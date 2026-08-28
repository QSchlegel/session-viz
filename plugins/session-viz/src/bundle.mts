/**
 * The evidence package: one downloadable file that says what a coding-agent
 * session did, and — louder — what it does not say.
 *
 * A report page answers the question while the tab is open. Someone eventually
 * has to answer it to an auditor, a client or their own risk function, on a
 * ticket, months later. That answer cannot be a browser tab. This turns the
 * measured spine into a zip they can attach, retain and hand over.
 *
 * IT IS EVIDENCE, NOT A CERTIFICATION. Nothing in this module states or implies
 * that holding the package makes anybody compliant with anything, and no
 * framework is named anywhere in what it writes. The register is "a record of
 * what ran, in a form you can hand to someone who asks". If a sentence here
 * ever starts to read as a conformance claim, the idea is wrong, not the
 * wording.
 *
 * Three constraints shape every decision below.
 *
 * NO NETWORK. The page is opened from file://. The zip is assembled in the
 * browser out of bytes already embedded in the document — a Blob and an
 * `<a download>`. Nothing is fetched.
 *
 * HASHES ARE COMPUTED HERE, IN NODE. `crypto.subtle` is absent or inconsistent
 * on a file:// origin, and a manifest whose integrity check silently did not
 * run is worse than no manifest at all. Every member's bytes are known at
 * render time, so they are hashed at render time and the digests are embedded.
 * The members travel to the browser as base64 precisely so that there is no
 * re-encoding step between the bytes that were hashed and the bytes that get
 * written: `atob` reverses to the same octets, byte for byte.
 *
 * DETERMINISTIC. Same input, byte-identical output, so two people can diff two
 * bundles. Member order is fixed, every map is emitted in sorted order, and the
 * only clock reading anywhere is the single `generatedAt` that is passed in.
 */

import crypto from 'node:crypto'
import { version as pluginVersion } from './version.mjs'
import { jsonForScript } from './html.mjs'
import type { Session, SessionTurn } from './extract.mjs'

// The browser globals the assembler touches. Declared here because this module
// compiles against an ES2023 lib with no DOM: it runs in Node and only
// SERIALISES the function, so these names exist solely to type it. They are
// erased at compile time and resolve to real globals in the page.
declare const document: {
  addEventListener(type: string, fn: (ev: BrowserClick) => void): void
  createElement(tag: string): { href: string; download: string; rel: string; click(): void }
  body: { appendChild(node: unknown): void; removeChild(node: unknown): void }
}
declare const window: Record<string, unknown>
interface BrowserClick {
  target: { closest?(selector: string): unknown } | null
  preventDefault(): void
}

// ---------------------------------------------------------------- the contract

/** The property the assembler hangs its API off, on `window`. */
export const BUNDLE_GLOBAL = '__qevidence'

/** Any element carrying this attribute downloads the bundle when clicked. The
 *  listener is delegated from `document`, so the markup may be rendered, moved
 *  or replaced at any time without re-binding. */
export const DOWNLOAD_HOOK = 'data-evidence-download'

/**
 * The sentence that has to survive every rewrite of this file.
 *
 * Kept as a constant rather than inlined into the templates because it appears
 * in three members and on the page, and three copies of a claim are three
 * chances for one of them to drift into something stronger.
 */
export const NOT_A_CERTIFICATION =
  'This package is a record of what one coding-agent session did, read out of that ' +
  "session's own transcript. It is evidence, not a certification: it does not assess, " +
  'certify or attest anything, and holding it does not make anyone compliant with any ' +
  'framework, standard or regulation.'

/**
 * What the record cannot show.
 *
 * This is the part that makes the package worth anything. A bundle that omits
 * its own limits invites the reader to treat silence as absence — to conclude
 * that no file was changed because no file is named, or that nothing went wrong
 * in a turn because nothing is recorded against it. Every entry below names a
 * thing the spine genuinely does not hold, and each one is checked against
 * extract.mts rather than imagined.
 *
 * Exported so the page can print the same list beside the download button. The
 * reader should know what they are getting BEFORE they attach it to a ticket.
 */
/**
 * What this package can say about redaction, which depends on how the EXTRACTOR
 * was invoked and not on anything this file can see.
 *
 * The first version of this list asserted "prompt text is redacted for secrets"
 * flatly. `extract.mjs --no-redact` exists, so that sentence could sit at the
 * top of a package whose session.json carried an API key verbatim -- an
 * evidence file making a safety claim it had no way to check, which is the one
 * defect this whole package is written against. The extractor records what it
 * did; this reads that record, and when there is no record it says so instead
 * of guessing in the reassuring direction.
 */
export const redactionLimit = (session: { redactedPrompts?: boolean }): string => {
  if (session.redactedPrompts === true)
    return (
      'Prompt text was passed through the secret patterns before it was stored: a fixed ' +
      'table of credential formats. A secret in a shape no pattern covers is still here ' +
      'verbatim, and a harmless string that merely resembles one has been replaced. ' +
      'Neither case is flagged.'
    )
  if (session.redactedPrompts === false)
    return (
      'PROMPT TEXT WAS NOT REDACTED. This reading was extracted with --no-redact, so the ' +
      'secret patterns were never applied and every prompt is here exactly as it was ' +
      'typed, including any credential that was pasted into one. Treat this package as ' +
      'carrying secrets until someone has read it.'
    )
  return (
    'WHETHER PROMPT TEXT WAS REDACTED IS UNKNOWN. This reading predates the field that ' +
    'records it, so nothing in the package can tell you whether the secret patterns were ' +
    'applied. Treat the prompts as unredacted, which is the assumption that is safe to be ' +
    'wrong about.'
  )
}

/** The parts of a spine the path sentence is derived from. Wider than `Session`
 *  on purpose: an older reading has neither field, and this has to be able to
 *  say so rather than crash or guess. */
export interface PathSource {
  recordedPaths?: boolean
  turns?: { files?: { path: string; count: number }[] }[]
  artifacts?: { fileTouches?: number }
}

// Counted the way every other member of this package counts, which is DISTINCT
// paths after the guard, not entries. A file touched by two turns is two entries
// and one path; summing entries gave LIMITS.txt -- the member a reader is told to
// open first -- a number that summary.md and artifacts.csv both disagreed with.
const pathsPresent = (session: PathSource): number =>
  new Set((session.turns ?? []).flatMap((t) => t.files ?? []).map((f) => safePath(f.path))).size

/**
 * What this package can say about file paths, which -- like redaction -- depends
 * on how the EXTRACTOR was invoked and not on anything this file can see.
 *
 * This list used to state flatly that no file path was recorded as data. That
 * was true when it was written and stopped being true the day the spine started
 * keeping them, and a package that reassures a reader about what it does not
 * contain, over the top of a list of the files somebody's session touched, is
 * the worst defect this format can ship. So the sentence is derived from the
 * reading, in all four states it can actually be in: recorded, refused,
 * unknown-and-empty, and unknown-but-visibly-present.
 *
 * The last of those is why this counts rather than trusting the flag alone.
 * "Unknown" is the honest answer when the field is missing AND there is nothing
 * to see; printed above forty paths it would be its own kind of lie.
 */
export const pathLimit = (session: PathSource): string => {
  const shown = pathsPresent(session)
  if (session.recordedPaths === true)
    return (
      'FILE PATHS ARE RECORDED. Each turn below carries the files named by the file-path ' +
      'input of its tool calls, under `files`, with a count of how many calls named each ' +
      'one. A path is stored relative to the working directory the session ran in -- a file ' +
      'outside it reads `../`, and one this package could not make relative is withheld ' +
      'whole rather than trimmed. Three things this is not. A file named only inside a shell ' +
      'command is not here: nothing reads paths out of command text, so a session that did ' +
      'its work through the shell can show few files or none. A touch is a tool call naming ' +
      'the file, so it does not say whether the file was read or written, or that anything ' +
      'in it changed. And tool calls made before the first human turn belong to no turn, and ' +
      'are counted in the file-touch total while appearing against no turn -- so that total ' +
      'is not a sum of what is listed. One further caution: a relative path cannot carry a ' +
      'home directory, but it can still carry a person\'s name where the name is part of a ' +
      'FILENAME rather than of the route to it. Nothing removes that, because no rule that ' +
      'finds it leaves an ordinary file called users-list.ts alone.'
    )
  if (session.recordedPaths === false)
    return (
      'FILE PATHS WERE NOT RECORDED. This reading was extracted with --no-paths, so the ' +
      'file-touch count says THAT a file was touched and nothing here says which. Prompt ' +
      'text is the exception and is not a field: it holds whatever the person typed, which ' +
      'routinely includes paths and sometimes whole diffs.'
    )
  if (shown > 0)
    return (
      `WHETHER FILE PATHS WERE RECORDED IS UNKNOWN, BUT ${shown} DISTINCT PATH(S) ARE HERE. This reading ` +
      'predates the field that records it, so nothing states whether paths were kept -- and ' +
      'the turns below carry them anyway. Read them as present but not as complete: there ' +
      'is no way from here to tell whether every file this session touched is among them.'
    )
  return (
    'WHETHER FILE PATHS WERE RECORDED IS UNKNOWN. This reading predates the field that ' +
    'records it, and no turn carries one. That is what a reading with paths turned off ' +
    'looks like and also what a reading from before paths existed looks like, and nothing ' +
    'here distinguishes them. Do not read the absence as evidence that no file was touched ' +
    '-- the file-touch count above is the number of tool calls that named one.'
  )
}

/** The limits that are properties of this format, in every package. */
export const LIMITS: readonly string[] = [
  'Prompt text is truncated. Each turn stores at most the first few thousand characters; ' +
    "the `prompt_chars` column and the turn's `fullChars` field give the length before " +
    'truncation, so a stored prompt shorter than that number is a fragment.',

  'This package additionally rewrites home-directory paths and email-shaped strings in ' +
    'every field before writing them, so prompt text here can differ from the page it was ' +
    'generated from. The page is the unrewritten form. Prompt text is also where a path ' +
    'arrives that no field of this reading holds: it is whatever the person typed, which ' +
    'routinely includes absolute paths and sometimes whole diffs, and home directories in ' +
    'it are rewritten to ~ but nothing else is.',

  'No file contents are recorded. Not what the agent read, not what it wrote, not a diff, ' +
    'not a line count. Nothing here can show what changed in the codebase.',

  // What used to stand here -- "No file path is recorded AS DATA. ... WHICH file
  // was touched is not captured by any tool-call field" -- is now pathLimit(),
  // because it stopped being a property of the format the day the spine started
  // keeping paths. It depends on how the extractor was invoked, exactly as
  // redaction does, and a constant cannot tell the difference. The one part of
  // it that is still true whatever the extractor did -- that prompt text carries
  // paths of its own -- moved up into the rewriting limit above, where the rest
  // of what this package does to prompt text already lives.

  // A branch name is evidence worth keeping, and it is also a place people put
  // their own names. Disclosed rather than mangled: withholding it would cost
  // the reader the one label that ties the record to a change.
  'The git branch name is kept verbatim. Teams commonly name branches after the person ' +
    'working on them, so this field may carry somebody\'s name even though the account ' +
    'name in paths has been rewritten. It is kept because a record that cannot say which ' +
    'branch it describes is hard to act on.',

  'Packages, CLI tools, stack files, extensions, skills and MCP servers are counted per ' +
    'session, not per turn. They carry no time and cannot be placed in one: a count of ' +
    'three does not say which three turns, or in what order.',

  'Tool calls are counted by name, per turn. Their inputs, their outputs and whether they ' +
    'succeeded are not recorded. A tool that ran and failed is indistinguishable here from ' +
    'one that ran and worked.',

  'An interruption is a count on a turn, not a point inside it. Which tool call it landed ' +
    'on is not recorded.',

  'A repeat points at the FIRST identical prompt, not the previous one. It is a star, not ' +
    'a chain, and the count of repeats is not a count of attempts.',

  'The score is a heuristic over signals visible in the transcript, not a measure of ' +
    'whether the work was correct. Each adjustment carries a tier: `outcome` was witnessed ' +
    'in the transcript, `form` was guessed from the shape of the prompt text. Nothing here ' +
    'inspects the resulting code.',

  'Sub-agent (sidechain) records are counted but not expanded. What a sub-agent did is not ' +
    'in this package.',

  "The transcript is the agent harness's own log of itself. Nothing here is independently " +
    'witnessed, and a transcript that was truncated, rotated or edited before it was read ' +
    'produces a record that still looks complete.',

  'The digests in manifest.json were computed when this package was generated. They show ' +
    'that a member has not been altered since. They say nothing about whether the ' +
    'transcript they were computed from was accurate.',

  'A model-written summary, when present as intent.json, is a language model describing ' +
    'its own session. It is not a measurement and no part of it was verified.',
]

/** One file inside the zip, with everything needed to write and check it. */
export interface BundleMember {
  /** Path inside the zip. ASCII, flat (no directories), stable across builds. */
  name: string
  mediaType: string
  /** UTF-8 text of the member. */
  text: string
  /** The exact octets that get written, and that `sha256` was taken over. */
  bytes: Uint8Array
  /** Those same octets, as the browser receives them. */
  base64: string
  size: number
  sha256: string
  crc32: number
}

export interface EvidenceBundle {
  /** Suggested download name. Deterministic; carries the source fingerprint. */
  filename: string
  generatedAt: string
  /** In zip order. manifest.json is first so an unzip lists it first. */
  members: BundleMember[]
  /** Byte length of the assembled zip, computed from the format's fixed
   *  overheads rather than by assembling one — see `predictZipSize`. */
  zipSize: number
  /** The same sentences as LIMITS.txt, for the page to print. */
  limits: readonly string[]
}

export interface BundleMeta {
  /**
   * The one clock reading in the package.
   *
   * Defaults to now, because a bundle is a record of a render and a render
   * happens at a moment. Pass it explicitly to make two runs over the same
   * spine produce byte-identical files — everything else here is a pure
   * function of the spine, so this is the only thing that moves.
   */
  generatedAt?: string
  /** The renderer's content hash over spine + intent + build. Recorded so a
   *  bundle can be tied back to the page it came from. */
  fingerprint?: string
  /** Defaults to this build's version, the same one the page footer prints. */
  version?: string
  /** Which command produced it, e.g. '/qpact'. */
  command?: string
  /** How old the spine was when the page rendered. */
  spineAgeMin?: number
}

/** The optional model-written intent file, as far as this module reads it.
 *  Structurally the renderer's own `Intent`, so its value passes straight in. */
export interface BundleIntent {
  tldr?: string
  compactInstruction?: string
  intents?: { title?: string; status?: string; summary?: string; turns?: number[] }[]
  quality?: { verdict?: string; strengths?: string[]; weaknesses?: string[]; recommendations?: string[] }
  sessionId?: string
}

// ---------------------------------------------------------------- integrity

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

/** CRC-32 (IEEE, the one zip uses). Exported so the test can recompute it over
 *  the bytes it reads back out of the archive rather than trusting the header. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const sha256 = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex')

/**
 * MS-DOS date and time, from the generation stamp.
 *
 * Zip entries carry a modification time in the 1980 DOS format, and it is part
 * of the header bytes — so it has to be deterministic or two bundles of the
 * same session differ. Derived from `generatedAt` in UTC: reading local fields
 * would make the archive depend on the machine's timezone. Unzip tools display
 * DOS times as local, so a listing will show an offset from the stamp in the
 * manifest; the manifest is the authority, and says so.
 */
function dosStamp(iso: string): { time: number; date: number } {
  const d = new Date(iso)
  // Before 1980 is unrepresentable, and an unparseable stamp must not produce
  // header bytes made of NaN. Both floor to the format's own epoch.
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

/**
 * The size of the archive the assembler will write.
 *
 * Arithmetic over the format's fixed overheads — 30 bytes plus the name for
 * each local header, 46 plus the name for each central directory entry, 22 for
 * the end record — and NOT a second implementation of the writer. That is the
 * point: the test asserts the assembled blob is exactly this long, so a wrong
 * header width in the browser code fails against an independent number instead
 * of against a copy of itself.
 *
 * The size and offset fields are 32 bits, so this format tops out at 4 GiB
 * without ZIP64. There is no guard because there is no path to it: every member
 * is built by serialising a JavaScript string, and Node's own string ceiling
 * sits an order of magnitude below the zip's. A spine that large fails in
 * JSON.stringify long before it reaches here.
 */
function predictZipSize(members: BundleMember[]): number {
  let n = 22
  for (const m of members) n += 30 + m.name.length + m.size + 46 + m.name.length
  return n
}

// ---------------------------------------------------------------- scrubbing

/**
 * Home-directory paths and email addresses, removed.
 *
 * An evidence package is made to be forwarded. The spine holds the transcript
 * path, the working directory and the harness's project key — and a Claude Code
 * project key is the working directory with the slashes turned into dashes, so
 * it carries the account name of whoever ran the session. Verbatim prompt text
 * carries whatever the person typed, which is routinely a path out of their
 * home directory.
 *
 * The rewrite is deliberately shallow and deliberately visible: `~` for a home
 * root, a marker for an address. It is listed in LIMITS so nobody compares this
 * text against the page and concludes the page was tampered with.
 */
const HOME_UNIX = /\/(?:Users|home)\/[^/\s"'`)\]},:;]+/g
// The dash-encoded form, withheld WHOLE rather than trimmed.
//
// A Claude Code project key is the working directory with its slashes turned
// into dashes, which the docblock above names as the reason this function
// exists -- and it was the one shape the patterns did not match, so
// `-Users-someone-git-api` travelled through titles and prompts untouched.
//
// It cannot be cut precisely, and trying is worse than not trying: the account
// name is itself dash-separated, so a pattern that stops at the first dash turns
// `-Users-fixture-user-two-git-api` into `~-user-two-git-api`, which both leaks
// half the name and corrupts the rest. There is no way to tell where the account
// ends and the path begins, so the whole run goes -- the same fail-closed rule
// the project field already used, now applied everywhere the shape appears.
const HOME_DASH = /-(?:Users|home)-[A-Za-z0-9._-]*/g
const HOME_WIN = /[A-Za-z]:\\Users\\[^\\\s"'`)\]},:;]+/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

/**
 * Deep, and total.
 *
 * The first version took a string, because the spine's type said `origin` was
 * one. It is `{ kind: 'human' }` in every real transcript, so /qpact crashed on
 * the first session anyone pointed it at while the fixture -- which used a
 * string, as the type promised -- stayed green. Walking the value means a shape
 * this module has never seen cannot smuggle text past the scrubber either,
 * which is the property that actually matters here.
 */
/** The `kind` off an origin shape, or '' -- never `[object Object]` in a cell. */
const originKind = (o: unknown): string =>
  o && typeof o === 'object' && typeof (o as { kind?: unknown }).kind === 'string'
    ? scrub((o as { kind: string }).kind)
    : typeof o === 'string'
      ? scrub(o)
      : ''

export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrub(value) as unknown as T
  if (Array.isArray(value)) return value.map(scrubDeep) as unknown as T
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubDeep(v)])
    ) as unknown as T
  return value
}

function scrub(value: string): string {
  return value
    .replace(HOME_UNIX, '~')
    .replace(HOME_WIN, '~')
    .replace(HOME_DASH, '«path-withheld»')
    .replace(EMAIL, '«redacted-email»')
}

const scrubOrNull = (v: string | null | undefined): string | null => (v == null ? null : scrub(v))

/** Still looks like a home root after scrubbing, in any of the encodings the
 *  harnesses use. The fail-closed test below. */
const STILL_HOMEY = /(?:^|[/\\-])(?:Users|home)[/\\-]/i

/**
 * A project label that cannot carry an account name.
 *
 * Claude Code names a project by its working directory with `/` replaced by
 * `-`, so `-Users-jane-doe-git-api` is a real project key and the obvious
 * "strip one segment after Users" rule leaks `doe` out of a hyphenated account
 * name. When cwd is available the home prefix is known exactly and can be cut
 * precisely; when it is not, there is no safe boundary to guess at, so the
 * whole label is withheld. Fail closed: a withheld label costs a reader some
 * context, a leaked one cannot be taken back.
 */
function safeProject(project: string, cwd: string | null): string {
  let out = project
  const home = (cwd || '').match(/^\/(Users|home)\/([^/]+)/)
  if (home) {
    const slug = `-${home[1]}-${home[2]!}`
    if (out.startsWith(slug)) out = out.slice(slug.length)
    if (out.startsWith(home[0])) out = out.slice(home[0].length)
  }
  out = scrub(out).replace(/^[-/\\]+/, '')
  return out && !STILL_HOMEY.test(out) ? out : '«path-withheld»'
}

/** The last path segment, which is the repository directory name. Useful, and
 *  not an account name — unless the session ran in the home directory itself,
 *  which the fail-closed check catches. */
function repoLabel(cwd: string | null): string | null {
  if (!cwd) return null
  const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || ''
  const safe = scrub(base)
  return safe && !STILL_HOMEY.test(safe) && safe !== '~' ? safe : null
}

const baseName = (p: string): string => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || ''

/** Still rooted somewhere on a disk after scrubbing: a leading slash, a drive
 *  letter, a UNC share. `~` is not in this set -- it is the marker the scrub
 *  leaves behind, and it names no account. */
const STILL_ROOTED = /^\/|^[A-Za-z]:[\\/]|^\\\\/

/**
 * One recorded file path, as it is allowed to leave in a forwarded package.
 *
 * extract.mts stores paths relative to the session's working directory, which is
 * the form that structurally cannot carry an account name. Its own fallback can
 * still produce an absolute one -- a transcript that never said what directory
 * it ran in has nothing to relativise against -- and this package is made to be
 * forwarded to people who were not there.
 *
 * So the rule safeProject() already uses applies here too: what cannot be shown
 * to be safe is withheld WHOLE. Trimming an absolute path to its tail would hand
 * back a plausible-looking relative path that is not one, and a reader cannot
 * tell the difference. A withheld path costs them a filename; a leaked one
 * cannot be taken back.
 *
 * What it deliberately does NOT do is hunt for `Users` or `home` inside any
 * relative path, the way safeProject() does inside a project key. There the
 * whole string is a home path and the word can only be that; here it is an
 * ordinary directory name -- `app/home/page/index.tsx` is a real file in a great
 * many repositories, and withholding it would gut the feature to catch a shape
 * the extractor cancels. Fail closed on what is genuinely ambiguous, not on
 * every file called home.
 *
 * One relative shape IS genuinely ambiguous and is withheld: a path that CLIMBS
 * out of the working directory and then descends through a `Users` or `home`
 * segment. `../../../../System/Volumes/Data/Users/<name>/.zshrc` is what macOS
 * resolves a home file to, relativised -- relative, and therefore looking safe,
 * with the account name in the middle of it. extract.mts no longer emits that,
 * but a spine written by an older reading of the same transcript does, and this
 * package is the layer that is forwarded. A file INSIDE the tree cannot take
 * this shape, so `app/home/page` never reaches the rule.
 */
function safePath(p: string): string {
  const s = p
    .replace(PATH_HOME_HEAD, '~')
    .replace(PATH_HOME_HEAD_WIN, '~')
    .replace(HOME_DASH, '«path-withheld»')
    .replace(EMAIL, '«redacted-email»')
  return !s || STILL_ROOTED.test(s) || CLIMBS_INTO_HOME.test(s) ? '«path-withheld»' : s
}

/** A `..` climb that lands on somebody's home root. Anchored at the start,
 *  because only a leading climb leaves the tree; `src/../home/page` is still
 *  inside it. */
const CLIMBS_INTO_HOME = /^(?:\.\.[\\/])+(?:.*[\\/])?(?:Users|home)[\\/][^\\/]/i

// The home-root rewrite, ANCHORED, and the reason safePath does not simply call
// scrub().
//
// scrub() is written for prose, where `/home/jane/notes` can only be a home
// directory. A recorded path is not prose. It is relative, and `app/home/page`
// is an ordinary directory in a great many repositories -- the prose rule finds
// `/home/page` in the middle of it and hands back `app~`, quietly renaming a
// file that was never anybody's home. Anchoring is safe here only because it is
// not the whole guard: a home root reached through a mount point sits in the
// MIDDLE of the path, and those arrive absolute and are withheld whole by
// STILL_ROOTED, or climbing and withheld whole by CLIMBS_INTO_HOME.
const PATH_HOME_HEAD = /^\/(?:Users|home)\/[^/]+/
const PATH_HOME_HEAD_WIN = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+/

/** The turn's files, ordered as the spine ordered them, with each path passed
 *  through the same guard. Tolerates a spine that predates the field: absent is
 *  not empty, and the sentence that says which is pathLimit()'s job. */
const safeFiles = (files: { path: string; count: number }[] | undefined): { path: string; count: number }[] =>
  (files ?? []).map((f) => ({ path: safePath(f.path), count: f.count }))

// ---------------------------------------------------------------- text shapes

/** Deterministic key order. `Object.keys` on a Record follows insertion order,
 *  and insertion order comes from whatever the transcript happened to say, so
 *  two readings of the same session can serialise the same map differently. */
const sortedPairs = (m: Record<string, number>): [string, number][] =>
  Object.keys(m)
    .sort()
    .map((k) => [scrub(k), m[k] ?? 0] as [string, number])

/**
 * One CSV cell.
 *
 * RFC 4180 quoting, plus a leading apostrophe on anything a spreadsheet would
 * read as a formula. Tool, package, skill and MCP names are harvested out of
 * tool-call inputs and are not constrained upstream, so a name beginning `=` or
 * `@` reaching Excel is a live cell in a file someone was told to treat as a
 * record. Numbers go through `num`, which does not get the guard, so a negative
 * value stays a negative value.
 */
function cell(v: string): string {
  const guarded = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}
const num = (n: number): string => String(n)
const csv = (rows: string[][]): string => rows.map((r) => r.join(',')).join('\r\n') + '\r\n'

/** Hard-wrap for the plain-text member. Deterministic, and never breaks a word
 *  so a digest or a field name stays greppable. */
function wrap(text: string, width = 78, indent = ''): string {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      out.push(indent + line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(indent + line)
  return out.join('\n')
}

// ---------------------------------------------------------------- members

function sessionJson(session: Session, generatedAt: string): string {
  return (
    JSON.stringify(
      {
        limits:
          'This reading is incomplete by construction. Read LIMITS.txt in the same package ' +
          'before drawing a conclusion from anything below.',
        generatedAt,
        withheld: {
          transcriptPath: 'Not included. `source.transcriptFile` in manifest.json is the file name only.',
          workingDirectory: 'Not included. `repo` below is its last path segment.',
          fileContents: 'Never read by this tool.',
          // Derived, and deliberately still under `withheld` even when the answer
          // is "not withheld at all". This is the key a reader looks up to find
          // out whether paths are here; moving it when the answer changed would
          // leave them looking at a block that no longer mentions the thing they
          // came for, and reading its silence as a no.
          filePaths: pathLimit(session),
        },
        session: {
          sessionId: session.sessionId,
          harness: session.harness,
          project: safeProject(session.project, session.cwd),
          repo: repoLabel(session.cwd),
          gitBranch: scrubOrNull(session.gitBranch),
          harnessVersion: session.version,
          title: scrubOrNull(session.title),
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          durationMs: session.durationMs,
          models: Object.fromEntries(sortedPairs(session.models)),
          slashCommands: [...session.slashCommands].sort(),
          permissionModes: session.permissionModes,
          artifacts: {
            packages: Object.fromEntries(sortedPairs(session.artifacts.packages)),
            tools: Object.fromEntries(sortedPairs(session.artifacts.tools)),
            stack: Object.fromEntries(sortedPairs(session.artifacts.stack)),
            extensions: Object.fromEntries(sortedPairs(session.artifacts.extensions)),
            skills: Object.fromEntries(sortedPairs(session.artifacts.skills)),
            mcp: Object.fromEntries(sortedPairs(session.artifacts.mcp)),
            fileTouches: session.artifacts.fileTouches,
          },
          totals: session.totals,
          score: session.score,
          turns: session.turns.map((t) => ({
            ...t,
            text: scrub(t.text),
            origin: scrubDeep(t.origin),
            // Named rather than left to the spread. `...t` would carry the paths
            // through unguarded, and this is the one field in a turn that is a
            // path by construction rather than by accident.
            files: safeFiles(t.files),
          })),
        },
      },
      null,
      2
    ) + '\n'
  )
}

const TURN_COLUMNS = [
  'turn', 'started_at', 'ended_at', 'duration_ms', 'typed', 'steering', 'origin',
  'model', 'mixed_model', 'assistant_messages', 'subagents', 'tool_calls', 'interruptions',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_create_tokens',
  'prompt_chars', 'prompt_chars_stored', 'terse', 'file_ref', 'code_block', 'url',
  'question', 'correction', 'acceptance_criteria', 'no_tool_calls', 'repeat_of',
  'clarification_roundtrip', 'followed_by_correction', 'friction', 'score',
  'slash_commands', 'tools_by_name', 'files_touched',
]

const bit = (b: boolean): string => (b ? '1' : '0')

/**
 * The spreadsheet member.
 *
 * Prompt text is deliberately NOT a column. It is free text of unbounded length
 * with embedded newlines, it is the one field that carries whatever a person
 * typed, and pasting it into a grid is how a record gets skimmed as though the
 * numbers beside it described it. session.json holds the text; this holds the
 * measurements, one row per turn, in turn order.
 */
function turnsCsv(turns: SessionTurn[]): string {
  const rows = [TURN_COLUMNS]
  for (const t of turns) {
    rows.push([
      num(t.index),
      cell(t.startedAt),
      cell(t.endedAt),
      num(t.durationMs),
      bit(t.typed),
      bit(t.steering),
      // `origin` is a shape, not a string -- {kind:'human'} in every real
      // transcript. A spreadsheet column takes the kind; the whole value is in
      // session.json for anyone who needs it.
      cell(originKind(t.origin)),
      cell(t.model ?? ''),
      bit(t.mixedModel),
      num(t.assistantMessages),
      num(t.subagents),
      num(t.toolCallCount),
      num(t.interruptions),
      num(t.tokens.input),
      num(t.tokens.output),
      num(t.tokens.cacheRead),
      num(t.tokens.cacheCreate),
      num(t.fullChars),
      num(t.text.length),
      bit(t.signals.terse),
      bit(t.signals.hasFileRef),
      bit(t.signals.hasCodeBlock),
      bit(t.signals.hasUrl),
      bit(t.signals.isQuestion),
      bit(t.signals.isCorrection),
      bit(t.signals.hasAcceptanceCriteria),
      bit(t.derived.noToolCalls),
      t.derived.repeatOf === null ? '' : num(t.derived.repeatOf),
      bit(t.derived.clarificationRoundtrip),
      bit(t.derived.followedByCorrection),
      cell([...t.friction].sort().join(';')),
      num(t.score.value),
      cell([...t.slashCommands].sort().join(';')),
      cell(
        [...t.toolCalls]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((x) => `${scrub(x.name)}x${x.count}`)
          .join(';')
      ),
      // The per-turn attribution, in the member people actually sort and filter.
      // An empty cell is three different facts -- no file, --no-paths, or a spine
      // from before paths -- and only the limits list can tell them apart, which
      // is why this column carries no wording of its own.
      cell(
        safeFiles(t.files)
          .map((f) => `${f.path}x${f.count}`)
          .join(';')
      ),
    ])
  }
  return csv(rows)
}

/**
 * The per-session aggregates, long-form so a pivot table can reach them.
 *
 * Every row here is session-scoped. For packages, tools, skills and the rest
 * that is all there is: the spine has no turn to put in a turn column. Files are
 * the exception now — they ARE held per turn — so what this member carries is a
 * roll-up across turns, and `turns.csv` is where the attribution lives. The
 * scope column says `session` on a file row for that reason and not because the
 * turn is unknown.
 */
function artifactsCsv(session: Session): string {
  const a = session.artifacts
  const rows = [['kind', 'name', 'count', 'scope']]
  const kinds: [string, Record<string, number>][] = [
    ['package', a.packages],
    ['cli_tool', a.tools],
    ['stack_file', a.stack],
    ['file_extension', a.extensions],
    ['skill', a.skills],
    ['mcp_server', a.mcp],
    ['model', session.models],
  ]
  for (const [kind, map] of kinds)
    for (const [name, count] of sortedPairs(map)) rows.push([cell(kind), cell(name), num(count), 'session'])
  // Rolled up here, and the roll-up can be smaller than the count below it: a
  // tool call made before the first human turn is counted there and belongs to
  // no turn, so it has no path row. The count row says so in its own name rather
  // than letting a reader subtract the two and conclude something is missing.
  const files: Record<string, number> = {}
  for (const t of session.turns) for (const f of safeFiles(t.files)) files[f.path] = (files[f.path] ?? 0) + f.count
  for (const [path, count] of Object.entries(files).sort(
    (x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)
  ))
    rows.push([cell('file'), cell(path), num(count), 'session'])
  rows.push([
    cell('file_touch'),
    cell(
      session.recordedPaths === true
        ? '(tool calls that named a file — not a total of the file rows)'
        : session.recordedPaths === false
          ? '(path not recorded — extracted with --no-paths)'
          : '(whether the paths were recorded is unknown — see LIMITS.txt)'
    ),
    num(a.fileTouches),
    'session',
  ])
  return csv(rows)
}

function limitsTxt(limits: readonly string[]): string {
  const lines: string[] = [
    'WHAT THIS RECORD DOES NOT CONTAIN, AND CANNOT SHOW',
    '='.repeat(50),
    '',
    wrap('Read this before you rely on anything else in this package.'),
    '',
    wrap(NOT_A_CERTIFICATION),
    '',
    wrap(
      'The record is incomplete by construction, not by accident. Each limit below is a ' +
        'thing the reading genuinely does not hold. Where a fact is absent here, that is ' +
        'silence — it is not evidence that the thing did not happen.'
    ),
    '',
  ]
  limits.forEach((limit, i) => {
    const n = String(i + 1).padStart(2, ' ')
    lines.push(`${n}. ${wrap(limit, 74, '    ').slice(4)}`, '')
  })
  lines.push(
    wrap(
      'Every member of this package is listed in manifest.json with its SHA-256 digest, so ' +
        'a reader can check that what they received is what was generated. manifest.json ' +
        'itself is not listed there: it is the index, and cannot contain its own digest.'
    ),
    ''
  )
  return lines.join('\n')
}

/**
 * The file-touch row of the summary table.
 *
 * "(count only)" sat in this label for as long as it was true of every reading.
 * It is now a property of the reading rather than of the format, so it is
 * derived — and in particular it never reads "count only" over a package that
 * lists the paths two files down. The four states are pathLimit()'s four states;
 * this is the one-line form of the same answer.
 */
function filesTouchedRow(session: Session): string {
  const n = session.artifacts.fileTouches
  const distinct = new Set(session.turns.flatMap((t) => t.files ?? []).map((f) => safePath(f.path))).size
  if (session.recordedPaths === true)
    return `${n} tool call(s) named a file; ${distinct} distinct path(s) recorded against turns`
  if (session.recordedPaths === false) return `${n} (count only — extracted with --no-paths)`
  if (distinct > 0)
    return `${n} tool call(s) named a file; ${distinct} distinct path(s) are here, though the reading does not say whether paths were recorded`
  return `${n} (no path is present, and whether any were recorded is unknown)`
}

function summaryMd(
  session: Session,
  intent: BundleIntent | null,
  generatedAt: string,
  meta: BundleMeta & { version: string; command: string },
  // Handed in rather than read off the constant. This file said "Repeated in
  // full from LIMITS.txt" under a list that was missing the derived sentences --
  // so the one member most people actually read was the one member that did not
  // carry the two limits that depend on how the extractor was invoked.
  limits: readonly string[]
): string {
  const t = session.totals
  const rows: [string, string][] = [
    ['Harness', session.harness],
    ['Session id', session.sessionId ?? '(none recorded)'],
    ['Repository directory', repoLabel(session.cwd) ?? '(not recorded)'],
    ['Branch', scrubOrNull(session.gitBranch) ?? '(not recorded)'],
    ['Started', session.startedAt ?? '(not recorded)'],
    ['Ended', session.endedAt ?? '(not recorded)'],
    ['Transcript records read', String(t.records)],
    ['Human turns', String(t.humanTurns)],
    ['Assistant messages', String(t.assistantMessages)],
    ['Tool calls', String(t.toolCalls)],
    ['Sub-agent records', String(t.sidechainRecords)],
    ['Interruptions', String(t.interruptions)],
    ['Compactions', String(t.compactions)],
    ['Turns showing friction', `${t.frictionTurns} of ${t.humanTurns}`],
    ['Repeated prompts', String(t.repeats)],
    ['Corrections', String(t.corrections)],
    ['Files touched', filesTouchedRow(session)],
    ['Input tokens', String(t.tokens.input)],
    ['Output tokens', String(t.tokens.output)],
    ['Cache read tokens', String(t.tokens.cacheRead)],
    ['Cache create tokens', String(t.tokens.cacheCreate)],
    [
      'Score',
      session.score.value === null
        ? '(not scored)'
        : `${session.score.value} (${session.score.band}, confidence ${session.score.confidence})`,
    ],
  ]

  const out: string[] = [
    '# Session evidence package',
    '',
    NOT_A_CERTIFICATION,
    '',
    `Generated ${generatedAt} by ${meta.command} in session-viz ${meta.version}.`,
  ]
  if (meta.fingerprint)
    out.push(`Source fingerprint \`${meta.fingerprint}\`, which the report page prints in its footer.`)
  out.push(
    '',
    '## What ran',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## What is in this package',
    '',
    '| File | What it is |',
    '| --- | --- |',
    '| `manifest.json` | The index: tool, version, generation time, source fingerprint, and a SHA-256 digest for every other member. |',
    '| `LIMITS.txt` | What this record does not contain and cannot show. Read it first. |',
    '| `summary.md` | This file. |',
    '| `session.json` | The full reading, including per-turn prompt text. |',
    '| `turns.csv` | One row per human turn, measurements only. Opens in a spreadsheet. |',
    '| `artifacts.csv` | Per-session counts of packages, tools, skills and MCP servers. |'
  )
  if (intent)
    out.push('| `intent.json` | A model-written summary of the session. Not a measurement, and not verified. |')
  out.push(
    '',
    '## What this cannot show',
    '',
    'Repeated in full from `LIMITS.txt`, because this is the file people read.',
    '',
    ...limits.map((l, i) => `${i + 1}. ${l}`),
    ''
  )
  return out.join('\n')
}

function intentJson(intent: BundleIntent, session: Session, generatedAt: string): string {
  // A mismatched sessionId is the one staleness vector no filename scheme can
  // see: an old intent file paired with a fresh spine reads as current. The
  // page warns about it; a member that travels on its own has to carry it.
  const mismatch =
    intent.sessionId && session.sessionId && intent.sessionId !== session.sessionId
      ? 'WARNING: this summary names a different session id than the reading it is packaged with.'
      : null
  return (
    JSON.stringify(
      {
        limits:
          'Written by a language model about its own session. Not a measurement, not ' +
          'verified, and not evidence of anything it asserts. See LIMITS.txt.',
        generatedAt,
        sessionIdOfSummary: intent.sessionId ?? null,
        sessionIdOfReading: session.sessionId,
        mismatch,
        tldr: scrubOrNull(intent.tldr),
        compactInstruction: scrubOrNull(intent.compactInstruction),
        intents: (intent.intents ?? []).map((i) => ({
          title: scrubOrNull(i.title),
          status: i.status ?? null,
          summary: scrubOrNull(i.summary),
          turns: i.turns ?? [],
        })),
        quality: intent.quality
          ? {
              verdict: scrubOrNull(intent.quality.verdict),
              strengths: (intent.quality.strengths ?? []).map(scrub),
              weaknesses: (intent.quality.weaknesses ?? []).map(scrub),
              recommendations: (intent.quality.recommendations ?? []).map(scrub),
            }
          : null,
      },
      null,
      2
    ) + '\n'
  )
}

// ---------------------------------------------------------------- assembly

function member(name: string, mediaType: string, text: string): BundleMember {
  // Names go into the zip headers one byte per character, in the browser and in
  // the size prediction alike. A non-ASCII name would make both wrong, and the
  // archive would be subtly corrupt rather than obviously broken.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`bundle member name is not flat ASCII: ${name}`)
  const bytes = Buffer.from(text, 'utf8')
  return {
    name,
    mediaType,
    text,
    bytes,
    base64: bytes.toString('base64'),
    size: bytes.length,
    sha256: sha256(bytes),
    crc32: crc32(bytes),
  }
}

/**
 * Build the package.
 *
 * The manifest is written last because it names the digests of everything else,
 * and placed first because that is the file a reader should open. It carries no
 * digest of itself: an index cannot contain its own hash, and pretending
 * otherwise by hashing a placeholder would produce a number that verifies
 * nothing.
 */
export function buildBundle(session: Session, intent?: BundleIntent | null, meta: BundleMeta = {}): EvidenceBundle {
  const generatedAt = meta.generatedAt ?? new Date().toISOString()
  const version = meta.version ?? pluginVersion()
  const command = meta.command ?? '/qpact'
  // Derived once, here, and handed to every member that prints it, so LIMITS.txt,
  // manifest.json and the page cannot end up saying different things about the
  // same package.
  // The two derived sentences lead, in the order the reader needs them: what
  // happened to the words they typed, then what is here about the files they
  // touched. Both depend on how the extractor was invoked and neither can be a
  // constant.
  const limits: readonly string[] = [redactionLimit(session), pathLimit(session), ...LIMITS]

  const body: BundleMember[] = [
    member('LIMITS.txt', 'text/plain; charset=utf-8', limitsTxt(limits)),
    member('summary.md', 'text/markdown; charset=utf-8', summaryMd(session, intent ?? null, generatedAt, { ...meta, version, command }, limits)),
    member('session.json', 'application/json', sessionJson(session, generatedAt)),
    member('turns.csv', 'text/csv; charset=utf-8', turnsCsv(session.turns)),
    member('artifacts.csv', 'text/csv; charset=utf-8', artifactsCsv(session)),
  ]
  if (intent) body.push(member('intent.json', 'application/json', intentJson(intent, session, generatedAt)))

  const manifest = member(
    'manifest.json',
    'application/json',
    JSON.stringify(
      {
        format: 'session-viz/evidence-bundle',
        formatVersion: 1,
        notACertification: NOT_A_CERTIFICATION,
        readFirst: 'LIMITS.txt',
        tool: { name: 'session-viz', command, version },
        generatedAt,
        generatedAtNote:
          'The only clock reading in this package. The modification times inside the zip ' +
          'headers are derived from it in UTC; an unzip tool will display them in local time.',
        source: {
          harness: session.harness,
          sessionId: session.sessionId,
          transcriptFile: baseName(session.file),
          transcriptRecords: session.totals.records,
          fingerprint: meta.fingerprint ?? null,
          spineAgeMin: meta.spineAgeMin ?? null,
          project: safeProject(session.project, session.cwd),
          repo: repoLabel(session.cwd),
          gitBranch: scrubOrNull(session.gitBranch),
          harnessVersion: session.version,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
        },
        digestAlgorithm: 'sha256',
        digestNote:
          "Computed over each member's bytes when this package was generated, and embedded " +
          'in the page the download came from. manifest.json is not listed below: it is the ' +
          'index and cannot carry its own digest.',
        members: body.map((m) => ({
          name: m.name,
          mediaType: m.mediaType,
          bytes: m.size,
          sha256: m.sha256,
          crc32: m.crc32.toString(16).padStart(8, '0'),
        })),
        limits,
      },
      null,
      2
    ) + '\n'
  )

  const members = [manifest, ...body]
  const sid = (session.sessionId || 'session').slice(0, 8)
  const tail = meta.fingerprint ? `-${meta.fingerprint}` : ''
  return {
    filename: `session-evidence-${sid}${tail}.zip`,
    generatedAt,
    members,
    zipSize: predictZipSize(members),
    limits,
  }
}

// ---------------------------------------------------------------- the browser

interface AssemblerEntry {
  /** name */ n: string
  /** base64 of the member's exact bytes */ b64: string
  /** crc32, computed in Node */ c: number
  /** size in bytes */ s: number
  /** DOS time */ t: number
  /** DOS date */ d: number
}

interface AssemblerPayload {
  filename: string
  entries: AssemblerEntry[]
  members: { name: string; bytes: number; sha256: string }[]
  limits: readonly string[]
  global: string
  hook: string
}

/**
 * Everything the page does, and nothing more.
 *
 * Serialised with `Function.prototype.toString` rather than kept as a string
 * literal, so the compiler checks it: a page script that lives in a template
 * literal is invisible to every check in this repo until a browser reads it,
 * and a stray backtick in one has already killed a whole page here while every
 * markup check passed. It closes over nothing — everything it needs arrives in
 * the payload.
 */
function assembler(P: AssemblerPayload): void {
  var host: Record<string, unknown> = (typeof window !== 'undefined' ? window : globalThis) as Record<string, unknown>

  // atob yields one character per byte. No TextEncoder anywhere: these are the
  // exact octets that were hashed at render time, so nothing re-encodes between
  // the digest in manifest.json and the bytes written to disk.
  function bytesOf(b64: string): Uint8Array {
    var s = atob(b64)
    var out = new Uint8Array(s.length)
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
    return out
  }

  // Member names are flat ASCII, enforced at render time, so one byte per
  // character is exact and matches the lengths written into the headers.
  function nameOf(n: string): Uint8Array {
    var out = new Uint8Array(n.length)
    for (var i = 0; i < n.length; i++) out[i] = n.charCodeAt(i) & 0x7f
    return out
  }

  // A STORED (uncompressed) zip: no deflate implementation, no dependency, and
  // it opens in Finder, Explorer and every unzip. Every Uint8Array below starts
  // zero-filled, so the fields this leaves alone -- extra length, comment
  // length, disk numbers, attributes -- are already the zeroes they must be.
  function build(): Blob {
    var parts: Uint8Array[] = []
    var central: Uint8Array[] = []
    var offset = 0
    var cdSize = 0
    for (var i = 0; i < P.entries.length; i++) {
      var e = P.entries[i]!
      var name = nameOf(e.n)
      var data = bytesOf(e.b64)

      var local = new Uint8Array(30 + name.length)
      var lv = new DataView(local.buffer)
      lv.setUint32(0, 0x04034b50, true) // local file header
      lv.setUint16(4, 20, true) // needs 2.0
      lv.setUint16(6, 0x0800, true) // the name is UTF-8
      lv.setUint16(8, 0, true) // method 0: stored
      lv.setUint16(10, e.t, true)
      lv.setUint16(12, e.d, true)
      lv.setUint32(14, e.c, true) // crc32, computed in Node
      lv.setUint32(18, e.s, true) // stored, so compressed size == uncompressed
      lv.setUint32(22, e.s, true)
      lv.setUint16(26, name.length, true)
      local.set(name, 30)
      parts.push(local)
      parts.push(data)

      var cen = new Uint8Array(46 + name.length)
      var cv = new DataView(cen.buffer)
      cv.setUint32(0, 0x02014b50, true) // central directory header
      cv.setUint16(4, 20, true)
      cv.setUint16(6, 20, true)
      cv.setUint16(8, 0x0800, true)
      cv.setUint16(10, 0, true)
      cv.setUint16(12, e.t, true)
      cv.setUint16(14, e.d, true)
      cv.setUint32(16, e.c, true)
      cv.setUint32(20, e.s, true)
      cv.setUint32(24, e.s, true)
      cv.setUint16(28, name.length, true)
      cv.setUint32(42, offset, true) // where this member's local header starts
      cen.set(name, 46)
      central.push(cen)

      offset += local.length + data.length
      cdSize += cen.length
    }
    for (var j = 0; j < central.length; j++) parts.push(central[j]!)

    var end = new Uint8Array(22)
    var ev = new DataView(end.buffer)
    ev.setUint32(0, 0x06054b50, true) // end of central directory
    ev.setUint16(8, P.entries.length, true)
    ev.setUint16(10, P.entries.length, true)
    ev.setUint32(12, cdSize, true)
    ev.setUint32(16, offset, true)
    parts.push(end)

    return new Blob(parts, { type: 'application/zip' })
  }

  function download(): void {
    var url = URL.createObjectURL(build())
    var a = document.createElement('a')
    a.href = url
    a.download = P.filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Revoked on a later tick. Revoking before the browser has taken the blob
    // cancels the download, and that failure looks like a click that did nothing.
    setTimeout(function () {
      URL.revokeObjectURL(url)
    }, 30000)
  }

  host[P.global] = {
    filename: P.filename,
    members: P.members,
    limits: P.limits,
    build: build,
    download: download,
  }

  // Delegated from the document, so the button can be rendered, moved or
  // replaced at any point without anything having to re-bind.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', function (ev: BrowserClick) {
      var t = ev.target
      if (!t || typeof t.closest !== 'function') return
      if (!t.closest('[' + P.hook + ']')) return
      ev.preventDefault()
      download()
    })
  }
}

/**
 * The assembler, as source ready to inline in a `<script>` element.
 *
 * It must go inside a script element and nowhere else: the function body
 * contains bare `<` and `&` from ordinary JavaScript, which are raw text inside
 * a script and are not raw text in an attribute or in XHTML.
 */
export function bundleScript(bundle: EvidenceBundle): string {
  const stamp = dosStamp(bundle.generatedAt)
  const payload: AssemblerPayload = {
    filename: bundle.filename,
    entries: bundle.members.map((m) => ({
      n: m.name,
      b64: m.base64,
      c: m.crc32,
      s: m.size,
      t: stamp.time,
      d: stamp.date,
    })),
    members: bundle.members.map((m) => ({ name: m.name, bytes: m.size, sha256: m.sha256 })),
    limits: bundle.limits,
    global: BUNDLE_GLOBAL,
    hook: DOWNLOAD_HOOK,
  }
  const src = `(${String(assembler)})(${jsonForScript(payload)});`
  // A script element ends at the first `</script`, and a comment opener inside
  // one changes how the rest is tokenised. Neither can occur in what is written
  // above, which is exactly why a silent change to it should stop here rather
  // than in a browser.
  if (/<\/script|<!--/i.test(src)) throw new Error('bundle script would terminate its own script element')
  return src
}
