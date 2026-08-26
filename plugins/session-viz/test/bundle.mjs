// The evidence package, checked against the archive a browser would actually
// write — not against the code that produced it.
//
// This suite runs the REAL assembler source. `bundleScript()` returns the
// string the renderer inlines into a `<script>` element; the test evaluates
// that exact string, calls the `build()` it installs, and then parses the
// resulting bytes back out as a zip: local headers, central directory, end
// record, and a CRC recomputed over every member's data. Nothing here reads the
// members off the `EvidenceBundle` and calls that a check — an assembler that
// wrote a correct-looking manifest into a corrupt archive would pass that, and
// a corrupt archive is exactly what nobody discovers until the auditor opens it.
//
// Four promises are load-bearing, and each has a section below:
//
//   - the same input produces byte-identical output, so two bundles can be diffed
//   - every digest in manifest.json matches the bytes that get written
//   - the archive is a real zip
//   - the package states its own limits, and names no framework it could be
//     read as claiming conformance with
//
// And one that is not about correctness at all: nothing in the package carries
// the account name of whoever ran the session, or a path out of their home
// directory. An evidence package exists to be forwarded.

import { createHash } from 'node:crypto'
import { runInThisContext } from 'node:vm'
import { buildBundle, bundleScript, crc32, LIMITS, redactionLimit, NOT_A_CERTIFICATION, BUNDLE_GLOBAL, DOWNLOAD_HOOK } from '../scripts/bundle.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

// A synthetic account name, invented for this file. It is planted in every
// field that carries one on a real machine — the transcript path, the working
// directory, the harness project key, and the prompt text — so the assertion
// that it never reaches a member has something to find when the scrubbing stops
// running.
const USER = 'fixtureuser'

const GENERATED_AT = '2026-03-04T09:15:30.000Z'

const turn = (over) => ({
  index: 1,
  promptId: null,
  uuid: 'u-1',
  startedAt: '2026-03-04T08:00:00.000Z',
  endedAt: '2026-03-04T08:04:00.000Z',
  durationMs: 240000,
  text: 'placeholder',
  fullChars: 11,
  hasImage: false,
  typed: true,
  steering: false,
  origin: null,
  signals: {
    chars: 11, words: 1, terse: false, hasFileRef: false, hasCodeBlock: false,
    hasUrl: false, isQuestion: false, isCorrection: false, hasAcceptanceCriteria: false,
  },
  tokens: { input: 10, output: 20, cacheRead: 30, cacheCreate: 40 },
  assistantMessages: 2,
  subagents: 0,
  interruptions: 0,
  slashCommands: [],
  effort: null,
  firstToolAt: null,
  timeToFirstToolMs: null,
  toolCalls: [],
  toolCallCount: 0,
  models: [],
  model: 'claude-opus-5',
  mixedModel: false,
  derived: { noToolCalls: false, clarificationRoundtrip: false, followedByCorrection: false, repeatOf: null },
  friction: [],
  score: { value: 70, deductions: [], additions: [] },
  ...over,
})

// `maps` lets the determinism section hand in the same content under a
// different key insertion order.
function fixture(maps) {
  // redactedPrompts is what extract.mjs records about its own invocation. The
  // fixture takes the default (true); the three-way test below covers the other
  // two states, which are the ones that used to be lied about.
  const m = maps ?? {
    packages: { react: 3, '+SUM(1+1)': 1, zod: 2 },
    tools: { git: 12, "=cmd|'/c calc'!A1": 1, npm: 4 },
    extensions: { mts: 19, json: 3 },
    models: { 'claude-opus-5': 7, 'claude-haiku-4-5': 2 },
  }
  return {
    sessionId: '1f2e3d4c-aaaa-bbbb-cccc-ddddeeeeffff',
    file: `/Users/${USER}/.claude/projects/-Users-${USER}-git-demo-api/1f2e3d4c-aaaa-bbbb-cccc-ddddeeeeffff.jsonl`,
    harness: 'claude-code',
    project: `-Users-${USER}-git-demo-api`,
    cwd: `/Users/${USER}/git/demo-api`,
    gitBranch: 'feature/evidence',
    redactedPrompts: true,
    version: '2.1.0',
    title: 'Add the evidence package',
    startedAt: '2026-03-04T08:00:00.000Z',
    endedAt: '2026-03-04T08:41:00.000Z',
    models: m.models,
    artifacts: {
      packages: m.packages,
      tools: m.tools,
      stack: { 'package.json': 4 },
      extensions: m.extensions,
      skills: { pdf: 1 },
      mcp: { railway: 2 },
      fileTouches: 31,
    },
    slashCommands: ['/qpact'],
    permissionModes: [{ ts: '2026-03-04T08:00:01.000Z', mode: 'acceptEdits' }],
    totals: {
      records: 812,
      humanTurns: 3,
      assistantMessages: 44,
      toolCalls: 96,
      sidechainRecords: 12,
      interruptions: 1,
      compactions: 0,
      steeringTurns: 1,
      tokens: { input: 4100, output: 51200, cacheRead: 9100000, cacheCreate: 220000 },
      frictionTurns: 1,
      frictionRate: 0.3333333333333333,
      repeats: 1,
      corrections: 1,
    },
    turns: [
      turn({
        index: 0,
        uuid: 'u-0',
        // Both leaks a real machine leaves in prompt text: a home-directory
        // path, and an address.
        text: `open /Users/${USER}/git/demo-api/src/index.ts and mail ${USER}@example.com when done`,
        fullChars: 4000,
        slashCommands: ['/qpact'],
        toolCalls: [{ name: "=cmd|'/c calc'!A1", count: 1 }, { name: 'Read', count: 9 }],
        toolCallCount: 10,
        signals: { ...turn({}).signals, hasFileRef: true, chars: 74, words: 12 },
      }),
      turn({
        index: 1,
        uuid: 'u-1',
        text: 'no, do it the other way',
        fullChars: 23,
        friction: ['correction', 'repeated'],
        interruptions: 1,
        derived: { noToolCalls: true, clarificationRoundtrip: false, followedByCorrection: false, repeatOf: 0 },
        score: { value: 41, deductions: [{ points: -20, why: 'repeat of an earlier prompt', tier: 'outcome' }], additions: [] },
      }),
      turn({ index: 2, uuid: 'u-2', text: 'ship it', fullChars: 7, steering: true }),
    ],
    score: { value: 61, band: 'mixed', confidence: 'medium', turnsScored: 3, frictionRate: 0.33, craftRate: 0.1, wastedTokens: 900, costliestTurn: 1 },
    durationMs: 2460000,
  }
}

const INTENT = {
  tldr: `Wired the bundle into /Users/${USER}/git/demo-api, reachable at ${USER}@example.com`,
  compactInstruction: 'keep the zip writer',
  intents: [{ title: 'Ship the package', status: 'done', summary: 'Built it', turns: [0, 2] }],
  quality: { verdict: 'solid', strengths: ['tested'], weaknesses: [], recommendations: ['wire it in'] },
  sessionId: '1f2e3d4c-aaaa-bbbb-cccc-ddddeeeeffff',
}

const META = { generatedAt: GENERATED_AT, fingerprint: 'a1b2c3d4', version: '9.9.9', command: '/qpact', spineAgeMin: 2 }

// ---------------------------------------------------------------- the archive

/**
 * Run the page's own script, then take the bytes it builds.
 *
 * `runInThisContext` evaluates the exact string the renderer inlines, against
 * this realm's globals — the same `atob`, `Blob`, `DataView` and `Uint8Array`
 * the browser hands it. In Node there is no `window`, so the assembler falls
 * through to `globalThis` and hangs its API there; that fallback is the only
 * concession this test asks of it.
 */
async function assembleInBrowser(bundle) {
  delete globalThis[BUNDLE_GLOBAL]
  runInThisContext(bundleScript(bundle), { filename: 'bundle-assembler.js' })
  const api = globalThis[BUNDLE_GLOBAL]
  if (!api) throw new Error(`the script did not install window.${BUNDLE_GLOBAL}`)
  return Buffer.from(await api.build().arrayBuffer())
}

/** Read a zip the way an unzip does: end record, then central directory, then
 *  each local header at the offset the directory points to. */
function readZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const eocd = buf.length - 22
  const problems = []
  if (eocd < 0 || v.getUint32(eocd, true) !== 0x06054b50)
    return { problems: ['no end-of-central-directory record at the tail'], entries: [] }

  const count = v.getUint16(eocd + 10, true)
  const cdSize = v.getUint32(eocd + 12, true)
  const cdOff = v.getUint32(eocd + 16, true)
  if (v.getUint16(eocd + 8, true) !== count) problems.push('the end record disagrees with itself about the entry count')

  const entries = []
  let p = cdOff
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) {
      problems.push(`central directory entry ${i} has no header signature`)
      break
    }
    const nameLen = v.getUint16(p + 28, true)
    const extraLen = v.getUint16(p + 30, true)
    const commentLen = v.getUint16(p + 32, true)
    const e = {
      name: buf.toString('latin1', p + 46, p + 46 + nameLen),
      method: v.getUint16(p + 10, true),
      crc: v.getUint32(p + 16, true),
      size: v.getUint32(p + 24, true),
      offset: v.getUint32(p + 42, true),
      dosTime: v.getUint16(p + 12, true),
      dosDate: v.getUint16(p + 14, true),
      data: Buffer.alloc(0),
    }
    // The local header, found the way an unzip finds it: through the offset the
    // central directory gave. A directory that points at the wrong place is a
    // failure that only shows up here.
    const lo = e.offset
    if (lo + 30 > buf.length || v.getUint32(lo, true) !== 0x04034b50) {
      problems.push(`${e.name}: the central directory points at ${lo}, which is not a local file header`)
    } else {
      const lNameLen = v.getUint16(lo + 26, true)
      const lExtra = v.getUint16(lo + 28, true)
      e.localName = buf.toString('latin1', lo + 30, lo + 30 + lNameLen)
      // Read from the local header as well as the directory. An unzip decides
      // how to read the data from THIS field, so a local header claiming
      // deflate over stored bytes is unopenable even though the directory and
      // every CRC still agree.
      e.localMethod = v.getUint16(lo + 8, true)
      e.localCrc = v.getUint32(lo + 14, true)
      e.localCompressed = v.getUint32(lo + 18, true)
      e.localSize = v.getUint32(lo + 22, true)
      const start = lo + 30 + lNameLen + lExtra
      e.data = buf.subarray(start, start + e.localCompressed)
      e.actualCrc = crc32(e.data)
    }
    entries.push(e)
    p += 46 + nameLen + extraLen + commentLen
  }
  if (p - cdOff !== cdSize) problems.push(`the central directory is ${p - cdOff} bytes, the end record says ${cdSize}`)
  return { problems, entries, count, cdOff, cdSize }
}

const sha = (b) => createHash('sha256').update(b).digest('hex')
/** A member's text straight off the bundle, for assertions about content
 *  rather than about the container. */
const memberText = (bundle, name) => {
  const m = bundle.members.find((x) => x.name === name)
  return m ? Buffer.from(m.bytes ?? m.data).toString('utf8') : null
}
const textOf = (zip, name) => {
  const e = zip.entries.find((x) => x.name === name)
  return e && e.data.length ? e.data.toString('utf8') : null
}

// ---------------------------------------------------------------- run

const bundle = buildBundle(fixture(), INTENT, META)
const zipBytes = await assembleInBrowser(bundle)
const zip = readZip(zipBytes)

console.log('\n── the package is built and the browser can write it')
chk('the script installs its API', typeof globalThis[BUNDLE_GLOBAL]?.build === 'function')
chk('the archive is not empty', zipBytes.length > 0, `${zipBytes.length} bytes`)
chk(
  'the assembled archive is exactly the size the bundle predicted',
  zipBytes.length === bundle.zipSize,
  `assembled ${zipBytes.length}, predicted ${bundle.zipSize}`
)
chk('manifest.json is the first member, so an unzip lists it first', bundle.members[0]?.name === 'manifest.json', bundle.members[0]?.name)
chk('LIMITS.txt is the second', bundle.members[1]?.name === 'LIMITS.txt', bundle.members[1]?.name)
chk('the download name carries the session and the fingerprint', bundle.filename === 'session-evidence-1f2e3d4c-a1b2c3d4.zip', bundle.filename)

console.log('\n── it is a real zip')
chk('nothing went wrong reading it back', zip.problems.length === 0, zip.problems.join('\n       '))
chk(
  'every member of the bundle is in the archive, in order',
  zip.entries.map((e) => e.name).join(',') === bundle.members.map((m) => m.name).join(','),
  `archive: ${zip.entries.map((e) => e.name).join(',')}`
)
for (const e of zip.entries) {
  chk(
    `${e.name}: stored, not compressed, in both headers`,
    e.method === 0 && e.localMethod === 0,
    `local says ${e.localMethod}, directory says ${e.method}`
  )
  chk(`${e.name}: the local header names the same file as the directory`, e.localName === e.name, `${e.localName} vs ${e.name}`)
  chk(
    `${e.name}: the CRC in the header matches the bytes`,
    e.actualCrc === e.localCrc,
    `header ${(e.localCrc >>> 0).toString(16)}, actual ${(e.actualCrc >>> 0).toString(16)}`
  )
  chk(`${e.name}: the directory CRC matches the local header`, e.crc === e.localCrc)
  chk(
    `${e.name}: the size in the header matches the bytes`,
    e.localSize === e.data.length && e.size === e.data.length,
    `header ${e.localSize}, actual ${e.data.length}`
  )
}
chk(
  'the modification stamps come from the generation time, not a clock',
  zip.entries.length > 0 &&
    zip.entries.every((e) => e.dosDate === (((2026 - 1980) << 9) | (3 << 5) | 4) && e.dosTime === ((9 << 11) | (15 << 5) | 15)),
  `first entry: date ${zip.entries[0]?.dosDate}, time ${zip.entries[0]?.dosTime}`
)

console.log('\n── every digest matches the bytes the browser wrote')
const manifest = JSON.parse(textOf(zip, 'manifest.json') ?? '{}')
chk('manifest.json parses', typeof manifest.format === 'string', manifest.format)
chk(
  'the manifest lists every member except itself',
  (manifest.members ?? []).map((m) => m.name).join(',') === bundle.members.slice(1).map((m) => m.name).join(','),
  (manifest.members ?? []).map((m) => m.name).join(',')
)
chk('the manifest does not claim a digest of itself', !(manifest.members ?? []).some((m) => m.name === 'manifest.json'))
for (const m of manifest.members ?? []) {
  const e = zip.entries.find((x) => x.name === m.name)
  chk(
    `${m.name}: the manifest digest matches the archived bytes`,
    !!e && sha(e.data) === m.sha256,
    e ? `manifest ${m.sha256}\n       archive  ${sha(e.data)}` : 'member missing from the archive'
  )
  chk(`${m.name}: the manifest byte count matches the archived bytes`, !!e && e.data.length === m.bytes, e ? `manifest ${m.bytes}, archive ${e.data.length}` : 'member missing')
  chk(`${m.name}: the manifest CRC matches the archived bytes`, !!e && parseInt(m.crc32, 16) === e.actualCrc)
}
chk('the digest algorithm is named', manifest.digestAlgorithm === 'sha256')
chk('the generation time is the one that was passed in', manifest.generatedAt === GENERATED_AT, manifest.generatedAt)
chk('the source fingerprint is recorded', manifest.source?.fingerprint === 'a1b2c3d4')
chk(
  'the transcript is named by file, never by path',
  manifest.source?.transcriptFile === '1f2e3d4c-aaaa-bbbb-cccc-ddddeeeeffff.jsonl',
  manifest.source?.transcriptFile
)

console.log('\n── the same input produces the same bytes')
const again = await assembleInBrowser(buildBundle(fixture(), INTENT, META))
chk('two builds of the same spine are byte-identical', Buffer.compare(zipBytes, again) === 0, `${zipBytes.length} vs ${again.length} bytes`)

// The same content with the maps built in a different key order. Object key
// order follows insertion, and insertion order follows whatever the transcript
// happened to say — so without a sort at every emit site, two readings of one
// session serialise differently and the bundles cannot be diffed.
const shuffled = await assembleInBrowser(
  buildBundle(
    fixture({
      packages: { zod: 2, react: 3, '+SUM(1+1)': 1 },
      tools: { npm: 4, git: 12, "=cmd|'/c calc'!A1": 1 },
      extensions: { json: 3, mts: 19 },
      models: { 'claude-haiku-4-5': 2, 'claude-opus-5': 7 },
    }),
    INTENT,
    META
  )
)
chk('the same content in a different key order is byte-identical', Buffer.compare(zipBytes, shuffled) === 0)

console.log('\n── the spreadsheet member')
const rows = (textOf(zip, 'turns.csv') ?? '').split('\r\n').filter((r) => r !== '')
chk('one header row and one row per turn', rows.length === 4, `${rows.length} rows`)
chk('the header names the turn and the score', /^turn,started_at/.test(rows[0] ?? '') && (rows[0] ?? '').includes(',score,'), rows[0])
chk('prompt text is not a column', !(rows[0] ?? '').includes('prompt_text'))
chk('a tool name a spreadsheet would evaluate is defused', (rows[1] ?? '').includes(",'=cmd"), rows[1])
const artifacts = (textOf(zip, 'artifacts.csv') ?? '').split('\r\n').filter((r) => r !== '')
chk(
  'a package name a spreadsheet would evaluate is defused',
  artifacts.some((r) => r.startsWith("package,'+SUM")),
  artifacts.slice(0, 4).join(' | ')
)
chk('the file-touch count is present and unattributed', artifacts.includes('file_touch,(path not recorded),31,session'))
chk('every artifact row is marked session-scoped', artifacts.length > 1 && artifacts.slice(1).every((r) => r.endsWith(',session')))

console.log('\n── the package states its own limits')
const limits = textOf(zip, 'LIMITS.txt') ?? ''
const summary = textOf(zip, 'summary.md') ?? ''
// LIMITS.txt is hard-wrapped for a plain-text reader, so every assertion about
// its wording runs against the text with its line breaks collapsed. Matching
// the wrapped form would make the suite fail on a rewording that changed only
// where the lines break, which is not a defect.
const flat = (s) => s.replace(/\s+/g, ' ')
const limitsFlat = flat(limits)
chk('LIMITS.txt is in the archive and is not a stub', limits.length > 1500, `${limits.length} bytes`)
chk('it says it is not a certification', limitsFlat.includes(flat(NOT_A_CERTIFICATION)))
chk('so does the manifest', manifest.notACertification === NOT_A_CERTIFICATION)
chk('so does the summary', flat(summary).includes(flat(NOT_A_CERTIFICATION)))
chk('the manifest points at it', manifest.readFirst === 'LIMITS.txt')

// The five the record has to admit to, asserted on the substance rather than on
// a whole sentence, so a rewrite that keeps the meaning still passes.
const NAMED = [
  ['what happened to prompt text', /passed through the secret patterns before it was stored/i],
  ['redaction can both miss and over-match', /no pattern covers is still here verbatim/i],
  // Derived, not asserted: the fixture says redaction ran, so this is the wording
  // for that case. The three-way test below is what pins the mechanism.
  ['file contents are never recorded', /No file contents are recorded/i],
  ['a file touch does not say which file', /WHICH file was touched is not captured/i],
  ['artifacts are per session and cannot be placed in time', /counted per session, not per turn.{0,60}cannot be placed in one/i],
]
for (const [what, re] of NAMED) chk(`LIMITS.txt names: ${what}`, re.test(limitsFlat))
chk('every limit reaches LIMITS.txt, in full', LIMITS.every((l) => limitsFlat.includes(flat(l))))
chk('every limit reaches summary.md, in full', LIMITS.every((l) => flat(summary).includes(flat(l))))
// ---- the spine's shapes, not the spine's type declarations
//
// `origin` was declared `string | null` and has never been a string: Claude Code
// writes { kind: 'human' }. The fixture believed the declaration, so this suite
// stayed green while `scrub` called .replace() on an object and /qpact could not
// render a single real session. Fixtures copied from a type are fixtures that
// test the type.
{
  const withShapes = {
    ...fixture(),
    turns: fixture().turns.map((t, i) => ({
      ...t,
      origin: i % 2 ? { kind: 'human' } : null,
    })),
  }
  let boom = null
  let built = null
  try { built = buildBundle(withShapes, INTENT, META) } catch (e) { boom = e }
  chk('a turn whose origin is a shape does not crash the build', boom === null,
    boom ? `${boom.constructor.name}: ${boom.message}` : '')
  if (built) {
    const j = JSON.parse(memberText(built, 'session.json') ?? '{}')
    const shaped = ((j.session && j.session.turns) || []).filter((t) => t.origin && typeof t.origin === 'object')
    chk('and the shape survives into session.json', shaped.length > 0, `${shaped.length} shaped origins`)
    chk('with its strings scrubbed rather than passed through',
      shaped.every((t) => typeof t.origin.kind === 'string'), JSON.stringify(shaped[0]?.origin))
    const csv = memberText(built, 'turns.csv') ?? ''
    chk('and the CSV names the kind rather than [object Object]',
      csv.includes('human') && !csv.includes('[object Object]'),
      (csv.split('\n').find((l) => l.includes('human')) || '').slice(0, 90))
  }
}

// ---- a nested string is still a string
{
  const deep = { ...fixture(), turns: fixture().turns.map((t) => ({
    ...t, origin: { kind: 'human', note: 'from /Users/someone/git/api' },
  })) }
  const j = JSON.parse(memberText(buildBundle(deep, INTENT, META), 'session.json') ?? '{}')
  const notes = ((j.session && j.session.turns) || []).map((t) => t.origin?.note).filter(Boolean)
  chk('a home path nested inside an origin shape is scrubbed too',
    notes.length > 0 && notes.every((x) => !x.includes('/Users/')), notes[0])
}

// ---- the redaction sentence is derived, not asserted
//
// The first version of LIMITS stated "prompt text is redacted for secrets" as a
// flat fact. `extract.mjs --no-redact` exists, so that sentence could head a
// package whose session.json carried an API key in the clear -- an evidence file
// making a safety claim it had no way to check. It is derived from what the
// extractor recorded now, and all three states are pinned here because the
// dangerous one is the state nobody writes a test for.
{
  const ran = redactionLimit({ ...fixture(), redactedPrompts: true })
  const not = redactionLimit({ ...fixture(), redactedPrompts: false })
  const unknown = redactionLimit({ ...fixture(), redactedPrompts: undefined })
  chk('a redacted reading says the patterns were applied', /passed through the secret patterns/i.test(ran), ran)
  chk('and still admits the patterns both miss and over-match', /no pattern covers is still here verbatim/i.test(ran), ran)
  chk('an unredacted reading says so, in the open', /PROMPT TEXT WAS NOT REDACTED/.test(not), not)
  chk('and warns the package itself carries secrets', /carrying secrets until someone has read it/i.test(not), not)
  chk('an unredacted reading never claims redaction happened',
    !/passed through the secret patterns/i.test(not), not)
  chk('a reading that cannot tell says it cannot tell', /UNKNOWN/.test(unknown), unknown)
  chk('and errs toward the assumption that is safe to be wrong about',
    /Treat the prompts as unredacted/i.test(unknown), unknown)
  const built = buildBundle({ ...fixture(), redactedPrompts: false }, INTENT, META)
  chk('and the whole package leads with it', /PROMPT TEXT WAS NOT REDACTED/.test(built.limits[0]), built.limits[0])
}

chk('every limit reaches the manifest, in full', JSON.stringify(manifest.limits) === JSON.stringify([redactionLimit(fixture()), ...LIMITS]))
chk('the page can print the same list', JSON.stringify(bundle.limits) === JSON.stringify([redactionLimit(fixture()), ...LIMITS]))

// The line this project cannot cross. Naming a framework anywhere in the
// package invites the reader to hear a conformance claim whatever the
// surrounding sentence says — so no member names one at all.
const FRAMEWORKS = /\b(EU AI Act|GDPR|SOC ?2|ISO[ /]?\d{4,5}|HIPAA|NIST|PCI[ -]?DSS|SOX|Sarbanes|Article \d+|Annex [IVX]+)\b/i
for (const m of bundle.members) {
  const hit = m.text.match(FRAMEWORKS)
  chk(`${m.name}: names no framework it could be read as claiming conformance with`, !hit, hit ? `found ${JSON.stringify(hit[0])}` : '')
}

console.log('\n── nothing carries an account name or a home path')
const HOMEY = /(?:\/Users\/|\/home\/|-Users-|-home-|\\Users\\)/
for (const e of zip.entries) {
  const text = e.data.toString('utf8')
  const at = text.indexOf(USER)
  chk(
    `${e.name}: the account name is nowhere in it`,
    at === -1,
    at === -1 ? '' : `at index ${at}: ${JSON.stringify(text.slice(Math.max(0, at - 40), at + 40))}`
  )
  const homey = text.match(HOMEY)
  chk(`${e.name}: no home-directory path survives`, !homey, homey ? `found ${JSON.stringify(homey[0])}` : '')
}

// Structured fields, walked. Turn prompt text is excluded and named as
// excluded: it is free text a person typed, and this package rewrites the home
// paths in it but does not claim to make every path inside it relative.
const sessionDoc = JSON.parse(textOf(zip, 'session.json') ?? '{}')
const promptText = (sessionDoc.session?.turns ?? []).map((t) => t.text)
// A slash command is a leading slash and one word — `/qpact` — with no
// separator and no extension. It is not a path and excluding it here is what
// keeps this assertion about paths.
const SLASH_COMMAND = /^\/[a-z][a-z0-9-]*$/
function absolutes(value, path, out) {
  if (typeof value === 'string') {
    if (SLASH_COMMAND.test(value) || promptText.includes(value)) return
    if (/^\/|^[A-Za-z]:[\\/]/.test(value)) out.push(`${path} = ${JSON.stringify(value)}`)
  } else if (Array.isArray(value)) value.forEach((v, i) => absolutes(v, `${path}[${i}]`, out))
  else if (value && typeof value === 'object') for (const k of Object.keys(value)) absolutes(value[k], `${path}.${k}`, out)
}
const abs = []
absolutes(manifest, 'manifest', abs)
absolutes(
  { ...sessionDoc, session: { ...sessionDoc.session, turns: (sessionDoc.session?.turns ?? []).map((t) => ({ ...t, text: '' })) } },
  'session',
  abs
)
absolutes(JSON.parse(textOf(zip, 'intent.json') ?? '{}'), 'intent', abs)
chk('no structured field outside prompt text is an absolute path', abs.length === 0, abs.join('\n       '))

// The scrub has to rewrite, not delete: an evidence package that quietly drops
// the useful half of a prompt is worse than one that keeps a tilde.
chk('a home path in a prompt is rewritten, not dropped', promptText[0]?.includes('open ~/git/demo-api/src/index.ts'), promptText[0])
chk('an address in a prompt is replaced', promptText[0]?.includes('«redacted-email»') && !promptText[0]?.includes('@example.com'), promptText[0])
chk('the rewriting is disclosed', LIMITS.some((l) => /rewrites home-directory paths and email-shaped strings/.test(l)))
chk('the working directory is reduced to the repository name', sessionDoc.session?.repo === 'demo-api', sessionDoc.session?.repo)
chk('the project key loses its home prefix but keeps its meaning', manifest.source?.project === 'git-demo-api', manifest.source?.project)

// A hyphenated account name has no findable boundary inside a dash-encoded
// project key, so there is nothing safe to cut and the label is withheld whole.
// `-Users-fixture-user-two-git-api` under the obvious one-segment rule leaks
// `user-two`.
const hyphenated = buildBundle({ ...fixture(), cwd: null, project: '-Users-fixture-user-two-git-api' }, null, META)
const hyphenText = hyphenated.members.map((m) => m.text).join('\n')
chk(
  'a hyphenated account name is withheld whole rather than half-cut',
  !/user-two/.test(hyphenText),
  (hyphenText.match(/.{0,30}user-two.{0,30}/) ?? [''])[0]
)
chk('and the withholding is visible', hyphenated.members.some((m) => m.text.includes('«path-withheld»')))

console.log('\n── the model-written summary is packaged as what it is')
const intentDoc = JSON.parse(textOf(zip, 'intent.json') ?? '{}')
chk('intent.json is present when an intent is given', !!textOf(zip, 'intent.json'))
chk('it says it is not a measurement', /not a measurement, not\s+verified/i.test(intentDoc.limits ?? ''))
chk('it records which session it claims to describe', intentDoc.sessionIdOfSummary === INTENT.sessionId)
chk('no intent, no member', !buildBundle(fixture(), null, META).members.some((m) => m.name === 'intent.json'))
const stale = buildBundle(fixture(), { ...INTENT, sessionId: 'deadbeef-0000-0000-0000-000000000000' }, META)
chk(
  'a summary naming a different session is flagged inside the member',
  /WARNING: this summary names a different session id/.test(stale.members.find((m) => m.name === 'intent.json')?.text ?? '')
)

console.log('\n── the script is safe to inline, and the button is wired')
const script = bundleScript(bundle)
chk('the script cannot end its own script element', !/<\/script/i.test(script) && !script.includes('<!--'))
chk('it fetches nothing', !/\bfetch\s*\(|XMLHttpRequest|importScripts|new WebSocket/.test(script))
chk('it hashes nothing in the browser', !/crypto\.subtle/.test(script))

// Member content travels base64-encoded, so a `</script>` inside a prompt or a
// skill name cannot reach the page as markup at all — the alphabet has no `<`
// in it. That is a structural guarantee and this is what holds it in place: if
// anyone ever embeds a member's text alongside its base64, the second assertion
// goes red. The filename is the one raw field built from transcript data, and
// it goes through the same escape the rest of this repo uses.
const HOSTILE = '</script><img src=x onerror=alert(1)>'
const hostile = buildBundle({ ...fixture(), sessionId: '<script>x', title: `T ${HOSTILE}` }, null, META)
const hostileScript = bundleScript(hostile)
chk(
  'a hostile session id is escaped where it reaches the page',
  hostileScript.includes('\\u003cscript\\u003e') && !hostileScript.includes('<script>'),
  hostile.filename
)
chk('member text never reaches the page in raw form', !hostileScript.includes('img src=x onerror=alert(1)'))
chk(
  'and the hostile value still round-trips into the archive, byte for byte',
  (textOf(readZip(await assembleInBrowser(hostile)), 'session.json') ?? '').includes(HOSTILE)
)

// The hook is the contract with whatever renders the button. It binds by
// delegation from `document`, so this stubs just enough document for the
// listener to register and fire. The global is re-installed from `bundle`
// here: the determinism section left the shuffled build's API in place, and
// asserting against that would tie this section to the order of the file.
const clicks = []
let listener = null
globalThis.document = {
  addEventListener: (type, fn) => {
    if (type === 'click') listener = fn
  },
  createElement: () => ({ href: '', download: '', rel: '', click: () => clicks.push('clicked') }),
  body: { appendChild() {}, removeChild() {} },
}
delete globalThis[BUNDLE_GLOBAL]
runInThisContext(bundleScript(bundle), { filename: 'bundle-assembler.js' })
chk(
  'the members and their digests are readable from the page',
  globalThis[BUNDLE_GLOBAL].members.length === bundle.members.length &&
    globalThis[BUNDLE_GLOBAL].members.every((m, i) => m.sha256 === bundle.members[i].sha256 && m.name === bundle.members[i].name)
)
chk('the page is told what to call the file', globalThis[BUNDLE_GLOBAL].filename === bundle.filename)
chk('the page can print the limits without the bundle', JSON.stringify(globalThis[BUNDLE_GLOBAL].limits) === JSON.stringify([redactionLimit(fixture()), ...LIMITS]))
chk('the script binds a delegated click listener', typeof listener === 'function')
if (typeof listener === 'function') {
  let prevented = false
  listener({
    target: { closest: (sel) => (sel === `[${DOWNLOAD_HOOK}]` ? {} : null) },
    preventDefault: () => {
      prevented = true
    },
  })
  chk(`a click on [${DOWNLOAD_HOOK}] starts the download`, prevented && clicks.includes('clicked'), `prevented=${prevented} clicks=${JSON.stringify(clicks)}`)
  const before = clicks.length
  listener({
    target: { closest: () => null },
    preventDefault: () => {
      throw new Error('a click elsewhere was swallowed')
    },
  })
  chk('a click anywhere else is left alone', clicks.length === before)
}
delete globalThis.document

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
