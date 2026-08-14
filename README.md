# session-viz

Nine commands over the transcripts Claude Code already writes to your disk.

Nothing is sent anywhere. The plugin reads `~/.claude/projects/**`, computes locally, and opens
an HTML report. There is a hosted side, and it is entirely optional — every command below works
with no account, no token and no network.

## Install

```bash
claude plugin marketplace add QSchlegel/session-viz
claude plugin install session-viz@session-viz
```

Two steps on purpose: `install` cannot resolve a plugin from a marketplace this machine has never
added.

## Commands

| | |
|---|---|
| `/qpact` | This session: score, friction, and a `/compact` line worth running |
| `/qtrends` | Every session: gated trends across repos and model releases |
| `/qruns` | Subagent and cron runs — the delivery ledger nothing else reads |
| `/qcost` | Where the tokens actually went |
| `/qship` | Prompts you keep retyping, split into rituals and misses |
| `/qdoctor` | This repo's config, measured against your other repos |
| `/qsetup` | Connect this machine — paste the token into a page, not a shell |
| `/qshare` | Choose what your team can see — nothing by default |
| `/qteam` | Shared vaults and task handoff (needs the hosted side) |

## What it refuses to tell you

The design constraint that shapes everything: **it measures artifacts, not people.**

Not because that is a nicer thing to say, but because the numbers do not support the alternative.
Prompt-form signals are confounded with task difficulty — hard tasks get longer prompts and worse
outcomes, so "long prompts are bad" falls out of the arithmetic and means nothing. Every signal is
stratified by workload and put through a two-proportion z-test before it is shown, and most do not
survive. The ones that fail say so rather than quietly appearing anyway.

The same applies to model comparisons: releases are confounded with time, and where there are no
overlapping weeks the comparison is refused rather than estimated.

## Requirements

Node 18+ to run it. No runtime dependencies.

## Building

Sources are TypeScript in `plugins/session-viz/src/*.mts`, compiled to
`plugins/session-viz/scripts/*.mjs`. The compiled output is committed, because a plugin
is installed by cloning it — there is no build step on the machine that installs it.

```bash
npm install
npm run build     # src/*.mts -> scripts/*.mjs
npm run check     # types only, no emit
```

Edit the `.mts` sources, never `scripts/`. Each compiled script is runnable directly:

```bash
node plugins/session-viz/scripts/runs.mjs --help
```

## The hosted side

[QSchlegel/session-viz-cloud](https://github.com/QSchlegel/session-viz-cloud) is the optional
backend: person-blind fleet telemetry on one plane, identity-bearing collaboration on another, and
the two structurally unable to join. Sign in at [session-viz.com](https://session-viz.com) if you
want it. Ignore it entirely and the plugin loses nothing.

## Licence

MIT — see [LICENSE](LICENSE).
