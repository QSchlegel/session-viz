// The brand chrome, asserted against the pages that actually emit it.
//
// Three things this has to catch, and one it must not pretend to.
//
//   1. THE COUNT. The mark is nine cells: seven settled, one accent, one
//      hollow. This project's own prose said "eight settled" for months and the
//      sentence was copied into a brand kit before anyone counted the rects. A
//      count that lives in a comment is a count that drifts; this one is read
//      back off the emitted SVG of every page.
//
//   2. THE PROVENANCE. Every fragment these footers used to print is the reason
//      anyone believes the numbers above it — how many records were read, which
//      fingerprint the reading has, that prompts were redacted first. Wrapping
//      the footer in a logo is exactly the change that quietly drops one, and
//      the loss is invisible: the page still ends in a tidy grey line.
//
//   3. SELF-CONTAINMENT. These pages are opened from file://. A stylesheet
//      link, a webfont or any url(http…) is a page that renders differently
//      offline and phones home when it does not. The brand chrome is the newest
//      code on every one of them and therefore the likeliest place for one to
//      appear.
//
// What it does NOT do is grep whole documents for `fetch(`. qshare and qsetup
// are served by a loopback HTTP server and talk back to the process that served
// them; that is the feature. The rule being enforced here is narrower and
// checkable: no page pulls an ASSET from anywhere, and the brand chrome itself
// contains no URL at all.
//
// Everything is read off render output. Re-running the producing code would
// pass on a helper that is correct and never called — which is the shape of
// nearly every bug this file exists for.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { render as renderTrends } from '../scripts/render-corpus.mjs'
import { pickerPage } from '../scripts/qshare.mjs'
import { PAGE as setupPage, done as setupDone } from '../scripts/qsetup.mjs'
import { MIN_MARK } from '../scripts/brand.mjs'

// src/render.mts is the one wrapper this stream does not own, so the chrome
// reaches it as a snippet somebody else pastes. SV_BRAND_QPACT points these
// assertions at a candidate build of that file, so the snippet can be run
// against them BEFORE it lands rather than after. Unset — which is how CI runs
// it — this is the ordinary import.
const { render: renderPact } = await import(process.env.SV_BRAND_QPACT || '../scripts/render.mjs')

let failed = 0

const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const note = (s) => console.log(`     ${s}`)

const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = JSON.parse(
  readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8'),
).version

// ------------------------------------------------------------------ reading

/** Every `<svg class="sv-mark">…</svg>` on the page, as raw markup. */
const marks = (html) => [...html.matchAll(/<svg class="sv-mark"[\s\S]*?<\/svg>/g)].map((m) => m[0])

/**
 * The three cell populations, counted off the emitted rects.
 *
 * Counts `sv-settled` explicitly rather than subtracting: "nine total minus the
 * two special ones" would report seven settled for a mark that emitted nine
 * accent cells and no settled ones at all.
 */
const cells = (svg) => ({
  total: (svg.match(/<rect /g) || []).length,
  settled: (svg.match(/class="sv-cell sv-settled"/g) || []).length,
  accent: (svg.match(/class="sv-cell sv-accent"/g) || []).length,
  hollow: (svg.match(/class="sv-cell sv-hollow"/g) || []).length,
})

const styles = (html) =>
  [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')

/** The region `brandCss()` brackets with its own comment sentinels. */
function brandRegion(css) {
  const a = css.indexOf('/* sv-brand')
  const b = css.indexOf('/* end sv-brand */')
  return a >= 0 && b > a ? css.slice(a, b) : ''
}

const chrome = (html) =>
  [...html.matchAll(/<header class="sv-brand[\s\S]*?<\/header>/g),
   ...html.matchAll(/<footer class="sv-foot[\s\S]*?<\/footer>/g)].map((m) => m[0]).join('\n')

// ------------------------------------------------------------- colour rules

const NAMED = /\b(?:red|blue|green|black|white|gray|grey|orange|purple|yellow|pink|brown|silver|gold|navy|teal|olive|lime|aqua|fuchsia|maroon|cyan|magenta)\b/i
const HEX = /#[0-9a-fA-F]{3,8}\b/
const FUNC = /\b(?:rgba?|hsla?|lab|lch|oklch|oklab)\(/i

/**
 * Declarations whose value names a colour outright.
 *
 * Anchored on `{` or `;` so a selector is never mistaken for a declaration —
 * without that, the id selector `#go` and the pseudo-class in `a:hover` both
 * read as `property:value` pairs and the whole scan turns to noise.
 *
 * Custom properties are exempt on purpose: a token declaration is the ONE place
 * a literal belongs. Everything else has to go through var().
 */
function litColours(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  const bad = []
  for (const [, prop, value] of clean.matchAll(/(?:^|[;{])\s*([-a-zA-Z][-\w]*)\s*:\s*([^;{}]*)/g)) {
    if (prop.startsWith('--')) continue
    if (HEX.test(value) || FUNC.test(value) || NAMED.test(value)) bad.push(`${prop}:${value.trim()}`)
  }
  return bad
}

// ------------------------------------------------------------------ contrast
//
// Both sides read off the rendered page: the brand's own tokens out of the
// sv-brand region, the surface they land on out of whatever the host page
// declared. Pinning a list of background colours here would pass forever after
// a page repainted itself, which is the interesting case rather than the
// uninteresting one.

const lin = (c) => (c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
function luminance(hex) {
  const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, '$&$&').slice(1) : hex.slice(1)
  const n = parseInt(h.slice(0, 6), 16)
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The `{…}` body of the first block whose selector matches, or ''. */
function block(css, selector) {
  const i = css.indexOf(selector)
  if (i < 0) return ''
  const open = css.indexOf('{', i)
  return open < 0 ? '' : css.slice(open + 1, css.indexOf('}', open))
}
const token = (body, name) => (body.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`)) || [])[1]

/**
 * The separator is a text glyph and owes 4.5:1; the cells are a graphic and owe
 * 3:1. The one that actually bites is the accent — it is the token most likely
 * to be "corrected" back to whatever the report palette uses, and on qsetup's
 * warmer background that costs it AA.
 */
function contrast(page, html) {
  const css = styles(html)
  const region = brandRegion(css)
  for (const [theme, brandSel, hostSel] of [
    ['light', ':root{', ':root{'],
    ['dark', ':root[data-theme=dark]{', ':root[data-theme=dark]{'],
  ]) {
    const b = block(region, brandSel)
    const host = block(css.replace(region, ''), hostSel)
    const surfaces = ['--bg', '--card']
      .map((t) => token(host, t)).filter(Boolean)
    if (!surfaces.length) { chk(`${page} (${theme}): host surface found`, false, hostSel); continue }
    for (const surface of surfaces) {
      for (const [tok, floor, what] of [['--sv-accent', 4.5, 'glyph'], ['--sv-cell', 3, 'graphic']]) {
        const fg = token(b, tok)
        const r = fg ? ratio(fg, surface) : 0
        chk(`${page} (${theme}): ${tok} on ${surface} clears ${floor}:1 (${what})`,
          r >= floor, `${fg} on ${surface} is ${r.toFixed(2)}:1`)
      }
    }
  }
}

/** Assets the page would go and fetch while rendering. `fetch()` to the
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

/** The mark's cell kinds in reading order, read off the emitted SVG. */
function layout(svg) {
  return [...svg.matchAll(/<rect[^>]*class="([^"]*)"/g)].map((m) =>
    /sv-accent/.test(m[1]) ? 'accent' : /sv-hollow/.test(m[1]) ? 'hollow' : 'settled')
}

/** Every cell's x, y and width, off the emitted SVG. */
function geometry(svg) {
  return [...svg.matchAll(/<rect[^>]*\sx="([\d.]+)"[^>]*\sy="([\d.]+)"[^>]*\swidth="([\d.]+)"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], w: +m[3] }))
}

// The mark's measurements, from the kit rather than from this file. Canonical
// source: services/web/public/brand/svg/lockup-on-light.svg in the cloud
// repository, and the <g class="lg"> block in the site's index.html — an 8-unit
// cell on a 10-unit pitch, so the gutter is a QUARTER of the cell.
//
// Counting nine cells and checking where they sit is still not enough to
// recognise a mark. This plugin drew the correct nine in the correct
// arrangement at a 6-unit cell on a 9-unit pitch — a gutter HALF its cell — and
// every assertion here passed while the reports carried visibly different
// proportions from every other surface. Where the cells are and how big they
// are are two different questions and both have to be asked.
const KIT_CELL = 8
const KIT_PITCH = 10
/** Kit palette: --cell-struct, --accent and --hatch, light and dark. The accent
 *  is deliberately a shade deeper than the site's #c2521a — see brand.mts, it is
 *  measured for AA on the warmest surface it lands on — so it is not pinned
 *  here; the two that carry no contrast argument are. */
const KIT_CELL_LIGHT = '#5f8a6d'
const KIT_CELL_DARK = '#4c8a63'
const KIT_HATCH_LIGHT = '#9a958c'
const KIT_HATCH_DARK = '#6d6878'
/** brand/usage.md's minimum, spelled out here so the module cannot lower it. */
const KIT_MIN_PX = 24

// The module's own minimum has to BE the kit's. Asserted separately from the
// per-page check that nothing is drawn below it, so the two cannot satisfy each
// other -- which is exactly what they did while the per-page check read its
// threshold from this same constant.
chk(`brand.mts agrees with the kit about the minimum size`, MIN_MARK === KIT_MIN_PX,
  `brand.mts says ${MIN_MARK}px, brand/usage.md says ${KIT_MIN_PX}px`)

/** Everything true of the chrome on every page that carries it. */
function brandChecks(page, html, { plain = false } = {}) {
  const found = marks(html)
  chk(`${page}: page carries the mark`, found.length > 0, 'no <svg class="sv-mark"> in the output')

  for (const [i, svg] of found.entries()) {
    const c = cells(svg)
    const where = found.length > 1 ? `${page} mark ${i + 1}` : page
    chk(`${where}: 7 settled cells`, c.settled === 7, `got ${c.settled}`)
    chk(`${where}: 1 accent cell`, c.accent === 1, `got ${c.accent}`)
    chk(`${where}: 1 hollow cell`, c.hollow === 1, `got ${c.hollow}`)
    chk(`${where}: 9 cells in total`, c.total === 9, `got ${c.total}`)

    // WHERE they are, not only how many. Counting nine cells with a 7/1/1 split
    // passed 214 assertions while the plugin drew a mark whose accent sat
    // bottom-centre and whose hollow sat bottom-right -- a different logo from
    // the product's, agreeing with itself on every page. The arrangement is
    // quoted from the canonical mark, the <g class="lg"> block in the site's
    // index.html, so this fails if either one moves.
    const order = layout(svg)
    chk(`${where}: the accent is top-right, as the site draws it`,
      order[2] === 'accent', `reading order: ${order.join(' ')}`)
    chk(`${where}: the hollow is middle-right, as the site draws it`,
      order[5] === 'hollow', `reading order: ${order.join(' ')}`)
    chk(`${where}: and every other cell is settled`,
      order.filter((_, i) => i !== 2 && i !== 5).every((k) => k === 'settled'),
      order.join(' '))

    // HOW BIG they are, not only where. A 3x3 grid in the right arrangement is
    // still a different logo if its gutters are twice the kit's.
    const g = geometry(svg)
    const xs = [...new Set(g.map((c) => c.x))].sort((a, b) => a - b)
    const pitch = xs.length > 1 ? xs[1] - xs[0] : 0
    const cell = g[0]?.w ?? 0
    chk(`${where}: the cell sits on the kit's pitch, so the gutter is a quarter of the cell`,
      cell === KIT_CELL && pitch === KIT_PITCH,
      `cell ${cell} on pitch ${pitch}; the kit is ${KIT_CELL} on ${KIT_PITCH}`)
    chk(`${where}: all nine cells are the same size`,
      g.length === 9 && g.every((c) => c.w === cell), g.map((c) => c.w).join(' '))

    // Never below the size at which the hollow cell's outline stops being an
    // outline. brand/usage.md computes 24px from a 1.6-unit stroke in a 34-unit
    // box; the footer used to draw this at 15.
    //
    // Held against a LITERAL, not against the module's own MIN_MARK. The first
    // version of this compared the drawn width to the constant that also
    // supplies the default width, so both sides moved together: lowering
    // MIN_MARK back to 15 lowered the bar with it and the check passed on a mark
    // drawn at 15px. A threshold a change can move is not a threshold.
    const drawn = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 0)
    chk(`${where}: is drawn at or above the kit's minimum size`, drawn >= KIT_MIN_PX,
      `drawn at ${drawn}px, and the kit's minimum is ${KIT_MIN_PX}px`)
  }

  chk(`${page}: wordmark reads SESSION·VIZ`,
    html.includes('SESSION<span class="sv-sep">·</span>VIZ'),
    'the wordmark markup is not on the page')

  const css = styles(html)
  const region = brandRegion(css)
  chk(`${page}: separator carries the accent colour`,
    /\.sv-sep\{[^}]*color:var\(--sv-accent\)/.test(region),
    'no .sv-sep rule painting the separator with --sv-accent')

  // THE WORDMARK'S SETTING. brand/typography.md: uppercase, 600, 0.13em, in the
  // sans stack, letters in --ink and the middle dot in --accent. Five surfaces
  // drew these six letters and four of them chose their own weight and tracking
  // -- 700/.1em mono on the site, 600/.13em mono in the console, 800/.13em mono
  // in the launch film -- while every check anybody had asked only whether the
  // letters were present.
  const word = /\.sv-word\{([^}]*)\}/.exec(region)?.[1] ?? ''
  chk(`${page}: the wordmark is set in the sans stack`,
    /var\(--sv-sans\)/.test(word) && !/var\(--sv-mono\)/.test(word), word || 'no .sv-word rule')
  chk(`${page}: at the one weight the kit states`, /\b600\b/.test(word), word)
  chk(`${page}: and the one tracking`, /letter-spacing:\.13em/.test(word), word)
  chk(`${page}: and the letters take the ink, not the accent`,
    /color:var\(--sv-ink\)/.test(word), word)
  // One setting, not one per placement: the footer used to restate the wordmark
  // at 11px and .11em, which is a second specification of the same logo.
  chk(`${page}: nothing restates the wordmark for one placement`,
    !/\.sv-word\{[^}]*\}[\s\S]*\.sv-word\{/.test(region.replace(/\.sv-foot \.sv-word\{[^}]*\}/g, '')) &&
      !/letter-spacing:\.11em/.test(region),
    (region.match(/\.sv-foot \.sv-word\{[^}]*\}/) || [''])[0])

  // The cells and the outline are the kit's colours. The accent is exempt and
  // says why at KIT_CELL_LIGHT above.
  for (const [name, value] of [
    ['settled cells, light', KIT_CELL_LIGHT], ['settled cells, dark', KIT_CELL_DARK],
    ['the unresolved outline, light', KIT_HATCH_LIGHT], ['the unresolved outline, dark', KIT_HATCH_DARK],
  ])
    chk(`${page}: ${name} is the kit's colour`, region.includes(value),
      `${value} is not among the tokens this page declares`)
  // The outline is not painted in the cell colour: the seven settled cells and
  // the unresolved one are two statements, and one token for both said the hole
  // was just a cell drawn differently.
  chk(`${page}: the outline takes --sv-hatch, not the cell colour`,
    /\.sv-hollow\{[^}]*stroke:var\(--sv-hatch\)/.test(region),
    (region.match(/\.sv-hollow\{[^}]*\}/) || [''])[0])

  chk(`${page}: footer states the tool version`,
    new RegExp(`<span class="sv-ver">v${VERSION.replace(/\./g, '\\.')}</span>`).test(html),
    `expected v${VERSION} from plugin.json`)

  // Three theme states and a declared color-scheme in each. The brand paints
  // its own tokens, so a page whose own palette flips and whose logo does not
  // is a logo that vanishes into the background it was drawn against.
  chk(`${page}: tokens on bare :root`, /^\s*:root\{[^}]*--sv-accent:/m.test(region), region.slice(0, 120))
  chk(`${page}: dark under the guarded system query`,
    /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{[^}]*--sv-accent:/.test(region))
  chk(`${page}: dark again under [data-theme=dark]`,
    /:root\[data-theme=dark\]\{[^}]*--sv-accent:/.test(region))
  // The lookbehind is load-bearing: `@media (prefers-color-scheme:dark)` ends in
  // the very string being counted, so a naive count reads four states and calls
  // a page correct that declared only two.
  const schemes = (region.match(/(?<!prefers-)color-scheme:/g) || []).length
  chk(`${page}: color-scheme declared in all three states`, schemes === 3, `got ${schemes}`)

  const reduced = region.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/)
  chk(`${page}: motion is off under prefers-reduced-motion`,
    !!reduced && /\.sv-cell\.sv-accent\s*\{\s*animation:\s*none/.test(reduced[1]),
    reduced ? reduced[1].trim() : 'no prefers-reduced-motion block in the brand region')

  // The mark's animation is one-shot. An infinite one says "still running" on a
  // page that finished before the reader opened it — the exact failure the
  // picker's own comment already names about its frontier cell.
  chk(`${page}: the mark does not loop`, !/animation:[^;}]*infinite/.test(region),
    'an infinite animation in the brand region')

  if (plain) {
    chk(`${page}: header is the plain variant`, /<header class="sv-brand sv-plain">/.test(html))
    chk(`${page}: no command chip`, !/class="sv-cmd"/.test(html),
      'the auth page must not wear a slash-command badge')
    chk(`${page}: no motion on the mark`,
      /\.sv-brand\.sv-plain \.sv-cell\.sv-accent\{animation:none\}/.test(region))
  }

  // No literal anywhere in the chrome — neither in its rules nor in its markup.
  const rules = litColours(region)
  chk(`${page}: no literal colour in the brand rules`, rules.length === 0, rules.join(', '))

  contrast(page, html)

  const markup = chrome(html).replace(/&#\d+;/g, '')
  chk(`${page}: no literal colour in the brand markup`,
    !HEX.test(markup) && !FUNC.test(markup), markup.slice(0, 200))
  chk(`${page}: no URL in the brand chrome`,
    !/https?:|\/\//.test(chrome(html)) && !/https?:/.test(region),
    'the mark is inline SVG and the wordmark is text; neither should reference anything')
}

/** Nothing on this page goes and gets something while it renders. */
function selfContained(page, html) {
  for (const [re, what] of ASSET_PULLS) {
    chk(`${page}: no ${what}`, !re.test(html), (html.match(re) || [''])[0].slice(0, 90))
  }
}

/** Every fragment this page printed before still prints. */
function provenance(page, html, fragments) {
  for (const f of fragments) {
    chk(`${page}: still prints "${f.length > 52 ? f.slice(0, 52) + '…' : f}"`, html.includes(f))
  }
  // Adding a branded footer next to the old one instead of in place of it is
  // the obvious way to pass every assertion above and still ship a page that
  // prints its provenance twice — once in the new chrome and once in a stray
  // grey line beneath it. Nothing else here would notice.
  const n = (html.match(/<footer\b/g) || []).length
  chk(`${page}: exactly one footer`, n === 1, `got ${n}`)
}

// ------------------------------------------------------------------ fixtures

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

const SESSION = {
  sessionId: 'abcdef01-2345-6789-abcd-ef0123456789',
  title: 'A session', cwd: 'demo', gitBranch: 'main', durationMs: 60000,
  totals: {
    humanTurns: 3, toolCalls: 9, tokens: { output: 100, cacheRead: 200 },
    frictionTurns: 1, repeats: 0, interruptions: 0, steeringTurns: 1, records: 812,
  },
  turns: [], score: null,
}

const ROWS = [
  { ref: 'alpha', name: 'alpha', cwd: 'alpha', sessions: 5, turns: 40,
    bytes: 4096, textFields: 12, ambiguous: false, harnesses: [['claude-code', 5]] },
  { ref: 'beta', name: 'beta', cwd: 'beta', sessions: 2, turns: 9,
    bytes: 2048, textFields: 3, ambiguous: false, harnesses: [['cursor', 2]] },
]

// ---------------------------------------------------------------------- run

console.log('\n/qtrends — render-corpus.mjs')
const trends = renderTrends(CORPUS)
brandChecks('/qtrends', trends)
selfContained('/qtrends', trends)
provenance('/qtrends', trends, [
  'generated by /qtrends · ',
  '7 MB of transcript across 4 sessions',
  '6 subagent transcripts not parsed',
  'prompts redacted for secrets',
])

console.log('\n/qshare — the picker')
const picker = pickerPage(ROWS, 'test-nonce', new Set(['alpha']))
brandChecks('/qshare', picker)
selfContained('/qshare', picker)
provenance('/qshare', picker, [
  // The redaction note the page has always carried, in its own words, above the
  // table. The footer restates it; neither is allowed to be the only copy.
  'Absolute paths and your username are stripped before anything leaves',
  '2 projects · 7 sessions counted on this machine',
  '1 already shared',
  'served on 127.0.0.1 — this page never leaves this machine',
])
// The picker's whole page is one template literal and its script lives inside
// it. brandCss() is now interpolated into that literal, so a stray backtick in
// the brand stylesheet would kill the script and leave every checkbox inert —
// with the markup still perfect. test/picker.mjs drives the script; this only
// checks it is still there to be driven.
chk('/qshare: the inline script survived the interpolation',
  /<script>[\s\S]*addEventListener[\s\S]*<\/script>/.test(picker))

console.log('\n/qsetup — connect this machine')
const setup = setupPage('nonce123', 'https://example.invalid', '~/.claude/settings.json', '')
brandChecks('/qsetup', setup, { plain: true })
selfContained('/qsetup', setup)
provenance('/qsetup', setup, [
  'Connect this machine',
  'written by /qsetup — check the address bar says 127.0.0.1 before typing a token',
])
// A local auth page must not dress up. These are the words that would make it
// look like it had authority it does not have.
for (const word of ['Verified', 'Secure', 'Official', 'Trusted', 'Certified']) {
  chk(`/qsetup: does not call itself "${word}"`, !new RegExp(`\\b${word}\\b`, 'i').test(setup))
}

console.log('\n/qsetup — the loopback reply')
const reply = setupDone('Connected', 'Scope collab, workspace acme.')
brandChecks('/qsetup reply', reply, { plain: true })
selfContained('/qsetup reply', reply)
provenance('/qsetup reply', reply, ['Connected', 'Scope collab, workspace acme.'])

// The same page in its redirecting form. This arm carries a meta refresh and a
// link out to the workspace — the one place in the plugin where a rendered page
// legitimately names a remote URL, and therefore the one place where an
// over-eager "no network" rule would start failing something correct.
const bounce = setupDone('Connected', 'Taking you back.', 'https://example.invalid/app')
brandChecks('/qsetup redirect', bounce, { plain: true })
selfContained('/qsetup redirect', bounce)
provenance('/qsetup redirect', bounce, ['Open your workspace'])

console.log('\n/qpact — render.mjs')
const pact = renderPact(SESSION, null, { fingerprint: 'ab12cd34', spineAgeMin: 3 })
// Hard today, and the regression guard for the handoff: every one of these has
// to survive whatever wraps the footer.
provenance('/qpact', pact, [
  'generated by /qpact · ',
  '812 records analysed',
  'prompts redacted for secrets',
  'fingerprint <b>ab12cd34</b>',
  'spine extracted 3 min ago',
])
selfContained('/qpact', pact)
if (marks(pact).length) {
  brandChecks('/qpact', pact)
} else {
  note('/qpact carries no brand chrome yet. src/render.mts belongs to another')
  note('agent this round; the snippet is in the handoff. These checks arm')
  note('themselves the moment the mark appears in the output — no edit here.')
}

// --------------------------------------------------------------- self-check
//
// A counter that returned 7 unconditionally would pass every assertion above
// while the pages shipped eight settled cells. So it is shown a mark that is
// deliberately wrong, and has to say so.

console.log('\nthe counter itself')
const EIGHT = '<svg class="sv-mark">' +
  '<rect class="sv-cell sv-settled"/>'.repeat(8) +
  '<rect class="sv-cell sv-accent"/></svg>'
const wrong = cells(EIGHT)
chk('an eight-settled mark is counted as eight, not seven',
  wrong.settled === 8 && wrong.accent === 1 && wrong.hollow === 0,
  JSON.stringify(wrong))

// And a scanner that never finds a colour is a scanner that guards nothing.
const planted = litColours('.x{color:#ff8a4c}.y{border:1px solid var(--sv-line)}')
chk('a planted literal colour is found', planted.length === 1 && planted[0].includes('#ff8a4c'),
  JSON.stringify(planted))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
