// Where this plugin keeps its own state, and where each harness keeps its
// transcripts.
//
// The plugin began inside Claude Code and wrote to `~/.claude/session-viz/`,
// which is somebody else's directory. That was fine while Claude Code was the
// only harness and wrong the moment it was not: a Codex or DeepSeek user has no
// `~/.claude`, and a sandboxed harness is not allowed to write outside its
// workspace at all — which surfaces as a bare `EPERM ... open` in a browser
// tab, a message that tells the reader nothing they can act on.
//
// So: one resolver, honoured everywhere, with an override that a confined
// harness can actually set.

import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/**
 * Config directories, best first.
 *
 * `SESSION_VIZ_HOME` exists for the confined case: a harness that sandboxes
 * writes to its workspace can point this at a directory inside it, and nothing
 * else has to change. XDG is next because it is the convention this should have
 * followed from the start. `~/.claude` stays last and is never *preferred* —
 * only honoured, so that installs predating this keep their token.
 */
export function configDirs(): string[] {
  const out: string[] = []
  const push = (d: string | undefined): void => { if (d && !out.includes(d)) out.push(d) }
  push(process.env.SESSION_VIZ_HOME)
  push(process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'session-viz') : undefined)
  push(join(homedir(), '.config', 'session-viz'))
  push(join(homedir(), '.claude', 'session-viz'))
  return out
}

export const configPaths = (): string[] => configDirs().map((d) => join(d, 'config.json'))

/** The file to read: whichever candidate exists. Null when none do. */
export function findConfig(): string | null {
  return configPaths().find((p) => existsSync(p)) || null
}

/**
 * Where a write should go.
 *
 * `SESSION_VIZ_HOME` is an instruction, not a hint: when it is set it wins
 * outright, even against a config that already exists elsewhere. Anything less
 * and the one setting that exists to rescue a confined harness gets overruled
 * by a stale file in a directory that harness cannot write.
 *
 * Otherwise an existing file wins, so saving again lands on the config already
 * in use rather than quietly creating a second one that shadows it — two
 * configs disagreeing is worse than an unfashionable path.
 */
export const configTarget = (): string =>
  (process.env.SESSION_VIZ_HOME
    ? join(process.env.SESSION_VIZ_HOME, 'config.json')
    : findConfig() || configPaths()[0]!)

export interface SavedTo {
  path: string
  /** True when the preferred location was refused and a later one was used. */
  fellBack: boolean
}

/**
 * Write JSON 0600 in a 0700 directory, trying each candidate in turn.
 *
 * `writeFileSync` honours `mode` only when it creates the file, so an existing
 * one keeps whatever permissions it had — the same omission once left session
 * reports world-readable in /tmp. Hence the explicit chmod.
 */
export function saveConfig(data: unknown): SavedTo {
  const targets = [configTarget(), ...configPaths().filter((p) => p !== configTarget())]
  const refused: string[] = []
  for (const path of targets) {
    try {
      const dir = dirname(path)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
      chmodSync(path, 0o600)
      chmodSync(dir, 0o700)
      return { path, fellBack: refused.length > 0 }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // Only a permission problem is worth trying elsewhere. A malformed path
      // or a full disk will fail identically everywhere, so surface it.
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EROFS') throw e
      refused.push(path)
    }
  }
  throw new Error(
    `cannot write the config — permission denied at ${refused.join(', ')}. ` +
    'A sandboxed harness usually cannot write outside its workspace: set ' +
    'SESSION_VIZ_HOME to a directory it can write, or set SESSION_VIZ_TOKEN ' +
    'in the environment and skip the file entirely.')
}

export function loadConfig<T>(): T | null {
  const p = findConfig()
  if (!p) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as T } catch { return null }
}

// ---------------------------------------------------------------- harnesses

export interface TranscriptRoot {
  /** Stable id used in reports and as the adapter key. */
  harness: string
  dir: string
}

/**
 * Where each known harness writes session transcripts.
 *
 * Only directories that exist are returned, so this doubles as detection: an
 * empty result means nothing on this machine has left transcripts where we know
 * to look, which is a different and more useful statement than "no sessions".
 *
 * `SESSION_VIZ_TRANSCRIPTS` takes a colon-separated list for anything not
 * listed here — a fork, a private harness, or a directory copied off another
 * machine. Entries take the form `harness=/path` or a bare path, which is
 * reported as `custom`.
 *
 * Identity is the directory itself (device + inode), not the string that names
 * it. CLAUDE_CONFIG_DIR pointing at `~/.claude` through a symlink, or as
 * `~/.Claude` on macOS's case-insensitive default filesystem, spells the same
 * directory two ways — de-duplicated on the raw string both survive, every
 * transcript under them is listed twice, and each duplicate is extracted as a
 * separate session. That doubles every pooled rate and every token total in
 * /qtrends, /qdoctor, /qship and /qpact at once, with nothing to show for it.
 */
export function transcriptRoots(): TranscriptRoot[] {
  const out: TranscriptRoot[] = []
  const seen = new Set<string>()
  const push = (harness: string, dir: string | undefined): void => {
    if (!dir) return
    let key: string
    try {
      const st = statSync(dir)
      if (!st.isDirectory()) return
      key = `${st.dev}:${st.ino}`
    } catch {
      return // missing, or unreadable, which is the same thing to a scan
    }
    if (seen.has(key)) return
    seen.add(key)
    out.push({ harness, dir })
  }
  for (const entry of (process.env.SESSION_VIZ_TRANSCRIPTS || '').split(':').filter(Boolean)) {
    const at = entry.indexOf('=')
    if (at > 0) push(entry.slice(0, at), entry.slice(at + 1))
    else push('custom', entry)
  }
  // Claude Code: one directory per project, JSONL per session.
  push('claude-code', process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : undefined)
  push('claude-code', join(homedir(), '.claude', 'projects'))
  // Codex: rollout-*.jsonl under a date tree, session_meta on the first line.
  push('codex', process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : undefined)
  push('codex', join(homedir(), '.codex', 'sessions'))
  return out
}

/**
 * A label for whichever harness is running this process, for the audit trail.
 * Env first because it is the only evidence that survives being spawned as a
 * plain child process, which is how every one of these runs us.
 */
export function harnessLabel(): string {
  if (process.env.SESSION_VIZ_ACTOR) return process.env.SESSION_VIZ_ACTOR
  if (process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDECODE) return 'claude-code'
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return 'codex'
  return 'unknown'
}
