#!/usr/bin/env node
// Extracts the "human spine" of a Claude Code session transcript.
//
// A session JSONL is mostly tool results and assistant messages; genuine human
// turns are ~2-4% of records. This collapses a transcript (often tens of MB)
// into a compact model keyed on those turns, with everything each turn caused
// attributed to it.
//
// Segmentation note: assistant records carry no promptId, so turns are cut by
// document order between human turns rather than grouped by id.
//
// -- Which files a turn touched, and what a recorded path IS -----------------
//
// For a long time this counted THAT a file was touched and threw the path away.
// The counter is still here; the path is now kept too, per turn, because the
// question people actually bring to a session record is "which files did this
// task change" and a count cannot answer it.
//
// A recorded path is RELATIVE TO THE SESSION'S WORKING DIRECTORY. Absolute was
// the other candidate -- it is verbatim, it is what the tool call said -- and it
// loses on the two grounds that decide it here:
//
//   1. An absolute path on this machine begins with the account name of whoever
//      ran the session. This spine is built to be forwarded: /qpact embeds it in
//      an evidence package, /qpush posts that page to a console, /qshare
//      publishes readings to colleagues. Every one of those has a scrubber, and
//      a leak that has to be scrubbed in three places eventually is not scrubbed
//      in one of them. Relativising removes the prefix that holds the home
//      directory, so in the ordinary case the leak never enters the spine at all
//      rather than being cleaned on the way out. In the case that is NOT
//      ordinary -- a working directory outside the home tree, which the climb
//      would walk back down through -- `~` replaces the home root instead.
//      Neither form carries the account name; that is the property, not the
//      syntax.
//   2. `src/extract.mts` is the answer to the question. The rest of an absolute
//      path is a fact about a disk, and two people reading the same repository
//      produce two different strings for one file.
//
// The cost is real and is stated rather than hidden: a path outside the working
// directory comes out as `../../.claude/settings.json`, which is legible but
// says nothing about where the tree it climbs into actually is; and when a
// transcript never says what the working directory was, there is nothing to
// relativise against and the path is kept with its home root rewritten to `~`.
// Consumers that forward this must still fail closed on an absolute path
// arriving from that last case -- bundle.mts does.
//
// WHAT THIS DOES NOT REACH. Two shapes of account name are removed: the home
// root -- at the head of a path or anywhere along it, because the route to a
// home directory is not always the shortest one (`/System/Volumes/Data/Users/x`
// is what macOS resolves every home file to, and a Windows path begins with a
// drive letter before it ever reaches `Users`) -- and a whole directory named
// after one with the slashes turned into dashes, which is how Claude Code names
// its own project and scratch directories. A name that is part of an ordinary FILENAME is not
// reachable -- Claude Code writes plan files called
// `users-<name>-downloads-<slug>.md` -- because no rule that catches it leaves
// `users-list.ts` alone, and withholding every file called that would cost more
// than it saves. It is a small residue and it is not zero: 7 of the 1,690 paths
// recorded across the corpus this was written against. Said out loud here, and
// in the evidence package's own limits, rather than rounded down to "paths carry
// no account name".
//
// Verbatim prompt text is untouched by all of this. People type absolute paths
// into prompts, and `turn.text` still holds whatever they typed; every consumer
// that scrubs prompt text already has to handle the absolute form appearing
// there, and still does.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, basename } from 'node:path'
import { codexProject, codexRecords, isCodexTranscript, listCodexSessions } from './codex.mjs'
import { cursorRecords, isCursorTranscript, listCursorSessions } from './cursor.mjs'
import { harnessLabel, transcriptRoots } from './home.mjs'
import type { TranscriptRoot } from './home.mjs'

// ---------------------------------------------------------------- shapes
//
// The spine's public surface. `extract()` returns a Session; every other script
// in this plugin consumes these shapes, so they are exported by name.

/** Token counters, accumulated per turn and per session. */
export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

/** One tool name, and how many times it ran inside a turn. */
export interface TurnToolCall {
  name: string
  count: number
}

/** One model name, and how many assistant messages it produced inside a turn. */
export interface TurnModelUse {
  name: string
  count: number
}

/**
 * One file a turn's tool calls named, and how many of them named it.
 *
 * A pair, not a repeated string: a busy turn reads the same file dozens of times
 * and a list would carry it dozens of times. The count is the whole reason this
 * is not a Set -- "touched forty times" and "touched once" are different facts
 * about a turn, and only one of them is worth looking at.
 *
 * It counts TOOL CALLS THAT NAMED THE FILE IN A FILE-PATH INPUT -- the same
 * three fields `fileTouches` has always counted. Two limits follow from that and
 * both matter more than the number does. A file named only inside a shell
 * command is not here at all: nothing reads paths out of command text, so a
 * session that works through `sed` and `grep` can show few files or none. And a
 * file that was only read sits here beside one that was rewritten with nothing
 * to tell them apart -- `toolCalls` on the same turn says which tools ran, but
 * not which of them named which file.
 */
export interface TurnFileTouch {
  /** Relative to the session's working directory; `../` when the file is
   *  outside it. See the module header for why it is not absolute. */
  path: string
  count: number
}

/** What the prompt text looks like, before anything is known about its outcome. */
export interface TurnSignals {
  chars: number
  words: number
  terse: boolean
  hasFileRef: boolean
  hasCodeBlock: boolean
  hasUrl: boolean
  isQuestion: boolean
  isCorrection: boolean
  hasAcceptanceCriteria: boolean
}

/** The ways the transcript can witness that a prompt did not land. These are the
 *  keys of OUTCOME, and the members of `turn.friction`. */
export type FrictionKind = 'repeated' | 'interrupted' | 'drew-correction' | 'correction' | 'roundtrip'

/** 'outcome' = witnessed by the transcript, 'form' = guessed from the text. */
export type ScoreTier = 'outcome' | 'form'

/** One signed contribution to a turn score, with the reason it was applied. */
export interface ScoreAdjustment {
  points: number
  why: string
  tier: ScoreTier
}

export interface TurnScore {
  value: number
  deductions: ScoreAdjustment[]
  additions: ScoreAdjustment[]
}

export type ScoreBand = 'clean' | 'solid' | 'mixed' | 'costly' | 'poor'

/** Facts about a turn that only its neighbours can supply. */
export interface TurnDerived {
  noToolCalls: boolean
  clarificationRoundtrip: boolean
  followedByCorrection: boolean
  /** index of the earlier turn this one repeats, or null */
  repeatOf: number | null
}

/** One human turn, with everything it caused attributed to it. */
export interface SessionTurn {
  index: number
  promptId: string | null
  uuid: string
  startedAt: string
  endedAt: string
  durationMs: number
  /** redacted and truncated to maxPromptChars */
  text: string
  fullChars: number
  hasImage: boolean
  /** false when the record was IDE-wrapped rather than written by hand */
  typed: boolean
  /** true when the turn arrived as a queued_command mid-flight */
  steering: boolean
  /**
   * Where a turn came from, verbatim from the harness's attachment record.
   *
   * Declared `string | null` for a long time and it has never been a string:
   * Claude Code writes `{ kind: 'human' }`, and this field is passed through
   * rather than parsed, so it is whatever shape that harness chose. A consumer
   * that believed the old type called .replace() on it and crashed on every
   * real session. Unknown, because that is what it is.
   */
  origin: unknown
  signals: TurnSignals
  tokens: TokenTotals
  assistantMessages: number
  subagents: number
  interruptions: number
  slashCommands: string[]
  effort: string | null
  firstToolAt: string | null
  timeToFirstToolMs: number | null
  toolCalls: TurnToolCall[]
  toolCallCount: number
  /**
   * The files this turn's tool calls named, most-touched first.
   *
   * Empty means one of three things and cannot tell them apart on its own: the
   * turn touched no file, the reading was extracted with --no-paths, or it
   * predates paths entirely. `session.recordedPaths` is the field that
   * distinguishes them, and it is the one a consumer must read before writing a
   * sentence about an empty list.
   */
  files: TurnFileTouch[]
  models: TurnModelUse[]
  /** the model that produced most of the turn's assistant messages */
  model: string | null
  mixedModel: boolean
  derived: TurnDerived
  friction: FrictionKind[]
  score: TurnScore
}

/** What a session touched, aggregated across all of its tool calls. Every map is
 *  keyed on the artifact and valued by how often it was seen. */
export interface SessionArtifacts {
  packages: Record<string, number>
  tools: Record<string, number>
  stack: Record<string, number>
  extensions: Record<string, number>
  skills: Record<string, number>
  mcp: Record<string, number>
  /** Every tool call that named a file, counted. Session-scoped, so it also
   *  counts calls made before the first human turn — which belong to no turn and
   *  appear in no `turn.files`. The two numbers are not required to agree, and
   *  nothing downstream may present one as a total of the other. */
  fileTouches: number
}

/** A permission-mode switch, in document order. */
export interface PermissionModeChange {
  ts: string
  mode: string
}

export interface SessionTotals {
  records: number
  humanTurns: number
  assistantMessages: number
  toolCalls: number
  sidechainRecords: number
  interruptions: number
  compactions: number
  steeringTurns: number
  tokens: TokenTotals
  frictionTurns: number
  frictionRate: number
  repeats: number
  corrections: number
}

/** The session score. Everything past `turnsScored` is absent for a session with
 *  no turns, where `value` and `band` are null and confidence is 'none'. */
export interface SessionScore {
  value: number | null
  band: ScoreBand | null
  confidence: 'none' | 'low' | 'medium' | 'high'
  turnsScored: number
  frictionRate?: number
  craftRate?: number
  wastedTokens?: number
  /** index of the lowest-scoring turn */
  costliestTurn?: number | null
}

/** The extracted spine of one transcript. */
export interface Session {
  sessionId: string | null
  file: string
  /** which harness wrote this transcript: 'claude-code', 'codex', … */
  harness: string
  project: string
  cwd: string | null
  gitBranch: string | null
  version: string | null
  title: string | null
  startedAt: string | null
  endedAt: string | null
  /** model name -> assistant messages produced */
  models: Record<string, number>
  artifacts: SessionArtifacts
  slashCommands: string[]
  permissionModes: PermissionModeChange[]
  totals: SessionTotals
  turns: SessionTurn[]
  score: SessionScore
  durationMs: number
  /**
   * Whether prompt text in this spine went through the secret patterns.
   *
   * Recorded because `--no-redact` exists and nothing downstream could tell.
   * The evidence package printed "prompt text is redacted for secrets" as a
   * flat statement, which was a claim about how a DIFFERENT program had been
   * invoked, made by a file that could not observe it -- so a bundle built from
   * a --no-redact spine asserted a redaction that had not happened, over the top
   * of the unredacted key. A reader cannot check this by looking; the extractor
   * is the only thing that knows, so the extractor says.
   */
  redactedPrompts: boolean
  /**
   * Whether this reading kept the path of each file its tool calls named.
   *
   * The same field, for the same reason, as `redactedPrompts` above: `--no-paths`
   * exists, and without a record of how the extractor was invoked every consumer
   * downstream has to guess -- and the comfortable guess is the wrong one. An
   * empty `turn.files` is indistinguishable, by looking, from a turn that touched
   * nothing. A reader who takes "no paths here" for "no files were touched" has
   * been misled by silence, which is the one failure this whole file is written
   * against.
   *
   * A spine written before this field existed has it `undefined`. That reads as
   * UNKNOWN. It must never be read as `false`: absence of the field is absence of
   * knowledge about the reading, not knowledge that the reading recorded nothing.
   */
  recordedPaths: boolean
  /**
   * Whether this reading retained tool-call inputs and results.
   *
   * The third field of its kind, for the third time for the same reason: a
   * consumer cannot observe how the extractor was invoked, and the comfortable
   * guess is the wrong one. An empty `trace` means either "this session made no
   * tool calls" or "nobody asked for them", and those are different facts.
   *
   * Read `undefined` as UNKNOWN, never as false — a spine written before this
   * field existed knows nothing about its own trace.
   */
  retainedTrace: boolean
  /** Every retained tool call, in document order. Empty unless retainTrace. */
  trace: RetainedCall[]
}

export interface ExtractOptions {
  redactText?: boolean
  maxPromptChars?: number
  /** Keep the path of each file a tool call named, attributed to the turn that
   *  made the call. Default true; `--no-paths` turns it off, and the spine says
   *  which happened. */
  recordPaths?: boolean
  /** Overrides the harness inferred from the path. */
  harness?: string
  /**
   * Retain every tool call's input and result, in full.
   *
   * Default FALSE, and the default is the point. Everything else this extractor
   * keeps is bounded or is prompt text the user typed; a trace is the commands
   * that ran, the files that were written and the arguments passed to every MCP
   * server, which is the rest of the session. `--with-trace` turns it on and the
   * spine says which happened.
   */
  retainTrace?: boolean
}

/** One transcript file on disk, as returned by listSessions(). */
export interface SessionFile {
  /** The root that produced this file. Carried rather than re-derived from the
   *  path at each call site: a report that says "436 transcripts contain no
   *  human turns — almost always scheduled-task runs" is a false statement the
   *  moment a second harness is in the corpus, and nothing but this field can
   *  make it true again. */
  harness: string
  /** Root-relative container directory. Harness-specific and opaque: a Claude
   *  Code project slug, a Codex `YYYY/MM/DD`. A label of last resort behind
   *  cwd, and the thing --project matches. */
  project: string
  file: string
  size: number
  mtime: number
}

// The transcript records, as far as this file reads them. The JSONL is untrusted,
// so every field is optional and narrowed where it is used — except `uuid` and
// `timestamp`, which every record carries and which the spine reads directly.

/** Tool-call input, as far as the harvesters read it. The three path fields stay
 *  `unknown` because harvestPath type-checks them itself. */
export interface ToolInput {
  skill?: unknown
  command?: string
  content?: string
  new_string?: string
  file_path?: unknown
  path?: unknown
  notebook_path?: unknown
}

/** A `tool_use` block inside an assistant message. The content array is read as
 *  these: any other block is skipped by the `type` check before `name` is used. */
export interface ToolUseBlock {
  type?: string
  /** Pairs a call with the `tool_result` that answers it, which arrives in a
   *  later record. Absent on a harness that does not emit one, in which case the
   *  call is retained with no result rather than dropped. */
  id?: string
  name: string
  input?: ToolInput
}

/** A `tool_result` block inside a user message — the answer to one tool_use. */
export interface ToolResultBlock {
  type?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

/**
 * One tool call, retained in full. Only present when extract was asked for it.
 *
 * This is the most exposing thing this extractor can produce. A `Bash` input is
 * a command line; a `Write` input is the contents of a file; an MCP input is
 * whatever arguments were passed. The spine already carries prompt text, and a
 * trace beside it is the rest of the session — which is why it is off unless
 * asked for, why `retainedTrace` records which happened, and why the result is
 * truncated per call with its original length kept.
 *
 * Structurally assignable to facts.mts's TraceSource, deliberately: the
 * projection there is what decides the wire shape, and this is its input.
 */
export interface RetainedCall {
  /** The turn this call belongs to, or -1 for a call made before the first
   *  human turn — which belongs to no turn and is not attributed to one. */
  turn: number
  seq: number
  tool: string
  startedAt: string
  durationMs: number | null
  ok: boolean
  errorKind: 'none' | 'tool_error'
  input: unknown
  result: string | null
  /** The result's length BEFORE truncation. Kept so a reader can see what was
   *  cut rather than reading a truncation as the whole answer. */
  resultBytes: number
  truncated: boolean
}

export interface ContentBlock {
  type?: string
  text?: string
}

export interface UsageRecord {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface TranscriptMessage {
  model?: string
  usage?: UsageRecord
  content?: string | ContentBlock[]
  /** Why generation stopped. extract() itself does not read this — runs.mts
   *  does, off the same records — but an adapter synthesising a record has to
   *  be able to say how a run ended, and this is the field that carries it. */
  stop_reason?: string | null
}

interface TranscriptAttachment {
  type?: string
  prompt?: string | ContentBlock[]
  source_uuid?: string
  origin?: unknown
}

export interface TranscriptRecord {
  type?: string
  uuid: string
  timestamp: string
  sessionId?: string
  cwd?: string
  gitBranch?: string
  version?: string
  isSidechain?: boolean
  promptId?: string
  effort?: string
  title?: string
  customTitle?: string
  aiTitle?: string
  mode?: string
  toolUseResult?: unknown
  message?: TranscriptMessage
  attachment?: TranscriptAttachment
}

/** How classifyUser() reports on a user-role record. */
type UserRecordClass =
  | { kind: 'tool_result' }
  | { kind: 'interrupt' }
  | { kind: 'compaction' }
  | { kind: 'injected' }
  | { kind: 'empty' }
  | { kind: 'slash'; command: string | null }
  | { kind: 'human'; text: string; hasImage: boolean; typed: boolean }

// The spine is assembled in place, so the builder works on drafts: these fields
// are attached only once a turn closes or the stream is drained, and what is
// finally returned matches the exported shapes above.
type LateTurnField =
  | 'toolCalls'
  | 'toolCallCount'
  | 'models'
  | 'model'
  | 'mixedModel'
  | 'derived'
  | 'friction'
  | 'score'
type TurnDraft = Omit<SessionTurn, LateTurnField | 'endedAt'> &
  Partial<Pick<SessionTurn, LateTurnField>> & {
    endedAt: string | null
    _tools?: Record<string, number>
    _models?: Record<string, number>
    /** Paths exactly as the tool calls gave them. Survives closeTurn, unlike the
     *  other two: relativising needs the session's working directory, which is
     *  only final once the stream has drained. */
    _files?: Record<string, number>
  }

type LateSessionField = 'score' | 'durationMs'
type LateTotalsField = 'frictionTurns' | 'frictionRate' | 'repeats' | 'corrections'
type SessionDraft = Omit<Session, LateSessionField | 'totals'> &
  Partial<Pick<Session, LateSessionField>> & {
    totals: Omit<SessionTotals, LateTotalsField> & Partial<Pick<SessionTotals, LateTotalsField>>
  }

interface NewTurnArgs {
  index: number
  uuid: string
  ts: string
  text: string
  promptId?: string | null
  hasImage?: boolean
  /** defaults true: everything but an IDE-wrapped record was typed */
  typed?: boolean
  steering?: boolean
  origin?: unknown
  effort?: string | null
}

// ---------------------------------------------------------------- classifying

// User-role records are not all typed prompts. Three groups, enumerated from
// the tags that actually occur across the transcript corpus:
//
//   SLASH    - the CLI's echo of a slash command invocation
//   INJECTED - background machinery reporting in (task notifications, CI
//              events, compaction summaries). Never human intent.
//   IDE      - wrapped, but genuinely user-initiated (clicking an element in
//              the IDE integration). Counted as a turn, flagged as non-typed.
const SLASH = /^<(command-name|command-message|command-args|local-command-caveat|local-command-stdout|local-command-stderr|user-prompt-submit-hook)\b/
// `scheduled-task` is a cron firing, not a person typing. It reads like a prompt
// and lands on the same code path as one, so without it the corpus attributes a
// recurring job's turns — and whatever friction they carry — to the user.
const INJECTED =
  /^<(task-notification|task-id|tool-use-id|status|output-file|ci-monitor-event|event|diagnostics|usage|result|note|siblings|create-pr-command|scheduled-task)\b/
const IDE = /^<(launch-selected-element|selected-lines|open-file)\b/
// Compaction leaves two traces in the user role: the <summary> payload itself
// and the resume preamble that opens the continued session. Neither is typed.
const COMPACTION = /^(<summary>|This session is being continued from a previous conversation)/
const INTERRUPT = /\[Request interrupted by user/
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function textOf(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n')
}

function classifyUser(rec: TranscriptRecord): UserRecordClass {
  if (rec.toolUseResult) return { kind: 'tool_result' }
  const content = rec.message?.content
  if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
    return { kind: 'tool_result' }
  }
  const hasImage = Array.isArray(content) && content.some((b) => b.type === 'image')
  const raw = textOf(content)
  if (INTERRUPT.test(raw)) return { kind: 'interrupt' }

  const text = raw.replace(REMINDER, '').trim()
  if (COMPACTION.test(text)) return { kind: 'compaction' }
  if (INJECTED.test(text)) return { kind: 'injected' }
  if (SLASH.test(text)) {
    const cmd = text.match(/^<command-name>\s*([^<]+)/)
    return { kind: 'slash', command: cmd ? cmd[1]!.trim() : null }
  }
  if (IDE.test(text)) return { kind: 'human', text, hasImage, typed: false }
  if (!text) return hasImage ? { kind: 'human', text: '[image]', hasImage, typed: true } : { kind: 'empty' }
  return { kind: 'human', text, hasImage, typed: true }
}

// ---------------------------------------------------------------- redaction

const SECRETS: [RegExp, string][] = [
  [/sk-ant-[\w-]{20,}/g, 'sk-ant-«redacted»'],
  [/\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}\b/g, 'gh«redacted»'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA«redacted»'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox«redacted»'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt«redacted»'],
  // KEY=value / TOKEN: value in pasted env blocks
  [/\b([A-Z][A-Z0-9_]{3,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|DSN))\s*[=:]\s*\S+/g, '$1=«redacted»'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`]+/g, '«redacted-conn-string»'],
  // The vendor-prefixed key shape, generically: `<vendor>_<class>_<entropy>`,
  // as used by Stripe (sk_live_, pk_test_), and by everyone who copied Stripe.
  //
  // The list above is one pattern per vendor, which means it only ever redacts
  // the issuers somebody thought of. A live key of exactly this shape reached a
  // /qship report in cleartext from the real corpus — matched by nothing here,
  // because its vendor prefix was not on the list. Every unlisted issuer had the
  // same hole, and the reports are the half of this tool designed to be shared.
  //
  // Anchored on the class segment (pk/sk/pat/api/key/token/secret) rather than
  // on entropy alone: a bare "long base62 run" also describes a git SHA, a UUID
  // and a minified identifier, and redacting those would quietly gut the prompt
  // text this tool exists to measure.
  //
  // Two entries because the convention has two orders, and a pattern written for
  // one silently passes the other — which is how the first draft of this fix
  // caught the key that prompted it while still letting every Stripe key
  // through.
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '«redacted-key»'],
  [/\b[a-z][a-z0-9]{1,20}_(?:pk|sk|pat|api|key|token|secret)_[A-Za-z0-9_-]{12,}\b/gi, '«redacted-key»'],
]

function redact(s: string): string {
  return SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), s)
}

/**
 * Redact every string inside a value, leaf by leaf.
 *
 * Leaf by leaf and NOT by stringifying, redacting and re-parsing, which is the
 * obvious shortcut and is unsafe: several patterns here end in `\S+`, which over
 * a JSON document happily swallows the closing quote and whatever follows it,
 * so the replacement lands across a string boundary and the result no longer
 * parses. A tool input is arbitrary JSON from the harness and is exactly the
 * place that would happen.
 *
 * Depth-limited because a transcript is untrusted input and a cyclic or
 * pathologically nested object should not become a stack overflow inside an
 * extractor.
 */
function redactDeep(v: unknown, depth = 0): unknown {
  if (depth > 12) return v
  if (typeof v === 'string') return redact(v)
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(val, depth + 1)
    return out
  }
  return v
}

/**
 * Result text kept per call.
 *
 * A ceiling here is not the contract's ceiling. Trace volume is metered and
 * billed rather than capped where it is stored; this is about the intermediate
 * on disk — a single `Read` of a large file would otherwise put megabytes into a
 * spine whose whole purpose is that a 42 MB transcript collapses into a few
 * hundred kilobytes. The original length travels in `resultBytes`, so nothing
 * is silently shortened.
 */
export const MAX_TRACE_RESULT_CHARS = 64 * 1024

/** The result text of a tool_result record, whichever way the harness wrote it. */
function resultOf(rec: TranscriptRecord): { id: string | null; text: string; isError: boolean } | null {
  const blocks = (rec.message?.content || []) as ToolResultBlock[]
  const block = Array.isArray(blocks) ? blocks.find((b) => b?.type === 'tool_result') : undefined
  if (block) {
    const c = block.content
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text?: unknown }).text ?? '') : '')).join('')
        : c == null ? '' : JSON.stringify(c)
    return { id: block.tool_use_id ?? null, text, isError: block.is_error === true }
  }
  // Claude Code also writes the answer to `toolUseResult` on the record itself,
  // with no id on it. Retained with a null id and paired positionally by the
  // caller, because a result with no pairing is still the answer to the call
  // that is open.
  if (rec.toolUseResult !== undefined) {
    const r = rec.toolUseResult
    return { id: null, text: typeof r === 'string' ? r : JSON.stringify(r), isError: false }
  }
  return null
}

// ---------------------------------------------------------------- signals

const FILE_REF = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|md|json|ya?ml|toml|css|scss|html|sql|sh|vue|svelte)\b/i
const CORRECTION = /^\s*(no+\b|nope\b|actually\b|wait\b|hold on\b|that'?s not\b|thats not\b|i meant\b|instead\b|nein\b|doch\b|falsch\b)/i
const CRITERIA = /\b(should|must|expect(ed)?|so that|acceptance|verify|ensure|make sure|test that|criteria|definition of done)\b/i
const QUESTION = /\?\s*$/

function signals(text: string): TurnSignals {
  const words = text.split(/\s+/).filter(Boolean).length
  return {
    chars: text.length,
    words,
    terse: words < 6,
    hasFileRef: FILE_REF.test(text),
    hasCodeBlock: text.includes('```'),
    hasUrl: /https?:\/\//.test(text),
    isQuestion: QUESTION.test(text),
    isCorrection: CORRECTION.test(text),
    hasAcceptanceCriteria: CRITERIA.test(text),
  }
}

// ---------------------------------------------------------------- scoring

// Two tiers of evidence, deliberately weighted apart.
//
// OUTCOME penalties are things the transcript witnessed: the prompt was re-sent,
// the work was interrupted, the next turn opened with a correction. These are
// facts about what a prompt cost, so they dominate the score.
//
// FORM adjustments are guesses from the text alone. A prompt that merely *reads*
// as vague may have worked fine, so these move the number only a little.
const OUTCOME: Record<FrictionKind, [number, string]> = {
  repeated: [-30, 're-sent verbatim — the first attempt did not land'],
  interrupted: [-25, 'work had to be interrupted mid-flight'],
  'drew-correction': [-20, 'the next turn opened with a correction'],
  correction: [-10, 'this turn was itself a correction'],
  roundtrip: [-8, 'no tools ran and no question was asked'],
}

// An ordinary prompt that simply worked starts here, not at 100. Starting at a
// perfect score makes "no friction" indistinguishable from "well specified",
// and pins any real session near the ceiling.
const BASE = 72

function scoreTurn(t: SessionTurn): TurnScore {
  const deductions: ScoreAdjustment[] = []
  const additions: ScoreAdjustment[] = []

  for (const f of t.friction) {
    const rule = OUTCOME[f]
    if (rule) deductions.push({ points: rule[0], why: rule[1], tier: 'outcome' })
  }

  if (t.signals.hasAcceptanceCriteria) additions.push({ points: 10, why: 'stated what done looks like', tier: 'form' })
  if (t.signals.hasFileRef) additions.push({ points: 6, why: 'named a concrete file', tier: 'form' })
  if (t.signals.hasCodeBlock) additions.push({ points: 4, why: 'included code or output', tier: 'form' })

  // Terseness is only a defect when starting fresh work. Mid-flight steering is
  // terse by nature and lands precisely because the context is already loaded.
  if (t.signals.terse && !t.steering) {
    deductions.push({ points: -10, why: 'very short with no prior context to lean on', tier: 'form' })
  }

  const delta = [...deductions, ...additions].reduce((n, x) => n + x.points, 0)
  const value = Math.max(0, Math.min(100, BASE + delta))
  return { value, deductions, additions }
}

function band(v: number): ScoreBand {
  if (v >= 88) return 'clean'
  if (v >= 76) return 'solid'
  if (v >= 62) return 'mixed'
  if (v >= 45) return 'costly'
  return 'poor'
}

// The session score is built from *rates*, not from a mean of turn scores.
// Averaging hundreds of turns converges on the base value by construction, which
// made every session land in a narrow band regardless of how it actually went.
// Rates keep their spread no matter how long the session runs.
function scoreSession(turns: SessionTurn[]): SessionScore {
  if (!turns.length) return { value: null, band: null, confidence: 'none', turnsScored: 0 }

  // Friction is counted per turn, deliberately NOT weighted by tokens. Weighting
  // by cost inverts the signal: an interrupted turn is cheap *because* it was
  // interrupted, and a verbatim repeat costs almost nothing, so token-weighting
  // erases the very failures being measured. Wasted tokens are reported
  // separately instead, where they inform without distorting.
  const frictionTurns = turns.filter((t) => t.friction.length)
  const frictionRate = frictionTurns.length / turns.length
  const wastedTokens = frictionTurns.reduce((n, t) => n + t.tokens.output, 0)

  const crafted = turns.filter(
    (t) => t.signals.hasAcceptanceCriteria || t.signals.hasFileRef || t.signals.hasCodeBlock
  ).length
  const craftRate = crafted / turns.length

  const value = Math.max(0, Math.min(100, Math.round(100 - 120 * frictionRate + 20 * craftRate)))

  // Short sessions give the outcome signals almost nothing to witness, so the
  // number carries its own weakness rather than posing as a verdict.
  const confidence = turns.length >= 20 ? 'high' : turns.length >= 8 ? 'medium' : 'low'

  return {
    value,
    band: band(value),
    confidence,
    turnsScored: turns.length,
    frictionRate: +frictionRate.toFixed(3),
    craftRate: +craftRate.toFixed(3),
    wastedTokens,
    costliestTurn: turns.slice().sort((a, b) => a.score.value - b.score.value)[0]?.index ?? null,
  }
}

// ---------------------------------------------------------------- artifacts

// What a session touched, harvested from tool-call inputs rather than from the
// prompt text. Prompt words are a poor description of a codebase — people say
// "fix the thing" — whereas the file that was edited and the package that was
// imported are unambiguous. These are what let one project be related to
// another.
//
// Aggregated per session, not per turn: the question this feeds is "does this
// repo know about X", which does not need turn resolution and would triple the
// spine if it carried one.

// Bare specifiers only. A relative import names a file inside the repo, which
// says nothing about shared knowledge; `three` or `@supabase/supabase-js` does.
const IMPORT = /(?:^|\n)\s*(?:import[\s\S]{0,200}?from\s*|import\s*|(?:const|let|var)[\s\S]{0,80}?=\s*require\s*\(\s*)['"]([^'".][^'"]*)['"]/g
const PY_IMPORT = /(?:^|\n)\s*(?:from\s+([a-zA-Z_][\w.]*)\s+import|import\s+([a-zA-Z_][\w.]*))/g
const INSTALL =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|i)\s+((?:@?[\w./-]+\s*)+)|\b(?:pip3?|uv pip)\s+install\s+((?:[\w.[\]=<>-]+\s*)+)|\bcargo\s+add\s+([\w-]+)|\bgo\s+get\s+([\w./-]+)/g

// The Python import pattern also matches TypeScript's `import type {…}` and
// `import Link from …`, which is how "type" and "Link" end up looking like the
// most widely shared packages in the corpus. Language is decided by the file
// being written, not guessed from the content.
const PY_EXT = new Set(['py', 'pyi', 'ipynb'])
const JS_EXT = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'svelte', 'vue', 'astro'])

// Standard libraries are in every repo that uses the language, so they bridge
// nothing — a graph edge for `fs` says only "this is JavaScript".
const STDLIB = new Set([
  'fs', 'path', 'os', 'url', 'util', 'events', 'stream', 'crypto', 'http', 'https', 'child_process',
  'readline', 'assert', 'buffer', 'zlib', 'net', 'tls', 'dns', 'querystring', 'timers', 'worker_threads',
  'perf_hooks', 'process', 'string_decoder', 'v8', 'vm', 'cluster',
  'sys', 'json', 're', 'time', 'datetime', 'math', 'random', 'pathlib', 'typing', 'collections',
  'itertools', 'functools', 'subprocess', 'logging', 'argparse', 'dataclasses', 'asyncio', 'unittest',
  'csv', 'io', 'shutil', 'glob', 'hashlib', 'base64', 'sqlite3', 'urllib', 'threading', 'tempfile',
  'traceback', 'enum', 'abc', 'copy', 'warnings', 'uuid', 'socket', 'struct', 'textwrap',
  'string', 'inspect', 'contextlib', 'secrets', 'signal', 'operator', 'statistics', 'decimal',
])

// Files that identify a stack rather than a feature. A repo with a Dockerfile
// and a pyproject.toml is describable; one with a main.js is not.
const STACK_FILES = new Set([
  'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'next.config.js',
  'next.config.mjs', 'tailwind.config.js', 'tailwind.config.ts', 'svelte.config.js', 'nuxt.config.ts',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'makefile', 'justfile',
  'pyproject.toml', 'requirements.txt', 'setup.py', 'cargo.toml', 'go.mod', 'gemfile', 'composer.json',
  'terraform.tf', 'main.tf', 'railway.json', 'railway.toml', 'vercel.json', 'netlify.toml', 'fly.toml',
  'supabase.toml', 'prisma.schema', 'schema.prisma', '.github', 'k8s', 'helm',
])

// Command-line tools worth graphing. An allow-list rather than "first word of
// every command": the long tail of ls/cd/echo is noise, and an allow-list is
// auditable in a way that a stopword list is not.
const CLI = new Set([
  'docker', 'docker-compose', 'kubectl', 'helm', 'terraform', 'ansible', 'vagrant',
  'psql', 'mysql', 'sqlite3', 'redis-cli', 'mongo', 'prisma', 'supabase',
  'gh', 'git', 'ssh', 'scp', 'rsync', 'tailscale', 'curl', 'wget', 'ffmpeg', 'imagemagick', 'convert',
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'deno', 'tsx', 'vite', 'webpack', 'esbuild',
  'python', 'python3', 'pip', 'pip3', 'uv', 'poetry', 'pytest', 'ruff', 'mypy', 'jupyter',
  'cargo', 'rustc', 'go', 'java', 'mvn', 'gradle', 'swift', 'xcodebuild', 'pod',
  'railway', 'vercel', 'netlify', 'fly', 'aws', 'gcloud', 'az', 'heroku', 'wrangler',
  'eslint', 'prettier', 'jest', 'vitest', 'playwright', 'cypress', 'blender',
])

const MAX_SCAN = 20000 // chars of tool content scanned for imports
const MAX_KEYS = 400 // distinct keys per category, so a pathological session cannot grow unbounded

function bump(map: Record<string, number>, key: string | undefined, n = 1): void {
  if (!key) return
  if (!(key in map) && Object.keys(map).length >= MAX_KEYS) return
  map[key] = (map[key] || 0) + n
}

// Builtins, relative imports and the repo's own `@/…` path aliases are not
// shared knowledge — the alias in particular resolves to a directory inside the
// repo, so it would link projects that have nothing in common but a convention.
const isPackage = (s: string) =>
  s &&
  !s.startsWith('.') &&
  !s.startsWith('/') &&
  !s.startsWith('~') &&
  !s.startsWith('@/') &&
  !s.startsWith('node:') &&
  !STDLIB.has(s) &&
  s.length > 1 &&
  s.length < 60

const pkgRoot = (s: string) => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]!)

const addPackage = (name: string | undefined, out: SessionArtifacts) => {
  const root = pkgRoot(String(name || '').trim())
  if (isPackage(root) && !STDLIB.has(root)) bump(out.packages, root)
}

function harvestImports(text: string | undefined, out: SessionArtifacts, ext: string | null): void {
  if (!text) return
  const body = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text
  // Unknown extension: assume JS, which is the syntax that cannot false-positive
  // on the other language's keywords.
  if (PY_EXT.has(ext!)) {
    for (const m of body.matchAll(PY_IMPORT)) addPackage((m[1] || m[2] || '').split('.')[0], out)
    return
  }
  if (ext && !JS_EXT.has(ext)) return
  for (const m of body.matchAll(IMPORT)) addPackage(m[1], out)
}

function harvestBash(cmd: string | undefined, out: SessionArtifacts): void {
  if (!cmd) return
  const body = cmd.length > MAX_SCAN ? cmd.slice(0, MAX_SCAN) : cmd
  // Every segment, not just the first: real commands are pipelines and && chains.
  for (const seg of body.split(/[|;&\n]+|\$\(/)) {
    const word = seg.trim().split(/\s+/)[0]!.replace(/^.*\//, '')
    if (CLI.has(word)) bump(out.tools, word)
  }
  for (const m of body.matchAll(INSTALL)) {
    const list = m[1] || m[2] || m[3] || m[4] || ''
    for (const raw of list.trim().split(/\s+/)) {
      if (!raw || raw.startsWith('-')) continue
      // Strip a version constraint, but only after any leading scope: `@scope/x`
      // keeps its @, `react@18` and `httpx>=0.27` lose the version.
      const scoped = raw.startsWith('@')
      const bare = (scoped ? raw.slice(1) : raw).split(/[@=<>~^[]/)[0]
      addPackage(scoped ? '@' + bare : bare, out)
    }
  }
}

function harvestPath(p: unknown, out: SessionArtifacts, files: Record<string, number> | null): void {
  if (typeof p !== 'string' || !p) return
  const base = p.replace(/^.*\//, '').toLowerCase()
  if (STACK_FILES.has(base)) bump(out.stack, base)
  const ext = base.includes('.') ? base.replace(/^.*\./, '') : null
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) bump(out.extensions, ext)
  out.fileTouches++
  // Raw here, relativised once the stream has drained: the working directory
  // arrives on a record and the first tool call can precede it. Rewriting each
  // path as it is seen would key the same file two ways in one turn depending on
  // where in the file the transcript happened to mention its own cwd.
  if (files) files[p] = (files[p] || 0) + 1
}

/**
 * @param files where this call's paths are counted, or null to record none --
 *   which is both `--no-paths` and a tool call that ran outside any turn. The
 *   counters in `out` are bumped either way, so the session-level count of file
 *   touches does not change when paths are turned off.
 */
export function harvestTool(
  block: ToolUseBlock,
  out: SessionArtifacts,
  files: Record<string, number> | null = null
): void {
  const i = block.input
  if (!i || typeof i !== 'object') return
  const name = block.name

  if (name.startsWith('mcp__')) bump(out.mcp, name.split('__')[1])
  if (name === 'Skill' && typeof i.skill === 'string') bump(out.skills, i.skill)
  if (name === 'Bash') harvestBash(i.command, out)

  // `path` is the generic one, and it is generic on the other side too: an
  // `mcp__*` tool is somebody else's schema, where `path` is as likely to be an
  // HTTP route, a JSON pointer or an object key as a file. That was tolerable
  // while the value was thrown away and only bumped an anonymous counter; now it
  // is stored, relativised against the working directory into something that
  // reads exactly like a repo-relative file, rolled up as a `file,` row in the
  // evidence package and listed on the page under the files a turn touched --
  // and `/v1/customers/4821/invoices` is none of those things. `file_path` and
  // `notebook_path` are this tool's own names and stay trusted from any caller.
  const generic = name.startsWith('mcp__') ? [] : (['path'] as const)
  let ext: string | null = null
  for (const key of ['file_path', ...generic, 'notebook_path'] as const) {
    if (!i[key]) continue
    harvestPath(i[key], out, files)
    const base = String(i[key]).replace(/^.*\//, '').toLowerCase()
    if (base.includes('.')) ext = base.replace(/^.*\./, '')
  }
  // Write content and Edit replacements are where imports live.
  harvestImports(i.content, out, ext)
  harvestImports(i.new_string, out, ext)
}

export function emptyArtifacts(): SessionArtifacts {
  return { packages: {}, tools: {}, stack: {}, extensions: {}, skills: {}, mcp: {}, fileTouches: 0 }
}

// ---------------------------------------------------------------- paths

// A leading `/`, a drive letter, or a UNC root. Both separators, because a
// transcript written on Windows is read on whatever machine opens it and
// node:path would answer for the reader's platform rather than the writer's.
const ABSOLUTE = /^\/|^[A-Za-z]:[\\/]|^\\\\/

/** A segment that starts somebody's home, when another segment follows it. */
const HOME_DIR = /^(?:Users|home)$/i

/**
 * Where an account's home root begins inside an absolute path, or -1.
 *
 * Found by SEGMENT and at any depth, which is the whole point. A home directory
 * is not always the first thing on the route to it, and a `^`-anchored pattern
 * sees none of the ways it is not: macOS resolves every home file through
 * `/System/Volumes/Data/Users/<name>`, which is what `realpath` prints; an
 * external disk puts one under `/Volumes/<disk>/Users/<name>`; an automounter
 * under `/net/<host>/home/<name>`; and EVERY Windows absolute path begins with
 * a drive letter, so a rule that reads only the first segment can never fire on
 * one at all. Each of those walked the account name out into the middle of a
 * path that is relative, and therefore looked safe.
 *
 * The FIRST such pair, not the last: the pair that names an account is the
 * outermost one, so a repository that contains a `home/` or `Users/` directory
 * of its own keeps it -- that inner one is a project directory. It must be
 * followed by something, because `/Users` alone names nobody.
 */
function homeRootAt(segs: string[]): number {
  for (let h = 0; h < segs.length - 1; h++) if (HOME_DIR.test(segs[h] ?? '')) return h
  return -1
}

/**
 * An absolute path with its home root -- wherever that root sits -- cut to `~`.
 *
 * A path with no home root is returned unchanged, and unchanged means still
 * absolute: `/etc/hosts` has nothing to remove, and pretending otherwise would
 * hand consumers a path that looks scrubbed. bundle.mts fails closed on it.
 */
function tilde(p: string): string {
  const segs = segments(p)
  const h = homeRootAt(segs)
  return h < 0 ? p : ['~', ...segs.slice(h + 2)].join('/')
}

// A whole directory named after a home path with the slashes turned into dashes.
//
// Claude Code names its own project and scratch directories that way, so
// `-Users-someone-git-api` is a real directory NAME sitting inside a path under
// /private/tmp -- and on the corpus this was written against, that is where
// nearly every account name that survived relativising was found. Nothing about
// the path is a home root, so cancelling prefixes does not touch it.
//
// It cannot be cut precisely: the account name is itself dash-separated, so a
// pattern that stops at the first dash leaks half the name and corrupts the
// rest. The whole segment goes, which is the rule bundle.mts already applies to
// this shape in prose -- and this is anchored to a segment boundary, which that
// one cannot be, so an ordinary `find-home-fast/` is not touched.
const HOME_DASH_SEGMENT = /(^|\/)-(?:Users|home)-[^/]*/g
// bundle.mts's marker, deliberately. One withheld-marker vocabulary across the
// tool means a reader who has seen it once knows what it means everywhere.
const WITHHELD = '«path-withheld»'

const segments = (s: string): string[] => s.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.')

/**
 * One tool-call path, as the spine stores it.
 *
 * Relative to `root` when there is one -- including upward, so a file outside
 * the working directory reads `../../.claude/settings.json` and is visibly
 * outside rather than silently renamed to something inside. A path that is
 * already relative is left alone: it was written relative to the same working
 * directory, so it is already in this form and normalising it again would key
 * `./src/a.ts` and `src/a.ts` as two files.
 *
 * The `..` form cancels the account name WHEN BOTH PATHS ARE UNDER THE HOME
 * DIRECTORY, which is the usual case and was very nearly assumed to be the only
 * one. It is not: a session run from a worktree in /private/tmp, or a checkout
 * on another volume, shares nothing with the file it edits under `~`, so the
 * climb walks back down through `Users/<name>` and the account name lands in the
 * middle of a path that is relative and therefore looks safe. Every session on
 * the corpus with a working directory outside the home tree did exactly that.
 * Where that happens, `~` replaces the home root instead -- shorter, and it is
 * what the relative form was chosen to achieve in the first place.
 *
 * With no root there is nothing to cancel, and the same `~` rewrite is all there
 * is. What remains may be absolute -- `/etc/hosts` has no home root to remove.
 * Consumers that forward the spine must fail closed on that rather than assume
 * this function made it safe.
 */
export function spinePath(p: string, root: string | null): string {
  if (!ABSOLUTE.test(p)) return deName(segments(p).join('/') || '.')
  if (!root || !ABSOLUTE.test(root)) return deName(tilde(p))
  const from = segments(root)
  const to = segments(p)
  // Different roots share no prefix that means anything, and counting `..`
  // between them would invent a relationship. A drive letter against a POSIX
  // root is the obvious case; `C:` against `D:` is the SAME case and was missed,
  // because the test asked whether each side had a drive letter and not whether
  // it was the same one -- so two accounts on two disks produced
  // `../../../../D:/Users/someone/x.ts`, which names the account and resolves
  // nowhere. The test is on the root segment itself now, not on its shape.
  const driveRoot = (x: string): boolean => /^[A-Za-z]:$/.test(x)
  if (driveRoot(from[0] ?? '') || driveRoot(to[0] ?? ''))
    if ((from[0] ?? '').toLowerCase() !== (to[0] ?? '').toLowerCase()) return deName(tilde(p))
  let i = 0
  while (i < from.length && i < to.length && from[i] === to[i]) i++
  // The climb is safe only when the shared prefix reaches PAST the account name.
  // Anything less and the `..` walk goes up over the home root and back down
  // through it, carrying the name into a path that is relative and therefore
  // looks safe -- `../../../Users/someone/.claude/x`. The old rule asked this of
  // the FIRST segment only, which is a home root on a plain POSIX box and is
  // `System`, `Volumes`, `net` or a drive letter on every other shape a home
  // path really takes; homeRootAt finds it wherever it is.
  //
  // Tested on the segments and not on the resulting text, which is what keeps it
  // precise: a repository with an `app/home/page` in it produces the same
  // substring and is not this.
  const h = homeRootAt(to)
  if (h >= 0 && i <= h + 1) return deName(tilde(p))
  const up = from.length - i
  return deName([...Array<string>(up).fill('..'), ...to.slice(i)].join('/') || '.')
}

/** The last shape an account name arrives in, after the prefixes have cancelled.
 *  Applied to every return above rather than at one exit, because there is no
 *  single exit and a scrub that runs on three of four paths is the failure this
 *  file is written against. */
const deName = (s: string): string => s.replace(HOME_DASH_SEGMENT, `$1${WITHHELD}`)

/** The turn's raw path counts, relativised and ordered. Most-touched first, ties
 *  broken by path, so two readings of one transcript serialise identically. */
function fileList(raw: Record<string, number> | undefined, root: string | null): TurnFileTouch[] {
  if (!raw) return []
  const merged: Record<string, number> = {}
  // Two raw spellings can collapse to one stored path -- `/repo/src/a.ts` and
  // `src/a.ts` are the same file named twice -- so the counts are summed after
  // rewriting, not before.
  for (const [p, n] of Object.entries(raw)) {
    const key = spinePath(p, root)
    merged[key] = (merged[key] || 0) + n
  }
  return Object.entries(merged)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// ---------------------------------------------------------------- token accum

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
}

function addUsage(acc: TokenTotals, usage: UsageRecord | undefined): void {
  if (!usage) return
  acc.input += usage.input_tokens || 0
  acc.output += usage.output_tokens || 0
  acc.cacheRead += usage.cache_read_input_tokens || 0
  acc.cacheCreate += usage.cache_creation_input_tokens || 0
}

// ---------------------------------------------------------------- record source

/** Claude Code's own transcripts: one record per line, nothing to normalise.
 *
 *  The parse is kept out of the yield so that a throw from *downstream* — the
 *  spine's tool-block loop hits one on a malformed `content` object — travels
 *  back out to the caller instead of being swallowed by the torn-line catch and
 *  silently truncating the session. */
async function* claudeRecords(file: string): AsyncGenerator<TranscriptRecord> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (!line.trim()) continue
    let rec: TranscriptRecord
    try {
      rec = JSON.parse(line) as TranscriptRecord
    } catch {
      continue // tolerate a torn final line on a live session
    }
    yield rec
  }
}

// Which harness wrote a transcript is a fact about where it lives, so the roots
// answer it and only a file handed to the CLI by path has to be sniffed. Read
// once: a corpus scan calls this per file, and no answer can change mid-run.
let ROOTS: TranscriptRoot[] | null = null
function rootOf(file: string): TranscriptRoot | null {
  if (!ROOTS) ROOTS = transcriptRoots()
  return ROOTS.find((r) => file.startsWith(r.dir.endsWith('/') ? r.dir : r.dir + '/')) || null
}

// ---------------------------------------------------------------- extraction

export async function extract(
  file: string,
  { redactText = true, maxPromptChars = 4000, recordPaths = true, retainTrace = false, harness: harnessOpt }: ExtractOptions = {}
): Promise<Session> {
  const root = rootOf(file)
  // Cursor is sniffed ahead of the root lookup, not after it. Its sessions are
  // addressed `<db>#<composerId>`, a string that begins with the globalStorage
  // root — so rootOf() matches it by prefix, hands back harness 'cursor'
  // correctly, but the same prefix logic would let a `--project` path or a
  // hand-passed file fall through to the JSONL reader and fail as a missing
  // file. Deciding on the address itself is the only check that cannot.
  const harness = isCursorTranscript(file) ? 'cursor'
    : harnessOpt || root?.harness || (isCodexTranscript(file) ? 'codex' : 'claude-code')
  const session: SessionDraft = {
    sessionId: null,
    file,
    harness,
    // Claude Code's project directory is the transcript's parent, so its
    // basename names the project. Codex nests YYYY/MM/DD, where that basename
    // is a day number twelve unrelated projects a year would share. Cursor has
    // no directory at all — its project is the checkout its files came from,
    // resolved by the adapter and carried on the records.
    project: harness === 'cursor' ? ''
      : harness === 'codex' ? codexProject(file, root?.dir)
      : basename(file.replace(/\/[^/]+$/, '')),
    cwd: null,
    gitBranch: null,
    version: null,
    redactedPrompts: redactText,
    retainedTrace: retainTrace,
    trace: [],
    recordedPaths: recordPaths,
    title: null,
    startedAt: null,
    endedAt: null,
    models: {},
    artifacts: emptyArtifacts(),
    slashCommands: [],
    permissionModes: [],
    totals: {
      records: 0,
      humanTurns: 0,
      assistantMessages: 0,
      toolCalls: 0,
      sidechainRecords: 0,
      interruptions: 0,
      compactions: 0,
      steeringTurns: 0,
      tokens: emptyTokens(),
    },
    turns: [],
  }

  // Calls awaiting their result. Keyed by tool_use id where the harness emits
  // one; `open` is the fallback for a harness that does not, paired in order,
  // which is correct for a serial tool loop and is stated rather than assumed.
  const pending = new Map<string, RetainedCall>()
  const open: RetainedCall[] = []
  let current: TurnDraft | null = null

  const newTurn = ({ index, uuid, ts, text, promptId = null, hasImage = false, typed = true, steering = false, origin = null, effort = null }: NewTurnArgs): TurnDraft => ({
    index,
    promptId,
    uuid,
    startedAt: ts,
    endedAt: null,
    durationMs: 0,
    text: text.length > maxPromptChars ? text.slice(0, maxPromptChars) + '\n…[truncated]' : text,
    fullChars: text.length,
    hasImage,
    typed,
    steering,
    origin,
    signals: signals(text),
    tokens: emptyTokens(),
    assistantMessages: 0,
    subagents: 0,
    interruptions: 0,
    slashCommands: [],
    effort,
    firstToolAt: null,
    timeToFirstToolMs: null,
    files: [],
    _tools: {},
    _models: {},
    // Absent, not empty, when paths are off. `harvestTool` records nothing when
    // handed null, so the switch lives in one place rather than at every call.
    _files: recordPaths ? {} : undefined,
  })

  const closeTurn = (ts: string | null | undefined): void => {
    if (!current) return
    current.endedAt = ts || current.startedAt
    current.durationMs = Date.parse(current.endedAt) - Date.parse(current.startedAt) || 0
    current.toolCalls = Object.entries(current._tools!)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
    current.toolCallCount = current.toolCalls.reduce((n, t) => n + t.count, 0)
    delete current._tools
    // A turn can span a model switch (/model mid-flight, or a fallback). Keep
    // the full breakdown, and name the model that did most of the work so the
    // turn can be attributed to exactly one of them downstream.
    current.models = Object.entries(current._models!)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
    current.model = current.models[0]?.name || null
    current.mixedModel = current.models.length > 1
    delete current._models
    session.turns.push(current as SessionTurn)
    current = null
  }

  // Everything below this line is harness-agnostic given a TranscriptRecord.
  // A Codex rollout is normalised into these shapes on the way in rather than
  // being taught to the switch, so the spine has exactly one record vocabulary
  // to reason about and Claude Code's path is the one it always was.
  const source = harness === 'cursor' ? cursorRecords(file)
    : harness === 'codex' ? codexRecords(file)
    : claudeRecords(file)

  for await (const rec of source) {
    session.totals.records++

    const ts = rec.timestamp
    if (ts) {
      if (!session.startedAt) session.startedAt = ts
      session.endedAt = ts
    }
    if (!session.sessionId && rec.sessionId) session.sessionId = rec.sessionId
    if (!session.cwd && rec.cwd) session.cwd = rec.cwd
    if (!session.gitBranch && rec.gitBranch) session.gitBranch = rec.gitBranch
    if (!session.version && rec.version) session.version = rec.version
    if (rec.isSidechain) session.totals.sidechainRecords++

    switch (rec.type) {
      case 'ai-title':
      case 'custom-title':
        // later titles supersede earlier ones
        session.title = rec.title || rec.customTitle || rec.aiTitle || session.title
        break

      case 'mode':
        if (rec.mode) session.permissionModes.push({ ts, mode: rec.mode })
        break

      // Messages sent while a turn is still running are not user records at all
      // — they arrive as queued_command attachments. They are genuine human
      // instructions and they redirect the work that follows, so they open a new
      // turn, flagged to distinguish steering from a fresh prompt.
      case 'attachment': {
        if (rec.attachment?.type !== 'queued_command') break
        // prompt is a string for typed text, but an array of content blocks when
        // the user pastes images mid-flight. textOf handles both; base64 image
        // payloads are dropped rather than carried into the spine.
        const p = rec.attachment.prompt
        const hasImage = Array.isArray(p) && p.some((b) => b.type === 'image')
        const raw = textOf(p).replace(REMINDER, '').trim()
        if (!raw && !hasImage) break
        // Background machinery also arrives on this path — a task notification
        // firing mid-turn is queued exactly like typed steering. It is not human
        // intent, and counting it opens a phantom turn that inherits whatever
        // friction the real turn was already carrying.
        if (INJECTED.test(raw)) break
        closeTurn(ts)
        session.totals.humanTurns++
        session.totals.steeringTurns++
        const body = raw || '[image]'
        current = newTurn({
          index: session.totals.humanTurns - 1,
          uuid: rec.attachment.source_uuid || rec.uuid,
          ts,
          text: redactText ? redact(body) : body,
          hasImage,
          steering: true,
          origin: rec.attachment.origin || null,
        })
        break
      }

      case 'assistant': {
        session.totals.assistantMessages++
        // `<synthetic>` marks harness-generated assistant records (API error
        // placeholders and the like), not a model that ran. Counting it would
        // put a phantom "model" in every per-model comparison.
        const model = rec.message?.model
        if (model && model !== '<synthetic>') session.models[model] = (session.models[model] || 0) + 1
        addUsage(session.totals.tokens, rec.message?.usage)
        if (current) {
          addUsage(current.tokens, rec.message?.usage)
          current.assistantMessages++
          if (model && model !== '<synthetic>') current._models![model] = (current._models![model] || 0) + 1
          if (rec.effort) current.effort = rec.effort
        }
        for (const block of (rec.message?.content || []) as ToolUseBlock[]) {
          if (block.type !== 'tool_use') continue
          session.totals.toolCalls++
          if (retainTrace) {
            // Inputs are redacted here and not at the far end, for the reason the
            // prompt text is: this is the only place that knows whether redaction
            // was asked for, and a payload redacted by whoever happens to send it
            // is a payload nobody can make a claim about.
            const call: RetainedCall = {
              turn: current ? current.index : -1,
              seq: session.trace.length,
              tool: block.name,
              startedAt: ts,
              durationMs: null,
              ok: true,
              errorKind: 'none',
              input: redactText ? redactDeep(block.input ?? null) : (block.input ?? null),
              result: null,
              resultBytes: 0,
              truncated: false,
            }
            session.trace.push(call)
            if (block.id) pending.set(block.id, call)
            else open.push(call)
          }
          // A tool call before the first human turn belongs to no turn, so its
          // path has nowhere to be attributed and is not recorded. It is still
          // counted in `fileTouches`, which is why that count can exceed the
          // paths below and why nothing may present one as the total of the other.
          harvestTool(block, session.artifacts, current?._files ?? null)
          if (!current) continue
          current._tools![block.name] = (current._tools![block.name] || 0) + 1
          if (!current.firstToolAt) {
            current.firstToolAt = ts
            current.timeToFirstToolMs = Date.parse(ts) - Date.parse(current.startedAt) || 0
          }
          if (block.name === 'Task' || block.name === 'Agent') current.subagents++
        }
        break
      }

      case 'user': {
        const c = classifyUser(rec)
        if (retainTrace && c.kind === 'tool_result') {
          const r = resultOf(rec)
          // A result whose call was never seen is dropped rather than invented:
          // it belongs to a tool_use in a record this reading did not reach.
          const call = r && (r.id ? pending.get(r.id) : open.shift())
          if (r && call) {
            if (r.id) pending.delete(r.id)
            const text = redactText ? redact(r.text) : r.text
            call.resultBytes = text.length
            call.truncated = text.length > MAX_TRACE_RESULT_CHARS
            call.result = call.truncated ? text.slice(0, MAX_TRACE_RESULT_CHARS) : text
            call.ok = !r.isError
            call.errorKind = r.isError ? 'tool_error' : 'none'
            call.durationMs = Date.parse(ts) - Date.parse(call.startedAt) || 0
          }
        }
        if (c.kind === 'interrupt') {
          session.totals.interruptions++
          if (current) current.interruptions++
          break
        }
        if (c.kind === 'slash') {
          if (c.command) {
            session.slashCommands.push(c.command)
            if (current) current.slashCommands.push(c.command)
          }
          break
        }
        if (c.kind === 'compaction') {
          session.totals.compactions++
          break
        }
        if (c.kind !== 'human') break

        closeTurn(ts)
        session.totals.humanTurns++
        const text = redactText ? redact(c.text) : c.text
        current = newTurn({
          index: session.totals.humanTurns - 1,
          promptId: rec.promptId || null,
          uuid: rec.uuid,
          ts,
          text,
          hasImage: !!c.hasImage,
          // An IDE-wrapped record is a real turn but nobody wrote it. Left off
          // the turn, classifyUser's verdict dies at the call site and a click
          // on an element scores as prose the user composed.
          typed: c.typed,
          effort: rec.effort || null,
        })
        break
      }
    }
  }
  closeTurn(session.endedAt)

  // Cross-turn signals. These are the honest quality metrics: they measure what
  // a prompt actually cost rather than how well-written it looks.
  // Pasted images arrive as identical placeholder text ("[Image: original
  // 2880x1800, displayed at ...]"), so two unrelated screenshots normalise to
  // the same key and register as a verbatim repeat — the heaviest deduction in
  // the model. Stripping the placeholder means a turn that is only an image
  // falls under the length floor and is never counted, while a turn with an
  // image *and* a real instruction still compares on the instruction.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\[image[^\]]*\]/g, ' ')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  const seen = new Map<string, number>()

  session.turns.forEach((t, i) => {
    // Here rather than in closeTurn, because closeTurn runs while the stream is
    // still going and `session.cwd` is set by the first record that carries one.
    // A turn closed before that record would relativise against null and store
    // the same file under a different key than every later turn.
    const draft = t as TurnDraft
    t.files = fileList(draft._files, session.cwd)
    delete draft._files

    const next = session.turns[i + 1]
    const key = norm(t.text)
    // A near-identical prompt sent twice means the first one did not land.
    const repeatOf = key.length > 12 && seen.has(key) ? seen.get(key)! : null
    if (key.length > 12 && !seen.has(key)) seen.set(key, i)

    t.derived = {
      noToolCalls: t.toolCallCount === 0,
      clarificationRoundtrip: t.toolCallCount === 0 && !!next,
      followedByCorrection: !!next?.signals.isCorrection,
      repeatOf,
    }
    // Friction = the prompt failed to land the first time, in any of the ways
    // the transcript can actually witness.
    //
    // A tool-less turn only counts as friction when it was *not* a question:
    // answering "explain onnx" without touching a tool is the correct outcome,
    // not a failed prompt.
    t.friction = [
      t.interruptions > 0 && 'interrupted',
      repeatOf !== null && 'repeated',
      t.signals.isCorrection && 'correction',
      t.derived.followedByCorrection && 'drew-correction',
      t.derived.clarificationRoundtrip && !t.signals.isQuestion && 'roundtrip',
    ].filter(Boolean) as FrictionKind[]

    t.score = scoreTurn(t)
  })

  session.score = scoreSession(session.turns)

  const f = session.turns.filter((t) => t.friction.length)
  session.totals.frictionTurns = f.length
  session.totals.frictionRate = session.turns.length ? +(f.length / session.turns.length).toFixed(3) : 0
  session.totals.repeats = session.turns.filter((t) => t.derived.repeatOf !== null).length
  session.totals.corrections = session.turns.filter((t) => t.signals.isCorrection).length

  session.durationMs = Date.parse(session.endedAt!) - Date.parse(session.startedAt!) || 0
  return session as Session
}

// ---------------------------------------------------------------- discovery

/** One directory per project, one JSONL per session, no recursion. Claude Code's
 *  layout, and the assumed shape of any root this file does not have an adapter
 *  for. */
function listProjectDirSessions(harness: string, root: string, projectFilter?: string | null): SessionFile[] {
  const out: SessionFile[] = []
  for (const proj of readdirSync(root)) {
    if (projectFilter && !proj.includes(projectFilter)) continue
    const dir = join(root, proj)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const full = join(dir, f)
      const st = statSync(full)
      out.push({ harness, project: proj, file: full, size: st.size, mtime: st.mtimeMs })
    }
  }
  return out
}

/**
 * Every transcript on this machine, newest first.
 *
 * The roots come from transcriptRoots(), which already returns only directories
 * that exist — so the old `existsSync(PROJECTS) → []` guard is now implicit, and
 * an empty result means "nothing has left transcripts where we know to look"
 * rather than "Claude Code has never run here".
 *
 * The scan cannot be shared, only the sort: Claude Code keeps sessions one level
 * under a project directory, Codex keeps them three levels down a date tree. A
 * fixed two-level readdir over ~/.codex/sessions returns ['2026'] and finds none
 * of the 436 rollouts under it, reporting success the whole way.
 */
export function listSessions(projectFilter?: string | null): SessionFile[] {
  const out: SessionFile[] = []
  for (const root of transcriptRoots()) {
    if (root.harness === 'codex') {
      out.push(...listCodexSessions(root.dir, projectFilter))
      continue
    }
    if (root.harness === 'cursor') {
      out.push(...listCursorSessions(root.dir, projectFilter))
      continue
    }
    out.push(...listProjectDirSessions(root.harness, root.dir, projectFilter))
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function resolveTarget(arg: string | undefined, projectFilter?: string | null): string | null {
  // A Cursor address is not a path, so existsSync is false for a perfectly
  // valid one — accepted explicitly rather than falling through to the
  // basename search, which would never match a composer UUID.
  if (arg && isCursorTranscript(arg)) return arg
  if (arg && existsSync(arg)) return arg
  const all = listSessions(projectFilter)
  if (!all.length) return null
  if (arg) {
    const hit = all.find((s) => basename(s.file).startsWith(arg))
    return hit ? hit.file : null
  }
  // No argument means "this session". /qpact's first step runs `extract.mjs
  // --json` with none and its skill states the contract outright — "it resolves
  // the most recently modified transcript, which is the live session". Newest
  // overall stopped meaning that the moment a second harness's transcripts
  // joined the list: a Codex rollout written a minute ago outranks the live
  // Claude Code transcript, render.mjs produces a report for the foreign
  // harness, and the skill goes on to describe it as "this session". Preferring
  // the running harness restores the contract for both, and only falls back to
  // newest-overall when nothing says which harness this is.
  const running = harnessLabel()
  return (all.find((s) => s.harness === running) || all[0]!).file
}

// ---------------------------------------------------------------- cli

function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
}

function summarize(s: Session): string {
  const L: string[] = []
  L.push(`session   ${s.sessionId}   harness:${s.harness}`)
  L.push(`title     ${s.title || '—'}`)
  L.push(`cwd       ${s.cwd}   branch:${s.gitBranch || '—'}`)
  L.push(`span      ${s.startedAt} → ${s.endedAt}  (${fmtDuration(s.durationMs)})`)
  L.push(`models    ${Object.entries(s.models).map(([m, n]) => `${m}×${n}`).join(', ') || '—'}`)
  L.push('')
  const t = s.totals
  L.push(
    `records ${t.records}  human-turns ${t.humanTurns}  assistant ${t.assistantMessages}  ` +
      `tool-calls ${t.toolCalls}  interruptions ${t.interruptions}  sidechain ${t.sidechainRecords}`
  )
  L.push(
    `tokens  in ${fmtTokens(t.tokens.input)}  out ${fmtTokens(t.tokens.output)}  ` +
      `cache-read ${fmtTokens(t.tokens.cacheRead)}  cache-write ${fmtTokens(t.tokens.cacheCreate)}`
  )
  // Said in the terminal too, because a person running this to see what the tool
  // holds should not have to read the JSON to find out that it now holds paths.
  const distinct = new Set(s.turns.flatMap((turn) => turn.files.map((f) => f.path))).size
  L.push(
    s.recordedPaths
      ? `files   ${s.artifacts.fileTouches} tool call(s) named a file; ${distinct} distinct path(s) kept, per turn`
      : `files   ${s.artifacts.fileTouches} tool call(s) named a file; no path kept (--no-paths)`
  )
  L.push('')
  L.push('  #  dur     tools  out-tok  flags  prompt')
  for (const turn of s.turns) {
    const flags = [
      turn.interruptions ? 'INT' : '',
      turn.signals.isCorrection ? 'CORR' : '',
      turn.derived.clarificationRoundtrip ? 'RT' : '',
      turn.signals.terse ? 'TERSE' : '',
      turn.signals.hasAcceptanceCriteria ? 'AC' : '',
      turn.signals.hasFileRef ? 'REF' : '',
    ].filter(Boolean).join(',')
    const preview = turn.text.replace(/\s+/g, ' ').slice(0, 62)
    L.push(
      `${String(turn.index).padStart(3)}  ${fmtDuration(turn.durationMs).padEnd(6)}  ` +
        `${String(turn.toolCallCount).padStart(5)}  ${fmtTokens(turn.tokens.output).padStart(7)}  ` +
        `${flags.padEnd(18)}  ${preview}`
    )
  }
  return L.join('\n')
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (n: string) => argv.includes(n)
  const opt = (n: string) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : null
  }

  if (flag('--list')) {
    const rows = listSessions(opt('--project')).slice(0, Number(opt('--limit') || 20))
    for (const r of rows) {
      console.log(
        `${new Date(r.mtime).toISOString().slice(0, 16)}  ${String(Math.round(r.size / 1024)).padStart(7)}k  ` +
          `${basename(r.file).slice(0, 8)}  ${r.project}`
      )
    }
    process.exit(0)
  }

  // Which argument is a flag's value is a fact about position, not about text:
  // indexOf() answers with the *first* match, so in `--project foo foo` the
  // trailing session id resolves back to the --project slot and is discarded —
  // the tool then extracts the newest session in the project instead of the one
  // that was named, and says nothing about it.
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) continue
    const prev = argv[i - 1]
    if (prev === '--project' || prev === '--limit') continue
    positional.push(a)
  }
  const target = resolveTarget(positional[0], opt('--project'))
  if (!target) {
    console.error('no session found. try --list')
    process.exit(1)
  }
  const result = await extract(target, {
    redactText: !flag('--no-redact'),
    recordPaths: !flag('--no-paths'),
    // Opt IN, unlike the two above. Those describe what is kept by default and
    // can be turned off; this is off until asked for, because a trace is every
    // command that ran and every file that was written.
    retainTrace: flag('--with-trace'),
  })
  console.log(flag('--json') ? JSON.stringify(result, null, 2) : summarize(result))
}
