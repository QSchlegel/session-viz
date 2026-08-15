#!/usr/bin/env node
// The RUN spine: every transcript on the machine, not just the ones with a
// human in them.
//
//   node runs.mjs                 # delivery ledger, text
//   node runs.mjs --cost          # token economy by agent family
//   node runs.mjs --json          # full model
//
// extract.mjs and corpus.mjs deliberately discard two populations to keep the
// prompting statistics honest: scheduled runs with no human turns, and the
// subagent transcripts nested under <session>/subagents/**. Those are the
// majority of runs and almost all of the token spend, so this reads them.
//
// A run is a task, a trajectory, an outcome and a cost. A human session is a
// run that happens to contain human turns — that is a field, not a subsystem.
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { emitJson } from './out.mjs';
import { harnessCoverage, transcriptRoots } from './home.mjs';
import { codexRecords, listCodexSessions } from './codex.mjs';
import { cursorRecords, listCursorSessions } from './cursor.mjs';
import { repoFromSlug, repoName } from './repo.mjs';
// No PROJECTS constant any more. This file used to hardcode ~/.claude/projects
// while extract.mts, corpus.mts and doctor.mts had already moved to
// transcriptRoots() — so /qruns and /qcost reported a Claude-Code-only fleet
// next to a /qtrends that covered two harnesses, and the token totals on the
// two screens could not be reconciled by anyone reading them.
//
// Cost is the sharpest case: Codex spend was not under-reported, it was absent,
// and nothing on the /qcost screen said a harness was missing.
// The one hand-maintained constant in the classifier. A run that ends by
// calling a return tool has SUCCEEDED; without this list, "ended on a tool
// call" looks like failure and condemns most of a healthy fleet.
const RETURN_SET = new Set(['StructuredOutput']);
// Widened to accept a missing name: the membership tests below run against
// tool names that may not have been seen (an unmatched tool_result).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
function* walk(dir) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory())
            yield* walk(full);
        else if (e.name.endsWith('.jsonl'))
            yield full;
    }
}
const isoWeek = (iso) => {
    const d0 = new Date(iso);
    const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const wk = 1 + Math.round(((d.getTime() - jan4.getTime()) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
// Family from the opening instruction. A heuristic, and labelled as one
// wherever it is reported — the boundaries between these are fuzzy.
function familyOf(text) {
    const t = (text || '').toLowerCase();
    if (/refute|verify|adversarial|skeptic|critique/.test(t))
        return 'verifier';
    if (/\bedit\b|patch|apply the fix|scoped/.test(t))
        return 'scoped-editor';
    if (/translat/.test(t))
        return 'translator';
    if (/note|summar|digest|brief/.test(t))
        return 'note-writer';
    return 'other';
}
/**
 * Claude Code writes one JSON object per line; that IS the record.
 *
 * A parse failure skips the line rather than the file. Records are yielded, not
 * collected, so a 588 MB rollout does not have to fit in memory — the same
 * constraint that made codexRecords a generator.
 */
async function* claudeRecords(file) {
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        try {
            yield JSON.parse(line);
        }
        catch { /* a bad line is not a bad file */ }
    }
}
/**
 * Reduce a stream of records to a RunScan.
 *
 * Split out of scanRun so Codex can reach it. Everything below this line was
 * already harness-agnostic given a well-shaped record — codex.mts normalises a
 * rollout into exactly these shapes on the way in, including `message.usage`,
 * which is what makes the cost ledger work across both without a second
 * accounting path to keep in step with this one.
 */
async function scanRecords(source) {
    const r = {
        started: null, agentEnded: null, lastRecord: null,
        out: 0, cin: 0, cread: 0, ccreate: 0,
        tools: 0, toolErr: 0, humanTurns: 0, cwd: null,
        lastStop: null, lastTool: null, lastToolId: null, resolved: new Set(),
        firstText: '', schedName: null, models: new Map(),
        structured: 0, structuredFail: 0,
        intentWrite: 0, wroteOk: 0, writeDenied: 0,
        permission: false, auth: false, loops: 0,
        toolCounts: new Map(),
    };
    const names = new Map();
    let lastKey = null;
    for await (const o of source) {
        const ts = o.timestamp;
        // First cwd wins. Codex records it on session_meta and nowhere else, so a
        // last-write-wins read would lose it the moment any later record omits it.
        if (!r.cwd && o.cwd)
            r.cwd = o.cwd;
        if (ts) {
            if (!r.started)
                r.started = ts;
            r.lastRecord = ts;
        }
        if (o.type === 'assistant') {
            // The last ASSISTANT timestamp, not the last record: a human reopening a
            // session hours later must not be counted as agent runtime. One session
            // in the reference corpus reads as 14,041 minutes and ran for two.
            if (ts)
                r.agentEnded = ts;
            const m = o.message?.model;
            if (m && m !== '<synthetic>')
                r.models.set(m, (r.models.get(m) || 0) + 1);
            const u = o.message?.usage || {};
            r.out += u.output_tokens || 0;
            r.cin += u.input_tokens || 0;
            r.cread += u.cache_read_input_tokens || 0;
            r.ccreate += u.cache_creation_input_tokens || 0;
            // An explicit `stop_reason: null` is the absence of a terminal reason,
            // not one. Last-write-wins let a trailing null erase the 'end_turn'
            // behind it and terminalState then read the run as a zombie.
            if (o.message?.stop_reason != null)
                r.lastStop = o.message.stop_reason;
            // A malformed record could hold a string here; iterating it yields
            // characters, which fall out of the loop on the type check below.
            for (const b of (o.message?.content || [])) {
                if (b.type !== 'tool_use')
                    continue;
                r.tools++;
                r.lastTool = b.name;
                r.lastToolId = b.id;
                names.set(b.id, b.name);
                r.toolCounts.set(b.name, (r.toolCounts.get(b.name) || 0) + 1);
                if (b.name === 'StructuredOutput')
                    r.structured++;
                if (WRITE_TOOLS.has(b.name))
                    r.intentWrite++;
                // Loop detection: the same tool with the same input, back to back.
                // Keyed per tool name this measured "the previous use OF THIS TOOL",
                // so Read(A), Bash(X), Read(A) — a re-read after other work, not a
                // loop — scored one. Back to back is the whole tool sequence.
                const key = b.name + '|' + JSON.stringify(b.input || {}).slice(0, 300);
                if (lastKey === key)
                    r.loops++;
                lastKey = key;
            }
        }
        else if (o.type === 'user') {
            const c = o.message?.content;
            // A user record carrying anything other than a tool_result is a person
            // typing. Counted because it is the only evidence that separates a run
            // somebody drove from one a machine issued — and on Codex it is the ONLY
            // evidence, there being no /subagents/ directory to read it off the path.
            // codex.mts has already dropped the human turns from `codex exec` and
            // control-surface rollouts, so a machine-issued run reaches here at zero.
            if (Array.isArray(c)) {
                if (c.some((b) => b.type !== 'tool_result'))
                    r.humanTurns++;
            }
            else if (typeof c === 'string' && c.trim())
                r.humanTurns++;
            if (Array.isArray(c)) {
                for (const b of c) {
                    if (b.type === 'tool_result') {
                        r.resolved.add(b.tool_use_id);
                        const n = names.get(b.tool_use_id);
                        const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
                        if (b.is_error) {
                            r.toolErr++;
                            if (n === 'StructuredOutput')
                                r.structuredFail++;
                            if (WRITE_TOOLS.has(n))
                                r.writeDenied++;
                            if (/permission|denied|allowlist|not allowed|approv/i.test(txt))
                                r.permission = true;
                            if (/\b401\b|unauthoriz|authentication failed/i.test(txt))
                                r.auth = true;
                        }
                        else if (WRITE_TOOLS.has(n))
                            r.wroteOk++;
                    }
                    else if (b.type === 'text' && !r.firstText) {
                        r.firstText = String(b.text || '').slice(0, 400);
                    }
                }
            }
            else if (typeof c === 'string' && !r.firstText) {
                r.firstText = c.slice(0, 400);
            }
            if (!r.schedName && r.firstText) {
                const m = r.firstText.match(/<scheduled-task name="([^"]+)"/);
                if (m)
                    r.schedName = m[1];
            }
        }
    }
    return r;
}
/** Scan one transcript, reading it the way its harness wrote it. */
const scanRun = (file, harness) => scanRecords(harness === 'cursor'
    ? cursorRecords(file)
    : harness === 'codex'
        ? codexRecords(file)
        : claudeRecords(file));
// Ordered, because the naive version of each of these is wrong in a way that
// changes the headline. See README.
function terminalState(r) {
    if (r.lastStop === 'end_turn')
        return 'completed_prose';
    if (r.lastStop === 'tool_use' && r.lastToolId) {
        const resolved = r.resolved.has(r.lastToolId);
        if (RETURN_SET.has(r.lastTool) && resolved)
            return 'completed_structured';
        if (!resolved)
            return 'abandoned_mid_tool';
        return 'truncated';
    }
    if (r.lastStop === 'stop_sequence')
        return 'infra_halt';
    if (!r.lastStop && r.tools === 0)
        return 'zombie';
    return 'unknown';
}
// Tri-state on purpose. Without a filesystem probe the server cannot witness
// delivery, so `wrote_ok` is a tool-result observation and is never called
// DELIVERED. UNVERIFIED is the default and is never alarmed on: a write into a
// container is exactly the case a probe would get wrong.
//
// `denied` means nothing landed, so it is tested AFTER wroteOk. Testing it
// first labelled a run with ten good Writes and one blocked Edit `denied`,
// which dropped it out of the cost-per-delivered denominator while its output
// tokens stayed in the numerator — cpdo inflated by the runs that shipped.
function deliveryState(r) {
    if (r.wroteOk > 0)
        return 'wrote_ok';
    if (r.writeDenied > 0)
        return 'denied';
    if (r.intentWrite > 0)
        return 'unverified';
    return 'no_intent';
}
/** Every transcript a harness left under one of its roots, with its kind. */
function* rootFiles(harness, dir) {
    if (harness === 'codex') {
        // A flat date tree: no project directory to name the repo, and no
        // /subagents/ nesting. Both are recovered from the records instead — cwd
        // for the repo, an absence of human turns for the kind.
        for (const s of listCodexSessions(dir))
            yield { file: s.file, isSub: false, slug: '' };
        return;
    }
    if (harness === 'cursor') {
        // Not a tree at all — one SQLite database, addressed `<db>#<composerId>`.
        // Cursor's own subagent composers are listed alongside their parents, and
        // are not distinguished here: `subagentComposerIds` names them, but a
        // subagent composer is a first-class conversation in that database and
        // counting it as a nested run would double its tokens against its parent.
        for (const s of listCursorSessions(dir))
            yield { file: s.file, isSub: false, slug: '' };
        return;
    }
    let projects = [];
    try {
        projects = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const proj of projects) {
        const projDir = join(dir, proj);
        try {
            if (!statSync(projDir).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        for (const file of walk(projDir)) {
            const isSub = /\/subagents\//.test(file);
            // Only depth-0 files are sessions; anything else nested is not.
            if (!isSub && file.slice(projDir.length + 1).split('/').length - 1 !== 0)
                continue;
            yield { file, isSub, slug: proj };
        }
    }
}
export async function collectRuns({ since = null } = {}) {
    const runs = [];
    const roots = transcriptRoots();
    for (const { harness, dir } of roots) {
        for (const { file, isSub, slug: projSlug } of rootFiles(harness, dir)) {
            let s;
            try {
                s = await scanRun(file, harness);
            }
            catch {
                continue;
            }
            if (!s.started)
                continue;
            if (since && Date.parse(s.started) < since)
                continue;
            // Codex has no /subagents/ directory, so its machine-issued runs are
            // identified by having no human turn at all. Calling those 'scheduled'
            // rather than inventing a fourth kind: from a delivery ledger's point of
            // view they are the same thing — work nobody was sitting in front of.
            const kind = isSub ? 'subagent'
                : s.schedName ? 'scheduled'
                    : harness === 'codex' && s.humanTurns === 0 ? 'scheduled'
                        : 'human';
            const agentMs = s.agentEnded ? Date.parse(s.agentEnded) - Date.parse(s.started) : 0;
            runs.push({
                file, kind, harness,
                // cwd first for both harnesses; the slug is a Claude-Code-only fallback
                // for a transcript that never recorded one. Codex has no slug to fall
                // back to, so an unreadable rollout is named '' rather than mislabelled.
                repo: repoName(s.cwd) || (projSlug ? repoFromSlug(projSlug) : ''),
                task: s.schedName ? slug(s.schedName) : null,
                family: isSub ? familyOf(s.firstText) : null,
                week: isoWeek(s.started), started: s.started,
                terminal: terminalState(s), delivery: deliveryState(s),
                errorClass: s.permission ? 'permission' : s.auth ? 'auth' : s.toolErr ? 'tool_error' : 'none',
                out: s.out, cread: s.cread, ccreate: s.ccreate, cin: s.cin,
                tools: s.tools, toolErr: s.toolErr, loops: s.loops,
                structured: s.structured, structuredFail: s.structuredFail,
                intentWrite: s.intentWrite, wroteOk: s.wroteOk, writeDenied: s.writeDenied,
                agentMin: Math.round(agentMs / 60000),
                model: [...s.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
                topTools: [...s.toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => ({ n, c })),
            });
        }
    }
    runs.sort((a, b) => a.started.localeCompare(b.started));
    // `roots`, plural, replaces the single `root`. A caller that prints where the
    // data came from has to be able to say "both of these" — printing one root
    // while reporting over two is how the Claude-Code-only assumption stayed
    // invisible for as long as it did.
    return { runs, roots: roots.map((r) => `${r.harness}:${r.dir}`) };
}
// ---------------------------------------------------------------- aggregate
const sum = (a, f) => a.reduce((n, x) => n + f(x), 0);
const by = (a, k) => {
    const m = new Map();
    for (const x of a) {
        const v = x[k];
        if (v === null || v === undefined)
            continue;
        if (!m.has(v))
            m.set(v, []);
        m.get(v).push(x);
    }
    return m;
};
export function ledger(runs) {
    const auto = runs.filter((r) => r.kind !== 'human');
    const tasks = [...by(runs.filter((r) => r.task), 'task').entries()].map(([task, a]) => {
        const delivered = a.filter((r) => r.delivery === 'wrote_ok').length;
        const denied = a.filter((r) => r.delivery === 'denied').length;
        return {
            task, runs: a.length, delivered, denied,
            unverified: a.filter((r) => r.delivery === 'unverified').length,
            noIntent: a.filter((r) => r.delivery === 'no_intent').length,
            out: sum(a, (r) => r.out), cread: sum(a, (r) => r.cread),
            lastRun: a[a.length - 1].started.slice(0, 10),
            series: a.map((r) => r.out),
            // The honest form of a zero denominator is a refusal plus both numbers.
            cpdo: delivered ? sum(a, (r) => r.out) / delivered : null,
            permission: a.filter((r) => r.errorClass === 'permission').length,
            // Same announced next step every run, and nothing shipped.
            stalled: delivered === 0 && a.length >= 3,
        };
    }).sort((x, y) => y.runs - x.runs);
    const families = [...by(runs.filter((r) => r.family), 'family').entries()].map(([family, a]) => ({
        family, runs: a.length,
        creadPerRun: Math.round(sum(a, (r) => r.cread) / a.length),
        outPerRun: Math.round(sum(a, (r) => r.out) / a.length),
        structured: sum(a, (r) => r.structured), structuredFail: sum(a, (r) => r.structuredFail),
        readers: a.filter((r) => r.intentWrite === 0 && r.tools > 5).length,
        zombie: a.filter((r) => r.terminal === 'zombie').length,
    })).sort((x, y) => y.runs - x.runs);
    const terminal = [...by(runs, 'terminal').entries()].map(([k, a]) => [k, a.length]).sort((x, y) => y[1] - x[1]);
    const kinds = [...by(runs, 'kind').entries()].map(([k, a]) => [k, a.length]);
    // Per-harness, and reported even when there is only one. A single line saying
    // `claude-code 1236` is how somebody notices that the Codex they have been
    // running all week is not in these numbers — which is the failure this whole
    // change exists to make impossible to have silently.
    const harnesses = [...by(runs, 'harness').entries()].map(([harness, a]) => ({
        harness, runs: a.length,
        human: a.filter((r) => r.kind === 'human').length,
        auto: a.filter((r) => r.kind !== 'human').length,
        out: sum(a, (r) => r.out), cread: sum(a, (r) => r.cread),
    })).sort((x, y) => y.cread - x.cread);
    return {
        generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
        totals: {
            runs: runs.length,
            ...Object.fromEntries(kinds),
            out: sum(runs, (r) => r.out), cread: sum(runs, (r) => r.cread),
            ccreate: sum(runs, (r) => r.ccreate), cin: sum(runs, (r) => r.cin),
            toolErr: sum(runs, (r) => r.toolErr), loops: sum(runs, (r) => r.loops),
        },
        terminal, tasks, families, harnesses,
        // Every harness we know how to read, including the ones that returned
        // nothing. `harnesses` above is what was measured; this is what was looked
        // for — and the difference between them is the only place a missing
        // surface can show up.
        coverage: harnessCoverage(),
        autonomous: {
            runs: auto.length,
            delivered: auto.filter((r) => r.delivery === 'wrote_ok').length,
            denied: auto.filter((r) => r.delivery === 'denied').length,
            permission: auto.filter((r) => r.errorClass === 'permission').length,
            zombie: auto.filter((r) => r.terminal === 'zombie').length,
        },
        caveats: [
            'wrote_ok is a tool-result observation, not witnessed delivery — no filesystem probe runs.',
            'Subagent families come from a first-message heuristic, so the boundaries are approximate.',
            `RETURN_SET is hand-maintained (${[...RETURN_SET].join(', ')}). A run ending on one of these succeeded; treating "ended mid-tool-call" as failure would misclassify most of a healthy fleet.`,
            'agentMin measures the last assistant record, not the last record — a reopened session is not agent runtime.',
        ],
    };
}
// ---------------------------------------------------------------- cli
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const pct = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '—');
function renderLedger(L) {
    const t = L.totals, a = L.autonomous;
    const out = [];
    out.push(`runs        ${t.runs}   human ${t.human || 0} · scheduled ${t.scheduled || 0} · subagent ${t.subagent || 0}`);
    out.push(`tokens      ${fmt(t.out)} out · ${fmt(t.cread)} cache-read · ${fmt(t.ccreate)} cache-create`);
    out.push(`harnesses   ${L.harnesses.map((h) => `${h.harness} ${h.runs} (${fmt(h.cread)} cr)`).join(' · ')}`);
    out.push(`autonomous  ${a.runs} runs · ${a.delivered} wrote a file · ${a.denied} denied · ${a.zombie} zombie`);
    out.push('');
    out.push('terminal state');
    for (const [k, n] of L.terminal)
        out.push(`  ${String(n).padStart(5)}  ${k}`);
    if (L.tasks.length) {
        out.push('');
        out.push('recurring tasks');
        out.push('  runs  wrote  denied  output   cost/delivered   task');
        for (const x of L.tasks) {
            const cp = x.cpdo === null ? `undefined (${x.runs} runs, ${fmt(x.out)} out, 0 delivered)` : fmt(Math.round(x.cpdo));
            out.push(`  ${String(x.runs).padStart(4)}  ${String(x.delivered).padStart(5)}  ${String(x.denied).padStart(6)}  ${fmt(x.out).padStart(6)}   ${cp.padEnd(16)} ${x.task}${x.stalled ? '   << STALLED' : ''}`);
        }
    }
    if (L.families.length) {
        out.push('');
        out.push('subagent families');
        out.push('  runs  cache-read/run  out/run  schema fail  readers  family');
        for (const f of L.families) {
            const sf = f.structured ? `${f.structuredFail}/${f.structured} (${pct(f.structuredFail, f.structured)})` : '—';
            out.push(`  ${String(f.runs).padStart(4)}  ${fmt(f.creadPerRun).padStart(14)}  ${fmt(f.outPerRun).padStart(7)}  ${sf.padEnd(11)}  ${String(f.readers).padStart(7)}  ${f.family}`);
        }
    }
    out.push('');
    // Printed only when something known is missing or partial, and silent when
    // everything is covered. An all-clear line on every run trains people to stop
    // reading it, and this is the line that has to be read the one time it says
    // an entire harness is absent from the numbers above.
    const cov = coverageBlock(L);
    if (cov)
        out.push(cov.replace(/^\n/, ''));
    out.push('caveats');
    for (const c of L.caveats)
        out.push(`  - ${c}`);
    return out.join('\n');
}
function renderCost(L) {
    const t = L.totals;
    const total = t.out + t.cread + t.ccreate;
    const out = [];
    out.push('token composition');
    for (const [label, v] of [['cache-read', t.cread], ['cache-create', t.ccreate], ['output', t.out]]) {
        const w = Math.round((v / total) * 46);
        out.push(`  ${label.padEnd(13)} ${fmt(v).padStart(7)}  ${pct(v, total).padStart(5)}  ${'█'.repeat(Math.max(1, w))}`);
    }
    out.push('');
    out.push('  Output is what the model generated. Cache-read is context replayed to it on');
    out.push('  every turn — it appears in no per-session view and it is almost the whole bill.');
    if (L.families.length) {
        const worst = [...L.families].sort((x, y) => y.creadPerRun - x.creadPerRun);
        const best = worst[worst.length - 1];
        out.push('');
        out.push('cache-read per run, by agent family');
        for (const f of worst) {
            const ratio = best.creadPerRun ? (f.creadPerRun / best.creadPerRun).toFixed(1) : '—';
            out.push(`  ${f.family.padEnd(15)} ${fmt(f.creadPerRun).padStart(7)}/run  ${String(f.runs).padStart(4)} runs   ${ratio}× the leanest`);
        }
        out.push('');
        out.push(`  The spread between families is the actionable part: same harness, same model,`);
        out.push(`  different prompt. Narrowing the widest one is worth more than any prompt tweak.`);
    }
    // The coverage block belongs HERE most of all, and was missing: /qcost is the
    // one screen that is entirely about token totals, and it was printing a
    // composition percentage over 2320 runs without mentioning that 641 of them
    // carry no token data at all. The percentages are not wrong, but a reader
    // takes them for a bill, and a whole harness contributing a measured zero is
    // the single thing most likely to mislead them.
    out.push(coverageBlock(L));
    out.push('  No currency is shown. The rate card is not part of this snapshot, and a dollar');
    out.push('  figure derived from an assumed price is an assumption rendered as a fact.');
    return out.join('\n');
}
/**
 * What is missing or partial, as lines. Empty when everything is covered.
 *
 * Shared by both renderers rather than written into one of them, because that
 * is exactly how /qcost came to be the screen without it.
 */
function coverageBlock(L) {
    const gaps = L.coverage.filter((c) => !c.found || c.tokens !== 'full');
    if (!gaps.length)
        return '';
    const out = ['', 'not in these numbers'];
    for (const c of gaps) {
        out.push(c.found
            ? `  ${c.harness}: counted, but token data is ${c.tokens} — its spend is a floor, not a total`
            : `  ${c.harness}: ${c.reason}`);
    }
    out.push('');
    return out.join('\n');
}
const isMain = process.argv[1] && process.argv[1].endsWith('runs.mjs');
if (isMain) {
    const argv = process.argv.slice(2);
    const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
    const sinceArg = opt('--since');
    let since = null;
    if (sinceArg) {
        const m = sinceArg.match(/^(\d+)([dwm])$/);
        since = m ? Date.now() - Number(m[1]) * { d: 864e5, w: 7 * 864e5, m: 30 * 864e5 }[m[2]] : Date.parse(sinceArg);
    }
    const { runs } = await collectRuns({ since });
    if (!runs.length) {
        console.error('no transcripts found');
        process.exit(1);
    }
    const L = ledger(runs);
    if (argv.includes('--json'))
        await emitJson({ ...L, runs });
    else if (argv.includes('--cost'))
        console.log(renderCost(L));
    else
        console.log(renderLedger(L));
}
