// How the knowledge graph is DRAWN: framing, theme, zoom and replay.
//
// test/graph.mjs already guards what reaches the page. This guards what the
// page then does with it, and every assertion is made against the rendered
// document rather than against a re-run of the code that produced it -- the
// recurring failure in this repo is a check that passes by not looking.
//
// The one thing that cannot be checked here is pixels: there is no layout
// engine in node, so getBBox does not exist and label collisions are not
// measurable. Those are measured in a browser by hand. Everything below is a
// property that survives having no renderer: positions, attributes, tokens.
import { render } from '../scripts/render.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

const turn = (index, extra = {}) => ({
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
  ...extra,
})

const base = (turns, extra = {}) => ({
  sessionId: 'abcd1234-0000-0000-0000-000000000000',
  harness: 'claude-code',
  cwd: '/home/x/demo',
  gitBranch: 'main',
  durationMs: 60000,
  models: { 'claude-opus-5': 12 },
  slashCommands: [],
  permissionModes: [],
  artifacts: { tools: {}, mcp: {}, packages: {}, stack: {}, extensions: {}, skills: {}, fileTouches: 3 },
  totals: {
    humanTurns: turns.length, toolCalls: 0, tokens: { output: 100, cacheRead: 100 },
    frictionTurns: 0, repeats: 0, interruptions: 0, steeringTurns: 0, records: 10,
  },
  score: { value: 90, band: 'clean', confidence: 'high', turnsScored: turns.length, frictionRate: 0, craftRate: 0, wastedTokens: 0, costliestTurn: 0 },
  turns,
  ...extra,
})

const payloadOf = (html) => {
  const m = html.match(/window\.__qkg=(.*?);<\/script>/s)
  return m ? JSON.parse(m[1]) : null
}

/** Every drawn node, read back out of the SVG: its id, its centre, its birth
 *  turn and whether its label survives being zoomed out. */
const drawn = (html) =>
  [...html.matchAll(/<g class="gn ([^"]*)" data-id="([^"]*)" data-t="(-?\d+)"( data-hi="1")?[^>]*>(.*?)<\/g>/gs)].map((m) => {
    const body = m[5]
    const c = body.match(/<circle class="gs" cx="(-?[\d.]+)" cy="(-?[\d.]+)" r="([\d.]+)"/)
    const p = body.match(/<polygon class="gs" points="(-?[\d.]+),(-?[\d.]+) (-?[\d.]+),(-?[\d.]+)/)
    const label = body.match(/<text x="(-?[\d.]+)" y="(-?[\d.]+)">/)
    return {
      cls: m[1], id: m[2], at: Number(m[3]), hi: !!m[4],
      x: c ? Number(c[1]) : p ? Number(p[3]) : null,
      y: c ? Number(c[2]) : p ? Number(p[2]) : null,
      r: c ? Number(c[3]) : null,
      labelY: label ? Number(label[2]) : null,
      shape: c ? 'circle' : p ? 'polygon' : null,
    }
  })

/** Connected components of the payload, so "the giant component" is measured
 *  from the edges the page actually carries. */
const components = (g) => {
  const adj = {}
  g.nodes.forEach((n) => { adj[n.id] = [] })
  g.edges.forEach((e) => { if (adj[e.s] && adj[e.t]) { adj[e.s].push(e.t); adj[e.t].push(e.s) } })
  const seen = new Set()
  const comps = []
  for (const n of g.nodes) {
    if (seen.has(n.id)) continue
    const q = [n.id]
    const c = []
    seen.add(n.id)
    while (q.length) {
      const v = q.pop()
      c.push(v)
      for (const w of adj[v]) if (!seen.has(w)) { seen.add(w); q.push(w) }
    }
    comps.push(c)
  }
  return comps.sort((a, b) => b.length - a.length)
}

// A core of three busy, frictional turns sharing three tools, and twenty quiet
// turns that each call a tool of their own. The quiet turns are dropped by the
// gate, so their tools survive as nodes with no edge at all -- which is exactly
// the shape that used to throw the framing away.
const SKEW = base(
  [
    turn(0, { friction: ['roundtrip'], toolCallCount: 30, toolCalls: [{ name: 'Read', count: 10 }, { name: 'Edit', count: 10 }, { name: 'Bash', count: 10 }] }),
    turn(1, { friction: ['roundtrip'], toolCallCount: 30, toolCalls: [{ name: 'Read', count: 10 }, { name: 'Edit', count: 10 }, { name: 'Bash', count: 10 }] }),
    turn(2, { friction: ['interrupted'], interruptions: 1, toolCallCount: 30, toolCalls: [{ name: 'Read', count: 10 }, { name: 'Edit', count: 10 }, { name: 'Bash', count: 10 }] }),
    ...Array.from({ length: 20 }, (_, i) =>
      turn(3 + i, { toolCallCount: 1, toolCalls: [{ name: `Lonely${i}`, count: 1 }] })),
  ],
  { score: { ...base([]).score, costliestTurn: 0 } }
)

// ---------------------------------------------------------------- 1. framing
{
  const html = render(SKEW, null)
  const g = payloadOf(html)
  const nodes = drawn(html)
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const unplaced = nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y))
  chk('every node the payload carries is drawn with a position',
    g.nodes.length === nodes.length && unplaced.length === 0,
    `${g.nodes.length} in payload, ${nodes.length} drawn, ${unplaced.length} without a readable centre`)
  if (unplaced.length) {
    // Everything below reads coordinates. Stopping here turns one broken build
    // into one named failure instead of a stack trace three assertions later.
    console.log('\nstopping: coordinates could not be read')
    process.exit(1)
  }

  const comps = components(g)
  const singles = comps.filter((c) => c.length === 1).map((c) => c[0])
  chk('the fixture really does produce unconnected nodes', singles.length === 20, `${singles.length}`)

  const boxOf = (ids) => {
    const xs = ids.map((i) => byId.get(i).x)
    const ys = ids.map((i) => byId.get(i).y)
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }
  const giant = boxOf(comps[0])
  const FRAME = 1000 * 620
  // THE assertion. One simulation over every node puts the unconnected on a
  // wide ring, the ring sets the extent, and the normalisation then divides the
  // connected component down into a couple of percent of the frame.
  chk('the connected component is drawn at a legible size',
    giant.w >= 220 && giant.h >= 130 && (giant.w * giant.h) / FRAME >= 0.10,
    `giant ${Math.round(giant.w)}x${Math.round(giant.h)} = ${(((giant.w * giant.h) / FRAME) * 100).toFixed(1)}% of the frame`)

  // Legible size is not enough on its own -- a component can span the frame and
  // still be a knot. This is the measurement that says the dots are apart.
  const spacings = comps[0].map((i) => {
    const a = byId.get(i)
    return Math.min(...comps[0].filter((j) => j !== i).map((j) => Math.hypot(a.x - byId.get(j).x, a.y - byId.get(j).y)))
  })
  const mean = spacings.reduce((a, b) => a + b, 0) / spacings.length
  chk('and its nodes are not crushed on top of each other',
    mean >= 22 && Math.min(...spacings) >= 10,
    `mean nearest-neighbour ${mean.toFixed(1)}, min ${Math.min(...spacings).toFixed(1)}`)

  // Gridded, not scattered: a scatter would give twenty distinct columns, and
  // the grid is a statement that these nodes have no geometry to show.
  const cols = [...new Set(singles.map((i) => byId.get(i).x.toFixed(1)))]
  chk('the unconnected sit in a grid, not a scatter', cols.length <= 5,
    `${cols.length} distinct columns for ${singles.length} nodes`)
  const col0 = singles.map((i) => byId.get(i)).filter((n) => n.x.toFixed(1) === cols[0]).map((n) => n.y).sort((a, b) => a - b)
  if (col0.length > 2) {
    const gaps = col0.slice(1).map((y, k) => y - col0[k])
    chk('and are evenly pitched down the column',
      Math.max(...gaps) - Math.min(...gaps) < 0.5, gaps.map((x) => x.toFixed(2)).join(', '))
  }

  chk('nothing is drawn outside the viewBox',
    nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x <= 1000 && n.y <= 620),
    nodes.filter((n) => n.x < 0 || n.y < 0 || n.x > 1000 || n.y > 620).map((n) => `${n.id}@${n.x},${n.y}`).join(' '))

  chk('the page says how many connect to nothing', html.includes('20 connect to nothing drawn'))
  chk('two renders of one input are byte-identical', render(SKEW, null) === html)
}

// ---------------------------------------------------------------- 2. theme
//
// The graph used to be painted on a hardcoded dark rectangle on a page that
// otherwise follows the system. Every colour it uses now has to resolve in all
// four states: system-light, system-dark, forced light, forced dark.
{
  const html = render(SKEW, null)
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
  const light = style.slice(style.indexOf(':root{'), style.indexOf('@media'))
  const media = style.slice(style.indexOf('@media'), style.indexOf(':root[data-theme=dark]'))
  const forced = style.slice(style.indexOf(':root[data-theme=dark]'), style.indexOf('*{box-sizing'))

  const used = [...new Set([...style.matchAll(/var\((--kg-[a-z-]+|--k-[a-z]+)[,)]/g)].map((m) => m[1]))]
  const defined = (block) => new Set([...block.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]))
  const inLight = defined(light)
  const inMedia = defined(media)
  const inForced = defined(forced)

  chk('every graph colour the stylesheet uses is defined for a light page',
    used.length > 0 && used.every((v) => inLight.has(v)), used.filter((v) => !inLight.has(v)).join(', '))
  chk('and redefined under prefers-color-scheme: dark',
    used.every((v) => inMedia.has(v)), used.filter((v) => !inMedia.has(v)).join(', '))
  chk('and again for a page forced to dark',
    used.every((v) => inForced.has(v)), used.filter((v) => !inForced.has(v)).join(', '))
  chk('the dark media block is guarded so a forced-light page stays light',
    media.includes(':root:not([data-theme=light])'))

  // A colour whose only definition is a literal cannot follow a theme.
  const gcss = style.slice(style.indexOf('/* knowledge graph */'))
  const hex = [...gcss.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  chk('the graph stylesheet carries no literal colours at all', hex.length === 0, hex.join(', '))
  const svg = html.slice(html.indexOf('<svg viewBox'), html.indexOf('</svg>'))
  chk('and the SVG paints nothing with an inline fill', !/fill="#/.test(svg))

  chk('a kind carries its colour as a class, so one rule fills every shape',
    html.includes('<g class="gn derived k-session"'))
  chk('the theme is applied before the first paint, not after',
    html.indexOf("localStorage.getItem('qpact-theme')") < html.indexOf('<style>'))
  chk('and only two values are ever honoured from storage',
    html.includes("m==='dark'||m==='light'"))
  chk('the toggle offers system as well as light and dark',
    html.includes("var order=['system','light','dark']"))
}

// ---------------------------------------------------------------- 3. zoom
{
  const html = render(SKEW, null)
  const svg = html.slice(html.indexOf('<svg viewBox'), html.indexOf('</svg>'))
  chk('one group wraps both edges and nodes, so one transform moves everything',
    /<g id="gview">\s*<g id="gedges">/.test(svg) && svg.indexOf('<g id="gnodes">') > svg.indexOf('<g id="gview">'))
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
  for (const rule of ['.ge{', '.gn text{', '.gn .gs{'])
    chk(`${rule.trim()} divides its stroke by the live zoom`,
      style.slice(style.indexOf(rule)).slice(0, 300).includes('var(--kgz,1)'))
  chk('the handler is what sets that factor', html.includes("svg.style.setProperty('--kgz',k)"))
  chk('zoom in, zoom out and fit are all reachable by mouse',
    ['data-z="out"', 'data-z="in"', 'data-z="fit"'].every((s) => html.includes(s)))
  chk('and by keyboard, from a focusable canvas',
    html.includes('<div class="gcanvas" id="gcanvas" tabindex="0"') && html.includes("ev.key==='0'"))
  chk('the wheel normalises deltaMode, so a line-scrolling browser is not inert',
    html.includes('ev.deltaMode===1?16:'))
  chk('pointer capture is not used, which would break selecting a node',
    !html.includes('.setPointerCapture('))
}

// ---------------------------------------------------------------- 4. replay
//
// The fatal shape here is an edge drawn in a frame where one of its endpoints
// does not exist yet: a line into empty space, which reads as a relation to
// something invisible.
{
  const html = render(SKEW, null)
  const g = payloadOf(html)
  const nodes = drawn(html)
  const at = new Map(g.nodes.map((n) => [n.id, n.at]))

  chk('every node carries a birth turn on the element itself',
    nodes.length > 0 && nodes.every((n) => Number.isInteger(n.at)))
  chk('and the element agrees with the payload',
    nodes.every((n) => n.at === at.get(n.id)),
    nodes.filter((n) => n.at !== at.get(n.id)).map((n) => n.id).join(', '))

  const bad = g.edges.filter((e) => e.at < at.get(e.s) || e.at < at.get(e.t))
  chk('no edge is born before either end of it', bad.length === 0,
    bad.slice(0, 3).map((e) => `${e.s}@${at.get(e.s)} -> ${e.t}@${at.get(e.t)} edge@${e.at}`).join('; '))

  // Walked frame by frame, the way the scrubber does.
  let stubs = 0
  for (let t = 0; t <= g.maxTurn; t++)
    for (const e of g.edges)
      if (e.at <= t && (at.get(e.s) > t || at.get(e.t) > t)) stubs++
  chk('and at no scrubber position does an edge outlive an endpoint', stubs === 0, `${stubs} stub frames`)

  chk('the session is present in the first frame', at.get(`session:${SKEW.sessionId}`) <= 0)
  const lonely = g.nodes.find((n) => n.id === 'tool:Lonely7')
  chk('a tool first called in a turn the gate dropped is still dated by that turn',
    !!lonely && lonely.at === 10, `${lonely && lonely.at}`)

  chk('the scrubber spans the turns and starts at the end',
    html.includes(`min="0" max="${g.maxTurn}" step="1" value="${g.maxTurn}"`), `maxTurn ${g.maxTurn}`)
  chk('an unborn node is hidden outright, not faded',
    html.includes('.ge.pre,.gn.pre{display:none}'))
  chk('one pass applies the replay, the layer toggle and the focus together',
    html.includes("g.classList.toggle('pre',!!pre)") && html.includes("var gone=hidden&&n.layer==='authored'"))
}

// ---------------------------------------------------------------- 5. undated
//
// A package cannot be placed in a turn, and the honest answer is to say so
// rather than to pick one.
{
  const s = base([turn(0, { friction: ['roundtrip'] })], {
    artifacts: { tools: { git: 4 }, mcp: {}, packages: { pg: 2 }, stack: {}, extensions: {}, skills: {}, fileTouches: 1 },
  })
  const html = render(s, null)
  const g = payloadOf(html)
  const pkg = g.nodes.find((n) => n.id === 'package:pg')
  const cli = g.nodes.find((n) => n.id === 'cli:git')
  chk('a session-level artifact is dated -1, not 0', !!pkg && pkg.at === -1 && !!cli && cli.at === -1,
    `package ${pkg && pkg.at}, cli ${cli && cli.at}`)
  chk('the panel says it could not be placed, rather than naming a turn',
    html.includes('not attributable to a turn'))
  chk('and the caveat block says the same in prose',
    html.includes('has no turn to be placed at'))
}

// ---------------------------------------------------------------- 6. authored
//
// The authored layer has to be tethered too, or the model's reading of the
// session pops in at frame zero and claims to have preceded the work.
{
  const s = base([
    turn(0, { friction: ['roundtrip'], toolCallCount: 5, toolCalls: [{ name: 'Edit', count: 5 }] }),
    turn(1, { toolCallCount: 4 }),
    turn(2, { friction: ['repeated'], derived: { repeatOf: 0 }, toolCallCount: 3 }),
  ])
  const intent = {
    graph: {
      concepts: [
        { id: 'late', label: 'A thing decided late', group: 'decision', anchors: ['turn:2'] },
        { id: 'named', label: 'A thing pinned to a turn', group: 'guard', turns: [1] },
        { id: 'floating', label: 'A thing anchored to nothing dated', group: 'thread' },
      ],
      relations: [{ from: 'late', to: 'named' }],
    },
  }
  const html = render(s, intent)
  const g = payloadOf(html)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  chk('a concept anchored to a turn is dated by that turn', byId.get('concept:late').at === 2,
    String(byId.get('concept:late').at))
  chk('a concept that names its own turns takes the earliest', byId.get('concept:named').at === 1,
    String(byId.get('concept:named').at))
  chk('a concept with nothing dated is present from the start', byId.get('concept:floating').at === -1,
    String(byId.get('concept:floating').at))
  const rel = g.edges.find((e) => e.s === 'concept:late' && e.t === 'concept:named')
  chk('a relation waits for the later of its two ends', !!rel && rel.at === 2, rel && String(rel.at))
  chk('the authored layer is still a diamond, not a circle',
    /<g class="gn authored k-decision"[^>]*>.*?<polygon/s.test(html))
  chk('and every authored label is kept at fit zoom',
    drawn(html).filter((n) => n.cls.includes('authored')).every((n) => n.hi))
}


// ---------------------------------------------------------------- 7. at scale
//
// Section 1 proves the framing on ONE 23-node fixture, and that is exactly the
// hole an adversarial review walked through: the fit was floored at 0.2, so
// past roughly five frames' worth of content it stopped shrinking, the offsets
// went negative and nodes were emitted outside the viewBox -- clipped by the
// canvas, unreachable by Fit, and still counted as drawn by the legend and the
// scrubber. One fixture that never got large could not see it.
{
  const busy = (n) =>
    base(
      Array.from({ length: n }, (_, i) =>
        turn(i, {
          // Friction on EVERY turn, so every turn survives the gate and the
          // packed extent really does get large. A fixture where only a third
          // of the turns are drawn never reaches the size that broke this, and
          // the assertion passes without looking.
          friction: ['roundtrip'],
          toolCallCount: (i % 7) + 1,
          toolCalls: [{ name: `T${i % 40}`, count: (i % 7) + 1 }],
          model: 'claude-opus-5',
        })),
      { score: { ...base([]).score, costliestTurn: 0 } }
    )
  // 1600 and not 800: at 800 turns the fit lands on 0.206, a hair above the 0.2
  // floor this is here to catch. A size that never quite reaches the bug is a
  // size that proves nothing.
  for (const n of [40, 200, 400, 1600]) {
    const html = render(busy(n), null)
    const nodes = drawn(html)
    const out = nodes.filter((x) => x.x < 0 || x.y < 0 || x.x > 1000 || x.y > 620)
    // A graph that fits by shrinking to nothing has to say so. Fitting and
    // being readable are different claims, and only one of them is guaranteed.
    if (n >= 1600)
      chk('a graph packed too small to read says so rather than looking broken',
        html.includes('too dense to read at fit'))
    chk(`a ${n}-turn session puts nothing outside the viewBox`, out.length === 0,
      `${out.length} of ${nodes.length} outside; x spans ${Math.min(...nodes.map((v) => v.x)).toFixed(0)} to ${Math.max(...nodes.map((v) => v.x)).toFixed(0)}`)
  }
}

// ---------------------------------------------------------------- 8. the fit
//
// Called directly, because these are properties of layoutGraph and not every
// shape that reaches it comes from deriveGraph -- the corpus renderer feeds it
// a different graph entirely. The two-node component is the one that matters:
// simulate seeds both nodes at the same y and every y-force cancels exactly, so
// such a component is ALWAYS 60px tall, floor(60/66) is 0, and taking the rail
// height from the pack alone collapsed it to one row thousands of pixels wide.
{
  const { layoutGraph } = await import('../scripts/graph.mjs')
  const iso = (n) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, degree: 0 }))
  const chain = (n) => ({
    nodes: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, degree: 2 })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ source: `c${i}`, target: `c${i + 1}` })),
  })
  const shapes = [
    ['200 unconnected, no edges at all', iso(200), []],
    ['200 unconnected plus one two-node component', iso(200), [{ source: 'n0', target: 'n1' }]],
    ['40 unconnected plus one two-node component', iso(40), [{ source: 'n0', target: 'n1' }]],
    ['820 unconnected', iso(820), []],
    ['an 80-node chain', chain(80).nodes, chain(80).edges],
    ['a 400-node chain', chain(400).nodes, chain(400).edges],
    ['a single node', iso(1), []],
    ['nothing at all', [], []],
  ]
  for (const [name, nodes, edges] of shapes) {
    const L = layoutGraph(nodes, edges, { width: 1000, height: 620 })
    const ps = Object.values(L.positions)
    const out = ps.filter((p) => p.x < 0 || p.y < 0 || p.x > 1000 || p.y > 620)
    const finite = ps.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    chk(`${name}: every node lands inside the frame`,
      out.length === 0 && finite && ps.length === nodes.length,
      `${out.length} outside, ${ps.length} placed of ${nodes.length}, scale ${L.scale}`)
  }
}

// ---------------------------------------------------------------- 9. degenerate
{
  const one = base([turn(0, { friction: ['roundtrip'] })])
  const html1 = render(one, null)
  chk('a one-turn session offers no replay, because there is nothing to replay',
    !html1.includes('id="gscrub"') && !html1.includes('id="gplay"'))
  chk('and never says "all 1 turns" by adding one to an index', !/all 1 turns/.test(html1))
  const none = base([])
  const html0 = render(none, null)
  chk('a zero-turn session still draws its session node', html0.includes('<h2>Knowledge graph</h2>'))
  chk('and offers no scrubber either', !html0.includes('id="gscrub"'))

  const many = render(base([turn(0, { friction: ['roundtrip'] }), turn(1, { friction: ['roundtrip'] })]), null)
  chk('two turns is enough to replay', many.includes('id="gscrub"'))
  chk('and the count is the number of turns, not the last index',
    many.includes('>all 2 turns<'))
}

// ---------------------------------------------------------------- 10. modes
//
// permissionModes holds one record per switch. An edge per record drew 319
// identical lines on top of each other on the session this was written in, and
// every one of them spent the global edge budget the rest of the graph is then
// capped out of.
{
  const s = base(
    [
      turn(0, { friction: ['roundtrip'], startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' }),
      turn(1, { friction: ['roundtrip'], startedAt: '2026-01-01T00:02:00Z', endedAt: '2026-01-01T00:03:00Z' }),
    ],
    {
      permissionModes: [
        ...Array.from({ length: 40 }, () => ({ ts: '2026-01-01T00:00:30Z', mode: 'normal' })),
        { ts: '2026-01-01T00:02:30Z', mode: 'acceptEdits' },
      ],
    }
  )
  const g = payloadOf(render(s, null))
  const sid = `session:${s.sessionId}`
  const toNormal = g.edges.filter((e) => e.s === sid && e.t === 'mode:normal')
  chk('forty records of one mode make one edge, not forty', toNormal.length === 1, `${toNormal.length} edges`)
  chk('and the edge says how many records it stands for', /x40/.test(toNormal[0].rel || ''), toNormal[0].rel)

  // The cross product: turn 0 brackets `normal` and turn 1 brackets
  // `acceptEdits`, so neither may claim the other's.
  const t0 = g.edges.filter((e) => e.s === 'turn:0' && e.t.startsWith('mode:')).map((e) => e.t)
  const t1 = g.edges.filter((e) => e.s === 'turn:1' && e.t.startsWith('mode:')).map((e) => e.t)
  chk('a host turn is linked only to the mode it actually bracketed',
    t0.length === 1 && t0[0] === 'mode:normal' && t1.length === 1 && t1[0] === 'mode:acceptEdits',
    `turn 0 -> ${t0.join(',')} | turn 1 -> ${t1.join(',')}`)
}

// ---------------------------------------------------------------- 11. controls
{
  const html = render(SKEW, null)
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
  // Without color-scheme, a page forced to dark keeps a light replay slider,
  // light scrollbars and light focus rings, because those are painted by the
  // browser and not by this stylesheet.
  chk('the page declares its colour scheme to the browser, both ways',
    // The semicolon matters: `@media (prefers-color-scheme:dark)` is a query,
    // not a declaration, and counting it made this pass on two of three blocks.
    (style.match(/color-scheme:light;/g) || []).length === 1 &&
      (style.match(/color-scheme:dark;/g) || []).length === 2,
    `${(style.match(/color-scheme:light;/g) || []).length} light, ${(style.match(/color-scheme:dark;/g) || []).length} dark declarations`)
  chk('a double click on a node or a button does not reset the view',
    html.includes("ev.target.closest('.gn')") && html.includes("ev.target.closest('.gzoom')"))
  chk("the browser's own zoom shortcuts are left alone",
    html.includes('if(ev.ctrlKey||ev.metaKey||ev.altKey)return;'))
  chk('the arrow-key pan step does not shrink as the canvas grows',
    html.includes('var step=70, hit=true;'))
  chk('rewinding past a pinned node drops the pin',
    html.includes('if(pinned&&nodes[pinned]&&nodes[pinned].at>upto)pinned=null;'))
  chk('the zoom readout is legible rather than a whisper',
    style.includes('color:var(--kg-label);opacity:.8'))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
