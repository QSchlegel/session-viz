// The knowledge graph, asserted against the REAL rendered page.
//
// Following picker.mjs: never assert against a re-run of deriveGraph(). The
// failures that matter here are the ones where the derivation is right and the
// page is wrong -- an edge drawn to a node the gate removed, a model-authored
// label that ends the script element, a suppression that happened silently.
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
  artifacts: { tools: { git: 4 }, mcp: { railway: 2 }, packages: {}, stack: {}, extensions: {}, skills: {}, fileTouches: 17 },
  totals: {
    humanTurns: turns.length, toolCalls: 0, tokens: { output: 100, cacheRead: 100 },
    frictionTurns: 0, repeats: 0, interruptions: 0, steeringTurns: 0, records: 10,
  },
  score: { value: 90, band: 'clean', confidence: 'high', turnsScored: turns.length, frictionRate: 0, craftRate: 0, wastedTokens: 0 },
  turns,
  ...extra,
})

const payloadOf = (html) => {
  const m = html.match(/window\.__qkg=(.*?);<\/script>/s)
  if (!m) return null
  return JSON.parse(m[1])
}

// ---------------------------------------------------------------- 1. it draws
{
  const html = render(base([turn(0), turn(1)]), null)
  chk('the page carries a Knowledge graph section', html.includes('<h2>Knowledge graph</h2>'))
  const g = payloadOf(html)
  chk('the payload parses out of the real page', !!g, 'no window.__qkg found')
  chk('the session node exists even with no friction anywhere', g.nodes.some((n) => n.kind === 'session'))
  chk('every node is marked derived when there is no intent', g.nodes.every((n) => n.layer === 'derived'))
}

// ---------------------------------------------------------------- 2. the repeat-target gate
//
// `repeated` friction attaches to the REPEATING turn only. Turn 2 below earns
// nothing of its own, so before the fix it was suppressed and the star edge
// from turn 5 dangled at a node that was not on the page.
{
  // Turns 0, 1 and 3 hold the three highest tool counts, and turn 4 is the
  // costliest, so turn 2 is reachable ONLY through the repeat-target rule. An
  // earlier draft of this fixture left every count at 0, which put turn 2 in
  // the top-3 anchors and made the assertion pass with the gate removed.
  const turns = [
    turn(0, { toolCallCount: 50 }),
    turn(1, { toolCallCount: 40 }),
    turn(2), // the target: clean, no friction, no signal, no anchor
    turn(3, { toolCallCount: 30 }),
    turn(4, { toolCallCount: 5 }),
    turn(5, { toolCallCount: 1, friction: ['repeated'], derived: { repeatOf: 2 } }),
  ]
  const g = payloadOf(render(base(turns, { score: { ...base([]).score, costliestTurn: 4 } }), null))
  const ids = new Set(g.nodes.map((n) => n.id))
  chk('a repeat TARGET carrying no signal of its own is still drawn', ids.has('turn:2'),
    `turn nodes: ${[...ids].filter((i) => i.startsWith('turn:')).join(', ')}`)
  chk('the repeat edge exists', g.edges.some((e) => e.s === 'turn:5' && e.t === 'turn:2'))
  chk('no edge reaches a node that is not on the page',
    g.edges.every((e) => ids.has(e.s) && ids.has(e.t)),
    g.edges.filter((e) => !ids.has(e.s) || !ids.has(e.t)).map((e) => `${e.s}->${e.t}`).join(', '))
}

// ---------------------------------------------------------------- 3. the mode-host gate
{
  // Five turns, and the host is not in the top three by tool count -- with only
  // three turns the anchor rule draws all of them and the gate is never tested.
  const turns = [
    turn(0, { toolCallCount: 50 }),
    turn(1, { toolCallCount: 0, startedAt: '2026-01-01T00:01:00Z', endedAt: '2026-01-01T00:02:00Z' }), // clean host
    turn(2, { toolCallCount: 40 }),
    turn(3, { toolCallCount: 30 }),
    turn(4, { toolCallCount: 20 }),
  ]
  const s = base(turns, {
    permissionModes: [{ ts: '2026-01-01T00:01:30Z', mode: 'acceptEdits' }],
    score: { ...base([]).score, costliestTurn: 0 },
  })
  const g = payloadOf(render(s, null))
  const ids = new Set(g.nodes.map((n) => n.id))
  chk('a turn that brackets a permission-mode switch is drawn', ids.has('turn:1'))
  chk('and the switch edge does not dangle', g.edges.every((e) => ids.has(e.s) && ids.has(e.t)))
}

// ---------------------------------------------------------------- 4. layer separation
{
  const intent = {
    sessionId: 'abcd1234-0000-0000-0000-000000000000',
    graph: {
      concepts: [
        { id: 'oauth-only', label: 'OAuth only', group: 'decision', note: 'held all session', anchors: ['tool:Edit', 'nope:missing'] },
        // Tries to impersonate a measured node.
        { id: 'session', label: 'not the session', group: 'repo' },
      ],
      relations: [{ from: 'oauth-only', to: 'tool:Edit', label: 'decided for' }],
    },
  }
  const turns = [turn(0, { toolCalls: [{ name: 'Edit', count: 3 }], toolCallCount: 3 })]
  const g = payloadOf(render(base(turns), intent))
  const authored = g.nodes.filter((n) => n.layer === 'authored')
  chk('authored concepts appear', authored.length >= 1, `${authored.length}`)
  chk('every authored id is namespaced under concept:',
    authored.every((n) => n.id.startsWith('concept:')), authored.map((n) => n.id).join(', '))
  chk('an authored node cannot take a derived id',
    !g.nodes.some((n) => n.layer === 'authored' && n.id === 'session:abcd1234-0000-0000-0000-000000000000'))
  chk('an authored node claiming a derived group is not given it',
    !authored.some((n) => n.kind === 'repo'), authored.map((n) => n.kind).join(', '))
  chk('a valid anchor becomes an edge', g.edges.some((e) => e.s === 'concept:oauth-only' && e.t === 'tool:Edit'))
  chk('an anchor naming nothing is dropped, not drawn',
    g.edges.every((e) => e.t !== 'nope:missing'))
}

// ---------------------------------------------------------------- 5. the authored layer is optional
{
  const turns = [turn(0)]
  const withOut = payloadOf(render(base(turns), null))
  const withIntentNoGraph = payloadOf(render(base(turns), { tldr: 'x' }))
  chk('the derived graph stands alone with no intent at all', withOut.nodes.length > 0)
  chk('and is identical when an intent carries no graph',
    JSON.stringify(withOut) === JSON.stringify(withIntentNoGraph))
}

// ---------------------------------------------------------------- 6. script escaping
//
// Authored labels and notes are model-written free text, which makes the
// corpus renderer's latent injection live here.
{
  const PAYLOAD = '</script><img src=x onerror=alert(1)>'
  const intent = { graph: { concepts: [{ id: 'x', label: PAYLOAD, note: PAYLOAD }] } }
  const html = render(base([turn(0)]), intent)
  const at = html.indexOf('window.__qkg=')
  const close = html.indexOf('</script>', at)
  const body = html.slice(at + 'window.__qkg='.length, close)
  chk('the graph payload is emitted escaped', html.includes('\\u003c/script\\u003e'))
  chk('the raw injected element never reaches the document', !html.includes('</script><img'))
  let parsed = null
  try { parsed = JSON.parse(body.replace(/;$/, '')) } catch (e) { chk('the graph script body parses as JSON', false, e.message) }
  if (parsed) {
    chk('the graph script body parses as JSON', true)
    chk('and the hostile label round-trips intact',
      parsed.nodes.some((n) => n.label === PAYLOAD.slice(0, 60)))
  }
  chk('script elements open and close in balance',
    (html.match(/<script[ >]/g) || []).length === (html.match(/<\/script>/g) || []).length,
    `${(html.match(/<script[ >]/g) || []).length} open, ${(html.match(/<\/script>/g) || []).length} close`)
}

// ---------------------------------------------------------------- 7. suppression is reported
{
  const turns = Array.from({ length: 40 }, (_, i) => turn(i))
  const html = render(base(turns), null)
  chk('a gate that dropped turns says so on the page', /\d+<\/b> turns not drawn/.test(html),
    'no suppression line found')
  chk('the non-claims block renders', html.includes('What this picture cannot say'))
  chk('it names the file limitation even though no file node can exist',
    html.includes('never which one'))
}

// ---------------------------------------------------------------- 8. the mismatch band
{
  const html = render(base([turn(0)]), { sessionId: 'ffffffff-1111-2222-3333-444444444444' })
  chk('a spine/intent session mismatch is stated on the page',
    html.includes('describe different sessions'))
  const ok = render(base([turn(0)]), { sessionId: 'abcd1234-0000-0000-0000-000000000000' })
  chk('and is absent when they agree', !ok.includes('describe different sessions'))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
