// The dependency layer, asserted on the rendered page.
//
// The thing this feature must not become is the bill of materials drawn as a
// graph. A real bill is hundreds to thousands of packages against a canvas that
// holds about a hundred nodes, and drawing it answers a question nobody asked of
// a SESSION report. So the assertions below are mostly about what is NOT drawn,
// and about the page saying so rather than quietly showing less.
//
// The bill here is synthetic. readSbom walks a real directory and its answer
// changes when somebody runs npm install, which is not a thing a test should be
// waiting on -- and every shape this exercises (a name at two versions, a name
// that is a node builtin, a manifest nobody touched) is easier to construct than
// to find.
import { render } from '../scripts/render.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (t) => console.log(`\n── ${t}`)

const payloadOf = (html) => {
  const m = html.match(/window\.__qkg=([\s\S]*?);<\/script>/)
  return m ? JSON.parse(m[1]) : null
}
const sup = (html) => [...html.matchAll(/<li><b>(\d+)<\/b> ([^<]*?) not drawn &mdash; ([^<]*)\./g)]
  .map((m) => ({ n: Number(m[1]), what: m[2], why: m[3] }))

const BUSY = { 0: 30, 4: 50, 6: 40 }
const FILES = { 0: [{ path: 'package.json', count: 3 }], 4: [{ path: 'src/a.ts', count: 1 }] }
const turn = (i) => ({
  index: i, text: `turn ${i}`, durationMs: 1000, friction: [], signals: {},
  toolCalls: [], toolCallCount: BUSY[i] ?? 0, tokens: { output: 10 },
  derived: { repeatOf: null }, score: { value: 90, deductions: [], additions: [] },
  files: FILES[i] ?? [],
})
const IMPORTS = { chalk: 3, 'left-pad': 1, 'node:fs': 4, nowhere: 1 }
const spine = () => ({
  sessionId: 'bbbbcccc-0000-0000-0000-000000000000', harness: 'claude-code', cwd: '/w/demo',
  gitBranch: 'main', durationMs: 480000, models: { 'claude-opus-5': 8 },
  slashCommands: [], permissionModes: [],
  artifacts: { tools: { git: 4 }, mcp: {}, packages: { ...IMPORTS }, stack: {}, extensions: {}, skills: {}, fileTouches: 9 },
  totals: { humanTurns: 8, toolCalls: 8, tokens: { output: 100, cacheRead: 100 }, frictionTurns: 0, repeats: 0, interruptions: 0, steeringTurns: 0, records: 10 },
  score: { value: 90, band: 'clean', confidence: 'high', turnsScored: 8, frictionRate: 0, craftRate: 0, wastedTokens: 0 },
  recordedPaths: true, turns: Array.from({ length: 8 }, (_, i) => turn(i)),
})
const doc = () => ({
  sessionId: 'bbbbcccc-0000-0000-0000-000000000000', tldr: 'A session with a bill.',
  intents: [{ title: 'Wire the bill', status: 'ongoing', summary: 's', turns: [0] }],
  graph: { concepts: [], relations: [] },
})

const entry = (id, name, version, over = {}) => ({
  id, name, version, versionKind: 'locked', relation: 'direct', scope: 'runtime',
  license: 'MIT', versionSource: 'package-lock.json', ...over,
})
// `chalk` twice, at two versions, which is the case where picking one would be a
// guess. `unreached` is in the bill and nothing points at it.
const BOM = () => ({
  status: 'ok', reason: null, transitiveClosure: 'from-lockfiles',
  manifests: [
    { id: 'm:root', path: 'package.json', name: 'demo', declaredCount: 2 },
    { id: 'm:sub', path: 'packages/api/package.json', name: 'api', declaredCount: 1 },
  ],
  entries: [
    entry('e:chalk-5', 'chalk', '5.6.2'),
    entry('e:chalk-4', 'chalk', '4.1.2'),
    entry('e:leftpad', 'left-pad', '1.3.0'),
    entry('e:unreached', 'unreached', '9.0.0', { relation: 'transitive' }),
  ],
  edges: [
    { from: 'm:root', to: 'e:chalk-5', kind: 'declares' },
    { from: 'm:root', to: 'e:leftpad', kind: 'declares' },
    { from: 'm:sub', to: 'e:unreached', kind: 'declares' },
  ],
})
const MATCHED = () => ({
  matches: [
    { root: 'chalk', packageName: 'chalk', entryIds: ['e:chalk-5', 'e:chalk-4'], status: 'matched', reason: null },
    { root: 'left-pad', packageName: 'left-pad', entryIds: ['e:leftpad'], status: 'matched', reason: null },
    { root: 'node:fs', packageName: null, entryIds: [], status: 'unmatched', reason: 'node-builtin' },
    { root: 'nowhere', packageName: 'nowhere', entryIds: [], status: 'unmatched', reason: 'not-in-bom' },
  ],
})
const withBom = (over = {}) => render(spine(), doc(), { fingerprint: 'aaaa1111', bom: { sbom: BOM(), matched: MATCHED(), ...over } })

// ══════════════════════════════════ 1. absent, empty and present are three states
section('1. no bill, no bill to read, and a bill are three different pages')
{
  const none = render(spine(), doc(), { fingerprint: 'aaaa1111' })
  chk('with no bill the page draws no dependency node',
    payloadOf(none).nodes.every((n) => n.layer !== 'dependency'))
  chk('and offers no toggle for one', !/id="gdep"/.test(none))
  // Absence of a layer and absence of a BILL are not the same fact, and a reader
  // has to be able to tell which page they are on.
  chk('and says nothing about a bill it never had',
    !sup(none).some((s) => /bill/.test(s.what)))

  const empty = render(spine(), doc(), {
    fingerprint: 'aaaa1111',
    bom: { sbom: { ...BOM(), status: 'no-manifest', reason: 'no package.json under the scan root', entries: [], manifests: [], edges: [] }, matched: { matches: [] } },
  })
  chk('a reading that found no manifest draws nothing',
    payloadOf(empty).nodes.every((n) => n.layer !== 'dependency'))
  chk('but says so, in the reading\'s own words',
    sup(empty).some((s) => /no package\.json under the scan root/.test(s.why)),
    JSON.stringify(sup(empty)))
}

// ══════════════════════════════════ 2. only what the session reached
section('2. nothing is drawn because it exists')
{
  const g = payloadOf(withBom())
  const deps = g.nodes.filter((n) => n.layer === 'dependency')
  const labels = deps.map((n) => n.label)
  chk('a package an import resolved to is drawn', labels.some((l) => l.startsWith('chalk 5.6.2')), labels.join(' | '))
  chk('a package a touched manifest declares is drawn', labels.some((l) => l.startsWith('left-pad')), labels.join(' | '))
  // The whole design in one assertion.
  chk('a package nothing in the session points at is NOT drawn',
    !labels.some((l) => l.startsWith('unreached')), labels.join(' | '))
  chk('and the page counts it rather than dropping it in silence',
    sup(withBom()).some((s) => s.n === 1 && /bill entry/.test(s.what)),
    JSON.stringify(sup(withBom())))
  // A manifest nobody edited is not a node either.
  chk('a manifest no turn edited is not drawn',
    !labels.includes('packages/api/package.json'), labels.join(' | '))
  chk('and that is counted too',
    sup(withBom()).some((s) => /manifest/.test(s.what) && /named its path/.test(s.why)),
    JSON.stringify(sup(withBom())))
}

// ══════════════════════════════════ 3. the correlation, which is the point
section('3. the transcript and the repository are joined, not merged')
{
  const g = payloadOf(withBom())
  const dep = g.edges.filter((e) => e.layer === 'dependency')
  chk('the import root stays a DERIVED node',
    g.nodes.find((n) => n.id === 'package:chalk')?.layer === 'derived',
    JSON.stringify(g.nodes.find((n) => n.id === 'package:chalk')))
  chk('and an edge joins it to what it resolves to',
    dep.some((e) => e.s === 'package:chalk' && e.rel === 'resolves to'),
    dep.map((e) => `${e.s}->${e.t}`).join(' | '))
  // One name installed twice: choosing one would be a guess, so both are drawn.
  chk('a name installed at two versions is drawn as both',
    g.nodes.filter((n) => n.layer === 'dependency' && n.label.startsWith('chalk')).length === 2)
  chk('and the ambiguity is reported rather than resolved',
    sup(withBom()).some((s) => /more than one entry/.test(s.what)),
    JSON.stringify(sup(withBom())))
  chk('a turn that edited a manifest has an edge to it',
    dep.some((e) => e.s === 'turn:0' && e.rel === 'edited' && e.t === 'manifest:package.json'),
    dep.map((e) => `${e.s}->${e.t}`).join(' | '))
}

// ══════════════════════════════════ 4. dates
section('4. a dependency did not happen at a turn')
{
  const g = payloadOf(withBom())
  const deps = g.nodes.filter((n) => n.layer === 'dependency')
  chk('every dependency node is present from the first frame',
    deps.every((n) => n.at === -1), JSON.stringify(deps.map((n) => [n.label, n.at])))
  // The one thing that DID happen at a turn.
  const edited = g.edges.find((e) => e.rel === 'edited')
  chk('but the edit that touched a manifest is dated to its turn', edited?.at === 0, JSON.stringify(edited))
}

// ══════════════════════════════════ 5. three layers, told apart
section('5. a third kind of claim, marked as one')
{
  const html = withBom()
  const g = payloadOf(html)
  const deps = g.nodes.filter((n) => n.layer === 'dependency')
  chk('every dependency id is namespaced away from the other layers',
    deps.every((n) => /^(dep|manifest):/.test(n.id)), deps.map((n) => n.id).join(' '))
  chk('none of them is marked derived or authored',
    !g.nodes.some((n) => n.layer === 'dependency' && (n.measured || n.carried)))
  // Shape, not colour: a square, where derived is a circle and authored a diamond.
  chk('they are drawn as squares in the markup',
    (html.match(/<g class="gn dependency[^"]*"[^>]*>(?:(?!<\/g>).)*?<rect class="gs"/gs) || []).length === deps.length,
    `${deps.length} dependency nodes`)
  chk('and a screen reader is told what layer it is on',
    /declared by a manifest, not observed in this session/i.test(html))
  chk('the legend counts them apart from the model\'s work',
    /Declared by the repository<\/b>[\s\S]{0,80}?(\d+) nodes/.test(html) &&
      Number(/Declared by the repository<\/b>[\s\S]{0,80}?(\d+) nodes/.exec(html)[1]) === deps.length,
    (html.match(/Declared by the repository[\s\S]{0,90}/) || [''])[0])
  // The arithmetic that broke when a third layer arrived: authoredCount was
  // "everything that is not derived and not carried".
  const authored = Number(/Written by the model, this session<\/b>[\s\S]{0,80}?(\d+) nodes/.exec(html)[1])
  chk('and the model\'s count does not swallow them',
    authored === g.nodes.filter((n) => n.layer === 'authored' && !n.carried).length,
    `legend says ${authored}`)
}

// ══════════════════════════════════ 6. a mode, not an overlay
section('6. the layer is off until it is asked for')
{
  const html = withBom()
  chk('the toggle is offered', /id="gdep"/.test(html))
  chk('and starts unpressed', /id="gdep"[^>]*aria-pressed="false"/.test(html),
    (html.match(/<button id="gdep"[^>]*>/) || [''])[0])
  chk('and names how many it would show',
    /Show what the repository declares \((\d+)\)/.test(html),
    (html.match(/Show what the repository declares[^<]*/) || [''])[0])
  // One predicate for both toggles -- the property the other suites hold too.
  chk('one predicate decides both layers',
    (html.match(/function offLayer\(x\)\{/g) || []).length === 1 &&
      /x\.layer==='dependency'/.test(html))
  chk('and the dependency layer is off in it by default', /var showDep=false;/.test(html))
}

// ══════════════════════════════════ 7. the reasons are the reader's, not the code's
section('7. what was not drawn, in words')
{
  const rows = sup(withBom())
  chk('a node builtin is explained, not printed as a code',
    rows.some((r) => /node built-in is declared by no manifest/.test(r.why)),
    JSON.stringify(rows))
  chk('and a name genuinely absent from the bill says the bill was searched',
    rows.some((r) => /searched in full/.test(r.why)), JSON.stringify(rows))
  chk('no row prints a raw reason code',
    !rows.some((r) => /reported (them )?as [a-z-]+$/.test(r.why)), JSON.stringify(rows))
  // A count and its noun have to agree, or the numbers beside them stop being
  // believed.
  chk('every row agrees with its own number',
    rows.every((r) => (r.n === 1 ? !/\b(entries|manifests|names|imports)\b/.test(r.what) : true)),
    JSON.stringify(rows.map((r) => `${r.n} ${r.what}`)))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
