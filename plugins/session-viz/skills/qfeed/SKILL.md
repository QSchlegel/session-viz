---
name: qfeed
description: File tasks into your team's queue from findings that passed a gate. Nothing is filed until you say so.
disable-model-invocation: true
---

# qfeed

Turn findings into tasks — for the findings that earned it.

## The thing that makes this worth having

A feeder that files a task for everything is a spam generator with a cron attached. The
value is entirely in what it **declines** to file.

Every detector reads a finding that already passed its own gate in the tool that produced
it, and two of them are stricter still:

- **`/qdoctor` notes never become tasks.** Only `level === 'gap'`. On the corpus this was
  written against, sixteen of seventeen repos have no `CLAUDE.md` — so *not* having one is
  the fleet norm, and qdoctor reports those as notes. Filing sixteen tasks from a
  measurement that explicitly declined to recommend anything would be inventing work.
- **`/qship` rituals need more than qship's own bar.** qship promotes on "seen in 2+
  sessions and always ran tools", which is right for a list a person skims. Filing a task
  commits someone's attention. At qship's threshold the first real run proposed tasks for
  *"yes please"*, *"Try again"* and *"commit and pr"*. The feeder requires three sessions,
  a median of three tools, and twenty characters. That took 24 candidates down to 3.

## Steps

### 1. See what qualifies

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qfeed.mjs
```

Each line carries the evidence it rests on. Report the count and the detectors, not the
full briefs.

### 2. Read the task bodies

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qfeed.mjs --review
```

### 3. File them

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qfeed.mjs --push --yes
```

`--push` without `--yes` refuses and tells you to review first.

### 4. Close what no longer holds

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qfeed.mjs --close
```

Closes only tasks **this tool filed** whose finding has gone away. A task a person wrote
has no `source` and is never touched.

It can only close a task somebody has **accepted**. `accepted → done` is the only way into
`done`, and a filed task starts in `draft`, so a stale task nobody picked up comes back
`409 illegal transition draft → done` — and because the closes run in sequence with no
guard, the first one ends the command and the rest are never attempted. On an untouched
queue `--close` therefore does nothing but fail. Relay that 409 as what it is rather than
as a broken tool, and withdraw the task in the console instead; do not work around it by
offering and accepting the task on somebody's behalf, because an acceptance is a person
saying they will do the work.

## Running it on a schedule

Safe to run daily. Each task carries a stable `source` — `qruns:stalled:<task>` — and the
server upserts on it, so a second run refreshes the evidence on the existing task instead
of filing the finding again.

`state` is deliberately **not** touched on update: a task somebody has already accepted or
closed is not dragged back to draft because the underlying condition is still true.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qfeed.mjs --push --yes && \
node ${CLAUDE_PLUGIN_ROOT}/scripts/qfeed.mjs --close
```

The `&&` is not a safety chain — `--push` has already written by the time `--close` runs.
Expect the pair to exit non-zero on any day a stale task is still sitting in `draft`, for
the reason under step 4. Nothing is lost when it does; the filing half is complete.

## Detectors

| detector | fires when | gate |
|---|---|---|
| `qruns:stalled` | a recurring task has delivered nothing | ≥5 runs, 0 delivered |
| `qruns:schema` | a subagent family fails its output contract | ≥25 structured runs, >2× the fleet median **and** >5 points above it |
| `qdoctor:gap` | config the fleet agrees on, one repo lacks | `level === 'gap'` only |
| `qship:ritual` | a procedure being retyped | ≥3 sessions, ≥3 count, ≥3 median tools, ≥20 chars |

A detector that fires on nothing is working. On the corpus this was written against,
`qruns:schema` produces zero — the four families are 8%, 7%, 1% and 1%, and 8% is not
twice a median of 7%.

## Requires

A **collab**-scoped token — tasks are plane B, and `/v1/tasks` refuses a `contrib` one
with `this token is scoped 'contrib' and this route needs 'collab'`. `/qsetup` mints
`contrib` by default, and only a workspace admin can approve the other, so ask for it
explicitly and stop if the consent screen refuses:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --scope collab
```

`--push` and `--close` additionally need an actor label: every task write is rejected with
`X-Actor required` when the token carries none. `/qsetup` fills it from the harness it ran
under, so a setup performed from a plain shell or a cron job can leave it empty —
`qsetup.mjs --show` prints what it settled on, and `SESSION_VIZ_ACTOR` sets it. Reading
(`qfeed.mjs` bare, and `--review`) needs neither.
