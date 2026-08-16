// Which build produced this report, and whether it is the newest one installed.
//
// Every command here prints numbers that change between versions — not because
// the numbers are unstable, but because the readings get more correct. Between
// 0.7.0 and 0.9.0 the same corpus went from 27.31B cache-read to 31.94B, and
// 274 Cursor sessions went from `delivery: no_intent` — "never tried to write
// anything" — to `wrote_ok`. Both figures were the best available at the time.
// Neither report said which time it was.
//
// So a report states its own version, and says so loudly when the copy that
// produced it is not the newest one on the machine. That second case is the one
// that actually happens: the plugin cache is keyed by version, so an old
// install sits in its own directory and keeps working indefinitely, answering
// with numbers a newer install would not give.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
/** This build's version, from the plugin manifest beside it. */
export function version() {
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const manifest = resolve(here, '..', '.claude-plugin', 'plugin.json');
        const j = JSON.parse(readFileSync(manifest, 'utf8'));
        return j.version || 'unknown';
    }
    catch {
        // A checkout without a manifest is a development run, not a fault.
        return 'unknown';
    }
}
/** True when this copy lives in the plugin cache rather than a git checkout. */
export const installed = () => fileURLToPath(import.meta.url).includes(join('.claude', 'plugins', 'cache'));
const num = (v) => v.split(/[.-]/).map((p) => Number(p) || 0);
/** Compare two versions. Positive when `a` is newer. */
export function cmp(a, b) {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d)
            return d;
    }
    return 0;
}
/**
 * A newer version present in the plugin cache than the one running, or null.
 *
 * Read off the filesystem, not the network: the cache lays installs out as
 * `cache/<marketplace>/<plugin>/<version>/`, so the answer is a directory
 * listing. No request, nothing to be slow or offline, and nothing that could
 * turn a local analysis into a call home.
 *
 * This deliberately does NOT report what the marketplace has — only what is
 * already on this machine. "You installed a newer one and are still running the
 * old one" is a fact. "A newer one exists somewhere" is an upgrade nag, and
 * this tool has no business being one.
 */
export function newerInstalled() {
    const mine = version();
    if (mine === 'unknown')
        return null;
    let best = null;
    const root = join(homedir(), '.claude', 'plugins', 'cache');
    try {
        for (const market of readdirSync(root, { withFileTypes: true })) {
            if (!market.isDirectory())
                continue;
            const plugin = join(root, market.name, 'session-viz');
            let versions;
            try {
                versions = readdirSync(plugin, { withFileTypes: true })
                    .filter((e) => e.isDirectory()).map((e) => e.name);
            }
            catch {
                continue;
            }
            for (const v of versions) {
                if (cmp(v, mine) > 0 && (!best || cmp(v, best) > 0))
                    best = v;
            }
        }
    }
    catch { /* no cache directory: nothing is installed, so nothing is newer */ }
    return best;
}
/**
 * The line every report carries, and the warning when one is warranted.
 *
 * Returned rather than printed so the JSON emitters can carry the same fact as
 * a field. A report whose provenance is only in the human-readable form is a
 * report whose provenance is lost the moment anyone pipes it.
 */
export function versionNote() {
    const v = version();
    const stale = newerInstalled();
    const line = stale
        ? `session-viz ${v} — WARNING: ${stale} is installed on this machine and is not what ran. ` +
            'Restart the harness, or run the newer copy: these commands report different numbers between versions.'
        : `session-viz ${v}${installed() ? '' : ' (source checkout)'}`;
    return { version: v, stale, line };
}
