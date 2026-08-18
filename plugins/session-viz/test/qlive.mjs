// /qlive's two load-bearing rules.
//
// 1. The trailing turn is never sent. extract closes the in-progress turn at
//    the end of its record loop, so it comes out looking complete -- an end
//    time, a duration, a score. A design that trusts "closed" would freeze a
//    turn mid-thought and, with an insert-once key, never be able to correct it.
//
// 2. /qlive must not write contrib.json. loadState/saveState read and write ONE
//    file whole, and loadState treats an unrecognised shape as "nothing sent",
//    so a clobbered ledger re-contributes the entire corpus into an endpoint
//    with no idempotency key.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the plugin's config resolution at a scratch directory before importing
// anything that reads it.
const home = mkdtempSync(join(tmpdir(), 'qlive-'))
mkdirSync(join(home, '.config', 'session-viz'), { recursive: true })
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.HOME = home

const { livePayload, enable, disable, isOn, loadLive } = await import('../scripts/qlive.mjs')
const { saveState, loadState, liveTarget, stateTarget } = await import('../scripts/home.mjs')

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

const turn = (index) => ({
  index,
  startedAt: '2026-01-01T00:00:00Z',
  endedAt: '2026-01-01T00:01:00Z',
  durationMs: 60000,
  toolCallCount: 2,
  tokens: { output: 100 },
  friction: [],
  text: 'a prompt that must not leave',
})

const spine = (n) => ({
  sessionId: 'sess-1',
  harness: 'claude-code',
  cwd: '/home/someone/private-client-work/repo',
  gitBranch: 'main',
  turns: Array.from({ length: n }, (_, i) => turn(i)),
})

// ---------------------------------------------------------------- 1. the drop
{
  const p = livePayload(spine(5))
  chk('the trailing turn is not sent', p.turns.length === 4, `${p.turns.length} turns sent of 5`)
  chk('and the highest sent index is one below the last', Math.max(...p.turns.map((t) => t.index)) === 3,
    String(Math.max(...p.turns.map((t) => t.index))))
  chk('the open turn is reported as a count', p.openTurns === 1, String(p.openTurns))
}
{
  const p = livePayload(spine(1))
  chk('a session with only an open turn sends nothing', p.turns.length === 0)
  chk('and still says one turn is open', p.openTurns === 1)
}
{
  // The correction path: once a further turn exists, the previously-open turn
  // becomes closed and is sent exactly once.
  const first = livePayload(spine(3))
  const sentUpTo = Math.max(...first.turns.map((t) => t.index))
  const second = livePayload(spine(4), sentUpTo)
  chk('a turn that closes later is sent on the next run', second.turns.some((t) => t.index === 2),
    second.turns.map((t) => t.index).join(','))
  chk('and is not sent twice', second.turns.filter((t) => t.index === 2).length === 1)
  chk('nothing already sent is repeated', second.turns.every((t) => t.index > sentUpTo))
}

// ---------------------------------------------------------------- 2. what leaves
{
  const p = livePayload(spine(3))
  const wire = JSON.stringify(p)
  chk('no prompt text leaves', !wire.includes('a prompt that must not leave'))
  chk('no absolute path leaves', !wire.includes('/home/someone'))
  chk('the repo name survives, because a colleague needs it', p.repo === 'repo', String(p.repo))
  chk('the branch survives', p.branch === 'main')
  chk('every sent turn carries shape, not content',
    p.turns.every((t) => !('text' in t) && typeof t.toolCallCount === 'number'))
}

// ---------------------------------------------------------------- 3. the ledger
//
// The one that would be silent and expensive.
{
  saveState({ schema_version: '3', sent: { 'k1': 12, 'k2': 7 } })
  const before = loadState()
  chk('the contribution ledger starts intact', before?.sent?.k1 === 12, JSON.stringify(before))

  enable('sess-1')
  enable('sess-2')
  disable('sess-2')

  const after = loadState()
  chk('/qlive does not touch contrib.json', JSON.stringify(after) === JSON.stringify(before),
    `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`)
  chk('and the two ledgers are different files', liveTarget() !== stateTarget(),
    `${liveTarget()} vs ${stateTarget()}`)
  chk('the live ledger exists on its own', existsSync(liveTarget()))
  const live = JSON.parse(readFileSync(liveTarget(), 'utf8'))
  chk('the live ledger holds only live state', 'on' in live && !('sent' in live), Object.keys(live).join(','))
}

// ---------------------------------------------------------------- 4. opt-in and expiry
{
  chk('a session that was never enabled is off', isOn(loadLive(), 'never-asked') === false)
  chk('an enabled session is on', isOn(loadLive(), 'sess-1') === true)
  chk('a disabled session is off again', isOn(loadLive(), 'sess-2') === false)

  const now = Date.now()
  enable('sess-3', 1, now)
  chk('an opt-in lapses on its own', isOn(loadLive(), 'sess-3', now + 2 * 3600_000) === false)
  chk('and is live before it lapses', isOn(loadLive(), 'sess-3', now + 30 * 60_000) === true)
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
