// A bill of materials for the repository a session ran in.
//
// WHY THIS IS NOT `artifacts.packages`. The spine already carries a per-session
// `artifacts.packages`: the import roots seen in text the model wrote during the
// session. That is evidence of what a session TALKED ABOUT. It is not a bill of
// materials and must never be presented as one — it has no versions, no
// licences, no transitive closure, and it is blind to every dependency the
// session did not happen to write an import for. A list like that reads as
// complete precisely because nothing on it is wrong, which is the failure this
// module exists to avoid. Nothing here is derived from it, and nothing here
// should be merged into it.
//
// What this reads instead: the repository's own manifests and lockfiles. Every
// field it returns names where it came from, because the difference between
// "the publisher claimed MIT" and "this package is MIT" is the whole point of a
// BOM, and so is the difference between "^4.0.0" and "4.2.1".
//
// The result is shaped to be drawn as well as listed: manifests and packages are
// nodes, `declares` and `depends` are edges, and every package carries the depth
// that proves a path back to a manifest exists. See `graphOf`.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative, sep } from 'node:path'
// Both of these are reached ONLY by the opt-in cross-check at the bottom of
// this file. `readSbom` runs no subprocess and touches no network, and the
// local report must keep working with neither git nor gh on the machine.
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

// ---------------------------------------------------------------- the shapes

/** Every node this module emits carries this, so a drawer cannot silently mix
 *  a dependency in with a decision or an intent. A dependency is a different
 *  KIND of thing from something a session concluded: one is a fact about the
 *  tree on disk, the other is a reading of what a person and a model did. The
 *  derived and authored layers were separated to stop exactly that conflation;
 *  putting both in one picture without a discriminator repeats it. */
export type BomLayer = 'dependency'

export type DepField = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'

/**
 * Whether a version string is a fact or a request.
 *
 * `locked` — read out of a lockfile: the version that is actually resolved.
 * `constraint` — read out of a manifest: a RANGE ("^5.7.2"), which is what the
 * project asked for and not what it got. The two are never merged into one
 * field, because a report that prints "^5.7.2" in a column headed "version" has
 * told the reader something false.
 */
export type VersionKind = 'locked' | 'constraint'

export type LockStatus =
  | 'read'                       // parsed; versions below are resolved facts
  | 'absent'                     // no lockfile at all next to or above this manifest
  | 'unread'                     // a lockfile exists but this module does not parse its format
  | 'not-covering-this-manifest' // a lockfile exists above, but has no entry for this manifest

export interface BomManifest {
  id: string
  layer: BomLayer
  kind: 'manifest'
  /** Repo-relative path of the package.json. */
  path: string
  name: string | null
  version: string | null
  ecosystem: 'npm'
  /** Repo-relative path of the lockfile that governs this manifest, when one was read. */
  lockPath: string | null
  lockStatus: LockStatus
  /** Named reason whenever lockStatus is not 'read'. Never null in that case. */
  lockReason: string | null
  /** How many dependencies this manifest declares, across all four fields.
   *  Zero here means "declares nothing", which is not the same fact as
   *  "we did not read it". */
  declaredCount: number
  /** True when a workspace root lists this manifest's directory. Workspace
   *  members are first-party code, so they are manifest nodes and never BOM
   *  entries — you do not bill yourself for your own package. */
  workspaceMember: boolean
}

export interface BomEntry {
  id: string
  layer: BomLayer
  kind: 'package'
  ecosystem: 'npm'
  name: string
  /** null only when neither a lock nor a manifest gave any version text. */
  version: string | null
  versionKind: VersionKind
  /** Repo-relative path of the file the version text was read from. */
  versionSource: string
  /** The declared range, when some manifest declares this package directly. */
  constraint: string | null
  relation: 'direct' | 'transitive'
  scope: 'runtime' | 'development'
  /** 'lockfile-dev-flag' | 'manifest-field' — how `scope` was decided. */
  scopeBasis: 'lockfile-dev-flag' | 'manifest-field'
  optional: boolean
  peer: boolean
  /** null means UNKNOWN. It never means MIT. */
  license: string | null
  /** 'lockfile-license-field' — npm's copy of the publisher's own `license`
   *  claim, not a verified fact and not a reading of any LICENSE file.
   *  'unknown' — nothing readable said anything. */
  licenseSource: 'lockfile-license-field' | 'unknown'
  /** Registry URL from the lockfile, when there was one. */
  resolved: string | null
  /** Repo-relative install location from the lockfile key; null for entries
   *  that exist only as a constraint in a manifest. */
  installPath: string | null
  /** Hops from the nearest manifest. 1 = declared by a manifest. null = present
   *  in the lockfile but not reachable from anything we read. */
  depth: number | null
}

export interface BomEdge {
  from: string
  to: string
  /** 'declares' — manifest to the package it names. 'depends' — package to
   *  package. Both directions of "what depends on this" are recoverable by
   *  filtering this one list; it is the graph, not a summary of it. */
  kind: 'declares' | 'depends'
  field: DepField
  constraint: string
}

/** A requirement that named something the lockfile does not contain. Surfaced
 *  rather than dropped: an unmet peer or a skipped optional is a real property
 *  of the tree, and an edge list that quietly loses them looks healthier than
 *  the repository is. */
export interface UnresolvedRequirement {
  from: string
  name: string
  constraint: string
  field: DepField
}

export interface EcosystemRead {
  ecosystem: string
  manifests: number
  locksRead: number
}

export interface EcosystemUnread {
  ecosystem: string
  /** Repo-relative path of the file that was seen and not parsed. */
  path: string
  reason: 'lock-format-not-parsed' | 'ecosystem-not-covered' | 'lockfile-unparseable'
  /** What the reader loses because of it, in plain words. */
  effect: string
}

export type ClosureState =
  | 'from-lockfiles'   // every manifest had a lockfile that was read
  | 'partial'          // some did; the rest contributed direct dependencies only
  | 'absent'           // none did; this is a direct-dependency list, not a closure

export interface Sbom {
  root: string
  status: 'ok' | 'no-manifest'
  /** Named whenever status is not 'ok', so an empty `entries` can never be
   *  mistaken for "this repository has no dependencies". */
  reason: string | null
  generatedFrom: 'manifests-and-lockfiles'
  coverage: { read: EcosystemRead[]; unread: EcosystemUnread[] }
  manifests: BomManifest[]
  entries: BomEntry[]
  edges: BomEdge[]
  unresolved: UnresolvedRequirement[]
  transitiveClosure: ClosureState
  counts: {
    manifests: number
    /** Line items. NOT the number of dependencies a person would name: one
     *  package installed twice is two entries, and one package declared by
     *  twelve workspace members with no lockfile to hoist it is twelve. A
     *  headline that reads "N dependencies" off this number overstates by a
     *  factor of three on real trees in this machine's corpus. */
    entries: number
    /** Distinct package names across the entries. */
    distinctNames: number
    /** Distinct name@version pairs — the count a "unique components" line
     *  should use. */
    distinctCoordinates: number
    direct: number
    transitive: number
    runtime: number
    development: number
    licenseUnknown: number
    lockedVersions: number
    constraintVersions: number
    orphanEntries: number
  }
  scan: {
    maxDepth: number
    /** Directories not descended into because maxDepth was hit. Named, because
     *  a manifest under one of them is missing from this BOM. */
    truncatedAt: string[]
    skippedDirNames: string[]
    /** Whether a node_modules exists at the root. The BOM is derived from the
     *  lockfile, so this does not change what is listed — but nothing here
     *  verifies the lockfile against what is installed, and this is the flag
     *  that says so. */
    nodeModulesPresent: boolean
  }
  notes: string[]
}

// ------------------------------------------------------------------ the walk

// node_modules is excluded because the lockfile already describes it and
// walking it would bill every dependency's own fixtures as first-party code.
// Dot-directories are excluded because Claude Code puts worktrees inside the
// repository at .claude/worktrees/<name> — descending into one would count a
// whole second checkout of the same project as part of this one.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__'])



const DEFAULT_MAX_DEPTH = 6

// Files that are evidence of a dependency ecosystem. `covered` is the only
// column that matters to a reader: false means the file was SEEN and NOT READ,
// which is a different statement from "there is nothing there".
const ECOSYSTEM_FILES: ReadonlyArray<{ file: string; ecosystem: string; covered: boolean; kind: 'manifest' | 'lock' }> = [
  { file: 'package.json', ecosystem: 'npm', covered: true, kind: 'manifest' },
  { file: 'package-lock.json', ecosystem: 'npm', covered: true, kind: 'lock' },
  // Same ecosystem, different lockfile. The manifest is still read, so direct
  // dependencies appear — as CONSTRAINTS, because the resolved versions are
  // sitting in a file this module cannot parse.
  { file: 'yarn.lock', ecosystem: 'npm', covered: false, kind: 'lock' },
  { file: 'pnpm-lock.yaml', ecosystem: 'npm', covered: false, kind: 'lock' },
  { file: 'bun.lock', ecosystem: 'npm', covered: false, kind: 'lock' },
  { file: 'bun.lockb', ecosystem: 'npm', covered: false, kind: 'lock' },
  { file: 'npm-shrinkwrap.json', ecosystem: 'npm', covered: false, kind: 'lock' },
  { file: 'requirements.txt', ecosystem: 'pypi', covered: false, kind: 'manifest' },
  { file: 'pyproject.toml', ecosystem: 'pypi', covered: false, kind: 'manifest' },
  { file: 'poetry.lock', ecosystem: 'pypi', covered: false, kind: 'lock' },
  { file: 'uv.lock', ecosystem: 'pypi', covered: false, kind: 'lock' },
  { file: 'Pipfile.lock', ecosystem: 'pypi', covered: false, kind: 'lock' },
  { file: 'Cargo.toml', ecosystem: 'cargo', covered: false, kind: 'manifest' },
  { file: 'Cargo.lock', ecosystem: 'cargo', covered: false, kind: 'lock' },
  { file: 'go.mod', ecosystem: 'go', covered: false, kind: 'manifest' },
  { file: 'Gemfile.lock', ecosystem: 'rubygems', covered: false, kind: 'lock' },
  { file: 'composer.lock', ecosystem: 'packagist', covered: false, kind: 'lock' },
]

/** Every filename above, by NAME rather than by path. Used where a file may no
 *  longer exist to have a path: a manifest DELETED in the working tree still
 *  changes what the local bill contains, and it is absent from any set built
 *  out of what the scan found on disk. */
const KNOWN_INPUT_NAMES = new Set(ECOSYSTEM_FILES.map((f) => f.file))

const LOCK_ALTERNATIVES = new Set(
  ECOSYSTEM_FILES.filter((f) => f.ecosystem === 'npm' && f.kind === 'lock' && !f.covered).map((f) => f.file),
)

interface FoundFile { dir: string; rel: string; file: string }

function walk(root: string, maxDepth: number): { found: FoundFile[]; truncatedAt: string[]; notes: string[] } {
  const found: FoundFile[] = []
  const truncatedAt: string[] = []
  const notes: string[] = []
  const wanted = new Set(ECOSYSTEM_FILES.map((f) => f.file))

  const visit = (dir: string, depth: number): void => {
    let ents
    try {
      ents = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Unreadable directories are named rather than skipped in silence; a BOM
      // that is short because of a permission error must not look complete.
      notes.push(`directory not readable, so anything under it is absent from this BOM: ${relOf(root, dir) || '.'}`)
      return
    }
    for (const e of ents) {
      if (e.isFile() || e.isSymbolicLink()) {
        if (wanted.has(e.name)) found.push({ dir, rel: relOf(root, dir), file: e.name })
      }
    }
    if (depth >= maxDepth) {
      for (const e of ents) {
        if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
          truncatedAt.push(relOf(root, join(dir, e.name)))
        }
      }
      return
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      visit(join(dir, e.name), depth + 1)
    }
  }

  visit(root, 0)
  return { found, truncatedAt, notes }
}

/** Repo-relative, always with forward slashes so an id means the same thing on
 *  every platform and in every JSON consumer. */
function relOf(root: string, p: string): string {
  const r = relative(root, p)
  return sep === '/' ? r : r.split(sep).join('/')
}

function readJson(path: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ------------------------------------------------------------- the lockfiles

interface LockPkg {
  version?: string
  resolved?: string
  license?: string
  dev?: boolean
  optional?: boolean
  peer?: boolean
  link?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface ReadLock {
  /** Repo-relative path of the lockfile. */
  path: string
  /** Directory the lockfile's keys are relative to, repo-relative ('' at root). */
  base: string
  packages: Record<string, LockPkg>
}

/**
 * npm's own resolution, replayed against the lockfile keys.
 *
 * A dependency name does not identify a lockfile entry: npm hoists, and the
 * same name can sit at several versions at once — this machine's own corpus has
 * `@cardano-sdk/core` installed four times in a single tree. Resolution walks
 * up from the requiring package's directory looking for `<dir>/node_modules/<name>`,
 * exactly as the runtime would, so an edge points at the version that would
 * actually be loaded rather than at whichever one happened to be first.
 *
 * Returns the lockfile key, or null when nothing matches — an unmet peer or a
 * platform-skipped optional, which the caller records instead of discarding.
 */
function resolveFrom(packages: Record<string, LockPkg>, fromKey: string, name: string): string | null {
  let prefix: string | null = fromKey
  while (prefix !== null) {
    const cand = prefix === '' ? `node_modules/${name}` : `${prefix}/node_modules/${name}`
    if (Object.prototype.hasOwnProperty.call(packages, cand)) return cand
    if (prefix === '') break
    const cut = prefix.lastIndexOf('/')
    prefix = cut === -1 ? '' : prefix.slice(0, cut)
  }
  return null
}

/** The package name a lockfile key installs, e.g.
 *  `apps/web/node_modules/@scope/x` -> `@scope/x`. */
function nameFromKey(key: string): string {
  const at = key.lastIndexOf('node_modules/')
  return at === -1 ? key : key.slice(at + 'node_modules/'.length)
}

const DEP_FIELDS: readonly DepField[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

// ------------------------------------------------------------------- reading

export interface ReadSbomOptions {
  /** How many directory levels below the root to walk. Anything deeper is
   *  reported in `scan.truncatedAt` rather than quietly missed. */
  maxDepth?: number
}

/**
 * Read the bill of materials for a repository.
 *
 * Never throws for a missing or malformed repository: every one of those is a
 * real state with a real answer. A repository with no manifest returns
 * status 'no-manifest' with a stated reason, because an empty `entries` array
 * on its own reads as "no dependencies", which is a different and much more
 * flattering claim.
 */
export function readSbom(root: string, options: ReadSbomOptions = {}): Sbom {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const notes: string[] = []
  const unread: EcosystemUnread[] = []

  const { found, truncatedAt, notes: walkNotes } = walk(root, maxDepth)
  notes.push(...walkNotes)

  const manifestFiles = found.filter((f) => f.file === 'package.json')
  const byDir = new Map<string, Set<string>>()
  for (const f of found) {
    let s = byDir.get(f.rel)
    if (!s) byDir.set(f.rel, (s = new Set()))
    s.add(f.file)
  }

  // Ecosystems seen and not read. Recorded before any early return, so even a
  // repository this module has nothing to say about still reports what it saw.
  for (const f of found) {
    const spec = ECOSYSTEM_FILES.find((x) => x.file === f.file)
    if (!spec || spec.covered) continue
    const path = f.rel ? `${f.rel}/${f.file}` : f.file
    unread.push({
      ecosystem: spec.ecosystem,
      path,
      reason: 'lock-format-not-parsed',
      effect:
        spec.ecosystem === 'npm'
          ? 'this lockfile format is not parsed, so the manifest beside it contributes direct dependencies as version CONSTRAINTS and no transitive closure'
          : `${spec.ecosystem} is not covered: nothing from this file appears in the BOM`,
    })
    if (spec.ecosystem !== 'npm') {
      unread[unread.length - 1]!.reason = 'ecosystem-not-covered'
    }
  }

  const nodeModulesPresent = (() => {
    try { return statSync(join(root, 'node_modules')).isDirectory() } catch { return false }
  })()

  const scan = {
    maxDepth,
    truncatedAt,
    skippedDirNames: [...SKIP_DIRS, '.*'],
    nodeModulesPresent,
  }

  if (manifestFiles.length === 0) {
    return {
      root,
      status: 'no-manifest',
      reason:
        unread.length > 0
          ? 'no package.json was found under this root; other ecosystems were detected but are not read by this module'
          : 'no package.json was found under this root',
      generatedFrom: 'manifests-and-lockfiles',
      coverage: { read: [], unread },
      manifests: [],
      entries: [],
      edges: [],
      unresolved: [],
      transitiveClosure: 'absent',
      counts: emptyCounts(),
      scan,
      notes,
    }
  }

  // --------------------------------------------------------------- lockfiles
  // One lockfile can govern many manifests (a workspace), so locks are read
  // once and shared rather than re-parsed per manifest.
  const lockCache = new Map<string, ReadLock | { unreadable: string }>()
  const readLockAt = (dirRel: string): ReadLock | { unreadable: string } | null => {
    if (!byDir.get(dirRel)?.has('package-lock.json')) return null
    const cached = lockCache.get(dirRel)
    if (cached) return cached
    const path = dirRel ? `${dirRel}/package-lock.json` : 'package-lock.json'
    const parsed = readJson(join(root, dirRel, 'package-lock.json'))
    let out: ReadLock | { unreadable: string }
    if (!parsed.ok) {
      out = { unreadable: `lockfile did not parse as JSON: ${parsed.error}` }
      unread.push({
        ecosystem: 'npm',
        path,
        reason: 'lockfile-unparseable',
        effect: 'versions from the manifest beside it are constraints, not facts, and there is no transitive closure',
      })
    } else if (!parsed.value || typeof parsed.value !== 'object' || !parsed.value.packages) {
      // lockfileVersion 1 stores a nested `dependencies` tree instead of the
      // flat `packages` map. It is a different format and guessing at it would
      // produce a BOM whose shape nobody checked, so it is declared unread.
      const v = parsed.value?.lockfileVersion
      out = { unreadable: `lockfile has no "packages" map (lockfileVersion ${v ?? 'unknown'})` }
      unread.push({
        ecosystem: 'npm',
        path,
        reason: 'lock-format-not-parsed',
        effect: `lockfileVersion ${v ?? 'unknown'} is not parsed: versions from the manifest beside it are constraints, not facts, and there is no transitive closure`,
      })
    } else {
      out = { path, base: dirRel, packages: parsed.value.packages as Record<string, LockPkg> }
    }
    lockCache.set(dirRel, out)
    return out
  }

  /** The nearest lockfile at or above a manifest's directory. */
  const nearestLock = (dirRel: string): { lock: ReadLock | null; status: LockStatus; reason: string | null; altPath: string | null } => {
    let d: string | null = dirRel
    while (d !== null) {
      const got = readLockAt(d)
      if (got && 'packages' in got) return { lock: got, status: 'read', reason: null, altPath: null }
      if (got) return { lock: null, status: 'unread', reason: got.unreadable, altPath: d ? `${d}/package-lock.json` : 'package-lock.json' }
      // No package-lock.json here — but another lockfile format might be, and
      // "locked by a file we cannot read" is not the same state as "unlocked".
      for (const alt of LOCK_ALTERNATIVES) {
        if (byDir.get(d)?.has(alt)) {
          const p = d ? `${d}/${alt}` : alt
          return { lock: null, status: 'unread', reason: `${alt} is present but this module does not parse that format`, altPath: p }
        }
      }
      if (d === '') break
      const cut: number = d.lastIndexOf('/')
      d = cut === -1 ? '' : d.slice(0, cut)
    }
    return { lock: null, status: 'absent', reason: 'no lockfile at or above this manifest', altPath: null }
  }

  // --------------------------------------------------------------- manifests
  const workspaceMembers = new Set<string>()
  const manifests: BomManifest[] = []
  const manifestByDir = new Map<string, BomManifest>()
  const declaredByManifest = new Map<string, Array<{ name: string; range: string; field: DepField }>>()

  for (const mf of manifestFiles) {
    const path = mf.rel ? `${mf.rel}/package.json` : 'package.json'
    const parsed = readJson(join(root, mf.rel, 'package.json'))
    if (!parsed.ok) {
      notes.push(`manifest did not parse as JSON, so nothing it declares is in this BOM: ${path} (${parsed.error})`)
      continue
    }
    const pkg = parsed.value ?? {}
    const declared: Array<{ name: string; range: string; field: DepField }> = []
    for (const field of DEP_FIELDS) {
      const map = pkg[field]
      if (!map || typeof map !== 'object') continue
      for (const [name, range] of Object.entries(map)) declared.push({ name, range: String(range), field })
    }
    const lockInfo = nearestLock(mf.rel)
    const m: BomManifest = {
      id: `manifest:${path}`,
      layer: 'dependency',
      kind: 'manifest',
      path,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      ecosystem: 'npm',
      lockPath: lockInfo.lock ? lockInfo.lock.path : lockInfo.altPath,
      lockStatus: lockInfo.status,
      lockReason: lockInfo.reason,
      declaredCount: declared.length,
      workspaceMember: false,
    }
    manifests.push(m)
    manifestByDir.set(mf.rel, m)
    declaredByManifest.set(m.id, declared)

    // Workspace globs are recorded, not expanded: the walk already found every
    // manifest, so the globs only need to say which of them are first-party.
    if (Array.isArray(pkg.workspaces) || (pkg.workspaces && Array.isArray(pkg.workspaces.packages))) {
      const globs: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages
      for (const g of globs) {
        const prefix = String(g).replace(/\/?\*+$/, '').replace(/\/$/, '')
        for (const other of manifestFiles) {
          if (other.rel === mf.rel) continue
          const base = mf.rel ? `${mf.rel}/` : ''
          if (other.rel === `${base}${prefix}` || other.rel.startsWith(`${base}${prefix}/`)) {
            workspaceMembers.add(other.rel)
          }
        }
      }
    }
  }
  for (const m of manifests) {
    const dir = m.path === 'package.json' ? '' : m.path.slice(0, -'/package.json'.length)
    if (workspaceMembers.has(dir)) m.workspaceMember = true
  }

  // ----------------------------------------------------------------- entries
  const entries = new Map<string, BomEntry>()
  const edges: BomEdge[] = []
  const unresolved: UnresolvedRequirement[] = []

  /** Lock key -> entry id, so `depends` edges can point at the right one of
   *  several installed copies. */
  const idOfKey = (lock: ReadLock, key: string): string =>
    `npm:${lock.base ? `${lock.base}/` : ''}${key}`

  const lockEntry = (lock: ReadLock, key: string, pkg: LockPkg): BomEntry => {
    const id = idOfKey(lock, key)
    const existing = entries.get(id)
    if (existing) return existing
    const installPath = `${lock.base ? `${lock.base}/` : ''}${key}`
    const e: BomEntry = {
      id,
      layer: 'dependency',
      kind: 'package',
      ecosystem: 'npm',
      name: nameFromKey(key),
      version: typeof pkg.version === 'string' ? pkg.version : null,
      versionKind: 'locked',
      versionSource: lock.path,
      constraint: null,
      relation: 'transitive',
      // npm sets `dev` only when a package is reachable EXCLUSIVELY through
      // devDependencies. Reachable both ways and the flag is absent, which is
      // why absent means runtime here and not "unclassified".
      scope: pkg.dev === true ? 'development' : 'runtime',
      scopeBasis: 'lockfile-dev-flag',
      optional: pkg.optional === true,
      peer: pkg.peer === true,
      // Absent means UNKNOWN. npm copies the publisher's own `license` field
      // when the package has one; roughly one entry in fifteen in this
      // machine's own trees has none, and filling those in with the modal
      // answer would be inventing a legal fact.
      license: typeof pkg.license === 'string' ? pkg.license : null,
      licenseSource: typeof pkg.license === 'string' ? 'lockfile-license-field' : 'unknown',
      resolved: typeof pkg.resolved === 'string' ? pkg.resolved : null,
      installPath,
      depth: null,
    }
    entries.set(id, e)
    return e
  }

  const locksRead = new Set<string>()
  const closureFrom: boolean[] = []

  // A workspace member declared by name, with no lockfile to reveal that it is
  // a symlink rather than a download. Without this the project bills itself:
  // one real workspace in this machine's corpus declares its own packages 124
  // times across 22 manifests, which is a fifth of its entries. Restricted to
  // manifests a workspace root actually lists, because a name collision with
  // something on the registry is otherwise indistinguishable from first-party
  // code and the safe reading of an ambiguous name is "this is a dependency".
  const workspaceByName = new Map<string, BomManifest>()
  for (const m of manifests) if (m.workspaceMember && m.name) workspaceByName.set(m.name, m)

  /**
   * A specifier that names a protocol instead of a range. `workspace:*` means
   * "resolve this from this repository"; `link:` and `file:` name a path on this
   * disk; `portal:` is yarn's version of the same. None of them is a version and
   * none of them is a third-party dependency.
   *
   * Checked on the SPECIFIER rather than on workspace membership, because
   * membership is declared in a different file in every package manager --
   * package.json for npm and yarn, pnpm-workspace.yaml for pnpm -- and reading
   * only the first meant every pnpm monorepo billed itself for its own packages
   * while reporting `workspace:*` in a field documented as a version.
   */
  const FIRST_PARTY_PROTOCOL = /^(workspace|link|file|portal):/

  const declareConstraint = (m: BomManifest, d: { name: string; range: string; field: DepField }): void => {
    const ws = workspaceByName.get(d.name)
    if (!ws && FIRST_PARTY_PROTOCOL.test(d.range)) {
      // First-party by declaration, but the member's own manifest was not
      // reached by the walk, so there is no node to point an edge at. Recorded
      // as a note rather than billed as a dependency or silently dropped.
      notes.push(
        `${d.name} is declared in ${m.path} as ${d.range}, a first-party protocol, ` +
          'so it is this repository\'s own code and is not billed as a dependency; ' +
          'its own manifest was not read'
      )
      return
    }
    if (ws) {
      edges.push({ from: m.id, to: ws.id, kind: 'declares', field: d.field, constraint: d.range })
      return
    }
    const id = `npm-constraint:${m.path}:${d.name}`
    const prior = entries.get(id)
    if (prior) {
      // Declared twice in one manifest (npm permits it and warns; this machine's
      // corpus has four live cases). Runtime wins, because a package needed at
      // runtime is needed at runtime whatever else also asks for it.
      if (d.field === 'dependencies') prior.scope = 'runtime'
      notes.push(`${d.name} is declared more than once in ${m.path}; kept as ${prior.scope}`)
    } else {
      entries.set(id, {
        id,
        layer: 'dependency',
        kind: 'package',
        ecosystem: 'npm',
        name: d.name,
        version: d.range,
        versionKind: 'constraint',
        versionSource: m.path,
        constraint: d.range,
        relation: 'direct',
        scope: d.field === 'devDependencies' ? 'development' : 'runtime',
        scopeBasis: 'manifest-field',
        optional: d.field === 'optionalDependencies',
        peer: d.field === 'peerDependencies',
        license: null,
        licenseSource: 'unknown',
        resolved: null,
        installPath: null,
        depth: 1,
      })
    }
    edges.push({ from: m.id, to: id, kind: 'declares', field: d.field, constraint: d.range })
  }

  for (const m of manifests) {
    const dir = m.path === 'package.json' ? '' : m.path.slice(0, -'/package.json'.length)
    const declared = declaredByManifest.get(m.id) ?? []
    const lockInfo = nearestLock(dir)
    const lock = lockInfo.lock

    if (!lock) {
      closureFrom.push(false)
      // No readable lock: every declared dependency is a REQUEST. The version
      // column carries the range and says so, and there is no transitive
      // closure to report because nothing on disk was consulted to resolve it.
      for (const d of declared) declareConstraint(m, d)
      continue
    }

    closureFrom.push(true)
    locksRead.add(lock.path)

    const selfKey = lock.base === '' ? dir : dir.slice(lock.base.length + 1)
    if (!Object.prototype.hasOwnProperty.call(lock.packages, selfKey)) {
      // The lock is above this manifest but has no entry for it — a nested
      // package.json that is not a workspace member. Its declarations are
      // constraints, and saying so beats resolving them against a tree that was
      // never installed for them.
      m.lockStatus = 'not-covering-this-manifest'
      m.lockReason = `${lock.path} has no entry for ${selfKey || '.'}`
      closureFrom[closureFrom.length - 1] = false
      for (const d of declared) declareConstraint(m, d)
      continue
    }

    for (const d of declared) {
      const key = resolveFrom(lock.packages, selfKey, d.name)
      if (key === null) {
        unresolved.push({ from: m.id, name: d.name, constraint: d.range, field: d.field })
        continue
      }
      const pkg = lock.packages[key]!
      if (pkg.link === true && typeof pkg.resolved === 'string') {
        // A workspace member, symlinked. It is first-party code with a manifest
        // of its own, so the edge goes to that manifest node and no BOM entry
        // is minted for it.
        const target = lock.base ? `${lock.base}/${pkg.resolved}` : pkg.resolved
        const tm = manifestByDir.get(target)
        if (tm) {
          edges.push({ from: m.id, to: tm.id, kind: 'declares', field: d.field, constraint: d.range })
          continue
        }
      }
      const e = lockEntry(lock, key, pkg)
      e.relation = 'direct'
      e.constraint = e.constraint ?? d.range
      edges.push({ from: m.id, to: e.id, kind: 'declares', field: d.field, constraint: d.range })
    }
  }

  // Every remaining lock entry is part of the closure, whether or not anything
  // we walked declares it. Minted after the direct pass so `relation` is
  // already correct on the ones that are declared.
  for (const lock of [...lockCache.values()].filter((l): l is ReadLock => l !== null && 'packages' in l)) {
    if (!locksRead.has(lock.path)) continue
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (!key.includes('node_modules/')) continue // '' and workspace members are manifests
      if (pkg.link === true) continue
      lockEntry(lock, key, pkg)
    }
    for (const [key, pkg] of Object.entries(lock.packages)) {
      if (!key.includes('node_modules/') || pkg.link === true) continue
      const fromId = idOfKey(lock, key)
      if (!entries.has(fromId)) continue
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
        const map = pkg[field]
        if (!map) continue
        for (const [name, range] of Object.entries(map)) {
          const target = resolveFrom(lock.packages, key, name)
          if (target === null) {
            unresolved.push({ from: fromId, name, constraint: String(range), field })
            continue
          }
          const tp = lock.packages[target]!
          if (tp.link === true && typeof tp.resolved === 'string') {
            const tm = manifestByDir.get(lock.base ? `${lock.base}/${tp.resolved}` : tp.resolved)
            if (tm) { edges.push({ from: fromId, to: tm.id, kind: 'depends', field, constraint: String(range) }); continue }
          }
          edges.push({ from: fromId, to: idOfKey(lock, target), kind: 'depends', field, constraint: String(range) })
        }
      }
    }
  }

  // ------------------------------------------------------------------- depth
  // Breadth-first from the manifests, so every transitive entry carries proof
  // that a path back to a declared one exists. Entries left at null are in the
  // lockfile and reachable from nothing we read — a real and reportable state,
  // not a number to round down to zero.
  {
    const out = new Map<string, string[]>()
    for (const e of edges) {
      let l = out.get(e.from)
      if (!l) out.set(e.from, (l = []))
      l.push(e.to)
    }
    const seen = new Set<string>()
    let frontier = manifests.map((m) => m.id)
    for (const id of frontier) seen.add(id)
    let d = 0
    while (frontier.length > 0) {
      d += 1
      const next: string[] = []
      for (const id of frontier) {
        for (const to of out.get(id) ?? []) {
          if (seen.has(to)) continue
          seen.add(to)
          const e = entries.get(to)
          if (e) e.depth = d
          next.push(to)
        }
      }
      frontier = next
    }
  }

  const list = [...entries.values()]
  const closure: ClosureState = closureFrom.every((x) => x)
    ? 'from-lockfiles'
    : closureFrom.some((x) => x)
      ? 'partial'
      : 'absent'

  if (closure !== 'from-lockfiles') {
    const bare = manifests.filter((m) => m.lockStatus !== 'read').map((m) => m.path)
    notes.push(
      closure === 'absent'
        ? `no lockfile was read: this is a DIRECT-DEPENDENCY list, not a transitive closure, and every version in it is a constraint (${bare.join(', ')})`
        : `these manifests contributed direct dependencies only, as constraints, because no lockfile covering them was read: ${bare.join(', ')}`,
    )
  }
  const orphans = list.filter((e) => e.depth === null).length
  if (orphans > 0) {
    notes.push(`${orphans} lockfile entries are reachable from no manifest that was read; they are listed with depth null rather than dropped`)
  }
  if (!nodeModulesPresent && locksRead.size > 0) {
    notes.push('node_modules is not present at the root; this BOM comes from the lockfile and is not verified against an installed tree')
  }

  const read: EcosystemRead[] = [{ ecosystem: 'npm', manifests: manifests.length, locksRead: locksRead.size }]

  return {
    root,
    status: 'ok',
    reason: null,
    generatedFrom: 'manifests-and-lockfiles',
    coverage: { read, unread },
    manifests,
    entries: list,
    edges,
    unresolved,
    transitiveClosure: closure,
    counts: {
      manifests: manifests.length,
      entries: list.length,
      distinctNames: new Set(list.map((e) => e.name)).size,
      distinctCoordinates: new Set(list.map((e) => `${e.name}@${e.version ?? '?'}`)).size,
      direct: list.filter((e) => e.relation === 'direct').length,
      transitive: list.filter((e) => e.relation === 'transitive').length,
      runtime: list.filter((e) => e.scope === 'runtime').length,
      development: list.filter((e) => e.scope === 'development').length,
      licenseUnknown: list.filter((e) => e.license === null).length,
      lockedVersions: list.filter((e) => e.versionKind === 'locked').length,
      constraintVersions: list.filter((e) => e.versionKind === 'constraint').length,
      orphanEntries: orphans,
    },
    scan,
    notes,
  }
}

function emptyCounts(): Sbom['counts'] {
  return {
    manifests: 0, entries: 0, distinctNames: 0, distinctCoordinates: 0, direct: 0,
    transitive: 0, runtime: 0, development: 0,
    licenseUnknown: 0, lockedVersions: 0, constraintVersions: 0, orphanEntries: 0,
  }
}

// --------------------------------------------------------- the correlation seam

export type ImportRootReason =
  | 'empty-specifier'
  | 'node-builtin'
  | 'relative-specifier'
  | 'absolute-specifier'
  | 'subpath-import'
  | 'url-specifier'
  | 'not-in-bom'
  /** The name was not found, but the closure is incomplete, so nothing was
   *  actually searched. Absence here is not evidence of absence. */
  | 'bom-incomplete'
  /** A node builtin name that no installed package shadows in this BOM. */
  | 'maybe-node-builtin'
  | 'no-bom'

export interface ImportRootMatch {
  /** The import root exactly as it arrived. */
  root: string
  /** The package name it reduces to, or null when it does not name one. */
  packageName: string | null
  /** Entry ids. Plural on purpose: one name can be installed at several
   *  versions in one tree, and picking one would be a guess. */
  entryIds: string[]
  status: 'matched' | 'unmatched'
  /** Named whenever status is 'unmatched'. */
  reason: ImportRootReason | null
}

export interface ImportRootMatchResult {
  matches: ImportRootMatch[]
  matchedCount: number
  unmatchedCount: number
  /** Roots that landed on more than one entry. A caller that wants a single
   *  dependency per import has to decide which, and this is the count that says
   *  how often that decision is being made. */
  ambiguousCount: number
}

const BUILTINS = new Set<string>(builtinModules)

/**
 * The package name an import root reduces to, or null with a reason.
 *
 * An import root is not a package name. `node:fs` is the runtime, `./util` is
 * this repository, `#internal` is a private mapping, and `lodash/merge` names a
 * file inside a package rather than the package. Every one of those has to come
 * back as a stated non-match, because turning them into package names is how a
 * correlation ends up asserting a dependency that does not exist.
 */
export function packageNameOf(spec: string): { name: string | null; reason: ImportRootReason | null } {
  const s = String(spec ?? '').trim()
  // Not 'not-in-bom': that reason says a package name was looked up and missed.
  // Nothing was looked up here, and saying otherwise would put a lookup in the
  // record that never happened.
  if (s === '') return { name: null, reason: 'empty-specifier' }
  if (s.startsWith('.')) return { name: null, reason: 'relative-specifier' }
  if (s.startsWith('/')) return { name: null, reason: 'absolute-specifier' }
  if (s.startsWith('#')) return { name: null, reason: 'subpath-import' }
  if (s.startsWith('node:')) return { name: null, reason: 'node-builtin' }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return { name: null, reason: 'url-specifier' }
  const parts = s.split('/')
  const name = s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
  // NOT resolved here. A bare `events` or `punycode` is a node builtin AND a
  // real package on the registry, and when the BOM contains one it is the
  // installed package that an import resolves to, not the builtin. Answering
  // "builtin" from the name alone reported a dependency the BOM itself lists as
  // though it were not a dependency. The caller checks the BOM first and only
  // falls back to this, so the name travels out and the decision is made where
  // the BOM is in scope.
  if (BUILTINS.has(name)) return { name, reason: 'maybe-node-builtin' }
  return { name, reason: null }
}

/**
 * Join import roots to BOM entries by name.
 *
 * WHAT THIS CAN SUPPORT: "these BOM entries carry the name this import root
 * reduces to". That is all. A turn that imported `express` is EVIDENCE that the
 * turn involved that dependency; it is not proof — the import may have been in
 * a code block the model wrote and never ran, in a comment, or in a file that
 * was reverted. A decision that touches an import is evidence about a
 * dependency and must never be rendered as a fact about one.
 *
 * WHAT IT CANNOT SUPPORT: which version. One name matching several entries is
 * the normal case in a hoisted tree, and this returns all of them rather than
 * choosing. Nor can it support absence: an import root missing from the BOM
 * means the name is not in the lockfile, not that the session was wrong.
 *
 * Unmatched roots come back in the list with a reason. They are never dropped —
 * a correlation that silently discards what it could not match reports a
 * perfect hit rate.
 */
export function matchImportRoots(sbom: Sbom, roots: readonly string[]): ImportRootMatchResult {
  const byName = new Map<string, string[]>()
  for (const e of sbom.entries) {
    let l = byName.get(e.name)
    if (!l) byName.set(e.name, (l = []))
    l.push(e.id)
  }
  const seen = new Set<string>()
  const matches: ImportRootMatch[] = []
  for (const raw of roots) {
    const root = String(raw ?? '')
    if (seen.has(root)) continue
    seen.add(root)
    const { name, reason } = packageNameOf(root)
    if (name === null) {
      matches.push({ root, packageName: null, entryIds: [], status: 'unmatched', reason })
      continue
    }
    if (sbom.status === 'no-manifest') {
      matches.push({ root, packageName: name, entryIds: [], status: 'unmatched', reason: 'no-bom' })
      continue
    }
    const ids = byName.get(name)
    // The BOM decides a shadowed builtin: if the installed package is here, the
    // import resolves to it.
    if (reason === 'maybe-node-builtin' && (!ids || ids.length === 0)) {
      matches.push({ root, packageName: null, entryIds: [], status: 'unmatched', reason: 'node-builtin' })
      continue
    }
    if (!ids || ids.length === 0) {
      // 'not-in-bom' says a name was looked up in a bill of materials and was
      // not there. That is only true when there IS a bill of materials to look
      // in: with the lockfile unread the closure is absent, nothing was
      // searched, and reporting absence would assert a check that never ran --
      // the same shape as claiming a redaction that never happened.
      const searched = sbom.transitiveClosure === 'from-lockfiles'
      matches.push({
        root, packageName: name, entryIds: [], status: 'unmatched',
        reason: searched ? 'not-in-bom' : 'bom-incomplete',
      })
      continue
    }
    matches.push({ root, packageName: name, entryIds: [...ids], status: 'matched', reason: null })
  }
  return {
    matches,
    matchedCount: matches.filter((m) => m.status === 'matched').length,
    unmatchedCount: matches.filter((m) => m.status === 'unmatched').length,
    ambiguousCount: matches.filter((m) => m.entryIds.length > 1).length,
  }
}

// ------------------------------------------------------------------- drawing

export type BomNode = BomManifest | BomEntry

/**
 * The BOM as nodes and edges, ready to draw.
 *
 * Two properties a drawer needs and cannot recover on its own:
 *
 * 1. SCALE. This is thousands of nodes where the session graph is about a
 *    hundred — one ordinary workspace in this machine's corpus is 982 lockfile
 *    entries. Anything that renders this needs a gate, and the gate has to say
 *    what it dropped. `depth` is the cheap one to gate on (1 = declared), and
 *    `counts` is what a "showing N of M" line should be computed against.
 *
 * 2. KIND. Every node carries `layer: 'dependency'` and a `kind` of 'manifest'
 *    or 'package'. A dependency is not the same kind of thing as a decision or
 *    an intent, and a picture that draws them as the same shape has made a
 *    claim about the data that the data does not make.
 */
export function graphOf(sbom: Sbom): {
  nodes: BomNode[]
  edges: BomEdge[]
  /** Edges dropped because an endpoint is not among the nodes, with the ids. */
  dangling: { from: string; to: string; kind: string }[]
} {
  const nodes = [...sbom.manifests, ...sbom.entries]
  // Every edge must land on a node that is drawn.
  //
  // A lockfile can name a dependency whose own manifest the walk never reached
  // -- a workspace member behind a skipped directory, a half-written file -- and
  // the edge to it survived while the node did not. A renderer given that pair
  // draws a line into empty space, which reads as a relation to something
  // invisible. This repo already has a CI step for exactly that failure in the
  // session graph; the bill of materials does not get to reintroduce it.
  //
  // Reported rather than silently filtered, because a dropped edge is a fact
  // about the reading and the page that draws this says what it dropped.
  const known = new Set(nodes.map((n) => n.id))
  const edges: BomEdge[] = []
  const dangling: { from: string; to: string; kind: string }[] = []
  for (const e of sbom.edges) {
    if (known.has(e.from) && known.has(e.to)) edges.push(e)
    else dangling.push({ from: e.from, to: e.to, kind: String(e.kind) })
  }
  return { nodes, edges, dangling }
}

// ═══════════════ a second reading of the same repository ════════════════════
//
// Everything above reads the working tree. GitHub publishes its own bill of
// materials for the same repository, built by its own parsers, and holding the
// two side by side says something neither says alone: which packages one source
// knows about and the other does not, and where two independent licence claims
// about the same package disagree.
//
// This is OPT-IN and lives behind its own function. `readSbom` above touches
// the network never; a report that runs offline has to keep working exactly as
// it did, so nothing here is reachable from there.
//
// FOUR WAYS A NAIVE COMPARISON LIES. Handling them is the whole of this
// section, and every one is handled here rather than left to the caller:
//
//  1. THE TWO SIDES DESCRIBE DIFFERENT THINGS. GitHub's dependency graph is
//     built from the repository's default branch. `readSbom` reads the working
//     tree. On a feature branch, with an uncommitted lockfile, or with commits
//     not yet pushed, the two SHOULD differ, and every one of those differences
//     is correct behaviour rather than a defect. `refs` states what each side
//     describes and `differencesExplainedByRef` says outright when a difference
//     already has its explanation. Nothing here is ever called an error. This
//     is the single most likely way this feature would end up lying.
//
//  2. GITHUB COVERS ECOSYSTEMS THIS MODULE DOES NOT. A GitHub Actions
//     dependency on their side is not a gap on ours -- we never claimed to read
//     one. Every package is classified by ecosystem BEFORE anything is called
//     absent, and one absent from the local reading is only ever reported as
//     absent from an ecosystem this module actually reads.
//
//  3. GITHUB ALSO REPORTS RANGES. "4.*.*" is not a resolved version. The
//     `VersionKind` distinction above applies to their side too: a range on
//     either side comes back as not comparable, never as a difference.
//
//  4. NEITHER LICENCE FIELD IS AUTHORITATIVE. npm's copy of the publisher's own
//     claim and GitHub's concluded licence are two claims about one package.
//     Where they disagree that is worth surfacing -- and this picks no winner:
//     both values are carried, each labelled with where it came from.

/**
 * What the cross-check was able to say. Exactly one of these is always set, and
 * only 'compared' ever comes with a comparison attached.
 *
 * Every other value is a REAL state with a REAL answer. A cross-check that
 * silently reports "no differences" because it never ran is the worst outcome
 * available here -- worse than an error, because it reads as agreement -- so
 * the comparison field is null rather than empty for all of them, which makes
 * that misreading impossible to write by accident.
 */
export type CrossCheckStatus =
  | 'compared'
  | 'not-a-git-repository'         // git could not be run here, or this is not a checkout
  | 'no-remote'                    // a checkout with no remote at all
  | 'remote-unparseable'           // a remote URL this module cannot turn into owner/name
  | 'remote-not-github'            // a remote pointing somewhere that is not github.com
  | 'gh-not-installed'
  | 'gh-not-authenticated'
  | 'repo-not-visible'             // the token cannot see it: private, or it is not there
  | 'dependency-graph-unavailable' // the repository is visible; this endpoint is not
  | 'repo-or-graph-not-visible'    // 403/404, and which of the two could not be told apart
  | 'network-unavailable'
  | 'unexpected-response'          // it answered, in a shape this module does not recognise
  | 'fetch-failed'                 // something else; the reason carries what was said

/** Fetch outcomes only. Kept separate from the statuses above so a fetcher seam
 *  cannot return 'no-remote', which is decided before any fetch happens. */
export type FetchFailureStatus = Extract<
  CrossCheckStatus,
  | 'gh-not-installed' | 'gh-not-authenticated' | 'repo-not-visible'
  | 'dependency-graph-unavailable' | 'repo-or-graph-not-visible'
  | 'network-unavailable' | 'fetch-failed'
>

export type GithubSbomFetch =
  | { ok: true; body: unknown }
  | { ok: false; status: FetchFailureStatus; reason: string }

/** The network seam. Injected by the test suite, which has no network and must
 *  never grow a dependency on one: a suite that reaches GitHub tests GitHub. */
export type GithubSbomFetcher = (repo: ResolvedRepo) => Promise<GithubSbomFetch>

/** The git seam. Takes arguments WITHOUT the `-C <root>` prefix, which the
 *  default binds, so a test feeds recorded output for real argument lists and
 *  the remote and branch parsing below is the thing under test. */
export type GitRunner = (args: readonly string[]) => { ok: true; stdout: string } | { ok: false; reason: string }

export interface ResolvedRepo {
  host: string
  owner: string
  name: string
  /** Which remote this came from, so a fork's `origin` is distinguishable from
   *  the `upstream` it was forked from. */
  remote: string
  /** The remote URL with any embedded credentials removed. A https remote can
   *  carry a token in its userinfo, and this string ends up in a report that
   *  gets published; printing it as it was read would leak one. */
  url: string
  /** Every remote seen. A fork has two, and the reader has to be able to see
   *  that the one NOT compared exists. */
  remotesSeen: ReadonlyArray<{ name: string; url: string }>
}

/** What the local side of the comparison describes. Never a commit on a server:
 *  the files on disk right now, which is why it can legitimately differ. */
export interface LocalRef {
  describes: 'working-tree'
  branch: string | null
  head: string | null
  detached: boolean
  /** Commits on this branch not on its upstream, or null when there is no
   *  upstream or it could not be read. Unpushed work is a difference GitHub
   *  cannot possibly know about yet. */
  ahead: number | null
  /** Commits on the upstream that this checkout does not have, or null when
   *  there is no upstream. GitHub's graph is built from what it has, so being
   *  behind is a difference the ref DOES account for -- and reading it as clean
   *  is how an un-pulled checkout blames the tool for somebody else's commit. */
  behind: number | null
  upstream: string | null
  /** The manifests and lockfiles that FED THIS BOM and differ from HEAD in the
   *  working tree -- modified, staged or untracked. Scoped to the BOM's own
   *  inputs on purpose: an edited README is not a reason the two bills differ. */
  dirtyBomInputs: string[]
  /** Whether the working tree differs from HEAD anywhere else. Reported and not
   *  mixed into the line above, because it explains nothing about the BOM. */
  otherWorkingTreeChanges: boolean
  read: boolean
  reason: string | null
}

/** What the GitHub side describes, read out of their document rather than
 *  assumed. GitHub builds this graph from the repository's default branch; the
 *  ref below is the one their document names for itself, which is the only
 *  claim the response actually supports. */
export interface GithubRef {
  describes: 'github-dependency-graph'
  ref: string | null
  refSource: 'spdx-self-package' | 'unknown'
  /** The repository their document says it describes. Need not be the one that
   *  was asked for: a rename or a redirect lands elsewhere, and a reader
   *  comparing against a repository they did not name should be told. */
  repository: string | null
}

export type RefRelation =
  | 'same-ref-clean'              // same ref, BOM inputs match HEAD, nothing unpushed OR unpulled
  | 'same-ref-dirty-working-tree'
  | 'same-ref-unpushed-commits'
  /** Same branch name, but the upstream has commits this checkout does not.
   *  GitHub built its graph from what it has, so anything it lists and this
   *  does not may simply be newer than this checkout -- which is an explanation,
   *  not a defect, and was previously indistinguishable from clean. */
  | 'same-ref-behind-upstream'
  | 'different-ref'
  | 'ref-unknown'

export interface RefComparison {
  local: LocalRef
  github: GithubRef | null
  relation: RefRelation
  /** The relation in words, naming every fact it was decided from. */
  relationReason: string
  /**
   * True whenever the two sides are not describing the same content, which
   * means a difference below needs no further explanation than that.
   *
   * False is NOT "any difference is a defect". It is the weaker and only
   * supportable claim: the ref does not account for it. GitHub rebuilds this
   * graph on push and can lag, and nothing here verifies their document against
   * the commit this tree sits on.
   */
  differencesExplainedByRef: boolean
}

export interface VersionClaim { value: string; kind: VersionKind }

export interface SideOfComparison {
  /** Distinct version claims for this name on this side. Plural because one
   *  name can be installed at several versions in one tree. */
  versions: VersionClaim[]
  /** How many line items produced those versions. */
  copies: number
  /** Distinct non-empty licence claims. */
  licenses: string[]
}

export type PresenceReason =
  | 'in-both'
  /** On GitHub only, in an ecosystem this module never claimed to read. This is
   *  not a miss: it is a kind of dependency the local reading is not about. */
  | 'ecosystem-not-read-locally'
  /** GitHub's node for the repository itself. Not a dependency on either side. */
  | 'repository-self'
  /** On GitHub only, in an ecosystem this module does read. */
  | 'absent-from-local-bom'
  /** Local only. */
  | 'absent-from-github-document'

export type VersionAgreement =
  | 'same'
  | 'differs'
  /** A range on one side or the other. Requirement 3: never a difference. */
  | 'not-comparable-range'
  | 'not-comparable-absent'
  | 'not-applicable'

export type LicenseAgreement =
  | 'agree'
  | 'disagree'
  | 'only-local'
  | 'only-github'
  | 'both-unknown'
  /** One side claims more than one licence for this name -- several installed
   *  copies that do not agree with each other. Comparing that against a single
   *  value on the other side would be picking one of ours to compare. */
  | 'ambiguous'
  | 'not-applicable'

export interface PackageComparison {
  name: string
  ecosystem: string
  presence: 'both' | 'only-local' | 'only-github'
  presenceReason: PresenceReason
  local: SideOfComparison | null
  github: SideOfComparison | null
  version: VersionAgreement
  license: LicenseAgreement
}

/** A licence claim that two independent sources make differently. Surfaced as
 *  its own list because it is the finding a reader would otherwise have to go
 *  looking for. Neither field is authoritative; both are labelled claims. */
export interface LicenseDisagreement {
  name: string
  ecosystem: string
  local: string[]
  localSource: 'lockfile-license-field'
  github: string[]
  githubSource: 'github-dependency-graph-licenseConcluded'
}

export interface BomComparison {
  /** Ecosystems both sides speak. Anything outside this is reported, never
   *  compared. */
  ecosystemsCompared: string[]
  packages: PackageComparison[]
  licenseDisagreements: LicenseDisagreement[]
  counts: {
    bothSides: number
    onlyLocal: number
    /** On GitHub only, in an ecosystem this module reads. The number a reader
     *  should look at. */
    onlyGithubInReadEcosystem: number
    /** On GitHub only, in an ecosystem this module does not read. NOT a gap. */
    onlyGithubOutOfScope: number
    versionSame: number
    versionDiffers: number
    versionNotComparable: number
    licenseAgree: number
    licenseDisagree: number
    licenseOneSided: number
    licenseBothUnknown: number
  }
}

export interface CrossCheck {
  status: CrossCheckStatus
  /** What happened, in words. Never empty, for any status. */
  reason: string
  /** What the reader cannot conclude because of it. Never empty. */
  effect: string
  source: { tool: 'gh'; endpoint: string } | null
  repository: ResolvedRepo | null
  refs: RefComparison
  /** Null for every status but 'compared'. Null and not an empty comparison, so
   *  a cross-check that did not run cannot be rendered as agreement. */
  comparison: BomComparison | null
  /** What the local side claimed, carried along so a difference can be read
   *  against how much of a bill of materials there was to compare. */
  local: { status: Sbom['status']; transitiveClosure: ClosureState; entries: number }
  notes: string[]
}

// ------------------------------------------------------- remotes and refs

/** Ecosystems this module claims to read, taken from the table above rather
 *  than hardcoded, so adding a parser there cannot leave this behind saying a
 *  package is out of scope when it is not. Deliberately NOT `coverage.read`,
 *  which is what a particular repository happened to contain: a repository with
 *  no package.json still has npm as an ecosystem this module reads. */
const READ_ECOSYSTEMS = new Set(ECOSYSTEM_FILES.filter((f) => f.covered).map((f) => f.ecosystem))

/** purl types that spell an ecosystem differently from the table above. Without
 *  this a Go module comes back as 'golang', misses the `READ_ECOSYSTEMS` check
 *  on spelling alone, and gets a reason naming the wrong thing. */
const PURL_TYPE_TO_ECOSYSTEM: Record<string, string> = {
  golang: 'go',
  gem: 'rubygems',
  composer: 'packagist',
}

/**
 * owner/name/host out of a git remote URL, or null when it is not that shape.
 *
 * Both forms real checkouts use: scp-like (`git@host:owner/name.git`) and URL
 * (`https://host/owner/name.git`, `ssh://git@host/owner/name`). Credentials in
 * the userinfo are DROPPED rather than carried into `url`, because that string
 * is written into a report -- a https remote holding a token would publish it.
 */
export function parseGitRemoteUrl(raw: string): { host: string; owner: string; name: string; url: string } | null {
  const s = String(raw ?? '').trim()
  if (s === '') return null

  let host: string | null = null
  let path: string | null = null
  let scheme = ''

  const asUrl = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/.exec(s)
  if (asUrl) {
    scheme = `${asUrl[1]!}://`
    host = asUrl[2]!
    path = asUrl[3]!
  } else {
    // scp-like. The lookahead keeps a `scheme://` that failed the branch above
    // from being read as a host called `https`, and a bare local path
    // (`/srv/git/x`) has no colon and falls through to null.
    const asScp = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(s)
    if (asScp) {
      host = asScp[1]!
      path = asScp[2]!
    }
  }
  if (host === null || path === null) return null

  const segs = path.replace(/\.git$/, '').split('/').filter((x) => x !== '')
  // Exactly owner/name. Anything else is a shape this module does not know how
  // to turn into a repository, and guessing would send the cross-check to some
  // other repository and present the answer as this one's.
  if (segs.length !== 2) return null
  return { host, owner: segs[0]!, name: segs[1]!, url: `${scheme}${host}/${segs[0]!}/${segs[1]!}` }
}

/** `git remote -v` into name/url pairs, fetch URL preferred. */
function parseRemotes(stdout: string): Array<{ name: string; url: string }> {
  const out = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/.exec(line)
    if (!m) continue
    if (m[3] === 'fetch' || !out.has(m[1]!)) out.set(m[1]!, m[2]!)
  }
  return [...out].map(([name, url]) => ({ name, url }))
}

/** The `## ` header `git status --porcelain -b` puts on its first line.
 *
 *  BOTH numbers in the bracket, not just `ahead`. Reading only `ahead` was the
 *  worst defect this comparison could carry: a checkout that has fetched and not
 *  pulled is `[behind 1]`, which parsed to `ahead: 0` and made the two sides
 *  look like the same clean ref -- so the dependency somebody added upstream
 *  yesterday was reported as an unexplained difference, under a sentence saying
 *  the ref does not account for it. That is not an edge case; it is every
 *  checkout anybody has left alone for a day. */
function parseStatusBranch(line: string): { branch: string | null; upstream: string | null; ahead: number | null; behind: number | null; detached: boolean } {
  const head = line.startsWith('## ') ? line.slice(3) : line
  if (head.startsWith('HEAD (no branch)')) return { branch: null, upstream: null, ahead: null, behind: null, detached: true }
  const fresh = /^No commits yet on (.+)$/.exec(head)
  if (fresh) return { branch: fresh[1]!.trim(), upstream: null, ahead: null, behind: null, detached: false }
  const m = /^(\S+?)(?:\.\.\.(\S+))?(?:\s+\[(.+)\])?$/.exec(head)
  if (!m) return { branch: head.trim() || null, upstream: null, ahead: null, behind: null, detached: false }
  const ahead = m[3] ? /ahead (\d+)/.exec(m[3]) : null
  const behind = m[3] ? /behind (\d+)/.exec(m[3]) : null
  return {
    branch: m[1]!,
    upstream: m[2] ?? null,
    // null rather than 0 when there is no upstream: "nothing unpushed" and "no
    // upstream to be unpushed to" are different states, and only one of them is
    // evidence that GitHub could have seen this branch.
    ahead: m[2] ? (ahead ? Number(ahead[1]) : 0) : null,
    behind: m[2] ? (behind ? Number(behind[1]) : 0) : null,
    detached: false,
  }
}

/** The paths `git status --porcelain` reported, repo-root-relative. */
function parseStatusPaths(lines: readonly string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (line.length < 4 || line.startsWith('## ')) continue
    let p = line.slice(3)
    // A rename prints `old -> new`; the new path is the one on disk.
    const arrow = p.indexOf(' -> ')
    if (arrow !== -1) p = p.slice(arrow + 4)
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1)
    if (p !== '') out.push(p)
  }
  return out
}

function firstLine(s: string): string {
  return String(s ?? '').split('\n').map((x) => x.trim()).filter((x) => x !== '')[0] ?? ''
}

const defaultGit = (root: string): GitRunner => (args) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15_000 })
  if (r.error) return { ok: false, reason: r.error instanceof Error ? r.error.message : String(r.error) }
  if (r.status !== 0) return { ok: false, reason: firstLine(String(r.stderr ?? '')) || `git exited with status ${r.status}` }
  return { ok: true, stdout: String(r.stdout ?? '') }
}

/**
 * What the working tree is, as far as git will say.
 *
 * Never throws and never refuses: a checkout with no commits, a detached HEAD
 * and a directory that is not a repository at all each come back as a stated
 * result, because "we could not tell which ref this is" has to be visible in
 * the comparison rather than defaulted into "the same one".
 */
function readLocalRef(sbom: Sbom, git: GitRunner): LocalRef {
  const blank: LocalRef = {
    describes: 'working-tree', branch: null, head: null, detached: false, ahead: null, behind: null, upstream: null,
    dirtyBomInputs: [], otherWorkingTreeChanges: false, read: false, reason: null,
  }
  const status = git(['status', '--porcelain', '-b'])
  if (!status.ok) return { ...blank, reason: `git status could not be read: ${status.reason}` }

  const lines = status.stdout.split('\n')
  const branchLine = lines.find((l) => l.startsWith('## ')) ?? ''
  const { branch, upstream, ahead, behind, detached } = parseStatusBranch(branchLine)

  const headRun = git(['rev-parse', '--short', 'HEAD'])
  const head = headRun.ok ? headRun.stdout.trim() || null : null

  // Porcelain paths are relative to the REPOSITORY root, while BOM paths are
  // relative to the root that was scanned. Without this prefix the two never
  // match for a scan of a subdirectory, and every dirty lockfile reads as clean
  // -- the wrong direction to be wrong in, because it would then claim a
  // working-tree difference was unexplained by the ref.
  const prefixRun = git(['rev-parse', '--show-prefix'])
  const prefix = prefixRun.ok ? prefixRun.stdout.trim() : ''

  const inputs = new Set<string>()
  for (const m of sbom.manifests) {
    inputs.add(`${prefix}${m.path}`)
    if (m.lockPath) inputs.add(`${prefix}${m.lockPath}`)
  }
  for (const u of sbom.coverage.unread) inputs.add(`${prefix}${u.path}`)

  const changed = parseStatusPaths(lines)
  // A file that fed this BOM is one readSbom FOUND, and a manifest deleted in
  // the working tree is by definition not among them -- so the single edit that
  // most changes what the local bill contains was the one edit this field could
  // not see, and the removed package's dependencies came out as an unexplained
  // gap. The same failure the field exists to prevent, reached from the other
  // side. So a changed path is also a BOM input when its NAME is one this reader
  // recognises, whether or not the file is still there.
  const isInput = (p: string): boolean => inputs.has(p) || KNOWN_INPUT_NAMES.has(p.slice(p.lastIndexOf('/') + 1))
  const dirty = changed.filter(isInput).map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p))
  return {
    describes: 'working-tree',
    branch, head, detached, ahead, behind, upstream,
    dirtyBomInputs: [...new Set(dirty)].sort(),
    otherWorkingTreeChanges: changed.length > dirty.length,
    read: true,
    reason: null,
  }
}

// --------------------------------------------------------- their document

export interface GithubPackage {
  name: string
  ecosystem: string
  ecosystemSource: 'purl' | 'spdxid' | 'unknown'
  version: string | null
  versionKind: VersionKind | null
  license: string | null
  spdxId: string | null
  isRepositorySelf: boolean
}

export type GithubDocumentRead =
  | { ok: true; packages: GithubPackage[]; ref: GithubRef; spdxVersion: string | null; documentName: string | null }
  | { ok: false; reason: string }

/**
 * Whether a version string is a resolved version or a request for one.
 *
 * Only a complete semantic version counts as `locked`. Everything else --
 * "4.*.*", "^5.3.0", ">=1.2", "latest", a branch name -- is a `constraint`,
 * which is the same distinction the local reader already draws and the reason
 * requirement 3 exists: comparing GitHub's "4.*.*" against a locked "4.2.1" and
 * printing a difference would be reporting a range as a version mismatch.
 *
 * Under-claims on purpose. A version this cannot recognise comes back as a
 * constraint and is reported as not comparable, which loses a comparison; the
 * other way round would invent one.
 */
export function classifyVersionText(text: string | null | undefined): VersionKind | null {
  const s = String(text ?? '').trim()
  if (s === '') return null
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(s) ? 'locked' : 'constraint'
}

/** SPDX spells "we do not know" as a value. Reading it as a licence would put
 *  the string NOASSERTION in a licence column and, worse, make it disagree with
 *  a real claim on the other side -- inventing a licence conflict out of two
 *  sources that between them said nothing. */
function spdxLicense(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '' || s === 'NOASSERTION' || s === 'NONE') return null
  return s
}

function ecosystemOf(pkg: Record<string, unknown>): { ecosystem: string; source: 'purl' | 'spdxid' | 'unknown' } {
  const refs = Array.isArray(pkg['externalRefs']) ? (pkg['externalRefs'] as unknown[]) : []
  for (const r of refs) {
    if (!r || typeof r !== 'object') continue
    const loc = (r as Record<string, unknown>)['referenceLocator']
    if (typeof loc !== 'string' || !loc.startsWith('pkg:')) continue
    const type = loc.slice(4).split('/')[0]!.split('@')[0]!.toLowerCase()
    if (type !== '') return { ecosystem: PURL_TYPE_TO_ECOSYSTEM[type] ?? type, source: 'purl' }
  }
  // The SPDXID carries the same word (`SPDXRef-npm-...`, `SPDXRef-githubactions-...`)
  // and is the fallback when a package has no purl at all. Weaker evidence: the
  // ids are GitHub's own construction rather than a standard, so it is labelled.
  const id = pkg['SPDXID']
  if (typeof id === 'string') {
    const m = /^SPDXRef-([a-z]+)-/.exec(id)
    if (m) return { ecosystem: PURL_TYPE_TO_ECOSYSTEM[m[1]!] ?? m[1]!, source: 'spdxid' }
  }
  return { ecosystem: 'unknown', source: 'unknown' }
}

/**
 * The SPDX document GitHub returns, validated into the shape above.
 *
 * Refuses rather than guesses. `gh api` hands back whatever the endpoint said,
 * and a body that is an error object, an empty object, or SPDX with no packages
 * array has to come back as a stated non-read: half-parsing it would produce a
 * comparison against a package list nobody checked, and an empty package list
 * on their side reads as "GitHub knows about nothing", which turns every local
 * dependency into a finding.
 */
export function readGithubSbomDocument(body: unknown): GithubDocumentRead {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'the response was not a JSON object' }
  const outer = body as Record<string, unknown>
  // The endpoint wraps the document: { "sbom": { ... } }. A document handed
  // over unwrapped is accepted too, because a recorded fixture or a response
  // shape that drops the wrapper is not a reason to refuse a valid document.
  const docRaw = outer['sbom'] !== undefined ? outer['sbom'] : outer
  if (!docRaw || typeof docRaw !== 'object') return { ok: false, reason: 'the response had no "sbom" document object' }
  const doc = docRaw as Record<string, unknown>
  const packagesRaw = doc['packages']
  if (!Array.isArray(packagesRaw)) {
    return { ok: false, reason: 'the SPDX document has no "packages" array, so there is nothing to compare against' }
  }

  // Which package is the repository itself, taken from the document's own
  // DESCRIBES relationship rather than guessed from the name. GitHub lists the
  // repository beside its dependencies; counting it as one would report the
  // project as a dependency of itself, at a "version" that is a branch name.
  let selfId: string | null = null
  const rels = Array.isArray(doc['relationships']) ? (doc['relationships'] as unknown[]) : []
  for (const r of rels) {
    if (!r || typeof r !== 'object') continue
    const rr = r as Record<string, unknown>
    if (rr['relationshipType'] === 'DESCRIBES' && rr['spdxElementId'] === 'SPDXRef-DOCUMENT' && typeof rr['relatedSpdxElement'] === 'string') {
      selfId = rr['relatedSpdxElement']
      break
    }
  }

  const packages: GithubPackage[] = []
  let ref: GithubRef = { describes: 'github-dependency-graph', ref: null, refSource: 'unknown', repository: null }

  for (const p of packagesRaw) {
    if (!p || typeof p !== 'object') continue
    const pk = p as Record<string, unknown>
    const name = typeof pk['name'] === 'string' ? pk['name'].trim() : ''
    if (name === '') continue
    const eco = ecosystemOf(pk)
    const version = typeof pk['versionInfo'] === 'string' && pk['versionInfo'].trim() !== '' ? pk['versionInfo'].trim() : null
    const spdxId = typeof pk['SPDXID'] === 'string' ? pk['SPDXID'] : null
    // The DESCRIBES relationship is the document's own statement about which
    // node is the repository. The purl type is the fallback for a document that
    // omits it -- weaker, but still theirs rather than a guess from the name.
    const isSelf = selfId !== null ? spdxId === selfId : eco.ecosystem === 'github'
    packages.push({
      name,
      ecosystem: eco.ecosystem,
      ecosystemSource: eco.source,
      version,
      versionKind: classifyVersionText(version),
      // licenseConcluded is GitHub's field for a dependency. The repository's
      // own node carries licenseDeclared instead; it is read for completeness
      // and never compared, because the repository is not a dependency.
      license: spdxLicense(pk['licenseConcluded']) ?? (isSelf ? spdxLicense(pk['licenseDeclared']) : null),
      spdxId,
      isRepositorySelf: isSelf,
    })
    if (isSelf) {
      // The self package's version is the ref GitHub's document describes and
      // its purl names the repository. This is the only statement in the whole
      // response about WHICH content was read, and requirement 1 turns on it.
      const purl = (() => {
        const refsArr = Array.isArray(pk['externalRefs']) ? (pk['externalRefs'] as unknown[]) : []
        for (const r of refsArr) {
          if (!r || typeof r !== 'object') continue
          const loc = (r as Record<string, unknown>)['referenceLocator']
          if (typeof loc === 'string' && loc.startsWith('pkg:github/')) return loc
        }
        return null
      })()
      const repo = purl
        ? decodeURIComponent(purl.slice('pkg:github/'.length).split('@')[0]!)
        : name.replace(/^com\.github\./, '')
      ref = {
        describes: 'github-dependency-graph',
        ref: version,
        refSource: version === null ? 'unknown' : 'spdx-self-package',
        repository: repo === '' ? null : repo,
      }
    }
  }

  // A document whose only entry is the repository itself lists no dependency at
  // all, and that is a real response: the graph is enabled but not yet indexed,
  // or every manifest is one GitHub does not parse. It passed the array check
  // above and then made every local dependency a finding -- which is the exact
  // outcome the guard's own comment says an empty package list must never be
  // allowed to produce. The self node also supplies a valid ref, so the
  // ref-unknown safety net that incidentally rescues a literal `packages: []`
  // does not fire here.
  if (!packages.some((p) => !p.isRepositorySelf)) {
    return {
      ok: false,
      reason:
        packages.length === 0
          ? 'the SPDX document lists no packages at all, so there is nothing to compare against'
          : "the SPDX document lists only the repository itself and no dependency, so there is nothing to compare against -- GitHub's graph may be enabled but not yet indexed, or it may parse none of this repository's manifests",
    }
  }

  return {
    ok: true,
    packages,
    ref,
    spdxVersion: typeof doc['spdxVersion'] === 'string' ? doc['spdxVersion'] : null,
    documentName: typeof doc['name'] === 'string' ? doc['name'] : null,
  }
}

// --------------------------------------------------------- the default fetcher

const runGh = promisify(execFile)

type GhAttempt =
  | { ok: true; stdout: string }
  | { ok: false; kind: FetchFailureStatus; reason: string; httpStatus: number | null }

/**
 * One `gh api` call, with every failure classified from what gh actually said.
 *
 * The patterns below match strings this machine observed from the real tool --
 * an unauthenticated gh printing its login hint, a network failure printing
 * "error connecting to", a rejection printing "(HTTP 404)" -- rather than
 * strings that seemed likely. Anything unrecognised comes back as
 * 'fetch-failed' carrying gh's own first line, because a confident wrong
 * diagnosis is worse than an honest general one.
 */
async function ghApi(path: string): Promise<GhAttempt> {
  try {
    const { stdout } = await runGh('gh', ['api', path], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 })
    return { ok: true, stdout: String(stdout) }
  } catch (e) {
    const err = e as { code?: string | number; stderr?: string; message?: string }
    // ENOENT from the spawn itself rather than from gh: the tool is not on PATH.
    if (err.code === 'ENOENT') {
      return { ok: false, kind: 'gh-not-installed', reason: 'the gh command is not on PATH', httpStatus: null }
    }
    const said = `${String(err.stderr ?? '')}\n${String(err.message ?? '')}`
    const http = /\(HTTP (\d{3})\)/.exec(said)
    const httpStatus = http ? Number(http[1]) : null
    // Order matters. An unauthenticated gh prints its login hint and no HTTP
    // status; a network failure prints a connection error and no status either.
    // Testing the status first would send both of them to 'fetch-failed'.
    if (/gh auth login|GH_TOKEN|GITHUB_TOKEN|authentication token/i.test(said) || httpStatus === 401) {
      return { ok: false, kind: 'gh-not-authenticated', reason: 'gh is installed but not authenticated to GitHub', httpStatus }
    }
    if (/error connecting to|check your internet connection|dial tcp|no such host|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network is unreachable|ETIMEDOUT/i.test(said)) {
      return { ok: false, kind: 'network-unavailable', reason: `gh could not reach GitHub: ${firstLine(said)}`, httpStatus }
    }
    if (httpStatus !== null) {
      return { ok: false, kind: 'fetch-failed', reason: `the endpoint returned HTTP ${httpStatus}`, httpStatus }
    }
    return { ok: false, kind: 'fetch-failed', reason: firstLine(said) || 'gh failed without saying why', httpStatus: null }
  }
}

/**
 * Ask `gh` for the repository's SPDX document.
 *
 * The only part of this module that touches the network, and it is reached only
 * when a caller does not inject a fetcher of its own.
 */
export const ghSbomFetcher: GithubSbomFetcher = async (repo) => {
  const path = `repos/${repo.owner}/${repo.name}/dependency-graph/sbom`
  const attempt = await ghApi(path)
  if (attempt.ok) {
    try {
      return { ok: true, body: JSON.parse(attempt.stdout) }
    } catch (e) {
      return {
        ok: false,
        status: 'fetch-failed',
        reason: `gh returned output that is not JSON: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }
  if (attempt.httpStatus !== 403 && attempt.httpStatus !== 404) {
    return { ok: false, status: attempt.kind, reason: attempt.reason }
  }

  // 403 and 404 are one answer for two very different states: a repository this
  // token cannot see, and a repository it can see whose dependency graph is off.
  // Only a second call tells them apart, and naming either one without asking
  // would put a diagnosis in the record that was never checked.
  const probe = await ghApi(`repos/${repo.owner}/${repo.name}`)
  if (probe.ok) {
    return {
      ok: false,
      status: 'dependency-graph-unavailable',
      reason: `the repository is visible to this token, but its dependency graph endpoint returned HTTP ${attempt.httpStatus}: the dependency graph is off for it, or this token may not read it`,
    }
  }
  if (probe.httpStatus === 404) {
    return {
      ok: false,
      status: 'repo-not-visible',
      reason: 'the repository endpoint returned HTTP 404: it is private to this token, or it is not there',
    }
  }
  if (probe.kind !== 'fetch-failed') return { ok: false, status: probe.kind, reason: probe.reason }
  return {
    ok: false,
    status: 'repo-or-graph-not-visible',
    reason: `the dependency graph endpoint returned HTTP ${attempt.httpStatus}, and the repository endpoint could not be reached to tell a repository this token cannot see from one whose dependency graph is off (${probe.reason})`,
  }
}

// ------------------------------------------------------------ the comparison

/** The one sentence every non-comparison has to carry. An unrun cross-check
 *  must never be readable as agreement, and this is the words that say so. */
const EFFECT_NO_COMPARISON =
  'no second reading was obtained, so nothing here says the two bills of materials agree; the local reading stands alone'

function noComparison(
  status: CrossCheckStatus,
  reason: string,
  sbom: Sbom,
  refs: RefComparison,
  repository: ResolvedRepo | null,
  notes: string[],
): CrossCheck {
  return {
    status,
    reason,
    effect: EFFECT_NO_COMPARISON,
    source: null,
    repository,
    refs,
    // Null, never an empty BomComparison. A caller that renders a diff cannot
    // accidentally render this one as "no differences" -- there is no diff to
    // render, and reaching for one is a type error rather than a wrong report.
    comparison: null,
    local: { status: sbom.status, transitiveClosure: sbom.transitiveClosure, entries: sbom.entries.length },
    notes,
  }
}

/** Distinct, order preserved. */
function distinctBy<T>(xs: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const x of xs) {
    const k = key(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

/**
 * Requirement 3 in one function: a range on either side is never a difference.
 *
 * Nothing here decides whether a locked version satisfies a range. That needs a
 * semver implementation, and answering "satisfied" without one would be the
 * same class of invention this module exists to avoid. Not comparable is the
 * honest answer, and both claims travel with it so a reader can look.
 */
function compareVersions(localVersions: readonly VersionClaim[], githubVersions: readonly VersionClaim[]): VersionAgreement {
  if (localVersions.length === 0 || githubVersions.length === 0) return 'not-comparable-absent'
  const lockedLocal = localVersions.filter((v) => v.kind === 'locked')
  const lockedGithub = githubVersions.filter((v) => v.kind === 'locked')
  if (lockedLocal.length !== localVersions.length || lockedGithub.length !== githubVersions.length) return 'not-comparable-range'
  const l = new Set(lockedLocal.map((v) => v.value))
  const g = new Set(lockedGithub.map((v) => v.value))
  if (l.size === g.size && [...l].every((v) => g.has(v))) return 'same'
  return 'differs'
}

/** Requirement 4: two claims, no winner. A side claiming several different
 *  licences for one name is ambiguous rather than compared -- choosing which of
 *  ours to hold up against theirs would be inventing the comparison. */
function compareLicenses(localLicenses: readonly string[], githubLicenses: readonly string[]): LicenseAgreement {
  if (localLicenses.length === 0 && githubLicenses.length === 0) return 'both-unknown'
  if (githubLicenses.length === 0) return 'only-local'
  if (localLicenses.length === 0) return 'only-github'
  if (localLicenses.length > 1 || githubLicenses.length > 1) return 'ambiguous'
  return localLicenses[0] === githubLicenses[0] ? 'agree' : 'disagree'
}

/**
 * Requirement 1 in one function.
 *
 * The strongest thing this can say is 'same-ref-clean': the branch is the one
 * GitHub's document names, no manifest or lockfile feeding this BOM differs
 * from HEAD, and nothing is sitting unpushed. Everything weaker sets
 * `differencesExplainedByRef`, so a caller cannot present a working-tree
 * difference as a defect without ignoring a field that says otherwise.
 */
function relateRefs(local: LocalRef, github: GithubRef): RefComparison {
  const mk = (relation: RefRelation, relationReason: string): RefComparison => ({
    local,
    github,
    relation,
    relationReason,
    differencesExplainedByRef: relation !== 'same-ref-clean',
  })
  if (!local.read) {
    return mk('ref-unknown', `the working tree's ref could not be read (${local.reason ?? 'no reason recorded'}), so the two sides cannot be said to describe the same content`)
  }
  if (local.detached) {
    return mk('ref-unknown', 'this checkout is on a detached HEAD, so there is no branch name to relate to the ref GitHub read')
  }
  if (github.ref === null) {
    return mk('ref-unknown', "GitHub's document does not name the ref it describes, so the two sides cannot be said to describe the same content")
  }
  if (local.branch === null) {
    return mk('ref-unknown', 'this checkout has no branch name, so the two sides cannot be said to describe the same content')
  }
  if (local.branch !== github.ref) {
    return mk('different-ref', `this working tree is on ${local.branch} and GitHub's document describes ${github.ref}: the two are reading different content, and every difference below follows from that rather than from a defect`)
  }
  if (local.dirtyBomInputs.length > 0) {
    return mk('same-ref-dirty-working-tree', `both sides name ${github.ref}, but ${local.dirtyBomInputs.length} of this BOM's own inputs differ from HEAD in the working tree (${local.dirtyBomInputs.join(', ')}), so the local reading is of content GitHub has never seen`)
  }
  if (local.ahead !== null && local.ahead > 0) {
    return mk('same-ref-unpushed-commits', `both sides name ${github.ref}, and this branch is ${local.ahead} commit(s) ahead of ${local.upstream ?? 'its upstream'}, so GitHub has not seen the commits this reading is of`)
  }
  // Checked AFTER ahead, so a branch that has diverged is reported by the half
  // that is this checkout's own doing. Checked at all because a fetched-and-not-
  // pulled checkout is the ordinary state of any repository left alone for a
  // day, and calling it clean turned somebody else's commit into a finding
  // against this tool.
  if (local.behind !== null && local.behind > 0) {
    return mk('same-ref-behind-upstream', `both sides name ${github.ref}, but this checkout is ${local.behind} commit(s) behind ${local.upstream ?? 'its upstream'}, so GitHub's document may describe content this working tree does not have yet`)
  }
  return mk(
    'same-ref-clean',
    local.ahead === null
      ? `both sides name ${github.ref} and no input to this BOM differs from HEAD; this branch has no upstream, so whether GitHub has this commit is not something git could confirm here`
      : `both sides name ${github.ref}, no input to this BOM differs from HEAD, and nothing is unpushed or unpulled`,
  )
}

/**
 * Hold the two bills of materials side by side.
 *
 * OPT-IN. Nothing calls this unless a caller asks for it, and `readSbom` above
 * still needs no network at all -- the local report is unchanged by this file
 * growing a second source.
 *
 * The result never claims agreement it did not check. When anything at all
 * prevented the second reading -- no gh, no authentication, no remote, a remote
 * that is not GitHub, a repository the token cannot see, a dependency graph
 * that is off, no network, or a response in a shape this module does not
 * recognise -- `status` names it, `reason` says what happened, `effect` says
 * what the reader therefore cannot conclude, and `comparison` is null rather
 * than an empty diff that would read as "no differences".
 */
export async function crossCheckWithGithub(
  sbom: Sbom,
  options: { git?: GitRunner; fetchSbom?: GithubSbomFetcher } = {},
): Promise<CrossCheck> {
  const git = options.git ?? defaultGit(sbom.root)
  const fetchSbom = options.fetchSbom ?? ghSbomFetcher
  const notes: string[] = []

  const local = readLocalRef(sbom, git)
  const unknownRefs: RefComparison = {
    local,
    github: null,
    relation: 'ref-unknown',
    relationReason: 'the second reading was never obtained, so there is no ref on the other side to relate this one to',
    differencesExplainedByRef: true,
  }

  const remotes = git(['remote', '-v'])
  if (!remotes.ok) {
    return noComparison('not-a-git-repository', `git could not list remotes here: ${remotes.reason}`, sbom, unknownRefs, null, notes)
  }
  const seen = parseRemotes(remotes.stdout)
  if (seen.length === 0) {
    return noComparison('no-remote', 'this checkout has no git remote, so there is no repository on GitHub to compare it with', sbom, unknownRefs, null, notes)
  }

  // `origin` by preference, every remote reported either way. A fork has
  // `origin` on the fork and `upstream` on what it was forked from; GitHub's
  // dependency graph for a fork is the fork's, so `origin` is the right
  // comparison -- but the reader has to be able to see that the other remote
  // exists and was not the thing compared.
  const chosen = seen.find((r) => r.name === 'origin') ?? [...seen].sort((a, b) => a.name.localeCompare(b.name))[0]!
  if (seen.length > 1) {
    notes.push(
      `this checkout has ${seen.length} remotes (${seen.map((r) => r.name).join(', ')}); only ${chosen.name} was compared, ` +
        'so if this is a fork, what it was forked from is not what this read',
    )
  }

  const parsed = parseGitRemoteUrl(chosen.url)
  if (!parsed) {
    return noComparison('remote-unparseable', `the ${chosen.name} remote is not a URL this module can turn into an owner and a repository name`, sbom, unknownRefs, null, notes)
  }
  const repository: ResolvedRepo = {
    host: parsed.host,
    owner: parsed.owner,
    name: parsed.name,
    remote: chosen.name,
    url: parsed.url,
    remotesSeen: seen.map((r) => ({ name: r.name, url: parseGitRemoteUrl(r.url)?.url ?? '(not a URL this module parses)' })),
  }

  const host = parsed.host.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') {
    return noComparison(
      'remote-not-github',
      `the ${chosen.name} remote points at ${parsed.host}, and this cross-check only speaks to github.com; ` +
        'an ssh config alias for github.com looks exactly like this from here and cannot be told apart without resolving it',
      sbom, unknownRefs, repository, notes,
    )
  }

  const got = await fetchSbom(repository)
  if (!got.ok) return noComparison(got.status, got.reason, sbom, unknownRefs, repository, notes)

  const doc = readGithubSbomDocument(got.body)
  if (!doc.ok) {
    return noComparison('unexpected-response', `GitHub answered, but the response is not a document this module recognises: ${doc.reason}`, sbom, unknownRefs, repository, notes)
  }

  // ------------------------------------------------------------ requirement 1
  const refs = relateRefs(local, doc.ref)
  if (doc.ref.repository !== null && doc.ref.repository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()) {
    notes.push(
      `the document GitHub returned describes ${doc.ref.repository}, not the ${repository.owner}/${repository.name} that was asked for; ` +
        'a renamed or redirected repository lands here, and everything below is a comparison against what was returned',
    )
  }
  notes.push(
    "GitHub builds this graph from the repository's default branch and rebuilds it on push, so it can lag; " +
      'nothing here verifies their document against the commit this working tree is on',
  )

  // ------------------------------------------------------------ requirement 2
  // Grouped by ecosystem AND name. Name alone would put a GitHub Actions
  // dependency and an npm package of the same name in one row and compare their
  // versions, which is two unrelated things reported as one disagreement.
  const keyOf = (ecosystem: string, name: string) => `${ecosystem} ${name}`
  const byKey = new Map<string, PackageComparison>()

  const localByKey = new Map<string, BomEntry[]>()
  for (const e of sbom.entries) {
    const k = keyOf(e.ecosystem, e.name)
    const l = localByKey.get(k)
    if (l) l.push(e)
    else localByKey.set(k, [e])
  }
  const githubByKey = new Map<string, GithubPackage[]>()
  for (const p of doc.packages) {
    const k = keyOf(p.ecosystem, p.name)
    const l = githubByKey.get(k)
    if (l) l.push(p)
    else githubByKey.set(k, [p])
  }

  const sideOfLocal = (es: readonly BomEntry[]): SideOfComparison => ({
    versions: distinctBy(
      es.filter((e) => e.version !== null).map((e) => ({ value: e.version!, kind: e.versionKind })),
      (v) => `${v.value} ${v.kind}`,
    ),
    copies: es.length,
    licenses: [...new Set(es.map((e) => e.license).filter((x): x is string => typeof x === 'string' && x !== ''))].sort(),
  })
  const sideOfGithub = (ps: readonly GithubPackage[]): SideOfComparison => ({
    versions: distinctBy(
      ps.filter((p) => p.version !== null && p.versionKind !== null).map((p) => ({ value: p.version!, kind: p.versionKind! })),
      (v) => `${v.value} ${v.kind}`,
    ),
    copies: ps.length,
    licenses: [...new Set(ps.map((p) => p.license).filter((x): x is string => typeof x === 'string' && x !== ''))].sort(),
  })

  for (const [k, es] of localByKey) {
    const first = es[0]!
    byKey.set(k, {
      name: first.name,
      ecosystem: first.ecosystem,
      presence: 'only-local',
      presenceReason: 'absent-from-github-document',
      local: sideOfLocal(es),
      github: null,
      version: 'not-applicable',
      license: 'not-applicable',
    })
  }

  for (const [k, ps] of githubByKey) {
    const first = ps[0]!
    const existing = byKey.get(k)
    if (existing && !first.isRepositorySelf) {
      existing.presence = 'both'
      existing.presenceReason = 'in-both'
      existing.github = sideOfGithub(ps)
      continue
    }
    byKey.set(k, {
      name: first.name,
      ecosystem: first.ecosystem,
      presence: 'only-github',
      presenceReason: first.isRepositorySelf
        ? 'repository-self'
        // Requirement 2, and the reason this is a named reason and not a
        // boolean: a package present only on GitHub in an ecosystem this module
        // never reads is not a miss. Calling it one reports every GitHub Actions
        // step as a dependency the local reading lost.
        : READ_ECOSYSTEMS.has(first.ecosystem)
          ? 'absent-from-local-bom'
          : 'ecosystem-not-read-locally',
      local: existing?.local ?? null,
      github: sideOfGithub(ps),
      version: 'not-applicable',
      license: 'not-applicable',
    })
  }

  // ---------------------------------------------------- requirements 3 and 4
  for (const c of byKey.values()) {
    if (c.presence !== 'both' || c.local === null || c.github === null) continue
    c.version = compareVersions(c.local.versions, c.github.versions)
    c.license = compareLicenses(c.local.licenses, c.github.licenses)
  }

  const packages = [...byKey.values()].sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name))
  const licenseDisagreements: LicenseDisagreement[] = packages
    .filter((c) => c.license === 'disagree')
    .map((c) => ({
      name: c.name,
      ecosystem: c.ecosystem,
      local: c.local === null ? [] : c.local.licenses,
      localSource: 'lockfile-license-field' as const,
      github: c.github === null ? [] : c.github.licenses,
      githubSource: 'github-dependency-graph-licenseConcluded' as const,
    }))
  if (licenseDisagreements.length > 0) {
    notes.push(
      'licence values are compared as exact strings, and neither side is authoritative: ' +
        "npm's is the publisher's own claim copied into the lockfile, GitHub's is their concluded value. " +
        'No SPDX expression is normalised, so two expressions meaning the same thing in different words appear here as a disagreement',
    )
  }

  const comparison: BomComparison = {
    ecosystemsCompared: [...new Set(packages.filter((c) => c.presence === 'both').map((c) => c.ecosystem))].sort(),
    packages,
    licenseDisagreements,
    counts: {
      bothSides: packages.filter((c) => c.presence === 'both').length,
      onlyLocal: packages.filter((c) => c.presence === 'only-local').length,
      onlyGithubInReadEcosystem: packages.filter((c) => c.presenceReason === 'absent-from-local-bom').length,
      onlyGithubOutOfScope: packages.filter((c) => c.presenceReason === 'ecosystem-not-read-locally').length,
      versionSame: packages.filter((c) => c.version === 'same').length,
      versionDiffers: packages.filter((c) => c.version === 'differs').length,
      versionNotComparable: packages.filter((c) => c.version === 'not-comparable-range' || c.version === 'not-comparable-absent').length,
      licenseAgree: packages.filter((c) => c.license === 'agree').length,
      licenseDisagree: licenseDisagreements.length,
      licenseOneSided: packages.filter((c) => c.license === 'only-local' || c.license === 'only-github').length,
      licenseBothUnknown: packages.filter((c) => c.license === 'both-unknown').length,
    },
  }

  if (sbom.status !== 'ok') {
    notes.push(
      `the local reading returned status ${sbom.status} (${sbom.reason ?? 'no reason recorded'}), ` +
        'so a package present only on GitHub here says more about what was read locally than about the repository',
    )
  } else if (sbom.transitiveClosure !== 'from-lockfiles') {
    notes.push(
      `the local side is ${sbom.transitiveClosure === 'absent' ? 'a direct-dependency list, not a closure' : 'only partly a closure'}, ` +
        'so a package present only on GitHub may be one the local reading was never in a position to see',
    )
  }

  return {
    status: 'compared',
    reason: `compared the working tree against GitHub's dependency graph for ${repository.owner}/${repository.name}`,
    // Three states, not two. `ref-unknown` shares differencesExplainedByRef with
    // `different-ref` but not its evidence: one KNOWS the two sides read
    // different content, the other could not tell -- and this string is written
    // to be printed verbatim, so it must not assert the stronger of the two.
    // relationReason on the same object already said "cannot be said to";
    // asserting "do not" three fields away had the object contradicting itself.
    effect:
      refs.relation === 'ref-unknown'
        ? 'whether the two sides describe the same content could not be determined here, so a difference below is neither accounted for nor unaccounted for'
        : refs.differencesExplainedByRef
          ? 'the two sides do not describe the same content, so a difference below is accounted for by that alone and none of it is a defect'
          : 'the two sides describe the same ref with nothing uncommitted, unpushed or unpulled, so a difference below is not accounted for by the ref',
    source: { tool: 'gh', endpoint: `repos/${repository.owner}/${repository.name}/dependency-graph/sbom` },
    repository,
    refs,
    comparison,
    local: { status: sbom.status, transitiveClosure: sbom.transitiveClosure, entries: sbom.entries.length },
    notes,
  }
}
