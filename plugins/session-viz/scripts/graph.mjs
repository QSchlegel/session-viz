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
// ---------------------------------------------------------------- layout
// Force-directed layout, computed here rather than in the browser so the page
// stays static and the same input always draws the same picture. Seeding on a
// circle by index keeps it free of randomness -- Math.random would make every
// regeneration a different graph and every diff meaningless.
//
// Moved here from corpus.mts so the two renderers share one implementation. A
// second copy of an 80-line simulation that drifts from the first is the same
// staleness failure this file exists to answer, one level up.
export function layoutGraph(nodes, edges, { width = 1000, height = 620, iterations = 400 } = {}) {
    const n = nodes.length;
    if (!n)
        return { width, height, positions: {} };
    const pos = nodes.map((_, i) => {
        const a = (i / n) * Math.PI * 2;
        return { x: width / 2 + Math.cos(a) * width * 0.32, y: height / 2 + Math.sin(a) * height * 0.32 };
    });
    const index = new Map(nodes.map((nd, i) => [nd.id, i]));
    const k = Math.sqrt((width * height) / n) * 0.55;
    const deg = nodes.map((nd) => Math.max(1, nd.degree));
    for (let it = 0; it < iterations; it++) {
        const temp = (1 - it / iterations) * (width * 0.06) + 0.5;
        const dx = new Array(n).fill(0);
        const dy = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let ex = pos[i].x - pos[j].x;
                let ey = pos[i].y - pos[j].y;
                let d2 = ex * ex + ey * ey;
                if (d2 < 0.01) {
                    ex = (i % 7) - 3 + 0.5;
                    ey = (j % 5) - 2 + 0.5;
                    d2 = ex * ex + ey * ey;
                }
                const d = Math.sqrt(d2);
                const f = (k * k) / d;
                dx[i] += (ex / d) * f;
                dy[i] += (ey / d) * f;
                dx[j] -= (ex / d) * f;
                dy[j] -= (ey / d) * f;
            }
        }
        for (const e of edges) {
            const i = index.get(e.source);
            const j = index.get(e.target);
            if (i === undefined || j === undefined)
                continue;
            const ex = pos[i].x - pos[j].x;
            const ey = pos[i].y - pos[j].y;
            const d = Math.sqrt(ex * ex + ey * ey) || 0.01;
            const f = (d * d) / k / Math.sqrt(Math.min(deg[i], deg[j]));
            dx[i] -= (ex / d) * f;
            dy[i] += -(ey / d) * f;
            dx[j] += (ex / d) * f;
            dy[j] += (ey / d) * f;
        }
        for (let i = 0; i < n; i++) {
            dx[i] += (width / 2 - pos[i].x) * 0.012;
            dy[i] += (height / 2 - pos[i].y) * 0.012;
            const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
            const step = Math.min(d, temp);
            pos[i].x += (dx[i] / d) * step;
            pos[i].y += (dy[i] / d) * step;
        }
    }
    const pad = 56;
    const xs = pos.map((p) => p.x);
    const ys = pos.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const sx = (width - pad * 2) / Math.max(1, maxX - minX);
    const sy = (height - pad * 2) / Math.max(1, maxY - minY);
    const positions = {};
    nodes.forEach((nd, i) => {
        positions[nd.id] = {
            x: +(pad + (pos[i].x - minX) * sx).toFixed(1),
            y: +(pad + (pos[i].y - minY) * sy).toFixed(1),
        };
    });
    return { width, height, positions };
}
// ---------------------------------------------------------------- derived
/** Closed set. An authored id can never take one of these. */
export const DERIVED_KINDS = [
    'session', 'harness', 'repo', 'model', 'tool', 'mcp', 'skill',
    'cli', 'package', 'stack', 'ext', 'slash', 'mode', 'friction', 'turn',
];
const MAX_TOOLS = 30;
const MAX_EDGES = 600;
const COOCCUR_MIN = 3;
const MAX_COOCCUR = 40;
const basename = (p) => p.replace(/\/+$/, '').replace(/^.*\//, '') || p;
export function deriveGraph(session) {
    const nodes = new Map();
    const edges = [];
    const suppressed = [];
    const add = (id, kind, label, extra = {}) => {
        if (!nodes.has(id))
            nodes.set(id, { id, kind, label, degree: 0, layer: 'derived', ...extra });
        return id;
    };
    const link = (source, target, rel, extra = {}) => {
        if (source === target)
            return;
        edges.push({ source, target, rel, layer: 'derived', ...extra });
    };
    const turns = session.turns || [];
    const art = session.artifacts || {};
    // The session node is unconditional. It is what makes the graph never empty,
    // even for a zero-turn session.
    const sid = session.sessionId || 'session';
    const sessionNode = add(`session:${sid}`, 'session', sid.slice(0, 8), {
        weight: turns.length,
        measured: `Measured -- ${turns.length} human turn(s), ${art.fileTouches ?? 0} file touch(es)`,
        note: `${art.fileTouches ?? 0} file touches. Which files is not recorded.`,
    });
    if (session.harness)
        link(sessionNode, add(`harness:${session.harness}`, 'harness', session.harness, {
            measured: `Measured -- session.harness = ${session.harness}`,
        }), 'ran under');
    if (session.cwd) {
        const repo = basename(session.cwd);
        link(sessionNode, add(`repo:${repo}`, 'repo', repo, {
            measured: `Measured -- session.cwd${session.gitBranch ? `, branch ${session.gitBranch}` : ''}`,
            note: session.gitBranch ? `branch ${session.gitBranch}` : undefined,
        }), 'in');
    }
    for (const [name, count] of Object.entries(session.models || {}))
        link(sessionNode, add(`model:${name}`, 'model', name, {
            weight: count,
            measured: `Measured -- session.models["${name}"] = ${count} assistant message(s)`,
        }), `${count} assistant messages`);
    // Session-scoped artifact maps. Never turn-scoped: the spine aggregates these
    // per session on purpose, so attaching one to a turn would be an invention.
    const ARTIFACT_KINDS = [
        ['tools', 'cli'], ['packages', 'package'], ['stack', 'stack'],
        ['extensions', 'ext'], ['skills', 'skill'], ['mcp', 'mcp'],
    ];
    for (const [key, kind] of ARTIFACT_KINDS) {
        const map = art[key] || {};
        for (const [name, count] of Object.entries(map))
            link(sessionNode, add(`${kind}:${name}`, kind, name, {
                weight: count,
                measured: `Measured -- session.artifacts.${key}["${name}"] = ${count}`,
            }), `used x${count}`);
    }
    for (const cmd of session.slashCommands || [])
        link(sessionNode, add(`slash:${cmd}`, 'slash', cmd, {
            measured: `Measured -- session.slashCommands includes ${cmd}`,
        }), 'invoked');
    for (const pm of session.permissionModes || []) {
        if (!pm.mode)
            continue;
        link(sessionNode, add(`mode:${pm.mode}`, 'mode', pm.mode, {
            measured: 'Measured -- session.permissionModes entry',
        }), 'switched to');
    }
    // ---- tools, capped by count
    const toolTotals = new Map();
    for (const t of turns)
        for (const c of t.toolCalls || [])
            toolTotals.set(c.name, (toolTotals.get(c.name) || 0) + c.count);
    const keptTools = new Set([...toolTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOOLS).map(([n]) => n));
    if (toolTotals.size > keptTools.size)
        suppressed.push({
            what: 'tools', dropped: toolTotals.size - keptTools.size, of: toolTotals.size,
            why: `only the top ${MAX_TOOLS} by call count are drawn`,
        });
    for (const name of keptTools)
        add(`tool:${name}`, 'tool', name, {
            weight: toolTotals.get(name),
            measured: `Measured -- ${toolTotals.get(name)} call(s) across the session`,
        });
    // ---- which turns get drawn
    //
    // A turn is drawn when it carries a signal of its own, OR when something else
    // in the graph points at it. The second half is not decoration: `repeated`
    // friction is attached to the REPEATING turn only, so the target of a repeat
    // star earns nothing itself -- and a permission-mode switch is bracketed into
    // a turn that may be otherwise clean. Without these two, every such edge
    // dangles at a node the gate removed.
    const repeatTargets = new Set();
    for (const t of turns) {
        const r = t.derived?.repeatOf;
        if (typeof r === 'number' && r >= 0)
            repeatTargets.add(r);
    }
    const modeHosts = new Set();
    for (const pm of session.permissionModes || []) {
        if (!pm.ts)
            continue;
        const at = Date.parse(pm.ts);
        if (!Number.isFinite(at))
            continue;
        const host = turns.find((t) => {
            const s = t.startedAt ? Date.parse(t.startedAt) : NaN;
            const e = t.endedAt ? Date.parse(t.endedAt) : NaN;
            return Number.isFinite(s) && Number.isFinite(e) && at >= s && at <= e;
        });
        if (host)
            modeHosts.add(host.index);
    }
    const byTools = [...turns].sort((a, b) => (b.toolCallCount || 0) - (a.toolCallCount || 0)).slice(0, 3);
    const anchors = new Set(byTools.map((t) => t.index));
    if (typeof session.score?.costliestTurn === 'number')
        anchors.add(session.score.costliestTurn);
    const carries = (t) => (t.friction || []).length > 0 ||
        (typeof t.derived?.repeatOf === 'number' && t.derived.repeatOf !== null) ||
        (t.interruptions || 0) > 0 ||
        Boolean(t.steering) ||
        (t.slashCommands || []).length > 0 ||
        (t.subagents || []).length > 0;
    const drawn = turns.filter((t) => carries(t) || anchors.has(t.index) || repeatTargets.has(t.index) || modeHosts.has(t.index));
    const drawnIdx = new Set(drawn.map((t) => t.index));
    if (turns.length > drawn.length)
        suppressed.push({
            what: 'turns', dropped: turns.length - drawn.length, of: turns.length,
            why: 'they carried no friction, repeat, interruption, steering, slash command or subagent, and nothing else pointed at them',
        });
    for (const t of drawn) {
        const id = add(`turn:${t.index}`, 'turn', `turn ${t.index}`, {
            weight: t.toolCallCount,
            turns: [t.index],
            measured: `Measured -- turn ${t.index}: ${t.toolCallCount ?? 0} tool call(s)`,
        });
        link(sessionNode, id, 'turn of');
        for (const c of t.toolCalls || [])
            if (keptTools.has(c.name))
                link(id, `tool:${c.name}`, `called x${c.count}`, { weight: c.count });
        // The one artifact recoverable per turn, parsed with the upstream
        // expression so the graph cannot disagree with artifacts.mcp.
        for (const c of t.toolCalls || []) {
            const server = c.name.startsWith('mcp__') ? c.name.split('__')[1] : null;
            if (server && nodes.has(`mcp:${server}`))
                link(id, `mcp:${server}`, 'called a tool on');
        }
        if (t.model && nodes.has(`model:${t.model}`))
            link(id, `model:${t.model}`, t.mixedModel ? 'plurality model (mixed)' : 'plurality model');
        for (const f of t.friction || [])
            link(id, add(`friction:${f}`, 'friction', f, { measured: `Measured -- turn friction "${f}"` }), 'showed');
        const r = t.derived?.repeatOf;
        if (typeof r === 'number' && drawnIdx.has(r))
            link(id, `turn:${r}`, 'repeats', { dashed: true });
        // A slash record does not open a turn, so it attaches to the PRECEDING
        // human turn. The rel string has to say so, or the edge reads as a claim
        // that this turn ran the command.
        for (const cmd of t.slashCommands || [])
            if (nodes.has(`slash:${cmd}`))
                link(id, `slash:${cmd}`, 'issued while this turn was open');
        if (modeHosts.has(t.index))
            for (const pm of session.permissionModes || [])
                if (pm.mode && nodes.has(`mode:${pm.mode}`))
                    link(id, `mode:${pm.mode}`, 'switched here');
    }
    // ---- tool co-occurrence: the densest relation, so gated hard
    const pair = new Map();
    for (const t of turns) {
        const names = (t.toolCalls || []).map((c) => c.name).filter((n) => keptTools.has(n)).sort();
        for (let i = 0; i < names.length; i++)
            for (let j = i + 1; j < names.length; j++) {
                const key = `${names[i]} ${names[j]}`;
                pair.set(key, (pair.get(key) || 0) + 1);
            }
    }
    const cooc = [...pair.entries()].filter(([, n]) => n >= COOCCUR_MIN).sort((a, b) => b[1] - a[1]);
    for (const [key, n] of cooc.slice(0, MAX_COOCCUR)) {
        const [a, b] = key.split(' ');
        edges.push({
            source: `tool:${a}`, target: `tool:${b}`, rel: `co-occur in ${n} turns`,
            layer: 'derived', weight: n, dashed: true,
        });
    }
    if (cooc.length > MAX_COOCCUR)
        suppressed.push({
            what: 'tool co-occurrences', dropped: cooc.length - MAX_COOCCUR, of: cooc.length,
            why: `capped at ${MAX_COOCCUR}`,
        });
    // ---- global edge cap. Layout is O(n^2) per iteration.
    let kept = edges;
    if (edges.length > MAX_EDGES) {
        kept = edges.slice(0, MAX_EDGES);
        suppressed.push({ what: 'edges', dropped: edges.length - MAX_EDGES, of: edges.length, why: `capped at ${MAX_EDGES}` });
    }
    // Drop any edge whose endpoints are not both present, then count degree.
    const present = new Set(nodes.keys());
    const final = kept.filter((e) => present.has(e.source) && present.has(e.target));
    for (const e of final) {
        nodes.get(e.source).degree++;
        nodes.get(e.target).degree++;
    }
    return { nodes: [...nodes.values()], edges: final, suppressed };
}
/** Closed, and disjoint from every derived kind, so an authored node cannot
 *  claim to be a repo, a harness, a model or a tool. */
export const AUTHORED_GROUPS = ['decision', 'defect', 'guard', 'thread', 'subsystem', 'question'];
const MAX_CONCEPTS = 60;
const MAX_RELATIONS = 120;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function mergeAuthored(derived, graph, turnCount) {
    const nodes = [...derived.nodes];
    const edges = [...derived.edges];
    const dropped = [];
    if (!graph)
        return { nodes, edges, dropped };
    const derivedIds = new Set(derived.nodes.map((n) => n.id));
    const concepts = graph.concepts || [];
    const relations = graph.relations || [];
    const byId = new Map(); // authored id -> namespaced id
    let badId = 0;
    let badGroup = 0;
    let badTurn = 0;
    let badAnchor = 0;
    for (const c of concepts.slice(0, MAX_CONCEPTS)) {
        const raw = String(c.id ?? '');
        if (!ID_RE.test(raw) || !c.label) {
            badId++;
            continue;
        }
        // Namespaced before anything else. This is the separation -- not the CSS.
        const id = `concept:${raw}`;
        if (derivedIds.has(id) || byId.has(raw)) {
            badId++;
            continue;
        }
        const group = AUTHORED_GROUPS.includes(String(c.group)) ? String(c.group) : 'concept';
        if (c.group && group === 'concept')
            badGroup++;
        const turns = (c.turns || []).filter((t) => Number.isInteger(t) && t >= 0 && t < turnCount);
        badTurn += (c.turns || []).length - turns.length;
        byId.set(raw, id);
        nodes.push({
            id,
            kind: group,
            label: String(c.label).slice(0, 60),
            degree: 0,
            layer: 'authored',
            note: c.note ? String(c.note).slice(0, 400) : undefined,
            turns: turns.length ? turns : undefined,
        });
        // Anchors are the ONLY way the authored layer touches the skeleton, and
        // the direction is one-way -- which is what lets the derived graph stand
        // alone when `graph` is absent.
        for (const a of c.anchors || []) {
            if (derivedIds.has(String(a)))
                edges.push({ source: id, target: String(a), rel: 'anchored to', layer: 'authored', dashed: true });
            else
                badAnchor++;
        }
    }
    if (concepts.length > MAX_CONCEPTS)
        dropped.push({ what: 'concepts', dropped: concepts.length - MAX_CONCEPTS, of: concepts.length, why: `capped at ${MAX_CONCEPTS}` });
    if (badId)
        dropped.push({ what: 'concepts', dropped: badId, of: concepts.length, why: 'missing or malformed id, missing label, or a duplicate' });
    if (badGroup)
        dropped.push({ what: 'concept groups', dropped: badGroup, of: concepts.length, why: `not one of ${AUTHORED_GROUPS.join(', ')} -- shown as "concept"` });
    if (badTurn)
        dropped.push({ what: 'concept turn refs', dropped: badTurn, of: badTurn, why: 'out of range for this session' });
    if (badAnchor)
        dropped.push({ what: 'anchors', dropped: badAnchor, of: badAnchor, why: 'named a node that is not in the derived graph' });
    let badEnd = 0;
    const resolve = (v) => {
        const s = String(v ?? '');
        if (byId.has(s))
            return byId.get(s);
        if (derivedIds.has(s))
            return s;
        return null;
    };
    for (const r of relations.slice(0, MAX_RELATIONS)) {
        const from = resolve(r.from);
        const to = resolve(r.to);
        if (!from || !to || from === to) {
            badEnd++;
            continue;
        }
        edges.push({
            source: from,
            target: to,
            layer: 'authored',
            dashed: r.dashed !== false,
            rel: r.label ? String(r.label).slice(0, 40) : undefined,
        });
    }
    if (relations.length > MAX_RELATIONS)
        dropped.push({ what: 'relations', dropped: relations.length - MAX_RELATIONS, of: relations.length, why: `capped at ${MAX_RELATIONS}` });
    if (badEnd)
        dropped.push({ what: 'relations', dropped: badEnd, of: relations.length, why: 'an endpoint resolved to nothing' });
    const index = new Map(nodes.map((n) => [n.id, n]));
    for (const n of nodes)
        n.degree = 0;
    const live = edges.filter((e) => index.has(e.source) && index.has(e.target));
    for (const e of live) {
        index.get(e.source).degree++;
        index.get(e.target).degree++;
    }
    return { nodes, edges: live, dropped };
}
