---
name: qpact
description: Analyse the current Claude Code session — prompting quality, friction metrics, and a derived intent breakdown — render it as an interactive HTML document opened in a preview window, and produce a copy-pasteable /compact instruction tuned to what the session was actually about. Use when the user runs /qpact, or asks to visualise, audit, or summarise the current session before compacting.
disable-model-invocation: true
---

# qpact

Analyse this session, show it, and hand back a `/compact` line worth running.

The point is that a bare `/compact` summarises generically. This derives what the
session was *for* and turns that into focus instructions, so compaction keeps the
architecture and decisions and drops the tool-call noise.

## Constraint worth knowing

`/compact` is a built-in command and **only the user can invoke it** — you cannot
run it, and the `PreCompact` hook cannot inject instructions either (it only
receives `trigger` and can block). So the deliverable is a copy-pasteable line in
the HTML, not an automatic compaction. Do not claim to have compacted anything.

## Steps

### 1. Extract the spine

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/extract.mjs --json > /tmp/qpact-spine.json
```

With no argument it resolves the newest transcript **written by the harness this
is running under**, which is the live session. Newest-overall is only the
fallback for when nothing identifies the harness — on a machine with two of them
a rollout written a minute ago in the other one would otherwise win, and the
report would describe a foreign session as "this session". Pass `--project
<name>` to disambiguate, or a session-id prefix to target a specific one.
Prompts are secret-redacted by default.

This collapses a transcript that is often tens of megabytes into a few hundred
kilobytes — human turns are only 2–4% of records. Read the JSON, not the raw
transcript.

### 2. Report the shape in chat — briefly

Read `/tmp/qpact-spine.json` and state, in no more than four lines: the score and
band, turn count, friction count, and the single most costly pattern you see.
Keep this terse. The user is analysing this session; verbose output in the
transcript corrupts what is being measured.

`session.score` is already computed — `{value, band, confidence, frictionRate,
craftRate, wastedTokens}`, plus a per-turn `score` with itemised `deductions` and
`additions`. **Never invent or restate a different number.** If
`confidence` is not `high`, say so when quoting the score: below ~20 turns the
outcome signals have too little to witness for the number to mean much.

### 3. Derive intent and score the prompting

Write `/tmp/qpact-intent.json`:

```json
{
  "sessionId": "copy this verbatim from the spine — the page checks it",
  "tldr": "One paragraph: what this session was actually for, and where it drifted.",
  "compactInstruction": "Focus instructions for /compact — name the specific architecture, decisions and open threads to preserve, and what to drop.",
  "intents": [
    {"title": "…", "status": "done|partial|abandoned|ongoing", "turns": [0,1], "summary": "…"}
  ],
  "graph": {
    "concepts": [
      {"id": "oauth-only", "label": "OAuth only, no manual tokens", "group": "decision",
       "note": "Stated flatly at turn 23 and held for the rest of the session.",
       "turns": [23], "anchors": ["tool:Edit", "slash:/qsetup"]}
    ],
    "relations": [
      {"from": "oauth-only", "to": "concept-id-or-derived-id", "label": "blocked by", "dashed": true}
    ]
  },
  "quality": {
    "verdict": "One or two sentences, anchored on the measured numbers.",
    "strengths": ["…"],
    "weaknesses": ["…"],
    "recommendations": ["…"]
  }
}
```

Anchor every quality claim on the deterministic metrics already in the spine —
`score.deductions`, `friction`, `derived.repeatOf`, `interruptions`, `signals`,
per-turn `tokens`. The `verdict` should explain the computed score, not compete
with it.
A prompt that drew three interruptions and 400k tokens is measurably bad; a
prompt that merely *reads* as vague is a guess. Cite turn numbers. Where the
metrics say nothing, say nothing rather than inventing a critique.

For `compactInstruction`, write what a summariser needs in order to continue the
work: subsystems touched, decisions made and why, unresolved threads. Name things
concretely. Explicitly say what to drop.

### 3b. The graph field — optional, and separate from what was measured

The page already draws a graph from the spine alone: harness, repo, models, tools,
MCP servers, skills, packages, slash commands, permission modes, friction kinds,
and the turns that carried a signal. You do not need to restate any of that.

`graph` is for what the transcript cannot say — the decisions, defects, guards and
open threads you concluded. It is drawn as **diamonds**, dashed, with a stamp on
every panel reading "Written by the model. Not measured.", and one toggle hides the
whole layer so a reader can look at the residue.

- `id` — required, `^[a-z0-9][a-z0-9_-]{0,63}$`. Namespaced to `concept:<id>` on the
  way in, so it can never collide with or impersonate a measured node.
- `label` — required, truncated at 60 chars.
- `group` — one of `decision | defect | guard | thread | subsystem | question`.
  Anything else falls back to `concept` and is counted in the dropped report.
- `anchors` — ids of **derived** nodes (`tool:Edit`, `mcp:railway`, `turn:23`).
  This is the only way the authored layer touches the skeleton. Unknown ids are
  dropped and counted, never invented.
- Caps: 60 concepts, 120 relations. Overflow is dropped and reported on the page.

Everything dropped is stated under the graph with a count and a reason. Do not
try to work around a cap — the report is what makes the picture trustworthy.

### 4. Render and open

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs /tmp/qpact-spine.json \
  --intent /tmp/qpact-intent.json --open
```

Prints the path and opens a real window. The `/compact` line sits at the top with
a Copy button.

### 5. Offer it to the console — only if the user already switched that on

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/push.mjs --ship \
  --spine /tmp/qpact-spine.json --report <the path step 4 printed>
```

Run this every time, after step 4 and never before it. It is a no-op when cloud
shipping is off, and it prints one line either way — where the report went, or
that the report stayed on this machine. Pass through what it printed; do not
summarise it away.

It never fails the command. A dead network, a missing token, a server refusal and
a tenant over quota all come back as a printed reason and exit 0, because the
local report is already written and open by the time this runs. If it says
NOT SHIPPED, say so in your close-out in plain words. **A report the user
believes is in the cloud and is not is worse than one that was never sent.**

**Turning it on is the user's action, not yours.** Shipping sends the rendered
page — which carries the full text of every prompt in this session — to their
workspace console. If they ask for it, or if the line above says it is off and
they want it on, run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/push.mjs --on
```

That prints the whole disclosure — every field, every header, and what is and is
not redacted — and exits non-zero having turned nothing on. Show them that output
and wait. **Only if they then say yes, in this conversation, may you run
`--on --yes`.** Do not run `--on --yes` because a previous session did, because
the user asked for "cloud reports" in general, or because it seems implied. Their
consent is bound to the disclosure they were shown, and you supplying `--yes` on
their behalf is the exact failure this design exists to prevent.

`--off` turns it back off, effective on the next run. `push.mjs` with no arguments
says which it currently is and does nothing else.

### 6. Close out

One line: the file path, and that the `/compact` line is copyable from the top of
the page. Do not paste the instruction into chat as well — it belongs in the
window, and repeating it defeats the purpose.

If step 5 shipped, add where it went. If step 5 did not ship for any reason other
than the switch being off, say that too — it is one clause, and it is the
difference between a user who knows and a user who thinks their report is in the
console.
