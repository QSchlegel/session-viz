#!/usr/bin/env node
// Contribute this machine's delivery ledger to the shared reference, as nine
// bounded columns and nothing else.
//
//   node qcontrib.mjs                 # what would leave, and what stays here
//   node qcontrib.mjs --review        # the literal payload, byte for byte
//   node qcontrib.mjs --send --yes    # send it
//
// ── Why this command exists ─────────────────────────────────────────────────
// The shared reference is fed by one endpoint, and until now nothing on a
// user's machine called it. The console's checklist asks you to "send your
// first findings" and the only instruction it could offer named a script that
// lives in the server's own repository. So the one required step in setting
// this up was the one step there was no way to take.
//
// ── Why it is a separate command and not a flag on /qruns ───────────────────
// runs.mjs is spawned as a library by /qfeed and /qshare. Putting a bearer
// token and a fetch inside it would invert that, and it would break the one
// invariant a nervous reader can hold in their head: the six read-only commands
// never open a socket. /qcontrib opens one; that is what its name is for.
//
// ── The consent ladder, which is /qshare's ──────────────────────────────────
// Run it bare and nothing leaves. --review prints the exact bytes --send would
// post, built by the same call, so the two cannot disagree. --send without
// --yes refuses with a non-zero exit rather than prompting: the second
// invocation IS the consent, and a y/n on a terminal is not a record of one.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { emitJson } from './out.mjs';
import { loadState, saveState, stateTarget } from './home.mjs';
import { config, introspect } from './cloud.mjs';
import { toFinding, validateFinding, describe, withheld } from './finding.mjs';
const run = promisify(execFile);
const HERE = new URL('.', import.meta.url).pathname;
const BIG = { maxBuffer: 64 * 1024 * 1024 };
/**
 * Batch size, set by the BODY limit rather than the item limit.
 *
 * The route accepts 5000 findings per request and rejects bodies over 1 MiB. A
 * minified finding is roughly 200 bytes, so 5000 of them is about 0.95 MiB —
 * inside the cap only until one task_class runs long. And an over-limit body is
 * not answered with a 400: the connection is destroyed, so the client sees a
 * socket hang-up and has nothing to report. 1000 keeps the two limits from ever
 * being in the same conversation.
 */
const BATCH = 1000;
/**
 * How recently a transcript may have been touched and still be contributed.
 *
 * A finding is a permanent row with no update path — the endpoint has no
 * idempotency key, so a run sent mid-flight can never be corrected, only
 * duplicated. A session still being typed into would be frozen as `zombie` or
 * `abandoned_mid_tool` and stay that way in the shared numbers forever.
 */
const WARM_MS = 30 * 60 * 1000;
const HOME = homedir();
const n = (x) => x.toLocaleString('en-GB');
async function collect(since) {
    // Spawned rather than imported, the same way /qfeed and /qshare read it: the
    // ledger is a full corpus scan and its JSON is large, and a subprocess with a
    // 64 MB buffer is the boundary that has already been proven at this size.
    const args = ['--json', ...(since ? ['--since', since] : [])];
    const { stdout } = await run('node', [join(HERE, 'runs.mjs'), ...args], BIG);
    return JSON.parse(stdout).runs || [];
}
const emptyState = () => ({ schema_version: 'contrib_v1', sent: {} });
/**
 * One transcript, one finding, ever.
 *
 * Keyed on the file and its first timestamp rather than the file alone, so a
 * rolled-over path that reuses a name is a different run. realpath resolves the
 * symlinked home directories some harnesses install; Cursor addresses a
 * conversation as `<db>#<composerId>`, which is not a path at all, so a failure
 * to resolve falls back to the string — a stable key is the requirement, not a
 * canonical one.
 */
function runKey(r) {
    let file = r.file;
    try {
        file = realpathSync(r.file);
    }
    catch { /* not a path on disk: the string is the identity */ }
    return createHash('sha256').update(file + '\0' + r.started).digest('hex');
}
function select(runs, state, force) {
    const now = Date.now();
    const eligible = [];
    const findings = [];
    const held = [];
    let alreadySent = 0, warm = 0;
    for (const r of runs) {
        if (!force && state.sent[runKey(r)]) {
            alreadySent++;
            continue;
        }
        const touched = Date.parse(r.ended || r.started);
        if (Number.isFinite(touched) && now - touched < WARM_MS) {
            warm++;
            continue;
        }
        const f = toFinding(r);
        const err = validateFinding(f);
        // Held back, not sent and hoped for. The server names the index of a
        // rejected item and never the value that was wrong, so anything invalid
        // that leaves this machine is a rejection nobody can act on.
        if (err) {
            held.push({ run: r, finding: f, err });
            continue;
        }
        eligible.push(r);
        findings.push(f);
    }
    return { all: runs, eligible, findings, alreadySent, warm, held };
}
// ---------------------------------------------------------------- disclosure
function disclose(sel) {
    const d = describe(sel.findings, sel.eligible, HOME);
    const weeks = [...new Set(sel.findings.map((f) => f.iso_week))].sort();
    const out = [];
    out.push('qcontrib — the delivery ledger, reduced to nine bounded columns');
    out.push('');
    out.push(`  ${n(sel.all.length)} run(s) on this machine · ${n(sel.eligible.length)} new · ` +
        `${n(sel.alreadySent)} already sent · ${n(sel.warm)} still warm (held back)`);
    if (weeks.length)
        out.push(`  weeks ${weeks[0]} … ${weeks[weeks.length - 1]}`);
    out.push('');
    out.push('  what would leave');
    out.push(`    ${d.fields.length} field(s) per finding: ${d.fields.join(', ')}`);
    out.push(`    ${n(d.bytes)} bytes · ${n(sel.findings.length)} findings · ` +
        `${d.fields.length}/9 declared fields, ${d.unknown.length} unknown` +
        (d.unknown.length ? ` — ${d.unknown.join(', ')}, THIS IS A BUG` : ''));
    out.push(`    ${d.textFields} field(s) carrying verbatim prompt text`);
    out.push(`    ${d.homePaths} absolute home path(s) — ${d.homePaths === 0 ? 'the schema has no field for one' : 'STILL PRESENT, this is a bug'}`);
    out.push(`    ${d.repoNames} repo name(s) — ${d.repoNames === 0 ? 'the schema has no field for one' : 'STILL PRESENT, this is a bug'}`);
    if (d.taskClasses.length) {
        // task_class is the ONE field a caller controls — everything else is an
        // enum or a bounded integer. So its values are listed literally rather than
        // counted, the way /qshare lists its prompt-text count: a reader can only
        // object to a value they have been shown.
        out.push(`    task_class values leaving: ${d.taskClasses.join(', ')}`);
    }
    out.push('');
    const w = sel.eligible[0];
    if (w) {
        const others = sel.eligible.length - 1;
        const distinct = (f) => [...new Set(sel.eligible.map(f).filter(Boolean))].slice(0, 4).join(', ') || '(none recorded)';
        out.push('  what stays on this machine');
        for (const { k, v } of withheld(w)) {
            const extra = k === 'file' && others > 0 ? `   (and ${n(others)} other${others === 1 ? '' : 's'})`
                : k === 'repo' ? `   — all of them: ${distinct((r) => r.repo)}`
                    : k === 'model' ? `   — all of them: ${distinct((r) => r.model || '')}`
                        : k === 'started' ? `   (only the ISO week leaves: ${toFinding(w).iso_week})`
                            : k === 'harness' ? `   — all of them: ${distinct((r) => r.harness)}`
                                : '';
            out.push(`    ${k.padEnd(10)} ${v}${extra}`);
        }
        out.push('');
    }
    if (sel.held.length) {
        out.push(`  ${sel.held.length} finding(s) held back — this machine's copy of the server's rules refused them:`);
        for (const h of sel.held.slice(0, 10)) {
            out.push(`    ${h.err}  —  task=${JSON.stringify(h.finding.task_class)} band=${JSON.stringify(h.finding.cli_band)} week=${JSON.stringify(h.finding.iso_week)}`);
        }
        out.push('');
    }
    return out;
}
/**
 * One batch, with the status code kept.
 *
 * Deliberately not cloud.mts's api(): that collapses every failure into a
 * message, and this path needs the status to tell a 5xx worth retrying from a
 * 403 that means "mint a different token" — and needs the body on a 400, which
 * is where the per-item rejections live.
 */
async function postBatch(cfg, findings) {
    const url = cfg.url.replace(/\/$/, '') + '/v1/contrib';
    const headers = {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
    };
    if (cfg.actor)
        headers['x-actor'] = cfg.actor;
    // NOT retried, deliberately.
    //
    // /v1/contrib takes no idempotency key and does no deduplication, and this
    // client records what it sent only after a reply arrives. So a connection
    // that drops AFTER the server has committed the batch is indistinguishable
    // from one that drops before — and retrying turns the first case into
    // double-counted findings in an aggregate nobody can later unpick, under a
    // schema version that cannot tell the copies apart.
    //
    // A retry loop is the right shape once the server can recognise a repeat.
    // Until then, an honest "unknown, look before you re-run" beats a resilience
    // feature that silently corrupts the thing it is protecting. The batches are
    // small and re-running after a check is cheap.
    let r;
    try {
        r = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ findings }) });
    }
    catch (e) {
        throw new Error(`${e.message}\n` +
            `  ${findings.length} finding(s) may or may not have been stored — the connection\n` +
            '  dropped without an answer, and this endpoint cannot recognise a repeat.\n' +
            '  Nothing was recorded as sent. Check the workspace before re-running.');
    }
    {
        // Status before body. fetch resolves as soon as the headers land, so a 5xx
        // whose body stalls or never closes would hang here — and the one thing
        // this path must always manage is telling somebody that the fate of their
        // contribution is unknown.
        if (r.status >= 500) {
            throw new Error(`HTTP ${r.status} — ${findings.length} finding(s) of unknown fate, for the same\n` +
                '  reason as above: a 5xx can follow a commit as easily as precede one.\n' +
                '  Nothing was recorded as sent.');
        }
        const body = (await r.json().catch(() => ({})));
        if (r.status === 403) {
            throw new Error(`${body.error || 'forbidden'} — this workspace's server has not been widened to accept ` +
                'a collab token here. Mint a contrib token with: /qsetup --scope contrib');
        }
        if (!r.ok && !Array.isArray(body.rejected))
            throw new Error(body.error || `HTTP ${r.status}`);
        return { accepted: body.accepted || 0, rejected: body.rejected || [] };
    }
}
// ---------------------------------------------------------------- cli
const isMain = process.argv[1] && process.argv[1].endsWith('qcontrib.mjs');
if (isMain) {
    const argv = process.argv.slice(2);
    const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? null) : null; };
    const force = argv.includes('--force');
    const yes = argv.includes('--yes');
    try {
        const state = loadState() || emptyState();
        const runs = await collect(opt('--since'));
        if (!runs.length) {
            console.error('no transcripts found');
            process.exit(1);
        }
        const sel = select(runs, state, force);
        if (argv.includes('--review')) {
            for (const line of disclose(sel))
                console.log(line);
            console.log('--- the literal payload ---');
            // The same object --send posts, from the same select() call. /qshare
            // shares one payload builder between --review and --share for exactly
            // this reason: a review of a payload that is merely equivalent to the one
            // sent is a review of nothing.
            await emitJson({ findings: sel.findings });
            console.log(`\n${n(sel.findings.length)} finding(s). Send them with:`);
            console.log('  qcontrib.mjs --send --yes');
            process.exit(0);
        }
        if (!argv.includes('--send')) {
            for (const line of disclose(sel))
                console.log(line);
            console.log('  Nothing has left this machine. Read the literal payload:');
            console.log('    qcontrib.mjs --review');
            process.exit(0);
        }
        const cfg = config();
        if (!yes) {
            console.log(`${n(sel.findings.length)} finding(s) would go to ${cfg.url}.`);
            console.log('');
            console.log('There is no revoke. Nothing above identifies you, this machine, or any');
            console.log('repo — that is why it cannot be recalled, and why it does not need to be.');
            console.log('');
            console.log('Read the literal payload first:  qcontrib.mjs --review');
            console.log('Then re-run with --yes.');
            process.exit(1);
        }
        if (!sel.findings.length) {
            console.log('Nothing new to send — every run on this machine is already in ' + stateTarget() + '.');
            process.exit(0);
        }
        // A shared CONTRIB_TOKEN is accepted by the endpoint and stamps no tenant,
        // so the send answers 200, the rows belong to nobody, and the console's
        // "Send your first findings" step stays unticked forever. That is the exact
        // confusion this command exists to end, so it is refused rather than
        // reported.
        if (!cfg.token.startsWith('svt_')) {
            console.error('this is not a workspace token. A shared token sends findings that belong');
            console.error('to nobody: the server answers 200, and the console\'s "Send your first');
            console.error('findings" step never ticks. Run /qsetup.');
            process.exit(1);
        }
        const who = await introspect(cfg);
        if (who.scope !== 'contrib' && who.scope !== 'collab') {
            console.error(`this token is scoped '${who.scope}', which cannot contribute. Run: /qsetup --scope contrib`);
            process.exit(1);
        }
        if (force) {
            console.log(`--force: re-sending everything. This will create ${n(sel.findings.length)} duplicate row(s)`);
            console.log('— the endpoint has no dedupe and no idempotency key.');
            console.log('');
        }
        const batches = Math.ceil(sel.findings.length / BATCH);
        let accepted = 0;
        let saved = null;
        for (let b = 0; b < batches; b++) {
            const from = b * BATCH;
            const slice = sel.findings.slice(from, from + BATCH);
            const reply = await postBatch(cfg, slice);
            accepted += reply.accepted;
            console.log(`  batch ${b + 1}/${batches}   ${String(n(slice.length)).padStart(5)} sent · ` +
                `${String(n(reply.accepted)).padStart(5)} accepted · ${n(reply.rejected.length)} rejected`);
            for (const rej of reply.rejected) {
                // The server returns an index and an error and never the value that was
                // wrong, so the client's own copy of the item is printed beside it.
                console.log(`    rejected [${from + rej.i}] ${rej.err}  —  ${JSON.stringify(slice[rej.i])}`);
            }
            // Only what the server ACCEPTED is recorded. The route succeeds partially
            // by design, and marking a rejected finding as sent would silently drop
            // it from this machine's contribution forever.
            const at = new Date().toISOString();
            const rejected = new Set(reply.rejected.map((x) => x.i));
            for (let i = 0; i < slice.length; i++) {
                if (rejected.has(i))
                    continue;
                const r = sel.eligible[from + i];
                if (!r)
                    continue;
                state.sent[runKey(r)] = { at, week: r.week };
            }
            // Written after every batch, not once at the end. A crash or a dropped
            // connection on batch 3 of 3 would otherwise discard the record of
            // batches 1 and 2, and the next run would send them again — into an
            // endpoint with no dedupe, which is the one failure this ledger exists
            // to prevent.
            saved = saveState(state);
        }
        console.log('');
        console.log(`${n(accepted)} accepted as tenant ${who.tenant}. Recorded in ${saved?.path || stateTarget()}`);
        console.log('so re-running sends only what is new.');
        console.log('');
        console.log('The console\'s "Send your first findings" step is now green.');
        process.exit(0);
    }
    catch (e) {
        console.error(`error: ${e.message}`);
        process.exit(1);
    }
}
