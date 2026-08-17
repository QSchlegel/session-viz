---
name: qteam
description: Work with the shared session-viz cloud — federated Obsidian vaults across projects and people, and task handoff between teammates. Resolve a [[wikilink]] against every vault you can see, find links that resolve nowhere, hand a task to a colleague with the context they need, or list what has been handed to you. Use when the user runs /qteam, mentions handing work over, asks who else has notes on something, or wants to find a concept documented in another project's vault.
disable-model-invocation: true
---

# qteam

The collaboration half of session-viz. Everything here goes through the hosted
MCP server, which reads none of the configuration the local commands read — and
against the public host, does not connect at all yet. Read the next section
before promising anyone these tools.

## Before anything

The MCP tools appear as `mcp__session-viz__*`. If they are absent the server is
not connected — say so plainly rather than guessing.

**There is nothing to export.** The shipped `.mcp.json` carries a bare URL and no
`env` block:

```json
{"mcpServers":{"session-viz":{"type":"http","url":"https://cloud.session-viz.com/v1/mcp"}}}
```

**And against the public host it does not connect yet.** The endpoint does answer
401 with a `WWW-Authenticate` naming its discovery document, but the browser
hand-off behind that header does not complete. A client that registers itself is
given an id, and `/authorize` then refuses that id — codes are issued only to the
CLI's own `session-viz-cli`. It refuses the advertised scopes too: the discovery
document offers `vault:read`, `task:write` and the rest, while the consent screen
accepts only `contrib` and `collab`. Nobody is ever shown a consent screen from
this path.

So do not tell a reader to restart and watch for a browser prompt. Say that the
hosted MCP server is not connectable from a stock entry today, the way this tool
names any harness it could not read. The fix is on the server, not on their
machine, and nothing they do locally will bring the tools up.

`SESSION_VIZ_TOKEN`, `SESSION_VIZ_ACTOR` and `SESSION_VIZ_URL` reach this server
by no path at all — the entry above has no `env` and no `headers`, so nothing
carries them into the connection. Setting them for its benefit does nothing
useful and two harmful things:

- the missing tool stays missing. The connection is not waiting on a token, so
  exporting one changes nothing about it, and the reader who believes it did
  stops looking for the real cause;
- those three variables **are** read by `/qshare`, `/qfeed` and `/qcontrib`
  (`config()` in `src/cloud.mts`, environment beating the config file). A
  self-hosted `COLLAB_TOKEN` exported there carries no tenant, so `/qshare` fails
  with `a tenant-scoped credential is required to share` and `/qcontrib` refuses
  it outright because it does not begin `svt_`. Exporting `SESSION_VIZ_URL` alone
  is worse still: `config()` throws rather than send the config file's token to a
  host it was not written for, and every local cloud command stops.

If a shell profile still exports them for the MCP's sake, remove them.

Self-hosting is the working path today, and it needs a hand edit: point the `url`
at your own deployment, which accepts the legacy `Bearer COLLAB_TOKEN` with an
`X-Actor` header. That is the path being retired rather than the one to build
against, but it is the one that answers. `/v1/mcp` rejects a credential carrying
no actor, and a bare-URL entry has nowhere to put one — so the header is not
optional.

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
   Say the server is not connected, that against the public host it cannot
   currently be connected, and that nothing exported here would change it. Do
   not offer a token, a restart or a browser prompt as the remedy — none of the
   three is one, and sending someone to hunt for a consent screen that never
   appears costs more than the plain answer.
2. Do the smallest useful thing that was asked. This skill is a set of verbs, not
   a report generator — do not render HTML unless asked.
3. State what changed in one or two lines, including anything the server refused
   and why: an illegal transition, an accept of a task offered to somebody else,
   a vault id that is not in this workspace, an ambiguous link. Those refusals
   are information, not errors to paper over.
