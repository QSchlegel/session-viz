// Codex transcripts, normalised into the records extract.mts already knows how
// to read.
//
// The two harnesses disagree about almost everything except that a transcript is
// one JSON object per line. Codex writes `{timestamp, type, payload}` and splits
// every session into two parallel streams that mirror each other: `event_msg` is
// what the client rendered, `response_item` is what was sent to the API. 97% of
// assistant prose appears in both. Reading both doubles every assistant counter,
// so this file picks the event stream and falls back to the history stream only
// where the event is missing.
//
// Everything here exists to make one promise to extract(): a record with a
// `uuid` and a `timestamp`, and a `type` that either means what Claude Code
// means by it or means nothing at all. Nothing partially-mapped, because the
// spine reads `uuid` and `timestamp` without a guard and a half-shaped record
// surfaces as NaN in a duration rather than as an error anyone can act on.
import { createReadStream, closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
// ---------------------------------------------------------------- identifying
const ROLLOUT = /^rollout-.*\.jsonl$/;
// `session_meta` is always the first record and its payload is large, but the
// three top-level keys come first, so the marker lands inside the first KB.
const META_SNIFF = /"type"\s*:\s*"session_meta"/;
const SNIFF_BYTES = 4096;
/**
 * Is this file a Codex rollout?
 *
 * Name first, because it is free and correct for every file that came from
 * listSessions(). The sniff is for the other path: `extract <path>` accepts any
 * file, and a rollout copied off another machine or renamed still has to parse
 * as Codex rather than as an empty Claude Code session — which is what it looks
 * like, silently, if this guesses wrong.
 */
export function isCodexTranscript(file) {
    if (ROLLOUT.test(basename(file)))
        return true;
    let fd = -1;
    try {
        fd = openSync(file, 'r');
        const buf = Buffer.alloc(SNIFF_BYTES);
        const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
        return META_SNIFF.test(buf.toString('utf8', 0, n));
    }
    catch {
        return false;
    }
    finally {
        if (fd >= 0) {
            try {
                closeSync(fd);
            }
            catch {
                // a descriptor we cannot close is not a reason to fail a predicate
            }
        }
    }
}
/**
 * The label that stands in for a project when nothing better is known.
 *
 * Claude Code puts one directory per project directly under its root, so the
 * transcript's parent directory names the project. Codex nests YYYY/MM/DD, and
 * the parent's basename is a day number: twelve unrelated projects a year all
 * called "14". Root-relative keeps it unique and obviously opaque, which is the
 * honest thing for a value whose only jobs are the --project prefilter and a
 * fallback label behind cwd.
 */
export function codexProject(file, root) {
    const dir = file.replace(/\/[^/]+$/, '');
    if (root) {
        const prefix = root.endsWith('/') ? root : root + '/';
        if (dir.startsWith(prefix))
            return dir.slice(prefix.length);
        if (dir === root)
            return '';
    }
    return basename(dir);
}
// ---------------------------------------------------------------- discovery
const MAX_DEPTH = 6; // YYYY/MM/DD is three; the rest is slack for a reorganised tree
/**
 * Every rollout under a Codex root.
 *
 * Recursive, unlike the Claude Code scan, because the date tree puts transcripts
 * three levels down: a fixed two-level readdir over ~/.codex/sessions returns
 * ['2026'] and reports success having found nothing.
 *
 * statSync is inside the try here. The Claude Code scan leaves it outside, where
 * a file deleted between readdir and stat takes the whole listing down; with two
 * roots that would also take the other harness's sessions with it.
 */
export function listCodexSessions(root, projectFilter) {
    const out = [];
    const walk = (dir, depth) => {
        if (depth > MAX_DEPTH)
            return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory()) {
                walk(full, depth + 1);
                continue;
            }
            if (!ROLLOUT.test(e.name))
                continue;
            // The filter matches a date path here, so `--project some-repo` excludes
            // every Codex session. That is the truthful answer: which repo a rollout
            // belongs to is inside the file, not in its path.
            const project = codexProject(full, root);
            if (projectFilter && !project.includes(projectFilter))
                continue;
            try {
                const st = statSync(full);
                out.push({ harness: 'codex', project, file: full, size: st.size, mtime: st.mtimeMs });
            }
            catch {
                continue;
            }
        }
    };
    walk(root, 0);
    return out;
}
// ---------------------------------------------------------------- text guards
// The desktop and VS Code clients wrap what the user typed in a block of editor
// state. Left in, the prompt text is a wall of open-tab paths: `hasFileRef` is
// true for every turn because the tab list names package.json, `terse` never
// fires, and repeat detection compares preambles instead of requests.
//
// Two headers, not one. The file-attachment variant carries the same `## My
// request for Codex:` marker under `# Files mentioned by the user:` and arrives
// with a leading newline, which also defeats a `^#` anchor — so it survived
// unstripped and the whole wrapper became the turn text: a five-word request
// measured as 21 words and 149 characters, `terse` read false, and the -10
// deduction for a very short prompt with no prior context never applied.
const IDE_CONTEXT = /^\s*#\s*(Context from my IDE setup|Files mentioned by the user):/;
// `for Codex` is optional: the corpus carries 2063 of the long form and 4 of the
// bare `## My request:`. Anchoring on the long one left those four measured as
// their own wrapper — 214 characters of clipboard path scoring 72.
const REQUEST_MARKER = /\n##\s*My request(?: for Codex)?:[ \t]*\n?/;
// `event_msg/user_message` is the one record type no injected shape produces, so
// this should never fire. It is here because the cost of being wrong is not a
// wrong number: a phantom human turn inherits the friction of whatever real turn
// was open, and it inherits it in every metric downstream at once.
const INJECTED_PROMPT = /^\s*(<(environment_context|user_instructions|turn_aborted|image|app-context|collaboration_mode|permissions|recommended_plugins|multi_agent_mode|automation_context)\b|#+\s*AGENTS\.md instructions|Warning: apply_patch was requested)/;
const MAX_TOOL_CHARS = 20000; // matches extract's own import-scan ceiling
const MAX_PATCH_FILES = 40;
const str = (v) => (typeof v === 'string' ? v : '');
/**
 * One cumulative counter, or the value it last held.
 *
 * Absent is not zero. A field that goes missing from one snapshot and returns
 * in the next would otherwise fall to 0 and climb back, and usageDelta() would
 * difference the climb as a fresh delta — counting the same tokens twice, so a
 * field going optional in a future CLI silently doubles that column. No rollout
 * on this machine does it today; every one of the 436 reconciles per field.
 */
const keep = (v, prev) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : prev;
/**
 * A timestamp the rest of the pipeline can do arithmetic on, or ''.
 *
 * Non-empty is not the same as parseable, and the spine reads `timestamp`
 * without a guard: a bad one becomes a turn's startedAt and reaches corpus.mts's
 * weekStart(), where `new Date(bad).toISOString()` throws RangeError from
 * buildTimeline — *after* per-file extraction, so it lands outside the try that
 * fills `meta.failures` and one malformed record in one rollout produces zero
 * output for the entire corpus.
 */
const clock = (v) => {
    const s = str(v);
    return s && Number.isFinite(Date.parse(s)) ? s : '';
};
/** Codex's current shell tool takes `cmd`; the older one takes `command`.
 *  Reading only one of the two loses ~96% of shell invocations. */
const cmdOf = (v) => {
    if (typeof v === 'string')
        return v;
    if (Array.isArray(v))
        return v.filter((x) => typeof x === 'string').join(' ');
    return '';
};
// ---------------------------------------------------------------- tool naming
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
/**
 * One block per file the patch touches, not one per apply_patch call.
 *
 * Claude Code counts an Edit per file, so a Codex patch spanning three files has
 * to be three calls or the two harnesses are counting different things under the
 * same name. It also gives harvestTool a real path per file: collapsed to one
 * block, every file after the first is invisible to the artifact graph.
 */
function patchBlocks(patch) {
    const out = [];
    let op = '';
    let path = '';
    let added = [];
    const flush = () => {
        if (!path)
            return;
        out.push({
            name: op === 'Add' ? 'Write' : 'Edit',
            input: { file_path: path, content: added.join('\n').slice(0, MAX_TOOL_CHARS) },
        });
        op = '';
        path = '';
        added = [];
    };
    for (const line of patch.split('\n')) {
        const m = line.match(PATCH_FILE);
        if (m) {
            flush();
            if (out.length >= MAX_PATCH_FILES)
                return out;
            op = m[1];
            path = m[2].trim();
            continue;
        }
        if (line.startsWith('*** ')) {
            flush();
            continue;
        }
        // Added lines only: context lines are already in the repo, so scanning them
        // for imports credits a file with packages it did not gain.
        if (path && line.startsWith('+'))
            added.push(line.slice(1));
    }
    flush();
    return out.length ? out : [{ name: 'Edit', input: {} }];
}
/**
 * Codex tool names mapped onto Claude Code's where the tools are the same thing.
 *
 * Not cosmetic: harvestTool reaches harvestBash only through the literal name
 * `Bash`, and harvests paths only from `file_path`/`path`. Left as
 * `exec_command` with a `cmd` argument, every Codex session harvests an empty
 * artifact set and contributes nothing to the knowledge graph. Tools with no
 * Claude Code counterpart keep their own names rather than being forced into a
 * near-miss.
 */
function functionCallBlocks(name, argsRaw) {
    let a = {};
    try {
        // Model-controlled text that happens to parse cleanly in every one of the
        // 57,937 records seen — which is exactly why it is wrapped.
        const parsed = JSON.parse(str(argsRaw) || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            a = parsed;
    }
    catch {
        a = {};
    }
    switch (name) {
        case 'exec_command':
        case 'shell_command':
        case 'local_shell_call':
            return [{ name: 'Bash', input: { command: cmdOf(a['cmd'] ?? a['command']) } }];
        case 'view_image':
            return [{ name: 'Read', input: { file_path: a['path'] } }];
        default:
            return [{ name, input: {} }];
    }
}
function customCallBlocks(name, input) {
    const body = str(input);
    if (name === 'apply_patch')
        return patchBlocks(body);
    // The `exec` wrapper's input is JavaScript calling the real tool. Naming it
    // accurately is not worth a second parser for 48 records corpus-wide; the body
    // still goes through the import scan.
    return [{ name, input: { content: body.slice(0, MAX_TOOL_CHARS) } }];
}
// ---------------------------------------------------------------- records
const SESSION_ID_IN_NAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
// Four times the largest line in either corpus on this machine — 7.7 MB across
// 2.03 GB of rollouts — and far below V8's 536,870,888-character string cap.
const MAX_LINE_CHARS = 32 * 1024 * 1024;
// The hold below only has to span the distance from an assistant record to the
// token_count reporting its cost. Replaying that discipline over all 436
// rollouts, the deepest it ever reaches is 10 — so this is a stop for a file
// that never sends one, not a working limit.
const MAX_HELD = 1000;
/**
 * The file's lines, without readline.
 *
 * readline accumulates a line into a single JS string, so one line past V8's
 * cap throws `RangeError: Invalid string length` from its stream `ondata`
 * handler — outside the async iterator's promise chain, which means
 * `try { await extract(f) } catch {}` never sees it. corpus.mts's per-file
 * `failures` collection cannot contain it either: the process dies with exit 1
 * and one corrupt or concatenated rollout destroys the whole /qpact run along
 * with every good session in it.
 *
 * Splitting the chunks here keeps every failure inside the loop, and the cap
 * turns an impossible line into one dropped record. IO errors still propagate,
 * because an unreadable file is a fact the caller needs.
 */
async function* readLines(file) {
    const stream = createReadStream(file, { encoding: 'utf8' });
    let held = '';
    // True while the tail of an over-long line is still going past.
    let dropping = false;
    for await (const chunk of stream) {
        let from = 0;
        for (;;) {
            const nl = chunk.indexOf('\n', from);
            if (nl === -1)
                break;
            if (dropping)
                dropping = false;
            else {
                const line = held + chunk.slice(from, nl);
                yield line.endsWith('\r') ? line.slice(0, -1) : line;
            }
            held = '';
            from = nl + 1;
        }
        if (dropping)
            continue;
        held += chunk.slice(from);
        if (held.length > MAX_LINE_CHARS) {
            held = '';
            dropping = true;
        }
    }
    if (!dropping && held)
        yield held;
}
/**
 * Stream one Codex rollout as records extract.mts can read.
 *
 * Malformed content never escapes: a torn final line, a line too long for a JS
 * string, an unparseable timestamp, a missing session_meta and an empty file
 * each degrade to fewer records rather than to an exception. IO
 * errors are deliberately *not* swallowed — an unreadable file is a fact the
 * caller needs, and corpus.mts already collects it into `failures`, where
 * silently returning an empty session would instead be counted as a real
 * transcript that happened to contain no human.
 */
export async function* codexRecords(file) {
    let seq = 0;
    let sid = basename(file).match(SESSION_ID_IN_NAME)?.[1] || basename(file).replace(/\.jsonl$/, '');
    let sawMeta = false;
    // Sub-agent and `codex exec` rollouts are real sessions with no human in them.
    // Their opening record reads like a prompt; counted as one, they add turns
    // nobody typed and pull the corpus's friction toward a judge's verdict. Set
    // once, from session_meta, because it is a property of the whole rollout.
    let noHuman = false;
    // Whether anyone has typed in this rollout yet. Read only by the auto-review
    // guard below, which needs to distinguish "this rollout is a review run" from
    // "a review ran inside a session that has a person in it".
    let sawHuman = false;
    let model = '';
    let effort = '';
    let lastTs = '';
    let cum = null;
    // task_started precedes the user_message it belongs to, so the first message
    // inside a task is the turn itself and only later ones are steering.
    let taskOpen = false;
    let taskHumans = 0;
    let lastAgentText = null;
    // Records not yet yielded. buf[0], when present, is an assistant record still
    // waiting for the token_count that reports what it cost; the rest are held
    // only so the stream stays in document order. Order matters because the spine
    // attributes everything to whichever turn is open when it arrives.
    let buf = [];
    // Released by swapping the array out, never by shift()ing it empty: shift() is
    // O(n), so a rollout that parks one assistant record and then queues a long
    // run of neutrals behind it degraded from linear to quadratic — 25s at 200k
    // records, 114s at 400k, and a 1M-record file that never finished at all.
    const flush = () => {
        const held = buf;
        buf = [];
        return held;
    };
    const mk = (ts, type, extra = {}) => ({
        type,
        uuid: `${sid}:${seq++}`,
        timestamp: ts,
        ...extra,
    });
    // A record that exists only so `records`, `startedAt` and `endedAt` keep
    // meaning "lines in this file" rather than "lines this adapter understood".
    // No case in the spine's switch matches, so it mutates nothing else.
    const neutral = (ts, extra = {}) => mk(ts, 'codex-event', extra);
    const assistant = (ts, content) => mk(ts, 'assistant', { message: { model: model || undefined, content }, effort: effort || undefined });
    const textBlock = (text) => ({ type: 'text', text });
    const toolBlock = (b) => ({ type: 'tool_use', name: b.name, input: b.input });
    /**
     * TOKEN ATTRIBUTION.
     *
     * Codex reports `total_token_usage` as a running total for the whole session
     * and `last_token_usage` as the per-request delta — and then re-emits the same
     * token_count event two or three times per request, the multiplicity varying
     * with the CLI version. Summing `last_token_usage`, which is the obvious
     * reading and the one addUsage()'s `+=` invites, overcounts by a median of
     * exactly 2.0x and by up to 3.1x. `last_token_usage` is also degenerate in
     * 1,011 events, carrying a populated total over a zeroed breakdown.
     *
     * So: difference the cumulative snapshot instead, and emit the difference.
     * Re-emissions collapse to a delta of zero and disappear, no version sniffing
     * required, and the session total lands on the final snapshot exactly.
     * Verified against the rollouts on this machine: the deltas sum to the final
     * cumulative value on every file that carries token data, with no negatives.
     *
     * The delta is then re-expressed in Claude Code's disjoint fields, because
     * that is what addUsage() adds up: Codex's `input_tokens` *contains*
     * `cached_input_tokens`, so passing it through unchanged counts every cache
     * hit twice. `reasoning_output_tokens` is likewise a subset of
     * `output_tokens`; there is no reasoning slot in TokenTotals, and folding it
     * into `output` is the only mapping that keeps `wastedTokens` — which reads
     * `tokens.output` — measuring the same thing for both harnesses.
     */
    const usageDelta = (info) => {
        const t = info?.total_token_usage;
        if (!t || typeof t !== 'object')
            return null;
        const prev = cum || [0, 0, 0, 0];
        const now = [
            keep(t.input_tokens, prev[0]),
            keep(t.cached_input_tokens, prev[1]),
            keep(t.cache_write_input_tokens, prev[2]),
            keep(t.output_tokens, prev[3]),
        ];
        cum = now;
        // Clamped rather than trusted. The counter has never been observed to go
        // backwards, but a resumed or rewritten session that reset it would
        // otherwise subtract a whole session's tokens from the open turn.
        const din = Math.max(0, now[0] - prev[0]);
        const dcache = Math.max(0, now[1] - prev[1]);
        const dwrite = Math.max(0, now[2] - prev[2]);
        const dout = Math.max(0, now[3] - prev[3]);
        if (!din && !dcache && !dwrite && !dout)
            return null;
        return {
            input_tokens: Math.max(0, din - dcache - dwrite),
            output_tokens: dout,
            cache_read_input_tokens: dcache,
            cache_creation_input_tokens: dwrite,
        };
    };
    for await (const line of readLines(file)) {
        if (!line.trim())
            continue;
        let raw;
        try {
            raw = JSON.parse(line);
        }
        catch {
            continue; // tolerate a torn final line on a live session
        }
        const out = [];
        let usage = null;
        try {
            // Not `str(raw.timestamp)`: a non-empty but unparseable clock passed that
            // guard, became a turn's startedAt, and crashed the whole corpus build in
            // weekStart(). Falling back to the last good one keeps the record; only a
            // record with no usable clock anywhere is unattributable.
            const ts = clock(raw.timestamp) || lastTs;
            if (!ts)
                continue;
            lastTs = ts;
            const p = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
            const kind = str(raw.type);
            const pt = str(p.type);
            if (kind === 'session_meta') {
                sawMeta = true;
                // `id` and `session_id` differ for sub-agents, where `session_id` names
                // the parent thread. Keying on it merges a rollout into its parent.
                if (str(p.id))
                    sid = str(p.id);
                const src = p.source;
                noHuman =
                    str(p.thread_source) === 'subagent' ||
                        !!str(p.parent_thread_id) ||
                        (!!src && typeof src === 'object' && 'subagent' in src) ||
                        // `codex exec` is the non-interactive entry point: the prompt is
                        // whatever a script or a control surface passed on the command line.
                        // All 19 exec rollouts here are machinery — runtime health probes
                        // ("Reply with exactly OK"), app-context persona injections whose
                        // 1.5 KB of Scope/Constraint/Response-format markup scores +10 for
                        // "stated what done looks like" and +6 for "named a concrete file"
                        // off the markup rather than off anything a person wrote, and a
                        // title-generation sub-agent. Every one is a single-turn session, so
                        // corpus.mts's zero-turn filter never sees them: unguarded, all 19
                        // enter the corpus as fabricated `clean` members.
                        str(src) === 'exec' ||
                        str(p.originator) === 'codex_exec';
                out.push(mk(ts, 'session_meta', {
                    sessionId: sid,
                    cwd: str(p.cwd) || undefined,
                    gitBranch: str(p.git?.branch) || undefined,
                    version: str(p.cli_version) || undefined,
                }));
            }
            else if (kind === 'turn_context') {
                // The only place a model name ever appears — session_meta has no `model`
                // field in any rollout on this machine. It can change mid-session, so it
                // is tracked rather than read once.
                const m = str(p.model);
                const review = m === 'codex-auto-review';
                // This identifies an auto-review *rollout*, which is why it only counts
                // before anyone has typed. turn_context records recur throughout a file
                // and carry the current model, so setting an unconditional flag here
                // latched: every later event_msg/user_message became a `codex-event`
                // neutral for the rest of the rollout, and because neutrals still count
                // as records the session reported a plausible size with two real typed
                // prompts silently missing from it. Once a person has typed, the rollout
                // has a human in it and no later turn can retract that.
                if (review && !sawHuman)
                    noHuman = true;
                // `model` is tracked forward as well, so adopting a review pass's name
                // relabels every assistant record after it — 22 of 22 in the case that
                // surfaced this.
                if (m && !review)
                    model = m;
                if (str(p.effort))
                    effort = str(p.effort);
                out.push(neutral(ts, { cwd: str(p.cwd) || undefined }));
            }
            else if (kind === 'event_msg' && pt === 'token_count') {
                usage = usageDelta(p.info);
                out.push(neutral(ts));
            }
            else if (kind === 'event_msg' && pt === 'user_message') {
                let text = str(p.message);
                if (IDE_CONTEXT.test(text)) {
                    const m = text.match(REQUEST_MARKER);
                    if (m && m.index !== undefined)
                        text = text.slice(m.index + m[0].length);
                }
                text = text.trim();
                const hasImage = (Array.isArray(p.images) && p.images.length > 0) ||
                    (Array.isArray(p.local_images) && p.local_images.length > 0);
                if (noHuman || INJECTED_PROMPT.test(text) || (!text && !hasImage)) {
                    out.push(neutral(ts));
                }
                else {
                    const content = [];
                    if (text)
                        content.push(textBlock(text));
                    if (hasImage)
                        content.push({ type: 'image' });
                    sawHuman = true;
                    const steering = taskOpen && taskHumans > 0;
                    taskHumans++;
                    // Codex has no queued_command record, so steering is inferred from
                    // position: a message that arrived while a task was already running.
                    // Rollouts from CLIs older than 0.100 carry no task events at all and
                    // report zero steering turns rather than a guess.
                    out.push(steering
                        ? mk(ts, 'attachment', {
                            attachment: { type: 'queued_command', prompt: content, source_uuid: `${sid}:${seq}` },
                        })
                        : mk(ts, 'user', { message: { content } }));
                }
            }
            else if (kind === 'event_msg' && pt === 'agent_message') {
                const text = str(p.message);
                lastAgentText = text;
                out.push(assistant(ts, [textBlock(text)]));
            }
            else if (kind === 'response_item' && pt === 'message') {
                // The history stream's mirror of what the event stream already reported.
                // Emitting both doubles every assistant counter, so it is emitted only
                // when it is not a repeat — which is also what recovers assistant prose
                // in the rollouts that carry no agent_message events at all.
                const role = str(p.role);
                const text = Array.isArray(p.content)
                    ? p.content
                        .filter((b) => b && typeof b === 'object' && str(b.type).endsWith('_text'))
                        .map((b) => str(b.text))
                        .join('\n')
                    : '';
                if (role === 'assistant' && text && text !== lastAgentText) {
                    lastAgentText = text;
                    out.push(assistant(ts, [textBlock(text)]));
                }
                else {
                    // role `user` here is machinery two times in three: AGENTS.md, the
                    // environment block, IDE state, interrupt notices. Only the event
                    // stream witnesses a person typing, so this branch never opens a turn.
                    if (role === 'assistant')
                        lastAgentText = null;
                    out.push(neutral(ts));
                }
            }
            else if (kind === 'response_item' && (pt === 'function_call' || pt === 'custom_tool_call')) {
                const name = str(p.name) || pt;
                const blocks = pt === 'function_call' ? functionCallBlocks(name, p.arguments) : customCallBlocks(name, p.input);
                out.push(assistant(ts, blocks.map(toolBlock)));
            }
            else if (kind === 'response_item' && pt === 'web_search_call') {
                out.push(assistant(ts, [toolBlock({ name: 'WebSearch', input: {} })]));
            }
            else if (kind === 'event_msg' && pt === 'mcp_tool_call_end') {
                // No top-level `name` on this one; harvestTool keys the MCP server off
                // the `mcp__server__tool` shape, so it is rebuilt here.
                const server = str(p.invocation?.server) || 'unknown';
                const tool = str(p.invocation?.tool) || 'call';
                out.push(assistant(ts, [toolBlock({ name: `mcp__${server}__${tool}`, input: {} })]));
            }
            else if (kind === 'event_msg' && pt === 'turn_aborted') {
                taskOpen = false;
                // Phrased the way classifyUser recognises an interrupt, so the spine
                // records it against the open turn instead of opening a new one.
                out.push(mk(ts, 'user', { message: { content: [textBlock('[Request interrupted by user]')] } }));
            }
            else if (kind === 'event_msg' && pt === 'context_compacted') {
                // A marker, never the payload. The sibling `compacted` record carries
                // `replacement_history` — a full synthetic conversation that anything
                // walking it would re-ingest as fresh turns.
                out.push(mk(ts, 'user', { message: { content: [textBlock('<summary>context compacted</summary>')] } }));
            }
            else {
                if (kind === 'event_msg' && pt === 'task_started') {
                    taskOpen = true;
                    taskHumans = 0;
                }
                if (kind === 'event_msg' && pt === 'task_complete')
                    taskOpen = false;
                out.push(neutral(ts));
            }
        }
        catch {
            // A shape nobody anticipated costs us a record, not the corpus.
            out.length = 0;
            usage = null;
        }
        // Attach the cost to the model output that incurred it, then release
        // everything held behind it.
        if (usage) {
            if (buf.length) {
                buf[0].message = { ...buf[0].message, usage };
            }
            else {
                // A delta with nothing to attribute it to: rare, but the tokens are real
                // and dropping them would understate the session.
                out.unshift(mk(lastTs, 'assistant', { message: { model: model || undefined, usage } }));
            }
        }
        for (const rec of out) {
            if (rec.type === 'assistant') {
                for (const held of flush())
                    yield held;
                buf.push(rec);
            }
            else if (rec.type === 'user' || rec.type === 'attachment') {
                for (const held of flush())
                    yield held;
                yield rec;
            }
            else if (buf.length) {
                buf.push(rec);
                // Past the cap the assistant record is released without its cost rather
                // than held for a token_count that is evidently never coming; the
                // tokens still land, on the synthetic carrier above.
                if (buf.length > MAX_HELD)
                    for (const held of flush())
                        yield held;
            }
            else {
                yield rec;
            }
        }
        if (usage)
            for (const held of flush())
                yield held;
    }
    for (const held of flush())
        yield held;
    // A rollout with no session_meta still has to be identifiable: sessionId is
    // first-wins in the spine, so this only lands when nothing else supplied one,
    // and it keeps null out of the id that reports key on. Emitted even when no
    // line parsed — an empty or unreadable rollout used to leave sessionId null,
    // which is the one case the guarantee exists for. The timestamp stays empty
    // rather than invented: the spine only advances startedAt/endedAt for a
    // record that carries one, so a file with no clock keeps no span.
    if (!sawMeta)
        yield mk(lastTs, 'session_meta', { sessionId: sid });
}
