---
name: qteam
description: Work with the shared session-viz cloud — federated Obsidian vaults across projects and people, and task handoff between teammates. Resolve a [[wikilink]] against every vault you can see, find links that resolve nowhere, hand a task to a colleague with the context they need, or list what has been handed to you. Use when the user runs /qteam, mentions handing work over, asks who else has notes on something, or wants to find a concept documented in another project's vault.
disable-model-invocation: true
---

# qteam

The collaboration half of session-viz. Everything here goes through the hosted
MCP server, which reads none of the configuration the local commands read. Read
the next section before promising anyone these tools: the server accepts a stock
client now, and nobody has yet driven the browser hand-off end to end against the
public host. Those are different sentences and this file used to run them
together.

## Before anything

The MCP tools appear as `mcp__session-viz__*`. If they are absent the server is
not connected — say so plainly rather than guessing.

**There is nothing to export.** The shipped `.mcp.json` carries a bare URL and no
`env` block:

```json
{"mcpServers":{"session-viz":{"type":"http","url":"https://cloud.session-viz.com/v1/mcp"}}}
```

**The server-side refusals this file used to describe are gone.** Until
2026-08-20 the endpoint answered 401 with a `WWW-Authenticate` naming its
discovery document and then refused everything behind it: a client that
registered itself was given an id that `/authorize` would not accept, and the
advertised scopes were refused in favour of `contrib` and `collab`. Both were
fixed server-side. A client may now register itself (RFC 7591, unauthenticated),
`/authorize` resolves that registration and matches its HTTPS redirect exactly,
and the granular scopes are accepted and canonicalised into internal `collab`
authority. Codes are bound to client id, redirect and PKCE verifier, single-use,
and unredeemable by any other client.

**One refusal is deliberate and still there:** a *subset* of the advertised
scopes is rejected. Per-tool scope enforcement has not landed, so accepting
`vault:read` alone and then minting a full `collab` token behind it would grant
more than was asked. Until that lands, ask for the complete advertised set —
`vault:read vault:write task:read task:write share:read share:write events:read`
— or be refused. Order and repeats do not matter; the grant is canonicalised.

**`X-Actor` is no longer needed for this path.** An OAuth-issued token carries
the verified account that created it, and `/v1/mcp` takes the actor from there.
The header is now required only for the legacy shared `COLLAB_TOKEN`, which has
no creator to read.

**What has NOT been verified:** the signed-in browser flow, end to end, against
the public host. Nobody has yet watched a consent screen render accurate client,
redirect and scope information, redeemed the code with PKCE from a stock client,
and called `tools/list` with no actor header. The pieces are implemented and
covered by tests; the run has not happened. So if a reader's tools do not appear,
do not tell them it is their machine, and do not promise it will work either —
say that the flow is implemented but unproven against the public host, and that
the next thing anyone learns from it will come from someone actually trying it.

`SESSION_VIZ_TOKEN`, `SESSION_VIZ_ACTOR` and `SESSION_VIZ_URL` reach this server
by no path at all — the entry above has no `env` and no `headers`, so nothing
carries them into the connection. Setting them for its benefit does nothing
useful and two harmful things:

- the missing tool stays missing. The connection authenticates over OAuth and is
  not waiting on a token, so exporting one changes nothing about it, and the
  reader who believes it did stops looking for the real cause;
- those three variables **are** read by `/qshare`, `/qfeed` and `/qcontrib`
  (`config()` in `src/cloud.mts`, environment beating the config file). A
  self-hosted `COLLAB_TOKEN` exported there carries no tenant, so `/qshare` fails
  with `a tenant-scoped credential is required to share` and `/qcontrib` refuses
  it outright because it does not begin `svt_`. Exporting `SESSION_VIZ_URL` alone
  is worse still: `config()` throws rather than send the config file's token to a
  host it was not written for, and every local cloud command stops.

If a shell profile still exports them for the MCP's sake, remove them.

Self-hosting still works and still needs a hand edit: point the `url` at your own
deployment, which accepts the legacy `Bearer COLLAB_TOKEN` with an `X-Actor`
header. That header is not optional on this path — a shared token names no
creator, so `/v1/mcp` has nowhere else to read an actor from, and a bare-URL
entry has nowhere to put one. It is the path being retired rather than the one to
build against; it is no longer the *only* path that answers.

`/qsetup --scope collab` is a separate errand: it gives the plugin's own
commands plane B access. It does not configure this server, and this server does
not read what it writes.

## What it can do

**`vault_register`** — index a vault. Send paths, titles, tags and outbound link
names only. **Never send note bodies.** The server has a column for them and it
stays null; the moment a body leaves the machine this stops being a local-first
tool. Build the index by walking `*.md` for frontmatter and `[[wikilinks]]`.

**`vault_resolve`** — resolve a link across every registered vault, returning
*all* candidates with an `obsidian://` URI each. When `ambiguous` is true, show
the choices and let the user pick. Do not pick for them: silently choosing one
of three notes with the same title is how a knowledge graph starts lying.

"Every vault" means every vault in this workspace, and it does mean all of them.
Federation stops at the workspace boundary — nothing resolves into another
customer's vaults — but inside one, the `shared` flag is stored and not consulted
here. Registering a vault with `shared: false` does not hide its note titles and
paths from a colleague, so never tell the user it will.

**`vault_dangling`** — links that resolve to nothing in any vault. Useful after a
merge or a rename. Report the count before the list; most of the value is in
whether it is 3 or 300.

**`task_create` / `task_offer` / `task_accept` / `task_done` / `task_list`** —
handoff. Forwards it is `draft → offered → accepted → done`. One move goes back
through these tools: `task_offer` on an **accepted** task hands it on or returns
it to the queue. `done` is terminal — a closed task cannot be reopened, and
neither can a draft be closed directly. Anything else comes back as
`illegal transition x → y`, `task_offer` on an already-offered task included. So
an offer cannot be redirected: either the person it names accepts and hands it
on, or somebody withdraws it to `draft` with `POST /v1/tasks/<id>/draft`, which
these tools do not expose and the workspace console does not draw. Say that
plainly rather than re-offering and relaying the refusal as a failure.

A task becomes someone else's only when they accept: an offer records who it is
*for*, and an accept from anybody else is refused. So never describe a task as
"assigned" while it is merely offered.

Two things the server does **not** check, so do not report them as checked:

- whether the person being offered to is in the workspace. An address that is not
  gets an actor row and an email carrying the task title, exactly as a colleague
  would. Read the recipient back to the user before offering.
- who accepts an offer that named nobody. `task_offer` requires a recipient, but
  the REST route behind it does not, so a task offered without one can be
  accepted by anyone in the workspace.

**`events_recent`** — what has happened lately, the same stream `/v1/live` pushes.

## Writing a handoff brief

The brief is the whole point, and a bad one wastes the recipient's first twenty
minutes. Include:

- what was being attempted, and why that rather than something else
- what has already been ruled out, with the evidence
- the exact repo, branch and worktree
- what "done" looks like

No secrets, and no wholesale transcript excerpts. If the session that produced
the work is worth reading, name it — the recipient can open it locally.

`/qpact` on the session being handed over is the best source for all of this:
its intent breakdown and open threads are already the right shape.

## Steps

1. Confirm the `mcp__session-viz__*` tools are present. If they are not, stop.
   Say the server is not connected and that nothing exported here would change
   it — `SESSION_VIZ_TOKEN` is not the remedy, because this connection
   authenticates over OAuth and the shipped entry carries no `env` at all. The
   sign-in is a browser hand-off the harness drives; whether it completes against
   the public host has not been established by anyone yet, so do not assert that
   it will, and do not assert that it cannot. Report what you observed.
2. Do the smallest useful thing that was asked. This skill is a set of verbs, not
   a report generator — do not render HTML unless asked.
3. State what changed in one or two lines, including anything the server refused
   and why: an illegal transition, an accept of a task offered to somebody else,
   a vault id that is not in this workspace, an ambiguous link. Those refusals
   are information, not errors to paper over.
