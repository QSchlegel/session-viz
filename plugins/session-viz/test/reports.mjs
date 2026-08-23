// The four report pages, asserted against the documents they emit.
//
// Two things landed on these pages at once, and each is the kind of change that
// looks finished while being quietly wrong.
//
//   THE CHROME. One mark, one wordmark, one footer, on four wrappers that share
//   no stylesheet. The mark is nine cells — seven settled, one accent, one
//   hollow — and the wrapping of a footer in a logo is exactly the edit that
//   silently drops a provenance line. Those lines are why anyone believes a
//   number on the page above them.
//
//   THE PACKAGE. /qpact now offers a zip of the session, assembled in the
//   browser out of base64 embedded in the document, with a SHA-256 for every
//   member printed on the page. The failure that matters is not a broken zip —
//   test/bundle.mjs opens one three ways — it is a page whose PRINTED digests
//   describe different bytes than the page's own script writes. Nobody notices
//   that until an auditor runs shasum on a file months later. So the script is
//   lifted out of the rendered HTML, run, and the archive it produces is hashed
//   and compared against the numbers the same document printed.
//
// Nothing here re-runs a producing function and calls the result a check. Every
// assertion reads the emitted page, or runs the page's own script.
//
// Two rules this file deliberately states narrowly, because the wide version
// would fail something correct:
//
//   NO NETWORK means no page pulls an ASSET. qshare and qsetup are served by a
//   loopback server and call back to the process that served them; that is the
//   feature, not a leak.
//
//   NO LITERAL COLOUR is a ratchet, not an absolute. Four `color:#fff`
//   declarations predate this work and two of them cannot be tokenised without
//   breaking a contrast rule in test/glass.mjs that measures every `color:
//   var(--token)` against a surface these are never drawn on. They are listed
//   below by name with the reason each survives; anything NOT on that list is a
//   failure, and shortening the list keeps this green.

import { createHash } from 'node:crypto'
import { runInThisContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { render as renderPact } from '../scripts/render.mjs'
import { render as renderTrends } from '../scripts/render-corpus.mjs'
import { pickerPage } from '../scripts/qshare.mjs'
import { PAGE as setupPage } from '../scripts/qsetup.mjs'
import { LIMITS, NOT_A_CERTIFICATION, BUNDLE_GLOBAL, DOWNLOAD_HOOK, redactionLimit } from '../scripts/bundle.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version

// ------------------------------------------------------------------- reading

const styles = (html) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
const marks = (html) => [...html.matchAll(/<svg class="sv-mark"[\s\S]*?<\/svg>/g)].map((m) => m[0])

/** The three cell populations, counted off the emitted rects. Counted, not
 *  derived by subtraction: "nine minus the two special ones" reports seven
 *  settled for a mark that emitted nine accents and no settled cells at all. */
const cells = (svg) => ({
  total: (svg.match(/<rect /g) || []).length,
  settled: (svg.match(/class="sv-cell sv-settled"/g) || []).length,
  accent: (svg.match(/class="sv-cell sv-accent"/g) || []).length,
  hollow: (svg.match(/class="sv-cell sv-hollow"/g) || []).length,
})

/** The region brandCss() brackets with its own comment sentinels. Lifted out
 *  rather than grepped for: four pages of report CSS around it make a
 *  document-wide search useless for any question about the chrome. */
function brandRegion(css) {
  const a = css.indexOf('/* sv-brand')
  const b = css.indexOf('/* end sv-brand */')
  return a >= 0 && b > a ? css.slice(a, b) : ''
}

/** Every `<script>…</script>` body on the page, in document order. */
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])

// -------------------------------------------------------------- colour rules

const NAMED = /\b(?:red|blue|green|black|white|gray|grey|orange|purple|yellow|pink|brown|silver|gold|navy|teal|olive|lime|aqua|fuchsia|maroon|cyan|magenta)\b/i
const HEX = /#[0-9a-fA-F]{3,8}\b/
const FUNC = /\b(?:rgba?|hsla?|lab|lch|oklch|oklab)\(/i

/**
 * Declarations whose value names a colour outright.
 *
 * Custom properties are exempt: a token declaration is the one place a literal
 * belongs. Anchored on `{` or `;` so a selector is never read as a declaration
 * — without that, `#gcanvas` and `a:hover` both parse as property:value pairs.
 *
 * `var()` references are stripped before the word test, and that is not
 * cosmetic: qsetup declares `--green`, and a naive scan reports
 * `outline:2px solid var(--green)` as a literal colour — a page doing exactly
 * the right thing, failed by the rule meant to enforce it.
 */
function litColours(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const bad = []
  for (const [, prop, raw] of clean.matchAll(/(?:^|[;{])\s*([-a-zA-Z][-\w]*)\s*:\s*([^;{}]*)/g)) {
    if (prop.startsWith('--')) continue
    const value = raw.replace(/var\(\s*--[-\w]+\s*\)/g, ' ')
    if (HEX.test(value) || FUNC.test(value) || NAMED.test(value)) bad.push(`${prop}:${raw.trim()}`)
  }
  return bad
}

/** The same scan over every `style="…"` attribute in the markup. A literal that
 *  moved out of the stylesheet and into an attribute is still a colour that
 *  cannot follow the theme. */
const inlineStyles = (html) =>
  litColours([...html.matchAll(/\sstyle="([^"]*)"/g)].map((m) => `x{${m[1]}}`).join('\n'))

/**
 * Literal colours that predate this work, by page, with the reason each is
 * still here. Membership is a ceiling: a page may carry fewer, never more, and
 * never a different one.
 *
 * The two on /qpact are the interesting case. `button.copy` and `.tag` paint
 * white text on a saturated fill (--accent, --bad). Moving that `#fff` into a
 * token turns it into a `color: var(--token)` declaration, and test/glass.mjs
 * collects every one of those and measures it against the glass panel and the
 * stats cell — surfaces white text is never drawn on. Tokenising them would
 * therefore fail a correct page on a contrast rule in a file this work does not
 * own. Left literal, and reported rather than buried.
 */
const LEGACY_LITERALS = {
  '/qpact': ['color:#fff', 'color:#fff'],
  '/qtrends': ['color:#fff'],
  '/qshare': [],
  '/qsetup': [],
}

/** Assets a page would go and fetch while rendering. `fetch()` back to the
 *  loopback server that served the page is not one of them. */
const ASSET_PULLS = [
  [/@import/, '@import'],
  [/<link[^>]+rel=["']?stylesheet/i, '<link rel=stylesheet>'],
  [/url\(\s*["']?(?:https?:)?\/\//i, 'url() to another host'],
  [/<script[^>]+\bsrc=/i, '<script src>'],
  [/<(?:img|iframe|video|audio|source|embed)[^>]+\bsrc=["']?(?:https?:)?\/\//i, 'remote media src'],
  [/fonts\.(?:googleapis|gstatic)\.com/i, 'Google Fonts'],
]

// ------------------------------------------------------------ page assertions

function brandChecks(page, html) {
  const found = marks(html)
  // Two, not "at least one": the rail and the footer both carry it, and a
  // footer swapped back to a bare grey line still leaves the header's mark
  // sitting there to satisfy a `> 0`.
  chk(`${page}: carries the mark in both the rail and the footer`, found.length === 2,
    `${found.length} <svg class="sv-mark"> on the page`)
  for (const [i, svg] of found.entries()) {
    const c = cells(svg)
    const where = found.length > 1 ? `${page} mark ${i + 1}` : page
    chk(`${where}: 7 settled, 1 accent, 1 hollow, 9 in total`,
      c.settled === 7 && c.accent === 1 && c.hollow === 1 && c.total === 9,
      `settled ${c.settled}, accent ${c.accent}, hollow ${c.hollow}, total ${c.total}`)
  }
  chk(`${page}: the wordmark reads SESSION·VIZ`,
    html.includes('SESSION<span class="sv-sep">·</span>VIZ'),
    'the wordmark markup is not on the page')
  chk(`${page}: the footer states the build that produced it`,
    new RegExp(`<span class="sv-ver">v${VERSION.replace(/\./g, '\\.')}</span>`).test(html),
    `expected v${VERSION} from plugin.json`)

  // A mark with no stylesheet behind it is nine invisible rects and a wordmark
  // in the body font. Every assertion above still passes on that page.
  const region = brandRegion(styles(html))
  chk(`${page}: the brand stylesheet reaches the page`, region.length > 0,
    'no /* sv-brand */ region in any <style> on the page')
  chk(`${page}: and the separator is painted from the brand accent token`,
    /\.sv-sep\{[^}]*color:var\(--sv-accent\)/.test(region))
  chk(`${page}: the mark stops moving under prefers-reduced-motion`,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.sv-cell\.sv-accent\s*\{\s*animation:\s*none/.test(region))
}

function selfContained(page, html) {
  for (const [re, what] of ASSET_PULLS)
    chk(`${page}: no ${what}`, !re.test(html), (html.match(re) || [''])[0].slice(0, 90))
}

function colours(page, html) {
  const allowed = LEGACY_LITERALS[page]
  const found = litColours(styles(html))
  const extra = found.filter((d) => !allowed.includes(d))
  chk(`${page}: no literal colour outside the token blocks beyond the ${allowed.length} known`,
    extra.length === 0 && found.length <= allowed.length,
    `${found.length} found, ${allowed.length} allowed: ${found.join(', ')}`)
  const inline = inlineStyles(html)
  chk(`${page}: and none in a style attribute either`, inline.length === 0, inline.join(', '))
}

// --------------------------------------------------------------------- the zip
//
// Read the way an unzip reads: end record, central directory, then each local
// header at the offset the directory points at. A member is taken from the
// bytes the archive actually carries, never from the payload it was built out
// of — a manifest that describes bytes the archive does not contain is the
// whole failure this section exists for.

function readZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const eocd = buf.length - 22
  if (eocd < 0 || v.getUint32(eocd, true) !== 0x06054b50) throw new Error('no end-of-central-directory record')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const out = []
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`central directory entry ${i} has no signature`)
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const cmtLen = v.getUint16(p + 32, true)
    const off = v.getUint32(p + 42, true)
    if (v.getUint32(off, true) !== 0x04034b50) throw new Error(`local header for entry ${i} has no signature`)
    const lName = v.getUint16(off + 26, true)
    const lExtra = v.getUint16(off + 28, true)
    const size = v.getUint32(off + 22, true)
    const start = off + 30 + lName + lExtra
    out.push({
      name: buf.toString('latin1', p + 46, p + 46 + nameLen),
      method: v.getUint16(off + 8, true),
      bytes: buf.subarray(start, start + size),
    })
    p += 46 + nameLen + extraLen + cmtLen
  }
  return out
}

// ------------------------------------------------------------------- the DOM
//
// Enough document for both listeners on the page to register and fire, with a
// real capture-then-bubble dispatch. That ordering is the point: bundle.mjs
// binds a delegated listener on `document` and render.mjs binds its own in the
// capture phase to put a failure somewhere the reader can see it. If the second
// one does not stop the event, one click writes the file twice.

function makeDom({ downloadAttr = true } = {}) {
  const listeners = []
  const saved = []
  const say = { textContent: '', className: 'evsay' }
  const anchor = () => (downloadAttr
    ? { href: '', download: '', rel: '', click: () => saved.push('saved') }
    : { href: '', rel: '', click: () => saved.push('saved') })
  const doc = {
    addEventListener: (type, fn, capture) => {
      if (type === 'click') listeners.push({ fn, capture: !!capture })
    },
    getElementById: (id) => (id === 'evsay' ? say : null),
    createElement: anchor,
    body: { appendChild() {}, removeChild() {} },
  }
  /** Dispatch, capture phase then bubble. Returns the error if a listener
   *  threw: an exception escaping a click handler is precisely the failure
   *  mode under test here, so it is reported by name rather than allowed to
   *  take the suite down. */
  const click = (onTheButton = true) => {
    let stopped = false
    const ev = {
      target: { closest: (sel) => (onTheButton && sel === `[${DOWNLOAD_HOOK}]` ? {} : null) },
      preventDefault() {},
      stopPropagation() { stopped = true },
    }
    try {
      for (const l of listeners) {
        if (!l.capture) continue
        l.fn(ev)
        if (stopped) return null
      }
      for (const l of listeners) if (!l.capture) l.fn(ev)
    } catch (e) {
      return e
    }
    return null
  }
  return { doc, click, saved, say, listeners }
}

/** Install the page's own scripts against a stubbed document, in document
 *  order, and hand back the API they leave behind. */
function runPageScripts(html, dom) {
  globalThis.document = dom.doc
  globalThis.window = globalThis
  delete globalThis[BUNDLE_GLOBAL]
  for (const [i, body] of scripts(html).entries()) {
    if (!body.includes('atob(') && !body.includes(BUNDLE_GLOBAL)) continue
    // A script that will not parse is reported by the assertion below, not by
    // ending the suite here: the interesting question after a bad edit is which
    // of these promises still holds, and a thrown SyntaxError answers none.
    try { runInThisContext(body, { filename: `qpact-script-${i}.js` }) } catch { /* named below */ }
  }
  return globalThis[BUNDLE_GLOBAL]
}

const teardown = () => {
  delete globalThis.document
  delete globalThis.window
  delete globalThis[BUNDLE_GLOBAL]
}

// ------------------------------------------------------------------ fixtures
//
// No path out of anyone's home directory, and no username: `cwd` is a bare
// directory name on purpose. The scrubbing that would strip a real one is
// test/bundle.mjs's subject, not this file's, and a report page rendered from a
// fixture is not a place to keep a specimen of one.

const turn = (over) => ({
  index: 0,
  promptId: null,
  uuid: 'u-0',
  startedAt: '2026-03-04T08:00:00.000Z',
  endedAt: '2026-03-04T08:04:00.000Z',
  durationMs: 240000,
  text: 'wire the evidence package into the report',
  fullChars: 41,
  hasImage: false,
  typed: true,
  steering: false,
  origin: null,
  signals: { chars: 41, words: 7, terse: false, hasFileRef: true, hasCodeBlock: false, hasUrl: false, isQuestion: false, isCorrection: false, hasAcceptanceCriteria: true },
  tokens: { input: 10, output: 2200, cacheRead: 90000, cacheCreate: 1200 },
  assistantMessages: 4,
  subagents: 0,
  interruptions: 0,
  slashCommands: ['/qpact'],
  effort: null,
  firstToolAt: null,
  timeToFirstToolMs: null,
  toolCalls: [{ name: 'Read', count: 6 }, { name: 'Edit', count: 2 }],
  toolCallCount: 8,
  models: [],
  model: 'claude-opus-5',
  mixedModel: false,
  derived: { noToolCalls: false, clarificationRoundtrip: false, followedByCorrection: false, repeatOf: null },
  friction: [],
  score: { value: 74, deductions: [], additions: [{ points: 6, why: 'named acceptance criteria', tier: 'form' }] },
  ...over,
})

const SPINE = {
  sessionId: '1f2e3d4c-aaaa-bbbb-cccc-ddddeeeeffff',
  file: 'demo-repo.jsonl',
  harness: 'claude-code',
  project: 'demo-repo',
  cwd: 'demo-repo',
  gitBranch: 'main',
  version: '2.1.0',
  title: 'Wire the evidence package',
  startedAt: '2026-03-04T08:00:00.000Z',
  endedAt: '2026-03-04T08:41:00.000Z',
  models: { 'claude-opus-5': 9 },
  artifacts: {
    packages: { zod: 2 }, tools: { git: 4 }, stack: { 'package.json': 1 },
    extensions: { mts: 12 }, skills: {}, mcp: {}, fileTouches: 14,
  },
  slashCommands: ['/qpact'],
  permissionModes: [{ ts: '2026-03-04T08:00:01.000Z', mode: 'acceptEdits' }],
  totals: {
    records: 812, humanTurns: 2, assistantMessages: 44, toolCalls: 12, sidechainRecords: 3,
    interruptions: 1, compactions: 0, steeringTurns: 1, frictionTurns: 1, frictionRate: 0.5,
    repeats: 0, corrections: 1,
    tokens: { input: 4100, output: 51200, cacheRead: 9100000, cacheCreate: 220000 },
  },
  turns: [
    turn({}),
    turn({ index: 1, uuid: 'u-1', text: 'no, the other way', fullChars: 17, friction: ['correction'], interruptions: 1, steering: true }),
  ],
  score: { value: 68, band: 'mixed', confidence: 'medium', turnsScored: 2, frictionRate: 0.5, craftRate: 0.5, wastedTokens: 400 },
  durationMs: 2460000,
}

const INTENT = {
  tldr: 'Wired the package in.',
  compactInstruction: 'keep the packager',
  intents: [{ title: 'Ship it', status: 'done', summary: 'Built and wired', turns: [0, 1] }],
  quality: { verdict: 'solid', strengths: ['tested'], weaknesses: [], recommendations: [] },
  sessionId: '1f2e3d4c-aaaa-bbbb-cccc-ddddeeeeffff',
}

/**
 * The narrowest thing `render()` will accept, which is not a hypothetical: it
 * is the shape test/brand.mjs hands it. render.mts declares its own view of a
 * spine and that view guarantees none of the thirty fields the packager reads,
 * so this fixture is the one that catches a packager wired straight to the
 * session object instead of through the adapter.
 */
const THIN = {
  sessionId: 'abcdef01-2345-6789-abcd-ef0123456789',
  title: 'A thin session', cwd: 'demo', gitBranch: 'main', durationMs: 60000,
  totals: {
    humanTurns: 1, toolCalls: 9, tokens: { output: 100, cacheRead: 200 },
    frictionTurns: 1, repeats: 0, interruptions: 0, steeringTurns: 1, records: 40,
  },
  turns: [{
    index: 0, text: 'thin', friction: [], signals: {}, toolCalls: [], toolCallCount: 0,
    tokens: { output: 1 }, durationMs: 10, derived: { repeatOf: null },
    score: { value: 70, deductions: [], additions: [] },
  }],
  score: null,
}

const CORPUS = {
  meta: {
    sessionCount: 4, turnCount: 31, projectCount: 2,
    harnesses: { 'claude-code': 4 },
    span: { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z', days: 7 },
    transcriptBytes: 7 * 1048576,
    subagents: { files: 6, bytes: 2048 },
    filter: { project: null, since: null },
    excluded: { noHumanTurns: 0, outOfWindow: 0, transcriptsFound: 4 },
    failures: [],
  },
  totals: {
    tokens: { input: 10, output: 20, cacheRead: 30, cacheCreate: 40 },
    frictionRate: 0, reworkRate: 0, craftRate: 0, repeats: 0, interruptions: 0,
  },
  trend: { measurable: false, why: 'one week of data' },
  timeline: [], taxonomy: {}, signals: [],
  models: { rollup: [], pairs: [] },
  graph: {
    nodes: [], edges: [],
    layout: { width: 1000, height: 620, positions: {} },
    related: [], bridges: [], isolated: [],
    gate: { minRepos: 2, universalAt: 5, repoCount: 1 },
  },
  projects: [], sessions: [],
  exemplars: { repeats: [], corrections: [], worst: [] },
  incidents: [], caveats: ['a caveat'],
}

const ROWS = [
  { ref: 'alpha', name: 'alpha', cwd: 'alpha', sessions: 5, turns: 40, bytes: 4096, textFields: 12, ambiguous: false, harnesses: [['claude-code', 5]] },
]

// ==================================================================== 1. chrome

console.log('\n1. the chrome, on every wrapper')

const PAGES = {
  '/qpact': renderPact(SPINE, INTENT, { fingerprint: 'ab12cd34', spineAgeMin: 3 }),
  '/qtrends': renderTrends(CORPUS),
  '/qshare': pickerPage(ROWS, 'test-nonce', new Set()),
  '/qsetup': setupPage('nonce123', 'https://example.invalid', '~/.claude/settings.json', ''),
}

for (const [page, html] of Object.entries(PAGES)) {
  brandChecks(page, html)
  selfContained(page, html)
  colours(page, html)
}

const pact = PAGES['/qpact']

// ================================================================ 2. provenance

console.log('\n2. what /qpact has always printed, after the logo landed')

for (const fragment of [
  'generated by /qpact · ',
  '812 records analysed',
  'prompts redacted for secrets',
  'fingerprint <b>ab12cd34</b>',
  'spine extracted 3 min ago',
]) chk(`/qpact: still prints "${fragment}"`, pact.includes(fragment))

// Pasting the branded footer in ABOVE the old one instead of over it passes
// every assertion above and ships a page that prints its provenance twice.
const feet = (pact.match(/<footer\b/g) || []).length
chk('/qpact: exactly one footer', feet === 1, `got ${feet}`)

// The title, the subtitle and the theme control are all still on the page, and
// the theme control moved INTO the rail rather than being dropped on the way.
chk('/qpact: the title survived the rail', pact.includes('<h1>Wire the evidence package</h1>'))
chk('/qpact: and the session subtitle under it',
  /<div class="sub">1f2e3d4c-[^<]*·[^<]*main<\/div>/.test(pact))
chk('/qpact: the theme button sits in the brand rail, not in a second strip',
  /<span class="sv-acts"><button id="theme"/.test(pact),
  'no #theme inside the header actions slot')
chk('/qpact: and the page still has exactly one of it',
  (pact.match(/id="theme"/g) || []).length === 1)

// The rail is above the title, and there is one of it. Two headers is the
// banner this was asked not to become.
chk('/qpact: one brand rail, above the title',
  (pact.match(/<header class="sv-brand/g) || []).length === 1 &&
  pact.indexOf('<header class="sv-brand') < pact.indexOf('<h1>'),
  `${(pact.match(/<header class="sv-brand/g) || []).length} rails`)

// graph-view.mjs takes the graph's <svg> as "from `<svg viewBox` to the FIRST
// `</svg>` in the document", which stopped being the graph the moment a mark
// appeared above it. Until that slice is anchored, this file is the only thing
// checking the group nesting the whole zoom and replay transform depends on.
{
  const at = pact.indexOf('<svg viewBox')
  const svg = at < 0 ? '' : pact.slice(at, pact.indexOf('</svg>', at))
  chk('/qpact: one group still wraps both edges and nodes',
    /<g id="gview">\s*<g id="gedges">/.test(svg) && svg.indexOf('<g id="gnodes">') > svg.indexOf('<g id="gview">'),
    `graph svg slice is ${svg.length} bytes`)
  chk('/qpact: and the graph svg paints nothing with an inline fill', svg.length > 0 && !/fill="#/.test(svg))
}

// ================================================================= 3. the offer

console.log('\n3. the package, as the page offers it')

chk('/qpact: the button is on the page, carrying the documented hook',
  new RegExp(`<button id="evgo"[^>]*\\b${DOWNLOAD_HOOK}\\b[^>]*>`).test(pact),
  `no [${DOWNLOAD_HOOK}] button`)
chk('/qpact: and one plain sentence of what the file is',
  pact.includes('a record you can hand to someone who asks, not a certificate that anything was compliant'))
chk('/qpact: with somewhere for the page to answer back',
  /<p class="evsay" id="evsay" role="status">/.test(pact))

// A stray backtick, or a brace that never closes, in a script that lives inside
// a template literal. The compiler cannot see it, no markup check notices, and
// the page dies silently in a browser — which has happened in this repo twice.
// Parsed rather than run: the graph script needs a document, and parsing is the
// half that catches this.
{
  const all = scripts(pact)
  for (const [i, body] of all.entries()) {
    let err = null
    try { new Function(body) } catch (e) { err = e }
    chk(`/qpact: inline script ${i + 1} of ${all.length} parses`, !err, err && err.message)
  }
}

// The limits are rendered server-side, so they are readable with scripting off
// and — the point — BEFORE the download rather than after the unzip.
//
// Searched inside the rendered <ol>, not anywhere on the page, and against the
// text as the page ESCAPES it. Both halves are load-bearing and neither was
// obvious: bundleScript embeds the same sentences as JSON so a page can print
// them itself, so a whole-document `includes` passes on a page that renders
// none of them — and it passes on the raw text, which the markup never carries
// because every apostrophe in these sentences is escaped to &#39;.
const escLike = (x) => x.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const evlim = (pact.match(/<ol class="evlim">[\s\S]*?<\/ol>/) || [''])[0]
const SPINE_LIMITS = [redactionLimit(SPINE), ...LIMITS]
const missing = SPINE_LIMITS.filter((l) => !evlim.includes(escLike(l)))
chk(`/qpact: all ${SPINE_LIMITS.length} limits are printed beside the button`,
  missing.length === 0 && evlim.length > 0,
  `${missing.length} missing from a ${evlim.length}-byte list, first: ${(missing[0] || '').slice(0, 60)}`)
chk('/qpact: and the count in the summary matches the list',
  pact.includes(`What this record cannot show — ${SPINE_LIMITS.length} limits`))

// A record, not a certificate. Naming a framework invites the reader to hear a
// conformance claim however the sentence around it is worded.
const card = pact.slice(pact.indexOf('<h2>Evidence package</h2>'), pact.indexOf('<h2>Turns</h2>'))
for (const word of ['EU AI Act', 'GDPR', 'SOC 2', 'ISO ', 'HIPAA', 'NIST', 'PCI-DSS', /\bArticle \d/])
  chk(`/qpact: the card names no framework (${word})`,
    !(word instanceof RegExp ? word.test(card) : card.includes(word)))

// The self-description, with the limits list cut out of it. The limits are
// where "verified" belongs — "no part of it was verified" is the opposite of a
// claim — and scanning them for the word fails the page for saying the right
// thing. What is checked is the prose that speaks in the page's own voice.
const claims = card.replace(/<ol class="evlim">[\s\S]*?<\/ol>/, '')
for (const word of ['Certified', 'Verified', 'Trusted', 'Official', 'Attests', 'Guarantees', 'Assures'])
  chk(`/qpact: and does not call itself "${word}"`, !new RegExp(`\\b${word}\\b`, 'i').test(claims))
chk('/qpact: the only "compliant" on the card is the one denying it',
  (claims.match(/compliant/gi) || []).length === 1 &&
  claims.includes('not a certificate that anything was compliant'))

// ====================================================== 4. digests vs the bytes

console.log('\n4. the digests the page printed, against the bytes the page writes')

{
  const dom = makeDom()
  const api = runPageScripts(pact, dom)
  chk('/qpact: the page installs the packager on window', !!api && typeof api.build === 'function',
    `window.${BUNDLE_GLOBAL} is ${typeof api}`)

  if (api) {
    const buf = Buffer.from(await api.build().arrayBuffer())
    const entries = readZip(buf)

    chk('/qpact: the archive holds every member the page listed',
      entries.length === api.members.length &&
      entries.every((e, i) => e.name === api.members[i].name),
      `${entries.map((e) => e.name).join(', ')} vs ${api.members.map((m) => m.name).join(', ')}`)

    // The assertion this whole file exists for. Recomputed over what came OUT
    // of the archive, never over the base64 that went in.
    for (const [i, e] of entries.entries()) {
      const got = createHash('sha256').update(e.bytes).digest('hex')
      const want = api.members[i]?.sha256
      chk(`/qpact: ${e.name} hashes to the digest the page embedded`, got === want,
        `page says ${String(want).slice(0, 16)}…, archive is ${got.slice(0, 16)}…`)
      chk(`/qpact: ${e.name} is stored, not deflated`, e.method === 0, `method ${e.method}`)
    }

    // The digest is also PRINTED, in the file list a reader opens. A page whose
    // script embeds one hash and whose markup prints another is worse than one
    // that prints none: it looks checkable and is not.
    for (const m of api.members)
      chk(`/qpact: ${m.name}'s digest is printed on the page too`,
        pact.includes(`<span class="evdg">${m.sha256}</span>`), m.sha256.slice(0, 16))

    // And the size beside the button describes the archive that button writes.
    const kb = `${Math.round(buf.length / 1024)} KB`
    chk('/qpact: the size printed beside the button is the archive that gets written',
      pact.includes(`${api.members.length} files · ${kb} ·`),
      `assembled ${buf.length} bytes -> "${kb}", page says "${(pact.match(/files · [^<·]*/) || [''])[0]}"`)

    const manifest = entries.find((e) => e.name === 'manifest.json')
    chk('/qpact: manifest.json is the first member, so an unzip lists it first',
      entries[0]?.name === 'manifest.json', entries[0]?.name)
    chk('/qpact: and it carries the disclaimer verbatim',
      manifest && manifest.bytes.toString('utf8').includes(JSON.stringify(NOT_A_CERTIFICATION).slice(1, -1)))
    chk('/qpact: the package is tied to the fingerprint the footer prints',
      manifest && manifest.bytes.toString('utf8').includes('"fingerprint": "ab12cd34"'))

    // One clock reading for the page: the footer's stamp and the manifest's
    // generatedAt are the same moment, so a reader holding the zip beside the
    // page is comparing one fact rather than two reads.
    const stamp = (pact.match(/generated by \/qpact · (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/) || [])[1]
    chk('/qpact: the manifest names the same moment the footer prints',
      !!stamp && manifest.bytes.toString('utf8').includes(`"generatedAt": "${stamp.replace(' ', 'T')}:00.000Z"`),
      `footer says ${stamp}`)
  }
  teardown()
}

// Byte-identical renders. /qpact names its output file after a hash of its
// INPUTS so an unchanged spine reuses the same document; a full-precision
// timestamp inside the package would have retired that quietly.
chk('/qpact: two renders of one spine are byte-identical',
  renderPact(SPINE, INTENT, { fingerprint: 'ab12cd34', spineAgeMin: 3 }) === pact)

// =============================================== 5. what happens when it cannot

console.log('\n5. the click, where downloads are refused')

{
  // Happy path first, and once. Both listeners are live on this document.
  const dom = makeDom()
  const api = runPageScripts(pact, dom)
  const threw = dom.click()
  chk('a click on the button hands exactly one file to the browser',
    !threw && dom.saved.length === 1, `${dom.saved.length} downloads${threw ? `, and a listener threw: ${threw.message}` : ''}`)
  chk('and the page says what it did',
    dom.say.textContent.includes(api.filename), JSON.stringify(dom.say.textContent))
  // The page is never told whether the file reached the disk. Claiming a save
  // would be the one sentence on this page nothing measured.
  chk('without claiming the file was saved',
    !/\bsaved\b/i.test(dom.say.textContent) && dom.say.className === 'evsay',
    `${dom.say.className}: ${dom.say.textContent}`)
  chk('and it names what to do if nothing appeared',
    /downloads are blocked/i.test(dom.say.textContent))

  const before = dom.saved.length
  dom.click(false)
  chk('a click anywhere else is left alone', dom.saved.length === before)
  teardown()
}

{
  // A browser whose anchors have no download attribute. Refused before a byte
  // is built, and said out loud.
  const dom = makeDom({ downloadAttr: false })
  runPageScripts(pact, dom)
  const threw = dom.click()
  chk('an anchor with no download attribute fails visibly, not silently',
    !threw && dom.saved.length === 0 && dom.say.className === 'evsay bad' &&
    /will not save/.test(dom.say.textContent),
    threw ? `it threw instead: ${threw.message}` : `${dom.say.className}: ${dom.say.textContent}`)
  teardown()
}

{
  // The blob URL refused at the moment of use — the shape a hardened viewer
  // takes. This one throws from INSIDE the packager's own download(), which is
  // the failure that reaches the console and nowhere else without the wrapper.
  const realURL = globalThis.URL
  const dom = makeDom()
  runPageScripts(pact, dom)
  globalThis.URL = { createObjectURL() { throw new Error('object URLs are blocked here') } }
  let threw
  try { threw = dom.click() } finally { globalThis.URL = realURL }
  chk('a blob URL refused mid-download is reported on the page',
    !threw && dom.saved.length === 0 && dom.say.className === 'evsay bad' &&
    dom.say.textContent.includes('object URLs are blocked here'),
    threw ? `it escaped the handler instead: ${threw.message}` : `${dom.say.className}: ${dom.say.textContent}`)
  teardown()
}

{
  // The packager script itself missing — a page truncated in transit, or a CSP
  // that dropped one script element and not the other.
  const dom = makeDom()
  globalThis.document = dom.doc
  globalThis.window = globalThis
  delete globalThis[BUNDLE_GLOBAL]
  const ui = scripts(pact).find((s) => s.includes("getElementById('evsay')"))
  chk('the page has a script that binds the button', !!ui)
  if (ui) {
    // Tolerant for the same reason runPageScripts is: a script that will not
    // parse is a named failure above, not the end of the run.
    let parsed = true
    try { runInThisContext(ui, { filename: 'qpact-evidence-ui.js' }) } catch { parsed = false }
    chk('and that script parses on its own', parsed)
    const threw = dom.click()
    chk('a missing packager is reported rather than swallowed',
      !threw && dom.say.className === 'evsay bad' && /did not load/.test(dom.say.textContent),
      threw ? `it threw instead: ${threw.message}` : `${dom.say.className}: ${dom.say.textContent}`)
  }
  teardown()
}

// ==================================================== 6. the thin spine renders

console.log('\n6. a spine narrower than the packager reads')

{
  let thin = ''
  let boom = null
  try { thin = renderPact(THIN, null, {}) } catch (e) { boom = e }
  chk('/qpact renders from the narrowest session render() accepts',
    !boom && thin.includes('<h1>A thin session</h1>') && thin.includes(`${DOWNLOAD_HOOK}`),
    boom ? `render() threw: ${boom.message}` : 'the page rendered but carries no button')
  const dom = makeDom()
  const api = thin ? runPageScripts(thin, dom) : null
  chk('and the package it offers is still a readable archive',
    !!api && readZip(Buffer.from(await api.build().arrayBuffer())).length === api.members.length)
  chk('with intent.json omitted when there is no intent',
    !!api && !api.members.some((m) => m.name === 'intent.json'),
    (api?.members || []).map((m) => m.name).join(', '))
  teardown()
}

// ==================================================================== 7. itself
//
// Every scanner above is a claim that something would have been caught. These
// are the checks that the scanners can fail at all.

console.log('\n7. the checks themselves')

const eight = cells('<svg class="sv-mark">' + '<rect class="sv-cell sv-settled"/>'.repeat(8) + '<rect class="sv-cell sv-accent"/></svg>')
chk('an eight-settled mark counts as eight, not seven',
  eight.settled === 8 && eight.accent === 1 && eight.hollow === 0, JSON.stringify(eight))

const planted = litColours('.x{color:#ff8a4c}.y{border:1px solid var(--sv-line)}.z{outline:2px solid var(--green)}')
chk('the colour scan finds a planted literal and nothing else',
  planted.length === 1 && planted[0].includes('#ff8a4c'), JSON.stringify(planted))

chk('the colour scan does not read var(--green) as the colour green',
  litColours('.z{color:var(--green)}').length === 0)

chk('the inline-style scan finds a literal in an attribute',
  inlineStyles('<p style="color:#b3261e">x</p>').length === 1)

chk('the asset scan finds a planted webfont',
  ASSET_PULLS.some(([re]) => re.test('<style>@import url(https://fonts.googleapis.com/css)</style>')))

// A zip reader that never rejects anything proves nothing about the archives it
// accepted. Corrupt the end-record signature and it has to refuse.
{
  const dom = makeDom()
  const api = runPageScripts(pact, dom)
  const buf = Buffer.from(await api.build().arrayBuffer())
  const wrecked = Buffer.from(buf)
  wrecked.writeUInt32LE(0xdeadbeef, wrecked.length - 22)
  let refused = false
  try { readZip(wrecked) } catch { refused = true }
  chk('the zip reader refuses an archive with no end record', refused)

  // And a digest that does not describe its bytes has to be visible as one.
  const entry = readZip(buf)[1]
  const wrong = createHash('sha256').update(Buffer.concat([entry.bytes, Buffer.from('x')])).digest('hex')
  chk('a digest over different bytes does not match',
    wrong !== createHash('sha256').update(entry.bytes).digest('hex'))
  teardown()
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
