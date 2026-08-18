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

### 5. Close out

One line: the file path, and that the `/compact` line is copyable from the top of
the page. Do not paste the instruction into chat as well — it belongs in the
window, and repeating it defeats the purpose.
