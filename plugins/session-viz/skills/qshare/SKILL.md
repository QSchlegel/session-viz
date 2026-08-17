---
name: qshare
description: Choose which projects, sessions or autonomous runs your team can see. Nothing is shared by default.
disable-model-invocation: true
---

# qshare

Publish a specific project, session or run to your workspace so colleagues can read it.
Per item, explicitly, and never by default.

## Read this before running it

The local analysis is richer than it looks. On the corpus this was written against it
carried **67 absolute paths** including the home directory and username, and **103 fields
of verbatim prompt text**. Sharing a project means sharing what you typed in it.

Two things happen before anything leaves:

1. **Your home directory is stripped, and `cwd` is cut to its last segment.** Every
   occurrence of `$HOME` in every string becomes `~`, including one quoted mid-sentence in
   prompt text — that is where the username usually survives. The `cwd` field alone is
   reduced to a repo name. Repo names themselves survive, deliberately.

   **What this does not do:** a path outside your home directory is not touched.
   `/srv/work/acme/keys.env` leaves verbatim, and so does anything under a mounted or
   shared root. The review's `0 absolute home path(s)` line counts home paths and only
   home paths — it is not a statement about every path in the payload. If this machine
   keeps work outside `$HOME`, read `--review` before deciding.
2. **Nothing is sent without a second, separate act.** `--share` refuses without `--yes`,
   and prints the byte count, the prompt-text count and the home-path count before it
   refuses, so the first refusal is also the review. `--pick` opens with nothing selected
   and confirms at the button with the count for what you selected; ticking select-all
   confirms once more on the way in, because that one means every project on the machine.
   But the picker never prints the payload — `--review` is the only thing that shows the
   literal bytes, and it is the only way to read the prompt text before a colleague does.

A share lands in **plane B**: identity-bearing, tenant-scoped, and it names you. It never
touches the person-blind telemetry and structurally cannot — that schema has no field for
a repo name.

## Steps

### 1. Pick visually — the usual way

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qshare.mjs --pick
```

Opens a local page listing every project with the number that actually decides this:
**how many fields carry verbatim prompt text.** Sorted by it, nothing selected, and
nothing sent until the button is pressed — which asks again, with the total.

The page is served from `127.0.0.1` on a port the kernel picks, guarded by a nonce, and
shut down after one exchange. It shows absolute paths, which is safe precisely because it
never leaves the machine — and it is how the ambiguous names get disambiguated, since each
checkout is its own row.

Tell the user the count they chose and the ids that came back. Do not paste paths into
the chat.

### 1b. Or list it in the terminal

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qshare.mjs
```

### 2. Review the literal payload

Do this before the first share of any kind. It prints the exact JSON that would be sent.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qshare.mjs --review project my-project
```

Report the byte count and the prompt-text count to the user in one line. Do **not** paste
the payload into the chat — it is on their screen already, and repeating it into a
transcript is the opposite of the point.

### 3. Share it

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qshare.mjs --share project my-project --yes
```

Add `--label "Support bot"` to show a different name to the team.

### 4. Unshare

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qshare.mjs --revoke shr_1a2b3c
```

The row is deleted, not hidden. Say so plainly, and say the other half too: **what a
colleague has already read cannot be recalled.** A tool that implies otherwise is lying.

## Units

| kind | ref | what goes |
|---|---|---|
| `project` | repo name | the project summary, plus its incidents and exemplars |
| `session` | session-id prefix | that session's digest and its incidents |
| `run` | task class or run id | the matching runs from the delivery ledger |

## Requires

A **collab**-scoped token. `/qsetup` mints `contrib` by default and `/v1/share` refuses
it — `this token is scoped 'contrib' and this route needs 'collab'`. Ask for the other
explicitly:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --scope collab
```

**Only a workspace admin can approve one.** A member who runs that command gets a refusal
on the consent screen, not a token. If that happens, say so and stop — re-running without
the flag would quietly hand back a `contrib` token, and the next `--share` would fail on
the same 401 with nothing new to read.

It is not symmetric the other way: a `collab` token *is* accepted at `/v1/contrib`, so one
token can both share and contribute. A `contrib` token reaches plane A only.
