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

/** The repository root a cwd belongs to. '' when there is no cwd to read. */
export const repoRoot = (cwd: string | null | undefined): string =>
  String(cwd || '').split(WORKTREE_SEP)[0]!

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
