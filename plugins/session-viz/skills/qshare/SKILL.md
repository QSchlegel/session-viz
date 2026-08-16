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

1. **Machine-local detail is stripped.** An absolute path becomes a repo name; a home
   directory becomes `~/`. Repo names survive — that is deliberate — but the route to them
   does not, because a parent folder can name a client and a username is not analysis.
2. **You cannot share what you have not reviewed.** `--share` refuses without `--yes`, and
   tells you how many prompt-text fields are in the payload first.

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
node ${CLAUDE_PLUGIN_ROOT}/scripts/qshare.mjs --review project dw-ai-support
```

Report the byte count and the prompt-text count to the user in one line. Do **not** paste
the payload into the chat — it is on their screen already, and repeating it into a
transcript is the opposite of the point.

### 3. Share it

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qshare.mjs --share project dw-ai-support --yes
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

A token from `/qsetup`. Sharing needs a **collab**-scoped token, not the `contrib` one —
they are different planes and each is refused where the other belongs.
