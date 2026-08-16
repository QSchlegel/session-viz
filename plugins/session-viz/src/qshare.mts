#!/usr/bin/env node
// Choose what your team can see. Nothing is shared by default.
//
//   node qshare.mjs                          # what exists locally, what is shared
//   node qshare.mjs --review project <name>  # the literal bytes that would leave
//   node qshare.mjs --share  project <name>  # send it, after you have reviewed it
//   node qshare.mjs --revoke <id>            # delete it from the workspace
//
// The local analysis is richer than people expect. It carries absolute paths
// including your home directory and username, and verbatim excerpts of what you
// typed — 67 paths and 103 text fields on the corpus this was written against.
// So this does two things before anything leaves:
//
//   1. Strips the machine-local parts nobody else can use. An absolute path
//      becomes a repo name. Your username is not analysis, it is incidental.
//   2. Refuses to send an item you have not reviewed. --share prints a summary
//      of what is in the payload and requires --yes, so the first time anyone
//      shares a session they see that prompt text is in it.
//
// A share lands in plane B — identity-bearing, tenant-scoped. It never touches
// the person-blind telemetry, and it cannot: that schema has no field for a
// repo name.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { loadConfig } from './home.mjs'
import { emitJson } from './out.mjs'

const run = promisify(execFile)

interface Config { url: string; token: string; actor?: string }

function config(): Config {
  const env = process.env.SESSION_VIZ_TOKEN
  // Resolved by home.mts rather than hardcoded, so this finds the token
  // wherever /qsetup was able to put it — which under a sandboxed harness is
  // not necessarily the preferred location.
  const file: Partial<Config> = loadConfig<Config>() || {}
  const url = process.env.SESSION_VIZ_URL || file.url || 'https://cloud.session-viz.com'
  const token = env || file.token
  if (!token) {
    throw new Error('no token — run /qsetup first, or set SESSION_VIZ_TOKEN')
  }
  const actor = process.env.SESSION_VIZ_ACTOR || file.actor
  return actor ? { url, token, actor } : { url, token }
}

const api = async (cfg: Config, path: string, method = 'GET', body?: unknown): Promise<any> => {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.token}` }
  if (body) headers['content-type'] = 'application/json'
  if (cfg.actor) headers['x-actor'] = cfg.actor
  const r = await fetch(cfg.url.replace(/\/$/, '') + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((j as { error?: string }).error || `HTTP ${r.status}`)
  return j
}

// ---------------------------------------------------------------- redaction

const HOME = homedir()

/**
 * Machine-local detail that is not analysis. A colleague gains nothing from
 * knowing the reader's home directory, and a path is the easiest way to leak a
 * username, a client name in a parent folder, or the shape of someone's disk.
 * Repo NAMES survive — that was the explicit choice — but the route to them
 * does not.
 */
const HOME_RE = new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')

function stripPaths<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      // Every occurrence, not just a leading one. The first version tested
      // `startsWith`, which is right for a `cwd` field and wrong for the thing
      // we actually chose to share: prompt text quoting an absolute path keeps
      // the username in the middle of a sentence. The tool's own review counted
      // one survivor on the first real payload.
      return v.replace(HOME_RE, '~')
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // `cwd` is an absolute path whose only useful part is the last segment,
        // and the object already carries that as `name`.
        if (k === 'cwd' && typeof x === 'string') { out[k] = x.split('/').filter(Boolean).pop() || x; continue }
        out[k] = walk(x)
      }
      return out
    }
    return v
  }
  return walk(value) as T
}

/** Counts the things a person should be told are in a payload before it leaves. */
export function describe(payload: unknown): { bytes: number; textFields: number; homePaths: number; keys: string[] } {
  const body = JSON.stringify(payload ?? null)
  const textFields = (body.match(/"text":/g) || []).length
  const homePaths = (body.match(new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload as Record<string, unknown>) : []
  return { bytes: body.length, textFields, homePaths, keys }
}

// ---------------------------------------------------------------- corpus

interface CorpusProject { name: string; cwd?: string; sessions: number; turns: number; [k: string]: unknown }
interface CorpusModel {
  projects: CorpusProject[]
  exemplars?: { best?: Array<Record<string, unknown>>; worst?: Array<Record<string, unknown>> }
  incidents?: Array<Record<string, unknown>>
  totals?: unknown
  meta?: unknown
}

async function corpus(): Promise<CorpusModel> {
  const here = new URL('.', import.meta.url).pathname
  const { stdout } = await run('node', [join(here, 'corpus.mjs'), '--json'], { maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(stdout) as CorpusModel
}

/**
 * Everything the local report shows for one project, minus the machine paths.
 *
 * A project is named by its basename, so two different checkouts can answer to
 * one name — `~/git/multisig` and `~/git/multisig-deployment/multisig`, and
 * three more such pairs in this corpus. `.find()` returned whichever came first
 * and discarded the rest silently, which is the worst available behaviour for a
 * command whose whole job is publishing verbatim prompt text: you would be
 * sharing a repository you did not choose, with nothing to notice it by.
 *
 * An ambiguous name is refused and every candidate printed. The full path
 * disambiguates, because it is the thing that actually differs.
 */
function projectPayload(m: CorpusModel, name: string): unknown {
  const hits = m.projects.filter((x) => x.name === name || String(x['cwd'] ?? '') === name)
  if (!hits.length) throw new Error(`no project called ${name} — run without arguments to list them`)
  if (hits.length > 1) {
    const lines = hits.map((h) => `    ${String(h['cwd'] ?? '(no path)')}  — ${h['sessions'] ?? '?'} sessions`)
    throw new Error(
      `"${name}" names ${hits.length} different checkouts, and sharing one publishes what you\n` +
      `  typed in it — so this will not guess. Pass the path instead:\n\n${lines.join('\n')}\n`)
  }
  const p = hits[0]!
  const ids = new Set((p['sessionIds'] as string[] | undefined) || [])
  // Session id only, never the project name. Name-matching collected rows
  // belonging to the OTHER checkout of the same name, so a share of one repo
  // carried incidents — and their prompt text — from a different one.
  const mine = (rows?: Array<Record<string, unknown>>) =>
    (rows || []).filter((r) => ids.has(String(r['sessionId'] ?? '')))
  return stripPaths({
    kind: 'project',
    project: p,
    incidents: mine(m.incidents),
    exemplars: {
      best: mine(m.exemplars?.best),
      worst: mine(m.exemplars?.worst),
    },
    sharedAt: new Date().toISOString(),
  })
}

function sessionPayload(m: CorpusModel, id: string): unknown {
  const match = (r: Record<string, unknown>) => String(r['sessionId'] ?? '').startsWith(id)
  const all = [...(m.exemplars?.best || []), ...(m.exemplars?.worst || [])]
  const digest = all.find(match)
  const incidents = (m.incidents || []).filter(match)
  if (!digest && !incidents.length) throw new Error(`no session starting ${id} in the corpus`)
  return stripPaths({ kind: 'session', session: digest ?? null, incidents, sharedAt: new Date().toISOString() })
}

async function runPayload(ref: string): Promise<unknown> {
  const here = new URL('.', import.meta.url).pathname
  const { stdout } = await run('node', [join(here, 'runs.mjs'), '--json'], { maxBuffer: 64 * 1024 * 1024 })
  const ledger = JSON.parse(stdout) as { runs?: Array<Record<string, unknown>>; families?: unknown; tasks?: unknown }
  const runs = (ledger.runs || []).filter(
    (r) => String(r['task'] ?? '') === ref || String(r['id'] ?? '').startsWith(ref),
  )
  if (!runs.length) throw new Error(`no run or task class matching ${ref}`)
  return stripPaths({ kind: 'run', ref, runs, sharedAt: new Date().toISOString() })
}

async function payloadFor(kind: string, ref: string): Promise<unknown> {
  if (kind === 'run') return runPayload(ref)
  const m = await corpus()
  if (kind === 'project') return projectPayload(m, ref)
  if (kind === 'session') return sessionPayload(m, ref)
  throw new Error('kind must be project, session or run')
}

// ---------------------------------------------------------------- picker

/**
 * The visual picker: a local page listing every project with the numbers that
 * decide whether sharing it is a good idea.
 *
 * A terminal table cannot show the thing that actually matters. "45 fields of
 * verbatim prompt text" is the sentence a person needs before publishing a
 * project to colleagues, and computing it means building each payload — too
 * slow to print on the way to a list, and too easy to skip when it is one line
 * among twenty.
 *
 * So the page carries it per row, sorts by it, and selects nothing on open. The
 * ambiguous names that --share refuses appear as separate rows with their
 * paths, which is the one place those paths are safe: this page is served from
 * 127.0.0.1 to a browser on the same machine, and its contents never leave it.
 */
interface PickRow {
  ref: string
  name: string
  cwd: string
  sessions: number
  turns: number
  bytes: number
  textFields: number
  ambiguous: boolean
  /** Which harnesses produced these sessions, most sessions first. */
  harnesses: Array<[string, number]>
}

async function pickRows(m: CorpusModel): Promise<PickRow[]> {
  const byName = new Map<string, number>()
  for (const p of m.projects) byName.set(p.name, (byName.get(p.name) || 0) + 1)

  const rows: PickRow[] = []
  for (const p of m.projects) {
    if (!p.name) continue
    const ambiguous = (byName.get(p.name) || 0) > 1
    // An ambiguous project is addressed by path, exactly as --share demands, so
    // the picker hands back a ref that already works.
    const ref = ambiguous ? String(p['cwd'] ?? p.name) : p.name
    let bytes = 0, textFields = 0
    try {
      // projectPayload against the corpus already in hand, NOT payloadFor —
      // which rebuilds the corpus on every call. Sixty projects meant sixty
      // full corpus runs at about a minute each, so the picker was an hour from
      // opening and looked simply hung.
      const d = describe(projectPayload(m, ref))
      bytes = d.bytes; textFields = d.textFields
    } catch { /* a project whose payload will not build is shown with zeros */ }
    // Already on every project as a per-harness session count. Shown because a
    // project is rarely one harness — the busiest here is 205 Cursor sessions
    // beside 11 Claude Code and 9 Codex — and "which agent produced this" is
    // part of deciding whether a colleague should read it.
    const harnesses = Object.entries((p['harnesses'] as Record<string, number>) || {})
      .map(([k, v]) => [k, Number(v) || 0] as [string, number])
      .sort((a, b) => b[1] - a[1])
    rows.push({
      ref, name: p.name, cwd: String(p['cwd'] ?? ''),
      sessions: Number(p.sessions || 0), turns: Number(p.turns || 0),
      bytes, textFields, ambiguous, harnesses,
    })
  }
  // Most prompt text first: the rows that most need a decision should be met
  // before the reader's attention runs out.
  return rows.sort((a, b) => b.textFields - a.textFields || b.turns - a.turns)
}

const esc = (s: unknown): string => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** How each harness is written for a person. Unknown ids pass through as-is,
 *  so a harness added later shows up rather than disappearing. */
const HARNESS_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

function pickerPage(rows: PickRow[], nonce: string, shared: Set<string>): string {
  const n = (x: number): string => x.toLocaleString('en-GB')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Choose what to share — session-viz</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#e6e2db;--accent:#c2521a;
--warn:#9a6a12;--ok:#2f6b46;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#16151a;--panel:#1e1d23;--ink:#ece9e4;--muted:#9b968d;
--line:#302e37;--accent:#ff8a4c;--warn:#e0b055;--ok:#6fbf8e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:36px 22px 120px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}
.lede{color:var(--muted);margin:0 0 26px;max-width:64ch}
table{border-collapse:collapse;width:100%;font-size:14px}
th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
padding:0 10px 8px;font-weight:600;border-bottom:1px solid var(--line)}
th.num,td.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
td{padding:11px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:hover td{background:var(--panel)}
.nm{font-weight:600}
.pth{display:block;font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:2px;word-break:break-all}
.amb{display:inline-block;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--warn);
border:1px solid var(--warn);border-radius:999px;padding:0 6px;margin-left:6px;vertical-align:1px}
.txt{color:var(--accent);font-weight:600}
/* One chip per harness, with its session count. Colour distinguishes them at a
   glance; the label carries the meaning, so it still reads without colour. */
.hz{display:inline-flex;align-items:center;gap:5px;font-size:11px;border-radius:999px;
padding:1px 8px;margin:0 4px 3px 0;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.hz i{font-style:normal;font-family:var(--mono);font-size:10.5px;opacity:.75}
.h-claude-code{border-color:#c2521a;color:#c2521a}
.h-codex{border-color:#4a7fb5;color:#4a7fb5}
.h-cursor{border-color:#5f8a6d;color:#5f8a6d}
@media(prefers-color-scheme:dark){
.h-claude-code{border-color:#ff8a4c;color:#ff8a4c}
.h-codex{border-color:#6a9fd4;color:#6a9fd4}
.h-cursor{border-color:#4c8a63;color:#8fbc6b}}
.done{color:var(--ok);font-size:12px}
input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent);cursor:pointer}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--panel);border-top:1px solid var(--line);
padding:14px 22px;display:flex;gap:16px;align-items:center;justify-content:center;flex-wrap:wrap}
.sum{font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums}
button{appearance:none;border:0;border-radius:9px;background:var(--accent);color:#fff;font:inherit;
font-weight:600;padding:10px 20px;cursor:pointer}
button:disabled{opacity:.4;cursor:not-allowed}
.warn{background:var(--panel);border:1px solid var(--warn);border-radius:10px;padding:13px 16px;
margin:0 0 24px;font-size:13.5px;color:var(--muted)}
.warn b{color:var(--ink)}
#msg{padding:13px 16px;border-radius:10px;margin:0 0 20px;display:none;font-size:14px;
background:var(--panel);border:1px solid var(--line)}
</style></head><body><div class="wrap">
<h1>Choose what to share</h1>
<p class="lede">Each of these publishes to your workspace, readable by everyone in it.
Nothing is selected, and nothing is sent until you press the button.</p>

<div class="warn"><b>Prompt text is the number to read.</b> It counts fields carrying what
you literally typed. Absolute paths and your username are stripped before anything leaves
— the paths below are shown because this page is served from your own machine and never
leaves it.</div>

<div id="msg"></div>

<table><thead><tr>
<th style="width:34px"><input type="checkbox" id="all" title="Select all"></th><th>Project</th>
<th>Source</th>
<th class="num">Sessions</th><th class="num">Turns</th>
<th class="num">Prompt text</th><th class="num">Size</th>
</tr></thead><tbody>
${rows.map((r, i) => `<tr>
<td>${shared.has(r.ref) ? '<span class="done">shared</span>' : `<input type="checkbox" id="c${i}" data-ref="${esc(r.ref)}" data-text="${r.textFields}">`}</td>
<td><label for="c${i}"><span class="nm">${esc(r.name)}</span>${r.ambiguous ? '<span class="amb">two checkouts</span>' : ''}</label>
${r.ambiguous && r.cwd ? `<span class="pth">${esc(r.cwd)}</span>` : ''}</td>
<td>${r.harnesses.length
  ? r.harnesses.map(([h, c]) => `<span class="hz h-${esc(h)}">${esc(HARNESS_LABEL[h] || h)}<i>${n(c)}</i></span>`).join('')
  : '<span class="pth">—</span>'}</td>
<td class="num">${n(r.sessions)}</td>
<td class="num">${n(r.turns)}</td>
<td class="num txt">${n(r.textFields)}</td>
<td class="num">${n(Math.round(r.bytes / 1024))} kB</td>
</tr>`).join('')}
</tbody></table>
</div>
<div class="bar">
  <span class="sum" id="sum">Nothing selected</span>
  <button id="go" disabled>Share selected</button>
</div>
<script>
// The header box is excluded by [data-ref] — it selects rows, it is not one.
const boxes=[...document.querySelectorAll('input[type=checkbox][data-ref]')];
const all=document.getElementById('all');
const sum=document.getElementById('sum'), go=document.getElementById('go'), msg=document.getElementById('msg');
// textContent throughout. Nothing here is untrusted today, but a page that
// assembles markup from data is a page that will do it with untrusted data
// later, and this one renders project names.
function tally(){
  const on=boxes.filter(b=>b.checked);
  const t=on.reduce((a,b)=>a+ +b.dataset.text,0);
  go.disabled=!on.length;
  // Indeterminate when the selection is partial, so "select all" reports the
  // state it is in rather than only the state it would move to.
  all.checked = on.length===boxes.length && boxes.length>0;
  all.indeterminate = on.length>0 && on.length<boxes.length;
  sum.textContent=on.length
    ? on.length+' selected · '+t.toLocaleString('en-GB')+' fields of prompt text'
    : 'Nothing selected';
}
boxes.forEach(b=>b.addEventListener('change',tally));
all.addEventListener('change',()=>{
  // Selecting everything here means publishing every project on the machine,
  // so it warns on the way in rather than only at the button. Turning it OFF
  // asks nothing — clearing a selection needs no defending.
  if(all.checked){
    const t=boxes.reduce((a,b)=>a+ +b.dataset.text,0);
    // Double-escaped, like the confirm below it. A single \\n is consumed by the
    // TEMPLATE LITERAL this page is built from, so it emits a real newline into
    // the middle of a JS string — a syntax error that kills the whole script,
    // taking the working parts down with it. The page still rendered, and every
    // checkbox silently did nothing.
    if(!confirm('Select all '+boxes.length+' projects?\\n\\nThat is '+t.toLocaleString('en-GB')+
      ' fields of verbatim prompt text across every project on this machine.\\n\\n'+
      'You will still be asked once more before anything is sent.')){
      all.checked=false; return;
    }
  }
  boxes.forEach(b=>{ b.checked=all.checked });
  tally();
});
go.addEventListener('click',async()=>{
  const on=boxes.filter(b=>b.checked);
  const refs=on.map(b=>b.dataset.ref);
  const t=on.reduce((a,b)=>a+ +b.dataset.text,0);
  if(!confirm('Share '+refs.length+' project(s)?\\n\\n'+t.toLocaleString('en-GB')+
    ' fields of verbatim prompt text will be readable by everyone in your workspace.\\n\\n'+
    'A share can be revoked, but what a colleague has already read cannot be recalled.')) return;
  go.disabled=true; go.textContent='Sharing…';
  let out;
  try{
    const r=await fetch('/share?nonce=${nonce}',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({refs})});
    out=await r.json();
    if(!r.ok) throw new Error(out.error||'refused');
    msg.style.borderColor='var(--ok)';
    msg.textContent='Shared '+out.shared+' — you can close this tab.';
    go.textContent='Done';
  }catch(e){
    msg.style.borderColor='var(--accent)';
    msg.textContent=(e&&e.message)||'the local helper did not answer';
    go.disabled=false; go.textContent='Share selected';
  }
  msg.style.display='block';
});
</script></body></html>`
}

// ---------------------------------------------------------------- cli

/**
 * Serve the picker on loopback and perform whatever it sends back.
 *
 * The same shape qsetup already uses for its OAuth callback: bound to 127.0.0.1
 * only, on a port the kernel picks, a nonce required and compared in constant
 * time, shut down after the exchange, abandoned after ten minutes.
 *
 * The nonce is doing real work here, not ceremony. This process holds a
 * collab-scoped token, and the endpoint it exposes publishes with it — so any
 * page in any tab could POST to a guessable loopback port and share on the
 * user's behalf without them seeing anything. The nonce is only ever printed
 * into the page this process served.
 */
async function runPicker(cfg: Config): Promise<void> {
  const http = await import('node:http')
  const crypto = await import('node:crypto')

  // Built once, here, and reused for both the counts and every share the page
  // asks for. It is the expensive step by a wide margin.
  console.log('  reading the corpus and counting what each project carries …')
  const model = await corpus()
  const rows = await pickRows(model)
  const existing = await api(cfg, '/v1/shares', 'GET')
  const shared = new Set<string>(((existing.shares as Array<{ ref?: string }>) || []).map((s) => String(s.ref ?? '')))

  const nonce = crypto.randomBytes(18).toString('base64url')
  const constEq = (a: string, b: string): boolean => {
    const x = Buffer.from(a), y = Buffer.from(b)
    return x.length === y.length && crypto.timingSafeEqual(x, y)
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => { if (settled) return; settled = true; server.close(); resolve() }

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url || '/', 'http://127.0.0.1')
      const send = (code: number, type: string, body: string): void => {
        res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
        res.end(body)
      }
      if (req.method === 'GET' && u.pathname === '/') {
        return send(200, 'text/html; charset=utf-8', pickerPage(rows, nonce, shared))
      }
      if (req.method !== 'POST' || u.pathname !== '/share') return send(404, 'text/plain', 'not here')
      if (!constEq(u.searchParams.get('nonce') || '', nonce)) {
        console.log('\n  refused a request whose nonce did not match — nothing was shared')
        return send(403, 'application/json', JSON.stringify({ error: 'nonce did not match' }))
      }
      let body: { refs?: unknown }
      try {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { refs?: unknown }
      } catch { return send(400, 'application/json', JSON.stringify({ error: 'unreadable request' })) }

      const refs = (Array.isArray(body.refs) ? body.refs : []).map(String).filter(Boolean)
      if (!refs.length) return send(400, 'application/json', JSON.stringify({ error: 'nothing selected' }))

      const done: string[] = []
      try {
        for (const ref of refs) {
          // Same model the page was built from, so what is published is exactly
          // what the counts on screen described — and a corpus that changed
          // mid-session cannot silently alter what leaves.
          const payload = projectPayload(model, ref)
          const out = await api(cfg, '/v1/share', 'POST', { kind: 'project', ref, label: ref.split('/').pop() || ref, payload })
          const d = describe(payload)
          console.log(`  shared ${out.id}  ${ref.split('/').pop()}  ${d.textFields} prompt-text field(s)`)
          done.push(String(out.id))
        }
      } catch (e) {
        // Partial success is reported as such. Saying "failed" after three of
        // five went out would leave somebody believing nothing was published.
        const msg = `${(e as Error).message}${done.length ? ` — ${done.length} already went out` : ''}`
        console.log(`\n  stopped: ${msg}`)
        send(500, 'application/json', JSON.stringify({ error: msg }))
        return finish()
      }
      send(200, 'application/json', JSON.stringify({ shared: done.length, ids: done }))
      console.log(`\n  ${done.length} shared. Revoke any of them with:  qshare.mjs --revoke <id>`)
      console.log('  A row can be deleted. What a colleague already read cannot be recalled.')
      finish()
    })

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      const link = `http://127.0.0.1:${port}/`
      console.log(`\n  opening ${link}`)
      console.log('  nothing is selected, and nothing is sent until you press the button')
      openBrowser(link)
    })
    // Abandoned rather than left listening. An open port that publishes on
    // request should not outlive the person's attention.
    setTimeout(() => { if (!settled) { console.log('\n  timed out after 10 minutes — nothing was shared'); finish() } }, 10 * 60_000).unref()
  })
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    // spawn, never a shell string: the URL carries a nonce.
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref()
  } catch {
    console.log('  (could not open a browser — visit the address above)')
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('qshare.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (n: string) => argv.indexOf(n)
  const yes = argv.includes('--yes')

  try {
    const cfg = config()

    if (argv.includes('--pick')) {
      await runPicker(cfg)
      process.exit(0)
    }

    const rev = flag('--revoke')
    if (rev >= 0) {
      const id = argv[rev + 1]
      if (!id) throw new Error('--revoke needs a share id (see the list)')
      await api(cfg, '/v1/share/revoke', 'POST', { id })
      console.log(`revoked ${id}`)
      console.log('The row is deleted, not hidden. What a colleague already read cannot be recalled.')
      process.exit(0)
    }

    const review = flag('--review')
    const share = flag('--share')
    const act = review >= 0 ? review : share
    if (act >= 0) {
      const kind = argv[act + 1] || ''
      const ref = argv[act + 2] || ''
      if (!kind || !ref) throw new Error(`usage: --${review >= 0 ? 'review' : 'share'} <project|session|run> <name>`)
      const payload = await payloadFor(kind, ref)
      const d = describe(payload)

      console.log(`\n${kind} ${ref}`)
      console.log(`  ${d.bytes.toLocaleString('en-GB')} bytes · sections: ${d.keys.join(', ')}`)
      console.log(`  ${d.textFields} field(s) carrying verbatim prompt text`)
      console.log(`  ${d.homePaths} absolute home path(s) — ${d.homePaths === 0 ? 'stripped' : 'STILL PRESENT, this is a bug'}`)

      if (review >= 0) {
        console.log('\n--- the literal payload ---')
        await emitJson(payload)
        console.log('\nShare it with:  qshare.mjs --share ' + kind + ' ' + ref + ' --yes')
        process.exit(0)
      }
      if (!yes) {
        console.log('\nThis will be readable by everyone in your workspace, including the')
        console.log('prompt text above. Review it first:')
        console.log(`  qshare.mjs --review ${kind} ${ref}`)
        console.log(`Then re-run with --yes.`)
        process.exit(1)
      }
      const label = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : ref
      const out = await api(cfg, '/v1/share', 'POST', { kind, ref, label, payload })
      console.log(`\nshared as ${out.id} (${out.bytes.toLocaleString('en-GB')} bytes)`)
      console.log(`Revoke with: qshare.mjs --revoke ${out.id}`)
      process.exit(0)
    }

    // Default: what exists locally, and what of it is already shared.
    const [m, remote] = await Promise.all([corpus(), api(cfg, '/v1/shares')])
    const shared = new Map<string, { id: string; bytes: number; sharedBy: string }>()
    for (const s of remote.shares || []) shared.set(`${s.kind}|${s.ref}`, s)

    console.log(`workspace ${cfg.url}`)
    console.log(`${remote.shares?.length || 0} item(s) shared with your team\n`)
    console.log('  SHARED  PROJECT                    SESSIONS  TURNS   ')
    for (const p of m.projects.slice(0, 20)) {
      const hit = shared.get(`project|${p.name}`)
      console.log(`  ${hit ? '  ✓   ' : '  —   '}  ${p.name.padEnd(26)} ${String(p.sessions).padStart(8)} ${String(p.turns).padStart(6)}`)
    }
    if (remote.shares?.length) {
      console.log('\n  shared already:')
      for (const s of remote.shares) {
        console.log(`    ${s.id}  ${s.kind}/${s.ref} — ${(s.bytes / 1024).toFixed(1)} KB by ${s.sharedBy}`)
      }
    }
    console.log('\n  Nothing is shared unless you say so. Review before you send:')
    console.log('    qshare.mjs --review project <name>')
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
  }
}
