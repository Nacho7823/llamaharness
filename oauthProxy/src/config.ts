// config.ts — Configuración 100% local. Sin IdP externo, sin fallback a Google.
// El proxy es emisor (iss) y verificador a la vez. El `iss` es siempre el propio proxy.
import { randomBytes } from 'node:crypto';
import { validPasswordHash } from './password.js';

// Callback estable publicado por OpenAI para emisores compatibles con RFC 9207.
export const CHATGPT_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';

export interface ProxyConfig {
  proxyHost: string;
  proxyPort: number;
  /** URL pública del proxy, usada como `iss` y base de discovery. */
  publicUrl: string;
  /** Base del backend llamaharness, p.ej. http://127.0.0.1:9908. Debe ser loopback. */
  upstreamUrl: string;
  audience: string;
  subject: string;
  passwordHash: string;
  /** Cliente remoto preconfigurado, con una URI de retorno exacta. */
  externalClient?: { id: string; redirectUri: string };
  accessTtlSec: number;
  codeTtlSec: number;
  sessionTtlSec: number;
  sessionSecret: string;
  sessionSecretEphemeral: boolean;
  keysDir: string;
}

function num(env: string | undefined, def: number): number {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function isLoopbackUpstream(upstreamUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(upstreamUrl);
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
}

function normalizePublicUrl(host: string, port: number, override?: string): string {
  if (override?.trim()) return override.trim().replace(/\/$/, '');
  // 0.0.0.0 no es un `iss` válido: se normaliza a 127.0.0.1 para que iss/aud sean estables.
  const h = host === '0.0.0.0' ? '127.0.0.1' : host;
  return `http://${h}:${port}`;
}

export function loadConfig(keysDirFallback: string): ProxyConfig {
  const proxyHost = process.env.PROXY_HOST?.trim() || '127.0.0.1';
  const proxyPort = num(process.env.PROXY_PORT, 9910);
  const publicUrl = normalizePublicUrl(proxyHost, proxyPort, process.env.PROXY_PUBLIC_URL);
  const upstreamUrl = (process.env.UPSTREAM_URL?.trim() || 'http://127.0.0.1:9908').replace(/\/$/, '');

  if (!isLoopbackUpstream(upstreamUrl)) {
    // El backend llamaharness corre SIN api-key (abierto). Exponerlo fuera de loopback
    // dejaría las tools (bash/fs) abiertas a red. Abortamos antes de escuchar.
    console.error(
      `[oauth-proxy] FATAL: UPSTREAM_URL debe ser loopback (127.0.0.1/localhost/::1). Recibido: ${upstreamUrl}`,
    );
    process.exit(1);
  }

  const passwordHash = process.env.OAUTH_PASSWORD_HASH?.trim() || '';
  if (!validPasswordHash(passwordHash)) {
    throw new Error('OAUTH_PASSWORD_HASH es obligatorio y debe generarse con pnpm password:hash.');
  }
  const publicEndpoint = new URL(publicUrl);
  if (publicEndpoint.protocol !== 'https:' &&
      !(publicEndpoint.protocol === 'http:' && isLoopbackUpstream(publicUrl) &&
        isLoopbackUpstream(`http://${proxyHost.includes(':') ? `[${proxyHost}]` : proxyHost}`))) {
    throw new Error('El acceso con contraseña requiere HTTPS salvo en loopback local.');
  }

  const redirectUri = process.env.OAUTH_REDIRECT_URI?.trim() || CHATGPT_REDIRECT_URI;
  let externalClient: ProxyConfig['externalClient'];
  if (redirectUri) {
    let callback: URL;
    try { callback = new URL(redirectUri); }
    catch { throw new Error('OAUTH_REDIRECT_URI debe ser una URL HTTPS completa.'); }
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) {
      throw new Error('OAUTH_REDIRECT_URI debe usar HTTPS, sin credenciales ni fragmento.');
    }
    const id = process.env.OAUTH_CLIENT_ID?.trim() || 'chatgpt';
    if (id === 'local-browser') throw new Error('OAUTH_CLIENT_ID local-browser está reservado para el login del navegador.');
    externalClient = { id, redirectUri };
  }

  let sessionSecret = process.env.SESSION_SECRET?.trim() || '';
  let ephemeral = false;
  if (!sessionSecret) {
    // Solo dev: secreto efímero (las sesiones se invalidan al reiniciar). En prod fijar SESSION_SECRET.
    sessionSecret = randomBytes(32).toString('hex');
    ephemeral = true;
  }

  return {
    proxyHost,
    proxyPort,
    publicUrl,
    upstreamUrl,
    audience: process.env.OAUTH_AUDIENCE?.trim() || 'llamaharness-local',
    subject: 'local-user',
    passwordHash,
    externalClient,
    accessTtlSec: num(process.env.ACCESS_TTL_SEC, 300),
    codeTtlSec: 300,
    sessionTtlSec: num(process.env.SESSION_TTL_SEC, 12 * 3600),
    sessionSecret,
    sessionSecretEphemeral: ephemeral,
    keysDir: process.env.KEYS_DIR?.trim() || keysDirFallback,
  };
}
