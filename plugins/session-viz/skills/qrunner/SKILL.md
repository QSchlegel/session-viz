---
name: qrunner
description: Run allowlisted session-viz commands on this machine when the workspace console asks. Starts Claude Code sessions here on somebody else's button press, so read the disclosure before starting it.
disable-model-invocation: true
---

# qrunner

Start a runner on this machine so commands can be triggered from the console — from a
phone, from a colleague's desk, from anywhere the workspace is open.

## Read this first, and mean it

This is the only thing in the product that **starts work on this computer because somebody
pressed a button somewhere else**. Everything about it is narrow on purpose, and the
narrowness is the only reason it is safe to offer:

- **It runs in the foreground, and the user starts it.** No daemon, no launchd, nothing
  that survives a reboot or a closed terminal. Do not offer to install one.
- **It runs a closed set of commands** — the ones the contract records as opening no
  socket at all: `/qdoctor`, `/qruns`, `/qship`, `/qtrends`. Not prompts. A run triggered
  from a phone therefore cannot itself send anything anywhere.
- **It runs them only in repositories named on the command line.**
- **One at a time.**

What it still means, and the disclosure says so plainly: a Claude Code session, with the
user's credential, with whatever file access their settings allow, spending their tokens,
begun by any member of their workspace.

## Do not run `--disclose` for them

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qrunner.mjs --disclose
```

That command records that a **person** read what starting this means. Running it on their
behalf converts a machine that would have shown somebody the disclosure into one that
accepts remote work without anyone having read it. Print the text, let them run it.

The same goes for starting the runner itself unattended. If they ask you to "keep it
running", say what that actually is — a process they should start in their own terminal
and can see — rather than backgrounding one they will forget about.

## Starting it

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qrunner.mjs --name <machine> --repo <dir> [--repo <dir>]
```

`--name` is how the console addresses this machine; it defaults to the short hostname.
Each `--repo` is a directory this runner may work in — the console offers its basename.

On start it prints what it is listening for, warns about any repository whose permissions
do not cover Write, and registers with the workspace. It appears at **`/app/runs`** in the
console within a few seconds.

## The permission warning is the one to act on

A headless run in a repository whose Claude Code permissions do not cover Write dies at
its first write, because there is nobody there to answer the prompt. The runner checks
before it spends anything and refuses with that sentence in the ledger.

If the user sees that warning, the fix is `/qdoctor` on that repository — it is the command
that already audits exactly this.

## Reading what happened

`/app/runs` carries the ledger: what ran, where, who asked, and how it went. A refused run
is a recorded outcome with its reason, not a missing row — which is the difference between
a remote you can trust and one you stop looking at.

If a run failed with an authentication error, the machine's Claude Code credential has
expired. Nothing about the runner can fix that; the user signs in again on that machine.

## Stopping it

Ctrl-C. Nothing is installed and nothing restarts, so no run begins after it exits.
