// The glass treatment: the animated field behind the page, and the translucent
// surfaces over it.
//
// Everything here is measured on the stylesheet the renderer actually emitted.
// Nothing re-runs the code that produced it and nothing hardcodes a colour --
// the tokens, the gradient geometry, the keyframe offsets, the panel alpha and
// the saturate factor are all read back out of the emitted document, so a
// change to any of them moves the numbers this file asserts on. The recurring
// defect in this repo is a check that passes by not looking.
//
// The one thing that cannot be checked here is a screenshot: there is no
// compositor in node, so "does the blur look like glass" is not measurable.
// What IS measurable is the thing that actually goes wrong -- text going
// unreadable because a moving tint passed behind it -- and that is arithmetic.
import { render } from '../scripts/render.mjs'

// A test that hangs is a test with no result. The sampling loop below is the
// only thing here that could run long, and it is CPU-bound and synchronous --
// so a setTimeout watchdog would never get a turn on the event loop to fire.
// It has to be a deadline the loop itself reads. Written and then proven by
// lowering it: a timer here passes by not looking.
const DEADLINE = Date.now() + 60000
const tick = (where) => {
  if (Date.now() > DEADLINE) {
    console.log(`\nFAIL glass.mjs exceeded 60s in ${where} — a sampling loop lost its bound`)
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
// A brace-matching reader over the emitted text. Enough of a parser to know
// which rules sit inside which at-rule, which is the whole question for
// @supports and prefers-reduced-motion.
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
        const body = src.slice(i + 1, j - 1)
        const node = { at, prelude, body, start: start }
        if (prelude.startsWith('@')) {
          node.children = read(i + 1, j - 1, [...at, prelude])
          // @keyframes children are percentage selectors, not nested rules, but
          // they read the same way and the reader does not need to care.
        }
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

// One session, rendered once. Every assertion reads this same document.
const turn = (index, extra = {}) => ({
  index, text: `turn ${index}`, durationMs: 1000, friction: index % 3 ? [] : ['roundtrip'],
  signals: {}, toolCalls: [{ name: 'Read', count: 2 }], toolCallCount: 2, tokens: { output: 40 },
  derived: { repeatOf: null }, score: { value: 90, deductions: [], additions: [] }, ...extra,
})
const SESSION = {
  sessionId: 'abcd1234-0000-0000-0000-000000000000', harness: 'claude-code', cwd: '/w/demo',
  gitBranch: 'main', durationMs: 60000, models: { 'claude-opus-5': 4 }, slashCommands: [],
  permissionModes: [],
  artifacts: { tools: { git: 2 }, mcp: {}, packages: {}, stack: {}, extensions: {}, skills: {}, fileTouches: 3 },
  totals: { humanTurns: 6, toolCalls: 12, tokens: { output: 900, cacheRead: 4000 }, frictionTurns: 2, repeats: 0, interruptions: 0, steeringTurns: 0, records: 40 },
  score: { value: 90, band: 'clean', confidence: 'high', turnsScored: 6, frictionRate: 0.3, craftRate: 0, wastedTokens: 0, costliestTurn: 0 },
  turns: Array.from({ length: 6 }, (_, i) => turn(i)),
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
chk('the emitted stylesheet parses and carries rules', rules.length > 40, `${rules.length} blocks`)

const find = (sel) => rules.filter((r) => !r.prelude.startsWith('@') && selectors(r.prelude).includes(sel))
const inSupports = (r) => r.at.some((a) => a.startsWith('@supports'))
const inReduced = (r) => r.at.some((a) => a.includes('prefers-reduced-motion'))

// ---------------------------------------------------------------- 1. the field
{
  const layers = ['body::before', 'body::after']
  for (const sel of layers) {
    const rs = find(sel)
    chk(`${sel} is declared`, rs.length > 0)
    const all = rs.flatMap((r) => decls(r.body))
    const img = all.filter(([p]) => p === 'background-image').map(([, v]) => v).join(' ')
    // No url(), no image-set(): the brief is gradients only, and a file here
    // would be a request the page does not otherwise make.
    chk(`${sel} paints gradients and nothing fetched`,
      !!img && /radial-gradient\(/.test(img) && !/url\(|image-set\(|element\(/.test(img),
      img.slice(0, 80))
    chk(`${sel} takes every colour from a token`,
      !!img && !/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/.test(img) && /var\(--aura-\d\)/.test(img),
      img.slice(0, 120))
    // A layer that is not fixed scrolls with the document, and a layer without a
    // negative z-index paints over the content instead of behind it.
    const map = Object.fromEntries(all)
    chk(`${sel} is fixed, behind the content, and cannot be clicked`,
      map.position === 'fixed' && Number(map['z-index']) < 0 && map['pointer-events'] === 'none',
      JSON.stringify({ position: map.position, z: map['z-index'], pe: map['pointer-events'] }))
    // The layer translates; a viewport-sized one would swing its own edge in.
    chk(`${sel} is larger than the viewport it drifts across`,
      /^-\d/.test(String(map.inset || '')), String(map.inset))
  }

  // The trap the brief names: a blurred layer under a sticky nav. This page has
  // no sticky bar, so the assertion that matters is the weaker one -- nothing
  // in the emitted sheet gives <body> a transform, a filter or a
  // backdrop-filter, any of which would make body the containing block for the
  // fixed layers and re-root the stacking context.
  const bodyDecls = find('body').flatMap((r) => decls(r.body)).map(([p]) => p)
  chk('body itself gains no transform, filter or backdrop-filter',
    !bodyDecls.some((p) => /^(transform|filter|backdrop-filter|perspective|contain)$/.test(p)),
    bodyDecls.join(' '))
}

// ---------------------------------------------------------------- 2. the motion
{
  const kf = rules.filter((r) => /^@keyframes\s+aura/.test(r.prelude))
  chk('both aura keyframe sets are emitted', kf.length === 2, kf.map((k) => k.prelude).join(', '))

  // THE cheapness assertion. transform on a promoted layer is composited;
  // anything else in a keyframe repaints the whole viewport every frame.
  const props = new Set()
  for (const k of kf)
    for (const step of k.children || [])
      for (const [p] of decls(step.body)) props.add(p)
  chk('nothing but transform is animated, so no frame repaints',
    props.size > 0 && [...props].every((p) => p === 'transform'), [...props].join(', '))

  const promoted = ['body::before', 'body::after'].every((sel) =>
    find(sel).flatMap((r) => decls(r.body)).some(([p, v]) => p === 'will-change' && v === 'transform'))
  chk('and both layers are promoted, so the transform never touches layout', promoted)

  // Two clocks that do not divide into each other. Equal durations would fall
  // into lockstep and the field would visibly loop.
  const durations = ['body::before', 'body::after'].map((sel) => {
    const a = find(sel).flatMap((r) => decls(r.body)).find(([p]) => p === 'animation')
    return a ? Number((a[1].match(/(\d+)s/) || [])[1]) : NaN
  })
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  chk('the two layers run on clocks that do not share a factor',
    durations.every(Number.isFinite) && gcd(...durations) === 1, durations.join(' and '))

  // Stopped, not slowed.
  const reduced = rules.filter((r) => inReduced(r) && !r.prelude.startsWith('@'))
  const stops = reduced.filter((r) =>
    selectors(r.prelude).some((s) => s.startsWith('body::')) &&
    decls(r.body).some(([p, v]) => p === 'animation' && v === 'none'))
  chk('reduced motion sets animation:none on the layers, not a longer duration',
    stops.length > 0 && !reduced.some((r) => decls(r.body).some(([p, v]) => p === 'animation' && v !== 'none' && /s\b/.test(v))),
    `${stops.length} rule(s)`)
  // A layer left at its keyframe transform after the animation is cancelled
  // would sit wherever the 0% frame put it; the base position is the honest one.
  // stops.length is asserted above and repeated here on purpose: `every` over an
  // empty list is true, so without it a deleted block would pass this line.
  chk('and puts the layers back to their untransformed position',
    stops.length > 0 && stops.every((r) => decls(r.body).some(([p, v]) => p === 'transform' && v === 'none')))
}

// ---------------------------------------------------------------- 3. fallback
//
// backdrop-filter is not universal. A translucent panel with no blur behind it
// is the failure this guards: legible only by luck, and only while the field
// happens to be pale where the text is.
{
  const translucent = rules.filter((r) =>
    !r.prelude.startsWith('@') &&
    decls(r.body).some(([p, v]) => p === 'background' && v.includes('color-mix(')))
  chk('the page does declare translucent surfaces', translucent.length > 0, `${translucent.length}`)
  const escaped = translucent.filter((r) => !inSupports(r))
  chk('and every one of them is inside @supports for backdrop-filter',
    escaped.length === 0, escaped.map((r) => r.prelude).join(' | '))

  // Inside the guard is not enough on its own: the selector needs a solid
  // background OUTSIDE it, or an unsupporting browser gets no background at all.
  const solid = new Map()
  for (const r of rules) {
    if (r.prelude.startsWith('@') || inSupports(r)) continue
    for (const [p, v] of decls(r.body))
      if (p === 'background' && !v.includes('color-mix(') && v !== 'none')
        for (const s of selectors(r.prelude)) solid.set(s, v)
  }
  const orphans = []
  for (const r of translucent)
    for (const s of selectors(r.prelude))
      if (!solid.has(s)) orphans.push(s)
  chk('and every translucent selector also has a solid background outside the guard',
    orphans.length === 0, orphans.join(', '))

  const guards = rules.filter((r) => r.prelude.startsWith('@supports')).map((r) => r.prelude)
  chk('the guard names the vendor-prefixed form too, or Safari gets no glass',
    guards.some((g) => g.includes('-webkit-backdrop-filter')), guards.join(' | '))
  const bf = rules.filter((r) => inSupports(r)).flatMap((r) => decls(r.body))
  chk('and the blur is declared prefixed as well as plain',
    bf.some(([p]) => p === '-webkit-backdrop-filter') && bf.some(([p]) => p === 'backdrop-filter'))

  // One backdrop raster per turn, on a session with three hundred of them, is
  // three hundred rasters the compositor has to keep. The turn rows are the one
  // element on this page whose count is set by the data rather than the layout,
  // so they take the translucency without the blur.
  const blurred = rules.filter((r) =>
    !r.prelude.startsWith('@') &&
    decls(r.body).some(([p]) => p === 'backdrop-filter' || p === '-webkit-backdrop-filter'))
    .flatMap((r) => selectors(r.prelude))
  chk('no element whose count comes from the data carries a blur',
    !blurred.some((s) => /^\.turn\b|^\.stat$|^\.tool$|^\.intent\b/.test(s)),
    blurred.join(', '))

  // Written inline rather than through a custom property on purpose: inline it
  // fails at parse time and the solid background survives, whereas a token
  // would fail at computed-value time and leave the surface transparent.
  const viaToken = rules.filter((r) => !r.prelude.startsWith('@'))
    .flatMap((r) => decls(r.body))
    .filter(([p, v]) => p.startsWith('--') && v.includes('color-mix(') && !p.startsWith('--aura'))
  chk('no surface colour is reached through a color-mix token',
    viaToken.length === 0, viaToken.map(([p]) => p).join(', '))
}

// ---------------------------------------------------------------- 4. the graph
//
// The canvas paints --kg-bg and every node label is stroked with a halo in
// --kg-halo, which is the same colour. Make the canvas translucent and the
// halos become opaque patches of a colour that is no longer behind them.
{
  const canvas = find('.gcanvas')
  const last = canvas.flatMap((r) => decls(r.body)).filter(([p]) => p === 'background').pop()
  chk('the graph canvas is still painted with a flat --kg-bg',
    !!last && last[1] === 'var(--kg-bg)', last ? last[1] : 'no background at all')
  chk('and it is not given a backdrop-filter',
    canvas.length > 0 && !canvas.flatMap((r) => decls(r.body)).some(([p]) => p.includes('backdrop-filter')))
  chk('and the glass block re-states that, next to the surfaces that are glass',
    canvas.some((r) => inSupports(r)))

  // The zoom divisor the SVG text and strokes depend on.
  for (const sel of ['.ge', '.gn text', '.gn .gs'])
    chk(`${sel} still divides its stroke by the live zoom`,
      find(sel).flatMap((r) => decls(r.body)).some(([, v]) => v.includes('var(--kgz,1)')))
}

// ---------------------------------------------------------------- 5. tokens
//
// Three theme states, and the field has to follow all three.
{
  const block = (pred) => {
    const r = rules.find(pred)
    return r ? Object.fromEntries(decls(r.body)) : {}
  }
  const light = block((r) => r.prelude === ':root' && !r.at.length)
  const media = block((r) => r.prelude === ':root:not([data-theme=light])' && r.at.some((a) => a.includes('prefers-color-scheme')))
  const forced = block((r) => r.prelude === ':root[data-theme=dark]')

  const names = Object.keys(light).filter((k) => k.startsWith('--aura'))
  chk('the field is built from tokens, not from one hardcoded picture', names.length >= 3, names.join(', '))
  chk('every aura token is defined for a light page', names.every((n) => light[n]))
  chk('and redefined under prefers-color-scheme: dark', names.every((n) => media[n]), names.filter((n) => !media[n]).join(', '))
  chk('and again for a page forced to dark', names.every((n) => forced[n]), names.filter((n) => !forced[n]).join(', '))
  chk('the two dark blocks agree, so the toggle and the system agree',
    names.every((n) => media[n] === forced[n]))
  // A dark block that copies the light values is a theme that does not follow.
  chk('and dark is not a copy of light — the field is weighted per theme',
    names.every((n) => media[n] !== light[n]))
  chk('every aura token is mixed out of a palette token, with no literal colour',
    names.every((n) => /var\(--[a-z0-9-]+\)/.test(light[n]) && !/#[0-9a-fA-F]{3,8}|rgba?\(/.test(light[n])),
    names.map((n) => light[n]).join(' | '))

  // The halo is stroked in --kg-halo and drawn on --kg-bg. If those ever stop
  // being the same colour the labels are outlined against something that is not
  // behind them -- which is exactly what glassing the canvas would have caused.
  for (const [name, b] of [['light', light], ['dark', media], ['forced dark', forced]])
    chk(`the label halo still matches the canvas it is drawn on (${name})`,
      b['--kg-halo'] === b['--kg-bg'], `${b['--kg-halo']} vs ${b['--kg-bg']}`)
}

// ---------------------------------------------------------------- 6. contrast
//
// The measurement. Everything below is read out of the emitted sheet: the
// palette, the aura weights, the gradient geometry, the keyframe offsets, the
// panel alpha and the saturate factor. Then the composite is evaluated at every
// point either layer can put under the viewport, at every keyframe, and the
// WORST ratio found is what is asserted. Not a best case, and not the centre of
// the screen.
{
  const block = (pred) => {
    const r = rules.find(pred)
    return r ? Object.fromEntries(decls(r.body)) : {}
  }
  const light = block((r) => r.prelude === ':root' && !r.at.length)
  const dark = { ...light, ...block((r) => r.prelude === ':root[data-theme=dark]') }

  // --panel is #fff in the light theme, so the three-digit form has to expand
  // or every light-theme number below silently becomes NaN.
  const hex = (h) => {
    const s = h.replace('#', '')
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
  /** color-mix(in srgb, <colour> N%, transparent) -> [rgb, alpha] */
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
  // CSS filters operate in sRGB; this is the feColorMatrix saturate matrix.
  const saturate = (p, s) => [
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
  ].map((r) => Math.min(255, Math.max(0, r[0] * p[0] + r[1] * p[1] + r[2] * p[2])))

  // Gradient geometry, straight out of the two layer rules.
  const blobs = (sel) => {
    const img = find(sel).flatMap((r) => decls(r.body)).find(([p]) => p === 'background-image')[1]
    return [...img.matchAll(/radial-gradient\(([\d.]+)% ([\d.]+)% at ([\d.]+)% ([\d.]+)%,\s*var\((--aura-\d)\)/g)]
      .map((m) => ({ rx: +m[1], ry: +m[2], cx: +m[3], cy: +m[4], token: m[5] }))
  }
  // Keyframe offsets, straight out of the two @keyframes blocks.
  const offsets = (name) => {
    const kf = rules.find((r) => r.prelude.replace(/\s+/g, ' ') === `@keyframes ${name}`)
    return (kf.children || []).flatMap((s) => decls(s.body))
      .filter(([p]) => p === 'transform')
      .map(([, v]) => v.match(/translate3d\((-?[\d.]+)%,\s*(-?[\d.]+)%/))
      .filter(Boolean)
      .map((m) => [Number(m[1]), Number(m[2])])
  }
  const A = blobs('body::before')
  const B = blobs('body::after')
  const OA = offsets('auraA')
  const OB = offsets('auraB')
  chk('the field really is two layers of several blobs',
    A.length >= 2 && B.length >= 2 && OA.length >= 2 && OB.length >= 2,
    `${A.length}+${B.length} blobs, ${OA.length}+${OB.length} keyframes`)

  // Panel alpha and saturate factor, straight out of the @supports block.
  const supports = rules.filter(inSupports).filter((r) => !r.prelude.startsWith('@'))
  // .card is named by two rules in the guard — one carries the blur, one the
  // fill. Taking the first would find no background and read as a crash.
  const panelMix = supports
    .filter((r) => selectors(r.prelude).includes('.card'))
    .flatMap((r) => decls(r.body))
    .filter(([p]) => p === 'background')
    .map(([, v]) => v)
    .pop()
  const sat = Number((supports.flatMap((r) => decls(r.body))
    .find(([p]) => p === 'backdrop-filter')[1].match(/saturate\(([\d.]+)\)/) || [])[1])
  chk('the panel alpha and the saturate factor are readable from the sheet',
    panelMix.includes('color-mix(') && Number.isFinite(sat), `${panelMix} / saturate ${sat}`)

  // The stats grid is two translucent layers, not one: .stats paints the 1px
  // gaps and carries the blur, .stat is the readable surface over it. Its text
  // therefore composites through both, so it is measured as its own surface
  // rather than assumed to be at least as good as a card.
  const mixOf = (s) => supports.filter((r) => selectors(r.prelude).includes(s))
    .flatMap((r) => decls(r.body)).filter(([p]) => p === 'background').map(([, v]) => v).pop()
  const gridMix = mixOf('.stats')
  const cellMix = mixOf('.stat')
  chk('the stats grid is two measurable layers', !!gridMix && !!cellMix, `${gridMix} then ${cellMix}`)

  const alphaAt = (x, y, b, peak) => {
    const d = Math.hypot((x - b.cx) / b.rx, (y - b.cy) / b.ry)
    return d >= 1 ? 0 : peak * (1 - d)
  }
  /** Every point of either layer box, at every keyframe offset, is a point that
   *  can land under some pixel of the viewport. Sampling the whole box is a
   *  superset of what is ever visible, so nothing on screen is more tinted than
   *  the worst this finds. */
  const measure = (vars) => {
    const base = hex(resolve(vars, vars['--bg']))
    const ink = hex(resolve(vars, vars['--ink']))
    const muted = hex(resolve(vars, vars['--muted']))
    const tint = Object.fromEntries(['--aura-1', '--aura-2', '--aura-3'].map((t) => [t, mix(vars, vars[t])]))
    const [panelRgb, panelA] = mix(vars, panelMix)
    const [gridRgb, gridA] = mix(vars, gridMix)
    const [cellRgb, cellA] = mix(vars, cellMix)
    let out = null
    for (const oa of OA) for (const ob of OB) {
      tick('the contrast sampling grid')
      for (let y = -20; y <= 120; y += 2) for (let x = -20; x <= 120; x += 2) {
        let c = base
        for (const b of A) {
          const [rgb, a0] = tint[b.token]
          const a = alphaAt(x - oa[0], y - oa[1], b, a0)
          if (a > 0) c = over(rgb, a, c)
        }
        for (const b of B) {
          const [rgb, a0] = tint[b.token]
          const a = alphaAt(x - ob[0], y - ob[1], b, a0)
          if (a > 0) c = over(rgb, a, c)
        }
        // Two glass surfaces, not one: the blurred ones saturate their backdrop
        // and the turn rows do not, so the composite differs. Both are measured
        // and the worse of the two is what gets asserted.
        const withSat = over(panelRgb, panelA, saturate(c, sat))
        const plain = over(panelRgb, panelA, c)
        const glass = ratio(muted, withSat) < ratio(muted, plain) ? withSat : plain
        const cell = over(cellRgb, cellA, over(gridRgb, gridA, saturate(c, sat)))
        const r = {
          fieldInk: ratio(ink, c), fieldMuted: ratio(muted, c),
          glassInk: Math.min(ratio(ink, withSat), ratio(ink, plain)),
          glassMuted: Math.min(ratio(muted, withSat), ratio(muted, plain)),
          cellInk: ratio(ink, cell), cellMuted: ratio(muted, cell),
          field: c, glass, cell,
        }
        if (!out || r.fieldMuted < out.fieldMuted) out = r
      }
    }
    return out
  }

  // Which tokens the page actually paints text with, read off the stylesheet
  // rather than assumed. --ink and --muted are the two that sit directly on the
  // page background; everything else is only ever drawn inside a surface, and
  // this is what keeps that claim honest as the page changes.
  const textTokens = new Set(
    rules.filter((r) => !r.prelude.startsWith('@'))
      .flatMap((r) => decls(r.body))
      .filter(([p]) => p === 'color')
      .map(([, v]) => (v.match(/^var\((--[a-z0-9-]+)/) || [])[1])
      .filter(Boolean))
  // .score .caveat is --warn and .score is a .card, .ded li.out is --bad inside
  // a .turn, and so on: the page has no accent text at all. If that stops being
  // true the exemption below stops being true with it, and this goes red.
  chk('nothing on this page paints text in --accent, so it is never on the field',
    !textTokens.has('--accent'), [...textTokens].join(', '))

  const fmt = (p) => `#${p.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
  for (const [name, vars] of [['light', light], ['dark', dark]]) {
    const w = measure(vars)
    console.log(`\n     ${name}: worst field ${fmt(w.field)} — ink ${w.fieldInk.toFixed(2)}:1, muted ${w.fieldMuted.toFixed(2)}:1`)
    console.log(`     ${name}: glass over it ${fmt(w.glass)} — ink ${w.glassInk.toFixed(2)}:1, muted ${w.glassMuted.toFixed(2)}:1`)
    console.log(`     ${name}: stats cell   ${fmt(w.cell)} — ink ${w.cellInk.toFixed(2)}:1, muted ${w.cellMuted.toFixed(2)}:1`)
    // Body text on the bare background is the binding case: it has no panel
    // between it and the field.
    chk(`${name}: body text clears 4.5:1 everywhere the field reaches`,
      w.fieldInk >= 4.5, `${w.fieldInk.toFixed(2)}:1`)
    chk(`${name}: and so does muted text, which carries most of the prose`,
      w.fieldMuted >= 4.5, `${w.fieldMuted.toFixed(2)}:1`)
    chk(`${name}: text on a glass panel clears it too`,
      w.glassInk >= 4.5 && w.glassMuted >= 4.5,
      `ink ${w.glassInk.toFixed(2)}:1, muted ${w.glassMuted.toFixed(2)}:1`)
    chk(`${name}: and through both layers of the stats grid`,
      w.cellInk >= 4.5 && w.cellMuted >= 4.5,
      `ink ${w.cellInk.toFixed(2)}:1, muted ${w.cellMuted.toFixed(2)}:1`)

    // ink and muted are covered above. The rest -- --warn on the score caveat,
    // --bad and --ok on the deduction list, --dim in the graph sidebar -- are
    // only ever drawn inside a surface, so the surface is where they are
    // measured. --warn is the tight one: it starts at 4.53:1 on the flat
    // background and there is no theme headroom above it.
    const rest = [...textTokens].filter((t) => !['--ink', '--muted', '--bg', '--alarm-ink'].includes(t))
    const onGlass = rest.map((t) => {
      const rgb = hex(resolve(vars, vars[t]))
      // --kg-label is the zoom readout over the graph canvas, and that canvas
      // stayed opaque. Measuring it against a glass panel would report a number
      // brighter than the one the reader gets -- a best case, which is the one
      // thing this file is not allowed to print.
      if (t === '--kg-label') return [t, ratio(rgb, hex(resolve(vars, vars['--kg-bg'])))]
      return [t, Math.min(ratio(rgb, w.glass), ratio(rgb, w.cell))]
    })
    console.log(`     ${name}: on a surface — ${onGlass.map(([t, r]) => `${t.slice(2)} ${r.toFixed(2)}`).join(', ')}`)
    const short = onGlass.filter(([, r]) => r < 4.5)
    chk(`${name}: every other text token clears 4.5:1 on the surface it is drawn on`,
      rest.length > 0 && short.length === 0,
      short.map(([t, r]) => `${t} ${r.toFixed(2)}:1`).join(', ') || 'no text tokens found at all')
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
