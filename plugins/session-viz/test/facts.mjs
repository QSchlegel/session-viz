#!/usr/bin/env node
// The facts projection: what it emits, and what it must never carry.
//
// This is the second payload a /qpact report ships and the first one a
// colleague can query. It is built from a spine that carries the absolute
// transcript path, the dash-encoded project key, the working directory and the
// verbatim text of every prompt — four things that each contain either somebody's
// home directory, and therefore their username, or the thing they typed.
//
// So the central assertion here is not a shape check. It is a spine built so
// that every refused field carries a unique sentinel, and an assertion that no
// sentinel survives into the output. A shape test passes on a projection that
// spreads the whole session in under a key nobody looked at; this one does not.

import {
  indexFacts, traceFacts, undisclosedFacts, undisclosedTrace,
  collectFiles, keyPaths, INDEX_FIELDS, TRACE_CALL_FIELDS, MAX_RESULT_CHARS,
} from '../scripts/facts.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (t) => console.log(`\n— ${t}`)

// Each sentinel is unique so a failure names WHICH refused field leaked, rather
// than reporting that something did.
const S = {
  home: 'SENTINEL-HOME-ada',
  file: '/Users/SENTINEL-HOME-ada/.claude/projects/SENTINEL-PROJECT-key/x.jsonl',
  project: '-Users-SENTINEL-HOME-ada-git-SENTINEL-PROJECT-key',
  cwd: '/Users/SENTINEL-HOME-ada/git/acme',
  prompt: 'SENTINEL-PROMPT the thing somebody actually typed',
  outsidePath: '../../SENTINEL-OUTSIDE/secrets.env',
  absPath: '/etc/SENTINEL-ABSOLUTE/passwd',
}

const spine = {
  sessionId: 'sess-1', harness: 'claude-code',
  file: S.file, project: S.project, cwd: S.cwd,
  gitBranch: 'main', version: '2.0.0', title: 'A session',
  startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z', durationMs: 3600000,
  redactedPrompts: true, recordedPaths: true,
  models: { 'claude-opus-5': 4 }, slashCommands: ['/qpact'],
  artifacts: { tools: { git: 2 }, mcp: { railway: 1 }, packages: {}, stack: {}, extensions: {}, skills: {}, fileTouches: 3 },
  totals: {
    records: 10, humanTurns: 2, assistantMessages: 6, toolCalls: 5, sidechainRecords: 0,
    interruptions: 1, compactions: 0, steeringTurns: 0, repeats: 1, corrections: 0,
    frictionTurns: 1, frictionRate: 0.5, tokens: { input: 5, output: 100, cacheRead: 9000, cacheCreate: 50 },
  },
  turns: [
    {
      index: 0, durationMs: 1000, toolCallCount: 2, tokens: { output: 60 },
      text: S.prompt, fullChars: 48, friction: ['repeated'], score: { value: 70 },
      signals: { chars: 48, isQuestion: false },
      files: [{ path: 'src/a.ts', count: 2 }, { path: S.outsidePath, count: 1 }, { path: S.absPath, count: 1 }],
      toolCalls: [{ name: 'Bash', count: 2 }],
    },
    {
      index: 1, durationMs: 2000, toolCallCount: 3, tokens: { output: 40 },
      text: S.prompt, friction: [], score: { value: 90 },
      files: [{ path: 'src/a.ts', count: 1 }], toolCalls: [{ name: 'Read', count: 3 }],
    },
  ],
  score: { value: 80, band: 'solid', confidence: 'low', turnsScored: 2, frictionRate: 0.5, craftRate: 0.5, wastedTokens: 12, costliestTurn: 0 },
}

const facts = indexFacts(spine, { pluginVersion: '0.26.0' })
const wire = JSON.stringify(facts)

// ------------------------------------------------------------------ leaks

section('Nothing the contract refuses survives the projection')
for (const [what, value] of Object.entries(S)) {
  chk(`no ${what} sentinel in the index tier`, !wire.includes(value),
    `${JSON.stringify(value)} reached the wire`)
}
chk('the whole home directory is absent, in any field',
  !wire.includes('/Users/') && !wire.includes('-Users-'),
  'a path fragment survived; the index tier is workspace-visible and this is the username')

// ------------------------------------------------------- closed, both ways

section('The payload is exactly what the contract names')
const u = undisclosedFacts(facts)
chk('no undisclosed field', u.extra.length === 0, u.extra.join(', '))
chk('no contract field left unemitted', u.missing.length === 0, u.missing.join(', '))
chk(`all ${INDEX_FIELDS.length} declared fields are emitted every time`,
  keyPaths(facts, INDEX_FIELDS).length === INDEX_FIELDS.length)

// A field smuggled in after the fact must be caught by the walk, not by review.
chk('a stray key is reported rather than ridden along',
  undisclosedFacts({ ...facts, cwd: S.cwd }).extra.includes('cwd'),
  'undisclosedFacts did not notice an added key')
chk('a dropped key is reported too',
  undisclosedFacts({ ...facts, repo: undefined, models: undefined }).missing.includes('models'),
  'a field the schema promises can go missing unnoticed')
// `models` keys are model ids and must not each read as an undisclosed field.
chk('a declared container terminates the walk',
  !u.extra.includes('models.claude-opus-5'),
  'the walk descended into a container and reported its contents as fields')

// ----------------------------------------------------------- the repository

section('A worktree folds onto its repository, and is kept')
chk('repo is the repository', facts.repo === 'acme', JSON.stringify(facts.repo))
chk('worktree is null outside one', facts.worktree === null, JSON.stringify(facts.worktree))
const wt = indexFacts({ ...spine, cwd: `${S.cwd}/.claude/worktrees/feature-x` }, {})
chk('inside a worktree, repo is still the repository', wt.repo === 'acme', JSON.stringify(wt.repo))
chk('and the worktree is its own axis', wt.worktree === 'feature-x', JSON.stringify(wt.worktree))

// --------------------------------------------------------------- the files

section('Paths that escape the repository are dropped and counted')
chk('a relative path is kept', facts.files_touched.includes('src/a.ts'))
chk('a ../ path is not', !facts.files_touched.some((p) => p.includes('SENTINEL-OUTSIDE')))
chk('an absolute path is not', !facts.files_touched.some((p) => p.includes('SENTINEL-ABSOLUTE')))
chk('and both are counted rather than silently omitted', facts.files_dropped === 2,
  `files_dropped is ${facts.files_dropped}`)
chk('the same file touched twice is listed once',
  facts.files_touched.filter((p) => p === 'src/a.ts').length === 1)

section('recordedPaths is tri-state and never coerced')
chk('true reads as yes', indexFacts({ ...spine, recordedPaths: true }, {}).paths_recorded === 'yes')
chk('false reads as no', indexFacts({ ...spine, recordedPaths: false }, {}).paths_recorded === 'no')
chk('absent reads as UNKNOWN, not as no',
  indexFacts({ ...spine, recordedPaths: undefined }, {}).paths_recorded === 'unknown',
  'a spine written before that field existed would otherwise claim paths were not recorded, and an empty file list would read as "touched nothing"')

// ---------------------------------------------------------------- the score

section('An unmeasured score is null, not zero')
const none = indexFacts({ ...spine, turns: [], score: { value: null, band: null, confidence: 'none', turnsScored: 0 } }, {})
chk('value stays null', none.score.value === null, JSON.stringify(none.score.value))
chk('band stays null', none.score.band === null)
chk('the optional fields are null rather than 0', none.score.craft_rate === null && none.score.wasted_tokens === null,
  'coercing an absent measurement to 0 reports a perfect-worst session nobody measured')

// ---------------------------------------------------------------- the trace

section('A trace call carries what it says and says what it cut')
const long = 'x'.repeat(MAX_RESULT_CHARS + 500)
const [call] = traceFacts([{ turn: 1, seq: 0, tool: 'Bash', input: { command: 'ls' }, result: long, durationMs: 5 }])
chk('exactly the declared fields', undisclosedTrace(call).extra.length === 0 && undisclosedTrace(call).missing.length === 0,
  JSON.stringify(undisclosedTrace(call)))
chk('the result is truncated', call.result.length === MAX_RESULT_CHARS)
chk('and the original length survives, so a reader sees what was cut',
  call.result_bytes === long.length && call.truncated === true,
  `result_bytes ${call.result_bytes}, truncated ${call.truncated}`)
const [mcp] = traceFacts([{ turn: 0, seq: 1, tool: 'mcp__railway__get_logs' }])
chk('an MCP call names its server', mcp.mcp_server === 'railway', JSON.stringify(mcp.mcp_server))
chk('a plain tool names none', call.mcp_server === null)
chk(`the trace tier declares ${TRACE_CALL_FIELDS.length} fields`, TRACE_CALL_FIELDS.length === 13)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
