#!/usr/bin/env node
// Turn findings into tasks, for findings that earned it.
//
//   node qfeed.mjs                 # what would be filed, and the evidence
//   node qfeed.mjs --review        # the literal task bodies
//   node qfeed.mjs --push --yes    # file them
//   node qfeed.mjs --close         # close tasks whose finding has gone away
//
// ── The thing that makes this worth having, and the thing that would ruin it ─
// A feeder that files a task for everything is a spam generator with a cron.
// The value is entirely in what it DOES NOT file.
//
// So every detector here reads a finding that already passed its own gate in
// the tool that produced it. /qdoctor is the clearest case: on the corpus this
// was written against, sixteen of seventeen repos have no CLAUDE.md — which
// means NOT having one is the fleet norm, and qdoctor correctly reports those
// as notes rather than gaps. A feeder that turned sixteen notes into sixteen
// tasks would be manufacturing work out of a measurement that explicitly
// declined to recommend anything. This reads `level === 'gap'` and ignores
// notes entirely.
//
// Each task carries a stable `source` — 'qruns:stalled:<task>' — so running
// this on a schedule updates the evidence on the existing task instead of
// filing the same finding every morning. The server upserts on it and
// deliberately does not touch `state`, so a task somebody already accepted is
// not dragged back to draft because the condition is still true.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { emitJson } from './out.mjs'
// config() and api() used to be declared here, byte-identical to the copies in
// qshare.mts. One module now: two commands that read the same token file must
// not be able to disagree about where it is or which headers it carries.
import { config, api } from './cloud.mjs'

const run = promisify(execFile)
const HERE = new URL('.', import.meta.url).pathname
const BIG = { maxBuffer: 64 * 1024 * 1024 }

// ---------------------------------------------------------------- candidates

export interface Candidate {
  /** Stable identity. Re-running updates this task rather than adding another. */
  source: string
  title: string
  brief: string
  repo?: string | null
  /** Why this passed a gate — printed before anything is filed. */
  evidence: string
  detector: string
}

interface RunsLedger {
  tasks?: Array<{ task: string; runs: number; delivered: number; denied: number; out: number; lastRun?: string }>
  families?: Array<{ family: string; runs: number; structured: number; structuredFail: number }>
  totals?: { runs?: number }
}

interface DoctorRow {
  repo: string
  findings?: Array<{ level: string; key?: string; text: string }>
  comparedAgainst?: number
}

interface ShipItem {
  key: string; text: string; count: number; sessions: number
  kind: string; promote?: boolean; repos?: string[]; medianTools?: number
}

const json = async <T,>(script: string, args: string[]): Promise<T> => {
  const { stdout } = await run('node', [join(HERE, script), ...args], BIG)
  return JSON.parse(stdout) as T
}

/**
 * A recurring task that has produced nothing. This is the strongest signal the
 * ledger has: it is not a rate or a comparison, it is a count of zero against a
 * run count that is not small.
 */
function stalledTasks(l: RunsLedger): Candidate[] {
  return (l.tasks || [])
    .filter((t) => t.runs >= 5 && t.delivered === 0)
    .map((t) => ({
      detector: 'qruns:stalled',
      source: `qruns:stalled:${t.task}`,
      title: `${t.task} has delivered nothing in ${t.runs} runs`,
      brief:
        `The scheduled task \`${t.task}\` has run ${t.runs} times and written no file on any of them.\n` +
        `${t.denied} run(s) had a write blocked by a permission prompt, which a headless run cannot answer.\n` +
        `It has spent ${Math.round(t.out / 1000)}k output tokens producing nothing that reached disk.\n` +
        (t.lastRun ? `Last run ${t.lastRun}.\n` : '') +
        `\nWhere to start: the repo's .claude/settings.json probably has no Write or Edit permission, ` +
        `so the run does all the work and dies at the first write. /qdoctor lists which repos are missing one.`,
      evidence: `${t.runs} runs, 0 delivered, ${t.denied} denied`,
    }))
}

/**
 * A subagent family failing its own output contract far more often than the
 * others. Gated on n so a small family with two bad runs does not qualify.
 */
function schemaFailures(l: RunsLedger): Candidate[] {
  const fams = (l.families || []).filter((f) => f.structured >= 25)
  if (fams.length < 2) return []
  const rate = (f: { structured: number; structuredFail: number }) => f.structuredFail / f.structured
  const median = [...fams].map(rate).sort((a, b) => a - b)[Math.floor(fams.length / 2)] ?? 0
  return fams
    // Twice the median AND at least five points above it, so a fleet that fails
    // 1% everywhere does not produce a task for the family that fails 2%.
    .filter((f) => rate(f) > median * 2 && rate(f) - median > 0.05)
    .map((f) => ({
      detector: 'qruns:schema',
      source: `qruns:schema:${f.family}`,
      title: `${f.family} subagents fail their output schema ${(rate(f) * 100).toFixed(0)}% of the time`,
      brief:
        `${f.structuredFail} of ${f.structured} structured runs in the \`${f.family}\` family did not return ` +
        `a valid result, against a fleet median of ${(median * 100).toFixed(0)}%.\n\n` +
        `A schema failure means the run finished and its output was thrown away, so the tokens are spent ` +
        `either way. This is usually the prompt asking for a shape the model cannot reliably produce.`,
      evidence: `${f.structuredFail}/${f.structured} fail, median ${(median * 100).toFixed(0)}%`,
    }))
}

/**
 * Config the fleet actually agrees on and one repo lacks. `level === 'gap'` is
 * the whole gate: qdoctor only says gap when at least half of at least four
 * other repos have the thing. A note never becomes a task.
 */
function configGaps(rows: DoctorRow[]): Candidate[] {
  const out: Candidate[] = []
  for (const r of rows) {
    for (const f of r.findings || []) {
      if (f.level !== 'gap') continue
      out.push({
        detector: 'qdoctor:gap',
        source: `qdoctor:${f.key || 'gap'}:${r.repo}`,
        title: `${r.repo}: ${f.text.split('.')[0]}`,
        repo: r.repo,
        brief: `${f.text}\n\nMeasured against ${r.comparedAgainst ?? '?'} other repositories of yours, ` +
          `not against anyone's idea of best practice. It is reported as a gap rather than a note ` +
          `because most of your other repos do have it.`,
        evidence: f.text.slice(0, 90),
      })
    }
  }
  return out
}

/**
 * A prompt retyped across sessions that always did real work.
 *
 * The bar here is deliberately HIGHER than /qship's own promote flag, and that
 * is not redundancy — the two answer different questions. qship promotes on
 * "seen in 2+ sessions and always ran tools", which is right for a list a
 * person skims and decides about. Filing a task commits somebody's attention,
 * and at that threshold the first run against a real corpus proposed tasks for
 * "yes please", "Try again" and "commit and pr" — phrases that pass the letter
 * of the gate and are plainly not procedures.
 *
 * So: three sessions rather than two, a median of three tools rather than one,
 * and long enough to be an instruction rather than an acknowledgement. A
 * feeder's whole value is in what it declines to file.
 */
function rituals(items: ShipItem[]): Candidate[] {
  return items
    .filter((i) => i.promote)
    .filter((i) => i.sessions >= 3 && i.count >= 3)
    .filter((i) => (i.medianTools ?? 0) >= 3)
    .filter((i) => i.text.trim().length >= 20)
    .map((i) => ({
      detector: 'qship:ritual',
      source: `qship:ritual:${i.key.slice(0, 80)}`,
      title: `Promote "${i.text.split('\n')[0]!.slice(0, 60)}" to a slash command`,
      brief:
        `Typed ${i.count} times across ${i.sessions} sessions${i.repos?.length ? ` in ${i.repos.join(', ')}` : ''}.\n` +
        `Every instance ran tools (median ${i.medianTools ?? '?'}) and none drew a correction, so this is a ` +
        `procedure being retyped rather than a prompt that failed to land.\n\n` +
        `\`/qship --write "${i.text.split('\n')[0]!.slice(0, 40)}"\` writes the command file for you.`,
      evidence: `${i.count}x across ${i.sessions} sessions, always ran tools`,
    }))
}

export async function candidates(): Promise<Candidate[]> {
  const [ledger, doctor, ship] = await Promise.all([
    json<RunsLedger>('runs.mjs', ['--json']),
    json<DoctorRow[]>('doctor.mjs', ['--all', '--json']),
    json<ShipItem[]>('ship.mjs', ['--json']),
  ])
  return [
    ...stalledTasks(ledger),
    ...schemaFailures(ledger),
    ...configGaps(doctor),
    ...rituals(ship),
  ]
}

// ---------------------------------------------------------------- cli

const isMain = process.argv[1] && process.argv[1].endsWith('qfeed.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  try {
    const found = await candidates()

    if (argv.includes('--json')) { await emitJson(found); process.exit(0) }

    if (argv.includes('--review')) {
      for (const c of found) {
        console.log(`\n${'─'.repeat(62)}\n${c.title}\n  source: ${c.source}\n`)
        console.log(c.brief)
      }
      console.log(`\n${found.length} task(s) would be filed. Push them with:  qfeed.mjs --push --yes`)
      process.exit(0)
    }

    const cfg = config()

    if (argv.includes('--close')) {
      const live = new Set(found.map((c) => c.source))
      const open = (await api(cfg, '/v1/tasks')) as Array<{ id: string; source?: string; state: string; title: string }>
      // Only ever close what THIS tool filed and the finding no longer supports.
      // A task a person wrote has no source and is never touched.
      const gone = open.filter((t) => t.source?.includes(':') && !live.has(t.source) && t.state !== 'done')
      for (const t of gone) {
        await api(cfg, `/v1/tasks/${t.id}/done`, 'POST', { text: 'the finding behind this no longer holds' })
        console.log(`  closed  ${t.title}`)
      }
      console.log(gone.length ? `\n${gone.length} closed.` : 'Nothing to close — every filed task still has a finding behind it.')
      process.exit(0)
    }

    if (argv.includes('--push')) {
      if (!argv.includes('--yes')) {
        console.log(`${found.length} task(s) would be filed into ${cfg.url}.`)
        console.log('Read them first:  qfeed.mjs --review')
        console.log('Then re-run with --yes.')
        process.exit(1)
      }
      for (const c of found) {
        const t = await api(cfg, '/v1/tasks', 'POST', {
          source: c.source, title: c.title, brief: c.brief, repo: c.repo ?? null,
          refs: [c.detector],
        })
        console.log(`  filed   ${t.id}  ${c.title}`)
      }
      console.log(`\n${found.length} filed. Re-running updates them in place rather than adding duplicates.`)
      process.exit(0)
    }

    // Default: what exists, and what it rests on.
    console.log(`${found.length} finding(s) currently qualify as work\n`)
    const byDetector = new Map<string, Candidate[]>()
    for (const c of found) byDetector.set(c.detector, [...(byDetector.get(c.detector) || []), c])
    for (const [d, list] of byDetector) {
      console.log(`  ${d}`)
      for (const c of list) console.log(`    ${c.title}\n      ${c.evidence}`)
    }
    console.log('\n  Nothing is filed until you say so:')
    console.log('    qfeed.mjs --review      the task bodies')
    console.log('    qfeed.mjs --push --yes  file them')
    console.log('\n  Detectors read findings that already passed a gate in the tool that produced them.')
    console.log('  A qdoctor NOTE never becomes a task — only a gap does — because a note is')
    console.log('  explicitly a measurement that declined to recommend anything.')
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  }
}
