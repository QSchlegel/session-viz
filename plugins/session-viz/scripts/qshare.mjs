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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from './home.mjs';
import { emitJson } from './out.mjs';
const run = promisify(execFile);
function config() {
    const env = process.env.SESSION_VIZ_TOKEN;
    // Resolved by home.mts rather than hardcoded, so this finds the token
    // wherever /qsetup was able to put it — which under a sandboxed harness is
    // not necessarily the preferred location.
    const file = loadConfig() || {};
    const url = process.env.SESSION_VIZ_URL || file.url || 'https://cloud.session-viz.com';
    const token = env || file.token;
    if (!token) {
        throw new Error('no token — run /qsetup first, or set SESSION_VIZ_TOKEN');
    }
    const actor = process.env.SESSION_VIZ_ACTOR || file.actor;
    return actor ? { url, token, actor } : { url, token };
}
const api = async (cfg, path, method = 'GET', body) => {
    const headers = { authorization: `Bearer ${cfg.token}` };
    if (body)
        headers['content-type'] = 'application/json';
    if (cfg.actor)
        headers['x-actor'] = cfg.actor;
    const r = await fetch(cfg.url.replace(/\/$/, '') + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok)
        throw new Error(j.error || `HTTP ${r.status}`);
    return j;
};
// ---------------------------------------------------------------- redaction
const HOME = homedir();
/**
 * Machine-local detail that is not analysis. A colleague gains nothing from
 * knowing the reader's home directory, and a path is the easiest way to leak a
 * username, a client name in a parent folder, or the shape of someone's disk.
 * Repo NAMES survive — that was the explicit choice — but the route to them
 * does not.
 */
const HOME_RE = new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
function stripPaths(value) {
    const walk = (v) => {
        if (typeof v === 'string') {
            // Every occurrence, not just a leading one. The first version tested
            // `startsWith`, which is right for a `cwd` field and wrong for the thing
            // we actually chose to share: prompt text quoting an absolute path keeps
            // the username in the middle of a sentence. The tool's own review counted
            // one survivor on the first real payload.
            return v.replace(HOME_RE, '~');
        }
        if (Array.isArray(v))
            return v.map(walk);
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, x] of Object.entries(v)) {
                // `cwd` is an absolute path whose only useful part is the last segment,
                // and the object already carries that as `name`.
                if (k === 'cwd' && typeof x === 'string') {
                    out[k] = x.split('/').filter(Boolean).pop() || x;
                    continue;
                }
                out[k] = walk(x);
            }
            return out;
        }
        return v;
    };
    return walk(value);
}
/** Counts the things a person should be told are in a payload before it leaves. */
export function describe(payload) {
    const body = JSON.stringify(payload ?? null);
    const textFields = (body.match(/"text":/g) || []).length;
    const homePaths = (body.match(new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? Object.keys(payload) : [];
    return { bytes: body.length, textFields, homePaths, keys };
}
async function corpus() {
    const here = new URL('.', import.meta.url).pathname;
    const { stdout } = await run('node', [join(here, 'corpus.mjs'), '--json'], { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
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
function projectPayload(m, name) {
    const hits = m.projects.filter((x) => x.name === name || String(x['cwd'] ?? '') === name);
    if (!hits.length)
        throw new Error(`no project called ${name} — run without arguments to list them`);
    if (hits.length > 1) {
        const lines = hits.map((h) => `    ${String(h['cwd'] ?? '(no path)')}  — ${h['sessions'] ?? '?'} sessions`);
        throw new Error(`"${name}" names ${hits.length} different checkouts, and sharing one publishes what you\n` +
            `  typed in it — so this will not guess. Pass the path instead:\n\n${lines.join('\n')}\n`);
    }
    const p = hits[0];
    const ids = new Set(p['sessionIds'] || []);
    // Session id only, never the project name. Name-matching collected rows
    // belonging to the OTHER checkout of the same name, so a share of one repo
    // carried incidents — and their prompt text — from a different one.
    const mine = (rows) => (rows || []).filter((r) => ids.has(String(r['sessionId'] ?? '')));
    return stripPaths({
        kind: 'project',
        project: p,
        incidents: mine(m.incidents),
        exemplars: { worst: mine(m.exemplars?.worst) },
        sharedAt: new Date().toISOString(),
    });
}
function sessionPayload(m, id) {
    const match = (r) => String(r['sessionId'] ?? '').startsWith(id);
    // `m.sessions` is every session; the exemplars are a handful picked for being
    // the worst. Resolving a share against the selection meant that on this
    // corpus 905 of 1108 sessions — 82% — could not be shared at all, and said
    // "no session starting X" as if the id were wrong rather than the lookup.
    const hits = (m.sessions || []).filter(match);
    // Refuse rather than take the first. The pool this searches went from a few
    // hundred exemplars to every session on the machine, which makes a short
    // prefix far likelier to collide — and the payload carries verbatim prompt
    // text, so guessing publishes someone's words from a session they did not
    // name. projectPayload already refuses to choose between two checkouts; a
    // wrong guess costs more here, not less.
    if (hits.length > 1) {
        const lines = hits.slice(0, 8).map((h) => {
            const sid = String(h['sessionId'] ?? '');
            return `    ${sid}  ${String(h['harness'] ?? '?')}  ${h['project'] || '(no project)'}`;
        });
        throw new Error(`${hits.length} sessions start with ${id} — name one exactly:\n${lines.join('\n')}` +
            (hits.length > 8 ? `\n    … and ${hits.length - 8} more` : ''));
    }
    const digest = hits[0] ?? (m.exemplars?.worst || []).find(match);
    const incidents = (m.incidents || []).filter(match);
    if (!digest && !incidents.length)
        throw new Error(`no session starting ${id} in the corpus`);
    return stripPaths({ kind: 'session', session: digest ?? null, incidents, sharedAt: new Date().toISOString() });
}
async function runPayload(ref) {
    const here = new URL('.', import.meta.url).pathname;
    const { stdout } = await run('node', [join(here, 'runs.mjs'), '--json'], { maxBuffer: 64 * 1024 * 1024 });
    const ledger = JSON.parse(stdout);
    const runs = (ledger.runs || []).filter((r) => String(r['task'] ?? '') === ref || String(r['id'] ?? '').startsWith(ref));
    if (!runs.length)
        throw new Error(`no run or task class matching ${ref}`);
    return stripPaths({ kind: 'run', ref, runs, sharedAt: new Date().toISOString() });
}
async function payloadFor(kind, ref) {
    if (kind === 'run')
        return runPayload(ref);
    const m = await corpus();
    if (kind === 'project')
        return projectPayload(m, ref);
    if (kind === 'session')
        return sessionPayload(m, ref);
    throw new Error('kind must be project, session or run');
}
async function pickRows(m) {
    const byName = new Map();
    for (const p of m.projects)
        byName.set(p.name, (byName.get(p.name) || 0) + 1);
    const rows = [];
    for (const p of m.projects) {
        if (!p.name)
            continue;
        const ambiguous = (byName.get(p.name) || 0) > 1;
        // An ambiguous project is addressed by path, exactly as --share demands, so
        // the picker hands back a ref that already works.
        const ref = ambiguous ? String(p['cwd'] ?? p.name) : p.name;
        let bytes = 0, textFields = 0;
        try {
            // projectPayload against the corpus already in hand, NOT payloadFor —
            // which rebuilds the corpus on every call. Sixty projects meant sixty
            // full corpus runs at about a minute each, so the picker was an hour from
            // opening and looked simply hung.
            const d = describe(projectPayload(m, ref));
            bytes = d.bytes;
            textFields = d.textFields;
        }
        catch { /* a project whose payload will not build is shown with zeros */ }
        // Already on every project as a per-harness session count. Shown because a
        // project is rarely one harness — the busiest here is 205 Cursor sessions
        // beside 11 Claude Code and 9 Codex — and "which agent produced this" is
        // part of deciding whether a colleague should read it.
        const harnesses = Object.entries(p['harnesses'] || {})
            .map(([k, v]) => [k, Number(v) || 0])
            .sort((a, b) => b[1] - a[1]);
        rows.push({
            ref, name: p.name, cwd: String(p['cwd'] ?? ''),
            sessions: Number(p.sessions || 0), turns: Number(p.turns || 0),
            bytes, textFields, ambiguous, harnesses,
        });
    }
    // Most prompt text first: the rows that most need a decision should be met
    // before the reader's attention runs out.
    return rows.sort((a, b) => b.textFields - a.textFields || b.turns - a.turns);
}
const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** How each harness is written for a person. Unknown ids pass through as-is,
 *  so a harness added later shows up rather than disappearing. */
const HARNESS_LABEL = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    cursor: 'Cursor',
};
/** Exported so the test can drive the page's own script rather than a copy of
 *  it. A copy is the one thing a test of this must not use: the script lives
 *  inside a template literal, where a stray backtick or a single-escaped `\n`
 *  is a syntax error that kills the whole page — and that has happened twice. */
export function pickerPage(rows, nonce, shared) {
    const n = (x) => x.toLocaleString('en-GB');
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
/* The progress mark is the run wall in miniature — the same cell grid the
   product uses everywhere else, filling left to right as items land. A generic
   spinner would say "something is happening"; this says how much of it. */
#go{display:inline-flex;align-items:center;gap:9px}
.cells rect{fill:currentColor;opacity:.22}
.cells rect.on{opacity:1}
/* Only the cell at the frontier pulses. The settled ones stay settled, because
   a finished item that keeps animating reads as still running. */
.cells rect.at{animation:beat .9s ease-in-out infinite}
@keyframes beat{0%,100%{opacity:1}50%{opacity:.35}}
/* The frontier cell is already distinguished by being the only unfilled one to
   the left of the wall, so dropping the animation loses nothing but the motion
   — which is the whole request. */
@media (prefers-reduced-motion: reduce){ .cells rect.at{animation:none} }
tr.sent td{opacity:.55}
.h-claude-code{border-color:#c2521a;color:#c2521a}
.h-codex{border-color:#4a7fb5;color:#4a7fb5}
.h-cursor{border-color:#5f8a6d;color:#5f8a6d}
@media(prefers-color-scheme:dark){
.h-claude-code{border-color:#ff8a4c;color:#ff8a4c}
.h-codex{border-color:#6a9fd4;color:#6a9fd4}
.h-cursor{border-color:#4c8a63;color:#8fbc6b}}
/* Now a badge beside the project name rather than a cell of its own, so it
   needs the gap the checkbox column used to give it. */
.done{color:var(--ok);font-size:12px;margin-left:7px}
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
<td><input type="checkbox" id="c${i}" data-ref="${esc(r.ref)}" data-text="${r.textFields}"${shared.has(r.ref) ? ' data-shared="1"' : ''}></td>
<td><label for="c${i}"><span class="nm">${esc(r.name)}</span>${shared.has(r.ref) ? '<span class="done">shared</span>' : ''}${r.ambiguous ? '<span class="amb">two checkouts</span>' : ''}</label>
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
  // A refresh and a first publication are counted apart. Re-sending a project
  // that is already up there is a smaller act than exposing a new one, and a
  // single total would hide which of the two somebody is about to do.
  const up=on.filter(b=>b.dataset.shared).length;
  sum.textContent=on.length
    ? on.length+' selected'+(up?' ('+up+' already shared — will refresh)':'')+
      ' · '+t.toLocaleString('en-GB')+' fields of prompt text'
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
  const up=on.filter(b=>b.dataset.shared).length, fresh=refs.length-up;
  if(!confirm('Share '+refs.length+' project(s)?\\n\\n'+
    (up? fresh+' new, '+up+' refreshed in place.\\n\\n' : '')+
    t.toLocaleString('en-GB')+
    ' fields of verbatim prompt text will be readable by everyone in your workspace.\\n\\n'+
    'A share can be revoked, but what a colleague has already read cannot be recalled.')) return;
  go.disabled=true;
  // The mark is the run wall in miniature: one cell per project, filling left
  // to right as each lands. Sized to the selection, so it is a measure and not
  // a decoration — twelve cells for twelve projects, sixty-one for sixty-one.
  const W=4,G=2,cw=refs.length*(W+G)-G;
  go.innerHTML='<svg class="cells" width="'+cw+'" height="11" viewBox="0 0 '+cw+' 11" '+
    'aria-hidden="true">'+refs.map((_,i)=>
      '<rect x="'+(i*(W+G))+'" y="0" width="'+W+'" height="11" rx="1"></rect>').join('')+
    '</svg><span id="lbl">Sharing…</span>';
  const cells=[...go.querySelectorAll('rect')], lbl=document.getElementById('lbl');
  // Rows dim as they go, so the page keeps saying which specific project was
  // published rather than only how many.
  const rowFor=i=>boxes.find(b=>b.dataset.ref===refs[i])?.closest('tr');
  msg.style.display='block'; msg.style.borderColor='var(--line)';
  let shared=0;
  try{
    const r=await fetch('/share?nonce=${nonce}',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({refs})});
    if(!r.ok||!r.body) throw new Error('the local helper refused');
    // NDJSON: read as it arrives. A chunk can split a line and can carry
    // several, so the tail is held back until its newline shows up.
    const rd=r.body.getReader(), dec=new TextDecoder(); let buf='',err=null,ended=false;
    for(;;){
      const {value,done}=await rd.read();
      if(value) buf+=dec.decode(value,{stream:true});
      const lines=buf.split('\\n'); buf=lines.pop()||'';
      for(const line of lines){
        if(!line.trim()) continue;
        let e; try{ e=JSON.parse(line) }catch{ continue }
        if(e.type==='begin'){
          cells[e.i]?.classList.add('at');
          lbl.textContent=e.name+' — '+(e.i+1)+' of '+refs.length;
        }else if(e.type==='done'){
          cells[e.i]?.classList.remove('at'); cells[e.i]?.classList.add('on');
          const tr=rowFor(e.i); if(tr) tr.classList.add('sent');
          shared=e.count;
        }else if(e.type==='end'){ ended=true; shared=e.shared }
        else if(e.type==='error'){ err=e.error; shared=e.shared }
      }
      if(done) break;
    }
    if(err) throw new Error(err);
    // The stream ending is not the same as the work finishing. A closed tab, a
    // killed helper or a dropped socket all end the read cleanly, and without
    // this the page would call that success and tell somebody every project
    // went out. Only the server's own 'end' says it did.
    if(!ended) throw new Error('the helper stopped before it finished');
    msg.style.borderColor='var(--ok)';
    msg.textContent='Shared '+shared+' — you can close this tab.';
    lbl.textContent='Done';
  }catch(e){
    // Whatever landed before the failure stays marked. Clearing the cells would
    // tell somebody nothing was published when some of it was.
    go.querySelectorAll('rect.at').forEach(c=>c.classList.remove('at'));
    // The ones that succeeded are unchecked, because the button now says "share
    // the rest" and rebuilds its list from what is ticked. Leaving them ticked
    // would publish them a second time — the opposite of what the label offers.
    boxes.forEach(b=>{ if(b.closest('tr')?.classList.contains('sent')) b.checked=false });
    tally();
    msg.style.borderColor='var(--accent)';
    msg.textContent=((e&&e.message)||'the local helper did not answer')+
      (shared?' — '+shared+' already went out and can be revoked':'');
    // The label inside the button, not the button itself: writing textContent
    // on the button would replace the cell wall with a string and erase the
    // very record of what landed that the line above promises is kept.
    // (No backticks in here — this whole page is a template literal.)
    lbl.textContent='Share the rest';
  }
});
</script></body></html>`;
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
async function runPicker(cfg) {
    const http = await import('node:http');
    const crypto = await import('node:crypto');
    // Built once, here, and reused for both the counts and every share the page
    // asks for. It is the expensive step by a wide margin.
    console.log('  reading the corpus and counting what each project carries …');
    const model = await corpus();
    const rows = await pickRows(model);
    const existing = await api(cfg, '/v1/shares', 'GET');
    // Filtered by kind, not just ref. The server's key is (tenant, kind, ref), so
    // a session or a run published under a ref that happens to read like a repo
    // name would otherwise mark that project as shared — and, before these rows
    // became re-selectable, lock it out of ever being published.
    const shared = new Set((existing.shares || [])
        .filter((s) => String(s.kind ?? 'project') === 'project')
        .map((s) => String(s.ref ?? '')));
    const nonce = crypto.randomBytes(18).toString('base64url');
    const constEq = (a, b) => {
        const x = Buffer.from(a), y = Buffer.from(b);
        return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (settled)
            return; settled = true; server.close(); resolve(); };
        const server = http.createServer(async (req, res) => {
            const u = new URL(req.url || '/', 'http://127.0.0.1');
            const send = (code, type, body) => {
                res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
                res.end(body);
            };
            if (req.method === 'GET' && u.pathname === '/') {
                return send(200, 'text/html; charset=utf-8', pickerPage(rows, nonce, shared));
            }
            if (req.method !== 'POST' || u.pathname !== '/share')
                return send(404, 'text/plain', 'not here');
            if (!constEq(u.searchParams.get('nonce') || '', nonce)) {
                console.log('\n  refused a request whose nonce did not match — nothing was shared');
                return send(403, 'application/json', JSON.stringify({ error: 'nonce did not match' }));
            }
            let body;
            try {
                const chunks = [];
                for await (const c of req)
                    chunks.push(c);
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            catch {
                return send(400, 'application/json', JSON.stringify({ error: 'unreadable request' }));
            }
            const refs = (Array.isArray(body.refs) ? body.refs : []).map(String).filter(Boolean);
            if (!refs.length)
                return send(400, 'application/json', JSON.stringify({ error: 'nothing selected' }));
            // Streamed as newline-delimited JSON rather than answered once at the end.
            // Sixty-one projects is sixty-one sequential round trips, and a button
            // that says "Sharing…" for that long with nothing behind it is
            // indistinguishable from one that has hung. The server knows exactly
            // which item it is on, so it says so instead of leaving the page to
            // animate a guess.
            res.writeHead(200, {
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-store',
                // Without this the response sits in a buffer until it is large enough
                // to flush, which would deliver every progress line at once, after the
                // work — the exact opposite of the point.
                'x-accel-buffering': 'no',
            });
            // A closed tab is a withdrawn instruction, not a network hiccup. Publishing
            // the rest of somebody's prompt text after they shut the page would be
            // doing the one thing this command exists to ask permission for.
            let gone = false;
            const abandon = () => { gone = true; };
            res.on('close', abandon);
            req.on('aborted', abandon);
            // Writing to a destroyed socket emits 'error' on a response with no
            // listener, which takes the whole helper down — and with it the loop that
            // was about to stop anyway.
            res.on('error', abandon);
            const emit = (o) => { if (!gone)
                res.write(JSON.stringify(o) + '\n'); };
            emit({ type: 'start', total: refs.length });
            const done = [];
            try {
                for (const [i, ref] of refs.entries()) {
                    if (gone) {
                        console.log(`\n  page closed — stopped after ${done.length} of ${refs.length}`);
                        return finish();
                    }
                    const name = ref.split('/').pop() || ref;
                    emit({ type: 'begin', i, name });
                    // Same model the page was built from, so what is published is exactly
                    // what the counts on screen described — and a corpus that changed
                    // mid-session cannot silently alter what leaves.
                    const payload = projectPayload(model, ref);
                    const out = await api(cfg, '/v1/share', 'POST', { kind: 'project', ref, label: name, payload });
                    const d = describe(payload);
                    console.log(`  shared ${out.id}  ${name}  ${d.textFields} prompt-text field(s)`);
                    done.push(String(out.id));
                    emit({ type: 'done', i, name, id: String(out.id), textFields: d.textFields, count: done.length });
                }
            }
            catch (e) {
                // Partial success is reported as such. Saying "failed" after three of
                // five went out would leave somebody believing nothing was published.
                const msg = `${e.message}${done.length ? ` — ${done.length} already went out` : ''}`;
                console.log(`\n  stopped: ${msg}`);
                emit({ type: 'error', error: msg, shared: done.length });
                res.end();
                return finish();
            }
            emit({ type: 'end', shared: done.length, ids: done });
            res.end();
            console.log(`\n  ${done.length} shared. Revoke any of them with:  qshare.mjs --revoke <id>`);
            console.log('  A row can be deleted. What a colleague already read cannot be recalled.');
            finish();
        });
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const link = `http://127.0.0.1:${port}/`;
            console.log(`\n  opening ${link}`);
            console.log('  nothing is selected, and nothing is sent until you press the button');
            openBrowser(link);
        });
        // Abandoned rather than left listening. An open port that publishes on
        // request should not outlive the person's attention.
        setTimeout(() => { if (!settled) {
            console.log('\n  timed out after 10 minutes — nothing was shared');
            finish();
        } }, 10 * 60_000).unref();
    });
}
function openBrowser(url) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try {
        // spawn, never a shell string: the URL carries a nonce.
        spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
    }
    catch {
        console.log('  (could not open a browser — visit the address above)');
    }
}
const isMain = process.argv[1] && process.argv[1].endsWith('qshare.mjs');
if (isMain) {
    const argv = process.argv.slice(2);
    const flag = (n) => argv.indexOf(n);
    const yes = argv.includes('--yes');
    try {
        const cfg = config();
        if (argv.includes('--pick')) {
            await runPicker(cfg);
            process.exit(0);
        }
        const rev = flag('--revoke');
        if (rev >= 0) {
            const id = argv[rev + 1];
            if (!id)
                throw new Error('--revoke needs a share id (see the list)');
            await api(cfg, '/v1/share/revoke', 'POST', { id });
            console.log(`revoked ${id}`);
            console.log('The row is deleted, not hidden. What a colleague already read cannot be recalled.');
            process.exit(0);
        }
        const review = flag('--review');
        const share = flag('--share');
        const act = review >= 0 ? review : share;
        if (act >= 0) {
            const kind = argv[act + 1] || '';
            const ref = argv[act + 2] || '';
            if (!kind || !ref)
                throw new Error(`usage: --${review >= 0 ? 'review' : 'share'} <project|session|run> <name>`);
            const payload = await payloadFor(kind, ref);
            const d = describe(payload);
            console.log(`\n${kind} ${ref}`);
            console.log(`  ${d.bytes.toLocaleString('en-GB')} bytes · sections: ${d.keys.join(', ')}`);
            console.log(`  ${d.textFields} field(s) carrying verbatim prompt text`);
            console.log(`  ${d.homePaths} absolute home path(s) — ${d.homePaths === 0 ? 'stripped' : 'STILL PRESENT, this is a bug'}`);
            if (review >= 0) {
                console.log('\n--- the literal payload ---');
                await emitJson(payload);
                console.log('\nShare it with:  qshare.mjs --share ' + kind + ' ' + ref + ' --yes');
                process.exit(0);
            }
            if (!yes) {
                console.log('\nThis will be readable by everyone in your workspace, including the');
                console.log('prompt text above. Review it first:');
                console.log(`  qshare.mjs --review ${kind} ${ref}`);
                console.log(`Then re-run with --yes.`);
                process.exit(1);
            }
            const label = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : ref;
            const out = await api(cfg, '/v1/share', 'POST', { kind, ref, label, payload });
            console.log(`\nshared as ${out.id} (${out.bytes.toLocaleString('en-GB')} bytes)`);
            console.log(`Revoke with: qshare.mjs --revoke ${out.id}`);
            process.exit(0);
        }
        // Default: what exists locally, and what of it is already shared.
        const [m, remote] = await Promise.all([corpus(), api(cfg, '/v1/shares')]);
        const shared = new Map();
        for (const s of remote.shares || [])
            shared.set(`${s.kind}|${s.ref}`, s);
        console.log(`workspace ${cfg.url}`);
        console.log(`${remote.shares?.length || 0} item(s) shared with your team\n`);
        console.log('  SHARED  PROJECT                    SESSIONS  TURNS   ');
        for (const p of m.projects.slice(0, 20)) {
            const hit = shared.get(`project|${p.name}`);
            console.log(`  ${hit ? '  ✓   ' : '  —   '}  ${p.name.padEnd(26)} ${String(p.sessions).padStart(8)} ${String(p.turns).padStart(6)}`);
        }
        if (remote.shares?.length) {
            console.log('\n  shared already:');
            for (const s of remote.shares) {
                console.log(`    ${s.id}  ${s.kind}/${s.ref} — ${(s.bytes / 1024).toFixed(1)} KB by ${s.sharedBy}`);
            }
        }
        console.log('\n  Nothing is shared unless you say so. Review before you send:');
        console.log('    qshare.mjs --review project <name>');
    }
    catch (e) {
        console.error(`error: ${e.message}`);
        process.exit(1);
    }
}
