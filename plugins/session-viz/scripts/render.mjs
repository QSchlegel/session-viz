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
import { deriveGraph, mergeAuthored, layoutGraph } from './graph.mjs';
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
};
const KIND_LIGHT = {
    session: '#b45f1f', harness: '#2c7676', repo: '#b45f1f', model: '#2f6fae',
    tool: '#4d8a2f', mcp: '#2c7676', skill: '#8a6712', cli: '#4d8a2f',
    package: '#2f6fae', stack: '#94438a', ext: '#94438a', slash: '#8a6712',
    mode: '#63636f', friction: '#b8402f', turn: '#6b6b78',
    decision: '#15803d', defect: '#b91c1c', guard: '#92400e',
    thread: '#7c22ce', subsystem: '#1d4ed8', question: '#57534e', concept: '#57534e',
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
  --bar:#d9d4cb; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:light;
  --kg-bg:#f3f0ea; --kg-halo:#f3f0ea; --kg-ring:#f3f0ea; --kg-label:#26251f;
  --kg-edge:#8d8779; --kg-edge-au:#7c3aed; --alarm:#b3261e; --alarm-ink:#fff;
  ${kindVars(KIND_LIGHT)}
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#16151a; --panel:#1e1d23; --ink:#ece9e4; --muted:#9b968d; --dim:#9b968d; --line:#302e37;
  --accent:#ff8a4c; --accent-soft:#2a1d16; --ok:#6fbf8e; --warn:#e0b055; --bad:#ff6b5e;
  --bar:#3a3742;
  color-scheme:dark;
  --kg-bg:#131218; --kg-halo:#131218; --kg-ring:#131218; --kg-label:#d8d6dc;
  --kg-edge:#6b6b76; --kg-edge-au:#b07acb; --alarm:#c02a20; --alarm-ink:#fff;
  ${kindVars(KIND_DARK)}
}}
:root[data-theme=dark]{
  --bg:#16151a; --panel:#1e1d23; --ink:#ece9e4; --muted:#9b968d; --dim:#9b968d; --line:#302e37;
  --accent:#ff8a4c; --accent-soft:#2a1d16; --ok:#6fbf8e; --warn:#e0b055; --bad:#ff6b5e;
  --bar:#3a3742;
  color-scheme:dark;
  --kg-bg:#131218; --kg-halo:#131218; --kg-ring:#131218; --kg-label:#d8d6dc;
  --kg-edge:#6b6b76; --kg-edge-au:#b07acb; --alarm:#c02a20; --alarm-ink:#fff;
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
.head{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
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
.chip{font-family:var(--mono);font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;
  border:1px solid var(--line);color:var(--muted)}
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

/* turns */
.filters{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.filters button{background:var(--panel);border:1px solid var(--line);color:var(--muted);
  border-radius:999px;padding:5px 13px;font-size:12px;cursor:pointer;font-weight:500}
.filters button.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.turn{border:1px solid var(--line);border-radius:9px;background:var(--panel);
  margin-bottom:7px;overflow:hidden}
.turn.friction{border-left:3px solid var(--bad)}
.turn > summary{padding:11px 15px;cursor:pointer;display:grid;
  grid-template-columns:34px 1fr auto;gap:12px;align-items:center;list-style:none}
.turn > summary::-webkit-details-marker{display:none}
.turn > summary:hover{background:var(--accent-soft)}
.idx{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right}
.txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.meta{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;
  display:flex;gap:9px;align-items:center}
.bar{height:4px;background:var(--bar);border-radius:2px;width:54px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bad);color:#fff;
  font-weight:600;letter-spacing:.03em}
.body{padding:2px 15px 16px 61px;border-top:1px solid var(--line)}
.body pre{font-family:var(--mono);font-size:12.5px;white-space:pre-wrap;word-break:break-word;
  background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:11px;margin:12px 0}
.tools{display:flex;gap:6px;flex-wrap:wrap}
.tool{font-family:var(--mono);font-size:11px;background:var(--bg);border:1px solid var(--line);
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
.gstamp.derived{background:rgba(21,128,61,.12);border:1px solid rgba(21,128,61,.45)}
.gstamp.authored{background:rgba(147,51,234,.12);border:1px solid rgba(147,51,234,.45)}
.gfoot{margin:12px 0 0;font-size:12.5px}
.glbl{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);
  font-weight:640;margin:12px 0 5px}
.gsup,.gnot{margin:0;padding-left:18px}
.gsup li,.gnot li{margin:2px 0}
.gnot li{color:var(--dim)}
.gmismatch{background:var(--alarm);color:var(--alarm-ink);padding:10px 14px;border-radius:8px;margin:0 0 14px;font-size:13.5px}

`;
}
function renderIntents(intent) {
    if (!intent?.intents?.length)
        return '';
    const items = intent.intents
        .map((i) => `<div class="intent ${esc(i.status || 'ongoing')}">
  <h3>${esc(i.title)}<span class="pill">${esc(i.status || '')}</span></h3>
  <p>${esc(i.summary || '')}</p>
</div>`)
        .join('\n');
    return `<h2>Intent breakdown</h2>\n${items}`;
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
    'No file appears here. The spine records that a file was touched, never which one.',
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
function renderGraph(session, intent) {
    const derived = deriveGraph(session);
    const merged = mergeAuthored(derived, intent?.graph, session.turns.length);
    const { nodes, edges } = merged;
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
        const body = n.layer === 'authored'
            ? `<polygon class="gs" points="${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}"/>`
            : `<circle class="gs" cx="${p.x}" cy="${p.y}" r="${r}"/>`;
        // One <text> per node and the full name in <title>/aria-label. An elided
        // label extracted from the DOM is still recoverable; a label split across
        // several <tspan>s comes back concatenated and wrong.
        return `<g class="gn ${n.layer} k-${kindClass(n.kind)}" data-id="${esc(n.id)}" data-t="${born(n.firstTurn)}"${hi(n) ? ' data-hi="1"' : ''} tabindex="0" role="img" aria-label="${esc(n.label)}"><title>${esc(n.label)}</title>${body}<text x="${p.x}" y="${labelY.get(n.id) ?? +(p.y + r + 11).toFixed(1)}">${esc(elide(n.label))}</text></g>`;
    };
    const derivedCount = nodes.filter((n) => n.layer === 'derived').length;
    const authoredCount = nodes.length - derivedCount;
    const drops = [...derived.suppressed, ...merged.dropped];
    const suppressedHtml = drops.length
        ? `<ul class="gsup">${drops
            .map((d) => `<li><b>${esc(String(d.dropped))}</b> ${esc(d.what)} not drawn &mdash; ${esc(d.why)}.</li>`)
            .join('')}</ul>`
        : '<p class="dim">Nothing was suppressed: every node the rules produced is on the page.</p>';
    const payload = {
        w: W, h: H, maxTurn, turns: session.turns.length,
        nodes: nodes.map((n) => ({
            id: n.id, kind: n.kind, label: n.label, layer: n.layer,
            note: n.note || null, measured: n.measured || null, turns: n.turns || null, degree: n.degree,
            at: born(n.firstTurn),
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
    <span class="ghalf"><b>Written by the model</b> <i class="gk gdia"></i> ${authoredCount} nodes</span>
    ${loose}
    ${dense}
    <button id="gtog" class="gbtn gpush" type="button">Hide the model's layer</button>
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
  <div class="glbl">What the gates dropped</div>
  ${suppressedHtml}
  <div class="glbl">What this picture cannot say</div>
  <ul class="gnot">${NOT_SAID.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
</div>
<script>window.__qkg=${jsonForScript(payload)};</script>
`;
}
export function render(session, intent, meta) {
    const t = session.totals;
    const maxDur = Math.max(1, ...session.turns.map((x) => x.durationMs));
    const compactLine = intent?.compactInstruction ? `/compact ${intent.compactInstruction}` : null;
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
<style>${css()}</style></head><body><div class="wrap">

<div class="head">
  <div>
    <h1>${esc(session.title || 'Session analysis')}</h1>
    <div class="sub">${esc(session.sessionId)} · ${esc(session.cwd || '')} · ${esc(session.gitBranch || '')}</div>
  </div>
  <button id="theme" type="button" title="Light, dark, or whatever this machine asks for">Theme: system</button>
</div>

${compactLine
        ? `<div class="card compact"><div class="row">
  <code id="cl">${esc(compactLine)}</code>
  <button class="copy" id="cp">Copy</button>
</div></div>`
        : ''}

${renderScore(session)}

${intent?.tldr ? `<h2>TL;DR</h2><div class="card">${esc(intent.tldr)}</div>` : ''}

<h2>Session shape</h2>
<div class="stats">${stats}</div>

${intent?.sessionId && session.sessionId && intent.sessionId !== session.sessionId
        ? `<div class="gmismatch"><b>These two files describe different sessions.</b> The spine is ${esc(String(session.sessionId).slice(0, 8))} and the intent was written for ${esc(String(intent.sessionId).slice(0, 8))}. The analysis below mixes them. Re-run step 3.</div>`
        : ''}
${renderIntents(intent)}
${renderQuality(intent)}
${renderGraph(session, intent)}

<h2>Turns</h2>
<div class="filters">
  <button class="on" data-f="all">All ${session.turns.length}</button>
  <button data-f="friction">Friction ${t.frictionTurns}</button>
  <button data-f="steering">Steering ${t.steeringTurns}</button>
  <button data-f="terse">Terse</button>
  <button data-f="criteria">With criteria</button>
</div>
${turns || '<div class="empty">No human turns found.</div>'}

<footer>generated by /qpact · ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} · ${esc(String(t.records))} records analysed · prompts redacted for secrets${meta?.fingerprint ? ` · fingerprint <b>${esc(meta.fingerprint)}</b>` : ''}${typeof meta?.spineAgeMin === 'number' ? ` · spine extracted ${esc(String(meta.spineAgeMin))} min ago` : ''}</footer>
</div>
<script>
const cp=document.getElementById('cp');
if(cp)cp.onclick=async()=>{
  try{await navigator.clipboard.writeText(document.getElementById('cl').textContent);}
  catch{const r=document.createRange();r.selectNode(document.getElementById('cl'));
    getSelection().removeAllRanges();getSelection().addRange(r);document.execCommand('copy');}
  cp.textContent='Copied';cp.classList.add('done');
  setTimeout(()=>{cp.textContent='Copy';cp.classList.remove('done')},1600);
};
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
  var side=document.getElementById('gside'), tog=document.getElementById('gtog');
  var svg=document.getElementById('qkg'), view=document.getElementById('gview');
  var canvas=document.getElementById('gcanvas'), zl=document.getElementById('gzl');
  var scrub=document.getElementById('gscrub'), play=document.getElementById('gplay');
  var out=document.getElementById('gat');
  var nodes={}, adj={};
  d.nodes.forEach(function(n){ nodes[n.id]=n; adj[n.id]=[]; });
  d.edges.forEach(function(e,i){ if(adj[e.s])adj[e.s].push(i); if(adj[e.t])adj[e.t].push(i); });
  var gEls=[].slice.call(document.querySelectorAll('#gnodes .gn'));
  var eEls=[].slice.call(document.querySelectorAll('#gedges .ge'));
  var hidden=false, pinned=null, upto=d.maxTurn;
  function esc(x){var p=document.createElement('p');p.textContent=x==null?'':String(x);return p.innerHTML;}
  function card(id){
    var n=nodes[id]; if(!n) return;
    var rel=adj[id].map(function(i){var e=d.edges[i];var o=e.s===id?e.t:e.s;
      return '<li>'+(e.s===id?'&rarr; ':'&larr; ')+esc((nodes[o]||{}).label||o)+(e.rel?' <i>'+esc(e.rel)+'</i>':'')+'</li>';}).join('');
    side.innerHTML='<h4>'+esc(n.label)+'</h4>'+
      '<span class="gstamp '+n.layer+'">'+(n.layer==='derived'
        ? esc(n.measured||'Measured from the transcript.')
        : "Written by the model at /qpact step 3. Not measured.")+'</span>'+
      (n.note?'<p>'+esc(n.note)+'</p>':'')+
      (n.turns&&n.turns.length?'<p class="dim">turn '+n.turns.join(', ')+'</p>':'')+
      '<p class="dim">'+(n.at<0?'not attributable to a turn &mdash; present from the first frame'
        :'enters the replay at turn '+n.at)+'</p>'+
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
      var gone=hidden&&n.layer==='authored';
      g.classList.toggle('pre',!!pre);
      g.classList.toggle('mute',!!(pre||gone||(near&&!near[n.id])));
      g.classList.toggle('near',!!(near&&near[n.id]&&!pre&&!gone));
      if(!pre&&!gone)shown++;
    });
    eEls.forEach(function(l,i){
      var e=d.edges[i]||{};
      var pre=e.at>upto;
      var gone=hidden&&e.layer==='authored';
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
    tog.textContent=hidden?"Show the model's layer":"Hide the model's layer";
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
  canvas.addEventListener('wheel',function(ev){
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

  apply(); paint(null);
})();
</script></body></html>`;
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
    const VALUE_FLAGS = new Set(['--intent', '-o', '--out']);
    const spinePath = argv
        .filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1] ?? ''))
        .find((a) => a.endsWith('.json'));
    if (!spinePath) {
        console.error('usage: render.mjs spine.json [--intent intent.json] [-o out.html] [--open]');
        process.exit(1);
    }
    const session = JSON.parse(readFileSync(spinePath, 'utf8'));
    const intentPath = opt('--intent');
    const intent = intentPath ? JSON.parse(readFileSync(intentPath, 'utf8')) : null;
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
            return ['render.mjs', 'graph.mjs']
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
    writeFileSync(out, render(session, intent, { fingerprint: hash8, spineAgeMin }), { mode: 0o600 });
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
