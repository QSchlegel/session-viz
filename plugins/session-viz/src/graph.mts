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
// -- What this file will not do ---------------------------------------------
// No file nodes. `harvestPath` reduces a path to a basename match, a bare
// extension and `fileTouches++`, then discards it -- `artifacts.fileTouches` is
// an integer, so there is no file to draw and no way to recover one without
// re-reading the transcript. It is printed as a count on the session node.
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
    note: `${art.fileTouches ?? 0} file touches. Which files is not recorded.`,
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

const MAX_CONCEPTS = 60
const MAX_RELATIONS = 120
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface MergeResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  dropped: Suppression[]
}

export function mergeAuthored(
  derived: DerivedGraph,
  graph: IntentGraph | null | undefined,
  turnCount: number
): MergeResult {
  const nodes = [...derived.nodes]
  const edges = [...derived.edges]
  const dropped: Suppression[] = []
  if (!graph) return { nodes, edges, dropped }

  const derivedIds = new Set(derived.nodes.map((n) => n.id))
  const derivedBirth = new Map<string, number | null>(derived.nodes.map((n) => [n.id, n.firstTurn ?? null]))
  const concepts = graph.concepts || []
  const relations = graph.relations || []
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

  let badEnd = 0
  const resolve = (v: unknown): string | null => {
    const s = String(v ?? '')
    if (byId.has(s)) return byId.get(s)!
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
  for (const e of live)
    if (typeof e.firstTurn !== 'number') e.firstTurn = Math.max(at(e.source), at(e.target))
  return { nodes, edges: live, dropped }
}
