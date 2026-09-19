// /qdrive's gate: whether this machine may collect, and what it does when it
// may not.
//
// The collection itself is HTTP and is covered on the server side, where the
// exactly-once write lives. What is here is the half that is this plugin's
// own: a disclosure record that fails closed, a version that re-asks, and a
// first run that prints and collects nothing.
import { shown, DISCLOSURE, DISCLOSURE_VERSION, SCHEMA_VERSION, main } from '../scripts/qdrive.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (t) => console.log(`\n— ${t}`)

section('the disclosure record fails closed')
{
  chk('no state at all means not shown', !shown(null))
  chk('an empty record means not shown', !shown({ schema_version: SCHEMA_VERSION }))
  chk('a record for an older disclosure does not carry over',
    !shown({ schema_version: SCHEMA_VERSION, shown: { at: '2026-01-01T00:00:00Z', version: '0' } }),
    'bumping the text must re-ask, or an old agreement stands in for a new promise')
  chk('a current record is accepted',
    shown({ schema_version: SCHEMA_VERSION, shown: { at: '2026-01-01T00:00:00Z', version: DISCLOSURE_VERSION } }))
}

section('the disclosure says the things it exists to say')
{
  // Not a style check. Each of these is a claim the design turns on, and a
  // disclosure that has quietly lost one is worse than no disclosure.
  chk('it says an instruction is a prompt', /is a prompt/i.test(DISCLOSURE))
  chk('it names who may queue one', /admins/i.test(DISCLOSURE) && /machine token/i.test(DISCLOSURE))
  chk('it says nothing is pushed', /nothing is pushed/i.test(DISCLOSURE))
  chk('it says ending the session ends it', /ending the session ends it/i.test(DISCLOSURE))
  chk('it states the retention and the lapse',
    /90 days/.test(DISCLOSURE) && /30 minutes/.test(DISCLOSURE))
}

section('a first run prints and collects nothing')
{
  // main() is driven directly with a scratch home, so no network is reached:
  // the gate must refuse BEFORE the credential is even resolved, and a test
  // that needed a server to prove that would be proving something weaker.
  const lines = []
  const log = console.log
  console.log = (...a) => lines.push(a.join(' '))
  const code = await main(['--session', 'sess-under-test'])
  console.log = log

  const out = lines.join('\n')
  chk('it exits without an error code', code === 0, String(code))
  chk('it printed the disclosure', /THE SESSION INBOX/.test(out))
  chk('it said plainly that nothing was collected', /NOT COLLECTED/.test(out), out.slice(-200))
  chk('and it named the command that changes that', /--disclose/.test(out))
  chk('it did not claim to have an empty inbox', !/inbox empty/.test(out),
    'that sentence would mean "we asked and there was nothing", which is not what happened')
}

section('it refuses to guess a session')
{
  const lines = []
  const log = console.log
  console.log = (...a) => lines.push(a.join(' '))
  const code = await main([])
  console.log = log
  chk('no --session is a usage error, not a default', code === 2, String(code))
  chk('and it prints the usage', /--session/.test(lines.join('\n')))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
