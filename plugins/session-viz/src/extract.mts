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

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, basename } from 'node:path'
import { codexProject, codexRecords, isCodexTranscript, listCodexSessions } from './codex.mjs'
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
  origin: string | null
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
}

export interface ExtractOptions {
  redactText?: boolean
  maxPromptChars?: number
  /** Overrides the harness inferred from the path. */
  harness?: string
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
  name: string
  input?: ToolInput
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
}

interface TranscriptAttachment {
  type?: string
  prompt?: string | ContentBlock[]
  source_uuid?: string
  origin?: string
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
  origin?: string | null
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

function harvestPath(p: unknown, out: SessionArtifacts): void {
  if (typeof p !== 'string' || !p) return
  const base = p.replace(/^.*\//, '').toLowerCase()
  if (STACK_FILES.has(base)) bump(out.stack, base)
  const ext = base.includes('.') ? base.replace(/^.*\./, '') : null
  if (ext && ext.length <= 5 && /^[a-z0-9]+$/.test(ext)) bump(out.extensions, ext)
  out.fileTouches++
}

export function harvestTool(block: ToolUseBlock, out: SessionArtifacts): void {
  const i = block.input
  if (!i || typeof i !== 'object') return
  const name = block.name

  if (name.startsWith('mcp__')) bump(out.mcp, name.split('__')[1])
  if (name === 'Skill' && typeof i.skill === 'string') bump(out.skills, i.skill)
  if (name === 'Bash') harvestBash(i.command, out)

  let ext: string | null = null
  for (const key of ['file_path', 'path', 'notebook_path'] as const) {
    if (!i[key]) continue
    harvestPath(i[key], out)
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
  { redactText = true, maxPromptChars = 4000, harness: harnessOpt }: ExtractOptions = {}
): Promise<Session> {
  const root = rootOf(file)
  const harness = harnessOpt || root?.harness || (isCodexTranscript(file) ? 'codex' : 'claude-code')
  const session: SessionDraft = {
    sessionId: null,
    file,
    harness,
    // Claude Code's project directory is the transcript's parent, so its
    // basename names the project. Codex nests YYYY/MM/DD, where that basename
    // is a day number twelve unrelated projects a year would share.
    project: harness === 'codex' ? codexProject(file, root?.dir) : basename(file.replace(/\/[^/]+$/, '')),
    cwd: null,
    gitBranch: null,
    version: null,
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
    _tools: {},
    _models: {},
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
  const source = harness === 'codex' ? codexRecords(file) : claudeRecords(file)

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
          harvestTool(block, session.artifacts)
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
    out.push(...listProjectDirSessions(root.harness, root.dir, projectFilter))
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function resolveTarget(arg: string | undefined, projectFilter?: string | null): string | null {
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
  const result = await extract(target, { redactText: !flag('--no-redact') })
  console.log(flag('--json') ? JSON.stringify(result, null, 2) : summarize(result))
}
