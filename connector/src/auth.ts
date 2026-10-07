import { setTimeout as delay } from 'node:timers/promises';
import contracts from '@microsoft/dev-tunnels-contracts';
import type { ConnectorState, AuthState } from './state.js';

interface DeviceLoginOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  wait?: typeof delay;
  log?: (message: string) => void;
  now?: () => number;
}

interface GitHubResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  access_token?: string;
  error?: string;
}

const CLIENT_ID = contracts.TunnelServiceProperties.production.gitHubAppClientId;

export function cachedToken(state: ConnectorState, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | undefined {
  if (env.DEV_TUNNELS_GITHUB_TOKEN) return env.DEV_TUNNELS_GITHUB_TOKEN.trim();
  const auth = state.auth;
  if (auth?.accessToken && (!auth.expiresAt || auth.expiresAt > now + 60_000)) return auth.accessToken;
}

export async function deviceLogin({ signal, fetcher = fetch, wait = delay, log = console.log, now = Date.now }: DeviceLoginOptions): Promise<AuthState> {
  async function request(endpoint: string, fields: Record<string, string>): Promise<GitHubResponse> {
    const response = await fetcher(`https://github.com/login/${endpoint}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
      signal: AbortSignal.any(signal ? [signal, AbortSignal.timeout(30_000)] : [AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error(`GitHub respondió HTTP ${response.status} durante la identificación.`);
    return response.json();
  }

  const device = await request('device/code', {});
  if (!device.device_code || !device.user_code || !device.verification_uri || !device.expires_in) {
    throw new Error('GitHub no habilitó la identificación por código para Dev Tunnels.');
  }
  log(`\nAutorizá Dev Tunnels en ${device.verification_uri}\nCódigo: ${device.user_code}\nEsperando autorización…`);
  const deadline = now() + device.expires_in * 1000;
  let interval = Math.max(device.interval || 5, 5) * 1000;
  while (now() < deadline) {
    await wait(interval, undefined, { signal });
    const result = await request('oauth/access_token', {
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (result.access_token) {
      return {
        accessToken: result.access_token,
        ...(result.expires_in ? { expiresAt: now() + result.expires_in * 1000 } : {}),
      };
    }
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') { interval += 5000; continue; }
    throw new Error('La autorización de GitHub venció o fue rechazada. Ejecutá pnpm start otra vez.');
  }
  throw new Error('El código de GitHub venció. Ejecutá pnpm start otra vez.');
}
