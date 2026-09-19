// /qrunner's refusals.
//
// The queue, the claim and the ledger are the server's, and are tested there
// over HTTP. What is this plugin's own is the set of things it declines to do
// on a machine, and those are what this file is about: a disclosure that
// fails closed, a permission preflight that spends nothing, and the reading
// of a CLI result whose exit code lies.
import {
  shownRunner, coversWrite, execute, repoMap, DISCLOSURE, DISCLOSURE_VERSION, main,
} from '../scripts/qrunner.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (t) => console.log(`\n— ${t}`)

/** A repo whose .claude/settings.json says what the argument says. */
const repoWith = (settings) => {
  const d = mkdtempSync(join(tmpdir(), 'qrunner-'))
  mkdirSync(join(d, '.claude'), { recursive: true })
  if (settings !== null) writeFileSync(join(d, '.claude/settings.json'), settings)
  return d
}

section('the disclosure fails closed and re-asks when it changes')
{
  chk('no record means not shown', !shownRunner(null))
  chk('an empty record means not shown', !shownRunner({ schema_version: '1' }))
  chk('a record for an older text does not carry over',
    !shownRunner({ schema_version: '1', runner: { at: 'x', version: '0' } }))
  chk('a current record is accepted',
    shownRunner({ schema_version: '1', runner: { at: 'x', version: DISCLOSURE_VERSION } }))
}

section('the disclosure says what starting this actually means')
{
  // Each of these is a claim somebody is agreeing to. A disclosure that has
  // quietly lost one is worse than none, because it looks like consent.
  chk('it says work starts on THIS computer', /THIS COMPUTER/.test(DISCLOSURE))
  chk('it says without being asked at the time', /without you being asked at the time/i.test(DISCLOSURE))
  chk('it names the closed set', /qdoctor/.test(DISCLOSURE) && /Not arbitrary prompts/i.test(DISCLOSURE))
  chk('it admits the run spends tokens', /spending your tokens/i.test(DISCLOSURE))
  chk('it says any member can press the button', /any member of your workspace/i.test(DISCLOSURE))
  chk('it says how to stop it', /close this process/i.test(DISCLOSURE))
}

section('the permission preflight reads what a run would read')
{
  chk('an explicit Write allow counts',
    coversWrite(repoWith('{"permissions":{"allow":["Write","Bash(git:*)"]}}')))
  chk('so does Edit', coversWrite(repoWith('{"permissions":{"allow":["Edit"]}}')))
  chk('acceptEdits counts', coversWrite(repoWith('{"permissions":{"defaultMode":"acceptEdits"}}')))
  chk('read-only does not', !coversWrite(repoWith('{"permissions":{"allow":["Read"]}}')))
  chk('no settings at all does not', !coversWrite(repoWith(null)))
  chk('an unreadable settings file is not a permission',
    !coversWrite(repoWith('{ this is not json')))
}

section('a repo that cannot be written to is refused before anything is spent')
{
  let started = false
  const never = async () => { started = true; return { outcome: 'ok', detail: 'should not happen' } }
  const out = await execute('qdoctor', repoWith('{"permissions":{"allow":["Read"]}}'), never)
  chk('it refuses', out.outcome === 'refused', JSON.stringify(out))
  chk('and names the failure a headless run would hit',
    /dies at its first write/.test(out.detail), out.detail)
  chk('and no session was started at all', !started,
    'the point of a preflight is that it costs nothing')

  const ok = await execute('qdoctor', repoWith('{"permissions":{"allow":["Write"]}}'), never)
  chk('a writable repo does start one', started && ok.outcome === 'ok', JSON.stringify(ok))
}

section('repositories are matched by their directory name')
{
  const m = repoMap(['/a/b/Checkout-API', '/x/y/infra'])
  chk('folded to lower case', m.has('checkout-api') && m.has('infra'), JSON.stringify([...m.keys()]))
  chk('and the full path is what gets used', m.get('infra') === '/x/y/infra')
}

section('a first start prints and runs nothing')
{
  const lines = []
  const log = console.log
  console.log = (...a) => lines.push(a.join(' '))
  const code = await main(['--name', 'box', '--repo', repoWith('{"permissions":{"allow":["Write"]}}')])
  console.log = log
  const out = lines.join('\n')
  chk('it exits cleanly', code === 0, String(code))
  chk('it printed the disclosure', /THE COMMAND RUNNER/.test(out))
  chk('it said it did not start', /NOT STARTED/.test(out), out.slice(-160))
  chk('and it never claimed to be listening', !/listening for/.test(out),
    'that line would mean a runner is up, which it is not')
}

section('it refuses to guess what it may run in')
{
  const lines = []
  const log = console.log
  console.log = (...a) => lines.push(a.join(' '))
  const code = await main(['--name', 'box'])
  console.log = log
  chk('no --repo is a usage error, not "everything"', code === 2, String(code))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
