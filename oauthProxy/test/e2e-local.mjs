#!/usr/bin/env node
/*
 * e2e-local.mjs — Test del oauth-proxy local (sin IdP externo, sin red).
 * Levanta llamaharness (SIN api-key) + proxy y verifica:
 *  fase 1 (backend --transport http): deny-by-default, OAuth code+PKCE,
 *    userinfo, refresh, Browser session con cookie, MCP vía Bearer y vía cookie.
 *  fase 2 (backend --transport sse): stream SSE vía cookie, MCP completo sobre
 *    SSE vía Bearer, y 404 del backend (no 401) con sessionId inexistente.
 * Puertos efímeros por ejecución (o E2E_UPSTREAM_PORT / E2E_PROXY_PORT si se fijan).
 * Salida: 0 OK, 1 FAIL. El exit se hace DESPUÉS del finally para no dejar huérfanos.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHash, randomBytes } from 'node:crypto';
import { connect, createServer as createTcpServer } from 'node:net';
import { hashPassword } from '../dist/password.js';
import { exit, stderr } from 'node:process';
import { Client } from '../../llamatools/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../llamatools/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const HERE = new URL('.', import.meta.url).pathname;
const ROOT = join(HERE, '..');
const BACKEND = join(ROOT, '..', 'llamatools', 'dist', 'llamaharness.js');

/** Puerto TCP libre (evita colisiones con huérfanos de ejecuciones previas). */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT || 0) || await pickFreePort();
const PROXY_PORT = Number(process.env.E2E_PROXY_PORT || 0) || await pickFreePort();
const UPSTREAM_URL = `http://127.0.0.1:${UPSTREAM_PORT}`;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const KEYS_DIR = mkdtempSync(join(tmpdir(), 'oauth-proxy-keys-'));

const procs = [];
function launch(cmd, args, env) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  procs.push(p);
  p.stderr.on('data', (d) => stderr.write(`[${args[0]?.split('/').pop()}|${args.join(' ').match(/--transport (\w+)/)?.[1] ?? ''}] ${d}`));
  return p;
}
function kill(p) {
  try { p.kill('SIGKILL'); } catch { /* ya terminado */ }
  const i = procs.indexOf(p);
  if (i !== -1) procs.splice(i, 1);
}

let failures = 0;
function ok(m) { stderr.write(`  ✓ ${m}\n`); }
function fail(m) { stderr.write(`  ✗ ${m}\n`); failures++; }
function assert(c, m) { c ? ok(m) : fail(m); }

/** Espera a que haya algo escuchando en 127.0.0.1:port (TCP, sin semántica HTTP). */
async function waitTcp(port, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const ready = await new Promise((resolve) => {
      const s = connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ready) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await wait(200);
  }
}

/** Espera a que el puerto quede libre (tras matar el backend anterior). */
async function waitTcpClosed(port, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const open = await new Promise((resolve) => {
      const s = connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (!open) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await wait(200);
  }
}

async function waitFor(cond, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await wait(100);
  }
}

const b64u = (b) => Buffer.from(b).toString('base64url');
let ACCESS = '';
let COOKIE = '';
const PASSWORD = 'e2e-password-for-proxy';
const csrf = (html) => html.match(/name="csrf_token" value="([^"]+)"/)?.[1] ?? '';
const sessionCookie = (response) => response.headers.getSetCookie().find((c) => c.startsWith('lh_session='))?.split(';')[0] ?? '';
const formHeaders = (cookie = '') => ({ 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) });

async function phaseHttp() {
  stderr.write('— fase 1: backend --transport http\n');
  // 1) healthz + discovery + jwks públicos
  {
    const h = await fetch(`${PROXY_URL}/healthz`);
    assert(h.status === 200 && (await h.json()).issuer === PROXY_URL, 'healthz público con issuer local');
    const d = await fetch(`${PROXY_URL}/.well-known/openid-configuration`);
    const dj = await d.json();
    assert(d.status === 200 && dj.issuer === PROXY_URL && dj.code_challenge_methods_supported?.includes('S256'), 'discovery local con PKCE S256');
    assert(dj.authorization_response_iss_parameter_supported === true, 'discovery anuncia identificación del emisor RFC 9207');
    const pr = await fetch(`${PROXY_URL}/.well-known/oauth-protected-resource`);
    const resource = await pr.json();
    assert(pr.status === 200 && resource.authorization_servers?.length === 1 && resource.authorization_servers[0] === dj.issuer, 'resource metadata y discovery anuncian exactamente el mismo emisor');
    const jw = await fetch(`${PROXY_URL}/jwks.json`);
    assert(jw.status === 200 && (await jw.json()).keys?.[0]?.kty === 'RSA', 'jwks local RSA');
  }

  // 2) deny-by-default (el proxy decide antes de tocar el upstream)
  {
    const r = await fetch(`${PROXY_URL}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    const www = r.headers.get('www-authenticate') ?? '';
    assert(r.status === 401 && www.includes('oauth-protected-resource'), 'POST /mcp sin token -> 401 + resource_metadata');
    const s = await fetch(`${PROXY_URL}/sse`);
    assert(s.status === 401, 'GET /sse sin sesión -> 401');
    await s.body?.cancel().catch(() => {});
    const q = await fetch(`${PROXY_URL}/mcp?apiKey=x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert(q.status === 401, '?apiKey= legacy no hace bypass en el proxy');
  }

  // 3) flujo code + PKCE
  const verifier = b64u(randomBytes(64));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const state = b64u(randomBytes(16));
  const CLIENT = 'e2e-client';
  const REDIRECT = 'http://127.0.0.1:18923/callback';
  const authUrl = `${PROXY_URL}/authorize?response_type=code&client_id=${CLIENT}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=mcp%3Atools&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  const page = await fetch(authUrl);
  assert(page.headers.get('referrer-policy') === 'same-origin', 'formularios conservan Origin del navegador sin revelar Referer a otros sitios');
  const loginHtml = await page.text();
  const loginCookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
  const loginCsrf = csrf(loginHtml);
  assert(page.status === 200 && loginHtml.includes('type="password"') && !loginHtml.includes('/authorize/approve'), 'GET /authorize exige contraseña antes de mostrar consentimiento');
  const fields = { client_id: CLIENT, redirect_uri: REDIRECT, scope: 'mcp:tools', state, code_challenge: challenge, code_challenge_method: 'S256' };
  const bypass = await fetch(`${PROXY_URL}/authorize/approve`, { method: 'POST', headers: formHeaders(), body: new URLSearchParams(fields), redirect: 'manual' });
  assert(bypass.status === 401 && !bypass.headers.get('location'), 'approve directo sin sesión no emite código');
  const noCsrf = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: formHeaders(loginCookie), body: new URLSearchParams({ password: PASSWORD }), redirect: 'manual' });
  assert(noCsrf.status === 403 && !noCsrf.headers.get('set-cookie'), 'login sin CSRF no crea sesión');
  const noCookie = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: formHeaders(), body: new URLSearchParams({ password: PASSWORD, csrf_token: loginCsrf }), redirect: 'manual' });
  assert(noCookie.status === 403, 'login CSRF requiere cookie de la misma solicitud');
  assert((await noCookie.text()).includes('no envió la cookie'), 'login sin cookie explica cómo recuperar la conexión');
  const otherUrl = new URL(authUrl);
  otherUrl.searchParams.set('state', 'second-tab-state');
  const otherPage = await fetch(otherUrl, { headers: { cookie: loginCookie } });
  const otherCsrf = csrf(await otherPage.text());
  assert(otherPage.headers.get('set-cookie')?.split(';')[0] === loginCookie && otherCsrf !== loginCsrf, 'otra pestaña conserva cookie con contexto de formulario independiente');
  const foreignPage = await fetch(authUrl);
  const foreignCookie = foreignPage.headers.get('set-cookie')?.split(';')[0] ?? '';
  await foreignPage.body?.cancel();
  const foreignLogin = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: formHeaders(foreignCookie), body: new URLSearchParams({ password: PASSWORD, csrf_token: loginCsrf }), redirect: 'manual' });
  assert(foreignLogin.status === 403 && (await foreignLogin.text()).includes('no corresponde a la cookie'), 'formulario de otro navegador no autentica');
  const foreignOrigin = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: { ...formHeaders(loginCookie), origin: 'https://evil.example' }, body: new URLSearchParams({ password: PASSWORD, csrf_token: loginCsrf }), redirect: 'manual' });
  assert(foreignOrigin.status === 403 && (await foreignOrigin.text()).includes('URL pública'), 'login conserva validación del origen');
  const nullOrigin = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: { ...formHeaders(loginCookie), origin: 'null' }, body: new URLSearchParams({ password: PASSWORD, csrf_token: loginCsrf }), redirect: 'manual' });
  assert(nullOrigin.status === 403, 'login sigue rechazando origen opaco');
  const wrong = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: formHeaders(loginCookie), body: new URLSearchParams({ password: 'incorrecta', csrf_token: loginCsrf }), redirect: 'manual' });
  assert(wrong.status === 401 && !wrong.headers.get('set-cookie'), 'contraseña incorrecta no crea sesión');
  const signedIn = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: { ...formHeaders(loginCookie), origin: PROXY_URL }, body: new URLSearchParams({ password: PASSWORD, csrf_token: loginCsrf, returnTo: 'https://evil.example' }), redirect: 'manual' });
  COOKIE = sessionCookie(signedIn);
  assert(signedIn.status === 302 && signedIn.headers.get('location') === new URL(authUrl).pathname + new URL(authUrl).search && COOKIE, 'contraseña correcta crea sesión y conserva solicitud OAuth; ignora returnTo externo');
  const replayLogin = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: formHeaders(loginCookie), body: new URLSearchParams({ password: PASSWORD, csrf_token: loginCsrf }), redirect: 'manual' });
  assert(replayLogin.status === 403, 'login usado no se puede repetir');
  const otherSignedIn = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: formHeaders(loginCookie), body: new URLSearchParams({ password: PASSWORD, csrf_token: otherCsrf }), redirect: 'manual' });
  assert(otherSignedIn.status === 302 && otherSignedIn.headers.get('location') === otherUrl.pathname + otherUrl.search, 'segunda pestaña conserva su solicitud y puede completar login');
  const consent = await fetch(authUrl, { headers: { cookie: COOKIE } });
  const consentHtml = await consent.text();
  const consentCsrf = csrf(consentHtml);
  assert(consentHtml.includes('Autorizar acceso') && consentCsrf, 'sesión autenticada muestra consentimiento');
  assert(consent.headers.get('content-security-policy')?.includes(`form-action 'self' ${new URL(REDIRECT).origin};`), 'consentimiento permite retorno al callback validado en otro origen');
  const remoteUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const remoteFields = { ...fields, client_id: 'chatgpt', redirect_uri: remoteUri };
  const remoteUrl = new URL(authUrl);
  remoteUrl.searchParams.set('client_id', 'chatgpt');
  remoteUrl.searchParams.set('redirect_uri', remoteUri);
  for (const [key, value, error] of [['response_type', 'token', 'unsupported_response_type'], ['code_challenge', '', 'invalid_request'], ['code_challenge_method', 'invalid', 'invalid_request'], ['state', '', 'invalid_request']]) {
    const failedUrl = new URL(remoteUrl);
    failedUrl.searchParams.set(key, value);
    const failed = await fetch(failedUrl, { redirect: 'manual' });
    const returned = new URL(failed.headers.get('location'));
    assert(failed.status === 302 && returned.searchParams.get('error') === error && returned.searchParams.get('iss') === PROXY_URL, 'respuesta de error incluye emisor exacto sin requerir sesión');
  }
  const remoteConsent = await fetch(remoteUrl, { headers: { cookie: COOKIE }, redirect: 'manual' });
  const remoteCsrf = csrf(await remoteConsent.text());
  assert(remoteConsent.status === 200 && remoteCsrf, 'cliente remoto configurado obtiene consentimiento');
  assert(remoteConsent.headers.get('content-security-policy')?.includes("form-action 'self' https://chatgpt.com;"), 'CSP permite retorno configurado a ChatGPT');
  for (const overrides of [
    { redirect_uri: remoteUri + '/other' },
    { redirect_uri: remoteUri + '?extra=1' },
    { redirect_uri: 'https://chatgpt.com.evil.example/callback' },
    { redirect_uri: REDIRECT },
    { client_id: 'other-client' },
  ]) {
    const invalidUrl = new URL(remoteUrl);
    for (const [key, value] of Object.entries(overrides)) invalidUrl.searchParams.set(key, value);
    const deniedGet = await fetch(invalidUrl, { headers: { cookie: COOKIE }, redirect: 'manual' });
    const deniedPost = await fetch(`${PROXY_URL}/authorize/approve`, { method: 'POST', headers: formHeaders(COOKIE), body: new URLSearchParams({ ...remoteFields, csrf_token: remoteCsrf, ...overrides }), redirect: 'manual' });
    assert(deniedGet.status === 400 && !deniedGet.headers.get('location') && deniedPost.status === 400 && !deniedPost.headers.get('location'), 'GET y POST rechazan callback o cliente no coincidente');
  }
  const remoteApproval = await fetch(`${PROXY_URL}/authorize/approve`, { method: 'POST', headers: formHeaders(COOKIE), body: new URLSearchParams({ ...remoteFields, csrf_token: remoteCsrf }), redirect: 'manual' });
  const remoteLocation = new URL(remoteApproval.headers.get('location'));
  assert(remoteApproval.status === 302 && remoteLocation.origin + remoteLocation.pathname === remoteUri && remoteLocation.searchParams.get('state') === state, 'aprobación retorna al callback exacto con state');
  assert(remoteLocation.searchParams.getAll('iss').length === 1 && remoteLocation.searchParams.get('iss') === PROXY_URL, 'respuesta exitosa identifica emisor exacto');
  const remoteToken = await fetch(`${PROXY_URL}/token`, { method: 'POST', headers: formHeaders(), body: new URLSearchParams({ grant_type: 'authorization_code', code: remoteLocation.searchParams.get('code'), client_id: 'chatgpt', redirect_uri: remoteUri, code_verifier: verifier }) });
  assert(remoteToken.status === 200 && (await remoteToken.json()).access_token, 'cliente remoto canjea código con PKCE sin secreto');
  for (const [extra, label] of [[{}, 'ausente'], [{ csrf_token: 'forjado' }, 'forjado']]) {
    const rejected = await fetch(`${PROXY_URL}/authorize/approve`, { method: 'POST', headers: formHeaders(COOKIE), body: new URLSearchParams({ ...fields, ...extra }), redirect: 'manual' });
    assert(rejected.status === 403 && !rejected.headers.get('location'), `approve con CSRF ${label} no emite código`);
  }
  const crossOrigin = await fetch(`${PROXY_URL}/authorize/approve`, { method: 'POST', headers: { ...formHeaders(COOKIE), origin: 'https://evil.example' }, body: new URLSearchParams({ ...fields, csrf_token: consentCsrf }), redirect: 'manual' });
  assert(crossOrigin.status === 403, 'approve rechaza origen ajeno incluso con CSRF');
  const approve = await fetch(`${PROXY_URL}/authorize/approve`, {
    method: 'POST',
    headers: formHeaders(COOKIE),
    redirect: 'manual',
    body: new URLSearchParams({ csrf_token: consentCsrf, client_id: CLIENT, redirect_uri: REDIRECT, scope: 'mcp:tools', state, code_challenge: challenge, code_challenge_method: 'S256' }),
  });
  const loc = approve.headers.get('location') ?? '';
  const code = new URL(loc, REDIRECT).searchParams.get('code');
  assert(approve.status === 302 && !!code, 'POST /authorize/approve emite code y redirige');
  assert(approve.headers.get('content-security-policy')?.includes(`form-action 'self' ${new URL(REDIRECT).origin};`), 'respuesta de aprobación conserva callback validado en la política de navegación');
  const tokRes = await fetch(`${PROXY_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: code ?? '', redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier }),
  });
  const tok = await tokRes.json();
  assert(tokRes.status === 200 && tok.token_type === 'Bearer' && !!tok.access_token && !!tok.refresh_token, 'POST /token canjea code+PKCE por JWT local');
  ACCESS = tok.access_token;

  const sdkClient = new Client({ name: 'proxy-e2e', version: '1' });
  try {
    await sdkClient.connect(new StreamableHTTPClientTransport(new URL(`${PROXY_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${ACCESS}` } },
    }));
    const listed = await sdkClient.listTools();
    assert(listed.tools.some(t => t.name === 'read_file') && listed.tools.some(t => t.name === 'list_dir'), 'cliente SDK completa inicialización y descubre herramientas de archivos');
    const directory = await sdkClient.callTool({ name: 'list_dir', arguments: { path: ROOT } });
    const file = await sdkClient.callTool({ name: 'read_file', arguments: { path: join(ROOT, 'README.md'), limit: 100 } });
    assert(!directory.isError && !file.isError && directory.content?.length && file.content?.length, 'cliente SDK lista y lee archivos a través del proxy');
  } finally { await sdkClient.close(); }

  // 4) userinfo + MCP autenticado vía Bearer
  {
    const u = await fetch(`${PROXY_URL}/userinfo`, { headers: { authorization: `Bearer ${ACCESS}` } });
    assert(u.status === 200 && (await u.json()).sub === 'local-user', 'userinfo con Bearer local');
    const init = await fetch(`${PROXY_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ACCESS}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0.1.0' } } }),
    });
    const raw = await init.text();
    const m = raw.match(/data:\s*(\{.*\})/s);
    const j = JSON.parse(m ? m[1] : raw);
    for (let i = 0; i < 3; i++) {
      const notification = await fetch(`${PROXY_URL}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ACCESS}`, 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert(notification.status === 202 && notification.headers.get('content-length') === '0' && !notification.headers.has('transfer-encoding') && (await notification.text()) === '', 'notificaciones repetidas reciben 202 vacío con longitud explícita');
    }
    assert(!!j.result?.protocolVersion, 'initialize vía proxy con Bearer');
    const tools = await fetch(`${PROXY_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ACCESS}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const traw = await tools.text();
    const tm = traw.match(/data:\s*(\{.*\})/s);
    const tj = JSON.parse(tm ? tm[1] : traw);
    assert(tj.result?.tools?.some((t) => t.name === 'run_bash'), 'tools/list vía proxy con Bearer');
    const bad = await fetch(`${PROXY_URL}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer forjado' }, body: '{}' });
    assert(bad.status === 401, 'Bearer forjado -> 401');
    const refr = await fetch(`${PROXY_URL}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: CLIENT }),
    });
    assert(refr.status === 200 && !!(await refr.json()).access_token, 'refresh_token renueva access');
  }

  // 5) sesión browser con cookie (para EventSource, que no manda headers)
  {
    const login = await fetch(`${PROXY_URL}/oauth/login`, { redirect: 'manual' });
    const toAuth = login.headers.get('location') ?? '';
    assert(login.status === 302 && toAuth.includes('/authorize?'), 'GET /oauth/login redirige al authorize local');
    const aq = new URL(toAuth).searchParams;
    const browserConsent = await fetch(toAuth, { headers: { cookie: COOKIE } });
    const browserCsrf = csrf(await browserConsent.text());
    const ap = await fetch(`${PROXY_URL}/authorize/approve`, {
      method: 'POST',
      headers: formHeaders(COOKIE),
      redirect: 'manual',
      body: new URLSearchParams({
        csrf_token: browserCsrf,
        client_id: 'local-browser',
        redirect_uri: `${PROXY_URL}/oauth/callback`,
        scope: 'mcp:tools',
        state: aq.get('state') ?? '',
        code_challenge: aq.get('code_challenge') ?? '',
        code_challenge_method: 'S256',
      }),
    });
    const cb = ap.headers.get('location') ?? '';
    const deniedCallback = await fetch(cb, { redirect: 'manual' });
    assert(deniedCallback.status === 401, 'callback sin sesión no permite saltar contraseña');
    const oldCookie = COOKIE;
    for (const value of [null, 'https://other-issuer.example', PROXY_URL + '/']) {
      const mismatched = new URL(cb);
      if (value === null) mismatched.searchParams.delete('iss');
      else mismatched.searchParams.set('iss', value);
      const denied = await fetch(mismatched, { redirect: 'manual', headers: { cookie: COOKIE } });
      assert(denied.status === 400, 'callback local rechaza emisor ausente o distinto sin consumir código');
    }
    const duplicateIssuer = new URL(cb);
    duplicateIssuer.searchParams.append('iss', PROXY_URL);
    assert((await fetch(duplicateIssuer, { redirect: 'manual', headers: { cookie: COOKIE } })).status === 400, 'callback local rechaza iss duplicado');
    const cbRes = await fetch(cb, { redirect: 'manual', headers: { cookie: COOKIE } });
    const setCookie = cbRes.headers.get('set-cookie') ?? '';
    assert(cbRes.status === 200 && setCookie.includes('lh_session=') && setCookie.includes('HttpOnly'), 'callback crea cookie de sesión HttpOnly');
    COOKIE = sessionCookie(cbRes);
    const rotated = await fetch(`${PROXY_URL}/userinfo`, { headers: { cookie: oldCookie } });
    assert(rotated.status === 401 && COOKIE !== oldCookie, 'callback rota sesión y revoca cookie anterior');
    const viaCookie = await fetch(`${PROXY_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: COOKIE },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    const vraw = await viaCookie.text();
    assert(viaCookie.status === 200 && vraw.includes('run_bash'), 'tools/list con cookie de sesión (sin Bearer)');
  }

  // 6) informativo: el backend está abierto por diseño; el borde es el proxy.
  {
    const direct = await fetch(`${UPSTREAM_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    await direct.text().catch(() => {});
    stderr.write(`  (info) backend directo sin auth -> ${direct.status} (abierto por diseño, solo loopback)\n`);
  }
}

async function phaseSse() {
  stderr.write('— fase 2: backend --transport sse\n');
  // GET /sse sin credencial sigue 401 (independiente del transporte upstream).
  {
    const s = await fetch(`${PROXY_URL}/sse`);
    assert(s.status === 401, 'GET /sse sin sesión -> 401 (backend sse)');
    await s.body?.cancel().catch(() => {});
  }
  // Stream SSE autenticado con cookie.
  const ctrl = new AbortController();
  const sse = await fetch(`${PROXY_URL}/sse`, { headers: { cookie: COOKIE }, signal: ctrl.signal });
  assert(sse.status === 200 && (sse.headers.get('content-type') ?? '').includes('text/event-stream'), 'GET /sse con cookie abre stream');
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    } catch { /* abort al cerrar */ }
  })();
  const gotEndpoint = await waitFor(() => /sessionId=/.test(buf), 5000);
  assert(gotEndpoint, 'stream entrega evento endpoint con sessionId');
  const sid = buf.match(/sessionId=([A-Za-z0-9_-]+)/)?.[1] ?? '';
  assert(!!sid, 'sessionId extraído del stream');

  const postMsg = (body) =>
    fetch(`${PROXY_URL}/messages?sessionId=${sid}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS}` },
      body: JSON.stringify(body),
    });
  // MCP completo sobre SSE: initialize -> initialized -> tools/list.
  {
    const init = await postMsg({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0.1.0' } } });
    assert(init.status === 202, 'POST initialize sobre SSE -> 202');
    await init.text().catch(() => {});
    assert(await waitFor(() => buf.includes('"id":1') && buf.includes('protocolVersion'), 5000), 'resultado initialize llega por el stream');
    const noted = await postMsg({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert(noted.status === 202, 'POST notifications/initialized -> 202');
    await noted.text().catch(() => {});
    const tools = await postMsg({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert(tools.status === 202, 'POST tools/list sobre SSE -> 202');
    await tools.text().catch(() => {});
    assert(await waitFor(() => buf.includes('"id":2') && buf.includes('run_bash'), 5000), 'tools/list sobre SSE devuelve run_bash por el stream');
  }
  // Pass-through: Bearer válido pero sesión inexistente llega al upstream (404 suyo, no 401).
  {
    const fwd = await fetch(`${PROXY_URL}/messages?sessionId=nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    await fwd.text().catch(() => {});
    assert(fwd.status === 404, 'Bearer válido llega al upstream (404 backend, no 401)');
  }
  ctrl.abort();
  await pump;
}


async function phaseLoginSecurity() {
  const logout = await fetch(`${PROXY_URL}/oauth/logout`, { headers: { cookie: COOKIE } });
  const token = csrf(await logout.text());
  const stillActive = await fetch(`${PROXY_URL}/userinfo`, { headers: { cookie: COOKIE } });
  assert(stillActive.status === 200, 'GET logout solo muestra confirmación');
  const invalid = await fetch(`${PROXY_URL}/oauth/logout`, { method: 'POST', headers: formHeaders(COOKIE), body: new URLSearchParams(), redirect: 'manual' });
  assert(invalid.status === 403, 'logout requiere CSRF');
  const loggedOut = await fetch(`${PROXY_URL}/oauth/logout`, { method: 'POST', headers: formHeaders(COOKIE), body: new URLSearchParams({ csrf_token: token }), redirect: 'manual' });
  const denied = await fetch(`${PROXY_URL}/userinfo`, { headers: { cookie: COOKIE } });
  assert(loggedOut.status === 302 && denied.status === 401, 'logout invalida sesión en el servidor');
  const login = await fetch(`${PROXY_URL}/oauth/login`, { redirect: 'manual' });
  const page = await fetch(login.headers.get('location'));
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const loginToken = csrf(await page.text());
  for (let i = 0; i < 5; i++) {
    const wrong = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: formHeaders(cookie), body: new URLSearchParams({ password: 'incorrecta', csrf_token: loginToken }), redirect: 'manual' });
    assert(wrong.status === 401, `intento fallido ${i + 1} rechazado`);
  }
  const blocked = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: { ...formHeaders(cookie), 'x-forwarded-for': '1.2.3.4' }, body: new URLSearchParams({ password: PASSWORD, csrf_token: loginToken }), redirect: 'manual' });
  assert(blocked.status === 429 && Number(blocked.headers.get('retry-after')) > 0 && !sessionCookie(blocked), 'límite de intentos bloquea nuevas verificaciones e ignora IP falsificada');
  const newPage = await fetch(login.headers.get('location'));
  const freshCookie = newPage.headers.get('set-cookie').split(';')[0];
  const freshToken = csrf(await newPage.text());
  const freshBlocked = await fetch(`${PROXY_URL}/oauth/signin`, { method: 'POST', headers: formHeaders(freshCookie), body: new URLSearchParams({ password: PASSWORD, csrf_token: freshToken }), redirect: 'manual' });
  assert(freshBlocked.status === 429, 'abrir otro formulario no reinicia el límite');
}

async function main() {
  // Backend SIN api-key (abierto por diseño): el proxy es el único borde.
  let backend = launch('node', [BACKEND, '--transport', 'http', '--host', '127.0.0.1', '--port', String(UPSTREAM_PORT)], {});
  launch('node', [join(ROOT, 'dist', 'index.js')], {
    PROXY_HOST: '127.0.0.1',
    PROXY_PORT: String(PROXY_PORT),
    UPSTREAM_URL,
    KEYS_DIR,
    OAUTH_DATA_FILE: join(KEYS_DIR, 'data.json'),
    SESSION_SECRET: 'e2e-test-secret',
    OAUTH_PASSWORD_HASH: await hashPassword(PASSWORD),
    OAUTH_CLIENT_ID: 'chatgpt',
    OAUTH_REDIRECT_URI: '',
    PROXY_PUBLIC_URL: PROXY_URL,
  });
  assert(await waitTcp(UPSTREAM_PORT), 'backend http escuchando');
  assert(await waitTcp(PROXY_PORT), 'proxy escuchando');
  await phaseHttp();

  // Fase 2: mismo proxy y puerto, backend en modo sse.
  kill(backend);
  assert(await waitTcpClosed(UPSTREAM_PORT), 'puerto liberado tras matar backend http');
  backend = launch('node', [BACKEND, '--transport', 'sse', '--host', '127.0.0.1', '--port', String(UPSTREAM_PORT)], {});
  assert(await waitTcp(UPSTREAM_PORT), 'backend sse escuchando');
  await phaseSse();
  await phaseLoginSecurity();

  if (failures === 0) stderr.write('\nE2E-LOCAL PASS\n');
  else stderr.write(`\nE2E-LOCAL FAIL (${failures})\n`);
  return failures === 0 ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  fail(`error: ${e?.message ?? String(e)}`);
  code = 1;
} finally {
  for (const p of [...procs]) kill(p);
  try { rmSync(KEYS_DIR, { recursive: true, force: true }); } catch { /* tmp */ }
}
exit(code);
