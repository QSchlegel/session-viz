#!/usr/bin/env node
// A backlog that goes both ways, and an ordering that shows its working.
//
//   node qbl.mjs "the picker stub has drifted from the real stream"  # push
//   node qbl.mjs                                                     # pull
//   node qbl.mjs --shared                                            # the team's
//   node qbl.mjs --done b3f9                                         # close one
//
// ── The claim this command has to keep ──────────────────────────────────────
// "Here are the next logical tasks" is a claim about ordering, and an ordering
// nobody can inspect is indistinguishable from a shuffle. Every list this
// prints therefore carries the criteria it actually sorted by — and, just as
// important, the criteria it applied that separated nothing. A backlog of three
// unrelated notes on one branch has no logic to find in it; saying "next, by
// dependency and relevance" over that list would be inventing a finding out of
// a sort that did nothing but order by age.
//
// So there are three sentences this file exists to be able to say honestly:
//
//   · "ordered by age alone — this is a queue, not a plan"  when nothing else
//     in the data separated one item from another;
//   · "the backlog is empty"                                rather than
//     proposing plausible work nobody asked for;
//   · "the shared backlog is unreachable, this list is local only"  rather than
//     printing a short list that reads as a complete one.
//
// ── Two scopes ──────────────────────────────────────────────────────────────
// Local lives on this machine, one file per project, and never leaves it.
// Shared is the `collab_task` queue behind /v1/tasks — the same queue /qfeed
// files into and /qteam hands around — so an item pushed here is an item a
// colleague can be offered.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { configDirs, configTarget } from './home.mjs';
import { repoRoot, repoName, worktreeOf } from './repo.mjs';
import { emitJson, writeOut } from './out.mjs';
import { config } from './cloud.mjs';
// ---------------------------------------------------------------- storage
/**
 * One file per project, not one file with a project key inside it.
 *
 * Two sessions in two repos push at the same moment. With a single document
 * both read it, both add their line, and the second write silently drops the
 * first — a backlog that loses entries is worse than no backlog, because the
 * user believes the thing was recorded. Separate files make that collision
 * impossible between projects, which is where it is most likely: one person
 * working in two checkouts at once is the normal case this tool is built for.
 */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
/**
 * The checkout a directory sits in: the nearest ancestor holding a `.git`,
 * whether that is a directory or a linked worktree's pointer file.
 *
 * `repoRoot` in repo.mts is a path-string transform. It folds the four
 * harnesses' worktree layouts back onto the repository they belong to and
 * returns anything else untouched — it discovers nothing, so on a plain checkout
 * it hands back exactly the directory it was given. Keying the backlog on that
 * gave every subdirectory of a repository a backlog file of its own: a note
 * pushed from `services/api` was unreachable from the repository root, which
 * then said the backlog was empty and named no reason to doubt it.
 *
 * The walk is the one `currentBranch` below already does, so the root and the
 * branch can never disagree about which checkout this is, and it spawns nothing
 * for the same reason that one does not.
 */
export function gitRoot(cwd) {
    let dir = cwd;
    for (let i = 0; i < 40; i++) {
        if (existsSync(join(dir, '.git')))
            return dir;
        const up = dirname(dir);
        if (up === dir)
            return null;
        dir = up;
    }
    return null;
}
/**
 * The project key. Name for a human reading the directory, digest for identity.
 *
 * The digest is not decoration: two checkouts of different repositories can
 * share a basename (`api`, `web`, `docs` are all over any machine), and one
 * backlog file serving both would mix two projects' work under one heading —
 * which is exactly the isolation this command promises.
 *
 * `checkout` is where the push physically happened and `root` is what the
 * backlog is keyed on; they differ only inside a worktree. Recording a path
 * against the checkout is what makes `services/api` read as `services/api` in
 * both layouts instead of `.claude/worktrees/<name>/services/api` in one of them.
 */
export function projectKey(cwd) {
    const checkout = gitRoot(cwd) || cwd;
    // repoRoot second, not first: folding a worktree onto its repository needs a
    // checkout to fold, and this line is the whole of "worktrees of one repo share
    // one backlog".
    const root = repoRoot(checkout) || checkout;
    const name = repoName(root) || 'project';
    return { root, checkout, name, key: `${slug(name)}-${createHash('sha256').update(root).digest('hex').slice(0, 10)}` };
}
const backlogPaths = (key) => configDirs().map((d) => join(d, 'backlog', `${key}.json`));
const backlogTarget = (key) => join(dirname(configTarget()), 'backlog', `${key}.json`);
/**
 * Read the file a write would land in, when it exists, and only then fall back
 * to another candidate.
 *
 * home.mts documents the same rule for the contribution ledger and the reason
 * is the same here: `saveBacklog` stops at the first directory it can write, so
 * a reader that took the first path that merely EXISTS would go on opening a
 * stale copy in a directory that has since gone read-only, and every item
 * pushed after that would be invisible to every pull.
 */
export function loadBacklog(key, project) {
    const here = backlogTarget(key);
    const p = existsSync(here) ? here : backlogPaths(key).find((q) => existsSync(q));
    const empty = { version: 1, project, items: [] };
    if (!p)
        return empty;
    try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        if (!parsed || !Array.isArray(parsed.items))
            return empty;
        return { version: 1, project: parsed.project || project, items: parsed.items };
    }
    catch {
        // A corrupt backlog must not make the command unrunnable — but unlike the
        // contribution ledger, reading it as empty here would let the next push
        // overwrite entries that are still on disk. Refuse instead, and name the
        // file, so the user can look at it.
        throw new Error(`the backlog at ${p} is not readable JSON — move it aside and the next push starts a new one`);
    }
}
export function saveBacklog(key, b) {
    const first = backlogTarget(key);
    const refused = [];
    for (const path of [first, ...backlogPaths(key).filter((p) => p !== first)]) {
        try {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            // writeFileSync honours `mode` only when it CREATES the file, so a
            // backlog written before this line existed would keep whatever
            // permissions it had. The explicit chmod is what makes 0600 true on the
            // second write as well as the first.
            writeFileSync(path, JSON.stringify(b, null, 2) + '\n', { mode: 0o600 });
            chmodSync(path, 0o600);
            chmodSync(dirname(path), 0o700);
            return path;
        }
        catch (e) {
            const code = e.code;
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EROFS')
                throw e;
            refused.push(path);
        }
    }
    throw new Error(`cannot write the backlog — permission denied at ${refused.join(', ')}. ` +
        'Set SESSION_VIZ_HOME to a directory this harness can write.');
}
/**
 * Backlog files holding notes that belong to this project but were filed under
 * a key it no longer uses.
 *
 * Before `projectKey` found the repository root, a push from a subdirectory was
 * digested against that subdirectory: `api-eec66716aa.json` for a note pushed
 * from `myrepo/services/api`, unreachable from `myrepo` and from every other
 * subdirectory of it. Fixing the key without this would leave those notes on
 * disk under a name nothing computes any more — which is the same loss as
 * deleting them, minus the honesty of saying so.
 *
 * Ownership is decided by re-resolving the root each item RECORDED, not by the
 * filename and not by a prefix test: a nested checkout vendored into this tree
 * records a root that resolves to itself, so its notes stay its own.
 */
export function strayBacklogs(key, root) {
    const out = [];
    const seen = new Set();
    const resolves = new Map();
    const resolve = (r) => {
        const hit = resolves.get(r);
        if (hit !== undefined)
            return hit;
        const v = repoRoot(gitRoot(r) || r) || r;
        resolves.set(r, v);
        return v;
    };
    for (const dir of configDirs().map((d) => join(d, 'backlog'))) {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const n of names) {
            if (!n.endsWith('.json') || n === `${key}.json`)
                continue;
            const path = join(dir, n);
            if (seen.has(path))
                continue;
            seen.add(path);
            let doc;
            // A file that is not ours and does not parse is not this command's
            // problem to report: refusing here would make an unrelated corrupt
            // backlog break every pull in every other project.
            try {
                doc = JSON.parse(readFileSync(path, 'utf8'));
            }
            catch {
                continue;
            }
            if (!doc || !Array.isArray(doc.items))
                continue;
            const mine = doc.items.filter((i) => {
                const r = i && i.where && i.where.root;
                return typeof r === 'string' && !!r && resolve(r) === root;
            });
            if (mine.length)
                out.push({ path, items: mine });
        }
    }
    return out;
}
// ---------------------------------------------------------------- context
/**
 * The branch, read rather than shelled out for.
 *
 * `git rev-parse` would be simpler and would also be a process spawn on a
 * command that is meant to answer instantly; more to the point it fails
 * differently inside a sandbox that has no git on PATH, and the branch is a
 * ranking input, not a hard requirement. Unreadable resolves to null and the
 * ordering says the branch criterion separated nothing.
 */
export function currentBranch(cwd) {
    let dir = cwd;
    for (let i = 0; i < 40; i++) {
        const dot = join(dir, '.git');
        try {
            const st = statSync(dot);
            let gitDir = dot;
            if (!st.isDirectory()) {
                // A linked worktree's `.git` is a file holding `gitdir: <path>`.
                const ptr = readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m);
                if (!ptr)
                    return null;
                gitDir = ptr[1].trim();
                if (!isAbsolute(gitDir))
                    gitDir = join(dir, gitDir);
            }
            const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
            const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
            return ref ? ref[1] : null; // detached HEAD names no branch
        }
        catch { /* keep walking up */ }
        const up = dirname(dir);
        if (up === dir)
            return null;
        dir = up;
    }
    return null;
}
export function context(cwd = process.cwd()) {
    const { root, checkout, name, key } = projectKey(cwd);
    return { cwd, root, checkout, name, key, branch: currentBranch(cwd), worktree: worktreeOf(cwd) };
}
// ---------------------------------------------------------------- direction
/**
 * The phrases that read as a request for work rather than a note to file.
 *
 * Matched WHOLE, after normalisation, and never as a substring. "next: rewrite
 * the picker stub" contains "next" and is plainly a push; a contains-check
 * would swallow it and the user would lose the note with no error. The whole
 * classification is therefore one lookup in this list, which is printable
 * (`--phrases`) and overridable (`--push` / `--pull`), so the reading is never
 * something the user has to guess at.
 */
export const PULL_PHRASES = [
    'next', 'what next', 'whats next', 'what is next', 'what now', 'now what',
    'next task', 'next tasks', 'the next task', 'the next tasks',
    'what should i do', 'what should i do next',
    'what should i work on', 'what should i work on next',
    'what should i pick up', 'what should i pick up next',
    'what do i do next', 'what do i work on next',
    'whats left', 'what is left', 'whats remaining', 'what is remaining',
    'anything to do', 'anything else to do', 'anything left',
    'pull', 'backlog', 'todo', 'list', 'show me the backlog',
];
/** Lowercase, drop the punctuation that only ever decorates these, collapse space. */
export const normalise = (s) => s.toLowerCase().replace(/['’`]/g, '').replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ').trim();
export function readsAsPull(arg) {
    return PULL_PHRASES.includes(normalise(arg));
}
const ago = (fromIso, now) => {
    const ms = now - Date.parse(fromIso);
    if (!Number.isFinite(ms) || ms < 0)
        return 'at an unknown time';
    const d = Math.floor(ms / 86400000);
    if (d >= 1)
        return `${d}d ago`;
    const h = Math.floor(ms / 3600000);
    if (h >= 1)
        return `${h}h ago`;
    const m = Math.floor(ms / 60000);
    return m >= 1 ? `${m}m ago` : 'just now';
};
/**
 * The ordering, and the evidence for it.
 *
 * Four criteria, applied in this order and reported whether or not they bit:
 *
 *   1. an item waiting on an open blocker is HELD, not ranked. That is a fact
 *      about recorded dependencies, not a judgement;
 *   2. how many open items each one unblocks. Also counted, not guessed;
 *   3. whether it was filed on the branch checked out right now;
 *   4. age, oldest first.
 *
 * Criteria 2 and 3 usually separate nothing, and that is the case this function
 * is built to be honest about: `ageAlone` is true when the ready items differ
 * on neither, and the caller prints "a queue, not a plan" rather than dressing
 * a date sort up as reasoning.
 */
export function order(items, ctx, now) {
    const open = items.filter((i) => i.state === 'open');
    const byId = new Map(items.map((i) => [i.id, i]));
    const openIds = new Set(open.map((i) => i.id));
    const danglingBlockers = [];
    for (const i of open) {
        for (const b of i.blockedBy) {
            if (!byId.has(b))
                danglingBlockers.push({ id: i.id, names: b });
        }
    }
    const held = [];
    const ready = [];
    for (const i of open) {
        // Only a blocker that is still OPEN blocks. A blocker id that matches
        // nothing in this backlog is reported above and treated as not blocking:
        // holding an item back on the strength of an id nobody can find would
        // silently bury it forever.
        const waiting = i.blockedBy.filter((b) => openIds.has(b));
        if (waiting.length) {
            held.push({ item: i, reason: `waiting on ${waiting.join(', ')}` });
            continue;
        }
        // Shared only: somebody else already holds it. Proposing it as "next"
        // would be proposing work that is not yours to take.
        if (i.heldBy) {
            held.push({ item: i, reason: `${i.sharedState || 'held'} by ${i.heldBy}` });
            continue;
        }
        ready.push(i);
    }
    const unblocksOf = (i) => open.filter((o) => o.blockedBy.includes(i.id)).map((o) => o.id);
    const onBranchOf = (i) => !!ctx.branch && i.where.branch === ctx.branch;
    const ranked = ready.map((item) => ({
        item, unblocks: unblocksOf(item), onBranch: onBranchOf(item), reasons: [],
    }));
    // Sort is stable in V8, so equal keys keep the order they were pushed in —
    // which is what makes "oldest first" true even when two items carry the same
    // ISO second.
    ranked.sort((a, b) => b.unblocks.length - a.unblocks.length ||
        Number(b.onBranch) - Number(a.onBranch) ||
        Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt));
    const distinct = (vs) => new Set(vs).size > 1;
    const unblockSeparated = distinct(ranked.map((r) => r.unblocks.length));
    const branchSeparated = distinct(ranked.map((r) => r.onBranch));
    for (const r of ranked) {
        if (r.unblocks.length)
            r.reasons.push(`unblocks ${r.unblocks.length} open item(s): ${r.unblocks.join(', ')}`);
        if (r.onBranch && branchSeparated)
            r.reasons.push(`filed on ${ctx.branch}, the branch checked out here`);
        r.reasons.push(`filed ${ago(r.item.createdAt, now)}`);
    }
    const basis = [
        {
            criterion: 'blockers must be closed first',
            separated: held.length > 0,
            detail: held.length
                ? `${held.length} item(s) held back below`
                : 'nothing here is waiting on anything else',
        },
        {
            criterion: 'then by how many open items each one unblocks',
            separated: unblockSeparated,
            detail: unblockSeparated
                ? `top item unblocks ${ranked[0]?.unblocks.length ?? 0}`
                : 'every ready item unblocks the same number of others, so this changed nothing',
        },
        {
            criterion: 'then by whether it was filed on the branch checked out here',
            separated: branchSeparated,
            detail: !ctx.branch
                ? 'no branch could be read here, so this was not applied'
                : branchSeparated
                    ? `${ranked.filter((r) => r.onBranch).length} of ${ranked.length} name ${ctx.branch}`
                    : `every ready item is the same on this test, so this changed nothing`,
        },
        { criterion: 'then oldest first', separated: ranked.length > 1, detail: 'by the time it was pushed' },
    ];
    // Criterion 1 counts here too, and leaving it out is what let the page deny a
    // dependency it had printed two lines earlier: with A and B each blocking
    // something, both are ready, both unblock exactly one, so criteria 2 and 3
    // separate nothing and the old test called that "age alone" under a held-back
    // section listing the very dependencies it was denying.
    //
    // The question the sentence asks is whether anything RECORDED a dependency,
    // which is why this reads `blockedBy` rather than counting `held`: a shared
    // item a colleague has accepted is held and is not a dependency, and a blocker
    // id naming nothing in this backlog is a dependency even though it holds
    // nothing back — it is printed by name a few lines above the sentence.
    // A CLOSED blocker is not a live dependency. blockedBy is never cleared on
    // close, so testing it raw meant that once anything in a project had ever been
    // blocked, the disclaimer was suppressed for good -- and `ageAlone: false` is
    // a positive claim that something other than age ordered the list, made on a
    // page where all three separators print "separated nothing". The stated intent
    // was never to deny a dependency the page PRINTS; a closed blocker appears in
    // no held section, no unblocks reason and no dangling list, so it prints
    // nowhere and denies nothing.
    const closedIds = new Set(items.filter((i) => i.state === 'done').map((i) => i.id));
    const recordsDependency = open.some((i) => 
    // Still open, or naming nothing at all -- a dangling id IS printed by name.
    i.blockedBy.some((b) => openIds.has(b) || !closedIds.has(b)));
    return {
        next: ranked, held, basis, danglingBlockers,
        ageAlone: !recordsDependency && !unblockSeparated && !branchSeparated,
    };
}
/**
 * Task rows as backlog items.
 *
 * `refs` is how a dependency survives the round trip — the server has no column
 * for one — so a `blocked-by:<id>` ref written by a push comes back as a real
 * blocker rather than as decoration nobody reads.
 */
export function fromTask(t, me) {
    const refs = Array.isArray(t.refs) ? t.refs : [];
    const why = t.brief ? t.brief.split(/\n\s*why:\s*/i)[1]?.trim() || null : null;
    return {
        id: t.id,
        text: t.title,
        why,
        where: { repo: t.repo || t.scope || 'unknown', root: '', branch: t.branch || null, worktree: null, path: null },
        tags: refs.filter((r) => !r.startsWith('blocked-by:') && r !== 'qbl'),
        blockedBy: refs.filter((r) => r.startsWith('blocked-by:')).map((r) => r.slice('blocked-by:'.length)),
        state: t.state === 'done' ? 'done' : 'open',
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        origin: 'shared',
        // An item somebody else has accepted, or that is offered to somebody else,
        // is not available to propose. Offered-to-nobody stays available, because
        // the REST route lets anyone in the workspace accept it.
        heldBy: t.assigned_to && t.assigned_to !== me ? t.assigned_to : null,
        sharedState: t.state,
    };
}
/**
 * Why the request did not land, in words a reader can act on.
 *
 * Node's fetch reports every transport failure as `TypeError: fetch failed` and
 * buries the actual reason one or two levels down — the real errno sits on
 * `cause`, or inside `cause.errors[]` when the host resolved to several
 * addresses and every attempt failed. Printed as-is, "fetch failed" tells the
 * user nothing about whether the host is wrong, the port is closed, or they are
 * offline, which is the whole content of the sentence this command has to say
 * before falling back.
 */
function netReason(e, timeoutMs) {
    const err = e;
    if (err.name === 'TimeoutError' || err.name === 'AbortError')
        return `no answer within ${timeoutMs}ms`;
    const code = err.code || err.cause?.code || err.cause?.errors?.find((x) => x?.code)?.code;
    if (code === 'ECONNREFUSED')
        return 'connection refused';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
        return 'host not found';
    if (code === 'ECONNRESET')
        return 'the connection was reset';
    if (code === 'CERT_HAS_EXPIRED')
        return 'its TLS certificate has expired';
    // Never `err.message` on its own: the outer error is always the literal
    // string "fetch failed", which names nothing at all.
    return code || err.cause?.message || err.message;
}
/**
 * The shared read, with a timeout, because the alternative is a hang.
 *
 * `api()` in cloud.mts sends no AbortSignal. That is fine for a command whose
 * whole purpose is the network call and which fails visibly when it stalls; it
 * is not fine here, where the shared queue is one input to an answer the local
 * backlog can already produce. A /qbl that sits silently against an unreachable
 * host has failed worse than one that says the host is unreachable — so the
 * timeout is the feature, not a detail.
 */
export async function sharedItems(timeoutMs) {
    let cfg;
    try {
        cfg = config();
    }
    catch (e) {
        return { ok: false, items: [], url: '', reason: `${e.message}` };
    }
    const url = cfg.url.replace(/\/$/, '');
    try {
        const r = await fetch(`${url}/v1/tasks`, {
            headers: {
                authorization: `Bearer ${cfg.token}`,
                ...(cfg.actor ? { 'x-actor': cfg.actor } : {}),
            },
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await r.json().catch(() => ({})));
        if (!r.ok) {
            const msg = Array.isArray(body) ? `HTTP ${r.status}` : body.error || `HTTP ${r.status}`;
            return { ok: false, items: [], url, reason: `${url} refused the request: ${msg}` };
        }
        if (!Array.isArray(body))
            return { ok: false, items: [], url, reason: `${url} answered something that is not a task list` };
        return { ok: true, items: body.map((t) => fromTask(t, cfg.actor)), url, reason: '' };
    }
    catch (e) {
        return { ok: false, items: [], url, reason: `cannot reach ${url}: ${netReason(e, timeoutMs)}` };
    }
}
/**
 * Push to the shared queue, deliberately WITHOUT a `source`.
 *
 * The server upserts on (tenant, source), which is exactly right for /qfeed:
 * a detector re-files the same finding every morning and the evidence updates
 * in place. It is wrong here, and worse than wrong — `qfeed --close` closes any
 * task carrying a source whose finding it can no longer see, and it cannot see
 * a note a person typed into /qbl. A sourced /qbl item would be closed by the
 * next scheduled feeder run, silently, as stale.
 *
 * The price is no dedupe: pushing the same sentence twice files it twice. That
 * is stated in the skill rather than solved by taking the risk above.
 */
export async function pushShared(item, timeoutMs) {
    let cfg;
    try {
        cfg = config();
    }
    catch (e) {
        return { error: e.message };
    }
    const url = cfg.url.replace(/\/$/, '');
    const brief = `${item.text}\n\n` +
        `where: ${item.where.repo}${item.where.branch ? ` · ${item.where.branch}` : ''}` +
        `${item.where.path ? ` · ${item.where.path}` : ''}\n` +
        `why: ${item.why || 'not recorded — pushed without one'}`;
    try {
        const r = await fetch(`${url}/v1/tasks`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${cfg.token}`,
                'content-type': 'application/json',
                ...(cfg.actor ? { 'x-actor': cfg.actor } : {}),
            },
            body: JSON.stringify({
                title: item.text.split('\n')[0].slice(0, 200),
                brief,
                scope: item.where.repo,
                repo: item.where.repo,
                branch: item.where.branch,
                refs: ['qbl', ...item.tags, ...item.blockedBy.map((b) => `blocked-by:${b}`)],
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await r.json().catch(() => ({})));
        if (!r.ok)
            return { error: `${url} refused the push: ${body.error || `HTTP ${r.status}`}` };
        return { id: body.id || '(no id returned)' };
    }
    catch (e) {
        return { error: `cannot reach ${url}: ${netReason(e, timeoutMs)}` };
    }
}
// ---------------------------------------------------------------- ids
/** Short enough to type into `--blocked-by`, wide enough not to collide. */
const mintId = () => 'b' + randomBytes(4).toString('hex');
/**
 * An id, an unambiguous prefix of one, or a refusal that names the candidates.
 * Picking one of several matches would close the wrong item, and a backlog that
 * closes the wrong item is a backlog nobody trusts twice.
 */
export function resolveId(items, given) {
    const exact = items.find((i) => i.id === given);
    if (exact)
        return { id: exact.id };
    const hits = items.filter((i) => i.id.startsWith(given));
    if (hits.length === 1)
        return { id: hits[0].id };
    if (hits.length === 0)
        return { error: `no item here has an id starting with ${given}` };
    return { error: `${given} matches ${hits.length} items: ${hits.map((h) => h.id).join(', ')}` };
}
// ---------------------------------------------------------------- render
const rule = (n = 70) => '─'.repeat(n);
function renderPull(v) {
    const L = [];
    const { ctx, ordering } = v;
    const open = v.items.filter((i) => i.state === 'open').length;
    const done = v.items.filter((i) => i.state === 'done').length;
    L.push(`backlog · ${ctx.name}${ctx.worktree ? ` (${ctx.worktree})` : ''} · ${v.scope}`);
    L.push(`${open} open, ${done} closed${ctx.branch ? ` · on ${ctx.branch}` : ' · no branch could be read here'}`);
    if (v.degraded) {
        L.push('');
        L.push(`  the shared backlog is NOT in this list: ${v.degraded.reason}`);
        L.push('  Showing the LOCAL backlog for this project instead. Anything a teammate');
        L.push('  filed is missing from it, so treat this list as partial, not as the queue.');
    }
    if (v.adoptedFrom.length) {
        L.push('');
        L.push(`  ${v.adoptedFrom.length} backlog file(s) written before this command keyed on the repository`);
        L.push('  root held items belonging to this project. Their contents are included');
        L.push('  in the counts and the sections below, and rewritten under this project\'s');
        L.push('  file. The originals are left where they were:');
        for (const p of v.adoptedFrom)
            L.push(`    ${p}`);
    }
    if (!v.items.length) {
        L.push('');
        L.push(`  This backlog is empty. Nothing has been pushed to ${v.scope === 'shared' ? 'the shared queue' : 'this project'} and`);
        L.push('  nothing has been closed here, so there is nothing to order and nothing to');
        L.push('  propose. No tasks are suggested, because none exist to suggest.');
        L.push('');
        L.push('    push one:   qbl.mjs "what to remember" --why "why it matters"');
        return L.join('\n');
    }
    // Everything closed is not "everything held back", and the branch below said
    // it was: with `open` at 0 it promised reasons "printed beside it below" under
    // a held-back section that could not exist, because nothing was held. Working
    // a small backlog to zero is the state right after empty in how often it
    // happens, and it has its own honest sentence.
    if (!open) {
        L.push('');
        L.push(`  Nothing is open. All ${done} item(s) in this backlog have been closed, so there is`);
        L.push('  nothing to order and nothing to propose. No tasks are suggested, because none');
        L.push('  are outstanding.');
        L.push('');
        L.push('    push one:   qbl.mjs "what to remember" --why "why it matters"');
        return L.join('\n');
    }
    if (!ordering.next.length) {
        L.push('');
        L.push(`  Nothing is ready to pick up. ${open} item(s) are open and every one of them is`);
        L.push('  held back for the reason printed beside it below.');
    }
    else {
        L.push('');
        L.push(`next up (${Math.min(v.limit, ordering.next.length)} of ${ordering.next.length} ready)`);
        L.push(rule());
        ordering.next.slice(0, v.limit).forEach((r, n) => {
            const i = r.item;
            L.push(`  ${n + 1}. ${i.id}  ${i.text.split('\n')[0]}`);
            const w = i.where;
            L.push(`       where   ${w.repo}${w.branch ? ` · ${w.branch}` : ''}${w.path ? ` · ${w.path}` : ''}`);
            L.push(`       why     ${i.why || 'not recorded — this item never said why it matters'}`);
            L.push(`       why now ${r.reasons.join('; ')}`);
        });
    }
    if (ordering.held.length) {
        L.push('');
        L.push(`held back (${ordering.held.length}) — not proposed, and here is why`);
        L.push(rule());
        for (const h of ordering.held)
            L.push(`  ${h.item.id}  ${h.item.text.split('\n')[0].slice(0, 52)}  —  ${h.reason}`);
    }
    L.push('');
    L.push('ordered by');
    L.push(rule());
    for (const b of v.ordering.basis) {
        L.push(`  ${b.separated ? '·' : ' '} ${b.criterion}`);
        L.push(`      ${b.separated ? '' : 'separated nothing: '}${b.detail}`);
    }
    if (v.ordering.ageAlone && v.ordering.next.length > 1) {
        L.push('');
        L.push('  Nothing here records a dependency and nothing distinguishes these by the');
        L.push('  branch you are on, so this list is ordered by age alone. That is a queue,');
        L.push('  not a plan — the order is a fact about when things were written down, and');
        L.push('  no claim at all about which one to do first.');
    }
    if (v.ordering.danglingBlockers.length) {
        L.push('');
        L.push('  blocker ids that name nothing in this backlog, treated as NOT blocking:');
        for (const d of v.ordering.danglingBlockers)
            L.push(`    ${d.id} waits on ${d.names}, which is not here`);
    }
    const hidden = v.ordering.next.length - Math.min(v.limit, v.ordering.next.length);
    if (hidden > 0)
        L.push(`\n  ${hidden} more ready item(s) not shown — qbl.mjs --list for all of them.`);
    if (v.scope === 'local' && !v.degraded) {
        L.push('');
        L.push('  This is the local backlog for this project only. It says nothing about the');
        L.push('  shared queue — qbl.mjs --shared reads that.');
    }
    return L.join('\n');
}
// ---------------------------------------------------------------- cli
const flagValue = (argv, name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
/**
 * A count flag, or a refusal naming what was given.
 *
 * `Number('abc')` is NaN, `Math.min(NaN, n)` is NaN and `slice(0, NaN)` is
 * empty — so `--limit abc` printed "next up (NaN of 2 ready)" and then nothing,
 * with the "not shown" note suppressed because `NaN > 0` is false. The whole
 * list vanished and the page said it had not dropped anything, which is the one
 * failure this file's header forbids outright. Refuse instead of guessing at a
 * default: a typo'd flag the command silently ignored is a flag the user
 * believes took effect.
 */
function countFlag(argv, name, fallback) {
    const raw = flagValue(argv, name);
    if (raw === undefined)
        return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
        console.error(`${name} ${raw} is not a whole number of 1 or more, so this command has no list to print.`);
        console.error(`Give ${name} a positive whole number${name === '--limit' ? ', or --list for everything' : ''}.`);
        process.exit(1);
    }
    return n;
}
/**
 * Where a backlog is read from, with the notes that predate the repository-root
 * key folded back in.
 *
 * Adopting is done on every read rather than once behind a marker, because the
 * marker would be the thing that has to be right. Ids dedupe, so a second run
 * over the same stray file adopts nothing; the save is what makes the message
 * stop appearing, and a save that cannot land leaves the items visible and the
 * message repeating, which is the safe way round.
 */
function openBacklog(ctx) {
    const b = loadBacklog(ctx.key, ctx.name);
    const have = new Set(b.items.map((i) => i.id));
    const adoptedFrom = [];
    for (const stray of strayBacklogs(ctx.key, ctx.root)) {
        const fresh = stray.items.filter((i) => !have.has(i.id));
        if (!fresh.length)
            continue;
        for (const i of fresh) {
            b.items.push(i);
            have.add(i.id);
        }
        adoptedFrom.push(stray.path);
    }
    // Best effort: a config directory that has gone read-only must not turn a
    // pull into an error when the items are already in hand and about to be
    // printed with the file they came from named beside them.
    if (adoptedFrom.length) {
        try {
            saveBacklog(ctx.key, b);
        }
        catch { /* still listed, still said */ }
    }
    return { b, adoptedFrom };
}
const isMain = process.argv[1] && process.argv[1].endsWith('qbl.mjs');
if (isMain) {
    const argv = process.argv.slice(2);
    const has = (f) => argv.includes(f);
    const VALUED = new Set(['--why', '--blocked-by', '--tag', '--done', '--drop', '--timeout', '--limit', '--where']);
    const free = argv
        .filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.has(argv[i - 1])))
        .join(' ')
        .trim();
    const asJson = has('--json');
    const scope = has('--shared') ? 'shared' : 'local';
    const timeoutMs = countFlag(argv, '--timeout', 8000);
    const limit = countFlag(argv, '--limit', 5);
    try {
        const ctx = context();
        if (has('--phrases')) {
            await writeOut('An argument equal to one of these — after lowercasing, dropping punctuation and\n' +
                'collapsing whitespace — is read as a request for work. Anything else is filed as\n' +
                'a backlog item. Matching is whole-string, never substring, so "next: fix the\n' +
                'picker" is a push. --push and --pull override the reading entirely.\n\n' +
                PULL_PHRASES.map((p) => `  ${p}`).join('\n'));
            process.exit(0);
        }
        // ---- close / drop ---------------------------------------------------
        const closing = flagValue(argv, '--done') || flagValue(argv, '--drop');
        if (closing) {
            if (scope === 'shared') {
                console.error('Closing a shared task is a handoff transition, not a backlog edit: only\n' +
                    '`accepted → done` is legal, so a task nobody accepted cannot be closed here.\n' +
                    'Use /qteam, which drives the real transitions and relays the refusal.');
                process.exit(1);
            }
            const { b, adoptedFrom } = openBacklog(ctx);
            const r = resolveId(b.items, closing);
            if ('error' in r) {
                console.error(r.error);
                process.exit(1);
            }
            const item = b.items.find((i) => i.id === r.id);
            if (item.state === 'done') {
                console.log(`${item.id} was already closed.`);
                process.exit(0);
            }
            item.state = 'done';
            item.closedAt = new Date().toISOString();
            item.updatedAt = item.closedAt;
            saveBacklog(ctx.key, b);
            // "No longer blocked" has to mean what the next pull will do with it.
            // Testing only whether this id appears in `blockedBy` announced a release
            // that `order()` then refused to honour — the user was told the work was
            // free and found it still held, by a blocker the close message never
            // mentioned. Every OTHER blocker has to be closed too.
            const stillOpen = new Set(b.items.filter((i) => i.state === 'open').map((i) => i.id));
            const waiting = b.items.filter((i) => i.state === 'open' && i.blockedBy.includes(item.id));
            const freed = waiting.filter((i) => !i.blockedBy.some((x) => stillOpen.has(x)));
            const stuck = waiting.filter((i) => i.blockedBy.some((x) => stillOpen.has(x)));
            console.log(`closed  ${item.id}  ${item.text.split('\n')[0]}`);
            if (!waiting.length)
                console.log('        nothing was waiting on it.');
            if (freed.length)
                console.log(`        ${freed.length} item(s) are no longer blocked: ${freed.map((f) => f.id).join(', ')}`);
            for (const s of stuck) {
                console.log(`        ${s.id} was waiting on it and is STILL held, by ${s.blockedBy.filter((x) => stillOpen.has(x)).join(', ')}`);
            }
            if (adoptedFrom.length)
                console.log(`\n  items were folded in from ${adoptedFrom.join(', ')}`);
            process.exit(0);
        }
        // ---- direction ------------------------------------------------------
        const forcedPush = has('--push');
        const forcedPull = has('--pull') || has('--list');
        if (forcedPush && forcedPull) {
            console.error('--push and --pull say opposite things. Pick one.');
            process.exit(1);
        }
        const pull = forcedPull || (!forcedPush && (!free || readsAsPull(free)));
        if (forcedPush && !free) {
            console.error('--push with nothing to push. Give the item as free text.');
            process.exit(1);
        }
        // ---- push -----------------------------------------------------------
        if (!pull) {
            const why = flagValue(argv, '--why') || null;
            const blockedBy = (flagValue(argv, '--blocked-by') || '').split(',').map((s) => s.trim()).filter(Boolean);
            const tags = (flagValue(argv, '--tag') || '').split(',').map((s) => s.trim()).filter(Boolean);
            const whereArg = flagValue(argv, '--where');
            // Relative to the CHECKOUT, not the key: inside a worktree the two differ
            // and the repository root would prefix every path with
            // `.claude/worktrees/<name>/`, which is not "the path within the repo"
            // this field is documented to carry.
            const rel = relative(ctx.checkout, ctx.cwd);
            const now = new Date().toISOString();
            const item = {
                id: mintId(),
                text: free.slice(0, 4000),
                why: why ? why.slice(0, 4000) : null,
                where: {
                    repo: ctx.name, root: ctx.root, branch: ctx.branch, worktree: ctx.worktree,
                    path: whereArg || (rel && !rel.startsWith('..') ? rel : null),
                },
                tags, blockedBy, state: 'open', createdAt: now, updatedAt: now, origin: scope,
            };
            // Loaded once and reused for the write below: `openBacklog` adopts stray
            // files and saves, so calling it twice would do that work twice.
            const local = scope === 'local' ? openBacklog(ctx) : null;
            // Blocker ids are resolved against the LOCAL backlog before the item is
            // written, so a typo is a refusal now rather than a permanently held item
            // discovered weeks later.
            if (local && blockedBy.length) {
                for (let n = 0; n < blockedBy.length; n++) {
                    const r = resolveId(local.b.items, blockedBy[n]);
                    if ('error' in r) {
                        console.error(`--blocked-by ${blockedBy[n]}: ${r.error}`);
                        process.exit(1);
                    }
                    item.blockedBy[n] = r.id;
                }
            }
            if (scope === 'shared') {
                const res = await pushShared(item, timeoutMs);
                if ('error' in res) {
                    // The push is NOT written locally as a consolation prize. A shared
                    // item that quietly became a local one is an item the teammate it was
                    // meant for will never see, filed under a success message.
                    console.error(`the shared push did not happen: ${res.error}`);
                    console.error('Nothing was written anywhere. Re-run without --shared to file it locally instead.');
                    process.exit(1);
                }
                console.log(`pushed to the shared queue as ${res.id}`);
                console.log(`  what   ${item.text.split('\n')[0]}`);
                console.log(`  where  ${item.where.repo}${item.where.branch ? ` · ${item.where.branch}` : ''}`);
                console.log(`  why    ${item.why || 'NOT RECORDED — nobody reading this later will know why it matters'}`);
                console.log('\n  It lands in `draft`. It is not offered to anyone until somebody offers it.');
                process.exit(0);
            }
            const { b, adoptedFrom } = local;
            b.items.push(item);
            const path = saveBacklog(ctx.key, b);
            if (asJson) {
                await emitJson({ pushed: item, path, adoptedFrom });
                process.exit(0);
            }
            console.log(`pushed  ${item.id}`);
            console.log(`  what   ${item.text.split('\n')[0]}`);
            console.log(`  where  ${item.where.repo}${item.where.branch ? ` · ${item.where.branch}` : ''}${item.where.path ? ` · ${item.where.path}` : ''}`);
            console.log(`  why    ${item.why || 'NOT RECORDED'}`);
            if (!item.why) {
                console.log('\n  No reason was recorded, so this item cannot say why it matters when it is');
                console.log('  pulled. It will be listed with "not recorded" rather than a guess.');
                console.log(`  Add one:  qbl.mjs --push "..." --why "..."   (or re-push with --why)`);
            }
            if (adoptedFrom.length)
                console.log(`\n  items were folded in from ${adoptedFrom.join(', ')}`);
            console.log(`\n  local to ${ctx.name}. ${b.items.filter((i) => i.state === 'open').length} open.`);
            process.exit(0);
        }
        // ---- pull -----------------------------------------------------------
        let items;
        let degraded = null;
        let effective = scope;
        let adoptedFrom = [];
        if (scope === 'shared') {
            const res = await sharedItems(timeoutMs);
            if (res.ok) {
                items = res.items;
            }
            else {
                // Falling back is the right behaviour and silence about it is not: a
                // short local list printed under a shared heading reads as "your team
                // has three things to do".
                degraded = { reason: res.reason };
                effective = 'local';
                const local = openBacklog(ctx);
                items = local.b.items;
                adoptedFrom = local.adoptedFrom;
            }
        }
        else {
            const local = openBacklog(ctx);
            items = local.b.items;
            adoptedFrom = local.adoptedFrom;
        }
        const showAll = has('--list');
        const ord = order(items, ctx, Date.now());
        const view = {
            ctx, scope: effective, items, ordering: ord, degraded, adoptedFrom,
            limit: showAll ? 1e9 : limit,
        };
        if (asJson) {
            await emitJson({
                scope: effective, requestedScope: scope, degraded, adoptedFrom,
                project: { name: ctx.name, branch: ctx.branch, worktree: ctx.worktree },
                empty: items.length === 0,
                counts: {
                    open: items.filter((i) => i.state === 'open').length,
                    // `closed`, not `done`: --drop and --done both land here and the
                    // backlog records no difference between them, so a key called `done`
                    // would be asserting a completion the file cannot support.
                    closed: items.filter((i) => i.state === 'done').length,
                    ready: ord.next.length, held: ord.held.length,
                },
                orderedByAgeAlone: ord.ageAlone,
                basis: ord.basis,
                danglingBlockers: ord.danglingBlockers,
                next: ord.next.slice(0, view.limit).map((r) => ({
                    id: r.item.id, text: r.item.text, why: r.item.why, where: r.item.where, reasons: r.reasons,
                })),
                held: ord.held.map((h) => ({ id: h.item.id, text: h.item.text, reason: h.reason })),
            });
            // The same exit as the text path, and this is the path that needs it
            // most: a caller reading JSON is precisely the one that cannot notice a
            // `degraded` key it did not think to look for, and exiting 0 here handed
            // a script a local-only list under the name of the team queue.
            process.exit(degraded ? 2 : 0);
        }
        await writeOut(renderPull(view));
        // The fallback is a partial answer, and a partial answer that exits 0 is
        // one a script will treat as complete.
        process.exit(degraded ? 2 : 0);
    }
    catch (e) {
        console.error(`error: ${e.message}`);
        process.exit(1);
    }
}
