#!/usr/bin/env node
// Write the registry's values into the regions that are allowed to hold them.
//
//   node contract/generate.mjs verify              # regenerate into memory, diff
//   node contract/generate.mjs write               # rewrite the regions in place
//   node contract/generate.mjs verify --tree ../session-viz-cloud --registry <path>
//
// -- What is generated, and what is only checked ----------------------------
// Generated: literals. A constant, a table row, an enumeration whose content IS
// the enumeration. Checked: a number inside a sentence somebody wrote. The
// second is the larger half on purpose — this repository's prose is the best
// thing in it, and a sentence assembled from a template reads like one. The
// registry pins the number inside the sentence; it does not write the sentence.
//
// That split is also what lets a JSON manifest join the registry at all.
// marketplace.json and plugin.json cannot carry a comment, so they cannot carry
// a region marker, so they can be checked and never generated. A marker smuggled
// into a manifest string is a marker that ships to users.
//
// -- verify, not write-then-diff --------------------------------------------
// CI regenerates into memory and compares, rather than writing and asking git
// what changed. It names the file and the claim id in the failure instead of
// printing a diff stat, and it gives the same answer against a dirty working
// tree — which is the difference between a check somebody can run mid-edit and
// one they learn to run only before committing.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load, render, spliceRegion, regionsIn, files, rel, exists, treeOf } from './contract.mjs'

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const mode = process.argv[2] === 'write' ? 'write' : 'verify'
const tree = resolve(flag('tree', process.cwd()))
const treeName = flag('name', 'session-viz')
const registryRoot = resolve(flag('registry-root', process.cwd()))

const reg = load(registryRoot)

/** The text a region should contain. `template` places the value inside a
 *  declaration; without one the body is the value alone. */
const bodyFor = (claim, g) => {
  const value = render(claim, g.emit)
  return g.template ? g.template.replace('{}', value) : value
}

const problems = []
const touched = []
const seen = new Map()

for (const [id, claim] of Object.entries(reg.claims)) {
  for (const g of claim.generated || []) {
    // A region belonging to the other repository is not this run's business.
    // Skipped by NAME rather than by whether the file happens to exist here:
    // both trees have a README.md, and "absent, so skip" would silently pass a
    // region that is genuinely missing from the tree that owns it.
    if (treeOf(g) !== treeName) continue
    const path = join(tree, g.file)
    if (!exists(path)) {
      problems.push(`${g.file}: claim '${id}' generates into ${treeOf(g)} and this file is not in that tree`)
      continue
    }
    const before = readFileSync(path, 'utf8')
    let after
    try {
      after = spliceRegion(before, id, bodyFor(claim, g), g.file)
    } catch (e) {
      problems.push(`${g.file}: ${e.message}`)
      continue
    }
    if (after === null) {
      problems.push(`${g.file}: the registry says claim '${id}' generates here, and the file has no <contract:${id}> region`)
      continue
    }
    seen.set(`${id}@${g.file}`, 'present')
    if (after !== before) {
      if (mode === 'write') { writeFileSync(path, after); touched.push(`${g.file} <- ${id}`) }
      else problems.push(`${g.file}: <contract:${id}> is not what the registry would write now — run 'node contract/generate.mjs write'`)
    }
  }
}

// A region whose id the registry does not know. There is deliberately no
// fallback that leaves the old text in place: that is exactly how a claim goes
// on being stated after it has stopped being registered.
for (const f of files(tree)) {
  const text = readFileSync(f, 'utf8')
  for (const id of regionsIn(text, f))
    if (!reg.claims[id]) problems.push(`${rel(tree, f)}: <contract:${id}> names a claim the registry does not have`)
}

if (mode === 'write') {
  for (const t of touched) console.log(`wrote ${t}`)
  if (!touched.length) console.log('nothing to write — every region already matches the registry')
}

const absent = [...seen.entries()].filter(([, v]) => v === 'absent').map(([k]) => k)
if (absent.length) console.log(`skipped ${absent.length} region(s) whose file is not in this tree: ${absent.join(', ')}`)

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`${mode}: every generated region matches contract v${reg.contract_version}`)
