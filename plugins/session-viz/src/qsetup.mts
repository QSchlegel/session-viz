#!/usr/bin/env node
// Connect this machine to a workspace, without a token ever passing through a
// terminal.
//
//   node qsetup.mjs                 # sign in in the browser, get a token back
//   node qsetup.mjs --scope collab  # ask for plane B access (admins only)
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

import http from 'node:http'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { rmSync, existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { findConfig, configPaths, configTarget, loadConfig, saveConfig, harnessLabel } from './home.mjs'
// The `plain` variants throughout. This page takes a bearer token, and chrome
// that reads as a seal of office is chrome that teaches the reader to trust a
// layout — the exact habit the page impersonating this one would need them to
// have. The mark says which tool opened the tab; it does not vouch for it.
import { brandCss, brandHeader, brandFooter, esc } from './brand.mjs'

const DEFAULT_URL = 'https://cloud.session-viz.com'
const DEADLINE_MS = 5 * 60 * 1000
const CLIENT_ID = 'session-viz-cli'

export interface PluginConfig {
  url: string
  token: string
  actor?: string
  scope?: string
  tenant?: string
  savedAt: string
}

/** Config first, environment second — an explicit env var still wins nothing here
 *  by accident: it is read only when the file has no value for that field. */
export function readConfig(): PluginConfig | null {
  return loadConfig<PluginConfig>()
}

export function resolveToken(): { url: string; token: string; actor?: string } | null {
  const cfg = readConfig()
  const url = process.env.SESSION_VIZ_URL || cfg?.url || DEFAULT_URL
  const token = process.env.SESSION_VIZ_TOKEN || cfg?.token
  if (!token) return null
  const actor = process.env.SESSION_VIZ_ACTOR || cfg?.actor
  return actor ? { url, token, actor } : { url, token }
}

// Path resolution, the 0600/0700 modes and the permission fallback all live in
// home.mts, because /qshare has to agree with this about where the token is.

const redact = (t: string): string => (t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : '…')

interface Introspection { valid: boolean; tenant: string; scope: string }

async function verify(url: string, token: string): Promise<Introspection> {
  const r = await fetch(`${url.replace(/\/$/, '')}/v1/token/introspect`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `the server refused this token (HTTP ${r.status})`)
  }
  return (await r.json()) as Introspection
}

/**
 * Does this deployment do the code flow?
 *
 * Asked rather than assumed, because a self-hosted copy pinned to an older
 * build has no /authorize, and the failure mode without this probe is a browser
 * tab showing a 404 while the terminal sits there saying "waiting…". A single
 * field in /healthz is a cheaper answer than parsing a redirect.
 */
async function supportsOAuth(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return false
    const h = (await r.json()) as { auth?: { oauth?: { token?: string } } }
    return !!h.auth?.oauth?.token
  } catch { return false }
}

const b64u = (b: Buffer): string => b.toString('base64url')
const constEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

// ---------------------------------------------------------------- the pages

/**
 * The palette both setup pages paint from.
 *
 * Split out of PAGE because `done` used to carry its own four literals, and a
 * page that hardcodes a light background is a page that stays light while the
 * brand chrome beside it — which declares `color-scheme` across three states —
 * has already gone dark. The visible failure is a dark scrollbar and a dark
 * form control on a cream card.
 *
 * Three states, guarded, like the reports: nothing here sets [data-theme]
 * today, but a palette that only knows the system query is a palette that
 * cannot be told otherwise later.
 */
const TOKENS = `:root{--bg:#f7f5f0;--card:#fffefb;--ink:#1b1a17;--dim:#6d6a63;--line:#e2ded4;
  --green:#4a7c59;--red:#a8443a;--accent:#c25a2b;--shadow:rgba(27,26,23,.3);
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:ui-sans-serif,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#16151a;--card:#1e1d23;--ink:#ece9e4;--dim:#9b968d;--line:#302e37;
  --green:#6fbf8e;--red:#ff6b5e;--accent:#ff8a4c;--shadow:rgba(0,0,0,.55)}}
:root[data-theme=dark]{
  --bg:#16151a;--card:#1e1d23;--ink:#ece9e4;--dim:#9b968d;--line:#302e37;
  --green:#6fbf8e;--red:#ff6b5e;--accent:#ff8a4c;--shadow:rgba(0,0,0,.55)}`

/** The loopback replies are the last thing the browser shows before it is sent
 *  back to the workspace, so they are plain and short rather than styled. The
 *  mark is the one addition: it is the only thing on the page that says which
 *  tool put it there. Exported so the brand test can render the real page. */
export const done = (heading: string, detail: string, goto?: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${heading} — session-viz</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${goto ? `<meta http-equiv="refresh" content="1;url=${goto}">` : ''}
<style>${TOKENS}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font:15px/1.55 var(--sans);padding:24px}
body > div{max-width:44ch}h1{font-size:20px;margin:0 0 8px}p{color:var(--dim);margin:0}
a{color:var(--accent)}${brandCss()}</style></head><body><div>
${brandHeader({ plain: true })}
<h1>${heading}</h1><p>${detail}</p>
${goto ? `<p style="margin-top:14px"><a href="${goto}">Open your workspace</a></p>` : ''}
${brandFooter({ plain: true, facts: ['written by /qsetup — check the address bar says 127.0.0.1 before typing a token'] })}
</div></body></html>`

// ---------------------------------------------------------------- cli

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
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
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true })
    child.on('error', () => { /* headless box; the printed URL is the fallback */ })
    child.unref()
  } catch {
    /* same answer, for the failures spawn does raise synchronously */
  }
}

/** What both flows print once a token is on disk, so the two cannot drift. */
function report(
  { saved, token, scope, tenant, target, actor }: {
    saved: { path: string; fellBack?: boolean }
    token: string; scope: string; tenant: string; target: string; actor: string
  },
): void {
  if (saved.fellBack) {
    console.log('\n  note    the preferred config location was not writable;')
    console.log('          this harness is probably sandboxed.')
  }
  console.log(`\n  saved   ${saved.path} (0600)`)
  console.log(`  token   ${redact(token)}  scope ${scope}`)
  console.log(`  tenant  ${tenant}`)
  console.log(`  server  ${target}`)
  // This used to print three export lines for the MCP server, on the grounds
  // that it read environment variables rather than this file. It no longer
  // does: .mcp.json carries a bare URL and authenticates by OAuth on its own.
  //
  // Following the old advice would set an Authorization header — and a header
  // is precisely what DISABLES the client's OAuth fallback. The setup command's
  // own closing instructions would have reintroduced the exact failure the
  // change existed to remove.
  console.log('\n  The MCP server needs nothing from this file. It authenticates on')
  console.log('  first use, in the browser, the same way you just did here.')
  // The step after setup used to have no name here, which is the whole reason a
  // correctly connected workspace still read "1 step left" in the console with
  // nothing on screen saying which of twelve commands would clear it.
  console.log('\n  next    /qcontrib shows what this machine would contribute, and what')
  console.log('          stays on it. Nothing leaves until you say so.')
}

// ---------------------------------------------------------------- oauth flow

async function runOAuth(target: string, scope: string, actor: string): Promise<boolean> {
  // Kept in this process and nowhere else. 32 random bytes base64url-encode to
  // 43 characters, which is the RFC's floor as well as its most common length.
  const verifier = b64u(crypto.randomBytes(32))
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest())
  const state = b64u(crypto.randomBytes(18))
  let ok = false

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      server.close()
      resolve()
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const html = (code: number, body: string): void => {
        res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
        res.end(body)
      }
      if (url.pathname !== '/callback') {
        return html(404, done('Not here', 'This address only receives the sign-in redirect.'))
      }
      // Constant-time, and checked before anything else is read: a callback
      // that cannot prove it belongs to this run is not worth parsing.
      if (!constEq(url.searchParams.get('state') || '', state)) {
        console.log('\n  refused a callback whose state did not match — nothing was written')
        return html(400, done('Refused', 'That redirect did not belong to the setup running on this machine.'))
      }
      const denied = url.searchParams.get('error')
      if (denied) {
        console.log(`\n  ${denied === 'access_denied' ? 'declined in the browser' : denied} — nothing was written`)
        html(200, done('Not connected', 'You declined, so nothing was written. Run setup again if that was a mistake.'))
        return finish()
      }
      const code = url.searchParams.get('code') || ''
      if (!code) {
        html(400, done('No code', 'The server redirected here without an authorization code.'))
        return finish()
      }
      try {
        const r = await fetch(`${target}/v1/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
            client_id: CLIENT_ID,
          }),
        })
        const d = (await r.json().catch(() => ({}))) as
          { access_token?: string; error_description?: string; error?: string }
        if (!r.ok || !d.access_token) {
          throw new Error(d.error_description || d.error || `the exchange failed (HTTP ${r.status})`)
        }
        // Verified before it is written, exactly as a pasted one is. It also
        // stamps last-used, which is what makes the console's checklist notice
        // that a machine has arrived.
        const info = await verify(target, d.access_token)
        const saved = saveConfig({
          url: target, token: d.access_token, scope: info.scope, tenant: info.tenant,
          ...(actor ? { actor } : {}),
          savedAt: new Date().toISOString(),
        })
        html(200, done('Connected',
          `Scope ${info.scope}, workspace ${info.tenant}. You can go back to your terminal.`,
          `${target}/authorize/done`))
        report({ saved, token: d.access_token, scope: info.scope, tenant: info.tenant, target, actor })
        ok = true
      } catch (e) {
        const msg = (e as Error).message
        console.log(`\n  failed  ${msg}`)
        html(400, done('Could not finish', msg))
      }
      finish()
    })

    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const to = new URL(`${target}/authorize`)
      to.searchParams.set('client_id', CLIENT_ID)
      to.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`)
      to.searchParams.set('code_challenge', challenge)
      to.searchParams.set('code_challenge_method', 'S256')
      to.searchParams.set('scope', scope)
      to.searchParams.set('state', state)
      if (actor) to.searchParams.set('label', actor)
      console.log('session-viz setup')
      console.log(`  server  ${target}`)
      console.log(`  scope   ${scope}`)
      console.log(`  opening ${to.toString()}`)
      console.log(`  waiting on 127.0.0.1:${port} … (ctrl-c to cancel)`)
      openBrowser(to.toString())
    })

    const timer = setTimeout(() => {
      console.log('\n  timed out after 5 minutes — nothing was written')
      finish()
    }, DEADLINE_MS)
    timer.unref()
  })
  return ok
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--show')) {
    const cfg = readConfig()
    if (!cfg) {
      // Every place that was looked at, not just the one we would write to —
      // "no config at <path>" is unhelpful when four paths are consulted.
      console.log('no config. looked in:')
      for (const p of configPaths()) console.log(`  ${p}`)
      return
    }
    console.log(`config   ${findConfig()}`)
    console.log(`server   ${cfg.url}`)
    console.log(`token    ${redact(cfg.token)}${cfg.scope ? `  (${cfg.scope})` : ''}`)
    console.log(`tenant   ${cfg.tenant || '—'}`)
    console.log(`actor    ${cfg.actor || '—'}`)
    console.log(`saved    ${cfg.savedAt}`)
    return
  }
  if (argv.includes('--forget')) {
    // Every copy, not the first one found. Leaving a shadowed config behind
    // means "forget" hands the token straight back on the next read.
    const gone = configPaths().filter((p) => existsSync(p))
    for (const p of gone) { rmSync(p); console.log(`removed ${p}`) }
    if (!gone.length) console.log('nothing to remove')
    return
  }

  const defaultUrl = (process.env.SESSION_VIZ_URL || readConfig()?.url || DEFAULT_URL).replace(/\/$/, '')
  // Pre-filled, not imposed. It saves the common case of typing the name of the
  // harness you are visibly sitting in, and in the OAuth flow it becomes the
  // token's label, so the console lists something better than "plugin".
  const harness = harnessLabel()
  const actor = harness === 'unknown' ? '' : harness

  const scopeAt = argv.indexOf('--scope')
  const scope = scopeAt >= 0 ? String(argv[scopeAt + 1] || '') : 'contrib'
  if (scope !== 'contrib' && scope !== 'collab') {
    console.error(`unknown scope "${scope}" — contrib or collab`)
    process.exitCode = 2
    return
  }

  // One way in. A token typed into a box is a token that can be read over a
  // shoulder, saved by a password manager that thinks it is a password, pasted
  // into the wrong window, or held by somebody who never signed in — and the
  // page that asked for it had to be trusted before the token could be checked.
  // The browser hand-off has none of those: nothing secret is typed, the
  // workspace mints the credential itself, and the exchange proves the machine
  // that asked is the machine that receives.
  if (!await supportsOAuth(defaultUrl)) {
    console.error(`\n  ${defaultUrl} does not offer browser sign-in, and there is no other way in.`)
    console.error('  A host that cannot sign you in cannot connect this machine. Check the')
    console.error('  address, or point SESSION_VIZ_URL at a workspace that can.')
    process.exitCode = 1
    return
  }
  // A refusal, a timeout or a failed exchange are all answers. None of them is
  // a reason to offer a text box instead.
  if (!await runOAuth(defaultUrl, scope, actor)) process.exitCode = 1
}

const isMain = process.argv[1] && process.argv[1].endsWith('qsetup.mjs')
if (isMain) await run()
