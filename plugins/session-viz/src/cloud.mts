// The one HTTP client every network command uses.
//
// This existed three times before it existed once: qfeed.mts and qshare.mts
// each carried a byte-identical `api()` and a near-identical `config()`, and
// qsetup.mts exported a third resolver (`resolveToken`) that neither of them
// imported. Three copies of the rule "environment beats file, and a missing
// token is a /qsetup problem" is three places for it to drift — and the drift
// would be silent, because each command is exercised on its own.
//
// Nothing here decides what to send. It resolves the credential, sets the
// headers, and translates the two server answers that are actively misleading.

import { loadConfig } from './home.mjs'

export interface Config {
  url: string
  token: string
  actor?: string
  /** What the SERVER said the token is scoped to, as recorded by /qsetup. Never
   *  trusted as authorisation — the server enforces scope — but worth reading
   *  so a command can name the fix before it spends a round trip on a 403. */
  scope?: string
}

/**
 * One credential, from one place: the file `/qsetup` wrote after signing in.
 *
 * `SESSION_VIZ_TOKEN` used to win wherever it was set. It is gone, and with it
 * the last way to hold a workspace credential without having signed in for it —
 * a token in an environment is a token in a shell profile, a CI variable, a
 * process listing and whatever inherited that environment, held by whoever
 * copied it there rather than by the person the workspace issued it to.
 *
 * What replaces it for a machine that cannot open a browser is not a weaker
 * credential: it is signing in on a machine that can, and carrying the config
 * file. `SESSION_VIZ_HOME` says where that file may live.
 */
export function config(): Config {
  const file: Partial<Config> = loadConfig<Config>() || {}
  const envUrl = process.env.SESSION_VIZ_URL

  // A URL and the token sent to it are ONE credential. `SESSION_VIZ_URL` left
  // over in a shell profile — from pointing setup at a self-hosted deployment,
  // say — must never decide where the file's token is sent: that would put a
  // live bearer for this workspace into a request to whatever the variable
  // happens to name.
  if (envUrl && file.url && envUrl !== file.url) {
    throw new Error(
      `SESSION_VIZ_URL names ${envUrl}, but this machine is connected to ${file.url}.\n` +
      '  Refusing to send that workspace\'s token to a different host.\n' +
      '  Unset it, or run /qsetup against the host you mean.')
  }

  const url = file.url || envUrl || 'https://cloud.session-viz.com'
  const token = file.token
  if (!token) throw new Error('no token — run /qsetup first; it signs you in and writes one')
  const actor = process.env.SESSION_VIZ_ACTOR || file.actor
  const scope = file.scope
  return { url, token, ...(actor ? { actor } : {}), ...(scope ? { scope } : {}) }
}

export const api = async (cfg: Config, path: string, method = 'GET', body?: unknown): Promise<any> => {
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

export interface Introspection {
  valid: boolean
  tenant: string
  scope: string
}

/**
 * Who this token belongs to, before anything is sent.
 *
 * The translation is the point. A revoked or unknown `svt_` token does not get
 * a "revoked" answer anywhere on the API: token lookup returns no row, the
 * request falls through to the legacy shared-token compare, and the caller sees
 * `bad contrib token` — which reads as "you typed it wrong" when it means "an
 * admin turned this off". Asking here turns a debugging session into one line.
 */
export async function introspect(cfg: Config): Promise<Introspection> {
  const r = await fetch(cfg.url.replace(/\/$/, '') + '/v1/token/introspect', {
    headers: { authorization: `Bearer ${cfg.token}` },
  })
  if (r.status === 401) {
    throw new Error('this token is revoked or unknown to ' + cfg.url + ' — run /qsetup again')
  }
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `the server refused this token (HTTP ${r.status})`)
  }
  return (await r.json()) as Introspection
}
