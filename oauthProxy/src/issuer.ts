// issuer.ts — Emisor OAuth auto-contenido con login por contraseña y consentimiento.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProxyConfig } from './config.js';
import { getKeys, signAccessToken } from './keys.js';
import {
  consumeBrowserLogin,
  consumeCode,
  getRefresh,
  randUrl,
  saveBrowserLogin,
  saveCode,
  saveRefresh,
  sha256b64url,
  verifyPkce,
} from './store.js';
import { newSession, setSessionCookie, clearSessionCookie, deleteSession, getSessionFromReq } from './session.js';
import { requirePassword } from './signin.js';
import { authenticate } from './auth.js';
import { isAllowedFormOrigin } from './formOrigin.js';
import { esc, parseForm, readBody, redirect, sendHtml, sendJson } from './httpUtils.js';

const BROWSER_CLIENT_ID = 'local-browser';
const DEFAULT_SCOPE = 'mcp:tools';

// RFC 9207: identificar al emisor tanto en respuestas exitosas como en errores.
function authorizationRedirect(res: ServerResponse, cfg: ProxyConfig, uri: string, params: Record<string, string>): void {
  const target = new URL(uri);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  target.searchParams.set('iss', cfg.publicUrl);
  allowCallbackNavigation(res, uri);
  redirect(res, target.toString());
}

export function callbackUrl(cfg: ProxyConfig): string {
  return `${cfg.publicUrl}/oauth/callback`;
}

// Algunos navegadores aplican form-action también al destino del redirect OAuth.
// Solo ampliar la política después de validar la URI de retorno.
function allowCallbackNavigation(res: ServerResponse, redirectUri: string): void {
  const policy = res.getHeader('content-security-policy');
  if (typeof policy === 'string') {
    res.setHeader('content-security-policy', policy.replace(
      "form-action 'self';",
      `form-action 'self' ${new URL(redirectUri).origin};`,
    ));
  }
}

/** Cliente remoto: coincidencia exacta de ID y callback. Resto: origen propio o loopback. */
export function isAllowedRedirectUri(cfg: ProxyConfig, uri: string, clientId?: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password || u.hash) return false;
  const clients = cfg.externalClients ?? (cfg.externalClient ? [cfg.externalClient] : []);
  if (clients.some(client => client.id === clientId)) {
    return clients.some(client => client.id === clientId && uri === client.redirectUri);
  }
  const issuer = new URL(cfg.publicUrl);
  if (u.origin === issuer.origin) return true;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if ((h === '127.0.0.1' || h === 'localhost' || h === '::1') && u.protocol === 'http:') return true;
  return false;
}

export function discoveryDoc(cfg: ProxyConfig): Record<string, unknown> {
  const base = cfg.publicUrl;
  return {
    issuer: base,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    userinfo_endpoint: `${base}/userinfo`,
    jwks_uri: `${base}/jwks.json`,
    registration_endpoint: undefined,
    scopes_supported: [DEFAULT_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

export function protectedResourceDoc(cfg: ProxyConfig): Record<string, unknown> {
  return {
    resource: `${cfg.publicUrl}/mcp`,
    authorization_servers: [cfg.publicUrl],
    scopes_supported: [DEFAULT_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'llamaharness (local)',
    resource_documentation: `${cfg.publicUrl}/healthz`,
  };
}

// ---- GET /authorize ----
export function handleAuthorize(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): void {
  const u = new URL(req.url ?? '/', cfg.publicUrl);
  const q = u.searchParams;
  const responseType = q.get('response_type') ?? '';
  const clientId = q.get('client_id')?.trim() ?? '';
  const redirectUri = q.get('redirect_uri') ?? '';
  const scope = q.get('scope')?.trim() || DEFAULT_SCOPE;
  const state = q.get('state') ?? '';
  const challenge = q.get('code_challenge') ?? '';
  const method = (q.get('code_challenge_method') || 'S256').toUpperCase();

  const fail = (error: string, desc: string): void => {
    if (redirectUri && isAllowedRedirectUri(cfg, redirectUri, clientId)) {
      authorizationRedirect(res, cfg, redirectUri, {
        error, error_description: desc, ...(state ? { state } : {}),
      });
      return;
    }
    sendJson(res, 400, { error, error_description: desc });
  };

  if (responseType !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
  if (!clientId) return fail('invalid_request', 'client_id is required');
  if (!redirectUri || !isAllowedRedirectUri(cfg, redirectUri, clientId))
    return fail('invalid_request', 'redirect_uri is not allowed for this client; add the exact id and redirectUri to OAUTH_CLIENTS');
  if (!challenge) return fail('invalid_request', 'code_challenge (PKCE S256) is required');
  if (method !== 'S256' && method !== 'PLAIN')
    return fail('invalid_request', 'code_challenge_method must be S256');
  if (!state) return fail('invalid_request', 'state is required');

  const session = getSessionFromReq(req);
  if (!session) { requirePassword(req, res, cfg); return; }
  allowCallbackNavigation(res, redirectUri);

  sendHtml(
    res,
    200,
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Autorizar acceso — llamaharness</title></head><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Autorizar acceso</h1>` +
      `<p>Iniciaste sesión. Aprobá el acceso de <code>${esc(clientId)}</code> con alcance <code>${esc(scope)}</code>.</p>` +
      `<form method="post" action="/authorize/approve">` +
      `<input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}">` +
      `<input type="hidden" name="client_id" value="${esc(clientId)}">` +
      `<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">` +
      `<input type="hidden" name="scope" value="${esc(scope)}">` +
      `<input type="hidden" name="state" value="${esc(state)}">` +
      `<input type="hidden" name="code_challenge" value="${esc(challenge)}">` +
      `<input type="hidden" name="code_challenge_method" value="${esc(method)}">` +
      `<button type="submit" style="font-size:1.1rem;padding:.6rem 1.4rem;cursor:pointer">Autorizar acceso</button>` +
      `</form>` +
      `<p><a href="/oauth/logout">Cerrar sesión</a></p>` +
      `</body></html>`,
  );
}

// ---- POST /authorize/approve ----
export async function handleApprove(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): Promise<void> {
  const session = getSessionFromReq(req);
  if (!session) { sendJson(res, 401, { error: 'login_required' }); return; }
  const body = await readBody(req, 8192);
  const f = parseForm(body, req.headers['content-type']);
  if (f.csrf_token !== session.csrfToken ||
      !isAllowedFormOrigin(req, cfg)) {
    sendJson(res, 403, { error: 'invalid_csrf' }); return;
  }
  const clientId = f.client_id?.trim() ?? '';
  const redirectUri = f.redirect_uri ?? '';
  const scope = f.scope?.trim() || DEFAULT_SCOPE;
  const state = f.state ?? '';
  const challenge = f.code_challenge ?? '';
  const method = (f.code_challenge_method || 'S256').toUpperCase();

  if (!clientId || !redirectUri || !isAllowedRedirectUri(cfg, redirectUri, clientId) || !challenge || !state || (method !== 'S256' && method !== 'PLAIN')) {
    sendJson(res, 400, { error: 'invalid_request', error_description: 'missing or invalid approve fields' });
    return;
  }

  allowCallbackNavigation(res, redirectUri);
  const code = randUrl(32);
  saveCode({
    code,
    clientId,
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: method === 'PLAIN' ? 'plain' : 'S256',
    scope,
    expiresAt: Date.now() + cfg.codeTtlSec * 1000,
  });
  authorizationRedirect(res, cfg, redirectUri, { code, state });
}

// ---- POST /token ----
export async function handleToken(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): Promise<void> {
  const body = await readBody(req);
  const f = parseForm(body, req.headers['content-type']);
  const grant = f.grant_type ?? '';

  if (grant === 'authorization_code') {
    const code = f.code ?? '';
    const redirectUri = f.redirect_uri ?? '';
    const clientId = f.client_id?.trim() ?? '';
    const verifier = f.code_verifier ?? '';
    const rec = consumeCode(code);
    if (!rec) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'code invalid, used or expired' });
      return;
    }
    if (!redirectUri || redirectUri !== rec.redirectUri) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }
    if (clientId && clientId !== rec.clientId) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });
      return;
    }
    if (!verifyPkce(verifier, rec.codeChallenge, rec.codeChallengeMethod)) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }
    const keys = await getKeys(cfg.keysDir);
    const access = await signAccessToken(keys, {
      issuer: cfg.publicUrl,
      audience: cfg.audience,
      subject: cfg.subject,
      scope: rec.scope,
      ttlSec: cfg.accessTtlSec,
    });
    const refresh = randUrl(32);
    saveRefresh({
      token: refresh,
      sub: cfg.subject,
      scope: rec.scope,
      clientId: rec.clientId,
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
    });
    sendJson(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: cfg.accessTtlSec,
      scope: rec.scope,
      refresh_token: refresh,
    });
    return;
  }

  if (grant === 'refresh_token') {
    const rt = f.refresh_token ?? '';
    const clientId = f.client_id?.trim() ?? '';
    const rec = rt ? getRefresh(rt) : undefined;
    if (!rec) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'refresh token invalid or expired' });
      return;
    }
    if (clientId && clientId !== rec.clientId) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'client_id mismatch' });
      return;
    }
    const keys = await getKeys(cfg.keysDir);
    const access = await signAccessToken(keys, {
      issuer: cfg.publicUrl,
      audience: cfg.audience,
      subject: rec.sub,
      scope: rec.scope,
      ttlSec: cfg.accessTtlSec,
    });
    sendJson(res, 200, {
      access_token: access,
      token_type: 'Bearer',
      expires_in: cfg.accessTtlSec,
      scope: rec.scope,
      refresh_token: rt,
    });
    return;
  }

  sendJson(res, 400, { error: 'unsupported_grant_type', error_description: 'use authorization_code or refresh_token' });
}

// ---- GET /userinfo ----
export async function handleUserinfo(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): Promise<void> {
  const auth = await authenticate(req, cfg);
  if (!auth) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource", error="invalid_token"`,
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  sendJson(res, 200, {
    sub: auth.sub,
    preferred_username: 'local-user',
    name: 'Local User',
    iss: cfg.publicUrl,
    aud: cfg.audience,
  });
}

// ---- GET /oauth/login (flujo browser auto-contenido) ----
export function handleLogin(_req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): void {
  const verifier = randUrl(64);
  const challenge = sha256b64url(verifier);
  const state = randUrl(16);
  saveBrowserLogin({ state, verifier, expiresAt: Date.now() + cfg.codeTtlSec * 1000 });
  const auth = new URL(`${cfg.publicUrl}/authorize`);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', BROWSER_CLIENT_ID);
  auth.searchParams.set('redirect_uri', callbackUrl(cfg));
  auth.searchParams.set('scope', DEFAULT_SCOPE);
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  redirect(res, auth.toString());
}

// ---- GET /oauth/callback ----
export async function handleCallback(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): Promise<void> {
  const previousSession = getSessionFromReq(req);
  if (!previousSession) { sendJson(res, 401, { error: 'login_required' }); return; }
  const u = new URL(req.url ?? '/', cfg.publicUrl);
  if (u.searchParams.getAll('iss').length !== 1 || u.searchParams.get('iss') !== cfg.publicUrl) {
    sendJson(res, 400, { error: 'invalid_request', error_description: 'authorization response issuer mismatch' });
    return;
  }
  const err = u.searchParams.get('error');
  if (err) {
    sendHtml(res, 400, `<h1>Autorización denegada</h1><p>${esc(err)}: ${esc(u.searchParams.get('error_description') ?? '')}</p>`);
    return;
  }
  const code = u.searchParams.get('code') ?? '';
  const state = u.searchParams.get('state') ?? '';
  const login = consumeBrowserLogin(state);
  if (!login || !code) {
    sendHtml(res, 400, `<h1>Sesión de login inválida o caducada</h1><p><a href="/oauth/login">Reintentar</a></p>`);
    return;
  }
  const rec = consumeCode(code);
  if (!rec || rec.redirectUri !== callbackUrl(cfg) || rec.clientId !== BROWSER_CLIENT_ID) {
    sendHtml(res, 400, `<h1>Código inválido</h1><p><a href="/oauth/login">Reintentar</a></p>`);
    return;
  }
  if (!verifyPkce(login.verifier, rec.codeChallenge, rec.codeChallengeMethod)) {
    sendHtml(res, 400, `<h1>PKCE inválido</h1><p><a href="/oauth/login">Reintentar</a></p>`);
    return;
  }
  const keys = await getKeys(cfg.keysDir);
  const access = await signAccessToken(keys, {
    issuer: cfg.publicUrl,
    audience: cfg.audience,
    subject: cfg.subject,
    scope: rec.scope,
    ttlSec: cfg.accessTtlSec,
  });
  const refresh = randUrl(32);
  saveRefresh({
    token: refresh,
    sub: cfg.subject,
    scope: rec.scope,
    clientId: rec.clientId,
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  });
  deleteSession(previousSession.id);
  const sess = newSession(cfg.subject, rec.scope, cfg.sessionTtlSec);
  const secure = cfg.publicUrl.startsWith('https://');
  setSessionCookie(res, sess.id, cfg.sessionTtlSec, secure);
  sendHtml(
    res,
    200,
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Sesión local activa</title></head><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Sesión local activa</h1>` +
      `<p>Ya puedes usar el MCP protegido. La cookie de sesión dura ${Math.round(cfg.sessionTtlSec / 3600)}h.</p>` +
      `<details><summary>Ver access token (caduca en ${cfg.accessTtlSec}s)</summary>` +
      `<pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:1rem">${esc(access)}</pre></details>` +
      `<p><a href="/oauth/logout">Cerrar sesión</a></p>` +
      `<p style="color:#666;font-size:.85rem">Ejemplo: <code>curl -H "Authorization: Bearer &lt;token&gt;" ${esc(cfg.publicUrl)}/.well-known/openid-configuration</code></p>` +
      `</body></html>`,
  );
}

// ---- GET /oauth/logout ----
export async function handleLogout(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): Promise<void> {
  const session = getSessionFromReq(req);
  if (!session) { redirect(res, '/oauth/login'); return; }
  if (req.method === 'GET') {
    sendHtml(res, 200, `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cerrar sesión</title></head><body><h1>Cerrar sesión</h1>` +
      `<form method="post" action="/oauth/logout"><input type="hidden" name="csrf_token" value="${esc(session.csrfToken)}"><button type="submit">Cerrar sesión</button></form></body></html>`);
    return;
  }
  const form = parseForm(await readBody(req, 8192), req.headers['content-type']);
  if (form.csrf_token !== session.csrfToken ||
      !isAllowedFormOrigin(req, cfg)) {
    sendJson(res, 403, { error: 'invalid_csrf' }); return;
  }
  deleteSession(session.id);
  clearSessionCookie(res);
  redirect(res, '/oauth/login');
}
