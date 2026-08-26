// The six sentences a bill of materials is allowed to say, and the six ways it
// lies if any of them slips.
//
// Every fixture below is a shape this machine's own trees actually contain: a
// lockfile that resolves a caret range to a concrete version, a workspace whose
// members are symlinked rather than fetched, a package installed twice at two
// versions, a lock entry with no `license` field at all, a project locked by a
// pnpm-lock.yaml this module cannot read, and a directory with no manifest.
//
// The failure this file exists to prevent is not a crash. It is a BOM that
// prints "^5.3.0" under a column headed Version, or "MIT" beside a package that
// never claimed it, or a direct-dependency list with the word BOM at the top —
// each of which is wrong in a way that reads as correct.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { readSbom, matchImportRoots, packageNameOf, graphOf } = await import('../scripts/sbom.mjs')

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

// Each fixture gets its own directory under a per-run temp root, so a stale
// tree from an earlier run can never be the thing under test.
const ROOT = mkdtempSync(join(tmpdir(), 'sbom-test-'))
const fixture = (name, files) => {
  const dir = join(ROOT, name)
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  mkdirSync(dir, { recursive: true })
  return dir
}
const find = (sbom, name) => sbom.entries.filter((e) => e.name === name)
const one = (sbom, name) => {
  const hits = find(sbom, name)
  if (hits.length !== 1) throw new Error(`expected exactly one ${name}, got ${hits.length}`)
  return hits[0]
}

// ───────────────────────────────────────────── 1. a range is not a version
// package.json asks for "^5.3.0". The lockfile says 5.6.2 is installed. A BOM
// that reports the range has told the reader the wrong thing about what is on
// disk, and a BOM that reports the resolved version without saying where it
// came from cannot be checked.
const locked = fixture('locked', {
  'package.json': {
    name: 'fixture-locked',
    version: '1.0.0',
    dependencies: { chalk: '^5.3.0' },
    devDependencies: { '@types/node': '^22.10.2' },
  },
  'package-lock.json': {
    name: 'fixture-locked',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'fixture-locked',
        version: '1.0.0',
        dependencies: { chalk: '^5.3.0' },
        devDependencies: { '@types/node': '^22.10.2' },
      },
      'node_modules/chalk': {
        version: '5.6.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz',
        license: 'MIT',
        dependencies: { 'ansi-styles': '^6.2.1' },
      },
      'node_modules/ansi-styles': {
        version: '6.2.3',
        resolved: 'https://registry.npmjs.org/ansi-styles/-/ansi-styles-6.2.3.tgz',
        license: 'MIT',
      },
      'node_modules/@types/node': {
        version: '22.20.1',
        dev: true,
        license: 'MIT',
        dependencies: { 'undici-types': '~6.21.0' },
      },
      // No `license` key at all. This is not rare: roughly one entry in fifteen
      // in this machine's real trees has none.
      'node_modules/undici-types': { version: '6.21.0', dev: true },
    },
  },
})

console.log('\n── a manifest range and a locked version are never the same field')
{
  const s = readSbom(locked)
  const chalk = one(s, 'chalk')
  chk('status ok', s.status === 'ok', s.reason ?? '')
  chk('the version is the resolved one', chalk.version === '5.6.2', chalk.version)
  chk('and is labelled locked', chalk.versionKind === 'locked', chalk.versionKind)
  chk('the range survives, in its own field', chalk.constraint === '^5.3.0', String(chalk.constraint))
  chk('the range is never in the version field', chalk.version !== '^5.3.0', chalk.version)
  chk('and the version names the file it came from', chalk.versionSource === 'package-lock.json', chalk.versionSource)
  chk('the closure is declared to come from a lockfile', s.transitiveClosure === 'from-lockfiles', s.transitiveClosure)

  console.log('\n── direct and transitive are labelled, not implied')
  chk('a declared package is direct', chalk.relation === 'direct', chalk.relation)
  const ansi = one(s, 'ansi-styles')
  chk('a package nothing declares is transitive', ansi.relation === 'transitive', ansi.relation)
  chk('the transitive one has a path back to a direct one', ansi.depth === 2, String(ansi.depth))
  chk('the direct one sits one hop from its manifest', chalk.depth === 1, String(chalk.depth))
  chk('counts agree with the labels', s.counts.direct === 2 && s.counts.transitive === 2,
    `${s.counts.direct} direct / ${s.counts.transitive} transitive`)

  console.log('\n── runtime and development are labelled from the lock, not guessed')
  chk('a dependency reached only through devDependencies is development',
    one(s, '@types/node').scope === 'development', one(s, '@types/node').scope)
  chk('and so is what it drags in', one(s, 'undici-types').scope === 'development', one(s, 'undici-types').scope)
  chk('the basis is stated', chalk.scopeBasis === 'lockfile-dev-flag', chalk.scopeBasis)
  chk('a runtime dependency is runtime', chalk.scope === 'runtime', chalk.scope)

  console.log('\n── an absent licence is unknown, never the popular answer')
  const undici = one(s, 'undici-types')
  chk('no licence field means null', undici.license === null, String(undici.license))
  chk('and it does not say MIT', undici.license !== 'MIT', String(undici.license))
  chk('the source says unknown', undici.licenseSource === 'unknown', undici.licenseSource)
  chk('a licence that IS there is attributed to the lockfield, not verified',
    chalk.license === 'MIT' && chalk.licenseSource === 'lockfile-license-field',
    `${chalk.license} / ${chalk.licenseSource}`)
  chk('the unknown count is reported', s.counts.licenseUnknown === 1, String(s.counts.licenseUnknown))

  console.log('\n── the BOM is drawable, not only listable')
  const g = graphOf(s)
  const declares = g.edges.filter((e) => e.kind === 'declares' && e.to === chalk.id)
  chk('a direct entry hangs off the manifest that declares it',
    declares.length === 1 && declares[0].from === 'manifest:package.json',
    JSON.stringify(declares))
  chk('the declaring edge carries the field it was declared in', declares[0]?.field === 'dependencies', String(declares[0]?.field))
  chk('a transitive entry has an edge back to its parent',
    g.edges.some((e) => e.kind === 'depends' && e.from === chalk.id && e.to === ansi.id), '')
  chk('every node says what layer it is', g.nodes.every((n) => n.layer === 'dependency'), '')
  chk('and a manifest is a different kind from a package',
    g.nodes.some((n) => n.kind === 'manifest') && g.nodes.some((n) => n.kind === 'package'), '')
}

// ─────────────────────────────────────── 2. no lockfile is a constraint, not a version
const unlocked = fixture('unlocked', {
  'package.json': { name: 'fixture-unlocked', version: '1.0.0', dependencies: { chalk: '^5.3.0' } },
})

console.log('\n── with no lockfile, the version is a request and says so')
{
  const s = readSbom(unlocked)
  const chalk = one(s, 'chalk')
  chk('the version field carries the range', chalk.version === '^5.3.0', String(chalk.version))
  chk('and is labelled a constraint', chalk.versionKind === 'constraint', chalk.versionKind)
  chk('sourced from the manifest', chalk.versionSource === 'package.json', chalk.versionSource)
  chk('the manifest reports no lockfile', s.manifests[0].lockStatus === 'absent', s.manifests[0].lockStatus)
  chk('with a named reason', typeof s.manifests[0].lockReason === 'string' && s.manifests[0].lockReason.length > 0,
    String(s.manifests[0].lockReason))
  chk('the closure is declared absent', s.transitiveClosure === 'absent', s.transitiveClosure)
  chk('nothing transitive is invented', s.counts.transitive === 0, String(s.counts.transitive))
  chk('and a note says it is a direct-dependency list',
    s.notes.some((n) => n.includes('DIRECT-DEPENDENCY list')), JSON.stringify(s.notes))
  chk('the licence is unknown, not assumed from the name', chalk.license === null, String(chalk.license))
}

// ──────────────────── 3. a lock we cannot read is not the same state as no lock
// pnpm, yarn and bun all pin exact versions. Reporting "no lockfile" here would
// say the project is unpinned, which is false; reporting a version would say we
// read one, which is also false.
const alt = fixture('alt-lock', {
  'package.json': { name: 'fixture-alt', version: '1.0.0', dependencies: { chalk: '^5.3.0' } },
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
})

console.log('\n── a lockfile format we do not parse is reported, not ignored')
{
  const s = readSbom(alt)
  chk('the manifest says the lock is unread', s.manifests[0].lockStatus === 'unread', s.manifests[0].lockStatus)
  chk('and names the file', String(s.manifests[0].lockReason).includes('pnpm-lock.yaml'), String(s.manifests[0].lockReason))
  chk('unread is not absent', s.manifests[0].lockStatus !== 'absent', s.manifests[0].lockStatus)
  const u = s.coverage.unread.find((x) => x.path === 'pnpm-lock.yaml')
  chk('coverage lists it as seen and unread', !!u, JSON.stringify(s.coverage.unread))
  chk('with a machine-readable reason', u?.reason === 'lock-format-not-parsed', String(u?.reason))
  chk('and an effect a reader can act on', typeof u?.effect === 'string' && u.effect.includes('CONSTRAINTS'), String(u?.effect))
  chk('versions are constraints', one(s, 'chalk').versionKind === 'constraint', one(s, 'chalk').versionKind)
  chk('npm is still listed as read', s.coverage.read.some((r) => r.ecosystem === 'npm'), JSON.stringify(s.coverage.read))
}

// ───────────────────── 4. no manifest at all is a stated result, not an empty BOM
const bare = fixture('bare', { 'README.md': '# nothing here\n' })
const cargoOnly = fixture('cargo-only', {
  'Cargo.toml': '[package]\nname = "thing"\nversion = "0.1.0"\n',
  'Cargo.lock': 'version = 3\n',
})

console.log('\n── a repository with no manifest says so')
{
  const s = readSbom(bare)
  chk('status is no-manifest', s.status === 'no-manifest', s.status)
  chk('with a stated reason', typeof s.reason === 'string' && s.reason.length > 0, String(s.reason))
  chk('entries are empty, but the status is what a reader checks', s.entries.length === 0, String(s.entries.length))
  chk('and nothing claims a closure', s.transitiveClosure === 'absent', s.transitiveClosure)
}
{
  // An ecosystem this module does not cover must not come back looking like an
  // empty project. The distinction a reader needs is "nothing there" versus
  // "something there that nobody read".
  const s = readSbom(cargoOnly)
  chk('a cargo-only repo is still no-manifest for npm', s.status === 'no-manifest', s.status)
  chk('but the reason names the unread ecosystems',
    String(s.reason).includes('not read by this module'), String(s.reason))
  const u = s.coverage.unread.find((x) => x.ecosystem === 'cargo')
  chk('and cargo appears as seen-and-uncovered', u?.reason === 'ecosystem-not-covered', JSON.stringify(s.coverage.unread))
  chk('a covered ecosystem is distinguishable from an unread one',
    s.coverage.read.every((r) => r.ecosystem !== 'cargo'), JSON.stringify(s.coverage.read))
}

// ──────────────────── 5. one name, several entries; and names that are not names
const dup = fixture('dup', {
  'package.json': { name: 'fixture-dup', version: '1.0.0', dependencies: { bar: '^1.0.0', foo: '^1.0.0' } },
  'package-lock.json': {
    name: 'fixture-dup',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-dup', version: '1.0.0', dependencies: { bar: '^1.0.0', foo: '^1.0.0' } },
      'node_modules/foo': { version: '1.4.0', license: 'MIT' },
      'node_modules/bar': { version: '1.0.0', license: 'MIT', dependencies: { foo: '^2.0.0' } },
      // The hoisting case: bar needs a foo the root cannot use, so npm nests a
      // second copy. Two BOM entries, one name.
      'node_modules/bar/node_modules/foo': { version: '2.1.0', license: 'ISC' },
    },
  },
})

console.log('\n── one import root can mean several BOM entries')
{
  const s = readSbom(dup)
  chk('both copies are billed', find(s, 'foo').length === 2,
    JSON.stringify(find(s, 'foo').map((e) => `${e.name}@${e.version}`)))
  const nested = s.entries.find((e) => e.installPath === 'node_modules/bar/node_modules/foo')
  const bar = one(s, 'bar')
  chk('the nested copy is found by its install path', nested?.version === '2.1.0', String(nested?.version))
  chk('and resolution points bar at the copy it would actually load',
    s.edges.some((e) => e.kind === 'depends' && e.from === bar.id && e.to === nested?.id),
    JSON.stringify(s.edges.filter((e) => e.from === bar.id)))
  const r = matchImportRoots(s, ['foo'])
  chk('an ambiguous root returns every candidate, not a pick', r.matches[0].entryIds.length === 2,
    JSON.stringify(r.matches[0]))
  chk('and the ambiguity is counted', r.ambiguousCount === 1, String(r.ambiguousCount))
}

console.log('\n── an import root that matches nothing is reported, never dropped')
{
  const s = readSbom(locked)
  const roots = ['chalk', 'chalk/source/index.js', 'definitely-not-a-package', 'node:fs', 'fs', './local', '#internal', 'https://esm.sh/x']
  const r = matchImportRoots(s, roots)
  chk('every root comes back', r.matches.length === roots.length, `${r.matches.length} of ${roots.length}`)
  // Read through optional chaining on purpose: the failure this block guards is
  // a root being DROPPED, and a dropped root must show up as a named check
  // going red rather than as a TypeError that says nothing about the contract.
  const by = Object.fromEntries(r.matches.map((m) => [m.root, m]))
  chk('a real dependency matches', by['chalk']?.status === 'matched', JSON.stringify(by['chalk']))
  chk('a subpath import reduces to its package', by['chalk/source/index.js']?.packageName === 'chalk',
    String(by['chalk/source/index.js']?.packageName))
  chk('a name absent from the BOM is unmatched, with a reason',
    by['definitely-not-a-package']?.status === 'unmatched' && by['definitely-not-a-package']?.reason === 'not-in-bom',
    JSON.stringify(by['definitely-not-a-package']))
  chk('and it is still present in the result', 'definitely-not-a-package' in by, JSON.stringify(Object.keys(by)))
  chk('a prefixed builtin is not a dependency', by['node:fs']?.reason === 'node-builtin', String(by['node:fs']?.reason))
  chk('a bare builtin is not a dependency either', by['fs']?.reason === 'node-builtin', String(by['fs']?.reason))
  chk('a relative specifier is not a package', by['./local']?.reason === 'relative-specifier', String(by['./local']?.reason))
  chk('a subpath-imports key is not a package', by['#internal']?.reason === 'subpath-import', String(by['#internal']?.reason))
  chk('a URL specifier is not a package', by['https://esm.sh/x']?.reason === 'url-specifier', String(by['https://esm.sh/x']?.reason))
  chk('the unmatched count is the truth about the join', r.unmatchedCount === 6, String(r.unmatchedCount))
  chk('scoped names keep both segments', packageNameOf('@types/node/fs').name === '@types/node',
    String(packageNameOf('@types/node/fs').name))
  // 'not-in-bom' asserts that a name was looked up and missed. Nothing is
  // looked up for an empty or absent specifier, so it gets its own reason
  // rather than borrowing one that describes a lookup.
  for (const junk of ['', '   ', null, undefined]) {
    chk(`an empty specifier is not a failed lookup: ${JSON.stringify(junk)}`,
      matchImportRoots(s, [junk]).matches[0]?.reason === 'empty-specifier',
      String(matchImportRoots(s, [junk]).matches[0]?.reason))
  }
}
{
  // Against a repository with no BOM at all, a name is unmatched for a
  // different reason than "not in the lockfile" — there was no lockfile.
  const r = matchImportRoots(readSbom(bare), ['chalk'])
  chk('with no BOM, the reason says so', r.matches[0].reason === 'no-bom', String(r.matches[0].reason))
}

// ───────────────────────────────────── 6. a workspace is several manifests, one lock
const ws = fixture('workspace', {
  'package.json': {
    name: 'fixture-ws',
    version: '1.0.0',
    workspaces: ['packages/*'],
    devDependencies: { '@fixture/lib': '*' },
  },
  'packages/lib/package.json': { name: '@fixture/lib', version: '0.2.0', dependencies: { chalk: '^5.3.0' } },
  'package-lock.json': {
    name: 'fixture-ws',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-ws', version: '1.0.0', devDependencies: { '@fixture/lib': '*' } },
      'packages/lib': { name: '@fixture/lib', version: '0.2.0', dependencies: { chalk: '^5.3.0' } },
      'node_modules/@fixture/lib': { resolved: 'packages/lib', link: true },
      'node_modules/chalk': { version: '5.6.2', license: 'MIT' },
    },
  },
})

console.log('\n── a workspace member is first-party, so it is a manifest and not a line item')
{
  const s = readSbom(ws)
  chk('both manifests are found', s.manifests.length === 2, JSON.stringify(s.manifests.map((m) => m.path)))
  const lib = s.manifests.find((m) => m.path === 'packages/lib/package.json')
  chk('the member is marked as one', lib?.workspaceMember === true, String(lib?.workspaceMember))
  chk('the member is not billed as a dependency', find(s, '@fixture/lib').length === 0,
    JSON.stringify(find(s, '@fixture/lib')))
  chk('the symlink edge points at the member manifest',
    s.edges.some((e) => e.kind === 'declares' && e.from === 'manifest:package.json' && e.to === lib?.id),
    JSON.stringify(s.edges))
  chk("the member's own dependency is resolved against the shared lock",
    one(s, 'chalk').versionKind === 'locked' && one(s, 'chalk').version === '5.6.2',
    JSON.stringify(one(s, 'chalk')))
  chk('one lockfile, counted once', s.coverage.read[0].locksRead === 1, String(s.coverage.read[0].locksRead))
}

// ─────────── 6b. and a workspace member is still first-party with no lock to read
// The same workspace, minus the lockfile. This is the state a pnpm or yarn
// project arrives in, and it is where the self-billing bug lives: with nothing
// to reveal that @fixture/lib is a symlink, a name-matching BOM sells the
// project its own package. One real workspace in this machine's corpus does
// this 124 times across 22 manifests.
const wsUnlocked = fixture('workspace-unlocked', {
  'package.json': {
    name: 'fixture-wsu',
    version: '1.0.0',
    workspaces: ['packages/*'],
    devDependencies: { '@fixture/lib': '*' },
  },
  'packages/lib/package.json': { name: '@fixture/lib', version: '0.2.0', dependencies: { chalk: '^5.3.0' } },
  'packages/app/package.json': { name: '@fixture/app', version: '0.1.0', dependencies: { '@fixture/lib': 'workspace:*' } },
})

console.log('\n── with no lockfile, a workspace member is still not a line item')
{
  const s = readSbom(wsUnlocked)
  const lib = s.manifests.find((m) => m.path === 'packages/lib/package.json')
  chk('the lock really is absent', s.manifests[0].lockStatus === 'absent', s.manifests[0].lockStatus)
  chk('the project does not bill itself', find(s, '@fixture/lib').length === 0,
    JSON.stringify(find(s, '@fixture/lib').map((e) => e.id)))
  chk('the edge points at the member manifest instead',
    s.edges.some((e) => e.from === 'manifest:packages/app/package.json' && e.to === lib?.id),
    JSON.stringify(s.edges.map((e) => `${e.from} -> ${e.to}`)))
  chk('a genuine third-party dependency is still billed', find(s, 'chalk').length === 1, String(find(s, 'chalk').length))
}

console.log('\n── entries are line items, and the count that says so is present')
{
  // One name, declared by two manifests with no lock to hoist it, is two
  // entries. A headline reading "N dependencies" off `entries` would say this
  // project has two chalks.
  const twice = fixture('declared-twice', {
    'package.json': { name: 'fixture-twice', version: '1.0.0', workspaces: ['packages/*'] },
    'packages/a/package.json': { name: '@twice/a', version: '1.0.0', dependencies: { chalk: '^5.3.0' } },
    'packages/b/package.json': { name: '@twice/b', version: '1.0.0', dependencies: { chalk: '^5.4.0' } },
  })
  const s = readSbom(twice)
  chk('two declarations are two entries', s.counts.entries === 2, String(s.counts.entries))
  chk('but one distinct name', s.counts.distinctNames === 1, String(s.counts.distinctNames))
  chk('and each keeps the range its own manifest asked for',
    new Set(find(s, 'chalk').map((e) => e.constraint)).size === 2,
    JSON.stringify(find(s, 'chalk').map((e) => e.constraint)))
  chk('distinct coordinates are counted too', typeof s.counts.distinctCoordinates === 'number',
    String(s.counts.distinctCoordinates))
}

// ───────────────────────── 7. a requirement the lock cannot satisfy is surfaced
const unmet = fixture('unmet', {
  'package.json': { name: 'fixture-unmet', version: '1.0.0', dependencies: { widget: '^1.0.0' } },
  'package-lock.json': {
    name: 'fixture-unmet',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-unmet', version: '1.0.0', dependencies: { widget: '^1.0.0' } },
      // An unmet peer: real trees carry these, and an edge list that drops them
      // makes the repository look tidier than it is.
      'node_modules/widget': { version: '1.2.0', license: 'MIT', peerDependencies: { react: '^18.0.0' } },
    },
  },
})

console.log('\n── an unmet requirement is named, not swallowed')
{
  const s = readSbom(unmet)
  chk('the unmet peer is listed', s.unresolved.some((u) => u.name === 'react'), JSON.stringify(s.unresolved))
  chk('with the range that went unmet', s.unresolved.find((u) => u.name === 'react')?.constraint === '^18.0.0',
    JSON.stringify(s.unresolved))
  chk('and it did not become a phantom entry', find(s, 'react').length === 0, JSON.stringify(find(s, 'react')))
}

// ─────────────────────────────── 8. a lockfile shape we do not parse is declared
const v1 = fixture('lockfile-v1', {
  'package.json': { name: 'fixture-v1', version: '1.0.0', dependencies: { chalk: '^5.3.0' } },
  'package-lock.json': {
    name: 'fixture-v1',
    lockfileVersion: 1,
    dependencies: { chalk: { version: '5.6.2', resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz' } },
  },
})

console.log('\n── a lockfileVersion we do not read is declared unread, not half-parsed')
{
  const s = readSbom(v1)
  chk('the manifest reports unread', s.manifests[0].lockStatus === 'unread', s.manifests[0].lockStatus)
  chk('coverage names the version', s.coverage.unread.some((u) => u.effect.includes('lockfileVersion 1')),
    JSON.stringify(s.coverage.unread))
  chk('and no version is taken from it', one(s, 'chalk').versionKind === 'constraint', one(s, 'chalk').versionKind)
  chk('specifically not the one sitting right there', one(s, 'chalk').version !== '5.6.2', String(one(s, 'chalk').version))
}

// ─────────── 8b. a lockfile we DO read can still say nothing about licences
// lockfileVersion 2 records no `license` key at all; version 3 does. Two real
// locks in this machine's corpus have 0 of 1560 and 0 of 1628 entries carrying
// one, while a v3 lock beside them has 3003 of 3047. So "unknown" here is a
// property of the npm that wrote the file, and a BOM that filled the gap in
// would be inventing 1560 licence claims from the format version alone.
const v2 = fixture('lockfile-v2', {
  'package.json': { name: 'fixture-v2', version: '1.0.0', dependencies: { chalk: '^5.3.0' } },
  'package-lock.json': {
    name: 'fixture-v2',
    lockfileVersion: 2,
    packages: {
      '': { name: 'fixture-v2', version: '1.0.0', dependencies: { chalk: '^5.3.0' } },
      'node_modules/chalk': { version: '5.6.2', resolved: 'https://registry.npmjs.org/chalk/-/chalk-5.6.2.tgz' },
    },
    // v2 keeps the legacy tree alongside `packages`; it must not be read twice.
    dependencies: { chalk: { version: '5.6.2' } },
  },
})

console.log('\n── a lockfileVersion 2 lock is read, and still yields no licence')
{
  const s = readSbom(v2)
  chk('the lock is read, not refused', s.manifests[0].lockStatus === 'read', s.manifests[0].lockStatus)
  chk('so the version is a fact', one(s, 'chalk').version === '5.6.2' && one(s, 'chalk').versionKind === 'locked',
    JSON.stringify([one(s, 'chalk').version, one(s, 'chalk').versionKind]))
  chk('but the licence is unknown', one(s, 'chalk').license === null, String(one(s, 'chalk').license))
  chk('and every entry says so rather than guessing', s.counts.licenseUnknown === s.counts.entries,
    `${s.counts.licenseUnknown} of ${s.counts.entries}`)
  chk('the legacy dependencies tree is not counted a second time', s.counts.entries === 1, String(s.counts.entries))
}

// ────────────── 8c. a lock entry nothing readable declares is kept, not dropped
// Real shape: a monorepo root whose own package.json declares nothing, with the
// manifest that DOES declare its dependencies governed by a yarn.lock this
// module cannot read. One repository in this machine's corpus lands 665 entries
// in exactly this state. They are real installed packages; what is missing is
// the path back to a declarer, and that is what depth null says.
const orphaned = fixture('orphaned', {
  'package.json': { name: 'fixture-orphan', version: '1.0.0' },
  'package-lock.json': {
    name: 'fixture-orphan',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-orphan', version: '1.0.0' },
      'node_modules/ghost': { version: '1.0.0', license: 'MIT' },
    },
  },
})

console.log('\n── a lock entry with no readable declarer is listed with depth null')
{
  const s = readSbom(orphaned)
  chk('the manifest declares nothing, and that is recorded', s.manifests[0].declaredCount === 0,
    String(s.manifests[0].declaredCount))
  chk('the entry is not dropped for being unattributable', find(s, 'ghost').length === 1,
    JSON.stringify(s.entries.map((e) => e.name)))
  // Read through the array, not through one(): a dropped orphan must surface as
  // these named checks going red, not as a lookup throwing.
  chk('its depth is null, not zero and not one', find(s, 'ghost')[0]?.depth === null,
    String(find(s, 'ghost')[0]?.depth))
  chk('and it is counted as an orphan', s.counts.orphanEntries === 1, String(s.counts.orphanEntries))
  chk('with a note a reader will see', s.notes.some((n) => n.includes('reachable from no manifest')),
    JSON.stringify(s.notes))
}

// ─────────────────────────────────────── 9. the scale warning has to be computable
console.log('\n── the numbers a drawer needs to gate on are present')
{
  const s = readSbom(locked)
  chk('every entry carries a depth or an explicit null',
    s.entries.every((e) => e.depth === null || typeof e.depth === 'number'), '')
  chk('counts.entries matches the list', s.counts.entries === s.entries.length,
    `${s.counts.entries} vs ${s.entries.length}`)
  chk('orphans are counted rather than hidden', typeof s.counts.orphanEntries === 'number', '')
  chk('the walk reports what it never looked inside', Array.isArray(s.scan.skippedDirNames) && s.scan.skippedDirNames.includes('node_modules'),
    JSON.stringify(s.scan.skippedDirNames))
  chk('and whether an installed tree was even there', typeof s.scan.nodeModulesPresent === 'boolean', '')
}

rmSync(ROOT, { recursive: true, force: true })
// ---------------------------------------------------------- first-party code
//
// A workspace member is this repository's own code, and billing it as a
// third-party dependency is a project selling itself its own packages. The
// first version caught only npm's `workspaces` field, so every pnpm monorepo --
// which declares members in pnpm-workspace.yaml -- billed itself: one real repo
// reported ten of its sixty entries as dependencies, each with the "version"
// `workspace:*`, which is a protocol pointer and not a version at all.
{
  const dir = mkdtempSync(join(tmpdir(), 'sbom-ws-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'root', private: true,
    dependencies: { '@own/db': 'workspace:*', '@own/api': 'workspace:^', chalk: '^5.3.0' },
    devDependencies: { '@own/tools': 'link:../tools', '@own/cfg': 'file:./cfg' },
  }))
  const s = await readSbom(dir)
  const names = (s.entries || []).map((e) => e.name)
  chk('a workspace: specifier is not billed as a dependency',
    !names.includes('@own/db') && !names.includes('@own/api'), names.join(', '))
  chk('nor is a link: or file: one, whatever declared the membership',
    !names.includes('@own/tools') && !names.includes('@own/cfg'), names.join(', '))
  chk('a real dependency beside them is still billed', names.includes('chalk'), names.join(', '))
  chk('and no entry carries a protocol pointer where a version belongs',
    (s.entries || []).every((e) => !/^(workspace|link|file|portal):/.test(String(e.version || ''))),
    (s.entries || []).map((e) => e.name + '@' + e.version).join(', '))
  chk('the first-party ones are named in the notes rather than dropped in silence',
    (s.notes || []).filter((n) => /first-party protocol/.test(n)).length === 4,
    (s.notes || []).filter((n) => /first-party/.test(n)).length + ' notes')
}

// ------------------------------------------- absence needs a search to precede it
//
// "not-in-bom" says a name was looked up in a bill of materials and was not
// there. With the lockfile unread there IS no bill of materials to look in, so
// reporting absence asserts a check that never ran.
{
  const dir = mkdtempSync(join(tmpdir(), 'sbom-unread-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '^4.18.0' } }))
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n')
  const s = await readSbom(dir)
  chk('with the lock unread the closure is absent', s.transitiveClosure !== 'from-lockfiles', s.transitiveClosure)
  const m = matchImportRoots(s, ['body-parser'])
  chk('a name not found is bom-incomplete, not not-in-bom',
    m.matches[0].reason === 'bom-incomplete', m.matches[0].reason)
  chk('and it never claims the name is absent from the project',
    m.matches[0].reason !== 'not-in-bom', m.matches[0].reason)
}

// -------------------------------------------- a builtin name a package shadows
//
// `events`, `punycode` and friends are node builtins AND real packages that are
// routinely installed. When the BOM holds the installed one, that is what an
// import resolves to, and answering "builtin" from the name alone reported a
// dependency the BOM itself lists as though it were not one.
{
  const dir = mkdtempSync(join(tmpdir(), 'sbom-shadow-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { events: '^3.3.0' } }))
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/events': { version: '3.3.0' } },
  }))
  const s = await readSbom(dir)
  const m = matchImportRoots(s, ['events', 'fs'])
  chk('a builtin name the BOM installs resolves to the package',
    m.matches[0].status === 'matched', m.matches[0].status + ' ' + (m.matches[0].reason || ''))
  chk('and a builtin nothing shadows is still a builtin',
    m.matches[1].reason === 'node-builtin', m.matches[1].reason)
}

// ------------------------------------------------- no edge into empty space
{
  const dir = mkdtempSync(join(tmpdir(), 'sbom-graph-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { chalk: '^5.0.0' } }))
  const s = await readSbom(dir)
  const g = graphOf(s)
  const ids = new Set(g.nodes.map((n) => n.id))
  chk('every edge lands on a node that is drawn',
    g.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
    g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to)).map((e) => e.from + '->' + e.to).join(', '))
  chk('and anything dropped for dangling is reported rather than filtered away',
    Array.isArray(g.dangling), typeof g.dangling)
}


// ═══════════════ the cross-check against GitHub's own bill of materials ═════
//
// A second reading of the same repository is only worth having if it cannot
// lie, and there are exactly five ways this one can:
//
//   * by comparing a feature branch against GitHub's default branch and
//     calling the difference a defect,
//   * by calling a GitHub Actions dependency a package the local reader MISSED,
//     when the local reader never claimed to read one,
//   * by comparing the range "4.*.*" against a locked "4.2.1" and printing a
//     version mismatch,
//   * by picking a winner between two licence claims that are both just claims,
//   * and, worst of all, by reporting "no differences" when it never ran.
//
// The last one is the reason every degraded state below is a test. An empty
// diff reads as agreement, so a cross-check that quietly fails is worse than
// one that crashes: it publishes a clean bill of health for a check that never
// happened. Every one of these asserts a NAMED result and a null comparison.
//
// There is no network here and there must never be one: a suite that reaches
// GitHub tests GitHub. Both seams are injected — recorded `git` output, so the
// remote and branch parsing is genuinely under test, and recorded SPDX bodies
// taken from the real endpoint's shape.

const { crossCheckWithGithub, readGithubSbomDocument, parseGitRemoteUrl, classifyVersionText } =
  await import('../scripts/sbom.mjs')

const XROOT = mkdtempSync(join(tmpdir(), 'sbom-xcheck-'))
const xfixture = (name, files) => {
  const dir = join(XROOT, name)
  mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
    writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return dir
}

// A repository whose lockfile resolves everything, so the local side of every
// comparison below is locked versions rather than ranges — which is the only
// state in which a version difference means anything at all.
const xlocked = xfixture('locked', {
  'package.json': { name: 'widget', version: '1.0.0', dependencies: { chalk: '^5.3.0' }, devDependencies: { '@types/node': '^22.10.2' } },
  'package-lock.json': {
    name: 'widget',
    lockfileVersion: 3,
    packages: {
      '': { name: 'widget', version: '1.0.0', dependencies: { chalk: '^5.3.0' }, devDependencies: { '@types/node': '^22.10.2' } },
      'node_modules/chalk': { version: '5.6.2', license: 'MIT', dependencies: { 'ansi-styles': '^6.2.1' } },
      'node_modules/ansi-styles': { version: '6.2.3', license: 'MIT' },
      'node_modules/@types/node': { version: '22.20.1', dev: true, license: 'MIT', dependencies: { 'undici-types': '~6.21.0' } },
      'node_modules/undici-types': { version: '6.21.0', dev: true },
    },
  },
})
// The same project with no lockfile, so its versions are ranges. Used for the
// "a range on OUR side" half of requirement 3.
const xunlocked = xfixture('unlocked', {
  'package.json': { name: 'widget', version: '1.0.0', dependencies: { chalk: '^5.3.0' } },
})

const ORIGIN_SSH = 'origin\tgit@github.com:acme/widget.git (fetch)\norigin\tgit@github.com:acme/widget.git (push)\n'

/** A git seam fed recorded output, keyed by the exact argument list. An
 *  unrecorded call fails loudly rather than returning empty output, because a
 *  silently-empty `git remote -v` would look like a repository with no remote
 *  and send the whole cross-check down a branch the test never meant to take. */
const gitFrom = (recorded) => (args) => {
  const key = args.join(' ')
  if (!(key in recorded)) return { ok: false, reason: `the test recorded no output for: git ${key}` }
  const v = recorded[key]
  return typeof v === 'string' ? { ok: true, stdout: v } : { ok: false, reason: v.fail }
}
const gitOn = (branchLine, opts = {}) => gitFrom({
  'remote -v': opts.remotes ?? ORIGIN_SSH,
  'status --porcelain -b': `## ${branchLine}\n${(opts.dirty ?? []).map((p) => ` M ${p}`).join('\n')}${(opts.dirty ?? []).length ? '\n' : ''}`,
  'rev-parse --short HEAD': 'abc1234\n',
  'rev-parse --show-prefix': opts.prefix ?? '',
})

/** One SPDX package in the shape the real endpoint returns. */
const ghPkg = (ecosystem, name, version, license) => ({
  name,
  SPDXID: `SPDXRef-${ecosystem}-${name.replace(/[^A-Za-z0-9]/g, '-')}-${version}`,
  versionInfo: version,
  downloadLocation: 'NOASSERTION',
  filesAnalyzed: false,
  ...(license === undefined ? {} : { licenseConcluded: license }),
  externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:${ecosystem}/${name}@${version}` }],
})

/** A whole document, wrapped exactly as `gh api` wraps it, with the repository's
 *  own node and the DESCRIBES relationship the real response carries. */
const ghDoc = (packages, { repo = 'acme/widget', ref = 'main' } = {}) => ({
  sbom: {
    spdxVersion: 'SPDX-2.3',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `com.github.${repo}`,
    packages: [
      ...packages,
      {
        name: `com.github.${repo}`,
        SPDXID: 'SPDXRef-github-self',
        versionInfo: ref,
        downloadLocation: `git+https://github.com/${repo}`,
        filesAnalyzed: false,
        licenseDeclared: 'MIT',
        externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:github/${repo}@${ref}` }],
      },
    ],
    relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relatedSpdxElement: 'SPDXRef-github-self', relationshipType: 'DESCRIBES' }],
  },
})

const serves = (body) => async () => ({ ok: true, body })
const refuses = (status, reason) => async () => ({ ok: false, status, reason })
const AGREEING = [
  ghPkg('npm', 'chalk', '5.6.2', 'MIT'),
  ghPkg('npm', 'ansi-styles', '6.2.3', 'MIT'),
  ghPkg('npm', '@types/node', '22.20.1', 'MIT'),
  ghPkg('npm', 'undici-types', '6.21.0'),
]
const pkg = (x, name) => x.comparison.packages.find((p) => p.name === name)

console.log('\n── the two sides agree, and saying so requires having actually looked')
{
  const s = readSbom(xlocked)
  const x = await crossCheckWithGithub(s, { git: gitOn('main...origin/main'), fetchSbom: serves(ghDoc(AGREEING)) })
  chk('the status says a comparison happened', x.status === 'compared', `${x.status}: ${x.reason}`)
  chk('and a comparison is attached', x.comparison !== null, String(x.comparison))
  chk('every npm package is on both sides', x.comparison.counts.bothSides === 4, JSON.stringify(x.comparison.counts))
  chk('their versions match', x.comparison.counts.versionSame === 4, JSON.stringify(x.comparison.counts))
  chk('nothing differs', x.comparison.counts.versionDiffers === 0, JSON.stringify(x.comparison.counts))
  chk('the endpoint that was read is named', x.source?.endpoint === 'repos/acme/widget/dependency-graph/sbom', JSON.stringify(x.source))
  chk('the ecosystems actually compared are stated', JSON.stringify(x.comparison.ecosystemsCompared) === '["npm"]',
    JSON.stringify(x.comparison.ecosystemsCompared))
}

console.log('\n── which ref each side describes, because that is where this lies if anywhere')
{
  const s = readSbom(xlocked)
  const clean = await crossCheckWithGithub(s, { git: gitOn('main...origin/main'), fetchSbom: serves(ghDoc(AGREEING)) })
  chk('the local side says it read the working tree', clean.refs.local.describes === 'working-tree', clean.refs.local.describes)
  chk('and the GitHub side names the ref its document describes', clean.refs.github?.ref === 'main', JSON.stringify(clean.refs.github))
  chk('read from their own document, not assumed', clean.refs.github?.refSource === 'spdx-self-package', String(clean.refs.github?.refSource))
  chk('on the same branch, clean and pushed, the relation is the strongest one available',
    clean.refs.relation === 'same-ref-clean', `${clean.refs.relation}: ${clean.refs.relationReason}`)
  chk('and only then is a difference NOT already explained by the ref',
    clean.refs.differencesExplainedByRef === false, String(clean.refs.differencesExplainedByRef))

  // The state this whole feature is most likely to lie in: a feature branch.
  const feature = await crossCheckWithGithub(s, { git: gitOn('claude/some-work...origin/claude/some-work'), fetchSbom: serves(ghDoc(AGREEING)) })
  chk('on a different branch the relation says so', feature.refs.relation === 'different-ref', feature.refs.relationReason)
  chk('it names both refs rather than only complaining',
    feature.refs.relationReason.includes('claude/some-work') && feature.refs.relationReason.includes('main'), feature.refs.relationReason)
  chk('and every difference is declared already explained by that',
    feature.refs.differencesExplainedByRef === true, String(feature.refs.differencesExplainedByRef))
  chk('the effect says outright that none of it is a defect',
    feature.effect.includes('none of it is a defect'), feature.effect)
  // The differences are still REPORTED on a feature branch -- they are just not
  // blamed. Suppressing them would be the opposite failure: a reader who wants
  // to see how their branch diverges from the default one would get nothing.
  chk('the comparison is still attached, so the differences stay visible',
    feature.comparison !== null, String(feature.comparison))
  chk('and both refs are named, so a reader can see which side is which',
    feature.refs.local.branch === 'claude/some-work' && feature.refs.github.ref === 'main',
    JSON.stringify([feature.refs.local.branch, feature.refs.github.ref]))

  // An uncommitted lockfile is content GitHub has never seen. Reporting the
  // resulting difference as a finding would blame the reader for saving a file.
  const dirty = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main', { dirty: ['package-lock.json', 'README.md'] }),
    fetchSbom: serves(ghDoc(AGREEING)),
  })
  chk('an uncommitted BOM input makes the two sides different content',
    dirty.refs.relation === 'same-ref-dirty-working-tree', dirty.refs.relationReason)
  chk('and it is named, so a reader can see which file', dirty.refs.local.dirtyBomInputs.includes('package-lock.json'),
    JSON.stringify(dirty.refs.local.dirtyBomInputs))
  chk('an edited README is not counted as a reason the bills differ',
    !dirty.refs.local.dirtyBomInputs.includes('README.md'), JSON.stringify(dirty.refs.local.dirtyBomInputs))
  chk('but it is still reported as a change elsewhere', dirty.refs.local.otherWorkingTreeChanges === true,
    String(dirty.refs.local.otherWorkingTreeChanges))
  chk('and the difference is explained by the ref', dirty.refs.differencesExplainedByRef === true, dirty.refs.relationReason)

  // Committed but unpushed: GitHub cannot have read it.
  const ahead = await crossCheckWithGithub(s, { git: gitOn('main...origin/main [ahead 2]'), fetchSbom: serves(ghDoc(AGREEING)) })
  chk('unpushed commits are a difference GitHub could not know about',
    ahead.refs.relation === 'same-ref-unpushed-commits', ahead.refs.relationReason)
  chk('and the count of them is stated', ahead.refs.local.ahead === 2, String(ahead.refs.local.ahead))
  chk('and it is explained by the ref too', ahead.refs.differencesExplainedByRef === true, String(ahead.refs.differencesExplainedByRef))

  const detached = await crossCheckWithGithub(s, { git: gitOn('HEAD (no branch)'), fetchSbom: serves(ghDoc(AGREEING)) })
  chk('a detached HEAD has no branch to relate, and says so rather than guessing',
    detached.refs.relation === 'ref-unknown' && detached.refs.local.detached === true, detached.refs.relationReason)
  chk('unknown is never treated as the same ref', detached.refs.differencesExplainedByRef === true,
    String(detached.refs.differencesExplainedByRef))

  const noUpstream = await crossCheckWithGithub(s, { git: gitOn('main'), fetchSbom: serves(ghDoc(AGREEING)) })
  chk('no upstream is not zero commits ahead', noUpstream.refs.local.ahead === null, String(noUpstream.refs.local.ahead))
  chk('and the reason admits git could not confirm GitHub has this commit',
    noUpstream.refs.relationReason.includes('no upstream'), noUpstream.refs.relationReason)
}

console.log('\n── a BOM scanned below the repository root still sees its own file as dirty')
{
  // Porcelain paths are repo-root relative; BOM paths are scan-root relative.
  // Without the prefix these never meet, every dirty lockfile reads as clean,
  // and the cross-check then claims a working-tree difference is unexplained.
  const s = readSbom(xlocked)
  const x = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main', { prefix: 'plugins/widget/\n', dirty: ['plugins/widget/package-lock.json'] }),
    fetchSbom: serves(ghDoc(AGREEING)),
  })
  chk('the dirty input is found through the prefix', x.refs.local.dirtyBomInputs.includes('package-lock.json'),
    JSON.stringify(x.refs.local.dirtyBomInputs))
  chk('and the relation is the dirty one, not the clean one',
    x.refs.relation === 'same-ref-dirty-working-tree', x.refs.relationReason)
}

console.log('\n── a package on one side only is classified before it is called missing')
{
  const s = readSbom(xlocked)
  const x = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main'),
    fetchSbom: serves(ghDoc([
      // ansi-styles dropped: present locally, absent from their document.
      ghPkg('npm', 'chalk', '5.6.2', 'MIT'),
      ghPkg('npm', '@types/node', '22.20.1', 'MIT'),
      ghPkg('npm', 'undici-types', '6.21.0'),
      // An npm package only they have: a real gap in an ecosystem we DO read.
      ghPkg('npm', 'left-pad', '1.3.0', 'WTFPL'),
      // A GitHub Actions dependency: only they have it, and we never claimed to
      // read one. This is the classification that stops the report inventing
      // two dependencies the local reader "lost".
      ghPkg('githubactions', 'actions/checkout', '4.*.*'),
      ghPkg('githubactions', 'actions/setup-node', '4.*.*'),
    ])),
  })
  chk('a package only the local side has is reported as that', pkg(x, 'ansi-styles').presence === 'only-local',
    JSON.stringify(pkg(x, 'ansi-styles')))
  chk('with a reason naming their document, not ours',
    pkg(x, 'ansi-styles').presenceReason === 'absent-from-github-document', pkg(x, 'ansi-styles').presenceReason)
  chk('and it is counted', x.comparison.counts.onlyLocal === 1, JSON.stringify(x.comparison.counts))

  chk('a package only GitHub has, in an ecosystem we read, is absent from the local BOM',
    pkg(x, 'left-pad').presenceReason === 'absent-from-local-bom', pkg(x, 'left-pad').presenceReason)
  chk('and that is the number a reader should look at',
    x.comparison.counts.onlyGithubInReadEcosystem === 1, JSON.stringify(x.comparison.counts))

  const checkout = pkg(x, 'actions/checkout')
  chk('a GitHub Actions dependency is classified by ecosystem', checkout.ecosystem === 'githubactions', checkout.ecosystem)
  chk('read from the purl rather than the name', x.comparison.packages.every((p) => p.name !== 'actions/checkout' || p.github.versions.length === 1), '')
  chk('and it is NOT called a package the local reading missed',
    checkout.presenceReason === 'ecosystem-not-read-locally', checkout.presenceReason)
  chk('the two kinds of only-on-GitHub are counted apart',
    x.comparison.counts.onlyGithubOutOfScope === 2 && x.comparison.counts.onlyGithubInReadEcosystem === 1,
    JSON.stringify(x.comparison.counts))
  chk('so an actions-only repository could never read as one dependency short',
    x.comparison.counts.onlyGithubInReadEcosystem !== x.comparison.counts.onlyGithubOutOfScope + 1,
    JSON.stringify(x.comparison.counts))
  chk('and the ecosystems actually compared exclude the one we do not read',
    !x.comparison.ecosystemsCompared.includes('githubactions'), JSON.stringify(x.comparison.ecosystemsCompared))

  // GitHub lists the repository beside its dependencies. Billed as one, the
  // project becomes a dependency of itself at a "version" that is a branch name.
  const self = x.comparison.packages.find((p) => p.presenceReason === 'repository-self')
  chk('their node for the repository itself is recognised as that', !!self, JSON.stringify(x.comparison.packages.map((p) => p.name)))
  // Optional chaining on purpose. If the repository node stops being
  // recognised, that has to show up as these named checks going red -- a
  // TypeError here would say nothing about which contract broke.
  chk('and never counted as a package we are missing',
    self?.presenceReason === 'repository-self', String(self?.presenceReason))
  chk('nor as a version to compare', self?.version === 'not-applicable', String(self?.version))
  chk('and the repository never appears among the npm packages either',
    !x.comparison.packages.some((p) => p.ecosystem === 'npm' && p.name.startsWith('com.github.')),
    JSON.stringify(x.comparison.packages.map((p) => `${p.ecosystem}/${p.name}`)))
}

console.log('\n── a version that really does differ is reported as differing')
{
  const s = readSbom(xlocked)
  const x = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main'),
    fetchSbom: serves(ghDoc([ghPkg('npm', 'chalk', '5.3.0', 'MIT'), ...AGREEING.slice(1)])),
  })
  chk('the differing package is marked', pkg(x, 'chalk').version === 'differs', pkg(x, 'chalk').version)
  chk('both claims survive, so a reader can see which is which',
    pkg(x, 'chalk').local.versions[0].value === '5.6.2' && pkg(x, 'chalk').github.versions[0].value === '5.3.0',
    JSON.stringify([pkg(x, 'chalk').local.versions, pkg(x, 'chalk').github.versions]))
  chk('and it is counted once', x.comparison.counts.versionDiffers === 1, JSON.stringify(x.comparison.counts))
  chk('the packages that agree still agree', x.comparison.counts.versionSame === 3, JSON.stringify(x.comparison.counts))
}

console.log('\n── a range is not a version, on either side, and never a difference')
{
  const s = readSbom(xlocked)
  // Their side is the range. This is the real shape: GitHub reports "4.*.*"
  // for an action, and reporting that against a locked 4.2.1 as a mismatch is
  // requirement 3's whole failure.
  const theirs = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main'),
    fetchSbom: serves(ghDoc([ghPkg('npm', 'chalk', '^5.3.0', 'MIT'), ...AGREEING.slice(1)])),
  })
  chk('a range on their side is labelled a constraint, exactly as ours would be',
    pkg(theirs, 'chalk').github.versions[0].kind === 'constraint', JSON.stringify(pkg(theirs, 'chalk').github.versions))
  chk('and the comparison refuses rather than differing',
    pkg(theirs, 'chalk').version === 'not-comparable-range', pkg(theirs, 'chalk').version)
  chk('specifically it is NOT reported as a version difference',
    pkg(theirs, 'chalk').version !== 'differs', pkg(theirs, 'chalk').version)
  chk('and it does not inflate the differs count', theirs.comparison.counts.versionDiffers === 0,
    JSON.stringify(theirs.comparison.counts))
  chk('it is counted as not comparable instead', theirs.comparison.counts.versionNotComparable === 1,
    JSON.stringify(theirs.comparison.counts))

  // Our side is the range: no lockfile, so every local version is what the
  // manifest asked for. Comparing that against their resolved version and
  // calling it a difference is the same error mirrored.
  const ours = await crossCheckWithGithub(readSbom(xunlocked), {
    git: gitOn('main...origin/main'),
    fetchSbom: serves(ghDoc([ghPkg('npm', 'chalk', '5.6.2', 'MIT')])),
  })
  chk('with no lockfile our side is a constraint', pkg(ours, 'chalk').local.versions[0].kind === 'constraint',
    JSON.stringify(pkg(ours, 'chalk').local.versions))
  chk('and a locked version on their side is still not comparable',
    pkg(ours, 'chalk').version === 'not-comparable-range', pkg(ours, 'chalk').version)
  chk('not a difference', pkg(ours, 'chalk').version !== 'differs', pkg(ours, 'chalk').version)
  chk('and a note says how little of a closure our side is',
    ours.notes.some((n) => n.includes('direct-dependency list')), JSON.stringify(ours.notes))

  chk('a bare exact version is the only thing read as locked', classifyVersionText('4.2.1') === 'locked', String(classifyVersionText('4.2.1')))
  for (const range of ['4.*.*', '^5.3.0', '~1.2.3', '>=1.0.0', '1.x', '*', 'latest', 'main', '4.2']) {
    chk(`a range is never read as a locked version: ${range}`, classifyVersionText(range) === 'constraint', String(classifyVersionText(range)))
  }
  chk('a prerelease is still an exact version', classifyVersionText('1.0.0-rc.1') === 'locked', String(classifyVersionText('1.0.0-rc.1')))
  chk('and nothing at all is neither', classifyVersionText('') === null && classifyVersionText(null) === null, '')
}

console.log('\n── two licence claims disagree, and neither of them wins')
{
  const s = readSbom(xlocked)
  const x = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main'),
    fetchSbom: serves(ghDoc([ghPkg('npm', 'chalk', '5.6.2', 'ISC'), ...AGREEING.slice(1)])),
  })
  const c = pkg(x, 'chalk')
  chk('the disagreement is surfaced, not resolved', c.license === 'disagree', c.license)
  chk("the lockfile's claim survives", JSON.stringify(c?.local?.licenses) === '["MIT"]', JSON.stringify(c?.local?.licenses))
  chk("and so does GitHub's", JSON.stringify(c?.github?.licenses) === '["ISC"]', JSON.stringify(c?.github?.licenses))
  const d = x.comparison.licenseDisagreements.find((y) => y.name === 'chalk')
  chk('it is listed where a reader will find it', !!d, JSON.stringify(x.comparison.licenseDisagreements))
  chk('with both sources named, so neither reads as the truth',
    d?.localSource === 'lockfile-license-field' && d?.githubSource === 'github-dependency-graph-licenseConcluded',
    JSON.stringify(d))
  chk('and both claims are carried, so no winner was picked',
    JSON.stringify(d?.local) === '["MIT"]' && JSON.stringify(d?.github) === '["ISC"]', JSON.stringify(d))
  chk('and a note says the comparison is exact-string, not SPDX-aware',
    x.notes.some((n) => n.includes('neither side is authoritative')), JSON.stringify(x.notes))
  chk('it is counted', x.comparison.counts.licenseDisagree === 1, JSON.stringify(x.comparison.counts))

  // A licence one side does not have is not a disagreement, and NOASSERTION is
  // not a licence: reading it as one would manufacture a conflict out of two
  // sources that between them said nothing.
  const undici = pkg(x, 'undici-types')
  chk('neither side claiming a licence is unknown, not a conflict', undici.license === 'both-unknown', undici.license)
  const noassert = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main'),
    fetchSbom: serves(ghDoc([ghPkg('npm', 'chalk', '5.6.2', 'NOASSERTION'), ...AGREEING.slice(1)])),
  })
  chk('SPDX NOASSERTION is read as unknown, not as a licence called NOASSERTION',
    pkg(noassert, 'chalk').license === 'only-local', pkg(noassert, 'chalk').license)
  chk('and it never disagrees with a real claim', noassert.comparison.counts.licenseDisagree === 0,
    JSON.stringify(noassert.comparison.counts))
}

console.log('\n── every way this can fail to run produces a stated result, never an empty diff')
{
  const s = readSbom(xlocked)
  const ok = gitOn('main...origin/main')
  // The worst outcome available to this feature is a clean bill of health for a
  // check that never happened. `comparison: null` is what makes that
  // unwriteable: there is no empty diff to render as agreement.
  const degraded = [
    ['gh is not installed', { git: ok, fetchSbom: refuses('gh-not-installed', 'the gh command is not on PATH') }, 'gh-not-installed'],
    ['gh is installed but not authenticated', { git: ok, fetchSbom: refuses('gh-not-authenticated', 'gh is installed but not authenticated to GitHub') }, 'gh-not-authenticated'],
    ['the repository is private to this token', { git: ok, fetchSbom: refuses('repo-not-visible', 'the repository endpoint returned HTTP 404') }, 'repo-not-visible'],
    ['the dependency graph is disabled', { git: ok, fetchSbom: refuses('dependency-graph-unavailable', 'the dependency graph endpoint returned HTTP 403') }, 'dependency-graph-unavailable'],
    ['a 403 or 404 that could not be pinned to one cause', { git: ok, fetchSbom: refuses('repo-or-graph-not-visible', 'the probe could not be reached') }, 'repo-or-graph-not-visible'],
    ['the network is down', { git: ok, fetchSbom: refuses('network-unavailable', 'gh could not reach GitHub') }, 'network-unavailable'],
    ['gh failed some other way', { git: ok, fetchSbom: refuses('fetch-failed', 'gh failed without saying why') }, 'fetch-failed'],
    ['this is not a git checkout', { git: gitFrom({}), fetchSbom: serves(ghDoc(AGREEING)) }, 'not-a-git-repository'],
    ['the checkout has no remote', { git: gitFrom({ 'remote -v': '', 'status --porcelain -b': '## main\n', 'rev-parse --short HEAD': 'abc1234\n', 'rev-parse --show-prefix': '' }), fetchSbom: serves(ghDoc(AGREEING)) }, 'no-remote'],
    ['the remote is not GitHub', { git: gitOn('main...origin/main', { remotes: 'origin\tgit@gitlab.com:acme/widget.git (fetch)\n' }), fetchSbom: serves(ghDoc(AGREEING)) }, 'remote-not-github'],
    ['the remote is not a shape we can resolve', { git: gitOn('main...origin/main', { remotes: 'origin\t/srv/git/widget.git (fetch)\n' }), fetchSbom: serves(ghDoc(AGREEING)) }, 'remote-unparseable'],
    ['the response is not the shape we expect', { git: ok, fetchSbom: serves({ message: 'Not Found', status: '404' }) }, 'unexpected-response'],
    ['the response is not an object at all', { git: ok, fetchSbom: serves('nope') }, 'unexpected-response'],
    ['the document has no packages array', { git: ok, fetchSbom: serves({ sbom: { spdxVersion: 'SPDX-2.3' } }) }, 'unexpected-response'],
  ]
  for (const [name, options, expected] of degraded) {
    const x = await crossCheckWithGithub(s, options)
    chk(`${name}: the status names it`, x.status === expected, `${x.status}: ${x.reason}`)
    chk(`${name}: there is no diff to mistake for agreement`, x.comparison === null, JSON.stringify(x.comparison))
    chk(`${name}: it says what happened`, typeof x.reason === 'string' && x.reason.length > 0, String(x.reason))
    chk(`${name}: and what the reader therefore cannot conclude`,
      typeof x.effect === 'string' && x.effect.includes('nothing here says the two bills of materials agree'), String(x.effect))
    chk(`${name}: the local reading is still reported`, x.local.entries === s.entries.length, `${x.local.entries} vs ${s.entries.length}`)
  }
  // The one thing every degraded state must never do: look like agreement.
  for (const [name, options] of degraded) {
    const x = await crossCheckWithGithub(s, options)
    chk(`${name}: no count of differences exists to read as zero`, x.comparison?.counts === undefined, JSON.stringify(x.comparison))
  }
}

console.log('\n── a repository this module cannot compare still names what it found')
{
  const s = readSbom(xlocked)
  const gl = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main', { remotes: 'origin\tgit@gitlab.com:acme/widget.git (fetch)\n' }),
    fetchSbom: serves(ghDoc(AGREEING)),
  })
  chk('the host that was found is named', gl.reason.includes('gitlab.com'), gl.reason)
  chk('and the repository is still reported, rather than nulled out', gl.repository?.host === 'gitlab.com', JSON.stringify(gl.repository))
  chk('the reason admits an ssh alias is indistinguishable from here', gl.reason.includes('ssh config alias'), gl.reason)
}

console.log('\n── the repository is resolved from the remote, in every form a remote takes')
{
  const forms = [
    ['git@github.com:acme/widget.git', 'github.com', 'acme', 'widget'],
    ['git@github.com:acme/widget', 'github.com', 'acme', 'widget'],
    ['https://github.com/acme/widget.git', 'github.com', 'acme', 'widget'],
    ['https://github.com/acme/widget', 'github.com', 'acme', 'widget'],
    ['ssh://git@github.com/acme/widget.git', 'github.com', 'acme', 'widget'],
    ['ssh://git@github.com:22/acme/widget.git', 'github.com', 'acme', 'widget'],
    ['git://github.com/acme/widget.git', 'github.com', 'acme', 'widget'],
    ['git@gitlab.com:acme/widget.git', 'gitlab.com', 'acme', 'widget'],
  ]
  for (const [url, host, owner, name] of forms) {
    const p = parseGitRemoteUrl(url)
    chk(`a remote is resolved: ${url}`, p?.host === host && p?.owner === owner && p?.name === name, JSON.stringify(p))
  }
  for (const junk of ['', '/srv/git/widget.git', 'https://github.com/acme', 'https://github.com/a/b/c']) {
    chk(`a remote that is not owner/name is refused rather than guessed: ${JSON.stringify(junk)}`,
      parseGitRemoteUrl(junk) === null, JSON.stringify(parseGitRemoteUrl(junk)))
  }
  // This report gets published. A https remote can carry a token in its
  // userinfo, and echoing the remote back as it was read would publish it.
  for (const secret of ['https://ghp_notarealtoken@github.com/acme/widget.git', 'https://someone:ghp_notarealtoken@github.com/acme/widget.git']) {
    const p = parseGitRemoteUrl(secret)
    chk('credentials in a remote URL never survive into the reported URL',
      p !== null && !p.url.includes('ghp_notarealtoken') && !p.url.includes('@'), JSON.stringify(p))
  }
  const s = readSbom(xlocked)
  const tokened = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main', { remotes: 'origin\thttps://ghp_notarealtoken@github.com/acme/widget.git (fetch)\n' }),
    fetchSbom: serves(ghDoc(AGREEING)),
  })
  chk('and not into the cross-check either', !JSON.stringify(tokened).includes('ghp_notarealtoken'),
    JSON.stringify(tokened.repository))
}

console.log('\n── a fork has two remotes, and only one of them was read')
{
  const s = readSbom(xlocked)
  const seen = []
  const x = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main', {
      remotes:
        'origin\tgit@github.com:me/widget.git (fetch)\norigin\tgit@github.com:me/widget.git (push)\n' +
        'upstream\thttps://github.com/acme/widget.git (fetch)\nupstream\thttps://github.com/acme/widget.git (push)\n',
    }),
    fetchSbom: async (repo) => { seen.push(`${repo.owner}/${repo.name}`); return { ok: true, body: ghDoc(AGREEING, { repo: 'me/widget' }) } },
  })
  chk('the fork is what was asked about, because that is what this checkout pushes to',
    JSON.stringify(seen) === '["me/widget"]', JSON.stringify(seen))
  chk('which remote it came from is recorded', x.repository.remote === 'origin', x.repository.remote)
  chk('the other remote is reported rather than hidden',
    x.repository.remotesSeen.some((r) => r.name === 'upstream' && r.url.includes('acme/widget')),
    JSON.stringify(x.repository.remotesSeen))
  chk('and a note says the upstream was not what was read',
    x.notes.some((n) => n.includes('forked from') && n.includes('upstream')), JSON.stringify(x.notes))
}

console.log('\n── a document describing some other repository is not silently accepted as this one')
{
  const s = readSbom(xlocked)
  const x = await crossCheckWithGithub(s, {
    git: gitOn('main...origin/main'),
    fetchSbom: serves(ghDoc(AGREEING, { repo: 'acme/widget-renamed' })),
  })
  chk('the swap is noticed', x.notes.some((n) => n.includes('acme/widget-renamed')), JSON.stringify(x.notes))
  chk('and the note says what was asked for', x.notes.some((n) => n.includes('acme/widget')), JSON.stringify(x.notes))
  chk('the comparison still happened, against what was actually returned', x.status === 'compared', x.status)
}

console.log('\n── their document is read the way it is actually shaped')
{
  const doc = readGithubSbomDocument(ghDoc([ghPkg('npm', '@types/node', '22.20.1', 'MIT'), ghPkg('githubactions', 'actions/checkout', '4.*.*')]))
  chk('the wrapper the endpoint puts around it is unwrapped', doc.ok === true, JSON.stringify(doc))
  chk('a scoped npm name keeps both segments', doc.packages.some((p) => p.name === '@types/node' && p.ecosystem === 'npm'),
    JSON.stringify(doc.packages.map((p) => `${p.ecosystem}/${p.name}`)))
  chk('the ecosystem comes from the purl', doc.packages.find((p) => p.name === '@types/node')?.ecosystemSource === 'purl',
    String(doc.packages.find((p) => p.name === '@types/node')?.ecosystemSource))
  chk('the ref is read from their own node for the repository', doc.ref.ref === 'main', JSON.stringify(doc.ref))
  chk('and so is the repository it describes', doc.ref.repository === 'acme/widget', String(doc.ref.repository))
  chk('an unwrapped document is accepted too', readGithubSbomDocument(ghDoc([]).sbom).ok === true, '')
  for (const junk of [null, 'text', 42, {}, { sbom: {} }, { sbom: { packages: 'no' } }]) {
    const r = readGithubSbomDocument(junk)
    chk(`a body that is not a document is refused with a reason: ${JSON.stringify(junk)}`,
      r.ok === false && typeof r.reason === 'string' && r.reason.length > 0, JSON.stringify(r))
  }
  // A document with no DESCRIBES relationship still must not bill the repo.
  const noRel = readGithubSbomDocument({ sbom: { packages: [{ name: 'com.github.acme/widget', SPDXID: 'SPDXRef-github-x', versionInfo: 'main', externalRefs: [{ referenceLocator: 'pkg:github/acme/widget@main' }] }] } })
  chk('without a DESCRIBES relationship the purl still identifies the repository node',
    noRel.ok === true && noRel.packages[0].isRepositorySelf === true, JSON.stringify(noRel))
}

console.log('\n── the local reading is never changed by any of this')
{
  // The cross-check is opt-in. A report that runs offline must be exactly what
  // it was before this file learned to reach the network.
  const before = JSON.stringify(readSbom(xlocked))
  await crossCheckWithGithub(readSbom(xlocked), { git: gitOn('main...origin/main'), fetchSbom: serves(ghDoc(AGREEING)) })
  chk('readSbom returns the same thing after a cross-check as before one', JSON.stringify(readSbom(xlocked)) === before, '')
  chk('and readSbom itself carries no cross-check field to be mistaken for one',
    !('crossCheck' in readSbom(xlocked)), JSON.stringify(Object.keys(readSbom(xlocked))))
}

rmSync(XROOT, { recursive: true, force: true })
console.log(failed === 0 ? '\nall sbom checks passed' : `\n${failed} sbom check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
