#!/usr/bin/env node
// Paste a plugin token into a page instead of into a shell.
//
//   node qsetup.mjs                 # open the page, wait, write the config
//   node qsetup.mjs --show          # print the current config, redacted
//   node qsetup.mjs --forget        # delete it
//
// A token is a long opaque string that people get from a browser. Asking them
// to move it into a terminal is where it ends up in shell history, in a
// screenshot, or pasted into the wrong window. So the browser hands it back
// directly: this starts a server on loopback, opens one page, takes the token,
// verifies it against the backend, writes it 0600, and exits.
//
// The server is as small a target as it can be while still existing:
//   - bound to 127.0.0.1 only, never a routable interface
//   - an ephemeral port chosen by the kernel, not a fixed one
//   - a one-time nonce in the URL, required on the POST, so another local
//     process cannot post to it blind
//   - one successful submission and it shuts down
//   - a five-minute deadline if nothing arrives
//
// The token is verified BEFORE it is written. Storing an unverified string is
// how you end up debugging a typo three days later, in a different component.
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
const DIR = join(homedir(), '.claude', 'session-viz');
const CONFIG = join(DIR, 'config.json');
const DEFAULT_URL = 'https://cloud.session-viz.com';
const DEADLINE_MS = 5 * 60 * 1000;
/** Config first, environment second — an explicit env var still wins nothing here
 *  by accident: it is read only when the file has no value for that field. */
export function readConfig() {
    try {
        return JSON.parse(readFileSync(CONFIG, 'utf8'));
    }
    catch {
        return null;
    }
}
export function resolveToken() {
    const cfg = readConfig();
    const url = process.env.SESSION_VIZ_URL || cfg?.url || DEFAULT_URL;
    const token = process.env.SESSION_VIZ_TOKEN || cfg?.token;
    if (!token)
        return null;
    const actor = process.env.SESSION_VIZ_ACTOR || cfg?.actor;
    return actor ? { url, token, actor } : { url, token };
}
function writeConfig(cfg) {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    // writeFileSync honours `mode` only when it creates the file, so an existing
    // one keeps whatever permissions it had. The same omission left session
    // reports world-readable in /tmp; not repeating it here.
    chmodSync(CONFIG, 0o600);
    chmodSync(dirname(CONFIG), 0o700);
}
const redact = (t) => (t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : '…');
async function verify(url, token) {
    const r = await fetch(`${url.replace(/\/$/, '')}/v1/token/introspect`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
        const body = (await r.json().catch(() => ({})));
        throw new Error(body.error || `the server refused this token (HTTP ${r.status})`);
    }
    return (await r.json());
}
// ---------------------------------------------------------------- the page
const PAGE = (nonce, defaultUrl) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connect session-viz</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f7f5f0;--card:#fffefb;--ink:#1b1a17;--dim:#6d6a63;--line:#e2ded4;
  --green:#4a7c59;--red:#a8443a;--accent:#c25a2b;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:ui-sans-serif,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);
  color:var(--ink);font:15px/1.55 var(--sans);padding:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:26px 28px;max-width:520px;width:100%;box-shadow:0 6px 24px -14px rgba(27,26,23,.3)}
h1{font-size:20px;margin:0 0 6px}
p{color:var(--dim);margin:0 0 18px}
label{display:block;font:600 10.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;
  color:var(--dim);margin:14px 0 6px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;
  font:13.5px var(--mono);background:var(--bg);color:var(--ink)}
input:focus{outline:2px solid var(--green);outline-offset:-1px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--ink);
  color:var(--bg);font:500 14px var(--sans);cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
.msg{margin-top:14px;font:13px var(--mono);min-height:20px}
.ok{color:var(--green)} .bad{color:var(--red)}
code{font-family:var(--mono);font-size:12.5px;color:var(--accent)}
</style></head><body>
<div class="card">
  <h1>Connect this machine</h1>
  <p>Paste the token from your workspace. It is checked against the server before anything
     is written, and stored only in <code>~/.claude/session-viz/config.json</code>.</p>
  <label for="u">Server</label>
  <input id="u" type="text" value="${defaultUrl}" spellcheck="false">
  <label for="t">Plugin token</label>
  <input id="t" type="password" placeholder="svt_…" spellcheck="false" autocomplete="off" autofocus>
  <label for="a">Actor label (optional)</label>
  <input id="a" type="text" placeholder="you@example.com" spellcheck="false">
  <button id="go" type="button">Verify and save</button>
  <p class="msg" id="m"></p>
</div>
<script>
const $ = (id) => document.getElementById(id)
const m = $('m')
const say = (t, cls) => { m.textContent = t; m.className = 'msg ' + (cls || '') }
$('go').onclick = async () => {
  const token = $('t').value.trim()
  if (!token) return say('Paste the token first.', 'bad')
  $('go').disabled = true
  say('Verifying with the server…')
  try {
    const r = await fetch('/save?nonce=${nonce}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, url: $('u').value.trim(), actor: $('a').value.trim() }),
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status))
    say('Saved. Scope ' + d.scope + ', workspace ' + d.tenant + '. You can close this tab.', 'ok')
    $('t').value = ''
  } catch (e) {
    say(e.message, 'bad')
    $('go').disabled = false
  }
}
$('t').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click() })
</script>
</body></html>`;
// ---------------------------------------------------------------- cli
function openBrowser(url) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    // spawn, not a shell string: the URL contains a nonce and must never be
    // subject to shell interpretation.
    try {
        spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
    }
    catch {
        /* headless box; the printed URL is the fallback */
    }
}
async function run() {
    const argv = process.argv.slice(2);
    if (argv.includes('--show')) {
        const cfg = readConfig();
        if (!cfg) {
            console.log('no config at ' + CONFIG);
            return;
        }
        console.log(`config   ${CONFIG}`);
        console.log(`server   ${cfg.url}`);
        console.log(`token    ${redact(cfg.token)}${cfg.scope ? `  (${cfg.scope})` : ''}`);
        console.log(`tenant   ${cfg.tenant || '—'}`);
        console.log(`actor    ${cfg.actor || '—'}`);
        console.log(`saved    ${cfg.savedAt}`);
        return;
    }
    if (argv.includes('--forget')) {
        if (existsSync(CONFIG)) {
            rmSync(CONFIG);
            console.log(`removed ${CONFIG}`);
        }
        else
            console.log('nothing to remove');
        return;
    }
    const nonce = crypto.randomBytes(18).toString('base64url');
    const defaultUrl = process.env.SESSION_VIZ_URL || readConfig()?.url || DEFAULT_URL;
    await new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            const send = (code, body) => {
                res.writeHead(code, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (req.method === 'GET' && url.pathname === '/') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(PAGE(nonce, defaultUrl));
            }
            if (req.method === 'POST' && url.pathname === '/save') {
                // The nonce is the whole reason another local process cannot drive
                // this: it is only ever printed to this terminal and handed to the
                // browser we opened.
                if (url.searchParams.get('nonce') !== nonce)
                    return send(403, { error: 'bad nonce' });
                let raw = '';
                for await (const chunk of req) {
                    raw += chunk;
                    if (raw.length > 8192)
                        return send(413, { error: 'too large' });
                }
                let body;
                try {
                    body = JSON.parse(raw);
                }
                catch {
                    return send(400, { error: 'invalid json' });
                }
                const token = String(body.token || '').trim();
                const target = String(body.url || defaultUrl).trim().replace(/\/$/, '');
                if (!token)
                    return send(400, { error: 'no token' });
                if (!/^svt_/.test(token)) {
                    return send(400, { error: 'that does not look like a plugin token — they begin svt_' });
                }
                try {
                    const info = await verify(target, token);
                    const actor = String(body.actor || '').trim();
                    writeConfig({
                        url: target, token, scope: info.scope, tenant: info.tenant,
                        ...(actor ? { actor } : {}),
                        savedAt: new Date().toISOString(),
                    });
                    send(200, { saved: true, scope: info.scope, tenant: info.tenant });
                    console.log(`\n  saved   ${CONFIG} (0600)`);
                    console.log(`  token   ${redact(token)}  scope ${info.scope}`);
                    console.log(`  tenant  ${info.tenant}`);
                    console.log(`  server  ${target}\n`);
                    console.log('  The MCP reads environment variables rather than this file, so for');
                    console.log('  vaults and task handoff also add to your shell profile:\n');
                    console.log(`    export SESSION_VIZ_URL=${target}`);
                    console.log('    export SESSION_VIZ_TOKEN=<a collab-scoped token>');
                    if (actor)
                        console.log(`    export SESSION_VIZ_ACTOR=${actor}`);
                    server.close();
                    resolve();
                }
                catch (e) {
                    send(400, { error: e.message });
                }
                return;
            }
            send(404, { error: 'not found' });
        });
        // Loopback only. Port 0 lets the kernel pick, so this is never a predictable
        // target between runs.
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            const link = `http://127.0.0.1:${port}/?nonce=${nonce}`;
            console.log('session-viz setup');
            console.log(`  opening ${link}`);
            console.log('  paste the token from your workspace at ' + defaultUrl + '/app');
            console.log('  waiting… (ctrl-c to cancel)');
            openBrowser(link);
        });
        // A setup page that outlives the terminal it was started from is a loose
        // end, not a convenience.
        const timer = setTimeout(() => {
            console.log('\n  timed out after 5 minutes — nothing was written');
            server.close();
            resolve();
        }, DEADLINE_MS);
        timer.unref();
    });
}
const isMain = process.argv[1] && process.argv[1].endsWith('qsetup.mjs');
if (isMain)
    await run();
