#!/usr/bin/env node
// Renders an extracted session spine into a self-contained interactive HTML doc.
//
//   node render.mjs spine.json [--intent intent.json] [-o out.html] [--open]
//
// The spine is deterministic (from extract.mjs); the intent file is optional and
// carries the model-derived TLDR, intent breakdown and the /compact instruction.
// Keeping them separate means the visual layer never depends on inference.

import { readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { dirname, join } from 'node:path'
import { version } from './version.mjs'
import { unlinkSync, readdirSync, statSync } from 'node:fs'
import { jsonForScript } from './html.mjs'
import { deriveGraph, mergeAuthored, layoutGraph } from './graph.mjs'
import type { IntentGraph, GraphNode, GraphEdge, Suppression } from './graph.mjs'

interface TurnToolCall {
  name: string
  count: number
}

interface TurnSignals {
  hasAcceptanceCriteria?: boolean
  hasFileRef?: boolean
  terse?: boolean
  hasCodeBlock?: boolean
}

interface ScoreReason {
  points: number
  why: string
}

interface TurnScore {
  value: number
  deductions: ScoreReason[]
  additions: ScoreReason[]
}

interface Turn {
  index: number
  text: string
  friction: string[]
  signals: TurnSignals
  toolCalls: TurnToolCall[]
  toolCallCount: number
  tokens: { output: number }
  durationMs: number
  derived: { repeatOf: number | null }
  score: TurnScore
  steering?: unknown
}

interface SessionTotals {
  humanTurns: number
  toolCalls: number
  tokens: { output: number; cacheRead: number }
  frictionTurns: number
  repeats: number
  interruptions: number
  steeringTurns: number
  records: number
}

interface SessionScore {
  value: number | null
  band: string
  confidence: string
  turnsScored: number
  frictionRate: number
  craftRate: number
  wastedTokens: number
}

interface Session {
  sessionId?: string
  title?: string
  cwd?: string
  gitBranch?: string
  durationMs: number
  totals: SessionTotals
  turns: Turn[]
  score?: SessionScore | null
  // The artifacts plane and the session-level facts. The graph is the first
  // thing on this page that reads them, and a field absent here is a field
  // that silently never renders.
  harness?: string
  models?: Record<string, number>
  slashCommands?: string[]
  permissionModes?: Array<{ ts?: string; mode?: string }>
  artifacts?: {
    packages?: Record<string, number>
    tools?: Record<string, number>
    stack?: Record<string, number>
    extensions?: Record<string, number>
    skills?: Record<string, number>
    mcp?: Record<string, number>
    fileTouches?: number
  }
}

interface IntentItem {
  title?: string
  status?: string
  summary?: string
  /** Documented in SKILL.md since the first version and silently discarded
   *  until now. A field the renderer drops teaches the model to write into a
   *  hole, so it is either read or removed; this reads it. */
  turns?: number[]
}

interface IntentQuality {
  verdict?: string
  strengths?: string[]
  weaknesses?: string[]
  recommendations?: string[]
}

interface Intent {
  tldr?: string
  compactInstruction?: string
  intents?: IntentItem[]
  quality?: IntentQuality
  /** Required from now on. A stale intent paired with a fresh spine is the one
   *  staleness vector no filename scheme can see, so the page checks it. */
  sessionId?: string
  graph?: IntentGraph
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!))


const fmtTokens = (n: number): string => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n))
const fmtDur = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`
}

const FRICTION_LABEL: Record<string, string> = {
  interrupted: 'interrupted',
  repeated: 'repeat',
  correction: 'correction',
  'drew-correction': 'drew correction',
  roundtrip: 'round-trip',
}

function css(): string {
  return `
:root{
  --bg:#fbfaf8; --panel:#fff; --ink:#1c1b19; --muted:#6b6862; --line:#e6e2db;
  --accent:#c2521a; --accent-soft:#fdf0e8; --ok:#2f6b46; --warn:#9a6a12; --bad:#b3261e;
  --bar:#d9d4cb; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#16151a; --panel:#1e1d23; --ink:#ece9e4; --muted:#9b968d; --line:#302e37;
  --accent:#ff8a4c; --accent-soft:#2a1d16; --ok:#6fbf8e; --warn:#e0b055; --bad:#ff6b5e;
  --bar:#3a3742;
}}
:root[data-theme=dark]{
  --bg:#16151a; --panel:#1e1d23; --ink:#ece9e4; --muted:#9b968d; --line:#302e37;
  --accent:#ff8a4c; --accent-soft:#2a1d16; --ok:#6fbf8e; --warn:#e0b055; --bad:#ff6b5e;
  --bar:#3a3742;
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
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}

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
  border-radius:10px;overflow:hidden;margin:10px 0 0}
@media (max-width:900px){.gwrap{grid-template-columns:1fr}}
.glegend{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:9px 14px;
  border-bottom:1px solid var(--line);font-size:12.5px}
.ghalf{display:inline-flex;align-items:center;gap:7px}
.gk{width:11px;height:11px;display:inline-block;background:var(--dim)}
.gcirc{border-radius:50%}
.gdia{transform:rotate(45deg)}
.gbtn{margin-left:auto;border:1px solid var(--line);background:transparent;color:var(--ink);
  font:inherit;font-size:12px;padding:3px 10px;border-radius:99px;cursor:pointer}
.gbtn.off{opacity:.55}
.gcanvas{overflow:auto;background:var(--kg-bg,#16151a)}
#qkg{display:block;width:100%;height:auto}
.ge{stroke:#6b6b76;stroke-opacity:.34;fill:none}
.ge.authored{stroke:#b07acb;stroke-opacity:.5}
.ge.dash{stroke-dasharray:4 4}
.ge.hot{stroke-opacity:.95;stroke-width:1.8}
.ge.mute,.gn.mute{opacity:.1}
.gn{cursor:pointer}
.gn .gs{stroke:#16151a;stroke-width:1.5}
.gn.authored .gs{stroke:#e8e6f2;stroke-width:1.2;stroke-dasharray:3 2}
.gn text{font-size:9.5px;fill:#d8d6dc;text-anchor:middle;paint-order:stroke;stroke:#16151a;
  stroke-width:3px;stroke-linejoin:round;pointer-events:none}
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
.gmismatch{background:#b91c1c;color:#fff;padding:10px 14px;border-radius:8px;margin:0 0 14px;font-size:13.5px}

`
}

function renderIntents(intent: Intent | null | undefined): string {
  if (!intent?.intents?.length) return ''
  const items = intent.intents
    .map(
      (i) => `<div class="intent ${esc(i.status || 'ongoing')}">
  <h3>${esc(i.title)}<span class="pill">${esc(i.status || '')}</span></h3>
  <p>${esc(i.summary || '')}</p>
</div>`
    )
    .join('\n')
  return `<h2>Intent breakdown</h2>\n${items}`
}

function renderQuality(intent: Intent | null | undefined): string {
  const q = intent?.quality
  if (!q) return ''
  const list = (label: string, arr: string[] | undefined) =>
    arr?.length ? `<p style="margin:10px 0 0"><strong>${label}</strong></p><ul style="margin:5px 0 0;padding-left:19px;color:var(--muted);font-size:14px">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''
  return `<h2>Prompting quality</h2><div class="card">
  <p style="margin:0">${esc(q.verdict || '')}</p>
  ${list('What worked', q.strengths)}
  ${list('What cost you', q.weaknesses)}
  ${list('Do differently', q.recommendations)}
</div>`
}

const BAND_MEANING: Record<string, string> = {
  clean: 'Prompts landed the first time. Little rework visible in the transcript.',
  solid: 'Mostly landed, with a few turns that needed a second pass.',
  mixed: 'A noticeable share of turns had to be repeated, corrected or interrupted.',
  costly: 'Rework dominated. A large fraction of turns did not land as written.',
  poor: 'Most turns required correction or were abandoned mid-flight.',
}

// The baseline a turn scores at before anything counts for or against it.
// extract.mjs owns it (BASE) and the spine does not carry it, so the renderer
// keeps a named copy rather than a literal buried in the markup.
const SCORE_BASE = 72

function renderScore(session: Session): string {
  const s = session.score
  // The spine is parsed JSON, so a score object with no `value` arrives as
  // undefined, not null — which slipped past a null-only guard and printed the
  // word "undefined" in the dial and in the --pct gradient width.
  if (!s || typeof s.value !== 'number') return ''
  const caveat =
    s.confidence !== 'high'
      ? `<div class="caveat">Confidence ${esc(s.confidence)} — only ${s.turnsScored} turns, so the outcome signals have little to witness. Treat this as weak evidence, not a verdict.</div>`
      : ''
  return `<div class="score card sc-${esc(s.band)}" style="--pct:${s.value}">
  <div class="dial"><b>${s.value}</b></div>
  <div class="meaning">
    <h3>${esc(s.band)}</h3>
    <p>${esc(BAND_MEANING[s.band] || '')}</p>
    <p style="margin-top:6px">${Math.round(s.frictionRate * 100)}% of turns showed friction · ${Math.round(s.craftRate * 100)}% named a file, criteria or code · ${fmtTokens(s.wastedTokens)} output tokens spent on turns that needed rework</p>
    ${caveat}
  </div>
</div>`
}


// ---------------------------------------------------------------- graph

// Reuses the corpus renderer's palette so the two pages share one vocabulary
// rather than inventing a second. Colour encodes kind WITHIN a layer; it never
// carries the derived/authored distinction, which is shape's job.
const KIND_COLOR: Record<string, string> = {
  session: '#e0894a', harness: '#68b3b3', repo: '#e0894a', model: '#6a9fd4',
  tool: '#8fbc6b', mcp: '#68b3b3', skill: '#d9b45c', cli: '#8fbc6b',
  package: '#6a9fd4', stack: '#c47ab0', ext: '#c47ab0', slash: '#d9b45c',
  mode: '#a0a0a8', friction: '#d06a5a', turn: '#9a9aa4',
  decision: '#15803d', defect: '#dc2626', guard: '#b45309',
  thread: '#9333ea', subsystem: '#2563eb', question: '#78716c', concept: '#78716c',
}

// Rendered unconditionally, whether or not the corresponding nodes exist. A
// caveat that disappears when quiet is one nobody trusts on its return.
const NOT_SAID: string[] = [
  'No file appears here. The spine records that a file was touched, never which one.',
  'A package, CLI tool, stack file, extension or skill is attributed to the session, never to a turn.',
  'A repeat points at the first identical prompt, not at the previous one. It is a star, not a chain.',
  'A slash command attaches to the turn that was open when it was issued, which is the preceding human turn.',
  'An interruption is a count on a turn, not a point inside it. Which tool call it hit is not recorded.',
]

function renderGraph(session: Session, intent: Intent | null | undefined): string {
  const derived = deriveGraph(session as never)
  const merged = mergeAuthored(derived, intent?.graph, session.turns.length)
  const { nodes, edges } = merged
  if (!nodes.length) return ''

  const W = 1000
  const H = 620
  const layout = layoutGraph(nodes, edges, { width: W, height: H })
  const pos = layout.positions
  const maxDeg = Math.max(1, ...nodes.map((n) => n.degree))
  const radius = (n: GraphNode): number =>
    (n.kind === 'session' ? 7 : 4) + Math.sqrt(n.degree / maxDeg) * (n.kind === 'session' ? 13 : 8)

  const line = (e: GraphEdge, i: number): string => {
    const a = pos[e.source]
    const b = pos[e.target]
    if (!a || !b) return '' // an endpoint the gates removed; never draw a stub
    return `<line class="ge ${e.layer}${e.dashed ? ' dash' : ''}" data-i="${i}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`
  }

  const dot = (n: GraphNode): string => {
    const p = pos[n.id]
    if (!p) return ''
    const r = radius(n)
    const col = KIND_COLOR[n.kind] || '#78716c'
    // Shape, not colour, carries the layer: a diamond survives greyscale,
    // colour-blindness, and a stylesheet that failed to load.
    const body =
      n.layer === 'authored'
        ? `<polygon class="gs" points="${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}" fill="${col}"/>`
        : `<circle class="gs" cx="${p.x}" cy="${p.y}" r="${r}" fill="${col}"/>`
    return `<g class="gn ${n.layer}" data-id="${esc(n.id)}" tabindex="0">${body}<text x="${p.x}" y="${p.y + r + 11}">${esc(n.label)}</text></g>`
  }

  const derivedCount = nodes.filter((n) => n.layer === 'derived').length
  const authoredCount = nodes.length - derivedCount
  const drops: Suppression[] = [...derived.suppressed, ...merged.dropped]
  const suppressedHtml = drops.length
    ? `<ul class="gsup">${drops
        .map((d) => `<li><b>${esc(String(d.dropped))}</b> ${esc(d.what)} not drawn &mdash; ${esc(d.why)}.</li>`)
        .join('')}</ul>`
    : '<p class="dim">Nothing was suppressed: every node the rules produced is on the page.</p>'

  const payload = {
    nodes: nodes.map((n) => ({
      id: n.id, kind: n.kind, label: n.label, layer: n.layer,
      note: n.note || null, measured: n.measured || null, turns: n.turns || null, degree: n.degree,
    })),
    edges: edges.map((e) => ({ s: e.source, t: e.target, rel: e.rel || null, layer: e.layer })),
  }

  return `<h2>Knowledge graph</h2>
<div class="gwrap">
  <div class="glegend">
    <span class="ghalf"><b>Measured from the transcript</b> <i class="gk gcirc"></i> ${derivedCount} nodes</span>
    <span class="ghalf"><b>Written by the model</b> <i class="gk gdia"></i> ${authoredCount} nodes</span>
    <button id="gtog" class="gbtn">Hide the model's layer</button>
  </div>
  <div class="gcanvas"><svg viewBox="0 0 ${W} ${H}" id="qkg" role="img" aria-label="Session knowledge graph">
    <g id="gedges">${edges.map(line).join('')}</g>
    <g id="gnodes">${nodes.map(dot).join('')}</g>
  </svg></div>
  <aside id="gside" class="gside"><p class="dim">Hover or focus a node. A measured node prints the field it came from; a written one says so.</p></aside>
</div>
<div class="gfoot">
  <div class="glbl">What the gates dropped</div>
  ${suppressedHtml}
  <div class="glbl">What this picture cannot say</div>
  <ul class="gnot">${NOT_SAID.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
</div>
<script>window.__qkg=${jsonForScript(payload)};</script>
`
}

export interface RenderMeta {
  /** Printed in the footer and to stdout. A generated-at stamp cannot detect a
   *  cached page, because the stamp is cached with the page; a hash the reader
   *  can compare against the terminal can. */
  fingerprint?: string
  /** How old the spine was when this rendered. Surfaces the case where step 1
   *  silently failed and this is the PREVIOUS run's spine. */
  spineAgeMin?: number
}

export function render(session: Session, intent: Intent | null | undefined, meta?: RenderMeta): string {
  const t = session.totals
  const maxDur = Math.max(1, ...session.turns.map((x) => x.durationMs))
  const compactLine = intent?.compactInstruction ? `/compact ${intent.compactInstruction}` : null

  const stats = ([
    ['turns', t.humanTurns],
    ['tool calls', t.toolCalls],
    ['output tok', fmtTokens(t.tokens.output)],
    ['cache read', fmtTokens(t.tokens.cacheRead)],
    ['friction', `${t.frictionTurns}`, t.frictionTurns > 0],
    ['repeats', `${t.repeats}`, t.repeats > 0],
    ['interrupts', `${t.interruptions}`, t.interruptions > 0],
    ['span', fmtDur(session.durationMs)],
  ] as [string, string | number, boolean?][])
    .map(([l, n, hot]) => `<div class="stat${hot ? ' hot' : ''}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`)
    .join('')

  const turns = session.turns
    .map((turn) => {
      const fr = turn.friction.length
      const tags = turn.friction.map((f) => `<span class="tag">${esc(FRICTION_LABEL[f] || f)}</span>`).join(' ')
      const flags = [
        turn.signals.hasAcceptanceCriteria && 'criteria',
        turn.signals.hasFileRef && 'file-ref',
        turn.signals.terse && 'terse',
        turn.signals.hasCodeBlock && 'code',
      ].filter(Boolean)
      const tools = turn.toolCalls.map((x) => `<span class="tool">${esc(x.name)}·${x.count}</span>`).join('')
      const pct = Math.round((turn.durationMs / maxDur) * 100)
      const repeat = turn.derived.repeatOf !== null ? `<p style="color:var(--bad);font-size:13px;margin:0 0 8px">Identical to turn #${turn.derived.repeatOf} — the first attempt did not land.</p>` : ''
      const sc = turn.score
      const why = [
        ...sc.deductions.map((d) => `<li class="out">${d.points} — ${esc(d.why)}</li>`),
        ...sc.additions.map((a) => `<li class="add">+${a.points} — ${esc(a.why)}</li>`),
      ].join('')
      const steer = turn.steering ? '<span class="tool">steering</span>' : ''
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
</details>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>qpact — ${esc(session.title || session.sessionId?.slice(0, 8))}</title>
<style>${css()}</style></head><body><div class="wrap">

<h1>${esc(session.title || 'Session analysis')}</h1>
<div class="sub">${esc(session.sessionId)} · ${esc(session.cwd || '')} · ${esc(session.gitBranch || '')}</div>

${
  compactLine
    ? `<div class="card compact"><div class="row">
  <code id="cl">${esc(compactLine)}</code>
  <button class="copy" id="cp">Copy</button>
</div></div>`
    : ''
}

${renderScore(session)}

${intent?.tldr ? `<h2>TL;DR</h2><div class="card">${esc(intent.tldr)}</div>` : ''}

<h2>Session shape</h2>
<div class="stats">${stats}</div>

${
  intent?.sessionId && session.sessionId && intent.sessionId !== session.sessionId
    ? `<div class="gmismatch"><b>These two files describe different sessions.</b> The spine is ${esc(String(session.sessionId).slice(0, 8))} and the intent was written for ${esc(String(intent.sessionId).slice(0, 8))}. The analysis below mixes them. Re-run step 3.</div>`
    : ''
}
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

// --- knowledge graph: hover isolates a neighbourhood, the toggle subtracts the
// model's layer. The toggle is the real answer to "which is which": it is
// checkable rather than asserted.
(function(){
  var d=window.__qkg; if(!d) return;
  var side=document.getElementById('gside'), tog=document.getElementById('gtog');
  var nodes={}, adj={};
  d.nodes.forEach(function(n){ nodes[n.id]=n; adj[n.id]=[]; });
  d.edges.forEach(function(e,i){ if(adj[e.s])adj[e.s].push(i); if(adj[e.t])adj[e.t].push(i); });
  var gEls=[].slice.call(document.querySelectorAll('#gnodes .gn'));
  var eEls=[].slice.call(document.querySelectorAll('#gedges .ge'));
  var hidden=false, pinned=null;
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
      '<ul class="gsup">'+rel+'</ul>';
  }
  function paint(id){
    var near=null;
    if(id){ near={}; near[id]=1; adj[id].forEach(function(i){near[d.edges[i].s]=1;near[d.edges[i].t]=1;}); }
    gEls.forEach(function(g){
      var n=nodes[g.getAttribute('data-id')]||{};
      var off=(hidden&&n.layer==='authored')||(near&&!near[g.getAttribute('data-id')]);
      g.classList.toggle('mute',!!off);
    });
    eEls.forEach(function(l,i){
      var e=d.edges[i]||{};
      var off=(hidden&&e.layer==='authored')||(near&&e.s!==id&&e.t!==id);
      l.classList.toggle('mute',!!off);
      l.classList.toggle('hot',!!(id&&(e.s===id||e.t===id)&&!off));
    });
    if(id)card(id); else side.innerHTML='<p class="dim">Hover or focus a node. A measured node prints the field it came from; a written one says so.</p>';
  }
  gEls.forEach(function(g){
    var id=g.getAttribute('data-id');
    g.addEventListener('mouseenter',function(){paint(id);});
    g.addEventListener('focus',function(){paint(id);});
    g.addEventListener('mouseleave',function(){paint(pinned);});
    g.addEventListener('click',function(ev){ev.stopPropagation();pinned=pinned===id?null:id;paint(pinned);});
  });
  if(tog)tog.addEventListener('click',function(){
    hidden=!hidden; tog.classList.toggle('off',hidden);
    tog.textContent=hidden?"Show the model's layer":"Hide the model's layer";
    paint(pinned);
  });
})();
</script></body></html>`
}

// ---------------------------------------------------------------- cli

// Comparing basenames by suffix made this module the entry point whenever the
// process was started from any script whose name ends the same way — a sibling
// render.mjs, or even er.mjs — so importing render() ran the CLI and exited.
// Resolved real paths are the only comparison that answers "am I the entry".
const realPath = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const isMain = !!process.argv[1] && realPath(fileURLToPath(import.meta.url)) === realPath(process.argv[1])
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n: string, d: string | null = null): string | null | undefined => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : d
  }
  // A flag's value is not a positional argument. Without this, `--intent
  // intent.json spine.json` rendered the intent file as the spine.
  const VALUE_FLAGS = new Set(['--intent', '-o', '--out'])
  const spinePath = argv
    .filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1] ?? ''))
    .find((a) => a.endsWith('.json'))
  if (!spinePath) {
    console.error('usage: render.mjs spine.json [--intent intent.json] [-o out.html] [--open]')
    process.exit(1)
  }
  const session = JSON.parse(readFileSync(spinePath, 'utf8')) as Session
  const intentPath = opt('--intent')
  const intent = intentPath ? (JSON.parse(readFileSync(intentPath, 'utf8')) as Intent) : null
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
  const selfBytes = (): string => {
    try {
      const here = realPath(fileURLToPath(import.meta.url))
      const dir = dirname(here)
      return ['render.mjs', 'graph.mjs']
        .map((f) => {
          try {
            return readFileSync(join(dir, f), 'utf8')
          } catch {
            return ''
          }
        })
        .join('')
    } catch {
      return ''
    }
  }
  const sid8 = (session.sessionId || 'session').slice(0, 8)
  const hash8 = crypto
    .createHash('sha256')
    .update(readFileSync(spinePath, 'utf8'))
    .update(intentPath ? readFileSync(intentPath, 'utf8') : '')
    .update(version())
    .update(selfBytes())
    .digest('hex')
    .slice(0, 8)
  const explicitOut = opt('-o') || opt('--out')
  const out = explicitOut || `/tmp/qpact-${sid8}-${hash8}.html`

  // 0600: the page embeds verbatim prompt text and lands in a shared /tmp.
  const spineAgeMin = (() => {
    try {
      return Math.round((Date.now() - statSync(spinePath).mtimeMs) / 60000)
    } catch {
      return undefined
    }
  })()
  writeFileSync(out, render(session, intent, { fingerprint: hash8, spineAgeMin }), { mode: 0o600 })
  chmodSync(out, 0o600) // writeFileSync honours mode only when it creates the file

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
            unlinkSync(join('/tmp', f))
          } catch {
            /* another run may have taken it already */
          }
    } catch {
      /* no /tmp listing; the hashed name still does the work */
    }
  }

  if (intent && intent.sessionId && session.sessionId && intent.sessionId !== session.sessionId)
    console.error(
      `warning: intent.sessionId (${intent.sessionId.slice(0, 8)}) does not match the spine (${session.sessionId.slice(0, 8)}) -- the page says so too`
    )
  console.log(out)
  console.log(`fingerprint ${hash8} - compare this against the footer of the page you are looking at`)

  if (argv.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execFile(cmd, [out], (err) => {
      if (err) console.error(`could not open a window: ${err.message}\nfile is at ${out}`)
    })
  }
}
