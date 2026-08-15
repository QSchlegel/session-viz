// What repository a session belongs to, and which worktree of it.
//
// This lived inside corpus.mts, where it was correct and invisible. The other
// three readers each grew their own copy of the first half of it and none grew
// the second: ship.mts and doctor.mts split on `/.claude/worktrees/` and stop
// there, which is right for Claude Code and silently wrong for Codex. The
// result was not a missing feature but a disagreement — /qtrends folding five
// worktrees into one repo while /qship reported five, over the same corpus, with
// nothing on either screen admitting the other existed.
//
// One definition, imported by everything that needs to name a repo.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Claude Code puts worktrees INSIDE the repository, at
// <repo>/.claude/worktrees/<name>, and gives each its own transcript directory.
// Left alone, a repo worked across five worktrees appears as five unrelated
// single-session "projects" — which hides the repo that actually dominates the
// corpus and makes every per-project rate a sample of one branch.
const WORKTREE_SEP = '/.claude/worktrees/'

// Codex checks its worktrees out *outside* the repository, at
// ~/.codex/worktrees/<id>/<repo> — so unlike the layout above, splitting the
// path recovers nothing, and the checkout arrives as a project of its own
// carrying the repository's basename. That collides: the knowledge graph mints
// node ids as `repo:<name>`, so both entries land on one id at one position, one
// circle permanently occluding the other while their tooltips disagree.
const CODEX_WORKTREE = /\/\.codex\/worktrees\/([^/]+)\/[^/]+$/

// Cursor checks worktrees out at ~/.cursor/worktrees/<repo>/<id>, which is the
// same idea as Codex's layout with the two segments the other way round: the
// REPOSITORY name comes first and the worktree id second.
//
// Unhandled, each id became a project of its own — `mesh` arrived as five
// entries (`mesh`, `6msTo`, `4mxT9`, `KREpC`, `luUuk`) in /qtrends, five repos
// in /qdoctor's fleet baseline, and five labels in /qship, while corpus.mts
// states the invariant outright: "worktrees of one repo are one project".
const CURSOR_WORKTREE = /\/\.cursor\/worktrees\/([^/]+)\/([^/]+)/

/**
 * The repository root a cwd belongs to. '' when there is no cwd to read.
 *
 * A Cursor worktree cannot be recovered by splitting: its checkout lives
 * outside the repository and the path names the repo but not where it is. The
 * `.git` file inside such a worktree points at the real one
 * (`gitdir: /…/mesh/.git/worktrees/6msTo`), so the name is resolved against
 * the sibling checkouts rather than guessed from the path.
 */
export const repoRoot = (cwd: string | null | undefined): string => {
  const s = String(cwd || '')
  if (CURSOR_WORKTREE.test(s)) return cursorWorktreeRepo(s) ?? s.split(WORKTREE_SEP)[0]!
  return s.split(WORKTREE_SEP)[0]!
}

// Resolved once per worktree; a corpus scan asks about the same handful of
// paths thousands of times.
const cursorRepoCache = new Map<string, string | null>()

/**
 * The real checkout behind a Cursor worktree, read rather than guessed.
 *
 * A linked worktree's `.git` is a FILE holding `gitdir: <path>/.git/worktrees/<id>`,
 * which names the repository exactly. Reconstructing it from the path instead
 * would mean assuming where repositories live — `~/git` on this machine, which
 * is a guess that is wrong on any other.
 *
 * Null when the pointer is missing or unreadable, so the caller falls back to
 * the path and a worktree is at worst labelled as it was before.
 */
function cursorWorktreeRepo(cwd: string): string | null {
  const m = cwd.match(/^(.*\/\.cursor\/worktrees\/[^/]+\/[^/]+)/)
  if (!m) return null
  const wt = m[1]!
  const hit = cursorRepoCache.get(wt)
  if (hit !== undefined) return hit
  let out: string | null = null
  try {
    const ptr = readFileSync(join(wt, '.git'), 'utf8').trim()
    const g = ptr.match(/^gitdir:\s*(.+)$/)
    if (g) {
      // <repo>/.git/worktrees/<id>  ->  <repo>
      const at = g[1]!.indexOf('/.git/worktrees/')
      if (at > 0) out = g[1]!.slice(0, at)
    }
  } catch { /* not a linked worktree, or gone from disk */ }
  cursorRepoCache.set(wt, out)
  return out
}

/**
 * The branch-ish worktree name, or null for the main checkout.
 *
 * Kept rather than discarded: within a repo, "which worktree" is the useful
 * second axis, and it is the only thing distinguishing two Codex checkouts that
 * otherwise share a basename.
 */
export const worktreeOf = (cwd: string | null | undefined): string | null => {
  const s = String(cwd || '')
  const i = s.indexOf(WORKTREE_SEP)
  if (i !== -1) return s.slice(i + WORKTREE_SEP.length).split('/')[0]!
  // Cursor names the repo first and the worktree id second, so the id is the
  // SECOND capture — the reverse of Codex's layout.
  const cur = s.match(CURSOR_WORKTREE)
  if (cur) return cur[2]!
  return s.match(CODEX_WORKTREE)?.[1] ?? null
}

/** The bare repository name — the last path segment of its root. */
export const repoName = (cwd: string | null | undefined): string =>
  repoRoot(cwd).replace(/^.*\//, '')

/**
 * The repo name recovered from a Claude Code transcript directory slug.
 *
 * The slug is the cwd with every '/' turned into '-', so it cannot be reversed
 * unambiguously — a repo with a hyphen in its name is indistinguishable from a
 * path separator. It is a fallback for the one case that has no cwd on any
 * record, and never preferred over a real cwd.
 */
export const repoFromSlug = (slug: string): string =>
  slug.replace(/^-Users-[^-]+-/, '').split('--claude-worktrees-')[0]!
