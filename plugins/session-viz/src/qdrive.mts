#!/usr/bin/env node
// /qdrive — collect instructions queued for this session from the console.
//
// -- What this is, and what it is not ---------------------------------------
// It is an INBOX. The console queues text against a session id; this asks
// whether anything is waiting and prints it. Nothing is pushed, nothing runs
// on its own, and a session that stops asking stops being reachable.
//
// It is not a remote control, and it cannot be. Claude Code offers no way for
// an outside process to type into a running session, so the only reach that
// exists is a session choosing to look — which is what this is.
//
// -- Why there is no stored opt-in ------------------------------------------
// /qlive keeps a per-session ledger with a TTL because it SENDS, repeatedly,
// after the moment somebody agreed. This only reads, and only while the skill
// is running it. When the session ends there is nothing left behind saying it
// may be steered, which is a stronger promise than a TTL and needs no file.
//
// The one thing that IS recorded is that this machine has been shown what an
// inbox means, once. That record fails closed: no record, no collection.
//
// -- Why the disclosure is its own -----------------------------------------
// Every other consent surface in this product describes what LEAVES the
// machine. This is the first thing that brings work IN, and the existing
// disclosure digest is a hash of a text about shipping reports. Reusing it
// would be counting somebody's agreement to one thing as agreement to another.

import { config, api } from './cloud.mjs'
import { loadDriveState, saveDriveState } from './home.mjs'

export const SCHEMA_VERSION = '1'

export interface DriveState {
  schema_version: string
  /** When the disclosure was printed and acknowledged on this machine. */
  shown?: { at: string; version: string }
}

/** Bumping this re-asks. The text below is the thing somebody agreed to, so a
 *  change to what it promises must not inherit the old agreement. */
export const DISCLOSURE_VERSION = '1'

export const DISCLOSURE = `
  THE SESSION INBOX — what turning this on means

  While /qdrive is running in a session, that session will ask your workspace
  whether anybody has queued an instruction for it, and will act on what it
  finds as though you had typed it.

  Who can queue one: you, and the admins of your workspace. Nobody else, and
  no machine token.

  What arrives: text somebody typed into the console. It is a prompt. Treat it
  exactly as seriously as you treat the ability to type into this terminal,
  because for the duration of this skill that is what it is.

  What does NOT happen: nothing is pushed to this machine, nothing runs when
  you are not asking, and no session is reachable unless it is running this.
  Ending the session ends it, with no state left behind.

  Where it goes: instructions are stored in your workspace for 90 days and can
  be withdrawn while uncollected. One nobody collects lapses after 30 minutes.
`.replace(/^\n/, '')

export interface Instruction {
  id: string
  sessionId: string
  body: string
  createdBy: string
  createdAt: string
  state: string
}

/** Whether this machine has been shown the disclosure. Unreadable state is
 *  NOT shown — a ledger that will not parse is a machine that cannot prove it
 *  was told, and the safe reading of that is that it was not. */
export function shown(state: DriveState | null): boolean {
  return !!state && state.shown?.version === DISCLOSURE_VERSION
}

export function recordShown(): DriveState {
  const next: DriveState = {
    schema_version: SCHEMA_VERSION,
    shown: { at: new Date().toISOString(), version: DISCLOSURE_VERSION },
  }
  saveDriveState(next)
  return next
}

/** Collect whatever is waiting. The server marks each one delivered in the
 *  same statement it returns them, so this is not idempotent by design: two
 *  calls do not hand over the same instruction twice. */
export async function collect(sessionId: string): Promise<Instruction[]> {
  const cfg = config()
  const out = await api(cfg, '/v1/instructions/claim', 'POST', { sessionId })
  return (out?.instructions || []) as Instruction[]
}

const usage = `/qdrive — collect instructions queued for this session

  qdrive.mjs --session <id>     collect what is waiting
  qdrive.mjs --disclose         print the disclosure and record that it was read
  qdrive.mjs --status           say whether this machine may collect, and why not

Nothing here pushes, schedules or runs anything. It asks, once, and prints.`

export async function main(argv: string[]): Promise<number> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (name: string): boolean => argv.includes(name)

  if (has('--help') || has('-h')) { console.log(usage); return 0 }

  const state = loadDriveState<DriveState>()

  if (has('--disclose')) {
    console.log(DISCLOSURE)
    recordShown()
    console.log('  Recorded. /qdrive can collect on this machine from now on.')
    return 0
  }

  if (has('--status')) {
    console.log(shown(state)
      ? `may collect — disclosure v${DISCLOSURE_VERSION} read ${state!.shown!.at}`
      : 'cannot collect — the disclosure has not been read on this machine; run --disclose')
    return 0
  }

  const sessionId = arg('--session')
  if (!sessionId) { console.log(usage); return 2 }

  if (!shown(state)) {
    // Fails closed, and says exactly what to do. Never prints and proceeds in
    // one run: the point of a one-run gate is that somebody reads it before
    // anything happens, not alongside the thing happening.
    console.log(DISCLOSURE)
    console.log('  NOT COLLECTED — this is the first run on this machine.')
    console.log('  Read the above, then run:  qdrive.mjs --disclose')
    return 0
  }

  let got: Instruction[]
  try {
    got = await collect(sessionId)
  } catch (e) {
    // A workspace that cannot be reached is not an instruction to do nothing;
    // it is a failure to ask, and the difference matters to whoever is waiting
    // on the other end.
    console.log(`COULD NOT ASK — ${(e as Error).message}`)
    return 1
  }

  if (!got.length) { console.log('inbox empty'); return 0 }
  console.log(`${got.length} instruction${got.length === 1 ? '' : 's'} collected:\n`)
  for (const i of got) {
    console.log(`  from ${i.createdBy} at ${i.createdAt}`)
    console.log(`  ${i.body}\n`)
  }
  return 0
}

// Run only when invoked directly, so the test can import the pure parts.
if (process.argv[1] && /qdrive\.mjs$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c })
}
