# The claims contract

A claim is anything this product tells somebody who cannot check it themselves: a count, an
enumeration, a ceiling, a promise about what leaves their machine.

Until this directory existed, each one was kept true by hand in every place it appeared, and the
code said so out loud. `services/api/src/report.ts` in the sibling repository carries *"If one of
the two ever moves, both move"* about a ceiling this repository also defines — a promise addressed
to a future reader, with nothing to enforce it. An inventory of both trees found **825 claim
statements, 71 distinct claims, and 35 pairs that already disagreed**, including four simultaneous
answers to how many commands there are and a headline privacy sentence that was generous by two.

`claims.json` holds each value once. The generator writes it into constants and tables; the drift
suite refuses to let any surface say something else; the derives prove the value is still true of
the code rather than merely agreed upon.

## Why it is here and not inside the plugin

A plugin install is a copy of `plugins/session-viz/`, so anything in there ships to every user.
This is build-time and CI tooling and has no business in an installed tree. It is also why the
registry lives in this repository rather than the cloud one: this repository is public and MIT, so
the cloud can verify its vendored copy against `raw.githubusercontent.com` with no credential.
Invert the ownership and the public workflow would need a secret to check its own copy.

## Generated, or checked — and why most claims are only checked

```
generated   a literal. A constant, a table row, an enumeration whose content IS the enumeration.
checked     a number inside a sentence somebody wrote. The registry pins the number; the writer
            keeps the sentence.
```

The second is the larger half deliberately. The prose in these two repositories is the best thing
in them, and a sentence assembled from a template reads like one. `count-word` normalisation means
"twelve" and `12` compare equal, so a writer may phrase a claim naturally and still be held to its
value.

It is also what lets a JSON manifest join the registry at all: `marketplace.json` cannot carry a
comment, so it cannot carry a region marker, so it can be checked and never generated. A marker
smuggled into a manifest string is a marker that ships to users.

## Regions

A region is a comment pair in the host language. The comment is the only thing that authorises a
machine to overwrite that span — the same reasoning `install.mts` gives for its own marker, where
`<!-- installed by session-viz` is the only thing that lets `--uninstall` delete a file.

```ts
// <contract:limits.document_bytes> generated from contract/claims.json — do not edit
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
// </contract:limits.document_bytes>
```

Interiors only. The doc comment above the constant and the twenty-five-line header explaining *why*
8 MiB stay hand-written. Generate the literal, never the argument around it.

## Tells

A `tell` is a phrasing that is **wrong now** — not merely a phrasing of the claim. `"never open a
socket"` is true of the four commands that do not open one; forbidding those words would fail a
corrected sentence and teach the next writer to widen the pattern until it asserts nothing. Tells
catch a retired claim reappearing; the `checked` entries pin the numbers.

The bound is worth stating: a tell catches a *known* wording in a new file. A paraphrase — "no
packets leave your laptop" — sails through. The hole is the size of how many wordings somebody
thought of, and no check here closes it.

## Two files, one question each

`claims.json` owns **membership**: which claims exist and what each one's value is.
`facts.json` owns **shape**: for the facts sidecar, what each field is, what it may hold, and
which tier it belongs to — plus a `refuses` block naming what the spine carries and the payload
must not.

They are cross-checked. The registry's `facts.index.fields` must name exactly the index-tier
fields in `facts.json`, and the derive runs the real projection and reports the keys it actually
writes. Three things therefore have to agree — the schema, the registry, and the code — so any one
of them moving alone is visible.

## Asserted, or planned

A claim is either true of the tree now (`asserted`, the default) or intended and not built yet
(`planned`).

The second is not a hedge. It is the only honest way to write a claim down before the behaviour
exists: a registry that asserted the intended model would state something false with a machine's
confidence behind it, which is the failure it exists to prevent. Seeding `tells` against the
*current* model has the same problem pointing the other way — it would forbid sentences that are
true today.

So a planned claim carries its `checked` surfaces as a **definition of done**, and is reported
rather than failed. It may not `generate` (that would write a value into code which does not
implement it) and it must carry a `plan` saying what has to be built first.

The assertion runs backwards, and that is what keeps it honest:

> **A planned surface that matches is a failure.**

The thing became true and nobody flipped the status, so the registry now understates what the
product does — the same drift as overstating it. You cannot park a claim in `planned` once the
tree agrees with it.

## Skew, and why values are immutable

This server redeploys. A plugin install does not: it is a copy in a version-keyed cache directory
that nothing updates, so a value baked into a shipped plugin is permanent. Each claim therefore
declares a discipline.

| discipline | means |
|---|---|
| `frozen` | the plugin's own behaviour. Nothing outside it can change this. |
| `server-first` | the server must widen before the plugin does. An older plugin under-using a wider server is fine; the reverse is a user told their upload failed for a reason nobody can explain. |
| `negotiated` | the server owns it and the plugin quotes it. Never rendered into a consent disclosure. |

A `consent_material` claim must be `frozen`, and the well-formedness check refuses any other
combination. The reason is the whole design in one paragraph: rendering a server-owned value into
the digested disclosure gives you a choice of two failures — a stored consent covering text that is
now false, or a digest that moves the moment an operator edits a retention setting, switching
shipping off for every user at once, silently, for a reason having nothing to do with what leaves
their machine.

## Running it

```bash
node contract/derive.mjs --list           # what can be recomputed from the tree
node contract/derive.mjs commands.outbound
node contract/derive.mjs --prove          # break each claim on purpose, assert the derive notices
node contract/generate.mjs verify         # regenerate into memory and diff
node contract/generate.mjs write          # rewrite the regions in place
node plugins/session-viz/test/claims.mjs  # the whole suite, both trees
```

The suite reads the sibling repository when it is checked out beside this one and prints what it
skipped when it is not. A check that silently covers half of what it names is the shape of a green
build that proves nothing.
