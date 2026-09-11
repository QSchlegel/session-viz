#!/usr/bin/env node
// The claims contract, asserted against both trees.
//
// What this guards is the difference between a promise and a mechanism. Before
// it existed, a number that appeared in six places was kept correct in six
// places by hand, and the source comments say so: services/api/src/report.ts
// carries "If one of the two ever moves, both move" about a ceiling this
// repository also defines. An inventory of both trees found 825 claim
// statements, 71 distinct claims, and 35 pairs that already disagreed —
// including a headline privacy sentence that was generous by two commands.
//
// Five checks, each aimed at a failure that has already happened here:
//
//   1. The registry is well-formed, and a consent claim cannot be one the
//      server is allowed to change underneath the person who agreed to it.
//   2. Every derived value is still true of the code. This is the check that
//      earns the registry: /qfeed, /qbl --shared and /qpact --ship each became
//      outbound without the sentence saying "two commands" being reread.
//   3. Every checked surface still says it, with the number normalised so
//      "twelve" and "12" compare equal — the registry pins the number inside
//      the sentence, never the sentence.
//   4. A retired phrasing appears nowhere. A tell is a phrasing that is WRONG
//      NOW, not merely a phrasing of the claim: "never open a socket" is true
//      of the four commands that do not open one, and forbidding those words
//      would fail a corrected sentence and teach the next writer to widen the
//      pattern until it asserts nothing. qshare.mts records that it removed
//      the promise "this page never leaves this machine" and explains why;
//      skills/qshare/SKILL.md went on saying it for releases afterwards,
//      because nothing connected the two files.
//   5. Every generated region is what the generator would write now.
//
// The sibling repository is checked when it is on disk beside this one and
// reported as skipped when it is not. A skipped surface is printed rather than
// passed over: a check that silently covers half of what it names is the shape
// of a green build that proves nothing.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { load, wellFormed, matches, checkedRe, regionSpans, spliceRegion, files, rel, exists, lineOf, treeOf, statusOf } from '../../../contract/contract.mjs'
import { DERIVES } from '../../../contract/derive.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SIBLING = process.env.SESSION_VIZ_CLOUD || resolve(ROOT, '..', 'session-viz-cloud')

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (t) => console.log(`\n— ${t}`)

const reg = load(ROOT)
const regionsIn_count = (text) => regionSpans(text, 'x.ts').length
const TREES = [{ name: 'session-viz', label: 'this repository', root: ROOT }]
if (exists(join(SIBLING, 'services')))
  TREES.push({ name: 'session-viz-cloud', label: 'session-viz-cloud', root: SIBLING })
const treeRoot = (name) => TREES.find((t) => t.name === name)

// --------------------------------------------------------------- 1. the file

section('The registry itself')
const bad = wellFormed(reg)
chk(`contract v${reg.contract_version}, ${Object.keys(reg.claims).length} claims, well-formed`,
  bad.length === 0, bad.join('\n       '))

for (const [id, c] of Object.entries(reg.claims)) {
  const surfaces = (c.generated || []).length + (c.checked || []).length
  chk(`${id} is not decorative`, surfaces > 0 || (c.tells || []).length > 0,
    'a claim with no generated surface, no checked surface and no tell asserts nothing')
}

// ------------------------------------------------------------- 2. the derives

section('Values still true of the code')
for (const [id, c] of Object.entries(reg.claims)) {
  if (!c.derive) continue
  const fn = DERIVES[c.derive]
  if (!fn) { chk(`${id} names a derive`, false, `no derive '${c.derive}'`); continue }
  const got = await fn(ROOT)
  const want = c.value
  chk(`${id} — ${c.statement}`, JSON.stringify(got) === JSON.stringify(want),
    `the registry says ${JSON.stringify(want)}; the tree says ${JSON.stringify(got)}`)
}

const underived = Object.entries(reg.claims).filter(([, c]) => !c.derive)
if (underived.length)
  console.log(`     ${underived.length} claim(s) carry no derive and cannot be proved by machine: ${underived.map(([i]) => i).join(', ')}`)

// ------------------------------------------------- 2b. the schema and the claim

// contract/facts.json owns each field's shape; the registry owns the membership;
// the code writes the keys. Three files, one question, so any one of them moving
// alone is visible — and the derive above already compares the code against the
// schema's vocabulary, which leaves exactly this comparison to make.
section('The schema and the registry name the same fields')
{
  const facts = JSON.parse(readFileSync(join(ROOT, 'contract', 'facts.json'), 'utf8'))
  const pairs = [
    ['facts.index.fields', Object.entries(facts.fields).filter(([, v]) => v.tier === 'index').map(([k]) => k)],
    ['facts.trace.call_fields', Object.keys(facts.trace_call_fields)],
  ]
  for (const [id, fromSchema] of pairs) {
    const claim = reg.claims[id]
    if (!claim) { chk(`${id} is registered`, false, 'contract/facts.json describes fields no claim carries'); continue }
    const a = [...fromSchema].sort(), b = [...claim.value].sort()
    const onlySchema = a.filter((x) => !b.includes(x))
    const onlyClaim = b.filter((x) => !a.includes(x))
    chk(`${id} matches contract/facts.json`, !onlySchema.length && !onlyClaim.length,
      [onlySchema.length ? `only in facts.json: ${onlySchema.join(', ')}` : '',
       onlyClaim.length ? `only in the claim: ${onlyClaim.join(', ')}` : ''].filter(Boolean).join('\n       '))
  }
}

// ------------------------------------------------------------ 3. the surfaces

section('Surfaces still say it')
let skipped = 0
for (const [id, c] of Object.entries(reg.claims)) {
  if (statusOf(c) !== 'asserted') continue
  for (const k of c.checked || []) {
    const t = treeRoot(treeOf(k))
    if (!t) { skipped++; console.log(`skip ${id} — ${k.file} lives in ${treeOf(k)}, which is not on this machine`); continue }
    const hit = join(t.root, k.file)
    if (!exists(hit)) {
      chk(`${id} in ${treeOf(k)}/${k.file}`, false, 'the registry names this surface and the file is not there')
      continue
    }
    const text = readFileSync(hit, 'utf8')
    const m = checkedRe(k.match).exec(text)
    if (!m) {
      chk(`${id} in ${treeOf(k)}/${k.file}`, false,
        `nothing matched /${k.match}/ — either the sentence was removed, or it was rewritten past the pattern`)
      continue
    }
    // A boolean claim is satisfied by the sentence being there; there is no
    // captured value to compare it against.
    if (typeof c.value === 'boolean') {
      chk(`${id} in ${treeOf(k)}/${k.file}:${lineOf(text, m.index)}`, true)
      continue
    }
    chk(`${id} in ${treeOf(k)}/${k.file}:${lineOf(text, m.index)}`, matches(k.as, m[1], c),
      `it says ${JSON.stringify(m[1])}; the registry says ${JSON.stringify(c.value)}`)
  }
}
if (skipped) console.log(`     ${skipped} surface(s) skipped because their tree is absent`)

// ------------------------------------------------- 3b. what is not true yet

// A planned claim records intended behaviour. It is reported, not asserted,
// because writing it down as true would be the registry stating something false
// with a machine's confidence behind it — the exact failure it exists to
// prevent. Its checked surfaces are its definition of done.
//
// The assertion runs the other way, and it is the part that keeps this honest:
// a planned surface that MATCHES is a failure. The thing became true and nobody
// flipped the status, so the registry is now understating what the product does
// — which is the same drift as overstating it, pointing the other way.
section('Not true yet, and known not to be')
const planned = Object.entries(reg.claims).filter(([, c]) => statusOf(c) === 'planned')
for (const [id, c] of planned) {
  console.log(`     ${id} — ${c.statement}`)
  for (const k of c.checked || []) {
    const t = treeRoot(treeOf(k))
    if (!t) { console.log(`skip ${id} — ${k.file} lives in ${treeOf(k)}, which is not on this machine`); continue }
    const hit = join(t.root, k.file)
    if (!exists(hit)) continue
    const text = readFileSync(hit, 'utf8')
    const m = checkedRe(k.match).exec(text)
    chk(`${id} is still planned, and ${treeOf(k)}/${k.file} still does not claim it`, !m,
      m ? `${treeOf(k)}/${k.file}:${lineOf(text, m.index)} now says ${JSON.stringify(m[0])}. If the behaviour landed, set this claim's status to "asserted" so it is held to it; if the sentence landed and the behaviour did not, that sentence is the drift.` : '')
  }
}
if (planned.length)
  console.log(`     ${planned.length} planned claim(s). Each one's checked surfaces are what "done" means for it.`)

// --------------------------------------------------------------- 4. the tells

section('Retired and unmanaged phrasings')
for (const [id, c] of Object.entries(reg.claims)) {
  if (!(c.tells || []).length) continue
  const hits = []
  const exempt = new Set((c.handwritten || []).map((h) => h.file))
  for (const { label, root } of TREES) {
    for (const f of files(root)) {
      const r = rel(root, f)
      if (exempt.has(r)) continue
      const text = readFileSync(f, 'utf8')
      const spans = regionSpans(text, f)
      for (const t of c.tells) {
        for (const m of text.matchAll(new RegExp(t, 'g'))) {
          if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue
          hits.push(`${label}: ${r}:${lineOf(text, m.index)} — ${JSON.stringify(m[0])}`)
        }
      }
    }
  }
  chk(`${id} is not stated in a retired form`, hits.length === 0, hits.join('\n       '))
}

// ------------------------------------------------- 4b. the splice, on its own

// Documentation that contains the marker is the case that breaks a naive
// splice: contract/README.md shows the region syntax inside a fenced block, and
// a generator that searched the raw text would bind to the example and rewrite
// the file at its own documentation. The scanner excludes contract/ entirely,
// so that file does NOT exercise this — which is exactly why it is asserted
// here against a constructed case rather than assumed from a passing suite.
section('A fenced example is not mistaken for a region')
{
  const doc = [
    'Prose above.',
    '',
    '```ts',
    '// <contract:limits.document_bytes> generated from contract/claims.json — do not edit',
    'export const EXAMPLE = 1',
    '// </contract:limits.document_bytes>',
    '```',
    '',
    '// <contract:limits.document_bytes> generated from contract/claims.json — do not edit',
    'export const REAL = 0',
    '// </contract:limits.document_bytes>',
    '',
    'Prose below.',
  ].join('\n')

  chk('a marker inside a fence is not reported as a region',
    regionsIn_count(doc) === 1, `found ${regionsIn_count(doc)} region(s); the fenced example should not count`)

  const out = spliceRegion(doc, 'limits.document_bytes', 'export const REAL = 8 * 1024 * 1024', 'x.ts')
  // Asserted AFTER the closing fence, not anywhere in the file. Without the
  // placeholder pass the splice rewrites the fenced example instead, and the
  // new text is then present — inside the fence — so a bare `includes` passes
  // while the generator has just corrupted the documentation it was shown.
  const afterFence = out === null ? '' : out.slice(out.lastIndexOf('```') + 3)
  chk('the real region is the one rewritten, below the fence',
    afterFence.includes('export const REAL = 8 * 1024 * 1024'),
    'the replacement did not land after the fenced example, which means it landed inside it')
  chk('the fenced example is left exactly as it was', out !== null && out.includes('export const EXAMPLE = 1'))
  chk('the fence itself survives', out !== null && (out.match(/```/g) || []).length === 2)
  chk('nothing NUL-shaped is left behind', out !== null && !out.includes('\u0000'),
    'the placeholder pass restores every fence it lifted, or the file ships with a byte git calls binary')
}

// -------------------------------------------------------- 5. generated regions

section('Generated regions')
for (const { name, label, root } of TREES) {
  const r = spawnSync('node',
    [join(ROOT, 'contract', 'generate.mjs'), 'verify', '--tree', root, '--name', name, '--registry-root', ROOT],
    { encoding: 'utf8' })
  chk(`${label}: every region is what the registry would write`, r.status === 0,
    `${r.stdout || ''}${r.stderr || ''}`.trim())
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
