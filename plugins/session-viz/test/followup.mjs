// The unfinished threads, the appendix that ties tasks to files, and the shape
// the model's conclusions take in the graph — asserted on the REAL rendered
// page and on the REAL command line, never on a re-run of the functions that
// produced them.
//
// Three claims are being defended here and all three are claims about wording
// as much as about markup.
//
//   A done thread has nothing left open, so it gets no drill-down. A button on
//   every thread would make the button mean "here is a thread" instead of "here
//   is a thread that did not finish", which is the only thing it is for.
//
//   The appendix is the section on this page most able to lie, and it lies two
//   ways. It lies by looking like a manifest: a turn touching a file is
//   EVIDENCE the task changed it, not proof, and a file under two tasks belongs
//   to neither exclusively. And it lies by being empty: --no-paths and a spine
//   older than the field both render exactly no rows, and no rows under "what
//   each task produced" reads as "these tasks produced nothing".
//
//   A conclusion carried in from an earlier session must never look like one
//   this session drew. Shape carries the layer, the ring carries the age, and
//   the one toggle still has to subtract the whole authored layer at once.
//
// The CLI half is not a nicety. The page's button and `--followup` are two
// consumers of one builder, and the only thing that keeps them from drifting is
// this file comparing the bytes of one against the bytes of the other.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render } from '../scripts/render.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (title, fn) => {
  console.log(`\n${title}`)
  try {
    fn()
  } catch (err) {
    // A break that throws is still a break, but a stack trace is not a named
    // failure. Every case reports as a FAIL with its own name so a deliberate
    // break shows which claim stopped holding rather than which line threw.
    chk(`${title} ran to the end`, false, String(err && err.stack ? err.stack.split('\n')[0] : err))
  }
}

const RENDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'render.mjs')

const unesc = (s) =>
  String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

/** Prose in the prompt is wrapped for a terminal, so a sentence is several
 *  lines with an indent between them. Assertions about what it SAYS run over
 *  this; assertions about its shape run over the raw text. */
const flat = (s) => String(s).replace(/\s+/g, ' ').trim()

const preOf = (html, id) => {
  const m = html.match(new RegExp(`<pre id="${id}">([\\s\\S]*?)</pre>`))
  return m ? unesc(m[1]) : null
}
const payloadOf = (html) => {
  const m = html.match(/window\.__qkg=([\s\S]*?);<\/script>/)
  return m ? JSON.parse(m[1]) : null
}
/** The one `.intent` block whose heading carries this title, markup and all. */
const blockOf = (html, title) => {
  const blocks = html.split('<div class="intent ').slice(1).map((b) => b.slice(0, b.indexOf('\n</div>')))
  return blocks.find((b) => b.includes(`>${title}<`)) ?? null
}
const appendixOf = (html) => {
  const from = html.indexOf('<h2>Appendix')
  if (from < 0) return ''
  const to = html.indexOf('<h2>', from + 4)
  return html.slice(from, to < 0 ? html.length : to)
}

// ---------------------------------------------------------------- the fixture
//
// Turn 5 is touched by no task's citation and turn 9 is cited by a task and is
// not in the spine at all. Both are here because both are shapes the appendix
// has to report rather than absorb.
const FILES = {
  0: [{ path: 'src/render.mts', count: 3 }],
  1: [{ path: 'src/graph.mts', count: 5 }, { path: 'src/render.mts', count: 1 }],
  2: [],
  3: [{ path: 'test/graph.mjs', count: 2 }],
  4: [{ path: 'src/graph.mts', count: 4 }],
  5: [{ path: 'docs/readme.md', count: 1 }],
  6: [{ path: 'src/bundle.mts', count: 7 }],
}

// The derived graph draws a turn only when something points at it, and with
// every count at zero the busiest-three rule picks turns 0, 1 and 2 -- so a
// thread citing turn 4 would have had nowhere to land its edge, and the
// assertion that a thread hangs off the turns it cited would have passed on a
// graph that never draws one. These three counts are what put turns 0, 4 and 6
// on the canvas.
const BUSY = { 0: 30, 4: 50, 6: 40 }

const turn = (index, extra = {}) => ({
  index,
  text: `turn ${index}`,
  durationMs: 1000,
  friction: [],
  signals: {},
  toolCalls: [],
  toolCallCount: BUSY[index] ?? 0,
  tokens: { output: 10 },
  derived: { repeatOf: null },
  score: { value: 90, deductions: [], additions: [] },
  ...(FILES[index] ? { files: FILES[index] } : {}),
  ...extra,
})

const SESSION = 'bbbbcccc-0000-0000-0000-000000000000'
const EARLIER = 'aaaa1111-0000-0000-0000-000000000000'

const spine = (extra = {}) => {
  const turns = Array.from({ length: 8 }, (_, i) => turn(i))
  return {
    sessionId: SESSION,
    harness: 'claude-code',
    cwd: '/w/demo',
    gitBranch: 'main',
    durationMs: 60000,
    models: { 'claude-opus-5': 8 },
    slashCommands: [],
    permissionModes: [],
    artifacts: { tools: { git: 4 }, mcp: {}, packages: {}, stack: {}, extensions: {}, skills: {}, fileTouches: 23 },
    totals: {
      humanTurns: turns.length, toolCalls: 0, tokens: { output: 100, cacheRead: 100 },
      frictionTurns: 0, repeats: 0, interruptions: 0, steeringTurns: 0, records: 10,
    },
    score: { value: 90, band: 'clean', confidence: 'high', turnsScored: turns.length, frictionRate: 0, craftRate: 0, wastedTokens: 0 },
    recordedPaths: true,
    turns,
    ...extra,
  }
}

const INTENTS = [
  { title: 'Draw the graph', status: 'done', summary: 'The derived skeleton landed and the layout packs.', turns: [0, 1] },
  { title: 'Wire the appendix', status: 'partial', summary: 'The table renders; the caveat is not written yet.', turns: [3] },
  { title: 'Teach the store to forget', status: 'abandoned', summary: 'Dropped after the second design failed to key.', turns: [4, 6] },
  { title: 'Follow the unfinished threads', status: 'ongoing', summary: 'Still open at the end of the session.', turns: [2, 9] },
  { title: 'Rename the thing', status: 'ongoing', summary: 'Never got a turn of its own.', turns: [] },
]

const STALE = 'Read sessionsAgo and daysAgo as age, not as confidence. Nothing has re-checked an older conclusion.'

const doc = (extra = {}) => ({
  sessionId: SESSION,
  tldr: 'A session about drawing conclusions.',
  intents: INTENTS,
  graph: {
    concepts: [{ id: 'layers', label: 'layer separation', group: 'guard', turns: [1], anchors: [`session:${SESSION}`] }],
    relations: [],
  },
  ...extra,
})

const WITH_PRIOR = doc({
  prior: [
    {
      sessionId: EARLIER,
      sessionsAgo: 3,
      daysAgo: 12,
      intents: [
        { title: 'Key the store on the repository', status: 'done', summary: 'Settled on the git root.', turns: [4] },
      ],
      graph: {
        concepts: [
          // Both of these ARE in this session's derived graph -- `cli:git` from the
          // artifacts plane and `turn:4` from the turn gates. That is the point:
          // an anchor that resolved to nothing would make the refusal below
          // untestable, because removing the refusal would still draw no edge.
          { id: 'adoption', label: 'store adoption', group: 'decision', turns: [2], anchors: ['cli:git', 'turn:4'] },
        ],
        relations: [],
      },
    },
  ],
  staleness: { note: STALE, sessionsHeld: 4, priorOmitted: 2, oldestRecordedAt: '2026-01-01T00:00:00.000Z' },
})

// ══════════════════════════════════════ 1. only the unfinished get a drill-down
section('1. a done thread has nothing to drill into', () => {
  const html = render(spine(), doc())

  const has = (title) => {
    const b = blockOf(html, title)
    return b === null ? null : b.includes('<div class="drill">')
  }
  chk('every named thread reached the page', INTENTS.every((i) => blockOf(html, i.title) !== null),
    INTENTS.filter((i) => blockOf(html, i.title) === null).map((i) => i.title).join(', ') || '')
  chk('a done thread carries no drill-down', has('Draw the graph') === false)
  chk('and neither does a partial one — "what is left" is a question the record does not separate',
    has('Wire the appendix') === false)
  chk('an abandoned thread carries one', has('Teach the store to forget') === true)
  chk('an ongoing thread carries one', has('Follow the unfinished threads') === true)
  chk('and so does an ongoing thread that cited no turn', has('Rename the thing') === true)

  const drills = (html.match(/<div class="drill">/g) || []).length
  chk('exactly three of the five threads have one', drills === 3, `${drills} drill-downs`)

  // The count is stated rather than left to be counted off the buttons.
  chk('the page says how many did not finish', html.includes('3 threads did not finish'))
  chk('and says a finished thread deliberately gets none',
    html.includes('a finished thread has nothing to drill into and gets none'))

  // Reachable with scripting off: the button needs the clipboard API, the
  // disclosure beside it needs nothing.
  const b = blockOf(html, 'Teach the store to forget')
  chk('the prompt is in the document, not built by script on click', b.includes('<pre id="fu2">'))
  chk('and there is a disclosure that shows it without any script at all', b.includes('<details class="fu">'))
  chk('the button reads the prompt by id rather than knowing what a prompt is',
    b.includes('data-copy="fu2"'))
})

// ══════════════════════════════════════ 2. the prompt names that thread's turns
section('2. the prompt is about ONE thread and says which', () => {
  const html = render(spine(), doc())
  const abandoned = preOf(html, 'fu2')
  const ongoing = preOf(html, 'fu3')
  const uncited = preOf(html, 'fu4')

  chk('the abandoned thread has a prompt', !!abandoned)
  chk('it names the thread', !!abandoned && abandoned.includes('Teach the store to forget'))
  chk('it names the status and what the analysis meant by it',
    !!abandoned && /Status: abandoned — the analysis marked this thread dropped before it finished\./.test(abandoned))
  chk('and it cites that thread\'s turns, in full',
    !!abandoned && abandoned.includes('Turns cited: 4, 6'), (abandoned || '').split('\n').find((l) => l.includes('Turns cited')))
  chk('and not another thread\'s',
    !!abandoned && !abandoned.includes('Turns cited: 0, 1') && !abandoned.includes('Turns cited: 2, 9'))
  chk('it repeats what the analysis concluded', !!abandoned && abandoned.includes('Dropped after the second design failed to key'))

  chk('the ongoing thread gets its own turns', !!ongoing && ongoing.includes('Turns cited: 2, 9'))
  chk('and its own status sentence',
    !!ongoing && ongoing.includes('the analysis marked this thread still open at the end of the session'))
  chk('a cited turn the spine does not hold is reported, not dropped',
    !!ongoing && ongoing.includes('is not in the spine at all'))
  chk('and the file line counts the turns the spine holds, not the citations',
    !!ongoing && flat(ongoing).includes('None. 1 cited turn is in the spine and not one of them made a tool call naming a file'))

  // A thread with no citation is the case where the prompt could most easily
  // imply something it does not know.
  chk('a thread with no turns cited says so rather than printing an empty list',
    !!uncited && uncited.includes('Turns cited: none.'))
  chk('and does not offer to read turns it cannot name',
    !!uncited && !/Read turns? /.test(uncited) && flat(uncited).includes('Find where this thread was worked on'))

  // The whole point of the prompt is that the record does not say what is left.
  chk('every prompt says what is NOT recorded',
    [abandoned, ongoing, uncited].every((p) => p && flat(p).includes('Nothing states what remains to be done')))
  chk('and asks for a refusal rather than a guess',
    [abandoned, ongoing, uncited].every((p) => p && flat(p).includes('say so instead of filling the gap')))

  // The files ride along, with the caveat attached to them rather than filed
  // somewhere else on the page.
  chk('the prompt carries the files the cited turns touched',
    !!abandoned && abandoned.includes('src/graph.mts') && abandoned.includes('src/bundle.mts'))
  chk('with the count of tool calls that named each',
    !!abandoned && /src\/bundle\.mts\s+7 tool calls/.test(abandoned))
  chk('and says what that list is worth, in the prompt itself',
    !!abandoned && flat(abandoned).includes('evidence the thread touched the file, not proof it changed it'))
  chk('and names the file another thread also claims',
    !!abandoned && /src\/graph\.mts[^\n]*also under: Draw the graph/.test(abandoned),
    (abandoned || '').split('\n').find((l) => l.includes('src/graph.mts')))
})

// ══════════════════════════════════════ 2b. the citation, wherever it was put
//
// `intents[i].turns` is a MIRROR the intent store keeps only because this
// renderer reads it there; `provenance.turns` is the canonical copy, the one
// that survives being flattened into another list. Reading only the mirror
// means a thread silently stops naming its own turns the day the mirror goes
// -- and a citation that goes quiet is not a visible failure, it is a
// drill-down that asks about nothing and an appendix that attributes nothing.
section('2b. a thread cites the same turns however the document carried them', () => {
  const mirrored = INTENTS.map((i) => ({ ...i }))
  const canonical = INTENTS.map(({ turns, ...rest }) => ({ ...rest, provenance: { turns } }))

  const a = render(spine(), doc({ intents: mirrored }))
  const b = render(spine(), doc({ intents: canonical }))

  chk('the prompt cites the same turns from either shape',
    preOf(a, 'fu2') === preOf(b, 'fu2'), `mirror: ${(preOf(a, 'fu2') || '').split('\n')[4]} / canonical: ${(preOf(b, 'fu2') || '').split('\n')[4]}`)
  chk('and it really is the turns, not two empty prompts agreeing',
    (preOf(b, 'fu2') || '').includes('Turns cited: 4, 6'))
  chk('the appendix attributes the same files from either shape',
    appendixOf(a) === appendixOf(b))
  chk('and the graph dates the thread from either shape',
    payloadOf(a).nodes.find((n) => n.id === 'intent:teach-the-store-to-forget')?.at ===
      payloadOf(b).nodes.find((n) => n.id === 'intent:teach-the-store-to-forget')?.at,
    String(payloadOf(b).nodes.find((n) => n.id === 'intent:teach-the-store-to-forget')?.at))
})

// ══════════════════════════════════════ 3. the same text, from a terminal
//
// The page's button and `--followup` are two consumers of one builder. Nothing
// but this comparison keeps them saying the same thing about one thread.
section('3. the command line prints the same thread, byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-viz-followup-'))
  try {
    const sp = join(dir, 'spine.json')
    const ip = join(dir, 'intent.json')
    writeFileSync(sp, JSON.stringify(spine()))
    writeFileSync(ip, JSON.stringify(doc()))
    const cli = (args) => execFileSync('node', [RENDER, sp, '--intent', ip, ...args], { encoding: 'utf8' })

    const html = render(spine(), doc())
    const page = preOf(html, 'fu2')
    const term = cli(['--followup', 'teach-the-store-to-forget'])
    chk('the terminal produced the same thread', term.includes('Teach the store to forget'))
    chk('and the page and the terminal are the same bytes', term.trimEnd() === (page || '').trimEnd(),
      `page ${page ? page.length : 0} bytes, terminal ${term.trimEnd().length} bytes`)

    chk('the index works as well as the slug', cli(['--followup', '2']).trimEnd() === term.trimEnd())
    chk('and so does an unambiguous prefix', cli(['--followup', 'teach-the-store']).trimEnd() === term.trimEnd())

    const listed = cli(['--followups'])
    chk('the listing counts the unfinished against the whole', listed.includes('3 of 5 thread(s)'))
    chk('and names the abandoned one', listed.includes('teach-the-store-to-forget'))
    chk('and does not offer the done one', !listed.includes('draw-the-graph'))
    chk('and says why a done thread is missing', listed.includes('has nothing to drill into and is not listed'))

    // A status outside the four this tool knows is not "finished"; it is
    // unclassified. The empty listing used to call it done or partial.
    const allDone = { ...doc(), intents: [{ title: 'Something', status: 'in progress', summary: 's', turns: [0] }] }
    writeFileSync(ip, JSON.stringify(allDone))
    const none = cli(['--followups'])
    chk('with no eligible thread it says what it checked for, not that everything finished',
      none.includes('no thread the analysis named is marked abandoned or ongoing'),
      none.trim().split('\n').pop())
    writeFileSync(ip, JSON.stringify(doc()))

    // The refusal is the same rule as the page's, said out loud.
    let refused = null
    try {
      cli(['--followup', 'draw-the-graph'])
    } catch (err) {
      refused = { status: err.status, err: String(err.stderr || '') }
    }
    chk('a done thread is refused at the command line too', !!refused && refused.status !== 0,
      refused ? `exit ${refused.status}` : 'it printed a prompt for a finished thread')
    chk('and the refusal says what the rule is', !!refused && refused.err.includes('so it has no drill-down'))

    const refusal = (args) => {
      try {
        cli(args)
        return null
      } catch (err) {
        return { status: err.status, err: String(err.stderr || '') }
      }
    }

    const missing = refusal(['--followup', 'no-such-thread'])
    chk('an unknown thread is refused by name, with the list',
      !!missing && missing.err.includes('no thread called "no-such-thread"'))

    // `--followup` as the last argument reads back as no value at all, which is
    // indistinguishable from the flag being absent -- and a page rendered in
    // answer to a question about one thread is the worst of both.
    const bare = refusal(['--followup'])
    chk('a bare --followup asks which thread rather than rendering a page',
      !!bare && bare.status !== 0 && bare.err.includes('--followup needs a thread'),
      bare ? bare.err.split('\n')[0] : 'it rendered a page')
    const swallowed = refusal(['--followup', '--open'])
    chk('and it will not swallow the next flag as a thread name',
      !!swallowed && swallowed.status !== 0 && swallowed.err.includes('takes a thread, not the flag'),
      swallowed ? swallowed.err.split('\n')[0] : 'it treated --open as a thread')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ══════════════════════════════════════ 4. the appendix, and what it will not claim
section('4. the appendix attributes files to tasks and says how strongly', () => {
  const html = render(spine(), doc())
  const apx = appendixOf(html)
  chk('the appendix renders', apx.includes('<h2>Appendix'), 'no appendix section on the page')

  chk('a task carries the files its cited turns touched',
    /Teach the store to forget[\s\S]*?src\/bundle\.mts/.test(apx))
  chk('with the tool-call count beside the path', /<td class="num">7<\/td>/.test(apx))

  // The strength of the attribution, stated where the tables are.
  chk('it says a row is evidence', apx.includes('<em>evidence</em> the task touched the file'))
  chk('and says it is not proof', apx.includes('It is not proof it changed it'))
  chk('and says why: a read counts the same as a rewrite',
    apx.includes('a call that only read the file counts the same as one that rewrote it'))
  chk('and says what it cannot see at all',
    apx.includes('A file named only inside a shell command is not here at all'))

  // The sharpest case: one file, two tasks.
  chk('a file two tasks touched is marked on BOTH rows',
    (apx.match(/class="apx-shared"/g) || []).length === 2,
    `${(apx.match(/class="apx-shared"/g) || []).length} shared rows`)
  chk('and each row names the other task', apx.includes('>Draw the graph</td>') && apx.includes('>Teach the store to forget</td>'))
  chk('and the lead says such a file belongs to neither exclusively',
    apx.includes('belong to none of them exclusively'))

  // The two ways a task can have no files, told apart from each other.
  chk('a task that cited no turn says the analysis cited none',
    apx.includes('The analysis attributed no turn to this task, so no file can be tied to it'))
  chk('and calls that a gap in the analysis, not a finding',
    apx.includes('That is a gap in the analysis, not a finding that the task touched nothing'))
  chk('a task whose cited turns named no file says THAT instead',
    apx.includes('and none of them made a tool call naming a file'))
  // The claim is counted against the turns the SPINE HOLDS. This task cited two
  // and one of them is not in the reading at all; saying "neither named a file"
  // would be a claim about a turn nothing here has read.
  chk('and counts only the cited turns the spine actually holds',
    apx.includes('1 cited turn is in the spine, and none of them made a tool call'),
    apx.match(/[^>]*cited turn[^<]*/)?.[0])
  chk('and names the reason a real session looks like that',
    apx.includes('nothing reads paths out of command text'))

  // A file no task claims is reported rather than absorbed into one.
  chk('files no task claims are counted', apx.includes('1 file touched in this session is claimed by no task above'))
  chk('and are not silently attributed to anyone', !/docs\/readme\.md/.test(apx))
  chk('and the page does not call them unimportant', apx.includes('nothing here says they were unimportant'))
})

// ══════════════════════════════════════ 4b. a very long list is cut, not lost
//
// A thread citing forty turns of a busy session names hundreds of paths. Both
// the prompt and the table cut the list; what must never happen is that the
// remainder disappears, because then the visible rows read as the whole of what
// the task touched.
section('4b. a list too long to print is truncated with its remainder counted', () => {
  const many = Array.from({ length: 130 }, (_, k) => ({ path: `src/mod${k}.mts`, count: 2 }))
  const turns = Array.from({ length: 8 }, (_, i) => (i === 4 ? { ...turn(4), files: many } : turn(i)))
  const html = render(spine({ turns }), doc())
  const apx = appendixOf(html)
  const rows = (apx.match(/<tr class="apx-shared"|<tr><td><code>/g) || []).length

  chk('the table stops well short of every file', rows <= 45, `${rows} rows`)
  chk('and the rows it did not draw are counted', apx.includes('and 91 more files, not listed'))
  chk('with the tool calls those files account for', apx.includes('<td class="num dim">182</td>'))
  chk('and it says where the cut is, rather than letting 40 look like all of them',
    apx.includes('the list is cut at 40'))

  // Counted rather than named: the list sorts by tool calls and then by path,
  // so which particular file falls off the end is arithmetic and not a fact
  // worth pinning. That 40 of 131 are drawn and 91 are counted is the fact.
  const prompt = preOf(html, 'fu2')
  const listed = (prompt || '').split('\n').filter((l) => /^ {2}\S+\.(mts|mjs|md)\s+\d+ tool/.test(l)).length
  chk('the prompt cuts the same list at the same place', listed === 40, `${listed} file lines`)
  chk('and counts what it left out, in files and in tool calls',
    !!prompt && /\.\.\.and 91 more files, not listed here, between them named by 182 tool calls\./.test(prompt),
    (prompt || '').split('\n').find((l) => l.includes('more file')))
})

// ══════════════════════════════════════ 5. with no paths, it says so
//
// Two readings produce exactly no rows and mean different things, and neither
// of them means "nothing was changed". An empty table under this heading would
// say precisely that.
section('5. an appendix with no paths says so rather than rendering empty', () => {
  for (const [name, extra] of [
    ['--no-paths', { recordedPaths: false, turns: Array.from({ length: 8 }, (_, i) => ({ ...turn(i), files: undefined })) }],
    ['a spine older than the field', { recordedPaths: undefined, turns: Array.from({ length: 8 }, (_, i) => ({ ...turn(i), files: undefined })) }],
  ]) {
    const apx = appendixOf(render(spine(extra), doc()))
    chk(`${name}: the appendix still renders`, apx.includes('<h2>Appendix'))
    chk(`${name}: and states plainly that nothing can be attributed`,
      apx.includes('<strong>No file can be attributed to any task in this reading.</strong>'))
    chk(`${name}: and refuses to be read as a finding about the work`,
      apx.includes('Read this as a fact about the reading, never as a finding that nothing was changed'))
    chk(`${name}: it draws no table at all, rather than an empty one`,
      !apx.includes('<table class="apx">'))
    chk(`${name}: the tasks are still listed, so the missing half is visible`,
      apx.includes('Teach the store to forget') && apx.includes('Draw the graph'))
    chk(`${name}: with the turns each one cited`, apx.includes('turns 4, 6'))
    chk(`${name}: and a task that cited none says so`, apx.includes('no turns cited'))
  }

  // The sentence itself comes from the evidence package rather than being
  // written twice, so the appendix and the package cannot drift apart.
  const refused = appendixOf(render(spine({ recordedPaths: false, turns: Array.from({ length: 8 }, (_, i) => ({ ...turn(i), files: undefined })) }), doc()))
  chk('--no-paths quotes the package\'s own sentence about the refusal',
    refused.includes('FILE PATHS WERE NOT RECORDED'))
  const unknown = appendixOf(render(spine({ recordedPaths: undefined, turns: Array.from({ length: 8 }, (_, i) => ({ ...turn(i), files: undefined })) }), doc()))
  chk('and an older spine quotes the one about not knowing',
    /WHETHER FILE PATHS WERE RECORDED IS UNKNOWN/.test(unknown), unknown.slice(0, 0) || 'the unknown sentence is not on the page')
  chk('and the two readings do not print the same sentence', refused !== unknown)

  // A spine carrying paths with no flag beside them is the fourth state: it is
  // attributed, and the missing flag is said out loud.
  const nof = appendixOf(render(spine({ recordedPaths: undefined }), doc()))
  chk('a spine that carries paths without the flag still attributes them',
    nof.includes('<table class="apx">'))
  chk('and says the flag is missing rather than promising the paths are complete',
    nof.includes('predates the flag that records whether paths were kept'))
})

// ══════════════════════════════════════ 6. this session's work vs the store's
section('6. a conclusion from an earlier session cannot look like this one', () => {
  const html = render(spine(), WITH_PRIOR)
  const g = payloadOf(html)
  chk('the payload parses out of the real page', !!g)
  const by = new Map((g?.nodes || []).map((n) => [n.id, n]))

  const mine = by.get('intent:teach-the-store-to-forget')
  const theirs = [...by.values()].find((n) => n.label === 'Key the store on the repository')
  chk('this session\'s thread is a node', !!mine)
  chk('the earlier session\'s thread is drawn too — it is not dropped', !!theirs)

  chk('this session\'s carries no carried stamp', !!mine && mine.carried === null)
  chk('the earlier one names the session it was drawn in',
    !!theirs && !!theirs.carried && theirs.carried.s === EARLIER, theirs && JSON.stringify(theirs.carried))
  chk('and how far back that is', !!theirs?.carried && theirs.carried.ago === 3 && theirs.carried.days === 12,
    JSON.stringify(theirs?.carried ?? null))

  // The replay is this session's timeline. An earlier session's turn 4 is a
  // different turn 4, so a carried node is dated to no turn of this one.
  chk('this session\'s thread enters the replay at the first turn it cited', !!mine && mine.at === 4, mine && String(mine.at))
  chk('a carried conclusion is dated to no turn of this session', !!theirs && theirs.at === -1, theirs && String(theirs.at))
  chk('and its citation is prose naming its own session, never this session\'s turn list',
    !!theirs && theirs.turns === null && String(theirs.note).includes('Cited turn 4 of session aaaa1111, not of this one'),
    JSON.stringify(theirs?.turns ?? null))

  // In the picture, and not only in the panel.
  const gtag = html.match(/<g class="gn authored [^"]*carried[^"]*"[^>]*>[\s\S]{0,400}?<\/g>/)
  chk('a carried node is marked in the markup as well as the payload', !!gtag)
  chk('and is drawn with a ring the others do not have', !!gtag && gtag[0].includes('<polygon class="gring"'))
  chk('while keeping the diamond that says which layer it is on', !!gtag && gtag[0].includes('<polygon class="gs"'))
  chk('and a screen reader is told it is not this session\'s',
    /aria-label="[^"]*carried from a session 3 back, not this one"/.test(html))
  const rings = (html.match(/<polygon class="gring"/g) || []).length
  const carriedNodes = [...by.values()].filter((n) => n.carried).length
  chk('every carried node gets a ring and nothing else does', rings === carriedNodes && rings === 3,
    `${rings} rings, ${carriedNodes} carried nodes`)

  // Said in words too, because a ring is only legible to someone who was told
  // what a ring means.
  chk('the legend counts them separately from this session\'s', html.includes('<b>Carried from an earlier session</b>'))
  chk('and the legend no longer calls the whole layer this session\'s work',
    html.includes("<b>Written by the model, this session</b>"))
  chk('the graph footer explains the ring and the hub',
    html.includes("They keep the model layer's diamond and gain a ring around it"))
  chk('and says they are not on the replay timeline',
    html.includes("an earlier session's turn 4 is a different turn 4"))

  // The store's own sentence, quoted rather than paraphrased.
  //
  // Scoped to the graph's own footer, because the note also travels inside the
  // payload for the panel to print: a whole-document `includes` passes on a
  // page that shows the reader a paraphrase and hides the real sentence in a
  // script element.
  const foot = html.slice(html.indexOf('<div class="gfoot">'), html.indexOf('window.__qkg'))
  chk('the store\'s staleness note is printed verbatim, in the markup', foot.includes(STALE),
    foot.slice(foot.indexOf('gcarry dim'), foot.indexOf('gcarry dim') + 160))
  chk('and the payload carries it for the panel too', g.stale === STALE)
  chk('history the store held back is reported', html.includes('holds 2 earlier sessions that this page does not carry'))

  // An anchor from an earlier session names ids measured out of THIS
  // transcript. Same name, different evidence.
  chk('a carried concept is not anchored to this session\'s measured nodes',
    !(g.edges || []).some((e) => e.s.startsWith('prior:') && !e.t.startsWith('prior:')),
    (g.edges || []).filter((e) => e.s.startsWith('prior:') && !e.t.startsWith('prior:')).map((e) => `${e.s}->${e.t}`).join(', '))
  chk('and the refusal is counted on the page rather than done quietly',
    /<b>2<\/b> anchors on carried conclusions not drawn/.test(html),
    (html.match(/<li><b>\d+<\/b> anchors[^<]*/) || [])[0])

  // Absence is reported the same way presence is.
  const plain = render(spine(), doc())
  chk('a page with no carried material says nothing about rings',
    !plain.includes('Carried from an earlier session'))
})

// ══════════════════════════════════════ 7. the intents are a structure
section('7. what the model concluded reads as a structure', () => {
  const html = render(spine(), WITH_PRIOR)
  const g = payloadOf(html)
  const by = new Map(g.nodes.map((n) => [n.id, n]))
  const edge = (s, t) => g.edges.some((e) => (e.s === s && e.t === t) || (e.s === t && e.t === s))

  chk('each thread is a node of its own', INTENTS.every((i) => [...by.values()].some((n) => n.kind === 'intent' && n.label === i.title)),
    INTENTS.filter((i) => ![...by.values()].some((n) => n.kind === 'intent' && n.label === i.title)).map((i) => i.title).join(', '))
  chk('the threads of one status share a hub', !!by.get('status:ongoing') && by.get('status:ongoing').kind === 'status')
  chk('and the hub says how many it holds', by.get('status:ongoing')?.label === 'ongoing · 2', by.get('status:ongoing')?.label)
  chk('a thread hangs off its status', edge('intent:follow-the-unfinished-threads', 'status:ongoing'))
  chk('and off the measured turns its author cited', edge('intent:teach-the-store-to-forget', 'turn:4'))
  chk('and off no turn it did not cite', !edge('intent:teach-the-store-to-forget', 'turn:0'))
  chk('the legend counts the threads and how many did not finish', html.includes('5 threads, 3 unfinished'))

  // A citation the turn gates did not draw has nowhere to land, and the count
  // of those is on the page rather than being the difference between two
  // numbers nobody prints.
  chk('a citation with no node to land on is reported', html.includes('intent turn citations'))

  // Carried conclusions get their own hub, so "three still ongoing" is never a
  // number covering two different weeks of work.
  const prior = [...by.values()].find((n) => n.kind === 'prior') ?? null
  chk('an earlier session is a hub of its own', !!prior && prior.label === '3 sessions ago', prior?.label)
  const carriedThread = [...by.values()].find((n) => n.carried && n.kind === 'intent') ?? null
  chk('and its conclusions hang off it, not off this session\'s status hubs',
    !!carriedThread && !!prior && edge(prior.id, carriedThread.id) && !edge(carriedThread.id, 'status:done'),
    carriedThread ? carriedThread.id : 'no carried thread node')
  chk('so a status hub counts only this session\'s threads', by.get('status:done')?.label === 'done · 1',
    by.get('status:done')?.label)

  chk('a status is labelled as something written down, not measured',
    html.includes('what the analysis wrote down, not an outcome anything measured'))
})

// ══════════════════════════════════════ 8. one toggle still subtracts the layer
section('8. the whole authored layer is still hideable in one toggle', () => {
  const html = render(spine(), WITH_PRIOR)
  const g = payloadOf(html)

  const toggles = (html.match(/id="gtog"/g) || []).length
  chk('there is exactly one toggle', toggles === 1, `${toggles} of them`)

  // The separation is a property of the ids and the layer field, not of the
  // styling. Everything the model wrote — this session's and the store's —
  // has to be on one side of one predicate or the toggle cannot subtract it.
  const authored = g.nodes.filter((n) => n.layer === 'authored')
  const kinds = new Set(authored.map((n) => n.kind))
  chk('every intent, hub, prior hub and concept is on the authored layer',
    ['intent', 'status', 'prior', 'guard', 'decision'].every((k) => kinds.has(k)), [...kinds].join(', '))
  chk('and nothing the model wrote is marked derived',
    !g.nodes.some((n) => n.layer === 'derived' && (n.carried || n.kind === 'intent' || n.kind === 'status' || n.kind === 'prior')))
  chk('every carried node is on the authored layer, so one predicate reaches it',
    g.nodes.filter((n) => n.carried).every((n) => n.layer === 'authored'))
  chk('and every authored id is namespaced away from the derived ones',
    authored.every((n) => /^(concept|intent|status|prior):/.test(n.id)),
    authored.filter((n) => !/^(concept|intent|status|prior):/.test(n.id)).map((n) => n.id).join(', '))

  // The markup the toggle acts on, and the one predicate it acts through.
  const drawn = (html.match(/<g class="gn authored /g) || []).length
  chk('the SVG marks the same nodes authored as the payload does', drawn === authored.length,
    `${drawn} drawn, ${authored.length} in the payload`)
  // One DEFINITION rather than one occurrence. Three readers now ask whether the
  // toggle has hidden something -- nodes, edges, and the status-hub recount --
  // and the property worth holding is that they all ask the same function, not
  // that only one of them asks.
  chk('the toggle decides by layer in exactly one place',
    (html.match(/function offLayer\(x\)\{ return hidden&&x\.layer==='authored'; \}/g) || []).length === 1)
  chk('and nothing spells that comparison out for itself',
    (html.match(/hidden&&[ne]\.layer==='authored'/g) || []).length === 0)
  chk('edges are decided by it too, or a line would outlive both its ends',
    /var gone=offLayer\(e\);/.test(html))
  chk('the button says it hides everything the model wrote, not only this session\'s',
    html.includes('Hide everything the model wrote'))
})

// ═══════════════════════ 9. two documents, two sessions, one prompt
//
// The page raises a banner when the intent document and the spine name different
// sessions, and the CLI warns on stderr — but the `--followup` branch exits
// before that warning is ever reached, so the ONE surface built to be copied
// into another model's context was the only one that never checked. What came
// out was an earlier session's conclusion printed under this session's id, with
// this session's turn numbers and this session's files under it, and the word
// `aaaa1111` nowhere on the page.
section('9. a prompt built from two different sessions says so, in its own text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-viz-followup-x-'))
  try {
    const sp = join(dir, 'spine.json')
    const ip = join(dir, 'intent.json')
    writeFileSync(sp, JSON.stringify(spine()))
    // Same threads, declared as another session's work.
    writeFileSync(ip, JSON.stringify({ ...doc(), sessionId: EARLIER }))

    const out = execFileSync('node', [RENDER, sp, '--intent', ip, '--followup', 'teach-the-store-to-forget'], {
      encoding: 'utf8',
    })

    chk('the prompt leads with the disagreement rather than the thread',
      /^READ THIS FIRST: the two documents .* describe DIFFERENT SESSIONS/m.test(out), out.split('\n')[0])
    // The whole defect in one assertion: the session the conclusion actually
    // came from was not written anywhere in the text.
    chk('and names the session the conclusion was drawn in', out.includes(EARLIER.slice(0, 8)), out.slice(0, 400))
    chk('and names the session the spine holds', out.includes(SESSION.slice(0, 8)))
    chk('and never claims the thread came FROM the spine\'s session',
      !new RegExp(`unfinished thread from session ${SESSION.slice(0, 8)}`).test(out))
    // Attribution runs the intent's turn numbers against the spine's turn list.
    // Across two sessions that indexes one session's conclusions into another
    // session's transcript, so the file list is about something else entirely.
    chk('the file list is withheld rather than printed under the wrong session',
      /no file is listed/.test(out) && !/tool calls?$/m.test(out), out)
    chk('and the citation line says whose turns those numbers are',
      /of session aaaa1111, not of the spine/.test(out), (out.match(/Turns cited.*/) || [])[0])
    chk('and the closing instruction points at the right session',
      /Find where this thread was worked on in session aaaa1111/.test(out),
      (out.match(/Find where.*/) || [])[0])

    // The listing is the other exit that skipped the check.
    const listed = execFileSync('node', [RENDER, sp, '--intent', ip, '--followups'], { encoding: 'utf8' })
    chk('--followups says it too, rather than listing them silently',
      /written about session aaaa1111, not about the spine given here/.test(listed), listed)

    // And the guard must stay off the ordinary case: one document, one session,
    // no banner in a prompt that has nothing to warn about.
    writeFileSync(ip, JSON.stringify(doc()))
    const clean = execFileSync('node', [RENDER, sp, '--intent', ip, '--followup', 'teach-the-store-to-forget'], {
      encoding: 'utf8',
    })
    chk('a matching pair carries no warning at all', !/DIFFERENT SESSIONS/.test(clean))
    chk('and still lists the files it can attribute', /tool calls?/.test(clean), clean.slice(0, 200))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ═══════════════════════ 10. numbers on the canvas that the canvas has to earn
//
// Three things here were true of the SOURCE and false of the PAGE, which is the
// only artefact anybody looks at.
section('10. a count on the canvas agrees with the frame it sits in', () => {
  const ONGOING = [
    { title: 'Alpha thread', status: 'ongoing', summary: 'a', turns: [0] },
    { title: 'Beta thread', status: 'ongoing', summary: 'b', turns: [4] },
    { title: 'Gamma thread', status: 'ongoing', summary: 'c', turns: [6] },
  ]
  const html = render(spine(), doc({ intents: ONGOING }))
  const g = payloadOf(html)

  // The label is drawn once from the whole document; the replay only toggles
  // visibility. What makes it honest is that paint() re-derives the number, and
  // what makes THAT possible is the payload carrying the three fields it counts
  // on. Asserted here because a renderer change that dropped `status` from the
  // payload would silently freeze the count again.
  const hub = g.nodes.find((n) => n.kind === 'status')
  chk('the hub is in the payload with the status it aggregates', hub?.status === 'ongoing', JSON.stringify(hub))
  chk('and every thread carries the status and the turn the recount reads',
    g.nodes.filter((n) => n.kind === 'intent' && !n.carried).every((n) => n.status && typeof n.at === 'number'))
  chk('the label is drawn with the whole-document count', hub?.label === 'ongoing · 3', hub?.label)
  chk('and the three threads are born at three different turns',
    JSON.stringify(g.nodes.filter((n) => n.kind === 'intent' && !n.carried).map((n) => n.at).sort()) === '[0,4,6]')

  // ---- the escape-eating class of bug, caught on the SHIPPED bytes
  //
  // The whole client script is a template literal, so a backslash-s or
  // backslash-d in a regex is an unrecognised escape and collapses to a bare
  // letter on its way into the page. The rewrite was present in the source,
  // present in the page, and matched nothing — the label sat at 3 in a frame
  // holding one thread while every check that read the source agreed it was
  // fixed. So this reads the page, and then RUNS what it found.
  const shipped = (html.match(/function recount\(el,c\)\{[^\n]*\}/) || [])[0] || ''
  chk('the recount function reached the page at all', !!shipped, shipped.slice(0, 60))
  chk('and its regex still has the escapes the template literal eats',
    shipped.includes('\\s*') && shipped.includes('\\d+'), shipped)
  if (shipped) {
    // Executed, not read. A regex that lost its backslashes is still a valid
    // regex, so only running it can tell the difference.
    const fn = new Function(`${shipped}; return recount;`)()
    const el = { textContent: 'ongoing \u00b7 3' }
    fn(el, 1)
    chk('and running it on the shipped text actually rewrites the count',
      el.textContent === 'ongoing \u00b7 1', el.textContent)
    const elided = { textContent: 'abandoned \u00b7 12' }
    fn(elided, 7)
    chk('and rewrites only the digits, leaving the status word alone',
      elided.textContent === 'abandoned \u00b7 7', elided.textContent)
    const plain = { textContent: 'src/graph.mts' }
    fn(plain, 9)
    chk('and leaves a label that carries no count untouched', plain.textContent === 'src/graph.mts', plain.textContent)
  }
})

// ═══════════════════════ 11. an age nothing recorded is not the number one
section('11. a carried conclusion with no stated age is not dated to one session back', () => {
  const NO_AGE = doc({
    prior: [{
      sessionId: EARLIER,
      // No sessionsAgo and no daysAgo. Reachable from a hand-written or older
      // intent document, and `--intent` accepts any JSON.
      intents: [{ title: 'Key the store on the repository', status: 'done', summary: 's', turns: [4] }],
      graph: { concepts: [], relations: [] },
    }],
    staleness: { note: STALE, sessionsHeld: 2, priorOmitted: 0 },
  })
  const html = render(spine(), NO_AGE)
  const g = payloadOf(html)
  const carried = g.nodes.filter((n) => n.carried)

  chk('there is something carried to be wrong about', carried.length > 0, `${carried.length}`)
  // The defect in one line: the hub label honoured the null and every node
  // hanging off it was stamped with a fabricated 1, so the page contradicted
  // itself about the one number a reader is told to trust here.
  chk('the payload carries the age as unstated rather than as one',
    carried.every((n) => n.carried.ago === null), JSON.stringify(carried.map((n) => n.carried.ago)))
  chk('no node claims to be one session back', !/a session 1 back/.test(html))
  chk('and the accessible name says only that it is earlier',
    /carried from an earlier session, not this one/.test(html))
  chk('while the hub it hangs off says the same thing',
    g.nodes.some((n) => n.kind === 'prior' && n.label === 'an earlier session'),
    g.nodes.filter((n) => n.kind === 'prior').map((n) => n.label).join(' | '))
  // And a document that DID say how far back keeps saying it.
  const stated = payloadOf(render(spine(), WITH_PRIOR))
  chk('a stated age is still carried through', stated.nodes.filter((n) => n.carried).every((n) => n.carried.ago === 3))
})

// ═══════════════════════ 12. what the prior-node budget drops, it says it dropped
section('12. a truncated history is not presented as a whole one', () => {
  // Well inside the store's own per-session cap, and past the graph's.
  const many = Array.from({ length: 30 }, (_, i) => ({
    title: `Carried thread ${i}`, status: 'done', summary: 's', turns: [1],
  }))
  const html = render(spine(), doc({
    prior: [{ sessionId: EARLIER, sessionsAgo: 3, daysAgo: 12, intents: many, graph: { concepts: [], relations: [] } }],
    staleness: { note: STALE, sessionsHeld: 2, priorOmitted: 0 },
  }))
  const g = payloadOf(html)
  const drawn = g.nodes.filter((n) => n.carried && n.kind === 'intent').length

  chk('the budget really did cut the session short', drawn < many.length, `${drawn} of ${many.length}`)
  // Every OTHER cap in the graph pushes a suppression; this one broke out of two
  // loops and pushed nothing, so the conclusions it dropped were on no canvas
  // and in no count — while the footer stated a bare total of what survived.
  chk('and the page says how many it did not draw',
    new RegExp(`<b>${many.length - drawn}</b> carried conclusions not drawn`).test(html),
    (html.match(/<li><b>\d+<\/b> carried conclusions not drawn[^<]*/g) || []).join(' | '))
  chk('and says why, naming the depth rather than an unexplained cap',
    /each earlier session is drawn at most \d+ conclusions deep/.test(html),
    (html.match(/each earlier session[^<.]*/) || [])[0])
  // The guard must not fire on a session that fits.
  chk('a session inside the budget reports nothing dropped for it',
    !/carried conclusions not drawn — each earlier session/.test(render(spine(), WITH_PRIOR)))
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
