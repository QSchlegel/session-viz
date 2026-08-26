#!/usr/bin/env node
// /qpact reports, readable in the cloud console. Off until you turn it on.
//
//   node push.mjs                                  # is it on, where would it go
//   node push.mjs --on                             # prints the disclosure, refuses
//   node push.mjs --on --yes                       # prints the disclosure, turns it on
//   node push.mjs --off                            # off, from the next run onward
//   node push.mjs --ship --spine S.json --report R.html
//
// -- Why this ships the DOCUMENT and not the spine --------------------------
// The ask was a cloud report that "reads like the local page". There are only
// two ways to get one, and they fail differently.
//
//   Ship the spine, render on the server. The console can then index, search
//   and cross-link, because it holds structure rather than markup. The cost is
//   a SECOND renderer. This plugin is installed by copying the repo — the cache
//   is keyed by version, so old installs keep working indefinitely, which is
//   why CI refuses a source change without a version bump. A spine written by
//   plugin 0.20 would be rendered by whatever single version the server runs.
//   Fields it does not know about are dropped; fields it expects and the spine
//   does not carry render as absent. Neither shows up as an error — they show
//   up as a page quietly describing the session differently from the one the
//   author read, which is the failure render.mts's whole fingerprint mechanism
//   exists to make detectable.
//
//   Ship the rendered document. The page in the console IS the page on the
//   screen, byte for byte, produced by the renderer the author actually ran and
//   stamped with its version and fingerprint. Nothing can go stale, because
//   nothing is re-derived. The cost is real and worth naming: the server holds
//   opaque markup it cannot index, and a renderer improvement never reaches a
//   report already sent.
//
// Shipping the document wins here because of what this feature is FOR. A
// consent design whose whole promise is "you were shown what leaves" needs a
// payload a person can actually inspect, and the document is the only payload
// in this plugin that the user has already opened in a browser. "What is in the
// cloud is the file you are looking at" is a sentence a reader can check.
// "The server rebuilt your page from these 340 fields" is not.
//
// -- What that means for redaction ------------------------------------------
// The redaction posture travels, and it is not flattering, so it is stated
// rather than implied — see standingDisclosure() below and REDACTION_POSTURE.
//
// bundle.mts's scrub does NOT apply to what leaves here. scrubDeep rewrites
// home paths and email addresses in the evidence package embedded in the page;
// bundle.mts's own LIMITS says of that rewrite "The page is the unrewritten
// form", and this ships the page. So a path or an address typed into a prompt
// travels verbatim. /qshare strips those because it publishes to colleagues.
// This posts your own report to your own console, and rewriting it would break
// the one property that makes the disclosure checkable: that the bytes in the
// console are the bytes on your screen.
//
// What DOES apply is extract.mjs's secret redaction, which is pattern matching
// and not the same as safe. bundle.mts already has the exact sentence for that
// and it is reused verbatim rather than paraphrased — a second wording of a
// safety claim is a second thing to drift.
//
// -- Why the switch is built the way it is ----------------------------------
// Three separate things have to be true before a byte moves, and each is a
// mechanism rather than a promise:
//
//   1. `enabled` was written by turnOn(), which cannot run without printing the
//      disclosure — the print and the write are the same call.
//   2. The stored digest still matches the CURRENT disclosure text. Add a field
//      to the payload, and the table that generates the disclosure changes, and
//      the digest stops matching, and shipping stops until the user is shown
//      the new text. "Not on after an update" is not a policy here, it is
//      arithmetic.
//   3. The destination recorded at consent time is still the destination now.
//      Consent was to a host, not to the idea of hosting.
//
// And one more at the last moment: the assembled payload is walked and refused
// if it carries a key path FIELDS does not name. Fail closed — a field added
// without a disclosure entry stops the send instead of riding along in it.
//
// No expiry. /qlive expires its opt-in after twelve hours because it reports
// from a hook — nothing on screen, nobody watching, exactly the opt-in somebody
// forgets. This only ever runs when a person runs /qpact, and it prints the
// destination on every single send. The anti-forgetting guarantee here is that
// line, not a clock.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDirs, configTarget } from './home.mjs';
import { config } from './cloud.mjs';
import { redactionLimit } from './bundle.mjs';
import { version } from './version.mjs';
export const SCHEMA_VERSION = '1';
/** Bumped when the disclosure text changes for a reason a reader should see.
 *  It is a label for humans; the digest is what actually gates shipping. */
export const DISCLOSURE_VERSION = '1';
/** The endpoint. One constant so the contract has one place to be read from. */
export const REPORT_PATH = '/v1/qpact/report';
/** Long enough for a multi-megabyte page over a bad connection, short enough
 *  that a black-holed socket does not hold the command open after the local
 *  report is already on screen. A hung upload is the failure mode that looks
 *  most like success. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Refused here rather than at the server, so the message names the file and
 *  the number instead of arriving as an HTTP 413. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const FIELDS = [
    {
        path: 'document.html',
        says: 'THE WHOLE REPORT, VERBATIM. The exact bytes of the HTML file /qpact just wrote and ' +
            'opened — not a summary, not a re-render. That page carries the full text of every ' +
            'prompt you typed this session, plus the evidence package embedded in it.',
    },
    { path: 'document.sha256', says: 'SHA-256 of those bytes, so the server can tell a truncated upload from a whole one.' },
    { path: 'document.bytes', says: 'How many bytes that is.' },
    { path: 'document.mediaType', says: "The constant 'text/html; charset=utf-8'." },
    { path: 'sessionId', says: "The harness's id for this session. The console keys on it, so re-running /qpact corrects the report rather than adding a second one." },
    {
        path: 'repo',
        says: 'The LAST SEGMENT of the working directory — the repository directory name. The route ' +
            'to it is not sent, and neither is your home directory. Null when the last segment ' +
            'would have been your account name.',
    },
    {
        path: 'branch',
        says: 'The git branch name, verbatim and unrewritten. Teams routinely name branches after the ' +
            'person working on them, so this field can carry somebody\'s name.',
    },
    { path: 'harness', says: "Which agent harness ran the session — 'claude-code', 'codex', 'cursor'." },
    { path: 'generatedAt', says: 'When the page was rendered, ISO-8601.' },
    { path: 'pluginVersion', says: 'Which build of this plugin rendered it. The console needs it to say which reading it is showing.' },
    { path: 'command', says: "The constant '/qpact'." },
    { path: 'schema_version', says: 'The version of this payload shape.' },
    { path: 'disclosure.version', says: 'Which version of this disclosure you were shown when you turned shipping on.' },
    { path: 'disclosure.sha256', says: 'Its digest, so your workspace has a record of what you agreed to and can tell it from a later one.' },
];
/** Request headers this sends. Headers carry data too, and a disclosure that
 *  enumerates the body while saying nothing about the headers has enumerated
 *  most of what leaves. Transport headers the runtime adds on its own (host,
 *  content-length, user-agent) are not ours and are not listed. */
export const HEADERS = [
    { path: 'authorization', says: 'Your session-viz token, as a bearer credential. The same one /qshare and /qcontrib use.' },
    { path: 'content-type', says: "The constant 'application/json'." },
    { path: 'x-actor', says: 'The harness label, identical to the `harness` field above. Set only when /qsetup recorded one.' },
];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/**
 * The repository directory name, or nothing.
 *
 * Fails closed when the session ran in the home directory itself: there the
 * last segment IS the account name, and "the route is not sent" would be a
 * false sentence in the disclosure above. bundle.mts's repoLabel() guards the
 * same case for the same reason.
 */
export function repoLabel(cwd) {
    if (!cwd)
        return null;
    const base = basename(cwd.replace(/[/\\]+$/, ''));
    if (!base || base === '~')
        return null;
    if (base === basename(homedir()))
        return null;
    return base;
}
/**
 * Assemble the exact object that will be serialised.
 *
 * Nothing is spread in from the spine. Every field is named and copied one at a
 * time, because `...session` is how a field nobody disclosed reaches a wire.
 */
export function reportPayload(args) {
    const { spine, html } = args;
    const sessionId = spine.sessionId;
    if (!sessionId)
        throw new Error('this spine has no sessionId — nothing to key a report on');
    const bytes = Buffer.byteLength(html, 'utf8');
    return {
        schema_version: SCHEMA_VERSION,
        command: '/qpact',
        sessionId,
        repo: repoLabel(spine.cwd),
        branch: spine.gitBranch || null,
        harness: spine.harness || null,
        generatedAt: new Date(args.now ?? Date.now()).toISOString(),
        pluginVersion: version(),
        document: { mediaType: 'text/html; charset=utf-8', bytes, sha256: sha256(html), html },
        disclosure: { version: DISCLOSURE_VERSION, sha256: disclosureDigest() },
    };
}
/**
 * Every leaf key path in a value, in the dotted form FIELDS uses.
 *
 * Arrays get a `[]` segment, so an array added where a scalar was disclosed
 * reads as a different path and is refused. That matters: `branch` and
 * `branch[]` are not the same disclosure.
 */
export function keyPaths(value, prefix = '') {
    if (Array.isArray(value)) {
        const at = `${prefix}[]`;
        const out = new Set([at]);
        for (const v of value)
            for (const p of keyPaths(v, at))
                out.add(p);
        return [...out];
    }
    if (value && typeof value === 'object') {
        const out = [];
        for (const [k, v] of Object.entries(value))
            out.push(...keyPaths(v, prefix ? `${prefix}.${k}` : k));
        return out;
    }
    return prefix ? [prefix] : [];
}
/**
 * The last gate before the socket: refuse a payload carrying anything the
 * disclosure did not name.
 *
 * Both directions are checked. An extra path is the dangerous one — that is an
 * undisclosed field on its way out. A missing one is a bug rather than a leak,
 * but it means the disclosure is describing a payload that no longer exists, so
 * the next reader is being told something untrue; a disclosure nobody maintains
 * is the thing this whole file is built to avoid.
 */
export function undisclosed(payload) {
    const named = new Set(FIELDS.map((f) => f.path));
    const actual = new Set(keyPaths(payload));
    return {
        extra: [...actual].filter((p) => !named.has(p)).sort(),
        missing: [...named].filter((p) => !actual.has(p)).sort(),
    };
}
// ---------------------------------------------------------------- disclosure
/**
 * The posture paragraphs — what is true of the text above, and what is not.
 *
 * Deliberately unflattering. A disclosure that only lists field names lets a
 * reader assume the reassuring thing about each one, and the reassuring
 * assumption here ("surely the paths are stripped, /qshare strips them") is
 * wrong.
 */
export const REDACTION_POSTURE = [
    'The page is sent UNREWRITTEN. bundle.mjs rewrites home-directory paths and email ' +
        'addresses, but only inside the evidence package embedded in the page — its own limits ' +
        'list calls the page "the unrewritten form", and this sends the page. So an absolute ' +
        'path or an email address you typed into a prompt goes as you typed it.',
    'That is a choice, not an oversight. /qshare strips those because it publishes to your ' +
        'colleagues. This posts your report to your own console, and rewriting it on the way ' +
        'would mean the document in the cloud is not the document on your screen — which is the ' +
        'one property that lets you check this disclosure by scrolling your own page.',
    'Whether prompt text was passed through the secret patterns depends on how the extractor ' +
        'was invoked. Every send reports which of the three cases it is, in bundle.mjs\'s own ' +
        'words, before it goes.',
    'Anyone who can read your workspace console can read the whole page, including every ' +
        'prompt in it. A row can be deleted. What somebody already read cannot be recalled.',
];
/**
 * The standing disclosure: what leaves, always, independent of any one report.
 *
 * This is the text whose digest consent is bound to. It carries no per-report
 * numbers and no destination, so the digest is stable across runs and changes
 * only when the SHAPE of what leaves changes — which is exactly when consent
 * should have to be given again.
 */
export function standingDisclosure() {
    const L = [];
    const pad = (s) => s.padEnd(22);
    const wrap = (text, indent) => {
        const words = text.split(' ');
        const lines = [];
        let cur = '';
        for (const w of words) {
            if (cur && (cur + ' ' + w).length > 74) {
                lines.push(cur);
                cur = '';
            }
            cur = cur ? `${cur} ${w}` : w;
        }
        if (cur)
            lines.push(cur);
        return lines.map((l, i) => (i === 0 ? l : indent + l));
    };
    L.push(`WHAT /qpact SENDS WHEN CLOUD SHIPPING IS ON  (disclosure v${DISCLOSURE_VERSION})`);
    L.push('');
    L.push(`  POST ${REPORT_PATH} — a JSON body with these fields and no others:`);
    L.push('');
    for (const f of FIELDS) {
        const head = `    ${pad(f.path)}`;
        const indent = ' '.repeat(head.length);
        const [first, ...rest] = wrap(f.says, indent);
        L.push(`${head}${first ?? ''}`);
        for (const r of rest)
            L.push(r);
    }
    L.push('');
    L.push('  and these request headers:');
    L.push('');
    for (const h of HEADERS) {
        const head = `    ${pad(h.path)}`;
        const indent = ' '.repeat(head.length);
        const [first, ...rest] = wrap(h.says, indent);
        L.push(`${head}${first ?? ''}`);
        for (const r of rest)
            L.push(r);
    }
    L.push('');
    L.push('  Nothing else. The payload is assembled, walked, and refused unsent if it');
    L.push('  carries a single key this list does not name.');
    L.push('');
    L.push('WHAT IS AND IS NOT TRUE OF THAT TEXT');
    L.push('');
    for (const p of REDACTION_POSTURE) {
        const [first, ...rest] = wrap(p, '    ');
        L.push(`  · ${first ?? ''}`);
        for (const r of rest)
            L.push(r);
        L.push('');
    }
    return L;
}
/** The digest consent is bound to. Over the rendered text, not over FIELDS
 *  alone: a posture paragraph that changes materially is a different agreement,
 *  and being made to re-consent over a typo fix is the direction to be wrong in. */
export const disclosureDigest = (lines = standingDisclosure()) => sha256(lines.join('\n'));
/**
 * The per-report half: the numbers this particular send would carry, and the
 * redaction sentence that only the spine can answer.
 *
 * Printed on every send. This is the line that makes a silent upload impossible
 * — not the consent record, which by definition happened once and long ago.
 */
export function reportDisclosure(args) {
    const { payload, destination, reportPath, spine } = args;
    const L = [];
    const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
    L.push(`  document   ${reportPath}`);
    L.push(`             ${kb(payload.document.bytes)}, sha256 ${payload.document.sha256.slice(0, 16)}… — byte-identical to that file`);
    L.push(`  session    ${payload.sessionId}`);
    L.push(`  repo       ${payload.repo ?? '(withheld — the working directory had no segment safe to send)'}${payload.branch ? ` on ${payload.branch}` : ''}`);
    L.push(`  carries    the full text of ${Array.isArray(spine.turns) ? spine.turns.length : '?'} prompt(s)`);
    const counts = documentCounts(payload.document.html);
    L.push(`             your home directory path appears ${counts.homePaths} time(s) in the document text`);
    L.push(`             ${counts.emails} email-shaped string(s)`);
    L.push(`             (the embedded evidence package is base64 and is not counted in either)`);
    L.push(`  to         ${destination}${REPORT_PATH}`);
    L.push('');
    // bundle.mjs's exact sentence, not a paraphrase. Two wordings of one safety
    // claim is two things to drift, and this one has already been wrong once.
    for (const line of wrapAt(redactionLimit({ redactedPrompts: spine.redactedPrompts }), 74))
        L.push(`  ${line}`);
    return L;
}
const wrapAt = (text, width) => {
    const out = [];
    let cur = '';
    for (const w of text.split(' ')) {
        if (cur && (cur + ' ' + w).length > width) {
            out.push(cur);
            cur = '';
        }
        cur = cur ? `${cur} ${w}` : w;
    }
    if (cur)
        out.push(cur);
    return out;
};
/**
 * How much of the reader's own machine is visible in the document text.
 *
 * A count, not a rewrite. The disclosure claims these travel verbatim; a number
 * turns that claim from a category into something the reader can weigh for THIS
 * report. Mirrors bundle.mts's HOME_UNIX and EMAIL shapes deliberately — they
 * are private to that module, and importing them is not on offer.
 */
export function documentCounts(html) {
    const home = homedir();
    const homeRe = new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
    return {
        homePaths: (html.match(homeRe) || []).length,
        emails: (html.match(emailRe) || []).length,
    };
}
const STATE_FILE = 'push.json';
export const pushPaths = () => configDirs().map((d) => join(d, STATE_FILE));
/** Beside the config that is actually in use — the same rule contrib.json and
 *  live.json follow, so one workspace has one answer to "is this on". */
export const pushTarget = () => join(dirname(configTarget()), STATE_FILE);
const OFF = { schema_version: SCHEMA_VERSION, enabled: false };
/**
 * Read the switch, failing closed on anything unexpected.
 *
 * A corrupt or unknown-schema file reads as OFF. For /qcontrib's ledger the
 * safe direction was the opposite — an unreadable ledger re-sends rather than
 * skipping — because there the cost of being wrong is a duplicate row. Here the
 * cost of being wrong is an upload nobody authorised, so it goes the other way.
 */
export function loadPush() {
    const p = pushPaths().find((q) => existsSync(q));
    if (!p)
        return { ...OFF };
    try {
        const s = JSON.parse(readFileSync(p, 'utf8'));
        if (!s || s.schema_version !== SCHEMA_VERSION || typeof s.enabled !== 'boolean')
            return { ...OFF };
        return s;
    }
    catch {
        return { ...OFF };
    }
}
/**
 * Write 0600 in a 0700 directory, trying each config location in turn.
 *
 * Duplicated from home.mts's private writeJson rather than shared, because
 * exporting it is not this change's to make. The fallback is not decoration: a
 * sandboxed harness cannot write outside its workspace, and without it the
 * EPERM lands on the one command a person runs to give consent — they would be
 * unable to turn the feature on and unable to see why.
 */
function savePush(state) {
    const first = pushTarget();
    const refused = [];
    for (const path of [first, ...pushPaths().filter((p) => p !== first)]) {
        try {
            const dir = dirname(path);
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
            chmodSync(path, 0o600);
            return path;
        }
        catch (e) {
            const code = e.code;
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EROFS')
                throw e;
            refused.push(path);
        }
    }
    throw new Error(`cannot record your choice — permission denied at ${refused.join(', ')}. ` +
        'Set SESSION_VIZ_HOME to a directory this harness can write.');
}
/**
 * Is shipping on, right now.
 *
 * Never consults the token. A credential lying around is not consent, and the
 * order matters at the call site too: this is asked before anything tries to
 * resolve one, so "off" is reported as off rather than as "no token".
 *
 * The digest comparison is what makes an update unable to re-arm this. There is
 * no path to `true` that does not go through a disclosure the current build
 * would print verbatim.
 */
export function isOn(state = loadPush()) {
    if (!state.enabled)
        return false;
    if (!state.disclosure?.sha256)
        return false;
    return state.disclosure.sha256 === disclosureDigest();
}
/** Why a state that looks on is not on. Empty when isOn() agrees. */
export function offReason(state = loadPush()) {
    if (!state.enabled)
        return 'cloud shipping is off';
    if (!state.disclosure?.sha256)
        return 'the stored consent has no record of what you were shown — turn it on again';
    if (state.disclosure.sha256 !== disclosureDigest())
        return 'what /qpact sends has changed since you agreed to it — shipping is off until you read the new disclosure and turn it on again';
    return '';
}
/**
 * Turn it on — which is the same call that prints the disclosure.
 *
 * They are one function on purpose. Two functions is an arrangement where the
 * printing one can be skipped, and "the user was shown this" then rests on
 * whoever wired the command up. Here the write is downstream of the print in
 * the same call stack; there is no way to reach the write without the lines
 * having gone to the sink.
 *
 * `confirmed` is the human's answer, and the caller must not supply it on the
 * human's behalf — see the skill, which says so where an agent will read it.
 */
export function turnOn(args) {
    // Held separately from `lines` because the digest is taken over the STANDING
    // text alone. Fold the destination into it and the recorded consent stops
    // matching the moment anyone points SESSION_VIZ_URL somewhere else — which
    // reads to the user as "the disclosure changed" when it did not. The
    // destination is bound by its own check in shipReport(), where the message
    // can name both hosts.
    const standing = standingDisclosure();
    const lines = [...standing];
    // Resolved BEFORE anything is written: consent is bound to a destination, and
    // there is nothing to bind it to until /qsetup has run. Refusing here also
    // means the recorded url is a real one rather than a default that a later
    // SESSION_VIZ_URL silently replaces.
    let cfg;
    try {
        cfg = config();
    }
    catch (e) {
        lines.push(`Cannot turn this on yet: ${e.message}.`);
        lines.push('There is no destination to consent to until a token exists. Run /qsetup.');
        return { on: false, lines };
    }
    lines.push(`  Destination   ${cfg.url}${REPORT_PATH}`);
    lines.push(`  Workspace     ${cfg.scope ? `token scoped to ${cfg.scope}` : 'scope not recorded by /qsetup'}`);
    lines.push('');
    if (!args.confirmed) {
        lines.push('Nothing has been turned on and nothing has been sent.');
        lines.push('If you want /qpact reports in the console, re-run with --yes.');
        return { on: false, destination: cfg.url, lines };
    }
    const now = args.now ?? Date.now();
    const state = {
        schema_version: SCHEMA_VERSION,
        enabled: true,
        since: new Date(now).toISOString(),
        disclosure: { version: DISCLOSURE_VERSION, sha256: disclosureDigest(standing) },
        url: cfg.url,
    };
    const path = savePush(state);
    lines.push(`Cloud shipping is ON for ${cfg.url}, recorded in ${path}.`);
    lines.push('Every /qpact from now on prints where its report went.');
    lines.push('Turn it off at any time with:  node push.mjs --off');
    return { on: true, path, destination: cfg.url, lines };
}
/** Off, and off from the next read — nothing caches this. */
export function turnOff() {
    const path = savePush({ schema_version: SCHEMA_VERSION, enabled: false });
    return {
        path,
        lines: [
            'Cloud shipping is OFF. The next /qpact sends nothing.',
            'Reports already in the console are still there — this stops new ones, it does not',
            'delete old ones.',
        ],
    };
}
/**
 * Send the report, and never throw.
 *
 * Never throwing is the contract, not an implementation detail. The local page
 * is already written and already open by the time this runs; a rejection here
 * would propagate into whatever the skill does next and turn a failed upload
 * into a failed command. Every path returns a ShipResult whose `reason` says
 * what did not happen, because a report that silently failed to ship is a
 * report the user believes is in the cloud.
 */
export async function shipReport(args) {
    const lines = [];
    const fail = (reason, extra = []) => ({
        shipped: false, reason, lines: [...lines, `  NOT SHIPPED — ${reason}`, ...extra],
    });
    // The switch first, before a token is looked for. Asking about credentials
    // ahead of consent is how "no token" gets reported for a feature the user
    // never turned on, and how a token appearing later reads as permission.
    const state = loadPush();
    if (!isOn(state)) {
        const why = offReason(state);
        return {
            shipped: false, reason: why,
            lines: [
                `  not sent to the cloud — ${why}.`,
                '  The report above is local only. Turn shipping on with:  node push.mjs --on',
            ],
        };
    }
    let spine;
    try {
        spine = JSON.parse(readFileSync(args.spinePath, 'utf8'));
    }
    catch (e) {
        return fail(`could not read the spine at ${args.spinePath}: ${e.message}`);
    }
    let html;
    try {
        html = readFileSync(args.reportPath, 'utf8');
    }
    catch (e) {
        return fail(`could not read the report at ${args.reportPath}: ${e.message}`);
    }
    const bytes = Buffer.byteLength(html, 'utf8');
    if (bytes > MAX_DOCUMENT_BYTES)
        return fail(`${args.reportPath} is ${(bytes / 1048576).toFixed(1)} MB, over the ${MAX_DOCUMENT_BYTES / 1048576} MB limit`, ['  The local report is unaffected. Nothing was sent.']);
    let cfg;
    try {
        cfg = config();
    }
    catch (e) {
        return fail(e.message, ['  Shipping is ON but there is no usable token. Run /qsetup.']);
    }
    // Consent was given for a host. This is the check that stops an environment
    // variable redirecting an existing consent somewhere else — cloud.mts already
    // refuses to pair a file token with an env URL, but a token and URL supplied
    // together resolve cleanly and would otherwise inherit this switch.
    if (state.url && state.url !== cfg.url)
        return fail(`you turned shipping on for ${state.url}, but this run resolves to ${cfg.url}`, ['  Nothing was sent. Turn it on again if the new destination is the one you want.']);
    let payload;
    try {
        payload = reportPayload({ spine, html, now: args.now });
    }
    catch (e) {
        return fail(e.message);
    }
    // Fail closed at the last moment. Anything FIELDS does not name stops here
    // rather than riding out on the socket.
    const drift = undisclosed(payload);
    if (drift.extra.length || drift.missing.length)
        return fail(`refusing to send a payload the disclosure does not describe` +
            (drift.extra.length ? ` — undisclosed: ${drift.extra.join(', ')}` : '') +
            (drift.missing.length ? ` — disclosed but absent: ${drift.missing.join(', ')}` : ''), ['  This is a bug in the plugin, not in your setup. Nothing was sent.']);
    lines.push(...reportDisclosure({ payload, destination: cfg.url, reportPath: args.reportPath, spine }));
    lines.push('');
    const headers = {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
    };
    if (cfg.actor)
        headers['x-actor'] = cfg.actor;
    // Written here rather than through cloud.mts's api() for two reasons that are
    // both load-bearing: api() has no timeout, so a black-holed socket would hold
    // the command open indefinitely after the page is already on screen; and it
    // collapses every non-2xx into one Error, discarding the status — and "over
    // quota" needs to be a different sentence from "refused". The credential
    // resolution, which is the part that must not be duplicated, still comes from
    // cloud.mts.
    const url = cfg.url.replace(/\/$/, '') + REPORT_PATH;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
    }
    catch (e) {
        const err = e;
        const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
        return fail(timedOut
            ? `${cfg.url} did not answer within ${(args.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
            : `could not reach ${cfg.url}: ${err.message}`, ['  The report above is on your machine and unaffected.']);
    }
    const body = (await res.json().catch(() => ({})));
    if (!res.ok) {
        // Quota and payload-size answers get their own sentence. Collapsed into
        // "the server refused this", a tenant over quota reads as a broken token
        // and sends somebody to /qsetup for an hour.
        const server = body.error || `HTTP ${res.status}`;
        const reason = res.status === 402 || res.status === 429 ? `${cfg.url} is over quota: ${server}`
            : res.status === 413 ? `${cfg.url} refused the report as too large: ${server}`
                : res.status === 401 || res.status === 403 ? `${cfg.url} refused this token: ${server} — run /qsetup`
                    : `${cfg.url} refused the report: ${server}`;
        return fail(reason, ['  The report above is on your machine and unaffected.']);
    }
    if (!body.id)
        return fail(`${cfg.url} accepted the report but named no id for it`);
    // Constructed only when the server did not say. A server that moves its
    // console to another host will say so here; guessing would print a link that
    // 404s and read as a failed upload.
    const link = body.url || `${cfg.url.replace(/\/$/, '')}/r/${body.id}`;
    return {
        shipped: true, id: body.id, url: link, bytes, reason: '',
        lines: [...lines, `  SHIPPED to ${link}`, `  Turn this off at any time with:  node push.mjs --off`],
    };
}
// ---------------------------------------------------------------- cli
const isMain = !!process.argv[1] && (() => {
    try {
        return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
    }
    catch {
        return false;
    }
})();
if (isMain) {
    const argv = process.argv.slice(2);
    const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
    const say = (ls) => { for (const l of ls)
        console.log(l); };
    try {
        if (argv.includes('--off')) {
            const r = turnOff();
            say(r.lines);
            process.exit(0);
        }
        if (argv.includes('--on')) {
            const r = turnOn({ confirmed: argv.includes('--yes') });
            say(r.lines);
            // Non-zero without --yes: a caller that treats exit 0 as "done" must not
            // come away believing consent was recorded when it was only offered.
            process.exit(r.on ? 0 : 1);
        }
        if (argv.includes('--ship')) {
            const spinePath = opt('--spine');
            const reportPath = opt('--report');
            if (!spinePath || !reportPath) {
                console.error('usage: push.mjs --ship --spine <spine.json> --report <report.html>');
                process.exit(1);
            }
            const r = await shipReport({ spinePath, reportPath });
            say(r.lines);
            // Exit 0 either way. A failed upload is reported, not fatal: /qpact has
            // already produced its report, and a non-zero exit here would mark the
            // whole command failed for something that did not touch it.
            process.exit(0);
        }
        // Default: state the switch, and nothing else. This command must be safe to
        // run out of curiosity.
        const state = loadPush();
        const on = isOn(state);
        console.log(`cloud shipping is ${on ? 'ON' : 'OFF'}`);
        if (on) {
            console.log(`  to        ${state.url}${REPORT_PATH}`);
            console.log(`  since     ${state.since}`);
            console.log(`  agreed to disclosure v${state.disclosure?.version} (${state.disclosure?.sha256.slice(0, 16)}…)`);
            console.log(`  recorded  ${pushTarget()}`);
            console.log('\n  See it again with:  push.mjs --on        Turn it off with:  push.mjs --off');
        }
        else {
            const why = offReason(state);
            if (state.enabled)
                console.log(`  ${why}`);
            console.log('\n  /qpact writes its report to /tmp and opens it. Nothing leaves this machine.');
            console.log('  To also have it in your console:  push.mjs --on');
        }
    }
    catch (e) {
        console.error(`error: ${e.message}`);
        process.exit(1);
    }
}
