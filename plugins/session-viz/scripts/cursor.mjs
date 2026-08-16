// Cursor conversations, normalised into the records extract.mts already reads.
//
// The two harnesses before this one disagreed about a lot but agreed that a
// transcript is a file of JSON lines. Cursor does not: the whole machine's chat
// history is ONE SQLite database, `state.vscdb`, keyed like a KV store —
// `composerData:<id>` holds a conversation's spine, `bubbleId:<composer>:<id>`
// holds each message as its own row. 981 conversations and ~4k messages here.
//
// So this file owes extract() two things the other adapters got for free: an
// address for a session that is not a path, and a `cwd` that Cursor never
// records.
//
// SQLite comes from `node:sqlite`, built into Node 22. It is flagged
// experimental and warns on import, which is suppressed below — the alternative
// was a native dependency in a plugin that currently has none, or shelling out
// to a `sqlite3` binary that is not on every machine this runs on.
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
// ---------------------------------------------------------------- addressing
/**
 * A Cursor session id is `<path-to-db>#<composerId>`.
 *
 * Everything upstream — listSessions, extract, the --project filter, the run
 * ledger — passes sessions around as a path string. Rather than widen all of
 * that to a tagged union for one harness, the composer id rides in a fragment,
 * which no filesystem call will ever produce by accident and which splits back
 * apart unambiguously because a composer id is a UUID and contains no '#'.
 */
const FRAGMENT = '#';
export const cursorAddress = (db, composerId) => `${db}${FRAGMENT}${composerId}`;
export function splitCursorAddress(file) {
    const i = file.lastIndexOf(FRAGMENT);
    if (i <= 0)
        return null;
    const db = file.slice(0, i);
    const composerId = file.slice(i + 1);
    if (!composerId || !db.endsWith('.vscdb'))
        return null;
    return { db, composerId };
}
export const isCursorTranscript = (file) => splitCursorAddress(file) !== null;
// ---------------------------------------------------------------- the store
/**
 * Where Cursor keeps `state.vscdb`, per platform.
 *
 * Returned as the containing directory rather than the file, so a Cursor root
 * is the same shape as every other harness root — transcriptRoots() checks
 * isDirectory(), and a root that was a file would have been silently dropped by
 * the very function whose job is to notice that a harness is present.
 */
export function cursorGlobalStorage() {
    const out = [];
    const push = (d) => { if (d && !out.includes(d))
        out.push(d); };
    push(process.env.CURSOR_GLOBAL_STORAGE);
    const home = homedir();
    // macOS
    push(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'));
    // Linux, and the Flatpak layout
    push(join(home, '.config', 'Cursor', 'User', 'globalStorage'));
    push(join(home, '.var', 'app', 'com.cursor.Cursor', 'config', 'Cursor', 'User', 'globalStorage'));
    // Windows, when running under a shell that exposes APPDATA
    push(process.env.APPDATA ? join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage') : undefined);
    return out;
}
const DB_NAME = 'state.vscdb';
/** The database inside a Cursor root, or null when the root holds none. */
export function cursorDb(root) {
    const p = basename(root) === DB_NAME ? root : join(root, DB_NAME);
    return existsSync(p) ? p : null;
}
// `node:sqlite` prints an ExperimentalWarning on first use. It goes to stderr,
// so it cannot corrupt --json on stdout, but it appears above every report and
// reads like a fault in the tool. Filtered rather than silenced globally: any
// other warning still gets through.
let openDb = null;
let sqliteTried = false;
/**
 * Load `node:sqlite` synchronously.
 *
 * `await import()` would be the idiomatic ESM way and is not available to us:
 * listSessions() is synchronous and is called from five places, so an async
 * loader here would turn into an async listSessions and an await at every call
 * site in the plugin — a refactor of everything, to accommodate one harness.
 * createRequire gives the same module without that.
 */
function sqlite() {
    if (openDb || sqliteTried)
        return openDb;
    sqliteTried = true;
    const warned = process.emitWarning;
    process.emitWarning = ((w, ...rest) => {
        const name = typeof w === 'string' ? String(rest[0] ?? '') : w?.name;
        if (String(name).includes('Experimental') && String(w).includes('SQLite'))
            return;
        warned.call(process, w, ...rest);
    });
    try {
        const req = createRequire(import.meta.url);
        const mod = req('node:sqlite');
        openDb = (file) => new mod.DatabaseSync(file, { readOnly: true });
        return openDb;
    }
    catch {
        // Node built without SQLite, or older than 22. A harness we cannot read is
        // reported by the coverage table, never by a crash in a command that was
        // about something else.
        return null;
    }
    finally {
        process.emitWarning = warned;
    }
}
/** Whether this Node can read a Cursor database at all. */
export const cursorReadable = () => sqlite() !== null;
/**
 * Open the database read-only and close it immediately.
 *
 * This is the one operation in the plugin that touches a file another running
 * application owns, so it holds the handle for exactly one query and never
 * writes. Any failure returns the fallback: Cursor being open, mid-write, or a
 * version ahead of this schema must degrade to "no Cursor sessions", not to a
 * stack trace in a report about Claude Code.
 */
function withDb(file, fn, fallback) {
    const open = sqlite();
    if (!open)
        return fallback;
    let db = null;
    try {
        db = open(file);
        return fn(db);
    }
    catch {
        return fallback;
    }
    finally {
        try {
            db?.close();
        }
        catch { /* a handle we cannot close is not a failure of the read */ }
    }
}
/**
 * The repository a conversation happened in.
 *
 * Cursor records no cwd. The workspace database knows, but the mapping is
 * per-workspace and incomplete — `composer.composerData` there holds only the
 * selected and last-focused ids, so a scan of 112 workspace databases would
 * still miss most conversations and cost a second's IO to do it.
 *
 * The conversation carries the answer itself: `originalFileStates` is keyed by
 * absolute `file://` URIs of everything it touched. The longest common prefix
 * of those, walked up to the nearest directory that actually exists, is the
 * checkout. Null when a conversation touched no files, which is honest — a
 * chat that only ever talked has no repository to attribute it to.
 */
export function composerCwd(c) {
    const paths = [];
    for (const uri of Object.keys(c.originalFileStates || {})) {
        if (!uri.startsWith('file://'))
            continue;
        try {
            paths.push(decodeURIComponent(new URL(uri).pathname));
        }
        catch { /* not a URI we can read */ }
    }
    if (!paths.length)
        return null;
    // Resolve each file to its own checkout and take the one that owns the most
    // of them — NOT the common prefix of all of them.
    //
    // The prefix is only the repository when every file happens to sit in one.
    // Touch two checkouts and it climbs to whatever encloses both: here that is
    // `~/git`, which is itself a git repo, so 47 sessions were attributed to it
    // as though "all my repositories" were a project. A session that edited ten
    // files in multisig and one in orchwiz is a multisig session; counting it as
    // neither is worse than counting it as the one it mostly was.
    const votes = new Map();
    for (const p of paths) {
        let dir = p;
        while (dir && dir !== '/' && !existsSync(dir))
            dir = dirname(dir);
        if (!dir || dir === '/')
            continue;
        try {
            if (!statSync(dir).isDirectory())
                dir = dirname(dir);
        }
        catch {
            continue;
        }
        const root = gitRootOf(dir);
        if (root)
            votes.set(root, (votes.get(root) || 0) + 1);
    }
    if (!votes.size)
        return null;
    // Ties broken by the longer path, so a nested checkout beats the parent that
    // contains it — the specific answer rather than the general one.
    return [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
}
/**
 * The checkout a directory belongs to: the nearest ancestor holding `.git`.
 *
 * The common prefix alone is NOT the repository. A conversation that only
 * touched files under one subtree yields that subtree, so the same repo arrived
 * as `multisig`, `multisig/src` and `multisig/src/components/crowdfund` — three
 * unrelated projects in every per-project rate, none of them the repo. One that
 * touched files in two checkouts yields the directory above both, which on this
 * machine was the home directory: 38 sessions attributed to `/Users/…` as if it
 * were a project.
 *
 * Bounded by the home directory, and null rather than a guess when nothing on
 * the way up is a checkout. `worktreeOf` in repo.mts still recovers a Claude
 * Code or Codex worktree from the path; a Cursor worktree is a checkout with
 * its own `.git` and resolves here directly.
 */
function gitRootOf(start) {
    const home = homedir();
    let dir = start;
    let below = start;
    for (let i = 0; i < 40 && dir && dir !== '/' && dir !== home; i++) {
        if (existsSync(join(dir, '.git'))) {
            // Found a repo — but a repo is not automatically a project. `~/git` here
            // is itself a checkout that CONTAINS several dozen unrelated ones, so
            // every file whose own directory tree holds no `.git` walked all the way
            // up into it: 44 sessions spanning at least 8 codebases were filed under
            // a project literally named `git`, the 5th busiest in /qtrends, pooling
            // their rework rates and stealing 322 turns from the projects they came
            // from. The dominant-checkout vote could not fix this, because the vote
            // is taken over what this function returns and every candidate was `~/git`.
            //
            // The question is not "does this directory hold other checkouts" — it is
            // "does THIS repo own this file". Counting child checkouts got that wrong
            // in both directions, because `~/git` and a project that vendors its
            // dependencies look identical from the outside: both are checkouts with
            // several checkouts inside them.
            //
            // `~/git/DW-Apps/DW-gbXML` vendors four clones, so the count said
            // container, and a session in a real repo was relabelled with a
            // subdirectory that has no `.git` at all — reintroducing one level down
            // the exact defect this function was written to remove. It also dropped
            // DW-gbXML out of /qdoctor's fleet baseline while adding a non-repo to
            // it, so a norm computed over "61 of your other repos" was counted over
            // the wrong 61.
            //
            // Git already answers ownership exactly, so ask it rather than guess:
            //
            //   ~/git            tracks 0 files under Mybot, multisig, DW-Apps
            //   DW-Apps/DW-gbXML tracks 37 files under gbxml-viewer
            //
            // A repo that tracks the path owns it. One that holds the path without
            // tracking it is a container, and the useful label for a file beneath it
            // is the child directory it sits in — which keeps `~/git/DW-Apps/apps/…`
            // together instead of dissolving it into "all my repositories".
            if (below !== dir && !repoTracks(dir, below))
                return below;
            return dir;
        }
        below = dir;
        const up = dirname(dir);
        if (up === dir)
            break;
        dir = up;
    }
    // Above the home directory, or nothing with a `.git` on the way. Both mean
    // the same thing to a per-project rate: this conversation cannot be
    // attributed, and saying so beats filing it under `/Users/<name>`.
    return null;
}
// Answers are cached per (repo, path): a corpus scan asks about the same few
// hundred pairs thousands of times, and each answer costs a subprocess.
const tracksCache = new Map();
/**
 * Does the repository at `repo` track anything under `path`?
 *
 * This shells out to git, which is a real cost and worth naming. The plugin has
 * no npm dependencies and this does not add one — git is already required to
 * have produced the repositories being asked about — but it is a subprocess,
 * so it runs only when the walk has actually found a checkout above a
 * subdirectory, and every answer is cached.
 *
 * `ls-files` is the cheap form: it reads the index, not the working tree, and
 * `-- <path>` limits it to one subtree. It does not care whether the files are
 * modified, only whether the repo has them.
 *
 * On any failure — git missing, not a repo, a timeout — this returns TRUE, so
 * the caller keeps the repo it found. That is git's own default answer for a
 * file under a checkout, and it is the conservative direction: the failure mode
 * is a container occasionally keeping its own name, never a real project having
 * its sessions relabelled with a directory that is not a project.
 */
function repoTracks(repo, path) {
    const key = `${repo}\0${path}`;
    const hit = tracksCache.get(key);
    if (hit !== undefined)
        return hit;
    let out = true;
    try {
        const rel = path.startsWith(repo + '/') ? path.slice(repo.length + 1) : path;
        const r = spawnSync('git', ['-C', repo, 'ls-files', '--', rel], {
            encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20,
        });
        // status 0 with empty stdout is the informative case: git understood the
        // question and the answer is "nothing". A non-zero status means it did not
        // understand, which is not evidence of anything.
        if (r.status === 0 && !r.error)
            out = (r.stdout || '').trim().length > 0;
    }
    catch { /* fall through to the conservative answer */ }
    tracksCache.set(key, out);
    return out;
}
/**
 * Every conversation in a Cursor root.
 *
 * `--project` filters on the resolved repository path, which means every
 * composer has to be parsed to answer it. That is ~25 MB of JSON here and about
 * a second; the alternative is filtering on a name the user never sees.
 */
export function listCursorSessions(root, projectFilter) {
    const db = cursorDb(root);
    if (!db)
        return [];
    return withDb(db, (h) => {
        const rows = h.prepare("select key, value from cursorDiskKV where key like 'composerData:%'").all();
        const out = [];
        for (const r of rows) {
            let c;
            // `JSON.parse` succeeding is not the same as getting an object: some rows
            // hold the literal `null`, and reading a field off that throws a
            // TypeError the `catch` above does not cover — it is not a parse error.
            // Inside withDb's try, that one row took down the whole listing and
            // returned zero Cursor sessions with no error anywhere. Same shape as the
            // readdir/stat race codex.mts guards against, one layer up.
            try {
                c = JSON.parse(r.value);
            }
            catch {
                continue;
            }
            if (!c || typeof c !== 'object')
                continue;
            const id = c.composerId || r.key.slice('composerData:'.length);
            const cwd = composerCwd(c);
            const project = cwd || '';
            if (projectFilter && !project.includes(projectFilter))
                continue;
            // An empty conversation is a composer the user opened and never used.
            // Listing them would put hundreds of zero-turn sessions into every rate.
            if (!(c.fullConversationHeadersOnly || []).length)
                continue;
            out.push({
                harness: 'cursor',
                project,
                file: cursorAddress(db, id),
                size: r.value.length,
                mtime: c.lastUpdatedAt || c.createdAt || 0,
            });
        }
        return out;
    }, []);
}
// Cursor's tool vocabulary, mapped onto Claude Code's. codex.mts does the same:
// the classifiers downstream test membership in sets like WRITE_TOOLS, so a
// name that means the same thing has to spell it the same way or an edit stops
// counting as an edit the moment it came from a different editor.
const TOOL_NAMES = {
    edit_file: 'Edit',
    search_replace: 'Edit',
    apply_patch: 'Edit',
    multiedit: 'Edit',
    edit_notebook: 'NotebookEdit',
    create_file: 'Write',
    write: 'Write',
    delete_file: 'Edit',
    read_file: 'Read',
    read_lints: 'Read',
    run_terminal_cmd: 'Bash',
    run_terminal_command: 'Bash',
    grep: 'Grep',
    grep_search: 'Grep',
    ripgrep_raw_search: 'Grep',
    codebase_search: 'Grep',
    semantic_search: 'Grep',
    semantic_search_full: 'Grep',
    file_search: 'Glob',
    glob_file_search: 'Glob',
    list_dir: 'Glob',
    todo_write: 'TodoWrite',
    web_search: 'WebSearch',
    web_fetch: 'WebFetch',
    fetch_pull_request: 'WebFetch',
    rg: 'Grep',
};
// What is left unmapped after this is 1.3% of calls, and deliberately so:
// `create_plan` and `ask_question` have no Claude Code equivalent to be renamed
// into, and an `mcp_<server>_<tool>` name is already the MCP tool's real
// identity in both harnesses. Inventing a mapping for those would lose
// information rather than align it.
// Cursor versions its tools by suffix — `edit_file` became `edit_file_v2`,
// `run_terminal_cmd` became `run_terminal_command_v2`. The suffix is stripped
// before lookup so a version bump does not silently unmap a tool again.
//
// It already had. A census over all 641 sessions found 47.6% of 66,392 tool
// calls falling through unmapped, almost all of it `_v2`, and the damage was
// not cosmetic: WRITE_TOOLS in runs.mts gates on the mapped name, so 6,854 real
// file edits never reached intentWrite. 274 sessions — one of them with 225
// edits — were reported `delivery: no_intent`, meaning "never tried to write
// anything". Those runs then dropped out of the cost-per-delivered denominator
// while their output tokens stayed in the numerator, which is precisely the
// inflation deliveryState()'s ordering exists to prevent.
const VERSION_SUFFIX = /_v\d+$/;
const toolName = (t) => {
    const raw = (t.name || t.tool || '').trim();
    if (!raw)
        return 'UnknownTool';
    const base = raw.replace(VERSION_SUFFIX, '').toLowerCase();
    return TOOL_NAMES[base] || raw;
};
/**
 * Did this tool call fail?
 *
 * Two independent fields say so and they do not agree. 1120 of the 2959 tool
 * calls here carry no name at all — just `{additionalData:{status:'error'}}` —
 * which is a tool call that failed before Cursor recorded what it was. Read
 * only `status`, and every one of those counts as a success.
 */
const toolErrored = (t) => t.additionalData?.status === 'error' || t.status === 'error' || t.status === 'cancelled';
/** A permission refusal, which is a different thing from a tool that broke. */
const toolDenied = (t) => t.userDecision === 'rejected' || t.userDecision === 'denied';
const parseArgs = (t) => {
    for (const raw of [t.params, t.rawArgs]) {
        if (!raw)
            continue;
        try {
            const o = JSON.parse(raw);
            if (o && typeof o === 'object')
                return o;
        }
        catch { /* Cursor stores these as strings and does not promise JSON */ }
    }
    return {};
};
const textBlock = (text) => ({ type: 'text', text });
/**
 * A conversation, as records extract() understands.
 *
 * Bubbles are fetched by the id order in `fullConversationHeadersOnly` rather
 * than by a `select ... where key like`, because SQLite returns rows in no
 * guaranteed order and the spine attributes every tool call to whichever turn
 * is open when it arrives. Out of order, a session's tools land on the wrong
 * prompt and the per-turn tool counts become fiction.
 */
export async function* cursorRecords(file) {
    const addr = splitCursorAddress(file);
    if (!addr)
        return;
    const { db, composerId } = addr;
    const loaded = withDb(db, (h) => {
        const row = h.prepare('select value from cursorDiskKV where key = ?').get(`composerData:${composerId}`);
        if (!row?.value)
            return null;
        let c;
        try {
            c = JSON.parse(row.value);
        }
        catch {
            return null;
        }
        if (!c || typeof c !== 'object')
            return null;
        const headers = c.fullConversationHeadersOnly || [];
        const stmt = h.prepare('select value from cursorDiskKV where key = ?');
        const bubbles = [];
        for (const head of headers) {
            if (!head?.bubbleId)
                continue;
            const b = stmt.get(`bubbleId:${composerId}:${head.bubbleId}`);
            if (!b?.value)
                continue;
            try {
                bubbles.push(JSON.parse(b.value));
            }
            catch { /* one unreadable bubble is not an unreadable session */ }
        }
        return { c, bubbles };
    }, null);
    if (!loaded)
        return;
    const { c, bubbles } = loaded;
    let seq = 0;
    const cwd = composerCwd(c);
    // Cursor timestamps bubbles as ISO strings but the composer in epoch millis.
    // Every downstream reader does Date.parse on this field, so the fallback has
    // to be a string it can parse — an epoch number silently becomes NaN, which
    // is what poisoned weekStart() when the Codex adapter did the same thing.
    const started = new Date(c.createdAt || Date.now()).toISOString();
    let lastTs = started;
    // sessionId on EVERY record, the way Claude Code writes it.
    //
    // Omitting it was not a missing field, it was a silent merge. extract() only
    // ever reads `sessionId` off a record, so every Cursor session came out with
    // `sessionId: null` — and corpus.mts counts distinct sessions with
    // `new Set(turns.map(t => t._session)).size`. All 640 Cursor sessions were
    // therefore ONE member of that set, and every per-session figure in /qtrends
    // collapsed accordingly: `interrupted` reported 70 sessions where the truth
    // was 107, `correction` 21 against 74. The HTML render then crashed outright
    // on the collision.
    //
    // A uuid is not a substitute: it is per-record, and nothing groups by it.
    const mk = (type, extra = {}) => ({
        type,
        uuid: `${composerId}:${seq++}`,
        sessionId: composerId,
        timestamp: lastTs,
        ...extra,
    });
    // cwd rides on the first record, matching where Claude Code puts it and where
    // doctor.mts and runs.mts both look for it.
    let first = true;
    for (const b of bubbles) {
        if (b.createdAt)
            lastTs = b.createdAt;
        const withCwd = (r) => {
            if (first && cwd) {
                r.cwd = cwd;
                first = false;
            }
            return r;
        };
        if (b.type === 1) {
            const text = String(b.text || '').trim();
            if (!text)
                continue;
            yield withCwd(mk('user', { message: { content: [textBlock(text)] } }));
            continue;
        }
        if (b.type !== 2)
            continue;
        const blocks = [];
        const text = String(b.text || '').trim();
        if (text)
            blocks.push(textBlock(text));
        const t = b.toolFormerData;
        if (t) {
            const id = t.toolCallId || `${composerId}:tool:${seq}`;
            blocks.push({ type: 'tool_use', id, name: toolName(t), input: parseArgs(t) });
        }
        if (!blocks.length)
            continue;
        const tok = b.tokenCount || {};
        // Cursor records a token count on only ~9% of bubbles — the rest are zero,
        // not absent. Emitting usage for those would report a real measurement of
        // zero cost. Omitted instead, so /qcost under-reports Cursor rather than
        // claiming it was free; the coverage table says which harnesses carry
        // token data and which do not.
        const usage = (tok.inputTokens || tok.outputTokens)
            ? { input_tokens: tok.inputTokens || 0, output_tokens: tok.outputTokens || 0 }
            : undefined;
        yield withCwd(mk('assistant', {
            message: {
                model: b.modelInfo?.modelName || undefined,
                content: blocks,
                ...(usage ? { usage } : {}),
            },
        }));
        // The result arrives as a user-role tool_result, the shape the scanners
        // already resolve tool ids against.
        if (t) {
            const id = t.toolCallId || `${composerId}:tool:${seq}`;
            const failed = toolErrored(t) || toolDenied(t);
            yield mk('user', {
                message: {
                    content: [{
                            type: 'tool_result',
                            tool_use_id: id,
                            is_error: failed,
                            content: failed
                                ? (toolDenied(t) ? 'permission denied by user' : String(t.result || 'tool error'))
                                : String(t.result || '').slice(0, 2000),
                        }],
                },
            });
        }
    }
    // How the conversation ended. Cursor says `completed` or `aborted` on the
    // composer and never writes a per-message stop reason, so without this every
    // Cursor run reached terminalState() with no `lastStop` and came out
    // `unknown` — 641 of them, which made `unknown` the single largest terminal
    // state in the ledger and said nothing true about any of them.
    //
    // `completed` becomes end_turn, the same token Claude Code writes for a run
    // that finished talking. `aborted` deliberately sets NO stop reason: that is
    // the absence of a clean ending, and terminalState() already reads an
    // unresolved trailing tool call as abandoned_mid_tool, which is more specific
    // than anything that could be asserted here.
    if (c.status === 'aborted') {
        yield mk('user', { message: { content: [textBlock('[Request interrupted by user]')] } });
    }
    else if (c.status === 'completed') {
        yield mk('assistant', { message: { stop_reason: 'end_turn' } });
    }
}
