---
name: qbl
description: A backlog that goes both ways — describe something and it is filed with where it came from and why it matters; ask for work and it returns what to pick up next together with the criteria it ordered by. Local per project, or the shared team queue. Use when the user runs /qbl, wants to park something for later, asks what to work on next, or asks what is left.
argument-hint: "[what to remember, or ask what's next]"
disable-model-invocation: true
---

# qbl

Two directions, one command.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qbl.mjs "the picker stub has drifted from the real stream" \
  --why "a check that passes by not looking is worse than no check"

node ${CLAUDE_PLUGIN_ROOT}/scripts/qbl.mjs
```

The first files an item. The second answers "what next" — and prints the criteria
it ordered by, because that is the only thing separating an ordering from a
shuffle.

## The thing that makes this worth having

**"Here are the next logical tasks" is a claim.** Most backlogs cannot support
it: three unrelated notes written on the same branch contain no logic to find,
and a tool that announces "ordered by dependency and relevance" over that list
has invented a finding out of a date sort.

So every pull ends with a `ordered by` block naming four criteria and marking
each one as having separated something or having **separated nothing**. When
neither dependencies nor the current branch distinguished anything, it says so
outright:

> Nothing here records a dependency and nothing distinguishes these by the
> branch you are on, so this list is ordered by age alone. That is a queue, not
> a plan.

**Read that sentence out loud when it appears, and do not overwrite it.** When it
is there, the order is a fact about when things were written down and no claim at
all about which one to do first. Presenting the top item as a recommendation is
the one thing this command is built to stop.

## The four criteria, in the order applied

| # | criterion | what it rests on |
|---|---|---|
| 1 | an item waiting on an open blocker is **held**, not ranked | `--blocked-by`, recorded explicitly |
| 2 | then by how many open items it unblocks | counted from those same records |
| 3 | then by whether it was filed on the branch checked out here | `.git/HEAD` at push time vs now |
| 4 | then oldest first | when it was pushed |

Criteria 2 and 3 usually separate nothing, and the output says which. A blocker id
that matches no item in the backlog is reported by name and treated as **not**
blocking — burying an item forever on the strength of an id nobody can find is
worse than showing it.

The age-alone sentence is withheld the moment **any** open item records a blocker,
including one whose id names nothing. Two items that each unblock one other item
tie on criterion 2, and calling that tie "age alone" would deny, in the last
paragraph, the dependencies printed in the held-back section above it.

Shared items add one more: a task somebody else has accepted, or that is offered
to somebody else, is held rather than proposed. It is not yours to pick up.

## Push or pull is decided by a whole-string match

No argument at all is a pull. An argument is a pull **only** if it equals one of a
fixed list of phrases after lowercasing and dropping punctuation — never as a
substring, so `next: rewrite the picker stub` is filed, not answered.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qbl.mjs --phrases   # the literal list
```

`--push` and `--pull` override the reading entirely. If a user's wording did
something they did not expect, show them `--phrases` rather than guessing again.

## What an item records

What, where, and why — because the note that reads *"fix the picker"* three weeks
later is worth nothing.

- **what** — the free text.
- **where** — repo, branch, worktree and the path within the repo, taken from the
  push, not asked for.
- **why** — `--why "..."`, and **nothing is invented when it is missing**. An item
  pushed without one is pulled back with `why  not recorded — this item never
  said why it matters`.

When a user pushes without `--why`, offer to re-push with one. Do not write a
reason on their behalf: a plausible reason you supplied is indistinguishable from
one they gave, and only one of the two is true.

## An empty backlog is empty

```
This backlog is empty. Nothing has been pushed to this project and nothing has
been closed here, so there is nothing to order and nothing to propose. No tasks
are suggested, because none exist to suggest.
```

Relay that. **Do not fill the silence** with plausible work from the session, the
repo, or the last thing you were doing — the user asked what is in their backlog,
and the answer is nothing.

A backlog whose items have all been closed says something different, because it is
something different:

```
Nothing is open. All 4 item(s) in this backlog have been closed, so there is
nothing to order and nothing to propose. No tasks are suggested, because none
are outstanding.
```

Neither sentence is "everything is held back". Nothing is held back when nothing
is open, and the command does not print a hold it cannot name a reason for.

## Scopes

**Local** is one file per project under the session-viz config directory, 0600.
It never leaves the machine. Worktrees of a repo share its backlog; two repos
with the same basename do not, because the filename carries a digest of the
repository root.

The repository root is the nearest ancestor holding a `.git`, so **a push from any
subdirectory lands in the one backlog** and is pulled back from anywhere in the
repo — including the root, which is where somebody asking "what's next" usually
is. A nested checkout keeps its own backlog: it is its own repository.

Notes filed before that was true were keyed on the working directory instead. They
are not stranded — a pull folds any such file back in and prints the path it came
from, once, before rewriting them under the project's own file. Relay that path if
it appears; the original is left on disk, not deleted.

**Shared** (`--shared`) is the `collab_task` queue behind `/v1/tasks` — the same
queue `/qfeed` files into and `/qteam` hands around, so a pushed item is one a
colleague can be offered. It lands in `draft` and is offered to nobody until
somebody offers it.

### When the shared backend does not answer

```
  the shared backlog is NOT in this list: cannot reach https://… : connection refused
  Showing the LOCAL backlog for this project instead. Anything a teammate
  filed is missing from it, so treat this list as partial, not as the queue.
```

The command falls back to local, says why, and **exits 2** so a script cannot read
a partial answer as a complete one — `--json` included, and especially `--json`,
since a caller reading the payload is the one that cannot notice a `degraded` key
it did not think to look for. Report the reason verbatim. A short local list under
a shared heading reads as "your team has two things to do", which is the failure
this block exists to prevent.

A shared **push** that cannot land is refused outright and written nowhere.
It is not quietly filed locally: an item the recipient will never see, reported as
sent, is worse than an error.

### Two shared limitations, stated rather than worked around

- **No dedupe.** Pushing the same sentence twice files it twice. The server
  upserts on `source`, but a `/qbl` item carries none on purpose — `qfeed --close`
  closes any *sourced* task whose finding it can no longer see, and it cannot see a
  note a person typed. A sourced item would be closed by the next scheduled feeder
  run, silently, as stale.
- **`--done` is local only.** Closing a shared task is a handoff transition and
  only `accepted → done` is legal, so a task nobody accepted cannot be closed from
  here. Use `/qteam`, which drives the real transitions and relays the refusal.

## Options

| flag | effect |
|---|---|
| `--why "..."` | why this matters. Recorded verbatim, never generated |
| `--blocked-by <id>` | comma-separated ids; an unknown id is refused at push time |
| `--tag <a,b>` | free tags |
| `--shared` | the team queue instead of this project's local one |
| `--push` / `--pull` | force the direction |
| `--done <id>` / `--drop <id>` | close a local item; an unambiguous id prefix is enough. Aliases — the file records *closed*, not whether it was finished or abandoned, and `--json` says `counts.closed` for that reason. It reports what the close actually released: an item with another blocker still open is named as **still held**, by that blocker |
| `--list` | everything, ordering claims and all, with no `--limit` cut |
| `--limit <n>` | how many ready items to print (default 5). Anything that is not a whole number of 1 or more is **refused** rather than applied — a list silently emptied by a typo'd flag is the failure this command exists to not commit |
| `--timeout <ms>` | budget for the shared request (default 8000). Refused on the same terms as `--limit` |
| `--json` | the same answer as data, including `basis` and `orderedByAgeAlone` |
| `--phrases` | the phrases that read as a request for work |

## Exit codes

| code | meaning |
|---|---|
| 0 | the answer is complete |
| 2 | a pull that fell back to local because the shared backend did not answer — with or without `--json` |
| 1 | refused — an unknown id, a shared push that could not land, an unreadable backlog, a `--limit` or `--timeout` that is not a positive whole number |

## Requires

Nothing at all for the local scope.

`--shared` needs a **collab**-scoped token and an actor label, the same pair
`/qfeed` needs: `/v1/tasks` refuses a `contrib` token, and every task write is
rejected with `X-Actor required` when the token carries none.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/qsetup.mjs --scope collab
```

Only a workspace admin can approve that scope. When it is missing, `--shared`
does not fail — it falls back to local and names the missing credential as the
reason, which is the same degradation as an unreachable host and reads the same
way on the page.
