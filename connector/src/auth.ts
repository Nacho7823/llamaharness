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
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

const CLIENT_ID = contracts.TunnelServiceProperties.production.gitHubAppClientId;

export function cachedToken(state: ConnectorState, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | undefined {
  if (env.DEV_TUNNELS_GITHUB_TOKEN) return env.DEV_TUNNELS_GITHUB_TOKEN.trim();
  const auth = state.auth;
  if (auth?.accessToken && (!auth.expiresAt || auth.expiresAt > now + 60_000)) return auth.accessToken;
}

export async function deviceLogin({ signal, fetcher = fetch, wait = delay, log = console.log, now = Date.now }: DeviceLoginOptions): Promise<AuthState> {

  const device = await githubRequest('device/code', { scope: 'offline_access' }, { signal, fetcher });
  if (!device.device_code || !device.user_code || !device.verification_uri || !device.expires_in) {
    throw new Error('GitHub no habilitó la identificación por código para Dev Tunnels.');
  }
  log(`\nAutorizá Dev Tunnels en ${device.verification_uri}\nCódigo: ${device.user_code}\nEsperando autorización…`);
  const deadline = now() + device.expires_in * 1000;
  let interval = Math.max(device.interval || 5, 5) * 1000;
  while (now() < deadline) {
    await wait(interval, undefined, { signal });
    const result = await githubRequest('oauth/access_token', {
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, { signal, fetcher });
    if (result.access_token) {
      return authState(result, now());
    }
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') { interval += 5000; continue; }
    throw new Error('La autorización de GitHub venció o fue rechazada. Ejecutá pnpm start otra vez.');
  }
  throw new Error('El código de GitHub venció. Ejecutá pnpm start otra vez.');
}

async function githubRequest(endpoint: string, fields: Record<string, string>, { signal, fetcher = fetch }: Pick<DeviceLoginOptions, 'signal' | 'fetcher'>): Promise<GitHubResponse> {
  const response = await fetcher(`https://github.com/login/${endpoint}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
    signal: AbortSignal.any(signal ? [signal, AbortSignal.timeout(30_000)] : [AbortSignal.timeout(30_000)]),
  });
  const result: GitHubResponse = await response.json();
  const rejectedRefresh = response.status === 400 && ['bad_refresh_token', 'invalid_grant', 'expired_token', 'access_denied'].includes(result.error ?? '');
  if (!response.ok && !rejectedRefresh) throw new Error(`GitHub respondió HTTP ${response.status} durante la identificación.`);
  return result;
}

function authState(result: GitHubResponse, now: number): AuthState {
  if (!result.access_token) throw new Error('GitHub no devolvió un access token.');
  return {
    accessToken: result.access_token,
    ...(result.expires_in ? { expiresAt: now + result.expires_in * 1000 } : {}),
    ...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
    ...(result.refresh_token_expires_in ? { refreshExpiresAt: now + result.refresh_token_expires_in * 1000 } : {}),
  };
}

export async function refreshAuth(auth: AuthState, options: Pick<DeviceLoginOptions, 'signal' | 'fetcher' | 'now'> = {}): Promise<AuthState | undefined> {
  const now = options.now ?? Date.now;
  if (!auth.refreshToken || (auth.refreshExpiresAt !== undefined && auth.refreshExpiresAt <= now())) return;
  const result = await githubRequest('oauth/access_token', {
    grant_type: 'refresh_token', refresh_token: auth.refreshToken,
  }, options);
  if (['bad_refresh_token', 'invalid_grant', 'expired_token', 'access_denied'].includes(result.error ?? '')) return;
  if (result.error) throw new Error('GitHub no pudo renovar la autorización. Se conservaron las credenciales.');
  if (!result.access_token || !result.refresh_token) throw new Error('GitHub no devolvió los dos tokens renovados.');
  return authState(result, now());
}

interface TokenProviderOptions extends Pick<DeviceLoginOptions, 'signal' | 'fetcher' | 'log' | 'now'> {
  state: ConnectorState;
  save: (state: ConnectorState) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  login?: typeof deviceLogin;
}

export function createTokenProvider({ state, save, signal, fetcher, log = console.log, now = Date.now, env = process.env, login = deviceLogin }: TokenProviderOptions) {
  let pending: Promise<string> | undefined;
  let pendingSave = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let automatic = false;

  async function persist() {
    await save(state);
    pendingSave = false;
  }

  async function obtain(force: boolean): Promise<string> {
    signal?.throwIfAborted();
    if (pendingSave) await persist();
    if (env.DEV_TUNNELS_GITHUB_TOKEN?.trim()) return env.DEV_TUNNELS_GITHUB_TOKEN.trim();
    const cached = cachedToken(state, {}, now());
    if (cached && !force) return cached;
    const refreshed = state.auth ? await refreshAuth(state.auth, { signal, fetcher, now }) : undefined;
    if (refreshed) {
      // El intercambio invalida los tokens anteriores. Conservar los nuevos en
      // memoria y reintentar su escritura si falla, sin volver a intercambiarlos.
      state.auth = refreshed;
      pendingSave = true;
      await persist();
      return refreshed.accessToken;
    }
    if (state.auth) {
      delete state.auth;
      pendingSave = true;
      await persist();
    }
    state.auth = await login({ signal, fetcher, now, log });
    pendingSave = true;
    await persist();
    return state.auth.accessToken;
  }

  function schedule(retry?: number) {
    if (timer) clearTimeout(timer);
    if (!automatic || disposed || signal?.aborted || env.DEV_TUNNELS_GITHUB_TOKEN?.trim() || !state.auth?.expiresAt) return;
    const wait = retry ?? Math.min(3_600_000, Math.max(1000, state.auth.expiresAt - now() - 60_000));
    timer = setTimeout(() => {
      getToken().catch(() => {
        if (disposed || signal?.aborted) return;
        log('[connector] No se pudo renovar la autorización de GitHub; se reintentará en 30 segundos.');
        schedule(30_000);
      });
    }, wait);
    timer.unref();
  }

  function getToken(force = false): Promise<string> {
    // El SDK y el temporizador comparten la renovación para no utilizar dos
    // veces un refresh token, que GitHub permite intercambiar una única vez.
    if (!pending) {
      pending = obtain(force).then(token => { schedule(); return token; }).finally(() => { pending = undefined; });
    }
    return pending;
  }

  function dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', dispose);
  }
  signal?.addEventListener('abort', dispose, { once: true });
  return { getToken, startAutoRefresh() { automatic = true; schedule(); }, dispose };
}
