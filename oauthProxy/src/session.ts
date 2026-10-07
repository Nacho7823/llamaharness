// session.ts — Sesión browser vía cookie `lh_session` (id opaco, estado en servidor).
// La cookie solo existe para navegadores (EventSource no manda Authorization).
// Los clientes MCP usan `Authorization: Bearer <JWT>` y no necesitan cookie.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSession, deleteSession, getSession, type Session } from './store.js';

export const SESSION_COOKIE = 'lh_session';

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch { /* Ignorar cookies malformadas. */ }
    }
  }
  return out;
}

export function getSessionFromReq(req: IncomingMessage): Session | undefined {
  const id = parseCookies(req)[SESSION_COOKIE];
  if (!id) return undefined;
  return getSession(id);
}

export function setSessionCookie(res: ServerResponse, id: string, maxAgeSec: number, secure: boolean): void {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(id)}`, 'Path=/', 'HttpOnly', `Max-Age=${maxAgeSec}`, 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  const prev = res.getHeader('set-cookie');
  const next = [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), parts.join('; ')];
  res.setHeader('set-cookie', next);
}

export function clearSessionCookie(res: ServerResponse): void {
  const prev = res.getHeader('set-cookie');
  const clear = `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []), clear]);
}

export function newSession(sub: string, scope: string, ttlSec: number): Session {
  return createSession(sub, scope, ttlSec);
}

export { deleteSession };
