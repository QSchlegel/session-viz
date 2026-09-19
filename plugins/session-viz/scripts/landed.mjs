// Did the work reach a commit? — the top rung of the ladder.
//
// docs/product-scope-and-gaps.md has carried "define an explicit
// expected-evidence contract and implement the git commit probe against it" as
// an open item since it was written, under a section that says plainly no
// commit probe exists. This is that probe, at its smallest honest size.
//
// -- What it looks at ------------------------------------------------------
// `git log` in the session's own working directory, bounded by the session's
// own window, with the changed paths of each commit intersected against the
// files the transcript says the session wrote. Nothing else. No network, no
// remote, no `gh`.
//
// -- What never leaves -----------------------------------------------------
// No SHA, no commit message, no author, no path. The probe answers with a
// state and three counts. A SHA is a key into a repository and a message is
// prose somebody wrote; neither is needed to say whether the work landed, and
// both would be new content in a spine built to be forwarded.
//
// -- What it refuses to claim ----------------------------------------------
// A commit is not a merge, not a push, not a review and not a deploy. The rung
// is called `committed` for that reason: it is what this can witness. The
// enum's own name says `landed` only at the org level, where the question is
// asked of a population rather than of one change.
//
// -- Why absence is not failure --------------------------------------------
// `unavailable` exists for the same reason the artifact probe has it. Not a
// repository, no git on the machine, a shallow or bare checkout, a container
// whose filesystem this process cannot see: each is a reason the probe could
// not look, and reporting those as "nothing landed" would be the probe lying
// about work it never examined.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, resolve, relative } from 'node:path';
const NOT_PROBED = { state: 'unavailable', commits: 0, overlap: 0, unrelated: 0, repos: 0, why: 'not probed' };
/**
 * How long after a session ends a commit still counts as its work.
 *
 * Committing is the thing people do immediately after the model stops, often
 * in another terminal, which is outside the transcript entirely. A window of
 * zero would score that as `none` and teach the opposite of the lesson. Thirty
 * minutes is long enough for the ordinary case and short enough that the next
 * piece of work is not yet being attributed here.
 */
export const GRACE_MS = 30 * 60 * 1000;
/** Normalise a transcript path to what `git log --name-only` prints: repo
 *  relative, forward slashes, no leading `./`. */
const gitish = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
/**
 * The basename-and-parent tail of a path, for matching a transcript path
 * against a git path when the two are rooted differently.
 *
 * The transcript records paths relative to the session's working directory,
 * which is not always the repository root — a session run inside
 * `services/api` records `src/runs.ts` for a file git calls
 * `services/api/src/runs.ts`. Matching on a suffix rather than equality is
 * what makes the probe work from a subdirectory, and the two-segment tail is
 * narrow enough that `src/index.ts` does not match every package in a monorepo.
 */
const tail = (p) => gitish(p).split('/').slice(-2).join('/');
const gitRun = (args, cwd) => execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
});
/**
 * At most this many repositories per session.
 *
 * Each costs two subprocesses. A session touching more than a handful of
 * checkouts is doing something this probe has no useful answer for, and the
 * cap keeps one pathological transcript from making a corpus scan crawl.
 */
export const MAX_REPOS = 4;
/** The repository root a file belongs to, or null. Memoised per directory:
 *  thirty files in one tree ask once. */
function rootOfDir(dir, run, memo) {
    const hit = memo.get(dir);
    if (hit !== undefined)
        return hit;
    let root = null;
    try {
        root = run(['rev-parse', '--show-toplevel'], dir).trim() || null;
    }
    catch {
        root = null;
    }
    memo.set(dir, root);
    return root;
}
/**
 * Probe a session's window for commits carrying its work.
 *
 * FOLLOWS THE FILES, not the working directory. The first version searched
 * only the session's own cwd, which answered "unavailable — every file is
 * outside the working directory" for the entirely ordinary case of a session
 * run in one checkout that edits another: a git worktree, a monorepo entered
 * at the wrong level, or any session that writes to a sibling repository.
 * Those are exactly the sessions whose work did land, so reporting them as
 * unprobeable was the false negative the rung exists to avoid.
 *
 * Every failure mode answers `unavailable` with a reason rather than throwing:
 * this runs inside the extractor, and a session in a directory that is not a
 * repository is ordinary, not exceptional.
 */
export function probeLanded(input) {
    const { cwd, startedAt, endedAt, filesTouched } = input;
    const run = input.run || gitRun;
    if (!cwd)
        return { ...NOT_PROBED, why: 'the transcript never recorded a working directory' };
    if (!startedAt)
        return { ...NOT_PROBED, why: 'the session has no start time' };
    if (!filesTouched.length)
        return { ...NOT_PROBED, why: 'the session wrote no files to look for' };
    const start = Date.parse(startedAt);
    const end = Date.parse(endedAt || startedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end))
        return { ...NOT_PROBED, why: 'the session window will not parse' };
    // Back to absolute, which is the only form a repository root can be found
    // from. `~` is the spine's own stand-in for the home root and is expanded
    // here rather than dropped; it is this machine's home either way.
    const abs = filesTouched
        .map((p) => (p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^\/+/, ''))
        : isAbsolute(p) ? p : resolve(cwd, p)));
    const memo = new Map();
    // root -> the repo-relative paths of the session's files inside it
    const byRoot = new Map();
    for (const p of abs) {
        const dir = p.replace(/\/[^/]*$/, '') || '/';
        const root = rootOfDir(dir, run, memo);
        if (!root)
            continue;
        if (!byRoot.has(root) && byRoot.size >= MAX_REPOS)
            continue;
        const rel = gitish(relative(root, p));
        if (!rel || rel.startsWith('..'))
            continue;
        if (!byRoot.has(root))
            byRoot.set(root, new Set());
        byRoot.get(root).add(rel);
    }
    if (!byRoot.size)
        return { ...NOT_PROBED, why: 'none of the files the session wrote are inside a git repository' };
    let commits = 0, unrelated = 0, overlap = 0, looked = 0;
    let sawDuring = false, sawAfter = false, failures = 0;
    for (const [root, files] of byRoot) {
        const wanted = new Set([...files].map(tail).filter(Boolean));
        if (!wanted.size)
            continue;
        let out;
        try {
            out = run([
                'log',
                `--since=${new Date(start - 1000).toISOString()}`,
                `--until=${new Date(end + GRACE_MS).toISOString()}`,
                '--name-only',
                '--no-merges',
                // A record separator and a machine timestamp. Deliberately no %s and
                // no %an: a subject line is prose and an author is a person.
                '--pretty=format:%x1ecommit%x1f%cI',
                '--all',
            ], root);
        }
        catch {
            failures++;
            continue;
        }
        looked++;
        const hit = new Set();
        for (const chunk of out.split('\u001e')) {
            if (!chunk.trim())
                continue;
            const [head, ...rest] = chunk.split('\n');
            const at = Date.parse((head || '').split('\u001f')[1] || '');
            if (!Number.isFinite(at))
                continue;
            const overlapping = rest.map((l) => l.trim()).filter(Boolean)
                .filter((q) => wanted.has(tail(q)));
            if (!overlapping.length) {
                unrelated++;
                continue;
            }
            commits++;
            for (const q of overlapping)
                hit.add(tail(q));
            if (at <= end)
                sawDuring = true;
            else
                sawAfter = true;
        }
        overlap += hit.size;
    }
    if (!looked)
        return {
            ...NOT_PROBED,
            repos: 0,
            why: failures ? 'git could not be read in any repository the files are in'
                : 'no repository to look in',
        };
    return {
        state: commits === 0 ? 'none' : sawDuring ? 'during' : sawAfter ? 'after' : 'none',
        commits,
        overlap,
        unrelated,
        repos: looked,
        why: null,
    };
}
