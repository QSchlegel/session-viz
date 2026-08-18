---
name: qcost
description: Where the tokens actually go — cache-read versus generated output, and how much context each agent family replays per run. Use when the user runs /qcost, asks about token spend, why their bill is high, what an agent costs, or wants to reduce context usage.
# Model-invocable, unlike the eight commands that are not. The rule: a skill may be
# reached without the user typing its name IFF it only reads this machine and prints
# to stdout. This one does. /qpact and /qtrends open a browser window, /qship --write
# writes files, and the five network commands send something — all of those stay
# behind an explicit slash command.
---

# qcost

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs --cost
```

## Before quoting money: get the rate card

```bash
curl -fsS --max-time 5 "${SESSION_VIZ_URL:-https://cloud.session-viz.com}/v1/prices"
```

Optional, and failure is not an error. This command reads only this machine, and
that stays true — the rate card is the one thing it cannot derive locally, so it
asks, and carries on without it. Offline, self-hosted with no workspace, or the
endpoint down: no currency, exactly as before.

The response carries its own age, which is the part that matters:

| field | what to do with it |
|---|---|
| `models` empty | No card. Quote no money. |
| `stale: true` | Say how old (`ageDays`) and quote no money. Offer to refresh. |
| `lastAttemptOk: false` | A refresh has been failing. Say so — `fetchedAt` is still honest, but someone should look. |
| otherwise | Quote money, labelled with `fetchedAt` and `source`. |

`fetchedAt` is the last *success* and `lastAttemptAt` the last *look*; they are
different questions and a stale card usually shows it here first. The card is
refreshed weekly by a cron in the cloud, from the published pricing page.

## The thing this exists to show

Output — text the model generated — is a rounding error on the bill. Almost
everything is **cache-read**: context replayed to the model on every turn. It
appears in no per-session view, so it is invisible exactly where people look.

On the reference corpus it was 24.7B cache-read against 86M output. Output was
under half a percent of all tokens.

## Reading it

The **spread between agent families** is the actionable number, not the total.
Families doing comparable work with a several-fold difference in cache-read per
run differ by prompt, not by model or harness — and the widest one is a file you
can edit.

The friction metrics in `/qtrends` cover a low-single-digit share of spend. If
someone is optimising for cost, this page is where the money is and that one is
not. Say that plainly rather than letting both look equally important.

## Rules

- **Money only from a dated rate card.** A dollar figure derived from an assumed
  price is an assumption rendered as a fact, so the rule was never "no currency"
  — it was "no *unsourced* currency". A fetched, dated, sourced card clears that
  bar. Check for one before quoting anything (below), and if there is none, say
  there is none rather than reaching for a remembered number: prices move, and
  the ones you remember are the ones most likely to be stale. Sonnet 5's $3/$15
  became $2/$10 permanently, and a cached answer got that wrong in this repo.
- **A list price is not the bill.** Even a fresh card is Anthropic API list
  pricing. A Claude Code subscription is not billed per token, so any figure is
  an API-equivalent cost — what these tokens *would* cost through the API — and
  must be labelled that way. Reporting it as spend is the same error the old
  no-currency rule existed to prevent, just with a better source.
- **Price per model, or say you didn't.** The corpus spans models; `models` in
  the spine says which. Pricing a mixed corpus at one model's rate is an
  assumption, so either do it per model or state the one you applied and that it
  is an upper or lower bound.
- **Cache writes have two prices.** 5-minute and 1-hour TTL differ by 1.6×. The
  snapshot does not record which was used, so name the assumption when it matters
  — on this corpus the gap between them is thousands of dollars.
- **Quote the integers beside the percentages.** There is one chart and it is
  linear: output rounds to `0%` and its bar is clamped to a single cell, so the
  composition block on its own reads as "output is nothing". Give the token
  counts too, or the one number a person can actually act on disappears.
- **Read the `not in these numbers` block out loud.** It only prints when a
  harness is missing or its token data is partial, which is exactly when a
  composition percentage will be taken for a bill. A total that silently
  excludes a whole harness is the failure this screen is most likely to cause.
- Cache-read is not waste. It is the cost of the context the agent needed. The
  question is whether it needed all of it.
