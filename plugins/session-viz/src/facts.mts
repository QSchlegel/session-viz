// A session, reduced to the two tiers the console can index.
//
// The report itself is opaque markup — push.mts ships the rendered page because
// that is the only payload a person can inspect before consenting to it, and
// says out loud what that costs: "the server holds opaque markup it cannot
// index". This is the other half. A merged view across a team needs structure,
// and structure is a SECOND payload with its own exposure, so every field it
// may carry is written down in contract/facts.json and generated into the list
// below rather than being whatever the spine happened to have.
//
// ── Two tiers, defaulting differently ──────────────────────────────────────
//   index   bounded values and derived prose. Workspace-visible, so a roll-up
//           over a team is complete. Nothing in it can quote a prompt.
//   trace   tool inputs and results in full. Author-plus-admins, the same rung
//           as the verbatim document, because bash command lines and file
//           contents expose at least as much as the prompts above them.
//
// ── Written out key by key ─────────────────────────────────────────────────
// finding.mts states the rule for nine person-blind columns and it applies here
// at fifty times the size: the projection is written out key by key rather than
// spread, so adding a field is a visible edit and not an accident. The spine
// carries `file` and `project` and `cwd` — each of which contains the home
// directory and therefore the username — and `turns[].text`, which is the
// verbatim prompt. None of them has a field here, and undisclosedFacts() walks
// the built object and refuses anything the contract does not name, because a
// closed schema at the far end is a last line of defence rather than a design.
//
// ── Pure ───────────────────────────────────────────────────────────────────
// No I/O, no network, no filesystem, for the reason finding.mts gives: the
// payload a disclosure prints and the payload that is sent are then the same
// object built by the same call, and cannot disagree.
//
// ── What cannot be built here yet, stated rather than faked ────────────────
// A spine's `turns[].toolCalls` is `{ name, count }`. It holds tool NAMES and
// COUNTS and no inputs or results at all — the bodies live in the raw transcript
// and extract.mts does not retain them. So traceFacts() takes a call list rather
// than a Session: the projection is real, tested and enforced, and the thing
// that feeds it does not exist. Building it from a spine would mean inventing
// the one field the trace tier exists for.

import type { Session, SessionTurn, FrictionKind } from './extract.mjs'
import { repoName, worktreeOf } from './repo.mjs'

// <contract:facts.index.fields> generated from contract/claims.json — do not edit
export const INDEX_FIELDS = [
  'branch', 'cli_version', 'duration_ms', 'ended_at', 'files_dropped', 'files_touched',
  'friction_kinds', 'graph', 'harness', 'intents', 'mcp_servers', 'models', 'paths_recorded',
  'plugin_version', 'repo', 'schema_version', 'score.band', 'score.confidence',
  'score.costliest_turn', 'score.craft_rate', 'score.friction_rate', 'score.turns_scored',
  'score.value', 'score.wasted_tokens', 'secrets_redacted', 'session_id', 'slash_commands',
  'started_at', 'title', 'tokens.cache_create', 'tokens.cache_read', 'tokens.input',
  'tokens.output', 'tools', 'totals.assistant_messages', 'totals.compactions',
  'totals.corrections', 'totals.friction_turns', 'totals.human_turns', 'totals.interruptions',
  'totals.records', 'totals.repeats', 'totals.sidechain_records', 'totals.steering_turns',
  'totals.tool_calls', 'trace_shape', 'turns', 'worktree'
] as const
// </contract:facts.index.fields>

// <contract:facts.trace.call_fields> generated from contract/claims.json — do not edit
export const TRACE_CALL_FIELDS = [
  'duration_ms', 'error_kind', 'input', 'input_bytes', 'mcp_server', 'ok', 'result',
  'result_bytes', 'seq', 'started_at', 'tool', 'truncated', 'turn'
] as const
// </contract:facts.trace.call_fields>

/** Per-turn shape. Deliberately not a field list in the contract: it is the
 *  interior of `turns`, which the contract names as one field, and splitting it
 *  into six more would make the index tier read as fifty-three fields when it
 *  carries forty-seven things. */
export const TURN_SHAPE_FIELDS = [
  'index', 'duration_ms', 'tool_calls', 'tokens_output', 'friction', 'score',
] as const

export const SCHEMA_VERSION = '1'

// ---------------------------------------------------------------- the types

export interface TurnShape {
  index: number
  duration_ms: number
  tool_calls: number
  tokens_output: number
  friction: FrictionKind[]
  score: number | null
}

export interface IndexFacts {
  schema_version: string
  session_id: string
  harness: string
  repo: string | null
  worktree: string | null
  branch: string | null
  plugin_version: string | null
  cli_version: string | null
  title: string | null
  started_at: string | null
  ended_at: string | null
  duration_ms: number
  paths_recorded: 'yes' | 'no' | 'unknown'
  secrets_redacted: boolean
  score: {
    value: number | null
    band: string | null
    confidence: string
    turns_scored: number
    friction_rate: number | null
    craft_rate: number | null
    wasted_tokens: number | null
    costliest_turn: number | null
  }
  totals: Record<string, number>
  tokens: { input: number; output: number; cache_read: number; cache_create: number }
  models: Record<string, number>
  tools: Record<string, number>
  mcp_servers: Record<string, number>
  slash_commands: string[]
  friction_kinds: Record<string, number>
  files_touched: string[]
  files_dropped: number
  turns: TurnShape[]
  trace_shape: Record<string, number>
  intents: { title: string; status: string; turns: number[] }[]
  graph: { concepts: { id: string; label: string; group: string | null }[]; relations: { from: string; to: string; label: string | null }[] }
}

export interface TraceCall {
  turn: number
  seq: number
  tool: string
  mcp_server: string | null
  started_at: string | null
  duration_ms: number | null
  ok: boolean
  error_kind: 'none' | 'permission' | 'auth' | 'tool_error' | 'other'
  input: unknown
  result: string | null
  input_bytes: number
  result_bytes: number
  truncated: boolean
}

/** What traceFacts() consumes. Not a spine type, because a spine cannot supply
 *  it — see the module header. */
export interface TraceSource {
  turn: number
  seq: number
  tool: string
  startedAt?: string | null
  durationMs?: number | null
  ok?: boolean
  errorKind?: TraceCall['error_kind']
  input?: unknown
  result?: string | null
}

// ---------------------------------------------------------------- helpers

/**
 * `repo` comes from repo.mts and not from the last segment of cwd, and the
 * difference is the whole usefulness of a merged view.
 *
 * Claude Code puts a worktree at <repo>/.claude/worktrees/<name>, Codex at
 * ~/.codex/worktrees/<id>/<repo>, Cursor at ~/.cursor/worktrees/<repo>/<id>.
 * Taking the last segment gives the WORKTREE in two of those three layouts, so
 * a repository worked across five worktrees would arrive as five unrelated
 * repositories and a team roll-up keyed on it would silently fragment. repo.mts
 * already carries that lesson: its header records /qbl folding five worktrees
 * into one repo while /qship reported five, over the same corpus.
 *
 * The worktree is not discarded, it is its own field — it is a real second axis
 * and losing it would make two checkouts of one repository indistinguishable.
 */

/**
 * A turn's file paths are already relative to the working directory, with `../`
 * when the file is outside it. So the rule here is escape, not relativisation:
 * a path starting `../` names something outside the repository, which is
 * somebody's machine layout rather than their work.
 *
 * Dropped paths are counted rather than silently omitted, for the reason
 * `recordedPaths` exists at all — an empty list that could mean either "nothing
 * touched" or "nothing kept" has misled the reader by saying nothing.
 */
export function collectFiles(turns: SessionTurn[]): { kept: string[]; dropped: number } {
  const kept = new Set<string>()
  let dropped = 0
  for (const t of turns) {
    for (const f of (t as unknown as { files?: { path: string }[] }).files || []) {
      const p = String(f?.path || '')
      if (!p) continue
      if (p.startsWith('../') || p.startsWith('..\\') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) { dropped++; continue }
      kept.add(p)
    }
  }
  return { kept: [...kept].sort(), dropped }
}

const countBy = <T,>(items: T[], key: (t: T) => string | null | undefined): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const i of items) {
    const k = key(i)
    if (k) out[k] = (out[k] || 0) + 1
  }
  return out
}

/** Tri-state, and never coerced. extract.mts's header is explicit: a spine
 *  written before the field existed has it undefined, that reads as UNKNOWN, and
 *  it must never be read as false — because an empty file list then reads as
 *  "touched nothing", which is the one failure that whole field exists against. */
const pathsRecorded = (s: Session): 'yes' | 'no' | 'unknown' =>
  s.recordedPaths === undefined ? 'unknown' : s.recordedPaths ? 'yes' : 'no'

// ---------------------------------------------------------------- the index tier

export function indexFacts(s: Session, meta: { pluginVersion?: string | null } = {}): IndexFacts {
  const turns = s.turns || []
  const { kept, dropped } = collectFiles(turns)
  const sc = s.score || ({} as Session['score'])
  const tot = s.totals || ({} as Session['totals'])
  const tk = tot.tokens || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }

  // Key by key. Never a spread, never a rest. Every key present every time, so
  // a field that is absent is emitted as null rather than vanishing — a reader
  // that sees no key cannot tell an unmeasured session from an old schema.
  return {
    schema_version: SCHEMA_VERSION,
    session_id: String(s.sessionId || ''),
    harness: String(s.harness || ''),
    repo: repoName(s.cwd) || null,
    worktree: worktreeOf(s.cwd),
    branch: s.gitBranch ?? null,
    plugin_version: meta.pluginVersion ?? null,
    cli_version: s.version ?? null,
    title: s.title ?? null,
    started_at: s.startedAt ?? null,
    ended_at: s.endedAt ?? null,
    duration_ms: Number(s.durationMs || 0),
    paths_recorded: pathsRecorded(s),
    secrets_redacted: s.redactedPrompts === true,

    score: {
      value: sc.value ?? null,
      band: sc.band ?? null,
      confidence: sc.confidence ?? 'none',
      turns_scored: Number(sc.turnsScored || 0),
      friction_rate: sc.frictionRate ?? null,
      craft_rate: sc.craftRate ?? null,
      wasted_tokens: sc.wastedTokens ?? null,
      costliest_turn: sc.costliestTurn ?? null,
    },

    totals: {
      records: Number(tot.records || 0),
      human_turns: Number(tot.humanTurns || 0),
      assistant_messages: Number(tot.assistantMessages || 0),
      tool_calls: Number(tot.toolCalls || 0),
      sidechain_records: Number(tot.sidechainRecords || 0),
      interruptions: Number(tot.interruptions || 0),
      compactions: Number(tot.compactions || 0),
      steering_turns: Number(tot.steeringTurns || 0),
      repeats: Number(tot.repeats || 0),
      corrections: Number(tot.corrections || 0),
      friction_turns: Number(tot.frictionTurns || 0),
    },

    tokens: {
      input: Number(tk.input || 0),
      output: Number(tk.output || 0),
      cache_read: Number(tk.cacheRead || 0),
      cache_create: Number(tk.cacheCreate || 0),
    },

    models: { ...(s.models || {}) },
    tools: { ...(s.artifacts?.tools || {}) },
    mcp_servers: { ...(s.artifacts?.mcp || {}) },
    slash_commands: [...(s.slashCommands || [])],
    friction_kinds: countBy(turns.flatMap((t) => t.friction || []), (f) => String(f)),

    files_touched: kept,
    files_dropped: dropped,

    turns: turns.map((t) => ({
      index: Number(t.index || 0),
      duration_ms: Number(t.durationMs || 0),
      tool_calls: Number((t as unknown as { toolCallCount?: number }).toolCallCount || 0),
      tokens_output: Number(t.tokens?.output || 0),
      friction: [...(t.friction || [])],
      score: (t as unknown as { score?: { value?: number } }).score?.value ?? null,
    })),

    // Shape of a trace nobody reading this tier is allowed to open, so a roll-up
    // can describe one without exposing it. Empty until a trace exists.
    trace_shape: {},

    // Model-written, and thinner than the store holds. Intents keep their title,
    // status and cited turns and LOSE their summary: a summary paraphrases the
    // prompts, and this tier is visible to the whole workspace.
    intents: [],
    graph: { concepts: [], relations: [] },
  }
}

// ---------------------------------------------------------------- the trace tier

/** Bytes of a result kept per call. Not a cap on the tier — trace volume is
 *  metered and billed rather than capped — but a single tool result can be a
 *  whole file, and the original length travels in result_bytes so a reader can
 *  see exactly what was cut rather than reading a truncation as the whole thing. */
export const MAX_RESULT_CHARS = 64 * 1024

export function traceFacts(calls: TraceSource[]): TraceCall[] {
  return (calls || []).map((c) => {
    const result = c.result == null ? null : String(c.result)
    const full = result === null ? 0 : result.length
    const truncated = full > MAX_RESULT_CHARS
    const input = c.input === undefined ? null : c.input
    return {
      turn: Number(c.turn || 0),
      seq: Number(c.seq || 0),
      tool: String(c.tool || ''),
      mcp_server: /^mcp__/.test(String(c.tool || '')) ? String(c.tool).split('__')[1] ?? null : null,
      started_at: c.startedAt ?? null,
      duration_ms: c.durationMs ?? null,
      ok: c.ok !== false,
      error_kind: c.errorKind ?? 'none',
      input,
      result: truncated ? result!.slice(0, MAX_RESULT_CHARS) : result,
      input_bytes: input === null ? 0 : JSON.stringify(input).length,
      result_bytes: full,
      truncated,
    }
  })
}

// ---------------------------------------------------------------- fail closed

/** Every key path in an object, stopping at a path the contract names.
 *
 *  Stopping matters: `models` is a declared field whose keys are model ids, and
 *  descending into it would report every model as an undisclosed field. So a
 *  path that IS declared terminates the walk, a path that is a PREFIX of a
 *  declared one is descended, and anything else is undisclosed. */
export function keyPaths(o: unknown, known: readonly string[], prefix = ''): string[] {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return prefix ? [prefix] : []
  const out: string[] = []
  for (const k of Object.keys(o as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    // A key whose value is `undefined` is NOT present. JSON.stringify drops it,
    // so a field left undefined passes a walk that counts keys and then vanishes
    // on the wire — the gate would report a complete payload and send an
    // incomplete one. null is different and counts: null serialises, and "we
    // measured nothing" is a value this schema deliberately carries.
    if ((o as Record<string, unknown>)[k] === undefined) continue
    if (known.includes(path)) { out.push(path); continue }
    const isPrefix = known.some((n) => n.startsWith(`${path}.`))
    if (isPrefix) out.push(...keyPaths((o as Record<string, unknown>)[k], known, path))
    else out.push(path)
  }
  return out
}

/**
 * The last gate before anything leaves. Refuse a payload carrying a key the
 * contract does not name, and report a contract field the payload never emits.
 *
 * The second half is not symmetry for its own sake. Every key is emitted every
 * time by design, so a missing one means the projection stopped writing a field
 * the schema still promises — and a reader would see absence where the schema
 * says there is always a value.
 */
export function undisclosedFacts(facts: unknown): { extra: string[]; missing: string[] } {
  const actual = new Set(keyPaths(facts, INDEX_FIELDS as unknown as string[]))
  const declared = new Set(INDEX_FIELDS as unknown as string[])
  return {
    extra: [...actual].filter((p) => !declared.has(p)).sort(),
    missing: [...declared].filter((p) => !actual.has(p)).sort(),
  }
}

/** The same gate for one trace call. */
export function undisclosedTrace(call: unknown): { extra: string[]; missing: string[] } {
  const actual = new Set(Object.keys((call || {}) as Record<string, unknown>))
  const declared = new Set(TRACE_CALL_FIELDS as unknown as string[])
  return {
    extra: [...actual].filter((p) => !declared.has(p)).sort(),
    missing: [...declared].filter((p) => !actual.has(p)).sort(),
  }
}
