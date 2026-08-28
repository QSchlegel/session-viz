// The session knowledge graph: a mechanically-derived skeleton, an optional
// model-authored layer folded on top, and the force layout both renderers share.
//
// -- Two layers, and why they are kept apart at the data level ---------------
// The derived layer is what the transcript records. The authored layer is what
// the model concluded. They are different kinds of claim, and a picture that
// mixes them silently is worse than either alone. So the separation is a
// property of the ids -- every authored concept is namespaced to `concept:` at
// merge time, and the derived prefixes are validated against a closed set --
// not a property of the styling. A model that writes `"id": "session:abc"` gets
// `concept:session-abc`; it cannot overwrite or impersonate a measured node.
//
// -- The authored layer is a structure, not a scatter ------------------------
// The model's conclusions used to arrive as one flat bag of concepts, so what
// it CONCLUDED -- the intents, and whether each one finished -- was legible
// only by reading every diamond. It now arrives as three kinds that hang
// together: an `intent:` per thread, a `status:` hub the threads of one status
// share, and an edge from each thread to the measured turns it cited. The hub
// is what makes "four threads, three of them unfinished" a shape rather than a
// caption, and the edges to `turn:` are the only place the authored layer
// touches the skeleton besides an anchor.
//
// -- A conclusion from an earlier session is not a conclusion from this one ---
// The intent store carries a project's conclusions across its sessions, so the
// authored layer can hold work this transcript never witnessed. Those nodes get
// `carried` -- the session they were drawn in and how far back that is -- and
// three separate things follow from it, none of them decorative. They hang off
// a `prior:` hub of their own rather than mixing into this session's status
// hubs. They are never dated onto this session's replay: an earlier session's
// turn 4 is a different turn 4, so `firstTurn` is null and the citation is
// printed as prose naming its own session. And they are never anchored to this
// session's measured nodes, because `tool:git` here and `tool:git` there are
// the same id and not the same evidence; the refusal is counted and reported
// rather than done quietly.
//
// -- What this file will not do ---------------------------------------------
// No file nodes. The spine now records WHICH files each turn touched, so this
// is no longer a limit of the data -- it is a choice about the picture. A file
// per turn on a real session is several hundred more nodes hung off the busiest
// part of the graph, and they would swamp the structure the graph exists to
// show. The files are attributed to tasks in the report's appendix instead,
// where a table can carry the caveat that a touch is evidence and not proof.
// `artifacts.fileTouches` is still what the session node prints, and it is
// still only a count.
//
// No repeat CHAINS. `derived.repeatOf` stores the FIRST index per normalised
// prompt, so the 2nd, 3rd and 4th repeat all point at the first occurrence,
// never at their predecessor. Drawn as a star, and the panel says star.

// ---------------------------------------------------------------- types

export type GraphLayer = 'derived' | 'authored'

export interface GraphNode {
  id: string
  kind: string
  label: string
  degree: number
  layer: GraphLayer
  weight?: number
  note?: string
  turns?: number[]
  /** Verbatim statement of the field this node came from. Derived nodes only. */
  measured?: string
  /**
   * The turn at which this node first became true, for replay. `null` means the
   * spine cannot attribute it to a turn -- packages, CLI tools, stack files,
   * extensions and skills are aggregated per SESSION, so there is no moment to
   * point at. Those are present from the start rather than given an invented one.
   */
  firstTurn?: number | null
  /**
   * Set on an authored node the store carried in from an EARLIER session, and
   * absent on everything this session drew. A renderer that draws the two the
   * same way has told the reader this transcript produced a conclusion it never
   * witnessed, which is the one failure carrying intent forward can introduce.
   */
  carried?: CarriedFrom
  /**
   * `done | partial | abandoned | ongoing` on an intent node, absent everywhere
   * else. Held as its own field rather than folded into `kind` so the layer's
   * colour vocabulary stays one entry per kind and the status is still readable
   * off the node by anything that does not paint.
   */
  status?: string
}

/**
 * Where an authored conclusion came from, when it did not come from here.
 *
 * `sessionsAgo` counts RECORDED sessions of this project -- sessions /qpact has
 * analysed -- not sessions that happened and not elapsed work. It is age, and
 * nothing in this file or the store it comes from has re-checked whether the
 * conclusion is still true.
 */
export interface CarriedFrom {
  /** The session it was drawn in. Never blank. */
  session: string
  /** Recorded sessions of this project between that one and this one. Null when
   *  the document did not say, which is not the same as one and must not be
   *  rendered as a number. */
  sessionsAgo: number | null
  /** Whole days since it was last restated. Null when the stamp would not parse. */
  daysAgo: number | null
}

export interface GraphEdge {
  source: string
  target: string
  /** Names the mechanism that produced the edge, so hovering explains itself. */
  rel?: string
  layer: GraphLayer
  dashed?: boolean
  weight?: number
  /** The turn at which the relation first held. Never earlier than both ends. */
  firstTurn?: number | null
}

export interface GraphLayout {
  width: number
  height: number
  positions: Record<string, { x: number; y: number }>
  /**
   * The uniform factor the packed layout was multiplied by to fit the frame.
   * Returned because node radii live in the same coordinate space as positions:
   * a renderer that scales one and not the other draws overlapping blobs at
   * exactly the densities where that matters most.
   */
  scale: number
  /** Connected components the packer had to place. */
  components: number
  /** Nodes carrying no edge at all. These are what used to set the bounding box. */
  isolated: number
}

export interface LayoutOptions {
  width?: number
  height?: number
  iterations?: number
}

/** A suppression the gates applied, reported rather than silent. */
export interface Suppression {
  what: string
  dropped: number
  of: number
  why: string
}

export interface DerivedGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  suppressed: Suppression[]
}

// ---------------------------------------------------------------- layout

// Force-directed layout, computed here rather than in the browser so the page
// stays static and the same input always draws the same picture. Seeding on a
// circle by index keeps it free of randomness -- Math.random would make every
// regeneration a different graph and every diff meaningless.
//
// Moved here from corpus.mts so the two renderers share one implementation. A
// second copy of an 80-line simulation that drifts from the first is the same
// staleness failure this file exists to answer, one level up.
//
// -- Why this is not one simulation over every node -------------------------
// A node with no edge feels only repulsion and the weak pull to centre, so it
// settles out on a wide ring. A connected component feels its springs and pulls
// into a knot. Put both in one box and the ring sets the bounding box while the
// knot -- the entire content of the picture -- normalises down into a few
// percent of the frame. That is what "the standalone nodes skew the whole
// image" was: the simulation was right and the framing was wrong.
//
// So each connected component is simulated in its OWN box, sized to its node
// count, and the components are then shelf-packed into the frame. Unconnected
// nodes become one block laid out as a grid -- which is also the more honest
// picture, because they have no structure and a scatter implies a geometry that
// is not there.
//
// The final fit is UNIFORM. The previous version scaled x and y independently,
// which silently stretched every layout whose aspect ratio did not match the
// frame's; circles stayed circles only because they are drawn after the fact.

interface PackedBlock {
  w: number
  h: number
  ids: string[]
  at: Array<{ x: number; y: number }>
}

/** One component, one box. Deterministic: seeded on a circle by index, never
 *  on Math.random, so the same input always draws the same picture. */
function simulate(
  nodes: Array<{ id: string; degree: number }>,
  edges: Array<{ source: string; target: string }>,
  width: number,
  height: number,
  iterations: number
): Array<{ x: number; y: number }> {
  const n = nodes.length
  if (!n) return []
  const pos = nodes.map((_, i) => {
    const a = (i / n) * Math.PI * 2
    return { x: width / 2 + Math.cos(a) * width * 0.32, y: height / 2 + Math.sin(a) * height * 0.32 }
  })
  const index = new Map<string, number>(nodes.map((nd, i) => [nd.id, i]))
  const k = Math.sqrt((width * height) / n) * 0.55
  const deg = nodes.map((nd) => Math.max(1, nd.degree))

  for (let it = 0; it < iterations; it++) {
    const temp = (1 - it / iterations) * (width * 0.06) + 0.5
    const dx = new Array<number>(n).fill(0)
    const dy = new Array<number>(n).fill(0)

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = pos[i]!.x - pos[j]!.x
        let ey = pos[i]!.y - pos[j]!.y
        let d2 = ex * ex + ey * ey
        if (d2 < 0.01) {
          ex = (i % 7) - 3 + 0.5
          ey = (j % 5) - 2 + 0.5
          d2 = ex * ex + ey * ey
        }
        const d = Math.sqrt(d2)
        const f = (k * k) / d
        dx[i]! += (ex / d) * f
        dy[i]! += (ey / d) * f
        dx[j]! -= (ex / d) * f
        dy[j]! -= (ey / d) * f
      }
    }

    for (const e of edges) {
      const i = index.get(e.source)
      const j = index.get(e.target)
      if (i === undefined || j === undefined) continue
      const ex = pos[i]!.x - pos[j]!.x
      const ey = pos[i]!.y - pos[j]!.y
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01
      const f = (d * d) / k / Math.sqrt(Math.min(deg[i]!, deg[j]!))
      dx[i]! -= (ex / d) * f
      dy[i]! += -(ey / d) * f
      dx[j]! += (ex / d) * f
      dy[j]! += (ey / d) * f
    }

    for (let i = 0; i < n; i++) {
      // Anisotropic centring. Repulsion and springs are isotropic, so a cloud
      // relaxes to roughly square however landscape the box it was given is --
      // and a square component in a landscape frame is fitted on its height,
      // leaving a third of the width empty. Pulling harder in y by the box's
      // own aspect ratio makes the component come out the shape of its frame.
      // Nothing is distorted by this that was ever measured: the force layout
      // has no ground truth in its aspect, which is why the page says distance
      // here is the packing and not a measurement.
      dx[i]! += (width / 2 - pos[i]!.x) * 0.012
      dy[i]! += (height / 2 - pos[i]!.y) * 0.012 * (width / Math.max(1, height))
      const d = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!) || 1
      const step = Math.min(d, temp)
      pos[i]!.x += (dx[i]! / d) * step
      pos[i]!.y += (dy[i]! / d) * step
    }
  }

  return pos
}

/** Node pitch in the grid of unconnected nodes. Wide rather than square because
 *  what collides here is labels, not dots. */
const CELL_W = 165
const CELL_H = 66
/** Breathing room inside a component's box, and between packed blocks. */
const BOX_PAD = 30
const GUTTER = 34

export function layoutGraph(
  nodes: Array<{ id: string; degree: number }>,
  edges: Array<{ source: string; target: string }>,
  { width = 1000, height = 620, iterations = 400 }: LayoutOptions = {}
): GraphLayout {
  const n = nodes.length
  if (!n) return { width, height, positions: {}, scale: 1, components: 0, isolated: 0 }

  const index = new Map<string, number>(nodes.map((nd, i) => [nd.id, i]))

  // ---- connected components
  const parent = nodes.map((_, i) => i)
  const find = (a: number): number => {
    let r = a
    while (parent[r] !== r) r = parent[r]!
    while (parent[a] !== r) {
      const nx = parent[a]!
      parent[a] = r
      a = nx
    }
    return r
  }
  for (const e of edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined) continue
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(i)
    else groups.set(r, [i])
  }
  // Largest first, then by first member: a tie broken by insertion order is a
  // tie broken by node order, which is stable across runs.
  const comps = [...groups.values()].sort((a, b) => b.length - a.length || a[0]! - b[0]!)
  const isolated = comps.reduce((k, c) => k + (c.length === 1 ? 1 : 0), 0)

  const rootOf = new Map<string, number>()
  nodes.forEach((nd, i) => rootOf.set(nd.id, find(i)))
  const inside = new Map<number, Array<{ source: string; target: string }>>()
  for (const e of edges) {
    const r = rootOf.get(e.source)
    if (r === undefined || rootOf.get(e.target) !== r) continue
    const list = inside.get(r)
    if (list) list.push(e)
    else inside.set(r, [e])
  }

  const blocks: PackedBlock[] = []
  for (const c of comps) {
    if (c.length < 2) continue
    const sub = c.map((i) => nodes[i]!)
    // Area per component grows with node count, so a 60-node knot is not given
    // the same box as a 3-node triangle and then blown up to match it.
    const side = Math.max(220, Math.sqrt(sub.length) * 132)
    const local = simulate(sub, inside.get(find(c[0]!)) || [], side, side * 0.66, iterations)
    const xs = local.map((p) => p.x)
    const ys = local.map((p) => p.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    blocks.push({
      w: Math.max(...xs) - minX + BOX_PAD * 2,
      h: Math.max(...ys) - minY + BOX_PAD * 2,
      ids: sub.map((s) => s.id),
      at: local.map((p) => ({ x: p.x - minX + BOX_PAD, y: p.y - minY + BOX_PAD })),
    })
  }

  // ---- shelf-pack the components, aiming at the frame's own aspect ratio.
  // Packing to the widest block instead would stack everything in one column
  // and leave a third of a landscape frame empty.
  const raw = new Map<string, { x: number; y: number }>()
  const area = blocks.reduce((a, b) => a + b.w * b.h, 0)
  const targetW = Math.max(...blocks.map((b) => b.w), Math.sqrt(area * (width / Math.max(1, height))), 1)
  let x = 0
  let y = 0
  let shelfH = 0
  let packW = 0
  for (const b of blocks) {
    if (x > 0 && x + b.w > targetW) {
      y += shelfH + GUTTER
      x = 0
      shelfH = 0
    }
    const ox = x
    const oy = y
    b.ids.forEach((id, i) => raw.set(id, { x: ox + b.at[i]!.x, y: oy + b.at[i]!.y }))
    x += b.w + GUTTER
    shelfH = Math.max(shelfH, b.h)
    packW = Math.max(packW, x - GUTTER)
  }
  const packH = y + shelfH

  // ---- the unconnected, as a rail beside the packed components
  //
  // Beside and not below: a rail sized to the height already in use keeps the
  // result the shape of the frame, where a grid appended underneath forces a
  // second shelf and shrinks everything to fit a column that is mostly air.
  // A grid rather than a scatter, because these nodes share no edge with
  // anything -- there is no geometry to draw, and pretending otherwise puts
  // meaning into distance that was never measured.
  const singles = comps.filter((c) => c.length === 1).map((c) => nodes[c[0]!]!)
  if (singles.length) {
    // Rows enough to sit alongside the pack, but never fewer than a block the
    // rough shape of the frame. Taking the pack's height alone is a trap: a
    // component of exactly two nodes is always 60px tall -- simulate seeds both
    // at the same y and every y-force cancels, so they never leave that line --
    // and floor(60/66) is 0, which collapses the rail to a single row thousands
    // of pixels wide and drags the whole fit down with it.
    const alongside = Math.floor(packH / CELL_H)
    const shaped = Math.ceil(Math.sqrt((singles.length * CELL_W) / (CELL_H * (width / Math.max(1, height)))))
    const rows = Math.max(1, Math.min(singles.length, Math.max(alongside, shaped)))
    const railH = Math.min(rows, singles.length) * CELL_H
    const ox = packW ? packW + GUTTER + BOX_PAD : 0
    const oy = Math.max(0, (packH - railH) / 2)
    // Column-major, so a column fills top to bottom before the next one starts.
    singles.forEach((s, i) =>
      raw.set(s.id, {
        x: ox + Math.floor(i / rows) * CELL_W + CELL_W / 2,
        y: oy + (i % rows) * CELL_H + CELL_H / 2,
      })
    )
  }

  // ---- one uniform fit over the real extent
  const pts = [...raw.values()]
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const bw = Math.max(...xs) - minX
  const bh = Math.max(...ys) - minY
  const pad = 46
  // No lower bound. A floor here overrides the fit it is wrapped around: past
  // roughly five frames' worth of content the packed extent stops shrinking,
  // the offsets go negative, and nodes are emitted outside the viewBox where
  // the canvas clips them -- invisible, unreachable, and still counted as drawn
  // by everything downstream. A graph too big to read is a graph to zoom into;
  // a graph half off the canvas is a graph that lies about what it contains.
  // The upper bound stays: a three-node graph blown up to fill the frame is
  // just a big triangle.
  const scale = Math.min(1.35, (width - pad * 2) / Math.max(1, bw), (height - pad * 2) / Math.max(1, bh))
  const offX = (width - bw * scale) / 2
  const offY = (height - bh * scale) / 2
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [id, p] of raw)
    positions[id] = {
      x: +(offX + (p.x - minX) * scale).toFixed(1),
      y: +(offY + (p.y - minY) * scale).toFixed(1),
    }
  return { width, height, positions, scale: +scale.toFixed(3), components: comps.length, isolated }
}

// ---------------------------------------------------------------- derived

/** Closed set. An authored id can never take one of these. */
export const DERIVED_KINDS = [
  'session', 'harness', 'repo', 'model', 'tool', 'mcp', 'skill',
  'cli', 'package', 'stack', 'ext', 'slash', 'mode', 'friction', 'turn',
] as const

const MAX_TOOLS = 30
const MAX_EDGES = 600
const COOCCUR_MIN = 3
const MAX_COOCCUR = 40

interface SpineTurn {
  index: number
  friction?: string[]
  derived?: { repeatOf?: number | null }
  interruptions?: number
  steering?: unknown
  slashCommands?: string[]
  subagents?: unknown[]
  toolCalls?: Array<{ name: string; count: number }>
  toolCallCount?: number
  model?: string | null
  mixedModel?: boolean
  startedAt?: string | null
  endedAt?: string | null
}

interface SpineSession {
  sessionId?: string | null
  harness?: string
  cwd?: string
  gitBranch?: string | null
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
  turns?: SpineTurn[]
  score?: { costliestTurn?: number | null }
}

const basename = (p: string): string => p.replace(/\/+$/, '').replace(/^.*\//, '') || p

export function deriveGraph(session: SpineSession): DerivedGraph {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const suppressed: Suppression[] = []

  const add = (id: string, kind: string, label: string, extra: Partial<GraphNode> = {}): string => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label, degree: 0, layer: 'derived', ...extra })
    return id
  }
  const link = (source: string, target: string, rel: string, extra: Partial<GraphEdge> = {}): void => {
    if (source === target) return
    edges.push({ source, target, rel, layer: 'derived', ...extra })
  }

  // When each node first became true, for replay.
  //
  // Only the turn stream can answer this, so anything the spine aggregates per
  // SESSION -- packages, CLI tools, stack files, extensions, skills -- never
  // reaches this map and ends up `null`. That is deliberate: the alternative is
  // to invent a moment, and the page already promises those are attributed to
  // the session and never to a turn. A null is drawn from the start and says so.
  const birth = new Map<string, number>()
  const bornAt = (id: string, at: number): void => {
    const cur = birth.get(id)
    if (cur === undefined || at < cur) birth.set(id, at)
  }

  const turns = session.turns || []
  const art = session.artifacts || {}
  const firstIdx = turns.length ? Math.min(...turns.map((t) => t.index)) : 0

  // The session node is unconditional. It is what makes the graph never empty,
  // even for a zero-turn session.
  const sid = session.sessionId || 'session'
  const sessionNode = add(`session:${sid}`, 'session', sid.slice(0, 8), {
    weight: turns.length,
    measured: `Measured -- ${turns.length} human turn(s), ${art.fileTouches ?? 0} file touch(es)`,
    // A count, and only a count. The spine may well carry the paths behind it
    // -- `turn.files` since the reading gained them -- but this graph draws no
    // file node, so what this NUMBER says is how many tool calls named a file
    // and nothing about which. The report's appendix is where the paths are
    // attributed; a note that implied this node knew them would send a reader
    // hunting the canvas for something that is not on it.
    note: `${art.fileTouches ?? 0} file touches. This graph draws no file node, so the number says how many, never which.`,
  })

  if (session.harness)
    link(sessionNode, add(`harness:${session.harness}`, 'harness', session.harness, {
      measured: `Measured -- session.harness = ${session.harness}`,
    }), 'ran under')

  if (session.cwd) {
    const repo = basename(session.cwd)
    link(sessionNode, add(`repo:${repo}`, 'repo', repo, {
      measured: `Measured -- session.cwd${session.gitBranch ? `, branch ${session.gitBranch}` : ''}`,
      note: session.gitBranch ? `branch ${session.gitBranch}` : undefined,
    }), 'in')
  }

  for (const [name, count] of Object.entries(session.models || {}))
    link(sessionNode, add(`model:${name}`, 'model', name, {
      weight: count,
      measured: `Measured -- session.models["${name}"] = ${count} assistant message(s)`,
    }), `${count} assistant messages`)

  // Session-scoped artifact maps. Never turn-scoped: the spine aggregates these
  // per session on purpose, so attaching one to a turn would be an invention.
  const ARTIFACT_KINDS: Array<[keyof NonNullable<SpineSession['artifacts']>, string]> = [
    ['tools', 'cli'], ['packages', 'package'], ['stack', 'stack'],
    ['extensions', 'ext'], ['skills', 'skill'], ['mcp', 'mcp'],
  ]
  for (const [key, kind] of ARTIFACT_KINDS) {
    const map = (art[key] as Record<string, number> | undefined) || {}
    for (const [name, count] of Object.entries(map))
      link(sessionNode, add(`${kind}:${name}`, kind, name, {
        weight: count,
        measured: `Measured -- session.artifacts.${key}["${name}"] = ${count}`,
      }), `used x${count}`)
  }

  for (const cmd of session.slashCommands || [])
    link(sessionNode, add(`slash:${cmd}`, 'slash', cmd, {
      measured: `Measured -- session.slashCommands includes ${cmd}`,
    }), 'invoked')

  // Counted, not repeated. permissionModes is one record per switch, and this
  // emitted an edge per record -- 319 identical session-to-mode lines on the
  // session this was written in, all drawn on top of each other, all eating the
  // global edge budget that the rest of the graph is then capped out of.
  const modeCounts = new Map<string, number>()
  for (const pm of session.permissionModes || [])
    if (pm.mode) modeCounts.set(pm.mode, (modeCounts.get(pm.mode) || 0) + 1)
  for (const [mode, n] of modeCounts)
    link(sessionNode, add(`mode:${mode}`, 'mode', mode, {
      weight: n,
      measured: `Measured -- session.permissionModes names ${mode} in ${n} record(s)`,
    }), n === 1 ? 'switched to' : `switched to x${n}`)

  // ---- tools, capped by count
  const toolTotals = new Map<string, number>()
  for (const t of turns)
    for (const c of t.toolCalls || []) toolTotals.set(c.name, (toolTotals.get(c.name) || 0) + c.count)
  const keptTools = new Set(
    [...toolTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOOLS).map(([n]) => n)
  )
  if (toolTotals.size > keptTools.size)
    suppressed.push({
      what: 'tools', dropped: toolTotals.size - keptTools.size, of: toolTotals.size,
      why: `only the top ${MAX_TOOLS} by call count are drawn`,
    })
  for (const name of keptTools)
    add(`tool:${name}`, 'tool', name, {
      weight: toolTotals.get(name),
      measured: `Measured -- ${toolTotals.get(name)} call(s) across the session`,
    })

  // Births, over EVERY turn rather than only the drawn ones. A tool first
  // called in a turn the gate removed still first appeared then, and a replay
  // that showed it later would be reporting the gate, not the session.
  for (const t of turns) {
    bornAt(`turn:${t.index}`, t.index)
    for (const c of t.toolCalls || []) {
      if (keptTools.has(c.name)) bornAt(`tool:${c.name}`, t.index)
      const server = c.name.startsWith('mcp__') ? c.name.split('__')[1] : null
      if (server) bornAt(`mcp:${server}`, t.index)
    }
    if (t.model) bornAt(`model:${t.model}`, t.index)
    for (const cmd of t.slashCommands || []) bornAt(`slash:${cmd}`, t.index)
    for (const f of t.friction || []) bornAt(`friction:${f}`, t.index)
  }

  // ---- which turns get drawn
  //
  // A turn is drawn when it carries a signal of its own, OR when something else
  // in the graph points at it. The second half is not decoration: `repeated`
  // friction is attached to the REPEATING turn only, so the target of a repeat
  // star earns nothing itself -- and a permission-mode switch is bracketed into
  // a turn that may be otherwise clean. Without these two, every such edge
  // dangles at a node the gate removed.
  const repeatTargets = new Set<number>()
  for (const t of turns) {
    const r = t.derived?.repeatOf
    if (typeof r === 'number' && r >= 0) repeatTargets.add(r)
  }
  // Which modes each host turn actually bracketed -- not merely that it
  // bracketed one. Keeping only the turn index meant every host turn was then
  // linked to every mode in the session, so a turn that saw one switch claimed
  // all of them.
  const modeHosts = new Map<number, Set<string>>()
  for (const pm of session.permissionModes || []) {
    if (!pm.ts) continue
    const at = Date.parse(pm.ts)
    if (!Number.isFinite(at)) continue
    const host = turns.find((t) => {
      const s = t.startedAt ? Date.parse(t.startedAt) : NaN
      const e = t.endedAt ? Date.parse(t.endedAt) : NaN
      return Number.isFinite(s) && Number.isFinite(e) && at >= s && at <= e
    })
    if (host && pm.mode) {
      const seen = modeHosts.get(host.index) || new Set<string>()
      seen.add(pm.mode)
      modeHosts.set(host.index, seen)
      bornAt(`mode:${pm.mode}`, host.index)
    }
  }
  const byTools = [...turns].sort((a, b) => (b.toolCallCount || 0) - (a.toolCallCount || 0)).slice(0, 3)
  const anchors = new Set<number>(byTools.map((t) => t.index))
  if (typeof session.score?.costliestTurn === 'number') anchors.add(session.score.costliestTurn)

  const carries = (t: SpineTurn): boolean =>
    (t.friction || []).length > 0 ||
    (typeof t.derived?.repeatOf === 'number' && t.derived.repeatOf !== null) ||
    (t.interruptions || 0) > 0 ||
    Boolean(t.steering) ||
    (t.slashCommands || []).length > 0 ||
    (t.subagents || []).length > 0

  const drawn = turns.filter(
    (t) => carries(t) || anchors.has(t.index) || repeatTargets.has(t.index) || modeHosts.has(t.index)
  )
  const drawnIdx = new Set(drawn.map((t) => t.index))
  if (turns.length > drawn.length)
    suppressed.push({
      what: 'turns', dropped: turns.length - drawn.length, of: turns.length,
      why: 'they carried no friction, repeat, interruption, steering, slash command or subagent, and nothing else pointed at them',
    })

  for (const t of drawn) {
    const id = add(`turn:${t.index}`, 'turn', `turn ${t.index}`, {
      weight: t.toolCallCount,
      turns: [t.index],
      measured: `Measured -- turn ${t.index}: ${t.toolCallCount ?? 0} tool call(s)`,
    })
    link(sessionNode, id, 'turn of')

    for (const c of t.toolCalls || [])
      if (keptTools.has(c.name)) link(id, `tool:${c.name}`, `called x${c.count}`, { weight: c.count })

    // The one artifact recoverable per turn, parsed with the upstream
    // expression so the graph cannot disagree with artifacts.mcp.
    for (const c of t.toolCalls || []) {
      const server = c.name.startsWith('mcp__') ? c.name.split('__')[1] : null
      if (server && nodes.has(`mcp:${server}`)) link(id, `mcp:${server}`, 'called a tool on')
    }

    if (t.model && nodes.has(`model:${t.model}`))
      link(id, `model:${t.model}`, t.mixedModel ? 'plurality model (mixed)' : 'plurality model')

    for (const f of t.friction || [])
      link(id, add(`friction:${f}`, 'friction', f, { measured: `Measured -- turn friction "${f}"` }), 'showed')

    const r = t.derived?.repeatOf
    if (typeof r === 'number' && drawnIdx.has(r)) link(id, `turn:${r}`, 'repeats', { dashed: true })

    // A slash record does not open a turn, so it attaches to the PRECEDING
    // human turn. The rel string has to say so, or the edge reads as a claim
    // that this turn ran the command.
    for (const cmd of t.slashCommands || [])
      if (nodes.has(`slash:${cmd}`)) link(id, `slash:${cmd}`, 'issued while this turn was open')

    for (const mode of modeHosts.get(t.index) || [])
      if (nodes.has(`mode:${mode}`)) link(id, `mode:${mode}`, 'switched here')
  }

  // ---- tool co-occurrence: the densest relation, so gated hard
  const pair = new Map<string, number>()
  // The turn the pair CROSSED the threshold, not the turn they first met. The
  // edge claims "co-occur in N turns", and that claim was not true until here --
  // taking the max of the two endpoints instead would draw it turns too early.
  const pairAt = new Map<string, number>()
  for (const t of turns) {
    const names = (t.toolCalls || []).map((c) => c.name).filter((n) => keptTools.has(n)).sort()
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++) {
        const key = `${names[i]} ${names[j]}`
        const seen = (pair.get(key) || 0) + 1
        pair.set(key, seen)
        if (seen === COOCCUR_MIN) pairAt.set(key, t.index)
      }
  }
  const cooc = [...pair.entries()].filter(([, n]) => n >= COOCCUR_MIN).sort((a, b) => b[1] - a[1])
  for (const [key, n] of cooc.slice(0, MAX_COOCCUR)) {
    const [a, b] = key.split(' ')
    edges.push({
      source: `tool:${a}`, target: `tool:${b}`, rel: `co-occur in ${n} turns`,
      layer: 'derived', weight: n, dashed: true, firstTurn: pairAt.get(key) ?? null,
    })
  }
  if (cooc.length > MAX_COOCCUR)
    suppressed.push({
      what: 'tool co-occurrences', dropped: cooc.length - MAX_COOCCUR, of: cooc.length,
      why: `capped at ${MAX_COOCCUR}`,
    })

  // ---- global edge cap. Layout is O(n^2) per iteration.
  let kept = edges
  if (edges.length > MAX_EDGES) {
    kept = edges.slice(0, MAX_EDGES)
    suppressed.push({ what: 'edges', dropped: edges.length - MAX_EDGES, of: edges.length, why: `capped at ${MAX_EDGES}` })
  }

  // Drop any edge whose endpoints are not both present, then count degree.
  const present = new Set(nodes.keys())
  const final = kept.filter((e) => present.has(e.source) && present.has(e.target))
  for (const e of final) {
    nodes.get(e.source)!.degree++
    nodes.get(e.target)!.degree++
  }

  // ---- tether every node and edge to a turn
  for (const nd of nodes.values()) {
    if (nd.kind === 'session' || nd.kind === 'harness' || nd.kind === 'repo') nd.firstTurn = firstIdx
    else nd.firstTurn = birth.has(nd.id) ? birth.get(nd.id)! : null
  }
  // An edge cannot predate either end. Where a node is unattributable it counts
  // as present from the start, so the edge is governed by the end that is dated.
  const at = (id: string): number => {
    const v = nodes.get(id)?.firstTurn
    return typeof v === 'number' ? v : firstIdx
  }
  for (const e of final)
    if (typeof e.firstTurn !== 'number') e.firstTurn = Math.max(at(e.source), at(e.target))

  return { nodes: [...nodes.values()], edges: final, suppressed }
}

// ---------------------------------------------------------------- authored

export interface IntentConcept {
  id?: string
  label?: string
  group?: string
  note?: string
  turns?: number[]
  anchors?: string[]
}
export interface IntentRelation {
  from?: string
  to?: string
  label?: string
  dashed?: boolean
}
export interface IntentGraph {
  concepts?: IntentConcept[]
  relations?: IntentRelation[]
}

/** Closed, and disjoint from every derived kind, so an authored node cannot
 *  claim to be a repo, a harness, a model or a tool. */
export const AUTHORED_GROUPS = ['decision', 'defect', 'guard', 'thread', 'subsystem', 'question'] as const

/** The four statuses an intent can carry, closed so a status the model invents
 *  cannot mint a hub of its own. Anything else is filed under `unstated`, which
 *  is a fact about the analysis rather than a fifth kind of outcome. */
export const INTENT_STATUSES = ['done', 'partial', 'abandoned', 'ongoing'] as const

/** One thread the model concluded something about. The same shape render.mts
 *  reads out of the intent document, narrowed to what a picture can use. */
export interface IntentThread {
  title?: string
  status?: string
  summary?: string
  turns?: number[]
}

/** One earlier session's conclusions, as the store hands them over. `session`
 *  and `sessionsAgo` are what keep them from being drawn as this session's. */
export interface PriorLayer {
  session?: string
  sessionsAgo?: number
  daysAgo?: number | null
  intents?: IntentThread[]
  graph?: IntentGraph
}

/** Everything beyond the flat concept bag that the authored layer now draws. */
export interface AuthoredExtra {
  intents?: IntentThread[]
  prior?: PriorLayer[]
}

const MAX_CONCEPTS = 60
const MAX_RELATIONS = 120
const MAX_INTENTS = 40
const MAX_PRIOR = 4
const MAX_PRIOR_NODES = 24
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** Titles are prose, ids are not. Slugged rather than hashed so the id stays
 *  legible in `data-id` and in a test failure, and capped so one runaway title
 *  cannot make an id longer than every other id put together. */
const slug = (s: string): string =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

const statusOf = (v: unknown): string =>
  (INTENT_STATUSES as readonly string[]).includes(String(v)) ? String(v) : 'unstated'

export interface MergeResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  dropped: Suppression[]
}

export function mergeAuthored(
  derived: DerivedGraph,
  graph: IntentGraph | null | undefined,
  turnCount: number,
  extra?: AuthoredExtra | null
): MergeResult {
  const nodes = [...derived.nodes]
  const edges = [...derived.edges]
  const dropped: Suppression[] = []
  // The concept bag, the intents and the carried layer are three independent
  // reasons to have an authored layer at all. Returning early on a missing
  // `graph` used to be right because it was the only one; it would now throw
  // away a whole session's intents whenever the model wrote no concepts.
  const threads = extra?.intents ?? []
  const priors = extra?.prior ?? []
  if (!graph && !threads.length && !priors.length) return { nodes, edges, dropped }

  const derivedIds = new Set(derived.nodes.map((n) => n.id))
  const derivedBirth = new Map<string, number | null>(derived.nodes.map((n) => [n.id, n.firstTurn ?? null]))
  const concepts = graph?.concepts || []
  const relations = graph?.relations || []
  const byId = new Map<string, string>() // authored id -> namespaced id

  let badId = 0
  let badGroup = 0
  let badTurn = 0
  let badAnchor = 0
  for (const c of concepts.slice(0, MAX_CONCEPTS)) {
    const raw = String(c.id ?? '')
    if (!ID_RE.test(raw) || !c.label) {
      badId++
      continue
    }
    // Namespaced before anything else. This is the separation -- not the CSS.
    const id = `concept:${raw}`
    if (derivedIds.has(id) || byId.has(raw)) {
      badId++
      continue
    }
    const group = (AUTHORED_GROUPS as readonly string[]).includes(String(c.group)) ? String(c.group) : 'concept'
    if (c.group && group === 'concept') badGroup++
    const turns = (c.turns || []).filter((t) => Number.isInteger(t) && t >= 0 && t < turnCount)
    badTurn += (c.turns || []).length - turns.length

    // A concept enters the replay at the earliest turn it names; failing that,
    // at the earliest turn its anchors were born. A concept anchored to nothing
    // dated stays null and is present from the start -- the model's reading of
    // the session is not itself an event in it.
    const anchored = (c.anchors || [])
      .map((a) => derivedBirth.get(String(a)))
      .filter((v): v is number => typeof v === 'number')
    const firstTurn = turns.length ? Math.min(...turns) : anchored.length ? Math.min(...anchored) : null

    byId.set(raw, id)
    nodes.push({
      id,
      kind: group,
      label: String(c.label).slice(0, 60),
      degree: 0,
      layer: 'authored',
      note: c.note ? String(c.note).slice(0, 400) : undefined,
      turns: turns.length ? turns : undefined,
      firstTurn,
    })

    // Anchors are the ONLY way the authored layer touches the skeleton, and
    // the direction is one-way -- which is what lets the derived graph stand
    // alone when `graph` is absent.
    for (const a of c.anchors || []) {
      if (derivedIds.has(String(a)))
        edges.push({ source: id, target: String(a), rel: 'anchored to', layer: 'authored', dashed: true })
      else badAnchor++
    }
  }
  if (concepts.length > MAX_CONCEPTS)
    dropped.push({ what: 'concepts', dropped: concepts.length - MAX_CONCEPTS, of: concepts.length, why: `capped at ${MAX_CONCEPTS}` })
  if (badId)
    dropped.push({ what: 'concepts', dropped: badId, of: concepts.length, why: 'missing or malformed id, missing label, or a duplicate' })
  if (badGroup)
    dropped.push({ what: 'concept groups', dropped: badGroup, of: concepts.length, why: `not one of ${AUTHORED_GROUPS.join(', ')} -- shown as "concept"` })
  if (badTurn)
    dropped.push({ what: 'concept turn refs', dropped: badTurn, of: badTurn, why: 'out of range for this session' })
  if (badAnchor)
    dropped.push({ what: 'anchors', dropped: badAnchor, of: badAnchor, why: 'named a node that is not in the derived graph' })

  // ---- the intents, as a structure
  //
  // Each thread becomes a node, the threads of one status share a hub, and a
  // thread reaches the skeleton through the turns its author CITED. That is the
  // whole of the coupling: an intent is drawn beside the measured turns it
  // named, and beside nothing it did not name.
  //
  // The hub is not decoration. Four threads with three statuses between them is
  // a shape a reader takes in at a glance and a caption they have to count; and
  // when the graph is packed to a third of its size, the shape is the half that
  // survives.
  const intentIds = new Map<string, string>() // slug -> namespaced id
  let badIntent = 0
  let uncitedTurn = 0
  {
    const hubs = new Map<string, string>()
    const hubCount = new Map<string, number>()
    const hubBirth = new Map<string, number>()
    for (const t of threads.slice(0, MAX_INTENTS)) {
      const title = String(t?.title ?? '').trim()
      const raw = slug(title)
      if (!title || !raw || intentIds.has(raw)) {
        badIntent++
        continue
      }
      const id = `intent:${raw}`
      if (derivedIds.has(id)) {
        badIntent++
        continue
      }
      const status = statusOf(t?.status)
      const turns = (t?.turns || []).filter((n) => Number.isInteger(n) && n >= 0 && n < turnCount)
      uncitedTurn += (t?.turns || []).length - turns.length
      const firstTurn = turns.length ? Math.min(...turns) : null
      intentIds.set(raw, id)
      nodes.push({
        id,
        kind: 'intent',
        label: title.slice(0, 60),
        degree: 0,
        layer: 'authored',
        status,
        note: t?.summary ? String(t.summary).slice(0, 400) : undefined,
        turns: turns.length ? turns : undefined,
        firstTurn,
      })

      const hub = hubs.get(status) ?? `status:${status}`
      hubs.set(status, hub)
      hubCount.set(status, (hubCount.get(status) ?? 0) + 1)
      if (typeof firstTurn === 'number') {
        const cur = hubBirth.get(status)
        if (cur === undefined || firstTurn < cur) hubBirth.set(status, firstTurn)
      }
      edges.push({ source: id, target: hub, rel: 'status', layer: 'authored', dashed: false })

      // Only turns the derived gates actually drew. A line to a node that is
      // not on the canvas is a stub, and the count of the ones that could not
      // be drawn is reported below rather than left as a silent shortfall.
      for (const n of turns) {
        if (derivedIds.has(`turn:${n}`))
          edges.push({ source: id, target: `turn:${n}`, rel: 'cited turn', layer: 'authored', dashed: true, firstTurn: n })
        else uncitedTurn++
      }
    }
    for (const [status, hub] of hubs)
      nodes.push({
        id: hub,
        kind: 'status',
        label: `${status} · ${hubCount.get(status) ?? 0}`,
        degree: 0,
        layer: 'authored',
        status,
        note:
          status === 'unstated'
            ? 'Threads whose status the analysis did not state, or stated as something outside done, partial, abandoned and ongoing.'
            : `Threads the analysis marked ${status}.`,
        firstTurn: hubBirth.get(status) ?? null,
      })
  }
  if (threads.length > MAX_INTENTS)
    dropped.push({ what: 'intents', dropped: threads.length - MAX_INTENTS, of: threads.length, why: `capped at ${MAX_INTENTS}` })
  if (badIntent)
    dropped.push({ what: 'intents', dropped: badIntent, of: threads.length, why: 'no title, or a title that slugs to one already drawn' })
  if (uncitedTurn)
    dropped.push({
      what: 'intent turn citations',
      dropped: uncitedTurn,
      of: uncitedTurn,
      why: 'the turn is out of range for this session, or the turn gates did not draw it; the citation stands, the line has nowhere to land',
    })

  let badEnd = 0
  const resolve = (v: unknown): string | null => {
    const s = String(v ?? '')
    if (byId.has(s)) return byId.get(s)!
    // A relation may name a thread by its title, which is how the model would
    // refer to one; concepts win the name, because they were here first and
    // their ids are declared rather than derived from prose.
    const asIntent = intentIds.get(slug(s))
    if (asIntent) return asIntent
    if (derivedIds.has(s)) return s
    return null
  }
  for (const r of relations.slice(0, MAX_RELATIONS)) {
    const from = resolve(r.from)
    const to = resolve(r.to)
    if (!from || !to || from === to) {
      badEnd++
      continue
    }
    edges.push({
      source: from,
      target: to,
      layer: 'authored',
      dashed: r.dashed !== false,
      rel: r.label ? String(r.label).slice(0, 40) : undefined,
    })
  }
  if (relations.length > MAX_RELATIONS)
    dropped.push({ what: 'relations', dropped: relations.length - MAX_RELATIONS, of: relations.length, why: `capped at ${MAX_RELATIONS}` })
  if (badEnd)
    dropped.push({ what: 'relations', dropped: badEnd, of: relations.length, why: 'an endpoint resolved to nothing' })

  // ---- what the store carried in from earlier sessions
  //
  // Everything here is drawn under a hub of its own and dated to no turn. Both
  // of those are refusals, not layout preferences. An earlier session's turn 4
  // is a different turn 4, so placing a carried conclusion on this session's
  // replay would put it on a timeline it was never on; and mixing it into this
  // session's status hubs would make "three threads still ongoing" a number
  // covering two different weeks of work.
  let carriedAnchor = 0
  let badCarried = 0
  let carriedBudget = 0
  for (const p of priors.slice(0, MAX_PRIOR)) {
    const sid = String(p?.session ?? '').trim()
    if (!sid) {
      badCarried++
      continue
    }
    // Eight characters of the id, which is how every other surface on the page
    // names a session. Two priors that agree on all eight collide, and the
    // collision is REFUSED below rather than silently merging one session's
    // conclusions into another's hub.
    const tag = slug(sid.slice(0, 8)) || 'prior'
    const hub = `prior:${tag}`
    if (nodes.some((n) => n.id === hub)) {
      badCarried++
      continue
    }
    const ago = Number.isInteger(p?.sessionsAgo) && (p!.sessionsAgo as number) > 0 ? (p!.sessionsAgo as number) : null
    const days = typeof p?.daysAgo === 'number' ? p.daysAgo : null
    // `ago` is resolved to null two lines up when the document did not say how
    // far back this session was, and the hub label honours that ("an earlier
    // session"). Passing `?? 1` on to the children threw the null away and wrote
    // "carried from a session 1 back" into the title, the accessible name and
    // the side panel of every one of them -- a number nothing in the document
    // stated, on the one field a reader is told to trust here, contradicting the
    // hub they hang off.
    const from: CarriedFrom = { session: sid, sessionsAgo: ago, daysAgo: days }
    const when = ago === null ? 'an earlier session' : ago === 1 ? '1 session ago' : `${ago} sessions ago`
    nodes.push({
      id: hub,
      kind: 'prior',
      label: when,
      degree: 0,
      layer: 'authored',
      carried: from,
      // No `measured`, and the wording is deliberately about the RECORD rather
      // than the work: the store knows this session was analysed, not what
      // happened in it.
      note:
        `Conclusions the intent store kept from session ${sid.slice(0, 8)}` +
        (days === null ? '' : days === 0 ? ', recorded today' : days === 1 ? ', recorded 1 day ago' : `, recorded ${days} days ago`) +
        '. Nothing has re-checked whether they still hold.',
      firstTurn: null,
    })

    let budget = MAX_PRIOR_NODES
    // Every other cap in this function pushes a Suppression; this one broke out
    // of two loops and pushed nothing, so a prior session's conclusions past the
    // budget were on no canvas and in no count -- while the footer stated a bare
    // total of what survived and `priorOmitted` read 0, because the store had
    // emitted everything the graph then threw away. A truncated history
    // presented as a whole one is the same defect class as an undated
    // conclusion. Concepts are drawn after intents from ONE shared budget, so a
    // session's decisions can disappear wholesale while its threads all survive:
    // the count below is what makes that visible.
    const offered = (p?.intents || []).length + (p?.graph?.concepts || []).length
    const localIds = new Map<string, string>()
    for (const t of p?.intents || []) {
      if (budget <= 0) break
      const title = String(t?.title ?? '').trim()
      const raw = slug(title)
      if (!title || !raw || localIds.has(`intent:${raw}`)) {
        badCarried++
        continue
      }
      budget--
      const id = `prior:${tag}:intent:${raw}`
      localIds.set(`intent:${raw}`, id)
      const cited = (t?.turns || []).filter((n) => Number.isInteger(n))
      nodes.push({
        id,
        kind: 'intent',
        label: title.slice(0, 60),
        degree: 0,
        layer: 'authored',
        status: statusOf(t?.status),
        carried: from,
        // The citation is prose, not `turns`. `turns` is read as an index into
        // THIS session's turn list everywhere it is rendered, and these numbers
        // index another session's.
        note:
          (t?.summary ? `${String(t.summary).slice(0, 320)} ` : '') +
          (cited.length
            ? `Cited turn ${cited.join(', ')} of session ${sid.slice(0, 8)}, not of this one.`
            : 'No turns were cited for it.'),
        firstTurn: null,
      })
      edges.push({ source: id, target: hub, rel: 'carried from', layer: 'authored', dashed: true, firstTurn: null })
    }

    for (const c of p?.graph?.concepts || []) {
      if (budget <= 0) break
      const raw = String(c?.id ?? '')
      if (!ID_RE.test(raw) || !c?.label || localIds.has(`concept:${raw}`)) {
        badCarried++
        continue
      }
      budget--
      const id = `prior:${tag}:concept:${raw}`
      localIds.set(`concept:${raw}`, id)
      const group = (AUTHORED_GROUPS as readonly string[]).includes(String(c.group)) ? String(c.group) : 'concept'
      const cited = (c.turns || []).filter((n) => Number.isInteger(n))
      nodes.push({
        id,
        kind: group,
        label: String(c.label).slice(0, 60),
        degree: 0,
        layer: 'authored',
        carried: from,
        note:
          (c.note ? `${String(c.note).slice(0, 320)} ` : '') +
          (cited.length
            ? `Cited turn ${cited.join(', ')} of session ${sid.slice(0, 8)}, not of this one.`
            : 'No turns were cited for it.'),
        firstTurn: null,
      })
      edges.push({ source: id, target: hub, rel: 'carried from', layer: 'authored', dashed: true, firstTurn: null })
      // Anchors are refused, and this is the point where it would be easiest to
      // be helpful and wrong: `tool:git` in that session and `tool:git` in this
      // one are the same id and not the same evidence, and an anchor drawn
      // across them would let a conclusion about last week's code hang off a
      // node measured out of today's transcript.
      carriedAnchor += (c.anchors || []).length
    }

    // After BOTH loops, because they share the budget: counted here, the number
    // is what this session offered and the canvas did not take.
    if (offered > MAX_PRIOR_NODES) carriedBudget += offered - MAX_PRIOR_NODES

    if ((p?.graph?.relations || []).length) {
      for (const r of p!.graph!.relations!) {
        const from2 = localIds.get(`concept:${String(r?.from ?? '')}`) || localIds.get(`intent:${slug(String(r?.from ?? ''))}`)
        const to2 = localIds.get(`concept:${String(r?.to ?? '')}`) || localIds.get(`intent:${slug(String(r?.to ?? ''))}`)
        if (!from2 || !to2 || from2 === to2) {
          badCarried++
          continue
        }
        edges.push({
          source: from2,
          target: to2,
          layer: 'authored',
          dashed: true,
          rel: r?.label ? String(r.label).slice(0, 40) : undefined,
          firstTurn: null,
        })
      }
    }
  }
  if (priors.length > MAX_PRIOR)
    dropped.push({ what: 'earlier sessions', dropped: priors.length - MAX_PRIOR, of: priors.length, why: `capped at ${MAX_PRIOR}` })
  if (badCarried)
    dropped.push({
      what: 'carried conclusions',
      dropped: badCarried,
      of: badCarried,
      why: 'no title or id, a duplicate within its own session, or a relation whose endpoint was not carried with it',
    })
  if (carriedBudget)
    dropped.push({
      what: 'carried conclusions',
      dropped: carriedBudget,
      of: carriedBudget,
      why: `each earlier session is drawn at most ${MAX_PRIOR_NODES} conclusions deep, and threads are drawn before decisions`,
    })
  if (carriedAnchor)
    dropped.push({
      what: 'anchors on carried conclusions',
      dropped: carriedAnchor,
      of: carriedAnchor,
      why: 'they name nodes measured out of THIS transcript, and the same id in an earlier session is not the same evidence',
    })

  const index = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) n.degree = 0
  const live = edges.filter((e) => index.has(e.source) && index.has(e.target))
  for (const e of live) {
    index.get(e.source)!.degree++
    index.get(e.target)!.degree++
  }
  const at = (id: string): number => {
    const v = index.get(id)?.firstTurn
    return typeof v === 'number' ? v : 0
  }
  // `=== undefined`, not `typeof !== 'number'`. A carried edge is dated null on
  // purpose -- it belongs to no turn of this session -- and the looser test
  // read that deliberate null as "not filled in yet" and stamped turn 0 on it,
  // which is a date, and a date is what the null was refusing to give.
  for (const e of live)
    if (e.firstTurn === undefined) e.firstTurn = Math.max(at(e.source), at(e.target))
  return { nodes, edges: live, dropped }
}
