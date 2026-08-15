#!/usr/bin/env node
// Config audit for a repo, against how your other repos are set up.
//
//   node doctor.mjs                 # audit the current repo
//   node doctor.mjs --all           # every repo with transcripts
//   node doctor.mjs --json
//
// Fingerprints `.claude/**` and compares against the rest of your repos. The
// comparison is to your OWN fleet, not to a best-practice list someone invented
// — "eleven of your sixteen repos have this and yours does not" is a fact about
// your setup; "you should have a CLAUDE.md" is an opinion.
//
// Where a recommendation cannot be supported it says so. A single repo is not a
// baseline, and this refuses to invent one.

import { readdirSync, existsSync, readFileSync, createReadStream } from 'node:fs'
import { join, basename } from 'node:path'
import { createInterface } from 'node:readline'
import { listSessions } from './extract.mjs'
import { emitJson } from './out.mjs'
import { repoRoot } from './repo.mjs'

const count = (dir: string, ext = '.md'): number => {
  try { return readdirSync(dir).filter((f) => f.endsWith(ext)).length } catch { return 0 }
}
const rules = (file: string): number => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l) || /^#{1,6}\s+\S/.test(l)).length
  } catch { return 0 }
}

/** One matcher entry under a hook event; its `hooks` array holds the commands. */
interface HookMatcher {
  hooks?: unknown[]
}

/** The fields of a settings.json we actually read. */
interface SettingsFile {
  permissions?: { allow?: unknown[] }
  hooks?: Record<string, HookMatcher[] | undefined>
}

export interface Fingerprint {
  repo: string
  root: string
  hasClaudeMd: boolean
  claudeMdRules: number
  commands: number
  skills: number
  agents: number
  hooks: number
  permissionAllow: number
  permissionCoversWrite: boolean
  hasMcp: boolean
  hasSettings: boolean
}

export function fingerprint(root: string): Fingerprint {
  const c = join(root, '.claude')
  const settings = ['settings.json', 'settings.local.json']
    .map((f) => join(c, f)).filter(existsSync)
  let allow = 0, coversWrite = false, hooks = 0
  for (const f of settings) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8')) as SettingsFile | null
      const a = j?.permissions?.allow || []
      allow += a.length
      if (a.some((p) => /^Write|^Edit/.test(String(p)))) coversWrite = true
      // An event name is one key however much hangs off it, so a repo wiring six
      // commands onto PreToolUse reported a single hook and read as unconfigured.
      // The number under the 'hooks' column is commands, which is what a person
      // means when they ask how many hooks a repo runs.
      const events: Record<string, HookMatcher[] | undefined> = j?.hooks || {}
      for (const entries of Object.values(events)) {
        if (!Array.isArray(entries)) continue
        for (const e of entries) hooks += Array.isArray(e?.hooks) ? e.hooks.length : 1
      }
    } catch {}
  }
  const claudeMd = ['CLAUDE.md', join('.claude', 'CLAUDE.md')].map((f) => join(root, f)).find(existsSync)
  return {
    repo: basename(root), root,
    hasClaudeMd: !!claudeMd,
    claudeMdRules: claudeMd ? rules(claudeMd) : 0,
    commands: count(join(c, 'commands')),
    skills: (() => { try { return readdirSync(join(c, 'skills')).length } catch { return 0 } })(),
    agents: count(join(c, 'agents')),
    hooks,
    permissionAllow: allow,
    permissionCoversWrite: coversWrite,
    hasMcp: existsSync(join(root, '.mcp.json')) || existsSync(join(c, '.mcp.json')),
    hasSettings: settings.length > 0,
  }
}

/** The one field of a transcript line this reads, at either of the two depths a
 *  harness puts it. */
interface TranscriptHead {
  cwd?: string
  payload?: { cwd?: string } | null
}

// Repos come from the `cwd` recorded in the transcript, NOT from the directory
// slug. The slug replaces both '/' and '-' with '-', so `qs-plugins` rebuilds as
// `qs/plugins` and the path check silently drops it — that reconstruction found
// four repos out of sixteen. Reading the real value costs a few lines per file.
async function cwdOf(file: string): Promise<string | null> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  let n = 0
  try {
    for await (const line of rl) {
      if (++n > 40) break
      if (!line.includes('"cwd"')) continue
      try {
        const o = JSON.parse(line) as TranscriptHead
        // Claude Code puts `cwd` at the top level; Codex nests it in
        // session_meta's payload. Reading only the top level returned null for
        // every one of the 436 rollouts on this machine — opened, parsed, and
        // learned nothing from — leaving 13 real repositories out of the
        // fingerprint, including the one with 256 sessions in it.
        const cwd = o.cwd || o.payload?.cwd
        if (cwd) { rl.close(); return cwd }
      } catch {}
    }
  } finally { rl.close() }
  return null
}

export async function knownRepos(): Promise<string[]> {
  const seen = new Set<string>()
  for (const s of listSessions()) {
    const cwd = await cwdOf(s.file)
    if (!cwd) continue
    // Worktrees fold back into their repository — for both harnesses. Splitting
    // on the Claude Code separator alone left every Codex worktree checkout in
    // as a repository of its own, so the fleet baseline this audit compares a
    // repo against counted some of them twice.
    const root = repoRoot(cwd)
    if (existsSync(root)) seen.add(root)
  }
  return [...seen]
}

const MIN_BASELINE = 4

export interface Finding {
  level: 'gap' | 'note'
  key?: string
  text: string
}

interface Check {
  key: string
  label: string
  pred: (f: Fingerprint) => boolean
  why: string
}

export interface AuditResult {
  me: Fingerprint
  findings: Finding[]
  comparedAgainst: number
}

export function audit(target: string, fleet: Fingerprint[]): AuditResult {
  const me = fingerprint(target)
  const others = fleet.filter((f) => f.root !== me.root)
  const findings: Finding[] = []
  const share = (pred: (f: Fingerprint) => boolean) => others.filter(pred).length

  if (others.length < MIN_BASELINE) {
    findings.push({
      level: 'note',
      text: `Only ${others.length} other repo${others.length === 1 ? '' : 's'} to compare against — fewer than ${MIN_BASELINE}, so nothing below is a fleet norm. Reported as description, not advice.`,
    })
  }

  const checks: Check[] = [
    { key: 'hasClaudeMd', label: 'a CLAUDE.md', pred: (f) => f.hasClaudeMd,
      why: 'Repeated constraints live here instead of being re-explained each session.' },
    { key: 'permissionCoversWrite', label: 'a Write permission in settings', pred: (f) => f.permissionCoversWrite,
      why: 'Scheduled and headless runs cannot answer a permission prompt; without this they die at the first write.' },
    { key: 'commands', label: 'slash commands', pred: (f) => f.commands > 0,
      why: 'Procedures you retype are cheaper as a command. /qship finds the candidates.' },
    { key: 'hasSettings', label: 'a settings file', pred: (f) => f.hasSettings, why: '' },
  ]

  for (const c of checks) {
    const has = c.pred(me)
    if (has || !others.length) continue
    // A satisfied check needs no baseline. Taking the share first walked the
    // whole fleet once per check for a number that was then thrown away.
    const n = share(c.pred)
    const level = others.length >= MIN_BASELINE && n / others.length >= 0.5 ? 'gap' : 'note'
    findings.push({
      level, key: c.key,
      text: `No ${c.label}. ${n} of ${others.length} of your other repos have one.${c.why ? ' ' + c.why : ''}`,
    })
  }

  if (me.hasClaudeMd && me.claudeMdRules < 3) {
    findings.push({ level: 'note', key: 'thinClaudeMd',
      text: `CLAUDE.md exists but holds ${me.claudeMdRules} rule-ish lines. Thin files tend to mean the constraints are still being re-typed.` })
  }
  return { me, findings, comparedAgainst: others.length }
}

// ---------------------------------------------------------------- cli

const isMain = process.argv[1] && process.argv[1].endsWith('doctor.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  const repos = await knownRepos()
  const fleet = repos.map(fingerprint)

  if (argv.includes('--all')) {
    const rows = fleet.map((f) => ({ ...f, ...audit(f.root, fleet) }))
    // comparedAgainst is the baseline size that decided gap-vs-note. Without it
    // the machine output cannot tell a norm from an observation, which is the
    // one distinction this tool exists to keep.
    if (argv.includes('--json')) { await emitJson(rows.map((r) => ({ repo: r.repo, me: r.me, findings: r.findings, comparedAgainst: r.comparedAgainst }))); process.exit(0) }
    console.log(`fleet: ${fleet.length} repos with transcripts and a checkout on disk\n`)
    console.log('  CLAUDE  cmds  skills  hooks  allow  write  repo')
    // sort() is in place. Sorting `fleet` for display reordered the very array
    // every audit() above was handed by reference, so a presentation choice
    // reached back into the comparison it was presenting.
    const ordered = [...fleet].sort((a, b) => Number(b.hasClaudeMd) - Number(a.hasClaudeMd))
    for (const f of ordered) {
      console.log(`  ${(f.hasClaudeMd ? '  ✓   ' : '  —   ')}  ${String(f.commands).padStart(4)}  ${String(f.skills).padStart(6)}  ${String(f.hooks).padStart(5)}  ${String(f.permissionAllow).padStart(5)}  ${f.permissionCoversWrite ? '  ✓  ' : '  —  '}  ${f.repo}`)
    }
    const noMd = ordered.filter((f) => !f.hasClaudeMd)
    if (noMd.length) console.log(`\n  ${noMd.length} without a CLAUDE.md: ${noMd.map((f) => f.repo).join(', ')}`)
    const noWrite = ordered.filter((f) => !f.permissionCoversWrite)
    if (noWrite.length) console.log(`  ${noWrite.length} without a Write permission: ${noWrite.map((f) => f.repo).join(', ')}`)
    process.exit(0)
  }

  const target = argv.find((a) => !a.startsWith('--')) || process.cwd()
  const r = audit(target, fleet)
  if (argv.includes('--json')) { await emitJson(r); process.exit(0) }

  console.log(`repo        ${r.me.repo}`)
  console.log(`config      CLAUDE.md ${r.me.hasClaudeMd ? `yes (${r.me.claudeMdRules} rules)` : 'no'} · ${r.me.commands} commands · ${r.me.skills} skills · ${r.me.hooks} hooks`)
  console.log(`permissions ${r.me.permissionAllow} allow entries${r.me.permissionCoversWrite ? ', covers Write' : ', none cover Write'}`)
  console.log(`compared    against ${r.comparedAgainst} other repos of yours\n`)
  if (!r.findings.length) { console.log('nothing to flag — this repo matches or exceeds your fleet on every check.'); process.exit(0) }
  for (const f of r.findings) console.log(`  [${f.level}] ${f.text}`)
  console.log('\n  "gap" means at least half your other repos do this and enough of them exist')
  console.log('  to call it a norm. "note" is an observation with too little behind it.')
}
