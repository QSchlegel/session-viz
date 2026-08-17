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
 * Environment over file, per field.
 *
 * `SESSION_VIZ_TOKEN` is how a confined harness works at all, so it wins where
 * it is set and nowhere else: a URL in the environment must not drag along a
 * token from a config for a different workspace.
 */
export function config(): Config {
  const file: Partial<Config> = loadConfig<Config>() || {}
  const envToken = process.env.SESSION_VIZ_TOKEN
  const envUrl = process.env.SESSION_VIZ_URL

  // A URL and the token sent to it are ONE credential and come from ONE source.
  // Resolved per field, `SESSION_VIZ_URL=http://elsewhere` with no token beside
  // it picked the token out of the config file and put a live bearer for this
  // workspace into a request to whatever that URL named. The doc comment above
  // already stated the rule; the code resolved the two independently and broke
  // it anyway.
  if (envUrl && !envToken && file.token) {
    throw new Error(
      'SESSION_VIZ_URL is set but SESSION_VIZ_TOKEN is not.\n' +
      '  Refusing to send the token from your config file to a different host.\n' +
      '  Set both, or neither.')
  }

  const url = (envToken ? envUrl : undefined) || file.url || 'https://cloud.session-viz.com'
  const token = envToken || file.token
  if (!token) throw new Error('no token — run /qsetup first, or set SESSION_VIZ_TOKEN')
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
