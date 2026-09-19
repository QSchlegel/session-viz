---
name: qdrive
description: Let this session collect instructions queued for it from the session-viz console, so work can be steered from a phone. An inbox the session chooses to read, never a remote control.
disable-model-invocation: true
---

# qdrive

Collect instructions queued for **this** session in the console, and act on them.

## What this actually is

Claude Code offers no way for an outside process to type into a running session. So this
is not a remote control and cannot become one. It is an inbox: the console queues text
against a session id, and this session asks whether anything is waiting.

Three consequences worth holding on to, because they are the whole safety argument:

- **Nothing is pushed.** The machine asks. A session that stops asking stops being
  reachable, immediately and with no state left behind saying otherwise.
- **The lag is one turn.** An instruction queued while you are mid-tool-call is collected
  at the next check, not the instant it was written.
- **An uncollected instruction lapses after 30 minutes.** A session that was never running
  this never receives anything at all.

## Who can queue one

The author of the session, and the admins of the workspace. Not other members, and not a
machine token — the server enforces that, and the console will not offer the box to
anyone else.

## The first run on a machine prints a disclosure and collects nothing

That is deliberate and it is not a bug to work around. An instruction is a prompt typed
by somebody who is not at this keyboard, and the disclosure says so in the plainest terms
available. It is separate from the report-shipping disclosure because that one describes
what leaves the machine and this describes what arrives.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qdrive.mjs --disclose
```

**Do not run `--disclose` on the user's behalf.** It records that a person read the text.
Running it for them turns a machine that would have shown somebody the disclosure into one
that collects without ever having done so, which is the single thing the gate exists to
prevent. Print the disclosure, and let them run it.

## Steps

### 1. Find this session's id

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/extract.mjs --json > /tmp/qdrive-spine.json
```

Read `sessionId` from it. That is the id the console queues against, and the only one
this session may collect.

### 2. Check the inbox

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qdrive.mjs --session <sessionId>
```

It prints `inbox empty`, or each instruction with who queued it and when.

### 3. Act on what arrived, then say so

Treat a collected instruction as a message from the user — because it is one, typed by
them or by an admin of their workspace, just not into this terminal. Do the work.

Then **say in chat what you collected and what you did with it.** The person who queued it
is looking at a console that says "collected", and the console cannot tell them what
happened next. This is the only place that can.

If an instruction is one you would have questioned had it been typed here, question it
here. Arriving through the console does not make an instruction more authoritative than
the person sitting at the keyboard — it makes it less, because they cannot see what you
can.

### 4. Keep checking, while it makes sense to

Re-run step 2 between pieces of work — after a build, after a test run, at the point you
would otherwise report progress. Checking on a fixed timer is worse than checking at the
seams of the work: an instruction collected mid-refactor is one you cannot act on cleanly
anyway.

Stop when the user says to, or when the session's work is done. There is nothing to turn
off: ending the session ends this.

## What this does not do

- It does not start sessions. Nothing in this product does.
- It does not reach a session that is not running this skill, including every session
  running right now on this machine.
- It does not report back automatically. Step 3 is you, in chat.
