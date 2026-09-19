#!/usr/bin/env node
// /qrunner — the machine half of the command remote.
//
// -- Read this before anything else ----------------------------------------
// This is the only thing in this product that STARTS work on your computer
// because somebody pressed a button somewhere else. Everything below exists
// to keep that sentence narrow.
//
//   It runs in the foreground, and you start it.       No daemon is installed,
//   nothing survives a reboot, and closing the terminal ends it. A channel you
//   opened is one you can close by not opening it.
//
//   It runs a CLOSED SET of commands.                  Not a prompt. The set is
//   the registry's own `commands.silent` — the commands that open no socket at
//   all — so a remotely triggered run cannot itself send anything anywhere.
//
//   It runs them in repositories you listed.           A run naming a repo this
//   runner was not started with is refused and says so in the ledger.
//
//   One at a time.                                     A queue of five is five
//   sequential runs, so a machine cannot be made to fan out.
//
// -- Why the preflight is not optional -------------------------------------
// A headless run in a repository whose Claude Code permissions do not cover
// Write dies at its first write with no prompt to answer, because there is
// nobody there to answer it. /qdoctor has always known this. The runner checks
// before it spends anything and refuses with that sentence, rather than
// producing a run that looks like it failed for a reason worth investigating.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { hostname } from 'node:os';
import { config, api } from './cloud.mjs';
import { loadDriveState, saveDriveState } from './home.mjs';
export const SCHEMA_VERSION = '1';
export const DISCLOSURE_VERSION = '1';
/** Seconds between asks when the queue is empty. */
export const POLL_SECONDS = 10;
/** A run that has not finished in this long is abandoned and reported failed.
 *  A runner that waits forever on one job stops being a runner. */
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const DISCLOSURE = `
  THE COMMAND RUNNER — what starting this means

  While this is running, anyone who can open your workspace console and press
  a button can cause a Claude Code session to start on THIS COMPUTER, in the
  repositories you list below, without you being asked at the time.

  What can be run: a closed set of commands that open no socket — currently
  qdoctor, qruns, qship and qtrends. Not arbitrary prompts. The set comes from
  the contract, so a command that stops being silent stops being runnable.

  What that still means: a Claude Code session, with your credential, with
  whatever file access your settings give it, writing whatever those commands
  write, and spending your tokens.

  Who can press the button: any member of your workspace. This runner does not
  check who asked — it checks only that the command is in the set and the
  repository is one you named.

  How to stop it: close this process. Nothing is installed, nothing restarts,
  and no run begins after it exits.
`.replace(/^\n/, '');
export function shownRunner(state) {
    return !!state && state.runner?.version === DISCLOSURE_VERSION;
}
export function recordShownRunner(prev) {
    saveDriveState({
        ...(prev || { schema_version: SCHEMA_VERSION }),
        schema_version: SCHEMA_VERSION,
        runner: { at: new Date().toISOString(), version: DISCLOSURE_VERSION },
    });
}
/**
 * Does this repository's Claude Code configuration let a headless run write?
 *
 * Deliberately conservative and deliberately shallow: it reads the settings a
 * run would read and looks for a permission that covers Write. It does not
 * try to model the whole permission system — a wrong "yes" here costs a run
 * that dies halfway, and a wrong "no" costs a refusal somebody can override
 * by fixing their settings, which is the cheaper mistake.
 */
export function coversWrite(dir) {
    for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
        const p = join(dir, rel);
        if (!existsSync(p))
            continue;
        try {
            const j = JSON.parse(readFileSync(p, 'utf8'));
            const mode = j.permissions?.defaultMode;
            if (mode === 'bypassPermissions' || mode === 'acceptEdits')
                return true;
            const allow = j.permissions?.allow || [];
            if (allow.some((a) => /^Write\b/.test(a) || a === 'Write' || /^Edit\b/.test(a)))
                return true;
        }
        catch { /* an unreadable settings file is not a permission */ }
    }
    return false;
}
/** Where this runner will run each named repository. */
export function repoMap(dirs) {
    const m = new Map();
    for (const d of dirs)
        m.set(basename(d).toLowerCase(), d);
    return m;
}
/**
 * Run one command, headlessly, in one directory.
 *
 * `claude -p /<command>` and nothing else on the command line: no
 * --dangerously-skip-permissions, no --allowedTools widening. A runner that
 * granted itself permissions the repository did not would make the preflight
 * above a decoration.
 */
export async function execute(cmd, dir, run = spawnClaude) {
    if (!coversWrite(dir))
        return {
            outcome: 'refused',
            detail: 'permissions in this repo do not cover Write — a headless run dies at its first write with no prompt to answer. Fix with /qdoctor.',
        };
    return await run(cmd, dir);
}
export async function spawnClaude(cmd, dir) {
    return await new Promise((resolve) => {
        const child = spawn('claude', ['-p', `/${cmd}`, '--output-format', 'json'], {
            cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => {
            try {
                child.kill('SIGTERM');
            }
            catch { /* already gone */ }
            resolve({ outcome: 'failed', detail: `no result in ${RUN_TIMEOUT_MS / 60000} minutes; killed` });
        }, RUN_TIMEOUT_MS);
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ outcome: 'failed', detail: `could not start claude: ${e.message}` });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            // The CLI answers an auth failure with exit 0 and is_error in the JSON,
            // which is exactly the shape that turns a broken runner into a silent
            // one. The body decides, not the exit code.
            let parsed = null;
            try {
                parsed = JSON.parse(out);
            }
            catch { /* not JSON; fall through */ }
            if (parsed?.is_error)
                return resolve({
                    outcome: 'failed',
                    detail: String(parsed.result || 'the run reported an error'), exitCode: code ?? undefined,
                });
            if (code !== 0)
                return resolve({
                    outcome: 'failed',
                    detail: (err.trim() || out.trim() || 'no output').slice(0, 400), exitCode: code ?? undefined,
                });
            resolve({ outcome: 'ok', detail: 'completed', exitCode: 0 });
        });
    });
}
const usage = `/qrunner — run allowlisted commands on this machine when the console asks

  qrunner.mjs --name <machine> --repo <dir> [--repo <dir> ...]
  qrunner.mjs --disclose          print what starting this means, and record it
  qrunner.mjs --once              collect and run at most one job, then exit

It runs in the foreground. Closing it stops it; nothing is installed.`;
export async function main(argv) {
    const all = (name) => argv.reduce((acc, v, i) => (v === name && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
    const one = (name) => all(name)[0];
    const has = (name) => argv.includes(name);
    if (has('--help') || has('-h')) {
        console.log(usage);
        return 0;
    }
    const state = loadDriveState();
    if (has('--disclose')) {
        console.log(DISCLOSURE);
        recordShownRunner(state);
        console.log('  Recorded. qrunner can start on this machine from now on.');
        return 0;
    }
    const name = one('--name') || hostname().split('.')[0] || 'machine';
    const dirs = all('--repo');
    if (!dirs.length) {
        console.log(usage);
        return 2;
    }
    const missing = dirs.filter((d) => !existsSync(d));
    if (missing.length) {
        console.log(`no such director${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`);
        return 2;
    }
    if (!shownRunner(state)) {
        console.log(DISCLOSURE);
        console.log('  NOT STARTED — this is the first run on this machine.');
        console.log('  Read the above, then run:  qrunner.mjs --disclose');
        return 0;
    }
    const repos = repoMap(dirs);
    const cfg = config();
    // Said once, at the top, because a person leaving this open should be able
    // to glance at the terminal and see exactly what it is offering.
    console.log(`qrunner ${name} — listening for ${[...repos.keys()].join(', ')}`);
    const pre = [...repos.entries()].filter(([, d]) => !coversWrite(d)).map(([r]) => r);
    if (pre.length)
        console.log(`  WARNING ${pre.join(', ')} — permissions do not cover Write; runs there will be refused`);
    console.log(`  press ctrl-c to stop; nothing is installed and nothing restarts\n`);
    await api(cfg, '/v1/machines', 'POST', { name, repos: [...repos.keys()], version: SCHEMA_VERSION });
    let stop = false;
    process.on('SIGINT', () => { stop = true; console.log('\nstopping — no further run will start'); });
    do {
        let job = null;
        try {
            const got = await api(cfg, '/v1/runs/claim', 'POST', { machine: name });
            job = got?.run || null;
        }
        catch (e) {
            console.log(`could not ask: ${e.message}`);
        }
        if (job) {
            const dir = repos.get(job.repo);
            console.log(`[${new Date().toISOString().slice(11, 19)}] /${job.command} in ${job.repo} — asked by ${job.requestedBy}`);
            const result = dir
                ? await execute(job.command, dir)
                : {
                    outcome: 'refused',
                    detail: `this runner was not started with a repository called ${job.repo}`,
                };
            console.log(`    ${result.outcome}: ${result.detail}`);
            try {
                await api(cfg, '/v1/runs/finish', 'POST', {
                    id: job.id, machine: name, outcome: result.outcome,
                    detail: result.detail, exitCode: result.exitCode,
                });
            }
            catch (e) {
                // The run happened. A ledger that cannot be told is a worse problem
                // than a run that failed, because the console will say "running"
                // forever, so it is said here at least.
                console.log(`    COULD NOT REPORT: ${e.message}`);
            }
            continue;
        }
        if (has('--once')) {
            console.log('nothing queued');
            return 0;
        }
        await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
    } while (!stop);
    return 0;
}
if (process.argv[1] && /qrunner\.mjs$/.test(process.argv[1])) {
    main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
