// The consent gate on /qpact's cloud shipping, asserted against the wire.
//
// NOTE ON THE NAME: this tests scripts/push.mjs. It is not a test of
// scripts/ship.mjs, which is /qship's prompt harvester and an unrelated thing.
//
// The design being guarded is a single sentence: nothing about a session leaves
// this machine unless the user was shown, in full, what would leave. Four ways
// that sentence can quietly stop being true, and one assertion for each:
//
//   IT SHIPS WITHOUT BEING TURNED ON. The worst case, and the easiest to reach
//   by accident — a `token` appearing in config.json is not consent, and a
//   default that flips to on during an upgrade is not consent either.
//
//   IT IS TURNED ON WITHOUT THE DISCLOSURE BEING SHOWN. The write and the print
//   are one call in push.mts precisely so this cannot happen; the test holds
//   that by checking the printed lines name every field before the switch moves.
//
//   A FIELD LEAVES THAT THE DISCLOSURE DID NOT NAME. This is the one that
//   matters, and it is the one a spot-check cannot catch: `payload.cwd = ...`
//   added a year from now would sail past any test that asserts three known
//   fields are present. So the received body is WALKED, and the complete set of
//   key paths on the wire is compared against the complete set named in the
//   text the human read. Extra paths and missing paths both fail.
//
//   A FAILED UPLOAD LOOKS LIKE A SUCCESSFUL ONE. A report the user believes is
//   in the cloud and is not is worse than one that was never sent, so every
//   refusal path is exercised for a named reason, a local file left untouched,
//   and no rejection escaping into the command that already rendered the page.
//
// Everything is asserted against the request the server RECEIVED, never against
// a second call to the function that built it. The key-path walker below is the
// test's own, deliberately not push.mjs's `keyPaths`: sharing the walker would
// let one bug hide the leak and the check for it at the same time.
//
// The report document is a fixture rather than a real render. What that buys is
// an adversarial one -- a `</script>`, four-byte characters, a home path, an
// address -- and byte-identity is then a claim about transport, which is what
// the design rests on. What it does not prove is that render.mjs's real output
// survives; test/reports.mjs owns the page itself.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

// Point config resolution at a scratch directory BEFORE importing anything that
// reads it. SESSION_VIZ_HOME is cleared because it outranks everything in
// home.mjs -- inherited from a real shell it would send these writes into the
// user's actual config directory.
const home = mkdtempSync(join(tmpdir(), 'qpact-ship-'))
mkdirSync(join(home, '.config', 'session-viz'), { recursive: true })
delete process.env.SESSION_VIZ_HOME
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.HOME = home
process.env.SESSION_VIZ_ACTOR = 'claude-code'

const {
  shipReport, turnOn, turnOff, isOn, loadPush, offReason,
  STATE_SCHEMA_VERSION, credentialFingerprint, canRecord, pushPaths,
  standingDisclosure, disclosureDigest, pushTarget,
  FIELDS, HEADERS, REPORT_PATH, SCHEMA_VERSION, MAX_DOCUMENT_BYTES,
} = await import('../scripts/push.mjs')

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

/**
 * shipReport promises never to reject, and that promise is the whole of "a
 * failure to ship must not stop the local render": by the time it runs the page
 * is written and open, so a rejection escaping here turns a failed upload into
 * a failed command.
 *
 * Caught and reported by name. Left uncaught it would surface as an unhandled
 * rejection -- a stack trace, a dead process, and no assertion saying which
 * guarantee broke.
 */
const ship = async (args) => {
  try {
    return await shipReport(args)
  } catch (e) {
    chk(`shipReport rejected instead of reporting: ${args.label || args.reportPath}`, false, String(e?.message))
    return { shipped: false, reason: `REJECTED: ${e?.message}`, lines: [], url: '' }
  }
}

// A test that hangs reports nothing at all, which is indistinguishable from a
// test that was never run. Every request below carries its own timeout; this is
// the backstop for the ones that do not fail the way they are supposed to.
const watchdog = setTimeout(() => {
  console.error('\nFAIL — the suite hung. Something is waiting on a socket that never answered.')
  process.exit(1)
}, 60_000)
watchdog.unref()

// ------------------------------------------------------------------ the stub

/** Records what actually arrived. `mode` decides how the server answers, so one
 *  server covers accept, refuse, over-quota and never-answers. */
function stub() {
  const calls = []
  const sockets = new Set()
  let mode = 'ok'
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: { ...req.headers }, body })
      if (mode === 'hang') return // deliberately no response, ever
      // Deliberately does NOT contain the words the assertion looks for. With a
      // body that said "over quota", the check downstream passed even with the
      // status classification removed -- it was reading the server's wording
      // back to itself. The phrase has to come from push.mjs or from nowhere.
      if (mode === 'quota') { res.writeHead(402, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'plan limit reached for this billing period' })) }
      if (mode === 'refuse') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'storage backend unavailable' })) }
      if (mode === 'noid') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'rep_x9k2', url: `http://127.0.0.1:${port}/r/rep_x9k2`, bytes: body.length }))
    })
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  let port = 0
  return {
    calls,
    setMode: (m) => { mode = m },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(`http://127.0.0.1:${port}`) })),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  }
}

// --------------------------------------------------------------- the fixtures

const SECRET_PROMPT = 'rewrite the auth middleware, it is dropping the session cookie'
const HOME_IN_PROMPT = join(homedir(), 'git', 'private-client', 'src', 'auth.ts')
const EMAIL_IN_PROMPT = 'someone@example.com'

// Adversarial on purpose: a closing script tag, a four-byte character, and both
// of the shapes the disclosure says travel unrewritten. If any layer between
// here and the socket re-encodes or rewrites, byte-identity fails and says so.
//
// The trailing newline is load-bearing and was missing at first. Without it the
// document had nothing to trim, so `readFileSync(...).trim()` -- the single most
// likely accidental mutation, and the one that makes the console page stop
// being the page on the screen -- slipped past every assertion here. Real files
// end in a newline; so does this one, and now the difference is visible.
const REPORT_HTML = `<!doctype html><html><head><title>qpact</title></head><body>
<pre>${SECRET_PROMPT}</pre>
<pre>look at ${HOME_IN_PROMPT} and mail ${EMAIL_IN_PROMPT}</pre>
<script>var s = "</scr" + "ipt>"; var g = "\u{1F600}";</script>
${'<p>padding to make this a document rather than a snippet.</p>\n'.repeat(2000)}
</body></html>
`

const reportPath = join(home, 'qpact-report.html')
writeFileSync(reportPath, REPORT_HTML, { mode: 0o600 })

const spinePath = join(home, 'qpact-spine.json')
writeFileSync(spinePath, JSON.stringify({
  sessionId: 'sess-abc-123',
  cwd: join(homedir(), 'git', 'private-client'),
  gitBranch: 'claude/auth-fix',
  harness: 'claude-code',
  redactedPrompts: true,
  turns: [{ index: 0, text: SECRET_PROMPT }, { index: 1, text: 'again' }],
}))

const sha = (s) => createHash('sha256').update(s).digest('hex')
const fileState = (p) => ({ sha: sha(readFileSync(p, 'utf8')), size: statSync(p).size })
const reportBefore = fileState(reportPath)

/**
 * Every leaf key path in a value, dotted, arrays marked with `[]`.
 *
 * The test's own, on purpose. push.mjs walks the payload with the same idea to
 * refuse an undisclosed field at runtime; if this called that one, a walker
 * that skipped a branch would make the runtime guard blind and this assertion
 * agree with it.
 */
function paths(v, prefix = '') {
  if (Array.isArray(v)) {
    const at = `${prefix}[]`
    return [at, ...v.flatMap((x) => paths(x, at))]
  }
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => paths(x, prefix ? `${prefix}.${k}` : k))
  }
  return prefix ? [prefix] : []
}

const server = stub()
const base = await server.listen()
process.env.SESSION_VIZ_URL = base
process.env.SESSION_VIZ_TOKEN = 'svt_test_token'

// ------------------------------------------------- 1. off, and off for a token
{
  chk('a machine that has never been asked is off', isOn() === false)
  chk('and has no state file to be read wrongly', !existsSync(pushTarget()))

  // A token is present in the environment right now. It is not consent.
  const r = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('nothing is sent when the switch is off', server.calls.length === 0, `${server.calls.length} request(s) reached the server`)
  chk('and the result says so rather than pretending', r.shipped === false && /off/i.test(r.reason), r.reason)
  chk('and the line a user reads names the local report as local only',
    r.lines.some((l) => /local only/i.test(l)), r.lines.join('\n'))
  chk('a token existing did not turn anything on', isOn() === false)
}

// ------------------------------- 2. the switch cannot move without the print
{
  const offered = turnOn({ confirmed: false })
  const text = offered.lines.join('\n')
  chk('offering the switch prints the disclosure', text.length > 500, `${text.length} chars`)
  chk('every field that can leave is named in it',
    FIELDS.every((f) => text.includes(f.path)),
    FIELDS.filter((f) => !text.includes(f.path)).map((f) => f.path).join(', '))
  chk('every header that can leave is named in it',
    HEADERS.every((h) => text.includes(h.path)),
    HEADERS.filter((h) => !text.includes(h.path)).map((h) => h.path).join(', '))
  chk('it says the page carries every prompt', /full text of every prompt/i.test(text))
  chk('it says the home-path rewrite does NOT apply', /unrewritten/i.test(text))
  chk('it names the destination it would send to', text.includes(base), base)
  chk('offering it does not turn it on', offered.on === false && isOn() === false)
  chk('and writes nothing', !existsSync(pushTarget()))

  const on = turnOn({ confirmed: true })
  chk('confirming turns it on', on.on === true && isOn() === true)
  chk('and the same call printed the disclosure again',
    FIELDS.every((f) => on.lines.join('\n').includes(f.path)))
  chk('the consent record is not world-readable',
    (statSync(pushTarget()).mode & 0o777) === 0o600, (statSync(pushTarget()).mode & 0o777).toString(8))

  const rec = loadPush()
  chk('the record binds to the destination', rec.url === base, String(rec.url))
  chk('and to the digest of what was shown', rec.disclosure.sha256 === disclosureDigest(), rec.disclosure.sha256)
}

// ------------------------ 2b. consent that no longer matches is not consent
{
  const good = loadPush()

  // An update that adds a field to the payload changes the disclosure, so the
  // stored digest stops matching. Modelled by storing a digest of a DIFFERENT
  // text, which is exactly the state such an update would leave behind.
  writeFileSync(pushTarget(), JSON.stringify({
    ...good,
    disclosure: { version: '1', sha256: disclosureDigest([...standingDisclosure(), '    payload.cwd    your working directory']) },
  }))
  chk('consent given to an older disclosure does not carry over', isOn() === false)
  chk('and the reason says what changed', /has changed/i.test(offReason()), offReason())
  const r = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('a lapsed consent sends nothing', server.calls.length === 0 && r.shipped === false, `${server.calls.length} call(s)`)

  // Forged outright: enabled, but no record of anything having been shown.
  writeFileSync(pushTarget(), JSON.stringify({ schema_version: SCHEMA_VERSION, enabled: true }))
  chk('an enabled flag with no disclosure record is not on', isOn() === false)

  // Unparseable reads as off, not as on.
  writeFileSync(pushTarget(), '{ not json')
  chk('a corrupt consent file fails closed', isOn() === false)

  writeFileSync(pushTarget(), JSON.stringify(good), { mode: 0o600 })
  chk('restored to genuinely on', isOn() === true)
}

// ------------------- 3. no field leaves that the disclosure did not name
{
  server.setMode('ok')
  const r = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('a report ships when the switch is on', r.shipped === true, r.reason)
  chk('exactly one request went out', server.calls.length === 1, String(server.calls.length))

  // Guarded rather than assumed. When an upstream guard correctly refuses a
  // send, nothing arrives -- and reading `server.calls[0].url` off an empty
  // array throws a TypeError, which exits with a stack trace instead of the
  // assertion that would have said which rule fired. A break has to be legible.
  const call = server.calls[0]
  if (!call) {
    chk('the wire assertions have a request to read', false, 'nothing reached the server; the assertions below could not run')
  } else {

  chk('it went to the endpoint the disclosure names', call.url === REPORT_PATH && call.method === 'POST', `${call.method} ${call.url}`)

  const wire = JSON.parse(call.body)
  const disclosure = standingDisclosure().join('\n')

  // THE ASSERTION. Not "these three fields are present" -- the complete set of
  // key paths that arrived, against the complete set the human was shown.
  const arrived = [...new Set(paths(wire))].sort()
  const named = FIELDS.map((f) => f.path).sort()
  const extra = arrived.filter((p) => !named.includes(p))
  const missing = named.filter((p) => !arrived.includes(p))
  chk('every key path on the wire was named in the disclosure', extra.length === 0, `undisclosed: ${extra.join(', ')}`)
  chk('and every path the disclosure names actually arrived', missing.length === 0, `promised but absent: ${missing.join(', ')}`)
  chk('each arrived path appears in the text the human read',
    arrived.every((p) => disclosure.includes(p)),
    arrived.filter((p) => !disclosure.includes(p)).join(', '))

  // Headers are payload too. Transport headers the runtime adds are excluded by
  // name, each for a stated reason, so anything NEW shows up as a failure
  // rather than being swept into a wildcard.
  const TRANSPORT = new Set([
    'host',            // the destination, which is the disclosed url
    'connection',      // socket management
    'content-length',  // the length of the disclosed body
    'accept',          // undici's default */*
    'accept-encoding', // undici's default
    'accept-language', // undici's default
    'sec-fetch-mode',  // undici's default
    'user-agent',      // undici's default node/undici string
  ])
  const disclosedHeaders = new Set(HEADERS.map((h) => h.path))
  const strayHeaders = Object.keys(call.headers).filter((h) => !TRANSPORT.has(h) && !disclosedHeaders.has(h))
  chk('no undisclosed header carries anything', strayHeaders.length === 0, strayHeaders.join(', '))
  chk('the disclosed headers are the ones actually sent',
    call.headers.authorization === 'Bearer svt_test_token' && call.headers['x-actor'] === 'claude-code',
    JSON.stringify({ a: call.headers.authorization, x: call.headers['x-actor'] }))

  // The property the whole architecture rests on: what is in the console is the
  // file on this machine, byte for byte. Compared against the file on disk, not
  // against the string this test built.
  const onDisk = readFileSync(reportPath, 'utf8')
  chk('the document is byte-identical to the local report',
    wire.document.html === onDisk, `${wire.document.html.length} vs ${onDisk.length} chars`)
  chk('and its declared sha256 is the sha256 of those bytes', wire.document.sha256 === sha(onDisk), wire.document.sha256)
  chk('and its declared length is that length', wire.document.bytes === Buffer.byteLength(onDisk, 'utf8'))

  // The envelope must be metadata only. Everything sensitive lives in the one
  // field the disclosure shouts about, and nowhere else.
  const envelope = JSON.stringify({ ...wire, document: { ...wire.document, html: '' } })
  chk('no prompt text is in the envelope', !envelope.includes(SECRET_PROMPT))
  chk('no home path is in the envelope', !envelope.includes(homedir()), envelope.slice(0, 300))
  chk('no email is in the envelope', !envelope.includes(EMAIL_IN_PROMPT))
  chk('the repo name survives, because the console needs it', wire.repo === 'private-client', String(wire.repo))
  chk('the branch survives, as the disclosure says it does', wire.branch === 'claude/auth-fix', String(wire.branch))

  }

  // Where it went, said out loud, on the send itself.
  chk('the command says where the report went', !!r.url && r.lines.some((l) => l.includes(r.url)), r.lines.join('\n'))
  chk('and how to turn it off', r.lines.some((l) => /--off/.test(l)))
  chk('and it discloses the per-report counts before sending',
    r.lines.some((l) => /home directory path appears \d+ time/.test(l)), r.lines.join('\n'))
  chk('and reuses bundle.mjs\'s sentence about secret redaction',
    r.lines.some((l) => /secret patterns/.test(l)), r.lines.join('\n'))
}

// ------------------------ 4. failure is loud, and the local report survives
{
  const before = server.calls.length

  server.setMode('quota')
  const quota = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('an over-quota tenant is reported as over quota',
    quota.shipped === false && /over quota/i.test(quota.reason), quota.reason)
  chk('and what the server actually said is carried through too',
    /plan limit reached/.test(quota.reason), quota.reason)
  chk('and it is not mistaken for a bad token', !/token/i.test(quota.reason), quota.reason)
  chk('and the failure is printed, not swallowed', quota.lines.some((l) => /NOT SHIPPED/.test(l)), quota.lines.join('\n'))

  server.setMode('refuse')
  const refused = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('a server error is reported with what the server said',
    refused.shipped === false && /storage backend unavailable/.test(refused.reason), refused.reason)

  server.setMode('noid')
  const noid = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('a 200 with no id is a failure, not a silent success',
    noid.shipped === false && /no id/i.test(noid.reason), noid.reason)

  server.setMode('hang')
  const t0 = Date.now()
  const hung = await ship({ spinePath, reportPath, timeoutMs: 700 })
  const elapsed = Date.now() - t0
  chk('a server that never answers times out instead of hanging',
    hung.shipped === false && /did not answer/i.test(hung.reason), hung.reason)
  chk('and gives up in about the time it was given', elapsed < 5000, `${elapsed}ms`)
  server.setMode('ok')

  // Nothing above touched the file /qpact wrote and opened.
  const after = fileState(reportPath)
  chk('the local report is untouched by every failure',
    after.sha === reportBefore.sha && after.size === reportBefore.size,
    `${reportBefore.sha.slice(0, 12)} -> ${after.sha.slice(0, 12)}`)
  chk('and every failure came back as a value, never a rejection',
    server.calls.length === before + 4, `${server.calls.length - before} requests for 4 attempts`)
}

// ------------------------------ 4b. refusals that never reach the network
{
  const before = server.calls.length

  // Consent was to a host. An environment variable moving the destination does
  // not inherit it.
  process.env.SESSION_VIZ_URL = 'http://127.0.0.1:9'
  const moved = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('a changed destination refuses before connecting',
    moved.shipped === false && moved.reason.includes(base) && moved.reason.includes('127.0.0.1:9'), moved.reason)
  chk('and nothing was sent anywhere', server.calls.length === before, String(server.calls.length - before))
  process.env.SESSION_VIZ_URL = base

  // Shipping on, credential gone. Loud, and pointed at the fix.
  const token = process.env.SESSION_VIZ_TOKEN
  delete process.env.SESSION_VIZ_TOKEN
  delete process.env.SESSION_VIZ_URL
  const noToken = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('shipping on with no token says so, and says how to fix it',
    noToken.shipped === false && /qsetup/i.test(noToken.lines.join('\n')), noToken.lines.join('\n'))
  chk('and does not read as "off"', !/shipping is off/i.test(noToken.reason), noToken.reason)
  process.env.SESSION_VIZ_TOKEN = token
  process.env.SESSION_VIZ_URL = base

  // Too large to send. Refused here, where the message can name the file and
  // the number, rather than as an HTTP 413 from a server the user cannot read.
  const huge = join(home, 'qpact-huge.html')
  writeFileSync(huge, 'x'.repeat(MAX_DOCUMENT_BYTES + 1), { mode: 0o600 })
  const oversize = await ship({ spinePath, reportPath: huge, timeoutMs: 3000 })
  chk('an oversized report is refused before the socket, by name',
    oversize.shipped === false && /over the 8 MB limit/.test(oversize.reason), oversize.reason)
  chk('and says the local report is unaffected',
    oversize.lines.some((l) => /unaffected|Nothing was sent/i.test(l)), oversize.lines.join('\n'))

  // A host that is not listening at all.
  const good = loadPush()
  writeFileSync(pushTarget(), JSON.stringify({ ...good, url: 'http://127.0.0.1:9' }), { mode: 0o600 })
  process.env.SESSION_VIZ_URL = 'http://127.0.0.1:9'
  const dead = await ship({ spinePath, reportPath, timeoutMs: 4000 })
  chk('an unreachable host names the host it could not reach',
    dead.shipped === false && dead.reason.includes('127.0.0.1:9'), dead.reason)
  chk('and says the local report is unaffected',
    dead.lines.some((l) => /unaffected/i.test(l)), dead.lines.join('\n'))
  process.env.SESSION_VIZ_URL = base
  writeFileSync(pushTarget(), JSON.stringify(good), { mode: 0o600 })

  chk('none of that reached the network', server.calls.length === before, String(server.calls.length - before))
}

// ----------------------------------------------- 5. turning it off stops it
{
  server.setMode('ok')
  const on = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('still shipping before it is turned off', on.shipped === true, on.reason)
  const sent = server.calls.length

  const off = turnOff()
  chk('turning it off says the next run sends nothing', off.lines.some((l) => /sends nothing/i.test(l)))
  chk('and the switch reads off immediately', isOn() === false)

  const after = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('nothing is sent once it is off', server.calls.length === sent, `${server.calls.length - sent} request(s) after --off`)
  chk('and the run says the report stayed local', after.shipped === false && /off/i.test(after.reason), after.reason)

  chk('turning it off does not silently delete what was already sent',
    off.lines.some((l) => /does not/i.test(l)), off.lines.join('\n'))
}

// ── The local record, which is where a "no" has to survive ───────────────
//
// Three ways the record can stop meaning what it says. All three are safe under
// an opt-in default, because every one of them fails to "off" — and all three
// stop being safe the moment the default ships, at which point the file will
// already have been written by a version that did not distinguish them.

console.log(`\n── ` + 'The state file and the wire have separate versions')
{
  chk('they are separate constants', typeof STATE_SCHEMA_VERSION === 'string' && typeof SCHEMA_VERSION === 'string')
  const path = pushTarget()
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  chk('the record carries the STATE version, not the wire one',
    raw.schema_version === STATE_SCHEMA_VERSION, JSON.stringify(raw.schema_version))
  // The failure this prevents: the wire version is bumped for a payload change
  // — the facts sidecar — and every push.json in the install base is discarded
  // with it, taking every standing opt-out.
  chk('a wire-version bump would not touch this file',
    raw.schema_version === STATE_SCHEMA_VERSION,
    'if these were one constant, a payload change would silently discard every recorded choice')
}

console.log(`\n── ` + 'An unreadable record is a NO, not an absence')
{
  const path = pushTarget()
  const keep = readFileSync(path, 'utf8')
  writeFileSync(path, '{ this is not json')
  const broken = loadPush()
  chk('it does not ship', isOn(broken) === false)
  chk('and it is reported as unreadable, not as absent', broken.origin === 'unreadable', String(broken.origin))

  writeFileSync(path, JSON.stringify({ schema_version: 'from-the-future', enabled: true }))
  const future = loadPush()
  chk('a version this build does not know is unreadable too', future.origin === 'unreadable', String(future.origin))
  chk('and is not treated as consent', isOn(future) === false)

  // Restored, and asserted against what the file actually says rather than
  // against a remembered state — the section before this one leaves shipping
  // off, and an assertion that assumed otherwise would be testing the order of
  // this file rather than the reader.
  writeFileSync(path, keep)
  const want = JSON.parse(keep).enabled ? 'consented' : 'opted-out'
  chk(`a parseable record reads as ${want}, from the file and not from a default`,
    loadPush().origin === want, `${loadPush().origin} (file says enabled=${JSON.parse(keep).enabled})`)
}

// The reader/writer asymmetry needs a HOME of its own to be reachable at all —
// the write target is the first candidate in this suite's layout, so a stale
// copy in a later directory could never win and an assertion here would prove
// nothing. It lives in test/push-state.mjs, which builds the legacy layout.

console.log(`\n── ` + 'A machine that cannot record a choice is a machine that must not ship')
{
  chk('canRecord is true here, where the scratch home is writable', canRecord() === true)
}

console.log(`\n── ` + 'Consent is bound to the workspace, not to the hostname')
{
  const on = turnOn({ confirmed: true })
  chk('shipping is on again', on.on === true, on.lines.join('\n'))
  const rec = loadPush()
  chk('the record fingerprints the credential', !!rec.credential?.fingerprint, JSON.stringify(rec.credential))
  chk('and never stores the credential itself',
    !JSON.stringify(rec).includes(process.env.SESSION_VIZ_TOKEN || '\u0000nope'),
    'the token must not be recoverable from the state file')
  chk('the fingerprint is a fingerprint, not a token',
    /^[0-9a-f]{16}$/.test(rec.credential?.fingerprint || ''), String(rec.credential?.fingerprint))
  chk('two different tokens fingerprint differently',
    credentialFingerprint('token-a') !== credentialFingerprint('token-b'))

  // The assertion that matters: a different workspace at the SAME host. The
  // url check above cannot see this, because the url is identical.
  const was = process.env.SESSION_VIZ_TOKEN
  process.env.SESSION_VIZ_TOKEN = 'svt_a_completely_different_workspace'
  const swapped = await ship({ spinePath, reportPath, timeoutMs: 3000, label: 'swapped-credential' })
  chk('a send with a different credential is refused', swapped.shipped === false, JSON.stringify(swapped.reason))
  chk('and the refusal says it is about consent, not about the network',
    /credential changed/i.test(String(swapped.reason)), String(swapped.reason))
  chk('and it names which kind of credential each was',
    swapped.lines.some((l) => /file credential|env credential/i.test(l)), swapped.lines.join('\n'))
  process.env.SESSION_VIZ_TOKEN = was
  const restored = await ship({ spinePath, reportPath, timeoutMs: 3000, label: 'restored-credential' })
  chk('and the original credential still ships', restored.shipped === true, JSON.stringify(restored.reason))
}

await server.close()
clearTimeout(watchdog)
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
