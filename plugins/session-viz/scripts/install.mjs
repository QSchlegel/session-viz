#!/usr/bin/env node
// Install the skills into a harness that is not Claude Code.
//
//   node install.mjs                 # detect the harness and install
//   node install.mjs codex cursor    # install into these, whatever is running
//   node install.mjs --list          # what is installed where, and is it current
//   node install.mjs --uninstall codex
//
// Claude Code needs none of this — `claude plugin install` puts the whole
// plugin in place and sets CLAUDE_PLUGIN_ROOT so the skills can find their
// scripts. Nothing else does either of those things.
//
// The skills are already portable in the one way that matters: Codex and Cursor
// read the same format Claude Code does — a directory holding a SKILL.md with
// `name` and `description` frontmatter. What is NOT portable is the one line in
// each of them that runs the analysis:
//
//     node ${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs
//
// CLAUDE_PLUGIN_ROOT is set by Claude Code and by nothing else, so under any
// other harness that expands to `node /scripts/runs.mjs` and fails on a path
// that was never going to exist. Copying the files is therefore not enough —
// the placeholder has to be resolved on the way in, which is the whole reason
// this file exists rather than a line of documentation telling people to `cp`.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { emitJson } from './out.mjs';
/**
 * Where each harness keeps user-level skills.
 *
 * Claude Code is deliberately absent: `claude plugin install` is a better
 * install than this one — it tracks the marketplace, updates in place, and sets
 * the variable the skills expect. Offering a second, worse path for it would
 * leave two copies of ten skills fighting over the same ten slash commands.
 */
export function targets() {
    const home = homedir();
    const dir = (...p) => join(home, ...p);
    const has = (d) => { try {
        return statSync(dirname(d)).isDirectory();
    }
    catch {
        return false;
    } };
    const codex = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'skills') : dir('.codex', 'skills');
    const cursor = dir('.cursor', 'skills');
    return [
        {
            id: 'codex', label: 'Codex', skills: codex, present: has(codex),
            // Codex reads the same frontmatter but has no equivalent of
            // `disable-model-invocation`, so a skill it can see is a skill it may
            // decide to run on its own. Said out loud rather than papered over: the
            // commands are read-only analyses, but "read-only" is not "expected".
            note: 'Codex has no disable-model-invocation, so it may invoke these itself rather than only on request.',
        },
        {
            id: 'cursor', label: 'Cursor', skills: cursor, present: has(cursor),
            note: 'Cursor has no disable-model-invocation, so it may invoke these itself rather than only on request.',
        },
    ];
}
// ---------------------------------------------------------------- source
/** The plugin root — the directory holding `scripts/` and `skills/`. */
export function pluginRoot() {
    // Resolved from this file's own location rather than from cwd or an env var,
    // because the installer is run from wherever the user happens to be standing
    // and the answer must not depend on that.
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..');
}
const PLACEHOLDER = /\$\{CLAUDE_PLUGIN_ROOT\}/g;
/**
 * A marker naming where a copy came from and when.
 *
 * Written into the file because there is nowhere else to put it: these
 * directories are shared with hand-written skills and skills from other
 * sources, and `--uninstall` must never delete something a person wrote. It
 * removes only what carries this line.
 */
const MARK = '<!-- installed by session-viz';
const stamp = (root) => `${MARK} from ${root} -->`;
/**
 * Copy the skills into a target, resolving the script path on the way.
 *
 * Copy rather than symlink, because the rewrite is the point: a symlinked
 * SKILL.md still says ${CLAUDE_PLUGIN_ROOT} and still fails. The cost is that
 * an update to the plugin does not reach an installed copy until this is run
 * again, which `--list` reports rather than leaving to be discovered.
 */
export function install(target, { dryRun = false } = {}) {
    const root = pluginRoot();
    const src = join(root, 'skills');
    const out = [];
    let names;
    try {
        names = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        throw new Error(`no skills directory at ${src} — is this a complete checkout?`);
    }
    for (const name of names) {
        const from = join(src, name, 'SKILL.md');
        if (!existsSync(from))
            continue;
        const body = readFileSync(from, 'utf8');
        // Every occurrence, not the first: several skills print two or three
        // invocations, and a half-rewritten file fails on whichever line the user
        // happens to try second.
        const resolved = body.replace(PLACEHOLDER, root).trimEnd() + `\n\n${stamp(root)}\n`;
        const dest = join(target.skills, name);
        const file = join(dest, 'SKILL.md');
        const replaced = existsSync(file);
        if (!dryRun) {
            mkdirSync(dest, { recursive: true });
            writeFileSync(file, resolved);
        }
        out.push({ skill: name, path: file, replaced });
    }
    return out;
}
/** Remove only the copies this tool wrote. */
export function uninstall(target) {
    const removed = [];
    let names = [];
    try {
        names = readdirSync(target.skills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        return removed;
    }
    for (const name of names) {
        const file = join(target.skills, name, 'SKILL.md');
        let body;
        try {
            body = readFileSync(file, 'utf8');
        }
        catch {
            continue;
        }
        // The marker is the only thing that authorises a delete here. A skill of
        // the same name that somebody wrote by hand does not carry it and is left
        // exactly where it is.
        if (!body.includes(MARK))
            continue;
        rmSync(join(target.skills, name), { recursive: true, force: true });
        removed.push(name);
    }
    return removed;
}
/** What this tool has installed into a target, and whether it still resolves. */
export function installed(target) {
    const root = pluginRoot();
    const out = [];
    let names = [];
    try {
        names = readdirSync(target.skills, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    }
    catch {
        return out;
    }
    for (const name of names) {
        let body;
        try {
            body = readFileSync(join(target.skills, name, 'SKILL.md'), 'utf8');
        }
        catch {
            continue;
        }
        const m = body.match(/<!-- installed by session-viz from (.+?) -->/);
        if (!m)
            continue;
        const from = m[1];
        out.push({ skill: name, from, current: from === root && existsSync(join(from, 'scripts')) });
    }
    return out;
}
// ---------------------------------------------------------------- cli
const isMain = process.argv[1] && process.argv[1].endsWith('install.mjs');
if (isMain) {
    const argv = process.argv.slice(2);
    const flag = (f) => argv.includes(f);
    const wanted = argv.filter((a) => !a.startsWith('-'));
    const all = targets();
    if (flag('--help') || flag('-h')) {
        console.log(`session-viz — install the skills into another harness

  node install.mjs                    detect what is here and install
  node install.mjs codex cursor       install into these specifically
  node install.mjs --list             what is installed, and whether it is current
  node install.mjs --uninstall codex  remove only what this tool wrote
  node install.mjs --dry-run          say what would be written, write nothing

Claude Code is not a target: 'claude plugin install session-viz@session-viz'
does it better, and two copies of ten skills would compete for ten commands.`);
        process.exit(0);
    }
    const chosen = wanted.length ? all.filter((t) => wanted.includes(t.id)) : all.filter((t) => t.present);
    const unknown = wanted.filter((w) => !all.some((t) => t.id === w));
    if (unknown.length) {
        console.error(`unknown harness: ${unknown.join(', ')}. Known: ${all.map((t) => t.id).join(', ')}`);
        process.exit(1);
    }
    if (flag('--list')) {
        const model = all.map((t) => ({ ...t, installed: installed(t) }));
        if (flag('--json')) {
            await emitJson(model);
            process.exit(0);
        }
        for (const t of model) {
            const state = !t.present ? 'not installed on this machine'
                : t.installed.length ? `${t.installed.length} skills`
                    : 'no session-viz skills';
            console.log(`${t.label.padEnd(8)} ${state}`);
            console.log(`         ${t.skills}`);
            const stale = t.installed.filter((i) => !i.current);
            if (stale.length) {
                console.log(`         ${stale.length} point at a different or missing checkout — re-run install to refresh`);
            }
            console.log();
        }
        process.exit(0);
    }
    if (flag('--uninstall')) {
        for (const t of chosen) {
            const gone = uninstall(t);
            console.log(`${t.label}: removed ${gone.length} skill${gone.length === 1 ? '' : 's'}${gone.length ? ` (${gone.join(', ')})` : ''}`);
        }
        process.exit(0);
    }
    if (!chosen.length) {
        // Nothing detected is a finding, not an error: it is how someone learns the
        // harness they meant to install into is not where this expected it.
        console.error('No supported harness found on this machine. Looked for:');
        for (const t of all)
            console.error(`  ${t.label.padEnd(8)} ${t.skills}`);
        console.error('\nName one explicitly to install anyway: node install.mjs codex');
        process.exit(1);
    }
    const dryRun = flag('--dry-run');
    for (const t of chosen) {
        const written = install(t, { dryRun });
        const fresh = written.filter((w) => !w.replaced).length;
        console.log(`${t.label}: ${dryRun ? 'would write' : 'wrote'} ${written.length} skills to ${t.skills}`);
        console.log(`  ${fresh} new, ${written.length - fresh} replaced`);
        if (t.note)
            console.log(`  note: ${t.note}`);
    }
    console.log(`\nScripts stay in ${pluginRoot()} — the copies point at them rather than duplicating them,`);
    console.log('so re-run this after updating the plugin. Restart the harness before the commands resolve.');
}
