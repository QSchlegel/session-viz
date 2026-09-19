// `task_class` is the one column of the eleven a person wrote the text of, and
// /qcontrib prints "0 repo name(s)" directly above the values it is about to
// send. A contribution cannot be recalled, so that line has to be true at the
// moment it is printed — which makes this the test that guards a promise, not
// a helper.
//
// Every case below is one that shipped wrong or nearly did.



import { withoutRepo, taskClass, contribSlug, band, bucket, toFinding, validateFinding } from '../scripts/finding.mjs'

let pass = 0, fail = 0
const chk = (name, got, want) => {
  const ok = String(got) === String(want)
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)} want ${JSON.stringify(want)})`}`)
  ok ? pass++ : fail++
}

console.log('\n── the repo name never survives')
// A single split/join pass consumes the separator between two occurrences, so
// the second one loses its left boundary and is never matched: this returned
// `acme-api-seo` and shipped the exact name the function exists to remove.
chk('adjacent repeats', withoutRepo('acme-api-acme-api-seo', 'acme-api'), 'seo')
chk('repeats at both ends', withoutRepo('acme-api-seo-acme-api', 'acme-api'), 'seo')
chk('named exactly for the repo', withoutRepo('acme-api', 'acme-api'), 'repo-named')
chk('repo stripped, purpose kept', withoutRepo('acme-api-seo', 'acme-api'), 'seo')
chk('repo in the middle', withoutRepo('seo-acme-run', 'acme'), 'seo-run')
chk('two-word repo', withoutRepo('multisig-lookup-daily', 'multisig-lookup'), 'daily')
chk('underscore separators', withoutRepo('acme_api_daily', 'acme_api'), 'daily')

console.log('\n── and nothing else is damaged getting there')
// Segment-bounded: a repo whose name is a substring of a word must not cut it.
chk('api does not maul apiary', withoutRepo('apiary-nightly', 'api'), 'apiary-nightly')
chk('a one-letter repo shreds nothing', withoutRepo('weekly', 'a'), 'weekly')
chk('absent repo leaves the class alone', withoutRepo('nightly-seo', 'acme'), 'nightly-seo')
chk('no repo recorded', withoutRepo('nightly-seo', null), 'nightly-seo')

console.log('\n── classes')
// 'human' is a magic literal: the reference report exempts exactly that string
// from k<5 suppression, so spelling it anything else suppresses every human run.
chk('human stays the magic literal', taskClass({ kind: 'human', repo: 'acme' }), 'human')
// Passed through raw, an unnormalised family failed server-side validation and
// the run was held back silently, for a reason nothing in the output explained.
chk('subagent family is slugged', taskClass({ kind: 'subagent', family: 'Scoped Editor', repo: null }), 'scoped-editor')
chk('subagent without a family', taskClass({ kind: 'subagent', family: null, repo: null }), 'other')
chk('scheduled, repo stripped', taskClass({ kind: 'scheduled', task: 'acme-nightly', repo: 'acme' }), 'nightly')
chk('unattended has no source at all', taskClass({ kind: 'scheduled', task: null, repo: null }), 'unattended')

console.log('\n── the slug can never produce something the server rejects')
const RE = /^[a-z0-9][a-z0-9_-]{0,63}$/   // vendored from the server
for (const s of ['_nightly', '--x--', 'ÜBER Größe', '', null, 'a'.repeat(200), '...', '9lives']) {
  chk(`accepted: ${JSON.stringify(String(s).slice(0, 18))}`, RE.test(contribSlug(s)), true)
}

console.log('\n── buckets stay comparable with rows already stored')
chk('band keeps major.minor', band('2.14.7'), '2.14.x')
chk('band rejects nonsense', band('not-a-version'), '0.0.x')
chk('band on nothing', band(null), '0.0.x')
chk('bucket 0', bucket(0, 40), 0)
chk('bucket is log2', bucket(1023, 40), 10)
chk('bucket caps', bucket(1e12, 40), 40)
chk('bucket floors at 0', bucket(-5, 40), 0)

// ---- the eleven columns, and the two that are new -------------------------
//
// Consent material: this is what leaves a machine when somebody runs
// /qcontrib, and the disclosure counts the columns out loud. A field added
// here without the disclosure following it would ship something nobody saw.
console.log('\n── plane A carries eleven bounded columns')
{
  const run = {
    kind: 'human', repo: 'acme', week: '2026-W38', cliVersion: '2.1.9',
    terminal: 'completed_prose', delivery: 'wrote_ok',
    verification: 'passed', landed: 'during',
    errorClass: 'none', out: 100, tools: 3, family: null, task: null,
  }
  const f = toFinding(run)
  chk('eleven columns', Object.keys(f).length, 11)
  chk('verification_state is one of them', 'verification_state' in f, true)
  chk('landed_state is one of them', 'landed_state' in f, true)
  chk('and they carry what the run measured', f.verification_state, 'passed')
  chk('landed too', f.landed_state, 'during')
  chk('a finding with all eleven validates', validateFinding(f), null)

  // Every value is an enum or a bounded number; task_class is the only text a
  // person chose, which is why the disclosure prints its values literally.
  chk('a rung outside its enum is refused',
    validateFinding({ ...f, verification_state: 'probably' }), 'invalid verification_state')
  chk('a landed state that was never defined is refused',
    validateFinding({ ...f, landed_state: 'merged' }), 'invalid landed_state')

  // `unavailable` is a member, not an absence. A validator that refused it
  // would force a machine to lie about runs it never looked at.
  chk('unavailable is a legitimate landed state',
    validateFinding({ ...f, landed_state: 'unavailable' }), null)
}

console.log(`\n   ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
