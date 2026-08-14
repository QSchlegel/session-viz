---
name: qsetup
description: Connect this machine to a session-viz workspace by pasting the plugin token into a page instead of a shell.
disable-model-invocation: true
---

# qsetup

Open a page, paste the plugin token, done. Nothing else in the plugin needs it — every
other command works entirely offline against transcripts already on disk.

## Why a page and not a prompt

A token is a long opaque string that lives in a browser. Moving it through a terminal is
how it ends up in shell history, in a screenshot, or pasted into the wrong window. This
starts a server on loopback, opens one page, takes the token from the browser directly,
verifies it, writes it `0600`, and exits.

The server is deliberately small: bound to `127.0.0.1` only, on an ephemeral port the
kernel picks, guarded by a one-time nonce that is required on the POST, shut down after
one success, and abandoned after five minutes if nothing arrives.

The token is checked against the server **before** it is written. Storing an unverified
string is how a typo becomes a confusing bug in a different component three days later.

## Steps

### 1. Run it

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs
```

A browser opens. If the machine is headless, the printed URL works from anywhere that can
reach its loopback — which is to say, from that machine.

Get the token from **Tokens** in your workspace at `https://cloud.session-viz.com/app`.
It is shown once, at creation, and is not retrievable afterwards.

Two scopes exist and they are not interchangeable:

| scope | for |
|---|---|
| `contrib` | sending findings — plane A, person-blind aggregates |
| `collab` | vaults, task handoff and the MCP — plane B, identity-bearing |

### 2. Report what happened

One line: the scope and workspace it verified against, and the config path. Do not print
the token, not even partially — it is on the user's screen already and does not need to be
in the transcript too.

## Other flags

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --show     # current config, token redacted
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --forget   # delete it
```

## What it writes

`~/.claude/session-viz/config.json`, mode `0600` in a `0700` directory:

```json
{
  "url": "https://cloud.session-viz.com",
  "token": "svt_…",
  "scope": "contrib",
  "tenant": "t_example-com",
  "savedAt": "…"
}
```

`SESSION_VIZ_URL`, `SESSION_VIZ_TOKEN` and `SESSION_VIZ_ACTOR` still take precedence when
set, so a CI environment overrides the file without touching it.

The MCP server is the exception: it is configured from environment variables in
`.mcp.json` and cannot read this file. `qsetup` prints the export lines to add to a shell
profile for that, and they need a **collab**-scoped token rather than the contrib one.
