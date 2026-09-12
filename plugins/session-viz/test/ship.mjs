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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const { INDEX_FIELDS, keyPaths } = await import('../scripts/facts.mjs')

const {
  shipReport, turnOn, turnOff, isOn, loadPush, offReason,
  STATE_SCHEMA_VERSION, credentialFingerprint, canRecord, pushPaths, skipSession, optOut,
  standingDisclosure, disclosureDigest, pushTarget, FACTS_PATH, withholdDocument,
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
    // Every send in this file is standing in for a person at a terminal running
    // /qpact. The gate treats a print with nothing attached to read it as not a
    // showing, which is correct and is exercised deliberately in its own section
    // below — it must not be the accidental state of every other assertion here.
    return await shipReport({ isTty: true, ...args })
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
  let terms = null
  let factsMode = null
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: { ...req.headers }, body })
      // The terms GET is answered for real in 'ok' mode: the send path fetches
      // it before the POST, and the printed table is asserted below. In every
      // other mode it falls through with the rest, which is how "the host could
      // not be asked" gets exercised.
      // A host having a bad day cannot answer this either, and the send path has
      // to fall back to the cache rather than parsing an error body as terms.
      if (req.url === '/v1/qpact/terms' && mode !== 'ok') {
        res.writeHead(503, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'unavailable' }))
      }
      if (mode === 'ok' && req.url === '/v1/qpact/terms') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(terms ?? {
          host: 'stub', retentionDays: 90, holdDays: 14,
          scopes: ['private', 'admins', 'workspace'], tracePriced: true,
        }))
      }
      // The sidecar can be refused on its own, which is the case that proves the
      // document's success is not conditional on it.
      if (factsMode === 'refuse' && req.url === '/v1/qpact/facts') {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'refused for the test' }))
      }
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
    setTerms: (t) => { terms = t },
    setFactsMode: (m) => { factsMode = m },
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
// A connected machine, the way /qsetup leaves one: a config file and nothing in
// the environment. The credential used to be exported here, which is the thing
// the plugin no longer accepts from anywhere.
const CONFIG = join(home, '.config', 'session-viz', 'config.json')
const connect = (url = base, token = 'svt_test_token') =>
  writeFileSync(CONFIG, JSON.stringify({ url, token, scope: 'collab', tenant: 't_test' }), { mode: 0o600 })
const disconnect = () => { if (existsSync(CONFIG)) rmSync(CONFIG) }
connect()

// ------------------------------------------------- 1. off, and off for a token
{
  chk('a machine that has never been asked is off', isOn() === false)
  chk('and has no state file to be read wrongly', !existsSync(pushTarget()))

  // A token is present in the environment right now. It is not consent.
  const r = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('nothing is sent when the switch is off', server.calls.length === 0, `${server.calls.length} request(s) reached the server`)
  chk('and the result says why, in the gate\u2019s own words',
    r.shipped === false && /has not been shown/i.test(r.reason), r.reason)
  // The first run is where the disclosure is printed. It is not a refusal that
  // points elsewhere — it is the showing itself, and it says so.
  chk('the disclosure is printed in that same run',
    FIELDS.every((f) => r.lines.join('\n').includes(f.path)),
    FIELDS.filter((f) => !r.lines.join('\n').includes(f.path)).map((f) => f.path).join(', '))
  chk('and it says plainly that this run sent nothing',
    r.lines.some((l) => /Nothing has been sent yet, including this run/i.test(l)), r.lines.join('\n'))
  chk('it names both ways to stop it',
    /--off/.test(r.lines.join('\n')) && /--skip/.test(r.lines.join('\n')), r.lines.join('\n'))
  // Under a default that ships, the first run is the showing — so afterwards
  // this machine WILL send. That is the reversal, asserted rather than implied.
  chk('having been shown once, the next run would ship', isOn() === true, offReason())
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
  chk('offering it records no acceptance', offered.on === false)
  // A record already exists — the first run wrote one when it printed. What the
  // preview must not do is CHANGE it, which is a different assertion from "no
  // file exists" and is the one that still means something.
  const beforePreview = readFileSync(pushTarget(), 'utf8')
  turnOn({ confirmed: false })
  chk('and changes nothing that was already recorded',
    readFileSync(pushTarget(), 'utf8') === beforePreview)

  const on = turnOn({ confirmed: true })
  chk('confirming records that it was read',
    on.on === true && loadPush().origin === 'consented', String(loadPush().origin))
  chk('and the same call printed the disclosure again',
    FIELDS.every((f) => on.lines.join('\n').includes(f.path)))
  chk('the consent record is not world-readable',
    (statSync(pushTarget()).mode & 0o777) === 0o600, (statSync(pushTarget()).mode & 0o777).toString(8))

  const rec = loadPush()
  chk('the record binds to the destination', rec.shown?.url === base, String(rec.shown?.url))
  chk('and to the digest of what was shown',
    rec.shown?.disclosure.sha256 === disclosureDigest(), String(rec.shown?.disclosure.sha256))
  chk('and to the credential, which is what names the workspace',
    /^[0-9a-f]{16}$/.test(rec.shown?.credential.fingerprint || ''), String(rec.shown?.credential.fingerprint))
  chk('and it records that somebody was there to read it',
    rec.shown?.tty === true, String(rec.shown?.tty))
}

// ------------------------ 2b. consent that no longer matches is not consent
{
  const good = loadPush()

  // An update that adds a field to the payload changes the disclosure, so the
  // stored digest stops matching. Modelled by storing a digest of a DIFFERENT
  // text, which is exactly the state such an update would leave behind.
  writeFileSync(pushTarget(), JSON.stringify({
    ...good,
    shown: {
      ...good.shown,
      disclosure: { version: '1', sha256: disclosureDigest([...standingDisclosure(), '    payload.cwd    your working directory']) },
    },
  }))
  chk('consent given to an older disclosure does not carry over', isOn() === false)
  chk('and the reason says what changed', /has changed/i.test(offReason()), offReason())
  const r = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('a lapsed consent sends nothing', server.calls.length === 0 && r.shipped === false, `${server.calls.length} call(s)`)

  // Forged outright: enabled, but no record of anything having been shown.
  writeFileSync(pushTarget(), JSON.stringify({ schema_version: STATE_SCHEMA_VERSION, optedOut: false }))
  chk('a record with no showing in it does not ship', isOn() === false, offReason())
  chk('and it asks to be shown rather than refusing outright',
    /has not been shown/i.test(offReason()), offReason())

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
  // The terms GET precedes every send now, so "one request" means one REPORT.
  const posts = server.calls.filter((c) => c.url === REPORT_PATH)
  chk('exactly one report went out', posts.length === 1, String(posts.length))
  chk('and the terms were asked for first, before anything was sent',
    server.calls[0]?.url === '/v1/qpact/terms' && server.calls[0]?.method === 'GET',
    JSON.stringify(server.calls.map((c) => `${c.method} ${c.url}`)))

  // Guarded rather than assumed. When an upstream guard correctly refuses a
  // send, nothing arrives -- and reading `server.calls[0].url` off an empty
  // array throws a TypeError, which exits with a stack trace instead of the
  // assertion that would have said which rule fired. A break has to be legible.
  const call = posts[0]
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
  const sendsBefore = server.calls.filter((c) => c.url === REPORT_PATH).length

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
  // Counted as REPORT posts. Each attempt now asks the host for its terms
  // first, so raw request counts are two per attempt and say nothing about how
  // many sends were made.
  const sends = server.calls.filter((c) => c.url === REPORT_PATH).length
  chk('and every failure came back as a value, never a rejection',
    sends === sendsBefore + 4, `${sends - sendsBefore} sends for 4 attempts`)
}

// ------------------------------ 4b. refusals that never reach the network
{
  const before = server.calls.length

  // Consent was to a host. An environment variable moving the destination does
  // not inherit it.
  connect('http://127.0.0.1:9')
  const moved = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('a changed destination refuses before connecting',
    moved.shipped === false && moved.reason.includes(base) && moved.reason.includes('127.0.0.1:9'), moved.reason)
  chk('and nothing was sent anywhere', server.calls.length === before, String(server.calls.length - before))
  connect()

  // Shipping on, credential gone. Loud, and pointed at the fix.
  disconnect()
  const noToken = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('shipping on with no token says so, and says how to fix it',
    noToken.shipped === false && /qsetup/i.test(noToken.lines.join('\n')), noToken.lines.join('\n'))
  chk('and does not read as "off"', !/shipping is off/i.test(noToken.reason), noToken.reason)
  connect()

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
  // Through the config, not an environment variable: a stray SESSION_VIZ_URL is
  // now refused before any socket is opened, which is a different assertion and
  // has its own section. This one is about a host that is genuinely not there.
  connect('http://127.0.0.1:9')
  const dead = await ship({ spinePath, reportPath, timeoutMs: 4000 })
  chk('an unreachable host names the host it could not reach',
    dead.shipped === false && dead.reason.includes('127.0.0.1:9'), dead.reason)
  chk('and says the local report is unaffected',
    dead.lines.some((l) => /unaffected/i.test(l)), dead.lines.join('\n'))
  connect()
  writeFileSync(pushTarget(), JSON.stringify(good), { mode: 0o600 })

  chk('none of that reached the network', server.calls.length === before, String(server.calls.length - before))
}

// ----------------------------------------------- 5. turning it off stops it
{
  server.setMode('ok')
  // The section before this one pointed the record at an unreachable host to
  // test a timeout. Re-accept for the live one BEFORE the send: under a gate
  // that binds consent to a destination, "still shipping" is only meaningful
  // about the destination this run actually resolves to.
  turnOn({ confirmed: true })
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
  chk('the record fingerprints the credential', !!rec.shown?.credential?.fingerprint, JSON.stringify(rec.shown?.credential))
  chk('and never stores the credential itself',
    !JSON.stringify(rec).includes('svt_test_token'),
    'the token must not be recoverable from the state file')
  chk('the fingerprint is a fingerprint, not a token',
    /^[0-9a-f]{16}$/.test(rec.shown?.credential?.fingerprint || ''), String(rec.shown?.credential?.fingerprint))
  chk('two different tokens fingerprint differently',
    credentialFingerprint('token-a') !== credentialFingerprint('token-b'))

  // The assertion that matters: a different workspace at the SAME host. The
  // url check above cannot see this, because the url is identical.
  connect(base, 'svt_a_completely_different_workspace')
  const swapped = await ship({ spinePath, reportPath, timeoutMs: 3000, label: 'swapped-credential' })
  chk('a send with a different credential is refused', swapped.shipped === false, JSON.stringify(swapped.reason))
  chk('and the refusal says it is about consent, not about the network',
    /credential changed/i.test(String(swapped.reason)), String(swapped.reason))
  // It used to say which KIND each was — a file credential against an
  // environment one — because there were two kinds. There is one now, so what
  // the line can still say is that the credential moved, and it does.
  // Swapping back does NOT resume immediately, and that is the gate being
  // consistent rather than inconvenient: the refused run showed the disclosure
  // for the new workspace and recorded it, so the original is now the one that
  // has not been shown. It earns the same single deferred run as any other
  // destination, and then it ships.
  connect()
  const back = await ship({ spinePath, reportPath, timeoutMs: 3000, label: 'restored-credential' })
  chk('swapping back earns one deferred run, not an immediate send',
    back.shipped === false && /credential changed|has not been shown/i.test(back.reason), String(back.reason))
  const afterBack = await ship({ spinePath, reportPath, timeoutMs: 3000, label: 'after-restore' })
  chk('and the run after that ships again', afterBack.shipped === true, String(afterBack.reason))
}

// ── The gate's other answers ─────────────────────────────────────────────
//
// Each of these writes the record it needs, so the order of this file does not
// decide the result — the lesson from migrating the sections above, where an
// assertion that looked like it was about consent was about which port the
// previous section had left in an environment variable.

console.log(`\n── ` + 'a session can be skipped one at a time')
{
  turnOn({ confirmed: true })
  const before = server.calls.length
  const sid = JSON.parse(readFileSync(spinePath, 'utf8')).sessionId
  skipSession(sid)
  const r = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('the skipped session is not sent', r.shipped === false && server.calls.length === before, String(r.reason))
  chk('and it says which reason it was', /this session was skipped/i.test(r.reason), r.reason)
  chk('the machine is not turned off by it', loadPush().optedOut === false, JSON.stringify(loadPush().optedOut))

  // A different session on the same machine is unaffected — the skip is one
  // session, not a quiet standing opt-out.
  const other = join(home, 'other-spine.json')
  const sp = JSON.parse(readFileSync(spinePath, 'utf8'))
  writeFileSync(other, JSON.stringify({ ...sp, sessionId: `${sp.sessionId}-other` }))
  const r2 = await ship({ spinePath: other, reportPath, timeoutMs: 3000 })
  chk('another session still ships', r2.shipped === true, String(r2.reason))
}

console.log(`\n── ` + 'a disclosure nothing was attached to read is not a showing')
{
  writeFileSync(pushTarget(), JSON.stringify({ schema_version: STATE_SCHEMA_VERSION, optedOut: false }), { mode: 0o600 })
  const before = server.calls.length
  const headless = await ship({ spinePath, reportPath, timeoutMs: 3000, isTty: false })
  chk('the first headless run sends nothing', headless.shipped === false && server.calls.length === before)
  chk('and it records that nothing was attached', loadPush().shown?.tty === false, String(loadPush().shown?.tty))

  const again = await ship({ spinePath, reportPath, timeoutMs: 3000, isTty: false })
  chk('and the NEXT headless run still sends nothing — a log is not a reader',
    again.shipped === false && server.calls.length === before, String(again.reason))
  chk('it names the escape', /SESSION_VIZ_SHIP_ACK/.test(again.lines.join('\n')), again.lines.join('\n'))

  // The escape is still a human act: somebody read it and set the digest.
  process.env.SESSION_VIZ_SHIP_ACK = disclosureDigest()
  const acked = await ship({ spinePath, reportPath, timeoutMs: 3000, isTty: false })
  chk('with the digest acknowledged, a headless run ships', acked.shipped === true, String(acked.reason))
  process.env.SESSION_VIZ_SHIP_ACK = 'not-the-digest'
  const wrong = await ship({ spinePath, reportPath, timeoutMs: 3000, isTty: false })
  chk('and a wrong digest does not count', wrong.shipped === false, String(wrong.reason))
  delete process.env.SESSION_VIZ_SHIP_ACK
}

console.log(`\n── ` + 'a version-1 record is read, and its two answers are not the same')
{
  const before = server.calls.length
  writeFileSync(pushTarget(), JSON.stringify({ schema_version: '1', enabled: false }), { mode: 0o600 })
  chk('an old NO is still a no', loadPush().origin === 'opted-out', String(loadPush().origin))
  const r = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('and it is not promoted into shipping by a version bump',
    r.shipped === false && server.calls.length === before, String(r.reason))

  writeFileSync(pushTarget(), JSON.stringify({
    schema_version: '1', enabled: true, url: base,
    disclosure: { version: '1', sha256: disclosureDigest() },
  }), { mode: 0o600 })
  chk('an old YES is not read as consent to what leaves now',
    loadPush().origin === 'legacy-consented', String(loadPush().origin))
  const r2 = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('it earns the deferred run rather than a send',
    r2.shipped === false && server.calls.length === before, String(r2.reason))
  chk('and the reason says what changed', /has changed/i.test(r2.reason), r2.reason)
  const r3 = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('and then it ships', r3.shipped === true, String(r3.reason))
}

console.log(`\n── ` + 'no workspace is not the same answer as no')
{
  const url = process.env.SESSION_VIZ_URL
  turnOn({ confirmed: true })
  // A machine that was never connected. It must not read as "you said no".
  disconnect()
  const r = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('a machine with no config is refused in its own words', r.shipped === false)
  chk('and told to run /qsetup rather than that shipping is off',
    /qsetup/i.test(r.lines.join('\n')) && !/shipping is off/i.test(r.reason), r.reason)
  connect()

  // SESSION_VIZ_URL left over in a shell, naming a different host than the one
  // this machine signed in to. The file's token must not follow it there — the
  // refusal that replaced the old "URL with no token" one, now that a token
  // cannot come from the environment at all.
  process.env.SESSION_VIZ_URL = 'http://127.0.0.1:9'
  const strayUrl = await ship({ spinePath, reportPath, timeoutMs: 3000 })
  chk('a stray SESSION_VIZ_URL does not redirect this workspace\u2019s token',
    strayUrl.shipped === false, strayUrl.reason)
  chk('and the refusal names both hosts',
    /127\.0\.0\.1:9/.test(strayUrl.lines.join('\n') + strayUrl.reason), strayUrl.reason)
  if (url) process.env.SESSION_VIZ_URL = url; else delete process.env.SESSION_VIZ_URL
}

console.log(`\n── ` + 'what the host says it does is printed on every send, outside the digest')
{
  server.setMode('ok')
  turnOn({ confirmed: true })
  const r = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  const text = r.lines.join('\n')
  chk('the send succeeded', r.shipped === true, String(r.reason))
  chk('the host\u2019s terms are printed', /WHAT .* SAYS IT DOES WITH IT/.test(text), text)
  chk('and labelled as not part of what was agreed',
    /not part of what you agreed to/.test(text), text)
  chk('and dated as fetched just now', /fetched just now/.test(text), text)
  for (const [label, value] of [['kept for', '90 days'], ['withdrawn, then held', '14 days'],
                                ['visibility ladder', 'private, admins, workspace'],
                                ['trace volume billed', 'true']])
    chk(`it prints ${label}`, text.includes(label) && text.includes(value), text)

  // The digest covers what LEAVES. It must not cover what the host asserts, or
  // an operator editing a retention setting would move it and switch shipping
  // off for everybody at once.
  chk('none of it is inside the digested text',
    !standingDisclosure().join('\n').includes('kept for'), 'a server-owned value reached the digest')
}

console.log(`\n── ` + 'a host that omits a field cannot shorten the disclosure')
{
  server.setTerms({ retentionDays: 90 })
  turnOn({ confirmed: true })
  const r = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  const text = r.lines.join('\n')
  chk('the fields it did not answer are still printed',
    (text.match(/the host did not say/g) || []).length === 3, text)
  chk('and the one it did answer is there', /kept for\s+90 days/.test(text), text)

  // A value from somewhere else, printed into a terminal immediately above a
  // decision. A host that can put an escape sequence there can redraw the lines
  // above it.
  server.setTerms({ retentionDays: '90\u001b[2J\u001b[H EVERYTHING IS FINE', holdDays: 14 })
  const r2 = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('control characters from the host are stripped',
    !/\u001b/.test(r2.lines.join('\n')), JSON.stringify(r2.lines.join('\n').slice(0, 200)))
  server.setTerms(null)
}

console.log(`\n── ` + 'a host that has answered before is quoted with the date')
{
  server.setMode('ok')
  turnOn({ confirmed: true })
  await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('the terms were cached', !!loadPush().terms, JSON.stringify(loadPush().terms?.url))

  server.setMode('error')
  const r = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  const text = r.lines.join('\n')
  chk('the cached terms are still printed when the host cannot be reached',
    /WHAT .* SAYS IT DOES WITH IT/.test(text), text)
  chk('with their age attached, not as if fetched now',
    /last fetched .* UTC/.test(text) && !/fetched just now/.test(text), text)
  server.setMode('ok')
}

console.log(`\n── ` + 'the sidecar goes too, and is reported apart from the document')
{
  server.setMode('ok')
  turnOn({ confirmed: true })
  const before = server.calls.length
  const r = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  const sent = server.calls.slice(before)
  const factsCall = sent.find((c) => c.url === '/v1/qpact/facts')

  chk('the document went', r.shipped === true, String(r.reason))
  chk('and the sidecar went', !!factsCall && factsCall.method === 'POST',
    JSON.stringify(sent.map((c) => `${c.method} ${c.url}`)))
  chk('after the document, not before it',
    sent.findIndex((c) => c.url === REPORT_PATH) < sent.findIndex((c) => c.url === '/v1/qpact/facts'),
    JSON.stringify(sent.map((c) => c.url)))
  chk('the two outcomes are reported separately, and neither says "shipped" alone',
    r.lines.some((l) => /SHIPPED to /.test(l)) && r.lines.some((l) => /FACTS SENT/.test(l)),
    r.lines.join('\n'))
  chk('and the result carries the sidecar\u2019s own outcome', r.factsShipped === true)

  // The payload itself, over the wire — not the projection re-run.
  // The BARE facts object, with no envelope around it — the disclosure says
  // "48 bounded fields and no others", and an envelope makes that false by one.
  const body = JSON.parse(factsCall.body)
  chk('it posts the facts themselves, not an envelope around them',
    !('facts' in body) && typeof body.session_id === 'string', Object.keys(body).slice(0, 6).join(', '))
  chk(`and all ${INDEX_FIELDS.length} declared fields`,
    keyPaths(body, INDEX_FIELDS).length === INDEX_FIELDS.length,
    String(keyPaths(body, INDEX_FIELDS).length))
  const wire = JSON.stringify(body)
  for (const refused of ['"cwd"', '"file"', '"project"', 'turns[].text'])
    chk(`and nothing named ${refused}`, !wire.includes(refused), refused)
  chk('and no home path anywhere in it', !/\/Users\/|-Users-/.test(wire), wire.slice(0, 160))
}

console.log(`\n── ` + 'the intents ride in the sidecar, and only this session’s')
{
  // The model-written half of the tier reached nobody for as long as the
  // sidecar existed: facts.mts shipped `intents: []`, and the console page
  // built on those fields drew nothing. This is the path that carries them —
  // and the two ways it must refuse, said out loud rather than thrown.
  server.setMode('ok')
  server.setFactsMode(null)
  turnOn({ confirmed: true })
  const PRIOR_TITLE = 'a title from an earlier session that must stay home'
  const SUMMARY = 'a summary that paraphrases the prompt and must stay home'
  const intentPath = join(home, 'sess-abc-123.intent.json')
  writeFileSync(intentPath, JSON.stringify({
    sessionId: 'sess-abc-123', tldr: 'tldr stays home', compactInstruction: 'compact stays home',
    intents: [{ title: 'Fix the cookie', status: 'done', summary: SUMMARY, turns: [0] }],
    graph: { concepts: [{ id: 'cookie', label: 'The cookie', group: 'defect', note: 'note stays home' }], relations: [] },
    prior: [{ sessionId: 'sess-old', intents: [{ title: PRIOR_TITLE, status: 'done' }] }],
  }), { mode: 0o600 })

  let before = server.calls.length
  let r = await ship({ spinePath, reportPath, intentPath, timeoutMs: 5000 })
  let facts = server.calls.slice(before).find((c) => c.url === '/v1/qpact/facts')
  let body = facts ? JSON.parse(facts.body) : null
  chk('with --intent the sidecar carries the intents',
    !!body && body.intents.length === 1 && body.intents[0].title === 'Fix the cookie', JSON.stringify(body?.intents))
  chk('and the concepts, with their kind',
    !!body && body.graph.concepts.length === 1 && body.graph.concepts[0].group === 'defect', JSON.stringify(body?.graph))
  const wire = facts ? facts.body : ''
  chk('but not the summary', !wire.includes(SUMMARY))
  chk('nor the note, the tldr or the compact instruction', !/note stays home|tldr stays home|compact stays home/.test(wire))
  chk('nor anything from a prior session', !wire.includes(PRIOR_TITLE))
  chk('and the outcome line says what was carried',
    r.lines.some((l) => /FACTS SENT.*with 1 intent and 1 concept/.test(l)), r.lines.filter((l) => /FACTS/.test(l)).join('\n'))

  // Another session's render file, handed over by a copied path. The facts
  // must still go — this session is real — but with no intents, and the
  // refusal must be printed where the person will read it.
  const wrongPath = join(home, 'sess-other.intent.json')
  writeFileSync(wrongPath, JSON.stringify({
    sessionId: 'sess-other-999', intents: [{ title: 'Somebody else’s work', status: 'done' }], graph: { concepts: [], relations: [] },
  }), { mode: 0o600 })
  before = server.calls.length
  r = await ship({ spinePath, reportPath, intentPath: wrongPath, timeoutMs: 5000 })
  facts = server.calls.slice(before).find((c) => c.url === '/v1/qpact/facts')
  body = facts ? JSON.parse(facts.body) : null
  chk('a render file for another session is refused by name',
    r.lines.some((l) => /INTENTS NOT SENT/.test(l) && /sess-oth/.test(l) && /sess-abc/.test(l)), r.lines.join('\n'))
  chk('and the facts still go, empty of intents', !!body && body.intents.length === 0 && r.factsShipped === true)
  chk('and nothing of the other session crosses', !(facts?.body || '').includes('Somebody else'))

  // No file: the facts go, and the line says how to send intents next time.
  before = server.calls.length
  r = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('without --intent the outcome line says so and names the flag',
    r.lines.some((l) => /FACTS SENT.*no intents.*--intent/.test(l)), r.lines.filter((l) => /FACTS/.test(l)).join('\n'))

  // An unreadable file: reported, and the facts still go.
  r = await ship({ spinePath, reportPath, intentPath: join(home, 'missing.intent.json'), timeoutMs: 5000 })
  chk('an unreadable render file is reported and the facts still go',
    r.factsShipped === true && r.lines.some((l) => /INTENTS NOT SENT — could not read/.test(l)), r.lines.join('\n'))
  chk('and the refusal is printed after the FACTS line it qualifies',
    r.lines.findIndex((l) => /INTENTS NOT SENT/.test(l)) > r.lines.findIndex((l) => /FACTS SENT/.test(l)), r.lines.join('\n'))

  // The step-4 fragment names no session. It is shaped like the render file
  // and projects fine; it is also the un-merged draft, not the record.
  const fragmentPath = join(home, 'a.fragment.json')
  writeFileSync(fragmentPath, JSON.stringify({ intents: [{ title: 'From a fragment', status: 'done' }], graph: { concepts: [], relations: [] } }), { mode: 0o600 })
  before = server.calls.length
  r = await ship({ spinePath, reportPath, intentPath: fragmentPath, timeoutMs: 5000 })
  facts = server.calls.slice(before).find((c) => c.url === '/v1/qpact/facts')
  chk('a file that names no session is refused, and told which file to pass instead',
    r.lines.some((l) => /INTENTS NOT SENT — .*names no session.*--merge/.test(l)) && JSON.parse(facts.body).intents.length === 0, r.lines.join('\n'))

  // A title that quotes a prompt is withheld before it leaves, and counted.
  const quotingPath = join(home, 'quoting.intent.json')
  writeFileSync(quotingPath, JSON.stringify({
    sessionId: 'sess-abc-123',
    intents: [{ title: SECRET_PROMPT, status: 'done' }, { title: 'A safe paraphrase', status: 'done' }],
    graph: { concepts: [], relations: [] },
  }), { mode: 0o600 })
  before = server.calls.length
  r = await ship({ spinePath, reportPath, intentPath: quotingPath, timeoutMs: 5000 })
  facts = server.calls.slice(before).find((c) => c.url === '/v1/qpact/facts')
  chk('a title that is the prompt never reaches the socket', !facts.body.includes(SECRET_PROMPT))
  chk('and the FACTS line counts it', r.lines.some((l) => /FACTS SENT.*1 intent.*1 title withheld for quoting a prompt/.test(l)), r.lines.filter((l) => /FACTS/.test(l)).join('\n'))

  // The page withheld: the intents go with the page, not with the numbers.
  withholdDocument(true)
  before = server.calls.length
  r = await ship({ spinePath, reportPath, intentPath, timeoutMs: 5000 })
  facts = server.calls.slice(before).find((c) => c.url === '/v1/qpact/facts')
  chk('with the page withheld the facts still go', r.factsShipped === true && !!facts)
  chk('but carry no intents', JSON.parse(facts.body).intents.length === 0 && JSON.parse(facts.body).graph.concepts.length === 0)
  chk('and both lines say so',
    r.lines.some((l) => /PAGE WITHHELD.*without intents/.test(l)) && r.lines.some((l) => /FACTS SENT.*withheld with the page/.test(l)), r.lines.join('\n'))
  chk('and nothing of the render file crosses', !facts.body.includes('Fix the cookie'))
  withholdDocument(false)
}

console.log(`\n── ` + 'what is posted is what the server will accept')
{
  // The assertion that was missing, and it cost two live defects to notice.
  //
  // The sidecar shipped as `{ schema_version, facts }` while the server
  // validated the envelope, and the trace shipped in extract's SOURCE shape
  // while the server expected the projected one. Both sides had tests. Both
  // passed. The plugin asserted its payload against its own walk and the server
  // asserted its own shape, and NOTHING asserted the two agree — so the first
  // time the two met was a real send, which refused every call by name.
  //
  // This runs the server's own validators over the bytes this plugin actually
  // posts. It needs the sibling repository built and says so when it is not,
  // rather than passing quietly: a cross-repo check that silently does nothing
  // is the same shape as the gap it exists to close.
  // From THIS file, not from the scratch home: `home` is a temp directory and
  // walking up from it lands nowhere, which made this skip while reading as if
  // it had looked.
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const CLOUD = process.env.SESSION_VIZ_CLOUD || join(REPO, '..', 'session-viz-cloud')
  const validators = join(CLOUD, 'services', 'api', 'dist', 'facts.js')
  if (!existsSync(validators)) {
    console.log(`skip  the server's validators are not built at ${validators}`)
    console.log('      set SESSION_VIZ_CLOUD, or run npm run build there')
  } else {
    const { validateFacts, validateTraceCall } = await import(validators)
    server.setMode('ok')
    turnOn({ confirmed: true })

    const traced = join(home, 'traced-spine.json')
    const base = JSON.parse(readFileSync(spinePath, 'utf8'))
    writeFileSync(traced, JSON.stringify({
      ...base,
      // extract's SOURCE shape, deliberately — camelCase, and not what the wire
      // takes. If the projection is skipped this is what arrives.
      trace: [{
        turn: 0, seq: 0, tool: 'Bash', startedAt: '2026-01-01T00:00:00Z', durationMs: 3,
        ok: true, errorKind: 'none', input: { command: 'ls' }, result: 'out', resultBytes: 3,
        truncated: false,
      }],
    }))

    // WITH intents, so the check cannot pass on an empty array — the server's
    // validator stops at the declared leaves, and the first populated payload
    // it ever saw was a real send.
    const tracedIntent = join(home, 'traced.intent.json')
    writeFileSync(tracedIntent, JSON.stringify({
      sessionId: JSON.parse(readFileSync(traced, 'utf8')).sessionId,
      intents: [{ title: 'Ship the trace', status: 'done', turns: [0] }],
      graph: { concepts: [{ id: 'trace', label: 'The trace', group: 'subsystem' }], relations: [] },
    }), { mode: 0o600 })
    const at = server.calls.length
    await ship({ spinePath: traced, reportPath, intentPath: tracedIntent, timeoutMs: 5000 })
    const sent = server.calls.slice(at)

    const factsBody = JSON.parse(sent.find((c) => c.url === FACTS_PATH).body)
    chk('the payload validated carries intents, so this is not vacuous', factsBody.intents.length === 1 && factsBody.graph.concepts.length === 1)
    chk('the facts this plugin posts are what the server accepts',
      validateFacts(factsBody) === null, String(validateFacts(factsBody)))

    const traceBody = JSON.parse(sent.find((c) => c.url === '/v1/qpact/trace').body)
    chk('and so is every call in the trace it posts',
      traceBody.calls.every((c) => validateTraceCall(c) === null),
      String(traceBody.calls.map((c) => validateTraceCall(c)).find(Boolean)))
    chk('which means the source shape was projected, not posted raw',
      traceBody.calls.every((c) => 'started_at' in c && !('startedAt' in c)),
      JSON.stringify(Object.keys(traceBody.calls[0] || {})))
  }
}

console.log(`\n── ` + 'a sidecar that fails does not unmake a report that went')
{
  server.setMode('ok')
  turnOn({ confirmed: true })
  server.setFactsMode('refuse')
  const r = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('the document still went', r.shipped === true, String(r.reason))
  chk('the sidecar is reported as not sent', r.factsShipped === false)
  chk('and the line says the report is unaffected',
    r.lines.some((l) => /FACTS NOT SENT/.test(l) && /unaffected/.test(l)), r.lines.join('\n'))
  server.setFactsMode(null)
}

console.log(`\n── ` + 'the disclosure names the sidecar and what it refuses')
{
  const text = standingDisclosure().join('\n')
  chk('it names the endpoint', text.includes('/v1/qpact/facts'), text.slice(0, 80))
  chk(`it names all ${INDEX_FIELDS.length} fields`,
    INDEX_FIELDS.every((f) => text.includes(f.split('.').pop())),
    INDEX_FIELDS.filter((f) => !text.includes(f.split('.').pop())).join(', '))
  chk('and what it refuses, by name',
    ['file, project, cwd', 'turns[].text', 'turns[].signals'].every((x) => text.includes(x)), text)
  chk('and the count matches the contract',
    new RegExp(`${INDEX_FIELDS.length} bounded fields`).test(text), text)
}

console.log(`\n── ` + 'the page can be withheld while the facts keep going')
{
  server.setMode('ok')
  turnOn({ confirmed: true })
  withholdDocument(true)
  const before = server.calls.length
  const r = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  const sent = server.calls.slice(before)

  chk('no page was sent', !sent.some((c) => c.url === REPORT_PATH),
    JSON.stringify(sent.map((c) => c.url)))
  chk('the facts still were', sent.some((c) => c.url === FACTS_PATH),
    JSON.stringify(sent.map((c) => c.url)))
  chk('and it says which happened', r.lines.some((l) => /PAGE WITHHELD/.test(l)), r.lines.join('\n'))
  chk('the document outcome is false and the facts outcome is true',
    r.shipped === false && r.factsShipped === true, JSON.stringify([r.shipped, r.factsShipped]))
  chk('and the reason names the withholding, not a failure',
    /withheld/.test(r.reason), r.reason)

  // An oversized page is not refused when it was never going to be sent.
  const huge = join(home, 'huge.html')
  writeFileSync(huge, 'x'.repeat(MAX_DOCUMENT_BYTES + 1024))
  const r2 = await ship({ spinePath, reportPath: huge, timeoutMs: 5000 })
  chk('a page too large to send is irrelevant when it is withheld',
    r2.factsShipped === true && !/too large|over the/i.test(r2.reason), String(r2.reason))

  withholdDocument(false)
  const r3 = await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('and turning it back on sends the page again', r3.shipped === true, String(r3.reason))
}

console.log(`\n── ` + 'a retained trace goes with it, and only when one was retained')
{
  server.setMode('ok')
  turnOn({ confirmed: true })
  const before = server.calls.length
  await ship({ spinePath, reportPath, timeoutMs: 5000 })
  chk('a spine with no trace sends none',
    !server.calls.slice(before).some((c) => c.url === '/v1/qpact/trace'),
    JSON.stringify(server.calls.slice(before).map((c) => c.url)))

  const withTrace = join(home, 'trace-spine.json')
  const base = JSON.parse(readFileSync(spinePath, 'utf8'))
  writeFileSync(withTrace, JSON.stringify({
    ...base,
    trace: [{
      turn: 0, seq: 0, tool: 'Bash', mcp_server: null, started_at: null, duration_ms: 1,
      ok: true, error_kind: 'none', input: { command: 'ls' }, result: 'out',
      input_bytes: 16, result_bytes: 3, truncated: false,
    }],
  }))
  const at = server.calls.length
  const r = await ship({ spinePath: withTrace, reportPath, timeoutMs: 5000 })
  const traceCall = server.calls.slice(at).find((c) => c.url === '/v1/qpact/trace')
  chk('a spine that carries one sends it', !!traceCall, JSON.stringify(server.calls.slice(at).map((c) => c.url)))
  chk('and the line says who can read it',
    r.lines.some((l) => /TRACE SENT/.test(l) && /admins/.test(l)), r.lines.join('\n'))
  // Retention is extract's decision, made with --with-trace. There is no switch
  // here, and there should not be a second place to turn the most exposing
  // payload in the product on.
  chk('the trace carries the calls the spine held',
    JSON.parse(traceCall.body).calls.length === 1, traceCall.body.slice(0, 80))
}

await server.close()
clearTimeout(watchdog)
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
