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
  collectFiles, keyPaths, projectIntent, quotesAPrompt, INDEX_FIELDS, TRACE_CALL_FIELDS, MAX_RESULT_CHARS,
  MAX_INTENTS, MAX_CONCEPTS, MAX_RELATIONS, QUOTE_RUN,
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

// ------------------------------------------------- the model-written half

section('Intents and the graph reach the index tier without their prose')
// Every field the projection must drop carries its own sentinel, so a leak
// names the field. The document is shaped like intent.mjs's render file: this
// session's conclusions at the top level, earlier sessions under `prior`.
const D = {
  summary: 'SENTINEL-SUMMARY paraphrases what was typed',
  note: 'SENTINEL-NOTE also paraphrases it',
  tldr: 'SENTINEL-TLDR',
  compact: 'SENTINEL-COMPACT',
  quality: 'SENTINEL-QUALITY',
  prov: 'SENTINEL-PROVENANCE',
  prior: 'SENTINEL-PRIOR-SESSION',
  anchor: 'tool:SENTINEL-ANCHOR',
}
const intentDoc = {
  sessionId: 'sess-1', tldr: D.tldr, compactInstruction: D.compact,
  intents: [
    { title: 'Fix the parser', status: 'done', summary: D.summary, turns: [1, 2], provenance: { session: D.prov } },
    { title: '   ', status: 'done' },
    { title: 'Odd status', status: 'weird', turns: ['a', 3, -1, 2.5] },
  ],
  graph: {
    concepts: [
      { id: 'a', label: 'A defect', group: 'defect', note: D.note, anchors: [D.anchor], provenance: { session: D.prov } },
      { id: 'b', label: 'Unknown kind', group: 'not-a-kind' },
      { id: 7, label: 'not a string id' },
    ],
    relations: [
      { from: 'a', to: 'b', label: 'hidden by', dashed: true, turns: [1] },
      { from: 'a', to: D.anchor, label: 'into a derived node' },
      { from: 'zzz', to: 'a', label: 'from nowhere' },
    ],
  },
  prior: [{ sessionId: 'other', intents: [{ title: D.prior, status: 'done' }], graph: { concepts: [{ id: 'p', label: D.prior, group: 'decision' }], relations: [] } }],
  quality: { verdict: D.quality },
}
const withIntent = indexFacts(spine, { pluginVersion: '0.26.0' }, intentDoc)
const wire2 = JSON.stringify(withIntent)
chk('intents carry title, status and turns, and only those',
  JSON.stringify(withIntent.intents) === JSON.stringify([
    { title: 'Fix the parser', status: 'done', turns: [1, 2] },
    { title: 'Odd status', status: 'ongoing', turns: [3] },
  ]), JSON.stringify(withIntent.intents))
chk('a blank title is not an intent', withIntent.intents.length === 2)
chk('an unknown status reads as ongoing', withIntent.intents[1].status === 'ongoing')
chk('concepts carry id, label and kind, and only those',
  JSON.stringify(withIntent.graph.concepts) === JSON.stringify([
    { id: 'a', label: 'A defect', group: 'defect' },
    { id: 'b', label: 'Unknown kind', group: null },
  ]), JSON.stringify(withIntent.graph.concepts))
chk('an unknown kind becomes null rather than free text', withIntent.graph.concepts[1].group === null)
chk('a relation keeps only endpoints and label, and only between concepts',
  JSON.stringify(withIntent.graph.relations) === JSON.stringify([{ from: 'a', to: 'b', label: 'hidden by' }]),
  JSON.stringify(withIntent.graph.relations))
for (const [what, value] of Object.entries(D)) {
  chk(`no ${what} sentinel reaches the wire`, !wire2.includes(value), `${JSON.stringify(value)} crossed`)
}
chk('the original sentinels still do not cross with intents attached',
  Object.values(S).every((v) => !wire2.includes(v)))
const u2 = undisclosedFacts(withIntent)
chk('the payload with intents is still exactly what the contract names',
  u2.extra.length === 0 && u2.missing.length === 0, [...u2.extra, ...u2.missing].join(', '))
chk('no document at all means empty, not absent',
  JSON.stringify(indexFacts(spine, {}).intents) === '[]' && JSON.stringify(indexFacts(spine, {}).graph) === '{"concepts":[],"relations":[]}')
chk('a document that is not an object means empty',
  projectIntent('nonsense').intents.length === 0 && projectIntent(null).graph.concepts.length === 0)
const many = {
  intents: Array.from({ length: MAX_INTENTS + 15 }, (_, i) => ({ title: `t${i}`, status: 'done' })),
  graph: {
    concepts: Array.from({ length: MAX_CONCEPTS + 15 }, (_, i) => ({ id: `c${i}`, label: `l${i}`, group: 'thread' })),
    relations: Array.from({ length: MAX_RELATIONS + 15 }, (_, i) => ({ from: `c${i % 10}`, to: `c${(i + 1) % 10}`, label: null })),
  },
}
const capped = projectIntent(many)
chk(`intents cap at ${MAX_INTENTS}`, capped.intents.length === MAX_INTENTS, String(capped.intents.length))
chk(`concepts cap at ${MAX_CONCEPTS}`, capped.graph.concepts.length === MAX_CONCEPTS, String(capped.graph.concepts.length))
chk(`relations cap at ${MAX_RELATIONS}`, capped.graph.relations.length === MAX_RELATIONS, String(capped.graph.relations.length))
chk('a label longer than the wire allows is cut, not refused',
  projectIntent({ graph: { concepts: [{ id: 'x', label: 'y'.repeat(500), group: 'guard' }], relations: [] } }).graph.concepts[0].label.length === 120)

// ---------------------------------------- "None of it can quote a prompt"
//
// That sentence is inside the consent digest. It was true by vacancy while
// intents shipped empty; populated, the code has to make it true, because a
// title is a model-written string and the model is shown no rule against
// restating the words the person typed.
section('A title or label that quotes a prompt is withheld, and counted')
const prompts = [S.prompt, 'add /qruns', 'ok']
chk('a title that IS the prompt quotes it', quotesAPrompt(S.prompt, prompts))
chk('re-punctuated and re-cased, it still does', quotesAPrompt('  ADD, /qruns!!', prompts))
chk('a sentence lifted from the middle of a longer prompt does',
  quotesAPrompt('we decided that ' + S.prompt.slice(4, 4 + QUOTE_RUN + 3) + ' later', prompts))
chk('a title that contains a whole short prompt does', quotesAPrompt('The user asked to add /qruns to the ledger', prompts))
chk('but a two-letter prompt does not withhold every title containing it', !quotesAPrompt('Look at the token', prompts))
chk('and a paraphrase that shares words survives', !quotesAPrompt('The typed thing, restated', prompts))
const quoting = {
  sessionId: 'sess-1',
  intents: [
    { title: S.prompt, status: 'done', turns: [0] },
    { title: 'A paraphrase of what was asked', status: 'partial', turns: [1] },
  ],
  graph: {
    concepts: [
      { id: 'q', label: 'decided: ' + S.prompt.slice(0, QUOTE_RUN + 2), group: 'decision' },
      { id: 'ok', label: 'A fine label', group: 'guard' },
      { id: 'ok2', label: 'Another fine label', group: 'thread' },
      { id: 'the user said never touch prod', label: 'free-text id', group: 'guard' },
      { id: 'Upper-Case', label: 'bad id', group: 'guard' },
      { id: 'ok', label: 'duplicate id, second copy', group: 'thread' },
    ],
    relations: [
      { from: 'q', to: 'ok', label: 'quoted concept edge' },
      { from: 'ok', to: 'ok', label: 'self' },
      { from: 'ok', to: 'the user said never touch prod', label: 'into a bad id' },
      { from: 'ok', to: 'ok2', label: S.prompt },
      { from: 'ok', to: 'ok2', label: 'kept' },
    ],
  },
}
const guarded = indexFacts(spine, {}, quoting)
const gw = JSON.stringify(guarded)
chk('the intent titled with the prompt is withheld', guarded.intents.length === 1 && guarded.intents[0].title === 'A paraphrase of what was asked', JSON.stringify(guarded.intents))
chk('the concept whose label quotes the prompt is withheld', !guarded.graph.concepts.some((c) => c.id === 'q'))
chk('and its relations go with it', !guarded.graph.relations.some((r) => r.from === 'q' || r.to === 'q'))
chk('no prompt text reaches the wire through a title, label or relation', !gw.includes(S.prompt) && !gw.includes(S.prompt.slice(4, 4 + QUOTE_RUN)))
chk('an id that fails the page’s own regex is dropped with its edges',
  !gw.includes('never touch prod') && !gw.includes('Upper-Case') && !guarded.graph.relations.some((r) => /never touch/.test(r.to)))
chk('a duplicate id keeps its first copy', guarded.graph.concepts.filter((c) => c.id === 'ok').length === 1 && guarded.graph.concepts.find((c) => c.id === 'ok').label === 'A fine label')
chk('a relation from a concept to itself is dropped', !guarded.graph.relations.some((r) => r.from === r.to))
chk('what survives is exactly the two fine labels',
  JSON.stringify(guarded.graph.concepts) === JSON.stringify([{ id: 'ok', label: 'A fine label', group: 'guard' }, { id: 'ok2', label: 'Another fine label', group: 'thread' }]),
  JSON.stringify(guarded.graph.concepts))
chk('a relation whose label quotes the prompt is dropped and the kept one stays',
  JSON.stringify(guarded.graph.relations) === JSON.stringify([{ from: 'ok', to: 'ok2', label: 'kept' }]), JSON.stringify(guarded.graph.relations))
const counted = projectIntent(quoting, [S.prompt])
chk('the withheld count names what was held back: one title, one label, one relation', counted.withheld === 3, String(counted.withheld))
chk('with no prompts to compare against nothing is withheld', projectIntent(quoting, []).withheld === 0)

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
