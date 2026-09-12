#!/usr/bin/env node
// /qpact reports, readable in the cloud console. Off until you turn it on.
//
//   node push.mjs                                  # is it on, where would it go
//   node push.mjs --on                             # prints the disclosure, refuses
//   node push.mjs --on --yes                       # prints the disclosure, turns it on
//   node push.mjs --off                            # off, from the next run onward
//   node push.mjs --withhold-document              # keep the facts, stop sending the page
//   node push.mjs --skip <session-id>              # this session only
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
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDirs, configTarget } from './home.mjs';
import { config } from './cloud.mjs';
import { indexFacts, traceFacts, undisclosedFacts, undisclosedTrace, INDEX_FIELDS } from './facts.mjs';
import { redactionLimit } from './bundle.mjs';
import { version } from './version.mjs';
export const SCHEMA_VERSION = '1';
/**
 * The LOCAL STATE file's shape, which is not the wire's.
 *
 * One constant used to serve both, and that is safe in exactly one direction.
 * `loadPush()` discards a state file whose version it does not recognise, so
 * bumping the wire version — for the facts sidecar, say — would discard every
 * push.json in the install base. Today that reads as OFF and nothing ships,
 * which is survivable. Under a default that ships, a state file nobody can read
 * is not "off", it is "no record", and the difference between those two is
 * every standing opt-out in the install base.
 *
 * So they are separate, and this one moves only when the shape below does.
 */
export const STATE_SCHEMA_VERSION = '2';
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
 *  the number instead of arriving as an HTTP 413.
 *
 *  The number itself is the contract's, not this file's. services/api/src/report.ts
 *  holds the same ceiling and carried a comment asking a future reader to move
 *  both whenever one moved; contract/claims.json now holds it once and writes it
 *  into both. Two ceilings that disagree mean a user is told "too large" about a
 *  file the other side would have taken. */
// <contract:limits.document_bytes> generated from contract/claims.json — do not edit
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
/**
 * The same object, handed to the projection as what it is.
 *
 * A cast and not a validation, and that is safe here for one reason worth
 * writing down: indexFacts reads every field defensively and emits every key
 * whether or not the source had it, and undisclosedFacts then walks what it
 * produced. So a spine missing half of this yields nulls rather than a throw,
 * and a spine carrying something extra yields nothing at all — the projection
 * writes its keys out one at a time and never copies.
 */
const asSession = (spine) => spine;
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
        'prompt in it. You can withdraw a report: it stops being readable at once, and is purged ' +
        'after a hold the console states. It is not an instant delete, and this sentence used to ' +
        'say it was. What somebody already read cannot be recalled by either.',
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
    L.push(...factsDisclosure());
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
/** How many per-session skips are kept. A skip is a small fact about one
 *  session and the list is not a database; past this the oldest fall off, and
 *  the standing opt-out is the answer for somebody who wants all of them. */
export const SKIP_LIMIT = 200;
/**
 * The terms this host asserts, fetched before a report is sent.
 *
 * These are the values the SERVER owns — how long a report is kept, how long a
 * withdrawn one is held, the visibility ladder, whether trace volume is billed.
 * They are deliberately outside the consent digest: a server-owned number
 * rendered into digested text either binds somebody's agreement to a figure that
 * later stops being true, or moves the digest the moment an operator edits a
 * setting, switching shipping off for every user at once. Both are worse than
 * printing them per send and saying where they came from.
 *
 * A FIXED set of keys, rendered whether or not the host supplied them. A host
 * that omits one gets "the host did not say", never a shorter disclosure —
 * because a disclosure that silently shortens is the failure mode this whole
 * arrangement is trying to avoid, and a hostile host must not be able to
 * shorten it by leaving fields out.
 */
export const FACTS_PATH = '/v1/qpact/facts';
export const TRACE_PATH = '/v1/qpact/trace';
/**
 * The facts sidecar's disclosure, and why it is grouped rather than itemised.
 *
 * FIELDS gives every key of the report payload its own paragraph, which works
 * at fourteen. The index tier has forty-eight, and forty-eight paragraphs
 * inside a disclosure somebody has to read before pressing a key is not a more
 * honest disclosure — it is the same disclosure, unread.
 *
 * So every field is still NAMED, in groups, compactly, and the groups say what
 * kind of thing each holds. Exhaustiveness is not traded away: the list is
 * generated from the same INDEX_FIELDS the projection is walked against, so a
 * field cannot be added to what leaves without appearing here, and the digest
 * covers this text like the rest.
 *
 * The refusals are listed too. A disclosure that says what leaves and not what
 * was deliberately left out tells somebody less than it could about a payload
 * built from a spine that carries their prompts and their home directory.
 */
export function factsDisclosure() {
    const L = [];
    const group = (name, prefix) => {
        const names = INDEX_FIELDS
            .filter((f) => (prefix ? f.startsWith(`${prefix}.`) : !f.includes('.')))
            .map((f) => (prefix ? f.slice(prefix.length + 1) : f));
        if (!names.length)
            return;
        const head = `    ${name.padEnd(14)}`;
        let cur = head;
        for (const n of names) {
            if (cur.length + n.length + 2 > 78) {
                L.push(cur.replace(/,$/, ''));
                cur = ' '.repeat(head.length);
            }
            cur += `${n}, `;
        }
        L.push(cur.replace(/,\s*$/, ''));
    };
    L.push(`  POST ${FACTS_PATH} — ${INDEX_FIELDS.length} bounded fields and no others:`);
    L.push('');
    group('session', '');
    group('score', 'score');
    group('totals', 'totals');
    group('tokens', 'tokens');
    L.push('');
    L.push('    None of it can quote a prompt. `intents` and `graph` are titles and labels');
    L.push('    written by the model, which can paraphrase one; everything else is a count,');
    L.push('    a band, a name or a timestamp.');
    L.push('');
    L.push('    What it refuses, from a spine that carries all of it:');
    L.push('      file, project, cwd   the transcript path and the project key — your home');
    L.push('                           directory, and therefore your account name');
    L.push('      turns[].text         the verbatim prompt');
    L.push('      turns[].files        per-turn paths');
    L.push('      turns[].signals      the prompt\u2019s shape, which is a fingerprint of it');
    L.push('');
    L.push('    `repo` is the repository name with the worktree folded onto it, never a path.');
    L.push('    `files_touched` is repo-relative and anything escaping the repo is dropped');
    L.push('    and counted.');
    return L;
}
export const TERM_KEYS = ['retentionDays', 'holdDays', 'scopes', 'tracePriced'];
/** Its own timeout, and a short one. The upload's twenty seconds is the budget
 *  for megabytes of document; this is one small GET, and a host that cannot
 *  answer it quickly should not hold up a person's terminal. */
export const TERMS_TIMEOUT_MS = 4_000;
export const TERMS_PATH = '/v1/qpact/terms';
/**
 * Ask the host what it does with a report.
 *
 * Never throws, for the reason shipReport never does: a failure here is a thing
 * to say out loud, not a crash in the middle of a command whose real work is
 * already on screen.
 */
export async function fetchTerms(cfg, timeoutMs = TERMS_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(`${cfg.url}${TERMS_PATH}`, {
            headers: { authorization: `Bearer ${cfg.token}` },
            signal: ctrl.signal,
        });
        if (!r.ok)
            return null;
        const v = await r.json();
        if (!v || typeof v !== 'object' || Array.isArray(v))
            return null;
        return { url: cfg.url, at: new Date().toISOString(), values: v };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(t);
    }
}
/** One value from a host, made safe to print.
 *
 *  Control characters stripped and the whole thing clipped: this string came
 *  from somewhere else and is about to be printed into somebody's terminal
 *  immediately above a decision they are making. A host that can put an escape
 *  sequence there can redraw the lines above it. */
const term = (v) => {
    const raw = Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v);
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
    return clean ? clean.slice(0, 80) : 'the host did not say';
};
/**
 * The server-quoted half of the disclosure, printed on every send and OUTSIDE
 * the digest — and it says so, because a reader has to be able to tell which
 * half they agreed to and which half is being asserted at them today.
 */
export function termsLines(terms, host, fresh) {
    const L = [];
    L.push('');
    if (!terms) {
        L.push(`  WHAT ${host} DOES WITH IT — unknown`);
        L.push('');
        L.push('    This host could not be asked just now, and nothing here has ever');
        L.push('    been able to ask it. The lines above describe what LEAVES; how long');
        L.push('    it is kept, and who can read it, are that host\u2019s to state and it has');
        L.push('    not.');
        return L;
    }
    L.push(`  WHAT ${host} SAYS IT DOES WITH IT — not part of what you agreed to`);
    L.push(fresh
        ? '  asserted by the host, fetched just now'
        : `  asserted by the host, last fetched ${terms.at.slice(0, 16).replace('T', ' ')} UTC — it could not be reached just now`);
    L.push('');
    const label = {
        retentionDays: 'kept for',
        holdDays: 'withdrawn, then held',
        scopes: 'visibility ladder',
        tracePriced: 'trace volume billed',
    };
    for (const k of TERM_KEYS) {
        const v = term(terms.values[k]);
        const unit = (k === 'retentionDays' || k === 'holdDays') && v !== 'the host did not say' ? ' days' : '';
        L.push(`    ${label[k].padEnd(22)}${v}${unit}`);
    }
    return L;
}
/** A credential, reduced to something comparable and useless to anyone reading
 *  the file. Sixteen hex characters of a sha256 — enough that two distinct
 *  tokens do not collide in practice, and not enough to be a token. */
export const credentialFingerprint = (token) => createHash('sha256').update(String(token || ''), 'utf8').digest('hex').slice(0, 16);
const STATE_FILE = 'push.json';
export const pushPaths = () => configDirs().map((d) => join(d, STATE_FILE));
/** Beside the config that is actually in use — the same rule contrib.json and
 *  live.json follow, so one workspace has one answer to "is this on". */
export const pushTarget = () => join(dirname(configTarget()), STATE_FILE);
const OFF = { schema_version: STATE_SCHEMA_VERSION, enabled: false };
/**
 * Read the switch, failing closed on anything unexpected.
 *
 * A corrupt or unknown-schema file reads as OFF. For /qcontrib's ledger the
 * safe direction was the opposite — an unreadable ledger re-sends rather than
 * skipping — because there the cost of being wrong is a duplicate row. Here the
 * cost of being wrong is an upload nobody authorised, so it goes the other way.
 */
/** Can this machine record a choice at all? A machine that cannot write its
 *  answer down must not be a machine that acts on the absence of one. */
export function canRecord() {
    return [pushTarget(), ...pushPaths()].some((path) => {
        try {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            accessSync(dirname(path), constants.W_OK);
            return true;
        }
        catch {
            return false;
        }
    });
}
const mtimeOf = (p) => { try {
    return statSync(p).mtimeMs;
}
catch {
    return 0;
} };
const isWritable = (p) => { try {
    accessSync(p, constants.W_OK);
    return true;
}
catch {
    return false;
} };
export function loadPush() {
    // Read the file savePush would next WRITE, not the first that merely exists.
    //
    // They are not the same path. savePush starts at pushTarget() and falls
    // through on EPERM, so when the preferred directory turns read-only the record
    // moves to a later candidate — and a reader taking the first that EXISTS goes
    // on opening the stale copy left behind. home.mts's loadState already carries
    // this reasoning for contrib.json; push.json did not, because under an opt-in
    // default the asymmetry could only ever lose a CONSENT, and losing a consent
    // fails closed. It loses an opt-out just as easily, and that fails open.
    //
    // Writability first, mtime only to break ties among the fallbacks: these
    // candidates belong to different config directories, so "newest" can mean
    // another workspace's answer.
    const here = pushTarget();
    const found = pushPaths().filter((q) => existsSync(q));
    const p = (found.includes(here) && isWritable(here))
        ? here
        : found.sort((a, b) => mtimeOf(b) - mtimeOf(a))[0];
    if (!p)
        return { ...OFF, origin: 'absent' };
    try {
        const s = JSON.parse(readFileSync(p, 'utf8'));
        // An unrecognised shape is read as a NO, not as an absence. The two are the
        // same today, because OFF does not ship either way — they stop being the
        // same the moment a default ships, and by then this file will have been
        // written by a version that did not make the distinction.
        if (!s || typeof s !== 'object')
            return { ...OFF, origin: 'unreadable' };
        // A version-1 record is READ rather than discarded, and the two answers it
        // can hold are not the same.
        //
        // A discarded record is an absence, and an absence is an invitation to ask
        // again — which for somebody who had opted out means being promoted back
        // into shipping by a version bump. So `enabled: false` is carried across as
        // the no it was. `enabled: true` is carried across as something weaker than
        // consent: they accepted A disclosure, not this one, so it earns one
        // deferred run and not a send.
        if (s.schema_version === '1' && typeof s.enabled === 'boolean')
            return { ...s, optedOut: !s.enabled, origin: s.enabled ? 'legacy-consented' : 'opted-out' };
        if (s.schema_version !== STATE_SCHEMA_VERSION)
            return { ...OFF, origin: 'unreadable' };
        if (s.optedOut === true)
            return { ...s, origin: 'opted-out' };
        return { ...s, origin: s.shown ? 'consented' : 'absent' };
    }
    catch {
        return { ...OFF, origin: 'unreadable' };
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
/**
 * Would this machine ship, right now?
 *
 * Expressed in terms of the gate rather than beside it. There used to be a
 * switch to read; two functions each deciding for themselves what "on" means
 * would be two answers to one question, which is how a status line and a send
 * end up disagreeing about the same machine.
 */
export function isOn(state = loadPush()) {
    return decide(state).act === 'ship';
}
/** Why a machine that could ship is not going to. Empty when it would. */
export function offReason(state = loadPush()) {
    const d = decide(state);
    return d.act === 'ship' ? '' : d.why;
}
/** Resolve the workspace and ask the gate. Shared by both, so they cannot drift
 *  from each other or from shipReport. */
function decide(state) {
    let cfg = null;
    let configError = null;
    try {
        cfg = config();
    }
    catch (e) {
        configError = e.message;
    }
    return shipDecision({ state, cfg, configError });
}
/**
 * The gate. One function, five answers, and only one of them sends.
 *
 * ── What changed, and what did not ────────────────────────────────────────
 * The default is now to ship: a workspace that is configured is a workspace
 * this machine will send to. What has NOT changed is that nothing leaves before
 * the person has been shown, in full, what leaves — that is `needs-disclosure`,
 * which prints and deliberately sends nothing on that run.
 *
 * One deferred run per disclosure version is the whole cost, and it buys the
 * thing the reversal would otherwise destroy. An existing install already holds
 * a token minted by /qsetup for /qcontrib or /qshare; without the deferral the
 * first /qpact after an upgrade posts that person's entire prompt history with
 * no act on their part and nothing on screen beforehand. An opt-out nobody was
 * told about is not an opt-out.
 *
 * ── Why it is keyed on four things ────────────────────────────────────────
 * The digest says the TEXT has not changed. It says nothing about WHERE this
 * run resolves to, and two tokens for two workspaces share a hostname — so the
 * record binds the disclosure, the destination, and the credential that names
 * the workspace. Any of them moving earns the disclosure again rather than a
 * send.
 *
 * ── Order, which is itself a decision ─────────────────────────────────────
 * `cannot-record` comes first. A machine that cannot write down an answer must
 * not act on the absence of one, and every outcome below it assumes the record
 * it reads is a record somebody could have changed.
 *
 * Then the standing no, before the workspace is even looked at: asking about
 * credentials ahead of a refusal is how "no token" gets reported to somebody who
 * simply said no.
 */
export function shipDecision(args) {
    const { state, cfg, configError, sessionId } = args;
    if (!canRecord())
        return {
            act: 'cannot-record',
            why: 'this machine cannot write down whether you want reports shipped, so it does not ship them',
            remedy: ['  Set SESSION_VIZ_HOME to a directory this harness can write, then run /qpact again.'],
        };
    if (state.origin === 'unreadable')
        return {
            act: 'opted-out',
            why: 'the local record of your choice will not parse, and an unreadable answer is read as a no',
            remedy: [
                `  Nothing was sent. Delete ${pushTarget()} to be asked again, or run push.mjs --on to accept now.`,
            ],
        };
    if (state.optedOut === true)
        return { act: 'opted-out', why: 'you turned report shipping off on this machine' };
    if (sessionId && (state.skipped || []).includes(sessionId))
        return { act: 'opted-out', why: 'this session was skipped' };
    if (!cfg)
        return {
            act: 'no-workspace',
            why: configError || 'there is no workspace configured on this machine',
            remedy: ['  Nothing was sent, and nothing is waiting to be. Run /qsetup to connect one.'],
        };
    const cred = credentialNow(cfg);
    const digest = disclosureDigest();
    const shown = state.shown;
    if (!shown)
        return {
            act: 'needs-disclosure',
            why: state.origin === 'legacy-consented'
                ? 'what /qpact sends has changed since you last agreed to it'
                : 'this machine has not been shown what /qpact sends',
        };
    if (shown.disclosure.sha256 !== digest)
        return { act: 'needs-disclosure', why: 'what /qpact sends has changed since you were shown it' };
    if (shown.url !== cfg.url)
        return { act: 'needs-disclosure', why: `you were shown this for ${shown.url}, and this run resolves to ${cfg.url}` };
    if (shown.credential.fingerprint !== cred.fingerprint)
        return {
            act: 'needs-disclosure',
            why: 'the credential changed, so this run would send to a workspace you have not been shown this for',
            // Which kind each was, because "the credential changed" is the same
            // sentence for a rotated token and for an environment variable pointing
            // somewhere else entirely, and only one of those is somebody's mistake.
            remedy: [`  You were shown this for a ${shown.credential.source} credential; this run uses a ${cred.source} one.`],
        };
    // A print that went nowhere a person could read is not a showing.
    //
    // The escape is deliberate and is still a human act: somebody reads the
    // disclosure once and sets the variable to its digest. What it refuses is the
    // shape where an unattended run prints into a log nobody opens and treats its
    // own output as consent.
    if (!shown.tty && process.env.SESSION_VIZ_SHIP_ACK !== digest)
        return {
            act: 'needs-disclosure',
            why: 'the disclosure was printed where no terminal was attached, so nothing here knows it was read',
            remedy: [
                '  Run /qpact once interactively, or set SESSION_VIZ_SHIP_ACK to the digest printed below.',
            ],
        };
    return { act: 'ship', why: `shipping to ${cfg.url}` };
}
/** The credential this run would use, as the record stores it. */
export function credentialNow(cfg) {
    return {
        source: process.env.SESSION_VIZ_TOKEN ? 'env' : 'file',
        fingerprint: credentialFingerprint(cfg.token),
    };
}
/**
 * Print the disclosure and record that it was printed — one call, for the
 * reason turnOn is one call: two functions is an arrangement where the printing
 * one can be skipped, and "they were shown this" then rests on whoever wired it
 * up. The write is downstream of the print in the same call stack.
 *
 * It records what it did, including whether anything was attached to read it,
 * and it returns the lines so a caller can pass them through rather than
 * summarising them.
 */
export function noteShown(args) {
    const standing = standingDisclosure();
    const lines = [...standing];
    const digest = disclosureDigest(standing);
    const tty = args.isTty ?? Boolean(process.stdout.isTTY);
    lines.push('');
    lines.push(`  Destination   ${args.cfg.url}`);
    lines.push(`  Disclosure    ${digest}`);
    lines.push('');
    lines.push('  Reports from this machine will be sent there from the NEXT /qpact on.');
    lines.push('  Nothing has been sent yet, including this run.');
    lines.push('');
    lines.push('  To stop that:   node push.mjs --off');
    lines.push('  For one session: node push.mjs --skip <session-id>');
    if (!tty) {
        lines.push('');
        lines.push('  Nothing was attached to read this, so it does not count as having been read.');
        lines.push(`  Run it where you can see it, or set SESSION_VIZ_SHIP_ACK=${digest}`);
    }
    const prev = loadPush();
    const path = savePush({
        schema_version: STATE_SCHEMA_VERSION,
        optedOut: false,
        skipped: prev.skipped || [],
        shown: {
            at: new Date(args.now ?? Date.now()).toISOString(),
            disclosure: { version: DISCLOSURE_VERSION, sha256: digest },
            url: args.cfg.url,
            credential: credentialNow(args.cfg),
            tty,
        },
    });
    return { path, lines };
}
/** The standing no. */
export function optOut() {
    const prev = loadPush();
    const path = savePush({ ...prev, origin: undefined, schema_version: STATE_SCHEMA_VERSION, optedOut: true });
    return {
        path,
        lines: [
            `Report shipping is OFF for this machine, recorded in ${path}.`,
            'The next /qpact sends nothing.',
            'This does not delete what was already sent: reports already in the console stay',
            'there until you withdraw them from the report page, or they are purged.',
        ],
    };
}
/** Withhold the page and keep sending the facts, or the reverse. */
export function withholdDocument(on) {
    const prev = loadPush();
    const path = savePush({ ...prev, origin: undefined, schema_version: STATE_SCHEMA_VERSION, documentWithheld: on });
    return {
        path,
        lines: on
            ? [
                `The rendered page will NOT be sent from this machine. Recorded in ${path}.`,
                'The bounded facts still are, so this session keeps appearing in your workspace\u2019s',
                'roll-up — counts, bands, repo and branch, and nothing that can quote a prompt.',
                'Pages already sent stay until you withdraw them.',
            ]
            : [`The rendered page will be sent again from this machine. Recorded in ${path}.`],
    };
}
/** One session, skipped. Bounded, oldest first. */
export function skipSession(sessionId) {
    const prev = loadPush();
    const skipped = [...(prev.skipped || []).filter((s) => s !== sessionId), sessionId].slice(-SKIP_LIMIT);
    const path = savePush({ ...prev, origin: undefined, schema_version: STATE_SCHEMA_VERSION, skipped });
    return { path, lines: [`Session ${sessionId} will not be shipped. Recorded in ${path}.`] };
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
    // The explicit accept. Under an opt-in default this was the switch; under a
    // default that ships there is no switch, and what a person is doing when they
    // run --on is saying they have read the disclosure. So it delegates to the one
    // function that prints and records together, rather than being a second way
    // to write the same record.
    //
    // `confirmed` still gates it and a caller still must not supply it on the
    // human's behalf — the skill says so where an agent will read it. Without it
    // the disclosure is printed and nothing is written, which is the same shape as
    // before and still exits non-zero at the CLI.
    let cfg;
    try {
        cfg = config();
    }
    catch (e) {
        return { on: false, lines: [e.message, 'Run /qsetup to connect a workspace first.'] };
    }
    if (!args.confirmed) {
        const preview = [...standingDisclosure(), '', `  Destination   ${cfg.url}`, ''];
        preview.push('Nothing has been recorded and nothing has been sent.');
        preview.push('Re-run with --yes to record that you have read this.');
        return { on: false, destination: cfg.url, lines: preview };
    }
    // tty defaults TRUE here and only here: somebody typed this command. That is
    // the difference between a person accepting a disclosure and a scheduled task
    // printing one into a log.
    const note = noteShown({ cfg, now: args.now, isTty: args.isTty ?? true });
    return { on: true, path: note.path, destination: cfg.url, lines: note.lines };
}
export function turnOff() {
    // One name for one act. optOut is the record; this stays because the CLI and
    // the skill have said --off for as long as the feature has existed.
    return optOut();
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
    // The spine is read first now, which is a reversal of the old order and worth
    // saying why. It used to ask the switch before it looked for a token, so that
    // "no token" could never be reported to somebody who had simply not turned the
    // feature on. Under a default that ships there is no switch to ask first, and
    // the gate needs the session id to honour a per-session skip. Reading a local
    // file decides nothing and sends nothing; the gate still runs before any
    // credential is used for anything.
    let spine;
    try {
        spine = JSON.parse(readFileSync(args.spinePath, 'utf8'));
    }
    catch (e) {
        return fail(`could not read the spine at ${args.spinePath}: ${e.message}`);
    }
    // The local record, read before the size check so the next two decisions can
    // both see it. It touches nothing and sends nothing.
    const state = loadPush();
    // The size refusal comes BEFORE the gate, and stays there.
    //
    // It is a local fact: this file is too large to send anywhere, to any
    // workspace, under any consent. Deciding it first means somebody with a 9 MB
    // report is told that, rather than being told their destination changed —
    // both of which can be true at once, and only one of which they can act on.
    // Nothing here opens a socket, so nothing is leaked by checking it early.
    let html;
    try {
        html = readFileSync(args.reportPath, 'utf8');
    }
    catch (e) {
        return fail(`could not read the report at ${args.reportPath}: ${e.message}`);
    }
    const bytes = Buffer.byteLength(html, 'utf8');
    // Not when the page is withheld: its size decides nothing, and refusing a
    // send that was never going to happen would report a problem the person has
    // already solved.
    if (!state.documentWithheld && bytes > MAX_DOCUMENT_BYTES)
        return fail(`${args.reportPath} is ${(bytes / 1048576).toFixed(1)} MB, over the ${MAX_DOCUMENT_BYTES / 1048576} MB limit`, ['  The local report is unaffected. Nothing was sent.']);
    let cfg = null;
    let configError = null;
    try {
        cfg = config();
    }
    catch (e) {
        configError = e.message;
    }
    const decision = shipDecision({
        state, cfg, configError, sessionId: spine.sessionId ?? null, isTty: args.isTty,
    });
    if (decision.act === 'needs-disclosure') {
        // Printed and recorded here, and NOTHING is sent on this run. The deferral
        // is the feature: it is the one run that stands between an upgrade and a
        // machine posting somebody's prompt history before they have read a word.
        const note = noteShown({ cfg: cfg, now: args.now, isTty: args.isTty });
        return {
            shipped: false,
            reason: decision.why,
            lines: [
                `  NOT SHIPPED — ${decision.why}.`,
                '',
                ...note.lines,
                '',
                `  Recorded in ${note.path}.`,
                ...(decision.remedy || []),
            ],
        };
    }
    if (decision.act !== 'ship') {
        return {
            shipped: false,
            reason: decision.why,
            lines: [`  not sent to the cloud — ${decision.why}.`, ...(decision.remedy || [])],
        };
    }
    // `cfg` is non-null here: shipDecision returns 'no-workspace' when it is not,
    // and only 'ship' reaches this line.
    const dest = cfg;
    // The destination and credential checks that used to live here are gone, not
    // relaxed: shipDecision makes both, and it makes them against the record this
    // build actually writes. What was here read `state.url` and `state.credential`
    // — version-1 fields that nothing has written since the gate landed — so it
    // was two checks that could no longer fire, sitting under comments explaining
    // why they were essential. Dead code asserting a model the code no longer has
    // is worse than no code: the next person reads it as the mechanism.
    // ── What the host says it does, asked before anything is sent ────────────
    //
    // Before the POST and on its own short timeout, not the upload's twenty
    // seconds: this is one small GET, and a host that cannot answer it quickly
    // should not hold up somebody's terminal.
    //
    // A host that cannot be reached AND has never once been reached is a refusal.
    // The alternative is printing the fields that leave with nothing about what
    // becomes of them — a disclosure that silently shortens, which is the shape
    // this whole arrangement exists to avoid. A host that has answered before is
    // quoted from cache with the date attached, because "kept 90 days" read
    // months later is a different claim from the one that was fetched.
    const freshTerms = await fetchTerms(dest);
    const cachedTerms = state.terms && state.terms.url === dest.url ? state.terms : null;
    const terms = freshTerms || cachedTerms;
    if (!terms)
        return fail(`${dest.url} could not be asked what it does with a report, and never has been`, [
            '  Nothing was sent, and the local report is unaffected. What leaves is known;',
            '  how long it is kept and who can read it are that host\u2019s to state, and it',
            '  has not.',
        ]);
    if (freshTerms) {
        try {
            savePush({ ...state, origin: undefined, terms: freshTerms });
        }
        catch { /* a cache is not worth failing a send over */ }
    }
    lines.push(...termsLines(terms, dest.url, Boolean(freshTerms)));
    // ── The page withheld, the facts still sent ─────────────────────────────
    //
    // Before the document is even read. The two payloads expose differently: the
    // page is every prompt in the session, verbatim; the sidecar is counts, bands
    // and names. Somebody who wants their team's roll-up to be complete should
    // not have to ship their prompts to achieve it, and somebody who withholds
    // their prompts should not vanish from the numbers as a side effect — the
    // shape of that absence is its own disclosure.
    if (state.documentWithheld) {
        const withheld = await sendSidecars(spine, dest, args, lines, {
            shipped: false,
            head: '  PAGE WITHHELD — you turned the rendered report off; the bounded facts still go',
        });
        return { ...withheld, reason: 'the rendered page is withheld from this machine' };
    }
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
    lines.push(...reportDisclosure({ payload, destination: dest.url, reportPath: args.reportPath, spine }));
    lines.push('');
    const headers = {
        authorization: `Bearer ${dest.token}`,
        'content-type': 'application/json',
    };
    if (dest.actor)
        headers['x-actor'] = dest.actor;
    // Written here rather than through cloud.mts's api() for two reasons that are
    // both load-bearing: api() has no timeout, so a black-holed socket would hold
    // the command open indefinitely after the page is already on screen; and it
    // collapses every non-2xx into one Error, discarding the status — and "over
    // quota" needs to be a different sentence from "refused". The credential
    // resolution, which is the part that must not be duplicated, still comes from
    // cloud.mts.
    const url = dest.url.replace(/\/$/, '') + REPORT_PATH;
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
            ? `${dest.url} did not answer within ${(args.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
            : `could not reach ${dest.url}: ${err.message}`, ['  The report above is on your machine and unaffected.']);
    }
    const body = (await res.json().catch(() => ({})));
    if (!res.ok) {
        // Quota and payload-size answers get their own sentence. Collapsed into
        // "the server refused this", a tenant over quota reads as a broken token
        // and sends somebody to /qsetup for an hour.
        const server = body.error || `HTTP ${res.status}`;
        const reason = res.status === 402 || res.status === 429 ? `${dest.url} is over quota: ${server}`
            : res.status === 413 ? `${dest.url} refused the report as too large: ${server}`
                : res.status === 401 || res.status === 403 ? `${dest.url} refused this token: ${server} — run /qsetup`
                    : `${dest.url} refused the report: ${server}`;
        return fail(reason, ['  The report above is on your machine and unaffected.']);
    }
    if (!body.id)
        return fail(`${dest.url} accepted the report but named no id for it`);
    // Constructed only when the server did not say. A server that moves its
    // console to another host will say so here; guessing would print a link that
    // 404s and read as a failed upload.
    const link = body.url || `${dest.url.replace(/\/$/, '')}/r/${body.id}`;
    return await sendSidecars(spine, dest, args, lines, {
        shipped: true, id: body.id, url: link, bytes,
        head: `  SHIPPED to ${link}`,
    });
}
/**
 * The sidecar and the trace, sent after the document — or instead of it.
 *
 * One function because both callers send the same things for the same reasons,
 * and two copies of "what else goes with a report" is how one of them acquires
 * a field the other does not have.
 *
 * ── The sidecar, reported separately ─────────────────────────────────────
 *
 * Two payloads, two outcomes, and the word "shipped" never stands alone again.
 * The report is the page somebody can check; the sidecar is the structure a
 * colleague can query, and they succeed and fail independently. The document's
 * success is not conditional on either: a sidecar that fails leaves a report
 * that is already there, and saying so beats unwinding a send that worked.
 */
async function sendSidecars(spine, dest, args, lines, out) {
    //
    // Two payloads, two outcomes, and the word "shipped" never stands alone
    // again. The report is the page somebody can check; the sidecar is the
    // structure a colleague can query, and they can succeed and fail
    // independently. One line saying "shipped" over a half-send would be the same
    // failure as a report somebody believes is in the cloud and is not.
    //
    // The document's success is not conditional on this. A sidecar that fails
    // leaves a report that is already there, and saying so is better than
    // unwinding a send that worked.
    // The model-written half of the tier, read from the file step 5 printed.
    // Two refusals, both local and both said out loud: a file that will not
    // parse, and a file that names a different session. The second is the one
    // that matters — the store carries earlier sessions as `prior`, but a render
    // file for another session is another session's conclusions, and they must
    // not be filed under this one because a path was copied wrong.
    let intentDoc = null;
    let intentNote = null;
    if (args.intentPath) {
        try {
            const doc = JSON.parse(readFileSync(args.intentPath, 'utf8'));
            const declared = typeof doc.sessionId === 'string' ? doc.sessionId : null;
            if (declared && declared !== String(spine.sessionId)) {
                intentNote = `  INTENTS NOT SENT — ${args.intentPath} describes session ${declared.slice(0, 8)}, not ${String(spine.sessionId).slice(0, 8)}; the facts went without them`;
            }
            else {
                intentDoc = doc;
            }
        }
        catch (e) {
            intentNote = `  INTENTS NOT SENT — could not read ${args.intentPath}: ${e.message}; the facts went without them`;
        }
    }
    const facts = indexFacts(asSession(spine), { pluginVersion: version() }, intentDoc);
    const und = undisclosedFacts(facts);
    if (und.extra.length || und.missing.length) {
        // Fail closed, exactly as the report payload does: a field the disclosure
        // does not name never reaches a socket, and a field it promises never goes
        // missing without somebody being told.
        return {
            ...out, reason: '', factsShipped: false,
            lines: [...lines, out.head,
                `  FACTS NOT SENT — the sidecar carries ${und.extra.length} field(s) the disclosure does not name` +
                    `${und.missing.length ? ` and is missing ${und.missing.length} it promises` : ''}.`,
                `    ${[...und.extra, ...und.missing].slice(0, 6).join(', ')}`,
                `    This is a defect in this build, not something you can fix.${out.shipped ? ' The report above went.' : ''}`],
        };
    }
    // The bare facts object, not an envelope around it.
    //
    // This shipped as `{ schema_version, facts }` and the server validated the
    // ENVELOPE, so every send came back "facts carries 1 field the contract does
    // not name: facts". Both sides were tested and both passed: the plugin
    // asserted the payload against its own walk, the server asserted its own
    // shape, and nothing asserted the two agree. The disclosure was right all
    // along — it says "48 bounded fields and no others", which is this object.
    //
    // `schema_version` is not lost: it is one of the 48, inside the facts.
    const fr = await post(`${dest.url}${FACTS_PATH}`, dest, facts, args.timeoutMs);
    const nI = facts.intents.length;
    const nC = facts.graph.concepts.length;
    const carried = nI || nC
        ? `with ${nI} intent${nI === 1 ? '' : 's'} and ${nC} concept${nC === 1 ? '' : 's'}`
        : args.intentPath ? 'with no intents' : 'with no intents — pass --intent <render file> to send them';
    const factsLine = fr.ok
        ? `  FACTS SENT — the session is in the workspace roll-up, ${carried}`
        : `  FACTS NOT SENT — ${fr.why}.${out.shipped ? ' The report above went and is unaffected.' : ''}`;
    if (intentNote)
        lines.push(intentNote);
    // ── The trace, only when the extractor was asked to keep one ────────────
    //
    // There is no flag here and there should not be: retention is extract's
    // decision, made with --with-trace, and a spine without one has nothing to
    // send. A switch in this file would be a second place to turn the most
    // exposing payload in the product on.
    // Through the projection, not raw.
    //
    // extract's RetainedCall is the SOURCE shape — startedAt, durationMs,
    // errorKind, resultBytes — and traceFacts is what turns it into the wire
    // shape the contract names. Posting spine.trace directly sent the source
    // shape and the server refused every call by name. facts.mts had the
    // projection the whole time and this line did not call it.
    const raw = spine.trace;
    const calls = Array.isArray(raw) ? traceFacts(raw) : [];
    let traceLine = null;
    if (calls.length) {
        // The same fail-closed walk the facts get. A trace call carrying a field the
        // contract does not name never reaches a socket — and finding that out here
        // names the field instead of spending a round trip to be told.
        const bad = calls.map((c) => undisclosedTrace(c)).find((u) => u.extra.length || u.missing.length);
        if (bad) {
            return {
                ...out, reason: '', factsShipped: fr.ok,
                lines: [...lines, out.head, factsLine,
                    `  TRACE NOT SENT — a call carries ${bad.extra.length} field(s) the contract does not name` +
                        `${bad.missing.length ? ` and is missing ${bad.missing.length}` : ''}: ${[...bad.extra, ...bad.missing].join(', ')}`,
                    '    This is a defect in this build, not something you can fix.'],
            };
        }
        const tr = await post(`${dest.url}${TRACE_PATH}`, dest, { sessionId: spine.sessionId, calls }, args.timeoutMs);
        traceLine = tr.ok
            ? `  TRACE SENT — ${calls.length} tool call(s), inputs and results, readable by you and workspace admins`
            : `  TRACE NOT SENT — ${tr.why}`;
    }
    return {
        ...out, reason: '', factsShipped: fr.ok,
        lines: [...lines, out.head, factsLine, ...(traceLine ? [traceLine] : []),
            `  Turn this off at any time with:  node push.mjs --off`],
    };
}
/** One POST, reduced to shipped-or-why. Used for the sidecar, whose failure is
 *  reported beside the document's success rather than replacing it. */
async function post(url, cfg, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
        if (r.ok)
            return { ok: true };
        let why = `HTTP ${r.status}`;
        try {
            const b = await r.json();
            if (b?.error)
                why = b.error;
        }
        catch { /* a refusal with no body is still a refusal */ }
        return { ok: false, why };
    }
    catch (e) {
        return { ok: false, why: `could not reach ${url}: ${e.message}` };
    }
    finally {
        clearTimeout(t);
    }
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
            const r = optOut();
            say(r.lines);
            process.exit(0);
        }
        if (argv.includes('--withhold-document') || argv.includes('--send-document')) {
            const r = withholdDocument(argv.includes('--withhold-document'));
            say(r.lines);
            process.exit(0);
        }
        if (argv.includes('--skip')) {
            const sid = opt('--skip');
            if (!sid) {
                console.error('usage: push.mjs --skip <session-id>');
                process.exit(1);
            }
            const r = skipSession(sid);
            say(r.lines);
            process.exit(0);
        }
        // --on is now "show me the disclosure and record that I read it", which is
        // what the default needs rather than a switch. It still prints in full, and
        // it still records nothing that was not printed in the same call.
        if (argv.includes('--on')) {
            let cfg;
            try {
                cfg = config();
            }
            catch (e) {
                console.error(e.message);
                process.exit(1);
            }
            const r = noteShown({ cfg });
            say(r.lines);
            say([``, `Recorded in ${r.path}.`]);
            process.exit(0);
        }
        if (argv.includes('--ship')) {
            const spinePath = opt('--spine');
            const reportPath = opt('--report');
            const intentPath = opt('--intent') || undefined;
            if (!spinePath || !reportPath) {
                console.error('usage: push.mjs --ship --spine <spine.json> --report <report.html> [--intent <intent.json>]');
                process.exit(1);
            }
            const r = await shipReport({ spinePath, reportPath, intentPath });
            say(r.lines);
            // Exit 0 either way. A failed upload is reported, not fatal: /qpact has
            // already produced its report, and a non-zero exit here would mark the
            // whole command failed for something that did not touch it.
            process.exit(0);
        }
        // Default: state what WOULD happen on the next /qpact, and do nothing. This
        // command must be safe to run out of curiosity, and under a default that
        // ships it has to answer a different question than it used to — not "is a
        // switch on" but "would this machine send, and if not, why not".
        {
            const st = loadPush();
            let c = null;
            let ce = null;
            try {
                c = config();
            }
            catch (e) {
                ce = e.message;
            }
            const d = shipDecision({ state: st, cfg: c, configError: ce });
            say([
                d.act === 'ship'
                    ? `The next /qpact WOULD ship: ${d.why}.`
                    : `The next /qpact would NOT ship — ${d.why}.`,
                ...(d.remedy || []),
                '',
                d.act === 'ship'
                    ? '  Stop it with:  node push.mjs --off      one session:  node push.mjs --skip <id>'
                    : '  See what would be sent with:  node push.mjs --on',
            ]);
            process.exit(0);
        }
        // eslint-disable-next-line no-unreachable
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
