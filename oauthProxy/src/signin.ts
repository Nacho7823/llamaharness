import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProxyConfig } from './config.js';
import { randUrl } from './store.js';
import { deleteSession, newSession, parseCookies, setSessionCookie } from './session.js';
import { esc, parseForm, readBody, redirect, sendHtml, sendJson } from './httpUtils.js';
import { verifyPassword } from './password.js';
import { isAllowedFormOrigin } from './formOrigin.js';

interface Login { browserId: string; csrf: string; returnTo: string; expiresAt: number }
interface Attempts { count: number; expiresAt: number }
const logins = new Map<string, Login>();
const attempts = new Map<string, Attempts>();
const LOGIN_COOKIE = 'lh_login';
const WINDOW = 15 * 60 * 1000;
let activeChecks = 0;

function cleanup(): void {
  const now = Date.now();
  for (const [id, login] of logins) if (login.expiresAt <= now) logins.delete(id);
  for (const [ip, entry] of attempts) if (entry.expiresAt <= now) attempts.delete(ip);
}
setInterval(cleanup, 60_000).unref();

function loginCookie(res: ServerResponse, id: string, cfg: ProxyConfig, age = 300): void {
  res.setHeader('set-cookie', `${LOGIN_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${cfg.publicUrl.startsWith('https://') ? '; Secure' : ''}`);
}

function showLogin(res: ServerResponse, login: Login, status = 200, message = ''): void {
  sendHtml(res, status, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ingresar — llamaharness</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem"><h1>Ingresar</h1><p>Ingresá la contraseña del proxy para continuar.</p>` +
    (message ? `<p role="alert">${esc(message)}</p>` : '') +
    `<form method="post" action="/oauth/signin"><input type="hidden" name="csrf_token" value="${esc(login.csrf)}">` +
    `<label>Contraseña <input type="password" name="password" autocomplete="current-password" required autofocus></label> <button type="submit">Continuar</button></form></body></html>`);
}

function invalidLogin(res: ServerResponse, reason: string): void {
  // Diagnóstico sin contraseñas, cookies, tokens ni parámetros de autorización.
  console.warn(`[oauth-proxy] Login rechazado: ${reason}`);
  sendHtml(res, 403, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Volver a conectar</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem"><h1>Volvé a iniciar la conexión</h1><p>${esc(reason)}</p>` +
    `<p>Si estabas conectando ChatGPT, cerrá esta pestaña y pulsá Conectar otra vez en ChatGPT. Usá la dirección HTTPS actual del túnel y permití las cookies de esa página.</p>` +
    `<p>Si reiniciaste el proxy, usá la nueva contraseña que imprime la terminal.</p></body></html>`);
}

// El destino se genera en /authorize y se conserva en el servidor, no en el formulario.
export function requirePassword(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): void {
  cleanup();
  if (logins.size >= 1000) { sendJson(res, 429, { error: 'too_many_requests' }); return; }
  const destination = new URL(req.url ?? '/', cfg.publicUrl);
  if (destination.origin !== new URL(cfg.publicUrl).origin || destination.pathname !== '/authorize') {
    sendJson(res, 400, { error: 'invalid_request' }); return;
  }
  const previous = parseCookies(req)[LOGIN_COOKIE];
  // Cada formulario mantiene su contexto; abrir otra pestaña no invalida el anterior.
  const id = previous && /^[A-Za-z0-9_-]{43}$/.test(previous) ? previous : randUrl(32);
  const login = { browserId: id, csrf: randUrl(32), returnTo: destination.pathname + destination.search, expiresAt: Date.now() + 300_000 };
  logins.set(login.csrf, login);
  loginCookie(res, id, cfg);
  showLogin(res, login);
}

export async function handleSignin(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): Promise<void> {
  cleanup();
  const id = parseCookies(req)[LOGIN_COOKIE] ?? '';
  const form = parseForm(await readBody(req, 8192), req.headers['content-type']);
  const login = logins.get(form.csrf_token ?? '');
  if (!id) return invalidLogin(res, 'El navegador no envió la cookie necesaria para iniciar sesión.');
  if (!form.csrf_token) return invalidLogin(res, 'El formulario llegó sin el token necesario para verificar el login.');
  if (!login || login.expiresAt <= Date.now()) return invalidLogin(res, 'El formulario venció, ya fue usado o pertenece a un arranque anterior del proxy.');
  if (login.browserId !== id) return invalidLogin(res, 'El formulario no corresponde a la cookie de este navegador.');
  if (!isAllowedFormOrigin(req, cfg)) {
    return invalidLogin(res, 'La dirección desde la que se envió el formulario no coincide con la URL pública del proxy.');
  }
  // No confiar en X-Forwarded-For: un cliente podría falsificarlo para evitar el límite.
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (!attempts.has(ip) && attempts.size >= 1000) { sendJson(res, 429, { error: 'too_many_requests' }); return; }
  const entry = attempts.get(ip) ?? { count: 0, expiresAt: Date.now() + WINDOW };
  if (entry.count >= 5 || activeChecks >= 2) {
    res.setHeader('retry-after', String(Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000))));
    showLogin(res, login, 429, 'Demasiados intentos. Esperá unos minutos antes de volver a intentar.'); return;
  }
  entry.count++;
  attempts.set(ip, entry);
  activeChecks++;
  let valid: boolean;
  try { valid = await verifyPassword(form.password ?? '', cfg.passwordHash); }
  finally { activeChecks--; }
  if (!valid) { showLogin(res, login, 401, 'Contraseña incorrecta.'); return; }
  // Una misma solicitud de login no puede crear dos sesiones concurrentes.
  if (logins.get(login.csrf) !== login || login.expiresAt <= Date.now()) {
    return invalidLogin(res, 'El formulario venció o ya fue usado.');
  }
  logins.delete(login.csrf);
  attempts.delete(ip);
  const oldSession = parseCookies(req).lh_session;
  if (oldSession) deleteSession(oldSession);
  const session = newSession(cfg.subject, 'mcp:tools', cfg.sessionTtlSec);
  // Conservar la cookie de contexto para otros formularios abiertos; no autentica.
  setSessionCookie(res, session.id, cfg.sessionTtlSec, cfg.publicUrl.startsWith('https://'));
  redirect(res, login.returnTo);
}
