#!/usr/bin/env node
// Choose what your team can see. Nothing is shared by default.
//
//   node qshare.mjs                          # what exists locally, what is shared
//   node qshare.mjs --review project <name>  # the literal bytes that would leave
//   node qshare.mjs --share  project <name>  # send it, after you have reviewed it
//   node qshare.mjs --revoke <id>            # delete it from the workspace
//
// The local analysis is richer than people expect. It carries absolute paths
// including your home directory and username, and verbatim excerpts of what you
// typed — 67 paths and 103 text fields on the corpus this was written against.
// So this does two things before anything leaves:
//
//   1. Strips the machine-local parts nobody else can use. An absolute path
//      becomes a repo name. Your username is not analysis, it is incidental.
//   2. Refuses to send an item you have not reviewed. --share prints a summary
//      of what is in the payload and requires --yes, so the first time anyone
//      shares a session they see that prompt text is in it.
//
// A share lands in plane B — identity-bearing, tenant-scoped. It never touches
// the person-blind telemetry, and it cannot: that schema has no field for a
// repo name.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig } from './home.mjs'
import { emitJson } from './out.mjs'

const run = promisify(execFile)

interface Config { url: string; token: string; actor?: string }

function config(): Config {
  const env = process.env.SESSION_VIZ_TOKEN
  // Resolved by home.mts rather than hardcoded, so this finds the token
  // wherever /qsetup was able to put it — which under a sandboxed harness is
  // not necessarily the preferred location.
  const file: Partial<Config> = loadConfig<Config>() || {}
  const url = process.env.SESSION_VIZ_URL || file.url || 'https://cloud.session-viz.com'
  const token = env || file.token
  if (!token) {
    throw new Error('no token — run /qsetup first, or set SESSION_VIZ_TOKEN')
  }
  const actor = process.env.SESSION_VIZ_ACTOR || file.actor
  return actor ? { url, token, actor } : { url, token }
}

const api = async (cfg: Config, path: string, method = 'GET', body?: unknown): Promise<any> => {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.token}` }
  if (body) headers['content-type'] = 'application/json'
  if (cfg.actor) headers['x-actor'] = cfg.actor
  const r = await fetch(cfg.url.replace(/\/$/, '') + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`)
  return j
}

// ---------------------------------------------------------------- redaction

const HOME = homedir()

/**
 * Machine-local detail that is not analysis. A colleague gains nothing from
 * knowing the reader's home directory, and a path is the easiest way to leak a
 * username, a client name in a parent folder, or the shape of someone's disk.
 * Repo NAMES survive — that was the explicit choice — but the route to them
 * does not.
 */
const HOME_RE = new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')

function stripPaths<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      // Every occurrence, not just a leading one. The first version tested
      // `startsWith`, which is right for a `cwd` field and wrong for the thing
      // we actually chose to share: prompt text quoting an absolute path keeps
      // the username in the middle of a sentence. The tool's own review counted
      // one survivor on the first real payload.
      return v.replace(HOME_RE, '~')
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // `cwd` is an absolute path whose only useful part is the last segment,
        // and the object already carries that as `name`.
        if (k === 'cwd' && typeof x === 'string') { out[k] = x.split('/').filter(Boolean).pop() || x; continue }
        out[k] = walk(x)
      }
      return out
    }
    return v
  }
  return walk(value) as T
}

/** Counts the things a person should be told are in a payload before it leaves. */
export function describe(payload: unknown): { bytes: number; textFields: number; homePaths: number; keys: string[] } {
  const body = JSON.stringify(payload ?? null)
  const textFields = (body.match(/"text":/g) || []).length
  const homePaths = (body.match(new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload as Record<string, unknown>) : []
  return { bytes: body.length, textFields, homePaths, keys }
}

// ---------------------------------------------------------------- corpus

interface CorpusProject { name: string; cwd?: string; sessions: number; turns: number; [k: string]: unknown }
interface CorpusModel {
  projects: CorpusProject[]
  exemplars?: { best?: Array<Record<string, unknown>>; worst?: Array<Record<string, unknown>> }
  incidents?: Array<Record<string, unknown>>
  totals?: unknown
  meta?: unknown
}

async function corpus(): Promise<CorpusModel> {
  const here = new URL('.', import.meta.url).pathname
  const { stdout } = await run('node', [join(here, 'corpus.mjs'), '--json'], { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout) as CorpusModel
}

/** Everything the local report shows for one project, minus the machine paths. */
function projectPayload(m: CorpusModel, name: string): unknown {
  const p = m.projects.find((x) => x.name === name)
  if (!p) throw new Error(`no project called ${name} — run without arguments to list them`)
  const ids = new Set((p['sessionIds'] as string[] | undefined) || [])
  const mine = (rows?: Array<Record<string, unknown>>) =>
    (rows || []).filter((r) => r['project'] === name || ids.has(String(r['sessionId'] ?? '')))
  return stripPaths({
    kind: 'project',
    project: p,
    incidents: mine(m.incidents),
    exemplars: {
      best: mine(m.exemplars?.best),
      worst: mine(m.exemplars?.worst),
    },
    sharedAt: new Date().toISOString(),
  })
}

function sessionPayload(m: CorpusModel, id: string): unknown {
  const match = (r: Record<string, unknown>) => String(r['sessionId'] ?? '').startsWith(id)
  const all = [...(m.exemplars?.best || []), ...(m.exemplars?.worst || [])]
  const digest = all.find(match)
  const incidents = (m.incidents || []).filter(match)
  if (!digest && !incidents.length) throw new Error(`no session starting ${id} in the corpus`)
  return stripPaths({ kind: 'session', session: digest ?? null, incidents, sharedAt: new Date().toISOString() })
}

async function runPayload(ref: string): Promise<unknown> {
  const here = new URL('.', import.meta.url).pathname
  const { stdout } = await run('node', [join(here, 'runs.mjs'), '--json'], { maxBuffer: 64 * 1024 * 1024 })
  const ledger = JSON.parse(stdout) as { runs?: Array<Record<string, unknown>>; families?: unknown; tasks?: unknown }
  const runs = (ledger.runs || []).filter(
    (r) => String(r['task'] ?? '') === ref || String(r['id'] ?? '').startsWith(ref),
  )
  if (!runs.length) throw new Error(`no run or task class matching ${ref}`)
  return stripPaths({ kind: 'run', ref, runs, sharedAt: new Date().toISOString() })
}

async function payloadFor(kind: string, ref: string): Promise<unknown> {
  if (kind === 'run') return runPayload(ref)
  const m = await corpus()
  if (kind === 'project') return projectPayload(m, ref)
  if (kind === 'session') return sessionPayload(m, ref)
  throw new Error('kind must be project, session or run')
}

// ---------------------------------------------------------------- cli

const isMain = process.argv[1] && process.argv[1].endsWith('qshare.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (n: string) => argv.indexOf(n)
  const yes = argv.includes('--yes')

  try {
    const cfg = config()

    const rev = flag('--revoke')
    if (rev >= 0) {
      const id = argv[rev + 1]
      if (!id) throw new Error('--revoke needs a share id (see the list)')
      await api(cfg, '/v1/share/revoke', 'POST', { id })
      console.log(`revoked ${id}`)
      console.log('The row is deleted, not hidden. What a colleague already read cannot be recalled.')
      process.exit(0)
    }

    const review = flag('--review')
    const share = flag('--share')
    const act = review >= 0 ? review : share
    if (act >= 0) {
      const kind = argv[act + 1] || ''
      const ref = argv[act + 2] || ''
      if (!kind || !ref) throw new Error(`usage: --${review >= 0 ? 'review' : 'share'} <project|session|run> <name>`)
      const payload = await payloadFor(kind, ref)
      const d = describe(payload)

      console.log(`\n${kind} ${ref}`)
      console.log(`  ${d.bytes.toLocaleString('en-GB')} bytes · sections: ${d.keys.join(', ')}`)
      console.log(`  ${d.textFields} field(s) carrying verbatim prompt text`)
      console.log(`  ${d.homePaths} absolute home path(s) — ${d.homePaths === 0 ? 'stripped' : 'STILL PRESENT, this is a bug'}`)

      if (review >= 0) {
        console.log('\n--- the literal payload ---')
        await emitJson(payload)
        console.log('\nShare it with:  qshare.mjs --share ' + kind + ' ' + ref + ' --yes')
        process.exit(0)
      }
      if (!yes) {
        console.log('\nThis will be readable by everyone in your workspace, including the')
        console.log('prompt text above. Review it first:')
        console.log(`  qshare.mjs --review ${kind} ${ref}`)
        console.log(`Then re-run with --yes.`)
        process.exit(1)
      }
      const label = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : ref
      const out = await api(cfg, '/v1/share', 'POST', { kind, ref, label, payload })
      console.log(`\nshared as ${out.id} (${out.bytes.toLocaleString('en-GB')} bytes)`)
      console.log(`Revoke with: qshare.mjs --revoke ${out.id}`)
      process.exit(0)
    }

    // Default: what exists locally, and what of it is already shared.
    const [m, remote] = await Promise.all([corpus(), api(cfg, '/v1/shares')])
    const shared = new Map<string, { id: string; bytes: number; sharedBy: string }>()
    for (const s of remote.shares || []) shared.set(`${s.kind}|${s.ref}`, s)

    console.log(`workspace ${cfg.url}`)
    console.log(`${remote.shares?.length || 0} item(s) shared with your team\n`)
    console.log('  SHARED  PROJECT                    SESSIONS  TURNS   ')
    for (const p of m.projects.slice(0, 20)) {
      const hit = shared.get(`project|${p.name}`)
      console.log(`  ${hit ? '  ✓   ' : '  —   '}  ${p.name.padEnd(26)} ${String(p.sessions).padStart(8)} ${String(p.turns).padStart(6)}`)
    }
    if (remote.shares?.length) {
      console.log('\n  shared already:')
      for (const s of remote.shares) {
        console.log(`    ${s.id}  ${s.kind}/${s.ref} — ${(s.bytes / 1024).toFixed(1)} KB by ${s.sharedBy}`)
      }
    }
    console.log('\n  Nothing is shared unless you say so. Review before you send:')
    console.log('    qshare.mjs --review project <name>')
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  }
}
