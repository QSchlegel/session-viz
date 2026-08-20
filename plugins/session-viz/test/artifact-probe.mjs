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

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} passed`)
process.exit(failed ? 1 : 0)
