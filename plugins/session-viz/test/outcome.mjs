// The two transcript-derived rungs: wrote, and verified.
//
// These are the rungs a session can climb without leaving the machine, and
// most of what is asserted here is what does NOT count — a check before the
// last write, a shell command that is not a check, a result that never came.
// A rung that counts too generously is worse than no rung: it tells somebody
// they closed a loop they left open.
import {
  WRITE_TOOLS, writeTarget, checkLabel,
  newOutcomeScan, noteToolUse, noteToolResult, noteUnansweredCall,
  deliveryOf, verificationOf, checksAfterLastWrite,
} from '../scripts/outcome.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (t) => console.log(`\n— ${t}`)

/** Drive a scan with a script of [tool, input, isError] triples. `undefined`
 *  for isError means the call never got an answer. */
const run = (steps) => {
  const scan = newOutcomeScan()
  for (const [name, input, isError] of steps) {
    const call = noteToolUse(scan, { name, input })
    if (isError === undefined) noteUnansweredCall(scan, call)
    else noteToolResult(scan, call, isError)
  }
  return scan
}
const W = (path) => ['Write', { file_path: path }, false]
const bash = (command, isError = false) => ['Bash', { command }, isError]

section('the write vocabulary is the one runs.mts already used')
{
  chk('three write tools, no more', WRITE_TOOLS.has('Write') && WRITE_TOOLS.has('Edit') &&
    WRITE_TOOLS.has('NotebookEdit') && !WRITE_TOOLS.has('Read') && !WRITE_TOOLS.has('Bash'))
  chk('Write names file_path', writeTarget('Write', { file_path: 'a.ts' }) === 'a.ts')
  chk('NotebookEdit prefers notebook_path',
    writeTarget('NotebookEdit', { notebook_path: 'n.ipynb', file_path: 'x' }) === 'n.ipynb')
  chk('a read tool has no target', writeTarget('Read', { file_path: 'a.ts' }) === null)
}

section('a check is a program whose job is to say whether it is still right')
{
  chk('a bare runner counts', checkLabel('pytest -q') === 'pytest')
  chk('inside a pipeline', checkLabel('cd api && npm test -- --run') === 'npm test')
  chk('through a path', checkLabel('./node_modules/.bin/vitest') === 'vitest')
  chk('behind an env assignment', checkLabel('CI=1 NODE_ENV=test jest') === 'jest')
  chk('cargo test', checkLabel('cargo test --all') === 'cargo test')
  chk('go vet', checkLabel('go vet ./...') === 'go vet')

  // The narrowness is the point. A broad list makes `verified` mean "ran a
  // command", which every session did.
  chk('npm install is not a check', checkLabel('npm install') === null)
  chk('npm run dev is not a check', checkLabel('npm run dev') === null)
  chk('npm run build is', checkLabel('npm run build') === 'npm run build')
  chk('npm run typecheck is', checkLabel('npm run typecheck') === 'npm run typecheck')
  chk('git is never a check', checkLabel('git status') === null && checkLabel('git commit -m x') === null,
    'counting git would let the ladder climb its own top rung')
  // Found by running the corpus: three of 798 sessions began a shell segment
  // with a word that is a property of Object.prototype, and indexing the
  // subcommand table with it returned a function whose .has() threw — taking
  // the whole extraction down rather than answering "not a check".
  for (const word of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])
    chk(`a command named ${word} answers, rather than throwing`,
      (() => { try { return checkLabel(`${word} --help`) === null } catch { return false } })())

  chk('ordinary shell is not a check',
    checkLabel('ls -la') === null && checkLabel('echo hi') === null && checkLabel('') === null)
}

section('delivery is what the tool results said')
{
  chk('a successful write is wrote_ok', deliveryOf(run([W('a.ts')])) === 'wrote_ok')
  chk('a refused write is denied',
    deliveryOf(run([['Write', { file_path: 'a.ts' }, true]])) === 'denied')
  chk('an intent with no answer is unverified',
    deliveryOf(run([['Write', { file_path: 'a.ts' }, undefined]])) === 'unverified')
  chk('no write at all is no_intent', deliveryOf(run([bash('ls')])) === 'no_intent')

  // The ordering runs.mts learned the hard way: ten good writes and one
  // blocked edit is a session that delivered.
  chk('one blocked edit among many good writes is still wrote_ok',
    deliveryOf(run([W('a.ts'), W('b.ts'), ['Edit', { file_path: 'c.ts' }, true]])) === 'wrote_ok',
    'testing denied first drops the run out of the delivered denominator while its tokens stay in')
}

section('verified means a check ran AFTER the last write')
{
  chk('a check after the write passes',
    verificationOf(run([W('a.ts'), bash('npm test')])) === 'passed')
  chk('a failing check after the write fails',
    verificationOf(run([W('a.ts'), bash('npm test', true)])) === 'failed')

  // THE ASSERTION THE RUNG EXISTS FOR.
  chk('a check BEFORE the last write does not count',
    verificationOf(run([W('a.ts'), bash('npm test'), W('b.ts')])) === 'none',
    'it proved the state before the final edit, which is the habit this notices the absence of')

  chk('one failure among passes after the write is failed',
    verificationOf(run([W('a.ts'), bash('npm test'), bash('tsc', true)])) === 'failed')
  chk('a check whose result never came is ran, not passed',
    verificationOf(run([W('a.ts'), ['Bash', { command: 'pytest' }, undefined]])) === 'ran',
    '"we did not see the answer" must not read as "it was fine"')
  chk('writing with no check at all is none',
    verificationOf(run([W('a.ts'), bash('ls')])) === 'none')
  chk('checking without writing is none, because there was nothing to verify',
    verificationOf(run([bash('npm test')])) === 'none')

  const after = checksAfterLastWrite(run([W('a.ts'), bash('npm test'), W('b.ts'), bash('tsc')]))
  chk('only the checks after the last write are reported',
    after.length === 1 && after[0].label === 'tsc', JSON.stringify(after))
}

section('an unmatched result is dropped rather than invented')
{
  const scan = newOutcomeScan()
  noteToolResult(scan, undefined, false)
  chk('a result with no call changes nothing', deliveryOf(scan) === 'no_intent')
}

section('successful write targets are collected, failed ones are not')
{
  const scan = run([W('a.ts'), ['Write', { file_path: 'b.ts' }, true], W('c.ts')])
  chk('only the writes that succeeded', [...scan.writeTargets].sort().join(',') === 'a.ts,c.ts',
    JSON.stringify([...scan.writeTargets]))
  const noTarget = run([['Write', {}, false]])
  chk('a successful write with no readable target is counted separately',
    noTarget.writesWithoutTarget === 1 && noTarget.writeTargets.size === 0,
    'so the artifact probe can say unavailable rather than silently reporting fewer')
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
