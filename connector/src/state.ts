import { readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { errorCode } from './errors.js';

export interface AuthState {
  accessToken: string;
  expiresAt?: number;
}

export interface TunnelReference {
  tunnelId: string;
  clusterId: string;
}

export interface ConnectorState {
  version: 1;
  auth?: AuthState;
  tunnel?: TunnelReference;
  publicUrl?: string;
}

export async function readState(path: string): Promise<ConnectorState> {
  try {
    const state: ConnectorState = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1) throw new Error('Versión de data.json no compatible.');
    await chmod(path, 0o600);
    return state;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { version: 1 };
    throw error;
  }
}

export async function writeState(path: string, state: ConnectorState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }
}
