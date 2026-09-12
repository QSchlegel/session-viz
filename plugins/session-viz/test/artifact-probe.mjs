// A successful Write/Edit result is transcript evidence. This is the separate
// local check that says whether the target is still visible on disk now.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ledger, probeWriteTargets, renderLedger, writeTarget } from '../scripts/runs.mjs'

let passed = 0, failed = 0
const chk = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  ok ? passed++ : failed++
}

chk('Write reads file_path', writeTarget('Write', { file_path: '/tmp/report.md' }) === '/tmp/report.md')
chk('Edit accepts the cross-harness path alias', writeTarget('Edit', { path: 'src/app.ts' }) === 'src/app.ts')
chk('NotebookEdit prefers notebook_path', writeTarget('NotebookEdit', {
  notebook_path: 'analysis.ipynb', file_path: 'wrong.ipynb',
}) === 'analysis.ipynb')
chk('a read tool cannot become delivery evidence', writeTarget('Read', { file_path: '/tmp/report.md' }) === null)
chk('a malformed input stays unprobeable', writeTarget('Write', 'report.md') === null)

const dir = mkdtempSync(join(tmpdir(), 'session-viz-artifact-'))
writeFileSync(join(dir, 'present.md'), 'evidence')
mkdirSync(join(dir, 'a-directory'))

const present = probeWriteTargets(['present.md'], dir)
chk('a relative successful target is resolved from the recorded cwd',
  present.state === 'present' && present.present === 1, JSON.stringify(present))

const missing = probeWriteTargets(['missing.md'], dir)
chk('an absent local target is a lead, not a delivery verdict',
  missing.state === 'not_found_local' && missing.notFoundLocal === 1, JSON.stringify(missing))

const partial = probeWriteTargets(['present.md', 'missing.md', 'present.md'], dir)
chk('targets are deduplicated and partial evidence stays partial',
  partial.state === 'partial' && partial.targeted === 2 && partial.present === 1 && partial.notFoundLocal === 1,
  JSON.stringify(partial))

const noCwd = probeWriteTargets(['relative.md'], null)
chk('a relative target without a recorded cwd is unavailable, not missing',
  noCwd.state === 'unavailable' && noCwd.unavailable === 1, JSON.stringify(noCwd))

const directory = probeWriteTargets(['a-directory'], dir)
chk('a directory does not masquerade as the file a write promised',
  directory.state === 'unavailable' && directory.unavailable === 1, JSON.stringify(directory))

const noTarget = probeWriteTargets([], dir, 1)
chk('a successful write result without a readable path stays unavailable',
  noTarget.state === 'unavailable' && noTarget.unavailable === 1, JSON.stringify(noTarget))

const mixedRun = {
  kind: 'scheduled', task: 'mixed evidence', delivery: 'wrote_ok', artifact: {
    state: 'partial', targeted: 2, present: 1, notFoundLocal: 0, unavailable: 1,
  },
  harness: 'claude-code', started: '2026-08-20T00:00:00Z', terminal: 'completed_prose',
  errorClass: 'none', out: 100, cread: 200, ccreate: 0, cin: 0, toolErr: 0, loops: 0,
  structured: 0, structuredFail: 0, intentWrite: 1, wroteOk: 1,
}
const mixedLedger = ledger([mixedRun])
chk('mixed evidence contributes to unavailable aggregates',
  mixedLedger.tasks[0].artifactUnavailable === 1 && mixedLedger.autonomous.artifactUnavailable === 1,
  JSON.stringify(mixedLedger.autonomous))
const mixedText = renderLedger(mixedLedger)
chk('text summaries expose unavailable evidence',
  mixedText.includes('1 unavailable') && mixedText.includes('not-found  unavailable'), mixedText)

// ------------------------------------------------ why a task produced nothing
//
// One rule used to answer three questions with one word: `delivered === 0 &&
// runs >= 3`. On 2026-09-12 it called session-viz's own daily audit STALLED on
// the day it worked — both repositories were unchanged, so it took its early
// exit and wrote nothing on purpose — and gave it the same label, and the same
// suggested remedy, as a blog writer whose every run died at a permission
// prompt. These three fixtures are those cases, kept apart.

const base = {
  kind: 'scheduled', harness: 'claude-code', started: '2026-09-01T00:00:00Z',
  artifact: { state: 'not_applicable', targeted: 0, present: 0, notFoundLocal: 0, unavailable: 0 },
  out: 100, cread: 200, ccreate: 0, cin: 0, toolErr: 0, loops: 0,
  structured: 0, structuredFail: 0, intentWrite: 0, wroteOk: 0,
}
// Refused: it tried to write and was told no. A settings line fixes this.
const blocked = Array.from({ length: 3 }, () => ({
  ...base, task: 'blog-writer', terminal: 'truncated', delivery: 'denied', errorClass: 'permission',
}))
// Meant to write and nothing landed, with no refusal recorded. Somebody has to
// read a transcript; no settings file explains this one.
const silent = Array.from({ length: 3 }, () => ({
  ...base, task: 'half-finisher', terminal: 'infra_halt', delivery: 'unverified', errorClass: 'none',
  intentWrite: 1,
}))
// Ran, decided there was nothing to do, said so, ended coherently. Not a
// failure at all — this is the case the old rule could not see.
const quiet = Array.from({ length: 3 }, () => ({
  ...base, task: 'daily-audit', terminal: 'completed_prose', delivery: 'no_intent', errorClass: 'none',
}))

const verdicts = ledger([...blocked, ...silent, ...quiet]).tasks
const v = (name) => verdicts.find((t) => t.task === name)

chk('a task refused a write reads as blocked', v('blog-writer')?.verdict, 'blocked')
chk('and is stalled, because it is failing', v('blog-writer')?.stalled === true)
chk('a task that meant to write and did not reads as silent', v('half-finisher')?.verdict, 'silent')
chk('and is stalled too', v('half-finisher')?.stalled === true)
chk('a task that cleanly had nothing to do reads as quiet', v('daily-audit')?.verdict, 'quiet')
chk('and is NOT stalled, however many times it has run', v('daily-audit')?.stalled === false)
chk('its runs are counted as quiet, not as failures',
  v('daily-audit')?.quiet === 3 && v('daily-audit')?.stopped === 0,
  JSON.stringify({ quiet: v('daily-audit')?.quiet, stopped: v('daily-audit')?.stopped }))
chk('a delivering task is neither', ledger([{ ...base, task: 'works', terminal: 'completed_prose', delivery: 'wrote_ok', errorClass: 'none', wroteOk: 1 }]).tasks[0].verdict, 'delivering')

// A task is only quiet if EVERY run ended that way. Two clean no-ops and one
// run that stopped is a task with a problem, and says so.
const mostlyQuiet = ledger([
  ...quiet.slice(0, 2).map((r) => ({ ...r, task: 'mixed' })),
  { ...base, task: 'mixed', terminal: 'truncated', delivery: 'no_intent', errorClass: 'tool_error' },
]).tasks[0]
chk('one stopped run among clean ones is not quiet', mostlyQuiet.verdict, 'silent')
chk('and the clean ones are still counted as such', mostlyQuiet.quiet, 2)

const verdictText = renderLedger(ledger([...blocked, ...quiet]))
chk('the text names the cause rather than one word for all of them',
  verdictText.includes('BLOCKED') && verdictText.includes('quiet') && !verdictText.includes('STALLED'),
  verdictText.split('\n').filter((l) => /blog-writer|daily-audit/.test(l)).join('\n'))
chk('and a quiet task is not shouted at',
  /daily-audit/.test(verdictText) && !/<< .*daily-audit|daily-audit.*<</.test(verdictText),
  verdictText.split('\n').filter((l) => /daily-audit/.test(l)).join('\n'))

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} passed`)
process.exit(failed ? 1 : 0)
