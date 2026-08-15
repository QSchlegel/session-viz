#!/usr/bin/env node
// Connect this machine to a workspace, without a token ever passing through a
// terminal.
//
//   node qsetup.mjs                 # sign in in the browser, get a token back
//   node qsetup.mjs --scope collab  # ask for plane B access (admins only)
//   node qsetup.mjs --paste         # the old flow: paste a token into a page
//   node qsetup.mjs --show          # print the current config, redacted
//   node qsetup.mjs --forget        # delete it
//
// ── Why this is an OAuth flow and not a text box ─────────────────────────────
// A token is a long opaque bearer string. Every way of moving one by hand is a
// way of leaving a copy somewhere: shell history, a screenshot, a scrollback
// buffer, the wrong window. The paste page below was already an improvement on
// typing it into a shell — but it still required the person to hold the secret
// for a moment, and holding it is the part that goes wrong.
//
// So the secret never gets held. This is the RFC 8252 native-app flow:
//
//   1. mint a random `code_verifier`, keep it in this process only
//   2. send its SHA-256 (the `code_challenge`) to /authorize, via the browser
//   3. the person approves in a session they already have — the browser proves
//      who they are, not a string they carry
//   4. the server redirects a single-use `code` to a loopback port here
//   5. this process exchanges code + verifier for the token, back-channel
//
// The code that crosses the browser is worthless without the verifier, which
// never left this process. The token that comes back is the same `svt_…` row
// the console has always issued — same list, same revoke button.
//
// The loopback listener is as small a target as it can be while existing:
//   - bound to 127.0.0.1 only, never a routable interface
//   - an ephemeral port the kernel picks, not a fixed one
//   - `state` is required on the callback and compared in constant time
//   - one callback and it shuts down
//   - a five-minute deadline if nothing arrives
//
// The token is verified BEFORE it is written, in both flows. Storing an
// unverified string is how you end up debugging a typo three days later, in a
// different component.
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { rmSync, existsSync } from 'node:fs';
import { findConfig, configPaths, configTarget, loadConfig, saveConfig, harnessLabel } from './home.mjs';
const DEFAULT_URL = 'https://cloud.session-viz.com';
const DEADLINE_MS = 5 * 60 * 1000;
const CLIENT_ID = 'session-viz-cli';
/** Config first, environment second — an explicit env var still wins nothing here
 *  by accident: it is read only when the file has no value for that field. */
export function readConfig() {
    return loadConfig();
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
// Path resolution, the 0600/0700 modes and the permission fallback all live in
// home.mts, because /qshare has to agree with this about where the token is.
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
/**
 * Does this deployment do the code flow?
 *
 * Asked rather than assumed, because a self-hosted copy pinned to an older
 * build has no /authorize, and the failure mode without this probe is a browser
 * tab showing a 404 while the terminal sits there saying "waiting…". A single
 * field in /healthz is a cheaper answer than parsing a redirect.
 */
async function supportsOAuth(url) {
    try {
        const r = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(6000) });
        if (!r.ok)
            return false;
        const h = (await r.json());
        return !!h.auth?.oauth?.token;
    }
    catch {
        return false;
    }
}
const b64u = (b) => b.toString('base64url');
const constEq = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};
// ---------------------------------------------------------------- the pages
/** The loopback replies are the last thing the browser shows before it is sent
 *  back to the workspace, so they are plain and short rather than styled. */
const done = (heading, detail, goto) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${heading} — session-viz</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${goto ? `<meta http-equiv="refresh" content="1;url=${goto}">` : ''}
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f5f0;color:#1b1a17;
font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;padding:24px}
div{max-width:44ch}h1{font-size:20px;margin:0 0 8px}p{color:#6d6a63;margin:0}
a{color:#c25a2b}</style></head><body><div>
<h1>${heading}</h1><p>${detail}</p>
${goto ? `<p style="margin-top:14px"><a href="${goto}">Open your workspace</a></p>` : ''}
</div></body></html>`;
const PAGE = (nonce, defaultUrl, target, actor) => `<!doctype html>
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
     is written, and stored only in <code>${target}</code>.</p>
  <label for="u">Server</label>
  <input id="u" type="text" value="${defaultUrl}" spellcheck="false">
  <label for="t">Plugin token</label>
  <input id="t" type="password" placeholder="svt_…" spellcheck="false" autocomplete="off" autofocus>
  <label for="a">Actor label (optional)</label>
  <input id="a" type="text" placeholder="you@example.com" spellcheck="false" value="${actor}">
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
    // Back to the workspace rather than "you can close this tab". The console
    // is where the next thing happens, and it now sees this machine as
    // connected — telling somebody to close the tab left them looking at a
    // checklist that had no idea the setup they just did had happened.
    say('Saved — scope ' + d.scope + ', workspace ' + d.tenant + '. Taking you to your workspace…', 'ok')
    $('t').value = ''
    // A link too, because a redirect can be blocked and a dead end here is a
    // person with a working config who thinks it failed.
    const a = document.createElement('a')
    a.href = d.app
    a.textContent = 'Open it now'
    a.style.marginLeft = '8px'
    m.appendChild(a)
    setTimeout(() => { location.href = d.app }, 1200)
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
    // spawn, not a shell string: the URL carries a nonce or a challenge and must
    // never be subject to shell interpretation.
    //
    // The 'error' listener is the part that matters, and it is not decoration.
    // spawn reports a missing binary ASYNCHRONOUSLY, so a try/catch around this
    // call never sees ENOENT — an unhandled 'error' event on a ChildProcess is
    // thrown instead, and it took the whole command down. That happened on
    // exactly the machines this fallback was written for: a headless box with no
    // xdg-open, where the printed URL is supposed to be the answer. The catch is
    // kept as well for the synchronous failures (a bad argv, EACCES on the
    // binary), which are real and are thrown here rather than emitted.
    try {
        const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
        child.on('error', () => { });
        child.unref();
    }
    catch {
        /* same answer, for the failures spawn does raise synchronously */
    }
}
/** What both flows print once a token is on disk, so the two cannot drift. */
function report({ saved, token, scope, tenant, target, actor }) {
    if (saved.fellBack) {
        console.log('\n  note    the preferred config location was not writable;');
        console.log('          this harness is probably sandboxed.');
    }
    console.log(`\n  saved   ${saved.path} (0600)`);
    console.log(`  token   ${redact(token)}  scope ${scope}`);
    console.log(`  tenant  ${tenant}`);
    console.log(`  server  ${target}`);
    console.log('\n  The MCP reads environment variables rather than this file, so for');
    console.log('  vaults and task handoff also add to your shell profile:\n');
    console.log(`    export SESSION_VIZ_URL=${target}`);
    // Naming the credential they are actually holding, rather than telling
    // somebody who just minted a collab token to go and find a collab token.
    console.log(scope === 'collab'
        ? '    export SESSION_VIZ_TOKEN=<the token just issued>'
        : '    export SESSION_VIZ_TOKEN=<a collab-scoped token>');
    if (actor)
        console.log(`    export SESSION_VIZ_ACTOR=${actor}`);
}
// ---------------------------------------------------------------- oauth flow
async function runOAuth(target, scope, actor) {
    // Kept in this process and nowhere else. 32 random bytes base64url-encode to
    // 43 characters, which is the RFC's floor as well as its most common length.
    const verifier = b64u(crypto.randomBytes(32));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const state = b64u(crypto.randomBytes(18));
    let ok = false;
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            server.close();
            resolve();
        };
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            const html = (code, body) => {
                res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
                res.end(body);
            };
            if (url.pathname !== '/callback') {
                return html(404, done('Not here', 'This address only receives the sign-in redirect.'));
            }
            // Constant-time, and checked before anything else is read: a callback
            // that cannot prove it belongs to this run is not worth parsing.
            if (!constEq(url.searchParams.get('state') || '', state)) {
                console.log('\n  refused a callback whose state did not match — nothing was written');
                return html(400, done('Refused', 'That redirect did not belong to the setup running on this machine.'));
            }
            const denied = url.searchParams.get('error');
            if (denied) {
                console.log(`\n  ${denied === 'access_denied' ? 'declined in the browser' : denied} — nothing was written`);
                html(200, done('Not connected', 'You declined, so nothing was written. Run setup again if that was a mistake.'));
                return finish();
            }
            const code = url.searchParams.get('code') || '';
            if (!code) {
                html(400, done('No code', 'The server redirected here without an authorization code.'));
                return finish();
            }
            try {
                const r = await fetch(`${target}/v1/oauth/token`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        code,
                        code_verifier: verifier,
                        redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
                        client_id: CLIENT_ID,
                    }),
                });
                const d = (await r.json().catch(() => ({})));
                if (!r.ok || !d.access_token) {
                    throw new Error(d.error_description || d.error || `the exchange failed (HTTP ${r.status})`);
                }
                // Verified before it is written, exactly as a pasted one is. It also
                // stamps last-used, which is what makes the console's checklist notice
                // that a machine has arrived.
                const info = await verify(target, d.access_token);
                const saved = saveConfig({
                    url: target, token: d.access_token, scope: info.scope, tenant: info.tenant,
                    ...(actor ? { actor } : {}),
                    savedAt: new Date().toISOString(),
                });
                html(200, done('Connected', `Scope ${info.scope}, workspace ${info.tenant}. You can go back to your terminal.`, `${target}/authorize/done`));
                report({ saved, token: d.access_token, scope: info.scope, tenant: info.tenant, target, actor });
                ok = true;
            }
            catch (e) {
                const msg = e.message;
                console.log(`\n  failed  ${msg}`);
                html(400, done('Could not finish', msg));
            }
            finish();
        });
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            const to = new URL(`${target}/authorize`);
            to.searchParams.set('client_id', CLIENT_ID);
            to.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
            to.searchParams.set('code_challenge', challenge);
            to.searchParams.set('code_challenge_method', 'S256');
            to.searchParams.set('scope', scope);
            to.searchParams.set('state', state);
            if (actor)
                to.searchParams.set('label', actor);
            console.log('session-viz setup');
            console.log(`  server  ${target}`);
            console.log(`  scope   ${scope}`);
            console.log(`  opening ${to.toString()}`);
            console.log(`  waiting on 127.0.0.1:${port} … (ctrl-c to cancel)`);
            openBrowser(to.toString());
        });
        const timer = setTimeout(() => {
            console.log('\n  timed out after 5 minutes — nothing was written');
            finish();
        }, DEADLINE_MS);
        timer.unref();
    });
    return ok;
}
// ---------------------------------------------------------------- paste flow
async function runPaste(defaultUrl, harness) {
    const nonce = crypto.randomBytes(18).toString('base64url');
    await new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
            const url = new URL(req.url || '/', 'http://127.0.0.1');
            const send = (code, body) => {
                res.writeHead(code, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (req.method === 'GET' && url.pathname === '/') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end(PAGE(nonce, defaultUrl, configTarget(), harness === 'unknown' ? '' : harness));
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
                    const saved = saveConfig({
                        url: target, token, scope: info.scope, tenant: info.tenant,
                        ...(actor ? { actor } : {}),
                        savedAt: new Date().toISOString(),
                    });
                    const app = `${target}/app`;
                    send(200, { saved: true, scope: info.scope, tenant: info.tenant, app });
                    report({ saved, token, scope: info.scope, tenant: info.tenant, target, actor });
                    console.log(`  browser sent to ${app}`);
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
async function run() {
    const argv = process.argv.slice(2);
    if (argv.includes('--show')) {
        const cfg = readConfig();
        if (!cfg) {
            // Every place that was looked at, not just the one we would write to —
            // "no config at <path>" is unhelpful when four paths are consulted.
            console.log('no config. looked in:');
            for (const p of configPaths())
                console.log(`  ${p}`);
            return;
        }
        console.log(`config   ${findConfig()}`);
        console.log(`server   ${cfg.url}`);
        console.log(`token    ${redact(cfg.token)}${cfg.scope ? `  (${cfg.scope})` : ''}`);
        console.log(`tenant   ${cfg.tenant || '—'}`);
        console.log(`actor    ${cfg.actor || '—'}`);
        console.log(`saved    ${cfg.savedAt}`);
        return;
    }
    if (argv.includes('--forget')) {
        // Every copy, not the first one found. Leaving a shadowed config behind
        // means "forget" hands the token straight back on the next read.
        const gone = configPaths().filter((p) => existsSync(p));
        for (const p of gone) {
            rmSync(p);
            console.log(`removed ${p}`);
        }
        if (!gone.length)
            console.log('nothing to remove');
        return;
    }
    const defaultUrl = (process.env.SESSION_VIZ_URL || readConfig()?.url || DEFAULT_URL).replace(/\/$/, '');
    // Pre-filled, not imposed. It saves the common case of typing the name of the
    // harness you are visibly sitting in, and in the OAuth flow it becomes the
    // token's label, so the console lists something better than "plugin".
    const harness = harnessLabel();
    const actor = harness === 'unknown' ? '' : harness;
    const scopeAt = argv.indexOf('--scope');
    const scope = scopeAt >= 0 ? String(argv[scopeAt + 1] || '') : 'contrib';
    if (scope !== 'contrib' && scope !== 'collab') {
        console.error(`unknown scope "${scope}" — contrib or collab`);
        process.exitCode = 2;
        return;
    }
    if (!argv.includes('--paste')) {
        if (await supportsOAuth(defaultUrl)) {
            const ok = await runOAuth(defaultUrl, scope, actor);
            // A refusal, a timeout or a failed exchange are all answers, not reasons
            // to quietly offer a text box instead. Falling through to the paste page
            // after somebody pressed Deny would be its own small betrayal.
            if (!ok)
                process.exitCode = 1;
            return;
        }
        console.log(`  note    ${defaultUrl} has no browser sign-in; using the paste page instead.`);
    }
    await runPaste(defaultUrl, harness);
}
const isMain = process.argv[1] && process.argv[1].endsWith('qsetup.mjs');
if (isMain)
    await run();
