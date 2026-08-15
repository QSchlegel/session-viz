---
name: qsetup
description: Connect this machine to a session-viz workspace by signing in through the browser — no token is ever typed, pasted or shown in the terminal.
disable-model-invocation: true
---

# qsetup

Sign in in the browser, and a token arrives on disk. Nothing else in the plugin needs it —
every other command works entirely offline against transcripts already on disk.

## Why nobody types a token

A token is a long opaque bearer string. Every way of moving one by hand leaves a copy
somewhere: shell history, a screenshot, a scrollback buffer, the wrong window. Pasting it
into a local page was already better than typing it into a shell, but it still asked
somebody to hold the secret for a moment, and holding it is the part that goes wrong.

So the secret is never held. This is the RFC 8252 native-app flow:

1. this process mints a random `code_verifier` and keeps it to itself
2. its SHA-256 goes to `/authorize` through the browser
3. the person approves in a session they already have — the browser proves who they are,
   rather than a string they carry
4. a single-use `code` comes back to a loopback port here
5. this process exchanges code + verifier for the token, out of band

The code that crosses the browser is worthless without the verifier, which never left this
process. What arrives is an ordinary `svt_…` token: same list in the workspace, same
revoke button, attributed to whoever approved it.

The listener is deliberately small: bound to `127.0.0.1` only, on an ephemeral port the
kernel picks, `state` required on the callback and compared in constant time, shut down
after one callback, abandoned after five minutes.

The token is checked against the server **before** it is written. Storing an unverified
string is how a typo becomes a confusing bug in a different component three days later.

## Steps

### 1. Run it

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs
```

A browser opens on the consent screen. Sign in there if you are not already — by emailed
code, passkey, GitHub or Google, whichever that deployment offers. Approve, and the
terminal finishes on its own.

If the machine is headless, the printed URL works from anywhere that can reach its
loopback — which is to say, from that machine.

Two scopes exist, they are not interchangeable, and they are not equally available:

| scope | for | who can approve |
|---|---|---|
| `contrib` | sending findings — plane A, person-blind aggregates | any member |
| `collab` | vaults, task handoff and the MCP — plane B, identity-bearing | admins only |

`contrib` is the default. Ask for the other explicitly:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --scope collab
```

The browser is sent on to the workspace once the token is written, so the last thing the
user sees is a console that already shows this machine as connected — not a dead loopback
tab.

### 2. Report what happened

One line: the scope and workspace it verified against, and the config path. Do not print
the token, not even partially — it is on the user's screen already and does not need to be
in the transcript too.

If the output carries a `note` about the preferred location not being writable, say which
path it settled on — that is a sandboxed harness, and the next command needs to find the
same file.

## Other flags

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --show     # current config, token redacted
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --forget   # delete it
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --paste    # the old flow, for a token you already hold
```

`--paste` opens a local page with a text box instead. It is the right answer in exactly two
cases: a self-hosted server too old to have `/authorize` — which the plugin detects on its
own and falls back to without being asked — and an admin installing a token they were
handed rather than one they are about to approve.

## What it writes

One `config.json`, mode `0600` in a `0700` directory:

```json
{
  "url": "https://cloud.session-viz.com",
  "token": "svt_…",
  "scope": "contrib",
  "tenant": "t_example-com",
  "savedAt": "…"
}
```

The location is not tied to any one harness — this plugin runs under Codex and others
too, and a machine that never had Claude Code installed has no `~/.claude` to write to.
Candidates, best first:

| path | when |
|---|---|
| `$SESSION_VIZ_HOME/config.json` | set — wins outright, see below |
| `$XDG_CONFIG_HOME/session-viz/` | `XDG_CONFIG_HOME` is set |
| `~/.config/session-viz/` | the default |
| `~/.claude/session-viz/` | honoured, never preferred — installs predating this |

Reads take the first that exists, so an existing token keeps working. Writes go to the
one already in use, or to the default when there is none.

**Sandboxed harnesses.** Codex and friends confine writes to the workspace, so every
path above fails with `EPERM` and no amount of retrying helps. Point
`SESSION_VIZ_HOME` at a directory inside the workspace — it beats every other candidate,
including a config that already exists somewhere unreachable. Setting `SESSION_VIZ_TOKEN`
in the environment skips the file entirely.

`SESSION_VIZ_URL`, `SESSION_VIZ_TOKEN` and `SESSION_VIZ_ACTOR` still take precedence when
set, so a CI environment overrides the file without touching it.

The MCP server is the exception: it is configured from environment variables in
`.mcp.json` and cannot read this file. `qsetup` prints the export lines to add to a shell
profile for that, and they need a **collab**-scoped token rather than the contrib one.
