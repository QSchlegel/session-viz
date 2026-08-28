// Which files a run touched — asserted on a real extraction, and on every
// sentence the tool then says about it.
//
// The spine used to take the full path off a tool call, keep the extension and
// a `fileTouches++`, and throw the path away. Three places told the reader so in
// so many words, and the evidence package told them twice. Recording paths makes
// every one of those sentences false, and a false reassurance about what a
// forwarded file contains is worse than the missing feature was — so this suite
// is half about the data and half about the wording, and the wording half is the
// one that matters.
//
// It runs the REAL extractor over a REAL transcript on disk. A fixture that
// hands `extract()` a pre-built Session would test the shape of an object this
// file made up; the failure that actually ships is a path that never reaches the
// turn, and only the streaming loop can produce that.
//
// The account name planted through the fixture is what every privacy assertion
// below hunts for. A recorded path is relative BECAUSE the relative form cannot
// carry it, so if the relativising ever stops running, this is where it shows.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from '../scripts/extract.mjs'
import { buildBundle, pathLimit } from '../scripts/bundle.mjs'
import { describe as describePayload, pickerPage } from '../scripts/qshare.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

// Invented for this file, and planted in the transcript path, the working
// directory, every tool-call path and the prompt text — all four places a real
// machine puts it.
const USER = 'fixtureuser'
const CWD = `/Users/${USER}/git/demo-api`

const dir = mkdtempSync(join(tmpdir(), 'session-viz-paths-'))
const FILE = join(dir, 'a1b2c3d4-0000-0000-0000-000000000000.jsonl')

let clock = Date.parse('2026-03-04T08:00:00.000Z')
const at = () => new Date((clock += 1000)).toISOString()
let seq = 0
const uuid = () => `u-${++seq}`

const base = () => ({ uuid: uuid(), timestamp: at(), sessionId: 'a1b2c3d4-0000-0000-0000-000000000000', cwd: CWD, version: '2.1.0' })
const human = (text) => ({ ...base(), type: 'user', message: { content: [{ type: 'text', text }] } })
/** One assistant record carrying `blocks` tool_use calls. */
const assistant = (blocks) => ({
  ...base(),
  type: 'assistant',
  message: { model: 'claude-opus-5', content: blocks, usage: { input_tokens: 1, output_tokens: 1 } },
})
const tool = (name, input) => ({ type: 'tool_use', name, input })
const read = (p) => tool('Read', { file_path: p })

// The transcript. Written in document order, which is the only order the
// extractor has: turns are cut between human records, so where a tool call sits
// in this array IS which turn it belongs to.
const RECORDS = [
  // Before any human turn. A real session opens this way whenever it resumes or
  // a hook fires first, and this call belongs to no turn — it is the reason
  // `fileTouches` is allowed to exceed the sum of what is listed per turn.
  assistant([read(`${CWD}/scripts/boot.mjs`)]),

  human(`please fix ${CWD}/src/index.ts, it throws`),
  // Twenty calls on one file. The whole point of storing a count: a busy turn
  // reads the same file dozens of times, and twenty entries of one string is how
  // a spine gets big for nothing.
  assistant(Array.from({ length: 20 }, () => read(`${CWD}/src/index.ts`))),
  assistant([
    tool('Edit', { file_path: `${CWD}/src/util.ts`, old_string: 'a', new_string: 'b' }),
    // Outside the working directory. Relativising is what removes the account
    // name, and it has to keep working when the file is not under the repo.
    read(`/Users/${USER}/.claude/settings.json`),
    // A path named ONLY inside a shell command. Nothing reads paths out of
    // command text, so this must not appear — and the limits list has to say so
    // rather than let a reader take an empty list for an idle session.
    tool('Bash', { command: `wc -l ${CWD}/src/hidden-by-bash.ts` }),
  ]),

  human('now the docs'),
  assistant([tool('Write', { file_path: `${CWD}/docs/readme.md`, content: 'hello' })]),
]
writeFileSync(FILE, RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n')

const spine = await extract(FILE)
const noPaths = await extract(FILE, { recordPaths: false })

const pathsOf = (turn) => (turn.files ?? []).map((f) => f.path)
const countOf = (turn, path) => (turn.files ?? []).find((f) => f.path === path)?.count ?? null

// ------------------------------------------------- the paths, and whose they are

console.log('\n── a path is recorded, against the turn that touched it')
chk('the extraction found both human turns', spine.turns.length === 2, `${spine.turns.length} turns`)
chk('the first turn names the file it worked on',
  pathsOf(spine.turns[0]).includes('src/index.ts'), pathsOf(spine.turns[0]).join(', '))
chk('the second turn names its own file',
  pathsOf(spine.turns[1]).includes('docs/readme.md'), pathsOf(spine.turns[1]).join(', '))
// The attribution, stated as a negative. A per-session bag of paths would pass
// every assertion above and answer none of the question this feature exists for.
chk('and neither turn has borrowed the other\'s file',
  !pathsOf(spine.turns[1]).includes('src/index.ts') && !pathsOf(spine.turns[0]).includes('docs/readme.md'),
  `${pathsOf(spine.turns[0]).join(', ')} | ${pathsOf(spine.turns[1]).join(', ')}`)

console.log('\n── twenty touches of one file is one entry and a count')
chk('the file appears exactly once',
  pathsOf(spine.turns[0]).filter((p) => p === 'src/index.ts').length === 1,
  pathsOf(spine.turns[0]).join(', '))
chk('and carries the count', countOf(spine.turns[0], 'src/index.ts') === 20, String(countOf(spine.turns[0], 'src/index.ts')))
chk('the turn that touched three files lists three',
  spine.turns[0].files.length === 3, pathsOf(spine.turns[0]).join(', '))
// Most-touched first, ties broken by path. Two readings of one transcript have
// to serialise identically or no two packages can be diffed.
chk('ordered most-touched first', spine.turns[0].files[0]?.path === 'src/index.ts',
  JSON.stringify(spine.turns[0].files))
{
  const again = await extract(FILE)
  chk('and the same transcript extracts to the same list, twice',
    JSON.stringify(again.turns.map((t) => t.files)) === JSON.stringify(spine.turns.map((t) => t.files)))
}

console.log('\n── a recorded path cannot carry the account name')
const everyPath = spine.turns.flatMap(pathsOf)
chk('a file outside the repo is relative to it, not absolute',
  everyPath.includes('../../.claude/settings.json'), everyPath.join(', '))
chk('no recorded path contains the account name',
  !everyPath.some((p) => p.includes(USER)), everyPath.filter((p) => p.includes(USER)).join(', '))
chk('no recorded path is absolute', !everyPath.some((p) => p.startsWith('/')), everyPath.join(', '))
// The prompt text is the other half of the same question, and the answer there
// is different: it is whatever the person typed, absolute path and all, and it
// is the consumers that rewrite it. Pinned so that "paths are relative now" is
// never read as covering the free text too.
chk('while the prompt text still holds the absolute path the person typed',
  spine.turns[0].text.includes(`${CWD}/src/index.ts`), spine.turns[0].text)

// A session whose working directory is NOT under the home tree, editing a file
// that is. This was very nearly missed: the relative form cancels the account
// name only when both paths share it, and here they share nothing — so the climb
// walks back down through `Users/<name>` and lands the account name in the middle
// of a path that is relative and therefore looks safe. On the corpus this was
// written against, every session with a working directory outside the home tree
// did it. It is a worktree in /private/tmp, which is an ordinary way to work.
console.log('\n── a working directory outside the home tree does not smuggle the name back in')
{
  const OUTSIDE = '/private/tmp/worktree-42/demo-api'
  const outsideFile = join(dir, 'b2c3d4e5-0000-0000-0000-000000000000.jsonl')
  const rec = (o) => ({ uuid: uuid(), timestamp: at(), sessionId: 'b2c3d4e5', cwd: OUTSIDE, version: '2.1.0', ...o })
  writeFileSync(outsideFile, [
    rec({ type: 'user', message: { content: [{ type: 'text', text: 'read the settings' }] } }),
    rec({ type: 'assistant', message: { model: 'claude-opus-5', content: [
      read(`/Users/${USER}/.claude/settings.json`),
      read(`${OUTSIDE}/src/index.ts`),
    ] } }),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')

  const outside = await extract(outsideFile)
  const got = pathsOf(outside.turns[0])
  chk('the file under the repo is still relative to it', got.includes('src/index.ts'), got.join(', '))
  chk('the file under a home directory becomes ~, not a climb through the account name',
    got.includes('~/.claude/settings.json'), got.join(', '))
  chk('so no recorded path names the account, even here',
    !got.some((p) => p.includes(USER)), got.join(', '))
}

// Two shapes of account name, and the one that gets away.
//
// The dash-encoded form is a whole directory NAME, not a route: Claude Code
// names its own project and scratch directories after the working directory with
// the slashes turned into dashes, and no amount of prefix-cancelling touches it.
// On the corpus this was written against it was where nearly every surviving
// account name was, and it is removed. The name inside an ordinary FILENAME is
// not, and cannot be — so the tool says so instead of rounding it down.
console.log('\n── the account name in a directory name, and the one that gets away')
{
  const encFile = join(dir, 'c3d4e5f6-0000-0000-0000-000000000000.jsonl')
  const rec = (o) => ({ uuid: uuid(), timestamp: at(), sessionId: 'c3d4e5f6', cwd: CWD, version: '2.1.0', ...o })
  writeFileSync(encFile, [
    rec({ type: 'user', message: { content: [{ type: 'text', text: 'use the scratchpad' }] } }),
    rec({ type: 'assistant', message: { model: 'claude-opus-5', content: [
      // Exactly the shape Claude Code's own scratch directory has.
      read(`/private/tmp/claude-501/-Users-${USER}-git-demo-api/9f/scratchpad/probe.mjs`),
      // An ordinary directory that merely reads like one. It must survive: a
      // scrubber that eats this has gutted the feature to catch a shape the
      // relativising already handles.
      read(`${CWD}/app/home/page/index.tsx`),
      // The residue. A plan file whose NAME contains the account name.
      read(`/Users/${USER}/.claude/plans/users-${USER}-downloads-slug.md`),
    ] } }),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')

  const enc = await extract(encFile)
  const got = pathsOf(enc.turns[0])
  chk('a directory named after a home path with dashes is withheld whole',
    got.some((p) => p.includes('«path-withheld»') && p.endsWith('/scratchpad/probe.mjs')) &&
      !got.some((p) => p.includes(`-Users-${USER}`)),
    got.join(', '))
  chk('while an ordinary app/home/page survives untouched',
    got.includes('app/home/page/index.tsx'), got.join(', '))
  // Asserted, not hidden. If somebody later finds a way to remove this, this
  // assertion goes red and the sentence in the evidence package has to change
  // with it — which is the point: the wording and the data move together.
  const residue = got.filter((p) => p.includes(USER))
  chk('and a name inside a FILENAME is the one shape that survives, as documented',
    residue.length === 1 && residue[0].endsWith('-downloads-slug.md'), got.join(', '))
  chk('which the evidence package discloses rather than rounding down',
    /name is part of a FILENAME rather than of the route to it/.test(pathLimit(enc)), pathLimit(enc))
}

console.log('\n── what is not recorded, and is not claimed to be')
chk('a path named only inside a shell command is not recorded',
  !everyPath.some((p) => p.includes('hidden-by-bash')), everyPath.join(', '))
// The count and the list are different measurements over different scopes. The
// boot call before the first turn is in one and not the other, and nothing
// downstream may present either as the total of the other.
const attributed = spine.turns.flatMap((t) => t.files).reduce((n, f) => n + f.count, 0)
chk('a tool call before the first human turn is counted but attributed to nothing',
  spine.artifacts.fileTouches === attributed + 1 && !everyPath.includes('scripts/boot.mjs'),
  `fileTouches ${spine.artifacts.fileTouches}, attributed ${attributed}`)

// ------------------------------------------------- the spine says what it did

console.log('\n── the spine records WHICH it did')
chk('a default extraction says it recorded paths', spine.recordedPaths === true, String(spine.recordedPaths))
chk('--no-paths says it did not', noPaths.recordedPaths === false, String(noPaths.recordedPaths))
chk('and records none', noPaths.turns.every((t) => t.files.length === 0),
  JSON.stringify(noPaths.turns.map((t) => t.files)))
// The counter is not the feature. Turning paths off must not quietly change what
// the session-level numbers say, or two readings of one transcript disagree
// about how much work it did.
chk('while still counting the touches it did not name',
  noPaths.artifacts.fileTouches === spine.artifacts.fileTouches,
  `${noPaths.artifacts.fileTouches} vs ${spine.artifacts.fileTouches}`)
chk('and still harvesting the extensions it always did',
  JSON.stringify(noPaths.artifacts.extensions) === JSON.stringify(spine.artifacts.extensions))

// ------------------------------------------------- the sentences downstream

// A spine written before the field existed. Reconstructed by deleting it rather
// than by hand, so this is the same object every other assertion here ran
// against, minus the one thing an older extract would not have written.
const older = { ...spine }
delete older.recordedPaths
const olderEmpty = { ...older, turns: older.turns.map((t) => ({ ...t, files: [] })) }

console.log('\n── every sentence about paths agrees with what the spine holds')
{
  const on = pathLimit(spine)
  const off = pathLimit(noPaths)
  const unknownFull = pathLimit(older)
  const unknownEmpty = pathLimit(olderEmpty)

  chk('a reading that kept paths says they are here', /^FILE PATHS ARE RECORDED/.test(on), on)
  chk('and admits a shell command hides a file from it',
    /named only inside a shell command is not here/i.test(on), on)
  chk('and refuses to let the count be read as a sum of the list',
    /not a sum of what is listed/i.test(on), on)
  chk('a --no-paths reading says that, and never the opposite',
    /^FILE PATHS WERE NOT RECORDED/.test(off) && !/ARE RECORDED/.test(off), off)

  // The rule the whole three-state pattern exists for. A missing field is a
  // missing answer; reading it as "no paths" is the reassuring direction and the
  // wrong one.
  chk('a spine predating the field reads as unknown', /IS UNKNOWN/.test(unknownEmpty), unknownEmpty)
  chk('and never as "no paths were recorded"', !/WERE NOT RECORDED/.test(unknownEmpty), unknownEmpty)
  chk('and refuses to read its own silence as "no file was touched"',
    /not read the absence as evidence that no file was touched/i.test(unknownEmpty), unknownEmpty)
  // The fourth state, which a copy of the redaction test would not have: the
  // field is missing and the paths are sitting right there. "Unknown" over an
  // empty list is honest; over five paths it is its own kind of lie.
  chk('but a spine predating the field that HOLDS paths says both',
    /IS UNKNOWN, BUT 4 DISTINCT PATH\(S\) ARE HERE/.test(unknownFull), unknownFull)
  chk('and still does not promise the list is complete', /not as complete/i.test(unknownFull), unknownFull)
}

console.log('\n── the evidence package says paths are present, when they are')
const META = { generatedAt: '2026-03-04T09:15:30.000Z', fingerprint: 'a1b2c3d4', version: '9.9.9', command: '/qpact', spineAgeMin: 2 }
const memberText = (bundle, name) => bundle.members.find((m) => m.name === name)?.text ?? ''
const flat = (s) => s.replace(/\s+/g, ' ')
{
  const pkg = buildBundle(spine, null, META)
  const limits = flat(memberText(pkg, 'LIMITS.txt'))
  const session = JSON.parse(memberText(pkg, 'session.json'))
  const turns = memberText(pkg, 'turns.csv')
  const artifacts = memberText(pkg, 'artifacts.csv')
  const summary = flat(memberText(pkg, 'summary.md'))

  chk('LIMITS.txt states it outright', /FILE PATHS ARE RECORDED/.test(limits), limits.slice(0, 120))
  chk('and no longer says which file was touched is not captured',
    !/WHICH file was touched is not captured/i.test(limits))
  chk('the withheld block in session.json says the same thing',
    /FILE PATHS ARE RECORDED/.test(session.withheld.filePaths), session.withheld.filePaths)
  chk('session.json carries the path against the turn',
    session.session.turns[0].files.some((f) => f.path === 'src/index.ts' && f.count === 20),
    JSON.stringify(session.session.turns[0].files))
  chk('turns.csv carries it in a column', /src\/index\.tsx20/.test(turns),
    (turns.split('\r\n')[1] ?? '').slice(-80))
  chk('artifacts.csv rolls it up', artifacts.includes('file,src/index.ts,20,session'),
    artifacts.split('\r\n').filter((r) => r.startsWith('file,')).join(' | '))
  chk('the summary stops calling the file count a count only',
    /Files touched \| 24 tool call\(s\) named a file; 4 distinct path\(s\) recorded against turns/.test(summary),
    (memberText(pkg, 'summary.md').split('\n').find((l) => l.startsWith('| Files touched')) ?? ''))
  // The package exists to be forwarded. Every assertion above is worthless if
  // the paths carried the account name into it.
  for (const m of pkg.members)
    chk(`${m.name}: the account name is nowhere in it`, !m.text.includes(USER),
      m.text.slice(Math.max(0, m.text.indexOf(USER) - 40), m.text.indexOf(USER) + 40))
}
{
  const pkg = buildBundle(noPaths, null, META)
  const limits = flat(memberText(pkg, 'LIMITS.txt'))
  const artifacts = memberText(pkg, 'artifacts.csv')
  chk('a --no-paths package says so instead', /FILE PATHS WERE NOT RECORDED/.test(limits), limits.slice(0, 120))
  chk('and never claims paths are recorded', !/FILE PATHS ARE RECORDED/.test(limits))
  chk('and has no file rows to roll up', !artifacts.split('\r\n').some((r) => r.startsWith('file,')),
    artifacts.split('\r\n').filter((r) => r.startsWith('file')).join(' | '))
}
{
  const pkg = buildBundle(olderEmpty, null, META)
  const limits = flat(memberText(pkg, 'LIMITS.txt'))
  chk('and a package built from a spine predating the field says it cannot tell',
    /WHETHER FILE PATHS WERE RECORDED IS UNKNOWN/.test(limits) && !/WERE NOT RECORDED\./.test(limits),
    limits.slice(0, 160))
}

console.log('\n── /qshare reports what it measured, and never zero for what it did not')
// The share picker told the reader "absolute paths and your username are
// stripped before anything leaves". That sentence is about the payload and it is
// still true of the payload — but a reader applies it to the whole tool, and the
// tool now keeps file paths. The page says so, and the number beside it is
// COUNTED in the bytes it is about to offer rather than asserted: an assertion
// about what a payload does not contain rots the first time somebody widens the
// producer, and nobody re-reads the comment when they do.
{
  const carrying = describePayload({ turns: [{ files: [{ path: 'src/a.ts', count: 2 }] }] })
  const empty = describePayload({ project: { name: 'demo', sessions: 3 } })
  chk('a payload carrying a recorded path is counted', carrying.filePaths === 1, JSON.stringify(carrying))
  chk('and one carrying none counts none', empty.filePaths === 0, JSON.stringify(empty))

  const row = (over) => ({
    ref: 'demo', name: 'demo', cwd: '/x/demo', sessions: 3, turns: 9,
    bytes: 1000, textFields: 2, ambiguous: false, harnesses: [['claude-code', 3]], ...over,
  })
  const page = pickerPage([row({ filePaths: 0 })], 'nonce', new Set())
  const unknown = pickerPage([row({ filePaths: undefined })], 'nonce', new Set())
  chk('the page still carries the sentence it has always carried',
    page.includes('Absolute paths and your username are stripped before anything leaves'))
  chk('and now says the local reading records which files a turn touched',
    /local reading also records which files each turn touched/i.test(page))
  chk('with the number it measured in the payloads on it',
    /0 of the fields in the payloads on this page name one/.test(page),
    (page.match(/name one[^<]*/) || [])[0])
  // Zero and "not measured" are different facts, and only one of them is a
  // reassurance. A row whose payload would not build is the case that used to
  // be shown as zeros.
  chk('and a payload it could not measure reported as unmeasured rather than zero',
    /were not measured, and are not being reported as zero/.test(unknown) &&
      !/0 of the fields in the payloads on this page name one/.test(unknown),
    (unknown.match(/not measured[^<]*/) || [])[0])
}

// ---------------------------------- a home directory reached the long way round
//
// The climb only cancels the account name when the working directory and the
// file share a home root. A session run from a worktree in /private/tmp shares
// nothing with a file under `~`, so the `..` walk goes up over the home root and
// back DOWN through it, and the name lands in the middle of a path that is
// relative and therefore looks like every safe value beside it.
//
// The guard for that used to read the FIRST segment of the path and ask whether
// it was `Users` or `home`. Every shape below is a real home directory whose
// first segment is something else: `/System/Volumes/Data/Users/<name>` is what
// macOS resolves any home file to and what `realpath` prints, an external disk
// gives `/Volumes/<disk>/Users/<name>`, an automounter `/net/<host>/home/<name>`,
// and a Windows path reaches `Users` only after a drive letter — so on Windows
// the guard could never fire at all.
{
  const OUT = '/private/tmp/wt/api'
  const f2 = join(dir, 'b2c3d4e5-0000-0000-0000-000000000000.jsonl')
  let c2 = Date.parse('2026-03-05T08:00:00.000Z')
  let s2 = 0
  const b2 = () => ({
    uuid: `v-${++s2}`, timestamp: new Date((c2 += 1000)).toISOString(),
    sessionId: 'b2c3d4e5-0000-0000-0000-000000000000', cwd: OUT, version: '2.1.0',
  })
  const recs = [
    { ...b2(), type: 'user', message: { content: [{ type: 'text', text: 'check my dotfiles' }] } },
    {
      ...b2(), type: 'assistant',
      message: {
        model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: `/System/Volumes/Data/Users/${USER}/.zshrc` } },
          { type: 'tool_use', name: 'Read', input: { file_path: `/Volumes/Backup/Users/${USER}/notes.md` } },
          { type: 'tool_use', name: 'Read', input: { file_path: `/net/host/home/${USER}/x.ts` } },
          { type: 'tool_use', name: 'Read', input: { file_path: `${OUT}/src/a.ts` } },
          // `path` on somebody else's schema. An MCP tool's `path` is as likely
          // to be an HTTP route as a file, and a route relativised against the
          // working directory comes out reading exactly like a repo file.
          { type: 'tool_use', name: 'mcp__gateway__request', input: { method: 'GET', path: '/v1/customers/4821/invoices' } },
        ],
      },
    },
  ]
  writeFileSync(f2, recs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const out = await extract(f2)
  const got = (out.turns[0]?.files ?? []).map((f) => f.path)

  console.log('\n── a home directory reached through a mount point still loses its account name')
  chk('no recorded path names the account', !got.some((x) => x.includes(USER)), got.join(' | '))
  chk('the macOS firmlink route is cut at the home root', got.includes('~/.zshrc'), got.join(' | '))
  chk('so is a home directory on another volume', got.includes('~/notes.md'), got.join(' | '))
  chk('and one reached through an automounter', got.includes('~/x.ts'), got.join(' | '))
  // The point of the whole feature has to survive the fix: a file that really is
  // in the working directory is still recorded plainly.
  chk('a file inside the working directory is untouched by any of it', got.includes('src/a.ts'), got.join(' | '))
  chk('and nothing climbed back down through a home root',
    !got.some((x) => /(?:^|\/)(?:Users|home)\//i.test(x)), got.join(' | '))
  // Not a file, and now that the value is stored rather than counted, saying so
  // matters: this would be listed on the page under the files a turn touched.
  chk('an MCP route is not recorded as a file this turn touched',
    !got.some((x) => x.includes('customers')), got.join(' | '))

  // Windows, read on this machine. A transcript is read wherever it is opened,
  // so the writer's platform is whatever the strings say it is.
  const f3 = join(dir, 'c3d4e5f6-0000-0000-0000-000000000000.jsonl')
  let c3 = Date.parse('2026-03-06T08:00:00.000Z')
  let s3 = 0
  const b3 = () => ({
    uuid: `w-${++s3}`, timestamp: new Date((c3 += 1000)).toISOString(),
    sessionId: 'c3d4e5f6-0000-0000-0000-000000000000', cwd: 'C:\\dev\\api', version: '2.1.0',
  })
  const wrecs = [
    { ...b3(), type: 'user', message: { content: [{ type: 'text', text: 'read my claude config' }] } },
    {
      ...b3(), type: 'assistant',
      message: {
        model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: `C:\\Users\\${USER}\\.claude\\CLAUDE.md` } },
          // Two accounts on two disks. Counting `..` between them invented a
          // relationship and produced a path that both named the account and
          // resolved nowhere.
          { type: 'tool_use', name: 'Read', input: { file_path: `D:\\Users\\${USER}\\other.ts` } },
        ],
      },
    },
  ]
  writeFileSync(f3, wrecs.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const wout = await extract(f3)
  const wgot = (wout.turns[0]?.files ?? []).map((f) => f.path)
  chk('a Windows home path loses its account name too', !wgot.some((x) => x.includes(USER)), wgot.join(' | '))
  chk('and a second drive is not walked to with `..`',
    !wgot.some((x) => /\.\.\/.*[A-Za-z]:/.test(x)), wgot.join(' | '))
}

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
