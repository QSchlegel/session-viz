---
name: qruns
description: The delivery ledger for autonomous work — every scheduled run, subagent and workflow agent on this machine, with what it actually shipped. Shows which recurring tasks produce nothing, which runs died on a permission prompt, and how each one terminated. Use when the user runs /qruns, asks what their agents or cron jobs are doing, why a scheduled task is not producing output, or wants to see subagent activity.
# Model-invocable, unlike the nine commands that are not. The rule: a skill may be
# reached without the user typing its name IFF it only reads this machine and prints
# to stdout. This one does. /qpact and /qtrends open a browser window, /qship --write
# writes files, and the five network commands send something — all of those stay
# behind an explicit slash command.
---

# qruns

`/qpact` and `/qtrends` both throw away the runs with no human in them, on
purpose — it keeps the prompting statistics honest. Those runs are the majority
of everything that executes and almost all of the token spend.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs
node ${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs --json > /tmp/qruns.json
```

Tens of seconds for a few thousand runs — it reads every transcript on the
machine, and the Cursor root is one multi-gigabyte SQLite database rather than a
tree of files. `--since 30d` narrows the window.

## Read it in this order

1. **Recurring tasks.** Three markers, three meanings, and only two are problems:
   - `<< BLOCKED` — it tried to write and was refused. A settings line fixes it.
   - `<< SILENT` — it meant to write, nothing landed, and nothing refused it.
     No settings change explains this; somebody has to read a transcript.
   - `·· quiet` — every run ended coherently having decided there was nothing to
     do. **This is not a finding.** Do not report it as one, do not send anybody
     to `/qdoctor` for it, and do not call it a task that "delivers nothing" — a
     job whose correct answer is often "no change" is working.

   BLOCKED and SILENT are the headline, and they are usually a surprise, because
   a failing task looks healthy: coherent transcripts, sensible plans, often no
   errors at all.
2. **The `denied` column.** A permission the job was never granted. Headless runs
   cannot answer a prompt, so they die at the first write. The fix is a settings
   line, not a prompt change — check `permissionCoversWrite` with `/qdoctor`.
3. **Terminal states.** `completed_structured` is success. `unknown` means the
   classifier could not name how the run ended; report the count and do not
   guess at it.
4. **Subagent families.** Cache-read per run varies severalfold between families
   doing comparable work. That spread is the cheapest thing on the page to fix.

## Reporting rules

- **`cost/delivered` prints `undefined (N runs, X out, 0 delivered)` when nothing
  shipped.** Do not convert that to ∞, 0, or "N/A" — the honest output of a zero
  denominator is a refusal plus both raw numbers.
- **Never call `wrote_ok` "delivered".** No filesystem probe runs, so a write is
  a tool-result observation. The distinction matters the moment someone asks
  whether the file is really there.
- **Read the `not in these numbers` block out loud when it appears.** It prints
  only when a harness is missing or its token data is partial, and is silent
  otherwise — so when it is there, a whole harness may be absent from the ledger
  above. A blocked task that never shows up because its harness was not read is
  the exact failure this page exists to catch, reported as an all-clear.
- Subagent families come from a first-message heuristic. Say so when you quote a
  per-family number.
- If a task is BLOCKED or SILENT, say what it cost and how long it has been that
  way. "17 runs, 30 days, nothing" lands; "delivery rate 0%" does not. A quiet
  task needs no such sentence: say how many runs ended with nothing to do, or say
  nothing at all.
- **Never quote a task's zero as evidence that autonomous work does not deliver
  without checking its verdict first.** A quiet task's zero is the system
  working.

## What to do next

A BLOCKED task → `/qdoctor` on that repo, then add the allow entry; its
`permission` count is the evidence. A SILENT task → open its most recent
transcript, because no settings change will explain it. A quiet task → nothing. A wide cache-read spread → look at the widest family's opening
prompt. Neither of those is a prompting problem, which is the point of having
this separate from `/qtrends`.
