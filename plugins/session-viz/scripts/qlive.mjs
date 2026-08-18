#!/usr/bin/env node
// /qlive — optional live session reporting to your workspace console.
//
// -- Opt-in, and off by default ---------------------------------------------
// Nothing here runs unless it was switched on for this session, by name, with
// an explicit --yes. That is the same posture as /qshare: this machine does not
// send anything a person did not ask it to send.
//
// -- The trailing turn is never sent ----------------------------------------
// This is the correctness rule the whole design turns on.
//
// extract closes the turn in progress at the end of its record loop, so
// `extract.mjs --json` ALWAYS emits the last turn as a fully formed row: an end
// time, a duration, finalised tool calls, a score. It looks finished because
// the extractor finished with it, not because the person did.
//
// Sending that would freeze a turn mid-thought — which is precisely what
// /qcontrib's warm-session rule refuses: "a session still being typed into
// would be frozen as zombie or abandoned_mid_tool and stay that way in the
// shared numbers forever." So the trailing turn is dropped from every run and
// reported only as a count. The cloud key is last-write-wins, so a turn that is
// later re-sent with better information corrects rather than duplicating.
//
// -- What leaves the machine ------------------------------------------------
// Turn shape, not turn content: index, timings, tool-call count, output tokens,
// friction kinds. No prompt text, no assistant text, no tool inputs, no file
// paths. The repo name goes (a colleague needs to know which repo) and the
// route to it does not.
import { loadLiveState, saveLiveState } from './home.mjs';
export const SCHEMA_VERSION = '1';
/** Reporting lapses on its own. An opt-in that never expires becomes an opt-in
 *  somebody forgot about, which is not consent by the time it matters. */
export const DEFAULT_TTL_HOURS = 12;
const basename = (p) => p.replace(/\/+$/, '').replace(/^.*\//, '') || p;
/**
 * Build the payload for a spine.
 *
 * `sentUpTo` is the highest turn index already reported; only turns after it
 * are included. The trailing turn is dropped regardless — see the header.
 */
export function livePayload(spine, sentUpTo = -1) {
    const sessionId = spine.sessionId;
    if (!sessionId)
        return null;
    const all = spine.turns || [];
    // The drop. Everything else here is bookkeeping; this line is the rule.
    const closed = all.slice(0, Math.max(0, all.length - 1));
    const fresh = closed.filter((t) => t.index > sentUpTo);
    return {
        sessionId,
        repo: spine.cwd ? basename(spine.cwd) : null,
        branch: spine.gitBranch || null,
        harness: spine.harness || null,
        turns: fresh.map((t) => ({
            index: t.index,
            startedAt: t.startedAt || null,
            endedAt: t.endedAt || null,
            durationMs: Math.max(0, Number(t.durationMs) || 0),
            toolCallCount: Math.max(0, Number(t.toolCallCount) || 0),
            outputTokens: Math.max(0, Number(t.tokens?.output) || 0),
            friction: Array.isArray(t.friction) ? t.friction.slice(0, 8).map(String) : [],
        })),
        // What is deliberately not being sent, stated as a number so the console
        // can say "1 turn in progress" without pretending to know anything about it.
        openTurns: all.length - closed.length,
    };
}
export function loadLive() {
    const s = loadLiveState();
    if (!s || s.schema_version !== SCHEMA_VERSION || typeof s.on !== 'object' || !s.on)
        return { schema_version: SCHEMA_VERSION, on: {} };
    return s;
}
/** Enabled and unexpired. Expiry is checked on read, so a lapsed opt-in stops
 *  reporting without anything having to run to clean it up. */
export function isOn(state, sessionId, now = Date.now()) {
    const rec = state.on[sessionId];
    if (!rec)
        return false;
    return new Date(rec.expires).getTime() > now;
}
export function enable(sessionId, ttlHours = DEFAULT_TTL_HOURS, now = Date.now()) {
    const s = loadLive();
    s.on[sessionId] = {
        since: new Date(now).toISOString(),
        expires: new Date(now + ttlHours * 3600_000).toISOString(),
    };
    // Drop lapsed records on the way past, so the file does not grow forever.
    for (const [k, v] of Object.entries(s.on))
        if (new Date(v.expires).getTime() <= now)
            delete s.on[k];
    saveLiveState(s);
    return s;
}
export function disable(sessionId) {
    const s = loadLive();
    delete s.on[sessionId];
    saveLiveState(s);
    return s;
}
/** Exactly what would leave the machine, for printing before it does. */
export function disclose(p) {
    const L = [];
    L.push(`session   ${p.sessionId}`);
    L.push(`repo      ${p.repo ?? '(none)'}${p.branch ? ` on ${p.branch}` : ''}`);
    L.push(`harness   ${p.harness ?? '(unknown)'}`);
    L.push(`turns     ${p.turns.length} finished turn(s); ${p.openTurns} still open and NOT sent`);
    L.push('fields    index, start, end, duration, tool-call count, output tokens, friction kinds');
    L.push('not sent  prompt text, assistant text, tool inputs, file paths, absolute paths');
    return L;
}
