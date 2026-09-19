// What a transcript can witness about whether work landed.
//
// -- Why this is its own module --------------------------------------------
// runs.mts has classified delivery for autonomous runs since it was written,
// and extract.mts now needs the same classification for sessions with a human
// in them. Two copies of "what counts as a successful write" would be two
// definitions that drift silently, each exercised by its own suite — the
// failure cloud.mts's header describes for `api()`, which existed three times
// before it existed once.
//
// So the vocabulary lives here and both callers feed it. runs.mts keeps its own
// accumulation loop, because it scans raw records and this does not; what it
// takes from here is the SET of write tools, the target field, and the rule
// that turns counts into a state.
//
// -- The ladder this is two rungs of ---------------------------------------
// claimed (authored, from the intent store) → wrote → verified → committed.
// This module owns `wrote` and `verified`. `committed` needs a repository and
// lives in landed.mts. `claimed` is written by the model and never measured.
//
// -- What each rung refuses to claim ---------------------------------------
// `wrote_ok` is a tool result that was not an error. It is not "the file is
// correct" and not "the file still exists" — the artifact probe answers the
// second and nothing answers the first.
//
// `passed` is a check process that exited zero. A runner that exits zero while
// reporting failures reads as passed here, and a flaky failure reads as failed.
// It is evidence that a check RAN and what it said, not a claim about the code.

import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** Widened to accept a missing name: the membership tests run against tool
 *  names that may not have been seen (an unmatched tool_result). */
export const WRITE_TOOLS = new Set<string | undefined>(['Write', 'Edit', 'NotebookEdit'])

/** The path field used by the three write tools across supported harnesses.
 *  Exported for the contract test: format drift here silently turns a real
 *  probe back into an `unavailable` counter. */
export function writeTarget(name: string | undefined, input: unknown): string | null {
  if (!WRITE_TOOLS.has(name) || !input || typeof input !== 'object' || Array.isArray(input)) return null
  const o = input as Record<string, unknown>
  const raw = name === 'NotebookEdit'
    ? o.notebook_path ?? o.file_path ?? o.path
    : o.file_path ?? o.path
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || null
}

export type DeliveryState = 'wrote_ok' | 'denied' | 'unverified' | 'no_intent'
export type VerificationState = 'none' | 'ran' | 'passed' | 'failed'

/**
 * Binaries whose invocation is a check on the work, not the work itself.
 *
 * Deliberately narrow. A broad list — anything that could fail — would make
 * `verified` mean "ran a command", which is every session, and the rung would
 * stop separating anything. These are programs whose entire job is to answer
 * "is it still right": test runners, type checkers, linters and builds.
 *
 * `git` is NOT here. A commit is the rung above, and counting `git status` as
 * verification would let the ladder climb itself.
 */
const CHECK_BINARIES = new Set([
  'pytest', 'vitest', 'jest', 'mocha', 'ava', 'playwright', 'cypress',
  'tsc', 'eslint', 'ruff', 'mypy', 'flake8', 'pylint', 'rubocop', 'clippy',
  'shellcheck', 'phpunit', 'rspec', 'gotestsum',
])

/**
 * Runners whose CHECK-ness depends on the subcommand: `npm test` is a check,
 * `npm install` is not. Matched on the first two words of a segment.
 *
 * A Map, not an object literal, and that is a bug fix rather than a style
 * choice. Indexing a plain object with a word taken from a command line hits
 * `Object.prototype` for `constructor`, `toString`, `valueOf` and the rest —
 * which returns a FUNCTION, and the `.has()` below then throws. Three of the
 * 798 sessions in the corpus this was first run against began a shell segment
 * with such a word, and each one crashed the whole extraction rather than
 * returning "not a check".
 */
const CHECK_SUBCOMMANDS = new Map<string, Set<string>>([
  ['npm', new Set(['test', 'run'])],
  ['pnpm', new Set(['test', 'run'])],
  ['yarn', new Set(['test', 'run'])],
  ['bun', new Set(['test', 'run'])],
  ['cargo', new Set(['test', 'check', 'clippy', 'build'])],
  ['go', new Set(['test', 'vet', 'build'])],
  ['make', new Set(['test', 'check', 'lint', 'build'])],
  ['gradle', new Set(['test', 'check', 'build'])],
  ['mvn', new Set(['test', 'verify'])],
  ['dotnet', new Set(['test', 'build'])],
  ['swift', new Set(['test', 'build'])],
  ['rake', new Set(['test', 'spec'])],
  ['tox', new Set([''])],
  ['nox', new Set([''])],
])

/** `npm run <script>` is a check only when the script name says so — `npm run
 *  dev` starts a server and proves nothing. */
const CHECK_SCRIPTS = /^(test|check|lint|typecheck|type-check|tsc|build|verify|ci|e2e|coverage)\b/

/**
 * The label of the check a shell command runs, or null.
 *
 * Splits the way harvestBash does, because real commands are pipelines and
 * `&&` chains and the check is rarely the first word of the whole line.
 */
export function checkLabel(cmd: string | undefined): string | null {
  if (!cmd) return null
  for (const seg of cmd.split(/[|;&\n]+|\$\(/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean)
    if (!words.length) continue
    // A leading `sudo`, `time` or env assignment is not the command.
    let i = 0
    while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]!) ||
      words[i] === 'sudo' || words[i] === 'time' || words[i] === 'nice')) i++
    const head = (words[i] || '').replace(/^.*\//, '')
    if (!head) continue
    if (CHECK_BINARIES.has(head)) return head
    const subs = CHECK_SUBCOMMANDS.get(head)
    if (!subs) continue
    const sub = words[i + 1] || ''
    if (subs.has('')) return head
    if (!subs.has(sub)) continue
    // `npm run <script>` needs the script to name a check.
    if (sub === 'run') {
      const script = words[i + 2] || ''
      if (!CHECK_SCRIPTS.test(script)) continue
      return `${head} run ${script}`
    }
    return `${head} ${sub}`
  }
  return null
}

/** One check the transcript saw, and where it sat in the tool order. */
export interface CheckRun {
  seq: number
  label: string
  /** null when the call had no result in this reading — the check ran and what
   *  it said is unknown, which is a third thing from passed and failed. */
  ok: boolean | null
}

/**
 * Everything the two rungs need, accumulated in tool order.
 *
 * `seq` is a monotonic tool-call counter, not a turn index: "after the last
 * write" has to be answerable inside a single turn, which is where most
 * write-then-test sequences happen.
 */
export interface OutcomeScan {
  intentWrite: number
  wroteOk: number
  writeDenied: number
  writeTargets: Set<string>
  /** Successful writes whose target field could not be read. Counted so the
   *  probe can say "unavailable" rather than silently reporting fewer. */
  writesWithoutTarget: number
  lastWriteSeq: number | null
  checks: CheckRun[]
  seq: number
}

export const newOutcomeScan = (): OutcomeScan => ({
  intentWrite: 0, wroteOk: 0, writeDenied: 0,
  writeTargets: new Set(), writesWithoutTarget: 0,
  lastWriteSeq: null, checks: [], seq: 0,
})

interface PendingCall { name: string; target: string | null; seq: number; check: string | null }

/** Call once per `tool_use`, in document order. Returns the pending record the
 *  matching result must be handed back with. */
export function noteToolUse(
  scan: OutcomeScan, { name, input }: { name: string; input?: unknown },
): PendingCall {
  const seq = ++scan.seq
  const target = writeTarget(name, input)
  if (WRITE_TOOLS.has(name)) scan.intentWrite++
  const cmd = name === 'Bash' && input && typeof input === 'object'
    ? (input as { command?: unknown }).command
    : undefined
  return { name, target, seq, check: checkLabel(typeof cmd === 'string' ? cmd : undefined) }
}

/**
 * Call once per `tool_result`, with the call it answers.
 *
 * A result whose call was never seen is dropped rather than invented — the
 * same rule the trace reader applies, and for the same reason: it belongs to a
 * tool_use in a record this reading did not reach.
 */
export function noteToolResult(
  scan: OutcomeScan, call: PendingCall | undefined, isError: boolean,
): void {
  if (!call) return
  if (WRITE_TOOLS.has(call.name)) {
    if (isError) scan.writeDenied++
    else {
      scan.wroteOk++
      scan.lastWriteSeq = call.seq
      if (call.target) scan.writeTargets.add(call.target)
      else scan.writesWithoutTarget++
    }
  }
  if (call.check) scan.checks.push({ seq: call.seq, label: call.check, ok: !isError })
}

/** A check whose result never arrived. Recorded so "ran, outcome unknown" is
 *  distinguishable from "never ran". */
export function noteUnansweredCall(scan: OutcomeScan, call: PendingCall | undefined): void {
  if (!call || !call.check) return
  scan.checks.push({ seq: call.seq, label: call.check, ok: null })
}

/**
 * `denied` is tested AFTER `wrote_ok`, and the order is load-bearing.
 *
 * runs.mts learned this the hard way: testing denied first labelled a run with
 * ten good writes and one blocked edit `denied`, which dropped it out of the
 * cost-per-delivered denominator while its output tokens stayed in the
 * numerator.
 */
export function deliveryOf(scan: OutcomeScan): DeliveryState {
  if (scan.wroteOk > 0) return 'wrote_ok'
  if (scan.writeDenied > 0) return 'denied'
  if (scan.intentWrite > 0) return 'unverified'
  return 'no_intent'
}

/**
 * Did anything check the work after the last successful write?
 *
 * Only checks strictly after that write count. One run before the final edit
 * proves the state before it, which is the habit this rung exists to notice
 * the absence of.
 *
 * With no successful write there is nothing to have verified, so the answer is
 * `none` rather than a reading of whatever else ran. A session that only ran
 * tests has `no_intent` delivery, and the rung above is where it is described.
 */
export function verificationOf(scan: OutcomeScan): VerificationState {
  if (scan.lastWriteSeq === null) return 'none'
  const after = scan.checks.filter((c) => c.seq > scan.lastWriteSeq!)
  if (!after.length) return 'none'
  if (after.some((c) => c.ok === false)) return 'failed'
  if (after.some((c) => c.ok === true)) return 'passed'
  return 'ran'
}

/** The checks that count, for a page that wants to name them. */
export const checksAfterLastWrite = (scan: OutcomeScan): CheckRun[] =>
  scan.lastWriteSeq === null ? [] : scan.checks.filter((c) => c.seq > scan.lastWriteSeq!)

// ---------------------------------------------------------------- artifact

/** Moved here from runs.mts so the human-session path and the autonomous-run
 *  path probe the same way. The same reasoning as WRITE_TOOLS above: two
 *  copies of 'is the file still there' would be two answers. */
export type ArtifactProbeState = 'present' | 'partial' | 'not_found_local' | 'unavailable' | 'not_applicable'

export interface ArtifactProbe {
  state: ArtifactProbeState
  targeted: number
  present: number
  notFoundLocal: number
  unavailable: number
}

/** Probe only successful write targets and report what is visible NOW.
 *
 * A missing local path is not called failed delivery: the tool may have run in
 * a container, worktree, or remote filesystem, or the artifact may have moved
 * after the run. Presence is useful corroborating evidence; absence is a lead
 * to investigate. Both remain distinct from the transcript's `wrote_ok` fact. */
export function probeWriteTargets(
  targets: Iterable<string>, cwd: string | null, unavailable = 0,
): ArtifactProbe {
  let targeted = 0, present = 0, notFoundLocal = 0
  for (const target of new Set(targets)) {
    targeted++
    if (!isAbsolute(target) && !cwd) { unavailable++; continue }
    const path = isAbsolute(target) ? target : resolve(cwd!, target)
    try {
      const st = statSync(path)
      if (st.isFile()) present++
      else unavailable++
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') notFoundLocal++
      else unavailable++
    }
  }
  const state: ArtifactProbeState = present && notFoundLocal ? 'partial'
    : present ? 'present'
    : notFoundLocal ? 'not_found_local'
    : targeted || unavailable ? 'unavailable'
    : 'not_applicable'
  return { state, targeted, present, notFoundLocal, unavailable }
}
