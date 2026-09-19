// The commit probe — the rung that reads a repository.
//
// Driven through its `run` seam rather than against a real checkout, so the
// window arithmetic, the overlap rule and every reason-it-could-not-look are
// exercised deterministically. The probe was also run against this project's
// own repositories while it was written, and the count it produced (8
// overlapping, 4 unrelated) was checked by hand against `git log`.
//
// Most of this file is about the two ways the rung can lie: counting a commit
// that had nothing to do with the session, and reporting "nothing landed" when
// it simply could not look.
import { probeLanded, GRACE_MS } from '../scripts/landed.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}
const section = (t) => console.log(`\n— ${t}`)

const START = '2026-09-19T10:00:00.000Z'
const END = '2026-09-19T11:00:00.000Z'
const at = (ms) => new Date(Date.parse(END) + ms).toISOString()

/** A fake git. `roots` maps a directory prefix to its repository root;
 *  `logs` maps a root to the commits it should report. */
const fakeGit = (roots, logs, { failLog = new Set() } = {}) => {
  const calls = []
  const run = (args, cwd) => {
    calls.push({ args, cwd })
    if (args[0] === 'rev-parse') {
      const hit = Object.keys(roots).find((p) => cwd === p || cwd.startsWith(p + '/'))
      if (!hit) throw new Error('fatal: not a git repository')
      return roots[hit] + '\n'
    }
    if (failLog.has(cwd)) throw new Error('fatal: bad object')
    return (logs[cwd] || [])
      .map(({ when, files }) => `commit${when}\n${files.join('\n')}`)
      .join('\n')
  }
  return { run, calls }
}

section('a commit carrying the work counts; one that does not, does not')
{
  const { run } = fakeGit(
    { '/repo': '/repo' },
    {
      '/repo': [
        { when: '2026-09-19T10:30:00Z', files: ['src/a.ts', 'README.md'] },
        { when: '2026-09-19T10:45:00Z', files: ['docs/unrelated.md'] },
      ],
    })
  const r = probeLanded({ cwd: '/repo', startedAt: START, endedAt: END, filesTouched: ['src/a.ts'], run })
  chk('it landed during the session', r.state === 'during', JSON.stringify(r))
  chk('one commit counted', r.commits === 1, JSON.stringify(r))
  chk('one file overlapped', r.overlap === 1, JSON.stringify(r))
  chk('the other is counted as unrelated, not as landing', r.unrelated === 1, JSON.stringify(r),)
  chk('one repository', r.repos === 1, JSON.stringify(r))
}

section('the overlap rule is what stops any commit satisfying any session')
{
  const { run } = fakeGit({ '/repo': '/repo' },
    { '/repo': [{ when: '2026-09-19T10:30:00Z', files: ['totally/other.ts'] }] })
  const r = probeLanded({ cwd: '/repo', startedAt: START, endedAt: END, filesTouched: ['src/a.ts'], run })
  chk('a commit in the window with no overlap does not land it', r.state === 'none', JSON.stringify(r))
  chk('but it is still counted', r.unrelated === 1, JSON.stringify(r))
}

section('the grace window, and its edge')
{
  const mk = (when) => fakeGit({ '/repo': '/repo' },
    { '/repo': [{ when, files: ['src/a.ts'] }] }).run
  const inside = probeLanded({
    cwd: '/repo', startedAt: START, endedAt: END, filesTouched: ['src/a.ts'], run: mk(at(GRACE_MS - 60_000)),
  })
  chk('a commit just after the session is `after`', inside.state === 'after', JSON.stringify(inside))
  const during = probeLanded({
    cwd: '/repo', startedAt: START, endedAt: END, filesTouched: ['src/a.ts'], run: mk('2026-09-19T10:59:00Z'),
  })
  chk('a commit inside the window is `during`', during.state === 'during', JSON.stringify(during))
  chk('and during beats after when both exist', probeLanded({
    cwd: '/repo', startedAt: START, endedAt: END, filesTouched: ['src/a.ts'],
    run: fakeGit({ '/repo': '/repo' }, {
      '/repo': [
        { when: at(GRACE_MS - 60_000), files: ['src/a.ts'] },
        { when: '2026-09-19T10:30:00Z', files: ['src/a.ts'] },
      ],
    }).run,
  }).state === 'during')
}

section('the probe follows the files, not the working directory')
{
  // The case that made this necessary: a session run in a worktree of one
  // repository whose every write lands in two others. The first version
  // answered "unavailable — every file is outside the working directory",
  // which is the false negative the rung exists to avoid.
  const { run, calls } = fakeGit(
    { '/work/tree': '/work/tree', '/other/cloud': '/other/cloud', '/other/plugin': '/other/plugin' },
    {
      '/other/cloud': [{ when: '2026-09-19T10:20:00Z', files: ['services/api/src/runs.ts'] }],
      '/other/plugin': [{ when: '2026-09-19T10:40:00Z', files: ['src/landed.mts'] }],
    })
  const r = probeLanded({
    cwd: '/work/tree',
    startedAt: START, endedAt: END,
    filesTouched: ['../../other/cloud/services/api/src/runs.ts', '../../other/plugin/src/landed.mts'],
    run,
  })
  chk('both repositories were looked in', r.repos === 2, JSON.stringify(r))
  chk('both commits counted', r.commits === 2, JSON.stringify(r))
  chk('and it landed', r.state === 'during', JSON.stringify(r))
  chk('the session\'s own cwd was never logged — it holds none of the work',
    !calls.some((c) => c.args[0] === 'log' && c.cwd === '/work/tree'),
    JSON.stringify(calls.filter((c) => c.args[0] === 'log').map((c) => c.cwd)))
}

section('a subdirectory session still matches, because the tail is what is compared')
{
  const { run } = fakeGit({ '/repo': '/repo' },
    { '/repo': [{ when: '2026-09-19T10:30:00Z', files: ['services/api/src/runs.ts'] }] })
  // The transcript recorded `src/runs.ts`, relative to services/api.
  const r = probeLanded({
    cwd: '/repo/services/api', startedAt: START, endedAt: END, filesTouched: ['src/runs.ts'], run,
  })
  chk('a path relative to a subdirectory matches the repo-rooted one',
    r.state === 'during' && r.commits === 1, JSON.stringify(r))
}

section('every reason it could not look says so, and none of them says "none"')
{
  const none = { startedAt: START, endedAt: END, filesTouched: ['a.ts'] }
  const no = (over) => probeLanded({ cwd: '/repo', ...none, ...over })

  chk('no working directory', probeLanded({ ...none, cwd: null }).state === 'unavailable')
  chk('no start time',
    probeLanded({ cwd: '/repo', ...none, startedAt: null }).state === 'unavailable')
  chk('no files written',
    probeLanded({ cwd: '/repo', ...none, filesTouched: [] }).state === 'unavailable')
  chk('an unparseable window',
    no({ startedAt: 'not a date', run: () => '' }).state === 'unavailable')

  const notRepo = probeLanded({
    cwd: '/nowhere', ...none, run: fakeGit({}, {}).run,
  })
  chk('nothing is in a repository', notRepo.state === 'unavailable', JSON.stringify(notRepo))
  chk('and it says why', /inside a git repository/.test(notRepo.why || ''), notRepo.why)

  const broken = probeLanded({
    cwd: '/repo', ...none,
    run: fakeGit({ '/repo': '/repo' }, {}, { failLog: new Set(['/repo']) }).run,
  })
  chk('git refused to log', broken.state === 'unavailable', JSON.stringify(broken))
  chk('which is never reported as nothing landed', broken.state !== 'none',
    'a probe that could not look must not say the work did not land')

  // And the case that IS a real answer.
  const empty = probeLanded({ cwd: '/repo', ...none, run: fakeGit({ '/repo': '/repo' }, { '/repo': [] }).run })
  chk('an empty log IS `none` — it looked and found nothing', empty.state === 'none', JSON.stringify(empty))
}

section('nothing identifying is retained')
{
  const { run, calls } = fakeGit({ '/repo': '/repo' },
    { '/repo': [{ when: '2026-09-19T10:30:00Z', files: ['src/a.ts'] }] })
  const r = probeLanded({ cwd: '/repo', startedAt: START, endedAt: END, filesTouched: ['src/a.ts'], run })
  const asText = JSON.stringify(r)
  chk('the result carries no path', !/src\/a\.ts/.test(asText), asText)
  chk('and no sha or message', !/[0-9a-f]{7,}/.test(asText.replace(/\d/g, '')), asText)
  const fmt = calls.find((c) => c.args[0] === 'log').args.join(' ')
  chk('the log format asks for no subject and no author',
    !/%s/.test(fmt) && !/%an/.test(fmt) && !/%ae/.test(fmt), fmt)
  chk('and merges are excluded', /--no-merges/.test(fmt), fmt)
}

section('against real git, which is where the fake could not follow')
{
  // Everything above drives the `run` seam. Two defects lived underneath it,
  // both invisible to a fake whose answers agree with its own inputs by
  // construction.
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  let have = true
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { have = false }
  if (!have) console.log('skip  real git is not on this machine')
  else {
    const dir = mkdtempSync(join(tmpdir(), 'sv-landed-real-'))
    const git = (args, when) => execFileSync('git', args, {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: when || '', GIT_COMMITTER_DATE: when || '',
        GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
    })
    try {
      git(['init', '-q', '-b', 'main'])
      writeFileSync(join(dir, 'mine.ts'), 'x')
      git(['add', '.']); git(['commit', '-qm', 'mine'], '2026-09-19T10:30:00+0000')
      const real = (over = {}) =>
        probeLanded({ cwd: dir, startedAt: START, endedAt: END, filesTouched: ['mine.ts'], ...over })

      // DEFECT ONE: a temp directory on macOS is /var/..., and git answers
      // with /private/var/... . Comparing the two made `relative()` climb out
      // with ../.. , the file was dropped, and the probe reported "none of
      // the files are inside a git repository" about a file sitting in one.
      // Any symlinked home, project directory or mount is the same story.
      const own = real()
      chk('a repository reached through a symlink is still a repository',
        own.state === 'during' && own.commits === 1, JSON.stringify(own))
      chk('and it is never reported as unprobeable', own.state !== 'unavailable', own.why || '')

      chk('a window with no commits in it is `none`, having looked',
        real({ startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T01:00:00Z' }).state === 'none')

      // DEFECT TWO: `--all` reaches refs/remotes/*, and a commit reachable
      // only from there is one that arrived by fetch. Somebody else's work,
      // in this session's window, touching a file this session also wrote,
      // was counted as this session's work landing.
      git(['checkout', '-q', '-b', 'theirs'])
      writeFileSync(join(dir, 'mine.ts'), 'their edit')
      git(['commit', '-qam', 'theirs'], '2026-09-19T10:45:00+0000')
      const sha = git(['rev-parse', 'HEAD']).trim()
      git(['checkout', '-q', 'main'])
      git(['branch', '-qD', 'theirs'])
      git(['update-ref', 'refs/remotes/origin/theirs', sha])
      const fetched = real()
      chk('a commit only a fetch could have put here is not this session\'s work',
        fetched.commits === 1, `${fetched.commits} — a remote-tracking ref was counted`)

      // A repository with nothing committed yet. Naming HEAD is fatal there,
      // and the first version of the narrowing turned 17 real sessions into
      // `unavailable` over it — a repository the probe can see perfectly
      // well, reported as one it could not look at.
      const fresh = mkdtempSync(join(tmpdir(), 'sv-landed-empty-'))
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh })
        writeFileSync(join(fresh, 'new.ts'), 'x')
        const r = probeLanded({ cwd: fresh, startedAt: START, endedAt: END, filesTouched: ['new.ts'] })
        chk('a repository with no commits yet answers `none`, not `unavailable`',
          r.state === 'none', JSON.stringify(r))
        chk('and it counts as having been looked in', r.repos === 1, JSON.stringify(r))
      } finally { rmSync(fresh, { recursive: true, force: true }) }

      // The case --all was there for, which must survive the narrowing: work
      // committed on a local branch the session then left.
      git(['checkout', '-q', '-b', 'mine-elsewhere'])
      writeFileSync(join(dir, 'mine.ts'), 'more of mine')
      git(['commit', '-qam', 'mine again'], '2026-09-19T10:50:00+0000')
      git(['checkout', '-q', 'main'])
      chk('but a local branch the session moved off still counts',
        real().commits === 2, JSON.stringify(real()))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
