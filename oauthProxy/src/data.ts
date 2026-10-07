// Archivo privado compartido por el launcher y el estado OAuth del proxy.
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashPassword, validPasswordHash, verifyPassword } from './password.js';
import type { RefreshToken, Session } from './store.js';

interface Data {
  version: 1;
  login?: { password: string; hash: string };
  issuers: Record<string, { sessions: Session[]; refreshTokens: RefreshToken[] }>;
}

export function dataFile(root: string): string {
  return resolve(process.env.OAUTH_DATA_FILE?.trim() || resolve(root, 'data.json'));
}

function validRecord(value: unknown, strings: string[], numbers: string[]): boolean {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return strings.every(key => typeof rec[key] === 'string' && rec[key] !== '') &&
    numbers.every(key => typeof rec[key] === 'number' && Number.isFinite(rec[key]));
}

export function readData(path: string): Data {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, issuers: {} };
    throw new Error(`No se pudo leer el archivo de datos: ${path}`);
  }
  let data: Data;
  try {
    data = JSON.parse(raw);
    if (!data || data.version !== 1 || !data.issuers || typeof data.issuers !== 'object' || Array.isArray(data.issuers)) throw new Error();
    if (data.login !== undefined && (!validRecord(data.login, ['password', 'hash'], []) || !validPasswordHash(data.login.hash))) throw new Error();
    for (const state of Object.values(data.issuers)) {
      if (!state || !Array.isArray(state.sessions) || !Array.isArray(state.refreshTokens) ||
          !state.sessions.every(s => validRecord(s, ['id', 'csrfToken', 'sub', 'scope'], ['createdAt', 'expiresAt'])) ||
          !state.refreshTokens.every(r => validRecord(r, ['token', 'sub', 'scope', 'clientId'], ['expiresAt']))) throw new Error();
    }
  } catch { throw new Error(`Archivo de datos inválido: ${path}. No se reemplazó su contenido.`); }
  chmodSync(path, 0o600);
  return data;
}

/** Escritura atómica y sincronizada: un corte no deja un JSON parcial. */
export function writeData(path: string, data: Data): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, path);
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export async function getLoginCredentials(path: string): Promise<{ password: string; hash: string }> {
  const data = readData(path);
  if (data.login) {
    if (!await verifyPassword(data.login.password, data.login.hash)) throw new Error('La contraseña guardada no corresponde a su hash.');
    return data.login;
  }
  const password = randomBytes(32).toString('base64url');
  const login = { password, hash: await hashPassword(password) };
  // Releer antes de escribir para conservar cualquier estado ya guardado.
  const current = readData(path);
  if (current.login) return getLoginCredentials(path);
  current.login = login;
  writeData(path, current);
  return login;
}
