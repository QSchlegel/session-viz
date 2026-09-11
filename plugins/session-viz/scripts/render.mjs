#!/usr/bin/env node
// Renders an extracted session spine into a self-contained interactive HTML doc.
//
//   node render.mjs spine.json [--intent intent.json] [-o out.html] [--open]
//
// The spine is deterministic (from extract.mjs); the intent file is optional and
// carries the model-derived TLDR, intent breakdown and the /compact instruction.
// Keeping them separate means the visual layer never depends on inference.
import { readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { dirname, join } from 'node:path';
import { version } from './version.mjs';
import { unlinkSync, readdirSync, statSync } from 'node:fs';
import { jsonForScript } from './html.mjs';
import { deriveGraph, mergeAuthored, mergeDependencies, layoutGraph } from './graph.mjs';
import { readSbom, matchImportRoots } from './sbom.mjs';
import { brandCss, brandHeader, brandFooter } from './brand.mjs';
import { buildBundle, bundleScript, BUNDLE_GLOBAL, DOWNLOAD_HOOK, pathLimit } from './bundle.mjs';
/**
 * The turns an intent cites, wherever the document put them.
 *
 * One function so the prompt, the appendix and the graph cannot disagree about
 * which turns a thread named -- three readings of one field is how a page ends
 * up attributing a file to a task its own drill-down does not mention.
 */
const citedTurns = (i) => (i?.turns ?? i?.provenance?.turns ?? []).filter((n) => Number.isInteger(n));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const fmtDur = (ms) => {
    const s = Math.round(ms / 1000);
    if (s < 60)
        return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60)
        return m + 'm';
    const h = Math.floor(m / 60);
    return h < 48 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`;
};
const FRICTION_LABEL = {
    interrupted: 'interrupted',
    repeated: 'repeat',
    correction: 'correction',
    'drew-correction': 'drew correction',
    roundtrip: 'round-trip',
};
// Colour encodes kind WITHIN a layer; it never carries the derived/authored
// distinction, which is shape's job. Two palettes rather than one, because the
// graph is no longer painted on a permanent dark rectangle: the same mid-tone
// that reads as a colour against #131218 washes out to grey against #f4f1ec.
// Kinds are keyed identically in both, and the light values are the darker,
// more saturated members of the same hue families.
const KIND_DARK = {
    session: '#e0894a', harness: '#68b3b3', repo: '#e0894a', model: '#6a9fd4',
    tool: '#8fbc6b', mcp: '#68b3b3', skill: '#d9b45c', cli: '#8fbc6b',
    package: '#6a9fd4', stack: '#c47ab0', ext: '#c47ab0', slash: '#d9b45c',
    mode: '#a0a0a8', friction: '#d06a5a', turn: '#9a9aa4',
    decision: '#4ade80', defect: '#f87171', guard: '#fbbf24',
    thread: '#c084fc', subsystem: '#60a5fa', question: '#a8a29e', concept: '#a8a29e',
    // The three kinds the authored layer gained when the intents became a
    // structure. `intent` is the thread itself, `status` the hub its siblings
    // share, `prior` the hub an earlier session's conclusions hang off. Same hue
    // families as the rest, and -- like every other entry here -- colour within
    // the layer only: the diamond is what says authored, and the ring is what
    // says carried.
    intent: '#f0a868', status: '#8b8b95', prior: '#8b8b95',
    // The dependency layer. `dep` takes the SAME hue as `package` on purpose:
    // a package this session imported and the bill entry it resolves to are two
    // views of one thing, and the edge between them reads as a join rather than
    // as a relation between two unrelated nodes. The square is what says which
    // side of it you are looking at. `manifest` sits in the stack family, which is
    // where files that describe a project already live.
    dep: '#6a9fd4', manifest: '#c47ab0',
};
const KIND_LIGHT = {
    session: '#b45f1f', harness: '#2c7676', repo: '#b45f1f', model: '#2f6fae',
    tool: '#4d8a2f', mcp: '#2c7676', skill: '#8a6712', cli: '#4d8a2f',
    package: '#2f6fae', stack: '#94438a', ext: '#94438a', slash: '#8a6712',
    mode: '#63636f', friction: '#b8402f', turn: '#6b6b78',
    decision: '#15803d', defect: '#b91c1c', guard: '#92400e',
    thread: '#7c22ce', subsystem: '#1d4ed8', question: '#57534e', concept: '#57534e',
    intent: '#a2521a', status: '#5b5b66', prior: '#5b5b66',
    dep: '#2f6fae', manifest: '#94438a',
};
const KIND_FALLBACK = 'question';
const kindVars = (m) => Object.entries(m).map(([k, v]) => `--k-${k}:${v};`).join('');
/** One rule per kind, setting a single inherited custom property. The shapes
 *  then have exactly one fill rule between them, so a kind that gains a colour
 *  cannot gain a second way to be painted. */
const kindRules = () => Object.keys(KIND_DARK).map((k) => `.gn.k-${k}{--kc:var(--k-${k})}`).join('\n');
function css() {
    return `
:root{
  --bg:#fbfaf8; --panel:#fff; --ink:#1c1b19; --muted:#6b6862; --dim:#6b6862; --line:#e6e2db;
  --accent:#c2521a; --accent-soft:#fdf0e8; --ok:#2f6b46; --warn:#9a6a12; --bad:#b3261e;
  --bar:#d9d4cb; --tag-ink:#fff; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:light;
  /* The turn card's own three colours. They exist because the tokens that were
     doing this job could not: --line on --panel is 1.29:1 and --panel on --bg
     is 1.04:1, so a column of turns painted one continuous grey field with no
     boundary a reader could see between one card and the next, or between a
     card and the page.

     --edge is that boundary, and it is chosen against four surfaces rather than
     one: the flat page, the solid card, and both of those again at the point of
     the drifting aura field that is worst for a 1px line -- which is NOT the
     point that is worst for text, so glass.mjs's numbers do not cover it. The
     floor is 3:1, WCAG 1.4.11 for a boundary that carries meaning, and the
     binding surface turned out to be the field rather than either flat one:
     the first dark value tried cleared 3:1 against both #1e1d23 and #16151a
     and then measured 2.83:1 against the field at its brightest, which is the
     number that chose the value below. test/cards.mjs prints all four.

     --idx and --chip are rank, not decoration. The summary row does three
     different jobs -- scan the score, navigate by the number, glance at the
     reference detail -- and until this pass all three were 11-12px --muted, so
     none of them could be found without reading the other two. --chip is the
     score's own opaque surface, opaque for the same reason .tool and .body pre
     are: a third alpha stacked on the glass would make its text contrast a
     product of three numbers instead of one. */
  --edge:#877f73; --idx:#43413c; --chip:#f1eee8;
  --kg-bg:#f3f0ea; --kg-halo:#f3f0ea; --kg-ring:#f3f0ea; --kg-label:#26251f;
  --kg-edge:#8d8779; --kg-edge-au:#7c3aed; --alarm:#b3261e; --alarm-ink:#fff;
  /* The ring around a conclusion carried in from an earlier session. Its own
     token in all three blocks rather than a reuse of --kg-edge-au, because it
     has to stay legible against every node fill the authored layer can take
     and the edge colour is chosen against the canvas. */
  --kg-carried:#7c3aed;
  /* The two layer stamps in the graph sidebar, which were written as rgba()
     literals in their own rules until this pass. Declared once rather than in
     each theme block: they are the same two colours in both today, and a token
     that exists in one block and not the others is a stamp that disappears
     when the toggle moves.

     Held as rgba rather than mixed with color-mix, which is what the aura
     tokens use. test/glass.mjs reads a color-mix background as glass and
     requires every one of them inside the backdrop-filter guard with a solid
     fallback outside it; these are flat labels on a panel, not surfaces, and
     buying a blur for them would cost a backdrop raster per sidebar render. */
  --stamp-derived:rgba(21,128,61,.12); --stamp-derived-line:rgba(21,128,61,.45);
  --stamp-authored:rgba(147,51,234,.12); --stamp-authored-line:rgba(147,51,234,.45);
  /* The third stamp: a conclusion the store carried in from an earlier session.
     Declared here with the other two, and amber rather than purple, because the
     panel has to say "not this session" before it says anything else. */
  --stamp-carried:rgba(180,110,15,.14); --stamp-carried-line:rgba(180,110,15,.5);
  /* The drifting field behind the page, mixed out of the palette this theme
     already declares so it follows the theme instead of being a second picture.

     Much weaker than the dark theme, and that is not timidity: #fbfaf8 sits at
     96% of white, so any tint on it can only subtract luminance, and every
     foreground on the page loses contrast in proportion. --warn starts at
     4.53:1 on the flat background -- three hundredths above AA -- so the whole
     light-theme budget is however much darkening that one token can absorb.
     The numbers these weights produce are asserted in test/glass.mjs. */
  --aura-1:color-mix(in srgb,var(--accent) 6%,transparent);
  --aura-2:color-mix(in srgb,var(--k-subsystem) 5%,transparent);
  --aura-3:color-mix(in srgb,var(--k-decision) 5%,transparent);
  ${kindVars(KIND_LIGHT)}
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#16151a; --panel:#1e1d23; --ink:#ece9e4; --muted:#9b968d; --dim:#9b968d; --line:#302e37;
  --accent:#ff8a4c; --accent-soft:#2a1d16; --ok:#6fbf8e; --warn:#e0b055; --bad:#ff6b5e;
  --bar:#3a3742; --tag-ink:#1a0f0d;
  color-scheme:dark;
  /* Re-measured on this palette, not the light values lightened. The surface
     that binds --edge here is neither --panel nor --bg: it is the aura field at
     its brightest, which lifted the page to #362b24 when test/cards.mjs last
     swept it, so --edge has to sit above all three rather than between the two
     flat ones. A token that only ever gets a light-theme value is the failure
     this triple is written out three times to avoid -- it would leave one pale
     hairline drawn on a near-black page, which is then the loudest thing on
     it. */
  --edge:#7e7c8b; --idx:#cbc7bf; --chip:#2a2833;
  --kg-bg:#131218; --kg-halo:#131218; --kg-ring:#131218; --kg-label:#d8d6dc;
  --kg-edge:#6b6b76; --kg-edge-au:#b07acb; --alarm:#c02a20; --alarm-ink:#fff;
  --kg-carried:#c79ae0;
  /* Twice the light theme, and it can afford it: #16151a leaves the whole range
     above it, so a tint here lifts the background toward the text rather than
     away from it, and every foreground still clears AA at the brightest point
     the field reaches. A weight that reads on #fbfaf8 is invisible here. */
  --aura-1:color-mix(in srgb,var(--accent) 13%,transparent);
  --aura-2:color-mix(in srgb,var(--k-subsystem) 10%,transparent);
  --aura-3:color-mix(in srgb,var(--k-decision) 10%,transparent);
  ${kindVars(KIND_DARK)}
}}
:root[data-theme=dark]{
  --bg:#16151a; --panel:#1e1d23; --ink:#ece9e4; --muted:#9b968d; --dim:#9b968d; --line:#302e37;
  --accent:#ff8a4c; --accent-soft:#2a1d16; --ok:#6fbf8e; --warn:#e0b055; --bad:#ff6b5e;
  --bar:#3a3742; --tag-ink:#1a0f0d;
  color-scheme:dark;
  --edge:#7e7c8b; --idx:#cbc7bf; --chip:#2a2833;
  --kg-bg:#131218; --kg-halo:#131218; --kg-ring:#131218; --kg-label:#d8d6dc;
  --kg-edge:#6b6b76; --kg-edge-au:#b07acb; --alarm:#c02a20; --alarm-ink:#fff;
  --kg-carried:#c79ae0;
  --aura-1:color-mix(in srgb,var(--accent) 13%,transparent);
  --aura-2:color-mix(in srgb,var(--k-subsystem) 10%,transparent);
  --aura-3:color-mix(in srgb,var(--k-decision) 10%,transparent);
  ${kindVars(KIND_DARK)}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;
  padding:28px 20px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
  margin:34px 0 12px;font-weight:600}
.sub{color:var(--muted);font-size:13px;font-family:var(--mono)}
.dim{color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}
/* theme */
/* No space-between any more: the theme button moved into the brand rail, so
   this row holds one child and pushing it apart from nothing left the title
   hard against the left edge of a 1080px column for no reason. */
.head{display:flex;gap:16px;align-items:flex-start}
/* The sub line carries the working directory, which is the one string on
   the page with no bound on its length and no space to break at. Break it
   anywhere rather than let it set the page's width on a phone. */
.head .sub{overflow-wrap:anywhere;word-break:break-word}
#theme{flex:none;border:1px solid var(--line);background:var(--panel);color:var(--muted);
  font:inherit;font-size:12px;padding:5px 12px;border-radius:99px;cursor:pointer}
#theme:hover{border-color:var(--accent);color:var(--ink)}

/* copy-pasteable compact line */
.compact{border-color:var(--accent);background:var(--accent-soft);margin-top:18px}
.compact .row{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.compact code{font-family:var(--mono);font-size:13px;white-space:pre-wrap;word-break:break-word;
  display:block;color:var(--ink)}
button.copy{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:8px 15px;
  font-size:13px;font-weight:600;cursor:pointer;flex:none}
button.copy:hover{filter:brightness(1.08)}
button.copy.done{background:var(--ok)}

/* score hero */
.score{display:flex;gap:22px;align-items:center;margin-top:18px}
.score .dial{flex:none;width:96px;height:96px;border-radius:50%;display:grid;place-items:center;
  background:conic-gradient(var(--sc) calc(var(--pct)*1%),var(--bar) 0);position:relative}
.score .dial::after{content:'';position:absolute;inset:7px;border-radius:50%;background:var(--panel)}
.score .dial b{position:relative;z-index:1;font-size:27px;font-weight:600;letter-spacing:-.03em;
  font-variant-numeric:tabular-nums}
.score .meaning{flex:1}
.score .meaning h3{margin:0 0 3px;font-size:17px;text-transform:capitalize}
.score .meaning p{margin:0;color:var(--muted);font-size:13.5px}
.score .caveat{margin-top:7px;font-size:12.5px;color:var(--warn)}
.sc-clean{--sc:var(--ok)} .sc-solid{--sc:var(--ok)} .sc-mixed{--sc:var(--warn)}
.sc-costly{--sc:var(--bad)} .sc-poor{--sc:var(--bad)}
/* The score. It is what a reader scans a hundred turns for, so it is the one
   thing in a summary row that is an object rather than a run of text: an opaque
   fill and an --edge border, against the .tool chips further down that keep
   --line. Same shape, two ranks, and the rank is which one you see first.

   --ink on --chip, not --muted on the card: at 11px --muted it measured the
   same as the duration sitting 9px to its right, so the number the page is
   organised around was the hardest thing in the row to pick out. Still 12px
   against the prompt line's 14px -- the prompt is the content and the score is
   only the index to it, and a chip that out-shouts the prompt has traded one
   unreadable row for another. */
.chip{font-family:var(--mono);font-size:12px;font-weight:600;padding:2px 7px;border-radius:5px;
  border:1px solid var(--edge);background:var(--chip);color:var(--ink)}
.chip.low{color:var(--bad);border-color:var(--bad)}
.ded{margin:10px 0 0;padding-left:17px;font-size:13px;color:var(--muted)}
.ded li.out{color:var(--bad)} .ded li.add{color:var(--ok)}

/* stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.stat{background:var(--panel);padding:13px 15px}
.stat .n{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.stat.hot .n{color:var(--bad)}

/* intents */
.intent{border-left:3px solid var(--line);padding:2px 0 2px 15px;margin:0 0 18px}
.intent.done{border-color:var(--ok)} .intent.partial{border-color:var(--warn)}
.intent.abandoned{border-color:var(--bad)} .intent.ongoing{border-color:var(--accent)}
.intent h3{margin:0 0 4px;font-size:15px;font-weight:600}
.intent p{margin:0;color:var(--muted);font-size:14px}
.pill{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;
  padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);
  margin-left:8px;vertical-align:2px;font-weight:600}

/* the drill-down on an unfinished thread.

   Two controls and not one, on purpose. The button is the thing the reader
   wants -- the prompt, in the clipboard, in one press -- and it needs script to
   work. The disclosure beside it is the same text, selectable, and it works
   with scripting off; the page's other copyable line has exactly this problem
   and only ever had the button. */
.drill{margin:9px 0 0}
button.copy.sm{padding:5px 11px;font-size:12px}
.fu{margin:8px 0 0}
.fu summary{cursor:pointer;color:var(--muted);font-size:12.5px;width:fit-content}
.fu pre{margin:9px 0 0;background:var(--chip);border:1px solid var(--line);border-radius:8px;
  padding:12px 13px;font-family:var(--mono);font-size:12px;line-height:1.5;color:var(--ink);
  white-space:pre-wrap;word-break:break-word;overflow-x:auto}
.fu code{font-family:var(--mono);font-size:11.5px}
.fu p{font-size:12px;margin:8px 0 0}

/* the appendix.

   No blur and no translucency anywhere in here: the task blocks and their rows
   are counted by the data, and one backdrop raster per task on a session with
   forty of them is forty rasters the compositor has to keep. Same reason .turn
   is left out of the glass block. */
.apx-how p{font-size:13.5px}
.apx-how code{font-family:var(--mono);font-size:12.5px}
.apx-quote{margin:0 0 12px;padding:11px 13px;border-left:3px solid var(--warn);
  background:var(--chip);border-radius:0 8px 8px 0;font-size:13px;color:var(--ink)}
.apx-tasks{margin:0;padding-left:19px;font-size:13.5px;color:var(--muted)}
.apx-tasks li{margin:4px 0}
.apx-tasks b{color:var(--ink);font-weight:600}
.apx-task{margin:20px 0 0}
.apx-task h3{margin:0 0 3px;font-size:15px;font-weight:600}
.apx-cite{margin:0 0 8px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.apx-warn{color:var(--warn)}
.apx-say{margin:0;font-size:13.5px;color:var(--muted)}
/* Wide tables scroll inside their own box. A page whose body scrolls sideways
   because one path was long is a page that is broken on a phone. */
.apx-scroll{overflow-x:auto;border:1px solid var(--edge);border-radius:9px;background:var(--panel)}
table.apx{border-collapse:collapse;width:100%;font-size:13px;min-width:420px}
table.apx th{text-align:left;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dim);font-weight:640;padding:8px 12px;border-bottom:1px solid var(--line)}
table.apx td{padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--muted)}
table.apx tr:last-child td{border-bottom:0}
table.apx td code{font-family:var(--mono);font-size:12px;color:var(--ink);word-break:break-all}
table.apx .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
/* A file under two tasks is the row the reader is most likely to misread, so it
   is marked in the table as well as spelled out in the cell. */
table.apx tr.apx-shared td{border-left:3px solid var(--warn)}
table.apx tr.apx-shared td:not(:first-child){border-left:0}

/* turns */
.filters{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.filters button{background:var(--panel);border:1px solid var(--line);color:var(--muted);
  border-radius:999px;padding:5px 13px;font-size:12px;cursor:pointer;font-weight:500}
.filters button.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
/* --edge, not --line. A turn card is 1.04:1 against the page and its --line
   border was 1.29:1 against its own fill, so nothing on this stack drew a
   boundary: a hundred turns read as one grey field with text in it. This is the
   only border on the page that has to survive being repeated a hundred times
   down a column, which is why it is the one that gets its own token.

   .turn.friction still wins the left edge on specificity, so the red marker is
   untouched -- and it now sits against a grey the reader can see, which is what
   makes it read as a marker rather than as the only border on the page. */
.turn{border:1px solid var(--edge);border-radius:9px;background:var(--panel);
  margin-bottom:7px;overflow:hidden}
.turn.friction{border-left:3px solid var(--bad)}
.turn > summary{padding:11px 15px;cursor:pointer;display:grid;
  grid-template-columns:34px 1fr auto;gap:12px;align-items:center;list-style:none}
.turn > summary::-webkit-details-marker{display:none}
.turn > summary:hover{background:var(--accent-soft)}
/* How a reader navigates, so it outranks the reference detail beside it -- 12px
   600 --idx against 11px 400 --muted -- and stays under the prompt line, which
   is what they are navigating to. The mono stack is doing real work and is not
   inherited decoration: a right-aligned number is only scannable down a column
   if its digits are one width, and mono is already what gives them that, which
   is why there is no font-variant-numeric here pretending to.

   The 34px column is load-bearing beyond this rule: .body indents to exactly
   this width plus the summary's padding and gap, so a change here that is not
   also made there unhooks every expanded body from the row it belongs to. */
.idx{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--idx);
  text-align:right}
/* The content, and it stays the loudest thing in the row: 14px against the
   score's 12px and the metadata's 11px, and the only one of them in the page's
   body font rather than the mono. 500 rather than 400 so that giving the score
   a fill did not quietly promote the score above the prompt it scores. */
.txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500}
/* Duration, tool count, tokens: reference, read after the reader has already
   chosen a row. Deliberately the same rank as .tool below -- they are the same
   job in two places, and inventing a fourth level for them would be rank for
   its own sake rather than for a reader's. */
.meta{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;
  display:flex;gap:9px;align-items:center}
.bar{height:4px;background:var(--bar);border-radius:2px;width:54px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bad);color:var(--tag-ink);
  font-weight:600;letter-spacing:.03em}
/* 61px is not a taste: it is the summary's 15px padding plus the 34px index
   column plus the 12px grid gap, so the expanded body starts on the same
   vertical as the prompt line above it. Any of those three numbers moving
   without this one moving with it breaks that alignment silently, which is why
   test/cards.mjs derives the sum from the grid rather than restating it. */
.body{padding:2px 15px 16px 61px;border-top:1px solid var(--edge)}
.body pre{font-family:var(--mono);font-size:12.5px;white-space:pre-wrap;word-break:break-word;
  background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:11px;margin:12px 0}
.tools{display:flex;gap:6px;flex-wrap:wrap}
.tool{font-family:var(--mono);font-size:11px;background:var(--bg);border:1px solid var(--edge);
  border-radius:5px;padding:2px 7px;color:var(--muted)}
.empty{color:var(--muted);font-style:italic;padding:20px;text-align:center}
footer{margin-top:44px;color:var(--muted);font-size:12px;font-family:var(--mono);
  border-top:1px solid var(--line);padding-top:14px}
/* knowledge graph */
.gwrap{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:0;border:1px solid var(--line);
  border-radius:10px;overflow:hidden;margin:10px 0 0;background:var(--panel)}
@media (max-width:900px){.gwrap{grid-template-columns:1fr}}
.glegend{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:9px 14px;
  border-bottom:1px solid var(--line);font-size:12.5px}
.ghalf{display:inline-flex;align-items:center;gap:7px}
.gk{width:11px;height:11px;display:inline-block;background:var(--dim)}
.gcirc{border-radius:50%}
.gdia{transform:rotate(45deg)}
.gbtn{border:1px solid var(--line);background:var(--panel);color:var(--ink);
  font:inherit;font-size:12px;padding:3px 10px;border-radius:99px;cursor:pointer}
.gbtn:hover{border-color:var(--accent)}
.gbtn.off{opacity:.55}
.gpush{margin-left:auto}

/* The canvas pans and zooms, so it clips rather than scrolls. touch-action is
   pan-y and not none: a graph that swallows the page scroll on a phone is a
   worse bug than one that cannot be dragged with a finger. */
.gcanvas{position:relative;overflow:hidden;background:var(--kg-bg);touch-action:pan-y;cursor:grab}
.gcanvas.grab{cursor:grabbing}
.gcanvas:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}
#qkg{display:block;width:100%;height:auto}
.gzoom{position:absolute;right:10px;bottom:10px;display:flex;gap:5px}
.gzoom button{width:27px;height:27px;padding:0;line-height:1;font-size:15px;border-radius:7px;
  border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.gzoom button.wide{width:auto;padding:0 9px;font-size:12px}
.gzoom button:hover{border-color:var(--accent)}
.gscale{position:absolute;left:11px;bottom:14px;font-family:var(--mono);font-size:11px;
  color:var(--kg-label);opacity:.8;pointer-events:none}
.greplay{grid-column:1/-1;display:flex;gap:12px;align-items:center;padding:9px 14px;
  border-top:1px solid var(--line);font-size:12.5px}
.greplay input[type=range]{flex:1;min-width:110px;accent-color:var(--accent)}
.greplay output{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap}

/* Every stroke width divides by the live zoom factor, so magnifying the graph
   spreads the nodes apart without also fattening the lines and the type into
   each other. --kgz is set on the svg by the pan/zoom handler. */
.ge{stroke:var(--kg-edge);stroke-opacity:.34;fill:none;stroke-width:calc(1px / var(--kgz,1))}
.ge.authored{stroke:var(--kg-edge-au);stroke-opacity:.5}
.ge.dash{stroke-dasharray:calc(4px / var(--kgz,1)) calc(4px / var(--kgz,1))}
.ge.hot{stroke-opacity:.95;stroke-width:calc(1.8px / var(--kgz,1))}
.ge.mute,.gn.mute{opacity:.1}
/* Not yet born, under the replay scrubber. */
.ge.pre,.gn.pre{display:none}
.gn{cursor:pointer}
.gn .gs{fill:var(--kc,var(--k-question));stroke:var(--kg-ring);stroke-width:calc(1.5px / var(--kgz,1))}
.gn.authored .gs{stroke:var(--kg-label);stroke-width:calc(1.2px / var(--kgz,1));
  stroke-dasharray:calc(3px / var(--kgz,1)) calc(2px / var(--kgz,1))}
/* The carried ring. An outline and not a fill, so the node keeps its kind
   colour and the ring is legible on top of any of them; and a second SHAPE
   rather than a second colour, so it survives greyscale exactly as the diamond
   does. Non-interactive, or hovering the gap between ring and node would
   count as leaving the node. */
.gn .gring{fill:none;stroke:var(--kg-carried);stroke-width:calc(1.4px / var(--kgz,1));
  pointer-events:none}
.gk.gcar{background:none;border:1.5px solid var(--kg-carried)}
/* The dependency layer. A SOLID outline where the authored layer is dashed:
   dashed says "somebody asserted this", solid says "a file declares it". Both
   differ from the derived layer's plain ring, and the square differs from both
   shapes, so the three are told apart without colour. */
.gn.dependency .gs{stroke:var(--kg-label);stroke-width:calc(1.2px / var(--kgz,1))}
.gk.gsq{border-radius:2px}
.gn text{font-size:calc(9.5px / var(--kgz,1));fill:var(--kg-label);text-anchor:middle;
  paint-order:stroke;stroke:var(--kg-halo);stroke-width:calc(3px / var(--kgz,1));
  stroke-linejoin:round;pointer-events:none}
/* Zoomed out, every label is drawn and none of them is legible. So the nodes
   that carry the shape of the session keep theirs and the rest wait for room --
   or for a hover, which always wins. */
#qkg:not(.showall) .gn:not([data-hi]) text{opacity:0}
.gn:hover text,.gn:focus text,.gn.near text{opacity:1 !important}
.gn:focus{outline:none}
.gn:focus .gs{stroke:var(--accent);stroke-width:calc(2.5px / var(--kgz,1));stroke-dasharray:none}
${kindRules()}
.gside{padding:14px 16px;border-left:1px solid var(--line);font-size:13px;overflow:auto;max-height:620px}
@media (max-width:900px){.gside{border-left:0;border-top:1px solid var(--line);max-height:none}}
.gside h4{margin:0 0 6px;font-size:14px}
/* Full-width stamp, never a subtle badge: which layer a node belongs to is the
   first thing a reader needs and the easiest thing to miss. */
.gstamp{display:block;padding:5px 8px;border-radius:5px;font-size:11.5px;margin:0 0 9px}
.gstamp.derived{background:var(--stamp-derived);border:1px solid var(--stamp-derived-line)}
.gstamp.authored{background:var(--stamp-authored);border:1px solid var(--stamp-authored-line)}
.gstamp.carried{background:var(--stamp-carried);border:1px solid var(--stamp-carried-line)}
.gstat{margin:0 0 7px;font-size:12px;color:var(--muted)}
.gstale{margin:8px 0 0;font-size:11.5px;color:var(--dim);border-left:2px solid var(--line);padding-left:9px}
.gcarry{margin:0 0 6px;font-size:12.5px}
.gfoot{margin:12px 0 0;font-size:12.5px}
.glbl{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);
  font-weight:640;margin:12px 0 5px}
.gsup,.gnot{margin:0;padding-left:18px}
.gsup li,.gnot li{margin:2px 0}
.gnot li{color:var(--dim)}
.gmismatch{background:var(--alarm);color:var(--alarm-ink);padding:10px 14px;border-radius:8px;margin:0 0 14px;font-size:13.5px}

/* evidence package */
.ev{margin-top:18px}
.evwhat{margin:0;font-size:14px}
.evrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px}
.evmeta{font-family:var(--mono);font-size:12px;color:var(--muted)}
/* Height reserved before anything is said. Without it the first click pushes
   both disclosures down the page from under the reader's cursor. */
.evsay{margin:12px 0 0;min-height:1.35em;font-family:var(--mono);font-size:12.5px;color:var(--muted)}
/* Failure is painted; success is not. Nothing tells this page whether the file
   reached the disk -- a viewer that forbids downloads swallows it and reports
   nothing -- so a green tick here would be the one claim on the page that no
   measurement stands behind. */
.evsay.bad{color:var(--bad)}
.evmore{margin-top:14px;font-size:13px}
.evmore summary{cursor:pointer;color:var(--muted)}
.evlim,.evfiles{margin:10px 0 0;padding-left:20px;color:var(--muted)}
.evlim li,.evfiles li{margin:0 0 9px}
.evfiles code{font-family:var(--mono);font-size:12px;color:var(--ink)}
.evdg{font-family:var(--mono);font-size:11px;color:var(--dim);word-break:break-all}

/* glass ------------------------------------------------------------------
   A drifting colour field behind the page, and translucent surfaces over it.

   The field is two fixed pseudo-elements. Nothing animates but \`transform\` on a
   promoted layer, so every frame is the same rasterised texture moved by the
   compositor -- no repaint, no script, no canvas, no image. Animating the
   gradient stops instead would repaint the whole viewport on every frame of a
   page that is also running a force-directed graph.

   Placed last on purpose: these rules restate backgrounds that earlier rules
   set solid, so they have to win on order rather than on specificity, which
   would mean inventing selectors the markup does not have. */
body::before,body::after{
  content:'';position:fixed;z-index:-1;pointer-events:none;
  /* 160% of the viewport in each axis. The layer translates by up to 6% of its
     own box and the untinted edge of a viewport-sized layer would swing into
     shot. */
  inset:-30%;
  will-change:transform;
}
/* If color-mix is unsupported the --aura-* tokens are invalid at computed-value
   time, which takes background-image with them and resolves it to \`none\`. The
   page is then the flat --bg it was before -- no half-painted field. */
body::before{
  background-image:
    radial-gradient(42% 48% at 14% 10%,var(--aura-1),transparent),
    radial-gradient(46% 52% at 88% 26%,var(--aura-2),transparent),
    radial-gradient(52% 46% at 44% 90%,var(--aura-3),transparent);
  animation:auraA 47s ease-in-out infinite;
}
body::after{
  background-image:
    radial-gradient(48% 54% at 74% 74%,var(--aura-1),transparent),
    radial-gradient(40% 46% at 24% 50%,var(--aura-2),transparent);
  animation:auraB 71s ease-in-out infinite;
}
/* 47 and 71 are coprime, so the two layers take fifty-five minutes to return to
   the same phase. A field that visibly loops is a field the reader starts
   watching instead of reading past. */
@keyframes auraA{
  0%,100%{transform:translate3d(-4%,-3%,0) scale(1.04)}
  34%{transform:translate3d(5%,3%,0) scale(1.1)}
  67%{transform:translate3d(-2%,6%,0) scale(1.06)}
}
@keyframes auraB{
  0%,100%{transform:translate3d(3%,4%,0) scale(1.08)}
  34%{transform:translate3d(-5%,-2%,0) scale(1.03)}
  67%{transform:translate3d(4%,-5%,0) scale(1.06)}
}
/* Stopped, not slowed. */
@media (prefers-reduced-motion:reduce){
  body::before,body::after{animation:none;transform:none;will-change:auto}
}

/* Translucency is opt-in on support, because a translucent panel over an
   unblurred moving field is worse than no glass at all. The solid --panel rules
   above stay the default and this block only fires where the blur exists to
   make it legible.

   color-mix is written inline here rather than through a custom property, and
   that is the whole safety argument: inline it fails at PARSE time, the
   declaration is dropped, and the solid background above survives. Through a
   token it would fail at computed-value time, resolve to \`unset\`, and leave the
   surface transparent -- the exact failure this block exists to avoid. */
@supports (backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px)){
  /* Everything named here has a bounded count on the page: a handful of cards,
     one stats grid, one graph, one theme button, five filters. .turn is
     deliberately NOT in this list -- there is one per human turn and sessions
     with several hundred are ordinary, and a compositor asked for three hundred
     separate backdrop rasters drops frames on the scroll. Turns get the
     translucency without the blur, which over a field this smooth is the part
     that was doing the work anyway. */
  .card,.stats,.gwrap,#theme,.filters button{
    -webkit-backdrop-filter:blur(18px) saturate(1.2);
    backdrop-filter:blur(18px) saturate(1.2);
  }
  .card,.turn,.gwrap,#theme,.filters button{
    background:color-mix(in srgb,var(--panel) 80%,transparent);
  }
  /* The compact line keeps its accent wash; it is the one card on the page that
     is coloured to be copied from. */
  .compact{background:color-mix(in srgb,var(--accent-soft) 80%,transparent)}
  /* .stats paints only the 1px grid gaps, so it is the layer that carries the
     blur and .stat is the readable surface over it. */
  .stats{background:color-mix(in srgb,var(--line) 55%,transparent)}
  .stat{background:color-mix(in srgb,var(--panel) 78%,transparent)}
  .card,.turn,.stats,.gwrap{
    box-shadow:0 1px 2px color-mix(in srgb,var(--ink) 6%,transparent),
               0 14px 34px color-mix(in srgb,var(--ink) 7%,transparent);
  }
  /* Restated here, inside the glass, and NOT because .gwrap would otherwise
     leak through it -- .gcanvas already declares this above. It is restated so
     that the last word on the canvas's background is spoken next to the rules
     that made everything around it translucent, and so that removing the
     earlier declaration does not quietly make the canvas transparent.

     Why it must stay opaque: .gcanvas paints --kg-bg, and every node label is
     drawn with a halo stroked in --kg-halo, which is the same colour. Make the
     canvas translucent and those halos become opaque patches of a colour that
     is no longer behind them -- the labels would be outlined in the wrong
     background. The graph is a data surface; it stays opaque, along with the
     zoom controls that float over it, and the glass is the chrome around it.

     The same reasoning keeps .body pre and .tool on their solid --bg: they sit
     inside a .turn that is already translucent, and a third alpha stacked on
     the first two makes the reader's contrast a product of three numbers
     instead of two. They are simply left out of every list above. */
  .gcanvas{background:var(--kg-bg)}
}

`;
}
// ------------------------------------------------- unfinished threads
//
// A done thread has nothing to drill into, so it gets no drill-down. That is
// the whole rule, and it is the rule because the alternative -- a button on
// every thread -- makes the button mean "here is a thread" instead of "here is
// a thread that did not finish", which is the only reason to have one.
//
// `partial` is deliberately NOT in here. It is a thread the analysis says
// landed in part, and "what is left" is a question about the part that did not
// land, which the record does not separate. Two states can be asked about
// honestly -- abandoned and ongoing -- and those are the two.
const UNFINISHED = new Set(['abandoned', 'ongoing']);
const unfinished = (i) => UNFINISHED.has(String(i.status || ''));
/** Slugged from the title, because a reader typing `--followup` at a terminal
 *  has the title in front of them and not an index. Collisions fall back to the
 *  index, which is always unique and never ambiguous. */
const threadSlug = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const pathsPresent = (session) => session.turns.reduce((n, t) => n + (t.files?.length ?? 0), 0);
const pathState = (session) => {
    if (session.recordedPaths === true)
        return 'recorded';
    if (session.recordedPaths === false)
        return 'refused';
    return pathsPresent(session) > 0 ? 'unknown-present' : 'unknown-empty';
};
/**
 * How many files one task lists before the rest are counted instead.
 *
 * A thread citing forty turns of a busy session can name several hundred paths,
 * and neither a prompt somebody pastes into a chat nor a table somebody reads
 * survives that. Truncated, never silently: the remainder is printed as a count
 * of files AND of tool calls, so the number at the bottom of the list is the
 * number the reader would have got by adding the rows up.
 */
const MAX_FILES_LISTED = 40;
/**
 * Tie each task to the files its cited turns touched.
 *
 * The join is turn index and nothing else. A task "produced" a file only in the
 * sense that a turn somebody attributed to that task made a tool call naming
 * the path -- which is the strongest thing the spine supports and a good deal
 * weaker than it will look in a table. Every caller of this prints that caveat;
 * the `alsoIn` field exists so the sharpest case, one file under two tasks, is
 * on the row rather than in the small print.
 */
function attribute(session, items) {
    const byIndex = new Map(session.turns.map((t) => [t.index, t]));
    const raw = items.map((it) => {
        const cited = citedTurns(it);
        const counts = new Map();
        const missing = [];
        let quiet = 0;
        for (const n of cited) {
            const turn = byIndex.get(n);
            if (!turn) {
                missing.push(n);
                continue;
            }
            const files = turn.files;
            if (!files || !files.length) {
                quiet++;
                continue;
            }
            for (const f of files)
                counts.set(f.path, (counts.get(f.path) || 0) + (f.count || 0));
        }
        return { cited, counts, missing, quiet };
    });
    const owners = new Map();
    raw.forEach((r, i) => {
        for (const path of r.counts.keys())
            owners.set(path, [...(owners.get(path) || []), i]);
    });
    return raw.map((r, i) => ({
        cited: r.cited,
        missing: r.missing,
        quiet: r.quiet,
        files: [...r.counts.entries()]
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .map(([path, count]) => ({
            path,
            count,
            alsoIn: (owners.get(path) || [])
                .filter((j) => j !== i)
                .map((j) => String(items[j]?.title ?? '')),
        })),
    }));
}
/** The files no task's cited turns reached. Not "files nothing produced" --
 *  files no thread in the analysis claims, which is a hole in the analysis. */
function unclaimed(session, attr) {
    const claimed = new Set(attr.flatMap((a) => a.files.map((f) => f.path)));
    const all = new Map();
    for (const t of session.turns)
        for (const f of t.files || [])
            all.set(f.path, (all.get(f.path) || 0) + (f.count || 0));
    let files = 0;
    let touches = 0;
    for (const [path, count] of all)
        if (!claimed.has(path)) {
            files++;
            touches += count;
        }
    return { files, touches };
}
const wrap = (s, indent = '  ', width = 76) => {
    const out = [];
    let line = '';
    for (const word of String(s).split(/\s+/).filter(Boolean)) {
        if (line && (line + ' ' + word).length > width) {
            out.push(indent + line);
            line = word;
        }
        else
            line = line ? `${line} ${word}` : word;
    }
    if (line)
        out.push(indent + line);
    return out.join('\n');
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/**
 * The follow-up prompt for ONE unfinished thread.
 *
 * Built here, once, and handed to both the page's button and the CLI's
 * `--followup`, so the two cannot say different things about the same thread.
 * test/followup.mjs compares the page's copy of this text against the CLI's
 * byte for byte, which is the only check that keeps that true as either side
 * changes.
 *
 * Every sentence in it is derived from the spine or from the analysis, and the
 * sections that have nothing to report SAY they have nothing rather than being
 * dropped -- a prompt whose file list is quietly absent invites the reader to
 * conclude the thread touched nothing.
 */
/**
 * @param intentSession the session the INTENT document says it describes, or
 *   null when it did not say. The page raises a banner when that disagrees with
 *   the spine, and the CLI warns on stderr — but this prompt is the one surface
 *   built to be copied into another model's context, and neither the banner nor
 *   the warning travels with the text once it is on a clipboard. So the
 *   disagreement is stated INSIDE the prompt, and the citations that depend on
 *   the two agreeing are withheld rather than printed under the wrong session's
 *   name.
 */
function followupPrompt(session, items, attr, i, intentSession) {
    const it = items[i];
    const a = attr[i];
    const status = String(it.status || 'ongoing');
    const sid = String(session.sessionId || 'this session');
    // Both must be known before they can disagree. A document that named no
    // session has not contradicted anything, and treating silence as a mismatch
    // would put a warning on every hand-written intent file.
    const other = intentSession && session.sessionId && intentSession !== session.sessionId ? String(intentSession) : null;
    const L = [];
    if (other) {
        L.push('READ THIS FIRST: the two documents this prompt was built from describe DIFFERENT SESSIONS.');
        L.push(wrap(`The conclusion below was written about session ${other.slice(0, 8)}. The transcript it was ` +
            `rendered against is session ${sid.slice(0, 8)}. Nothing here has checked whether the thread ` +
            'survived into that second session, and the turn numbers the analysis cited index the first ' +
            'one, so they are not printed against the second. Treat everything below as a conclusion ' +
            'about a session you are not looking at.'));
        L.push('');
    }
    else
        L.push(`Follow-up on one unfinished thread from session ${sid.slice(0, 8)}, as /qpact read it.`);
    L.push('');
    L.push('THREAD');
    L.push(wrap(String(it.title || 'untitled')));
    L.push(`  Status: ${status} — ${status === 'abandoned'
        ? 'the analysis marked this thread dropped before it finished.'
        : status === 'ongoing'
            ? 'the analysis marked this thread still open at the end of the session.'
            : 'the analysis gave it this status.'}`);
    if (other)
        L.push(`  Turns cited: ${a.cited.length ? `${a.cited.join(', ')} — of session ${other.slice(0, 8)}, not of the spine this was rendered against.` : 'none.'}`);
    else {
        L.push(a.cited.length
            ? `  Turns cited: ${a.cited.join(', ')}`
            : '  Turns cited: none. The analysis attributed no turn to this thread, so nothing below can be tied to it.');
        if (a.missing.length)
            L.push(`  Of those, ${plural(a.missing.length, 'turn')} (${a.missing.join(', ')}) is not in the spine at all.`);
    }
    L.push('');
    L.push('WHAT THE ANALYSIS CONCLUDED');
    L.push(it.summary ? wrap(String(it.summary)) : '  It wrote no summary for this thread.');
    L.push('');
    L.push('FILES THE CITED TURNS TOUCHED');
    const state = pathState(session);
    if (other)
        // The files are real and they are the WRONG session's. Attribution runs the
        // intent's turn numbers against the spine's turn list, so a mismatch indexes
        // one session's conclusions into another session's transcript and produces a
        // file list that is confidently, silently about something else. Printing it
        // under this thread's name is the constructed provenance failure; withholding
        // it costs a list nobody could have relied on.
        L.push(wrap(`The turn numbers cited here belong to session ${other.slice(0, 8)}, and the spine holds ` +
            `session ${sid.slice(0, 8)}. Reading one against the other would attribute this thread to ` +
            'whatever happened to occupy those turn numbers in a different session, so no file is ' +
            'listed. Render this thread against the spine of its own session to get one.'));
    else if (state === 'refused')
        L.push(wrap('This reading was extracted with --no-paths, so the spine records that a file was ' +
            'touched and never which one. Nothing can be attributed to this thread. That is a ' +
            'property of how the reading was taken, not a finding that nothing was changed.'));
    else if (state === 'unknown-empty')
        L.push(wrap('This spine predates the field that records which files a turn touched, so nothing ' +
            'in it can say. Not a finding that nothing was changed — the reading simply cannot ' +
            'answer the question.'));
    else if (!a.cited.length)
        L.push(wrap('No turn was cited for this thread, so no file can be attributed to it.'));
    else if (!a.files.length)
        // Counted against the turns the spine actually HOLDS, not against the
        // citations. A turn the spine does not hold made no tool call as far as
        // this reading is concerned, and saying it named no file would be a claim
        // about a turn nothing here has read.
        L.push(wrap(a.cited.length - a.missing.length === 0
            ? 'None of the turns cited for this thread is in the spine, so nothing can be attributed to it.'
            : `None. ${plural(a.cited.length - a.missing.length, 'cited turn')} ${a.cited.length - a.missing.length === 1 ? 'is' : 'are'} in the spine and not one of them made a tool call naming a file. A turn that did its ` +
                'work through a shell command shows up exactly like this, because nothing reads paths ' +
                'out of command text.'));
    else {
        const shown = a.files.slice(0, MAX_FILES_LISTED);
        const rest = a.files.slice(MAX_FILES_LISTED);
        const w = Math.min(52, Math.max(...shown.map((f) => f.path.length)));
        for (const f of shown)
            L.push(`  ${f.path.padEnd(w)}  ${String(f.count).padStart(4)} tool ${f.count === 1 ? 'call' : 'calls'}` +
                (f.alsoIn.length ? `   also under: ${f.alsoIn.join('; ')}` : ''));
        if (rest.length)
            L.push(`  ...and ${plural(rest.length, 'more file')}, not listed here, between them named by ` +
                `${plural(rest.reduce((n, f) => n + f.count, 0), 'tool call')}.`);
    }
    if (!other && a.quiet)
        L.push(`  (${plural(a.quiet, 'cited turn')} named no file at all.)`);
    L.push('');
    if (!other && (state === 'recorded' || state === 'unknown-present')) {
        L.push('HOW MUCH THAT LIST IS WORTH');
        const shared = a.files.filter((f) => f.alsoIn.length).length;
        L.push(wrap('A file is on it because a turn cited for this thread made a tool call naming that ' +
            'path. That is evidence the thread touched the file, not proof it changed it: a call ' +
            'that only read the file counts the same as one that rewrote it, and the spine does ' +
            'not record which tool named which path. A file named only inside a shell command is ' +
            'not on the list at all.' +
            (shared
                ? ` ${plural(shared, 'file')} here ${shared === 1 ? 'is' : 'are'} also attributed to another thread and ` +
                    `${shared === 1 ? 'belongs' : 'belong'} to neither exclusively.`
                : '')));
        if (state === 'unknown-present')
            L.push(wrap('This spine also predates the flag that records whether paths were kept, so the ' +
                'paths above are what happens to be in it rather than what it promises to hold.'));
        L.push('');
    }
    L.push('WHAT IS NOT RECORDED');
    L.push(wrap(`Nothing states what remains to be done. "${status}" is the status the analysis assigned ` +
        'and the summary above is everything it wrote about this thread. Nothing in this record ' +
        're-checks whether that is still the case.'));
    L.push('');
    L.push('WHAT I WANT FROM YOU');
    L.push(wrap(other
        ? `Find where this thread was worked on in session ${other.slice(0, 8)} — not in ` +
            `${sid.slice(0, 8)}, whose turns are not the ones cited — then tell me where it actually ` +
            'stands and what the next concrete step is. Where the record does not support an answer, ' +
            'say so instead of filling the gap.'
        : (a.cited.length
            ? `Read ${a.cited.length === 1 ? 'turn' : 'turns'} ${a.cited.join(', ')} of that session, and the files above, `
            : 'Find where this thread was worked on in that session, ') +
            'then tell me where this thread actually stands and what the next concrete step is. ' +
            'Where the record does not support an answer, say so instead of filling the gap.'));
    return L.join('\n');
}
function renderIntents(session, intent) {
    if (!intent?.intents?.length)
        return '';
    const items = intent.intents;
    const attr = attribute(session, items);
    const items_html = items
        .map((i, n) => {
        const status = String(i.status || 'ongoing');
        // The drill-down is the whole of what separates an unfinished thread from
        // a finished one on this page, so it is gated on the status and on
        // nothing else. A `done` thread has no open question to ask about, and a
        // button offering to ask one anyway would be a button that lies about
        // what it knows.
        const drill = unfinished(i)
            ? `
  <div class="drill">
    <button class="copy sm" type="button" data-copy="fu${n}" data-done="Prompt copied">Copy a follow-up prompt</button>
    <details class="fu">
      <summary>Read it first</summary>
      <pre id="fu${n}">${esc(followupPrompt(session, items, attr, n, intent?.sessionId ? String(intent.sessionId) : null))}</pre>
      <p class="dim">Same text from a terminal, for anyone not looking at this page:<br>
        <code>render.mjs &lt;spine.json&gt; --intent &lt;intent.json&gt; --followup ${esc(threadSlug(String(i.title || '')) || String(n))}</code></p>
    </details>
  </div>`
            : '';
        return `<div class="intent ${esc(status)}">
  <h3>${esc(i.title)}<span class="pill">${esc(i.status || '')}</span></h3>
  <p>${esc(i.summary || '')}</p>${drill}
</div>`;
    })
        .join('\n');
    const open = items.filter(unfinished).length;
    // Printed whether or not there are any, because a line that appears only when
    // the news is bad is a line nobody can read the absence of.
    const lead = open
        ? `<p class="dim" style="margin:0 0 14px">${plural(open, 'thread')} did not finish. Each one carries a follow-up prompt naming its own turns; a finished thread has nothing to drill into and gets none.</p>`
        : `<p class="dim" style="margin:0 0 14px">No thread was left abandoned or ongoing, so nothing here carries a follow-up prompt.</p>`;
    return `<h2>Intent breakdown</h2>\n${lead}\n${items_html}`;
}
// ------------------------------------------------- the appendix
//
// What each task actually produced, tied to the files its cited turns touched.
//
// This is the section on the page most able to lie, and it lies by looking like
// a manifest. A row here means: a turn somebody attributed to this task made a
// tool call naming this path. It does not mean the task changed the file, and
// where the same path sits under two tasks it does not mean either of them owns
// it. Both of those are stated above the tables and repeated on the rows that
// are actually shared, because a caveat read once and a caveat read at the row
// are not the same caveat.
//
// The second way it could lie is by being empty. A reading taken with
// --no-paths and a reading older than the field both produce exactly no rows,
// and no rows under a heading called "what each task produced" reads as "these
// tasks produced nothing". So the four states bundle.mjs distinguishes are
// distinguished here too, and in three of them the tables are replaced by the
// package's own sentence about paths -- printed verbatim rather than
// paraphrased, so the appendix and the evidence package cannot drift apart.
function renderAppendix(session, intent) {
    const items = intent?.intents ?? [];
    const state = pathState(session);
    const head = '<h2>Appendix — tasks and what they touched</h2>';
    if (!items.length)
        return `${head}
<div class="card"><p style="margin:0">The analysis named no tasks, so there is nothing to attribute files to. ${state === 'recorded'
            ? `The spine does record which files were touched: ${plural(pathsPresent(session), 'file entry', 'file entries')} across ${plural(session.turns.length, 'turn')}.`
            : 'Whether the spine records which files were touched is a separate question, answered in the evidence package below.'}</p></div>`;
    if (state !== 'recorded' && state !== 'unknown-present')
        return `${head}
<div class="card apx-none">
  <p style="margin:0 0 10px"><strong>No file can be attributed to any task in this reading.</strong> ${items.length === 1 ? 'The one task below is' : `All ${items.length} tasks below are`} still here, with the turns cited for ${items.length === 1 ? 'it' : 'them'} — what is missing is the other half of the join, not the tasks.</p>
  <p class="dim" style="margin:0 0 10px">Read this as a fact about the reading, never as a finding that nothing was changed. The evidence package states it in its own words:</p>
  <p class="apx-quote">${esc(pathLimit(session))}</p>
  <ul class="apx-tasks">${items
            .map((i) => `<li><b>${esc(i.title)}</b> <span class="pill">${esc(i.status || '')}</span> — ${citedTurns(i).length ? `turns ${esc(citedTurns(i).join(', '))}` : 'no turns cited'}</li>`)
            .join('')}</ul>
</div>`;
    const attr = attribute(session, items);
    const rest = unclaimed(session, attr);
    const sharedRows = attr.reduce((n, a) => n + a.files.filter((f) => f.alsoIn.length).length, 0);
    const tables = items
        .map((i, n) => {
        const a = attr[n];
        const cited = a.cited.length
            ? `turns ${esc(a.cited.join(', '))}`
            : '<span class="apx-warn">no turns cited</span>';
        let body;
        if (!a.cited.length)
            body = `<p class="apx-say">The analysis attributed no turn to this task, so no file can be tied to it. That is a gap in the analysis, not a finding that the task touched nothing.</p>`;
        else if (!a.files.length)
            // Same refusal as the prompt's: the sentence counts the cited turns the
            // spine HOLDS. "none of them made a tool call" over a citation the
            // reading never saw is a claim about a turn nobody read.
            body =
                a.cited.length - a.missing.length === 0
                    ? `<p class="apx-say">None of the turns cited for this task is in the spine, so nothing can be attributed to it.</p>`
                    : `<p class="apx-say">${plural(a.cited.length - a.missing.length, 'cited turn')} ${a.cited.length - a.missing.length === 1 ? 'is' : 'are'} in the spine, and none of them made a tool call naming a file. Work done through a shell command looks exactly like this: nothing reads paths out of command text.</p>`;
        else {
            const rest = a.files.slice(MAX_FILES_LISTED);
            body = `<div class="apx-scroll"><table class="apx">
  <thead><tr><th>File</th><th class="num">Tool calls</th><th>Also attributed to</th></tr></thead>
  <tbody>${a.files
                .slice(0, MAX_FILES_LISTED)
                .map((f) => `<tr${f.alsoIn.length ? ' class="apx-shared"' : ''}><td><code>${esc(f.path)}</code></td><td class="num">${f.count}</td><td>${f.alsoIn.length ? esc(f.alsoIn.join('; ')) : '<span class="dim">this task only, among the tasks named</span>'}</td></tr>`)
                .join('')}${rest.length
                ? `<tr><td class="dim">and ${plural(rest.length, 'more file')}, not listed</td><td class="num dim">${rest.reduce((n, f) => n + f.count, 0)}</td><td class="dim">the list is cut at ${MAX_FILES_LISTED}; the count beside it is theirs</td></tr>`
                : ''}</tbody>
</table></div>`;
        }
        const notes = [
            a.missing.length
                ? `${plural(a.missing.length, 'cited turn')} (${esc(a.missing.join(', '))}) is not in the spine at all.`
                : '',
            a.quiet ? `${plural(a.quiet, 'cited turn')} named no file.` : '',
        ].filter(Boolean);
        return `<div class="apx-task">
  <h3>${esc(i.title)}<span class="pill">${esc(i.status || '')}</span></h3>
  <p class="apx-cite">${cited}</p>
  ${body}
  ${notes.length ? `<p class="apx-say dim">${notes.map(esc).join(' ')}</p>` : ''}
</div>`;
    })
        .join('\n');
    return `${head}
<div class="card apx-how">
  <p style="margin:0"><strong>What a row here is, and what it is not.</strong> A file appears under a task because a turn the analysis cited for that task made a tool call naming that path. That is <em>evidence</em> the task touched the file. It is not proof it changed it: a call that only read the file counts the same as one that rewrote it, and the spine does not record which tool named which path.</p>
  <p style="margin:10px 0 0">A file named only inside a shell command is not here at all, so a task that worked through <code>sed</code> or <code>git</code> can show few files or none. ${sharedRows
        ? `${plural(sharedRows, 'row')} below ${sharedRows === 1 ? 'names a file that is' : 'name files that are'} attributed to more than one task; those belong to none of them exclusively, and nothing in the record divides them.`
        : 'No file below is attributed to more than one task in this reading, which is a fact about these particular citations and not a property of the method.'}</p>
  ${state === 'unknown-present'
        ? `<p style="margin:10px 0 0" class="apx-warn">This spine predates the flag that records whether paths were kept. The paths below are what happens to be in it, not what it promises to hold.</p>`
        : ''}
  <p style="margin:10px 0 0" class="dim">${rest.files
        ? `${plural(rest.files, 'file')} touched in this session ${rest.files === 1 ? 'is' : 'are'} claimed by no task above (${plural(rest.touches, 'tool call')}). Those turns went unattributed by the analysis; nothing here says they were unimportant.`
        : 'Every file this session touched is claimed by at least one task above.'}</p>
</div>
${tables}`;
}
function renderQuality(intent) {
    const q = intent?.quality;
    if (!q)
        return '';
    const list = (label, arr) => arr?.length ? `<p style="margin:10px 0 0"><strong>${label}</strong></p><ul style="margin:5px 0 0;padding-left:19px;color:var(--muted);font-size:14px">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    return `<h2>Prompting quality</h2><div class="card">
  <p style="margin:0">${esc(q.verdict || '')}</p>
  ${list('What worked', q.strengths)}
  ${list('What cost you', q.weaknesses)}
  ${list('Do differently', q.recommendations)}
</div>`;
}
const BAND_MEANING = {
    clean: 'Prompts landed the first time. Little rework visible in the transcript.',
    solid: 'Mostly landed, with a few turns that needed a second pass.',
    mixed: 'A noticeable share of turns had to be repeated, corrected or interrupted.',
    costly: 'Rework dominated. A large fraction of turns did not land as written.',
    poor: 'Most turns required correction or were abandoned mid-flight.',
};
// The baseline a turn scores at before anything counts for or against it.
// extract.mjs owns it (BASE) and the spine does not carry it, so the renderer
// keeps a named copy rather than a literal buried in the markup.
const SCORE_BASE = 72;
function renderScore(session) {
    const s = session.score;
    // The spine is parsed JSON, so a score object with no `value` arrives as
    // undefined, not null — which slipped past a null-only guard and printed the
    // word "undefined" in the dial and in the --pct gradient width.
    if (!s || typeof s.value !== 'number')
        return '';
    const caveat = s.confidence !== 'high'
        ? `<div class="caveat">Confidence ${esc(s.confidence)} — only ${s.turnsScored} turns, so the outcome signals have little to witness. Treat this as weak evidence, not a verdict.</div>`
        : '';
    return `<div class="score card sc-${esc(s.band)}" style="--pct:${s.value}">
  <div class="dial"><b>${s.value}</b></div>
  <div class="meaning">
    <h3>${esc(s.band)}</h3>
    <p>${esc(BAND_MEANING[s.band] || '')}</p>
    <p style="margin-top:6px">${Math.round(s.frictionRate * 100)}% of turns showed friction · ${Math.round(s.craftRate * 100)}% named a file, criteria or code · ${fmtTokens(s.wastedTokens)} output tokens spent on turns that needed rework</p>
    ${caveat}
  </div>
</div>`;
}
// ---------------------------------------------------------------- graph
// Rendered unconditionally, whether or not the corresponding nodes exist. A
// caveat that disappears when quiet is one nobody trusts on its return.
const NOT_SAID = [
    'No file appears here. This graph places no file node, so the count on the session node says how many tool calls named a file and never which one — the paths themselves, where the reading kept them, are attributed to tasks in the appendix below.',
    'A thread is drawn beside the turns its author CITED, and beside nothing it did not cite. An uncited turn that in fact belonged to it is invisible here.',
    'A status is what the analysis wrote down, not an outcome anything measured. Nothing has re-checked whether an unfinished thread is still unfinished.',
    'A package, CLI tool, stack file, extension or skill is attributed to the session, never to a turn.',
    'A repeat points at the first identical prompt, not at the previous one. It is a star, not a chain.',
    'A slash command attaches to the turn that was open when it was issued, which is the preceding human turn.',
    'An interruption is a count on a turn, not a point inside it. Which tool call it hit is not recorded.',
    'Replay places a node at the earliest turn that could have produced it, which is not the same as the turn it mattered. Anything the spine holds per session rather than per turn has no turn to be placed at, so it is present from the first frame.',
    'Distance in the picture is the packing, not a measurement. Nodes that share no edge were never compared.',
];
/** Long names — `mcp__Claude_Browser__read_console_messages` — are wider than
 *  any layout can give them, and a row of them overlaps into a smear. Elided in
 *  the middle so both ends stay identifying; the full string is in the SVG
 *  title, the accessible name and the side panel, so nothing is lost. */
const elide = (s, max = 26) => s.length <= max ? s : `${s.slice(0, max - 11)}…${s.slice(-10)}`;
/** Kinds come from two closed sets, but a class name built from data gets
 *  sanitised anyway. An unknown kind simply finds no `--k-` rule and falls
 *  through to the neutral. */
const kindClass = (kind) => String(kind).replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
function renderGraph(session, intent, bom) {
    const derived = deriveGraph(session);
    // The intents and the carried layer are handed to the same merge as the
    // concept bag, so the namespacing, the caps and the suppression report stay
    // in one place. A second merge here would be a second set of rules for the
    // separation this graph's whole honesty rests on.
    // Normalised here, not in graph.mts: the citation can arrive on the item or
    // inside its provenance, and the graph must draw the same turns the appendix
    // attributes files from.
    const cited = (list) => (list ?? []).map((i) => ({ ...i, turns: citedTurns(i) }));
    const merged = mergeAuthored(derived, intent?.graph, session.turns.length, {
        intents: cited(intent?.intents),
        prior: (intent?.prior ?? []).map((p) => ({
            session: p.sessionId,
            sessionsAgo: p.sessionsAgo,
            daysAgo: p.daysAgo ?? null,
            intents: cited(p.intents),
            graph: p.graph,
        })),
    });
    // Third and last, so the dependency layer is folded into a graph that already
    // knows which turns are drawn -- it hangs an edge off a turn node, and can
    // only do that for turns that survived the derived layer's own gates.
    const withDeps = mergeDependencies(merged, bom?.sbom, bom?.matched, {
        importRoots: Object.keys(session.artifacts?.packages ?? {}),
        turnFiles: session.turns.map((t) => ({
            index: t.index,
            paths: (t.files ?? []).map((f) => f.path),
        })),
    });
    const { nodes, edges } = withDeps;
    if (!nodes.length)
        return '';
    const W = 1000;
    const H = 620;
    const layout = layoutGraph(nodes, edges, { width: W, height: H });
    const pos = layout.positions;
    const maxDeg = Math.max(1, ...nodes.map((n) => n.degree));
    // Radii live in the same coordinate space as the packed positions, so they
    // take the same fit factor. Without that, a layout squeezed to 60% draws
    // full-size dots at 60% spacing -- overlapping blobs at exactly the densities
    // where the picture had to be squeezed in the first place. Floored, because a
    // node scaled down to a hairline is a node that is not on the page.
    const radius = (n) => Math.max(2.4, ((n.kind === 'session' ? 7 : 4) + Math.sqrt(n.degree / maxDeg) * (n.kind === 'session' ? 13 : 8)) * layout.scale);
    // Which labels survive being zoomed out. The session's spine, the model's own
    // layer, the friction, and the busiest measured nodes; the rest wait for room
    // or for a hover. Hiding them all would be tidier and useless.
    const SPINE = new Set(['session', 'harness', 'repo', 'model', 'friction']);
    const busiest = new Set(nodes.filter((n) => n.layer === 'derived').sort((a, b) => b.degree - a.degree).slice(0, 14).map((n) => n.id));
    const hi = (n) => n.layer === 'authored' || SPINE.has(n.kind) || busiest.has(n.id);
    // -1, not 0: a node the spine cannot date is present before the first turn
    // rather than arriving with it, and the two must stay distinguishable.
    const born = (v) => (typeof v === 'number' ? v : -1);
    const maxTurn = session.turns.length ? Math.max(0, ...session.turns.map((x) => x.index)) : 0;
    // Label placement, relaxed for exactly the labels that are drawn at fit.
    //
    // The rest are revealed by zooming, and they do not need this: labels
    // counter-scale while positions spread, so at 2x the gaps double and the type
    // does not. Collisions are a fit-zoom problem only.
    //
    // The width here is an ESTIMATE -- there are no font metrics in a renderer --
    // which is exactly why the test for this measures the real text boxes in a
    // browser instead of re-running this arithmetic and agreeing with itself.
    const CHAR_W = 5.15;
    const labelY = new Map();
    {
        const taken = [];
        const order = nodes
            .filter((n) => hi(n) && pos[n.id])
            .sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x || (a.id < b.id ? -1 : 1));
        for (const n of order) {
            const p = pos[n.id];
            const r = radius(n);
            const half = (elide(n.label).length * CHAR_W) / 2;
            // Below the node first, then above, then progressively further out.
            const cands = [r + 11, -(r + 5), r + 21, -(r + 15), r + 31, -(r + 25)];
            let dy = cands[0];
            for (const c of cands) {
                const box = { x0: p.x - half, x1: p.x + half, y0: p.y + c - 8, y1: p.y + c + 2.5 };
                if (!taken.some((q) => box.x0 < q.x1 && q.x0 < box.x1 && box.y0 < q.y1 && q.y0 < box.y1)) {
                    dy = c;
                    break;
                }
            }
            taken.push({ x0: p.x - half, x1: p.x + half, y0: p.y + dy - 8, y1: p.y + dy + 2.5 });
            labelY.set(n.id, +(p.y + dy).toFixed(1));
        }
    }
    const line = (e, i) => {
        const a = pos[e.source];
        const b = pos[e.target];
        if (!a || !b)
            return ''; // an endpoint the gates removed; never draw a stub
        return `<line class="ge ${e.layer}${e.dashed ? ' dash' : ''}" data-i="${i}" data-t="${born(e.firstTurn)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    };
    const dot = (n) => {
        const p = pos[n.id];
        if (!p)
            return '';
        const r = radius(n);
        // Shape, not colour, carries the layer: a diamond survives greyscale,
        // colour-blindness, and a stylesheet that failed to load.
        // A SQUARE for a dependency: a third shape for a third kind of claim, and a
        // deliberately blunt one. A circle was measured here, a diamond was written
        // here, and a square was declared somewhere else entirely and merely found.
        const body = n.layer === 'authored'
            ? `<polygon class="gs" points="${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}"/>`
            : n.layer === 'dependency'
                ? `<rect class="gs" x="${(p.x - r * 0.86).toFixed(1)}" y="${(p.y - r * 0.86).toFixed(1)}" width="${(r * 1.72).toFixed(1)}" height="${(r * 1.72).toFixed(1)}" rx="1.5"/>`
                : `<circle class="gs" cx="${p.x}" cy="${p.y}" r="${r}"/>`;
        // A conclusion carried in from an earlier session keeps the diamond -- the
        // layer is still the layer -- and gains a ring around it. A second outline
        // rather than a second colour, for the reason the diamond is a diamond: it
        // is still there in greyscale and still there when the stylesheet does not
        // load. The sidebar names the session and how far back it is; this is what
        // makes it visible without hovering every node on the canvas.
        const ring = n.carried
            ? `<polygon class="gring" points="${p.x},${(p.y - r - 3.4).toFixed(1)} ${(p.x + r + 3.4).toFixed(1)},${p.y} ${p.x},${(p.y + r + 3.4).toFixed(1)} ${(p.x - r - 3.4).toFixed(1)},${p.y}"/>`
            : '';
        // The accessible name carries the two things the shape carries, because a
        // screen reader gets neither the diamond nor the ring.
        const layerWord = n.layer === 'dependency' ? ' — declared by a manifest, not observed in this session' : '';
        const aria = `${n.label}${layerWord}${n.status ? ` — ${n.status}` : ''}${n.carried
            ? n.carried.sessionsAgo === null
                ? ' — carried from an earlier session, not this one'
                : ` — carried from a session ${n.carried.sessionsAgo} back, not this one`
            : ''}`;
        // One <text> per node and the full name in <title>/aria-label. An elided
        // label extracted from the DOM is still recoverable; a label split across
        // several <tspan>s comes back concatenated and wrong.
        return `<g class="gn ${n.layer} k-${kindClass(n.kind)}${n.carried ? ' carried' : ''}${n.status ? ` st-${kindClass(n.status)}` : ''}" data-id="${esc(n.id)}" data-t="${born(n.firstTurn)}"${hi(n) ? ' data-hi="1"' : ''} tabindex="0" role="img" aria-label="${esc(aria)}"><title>${esc(aria)}</title>${ring}${body}<text x="${p.x}" y="${labelY.get(n.id) ?? +(p.y + r + 11).toFixed(1)}">${esc(elide(n.label))}</text></g>`;
    };
    const derivedCount = nodes.filter((n) => n.layer === 'derived').length;
    const carriedNodes = nodes.filter((n) => n.carried);
    const depCount = nodes.filter((n) => n.layer === 'dependency').length;
    // Subtracted, not assumed. This was `length - derived - carried`, which was
    // right while there were two layers and would have counted every dependency
    // node as something the model wrote the moment there were three.
    const authoredCount = nodes.length - derivedCount - carriedNodes.length - depCount;
    // Counted off the NODES that were actually drawn, not off the intent document
    // -- the caps and the id rules can drop a thread, and a legend that counted
    // the input would print a number the canvas does not contain.
    const threadNodes = nodes.filter((n) => n.kind === 'intent' && !n.carried);
    const openThreads = threadNodes.filter((n) => n.status === 'abandoned' || n.status === 'ongoing').length;
    const drops = [...derived.suppressed, ...withDeps.dropped];
    const suppressedHtml = drops.length
        ? `<ul class="gsup">${drops
            .map((d) => `<li><b>${esc(String(d.dropped))}</b> ${esc(d.what)} not drawn &mdash; ${esc(d.why)}.</li>`)
            .join('')}</ul>`
        : '<p class="dim">Nothing was suppressed: every node the rules produced is on the page.</p>';
    const payload = {
        w: W, h: H, maxTurn, turns: session.turns.length,
        // Quoted, not paraphrased. intent.mts writes this sentence once so that a
        // renderer cannot turn "this is old" into "this is probably still right";
        // the sidebar prints whatever is in the document, and prints the store's
        // own default only when the document carried none.
        stale: String(intent?.staleness?.note || '').slice(0, 600) || null,
        nodes: nodes.map((n) => ({
            id: n.id, kind: n.kind, label: n.label, layer: n.layer,
            note: n.note || null, measured: n.measured || null, turns: n.turns || null, degree: n.degree,
            at: born(n.firstTurn),
            status: n.status || null,
            carried: n.carried ? { s: n.carried.session, ago: n.carried.sessionsAgo, days: n.carried.daysAgo } : null,
        })),
        edges: edges.map((e) => ({
            s: e.source, t: e.target, rel: e.rel || null, layer: e.layer, at: born(e.firstTurn),
        })),
    };
    // Stated in the legend rather than left to be inferred from the picture,
    // because the packer deliberately does not draw them the way the simulation
    // would: they are gridded, and a grid is a statement that there is no
    // structure to show, not a claim about who sits near whom.
    const cappedEdges = derived.suppressed.some((d) => d.what === 'edges');
    const loose = layout.isolated
        ? `<span class="ghalf dim" title="${esc(cappedEdges
            ? 'Not all of these lack an edge: the global edge cap fired on this session, so some lost theirs to it. See what the gates dropped, below.'
            : 'They carry no edge at all, so the grid is an arrangement and not a measurement.')}">${layout.isolated} connect to nothing drawn</span>`
        : '';
    // Removing the floor on the fit means everything lands inside the frame, and
    // for a very large graph that means everything lands inside the frame very
    // small. Saying so is the difference between a picture that is dense and a
    // picture that looks broken; the reader can then zoom, which is what the zoom
    // is for.
    const dense = layout.scale < 0.3
        ? `<span class="ghalf dim" title="Packed to ${Math.round(layout.scale * 100)}% to fit the frame. Nothing is cut off; it is simply smaller than this frame can show.">too dense to read at fit &mdash; zoom in</span>`
        : '';
    return `<h2>Knowledge graph</h2>
<div class="gwrap">
  <div class="glegend">
    <span class="ghalf"><b>Measured from the transcript</b> <i class="gk gcirc"></i> ${derivedCount} nodes</span>
    <span class="ghalf"><b>Written by the model, this session</b> <i class="gk gdia"></i> ${authoredCount} nodes</span>
    ${carriedNodes.length
        ? `<span class="ghalf"><b>Carried from an earlier session</b> <i class="gk gdia gcar"></i> ${carriedNodes.length} nodes</span>`
        : ''}
    ${depCount
        ? `<span class="ghalf"><b>Declared by the repository</b> <i class="gk gsq"></i> ${depCount} nodes, hidden until asked for</span>`
        : ''}
    ${threadNodes.length
        ? `<span class="ghalf dim" title="A thread hangs off the turns its author cited, and off a hub shared with the other threads of its status.">${threadNodes.length} threads, ${openThreads} unfinished</span>`
        : ''}
    ${loose}
    ${dense}
    <button id="gtog" class="gbtn gpush" type="button">Hide everything the model wrote</button>
    ${depCount
        ? `<button id="gdep" class="gbtn off" type="button" aria-pressed="false">Show what the repository declares (${depCount})</button>`
        : ''}
  </div>
  <div class="gcanvas" id="gcanvas" tabindex="0" aria-label="Knowledge graph canvas. Scroll to zoom, drag to pan, plus and minus to zoom, 0 to fit.">
    <svg viewBox="0 0 ${W} ${H}" id="qkg" aria-hidden="false">
      <g id="gview">
        <g id="gedges">${edges.map(line).join('')}</g>
        <g id="gnodes">${nodes.map(dot).join('')}</g>
      </g>
    </svg>
    <div class="gscale" id="gzl">100%</div>
    <div class="gzoom">
      <button type="button" data-z="out" aria-label="Zoom out">&minus;</button>
      <button type="button" data-z="in" aria-label="Zoom in">+</button>
      <button type="button" data-z="fit" class="wide">Fit</button>
    </div>
  </div>
  <aside id="gside" class="gside"><p class="dim">Hover or focus a node. A measured node prints the field it came from; a written one says so.</p></aside>
  ${session.turns.length > 1
        ? `<div class="greplay">
    <button id="gplay" class="gbtn" type="button">&#9654; Replay</button>
    <input id="gscrub" type="range" min="0" max="${maxTurn}" step="1" value="${maxTurn}" aria-label="Show the graph as it stood at this turn">
    <output id="gat" for="gscrub">all ${session.turns.length} turns</output>
  </div>`
        : ''}
</div>
<div class="gfoot">
  ${carriedNodes.length || (intent?.staleness?.priorOmitted ?? 0) > 0
        ? `<div class="glbl">Carried from earlier sessions</div>
  <p class="gcarry">${carriedNodes.length
            ? `${esc(String(carriedNodes.length))} of the shapes above were written in an earlier session of this project, not in this one. They keep the model layer's diamond and gain a ring around it, they hang off a hub of their own rather than this session's status hubs, and none of them is placed on the replay timeline &mdash; an earlier session's turn 4 is a different turn 4, so their citations are printed as prose naming their own session. The one toggle above subtracts them along with everything else the model wrote.`
            : 'Nothing from an earlier session is drawn on this canvas.'}${(intent?.staleness?.priorOmitted ?? 0) > 0
            ? ` The store holds ${esc(String(intent.staleness.priorOmitted))} earlier ${intent.staleness.priorOmitted === 1 ? 'session' : 'sessions'} that this page does not carry.`
            : ''}</p>
  <p class="gcarry dim">${esc(intent?.staleness?.note ||
            'Nothing has re-checked whether a conclusion from an earlier session still holds. Read the age as age, not as confidence.')}</p>`
        : ''}
  <div class="glbl">What the gates dropped</div>
  ${suppressedHtml}
  <div class="glbl">What this picture cannot say</div>
  <ul class="gnot">${NOT_SAID.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
</div>
<script>window.__qkg=${jsonForScript(payload)};</script>
`;
}
/**
 * One turn, filled out to the shape the packager iterates.
 *
 * `Turn` above is this file's own narrow view of a spine turn -- the dozen
 * fields the page paints -- while the JSON on disk carries roughly thirty. At
 * runtime the rest are simply present and pass straight through the spread. The
 * defaults exist for the inputs that are not a fresh spine: a fixture, or a
 * spine written by an older extract. `turns.csv` spreads `slashCommands`, so an
 * absent one is a TypeError that takes down the entire report over a button.
 */
function evidenceTurn(turn) {
    return {
        promptId: null,
        uuid: '',
        startedAt: '',
        endedAt: '',
        hasImage: false,
        typed: true,
        origin: null,
        // 0, not turn.text.length. Equal stored and full lengths read as "this
        // prompt was not truncated", which is the single thing the field exists to
        // let a reader disprove; a zero beside a non-zero stored length is
        // obviously missing data instead.
        fullChars: 0,
        assistantMessages: 0,
        subagents: 0,
        interruptions: 0,
        slashCommands: [],
        effort: null,
        firstToolAt: null,
        timeToFirstToolMs: null,
        models: [],
        model: null,
        mixedModel: false,
        ...turn,
        // `steering` is `unknown` in the view above, and the CSV writes it as a bit.
        steering: !!turn.steering,
        signals: { ...turn.signals },
        tokens: { input: 0, cacheRead: 0, cacheCreate: 0, ...turn.tokens },
        // Computed, not defaulted: `false` on a turn that genuinely ran no tools
        // would be a wrong row rather than a missing one.
        derived: {
            noToolCalls: turn.toolCallCount === 0,
            clarificationRoundtrip: false,
            followedByCorrection: false,
            ...turn.derived,
        },
        score: { ...turn.score },
    };
}
/**
 * The spine, widened to what the packager reads.
 *
 * Defaults first, the real session over them, then the nested objects merged
 * separately -- a spread only reaches one level, and `Object.keys` over an
 * absent `artifacts.packages` throws. The single cast is where this file's
 * narrow declaration and extract.mts's full one meet; both describe the same
 * JSON, and nothing here invents a value that a reader could mistake for a
 * measurement.
 */
function evidenceSpine(session) {
    const t = session.totals;
    return {
        sessionId: null,
        file: '',
        harness: '',
        project: '',
        cwd: null,
        gitBranch: null,
        version: null,
        title: null,
        startedAt: null,
        endedAt: null,
        models: {},
        slashCommands: [],
        permissionModes: [],
        ...session,
        artifacts: {
            packages: {}, tools: {}, stack: {}, extensions: {}, skills: {}, mcp: {}, fileTouches: 0,
            ...(session.artifacts ?? {}),
        },
        totals: {
            // Only what this file's own SessionTotals view does not already require.
            // A default for a field the view guarantees is dead code, and the
            // compiler says so.
            assistantMessages: 0, sidechainRecords: 0, compactions: 0, frictionRate: 0, corrections: 0,
            ...t,
            tokens: { input: 0, cacheCreate: 0, ...t.tokens },
        },
        score: {
            value: null, band: 'unscored', confidence: 'none', turnsScored: 0,
            frictionRate: 0, craftRate: 0, wastedTokens: 0,
            ...(session.score ?? {}),
        },
        turns: session.turns.map(evidenceTurn),
    };
}
const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : `${n} bytes`;
/**
 * The button, and everything a reader needs before they press it.
 *
 * The limits and the file list are rendered here, from the bundle, rather than
 * printed by the page script: they have to be readable with JavaScript off, and
 * they have to be readable BEFORE the download rather than after it. The
 * sentence at the top is the whole claim this feature is allowed to make.
 */
function renderEvidence(bundle) {
    const files = bundle.members
        .map((m) => `<li><code>${esc(m.name)}</code> · ${esc(fmtBytes(m.size))}<br><span class="evdg">${esc(m.sha256)}</span></li>`)
        .join('');
    const limits = bundle.limits.map((l) => `<li>${esc(l)}</li>`).join('');
    const n = String(bundle.members.length);
    return `<h2>Evidence package</h2>
<div class="card ev">
  <p class="evwhat">A zip of what this session did, read out of its own transcript — a record you can hand to someone who asks, not a certificate that anything was compliant.</p>
  <div class="evrow">
    <button id="evgo" class="copy" type="button" ${DOWNLOAD_HOOK}>Download the package</button>
    <span class="evmeta">${esc(bundle.filename)} · ${esc(n)} files · ${esc(fmtBytes(bundle.zipSize))} · built in this page, nothing is fetched</span>
  </div>
  <p class="evsay" id="evsay" role="status"></p>
  <noscript><p class="evsay bad">This button needs JavaScript, which is off. The package is assembled in the page, so nothing can be downloaded from here without it &mdash; the limits above are still readable, and re-running the command produces the same file.</p></noscript>
  <details class="evmore"><summary>What this record cannot show — ${esc(String(bundle.limits.length))} limits, and they travel with it as LIMITS.txt</summary><ol class="evlim">${limits}</ol></details>
  <details class="evmore"><summary>The ${esc(n)} files in it, and the SHA-256 each was generated with</summary><ul class="evfiles">${files}</ul></details>
</div>`;
}
/**
 * The click, wrapped so that a refusal is visible.
 *
 * bundle.mjs already binds its own delegated listener on `document` for the
 * same attribute, and that listener is the fallback if this script never runs.
 * When both run, one click writes the file twice -- so this one takes the event
 * in the CAPTURE phase and stops it there.
 *
 * What it buys is the failure path. An exception out of the packager's listener
 * is a console message on a page nobody has devtools open on, which the reader
 * experiences as a button that does nothing. Three refusals are detectable
 * before anything is built, and every other throw is caught and printed.
 *
 * The fourth is NOT detectable, and the success line says so rather than
 * claiming a save: a sandboxed viewer, or a browser told to block downloads,
 * takes the click, discards the file and reports nothing to the page. So the
 * page states what it actually did -- handed the file to the browser -- and
 * names the thing to try if no file appeared.
 */
function evidenceScript() {
    return `
(function(){
  var say=document.getElementById('evsay'); if(!say) return;
  function tell(m,bad){ say.textContent=m; say.className=bad?'evsay bad':'evsay'; }
  document.addEventListener('click',function(ev){
    var el=ev.target;
    if(!el||typeof el.closest!=='function'||!el.closest('[${DOWNLOAD_HOOK}]')) return;
    ev.stopPropagation(); ev.preventDefault();
    var api=window['${BUNDLE_GLOBAL}'];
    try{
      if(!api||typeof api.download!=='function') throw new Error('the package script on this page did not load');
      if(typeof URL==='undefined'||!URL.createObjectURL) throw new Error('this browser cannot assemble a file inside a page');
      if(!('download' in document.createElement('a'))) throw new Error('this browser will not save a file a page generated');
      api.download();
      tell('Handed '+api.filename+' to the browser. If no file appeared, downloads are blocked where this page is open — open the report in a browser tab and click again.');
    }catch(e){
      tell('The package could not be produced here: '+((e&&e.message)||e)+'. Nothing else on this page is affected.',1);
    }
  },true);
})();
`;
}
export function render(session, intent, meta) {
    const t = session.totals;
    const maxDur = Math.max(1, ...session.turns.map((x) => x.durationMs));
    const compactLine = intent?.compactInstruction ? `/compact ${intent.compactInstruction}` : null;
    // One clock reading for the whole page. The footer's stamp and the package's
    // `generatedAt` are then the same moment rather than two reads a few
    // milliseconds apart, so a reader holding the zip beside the page is
    // comparing one fact instead of two.
    //
    // Rounded to the minute, which is the resolution the footer has printed since
    // this page existed, and deliberately not finer. /qpact names its output file
    // after a hash of its INPUTS precisely so that re-rendering an unchanged spine
    // reuses the same document; a millisecond in the manifest would make every
    // render of one session a different file and quietly retire that. The zip's
    // own headers store time in two-second steps, so the precision being given up
    // here could never have reached the archive anyway.
    const now = new Date(`${new Date().toISOString().slice(0, 16)}:00.000Z`);
    const bundle = buildBundle(evidenceSpine(session), intent ?? null, {
        generatedAt: now.toISOString(),
        fingerprint: meta?.fingerprint,
        command: '/qpact',
        spineAgeMin: meta?.spineAgeMin,
    });
    const stats = [
        ['turns', t.humanTurns],
        ['tool calls', t.toolCalls],
        ['output tok', fmtTokens(t.tokens.output)],
        ['cache read', fmtTokens(t.tokens.cacheRead)],
        ['friction', `${t.frictionTurns}`, t.frictionTurns > 0],
        ['repeats', `${t.repeats}`, t.repeats > 0],
        ['interrupts', `${t.interruptions}`, t.interruptions > 0],
        ['span', fmtDur(session.durationMs)],
    ]
        .map(([l, n, hot]) => `<div class="stat${hot ? ' hot' : ''}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`)
        .join('');
    const turns = session.turns
        .map((turn) => {
        const fr = turn.friction.length;
        const tags = turn.friction.map((f) => `<span class="tag">${esc(FRICTION_LABEL[f] || f)}</span>`).join(' ');
        const flags = [
            turn.signals.hasAcceptanceCriteria && 'criteria',
            turn.signals.hasFileRef && 'file-ref',
            turn.signals.terse && 'terse',
            turn.signals.hasCodeBlock && 'code',
        ].filter(Boolean);
        const tools = turn.toolCalls.map((x) => `<span class="tool">${esc(x.name)}·${x.count}</span>`).join('');
        const pct = Math.round((turn.durationMs / maxDur) * 100);
        const repeat = turn.derived.repeatOf !== null ? `<p style="color:var(--bad);font-size:13px;margin:0 0 8px">Identical to turn #${turn.derived.repeatOf} — the first attempt did not land.</p>` : '';
        const sc = turn.score;
        const why = [
            ...sc.deductions.map((d) => `<li class="out">${d.points} — ${esc(d.why)}</li>`),
            ...sc.additions.map((a) => `<li class="add">+${a.points} — ${esc(a.why)}</li>`),
        ].join('');
        const steer = turn.steering ? '<span class="tool">steering</span>' : '';
        return `<details class="turn${fr ? ' friction' : ''}" data-friction="${fr ? 1 : 0}" data-terse="${turn.signals.terse ? 1 : 0}" data-criteria="${turn.signals.hasAcceptanceCriteria ? 1 : 0}" data-steering="${turn.steering ? 1 : 0}">
  <summary>
    <span class="idx">#${turn.index}</span>
    <span class="txt">${esc(turn.text.replace(/\s+/g, ' ').slice(0, 150))}</span>
    <span class="meta">${tags}<span class="chip${sc.value < 62 ? ' low' : ''}">${sc.value}</span><span class="bar"><i style="width:${pct}%"></i></span>${esc(fmtDur(turn.durationMs))} · ${esc(String(turn.toolCallCount))}t · ${esc(fmtTokens(turn.tokens.output))}</span>
  </summary>
  <div class="body">
    ${repeat}
    <pre>${esc(turn.text)}</pre>
    <div class="tools">${tools || '<span class="tool">no tools</span>'}${steer}${flags.map((f) => `<span class="tool">${esc(f)}</span>`).join('')}</div>
    ${why ? `<ul class="ded">${why}</ul>` : `<p class="ded" style="list-style:none;padding:0">Scored at the ${SCORE_BASE} baseline — nothing counted for or against it.</p>`}
  </div>
</details>`;
    })
        .join('\n');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>qpact — ${esc(session.title || session.sessionId?.slice(0, 8))}</title>
<script>
// Before the first paint, not after. A stylesheet that resolves to light and a
// script that corrects it a frame later is a flash of the wrong page.
try{var m=localStorage.getItem('qpact-theme');if(m==='dark'||m==='light')document.documentElement.dataset.theme=m;}catch(e){}
</script>
<style>${css()}</style><style>${brandCss()}</style></head><body><div class="wrap">

${brandHeader({
        command: '/qpact',
        // The theme button moves INTO the brand rail rather than keeping its own row
        // beneath one. Two stacked strips above the title is a banner; a single rail
        // carrying the mark, the command that produced the page and the page's own
        // control is the same chrome the other four wrappers wear.
        actions: '<button id="theme" type="button" title="Light, dark, or whatever this machine asks for">Theme: system</button>',
    })}

<div class="head">
  <div>
    <h1>${esc(session.title || 'Session analysis')}</h1>
    <div class="sub">${esc(session.sessionId)} · ${esc(session.cwd || '')} · ${esc(session.gitBranch || '')}</div>
  </div>
</div>

${compactLine
        ? `<div class="card compact"><div class="row">
  <code id="cl">${esc(compactLine)}</code>
  <button class="copy" id="cp" type="button" data-copy="cl">Copy</button>
</div></div>`
        : ''}

${renderScore(session)}

${intent?.tldr ? `<h2>TL;DR</h2><div class="card">${esc(intent.tldr)}</div>` : ''}

<h2>Session shape</h2>
<div class="stats">${stats}</div>

${intent?.sessionId && session.sessionId && intent.sessionId !== session.sessionId
        ? `<div class="gmismatch"><b>These two files describe different sessions.</b> The spine is ${esc(String(session.sessionId).slice(0, 8))} and the intent was written for ${esc(String(intent.sessionId).slice(0, 8))}. The analysis below mixes them. Re-run step 3.</div>`
        : ''}
${renderIntents(session, intent)}
${renderQuality(intent)}
${renderGraph(session, intent, meta?.bom)}

${renderAppendix(session, intent)}

${renderEvidence(bundle)}

<h2>Turns</h2>
<div class="filters">
  <button class="on" data-f="all">All ${session.turns.length}</button>
  <button data-f="friction">Friction ${t.frictionTurns}</button>
  <button data-f="steering">Steering ${t.steeringTurns}</button>
  <button data-f="terse">Terse</button>
  <button data-f="criteria">With criteria</button>
</div>
${turns || '<div class="empty">No human turns found.</div>'}

${brandFooter({
        command: '/qpact',
        at: now,
        // Every fragment this footer has printed since it existed, in the order it
        // printed them. brandFooter escapes each one, so nothing is pre-escaped here,
        // and the fingerprint keeps the <b> it has always had through `strong`.
        // These lines are why anyone believes a number on this page; the logo above
        // them is not allowed to cost a single one.
        facts: [
            `${t.records} records analysed`,
            'prompts redacted for secrets',
            meta?.fingerprint ? { label: 'fingerprint', value: meta.fingerprint, strong: true } : null,
            typeof meta?.spineAgeMin === 'number' ? `spine extracted ${meta.spineAgeMin} min ago` : null,
        ],
    })}
</div>
<script>
// One copy handler for every copyable thing on the page, delegated rather than
// wired per button. The compact line had this to itself; the follow-up prompts
// are one per unfinished thread, and a handler bound in a loop would be N
// closures that have to be rebound if anything ever re-renders a thread.
//
// data-copy names the element to read, so nothing here knows what a compact
// line or a follow-up prompt IS -- and #evgo, which is also .copy, carries no
// data-copy and is left alone.
document.addEventListener('click',async(ev)=>{
  const b=ev.target&&ev.target.closest?ev.target.closest('button.copy[data-copy]'):null;
  if(!b)return;
  const src=document.getElementById(b.getAttribute('data-copy'));
  if(!src)return;
  const label=b.textContent;
  try{await navigator.clipboard.writeText(src.textContent);}
  catch{const r=document.createRange();r.selectNode(src);
    getSelection().removeAllRanges();getSelection().addRange(r);document.execCommand('copy');}
  b.textContent=b.getAttribute('data-done')||'Copied';b.classList.add('done');
  setTimeout(()=>{b.textContent=label;b.classList.remove('done')},1600);
});
document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  const f=b.dataset.f;
  document.querySelectorAll('.turn').forEach(t=>{
    t.style.display = f==='all' || t.dataset[f]==='1' ? '' : 'none';
  });
});

// --- theme. Three states, not two: a page that only toggles is a page that has
// silently overridden whatever the machine asked for, with no way back to
// "follow the system".
(function(){
  var b=document.getElementById('theme'); if(!b) return;
  var order=['system','light','dark'];
  function now(){var m=document.documentElement.dataset.theme;return m==='light'||m==='dark'?m:'system';}
  function show(){b.textContent='Theme: '+now();}
  show();
  b.addEventListener('click',function(){
    var next=order[(order.indexOf(now())+1)%order.length];
    if(next==='system'){delete document.documentElement.dataset.theme;try{localStorage.removeItem('qpact-theme');}catch(e){}}
    else{document.documentElement.dataset.theme=next;try{localStorage.setItem('qpact-theme',next);}catch(e){}}
    show();
  });
})();

// --- knowledge graph: hover isolates a neighbourhood, the toggle subtracts the
// model's layer, the wheel zooms, the scrubber replays. The layer toggle is the
// real answer to "which is which": it is checkable rather than asserted.
//
// Positions are computed once, for the WHOLE graph, and never recomputed. So
// replay reveals nodes where they will finally sit rather than re-simulating a
// smaller graph at every step -- which would move every node on every frame and
// show off the layout algorithm instead of the session.
(function(){
  var d=window.__qkg; if(!d) return;
  // Counted off the payload, not interpolated a second time: the button's number
  // and the canvas's contents are then the same number by construction.
  var depTotal=d.nodes.filter(function(n){return n.layer==='dependency';}).length;
  var side=document.getElementById('gside'), tog=document.getElementById('gtog');
  var svg=document.getElementById('qkg'), view=document.getElementById('gview');
  var canvas=document.getElementById('gcanvas'), zl=document.getElementById('gzl');
  var scrub=document.getElementById('gscrub'), play=document.getElementById('gplay');
  var out=document.getElementById('gat');
  var nodes={}, adj={};
  d.nodes.forEach(function(n){ nodes[n.id]=n; adj[n.id]=[]; });
  d.edges.forEach(function(e,i){ if(adj[e.s])adj[e.s].push(i); if(adj[e.t])adj[e.t].push(i); });
  var gEls=[].slice.call(document.querySelectorAll('#gnodes .gn'));
  // A status hub's label carries a COUNT, and a count sitting on the canvas
  // reads as a tally of what is ON the canvas. It was written into the SVG once,
  // from the whole intent document, and paint() only ever toggled visibility --
  // so any frame between the hub's birth and the last thread's showed
  // "ongoing · 3" beside a single diamond, while the readout next to the
  // scrubber counted only what was visible and disagreed with it. That is the
  // same lie the side panel refuses to tell three functions down ("the panel
  // listing an edge to a node the scrubber has not reached yet is the same lie
  // as drawing the line would be, just in prose"). So the number is re-derived
  // per frame, from the threads the frame actually holds.
  var hubEls=gEls.filter(function(g){ return (nodes[g.getAttribute('data-id')]||{}).kind==='status'; });
  // Only the digits are rewritten. The label may have been elided when it was
  // drawn, and rebuilding it from the status would quietly un-elide it.
  // Doubled backslashes, deliberately. This whole script is a template literal,
  // where a backslash-s and a backslash-d are unrecognised escapes and collapse
  // to a bare s and d. The regex shipped matching a literal s and d, matched
  // nothing at all, and the label sat unchanged on the canvas while every check
  // that read the SOURCE agreed the rewrite was there.
  function recount(el,c){ if(!el)return; var t=el.textContent||''; var r=t.replace(/(\\u00b7\\s*)\\d+\\s*$/,'$1'+c); if(r!==t)el.textContent=r; }
  // ONE definition of "a toggle has hidden this", for nodes and edges alike.
  // Three handlers each spelling the comparison out is how a node ends up drawn
  // in a state another handler thinks it is hidden in -- and the hub recount
  // below is a third reader of it, which is what turned the duplication from a
  // style question into a real one. There are two toggles now and still one
  // predicate, which is the whole point.
  //
  // The dependency layer is off until asked for, and that is not a default it
  // could go either way on: it is the answer to a different question from the
  // rest of the canvas, and overlaying it unasked buries a session graph of a
  // hundred nodes under the repository's dependencies.
  var showDep=false;
  function offLayer(x){ return (hidden&&x.layer==='authored')||(!showDep&&x.layer==='dependency'); }
  var eEls=[].slice.call(document.querySelectorAll('#gedges .ge'));
  var hidden=false, pinned=null, upto=d.maxTurn;
  function esc(x){var p=document.createElement('p');p.textContent=x==null?'':String(x);return p.innerHTML;}
  function card(id){
    var n=nodes[id]; if(!n) return;
    // Only the relations that exist in the frame being displayed. The panel
    // listing an edge to a node the scrubber has not reached yet is the same
    // lie as drawing the line would be, just in prose -- and the count is
    // printed rather than the rest being dropped in silence.
    var at=function(x){var n=nodes[x];return n&&typeof n.at==='number'?n.at:-1;};
    var live=adj[id].filter(function(i){var e=d.edges[i];
      return e.at<=upto&&at(e.s)<=upto&&at(e.t)<=upto;});
    var held=adj[id].length-live.length;
    var rel=live.map(function(i){var e=d.edges[i];var o=e.s===id?e.t:e.s;
      return '<li>'+(e.s===id?'&rarr; ':'&larr; ')+esc((nodes[o]||{}).label||o)+(e.rel?' <i>'+esc(e.rel)+'</i>':'')+'</li>';}).join('')
      +(held?'<li class="dim">'+held+' more, not yet at turn '+upto+'</li>':'');
    // Three stamps, not two. A conclusion this session drew and one the store
    // kept from an earlier session are both "written by the model", and a panel
    // that says only that has told the reader this transcript produced work it
    // never witnessed.
    var ago=n.carried?(n.carried.ago===null||n.carried.ago===undefined?'an earlier recorded session'
      :n.carried.ago===1?'1 recorded session ago':n.carried.ago+' recorded sessions ago'):'';
    var days=n.carried&&typeof n.carried.days==='number'
      ?(n.carried.days===0?', recorded today':n.carried.days===1?', recorded 1 day ago':', recorded '+n.carried.days+' days ago')
      :'';
    var stamp=n.layer==='dependency'
      ? 'Declared by a manifest in this repository. Not measured from this transcript and not written by the model \u2014 it was true before this session opened.'
      : n.layer==='derived'
      ? esc(n.measured||'Measured from the transcript.')
      : n.carried
        ? 'Written by the model in session '+esc(String(n.carried.s).slice(0,8))+', '+esc(ago)+esc(days)
          +'. Not this session, and not measured.'
        : 'Written by the model at /qpact step 3. Not measured.';
    side.innerHTML='<h4>'+esc(n.label)+'</h4>'+
      '<span class="gstamp '+(n.carried?'carried':n.layer)+'">'+stamp+'</span>'+
      (n.status?'<p class="gstat">status: <b>'+esc(n.status)+'</b> — what the analysis wrote down, not an outcome anything measured</p>':'')+
      (n.note?'<p>'+esc(n.note)+'</p>':'')+
      (n.turns&&n.turns.length?'<p class="dim">turn '+n.turns.join(', ')+'</p>':'')+
      '<p class="dim">'+(n.at<0?'not attributable to a turn &mdash; present from the first frame'
        :'enters the replay at turn '+n.at)+'</p>'+
      // Quoted from the intent document, or, when it carried none, said in the
      // renderer's own words rather than in a note nobody wrote.
      (n.carried?'<p class="gstale">'+esc(d.stale||'Nothing has re-checked whether a conclusion from an earlier session still holds. Read the age as age, not as confidence.')+'</p>':'')+
      '<ul class="gsup">'+rel+'</ul>';
  }
  // One pass applies all three filters, because they compose: a node can be
  // unborn AND on the hidden layer AND outside the focused neighbourhood, and
  // three handlers fighting over one class list is how a node ends up drawn in
  // a frame it did not exist in.
  function paint(id){
    var near=null;
    if(id){ near={}; near[id]=1; adj[id].forEach(function(i){near[d.edges[i].s]=1;near[d.edges[i].t]=1;}); }
    var shown=0, live=0;
    gEls.forEach(function(g){
      var n=nodes[g.getAttribute('data-id')]||{};
      var pre=n.at>upto;
      var gone=offLayer(n);
      g.classList.toggle('pre',!!pre);
      g.classList.toggle('mute',!!(pre||gone||(near&&!near[n.id])));
      g.classList.toggle('near',!!(near&&near[n.id]&&!pre&&!gone));
      if(!pre&&!gone)shown++;
    });
    if(hubEls.length){
      var byStatus={};
      d.nodes.forEach(function(n){
        if(n.kind!=='intent'||n.carried||!n.status)return;
        if(n.at>upto)return;
        if(offLayer(n))return;
        byStatus[n.status]=(byStatus[n.status]||0)+1;
      });
      hubEls.forEach(function(g){
        var n=nodes[g.getAttribute('data-id')]||{};
        var c=byStatus[n.status]||0;
        recount(g.querySelector('text'),c);
        recount(g.querySelector('title'),c);
        var a=g.getAttribute('aria-label')||'';
        var ra=a.replace(/(\\u00b7\\s*)\\d+/,'$1'+c);
        if(ra!==a)g.setAttribute('aria-label',ra);
      });
    }
    eEls.forEach(function(l,i){
      var e=d.edges[i]||{};
      var pre=e.at>upto;
      var gone=offLayer(e);
      l.classList.toggle('pre',!!pre);
      var off=pre||gone||(near&&e.s!==id&&e.t!==id);
      l.classList.toggle('mute',!!off);
      l.classList.toggle('hot',!!(id&&(e.s===id||e.t===id)&&!off));
      if(!pre&&!gone)live++;
    });
    if(out)out.value=(upto>=d.maxTurn?'all '+d.turns+' turns':'turn '+upto+' of '+d.maxTurn)
      +' · '+shown+' nodes, '+live+' edges';
    if(id)card(id); else side.innerHTML='<p class="dim">Hover or focus a node. A measured node prints the field it came from; a written one says so.</p>';
  }
  gEls.forEach(function(g){
    var id=g.getAttribute('data-id');
    g.addEventListener('mouseenter',function(){paint(id);});
    g.addEventListener('focus',function(){paint(id);});
    g.addEventListener('mouseleave',function(){paint(pinned);});
    g.addEventListener('click',function(ev){
      ev.stopPropagation();
      if(moved>4)return; // that was a pan that crossed a node, not a click on it
      pinned=pinned===id?null:id;paint(pinned);
    });
  });
  if(tog)tog.addEventListener('click',function(){
    hidden=!hidden; tog.classList.toggle('off',hidden);
    tog.textContent=hidden?"Show everything the model wrote":"Hide everything the model wrote";
    paint(pinned);
  });
  var dep=document.getElementById('gdep');
  if(dep)dep.addEventListener('click',function(){
    showDep=!showDep; dep.classList.toggle('off',!showDep);
    dep.setAttribute('aria-pressed',showDep?'true':'false');
    dep.textContent=(showDep?"Hide what the repository declares":"Show what the repository declares")+" ("+depTotal+")";
    paint(pinned);
  });

  // ---- pan and zoom
  var k=1,tx=0,ty=0;
  function apply(){
    view.setAttribute('transform','translate('+tx.toFixed(2)+' '+ty.toFixed(2)+') scale('+k.toFixed(4)+')');
    // Every stroke width and font size on the canvas divides by this, so lines
    // and type keep their weight on screen while the structure spreads apart.
    svg.style.setProperty('--kgz',k);
    svg.classList.toggle('showall',k>=1.5);
    if(zl)zl.textContent=Math.round(k*100)+'%';
  }
  function zoomAt(px,py,nk){
    nk=Math.max(0.45,Math.min(9,nk));
    tx=px-(px-tx)*(nk/k); ty=py-(py-ty)*(nk/k); k=nk; apply();
  }
  function fit(){k=1;tx=0;ty=0;apply();}
  function pt(ev){var r=svg.getBoundingClientRect();
    return [(ev.clientX-r.left)/(r.width||1)*d.w,(ev.clientY-r.top)/(r.height||1)*d.h];}
  // Pinch and ctrl-wheel zoom; a plain wheel scrolls the PAGE. The canvas
  // used to take every wheel event, so on a phone or a trackpad the page
  // stopped dead at the graph and a swipe meant to reach the next section
  // zoomed the picture to 45% instead. A trackpad pinch arrives as a wheel
  // with ctrlKey set, which is the gesture that means zoom.
  canvas.addEventListener('wheel',function(ev){
    if(!(ev.ctrlKey||ev.metaKey))return;
    ev.preventDefault();
    // deltaMode is lines on some browsers and pages on others. Reading all three
    // as pixels makes the wheel almost inert everywhere that does not use them.
    var dy=ev.deltaY*(ev.deltaMode===1?16:ev.deltaMode===2?400:1);
    var p=pt(ev); zoomAt(p[0],p[1],k*Math.pow(1.0016,-dy));
  },{passive:false});

  // Deliberately no setPointerCapture: capturing redirects the pointerup to the
  // canvas, so the click that follows is dispatched to the canvas too and
  // selecting a node stops working entirely.
  var dragging=false,lx=0,ly=0,moved=0;
  canvas.addEventListener('pointerdown',function(ev){
    if(ev.button!==0)return;
    dragging=true;moved=0;lx=ev.clientX;ly=ev.clientY;canvas.classList.add('grab');
  });
  window.addEventListener('pointermove',function(ev){
    if(!dragging)return;
    var r=svg.getBoundingClientRect();
    moved+=Math.abs(ev.clientX-lx)+Math.abs(ev.clientY-ly);
    tx+=(ev.clientX-lx)/(r.width||1)*d.w; ty+=(ev.clientY-ly)/(r.height||1)*d.h;
    lx=ev.clientX;ly=ev.clientY;apply();
  });
  function endDrag(){ if(!dragging)return; dragging=false; canvas.classList.remove('grab'); }
  window.addEventListener('pointerup',endDrag);
  window.addEventListener('pointercancel',endDrag);
  canvas.addEventListener('dblclick',function(ev){
    // Only the empty canvas resets the view. dblclick bubbles, so without this
    // a double click on a node -- or a quick second press of the + button --
    // threw away the zoom the reader had just dialled in.
    if(ev.target&&ev.target.closest&&(ev.target.closest('.gn')||ev.target.closest('.gzoom')))return;
    fit();
  });
  [].slice.call(document.querySelectorAll('.gzoom button')).forEach(function(b){
    b.addEventListener('click',function(ev){
      ev.stopPropagation();
      var z=b.getAttribute('data-z');
      if(z==='fit')fit(); else zoomAt(d.w/2,d.h/2,z==='in'?k*1.45:k/1.45);
    });
  });
  canvas.addEventListener('keydown',function(ev){
    // Ctrl/Cmd +, - and 0 are the browser's page zoom. Branching on ev.key
    // alone took all three away from anyone who reads at 125%.
    if(ev.ctrlKey||ev.metaKey||ev.altKey)return;
    // A constant step, NOT 70/k. tx is in unscaled viewBox units, so dividing
    // by the zoom shrinks the on-screen movement exactly as the canvas gets
    // bigger -- surveying a 4x view cost sixteen times the presses.
    var step=70, hit=true;
    if(ev.key==='+'||ev.key==='=')zoomAt(d.w/2,d.h/2,k*1.45);
    else if(ev.key==='-'||ev.key==='_')zoomAt(d.w/2,d.h/2,k/1.45);
    else if(ev.key==='0')fit();
    else if(ev.key==='ArrowLeft'){tx+=step;apply();}
    else if(ev.key==='ArrowRight'){tx-=step;apply();}
    else if(ev.key==='ArrowUp'){ty+=step;apply();}
    else if(ev.key==='ArrowDown'){ty-=step;apply();}
    else hit=false;
    if(hit)ev.preventDefault();
  });

  // ---- replay
  var timer=null;
  function stop(){ if(timer){clearInterval(timer);timer=null;} if(play)play.textContent='▶ Replay'; }
  function setUpto(v){
    upto=v; if(scrub)scrub.value=String(v);
    // Drop a pin the scrubber has just rewound past. Focus dims everything
    // outside the pinned node's neighbourhood, so a pin on a node that does not
    // exist in this frame greys out the entire frame around an absence.
    if(pinned&&nodes[pinned]&&nodes[pinned].at>upto)pinned=null;
    paint(pinned);
  }
  if(scrub)scrub.addEventListener('input',function(){ stop(); setUpto(+scrub.value); });
  if(play)play.addEventListener('click',function(){
    if(timer){stop();return;}
    setUpto(0);
    play.textContent='❚❚ Pause';
    // A fixed step per turn makes a 300-turn session unwatchable, so the whole
    // replay is budgeted at about eleven seconds however many turns there are.
    var ms=Math.max(70,Math.round(11000/Math.max(1,d.maxTurn+1)));
    timer=setInterval(function(){ if(upto>=d.maxTurn){stop();return;} setUpto(upto+1); },ms);
  });

  // ---- the swell
  //
  // The canvas drifts, the way a raft of floats drifts on moving water. It is
  // ornament and it is deliberately the KIND of ornament that cannot be read as
  // data, which on a page whose whole claim is "these positions were measured"
  // is the only kind allowed here.
  //
  // Two rules keep it honest, and both are properties of the field rather than
  // promises about it:
  //
  //   COHERENT, NOT PER-NODE. The offset is a function of a node's own position,
  //   so neighbours move together and the whole picture sways as one surface. A
  //   field of independently jittering dots reads as "these values are
  //   updating"; a swell reads as "the surface is moving", which is what it is.
  //
  //   SMALLER THAN THE STRUCTURE. The amplitude is a few units against a
  //   1000x620 canvas and against a layout whose nearest pair sits far further
  //   apart than that, so no node ever visibly changes who it sits beside. A
  //   drift that could reorder the picture would be making a claim.
  //
  // Amplitude divides by the zoom, so the motion is constant in SCREEN pixels.
  // Without that, a reader who zoomed to 9x to read one label would be watching
  // it thrash across a third of the viewport.
  //
  // Heavier nodes move less: a node's weight is its degree, so the hubs the
  // layout worked hardest to place are the steadiest things on the canvas and
  // the loose ends bob most. That is also what keeps the isolated grid legible
  // while it moves -- its members are all degree 0 and all move in step.
  var swimming=false, swimRaf=null, swimLast=0, onScreen=true;
  var reduce=window.matchMedia?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
  // Every edge's endpoints, read ONCE and before anything writes them. Read
  // lazily per frame they would be the previous frame's drifted values, and the
  // graph would walk off the canvas in about four seconds.
  var eBase=eEls.map(function(l){
    var i=+(l.getAttribute('data-i')||-1);
    var e=d.edges[i]||{};
    return {el:l, s:e.s, t:e.t,
      x1:l.x1.baseVal.value, y1:l.y1.baseVal.value,
      x2:l.x2.baseVal.value, y2:l.y2.baseVal.value};
  });
  // data-i, not the array index. line() emits nothing for an edge whose endpoint
  // the gates removed, so the nth <line> is not always the nth edge -- and an
  // off-by-one here does not throw, it silently ties a line to the wrong node
  // and shears the graph.
  var swimNodes=gEls.map(function(g){
    var n=nodes[g.getAttribute('data-id')]||{};
    // A stable per-node phase so two nodes at the same point do not lock
    // together. Derived from the id, so it is the same on every render of the
    // same session -- this page is a snapshot and two openings of it should not
    // be two different pictures.
    var h=0, id=String(n.id||'');
    for(var c=0;c<id.length;c++){ h=(h*31+id.charCodeAt(c))>>>0; }
    return {el:g, id:n.id, seed:(h%1000)/1000*6.283,
      weight:1/(1+Math.min(6,(n.degree||0))*0.22), x:0, y:0};
  });
  // Where each node sits, read off its label rather than its shape: a circle
  // carries cx, a diamond carries a points list and a square carries a corner,
  // while the <text> carries a plain x and y on all three. The label's y sits a
  // few units below the node it belongs to, which is immaterial -- this feeds a
  // phase, not a position, and a phase shifted by a tenth of a wavelength is
  // the same field.
  swimNodes.forEach(function(s){
    var t=s.el.querySelector('text');
    s.x=t?t.x.baseVal.getItem(0).value:0;
    s.y=t?t.y.baseVal.getItem(0).value:0;
  });
  var off={};
  function swimFrame(ms){
    swimRaf=null;
    if(!swimming)return;
    // ~30fps. The eye cannot tell this from 60 on motion this slow, and it
    // halves the attribute writes on a canvas that can carry 200 elements.
    if(ms-swimLast>=32){
      swimLast=ms;
      var t=ms*0.001;
      // Amplitude in screen pixels, converted back to viewBox units by the live
      // zoom. 3.4 is the largest value at which a 20-minute look at this page
      // still reads as calm.
      var A=3.4/Math.max(0.45,k);
      for(var i=0;i<swimNodes.length;i++){
        var s=swimNodes[i];
        // Three incommensurate periods per axis -- roughly 17, 10 and 28
        // seconds -- so the field never returns to a pose anybody can catch it
        // repeating. The x and y terms of the spatial phase differ, which is
        // what tilts the wave across the canvas instead of running it straight
        // down one axis.
        var ph=s.x*0.0113+s.y*0.0171;
        var a=A*s.weight;
        off[s.id]=[
          a*(Math.sin(t*0.37+ph)+0.55*Math.sin(t*0.61-s.y*0.0231+s.seed)),
          a*(Math.cos(t*0.29+ph*1.31)+0.55*Math.cos(t*0.53+s.x*0.0194+s.seed))
        ];
      }
      for(var j=0;j<swimNodes.length;j++){
        var sn=swimNodes[j], o=off[sn.id];
        sn.el.setAttribute('transform','translate('+o[0].toFixed(2)+' '+o[1].toFixed(2)+')');
      }
      for(var m=0;m<eBase.length;m++){
        var b=eBase[m], a1=off[b.s], b1=off[b.t];
        if(!a1||!b1)continue;
        b.el.setAttribute('x1',(b.x1+a1[0]).toFixed(2));
        b.el.setAttribute('y1',(b.y1+a1[1]).toFixed(2));
        b.el.setAttribute('x2',(b.x2+b1[0]).toFixed(2));
        b.el.setAttribute('y2',(b.y2+b1[1]).toFixed(2));
      }
    }
    swimRaf=requestAnimationFrame(swimFrame);
  }
  // Put everything back exactly where it was laid out. Stopping without this
  // freezes the whole canvas at whatever offsets the last frame happened to
  // hold, which is a layout nobody computed -- and under prefers-reduced-motion
  // it would be the ONLY layout that reader ever sees.
  function swimRest(){
    swimNodes.forEach(function(s){ s.el.removeAttribute('transform'); });
    eBase.forEach(function(b){
      b.el.setAttribute('x1',b.x1); b.el.setAttribute('y1',b.y1);
      b.el.setAttribute('x2',b.x2); b.el.setAttribute('y2',b.y2);
    });
  }
  function swimStop(){
    if(!swimming)return;
    swimming=false;
    if(swimRaf){cancelAnimationFrame(swimRaf);swimRaf=null;}
    swimRest();
  }
  function swimStart(){
    if(swimming)return;
    if(reduce&&reduce.matches)return;
    if(document.hidden)return;
    if(!onScreen)return;
    swimming=true; swimLast=0;
    swimRaf=requestAnimationFrame(swimFrame);
  }
  // Off the screen is off. A report is a long page and this graph sits a long
  // way down it; animating it while somebody reads the tables above burns a
  // core for a picture nobody is looking at.
  if(window.IntersectionObserver){
    onScreen=false;
    new IntersectionObserver(function(es){
      onScreen=es.some(function(e){return e.isIntersecting;});
      if(onScreen)swimStart(); else swimStop();
    },{rootMargin:'120px'}).observe(canvas);
  }
  document.addEventListener('visibilitychange',function(){
    if(document.hidden)swimStop(); else swimStart();
  });
  // Reduced motion is honoured when it CHANGES, not only at load: somebody who
  // turns it on in the system settings while this page is open is asking for
  // the motion to stop now, and a page that only read the value once tells them
  // the setting does not work.
  if(reduce){
    var onReduce=function(){ if(reduce.matches)swimStop(); else swimStart(); };
    if(reduce.addEventListener)reduce.addEventListener('change',onReduce);
    else if(reduce.addListener)reduce.addListener(onReduce);
  }
  swimStart();

  apply(); paint(null);
})();
</script>
<script>${bundleScript(bundle)}</script>
<script>${evidenceScript()}</script>
</body></html>`;
}
// ---------------------------------------------------------------- cli
// Comparing basenames by suffix made this module the entry point whenever the
// process was started from any script whose name ends the same way — a sibling
// render.mjs, or even er.mjs — so importing render() ran the CLI and exited.
// Resolved real paths are the only comparison that answers "am I the entry".
const realPath = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
};
const isMain = !!process.argv[1] && realPath(fileURLToPath(import.meta.url)) === realPath(process.argv[1]);
if (isMain) {
    const argv = process.argv.slice(2);
    const opt = (n, d = null) => {
        const i = argv.indexOf(n);
        return i >= 0 ? argv[i + 1] : d;
    };
    // A flag's value is not a positional argument. Without this, `--intent
    // intent.json spine.json` rendered the intent file as the spine.
    const VALUE_FLAGS = new Set(['--intent', '-o', '--out', '--followup']);
    const spinePath = argv
        .filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1] ?? ''))
        .find((a) => a.endsWith('.json'));
    if (!spinePath) {
        console.error('usage: render.mjs spine.json [--intent intent.json] [-o out.html] [--open] [--no-bom]\n' +
            '       render.mjs spine.json --intent intent.json --followup <thread>   print one thread\n' +
            '       render.mjs spine.json --intent intent.json --followups           list the unfinished ones\n' +
            '\n' +
            '  --no-bom  skip the repository scan. The page then draws no dependency layer\n' +
            '            and offers no toggle for one, which is a different page from one\n' +
            '            whose repository has no manifest -- that case says so.');
        process.exit(1);
    }
    const session = JSON.parse(readFileSync(spinePath, 'utf8'));
    const intentPath = opt('--intent');
    const intent = intentPath ? JSON.parse(readFileSync(intentPath, 'utf8')) : null;
    // ---- the text path to the same drill-down the page's button produces
    //
    // Same builder, same bytes. The page and this share followupPrompt(), so the
    // person reading a terminal and the person reading the page cannot be handed
    // two different accounts of one thread -- and test/followup.mjs compares the
    // two outputs directly, which is what keeps that true rather than intended.
    const wantList = argv.includes('--followups');
    // A sentinel, not `undefined`. `--followup` as the LAST argument makes
    // opt() return undefined, which is indistinguishable from the flag being
    // absent -- so a bare `--followup` quietly rendered a whole page instead of
    // saying which thread it wanted.
    const asked = argv.includes('--followup');
    const wantThread = asked ? String(opt('--followup') ?? '') : null;
    if (wantList || asked) {
        // The page raises a banner on this and the run below warns on stderr — but
        // both of those come AFTER a branch that exits here, so the one surface
        // built to be copied elsewhere was the only one that never checked. The
        // prompt states it in its own text too; this is for whoever is watching the
        // terminal.
        if (intent?.sessionId && session.sessionId && intent.sessionId !== session.sessionId)
            console.error(`warning: intent.sessionId (${String(intent.sessionId).slice(0, 8)}) does not match the spine ` +
                `(${session.sessionId.slice(0, 8)}) -- these are different sessions, and the prompt says so too`);
        const items = intent?.intents ?? [];
        if (!items.length) {
            console.error(intentPath
                ? 'that intent file names no threads, so there is nothing to drill into'
                : 'no --intent file was given, and the spine alone holds no threads: /qpact step 3 is what writes them');
            process.exit(1);
        }
        const attr = attribute(session, items);
        const eligible = items.map((it, i) => ({ it, i })).filter(({ it }) => unfinished(it));
        const listing = () => eligible.length
            ? eligible
                .map(({ it, i }) => `  ${String(i).padEnd(3)} ${threadSlug(String(it.title || '')) || String(i)}\n      ${it.status} — ${it.title}`)
                .join('\n')
            // Not "every thread is done or partial": a status outside the four this
            // tool knows is neither, and this line would have called it finished.
            : '  (none: no thread the analysis named is marked abandoned or ongoing)';
        if (wantList) {
            console.log(`${eligible.length} of ${items.length} thread(s) were left abandoned or ongoing.\n` +
                'A done thread has nothing to drill into and is not listed.\n' +
                (intent?.sessionId && session.sessionId && intent.sessionId !== session.sessionId
                    ? `These threads were written about session ${String(intent.sessionId).slice(0, 8)}, not about the spine ` +
                        `given here (${session.sessionId.slice(0, 8)}).\n`
                    : '') +
                listing());
            process.exit(0);
        }
        const want = String(wantThread ?? '').trim();
        // A flag's own value, never the next flag: `--followup --open` asked for a
        // thread called "--open" and got a listing that did not mention why.
        if (!want) {
            console.error(`--followup needs a thread. The ones that have a drill-down:\n${listing()}`);
            process.exit(1);
        }
        // Index first, because it is unambiguous; then an exact slug; then a unique
        // prefix. An ambiguous prefix is refused by name rather than resolved to
        // whichever thread happens to sort first.
        if (want.startsWith('--')) {
            console.error(`--followup takes a thread, not the flag "${want}". The ones that have a drill-down:\n${listing()}`);
            process.exit(1);
        }
        const byIndex = /^\d+$/.test(want) ? Number(want) : -1;
        const slugs = items.map((it, i) => threadSlug(String(it.title || '')) || String(i));
        let pick = byIndex >= 0 && byIndex < items.length ? byIndex : slugs.indexOf(want);
        if (pick < 0) {
            const hits = slugs.map((sl, i) => (sl.startsWith(want) ? i : -1)).filter((i) => i >= 0);
            if (hits.length > 1) {
                console.error(`"${want}" matches ${hits.length} threads: ${hits.map((i) => slugs[i]).join(', ')}`);
                process.exit(1);
            }
            pick = hits[0] ?? -1;
        }
        if (pick < 0) {
            console.error(`no thread called "${want}". The ones that have a drill-down:\n${listing()}`);
            process.exit(1);
        }
        if (!unfinished(items[pick])) {
            // A refusal and not a courtesy print. The whole rule is that a finished
            // thread has no open question, so producing a prompt that asks one would
            // be the page's claim inverted at the command line.
            console.error(`"${items[pick].title}" is ${items[pick].status || 'unstated'}, so it has no drill-down. ` +
                'Only an abandoned or ongoing thread has something left open to ask about.\n' +
                `The ones that do:\n${listing()}`);
            process.exit(1);
        }
        console.log(followupPrompt(session, items, attr, pick, intent?.sessionId ? String(intent.sessionId) : null));
        process.exit(0);
    }
    // Content-hashed filename: the load-bearing staleness mechanism.
    //
    // Hash the INPUTS, not the output -- the footer carries a wall clock, so
    // hashing rendered bytes would mint a new URL on every run even when the
    // analysis is identical, filling /tmp and destroying the useful property that
    // the same analysis is the same URL.
    //
    // The renderer's OWN bytes are in the hash, and that is not belt-and-braces.
    // version() reads the plugin manifest -- the release version, not the build --
    // and returns 'unknown' with no manifest. Editing render.mts within one
    // version would otherwise leave the path byte-identical, and `open` on an
    // unchanged path focuses the existing tab without reloading. That is exactly
    // the environment this feature is developed in, so the bug would survive
    // where it is most likely to be seen.
    const selfBytes = () => {
        try {
            const here = realPath(fileURLToPath(import.meta.url));
            const dir = dirname(here);
            // brand.mjs and bundle.mjs are in here for the reason the comment above
            // gives about render.mjs itself: both now write bytes into every page,
            // and an edit to either within one version would otherwise leave the
            // output path byte-identical, so `open` would focus the stale tab.
            return ['render.mjs', 'graph.mjs', 'brand.mjs', 'bundle.mjs']
                .map((f) => {
                try {
                    return readFileSync(join(dir, f), 'utf8');
                }
                catch {
                    return '';
                }
            })
                .join('');
        }
        catch {
            return '';
        }
    };
    const sid8 = (session.sessionId || 'session').slice(0, 8);
    const hash8 = crypto
        .createHash('sha256')
        .update(readFileSync(spinePath, 'utf8'))
        .update(intentPath ? readFileSync(intentPath, 'utf8') : '')
        .update(version())
        .update(selfBytes())
        .digest('hex')
        .slice(0, 8);
    const explicitOut = opt('-o') || opt('--out');
    const out = explicitOut || `/tmp/qpact-${sid8}-${hash8}.html`;
    // 0600: the page embeds verbatim prompt text and lands in a shared /tmp.
    const spineAgeMin = (() => {
        try {
            return Math.round((Date.now() - statSync(spinePath).mtimeMs) / 60000);
        }
        catch {
            return undefined;
        }
    })();
    // The bill, read HERE and not inside render(): readSbom walks a directory
    // tree, and a renderer that touches the filesystem cannot be handed a spine
    // from another machine -- which is exactly what /qshare and the cloud console
    // do with it.
    //
    // Opt-out rather than opt-in, because it costs a bounded local scan and no
    // network. `--no-bom` skips it; a repository with no manifest is a stated
    // result rather than a silent absence, and a scan that throws leaves the page
    // exactly as it was before this existed.
    const bom = (() => {
        if (argv.includes('--no-bom'))
            return null;
        const root = typeof session.cwd === 'string' ? session.cwd : '';
        if (!root)
            return null;
        try {
            const sbom = readSbom(root);
            return { sbom, matched: matchImportRoots(sbom, Object.keys(session.artifacts?.packages ?? {})) };
        }
        catch {
            // A page that renders without the layer is better than no page. The
            // toggle simply does not appear.
            return null;
        }
    })();
    writeFileSync(out, render(session, intent, { fingerprint: hash8, spineAgeMin, bom }), { mode: 0o600 });
    chmodSync(out, 0o600); // writeFileSync honours mode only when it creates the file
    // Remove superseded pages for this session. Be precise about what this buys:
    // it stops a stale URL being re-servable and keeps /tmp from filling. It does
    // NOT close or reload a tab that is already open -- an unlinked file leaves
    // the loaded DOM exactly where it is. Nothing here can close that tab; the
    // hash in the filename and the fingerprint below are what let a reader
    // DETECT one, which is the weaker and honest claim.
    if (!explicitOut) {
        try {
            for (const f of readdirSync('/tmp'))
                if (f.startsWith(`qpact-${sid8}-`) && f.endsWith('.html') && f !== `qpact-${sid8}-${hash8}.html`)
                    try {
                        unlinkSync(join('/tmp', f));
                    }
                    catch {
                        /* another run may have taken it already */
                    }
        }
        catch {
            /* no /tmp listing; the hashed name still does the work */
        }
    }
    if (intent && intent.sessionId && session.sessionId && intent.sessionId !== session.sessionId)
        console.error(`warning: intent.sessionId (${intent.sessionId.slice(0, 8)}) does not match the spine (${session.sessionId.slice(0, 8)}) -- the page says so too`);
    console.log(out);
    console.log(`fingerprint ${hash8} - compare this against the footer of the page you are looking at`);
    if (argv.includes('--open')) {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execFile(cmd, [out], (err) => {
            if (err)
                console.error(`could not open a window: ${err.message}\nfile is at ${out}`);
        });
    }
}
