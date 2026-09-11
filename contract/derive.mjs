#!/usr/bin/env node
// Derives: recompute a claim's value from the tree, so the registry records what
// is true rather than what was true.
//
//   node contract/derive.mjs --list
//   node contract/derive.mjs commands.outbound
//   node contract/derive.mjs --prove
//
// -- Why a derive must be a real read, never a grep --------------------------
// A grep that silently finds nothing returns the old answer and stays green,
// which is the one failure mode a drift test cannot survive: it would report
// agreement between the registry and a tree it did not actually inspect. So
// commands.count walks the skills directory the way install.mts already walks
// it, commands.model_invocable parses frontmatter rather than matching the flag
// string, and commands.outbound follows the import graph instead of looking for
// the word "fetch".
//
// -- --prove, and why it is its own CI step ---------------------------------
// A derive nobody has watched fail is documentation. --prove copies the tree to
// a temporary directory, breaks each claim on purpose — adds a thirteenth skill,
// removes a frontmatter flag, wires a network call into a command that has none
// — and asserts the derive notices. A derive that stays green under its own
// perturbation is reported as broken, because that is exactly what it is.

import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = (root) => join(root, 'plugins', 'session-viz', 'src')
const SKILLS = (root) => join(root, 'plugins', 'session-viz', 'skills')

const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

/** The skill directories, which are what a command IS: a directory with a
 *  SKILL.md in it is a command, and nothing else in the tree defines one. */
const skillNames = (root) =>
  readdirSync(SKILLS(root), { withFileTypes: true })
    .filter((e) => e.isDirectory() && read(join(SKILLS(root), e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort()

/** Frontmatter, parsed rather than grepped: a flag inside a fenced example or a
 *  sentence about the flag is not the flag. */
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!m) return {}
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

/** module -> modules it imports, across src/*.mts. Imports are written
 *  `from './x.mjs'` because the source is .mts compiled to .mjs; the edge is to
 *  the .mts that produces it. */
const importGraph = (root) => {
  const g = new Map()
  for (const f of readdirSync(SRC(root)).filter((f) => f.endsWith('.mts'))) {
    const body = read(join(SRC(root), f))
    const to = [...body.matchAll(/from '\.\/([a-z-]+)\.mjs'/g)].map((m) => `${m[1]}.mts`)
    g.set(f, [...new Set(to)])
  }
  return g
}

/** A module is outbound when it reads the workspace credential — it imports
 *  config() from cloud.mts and calls it. That is the honest test: a module with
 *  a fetch( to a public price list is not putting the user's work on a wire, and
 *  one that mints a token is moving a credential, not a payload. */
const outboundModules = (root) => {
  const out = new Set()
  for (const f of readdirSync(SRC(root)).filter((f) => f.endsWith('.mts'))) {
    const body = read(join(SRC(root), f))
    const importsConfig = /import\s*\{[^}]*\bconfig\b[^}]*\}\s*from '\.\/cloud\.mjs'/.test(body)
    const callsConfig = /(?<!function\s)\bconfig\(\)/.test(body.replace(/^\/\/.*$/gm, ''))
    if (importsConfig && callsConfig) out.add(f)
  }
  return out
}

/** The modules a skill actually invokes, followed transitively. A skill names
 *  its scripts by path; everything those scripts import counts too, because a
 *  send one import away is still a send. */
const modulesOf = (root, skill) => {
  const body = read(join(SKILLS(root), skill, 'SKILL.md'))
  const direct = [...body.matchAll(/scripts\/([a-z-]+)\.mjs/g)].map((m) => `${m[1]}.mts`)
  const g = importGraph(root)
  const seen = new Set()
  const stack = [...new Set(direct)]
  while (stack.length) {
    const m = stack.pop()
    if (seen.has(m)) continue
    seen.add(m)
    for (const n of g.get(m) || []) stack.push(n)
  }
  return seen
}

/** A skill that issues a network call in its own instructions, without reaching
 *  the credential. /qcost's first step curls an unauthenticated rate card: no
 *  credential leaves, but a request does, and a command that opens a socket is
 *  not a command that "sends nothing anywhere". */
const networkSkills = (root) =>
  skillNames(root).filter((s) => /\bcurl\b|SESSION_VIZ_URL/.test(read(join(SKILLS(root), s, 'SKILL.md'))))

export const DERIVES = {
  'commands.count': (root) => skillNames(root).length,

  'commands.model_invocable': (root) =>
    skillNames(root).filter((s) =>
      frontmatter(read(join(SKILLS(root), s, 'SKILL.md')))['disable-model-invocation'] !== 'true'),

  'commands.outbound': (root) => {
    const out = outboundModules(root)
    return skillNames(root).filter((s) => [...modulesOf(root, s)].some((m) => out.has(m)))
  },

  'commands.silent': (root) => {
    const out = new Set(DERIVES['commands.outbound'](root))
    const net = new Set(networkSkills(root))
    return skillNames(root).filter((s) => !out.has(s) && !net.has(s))
  },

  'receipt.fetch_call_sites': (root) =>
    readdirSync(SRC(root)).filter((f) => f.endsWith('.mts') && read(join(SRC(root), f)).includes('fetch(')).length,
}

// ------------------------------------------------------------------- --prove

/** One deliberate break per derive, each chosen to be the change a real feature
 *  would make: a new command, a flag removed, a network call added. */
const PERTURBATIONS = {
  'commands.count': (root) => {
    mkdirSync(join(SKILLS(root), 'qthirteen'), { recursive: true })
    writeFileSync(join(SKILLS(root), 'qthirteen', 'SKILL.md'), '---\nname: qthirteen\ndescription: a command that did not exist\n---\n')
    return 'added a thirteenth skill directory'
  },
  'commands.model_invocable': (root) => {
    const p = join(SKILLS(root), 'qshare', 'SKILL.md')
    writeFileSync(p, read(p).replace(/^disable-model-invocation: true$/m, 'disable-model-invocation: false'))
    return 'let the model start /qshare on its own'
  },
  'commands.outbound': (root) => {
    const p = join(SRC(root), 'ship.mts')
    writeFileSync(p, `import { config } from './cloud.mjs'\nconst _c = () => config()\n${read(p)}`)
    return 'wired the credential into /qship'
  },
  'commands.silent': (root) => {
    const p = join(SKILLS(root), 'qruns', 'SKILL.md')
    writeFileSync(p, `${read(p)}\n\ncurl -fsS "\${SESSION_VIZ_URL}/v1/anything"\n`)
    return 'gave /qruns a network step'
  },
  'receipt.fetch_call_sites': (root) => {
    const p = join(SRC(root), 'out.mts')
    writeFileSync(p, `${read(p)}\nexport const _probe = () => fetch('https://example.invalid')\n`)
    return 'added a seventh fetch( call site'
  },
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function prove(root) {
  const results = []
  for (const [id, perturb] of Object.entries(PERTURBATIONS)) {
    const tmp = mkdtempSync(join(tmpdir(), 'sv-claims-'))
    try {
      // Only the two directories the derives read. Copying the whole repository
      // would drag node_modules and .git through a temp dir on every CI run.
      cpSync(join(root, 'plugins'), join(tmp, 'plugins'), { recursive: true })
      const before = DERIVES[id](tmp)
      const what = perturb(tmp)
      const after = DERIVES[id](tmp)
      results.push({ id, what, before, after, noticed: !same(before, after) })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  return results
}

// ---------------------------------------------------------------------- cli

const root = process.cwd()
const arg = process.argv[2]

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!arg || arg === '--list') {
    for (const id of Object.keys(DERIVES)) console.log(id)
  } else if (arg === '--prove') {
    let failed = 0
    for (const r of prove(root)) {
      console.log(`${r.noticed ? 'ok  ' : 'FAIL'} ${r.id} — ${r.what}`)
      if (!r.noticed) {
        failed++
        console.log(`       still ${JSON.stringify(r.after)} after the break; this derive is not reading what it claims to read`)
      }
    }
    process.exit(failed ? 1 : 0)
  } else if (DERIVES[arg]) {
    console.log(JSON.stringify(DERIVES[arg](root)))
  } else {
    console.error(`no derive '${arg}'. Known: ${Object.keys(DERIVES).join(', ')}`)
    process.exit(2)
  }
}
