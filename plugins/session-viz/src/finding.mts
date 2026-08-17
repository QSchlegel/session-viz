// A Run, reduced to the nine bounded columns the shared reference accepts.
//
// Pure: no I/O, no network, no filesystem. Everything here is a function of a
// Run, so the payload /qcontrib prints and the payload /qcontrib sends are the
// same object built by the same call — the property /qshare gets by sharing one
// `payloadFor()` between --review and --share, for the same reason.
//
// ── What this deliberately cannot express ───────────────────────────────────
// A Run carries a file path, a repo name, a model id, tool names and an exact
// timestamp. None of them have a field here, and the projection is written out
// key by key rather than spread, so adding one is a visible edit rather than an
// accident. The server's schema is closed and would reject a stray key — but a
// closed schema at the far end is a last line of defence, not a design, and it
// is not the thing that should be standing between a convenience spread and an
// egress bug.

import type { Run, TerminalState, DeliveryState } from './runs.mjs'

/**
 * The wire type. NOT called `Finding`: doctor.mts already exports an interface
 * of that name for a config-audit row, and two `Finding`s in one plugin is how
 * an import lands on the wrong one and type-checks anyway.
 */
export interface ContribFinding {
  kind: 'human_session' | 'scheduled' | 'subagent'
  task_class: string
  cli_band: string
  iso_week: string
  terminal_state: TerminalState
  delivery_state: DeliveryState
  error_class: 'none' | 'permission' | 'auth' | 'tool_error' | 'other'
  cost_bucket: number
  tool_bucket: number
}

// ---------------------------------------------------------------- helpers

/**
 * A semver, reduced to its band. Ported verbatim from the loader that wrote
 * every row already in the table: change the shape and new rows stop being
 * comparable with old ones, with nothing in the table able to tell them apart —
 * the stored schema_version is a constant.
 *
 * The '0.0.x' fallback is not an error path. Cursor records no CLI version at
 * all, and a legal band for "not stated" is better than a rejected finding.
 */
export const band = (v: string | null | undefined): string =>
  (v && /^\d+\.\d+\.\d+$/.test(v) ? v.replace(/\d$/, 'x') : '0.0.x')

/** log2 buckets, capped. Also ported verbatim, and for the same reason. */
export const bucket = (n: number, cap: number): number =>
  Math.min(cap, Math.round(Math.log2(1 + Math.max(0, n))))

/**
 * A task name, reduced to a task_class.
 *
 * Two slugs already exist and disagree: runs.mts collapses underscores to
 * hyphens and can return '', and the cloud's loader keeps underscores but
 * strips only leading HYPHENS — so a scheduled task called `_nightly` produced
 * the literal `_nightly`, which fails the server's `^[a-z0-9]` anchor and is
 * rejected with a bare 'invalid task_class' and no offending value echoed back.
 * This one strips both, and can never return empty.
 */
export const contribSlug = (s: string | null | undefined): string =>
  String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '').slice(0, 64) || 'unknown'

/**
 * Which class of work this run belongs to.
 *
 * 'human' is a magic literal, not a label: the reference report exempts exactly
 * that string from its k<5 suppression. Spelling it 'human-session', or using
 * the repo name, gets every human run suppressed out of the report the
 * contribution exists to feed.
 */
export function taskClass(run: Run): string {
  if (run.kind === 'human') return 'human'
  if (run.kind === 'subagent') return run.family || 'other'
  if (run.task) return contribSlug(run.task)
  // A Codex run with no human turns and no scheduled-task name: classified
  // 'scheduled' by the ledger, but carrying neither a task nor a family. The
  // one field with no source at all, so it gets a stated literal rather than an
  // empty string that would fail the regex and reject the whole finding.
  return 'unattended'
}

/**
 * The projection. Written out field by field, on purpose — see the header.
 */
export function toFinding(run: Run): ContribFinding {
  return {
    // The ledger's 'human' is the server's 'human_session'. Unmapped, this is
    // the worst possible failure: scheduled and subagent findings are accepted,
    // human ones are rejected item by item, and the request still answers 200.
    kind: run.kind === 'human' ? 'human_session' : run.kind,
    task_class: taskClass(run),
    cli_band: band(run.cliVersion),
    iso_week: run.week,
    terminal_state: run.terminal,
    delivery_state: run.delivery,
    error_class: run.errorClass,
    // OUTPUT tokens only, never out + cread + ccreate. The reference report
    // inverts this bucket as 2**b and prints it as a token count, and every row
    // already stored was built from output alone. Feeding it a total still
    // validates — it is an integer in range — and silently shifts every new row
    // five or six buckets against everything it will be averaged with.
    cost_bucket: bucket(run.out, 40),
    tool_bucket: bucket(run.tools, 14),
  }
}

// ---------------------------------------------------------------- validation

// Vendored from the server's own validateFinding. Same field list, same enums,
// same regexes, same messages — so a rejection reads identically whether it was
// caught here or there.
//
// This is a copy, and copies drift. It is here anyway because the alternative
// is discovering an invalid finding by watching it leave the machine and come
// back rejected: the server names the index and never the offending value, so a
// rejection that only happens remotely is a rejection nobody can debug. The
// mitigation for the drift is that the send path reports the server's errors
// too, rather than trusting this to have caught everything.
const FIELDS = [
  'kind', 'task_class', 'cli_band', 'iso_week',
  'terminal_state', 'delivery_state', 'error_class',
  'cost_bucket', 'tool_bucket',
] as const

const ENUMS: Record<string, readonly string[]> = {
  kind: ['human_session', 'scheduled', 'subagent'],
  terminal_state: [
    'completed_structured', 'completed_prose', 'truncated',
    'abandoned_mid_tool', 'infra_halt', 'zombie', 'unknown',
  ],
  delivery_state: ['wrote_ok', 'denied', 'no_intent', 'unverified'],
  error_class: ['none', 'permission', 'auth', 'tool_error', 'other'],
}

/** The first thing wrong with this finding, or null. */
export function validateFinding(f: unknown): string | null {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'not an object'
  const o = f as Record<string, unknown>
  for (const k of Object.keys(o)) if (!(FIELDS as readonly string[]).includes(k)) return `unknown field: ${k}`
  for (const k of FIELDS) if (!(k in o)) return `missing field: ${k}`
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(String(o[k]))) return `invalid ${k}`
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(o['task_class']))) return 'invalid task_class'
  if (!/^\d+\.\d+\.\d*x$/.test(String(o['cli_band']))) return 'invalid cli_band'
  if (!/^\d{4}-W\d{2}$/.test(String(o['iso_week']))) return 'invalid iso_week'
  const cost = o['cost_bucket'], tool = o['tool_bucket']
  if (!Number.isInteger(cost) || (cost as number) < 0 || (cost as number) > 40) return 'invalid cost_bucket'
  if (!Number.isInteger(tool) || (tool as number) < 0 || (tool as number) > 14) return 'invalid tool_bucket'
  return null
}

// ---------------------------------------------------------------- disclosure

/**
 * What a Run carries that the projection drops, with the REAL local values.
 *
 * Printed above the payload rather than described in prose. "No paths are sent"
 * is a claim; the reader's own home directory on screen next to a payload that
 * has just been validated as nine known fields is evidence.
 */
export function withheld(run: Run): { k: string; v: string }[] {
  return [
    { k: 'file', v: run.file },
    { k: 'repo', v: run.repo || '(none recorded)' },
    { k: 'model', v: run.model || '(none recorded)' },
    { k: 'topTools', v: run.topTools.map((t) => t.n).join(', ') || '(none)' },
    { k: 'started', v: run.started },
    { k: 'harness', v: run.harness },
    { k: 'agentMin', v: String(run.agentMin) },
  ]
}

export interface Disclosure {
  bytes: number
  /** Keys actually present across the payload, and any the server does not declare. */
  fields: string[]
  unknown: string[]
  /** Fields carrying verbatim prompt text. Structurally zero; counted anyway. */
  textFields: number
  /** Absolute home paths surviving into the payload. Same. */
  homePaths: number
  /** How many of this machine's repo names appear anywhere in the bytes. */
  repoNames: number
  /** The one field a caller controls, listed literally rather than counted. */
  taskClasses: string[]
}

/**
 * The numbers the consent gate reports, computed by scanning the actual bytes.
 *
 * Every one of these is a measurement of the payload, not an assertion about
 * it. The redaction self-check in /qshare is the precedent: a count that can
 * come back non-zero is worth printing, and one that is asserted rather than
 * measured tells the reader nothing they could not have read in the README.
 */
export function describe(findings: ContribFinding[], runs: Run[], home: string): Disclosure {
  const body = JSON.stringify({ findings })
  const present = new Set<string>()
  for (const f of findings) for (const k of Object.keys(f)) present.add(k)
  const repos = [...new Set(runs.map((r) => r.repo).filter(Boolean))]
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return {
    bytes: body.length,
    fields: [...present].sort(),
    unknown: [...present].filter((k) => !(FIELDS as readonly string[]).includes(k)).sort(),
    textFields: (body.match(/"text":/g) || []).length,
    homePaths: home ? (body.match(new RegExp(esc(home), 'g')) || []).length : 0,
    // A repo name is a bare word, so this looks for it quoted as a JSON string
    // value — the only way it could appear here at all. Substring matching
    // would count 'api' inside 'task_class' and report a leak that is a
    // coincidence of spelling.
    repoNames: repos.filter((r) => body.includes(`"${r}"`)).length,
    taskClasses: [...new Set(findings.map((f) => f.task_class))].sort(),
  }
}
