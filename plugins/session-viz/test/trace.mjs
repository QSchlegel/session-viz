// Tool-call retention: what --with-trace keeps, and what it must not carry.
//
// A retained trace is the most exposing thing this extractor can produce. A Bash
// input is a command line, a Write input is the contents of a file, an MCP input
// is whatever arguments went to a third party. The spine already holds prompt
// text; a trace beside it is the rest of the session.
//
// So the assertions here are mostly about restraint: that it is OFF unless
// asked, that the spine SAYS which happened, that secrets are redacted in the
// input and in the result rather than only in the prompt, and that a result too
// large to keep is cut with its real length recorded instead of a truncation
// being reported as the whole answer.
//
// Real JSONL through the real streaming loop, for the reason paths.mjs gives:
// a fixture that hands extract() a pre-built Session tests the shape of an
// object this file made up, and the failure that ships is in the loop.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract, MAX_TRACE_RESULT_CHARS } from '../scripts/extract.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (t) => console.log(`\n— ${t}`)

const KEY = 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CONN = 'postgres://admin:hunter2@db.internal:5432/prod'
const HUGE = 'z'.repeat(MAX_TRACE_RESULT_CHARS + 4096)

const dir = mkdtempSync(join(tmpdir(), 'session-viz-trace-'))
const FILE = join(dir, 'session.jsonl')

let n = 0
const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString()
const rec = (o) => ({ uuid: `u${n}`, timestamp: ts(), sessionId: 's1', cwd: '/w/demo', ...o })
const use = (id, name, input) => rec({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] } })
const res = (id, content, is_error = false) => rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })
const human = (text) => rec({ type: 'user', message: { content: [{ type: 'text', text }] } })

const records = [
  // Before any human turn: belongs to no turn, and must not be attributed to one.
  use('t0', 'Read', { file_path: '/w/demo/boot.ts' }),
  res('t0', 'boot ok'),

  human('do the thing'),
  // A secret in the command, and a nested object so structure can be checked.
  use('t1', 'Bash', { command: `export ANTHROPIC_API_KEY=${KEY} && psql ${CONN}`, meta: { retries: 2, tags: ['a', 'b'] } }),
  res('t1', `connected to ${CONN}\nkey ${KEY}\ndone`),

  use('t2', 'Read', { file_path: '/w/demo/big.txt' }),
  res('t2', HUGE),

  use('t3', 'Bash', { command: 'exit 1' }),
  res('t3', 'command failed', true),

  use('t4', 'mcp__railway__get_logs', { service: 'api' }),
  res('t4', 'log line'),

  // The case that decides HOW redaction is done. Several secret patterns end in
  // `\S+`, which over a serialised document runs past the closing quote — so
  // stringify, redact, re-parse produces `{"env":"DATABASE_PASSWORD=«redacted»`
  // and throws, losing the entire input. Redacting leaf by leaf cannot: it never
  // sees a quote, because the quote is JSON's and not the string's.
  use('t5', 'Bash', { command: 'deploy', env: 'DATABASE_PASSWORD=p4ssw0rd' }),
  res('t5', 'deployed'),

  // An answer to a call this reading never saw.
  res('t-never-seen', 'orphan result'),
]
writeFileSync(FILE, records.map((r) => JSON.stringify(r)).join('\n') + '\n')

// ------------------------------------------------------------------- off

section('Off unless asked for, and the spine says which')
const plain = await extract(FILE)
chk('no trace by default', (plain.trace || []).length === 0, `${(plain.trace || []).length} call(s) retained`)
chk('and the spine records that it was not retained', plain.retainedTrace === false, String(plain.retainedTrace))
chk('while the calls themselves are still counted', plain.totals.toolCalls === 6, String(plain.totals.toolCalls))

// ------------------------------------------------------------------- on

section('With --with-trace, every call is kept and paired')
const t = await extract(FILE, { retainTrace: true })
chk('the spine records that it was retained', t.retainedTrace === true)
chk('one entry per tool call', t.trace.length === t.totals.toolCalls, `${t.trace.length} vs ${t.totals.toolCalls}`)
chk('seq is dense and in order', t.trace.every((c, i) => c.seq === i))

const byTool = (name) => t.trace.find((c) => c.tool === name && c.turn >= 0)
const bash = t.trace.find((c) => c.tool === 'Bash' && c.input?.command?.includes('psql'))
chk('a call made before the first human turn is turn -1, not turn 0',
  t.trace[0].turn === -1, `turn ${t.trace[0].turn}`)
chk('a call inside a turn carries that turn', bash && bash.turn === 0, String(bash && bash.turn))
chk('a duration is measured from the call to its result', bash && bash.durationMs > 0, String(bash && bash.durationMs))

// -------------------------------------------------------------- redaction

section('Secrets are redacted in the input and in the result')
const wire = JSON.stringify(t.trace)
chk('the api key is not in the trace', !wire.includes(KEY))
chk('the connection string is not either', !wire.includes('hunter2'))
chk('the input was redacted, not dropped', bash && /«redacted»|«redacted-conn-string»/.test(bash.input.command),
  bash && bash.input.command)
chk('the result was redacted too', bash && !bash.result.includes(KEY) && bash.result.includes('done'),
  bash && bash.result)

section('Redacting an input does not corrupt its structure')
chk('the input is still an object', bash && typeof bash.input === 'object' && !Array.isArray(bash.input))
chk('a nested number survives as a number', bash && bash.meta === undefined && bash.input.meta.retries === 2,
  JSON.stringify(bash && bash.input.meta))
chk('a nested array survives as an array',
  bash && Array.isArray(bash.input.meta.tags) && bash.input.meta.tags.join('') === 'ab',
  JSON.stringify(bash && bash.input.meta.tags))

// The assertion that chooses the implementation rather than merely describing it.
const edge = t.trace.find((c) => c.input?.command === 'deploy')
chk('a secret value that runs to the end of its string is still redacted',
  edge && /«redacted»/.test(edge.input.env), JSON.stringify(edge && edge.input))
chk('and the input around it is intact, not a parse failure',
  edge && typeof edge.input === 'object' && edge.input.command === 'deploy',
  'stringify-redact-reparse loses the whole input here; leaf-by-leaf does not')

section('--no-redact is honoured, and recorded')
const raw = await extract(FILE, { retainTrace: true, redactText: false })
const rawBash = raw.trace.find((c) => c.tool === 'Bash' && String(c.input?.command).includes('psql'))
chk('the key survives when redaction is off', rawBash && rawBash.input.command.includes(KEY))
chk('and the spine says redaction was off', raw.redactedPrompts === false)

// ------------------------------------------------------------- truncation

section('A result too large is cut, and says how much')
const big = t.trace.find((c) => c.input?.file_path === '/w/demo/big.txt')
chk('the kept text stops at the ceiling', big && big.result.length === MAX_TRACE_RESULT_CHARS,
  String(big && big.result.length))
chk('the original length is recorded', big && big.resultBytes === HUGE.length,
  `${big && big.resultBytes} vs ${HUGE.length}`)
chk('and it is flagged as truncated', big && big.truncated === true)
chk('a result under the ceiling is not flagged', bash && bash.truncated === false)

// ----------------------------------------------------------------- errors

section('A failed call is recorded as failed')
const bad = t.trace.find((c) => c.input?.command === 'exit 1')
chk('ok is false', bad && bad.ok === false)
chk('errorKind is tool_error', bad && bad.errorKind === 'tool_error', String(bad && bad.errorKind))
chk('a successful call is ok with errorKind none', bash && bash.ok === true && bash.errorKind === 'none')

section('An answer to a call nobody saw is dropped, not invented')
chk('no entry carries the orphan result',
  !t.trace.some((c) => String(c.result || '').includes('orphan')),
  JSON.stringify(t.trace.map((c) => c.result && c.result.slice(0, 20))))
chk('and the retained count is unchanged by it', t.trace.length === 6, String(t.trace.length))

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
