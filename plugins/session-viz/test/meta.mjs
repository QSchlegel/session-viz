#!/usr/bin/env node
// User-role records the harness wrote itself.
//
// After a slash command the harness inserts the skill's body as a user-role
// record — the whole SKILL.md, fifteen thousand characters — stamped
// `isMeta: true`. It is a real turn: the model acts on it. But nobody typed it,
// and until this file existed the spine said they had. Everything that asks
// "what did the person write" — the quote guard in the facts projection, the
// evidence package's typed bit — was handed the skill's words as the user's.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from '../scripts/extract.mjs'
import { typedPrompts } from '../scripts/facts.mjs'

let failed = 0
const chk = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'session-viz-meta-'))
const SID = 'b2c3d4e5-0000-0000-0000-000000000000'
const FILE = join(dir, `${SID}.jsonl`)
let clock = Date.parse('2026-03-04T08:00:00.000Z')
const at = () => new Date((clock += 1000)).toISOString()
let seq = 0
const uuid = () => `u-${++seq}`
const base = () => ({ uuid: uuid(), timestamp: at(), sessionId: SID, cwd: '/Users/fixtureuser/git/demo', version: '2.1.0' })
const human = (text, extra = {}) => ({ ...base(), type: 'user', message: { content: [{ type: 'text', text }] }, ...extra })
const assistant = (text) => ({
  ...base(), type: 'assistant',
  message: { model: 'claude-opus-5', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } },
})

const SKILL_BODY = 'Base directory for this skill: /plugins/x/skills/qpact\n\n# qpact\n\nAnalyse this session with /qpact, show it, and hand back a compact line.\n' + 'Read the JSON, not the raw transcript. '.repeat(300)
const TYPED = 'fix the intent path first, before the design lands'

writeFileSync(FILE, [
  human('where are we'),
  assistant('Looking.'),
  // The harness inserting the skill after the person ran a slash command.
  human(SKILL_BODY, { isMeta: true, turnCompanion: true }),
  assistant('Following the skill.'),
  human(TYPED),
  assistant('On it.'),
  // isMeta with nothing in it is not a turn at all, as before.
  human('', { isMeta: true }),
].map((r) => JSON.stringify(r)).join('\n') + '\n')

const spine = await extract(FILE)
const turns = spine.turns

console.log('\n— The skill body is a turn, and nobody typed it')
chk('three human turns: two typed, one inserted', turns.length === 3, String(turns.length))
chk('the typed prompts are typed', turns[0].typed === true && turns[2].typed === true)
chk('the skill body is not', turns[1].typed === false, JSON.stringify({ typed: turns[1].typed, head: String(turns[1].text).slice(0, 40) }))
chk('but it is still counted, with its text, as the turn the model acted on',
  turns[1].text.startsWith('Base directory for this skill') && spine.totals.humanTurns === 3)
chk('an empty isMeta record opens no turn', !turns.some((t) => t.text === ''))

console.log('\n— And the prompt set the quote guard sees is the typed ones only')
const prompts = typedPrompts(turns)
chk('two prompts, not three', prompts.length === 2, String(prompts.length))
chk('the skill’s words are not among them', !prompts.some((p) => p.includes('qpact')))
chk('the person’s are', prompts.includes(TYPED) && prompts.includes('where are we'))

rmSync(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
