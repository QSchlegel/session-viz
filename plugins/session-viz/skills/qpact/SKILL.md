---
name: qpact
description: Analyse the current Claude Code session — prompting quality, friction metrics, and a derived intent breakdown carried forward from this project's earlier sessions — render it as an interactive HTML document opened in a preview window, and produce a copy-pasteable /compact instruction tuned to what the session was actually about. Use when the user runs /qpact, or asks to visualise, audit, or summarise the current session before compacting.
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

### 3. Ask the store what this project already knows

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/intent.mjs --spine /tmp/qpact-spine.json
```

This reads and changes nothing. It prints:

- **the store path.** One store per repository, keyed the way `/qbl` keys a
  backlog — the git root, with worktrees folded onto the repository they belong
  to. A run from `services/api`, or from a worktree, finds the same store the
  repository root finds. A store left under an older key is adopted and the file
  it came from is named.
- **whether this session has been analysed before**, how many runs, and the turn
  count at the last one — so you read the new turns rather than all of them.
- **what is already recorded for this session.** This is the part that saves you
  the work.
- **earlier sessions of this project**, how many sessions back each one is, and
  its headline.
- **the exact path to write the fragment to** in the next step.

**What you no longer derive from scratch.** On a re-run of the same session,
anything already recorded. Restate only what the new turns actually changed. A
field you leave out of the fragment is kept exactly as it is — same text, same
turn citations, same date it was first drawn. A field you restate is updated in
place; intents match on their title and graph concepts on their id, so saying
something again never grows a second copy of it.

**Earlier sessions are context for you, not conclusions to repeat.** Use them to
understand what this project has already decided. Do not copy them into the
fragment: they are already in the store, with their own provenance, and copying
one in would re-file it as this session's work.

### 4. Write the fragment

Write to the path step 3 printed. Include only what THIS run concluded:

```json
{
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
      {"from": "oauth-only", "to": "concept-id-or-derived-id", "label": "blocked by",
       "dashed": true, "turns": [23]}
    ]
  },
  "quality": {
    "verdict": "One or two sentences, anchored on the measured numbers.",
    "strengths": ["…"],
    "weaknesses": ["…"],
    "recommendations": ["…"],
    "turns": [12, 23]
  }
}
```

**No `sessionId` field.** The store takes it from the spine, so it cannot be
mistyped — the old instruction to "copy this verbatim, the page checks it" was a
transcription step whose only possible outcome was a page describing the wrong
session. If you do include one it must match the spine, or the merge is refused.

**`turns` is a citation, not decoration.** It is the only thing that lets a
reader check a conclusion, and it is what keeps a conclusion attributable once it
has been carried into later sessions. Cite the turns you actually drew it from.
Leave the array out when you have none — an empty list reads as "no turns cited",
which is true and useful; an invented range is neither.

Anchor every quality claim on the deterministic metrics already in the spine —
`score.deductions`, `friction`, `derived.repeatOf`, `interruptions`, `signals`,
per-turn `tokens`. The `verdict` should explain the computed score, not compete
with it. A prompt that drew three interruptions and 400k tokens is measurably
bad; a prompt that merely *reads* as vague is a guess. Where the metrics say
nothing, say nothing rather than inventing a critique.

For `compactInstruction`, write what a summariser needs in order to continue the
work: subsystems touched, decisions made and why, unresolved threads. Name things
concretely. Explicitly say what to drop.

### 4b. The graph field — optional, and separate from what was measured

The page already draws a graph from the spine alone: harness, repo, models, tools,
MCP servers, skills, packages, slash commands, permission modes, friction kinds,
and the turns that carried a signal. You do not need to restate any of that.

`graph` is for what the transcript cannot say — the decisions, defects, guards and
open threads you concluded. It is drawn as **diamonds**, dashed, with a stamp on
every panel reading "Written by the model. Not measured.", and one toggle hides the
whole layer so a reader can look at the residue.

- `id` — required, `^[a-z0-9][a-z0-9_-]{0,63}$`. Namespaced to `concept:<id>` on the
  way in, so it can never collide with or impersonate a measured node. It is also
  the merge key: the same id in a later run of this session updates that concept
  rather than adding a second one.
- `label` — required, truncated at 60 chars.
- `group` — one of `decision | defect | guard | thread | subsystem | question`.
  Anything else is left unset by the store and falls back at render time, counted
  in the dropped report.
- `anchors` — ids of **derived** nodes (`tool:Edit`, `mcp:railway`, `turn:23`).
  This is the only way the authored layer touches the skeleton. Unknown ids are
  dropped and counted, never invented.
- Caps: 60 concepts and 120 relations reach the page; the store holds more and
  says so. Overflow is reported on the page.

Everything dropped is stated under the graph with a count and a reason. Do not
try to work around a cap — the report is what makes the picture trustworthy.

### 5. Merge it in

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/intent.mjs --spine /tmp/qpact-spine.json \
  --merge <the fragment path from step 3>
```

It prints what was added, what was updated, what was **carried** untouched, and
two paths: the store, and a `render` file for this session. **Use that render
path in step 6.** It carries the session id in its name, which is the whole
repair here: `/qpact` used to write one fixed path, so analysing a second session
silently overwrote the first session's file and the next render described the
wrong work.

Every collision is named and nothing is written on a refusal:

- `session-mismatch` — the fragment declares a different session than the spine.
  Re-derive for this session, or pass `--session <id>` to file it deliberately.
- `store-unreadable` — the store will not parse. It is left exactly as it is;
  move the named file aside and the next run starts a new one. It is not read as
  empty, because an empty read would report no prior intent and then write over
  conclusions still on disk.
- `project-mismatch` — the store was written for a different repository.

### 6. Render and open

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/render.mjs /tmp/qpact-spine.json \
  --intent <the render path from step 5> --open
```

Prints the path and opens a real window. The `/compact` line sits at the top with
a Copy button.

### 6b. What the page shows, and what it does not

Say this accurately or not at all.

- The document's top-level fields hold **only this session's conclusions**. The
  page therefore attributes nothing to this session that this session did not
  produce.
- Earlier sessions travel in a separate `prior` field, and **the renderer does
  not draw it yet**. Do not tell the user the page shows carried-forward
  context — it does not. The store carries it; the page does not show it.
- Every conclusion in the document records the session it came from, the turns
  cited for it, when it was first drawn and when it was last restated, plus how
  many sessions back that is.
- **Age is not confidence.** Nothing re-checks whether an older conclusion still
  holds; a decision recorded four sessions ago may have been reversed since and
  the store cannot see that. If you mention carried-forward material in chat, say
  how old it is and say that it has not been re-checked.

### 7. Ship it to the console

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/push.mjs --ship \
  --spine /tmp/qpact-spine.json --report <the path step 6 printed> \
  --intent <the render path step 5 printed>
```

`--intent` is what carries this session's intents and concept graph into the
facts — titles, statuses, cited turns, labels and kinds; never a summary, a note
or a prior session. Without it the facts still go, with no intents, and the
console's intent page shows nothing for this session. It is the same render
path step 6 used; do not hand it a different session's file — push refuses one
whose `sessionId` is not this spine's and says so.

Run this every time, after step 6 and never before it. It prints one line either
way — where the report went, or why it stayed on this machine. **Pass through
what it printed; do not summarise it away.**

**Reports ship by default when a workspace is reachable.** There is no switch to
turn on. What there is instead is one run: the first `/qpact` on a machine prints
the whole disclosure, records that it printed it, and sends nothing. Every run
after that ships.

So on a first run this step will say NOT SHIPPED and print the disclosure. That
output is the point of the run — relay it in full. The user is being shown, once,
what every later run will send, and a summary of a disclosure is not a
disclosure.

It never fails the command. A dead network, a missing token, a server refusal and
a tenant over quota all come back as a printed reason and exit 0, because the
local report is already written and open by the time this runs. If it says NOT
SHIPPED, say so in your close-out in plain words. **A report the user believes is
in the cloud and is not is worse than one that was never sent.**

#### What you must not do on their behalf

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/push.mjs --on      # records "I have read this"
```

`--on` is the user saying they have read the disclosure. It is not a setup step
and it is not yours to run. Running it silently converts a machine that would
have shown somebody the disclosure into one that ships without ever having done
so — which is the single thing this design exists to prevent, and it is easier to
do by accident now that there is no switch to notice.

The same goes for `SESSION_VIZ_SHIP_ACK`. A disclosure printed where no terminal
was attached does not count as having been read, and that variable is how a
person says they read it anyway. Do not set it, do not suggest setting it as a
way to make an unattended run work, and do not treat a disclosure **you**
summarised as one the user read.

Turning it OFF is different, and you may do it when asked:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/push.mjs --off                  # stop shipping from this machine
node ${CLAUDE_PLUGIN_ROOT}/scripts/push.mjs --skip <session>       # this session only
node ${CLAUDE_PLUGIN_ROOT}/scripts/push.mjs --withhold-document    # keep the facts, stop the page
```

`--withhold-document` is the middle answer and worth offering when somebody is
uneasy about the page but not about the numbers: it stops sending the rendered
report — every prompt in the session, verbatim — and keeps sending the 48
bounded fields, so they stay in their team's roll-up without their prompts going
with them.

A step 7 run prints two outcomes now, and sometimes three: the page, the facts,
and a trace when the extractor was asked to keep one. Relay all of them. "Shipped"
on its own is no longer a true summary of what happened.

`push.mjs` with no arguments says what the next run would do and why, and changes
nothing.

### 8. Close out

One line: the file path, and that the `/compact` line is copyable from the top of
the page. Do not paste the instruction into chat as well — it belongs in the
window, and repeating it defeats the purpose.

If this was a re-run of a session already in the store, add one clause saying what
was reused rather than re-derived — step 5 printed the counts.

If step 7 shipped, add where it went. If step 7 did not ship for any reason other
than the switch being off, say that too — it is one clause, and it is the
difference between a user who knows and a user who thinks their report is in the
console.

## The store, in one paragraph

`intent.mjs` keeps one file per repository under the session-viz config
directory, holding every session of that project that has been analysed. It
exists because the old flow re-derived everything on every run — paying twice for
reasoning already on disk — and wrote it to one fixed path, where a different
session's analysis silently replaced it. Re-running one session now merges;
a different session is filed separately and carried forward as prior context;
and every conclusion carries which session drew it and which turns it cited, so
a conclusion from three sessions ago can never be presented as this session's
work. `--where` prints the store and what it holds; `--emit` re-emits a render
file without merging anything.
