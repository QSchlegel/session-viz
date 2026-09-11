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

/** A minimal Session, enough for the projection to emit every key.
 *
 *  Synthetic rather than a real spine: a derive that reads a transcript would
 *  change its answer depending on whose machine it ran on, and a check whose
 *  result depends on the corpus is not a check. */
const FIXTURE_SESSION = {
  sessionId: 's', harness: 'claude-code', cwd: '/w/repo', gitBranch: 'b', version: '1',
  title: 't', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
  durationMs: 60000, redactedPrompts: true, recordedPaths: true,
  models: { m: 1 }, slashCommands: ['/x'],
  artifacts: { tools: { git: 1 }, mcp: { s: 1 }, packages: {}, stack: {}, extensions: {}, skills: {}, fileTouches: 1 },
  totals: {
    records: 1, humanTurns: 1, assistantMessages: 1, toolCalls: 1, sidechainRecords: 0,
    interruptions: 0, compactions: 0, steeringTurns: 0, repeats: 0, corrections: 0,
    frictionTurns: 0, frictionRate: 0, tokens: { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
  },
  turns: [{ index: 0, durationMs: 1, toolCallCount: 1, tokens: { output: 1 }, friction: [], score: { value: 1 }, files: [{ path: 'a.ts', count: 1 }] }],
  score: { value: 1, band: 'clean', confidence: 'low', turnsScored: 1, frictionRate: 0, craftRate: 0, wastedTokens: 0, costliestTurn: 0 },
}

/**
 * What the projection ACTUALLY emits, by running it.
 *
 * Not by reading the field list it exports — that constant is generated from the
 * registry, so comparing it to the registry would compare the registry to
 * itself. The walk's vocabulary comes from contract/facts.json, a third file, so
 * three things must agree: the schema's membership, the registry's claim, and
 * the keys the code writes. Any one of them moving alone is visible.
 */
/** ESM caches a module by URL, and the perturbation rewrites the same file in
 *  the same directory — so a cache-buster derived from the file's CONTENT is no
 *  buster at all when the content is what changed and the key is not. This
 *  counter made --prove go from green to red on two derives that were reading a
 *  stale copy of the module they claimed to be reading. */
let importSeq = 0

const emittedFields = async (root, tier) => {
  const { readFileSync } = await import('node:fs')
  const facts = JSON.parse(readFileSync(join(root, 'contract', 'facts.json'), 'utf8'))
  const known = Object.entries(facts.fields).filter(([, v]) => v.tier === tier).map(([k]) => k)
  const mod = await import(`${join(root, 'plugins', 'session-viz', 'scripts', 'facts.mjs')}?t=${importSeq++}`)
  if (tier === 'trace') {
    // Run the projection, do not read the schema back. A derive that returned
    // facts.json's own keys would compare the schema to the registry — a
    // comparison the suite already makes — while saying nothing at all about
    // what the code writes, which is the only thing that reaches a wire.
    const [call] = mod.traceFacts([{ turn: 0, seq: 0, tool: 'Bash', input: {}, result: 'x' }])
    return Object.keys(call || {}).sort()
  }
  return mod.keyPaths(mod.indexFacts(FIXTURE_SESSION, { pluginVersion: '0' }), known).sort()
}

export const DERIVES = {
  /** Run the extractor with no options over a two-record transcript and look at
   *  what came back. Not a grep for the flag name: a flag can be renamed, wired
   *  to the wrong option, or defaulted the other way in the function signature,
   *  and only running it can tell the difference. */
  'extract.trace.default_off': async (root) => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'sv-derive-'))
    try {
      const f = join(dir, 's.jsonl')
      const recs = [
        { type: 'assistant', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', sessionId: 's', cwd: '/w/r', message: { model: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] } },
        { type: 'user', uuid: 'b', timestamp: '2026-01-01T00:00:01Z', sessionId: 's', cwd: '/w/r', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'out' }] } },
      ]
      writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
      const mod = await import(`${join(root, 'plugins', 'session-viz', 'scripts', 'extract.mjs')}?t=${importSeq++}`)
      const out = await mod.extract(f)
      if (out.totals.toolCalls < 1) return 'inconclusive — the fixture produced no tool call'
      return (out.trace || []).length === 0 && out.retainedTrace === false ? 'off' : 'on'
    } finally { rmSync(dir, { recursive: true, force: true }) }
  },
  'facts.index.fields': (root) => emittedFields(root, 'index'),
  'facts.trace.call_fields': (root) => emittedFields(root, 'trace'),

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
  'extract.trace.default_off': (root) => {
    const p = join(root, 'plugins', 'session-viz', 'scripts', 'extract.mjs')
    writeFileSync(p, read(p).replace('retainTrace = false', 'retainTrace = true'))
    return 'flipped the default to retaining every tool call'
  },
  // These break the PROJECTION, not the schema. Removing a field from
  // contract/facts.json leaves the code emitting it and the walk reporting it
  // as an undeclared path, so the derive's answer is unchanged and the
  // perturbation proves nothing — which is how this was written first, and why
  // --prove exists at all. The failure worth catching is a field added to the
  // projection, so that is the field added here.
  'facts.index.fields': (root) => {
    const p = join(root, 'plugins', 'session-viz', 'scripts', 'facts.mjs')
    writeFileSync(p, read(p).replace('schema_version: SCHEMA_VERSION,', 'schema_version: SCHEMA_VERSION, cwd: s.cwd,'))
    return 'added cwd to the index projection'
  },
  'facts.trace.call_fields': (root) => {
    const p = join(root, 'plugins', 'session-viz', 'scripts', 'facts.mjs')
    writeFileSync(p, read(p).replace('turn: Number(c.turn || 0),', 'turn: Number(c.turn || 0), transcript: c.transcript,'))
    return 'added transcript to the trace projection'
  },
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

export async function prove(root) {
  const results = []
  for (const [id, perturb] of Object.entries(PERTURBATIONS)) {
    const tmp = mkdtempSync(join(tmpdir(), 'sv-claims-'))
    try {
      // Only the two directories the derives read. Copying the whole repository
      // would drag node_modules and .git through a temp dir on every CI run.
      cpSync(join(root, 'plugins'), join(tmp, 'plugins'), { recursive: true })
      // contract/ too: the facts derives read the schema from it, and a copy
      // without it would make them throw rather than disagree.
      cpSync(join(root, 'contract'), join(tmp, 'contract'), { recursive: true })
      const before = await DERIVES[id](tmp)
      const what = perturb(tmp)
      const after = await DERIVES[id](tmp)
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
    for (const r of await prove(root)) {
      console.log(`${r.noticed ? 'ok  ' : 'FAIL'} ${r.id} — ${r.what}`)
      if (!r.noticed) {
        failed++
        console.log(`       still ${JSON.stringify(r.after)} after the break; this derive is not reading what it claims to read`)
      }
    }
    process.exit(failed ? 1 : 0)
  } else if (DERIVES[arg]) {
    console.log(JSON.stringify(await DERIVES[arg](root)))
  } else {
    console.error(`no derive '${arg}'. Known: ${Object.keys(DERIVES).join(', ')}`)
    process.exit(2)
  }
}
