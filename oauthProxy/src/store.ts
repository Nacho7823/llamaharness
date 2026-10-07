// Sesiones y refresh tokens persistentes; códigos y formularios de login efímeros.
import { createHash, randomBytes } from 'node:crypto';
import { readData, writeData } from './data.js';

export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256' | 'plain';
  scope: string;
  expiresAt: number;
  used: boolean;
}

export interface RefreshToken {
  token: string;
  sub: string;
  scope: string;
  clientId: string;
  expiresAt: number;
}

export interface Session {
  csrfToken: string;
  id: string;
  sub: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

export interface BrowserLogin {
  state: string;
  verifier: string;
  expiresAt: number;
}

const codes = new Map<string, AuthCode>();
const refreshes = new Map<string, RefreshToken>();
const sessions = new Map<string, Session>();
const logins = new Map<string, BrowserLogin>();
let persistence: { path: string; issuer: string } | undefined;

export function initializeStore(path: string, issuer: string): void {
  const data = readData(path);
  const state = data.issuers[issuer];
  sessions.clear(); refreshes.clear(); codes.clear(); logins.clear();
  const now = Date.now();
  for (const session of state?.sessions ?? []) if (session.expiresAt > now) sessions.set(session.id, session);
  for (const refresh of state?.refreshTokens ?? []) if (refresh.expiresAt > now) refreshes.set(refresh.token, refresh);
  persistence = { path, issuer };
  persist();
}

function persist(): void {
  if (!persistence) return;
  const data = readData(persistence.path);
  const now = Date.now();
  data.issuers[persistence.issuer] = {
    sessions: [...sessions.values()].filter(s => s.expiresAt > now),
    refreshTokens: [...refreshes.values()].filter(r => r.expiresAt > now),
  };
  writeData(persistence.path, data);
}

export function randUrl(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256b64url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function verifyPkce(verifier: string, challenge: string, method: 'S256' | 'plain'): boolean {
  if (!verifier || !challenge) return false;
  if (method === 'plain') return verifier === challenge;
  return sha256b64url(verifier) === challenge;
}

export function saveCode(c: Omit<AuthCode, 'used'>): AuthCode {
  const rec: AuthCode = { ...c, used: false };
  codes.set(c.code, rec);
  return rec;
}

export function consumeCode(code: string): AuthCode | undefined {
  const rec = codes.get(code);
  if (!rec || rec.used || rec.expiresAt < Date.now()) {
    codes.delete(code);
    return undefined;
  }
  rec.used = true;
  codes.delete(code);
  return rec;
}

export function saveRefresh(r: RefreshToken): void {
  refreshes.set(r.token, r);
  persist();
}

export function getRefresh(token: string): RefreshToken | undefined {
  const r = refreshes.get(token);
  if (!r || r.expiresAt < Date.now()) {
    if (r) { refreshes.delete(token); persist(); }
    return undefined;
  }
  return r;
}

export function createSession(sub: string, scope: string, ttlSec: number): Session {
  const now = Date.now();
  const s: Session = { csrfToken: randUrl(32), id: randUrl(32), sub, scope, createdAt: now, expiresAt: now + ttlSec * 1000 };
  sessions.set(s.id, s);
  persist();
  return s;
}

export function getSession(id: string): Session | undefined {
  const s = sessions.get(id);
  if (!s || s.expiresAt < Date.now()) {
    if (s) { sessions.delete(id); persist(); }
    return undefined;
  }
  return s;
}

export function deleteSession(id: string): void {
  if (sessions.delete(id)) persist();
}

export function saveBrowserLogin(l: BrowserLogin): void {
  logins.set(l.state, l);
}

export function consumeBrowserLogin(state: string): BrowserLogin | undefined {
  const l = logins.get(state);
  if (!l || l.expiresAt < Date.now()) {
    if (l) logins.delete(state);
    return undefined;
  }
  logins.delete(state);
  return l;
}

// Limpieza periódica (codes/logins de 5min, refresh/sesiones caducadas).
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expiresAt < now || v.used) codes.delete(k);
  let changed = false;
  for (const [k, v] of refreshes) if (v.expiresAt <= now) { refreshes.delete(k); changed = true; }
  for (const [k, v] of sessions) if (v.expiresAt <= now) { sessions.delete(k); changed = true; }
  for (const [k, v] of logins) if (v.expiresAt < now) logins.delete(k);
  if (changed) {
    try { persist(); } catch { console.error('[oauth-proxy] No se pudo guardar la limpieza de sesiones.'); }
  }
}, 60_000).unref?.();
