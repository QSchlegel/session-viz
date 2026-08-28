// The intent store, asserted against the files it actually leaves on disk.
//
// This store exists because /qpact re-derived everything every run and wrote it
// to one fixed path, so a second session's analysis silently replaced the
// first's. Every claim below is one that failure would have passed:
//
//   1. a second run of the SAME session MERGES — it updates what is there,
//      keeps what this run did not restate, and never grows a second copy of a
//      conclusion the model chose to say again. That is the compute saving, and
//      a store that quietly duplicated instead would still look full;
//   2. a DIFFERENT session is never clobbered. Its record survives another
//      session's merge untouched, and it is carried forward as PRIOR context —
//      never mixed into the fields that describe this session;
//   3. every conclusion carries the session it was drawn in and the turns cited
//      for it, in this session's fields and in the carried-forward ones. A
//      conclusion drawn three sessions ago that reads as this session's work is
//      the exact defect this codebase exists against;
//   4. a run from a SUBDIRECTORY finds the store the repository root finds.
//      qbl.mts shipped the other behaviour once: a note pushed from
//      `services/api` was unreachable from the root, which then reported
//      nothing and named no reason to doubt it;
//   5. a corrupt store is REFUSED BY NAME rather than half-read. Reading it as
//      empty would report no prior intent and then write over conclusions that
//      are still on disk.
//
// Every assertion is against the child process's own output or the JSON it
// wrote, never against a re-import of the function that produced it — except
// the last case, which hands the emitted document to the REAL renderer, because
// "render.mjs can read this" is a claim no amount of shape-checking settles.
//
// Every spawn carries a timeout, so a command that hangs is a named failure
// rather than a run that never ends.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, openSync, writeSync, closeSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { render } from '../scripts/render.mjs'

const INTENT = fileURLToPath(new URL('../scripts/intent.mjs', import.meta.url))

let pass = 0
let fail = 0
const chk = (name, ok, detail) => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok && detail) console.log(`         ${String(detail).split('\n').join('\n         ')}`)
  ok ? pass++ : fail++
}

// A unique root per run. A shared path under /tmp would let two runs of this
// test — or a run of it and a real /qpact — read each other's stores, and case 4
// would pass or fail for the wrong reason.
const ROOT = mkdtempSync(join(tmpdir(), 'intent-test-'))
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })

// Every candidate config directory home.mts knows about points into the scratch
// root. Leaving even one at its real value would let the developer's own intent
// store leak into these assertions.
const ENV = {
  PATH: process.env.PATH,
  HOME,
  SESSION_VIZ_HOME: HOME,
  XDG_CONFIG_HOME: join(HOME, 'xdg'),
}

const INTENT_DIR = join(HOME, 'intent')

function run(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [INTENT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...ENV, ...env },
  })
  if (r.error) throw new Error(`intent ${args.join(' ')} did not run: ${r.error.message}`)
  if (r.signal) throw new Error(`intent ${args.join(' ')} was killed by ${r.signal} — it hung past the 20s timeout`)
  return { out: r.stdout || '', err: r.stderr || '', code: r.status }
}

const json = (cwd, args, env) => {
  const r = run(cwd, [...args, '--json'], env)
  try {
    return { ...r, j: JSON.parse(r.out) }
  } catch (e) {
    throw new Error(`intent ${args.join(' ')} --json did not print JSON (exit ${r.code}): ${r.out.slice(0, 300)}${r.err ? `\nstderr: ${r.err.slice(0, 300)}` : ''}`)
  }
}

// A fabricated .git rather than a `git init`: projectKey() and currentBranch()
// walk for a `.git`, so this exercises the real code path with no git binary on
// PATH and no repository state to clean up.
const repo = (name, branch = 'main') => {
  const dir = join(ROOT, name)
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  return dir
}

const subdir = (dir, rel) => {
  const p = join(dir, rel)
  mkdirSync(p, { recursive: true })
  return p
}

const spine = (path, sessionId, turns) => {
  writeFileSync(
    path,
    JSON.stringify({ sessionId, file: `${path}.jsonl`, cwd: '/somewhere', turns: Array.from({ length: turns }, (_, i) => ({ index: i })) })
  )
  return path
}

const frag = (path, doc) => {
  writeFileSync(path, JSON.stringify(doc))
  return path
}

// Null rather than a throw. A missing or unparseable file is a thing to FAIL
// on by name — an exception escaping here would abort the run and report
// nothing, which is the failure mode this whole file argues against.
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

const storeOf = (key) => readJson(join(INTENT_DIR, `${key}.json`))
const sessionOf = (key, id) => (storeOf(key)?.sessions || []).find((s) => s.sessionId === id) ?? null

/**
 * A numbered case, with a net under it.
 *
 * Proving these assertions load-bearing means running the suite against a
 * deliberately broken store, and broken code does not politely return the
 * shapes a traversal expects. Without this, two of the breaks took the whole
 * run down with a TypeError and printed no verdict at all — a suite that
 * crashes tells you less than one that says which claim failed.
 */
const section = (title, fn) => {
  console.log(`\n${title}`)
  try {
    fn()
  } catch (e) {
    chk(`${title} — ran to the end`, false, `threw: ${(e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : String(e))}`)
  }
}

/** A section that has to await something. Same net, same reporting. */
const sectionAsync = async (title, fn) => {
  console.log(`\n${title}`)
  try {
    await fn()
  } catch (e) {
    chk(`${title} — ran to the end`, false, `threw: ${(e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : String(e))}`)
  }
}

/** Sleep without a timer, so a bounded wait cannot become an unbounded one. */
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const record = (sessionId, text, at) => ({
  sessionId,
  firstSeen: at,
  lastSeen: at,
  runs: 1,
  turnsSeen: 3,
  cwd: '',
  branch: null,
  worktree: null,
  tldr: { text, provenance: { session: sessionId, turns: [1], recordedAt: at, firstRecordedAt: at } },
  compactInstruction: null,
  intents: [],
  quality: null,
  graph: { concepts: [], relations: [] },
})

const SESS_A = '0199aa11-1111-2222-3333-444455556666'
const SESS_B = '0199bb22-7777-8888-9999-aaaabbbbcccc'

// ══════════════════════════════════════════════════════════ 1. the merge
section('1. a second run of one session merges into what is there', () => {
  const dir = repo('merging')
  const sp = spine(join(ROOT, 'merge-spine.json'), SESS_A, 12)
  const key = json(dir, ['--where']).j.key

  const f1 = frag(join(ROOT, 'm1.json'), {
    tldr: 'Building the intent store.',
    compactInstruction: 'Keep the store shape and the provenance rules.',
    quality: { verdict: 'Two interruptions, both on the same file.', strengths: ['named the file'], weaknesses: [], recommendations: [] },
    intents: [
      { title: 'Design the store', status: 'partial', turns: [1, 2], summary: 'Keyed on the repository.' },
      { title: 'Read qbl first', status: 'done', turns: [0], summary: 'It hit this already.' },
    ],
    graph: {
      concepts: [{ id: 'prov', label: 'Provenance on every conclusion', group: 'decision', turns: [3], anchors: ['tool:Edit'] }],
      relations: [{ from: 'prov', to: 'turn:3', label: 'decided at', turns: [3] }],
    },
  })

  const r1 = json(dir, ['--spine', sp, '--merge', f1])
  chk('the first merge reports itself as the first run', r1.j.merged.firstRun === true && r1.j.merged.runs === 1, JSON.stringify(r1.j.merged))

  const after1 = sessionOf(key, SESS_A)
  const tldrStamp1 = after1?.tldr?.provenance?.recordedAt ?? null
  const designStamp1 = after1?.intents?.find((i) => i.title === 'Design the store')?.provenance?.recordedAt ?? null
  chk('the first merge left a record with a tldr and an intent on disk', !!tldrStamp1 && !!designStamp1, JSON.stringify(after1))

  // Run two restates ONE intent, adds a new one, and says nothing about the
  // tldr, the compact instruction, the quality or the graph. That silence is
  // the compute saving, so it is what the assertions below are about.
  const f2 = frag(join(ROOT, 'm2.json'), {
    intents: [
      { title: 'Design the store', status: 'done', turns: [5, 6], summary: 'Keyed on the repository, with adoption.' },
      { title: 'Write the tests', status: 'ongoing', turns: [7], summary: 'Five cases.' },
    ],
  })
  const r2 = json(dir, ['--spine', sp, '--merge', f2])
  const m = r2.j.merged

  chk('the second merge is run 2 of the same session, not a new one', m.firstRun === false && m.runs === 2, JSON.stringify(m))

  const after2 = sessionOf(key, SESS_A)
  const titles = (after2?.intents || []).map((i) => i.title)
  chk(
    'a restated intent updates in place — three intents, not four',
    titles.length === 3 && titles.filter((t) => t === 'Design the store').length === 1,
    `intents on disk: ${JSON.stringify(titles)}`
  )
  chk('the merge report counts one updated and one new', m?.intents?.updated === 1 && m?.intents?.added === 1, JSON.stringify(m?.intents))

  const design = (after2?.intents || []).find((i) => i.title === 'Design the store') ?? null
  chk('the restated intent takes the new status and summary', design?.status === 'done' && !!design?.summary?.includes('adoption'), JSON.stringify(design))
  chk(
    'its turn citations accumulate rather than being replaced',
    JSON.stringify(design?.turns) === JSON.stringify([1, 2, 5, 6]),
    `turns: ${JSON.stringify(design?.turns)}`
  )
  chk(
    'it still records when it was FIRST drawn, not when it was restated',
    !!designStamp1 && design?.provenance?.firstRecordedAt === designStamp1 && design?.provenance?.recordedAt !== designStamp1,
    `firstRecordedAt ${design?.provenance?.firstRecordedAt} vs run-1 ${designStamp1}, recordedAt ${design?.provenance?.recordedAt}`
  )

  // The whole point: what run two did not restate cost nothing and was not
  // re-dated to now. A store that re-stamped it would report a four-session-old
  // conclusion as today's.
  chk(
    'a field the second run left out is carried, with its original date intact',
    after2?.tldr?.text === 'Building the intent store.' && after2?.tldr?.provenance?.recordedAt === tldrStamp1,
    `tldr recordedAt ${after2?.tldr?.provenance?.recordedAt ?? '(no tldr on disk)'}, was ${tldrStamp1}`
  )
  chk(
    'the report says so, so a caller can tell reuse from rework',
    m?.tldr === 'carried' && m?.compactInstruction === 'carried' && m?.quality === 'carried' && m?.concepts?.carried === 1 && m?.relations?.carried === 1,
    JSON.stringify({ tldr: m?.tldr, quality: m?.quality, concepts: m?.concepts, relations: m?.relations })
  )

  // And the context a third run reads before it writes anything names what it
  // may leave out. This is the sentence that saves the model the work.
  const ctx = json(dir, ['--spine', sp]).j
  chk(
    'the next run is told what it can leave out',
    ctx.session?.known === true && ctx.session?.runs === 2 && ctx.reusable?.tldr === true && ctx.reusable?.intents === 3,
    JSON.stringify(ctx.reusable)
  )
  chk(
    'and how far the last run got, so only new turns need reading',
    ctx.session?.turnsAtLastRun === 12 && ctx.session?.turnsNow === 12 && ctx.session?.newTurns === 0,
    JSON.stringify(ctx.session)
  )

  // Two edges that differ only in where the boundary between their endpoints
  // falls. Joining the fields with any separator a value could contain would
  // merge them into one, and the graph would lose a relation with nothing said.
  const f3 = frag(join(ROOT, 'm3.json'), {
    graph: {
      relations: [
        { from: 'a b', to: 'c', label: 'same' },
        { from: 'a', to: 'b c', label: 'same' },
      ],
    },
  })
  const r3 = json(dir, ['--spine', sp, '--merge', f3])
  chk(
    'two edges that differ only in where their endpoints split stay two edges',
    r3.j.merged?.relations?.added === 2,
    JSON.stringify(r3.j.merged?.relations)
  )
  chk(
    'and both are on disk',
    (sessionOf(key, SESS_A)?.graph?.relations || []).filter((x) => x.label === 'same').length === 2,
    JSON.stringify((sessionOf(key, SESS_A)?.graph?.relations || []).map((x) => [x.from, x.to, x.label]))
  )
})

// ══════════════════════════════════════════════════════════ 2. no clobbering
let CARRY = null
section('2. a different session is carried forward, never overwritten', () => {
  const dir = repo('carrying')
  const spA = spine(join(ROOT, 'carry-a.json'), SESS_A, 8)
  const spB = spine(join(ROOT, 'carry-b.json'), SESS_B, 4)
  const key = json(dir, ['--where']).j.key

  const fA = frag(join(ROOT, 'c-a.json'), {
    tldr: 'Session A decided the store is keyed on the repository.',
    compactInstruction: 'A: keep the keying decision.',
    intents: [{ title: 'Key on the repository', status: 'done', turns: [2, 3], summary: 'Not on the working directory.' }],
    graph: { concepts: [{ id: 'repo-key', label: 'Repository key', group: 'decision', turns: [2] }], relations: [] },
    quality: { verdict: 'A was clean.', strengths: [], weaknesses: [], recommendations: [] },
  })
  const rA = json(dir, ['--spine', spA, '--merge', fA])
  const beforeB = JSON.stringify(sessionOf(key, SESS_A))
  const renderA = rA.j.render

  const fB = frag(join(ROOT, 'c-b.json'), {
    tldr: 'Session B wired the renderer.',
    compactInstruction: 'B: keep the renderer wiring.',
    intents: [{ title: 'Wire the renderer', status: 'ongoing', turns: [1], summary: 'Emit what render.mjs reads.' }],
  })
  const rB = json(dir, ['--spine', spB, '--merge', fB])

  chk(
    "session A's record is byte-identical after session B merged",
    JSON.stringify(sessionOf(key, SESS_A)) === beforeB,
    'A changed when B was written'
  )
  chk('both sessions are held in one store', storeOf(key)?.sessions?.length === 2, JSON.stringify(storeOf(key)?.sessions?.map((x) => x.sessionId)))

  // The original defect, directly: one fixed path meant B's run replaced A's
  // file. Two sessions, two paths, and A's is still A's.
  chk('each session gets its own render file', !!rA.j.render && rA.j.render !== rB.j.render, `${rA.j.render}\n${rB.j.render}`)
  const docA = readJson(renderA)
  chk(
    "session A's render file still describes session A after B ran",
    docA?.sessionId === SESS_A && !!docA?.tldr?.startsWith('Session A'),
    `${docA?.sessionId} / ${docA?.tldr}`
  )

  const docB = readJson(rB.j.render)
  CARRY = { docA, docB, key, dir, spB }

  // The anti-defect assertion. A conclusion A drew must not appear in any field
  // that describes what B did.
  chk(
    "session B's own fields hold only session B's work",
    !!docB?.tldr?.startsWith('Session B') &&
      docB?.intents?.length === 1 &&
      docB.intents.every((i) => i.provenance?.session === SESS_B),
    JSON.stringify(docB?.intents?.map((i) => [i.title, i.provenance?.session]))
  )
  chk(
    "session A is carried forward as prior context, and says how far back it is",
    docB?.prior?.length === 1 && docB.prior[0].sessionId === SESS_A && docB.prior[0].sessionsAgo === 1,
    JSON.stringify(docB?.prior?.map((p) => [p.sessionId, p.sessionsAgo]))
  )
  chk(
    "an earlier session's /compact line is NOT carried — it would tell the summariser to keep threads this session never touched",
    !!docB?.prior?.[0] && !('compactInstruction' in docB.prior[0]),
    `prior carried: ${JSON.stringify(docB?.prior?.[0] ? Object.keys(docB.prior[0]) : null)}`
  )
  chk(
    'the carried material says outright that nothing has re-checked whether it is still true',
    /may have been reversed/.test(docB?.staleness?.note || '') && /age, not as confidence/.test(docB?.staleness?.note || ''),
    docB?.staleness?.note
  )

  // Filing one session's conclusions under another is refused, not merged. This
  // is the "silence is not an option" half: a mismatch is named on the way in,
  // not warned about on the page after the fact.
  const bad = frag(join(ROOT, 'c-bad.json'), { sessionId: SESS_A, tldr: 'this belongs to A' })
  const before = readFileSync(join(INTENT_DIR, `${key}.json`), 'utf8')
  const r = run(dir, ['--spine', spB, '--merge', bad])
  chk('a fragment written for another session is refused', r.code !== 0, `exit ${r.code}`)
  chk(
    'the refusal names the conflict and both sessions',
    /session-mismatch/.test(r.err) && r.err.includes(SESS_A.slice(0, 8)) && r.err.includes(SESS_B.slice(0, 8)),
    r.err.trim()
  )
  chk('and nothing was written', readFileSync(join(INTENT_DIR, `${key}.json`), 'utf8') === before)
})

// ══════════════════════════════════════════════════════════ 3. provenance
section('3. every conclusion carries its session and its turns', () => {
  chk('case 2 produced the two documents this case reads', !!CARRY?.docA && !!CARRY?.docB, 'case 2 did not get far enough to emit them')
  const docA = CARRY?.docA ?? {}
  const docB = CARRY?.docB ?? { prior: [], intents: [], graph: {}, provenance: {} }

  // Walk the emitted document generically. A hand-listed set of fields is how a
  // new conclusion type ships with no provenance and nothing notices.
  const found = []
  const visit = (label, p) => found.push([label, p])
  const walkSession = (label, d) => {
    if (d.tldr && d.provenance?.tldr) visit(`${label}.tldr`, d.provenance.tldr)
    if (d.compactInstruction && d.provenance?.compactInstruction) visit(`${label}.compactInstruction`, d.provenance.compactInstruction)
    if (d.quality) visit(`${label}.quality`, d.quality.provenance)
    ;(d.intents || []).forEach((i, n) => visit(`${label}.intents[${n}]`, i.provenance))
    ;(d.graph?.concepts || []).forEach((c, n) => visit(`${label}.concepts[${n}]`, c.provenance))
    ;(d.graph?.relations || []).forEach((r, n) => visit(`${label}.relations[${n}]`, r.provenance))
  }
  walkSession('this', docB)
  docB.prior.forEach((p, n) => {
    if (p.tldr) visit(`prior[${n}].tldr`, p.tldr.provenance)
    walkSession(`prior[${n}]`, p)
  })

  chk('the document actually holds conclusions to check', found.length >= 6, `found ${found.length}`)

  const bad = found.filter(
    ([, p]) =>
      !p ||
      typeof p.session !== 'string' ||
      !p.session ||
      !Array.isArray(p.turns) ||
      typeof p.recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(p.recordedAt)) ||
      typeof p.fromThisSession !== 'boolean' ||
      !Number.isInteger(p.sessionsAgo)
  )
  chk(
    'every conclusion names a session, a turn list and a date',
    bad.length === 0,
    bad.map(([l, p]) => `${l}: ${JSON.stringify(p)}`).join('\n')
  )

  const misattributed = found.filter(([, p]) => p.fromThisSession !== (p.session === docB.sessionId))
  chk(
    'nothing drawn in an earlier session claims to be this one',
    misattributed.length === 0,
    misattributed.map(([l, p]) => `${l}: session ${p.session} fromThisSession ${p.fromThisSession}`).join('\n')
  )

  const carried = found.filter(([l]) => l.startsWith('prior['))
  chk(
    'the carried conclusions are all dated one session back',
    carried.length > 0 && carried.every(([, p]) => p.sessionsAgo === 1 && p.session === docA.sessionId),
    carried.map(([l, p]) => `${l}: ${p.sessionsAgo} back, ${p.session}`).join('\n')
  )

  // Turns are what the author cited and nothing else. The store must neither
  // lose them nor supply a range nobody stated.
  const priorIntent = docB?.prior?.[0]?.intents?.[0] ?? null
  chk(
    "a carried conclusion still cites the turns of the session that drew it",
    JSON.stringify(priorIntent?.provenance?.turns) === JSON.stringify([2, 3]) && priorIntent?.provenance?.session === docA?.sessionId,
    JSON.stringify(priorIntent?.provenance)
  )
  chk(
    'a conclusion the author cited no turns for carries an empty list, not an invented one',
    Array.isArray(docB?.provenance?.tldr?.turns) && docB.provenance.tldr.turns.length === 0,
    JSON.stringify(docB?.provenance?.tldr)
  )
})

// ══════════════════════════════════════════════════════════ 4. subdirectories
section('4. a run from a subdirectory finds the store the root finds', () => {
  const dir = repo('deep')
  const deep = subdir(dir, 'services/api/handlers')
  const sp = spine(join(ROOT, 'deep-spine.json'), SESS_A, 5)

  const atRoot = json(dir, ['--where']).j
  const atDeep = json(deep, ['--where']).j
  chk('the key is the repository, not the directory the command ran in', atRoot.key === atDeep.key, `${atRoot.key} vs ${atDeep.key}`)
  chk('and so is the recorded root', atRoot.root === atDeep.root, `${atRoot.root} vs ${atDeep.root}`)

  // Written from the subdirectory, read from the root. qbl.mts shipped the
  // opposite: the root reported an empty backlog and named no reason to doubt it.
  const f = frag(join(ROOT, 'deep.json'), { tldr: 'Pushed from a subdirectory.', intents: [{ title: 'X', status: 'done', turns: [1], summary: 's' }] })
  const w = json(deep, ['--spine', sp, '--merge', f])
  const fromRoot = json(dir, ['--spine', sp]).j
  chk(
    'intent written from a subdirectory is visible from the repository root',
    fromRoot.session?.known === true && fromRoot.reusable?.tldr === true && fromRoot.reusable?.intents === 1,
    JSON.stringify(fromRoot.reusable)
  )
  chk('both runs name the same store file', !!w.j.store && w.j.store === fromRoot.store?.path, `${w.j.store}\n${fromRoot.store?.path}`)
  chk(
    'and the same place to write the fragment, so two runs cannot disagree',
    !!fromRoot.paths?.fragment && json(deep, ['--spine', sp]).j.paths?.fragment === fromRoot.paths.fragment
  )

  // A store left under a key nothing computes any more is lost as thoroughly as
  // a deleted one. This is the file the pre-repository-key version would have
  // written, and it must be adopted rather than orphaned.
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'
  const oldKey = `${slug(basename(deep))}-${createHash('sha256').update(deep).digest('hex').slice(0, 10)}`
  const strayPath = join(INTENT_DIR, `${oldKey}.json`)
  writeFileSync(
    strayPath,
    JSON.stringify({
      version: 1,
      project: { name: 'handlers', root: deep, key: oldKey },
      sessions: [
        {
          sessionId: SESS_B,
          firstSeen: '2026-01-01T00:00:00.000Z',
          lastSeen: '2026-01-01T00:00:00.000Z',
          runs: 1,
          turnsSeen: 3,
          cwd: deep,
          branch: 'main',
          worktree: null,
          tldr: { text: 'Filed under the old key.', provenance: { session: SESS_B, turns: [4], recordedAt: '2026-01-01T00:00:00.000Z', firstRecordedAt: '2026-01-01T00:00:00.000Z' } },
          compactInstruction: null,
          intents: [],
          quality: null,
          graph: { concepts: [], relations: [] },
        },
      ],
    })
  )
  const adopted = json(dir, ['--where']).j
  chk('a store under a key this command no longer computes is adopted, not orphaned', !!adopted.adoptedFrom?.includes(strayPath), JSON.stringify(adopted.adoptedFrom))
  chk('and its session is now in the store the root reads', !!adopted.sessions?.some((s) => s.sessionId === SESS_B), JSON.stringify(adopted.sessions?.map((s) => s.sessionId)))
  chk('a second run adopts nothing — ids dedupe', json(dir, ['--where']).j.adoptedFrom?.length === 0)

  // Ownership is re-resolved from the root the file recorded, never guessed
  // from the path. A checkout vendored inside this tree is its own project.
  const nested = subdir(dir, 'vendor/lib')
  mkdirSync(join(nested, '.git'), { recursive: true })
  writeFileSync(join(nested, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const nestedKey = `${slug(basename(nested))}-${createHash('sha256').update(nested).digest('hex').slice(0, 10)}`
  writeFileSync(
    join(INTENT_DIR, `${nestedKey}.json`),
    JSON.stringify({ version: 1, project: { name: 'lib', root: nested, key: nestedKey }, sessions: [{ sessionId: 'nested-session', firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', runs: 1, turnsSeen: null, cwd: nested, branch: null, worktree: null, tldr: null, compactInstruction: null, intents: [], quality: null, graph: { concepts: [], relations: [] } }] })
  )
  const after = json(dir, ['--where']).j
  chk(
    'a nested checkout inside this tree keeps its own store',
    !after.sessions?.some((s) => s.sessionId === 'nested-session'),
    JSON.stringify(after.sessions?.map((s) => s.sessionId))
  )

  // The emitted documents must not sit where adoption looks for stores.
  const beside = readdirSync(INTENT_DIR).filter((n) => n.endsWith('.json'))
  chk(
    'per-session files live below the stores, not beside them',
    beside.every((n) => !n.includes('.intent.json') && !n.includes('.fragment.json')) && existsSync(join(INTENT_DIR, 'sessions')),
    JSON.stringify(beside)
  )
})

// ══════════════════════════════════════════════════════════ 5. a corrupt store
section('5. a corrupt store is refused by name, not half-read', () => {
  const dir = repo('corrupt')
  const sp = spine(join(ROOT, 'corrupt-spine.json'), SESS_A, 6)
  const key = json(dir, ['--where']).j.key
  const f = frag(join(ROOT, 'corrupt-frag.json'), { tldr: 'good', intents: [{ title: 'T', status: 'done', turns: [1], summary: 's' }] })
  json(dir, ['--spine', sp, '--merge', f])

  const path = join(INTENT_DIR, `${key}.json`)
  const truncated = '{"version":1,"project":{"name":"corrupt","root":"' + dir + '"},"sessions":[{"sessionId":"0199'
  writeFileSync(path, truncated)

  const ctx = run(dir, ['--spine', sp])
  chk('reading a corrupt store fails', ctx.code !== 0, `exit ${ctx.code}`)
  chk('the refusal carries a code and the path of the file to look at', /store-unreadable/.test(ctx.err) && ctx.err.includes(path), ctx.err.trim())

  // The half-read is the dangerous one: treated as empty, this run would report
  // no prior intent and then write over conclusions still on disk.
  const merged = run(dir, ['--spine', sp, '--merge', f])
  chk('merging into a corrupt store fails too', merged.code !== 0, `exit ${merged.code}`)
  chk('and the file is exactly as it was — nothing was written over it', readFileSync(path, 'utf8') === truncated)
  chk('the store was not silently replaced by a fresh one', readFileSync(path, 'utf8').length === truncated.length)

  // Valid JSON of the wrong shape is the same refusal: a document with no
  // sessions array read as "no sessions" is a half-read with better syntax.
  writeFileSync(path, JSON.stringify({ version: 1, project: { name: 'corrupt', root: dir }, sessions: 'nope' }))
  const shaped = run(dir, ['--spine', sp])
  chk('valid JSON that is not a store is refused the same way', shaped.code !== 0 && /store-unreadable/.test(shaped.err), shaped.err.trim())

  // A store recording another repository is refused rather than merged into:
  // ten hex characters of digest is not proof, and config directories get copied.
  writeFileSync(path, JSON.stringify({ version: 1, project: { name: 'elsewhere', root: join(ROOT, 'some-other-repo'), key }, sessions: [] }))
  const other = run(dir, ['--spine', sp])
  chk('a store written for another repository is refused by name', other.code !== 0 && /project-mismatch/.test(other.err), other.err.trim())

  // An unrelated corrupt store elsewhere on the machine must not break this
  // project — adoption skips what it cannot read rather than refusing for it.
  writeFileSync(path, JSON.stringify({ version: 1, project: { name: 'corrupt', root: dir, key }, sessions: [] }))
  writeFileSync(join(INTENT_DIR, 'someone-elses-0000000000.json'), '{not json at all')
  const recovered = run(dir, ['--spine', sp])
  chk('an unrelated unreadable store elsewhere does not break this project', recovered.code === 0, recovered.err.trim())
})

// ══════════════════════════════════════════════════════════ 6. the renderer
section('6. the emitted document is what render.mjs reads', () => {
  const turns = Array.from({ length: 6 }, (_, index) => ({
    index,
    text: `turn ${index}`,
    durationMs: 1000,
    friction: [],
    signals: {},
    toolCalls: [],
    toolCallCount: 0,
    tokens: { output: 10 },
    derived: { repeatOf: null },
    score: { value: 90, deductions: [], additions: [] },
  }))
  const session = {
    sessionId: SESS_B,
    harness: 'claude-code',
    cwd: '/somewhere/carrying',
    gitBranch: 'main',
    durationMs: 60000,
    models: { 'claude-opus-5': 6 },
    slashCommands: [],
    permissionModes: [],
    artifacts: { tools: { git: 2 }, mcp: {}, packages: {}, stack: {}, extensions: {}, skills: {}, fileTouches: 4 },
    totals: { humanTurns: turns.length, toolCalls: 0, tokens: { output: 100, cacheRead: 100 }, frictionTurns: 0, repeats: 0, interruptions: 0, steeringTurns: 0, records: 10 },
    score: { value: 90, band: 'clean', confidence: 'high', turnsScored: turns.length, frictionRate: 0, craftRate: 0, wastedTokens: 0 },
    turns,
  }
  const html = render(session, CARRY?.docB ?? null)

  chk("this session's TL;DR reaches the page", html.includes('Session B wired the renderer'), 'the tldr is not in the rendered page')
  chk("this session's intent breakdown reaches the page", html.includes('Wire the renderer'))
  chk(
    'the page does not accuse the two files of describing different sessions',
    !html.includes('These two files describe different sessions'),
    'the sessionId the store emitted did not match the spine'
  )
  // This assertion used to test ABSENCE, and it was right to at the time: the
  // renderer did not read `prior`, and a conclusion drawn last week appearing
  // with no date on it is worse than not appearing. The renderer reads it now,
  // so the honest test is the harder one — it is DRAWN, and it is dated, and it
  // is not counted among this session's work.
  const payload = JSON.parse((html.match(/window\.__qkg=([\s\S]*?);<\/script>/) || [])[1] || 'null')
  const carried = (payload?.nodes ?? []).filter((n) => n.carried)
  const mine = (payload?.nodes ?? []).filter((n) => n.kind === 'intent' && !n.carried)

  chk(
    "the earlier session's conclusion is drawn rather than quietly dropped",
    carried.some((n) => /Key on the repository/i.test(n.label || '')),
    `carried nodes: ${JSON.stringify(carried.map((n) => n.label))}`
  )
  chk(
    'and every one of them names the session it was drawn in',
    carried.length > 0 && carried.every((n) => n.carried.s && n.carried.s !== SESS_B),
    JSON.stringify(carried.map((n) => n.carried?.s))
  )
  chk(
    'and is dated to no turn of this session, so the replay cannot claim it',
    carried.every((n) => n.at === -1 && !n.turns),
    JSON.stringify(carried.map((n) => [n.at, n.turns]))
  )
  chk(
    'and the markup tells a reader who cannot see the ring',
    /carried from a session 1 back, not this one/.test(html)
  )
  chk(
    "and this session's own threads are not marked carried",
    mine.length > 0 && mine.every((n) => !n.carried),
    JSON.stringify(mine.map((n) => n.label))
  )
  chk(
    "so a status hub counts this session's threads and not the earlier one's",
    (payload?.nodes ?? [])
      .filter((n) => n.kind === 'status')
      .every((h) => Number((h.label.match(/\u00b7\s*(\d+)/) || [])[1]) === mine.filter((n) => n.status === h.status).length),
    JSON.stringify((payload?.nodes ?? []).filter((n) => n.kind === 'status').map((n) => n.label))
  )
})

// ══════════════════════════════════════════════════════════ 7. the write race
//
// Two sessions analysing at once in one repository both read the store, both
// add their own record, and the second save drops the first's. No error, no
// conflict, and the loser's conclusions are gone — which is the same silent
// overwrite this store was built to end, wearing a different hat.
//
// A named pipe makes the window exact rather than hoped for. The child has
// already read the store by the time it opens the fragment, and it cannot get
// past that open until this test appears at the other end of the pipe — so the
// competing session lands provably inside the window, with no sleeps and
// nothing timing-dependent to go flaky.
await sectionAsync('7. a session that lands mid-run is not overwritten by this one', async () => {
  const dir = repo('racing')
  const spB = spine(join(ROOT, 'race-b.json'), SESS_B, 3)
  const key = json(dir, ['--where']).j.key
  const storePath = join(INTENT_DIR, `${key}.json`)

  // An existing session, so the store is real before the race starts.
  const sp0 = spine(join(ROOT, 'race-0.json'), '0199dd44-0000-0000-0000-000000000000', 2)
  json(dir, ['--spine', sp0, '--merge', frag(join(ROOT, 'race-0f.json'), { tldr: 'The session already in the store.' })])

  const fifo = join(ROOT, 'race.fifo')
  const mk = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
  chk('a named pipe is available to hold the child open', mk.status === 0, mk.stderr || String(mk.error))
  if (mk.status !== 0) return

  const child = spawn(process.execPath, [INTENT, '--spine', spB, '--merge', fifo, '--json'], { cwd: dir, env: ENV })
  let out = ''
  let cerr = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (cerr += d))
  const exited = new Promise((res) => child.on('exit', (code) => res(code)))

  // O_NONBLOCK so a child that died is a named failure, never a hang: opening
  // the write end of a pipe with no reader returns ENXIO instead of blocking.
  let fd = null
  const deadline = Date.now() + 15000
  while (fd === null && Date.now() < deadline) {
    try {
      fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)
    } catch (e) {
      if (e.code !== 'ENXIO') throw e
      nap(5)
    }
  }
  chk('the child reached the fragment, so it has already read the store', fd !== null, `child stderr: ${cerr.slice(0, 300)}`)
  if (fd === null) {
    child.kill()
    return
  }

  // The competing session finishes now — provably after the child read the
  // store and provably before the child writes it.
  const mid = readJson(storePath)
  const at = new Date().toISOString()
  mid.sessions.push(record(SESS_A, 'Session A landed while B was thinking.', at))
  writeFileSync(storePath, JSON.stringify(mid, null, 2) + '\n')

  writeSync(fd, JSON.stringify({ tldr: 'Session B finished second.' }))
  closeSync(fd)
  const code = await exited

  chk('the child completed', code === 0, `exit ${code}, stderr: ${cerr.slice(0, 300)}`)
  const final = readJson(storePath)
  const ids = (final?.sessions || []).map((x) => x.sessionId)
  chk('this run recorded its own session', ids.includes(SESS_B), JSON.stringify(ids))
  chk(
    'the session that landed mid-run survived the write',
    ids.includes(SESS_A),
    `the store was written from a copy read before that session existed: ${JSON.stringify(ids)}`
  )
  chk('and so did the session that was there all along', ids.includes('0199dd44-0000-0000-0000-000000000000'), JSON.stringify(ids))
  chk(
    "the survivor kept its own text, not this run's",
    final?.sessions?.find((x) => x.sessionId === SESS_A)?.tldr?.text === 'Session A landed while B was thinking.',
    JSON.stringify(final?.sessions?.find((x) => x.sessionId === SESS_A)?.tldr)
  )
  // A page built for B must now show A as prior context rather than pretending
  // it was not there.
  const doc = readJson(JSON.parse(out).render)
  chk(
    'the page built for this run carries the mid-run session as prior context',
    (doc?.prior || []).some((x) => x.sessionId === SESS_A),
    JSON.stringify((doc?.prior || []).map((x) => x.sessionId))
  )
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
