// The knowledge graph's adjacency map is emitted inside a <script> element.
// JSON.stringify does not escape `<`, so a graph node id containing the literal
// `</script>` would end that element early and the rest of the page would be
// parsed as markup. Node ids are `<kind>:<label>`, and labels come from
// artifacts harvested out of tool-call inputs — a skill name is copied with no
// character constraint at all, so nothing upstream guarantees this cannot happen.
//
// This asserts against the RENDERED DOCUMENT, not against the escaping helper:
// a helper that is correct but not called at the emit site is the failure this
// test exists to catch.
import { render } from '../scripts/render-corpus.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

const PAYLOAD = '</script><img src=x onerror=alert(1)>'
const POISONED = `package:${PAYLOAD}`

const model = {
  meta: {
    sessionCount: 1,
    turnCount: 3,
    projectCount: 1,
    harnesses: { 'claude-code': 1 },
    span: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z', days: 1 },
    transcriptBytes: 1024,
    subagents: { files: 0, bytes: 0 },
    filter: { project: null, since: null },
    excluded: { noHumanTurns: 0, outOfWindow: 0, transcriptsFound: 1 },
    failures: [],
  },
  totals: {
    tokens: { input: 0, output: 1, cacheRead: 1, cacheCreate: 0 },
    frictionRate: 0,
    reworkRate: 0,
    craftRate: 0,
    repeats: 0,
    interruptions: 0,
  },
  // The `measurable: false` arm — the comparison branch reads trend.reworkRate.from,
  // which this fixture has no weeks to populate.
  trend: { measurable: false, why: 'one week of data' },
  timeline: [],
  taxonomy: {},
  signals: [],
  models: { rollup: [], pairs: [] },
  graph: {
    nodes: [
      { id: 'repo:demo', kind: 'repo', label: 'demo', degree: 1, turns: 3 },
      { id: POISONED, kind: 'package', label: PAYLOAD, degree: 1 },
    ],
    edges: [{ source: 'repo:demo', target: POISONED }],
    layout: {
      width: 1000,
      height: 620,
      positions: { 'repo:demo': { x: 100, y: 100 }, [POISONED]: { x: 300, y: 300 } },
    },
    related: [],
    bridges: [],
    isolated: [],
    gate: { minRepos: 2, universalAt: 5, repoCount: 1 },
  },
  projects: [],
  sessions: [],
  exemplars: { repeats: [], corrections: [], worst: [] },
  incidents: [],
  caveats: [],
}

let html
try {
  html = render(model)
} catch (err) {
  chk('render() completes on a model carrying a hostile node id', false, err.message)
  process.exit(1)
}
chk('render() completes on a model carrying a hostile node id', typeof html === 'string' && html.length > 0)

// The emit site, and the script body a browser would see: everything from the
// assignment up to the FIRST `</script>` that follows it. If the payload broke
// out, that first close is the injected one and the body is truncated JSON.
const marker = 'window.__kgAdj='
const at = html.indexOf(marker)
chk('the adjacency script is present', at !== -1)

const close = html.indexOf('</script>', at)
chk('the adjacency script is closed', close !== -1)

const body = html.slice(at + marker.length, close)

// NOT "the body contains no <". That slice ends at the FIRST `</script>` — on a
// vulnerable build that IS the injected one, so everything before it is clean
// and the assertion passes while the page is broken. It has to name the escape.
chk(
  'the payload is emitted in escaped form',
  html.includes('\\u003c/script\\u003e'),
  'no \\u003c escape found — the emit site is not going through jsonForScript'
)
chk('the raw injected element never reaches the document', !html.includes('</script><img'))

// The whole point of escaping rather than stripping: the value must still be
// there, and must still parse. A test that only checked for absence would pass
// on a helper that silently dropped the data.
let parsed = null
try {
  parsed = JSON.parse(body.replace(/;$/, ''))
} catch (err) {
  chk('the script body parses as JSON', false, err.message)
}
if (parsed) {
  chk('the script body parses as JSON', true)
  chk(
    'the payload round-trips byte for byte',
    Object.prototype.hasOwnProperty.call(parsed, POISONED),
    `keys: ${JSON.stringify(Object.keys(parsed))}`
  )
  chk(
    'the adjacency it encodes is still correct',
    Array.isArray(parsed[POISONED]) && parsed[POISONED].includes('repo:demo')
  )
}

// A browser reading the document must not find the injected element. Counting
// closes is the check that would have failed before the fix.
chk(
  'the document opens and closes the same number of script elements',
  (html.match(/<script[ >]/g) || []).length === (html.match(/<\/script>/g) || []).length,
  `${(html.match(/<script[ >]/g) || []).length} open, ${(html.match(/<\/script>/g) || []).length} close`
)
chk('the injected element is nowhere in the document', !html.includes('<img src=x onerror='))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
