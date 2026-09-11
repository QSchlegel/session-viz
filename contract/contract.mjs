// The claims contract: loading it, rendering a value, and finding the regions a
// generator is allowed to overwrite.
//
// Shared by contract/generate.mjs, contract/derive.mjs and the drift suite in
// plugins/session-viz/test/claims.mjs, and read directly by the cloud repository
// from its vendored copy. Plain ESM with no dependencies, deliberately: this
// repository's CI fails the build if package.json declares a runtime dependency,
// because a plugin is installed by copying the tree with no npm install — and
// the cloud must be able to run this file straight out of a vendored directory
// with nothing installed either.
//
// Not compiled. Everything under plugins/session-viz/src is .mts built into a
// committed scripts/ directory, and this is neither: it never ships to a user
// and it never runs at plugin runtime. Putting it through that build would
// couple a CI tool to the version-bump and committed-output rules that exist for
// shipped code.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'

/** Written \u0000 as an ESCAPE and never as a literal NUL byte in this file.
 *
 *  The reason is recorded in full in session-viz-cloud/services/web/src/blog.ts
 *  and is not restated here, because one account of a lesson is one place to
 *  correct it. The short of it: git calls a file with a NUL in its first 8000
 *  bytes binary, so it has no diff and cannot be merged — that already blocked a
 *  merge in the sibling repository and had to be resolved by taking one whole
 *  side — and grep skips such a file silently, so a search for a stale rule
 *  comes back empty rather than admitting it gave up.
 *
 *  Same byte at runtime. Ordinary text at rest. */
const NUL = '\u0000'

// ---------------------------------------------------------------- loading

/** The two trees a claim can be stated in. A surface names its tree rather than
 *  being found by probing for the file, because both repositories have a
 *  README.md — and resolving "README.md" to whichever one happens to exist first
 *  checks the wrong file and reports the right answer for it. */
export const TREES = ['session-viz', 'session-viz-cloud']
export const treeOf = (entry) => entry.tree || 'session-viz'

export const DISCIPLINES = ['frozen', 'server-first', 'negotiated']

/** A claim is either true of the tree now, or intended and not built yet.
 *
 *  The second is not a hedge, it is the only honest way to write down a claim
 *  before the behaviour exists. A registry that asserted the intended model
 *  would be stating something false with a machine's confidence behind it —
 *  precisely the failure it exists to prevent — and seeding `tells` against the
 *  CURRENT model would forbid sentences that are true today.
 *
 *  So a planned claim carries its surfaces as a definition of done and is
 *  reported rather than failed. The inversion is what keeps it honest: a planned
 *  claim whose surface starts MATCHING is a failure, because the thing became
 *  true and nobody flipped it. You cannot leave a claim parked in `planned` once
 *  the tree agrees with it. */
export const STATUSES = ['asserted', 'planned']
export const statusOf = (claim) => claim.status || 'asserted'
export const KINDS = ['number', 'list', 'enum', 'behaviour', 'prose']
export const RISKS = ['consent', 'safety', 'accuracy', 'commercial', 'cosmetic']

/** The floor for a `why`. JSON has no comments, and this codebase states its
 *  reasoning in prose beside every rule — so the reasoning became a required
 *  field. A one-word `why` is the failure this number exists to refuse. */
export const WHY_MIN = 40

export function load(root) {
  const path = join(root, 'contract', 'claims.json')
  const raw = readFileSync(path, 'utf8')
  const reg = JSON.parse(raw)
  return { ...reg, path, raw }
}

/** Every problem with the registry itself, as a list rather than a throw: a
 *  caller checking a file wants all of them at once, not the first one. */
export function wellFormed(reg) {
  const bad = []
  const say = (id, msg) => bad.push(`${id}: ${msg}`)

  if (!Number.isInteger(reg.contract_version) || reg.contract_version < 1)
    bad.push('contract_version must be a positive integer')

  for (const [id, c] of Object.entries(reg.claims || {})) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(id)) say(id, 'id must be dotted lower-case')
    if (!c.statement) say(id, 'no statement')
    if (typeof c.why !== 'string' || c.why.length < WHY_MIN)
      say(id, `why must be at least ${WHY_MIN} characters — this file has no comments, so the reasoning has to live in the data`)
    if (!KINDS.includes(c.kind)) say(id, `kind must be one of ${KINDS.join(', ')}`)
    if (!RISKS.includes(c.risk)) say(id, `risk must be one of ${RISKS.join(', ')}`)
    if (!DISCIPLINES.includes(c.discipline)) say(id, `discipline must be one of ${DISCIPLINES.join(', ')}`)
    if (c.value === undefined) say(id, 'no value')
    if (!STATUSES.includes(statusOf(c))) say(id, `status must be one of ${STATUSES.join(', ')}`)

    if (statusOf(c) === 'planned') {
      // A planned claim that generates would write a value into code which does
      // not implement it — a constant asserting a behaviour nothing performs.
      if ((c.generated || []).length)
        say(id, 'a planned claim may not generate — that writes a value into code that does not implement it yet')
      // Without a surface it is a note, not a claim, and nothing will ever tell
      // anybody it came true.
      if (!(c.checked || []).length)
        say(id, 'a planned claim needs at least one checked surface: that surface list is its definition of done')
      if (!c.plan || String(c.plan).length < WHY_MIN)
        say(id, `a planned claim needs a 'plan' of at least ${WHY_MIN} characters saying what has to be built before it is true`)
    }

    // The two rules that keep consent honest, enforced rather than intended.
    //
    // A negotiated value is one the server can change after the user agreed to
    // it. Rendering such a value into the digested disclosure gives you a
    // choice of two failures: a stored consent that covers text which is now
    // false, or a digest that moves when an operator edits a setting — which
    // fails closed, silently, for every user at once, and looks like the
    // feature breaking after an update.
    if (c.consent_material && c.discipline !== 'frozen')
      say(id, 'a consent_material claim must be frozen — the user agreed to this value, so nothing may change it under them')
    if (c.consent_material && c.discipline === 'negotiated')
      say(id, 'consent_material and negotiated are the combination this design exists to refuse')

    // A list claim whose render is a code literal must contain exactly the
    // names in its value. Without this the generator would happily write a
    // literal that disagrees with the claim it was generated from, and the
    // registry would hold two answers to one question.
    if (Array.isArray(c.value) && (c.render || {}).expr) {
      const lit = String(c.render.expr)
      const missing = c.value.filter((n) => !lit.includes(`'${n}'`))
      const quoted = (lit.match(/'[^']+'/g) || []).map((q) => q.slice(1, -1))
      if (missing.length) say(id, `render.expr omits ${missing.length} name(s) from value: ${missing.join(', ')}`)
      if (quoted.length !== c.value.length)
        say(id, `render.expr holds ${quoted.length} names and value holds ${c.value.length}`)
    }

    for (const g of c.generated || []) {
      if (!g.file || !g.region) say(id, 'a generated entry needs file and region')
      if (!TREES.includes(treeOf(g))) say(id, `generated tree '${g.tree}' is not one of ${TREES.join(', ')}`)
      if (g.emit && !(c.render || {})[g.emit]) say(id, `generated emit '${g.emit}' has no render entry`)
    }
    for (const k of c.checked || []) {
      if (!k.file || !k.match) say(id, 'a checked entry needs file and match')
      if (!TREES.includes(treeOf(k))) say(id, `checked tree '${k.tree}' is not one of ${TREES.join(', ')}`)
      try {
        const re = new RegExp(k.match)
        // An asserted surface extracts a value and compares it, so it needs
        // exactly one group. A planned surface is a presence test — has this
        // sentence appeared yet — and has nothing to extract, because the value
        // it would compare against is not true of anything yet.
        const groups = countGroups(re)
        if (statusOf(c) === 'asserted' && groups !== 1)
          say(id, `an asserted checked match must have exactly one capture group: ${k.match}`)
        if (groups > 1) say(id, `checked match has ${groups} capture groups; at most one is read: ${k.match}`)
      } catch { say(id, `checked match does not compile: ${k.match}`) }
    }
    for (const t of c.tells || []) {
      try { new RegExp(t) } catch { say(id, `tell does not compile: ${t}`) }
    }
    for (const h of c.handwritten || []) {
      if (!h.file || !h.why) say(id, 'a handwritten exemption needs a file and a reason — silencing a check should cost a sentence somebody has to write')
    }
  }
  return bad
}

const countGroups = (re) => new RegExp(`${re.source}|`).exec('').length - 1

// ---------------------------------------------------------------- rendering

/** The rendering named by `emit`, or the value itself when a claim has none.
 *
 *  Renderings are the answer to one number wanting several forms: `8 * 1024 *
 *  1024` in a constant, `8 MiB` in a refusal, `8 MB` in a sentence to a user.
 *  Those are not a discrepancy to be reconciled by whoever notices next; they
 *  are one value with three registers, and the registry is where that is said. */
export function render(claim, emit) {
  if (!emit) return String(claim.value)
  const r = (claim.render || {})[emit]
  if (r === undefined) throw new Error(`no render '${emit}' for this claim`)
  return String(r)
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty']

/** Compare a captured string against a claim, under the named normaliser.
 *
 *  `count-word` is what lets prose stay prose. A writer may say "twelve
 *  commands" or "12 commands" and both compare equal to 12, so the check pins
 *  the number without pinning the sentence — which is the whole reason this
 *  design asserts against prose rather than generating it. */
/** A checked pattern's literal spaces become `\\s+`.
 *
 *  Prose wraps. A sentence that fits on one line today is reflowed by the next
 *  person who edits the paragraph around it, and a pattern that breaks on a
 *  newline fails a correct edit — which is the friction that teaches a writer to
 *  widen a pattern until it stops asserting anything. Patterns stay readable in
 *  the registry and tolerant in the tree. */
export const checkedRe = (match) => new RegExp(match.replace(/ /g, '\\s+'))

export function matches(as, captured, claim) {
  const v = claim.value
  const n = Array.isArray(v) ? v.length : v
  const got = String(captured).trim()
  switch (as || 'exact') {
    case 'exact': return got === String(v)
    case 'number': return Number(got) === Number(n)
    case 'plain-number': return Number(got) === Number(render(claim, 'plain').replace(/[^\d.]/g, ''))
    case 'count-word': {
      const asNum = /^\d+$/.test(got) ? Number(got) : WORDS.indexOf(got.toLowerCase())
      return asNum === Number(n)
    }
    case 'set': {
      const want = new Set((Array.isArray(v) ? v : String(v).split(/\s*,\s*/)).map(slug))
      const have = new Set(got.split(/\s*(?:,|and)\s*/).filter(Boolean).map(slug))
      return want.size === have.size && [...want].every((x) => have.has(x))
    }
    default: throw new Error(`unknown normaliser '${as}'`)
  }
}

const slug = (s) => String(s).toLowerCase().replace(/^[/\s]+|[\s.]+$/g, '').replace(/[^a-z0-9]+/g, '-')

// ---------------------------------------------------------------- regions

/** A region is a comment pair in the host language. The comment is the only
 *  thing that authorises a machine to overwrite that span — the same reasoning
 *  install.mts gives for its own marker, where `<!-- installed by session-viz`
 *  is the only thing that lets --uninstall delete a file, so a skill somebody
 *  wrote by hand is left exactly where it is.
 *
 *  Interiors only. The doc comment above a constant, the paragraph that gives a
 *  number its meaning, the twenty-five-line header explaining why 8 MiB and why
 *  draining is not resetting — none of that is generated. Generate the literal,
 *  never the argument around it. */
export const NOTE = 'generated from contract/claims.json — do not edit'

const MARKERS = {
  line: (id) => ({
    open: new RegExp(`^([ \\t]*)// <contract:${esc(id)}>.*$`, 'm'),
    close: new RegExp(`^[ \\t]*// </contract:${esc(id)}>.*$`, 'm'),
    openText: (indent) => `${indent}// <contract:${id}> ${NOTE}`,
    closeText: (indent) => `${indent}// </contract:${id}>`,
  }),
  html: (id) => ({
    open: new RegExp(`^([ \\t]*)<!-- <contract:${esc(id)}>.*$`, 'm'),
    close: new RegExp(`^[ \\t]*<!-- </contract:${esc(id)}> -->[ \\t]*$`, 'm'),
    openText: (indent) => `${indent}<!-- <contract:${id}> ${NOTE} -->`,
    closeText: (indent) => `${indent}<!-- </contract:${id}> -->`,
  }),
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const syntaxFor = (file) =>
  ['.md', '.html'].includes(extname(file)) ? 'html' : 'line'

/** Lift fenced code blocks out before the markers are looked for, and put them
 *  back afterwards.
 *
 *  Load-bearing, not tidy: the README documents this very marker inside a fenced
 *  block, and a naive search would bind to the documentation and splice the file
 *  at its own example. Extract first, restore last — blog.ts's code-span round
 *  trip, for the same reason it gives. */
function protectFences(text) {
  const held = []
  const out = text.replace(/^```[\s\S]*?^```[ \t]*$/gm, (block) => {
    held.push(block)
    return `${NUL}${held.length - 1}${NUL}`
  })
  return { out, restore: (s) => s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, 'g'), (_, i) => held[Number(i)]) }
}

/**
 * Replace the interior of one region. Returns null when the file has no such
 * region, which the caller reports as a claim that generates nowhere — a claim
 * nobody reads is a claim that is not doing its job.
 */
export function spliceRegion(text, id, body, file) {
  const { out, restore } = protectFences(text)
  const m = MARKERS[syntaxFor(file)](id)
  const o = m.open.exec(out)
  if (!o) return null
  const after = out.slice(o.index + o[0].length)
  const c = m.close.exec(after)
  if (!c) throw new Error(`${file}: <contract:${id}> is opened and never closed`)
  const indent = o[1] || ''
  const rebuilt =
    out.slice(0, o.index) +
    m.openText(indent) + '\n' +
    body.split('\n').map((l) => (l ? indent + l : l)).join('\n') + '\n' +
    m.closeText(indent) +
    after.slice(c.index + c[0].length)
  const final = restore(rebuilt)
  if (final.includes(NUL)) throw new Error(`${file}: refusing to write a file containing a literal NUL byte`)
  return final
}

/** Every region marker present in a file, whether or not the registry knows it.
 *  An unknown id here is a hard failure at generate time: there is no fallback
 *  that quietly leaves the old text, because that is precisely how a claim would
 *  go on being stated after it stopped being registered. */
export function regionsIn(text, file) {
  const { out } = protectFences(text)
  const tag = syntaxFor(file) === 'html' ? /<!-- <contract:([a-z0-9_.]+)>/g : /\/\/ <contract:([a-z0-9_.]+)>/g
  const ids = []
  for (const m of out.matchAll(tag)) ids.push(m[1])
  return ids
}

/** The span of every region in a file, so a scanner can exclude generated text
 *  from a search for hand-written claims. Without this the tells scan reports
 *  the generator's own output as an unmanaged claim. */
export function regionSpans(text, file) {
  const spans = []
  for (const id of regionsIn(text, file)) {
    const m = MARKERS[syntaxFor(file)](id)
    const o = m.open.exec(text)
    if (!o) continue
    const after = text.slice(o.index + o[0].length)
    const c = m.close.exec(after)
    if (!c) continue
    spans.push([o.index, o.index + o[0].length + c.index + c[0].length])
  }
  return spans
}

// ---------------------------------------------------------------- the tree

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test-dist', 'scripts', 'contract', '.session-viz'])
const READ_EXT = new Set(['.md', '.ts', '.mts', '.mjs', '.js', '.json', '.html', '.yml', '.yaml'])

/** Files a claim may be stated in. `scripts/` is excluded because it is
 *  committed build output with its own gate — a claim found there is the same
 *  claim already found in src/, reported twice. */
export function* files(root) {
  const walk = function* (dir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude-plugin' && e.name !== '.github') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        yield* walk(p)
      } else if (READ_EXT.has(extname(e.name))) {
        yield p
      }
    }
  }
  yield* walk(root)
}

export const lineOf = (text, index) => text.slice(0, index).split('\n').length

export const rel = (root, p) => relative(root, p)

export const exists = (p) => { try { statSync(p); return true } catch { return false } }
