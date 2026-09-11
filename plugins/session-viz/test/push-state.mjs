// Where a "no" is written, and where it is read back from.
//
// push.json has several candidate locations. `savePush` starts at the one
// beside the config actually in use and falls through on EPERM; `loadPush` used
// to take the first that merely EXISTED. Those are not the same file, and the
// case where they differ is ordinary rather than exotic: a legacy install whose
// config.json sits in ~/.claude/session-viz, with a leftover push.json in
// ~/.config/session-viz from an earlier layout.
//
// Under an opt-in default the asymmetry could only ever lose a CONSENT, which
// fails closed and is invisible. It loses an opt-out exactly as easily, and
// that fails open — the user opts out, the write lands in one file, every later
// run reads the other, and the session keeps shipping with nothing to notice.
//
// This file needs its own HOME, which is why it is not inside ship.mjs: that
// suite fixes its environment before it imports, and the layout under test is a
// different one.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'qpact-state-'))
// The legacy shape: the config in use is the .claude one, so that is where a
// write goes — while the .config directory still holds an older push.json.
mkdirSync(join(home, '.config', 'session-viz'), { recursive: true })
mkdirSync(join(home, '.claude', 'session-viz'), { recursive: true })
writeFileSync(join(home, '.claude', 'session-viz', 'config.json'),
  JSON.stringify({ token: 'svt_legacy', url: 'https://self.hosted.invalid' }))
delete process.env.SESSION_VIZ_HOME
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.HOME = home

const { pushPaths, pushTarget, loadPush, STATE_SCHEMA_VERSION, canRecord } =
  await import('../scripts/push.mjs')

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

const paths = pushPaths()
const target = pushTarget()
const ix = paths.indexOf(target)

console.log('\n── the layout this exists for')
chk('the write target is not the first candidate', ix > 0,
  `target index ${ix}\n       ${paths.map((p, i) => `[${i}] ${p}`).join('\n       ')}`)
if (ix <= 0) {
  // Said out loud rather than passing quietly: if the layout cannot be
  // constructed, the assertions below prove nothing and must not read as if
  // they did.
  console.log('       the asymmetry is not reachable in this layout; the rest of this file would assert nothing')
  process.exit(1)
}

const stale = paths[0]
const real = target

console.log('\n── an opt-out is read back, not a stale copy from another directory')
mkdirSync(dirname(stale), { recursive: true })
// Written in the CURRENT shape: `optedOut` is the answer, and `enabled` is a
// version-1 field that only loadPush's legacy branch still reads.
writeFileSync(stale, JSON.stringify({
  schema_version: STATE_SCHEMA_VERSION, optedOut: false, url: 'https://stale.invalid',
  shown: {
    at: '2026-01-01T00:00:00Z', disclosure: { version: '1', sha256: 'x' },
    url: 'https://stale.invalid', credential: { source: 'file', fingerprint: '0'.repeat(16) }, tty: true,
  },
}, null, 2))
writeFileSync(real, JSON.stringify({
  schema_version: STATE_SCHEMA_VERSION, optedOut: true, url: 'https://self.hosted.invalid',
}, null, 2))

const got = loadPush()
chk('the record that comes back is the one the writer would write',
  got.url === 'https://self.hosted.invalid', JSON.stringify(got))
chk('the opt-out is honoured', got.optedOut === true, JSON.stringify(got))
chk('and it is reported as an opt-out rather than an absence', got.origin === 'opted-out', String(got.origin))
chk('the stale copy is still on disk, so this is about which was READ',
  JSON.parse(readFileSync(stale, 'utf8')).optedOut === false)

console.log('\n── and a machine that cannot record a choice knows it')
chk('canRecord is true where a directory is writable', canRecord() === true)

rmSync(home, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
