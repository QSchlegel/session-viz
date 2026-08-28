#!/usr/bin/env node
// The intent a project carries between its sessions.
//
//   node intent.mjs --spine spine.json                     # what is already known
//   node intent.mjs --spine spine.json --merge frag.json   # fold this run in
//   node intent.mjs --spine spine.json --emit              # re-emit, change nothing
//   node intent.mjs --where                                # where the store is
//
// ── What was wrong ──────────────────────────────────────────────────────────
// /qpact re-derived the whole intent on every run and wrote it to one fixed
// path. Two consequences, both of which happened:
//
//   · a second run over the same session paid a second time for reasoning that
//     was already on disk;
//   · a run of a DIFFERENT session landed on the same filename and overwrote
//     the first without a word. render.mts can only catch that when the stale
//     intent and the fresh spine are handed to it together — and by then the
//     file it would have compared against is gone.
//
// So intent is stored per project and per session, and the file a run hands to
// the renderer carries the session in its name. Nothing overwrites anything by
// arriving.
//
// ── The claim this file has to keep ─────────────────────────────────────────
// Carrying conclusions forward is the useful part and the dangerous part. A
// page showing a decision drawn three sessions ago as though this session
// produced it is the exact defect this codebase exists against. So:
//
//   · every conclusion carries the session it was drawn in, the turns cited for
//     it, when it was first recorded, and when it was last restated;
//   · this session's conclusions and earlier sessions' conclusions leave here
//     in SEPARATE fields, so a renderer has to opt in to mixing them and cannot
//     do it by accident;
//   · nothing here judges whether an old conclusion is still true. It cannot. A
//     decision recorded four sessions ago may have been reversed since and this
//     store has no way to see that, so it reports age and says outright that
//     age is not confidence.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { configDirs, configTarget } from './home.mjs';
import { repoRoot, worktreeOf } from './repo.mjs';
import { projectKey, gitRoot, currentBranch } from './qbl.mjs';
import { AUTHORED_GROUPS } from './graph.mjs';
import { emitJson, writeOut } from './out.mjs';
/**
 * A refusal with a name on it.
 *
 * The whole point of this file is that a collision is never silent, so every
 * way one can arise exits through here with a code a caller can branch on and a
 * sentence a person can act on.
 */
export class IntentConflict extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'IntentConflict';
        this.code = code;
    }
}
// ---------------------------------------------------------------- storage
/**
 * Where this project's intent lives.
 *
 * Keyed exactly as /qbl keys a backlog, by importing the function rather than
 * copying it. qbl.mts learned two things the hard way and both apply here
 * unchanged: `repoRoot` is a path-string transform that discovers nothing, so
 * keying on it gives every SUBDIRECTORY of a repository a store of its own —
 * an intent written from `services/api` invisible from the root, which then
 * reports no prior intent and names no reason to doubt it. And a store left
 * under a key nothing computes any more is lost as thoroughly as a deleted one,
 * minus the honesty of saying so; hence `strayStores` below.
 *
 * A second copy of that resolution here would be a second thing to keep right.
 */
export function storeKey(cwd = process.cwd()) {
    return projectKey(cwd);
}
const storeDirs = () => configDirs().map((d) => join(d, 'intent'));
const storePaths = (key) => storeDirs().map((d) => join(d, `${key}.json`));
const storeTarget = (key) => join(dirname(configTarget()), 'intent', `${key}.json`);
/** The file a read should open: the one a write would land in, if it exists. */
export function storeFile(key) {
    const here = storeTarget(key);
    if (existsSync(here))
        return here;
    return storePaths(key).find((p) => existsSync(p)) ?? null;
}
const emptyStore = (name, root, key) => ({
    version: 1,
    project: { name, root, key },
    sessions: [],
});
/**
 * Read the store, or refuse by name.
 *
 * home.mts documents the read-order rule for the contribution ledger and qbl.mts
 * repeats it for the backlog: a writer stops at the first directory it can
 * write, so a reader that opened the first path that merely EXISTS would go on
 * reading a stale copy in a directory that has since gone read-only.
 *
 * A store that will not parse is refused rather than treated as empty. Treating
 * it as empty is the half-read: the run would report no prior intent, the model
 * would re-derive everything it already had, and the save at the end would put
 * that on top of conclusions still sitting on disk. Two sessions' work gone, no
 * error. So this throws, names the file, and leaves it exactly as it found it.
 */
export function loadStore(key, name, root) {
    const p = storeFile(key);
    if (!p)
        return emptyStore(name, root, key);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        throw new IntentConflict('store-unreadable', `the intent store at ${p} is not readable JSON — nothing was read and nothing was written. ` +
            'Move it aside and the next run starts a new one.');
    }
    const doc = parsed;
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.sessions)) {
        throw new IntentConflict('store-unreadable', `the intent store at ${p} parsed as JSON but is not an intent store — it has no \`sessions\` array. ` +
            'Move it aside and the next run starts a new one.');
    }
    const stored = doc.project && typeof doc.project === 'object' ? doc.project : { name, root, key };
    // A store that records a different repository is not this project's, whatever
    // the filename says. Digests are 40 bits and config directories get copied
    // between machines; merging into it would blend two projects' conclusions
    // under one heading and every provenance line would still read as correct.
    const storedRoot = typeof stored.root === 'string' ? stored.root : '';
    if (storedRoot && root && resolveRoot(storedRoot) !== resolveRoot(root)) {
        throw new IntentConflict('project-mismatch', `the intent store at ${p} was written for ${storedRoot}, and this run is in ${root}. ` +
            'Refusing to merge one project\'s conclusions into another — move that file aside if it is stale.');
    }
    return {
        version: 1,
        project: {
            name: typeof stored.name === 'string' && stored.name ? stored.name : name,
            root: storedRoot || root,
            key: typeof stored.key === 'string' && stored.key ? stored.key : key,
        },
        sessions: doc.sessions.filter((s) => !!s && typeof s === 'object' && typeof s.sessionId === 'string' && !!s.sessionId),
    };
}
/**
 * Write 0600 in a 0700 directory, trying each candidate in turn.
 *
 * `writeFileSync` honours `mode` only when it CREATES the file, so a store
 * written before this line existed would keep whatever permissions it had. The
 * explicit chmod is what makes 0600 true on the second write as well as the
 * first — and this file holds model-written summaries of every prompt in a
 * session, so that matters as much here as it does for the reports.
 */
export function saveStore(key, store) {
    const first = storeTarget(key);
    const refused = [];
    for (const path of [first, ...storePaths(key).filter((p) => p !== first)]) {
        try {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
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
    throw new Error(`cannot write the intent store — permission denied at ${refused.join(', ')}. ` +
        'Set SESSION_VIZ_HOME to a directory this harness can write.');
}
/**
 * The same repository, spelled the same way, however it was reached.
 *
 * `/tmp` and `/var` are symlinks into `/private` on macOS, home directories are
 * symlinked on plenty of machines, and `process.cwd()` hands back the resolved
 * path while a path recorded in a file keeps whatever spelling was used when it
 * was written. Comparing the two as strings makes one repository look like two:
 * the store written last week is refused as belonging to another project, and
 * the run that would have adopted it walks past.
 *
 * A path that no longer exists cannot be resolved, so it keeps its spelling —
 * a stale record is compared as it was written rather than throwing.
 */
const canonCache = new Map();
function canon(p) {
    if (!p)
        return p;
    const hit = canonCache.get(p);
    if (hit !== undefined)
        return hit;
    let v = p;
    try {
        v = realpathSync(p);
    }
    catch {
        /* gone from disk, or never existed: compare it as written */
    }
    canonCache.set(p, v);
    return v;
}
/**
 * Write this session's record onto whatever is on disk NOW, not onto the copy
 * this run read a minute ago.
 *
 * The read-modify-write is the same silent overwrite in a different disguise.
 * Two sessions analysing at once in one repository both read the store, both
 * add their own record, and the second save drops the first's — no error, no
 * conflict, and the loser's conclusions are gone from a file whose whole
 * purpose is to keep them.
 *
 * Sessions are disjoint records, which is what makes the repair simple: the
 * only thing this run has any business changing is its own. So the store is
 * re-read immediately before the write, anything that arrived meanwhile is
 * kept, and this session's record is spliced in beside it. A store that has
 * gone corrupt in the meantime throws out of `loadStore` and nothing is
 * written, which is the right way round.
 *
 * What this does NOT close: two runs of the SAME session at the same moment
 * still resolve as last-writer-wins for that one record. Nothing here detects
 * it, so nothing here claims to.
 */
export function saveSessionRecord(key, store, sessionId) {
    const mine = store.sessions.find((s) => s.sessionId === sessionId) ?? null;
    const fresh = loadStore(key, store.project.name, store.project.root);
    const have = new Set(fresh.sessions.map((s) => s.sessionId));
    for (const s of store.sessions) {
        if (!have.has(s.sessionId)) {
            fresh.sessions.push(s);
            have.add(s.sessionId);
        }
    }
    if (mine) {
        const at = fresh.sessions.findIndex((s) => s.sessionId === sessionId);
        if (at === -1)
            fresh.sessions.push(mine);
        else
            fresh.sessions[at] = mine;
    }
    sortSessions(fresh);
    return { path: saveStore(key, fresh), store: fresh };
}
// One resolution per root: adoption asks about the same handful of paths for
// every candidate file it opens.
const rootCache = new Map();
function resolveRoot(r) {
    const hit = rootCache.get(r);
    if (hit !== undefined)
        return hit;
    const v = canon(repoRoot(gitRoot(r) || r) || r);
    rootCache.set(r, v);
    return v;
}
/**
 * Stores holding this project's sessions under a key it no longer uses.
 *
 * qbl.mts hit this exactly: fixing the key without adopting what the old key
 * wrote leaves those notes on disk under a name nothing computes any more.
 * Ownership is decided by re-resolving the root the file RECORDED, never by the
 * filename and never by a prefix test — a nested checkout vendored into this
 * tree resolves to itself, so its sessions stay its own.
 */
export function strayStores(key, root) {
    const out = [];
    const seen = new Set();
    for (const dir of storeDirs()) {
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
            // A file that is not ours and does not parse is not this command's problem
            // to report. Refusing here would let one unrelated corrupt store break
            // every /qpact in every other project on the machine.
            try {
                doc = JSON.parse(readFileSync(path, 'utf8'));
            }
            catch {
                continue;
            }
            if (!doc || !Array.isArray(doc.sessions) || !doc.project || typeof doc.project.root !== 'string')
                continue;
            if (!doc.project.root || resolveRoot(doc.project.root) !== resolveRoot(root))
                continue;
            const sessions = doc.sessions.filter((s) => !!s && typeof s === 'object' && typeof s.sessionId === 'string' && !!s.sessionId);
            if (sessions.length)
                out.push({ path, sessions });
        }
    }
    return out;
}
/**
 * The store, with sessions filed under an older key folded back in.
 *
 * Adopted on every read rather than once behind a marker, because the marker
 * would become the thing that has to be right. Session ids dedupe, so a second
 * pass over the same stray file adopts nothing; the save is what makes the
 * message stop appearing, and a save that cannot land leaves the sessions
 * visible and the message repeating, which is the safe way round.
 */
export function openStore(ctx) {
    const store = loadStore(ctx.key, ctx.name, ctx.root);
    const have = new Set(store.sessions.map((s) => s.sessionId));
    const adoptedFrom = [];
    for (const stray of strayStores(ctx.key, ctx.root)) {
        const fresh = stray.sessions.filter((s) => !have.has(s.sessionId));
        if (!fresh.length)
            continue;
        for (const s of fresh) {
            store.sessions.push(s);
            have.add(s.sessionId);
        }
        adoptedFrom.push(stray.path);
    }
    if (adoptedFrom.length) {
        sortSessions(store);
        // Best effort: a config directory gone read-only must not turn a read into
        // an error when the sessions are already in hand and about to be reported
        // with the file they came from named beside them.
        try {
            saveStore(ctx.key, store);
        }
        catch {
            /* still held, still said */
        }
    }
    return { store, adoptedFrom };
}
const sortSessions = (store) => {
    store.sessions.sort((a, b) => String(a.firstSeen || '').localeCompare(String(b.firstSeen || '')) || a.sessionId.localeCompare(b.sessionId));
};
const TURN_CAP = 200;
const CONCEPT_CAP = 200;
const RELATION_CAP = 400;
const str = (v, cap) => (typeof v === 'string' ? v.trim().slice(0, cap) : '');
const strList = (v, cap, max) => Array.isArray(v) ? v.map((x) => str(x, cap)).filter(Boolean).slice(0, max) : [];
/**
 * Turn citations, normalised and never invented.
 *
 * A non-integer, a negative or a string that will not parse is dropped rather
 * than coerced: `turns: ["several"]` becoming `[NaN]` would print as a turn
 * reference that points at nothing, which is worse than the empty array that
 * honestly says the author cited none.
 */
const turnList = (v) => {
    if (!Array.isArray(v))
        return [];
    const out = new Set();
    for (const raw of v) {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (Number.isInteger(n) && n >= 0)
            out.add(n);
    }
    return [...out].sort((a, b) => a - b).slice(0, TURN_CAP);
};
const unionTurns = (a, b) => [...new Set([...a, ...b])].sort((x, y) => x - y).slice(0, TURN_CAP);
const STATUSES = ['done', 'partial', 'abandoned', 'ongoing'];
/**
 * What makes two authored edges the same edge.
 *
 * Joining the three fields with a separator means a value containing that
 * separator can forge another edge's identity: `a b`→`c` and `a`→`b c` are
 * different relations and would merge into one. An earlier draft dodged that by
 * joining on a NUL, which worked and turned the source file into something
 * `grep` reports as binary. JSON has no such character to hide behind.
 */
const relationId = (from, to, label) => JSON.stringify([from, to, label]);
const slugTitle = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/**
 * Fold one run's conclusions into the store.
 *
 * Two rules carry the whole design.
 *
 * A field the fragment omits is KEPT, with its original provenance untouched.
 * That is the compute saving and it is the point: a second run over one session
 * writes only what changed, and what it does not write goes on saying which turns
 * it came from and when it was first recorded rather than being re-dated to now.
 *
 * A conclusion belonging to a different session is never written into this one.
 * Sessions are separate records, so an arriving run cannot clobber another by
 * landing; and a fragment that declares a session other than the one being
 * merged is refused by name rather than filed under the wrong heading — that
 * refusal is the whole reason this file exists.
 */
export function mergeFragment(store, sessionId, fragment, meta = {}) {
    if (!sessionId) {
        throw new IntentConflict('no-session-id', 'no session id — an intent that cannot be told apart from another session\'s is exactly what this store exists to prevent.');
    }
    const declared = str(fragment.sessionId, 200);
    if (declared && declared !== sessionId) {
        throw new IntentConflict('session-mismatch', `this fragment declares session ${declared.slice(0, 8)} and this run is session ${sessionId.slice(0, 8)}. ` +
            'Refusing to file one session\'s conclusions under another — re-derive for this session, or pass ' +
            `--session ${declared} to file it where it belongs.`);
    }
    const now = meta.now ?? new Date();
    const stamp = now.toISOString();
    const dropped = [];
    const drop = (what, why, count) => {
        if (count > 0)
            dropped.push({ what, why, count });
    };
    let rec = store.sessions.find((s) => s.sessionId === sessionId);
    const firstRun = !rec;
    if (!rec) {
        rec = {
            sessionId,
            firstSeen: stamp,
            lastSeen: stamp,
            runs: 0,
            turnsSeen: null,
            cwd: meta.cwd ?? '',
            branch: meta.branch ?? null,
            worktree: meta.worktree ?? null,
            tldr: null,
            compactInstruction: null,
            intents: [],
            quality: null,
            graph: { concepts: [], relations: [] },
        };
        store.sessions.push(rec);
    }
    const priorSessions = store.sessions.filter((s) => s.sessionId !== sessionId && String(s.firstSeen || '') < String(rec.firstSeen || '')).length;
    rec.runs += 1;
    rec.lastSeen = stamp;
    if (meta.cwd)
        rec.cwd = meta.cwd;
    if (meta.branch !== undefined)
        rec.branch = meta.branch;
    if (meta.worktree !== undefined)
        rec.worktree = meta.worktree;
    if (typeof meta.turnsNow === 'number' && Number.isFinite(meta.turnsNow))
        rec.turnsSeen = meta.turnsNow;
    const prov = (existing, turns) => ({
        session: sessionId,
        turns,
        recordedAt: stamp,
        firstRecordedAt: existing?.firstRecordedAt ?? stamp,
    });
    // ---- the three scalars
    const setText = (current, incoming, turns) => {
        if (!incoming)
            return { value: current, change: current ? 'carried' : 'absent' };
        return {
            value: { text: incoming, provenance: prov(current?.provenance, turns) },
            change: current ? 'replaced' : 'added',
        };
    };
    // The tldr and the compact instruction are about the session as a whole, and
    // the author cites no turns for them. Recording the turns the spine reached
    // instead would be this file inventing a citation, so they carry none and a
    // reader is told none were cited.
    const t = setText(rec.tldr, str(fragment.tldr, 8000), []);
    rec.tldr = t.value;
    const c = setText(rec.compactInstruction, str(fragment.compactInstruction, 8000), []);
    rec.compactInstruction = c.value;
    let qualityChange = rec.quality ? 'carried' : 'absent';
    const fq = fragment.quality;
    if (fq && (str(fq.verdict, 4000) || (fq.strengths?.length || fq.weaknesses?.length || fq.recommendations?.length))) {
        qualityChange = rec.quality ? 'replaced' : 'added';
        rec.quality = {
            verdict: str(fq.verdict, 4000),
            strengths: strList(fq.strengths, 500, 20),
            weaknesses: strList(fq.weaknesses, 500, 20),
            recommendations: strList(fq.recommendations, 500, 20),
            provenance: prov(rec.quality?.provenance, turnList(fq.turns)),
        };
    }
    // ---- intents, keyed on the slugged title so a restatement updates rather
    // than duplicates. Identity by title is what makes a second run of one session
    // a merge; without it the breakdown grows a second copy of every line the
    // model chose to restate.
    const iChange = { added: 0, updated: 0, carried: 0 };
    const touchedIntents = new Set();
    let badStatus = 0;
    let untitled = 0;
    for (const raw of fragment.intents ?? []) {
        const title = str(raw?.title, 300);
        if (!title) {
            untitled++;
            continue;
        }
        const id = slugTitle(title);
        if (!id) {
            untitled++;
            continue;
        }
        const turns = turnList(raw?.turns);
        const statusRaw = str(raw?.status, 40).toLowerCase();
        const status = STATUSES.includes(statusRaw) ? statusRaw : 'ongoing';
        if (statusRaw && status !== statusRaw)
            badStatus++;
        const existing = rec.intents.find((x) => slugTitle(x.title) === id);
        if (existing) {
            // Turns accumulate across runs of one session: a run that cites fewer does
            // not retract what an earlier run cited for the same conclusion.
            const merged = unionTurns(existing.turns, turns);
            existing.title = title;
            existing.status = status;
            existing.summary = str(raw?.summary, 4000) || existing.summary;
            existing.turns = merged;
            existing.provenance = prov(existing.provenance, merged);
            iChange.updated++;
        }
        else {
            rec.intents.push({ title, status, summary: str(raw?.summary, 4000), turns, provenance: prov(undefined, turns) });
            iChange.added++;
        }
        touchedIntents.add(id);
    }
    iChange.carried = rec.intents.filter((x) => !touchedIntents.has(slugTitle(x.title))).length;
    drop('intent', 'no title, so nothing to key it on', untitled);
    drop('intent.status', `not one of ${STATUSES.join(' | ')}; recorded as ongoing`, badStatus);
    // ---- graph concepts, keyed on the id graph.mts already requires
    const cChange = { added: 0, updated: 0, carried: 0 };
    const touchedConcepts = new Set();
    let badId = 0;
    let badGroup = 0;
    let overCap = 0;
    for (const raw of fragment.graph?.concepts ?? []) {
        const id = str(raw?.id, 80);
        const label = str(raw?.label, 300);
        if (!id || !label) {
            badId++;
            continue;
        }
        const turns = turnList(raw?.turns);
        const anchors = strList(raw?.anchors, 200, 40);
        const groupRaw = str(raw?.group, 40).toLowerCase();
        // graph.mts owns the vocabulary and applies its own fallback at render time.
        // A group this store cannot vouch for is left absent rather than stored as
        // junk that outlives the run that wrote it.
        const group = AUTHORED_GROUPS.includes(groupRaw) ? groupRaw : undefined;
        if (groupRaw && !group)
            badGroup++;
        const existing = rec.graph.concepts.find((x) => x.id === id);
        if (existing) {
            const merged = unionTurns(existing.turns, turns);
            existing.label = label;
            if (group)
                existing.group = group;
            const note = str(raw?.note, 2000);
            if (note)
                existing.note = note;
            existing.turns = merged;
            existing.anchors = [...new Set([...existing.anchors, ...anchors])].slice(0, 40);
            existing.provenance = prov(existing.provenance, merged);
            cChange.updated++;
        }
        else if (rec.graph.concepts.length >= CONCEPT_CAP) {
            overCap++;
            continue;
        }
        else {
            const note = str(raw?.note, 2000);
            const entry = { id, label, turns, anchors, provenance: prov(undefined, turns) };
            if (group)
                entry.group = group;
            if (note)
                entry.note = note;
            rec.graph.concepts.push(entry);
            cChange.added++;
        }
        touchedConcepts.add(id);
    }
    cChange.carried = rec.graph.concepts.filter((x) => !touchedConcepts.has(x.id)).length;
    drop('concept', 'no id or no label', badId);
    drop('concept.group', `not one of ${AUTHORED_GROUPS.join(' | ')}; left unset for graph.mts to fall back`, badGroup);
    drop('concept', `this session already holds ${CONCEPT_CAP} concepts`, overCap);
    // ---- graph relations, keyed on the triple that identifies an edge
    const rChange = { added: 0, updated: 0, carried: 0 };
    const touchedRelations = new Set();
    let badEdge = 0;
    let overEdgeCap = 0;
    for (const raw of fragment.graph?.relations ?? []) {
        const from = str(raw?.from, 80);
        const to = str(raw?.to, 80);
        if (!from || !to) {
            badEdge++;
            continue;
        }
        const label = str(raw?.label, 200);
        const turns = turnList(raw?.turns);
        const id = relationId(from, to, label);
        const existing = rec.graph.relations.find((x) => relationId(x.from, x.to, x.label) === id);
        if (existing) {
            const merged = unionTurns(existing.turns, turns);
            existing.dashed = raw?.dashed !== false;
            existing.turns = merged;
            existing.provenance = prov(existing.provenance, merged);
            rChange.updated++;
        }
        else if (rec.graph.relations.length >= RELATION_CAP) {
            overEdgeCap++;
            continue;
        }
        else {
            rec.graph.relations.push({ from, to, label, dashed: raw?.dashed !== false, turns, provenance: prov(undefined, turns) });
            rChange.added++;
        }
        touchedRelations.add(id);
    }
    rChange.carried = rec.graph.relations.filter((x) => !touchedRelations.has(relationId(x.from, x.to, x.label))).length;
    drop('relation', 'no from or no to', badEdge);
    drop('relation', `this session already holds ${RELATION_CAP} relations`, overEdgeCap);
    sortSessions(store);
    return {
        session: sessionId,
        firstRun,
        runs: rec.runs,
        tldr: t.change,
        compactInstruction: c.change,
        quality: qualityChange,
        intents: iChange,
        concepts: cChange,
        relations: rChange,
        dropped,
        priorSessions,
    };
}
// ---------------------------------------------------------------- emit
/**
 * The sentence that has to travel with every carried-forward conclusion.
 *
 * Written once, here, so a renderer quotes it rather than paraphrasing it into
 * something the store cannot support.
 */
export const STALENESS_NOTE = 'Each conclusion records the session it was drawn in and the turns cited for it. ' +
    'Nothing has re-checked whether an older one is still true: a decision recorded in an ' +
    'earlier session may have been reversed since, and this store cannot see that. ' +
    'Read sessionsAgo and daysAgo as age, not as confidence.';
const DAY = 86_400_000;
const daysSince = (iso, now) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t))
        return null;
    return Math.max(0, Math.floor((now.getTime() - t) / DAY));
};
/**
 * Emit a document for one session.
 *
 * `limit` caps how many earlier sessions travel with it, and whatever is held
 * back is COUNTED in `staleness.priorOmitted` — a truncated history presented as
 * a whole one is the same class of defect as an undated conclusion.
 */
export function emitIntent(store, sessionId, opts = {}) {
    const now = opts.now ?? new Date();
    const limit = opts.limit ?? 6;
    const ordered = [...store.sessions].sort((a, b) => String(a.firstSeen || '').localeCompare(String(b.firstSeen || '')) || a.sessionId.localeCompare(b.sessionId));
    const idx = new Map(ordered.map((s, i) => [s.sessionId, i]));
    // A session not yet in the store is "after everything held", which is what an
    // emit before the first merge means.
    const here = idx.get(sessionId) ?? ordered.length;
    const stamp = (p) => {
        const at = idx.get(p.session);
        return {
            session: p.session,
            turns: Array.isArray(p.turns) ? p.turns : [],
            recordedAt: p.recordedAt,
            firstRecordedAt: p.firstRecordedAt ?? p.recordedAt,
            fromThisSession: p.session === sessionId,
            sessionsAgo: at === undefined ? 0 : Math.max(0, here - at),
            daysAgo: daysSince(p.recordedAt, now),
        };
    };
    const rec = ordered.find((s) => s.sessionId === sessionId) ?? null;
    const priorAll = ordered.filter((s) => s.sessionId !== sessionId && (idx.get(s.sessionId) ?? 0) < here).reverse();
    const prior = priorAll.slice(0, limit).map((s) => ({
        sessionId: s.sessionId,
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
        sessionsAgo: Math.max(1, here - (idx.get(s.sessionId) ?? 0)),
        daysAgo: daysSince(s.lastSeen, now),
        runs: s.runs,
        tldr: s.tldr ? { text: s.tldr.text, provenance: stamp(s.tldr.provenance) } : null,
        // The compact instruction is deliberately NOT carried forward. It is a
        // instruction for compacting ONE session's context; handing an earlier
        // session's line to /compact now would tell the summariser to preserve
        // threads this session never touched.
        intents: s.intents.map((i) => ({ ...i, provenance: stamp(i.provenance) })),
        quality: s.quality ? { ...s.quality, provenance: stamp(s.quality.provenance) } : null,
        graph: {
            concepts: s.graph.concepts.map((c) => ({ ...c, provenance: stamp(c.provenance) })),
            relations: s.graph.relations.map((r) => ({ ...r, provenance: stamp(r.provenance) })),
        },
    }));
    const out = {
        sessionId,
        intents: rec ? rec.intents.map((i) => ({ ...i, provenance: stamp(i.provenance) })) : [],
        graph: {
            concepts: rec ? rec.graph.concepts.map((c) => ({ ...c, provenance: stamp(c.provenance) })) : [],
            relations: rec ? rec.graph.relations.map((r) => ({ ...r, provenance: stamp(r.provenance) })) : [],
        },
        provenance: {},
        prior,
        staleness: {
            note: STALENESS_NOTE,
            sessionsHeld: ordered.length,
            priorOmitted: Math.max(0, priorAll.length - prior.length),
            oldestRecordedAt: ordered[0]?.firstSeen ?? null,
        },
        store: { path: opts.path ?? null, project: store.project.name, key: store.project.key },
    };
    if (rec?.tldr) {
        out.tldr = rec.tldr.text;
        out.provenance.tldr = stamp(rec.tldr.provenance);
    }
    if (rec?.compactInstruction) {
        out.compactInstruction = rec.compactInstruction.text;
        out.provenance.compactInstruction = stamp(rec.compactInstruction.provenance);
    }
    if (rec?.quality) {
        out.quality = { ...rec.quality, provenance: stamp(rec.quality.provenance) };
        out.provenance.quality = out.quality.provenance;
    }
    return out;
}
/**
 * A short id for a filename. Twelve characters of the session id, so two
 * sessions cannot land on one path — which was the original defect, at a
 * fixed path shared by every session on the machine.
 */
export const sessionSlug = (sessionId) => {
    const clean = sessionId.toLowerCase().replace(/[^a-z0-9]/g, '');
    return clean.slice(0, 12) || createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
};
/**
 * Per-session files live one directory BELOW the stores.
 *
 * `strayStores` scans every `*.json` beside a store looking for one that
 * records this repository, and an emitted document is a JSON file that sits
 * next to a store and describes the same project. It is rejected today on the
 * shape of its `project` field, which means a later change to that field —
 * made in another file, for another reason — would quietly turn every emitted
 * document into a candidate store. A directory boundary does not depend on
 * anyone remembering that.
 */
const sessionDir = (key) => join(dirname(storeTarget(key)), 'sessions');
export const fragmentPath = (key, sessionId) => join(sessionDir(key), `${key}.${sessionSlug(sessionId)}.fragment.json`);
export const renderPath = (key, sessionId) => join(sessionDir(key), `${key}.${sessionSlug(sessionId)}.intent.json`);
export function contextFor(store, sessionId, opts = {}) {
    const now = opts.now ?? new Date();
    const em = emitIntent(store, sessionId, { now, limit: opts.limit ?? 6, path: storeFile(store.project.key) });
    const rec = store.sessions.find((s) => s.sessionId === sessionId) ?? null;
    const turnsNow = typeof opts.turnsNow === 'number' && Number.isFinite(opts.turnsNow) ? opts.turnsNow : null;
    const turnsAtLastRun = rec?.turnsSeen ?? null;
    return {
        store: {
            path: storeFile(store.project.key),
            target: storeTarget(store.project.key),
            key: store.project.key,
            project: store.project.name,
            sessionsHeld: store.sessions.length,
        },
        session: {
            sessionId,
            known: !!rec,
            runs: rec?.runs ?? 0,
            firstSeen: rec?.firstSeen ?? null,
            lastSeen: rec?.lastSeen ?? null,
            turnsAtLastRun,
            turnsNow,
            newTurns: turnsNow !== null && turnsAtLastRun !== null ? Math.max(0, turnsNow - turnsAtLastRun) : null,
        },
        reusable: {
            tldr: !!rec?.tldr,
            compactInstruction: !!rec?.compactInstruction,
            quality: !!rec?.quality,
            intents: rec?.intents.length ?? 0,
            concepts: rec?.graph.concepts.length ?? 0,
            relations: rec?.graph.relations.length ?? 0,
        },
        prior: em.prior.map((p) => ({
            sessionId: p.sessionId,
            sessionsAgo: p.sessionsAgo,
            daysAgo: p.daysAgo,
            intents: p.intents.length,
            concepts: p.graph.concepts.length,
            headline: p.tldr?.text ? p.tldr.text.slice(0, 160) : null,
        })),
        staleness: STALENESS_NOTE,
        paths: { fragment: fragmentPath(store.project.key, sessionId), render: renderPath(store.project.key, sessionId) },
        adoptedFrom: opts.adoptedFrom ?? [],
    };
}
/**
 * The two facts this command needs out of a spine: which session, and how far
 * it has got.
 *
 * Reading them here rather than asking the model to copy them across removes the
 * transcription step that made the old SKILL.md say "copy this verbatim — the
 * page checks it". A mistyped id was a page that silently described the wrong
 * session; a mistyped id now cannot happen because nobody types it.
 *
 * A spine with no `sessionId` still has to be filed somewhere, and a shared
 * bucket for all of them would rebuild the exact collision this store exists to
 * stop. The transcript path is a real identity, so it is digested into one — and
 * `idFrom` records that it happened, so nothing downstream reports a derived id
 * as one the harness wrote.
 */
export function spineFacts(path) {
    let doc;
    try {
        doc = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch (e) {
        throw new IntentConflict('spine-unreadable', `the spine at ${path} is not readable JSON: ${e.message}`);
    }
    const id = typeof doc.sessionId === 'string' && doc.sessionId ? doc.sessionId : '';
    const file = typeof doc.file === 'string' ? doc.file : '';
    if (!id && !file) {
        throw new IntentConflict('no-session-id', `the spine at ${path} carries neither a sessionId nor a transcript path, so this run cannot be told apart ` +
            'from another session\'s. Pass --session <id> to file it deliberately.');
    }
    return {
        sessionId: id || `file-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`,
        turns: Array.isArray(doc.turns) ? doc.turns.length : null,
        idFrom: id ? 'spine' : 'file',
        cwd: typeof doc.cwd === 'string' ? doc.cwd : null,
    };
}
// ---------------------------------------------------------------- printing
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
function renderContext(c) {
    const L = [];
    L.push(`intent store · ${c.store.project} · ${plural(c.store.sessionsHeld, 'session')} held`);
    L.push(`  store     ${c.store.path ?? `${c.store.target} (not written yet)`}`);
    const runLine = c.session.known ? `run ${c.session.runs + 1} of this session` : 'first run of this session';
    L.push(`  session   ${c.session.sessionId.slice(0, 8)}  ${runLine}`);
    if (c.session.turnsAtLastRun !== null && c.session.turnsNow !== null) {
        L.push(`  turns     analysed through ${c.session.turnsAtLastRun}; the spine now has ${c.session.turnsNow} (${c.session.newTurns} new)`);
    }
    else if (c.session.turnsNow !== null) {
        L.push(`  turns     ${c.session.turnsNow} in the spine`);
    }
    if (c.adoptedFrom.length) {
        L.push('');
        L.push(`  ${plural(c.adoptedFrom.length, 'store file')} written before this command keyed on the repository were folded in:`);
        for (const p of c.adoptedFrom)
            L.push(`    ${p}`);
    }
    const r = c.reusable;
    const anything = r.tldr || r.compactInstruction || r.quality || r.intents || r.concepts || r.relations;
    L.push('');
    if (anything) {
        L.push('already recorded for THIS session — leave a field out of the fragment and it stays as it is');
        if (r.tldr)
            L.push('  tldr');
        if (r.compactInstruction)
            L.push('  compact instruction');
        if (r.quality)
            L.push('  quality');
        if (r.intents)
            L.push(`  ${plural(r.intents, 'intent')}`);
        if (r.concepts || r.relations)
            L.push(`  ${plural(r.concepts, 'concept')}, ${plural(r.relations, 'relation')}`);
    }
    else {
        L.push('nothing recorded for this session yet — the fragment is written from scratch');
    }
    L.push('');
    if (c.prior.length) {
        L.push('carried forward from earlier sessions — context, not this session\'s work');
        for (const p of c.prior) {
            const age = p.daysAgo === null ? '' : `, ${plural(p.daysAgo, 'day')} old`;
            L.push(`  ${plural(p.sessionsAgo, 'session')} ago  ${p.sessionId.slice(0, 8)}  ${plural(p.intents, 'intent')}, ${plural(p.concepts, 'concept')}${age}`);
            if (p.headline)
                L.push(`    ${p.headline}`);
        }
        L.push('');
        L.push(`  ${c.staleness}`);
    }
    else {
        L.push('no earlier sessions recorded for this project');
    }
    L.push('');
    L.push('write the fragment to');
    L.push(`  ${c.paths.fragment}`);
    L.push('then');
    L.push(`  node intent.mjs --spine <spine.json> --merge ${c.paths.fragment}`);
    return L.join('\n');
}
function renderMerge(rep, out, storePath) {
    const L = [];
    const f = (c) => `${c.added} new, ${c.updated} updated, ${c.carried} carried`;
    L.push(`merged into session ${rep.session.slice(0, 8)} — run ${rep.runs}${rep.firstRun ? ' (first)' : ''}`);
    L.push(`  tldr / compact / quality   ${rep.tldr} / ${rep.compactInstruction} / ${rep.quality}`);
    L.push(`  intents                    ${f(rep.intents)}`);
    L.push(`  concepts                   ${f(rep.concepts)}`);
    L.push(`  relations                  ${f(rep.relations)}`);
    if (rep.priorSessions) {
        L.push(`  ${plural(rep.priorSessions, 'earlier session')} of this project carried forward as prior context, untouched`);
    }
    for (const d of rep.dropped)
        L.push(`  dropped ${plural(d.count, d.what)} — ${d.why}`);
    L.push('');
    L.push(`  store   ${storePath}`);
    L.push(`  render  ${out}`);
    return L.join('\n');
}
// ---------------------------------------------------------------- cli
const isMain = process.argv[1] && process.argv[1].endsWith('intent.mjs');
if (isMain) {
    const argv = process.argv.slice(2);
    const has = (f) => argv.includes(f);
    const opt = (f) => {
        const i = argv.indexOf(f);
        return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
    };
    const asJson = has('--json');
    const fail = async (code, message) => {
        if (asJson)
            await emitJson({ error: code, message });
        else
            console.error(`error [${code}]: ${message}`);
        process.exit(1);
    };
    try {
        if (has('--help') || has('-h')) {
            await writeOut([
                'usage: intent.mjs --spine <spine.json> [--merge <fragment.json>] [--emit] [--json]',
                '       intent.mjs --session <id> [...]      when there is no spine to read',
                '       intent.mjs --where                   the store path and what it holds',
                '',
                'With neither --merge nor --emit it reports what the store already knows about',
                'this session and this project, and changes nothing.',
            ].join('\n'));
            process.exit(0);
        }
        const ctx = storeKey(process.cwd());
        const { store, adoptedFrom } = openStore(ctx);
        if (has('--where')) {
            const held = store.sessions.map((s) => ({ sessionId: s.sessionId, runs: s.runs, firstSeen: s.firstSeen, lastSeen: s.lastSeen }));
            if (asJson) {
                await emitJson({ project: ctx.name, root: ctx.root, key: ctx.key, path: storeFile(ctx.key), target: storeTarget(ctx.key), sessions: held, adoptedFrom });
                process.exit(0);
            }
            await writeOut([
                `project   ${ctx.name}`,
                `key       ${ctx.key}`,
                `store     ${storeFile(ctx.key) ?? `${storeTarget(ctx.key)} (not written yet)`}`,
                `sessions  ${held.length}`,
                ...held.map((h) => `  ${h.sessionId.slice(0, 8)}  ${plural(h.runs, 'run')}  last ${h.lastSeen}`),
                ...(adoptedFrom.length ? ['', `adopted from ${adoptedFrom.join(', ')}`] : []),
            ].join('\n'));
            process.exit(0);
        }
        const spinePath = opt('--spine');
        const facts = spinePath ? spineFacts(spinePath) : null;
        const sessionId = opt('--session') || facts?.sessionId || '';
        if (!sessionId) {
            await fail('no-session-id', 'give --spine <spine.json> or --session <id>. Nothing is filed without one, because a shared bucket for unnamed sessions is the collision this store exists to prevent.');
        }
        // Said, not swallowed: a page built on a derived id would otherwise present
        // it as the id the harness wrote.
        if (facts && facts.idFrom === 'file' && !opt('--session') && !asJson) {
            console.error(`note: that spine carries no sessionId, so this run is filed under an id derived from the transcript path (${sessionId}).`);
        }
        const mergePath = opt('--merge');
        if (mergePath) {
            let fragment;
            try {
                fragment = JSON.parse(readFileSync(mergePath, 'utf8'));
            }
            catch (e) {
                await fail('fragment-unreadable', `the fragment at ${mergePath} is not readable JSON: ${e.message}`);
                throw e;
            }
            const rep = mergeFragment(store, sessionId, fragment, {
                cwd: ctx.checkout,
                branch: currentBranch(process.cwd()),
                worktree: worktreeOf(process.cwd()),
                turnsNow: facts?.turns ?? null,
            });
            // Emitted from the store as it stands AFTER the write, so a session that
            // landed while this one was thinking is carried forward rather than
            // missing from a page that names no reason for its absence.
            const saved = saveSessionRecord(ctx.key, store, sessionId);
            const out = opt('--out') || renderPath(ctx.key, sessionId);
            const doc = emitIntent(saved.store, sessionId, { path: saved.path });
            mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
            writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
            chmodSync(out, 0o600);
            if (asJson) {
                await emitJson({ merged: rep, store: saved.path, render: out, adoptedFrom });
                process.exit(0);
            }
            await writeOut(renderMerge(rep, out, saved.path));
            process.exit(0);
        }
        if (has('--emit')) {
            const out = opt('--out') || renderPath(ctx.key, sessionId);
            const doc = emitIntent(store, sessionId, { path: storeFile(ctx.key) });
            mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
            writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
            chmodSync(out, 0o600);
            if (asJson) {
                await emitJson({ render: out, sessionId, sessionsHeld: doc.staleness.sessionsHeld, prior: doc.prior.length });
                process.exit(0);
            }
            await writeOut(`render  ${out}`);
            process.exit(0);
        }
        const c = contextFor(store, sessionId, { turnsNow: facts?.turns ?? null, adoptedFrom });
        if (asJson) {
            await emitJson(c);
            process.exit(0);
        }
        await writeOut(renderContext(c));
        process.exit(0);
    }
    catch (e) {
        const code = e instanceof IntentConflict ? e.code : 'error';
        if (asJson)
            await emitJson({ error: code, message: e.message });
        else
            console.error(`error [${code}]: ${e.message}`);
        process.exit(1);
    }
}
