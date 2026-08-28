// The turn cards on the /qpact report.
//
// Two defects, both measured before anything was changed and both re-measured
// here on the page render() actually emits:
//
//   the card did not exist as an object   --panel on --bg was 1.04:1 light and
//                                         1.09:1 dark, and the --line border
//                                         that was supposed to rescue it was
//                                         1.29:1 against the card's own fill.
//                                         A column of turns was one grey field.
//
//   the contents had no rank              .idx, .meta, .tool and .chip were all
//                                         --muted at 11-12px. The number a
//                                         reader scans for, the number they
//                                         navigate by and the reference detail
//                                         were the same object four times.
//
// What is NOT the defect, and what this file must not be "fixed" into becoming:
// contrast. --muted on --panel is 5.55:1 light and 5.69:1 dark. Both clear AA
// and both are printed below, so darkening every grey to make a number go up
// would show here as the hierarchy collapsing again rather than as a win.
//
// Nothing below hardcodes a colour, a size or a ratio it then asserts on. The
// palette, the aura geometry, the panel alpha, the type scale and the grid are
// all read back out of the emitted document, so a change to any of them moves
// these numbers. The recurring defect in this repo is a check that passes by
// not looking.
import { render } from '../scripts/render.mjs'

// A CPU-bound synchronous sampling loop cannot be rescued by a setTimeout: the
// timer never gets a turn. The bound has to be one the loop itself reads.
const DEADLINE = Date.now() + 60000
const tick = (where) => {
  if (Date.now() > DEADLINE) {
    console.log(`\nFAIL cards.mjs exceeded 60s in ${where} — a sampling loop lost its bound`)
    process.exit(1)
  }
}

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

// ---------------------------------------------------------------- a stylesheet
//
// Brace-matching, enough of a parser to know which rules sit inside which
// at-rule. That is the whole question for @supports and @media.
const parse = (css) => {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const read = (from, to, at) => {
    const out = []
    let i = from
    let start = i
    while (i < to) {
      const c = src[i]
      if (c === "'" || c === '"') {
        const q = c
        i++
        while (i < to && src[i] !== q) i += src[i] === '\\' ? 2 : 1
        i++
        continue
      }
      if (c === '{') {
        let depth = 1
        let j = i + 1
        while (j < to && depth) {
          if (src[j] === '{') depth++
          else if (src[j] === '}') depth--
          j++
        }
        if (depth) throw new Error(`unbalanced brace at offset ${i}`)
        const prelude = src.slice(start, i).trim()
        const node = { at, prelude, body: src.slice(i + 1, j - 1) }
        if (prelude.startsWith('@')) node.children = read(i + 1, j - 1, [...at, prelude])
        out.push(node)
        i = j
        start = i
      } else i++
    }
    return out
  }
  const flat = []
  const walk = (nodes) => nodes.forEach((n) => { flat.push(n); if (n.children) walk(n.children) })
  walk(read(0, src.length, []))
  return flat
}

/** Declarations of one rule body, in source order, top level only. */
const decls = (body) => {
  const out = []
  let depth = 0
  let buf = ''
  for (const c of body) {
    if (c === '{') depth++
    else if (c === '}') depth--
    if (c === ';' && depth === 0) { out.push(buf); buf = '' } else buf += c
  }
  if (buf.trim()) out.push(buf)
  return out
    .map((d) => d.trim())
    .filter((d) => d && !d.startsWith('@') && d.includes(':') && !d.endsWith('}'))
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])
}

const selectors = (prelude) => prelude.split(',').map((s) => s.trim()).filter(Boolean)

// --------------------------------------------------------------- one document
//
// Six turns, one of them friction, one of them scoring low enough to take the
// .low chip. Every assertion below reads this same page.
const turn = (index, extra = {}) => ({
  index,
  text: `turn ${index} — a prompt long enough to be the widest thing in its row`,
  durationMs: 1000 + index * 250,
  friction: index === 3 ? ['roundtrip'] : [],
  signals: { terse: index === 1, hasAcceptanceCriteria: index === 2 },
  toolCalls: [{ name: 'Read', count: 2 }],
  toolCallCount: 2,
  tokens: { output: 40 },
  derived: { repeatOf: null },
  score: { value: index === 4 ? 41 : 88, deductions: [], additions: [] },
  ...extra,
})
const SESSION = {
  sessionId: 'abcd1234-0000-0000-0000-000000000000', harness: 'claude-code', cwd: '/w/demo',
  gitBranch: 'main', durationMs: 60000, models: { 'claude-opus-5': 4 }, slashCommands: [],
  permissionModes: [],
  artifacts: { tools: { git: 2 }, mcp: {}, packages: {}, stack: {}, extensions: {}, skills: {}, fileTouches: 3 },
  totals: { humanTurns: 6, toolCalls: 12, tokens: { output: 900, cacheRead: 4000 }, frictionTurns: 1, repeats: 0, interruptions: 0, steeringTurns: 1, records: 40 },
  score: { value: 88, band: 'solid', confidence: 'high', turnsScored: 6, frictionRate: 0.16, craftRate: 0, wastedTokens: 0, costliestTurn: 0 },
  turns: Array.from({ length: 6 }, (_, i) => turn(i, i === 5 ? { steering: { note: 'redirected' } } : {})),
}

const html = render(SESSION, { tldr: 'demo', compactInstruction: 'compact me' })
const sheet = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'))

let rules
try {
  rules = parse(sheet)
} catch (e) {
  console.log(`FAIL the emitted stylesheet does not parse: ${e.message}`)
  process.exit(1)
}
const find = (sel) => rules.filter((r) => !r.prelude.startsWith('@') && selectors(r.prelude).includes(sel))
const inSupports = (r) => r.at.some((a) => a.startsWith('@supports'))
const inReduced = (r) => r.at.some((a) => a.includes('prefers-reduced-motion'))
/** The last value a selector is given for a property, which is what wins. */
const prop = (sel, name, filter = () => true) =>
  find(sel).filter(filter).flatMap((r) => decls(r.body)).filter(([p]) => p === name).map(([, v]) => v).pop()

chk('the emitted stylesheet parses and carries rules', rules.length > 40, `${rules.length} blocks`)

// ------------------------------------------------------------- the three roots
//
// A new colour token has to be declared in all three, and the failure when it
// is not is silent and one-sided: the page looks right in whichever theme the
// author happened to be in. The dark pair are two separate blocks -- the media
// query for "follow the system" and the attribute for "the reader chose dark"
// -- and a token added to one of them is a token that changes when the toggle
// moves.
const rootLight = rules.find((r) => r.prelude === ':root' && !r.at.length)
const rootMedia = rules.find((r) => r.prelude === ':root:not([data-theme=light])' &&
  r.at.some((a) => a.includes('prefers-color-scheme:dark')))
const rootAttr = rules.find((r) => r.prelude === ':root[data-theme=dark]' && !r.at.length)
chk('the page still declares all three theme blocks',
  !!rootLight && !!rootMedia && !!rootAttr,
  `:root ${!!rootLight}, media ${!!rootMedia}, [data-theme=dark] ${!!rootAttr}`)
if (!rootLight || !rootMedia || !rootAttr) { console.log('\n1 failed'); process.exit(1) }

const tokensOf = (r) => Object.fromEntries(decls(r.body).filter(([p]) => p.startsWith('--')))
const LIGHT = tokensOf(rootLight)
const MEDIA = tokensOf(rootMedia)
const ATTR = tokensOf(rootAttr)
const DARK = { ...LIGHT, ...ATTR }

// ------------------------------------------------------------------- arithmetic
const hex = (h) => {
  const s = String(h).trim().replace('#', '')
  const full = s.length === 3 ? [...s].map((c) => c + c).join('') : s
  const p = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  if (p.some((v) => !Number.isFinite(v))) throw new Error(`unreadable colour: ${h}`)
  return p
}
const resolve = (vars, v, depth = 0) => {
  if (depth > 8) throw new Error(`var() cycle in ${v}`)
  const m = String(v).trim().match(/^var\((--[a-z0-9-]+)\)$/)
  return m ? resolve(vars, vars[m[1]], depth + 1) : String(v).trim()
}
const rgb = (vars, v) => hex(resolve(vars, v))
const mix = (vars, v) => {
  const m = String(v).match(/color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)/)
  if (!m) throw new Error(`not a color-mix: ${v}`)
  return [hex(resolve(vars, m[1])), Number(m[2]) / 100]
}
const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const lum = (p) => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2])
const ratio = (a, b) => {
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]
  return (hi + 0.05) / (lo + 0.05)
}
const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i])
const fmt = (p) => `#${p.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
const n2 = (x) => `${x.toFixed(2)}:1`

// ------------------------------------------------------- the field, as it moves
//
// The page is not flat. Two fixed layers of soft radial tints drift behind
// everything, so "the page" under a card edge is a range of colours rather than
// --bg. test/glass.mjs samples that range to prove TEXT stays readable; this
// samples it again to ask a different question, about a 1px border, and the
// point of the field that is worst for a border is not the point that is worst
// for text. Geometry, keyframes and weights all come off the sheet.
const blobs = (sel) => {
  const img = prop(sel, 'background-image')
  return [...String(img).matchAll(/radial-gradient\(([\d.]+)% ([\d.]+)% at ([\d.]+)% ([\d.]+)%,\s*var\((--aura-\d)\)/g)]
    .map((m) => ({ rx: +m[1], ry: +m[2], cx: +m[3], cy: +m[4], token: m[5] }))
}
const offsets = (name) => {
  const kf = rules.find((r) => r.prelude.replace(/\s+/g, ' ') === `@keyframes ${name}`)
  return (kf?.children || []).flatMap((s) => decls(s.body))
    .filter(([p]) => p === 'transform')
    .map(([, v]) => v.match(/translate3d\((-?[\d.]+)%,\s*(-?[\d.]+)%/))
    .filter(Boolean)
    .map((m) => [Number(m[1]), Number(m[2])])
}
const A = blobs('body::before')
const B = blobs('body::after')
const OA = offsets('auraA')
const OB = offsets('auraB')
chk('the drifting field is still two layers of several blobs, so it is worth sampling',
  A.length >= 2 && B.length >= 2 && OA.length >= 2 && OB.length >= 2,
  `${A.length}+${B.length} blobs, ${OA.length}+${OB.length} keyframes`)

// The alpha the card is painted with where backdrop-filter exists. Read off the
// rule that names .turn rather than the one that names .card: they share a
// declaration today and a future pass that splits them would otherwise be
// measured on the wrong surface.
const turnGlass = rules.filter(inSupports)
  .filter((r) => !r.prelude.startsWith('@') && selectors(r.prelude).includes('.turn'))
  .flatMap((r) => decls(r.body)).filter(([p]) => p === 'background').map(([, v]) => v).pop()
chk('the translucent card fill is readable from the sheet',
  !!turnGlass && turnGlass.includes('color-mix('), String(turnGlass))

const alphaAt = (x, y, b, peak) => {
  const d = Math.hypot((x - b.cx) / b.rx, (y - b.cy) / b.ry)
  return d >= 1 ? 0 : peak * (1 - d)
}
/** Every point either layer box can put under the viewport, at every keyframe.
 *  A superset of what is ever on screen, so nothing the reader sees is more
 *  tinted than the worst this finds. `probe` names the ratios to minimise, and
 *  each one comes back with the two surfaces that produced its worst case --
 *  the point of the drift that is worst for a border is not the point that is
 *  worst for text, so they cannot share one answer. */
const sweep = (vars, probe) => {
  const base = rgb(vars, vars['--bg'])
  const tint = Object.fromEntries(['--aura-1', '--aura-2', '--aura-3'].map((t) => [t, mix(vars, vars[t])]))
  const [panelRgb, panelA] = mix(vars, turnGlass)
  const worst = {}
  for (const oa of OA) for (const ob of OB) {
    tick('the field sweep')
    for (let y = -20; y <= 120; y += 2) for (let x = -20; x <= 120; x += 2) {
      let field = base
      for (const b of A) {
        const [c, a0] = tint[b.token]
        const a = alphaAt(x - oa[0], y - oa[1], b, a0)
        if (a > 0) field = over(c, a, field)
      }
      for (const b of B) {
        const [c, a0] = tint[b.token]
        const a = alphaAt(x - ob[0], y - ob[1], b, a0)
        if (a > 0) field = over(c, a, field)
      }
      // .turn is deliberately excluded from the blur list in the sheet, so its
      // backdrop is not saturated -- the card fill is a plain composite.
      const fill = over(panelRgb, panelA, field)
      const r = probe(field, fill)
      for (const k of Object.keys(r)) {
        if (!worst[k] || r[k] < worst[k].ratio) worst[k] = { ratio: r[k], field, fill }
      }
    }
  }
  return worst
}

// ------------------------------------------------------------- 1. the card edge
//
// A boundary a reader has to see to know where one card ends is exactly what
// WCAG 1.4.11 puts a 3:1 floor under, so that is the stated minimum. It is
// checked against three surfaces and not one: the page, the solid card fill,
// and the translucent card fill -- and each of those twice more, at the point
// of the drifting field that is worst for it.
const MIN_EDGE = 3
console.log('\n  --- the card edge')
for (const [name, vars] of [['light', LIGHT], ['dark', DARK]]) {
  const edge = rgb(vars, prop('.turn', 'border').split(/\s+/).pop())
  const page = rgb(vars, vars['--bg'])
  const solid = rgb(vars, vars['--panel'])
  const line = rgb(vars, vars['--line'])
  const w = sweep(vars, (field, fill) => ({ page: ratio(edge, field), fill: ratio(edge, fill) }))

  const flatPage = ratio(edge, page)
  const flatFill = ratio(edge, solid)
  console.log(`     ${name}: edge ${fmt(edge)} — flat page ${fmt(page)} ${n2(flatPage)}, flat card ${fmt(solid)} ${n2(flatFill)}`)
  console.log(`     ${name}: under the field — page ${fmt(w.page.field)} ${n2(w.page.ratio)}, card ${fmt(w.fill.fill)} ${n2(w.fill.ratio)}`)
  console.log(`     ${name}: was --line ${fmt(line)} — ${n2(ratio(line, page))} on the page, ${n2(ratio(line, solid))} on the card`)
  console.log(`     ${name}: the card fill itself is still only ${n2(ratio(solid, page))} against the page`)

  const worst = Math.min(flatPage, flatFill, w.page.ratio, w.fill.ratio)
  chk(`${name}: the card edge clears ${MIN_EDGE}:1 against the page and against the card fill, flat and under the field`,
    worst >= MIN_EDGE,
    `worst of the four is ${n2(worst)} — page ${n2(flatPage)}/${n2(w.page.ratio)}, card ${n2(flatFill)}/${n2(w.fill.ratio)}`)
  chk(`${name}: and it is a real change — the border it replaced never came close`,
    Math.max(ratio(line, page), ratio(line, solid)) < MIN_EDGE,
    `--line reached ${n2(Math.max(ratio(line, page), ratio(line, solid)))}`)
}

// A friction turn is marked by a red left border. The point of a visible grey
// edge is that the red still reads as a marker rather than as the only border
// on the page, so it has to stay both present and louder.
{
  const fr = prop('.turn.friction', 'border-left')
  chk('a friction turn still keeps its red left border, and it is thicker than the edge around it',
    !!fr && /var\(--bad\)/.test(fr) && parseFloat(fr) > parseFloat(prop('.turn', 'border')),
    `${fr} against ${prop('.turn', 'border')}`)
  for (const [name, vars] of [['light', LIGHT], ['dark', DARK]]) {
    const bad = rgb(vars, vars['--bad'])
    const edge = rgb(vars, prop('.turn', 'border').split(/\s+/).pop())
    const solid = rgb(vars, vars['--panel'])
    chk(`${name}: and the red still outranks the grey it sits next to`,
      ratio(bad, solid) > ratio(edge, solid),
      `friction ${n2(ratio(bad, solid))} vs edge ${n2(ratio(edge, solid))}`)
  }
}

// ------------------------------------------------- 2. rank inside the summary
//
// The four roles, with the surface each one is actually painted on. .tool and
// .chip carry their own opaque fills, so they are measured on those; .idx and
// .meta sit on the card, so they are measured at the worst point of the field.
const ROLES = [
  { sel: '.idx', job: 'navigate', on: 'card' },
  { sel: '.meta', job: 'reference', on: 'card' },
  { sel: '.tool', job: 'reference', on: 'own fill' },
  { sel: '.chip', job: 'scan', on: 'own fill' },
]
const roleOf = (sel) => ({
  sel,
  color: (String(prop(sel, 'color')).match(/var\((--[a-z0-9-]+)\)/) || [])[1],
  size: parseFloat(prop(sel, 'font-size')),
  weight: Number(prop(sel, 'font-weight') || 400),
  bg: (String(prop(sel, 'background') || '').match(/var\((--[a-z0-9-]+)\)/) || [])[1],
})
const roles = ROLES.map((r) => ({ ...r, ...roleOf(r.sel) }))
chk('all four secondary roles are still readable off the sheet',
  roles.every((r) => r.color && Number.isFinite(r.size)),
  roles.map((r) => `${r.sel} ${r.color}/${r.size}`).join(', '))

{
  const colours = new Set(roles.map((r) => r.color))
  const sizes = new Set(roles.map((r) => r.size))
  const sigs = new Set(roles.map((r) => `${r.color}|${r.size}|${r.weight}`))
  console.log('\n  --- the four secondary roles')
  chk('the four no longer share one colour', colours.size > 1, [...colours].join(', '))
  chk('and they no longer share one size', sizes.size > 1, [...sizes].join(', '))
  // Three jobs, so three ranks. Four would be rank for its own sake: .meta and
  // .tool are the same reference detail in two places and are meant to match.
  chk('they resolve into three ranks, one per job, not four and not one',
    sigs.size === 3, `${sigs.size} distinct (colour, size, weight): ${[...sigs].join('  ')}`)
  const twins = roles.filter((r) => `${r.color}|${r.size}|${r.weight}` ===
    `${roles[1].color}|${roles[1].size}|${roles[1].weight}`).map((r) => r.sel)
  chk('and the two that still match are the two that do the same job',
    twins.join(',') === '.meta,.tool', twins.join(', ') || 'none')
}

for (const [name, vars] of [['light', LIGHT], ['dark', DARK]]) {
  // One card fill, taken at the moment of the drift that is worst for text on
  // it, so every role that sits on the card is judged at the same instant. A
  // rank that only holds at the kindest point of the animation is not a rank.
  const card = sweep(vars, (field, fill) => ({ ink: ratio(rgb(vars, vars['--ink']), fill) })).ink.fill
  const surface = (r) => (r.bg ? rgb(vars, vars[r.bg]) : card)
  const on = (r) => ratio(rgb(vars, vars[r.color]), surface(r))

  const idx = roles.find((r) => r.sel === '.idx')
  const meta = roles.find((r) => r.sel === '.meta')
  const tool = roles.find((r) => r.sel === '.tool')
  const chip = roles.find((r) => r.sel === '.chip')

  console.log(`\n     ${name}: card fill at the worst of the drift ${fmt(card)}`)
  for (const r of [chip, idx, meta, tool]) {
    console.log(`     ${name}: ${r.sel.padEnd(6)} ${r.job.padEnd(9)} ${r.color.slice(2).padEnd(6)} ${fmt(rgb(vars, vars[r.color]))} ${String(r.size).padStart(4)}px/${r.weight} on ${fmt(surface(r))} — ${n2(on(r))}`)
  }
  chk(`${name}: the score reads louder than the index, which reads louder than the reference detail`,
    on(chip) > on(idx) && on(idx) > on(meta) && on(idx) > on(tool),
    `chip ${n2(on(chip))}, idx ${n2(on(idx))}, meta ${n2(on(meta))}, tool ${n2(on(tool))}`)
  // Both chips are outlined boxes on the same card, so their borders are
  // measured against that card and not against their own fills: what separates
  // a chip from the row is the only comparison that says which one is found
  // first.
  const chipEdge = ratio(rgb(vars, prop('.chip', 'border').split(/\s+/).pop()), card)
  const toolEdge = ratio(rgb(vars, prop('.tool', 'border').split(/\s+/).pop()), card)
  // Stated as what it means, not as a ratio between two borders. The first
  // version asserted chipEdge > toolEdge * 2, which made the score chip's
  // prominence depend on the TOOL chip's border staying invisible -- so giving
  // the tool chips the same one-token fix the card got turned this guard red.
  // A test that fails when a defect is fixed is worse than no test.
  chk(`${name}: both chips have an edge a reader can see`,
    chipEdge >= 3 && toolEdge >= 3, `score chip ${n2(chipEdge)}, tool chip ${n2(toolEdge)}`)
  chk(`${name}: and the score chip still outranks them, by fill and weight rather than by their absence`,
    fmt(surface(chip)) !== fmt(surface(tool)) &&
      Number(prop('.chip', 'font-weight')) > Number(prop('.tool', 'font-weight') || 400),
    `chip fill ${fmt(surface(chip))} weight ${prop('.chip', 'font-weight')}; ` +
      `tool fill ${fmt(surface(tool))} weight ${prop('.tool', 'font-weight') || '400'}`)
  // A low score turns the chip red. It is the one text colour on the page that
  // moved onto a new surface in this pass, so it is measured on that surface.
  const low = rgb(vars, String(prop('.chip.low', 'color')))
  chk(`${name}: a low score still clears AA on the chip's own fill`,
    ratio(low, surface(chip)) >= 4.5, `${fmt(low)} on ${fmt(surface(chip))} — ${n2(ratio(low, surface(chip)))}`)

  // The prompt is the content. Everything above is an index to it, and a score
  // chip that out-shouts the prompt has traded one unreadable row for another.
  const txt = { color: 'ink', size: parseFloat(prop('.txt', 'font-size')) }
  const txtRatio = ratio(rgb(vars, vars['--ink']), card)
  console.log(`     ${name}: .txt   content   ink    ${fmt(rgb(vars, vars['--ink']))} ${String(txt.size).padStart(4)}px on ${fmt(card)} — ${n2(txtRatio)}`)
  chk(`${name}: the prompt line is still the most prominent thing in the row`,
    txt.size > Math.max(...roles.map((r) => r.size)) && txtRatio >= on(chip),
    `${txt.size}px vs ${Math.max(...roles.map((r) => r.size))}px, ${n2(txtRatio)} vs chip ${n2(on(chip))}`)
}

// ---------------------------------------------- 3. every token, in all three
//
// Scoped to what the turn card actually paints with, resolved transitively, and
// filtered to the ones that carry a colour: --mono is declared once on purpose
// and a check that demanded it in all three blocks would be noise. The failure
// this catches is the one the brief names -- a shadow or a tint given a
// light-theme value and no dark one, which lands as a black smear on a dark
// page and is invisible to whoever wrote it.
{
  const CARD = ['.turn', '.idx', '.txt', '.meta', '.chip', '.tool', '.bar', '.tag', '.body', '.ded']
  const touched = rules.filter((r) => !r.prelude.startsWith('@') &&
    selectors(r.prelude).some((s) => CARD.some((c) => s === c || s.startsWith(`${c}.`) ||
      s.startsWith(`${c} `) || s.startsWith(`${c}:`) || s.startsWith(`${c}>`))))
  const seen = new Set()
  const collect = (v, depth = 0) => {
    if (depth > 8) return
    for (const m of String(v).matchAll(/var\((--[a-z0-9-]+)/g)) {
      if (seen.has(m[1])) continue
      seen.add(m[1])
      if (LIGHT[m[1]] !== undefined) collect(LIGHT[m[1]], depth + 1)
    }
  }
  touched.flatMap((r) => decls(r.body)).forEach(([, v]) => collect(v))
  const isColour = (t) => {
    const v = LIGHT[t]
    return v !== undefined && (/^#[0-9a-fA-F]{3,8}$/.test(String(v).trim()) || String(v).includes('color-mix('))
  }
  const coloured = [...seen].filter(isColour).sort()
  console.log(`\n  --- ${coloured.length} colour tokens reach the turn card: ${coloured.map((t) => t.slice(2)).join(', ')}`)
  chk('the turn card paints with a countable set of colour tokens',
    coloured.length >= 6, coloured.join(', '))
  const missing = coloured.filter((t) => MEDIA[t] === undefined || ATTR[t] === undefined)
  chk('every colour token the card paints with is declared in all three theme blocks',
    missing.length === 0,
    missing.map((t) => `${t}: :root ${LIGHT[t]}, media ${MEDIA[t] ?? 'MISSING'}, [data-theme=dark] ${ATTR[t] ?? 'MISSING'}`).join('; '))
  const split = coloured.filter((t) => MEDIA[t] !== undefined && ATTR[t] !== undefined && MEDIA[t] !== ATTR[t])
  chk('and the two dark blocks agree, so the theme toggle does not repaint the card',
    split.length === 0,
    split.map((t) => `${t}: media ${MEDIA[t]} vs attr ${ATTR[t]}`).join('; '))
}

// --------------------------------------------- 4. no literal colour, anywhere
//
// A token declaration is the one place a literal belongs; everything else goes
// through var(). Written the way test/brand.mjs writes it, and anchored on `{`
// or `;` so `#go` and `a:hover` are not read as declarations.
{
  const HEXV = /#[0-9a-fA-F]{3,8}\b/
  const FUNC = /\b(?:rgba?|hsla?|lab|lch|oklch|oklab)\(/i
  const NAMED = /\b(?:red|blue|green|black|white|gray|grey|orange|purple|yellow|pink|brown|silver|gold|navy|teal|olive|lime|aqua|fuchsia|maroon|cyan|magenta)\b/i
  const literals = (css) => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
    const bad = []
    for (const [, p, v] of clean.matchAll(/(?:^|[;{])\s*([-a-zA-Z][-\w]*)\s*:\s*([^;{}]*)/g)) {
      if (p.startsWith('--')) continue
      if (HEXV.test(v) || FUNC.test(v) || NAMED.test(v)) bad.push(`${p}:${v.trim()}`)
    }
    return bad
  }
  // The scanner proves itself before it is trusted: a check that cannot fail is
  // the failure mode this whole file exists to avoid.
  chk('the literal scanner finds a planted literal and lets a token through',
    literals('.x{color:#ff8a4c}').length === 1 && literals('.y{border:1px solid var(--edge)}').length === 0,
    literals('.x{color:#ff8a4c}').join(', '))

  // ONE literal is left: `color:#fff` on button.copy's solid --accent fill.
  //
  // .tag was the other, and it was not merely a style nit -- white on --bad is
  // 5.90:1 in light and 2.79:1 in DARK, because the dark theme's red is a light
  // red. The friction label failed AA on exactly the cards a reader most needs
  // to read. It takes a --tag-ink token now, which is why this list shrank.
  // Named rather than pattern-matched, so a new one cannot join quietly.
  const GRANDFATHERED = new Map([['button.copy', 'color:#fff']])
  const offenders = rules
    .filter((r) => !r.prelude.startsWith('@'))
    .flatMap((r) => literals(`x{${r.body}}`).map((d) => [r.prelude, d]))
    .filter(([sel, d]) => GRANDFATHERED.get(sel) !== d)
  console.log(`\n  --- grandfathered literals: ${[...GRANDFATHERED].map(([s, d]) => `${s} { ${d} }`).join(', ')}`)
  chk('no literal colour entered the stylesheet outside a token declaration',
    offenders.length === 0, offenders.map(([sel, d]) => `${sel} { ${d} }`).join('; '))
  chk(`and the grandfathered list is still exactly ${GRANDFATHERED.size}, so it is not stale`,
    rules.filter((r) => !r.prelude.startsWith('@')).flatMap((r) => literals(`x{${r.body}}`)).length === GRANDFATHERED.size,
    `${rules.filter((r) => !r.prelude.startsWith('@')).flatMap((r) => literals(`x{${r.body}}`)).length} found`)
}

// ------------------------------------------------- 5. the markup still works
//
// The card is a <details>. Everything the filter UI and the keyboard path need
// lives on it, and none of it is visual, so a restyling pass is exactly when it
// gets broken without anyone noticing.
{
  const cards = [...html.matchAll(/<details class="turn[^"]*"[^>]*>/g)].map((m) => m[0])
  chk('every turn is still a <details>, one per turn',
    cards.length === SESSION.turns.length, `${cards.length} of ${SESSION.turns.length}`)
  const ATTRS = ['data-friction', 'data-terse', 'data-criteria', 'data-steering']
  const short = cards.filter((c) => !ATTRS.every((a) => c.includes(`${a}="`)))
  chk('and every one of them still exposes all four filter attributes',
    short.length === 0, short[0] || '')
  // The filter buttons read these by dataset key. A renamed attribute that
  // still exists would pass the check above and silently filter nothing.
  const buttons = [...html.matchAll(/<button[^>]*data-f="([a-z]+)"/g)].map((m) => m[1])
  const missing = buttons.filter((b) => b !== 'all' && !ATTRS.includes(`data-${b}`))
  chk('and every filter button names an attribute that exists on the cards',
    buttons.length > 1 && missing.length === 0,
    `buttons ${buttons.join(', ')}; unmatched ${missing.join(', ') || 'none'}`)
  chk('the filter script still reads them off the dataset',
    /\.turn'\)\.forEach\(t=>\{[\s\S]{0,120}t\.dataset\[f\]/.test(html), 'the .turn loop or its dataset read moved')

  const one = html.slice(html.indexOf('<details class="turn'))
  const summary = one.slice(one.indexOf('<summary>'), one.indexOf('</summary>'))
  chk('the summary still carries the index, the prompt and the meta strip in that order',
    ['class="idx"', 'class="txt"', 'class="meta"'].every((c) => summary.includes(c)) &&
    summary.indexOf('class="idx"') < summary.indexOf('class="txt"') &&
    summary.indexOf('class="txt"') < summary.indexOf('class="meta"'),
    summary.slice(0, 160))
  chk('the score chip is still inside the summary, and a low score still marks itself',
    /<span class="chip">/.test(html) && /<span class="chip low">/.test(html),
    'one of the two chip states never rendered — the fixture scores both')
  chk('the friction turn still gets the class its red border hangs on',
    /<details class="turn friction"/.test(html), 'no friction card rendered')
}

// The body indent is arithmetic, not taste: summary padding + index column +
// grid gap. Deriving it here rather than restating 61px is the whole point --
// the alignment breaks silently when one of the three moves alone.
{
  const pad = parseFloat(String(prop('.turn > summary', 'padding')).split(/\s+/)[1])
  const col = parseFloat(String(prop('.turn > summary', 'grid-template-columns')).split(/\s+/)[0])
  const gap = parseFloat(prop('.turn > summary', 'gap'))
  const indent = parseFloat(String(prop('.body', 'padding')).split(/\s+/)[3])
  console.log(`\n  --- body indent: ${pad} padding + ${col} index column + ${gap} gap = ${pad + col + gap}, .body has ${indent}`)
  chk('the expanded body still starts on the same vertical as the prompt above it',
    [pad, col, gap, indent].every(Number.isFinite) && pad + col + gap === indent,
    `${pad} + ${col} + ${gap} = ${pad + col + gap}, not ${indent}`)
}

// ------------------------------------------------------- 6. nothing moves yet
//
// The card treatment is static on purpose. This is not a check that it must
// stay that way, it is the guard for the day it does not: a transition or an
// animation added here without a reduced-motion escape is the failure, not the
// motion itself.
{
  const moving = rules
    .filter((r) => !r.prelude.startsWith('@') && !inReduced(r))
    .filter((r) => selectors(r.prelude).some((s) => s.startsWith('.turn') || s === '.idx' || s === '.chip'))
    .flatMap((r) => decls(r.body).map(([p, v]) => [r.prelude, p, v]))
    .filter(([, p]) => p === 'animation' || p === 'transition')
  chk('nothing on the turn card animates without a reduced-motion escape',
    moving.length === 0 || rules.some((r) => inReduced(r) &&
      selectors(r.prelude).some((s) => moving.some(([sel]) => selectors(sel).includes(s)))),
    moving.map(([sel, p, v]) => `${sel} { ${p}:${v} }`).join('; '))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
