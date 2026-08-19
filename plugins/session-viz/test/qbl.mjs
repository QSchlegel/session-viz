// /qbl makes four claims that nothing else in the tool can check, so this file
// runs the real command as a child process and reads what it actually printed.
//
// The claims:
//
//   1. an item pushed is an item pulled, carrying the what/where/why it was
//      given — a backlog that loses an entry is worse than no backlog, because
//      the user believes the thing was recorded;
//   2. the ordering is the one it says it is. "Next up" is a claim, and the
//      output names the criteria it sorted by. Those two must agree: printing
//      "by how many open items each one unblocks" over a list that is really in
//      date order is the exact defect this codebase keeps producing — a check,
//      or a sentence, that passes by not looking;
//   3. an empty backlog says it is empty instead of proposing plausible work;
//   4. an unreachable shared backend degrades to the local backlog and SAYS SO,
//      with the reason. A short local list printed under a shared heading reads
//      as "your team has two things to do";
//   5. a local backlog written in one project is invisible from another.
//
// Every assertion below is against the child's stdout or its `--json`, never
// against a re-import of the functions that produced it. The renderer is the
// artifact; the sort function is not.
//
// Every spawn carries a timeout, so a command that hangs is a named failure
// rather than a test run that never ends.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const QBL = fileURLToPath(new URL('../scripts/qbl.mjs', import.meta.url))

let pass = 0, fail = 0
const chk = (name, ok, detail) => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail) console.log(`         ${String(detail).split('\n').join('\n         ')}`)
  ok ? pass++ : fail++
}

// A unique root per run: a shared path under /tmp would let two runs of this
// test — or a run of it and a real /qbl — read each other's backlogs, and the
// isolation case below would pass or fail for the wrong reason.
const ROOT = mkdtempSync(join(tmpdir(), 'qbl-test-'))
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })

const project = (name, branch) => {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  // A fabricated .git rather than a `git init`: currentBranch() reads
  // .git/HEAD, so this exercises the real code path with no git binary and no
  // repository state to clean up.
  if (branch) {
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  }
  return dir
}

const setBranch = (dir, branch) => writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)

function run(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [QBL, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: process.env.PATH,
      // Every candidate config directory home.mts knows about is pointed into
      // the scratch root. Leaving even one of them at the real value would let
      // the developer's own backlog leak into these assertions.
      HOME,
      SESSION_VIZ_HOME: HOME,
      XDG_CONFIG_HOME: join(HOME, 'xdg'),
      ...env,
    },
  })
  if (r.error) throw new Error(`qbl ${args.join(' ')} did not run: ${r.error.message}`)
  if (r.signal) throw new Error(`qbl ${args.join(' ')} was killed by ${r.signal} — it hung past the 20s timeout`)
  return { out: r.stdout || '', err: r.stderr || '', code: r.status }
}

const pushedId = (out) => (out.match(/^pushed\s+(b[0-9a-f]+)/m) || [])[1]
// The exit code comes back with the payload. A `--json` helper that threw it
// away is how the degraded pull went on exiting 0 under a suite that asserted
// exit 2 on the text path and never looked at the one scripts actually read.
const jsonRun = (cwd, args, env) => {
  const r = run(cwd, [...args, '--json'], env)
  return { j: JSON.parse(r.out), code: r.code, out: r.out, err: r.err }
}
const json = (cwd, args, env) => jsonRun(cwd, args, env).j

/** A subdirectory of a project, made real, because the push has to happen in one. */
const subdir = (dir, rel) => {
  const p = join(dir, rel)
  mkdirSync(p, { recursive: true })
  return p
}

const SHARED_ROWS = [
  {
    id: 'task_aaa', title: 'Rotate the workspace token', brief: 'x\n\nwhy: it is six months old',
    scope: 'shared-proj', repo: 'shared-proj', branch: null, refs: ['qbl'],
    created_by: 'me@example', assigned_to: null, state: 'draft',
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  },
  {
    id: 'task_bbb', title: 'Write the runbook', brief: 'y', scope: 'shared-proj', repo: 'shared-proj',
    branch: null, refs: ['qbl', 'blocked-by:task_aaa'], created_by: 'me@example', assigned_to: null,
    state: 'draft', created_at: '2026-08-02T00:00:00Z', updated_at: '2026-08-02T00:00:00Z',
  },
]

// The stub backends run in their OWN processes, and that is not tidiness.
// `spawnSync` blocks this process's event loop for the whole life of the child,
// so a server hosted here could never accept the child's connection — every
// shared read would time out and the fallback assertions would pass while the
// working path was never exercised at all. That is the same defect this file
// exists to catch, one level up: a check that passes by not looking.
const SERVER = join(ROOT, 'stub-server.mjs')
writeFileSync(SERVER, `
import { createServer } from 'node:http'
const rows = ${JSON.stringify(SHARED_ROWS)}
const silent = process.argv[2] === 'silent'
const s = createServer((req, res) => {
  if (silent) return                       // accept the socket, answer nothing
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(rows))
})
s.listen(0, '127.0.0.1', () => console.log(s.address().port))
`)

const startServer = (mode) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [SERVER, mode], { stdio: ['ignore', 'pipe', 'inherit'] })
  const t = setTimeout(() => reject(new Error(`the ${mode} stub server never reported a port`)), 10000)
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    const m = buf.match(/(\d+)\n/)
    if (m) { clearTimeout(t); resolve({ child, port: Number(m[1]) }) }
  })
  child.on('error', (e) => { clearTimeout(t); reject(e) })
})

// A port nothing is listening on. Bound and released so it is real and free,
// which gives a deterministic ECONNREFUSED rather than a timeout.
const deadPort = await new Promise((resolve) => {
  const s = createServer(() => {})
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})

const up = await startServer('answering')
const silent = await startServer('silent')

const CLOUD = (port) => ({
  SESSION_VIZ_TOKEN: 'svt_test',
  SESSION_VIZ_URL: `http://127.0.0.1:${port}`,
  SESSION_VIZ_ACTOR: 'me@example',
})

try {
  // ───────────────────────────────────────────── 1. an empty backlog says so
  //
  // The failure this guards is a command that answers "what should I do next"
  // with something plausible when it has nothing. An empty backlog has exactly
  // one honest answer.
  console.log('\n── an empty backlog says it is empty')
  {
    const p = project('empty-proj')
    const { out, code } = run(p, [])
    chk('says the backlog is empty', /This backlog is empty/.test(out), out)
    chk('and says no tasks are suggested', /No tasks are suggested, because none exist to suggest/.test(out), out)
    chk('proposes nothing', !/next up/.test(out), out)
    chk('exits 0 — empty is an answer, not an error', code === 0, `exit ${code}`)
    const j = json(p, [])
    chk('--json marks it empty', j.empty === true, JSON.stringify(j.counts))
    chk('--json proposes nothing', Array.isArray(j.next) && j.next.length === 0, JSON.stringify(j.next))
  }

  // ─────────────────────────────────────── 2. an item pushed is an item pulled
  console.log('\n── an item pushed is an item pulled, with what/where/why intact')
  {
    const p = project('roundtrip', 'main')
    const push = run(p, ['the picker stub has drifted from the real stream',
      '--why', 'a check that passes by not looking is worse than no check'])
    const id = pushedId(push.out)
    chk('the push reports an id', !!id, push.out + push.err)

    const { out } = run(p, [])
    chk('the pulled list carries the id', out.includes(id), out)
    chk('...the text', out.includes('the picker stub has drifted from the real stream'), out)
    chk('...the stated why', out.includes('a check that passes by not looking'), out)
    chk('...and where it came from', /where\s+roundtrip · main/.test(out), out)
  }

  console.log('\n── an item pushed without a reason says so rather than inventing one')
  {
    const p = project('no-why')
    run(p, ['wire the new command into CI'])
    const { out } = run(p, [])
    chk('the pull says the reason was not recorded',
      /why\s+not recorded — this item never said why it matters/.test(out), out)
    const j = json(p, [])
    chk('--json carries a null why, not a fabricated string', j.next[0].why === null, JSON.stringify(j.next[0]))
  }

  // ──────────────────────────────── 3. the ordering is the one it claims to be
  //
  // Three shapes, because the claim changes with the data: dependencies order
  // it, the current branch orders it, and when neither does the command has to
  // stop claiming and say it is a date sort.
  console.log('\n── ordering: a dependency puts the unblocker first, and says that is why')
  {
    const p = project('deps')
    // The unblocker is pushed SECOND on purpose. With it pushed first, age
    // alone would put it at the top and the assertion below would pass with
    // the unblocking criterion deleted from the sort — which is precisely how
    // a test comes to guard nothing. Here the ordering is only right if the
    // dependency count actually beat the date.
    const oldest = pushedId(run(p, ['make the stub read the real stream']).out)
    const unblocker = pushedId(run(p, ['rewrite the picker stub so it reads the real stream']).out)
    run(p, ['wire the new command into CI'])
    const blocked = pushedId(run(p, ['ship the release notes', '--blocked-by', unblocker]).out)

    const { out } = run(p, [])
    const j = json(p, [])
    chk('the unblocker is first, ahead of an older item',
      j.next[0].id === unblocker && j.next[1].id === oldest, JSON.stringify(j.next.map((n) => n.id)))
    chk('and its reason names what it unblocks',
      j.next[0].reasons.some((r) => r.includes('unblocks 1 open item')), JSON.stringify(j.next[0].reasons))
    chk('the blocked item is held back, not ranked',
      j.next.every((n) => n.id !== blocked) && j.held.some((h) => h.id === blocked), JSON.stringify(j.held))
    chk('and the hold names what it waits on',
      j.held.find((h) => h.id === blocked).reason === `waiting on ${unblocker}`, JSON.stringify(j.held))
    chk('the printed basis marks the unblocking criterion as one that separated',
      j.basis.find((x) => /unblocks/.test(x.criterion)).separated === true, JSON.stringify(j.basis))
    chk('it does not claim age alone', j.orderedByAgeAlone === false, String(j.orderedByAgeAlone))
    chk('the rendered page shows the held-back section', /held back \(1\)/.test(out), out)
  }

  console.log('\n── ordering: the current branch beats age, and the basis says by how much')
  {
    const p = project('branchy', 'main')
    run(p, ['written on main, and older'])
    setBranch(p, 'feat/glass')
    run(p, ['written on feat/glass, and newer'])

    const j = json(p, [])
    chk('the item on this branch is first despite being newer',
      j.next[0].text === 'written on feat/glass, and newer', JSON.stringify(j.next.map((n) => n.text)))
    chk('and it says the branch is why',
      j.next[0].reasons.some((r) => r.includes('feat/glass, the branch checked out here')),
      JSON.stringify(j.next[0].reasons))
    const branchCrit = j.basis.find((x) => /branch checked out here/.test(x.criterion))
    chk('the basis marks the branch criterion as one that separated', branchCrit.separated === true, JSON.stringify(branchCrit))
    chk('and counts how many matched', /1 of 2 name feat\/glass/.test(branchCrit.detail), branchCrit.detail)
  }

  console.log('\n── ordering: with nothing to order by, it says so instead of claiming')
  {
    const p = project('flat')
    run(p, ['first thing'])
    run(p, ['second thing'])
    run(p, ['third thing'])

    const { out } = run(p, [])
    const j = json(p, [])
    chk('order is oldest first', j.next.map((n) => n.text).join('|') === 'first thing|second thing|third thing',
      JSON.stringify(j.next.map((n) => n.text)))
    chk('it admits the order is age alone', j.orderedByAgeAlone === true, String(j.orderedByAgeAlone))
    chk('and says so in words: a queue, not a plan', /ordered by age alone[\s\S]*queue,\s*\n?\s*not a plan/.test(out), out)
    chk('the unblocking criterion is marked as having separated nothing',
      j.basis.find((x) => /unblocks/.test(x.criterion)).separated === false, JSON.stringify(j.basis))
    chk('and the page says that criterion separated nothing',
      /separated nothing: every ready item unblocks the same number/.test(out), out)
  }

  console.log('\n── ordering: a blocker id that names nothing is reported, never silently satisfied')
  {
    const p = project('dangling')
    run(p, ['a real item'])
    // Written straight into the file: --blocked-by refuses an unknown id at
    // push time, so the only way this state arises is an edited or half-synced
    // backlog — which is exactly when a silent "not blocked" would mislead.
    // The file is found by its content, because the name carries a digest of an
    // absolute path this test has no business reconstructing.
    const dir = join(HOME, 'backlog')
    const f = readdirSync(dir).map((n) => join(dir, n))
      .find((n) => readFileSync(n, 'utf8').includes('a real item'))
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    doc.items[0].blockedBy = ['bdeadbeef']
    writeFileSync(f, JSON.stringify(doc, null, 2))

    const { out } = run(p, [])
    const j = json(p, [])
    chk('the item is still proposed', j.next.length === 1, JSON.stringify(j.next))
    chk('and the dangling blocker is named on the page',
      /blocker ids that name nothing in this backlog/.test(out) && out.includes('bdeadbeef'), out)
    chk('--json carries it too', j.danglingBlockers.some((d) => d.names === 'bdeadbeef'),
      JSON.stringify(j.danglingBlockers))
  }

  // ───────────────────────────────────────── 4. shared: works, then degrades
  //
  // The positive control is not optional. Without it "falls back to local"
  // would pass just as well if the shared path were broken outright, which is
  // the same defect in a different coat.
  console.log('\n── shared: reads the shared queue when the backend answers')
  {
    const p = project('shared-proj')
    run(p, ['a purely local note'])
    const { out, code } = run(p, ['--shared', '--timeout', '5000'], CLOUD(up.port))
    chk('the heading says shared', /backlog · shared-proj · shared/.test(out), out.split('\n')[0])
    chk('a shared task is listed', out.includes('Rotate the workspace token'), out)
    chk('a blocked-by ref survives the round trip as a real hold',
      /task_bbb.*waiting on task_aaa/.test(out), out)
    chk('the local-only note is NOT in the shared list', !out.includes('a purely local note'), out)
    chk('exit 0 when the shared list is the real one', code === 0, `exit ${code}`)
  }

  console.log('\n── shared: degrades to local, states the reason, and does not pretend to be complete')
  {
    const p = project('shared-proj')  // same project — it already has a local note
    const { out, code } = run(p, ['--shared', '--timeout', '5000'], CLOUD(deadPort))
    chk('the heading falls back to local', /backlog · shared-proj · local/.test(out), out.split('\n')[0])
    chk('it says the shared backlog is not in the list',
      /the shared backlog is NOT in this list/.test(out), out)
    chk('and gives the actual reason', /connection refused/.test(out), out)
    chk('and names the host it could not reach', out.includes(`127.0.0.1:${deadPort}`), out)
    chk('and says the answer is partial', /treat this list as partial, not as the queue/.test(out), out)
    chk('the local items are still shown', out.includes('a purely local note'), out)
    chk('nothing from the shared queue is claimed', !out.includes('Rotate the workspace token'), out)
    chk('exit is non-zero, so a script cannot read a partial answer as complete', code === 2, `exit ${code}`)
    const { j, code: jcode } = jsonRun(p, ['--shared', '--timeout', '5000'], CLOUD(deadPort))
    chk('--json records the requested scope and the one it got',
      j.requestedScope === 'shared' && j.scope === 'local', JSON.stringify({ r: j.requestedScope, s: j.scope }))
    chk('--json carries the reason', /connection refused/.test(j.degraded.reason), JSON.stringify(j.degraded))
    // The exit code is the whole contract for a caller reading JSON: it is the
    // one caller that cannot notice a `degraded` key it did not think to look
    // for, so exiting 0 here hands a script a local-only list under the name of
    // the team queue.
    chk('--json exits 2 as well — the payload flag is not a substitute for the code',
      jcode === 2, `exit ${jcode}`)
  }

  console.log('\n── shared: a backend that accepts the socket and never answers is a timeout, not a hang')
  {
    const p = project('shared-proj')
    const { out, code } = run(p, ['--shared', '--timeout', '400'], CLOUD(silent.port))
    chk('the reason is the timeout, with the budget in it', /no answer within 400ms/.test(out), out)
    chk('it still falls back to local', /backlog · shared-proj · local/.test(out), out.split('\n')[0])
    chk('exit 2', code === 2, `exit ${code}`)
  }

  console.log('\n── shared: a push that could not land is not quietly filed locally')
  {
    const p = project('shared-proj')
    const before = json(p, []).counts.open
    const { err, code } = run(p, ['--shared', 'something for the team', '--why', 'it matters', '--timeout', '2000'],
      CLOUD(deadPort))
    chk('it refuses', code === 1, `exit ${code}`)
    chk('and says nothing was written anywhere', /Nothing was written anywhere/.test(err), err)
    chk('the local backlog is unchanged', json(p, []).counts.open === before,
      `${before} -> ${json(p, []).counts.open}`)
  }

  // ────────────────────────────── 5. one project's backlog is its own
  console.log('\n── a local backlog written by one project is not visible from another')
  {
    const a = project('isolated-a')
    const b = project('isolated-b')
    run(a, ['a secret only project A knows', '--why', 'project A reasons'])
    const { out } = run(b, [])
    chk('project B does not see it', !out.includes('a secret only project A knows'), out)
    chk('project B reports itself empty', /This backlog is empty/.test(out), out)
    chk('project A still sees it', run(a, []).out.includes('a secret only project A knows'), '')
    chk('and B is named as B, not as A', /backlog · isolated-b/.test(out), out.split('\n')[0])
  }

  // ──────────────────────────────────────── the push/pull reading is auditable
  console.log('\n── the direction is decided by a whole-string match, and is printable')
  {
    const p = project('direction')
    const asked = run(p, ["what's next?"])
    chk('"what\'s next?" reads as a pull', /This backlog is empty/.test(asked.out), asked.out)
    const noted = run(p, ['next: rewrite the picker stub'])
    chk('"next: rewrite the picker stub" reads as a push — no substring match',
      /^pushed\s+b/m.test(noted.out), noted.out)
    const phrases = run(p, ['--phrases'])
    chk('--phrases prints the list the decision is made from',
      phrases.out.includes('what next') && /whole-string, never substring/.test(phrases.out), phrases.out)
    const forced = run(p, ['--push', 'backlog'])
    chk('--push forces a phrase to be filed', /^pushed\s+b/m.test(forced.out), forced.out)
  }

  // ─────────────────────────────────────── closing an item releases its blocker
  console.log('\n── closing an item releases what was waiting on it')
  {
    const p = project('closing')
    const a = pushedId(run(p, ['the blocker']).out)
    const b = pushedId(run(p, ['the blocked one', '--blocked-by', a]).out)
    const done = run(p, ['--done', a.slice(0, 5)])
    chk('a unique id prefix is enough to close', /^closed\s+/m.test(done.out), done.out)
    chk('and it names what it released', done.out.includes(b), done.out)
    const j = json(p, [])
    chk('the formerly blocked item is now proposed', j.next.length === 1 && j.next[0].id === b, JSON.stringify(j.next))
    // `closed`, not `done`: --drop lands in the same place and the file records
    // no difference, so the key must not claim one.
    chk('and the counts moved', j.counts.closed === 1 && j.counts.open === 1, JSON.stringify(j.counts))
  }

  console.log('\n── closing one of two blockers does not claim the item was released')
  {
    const p = project('two-blockers')
    const a = pushedId(run(p, ['blocker A']).out)
    const b = pushedId(run(p, ['blocker B']).out)
    const x = pushedId(run(p, ['the thing waiting on both', '--blocked-by', `${a},${b}`]).out)
    const done = run(p, ['--done', a])
    // The close message and the very next pull have to agree. Announcing a
    // release that `order()` then refuses to honour tells the user work is free
    // and leaves them to find it still held, by a blocker nothing mentioned.
    chk('the close does not claim the still-blocked item was released',
      !done.out.includes(`no longer blocked: ${x}`) && !/no longer blocked/.test(done.out), done.out)
    chk('it names the item and the blocker still holding it',
      done.out.includes(x) && done.out.includes(b) && /STILL held/.test(done.out), done.out)
    const j = json(p, [])
    chk('and the pull agrees: it is still held, not ready',
      !j.next.some((n) => n.id === x) && j.held.some((h) => h.id === x && h.reason === `waiting on ${b}`),
      JSON.stringify({ next: j.next.map((n) => n.id), held: j.held }))
    const done2 = run(p, ['--done', b])
    chk('closing the last blocker is what reports the release',
      done2.out.includes(`no longer blocked: ${x}`), done2.out)
  }

  // ───────────────────────── the ordering sentence agrees with the same page
  //
  // The defect this codebase cares most about is a conclusion contradicted by
  // the output two lines above it. "Nothing here records a dependency" printed
  // under a held-back section listing dependencies is that defect exactly.
  console.log('\n── it does not deny a dependency it printed on the same page')
  {
    const p = project('two-chains')
    const a = pushedId(run(p, ['A, an unblocker']).out)
    const b = pushedId(run(p, ['B, another unblocker']).out)
    run(p, ['C, waiting on A', '--blocked-by', a])
    run(p, ['D, waiting on B', '--blocked-by', b])

    const { out } = run(p, [])
    const j = json(p, [])
    chk('two dependencies are held back and shown', /held back \(2\)/.test(out), out)
    chk('and both ready items say what they unblock',
      j.next.length === 2 && j.next.every((n) => n.reasons.some((r) => /unblocks 1 open item/.test(r))),
      JSON.stringify(j.next.map((n) => n.reasons)))
    chk('--json does not call this age alone', j.orderedByAgeAlone === false, String(j.orderedByAgeAlone))
    chk('and the page does not deny the dependency it just printed',
      !/Nothing here records a dependency/.test(out), out)
  }

  // The fix for the block above over-reached: blockedBy is never cleared on
  // close, so a blocker that had been CLOSED went on suppressing the disclaimer
  // for the life of the project. `orderedByAgeAlone: false` is a positive claim
  // that something other than age ordered the list -- made on a page where all
  // three separators print "separated nothing" and nothing about the closed
  // blocker is printed anywhere. Both directions are pinned here, because this
  // is a predicate that has now been wrong in each of them.
  console.log('\n── a blocker that has been closed stops being a dependency')
  {
    const p = project('closed-blocker')
    const a = pushedId(run(p, ['A, the blocker']).out)
    run(p, ['B, unrelated'])
    run(p, ['C, once waited on A', '--blocked-by', a])
    run(p, ['--done', a])

    const { out } = run(p, [])
    const j = json(p, [])
    chk('nothing is held back once the blocker is closed', !/held back \(/.test(out), out)
    chk('and no separator claims to have separated anything',
      !/unblocks \d+ open item/.test(out), out)
    chk('so the page says it ordered by age alone', /ordered by age alone/.test(out), out)
    chk('and --json says the same thing', j.orderedByAgeAlone === true, String(j.orderedByAgeAlone))
  }

  console.log('\n── but a blocker that is still open is still a dependency')
  {
    const p = project('open-blocker')
    const a = pushedId(run(p, ['A, the blocker']).out)
    run(p, ['B, unrelated'])
    run(p, ['C, waiting on A', '--blocked-by', a])

    const { out } = run(p, [])
    const j = json(p, [])
    chk('it is held back', /held back \(1\)/.test(out), out)
    chk('and the page does not call this age alone', !/ordered by age alone/.test(out), out)
    chk('nor does --json', j.orderedByAgeAlone === false, String(j.orderedByAgeAlone))
  }

  console.log('\n── one item unblocking three is not "age alone" either')
  {
    const p = project('one-unblocker')
    const a = pushedId(run(p, ['the one thing everything waits on']).out)
    run(p, ['first waiter', '--blocked-by', a])
    run(p, ['second waiter', '--blocked-by', a])
    run(p, ['third waiter', '--blocked-by', a])

    const j = json(p, [])
    const { out } = run(p, [])
    chk('the single ready item is the unblocker', j.next.length === 1 && j.next[0].id === a,
      JSON.stringify(j.next.map((n) => n.id)))
    chk('and its reason counts the three it releases',
      ((j.next[0] || {}).reasons || []).some((r) => /unblocks 3 open item/.test(r)), JSON.stringify(j.next))
    // SKILL.md tells the model that when this flag is set the top item must not
    // be presented as a recommendation. Setting it here would suppress the one
    // ordering this backlog can actually defend.
    chk('--json does not set the age-alone flag over a real dependency',
      j.orderedByAgeAlone === false, String(j.orderedByAgeAlone))
    chk('and the page says nothing about age alone', !/ordered by age alone/.test(out), out)
  }

  console.log('\n── a dangling blocker is still a recorded dependency, not "nothing"')
  {
    const p = project('dangling-claim')
    run(p, ['an item with a blocker nobody can find'])
    run(p, ['a second item so there is a list to order'])
    const dir = join(HOME, 'backlog')
    const f = readdirSync(dir).map((n) => join(dir, n))
      .find((n) => readFileSync(n, 'utf8').includes('an item with a blocker nobody can find'))
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    doc.items[0].blockedBy = ['bdeadbeef']
    writeFileSync(f, JSON.stringify(doc, null, 2))

    const { out } = run(p, [])
    const j = json(p, [])
    chk('the dangling blocker is named on the page',
      /blocker ids that name nothing in this backlog/.test(out), out)
    chk('and the page does not then say nothing records a dependency',
      !/Nothing here records a dependency/.test(out), out)
    chk('--json agrees', j.orderedByAgeAlone === false, String(j.orderedByAgeAlone))
  }

  // ─────────────────────────────── a backlog worked to zero says what it is
  console.log('\n── with everything closed it does not claim items are held back')
  {
    const p = project('worked-to-zero')
    const only = pushedId(run(p, ['the only thing there ever was', '--why', 'it mattered once']).out)
    run(p, ['--done', only])
    const { out, code } = run(p, [])
    chk('it does not claim anything is held back',
      !/every one of them is/.test(out) && !/held back/.test(out), out)
    chk('it says nothing is open and how many were closed',
      /Nothing is open\. All 1 item\(s\) in this backlog have been closed/.test(out), out)
    chk('it proposes nothing', !/next up/.test(out), out)
    chk('exit 0 — a finished backlog is an answer, not an error', code === 0, `exit ${code}`)
    const j = json(p, [])
    chk('--json counts it as closed, not held', j.counts.open === 0 && j.counts.closed === 1 && j.counts.held === 0,
      JSON.stringify(j.counts))
  }

  console.log('\n── with every OPEN item held back, that sentence is still true')
  {
    // The neighbouring branch to the one above, and the fix to that one must not
    // have taken this one with it. A cycle is the only way to hold every open
    // item locally — an item is held only by an OPEN blocker — so it is written
    // into the file, as with the dangling case above.
    const p = project('all-held')
    const a = pushedId(run(p, ['each waits on the other, A']).out)
    const b = pushedId(run(p, ['each waits on the other, B']).out)
    const dir = join(HOME, 'backlog')
    const f = readdirSync(dir).map((n) => join(dir, n))
      .find((n) => readFileSync(n, 'utf8').includes('each waits on the other, A'))
    const doc = JSON.parse(readFileSync(f, 'utf8'))
    doc.items.find((i) => i.id === a).blockedBy = [b]
    doc.items.find((i) => i.id === b).blockedBy = [a]
    writeFileSync(f, JSON.stringify(doc, null, 2))

    const { out, code } = run(p, [])
    chk('it says every open item is held back', /2 item\(s\) are open and every one of them is/.test(out), out)
    chk('and the held-back section it promises is actually there', /held back \(2\)/.test(out), out)
    chk('with a reason beside each', (out.match(/waiting on b[0-9a-f]+/g) || []).length === 2, out)
    chk('exit 0', code === 0, `exit ${code}`)
  }

  // ──────────────────────────── a flag it cannot read is refused, not ignored
  console.log('\n── a --limit it cannot read refuses instead of dropping the list')
  {
    const p = project('bad-limit')
    run(p, ['first ready thing'])
    run(p, ['second ready thing'])
    for (const bad of ['abc', '0', '-1', '2.5']) {
      const r = run(p, ['--limit', bad])
      chk(`--limit ${bad} is refused`, r.code === 1, `exit ${r.code}: ${r.out}${r.err}`)
      chk(`--limit ${bad} names the value it could not use`, r.err.includes(bad), r.err)
      chk(`--limit ${bad} prints no list at all`, !/next up/.test(r.out) && !/NaN/.test(r.out), r.out)
    }
    const ok = run(p, ['--limit', '1'])
    chk('a readable --limit still cuts, and says how much it cut',
      /next up \(1 of 2 ready\)/.test(ok.out) && /1 more ready item\(s\) not shown/.test(ok.out), ok.out)
  }

  // ──────────────────────────── the backlog belongs to the repo, not the cwd
  //
  // Keyed on the cwd, a note pushed from `services/api` landed in a backlog file
  // of its own, was unreachable from the repository root, and the root then said
  // the backlog was empty — a false statement with nothing on screen to doubt.
  console.log('\n── a note pushed from a subdirectory belongs to the repository')
  {
    const repo = project('monorepo', 'main')
    const api = subdir(repo, 'services/api')
    const push = run(api, ['the picker stub has drifted', '--why', 'it silently passes'])
    chk('the push names the repository, not the subdirectory',
      /where\s+monorepo · main · services\/api/.test(push.out), push.out)

    const root = run(repo, [])
    chk('the repository root does NOT report itself empty', !/This backlog is empty/.test(root.out), root.out)
    chk('and the note is there', root.out.includes('the picker stub has drifted'), root.out)
    chk('with the path within the repo recorded', /where\s+monorepo · main · services\/api/.test(root.out), root.out)

    const other = subdir(repo, 'services/web')
    chk('a sibling subdirectory sees the same one backlog',
      run(other, []).out.includes('the picker stub has drifted'), run(other, []).out)

    const j = json(repo, [])
    // Read through a default, so a regression that empties the list is a named
    // FAIL rather than a TypeError that stops the run — a crash proves nothing
    // about which claim broke.
    const where = (j.next[0] || {}).where || {}
    chk('--json records the path too', where.path === 'services/api', JSON.stringify(j.next))
    chk('and names the repository as the repo', where.repo === 'monorepo', JSON.stringify(j.next))
  }

  console.log('\n── a checkout nested inside another keeps its own backlog')
  {
    const outer = project('outer-repo', 'main')
    const inner = join(outer, 'vendor', 'inner-repo')
    mkdirSync(join(inner, '.git'), { recursive: true })
    writeFileSync(join(inner, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    run(outer, ['an outer note'])
    run(inner, ['an inner note'])
    const o = run(outer, []).out
    const i = run(inner, []).out
    chk('the outer repo does not swallow the nested checkout',
      o.includes('an outer note') && !o.includes('an inner note'), o)
    chk('and the nested checkout does not see the outer one',
      i.includes('an inner note') && !i.includes('an outer note'), i)
  }

  console.log('\n── a backlog file left under the old key is recovered, not lost')
  {
    const repo = project('legacy-repo', 'main')
    // Resolved, because a real push recorded `process.cwd()` and Node hands back
    // the real path. On macOS the scratch root arrives via /var -> /private/var,
    // so an unresolved string here would be a root no push could ever have
    // written and the test would be checking a case that does not occur.
    const deep = realpathSync(subdir(repo, 'tools/gen'))
    // Written by hand, with the shape a cwd-keyed push left behind: an item
    // whose recorded root is a subdirectory of this repository, in a file whose
    // name nothing computes any more. The filename is arbitrary on purpose —
    // ownership is decided by the root the item recorded, not by the digest,
    // which this test has no business reconstructing.
    const dir = join(HOME, 'backlog')
    mkdirSync(dir, { recursive: true })
    const orphan = join(dir, 'gen-0123456789.json')
    writeFileSync(orphan, JSON.stringify({
      version: 1, project: 'gen',
      items: [{
        id: 'blegacy01', text: 'a note pushed before the key was the repo root',
        why: 'it would otherwise be unreachable', tags: [], blockedBy: [], state: 'open',
        where: { repo: 'gen', root: deep, branch: 'main', worktree: null, path: null },
        createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', origin: 'local',
      }],
    }, null, 2))

    const { out } = run(repo, [])
    chk('the orphaned note is listed from the repository root',
      out.includes('a note pushed before the key was the repo root'), out)
    chk('and the file it came from is named on the page', out.includes(orphan), out)
    chk('the root does not report itself empty', !/This backlog is empty/.test(out), out)
    // Folding it in is a write. Once it has landed the notice has nothing left
    // to report, and a second pull must not double the item or repeat itself.
    const second = run(repo, [])
    chk('a second pull does not adopt it twice',
      (second.out.match(/a note pushed before the key was the repo root/g) || []).length === 1, second.out)
    chk('and says nothing more about the file it already folded in',
      !second.out.includes(orphan), second.out)
    const j = json(repo, [])
    chk('--json counts it once', j.counts.open === 1, JSON.stringify(j.counts))
  }
} finally {
  up.child.kill()
  silent.child.kill()
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(`\n   ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
