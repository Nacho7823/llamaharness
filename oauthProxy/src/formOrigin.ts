import type { IncomingMessage } from 'node:http';
import type { ProxyConfig } from './config.js';

/** Validar formularios sin confiar de forma general en cabeceras reenviadas. */
export function isAllowedFormOrigin(req: IncomingMessage, cfg: ProxyConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const endpoint = new URL(cfg.publicUrl);
  if (origin === endpoint.origin) return true;

  // Dev Tunnels reescribe Origin al destino local. Esta excepción solo aplica
  // al túnel configurado, desde loopback y a navegación del mismo origen.
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.devtunnels.ms') ||
      req.headers['sec-fetch-site'] !== 'same-origin') return false;
  const address = req.socket.remoteAddress;
  if (!address || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const localOrigins = ['http:', 'https:'].flatMap(protocol =>
    ['localhost', '127.0.0.1', '[::1]'].map(host => `${protocol}//${host}:${cfg.proxyPort}`));
  if (!localOrigins.includes(origin)) return false;
  const forwardedHost = req.headers['x-forwarded-host'];
  if (forwardedHost !== undefined) return forwardedHost === endpoint.host;
  return ['localhost', '127.0.0.1', '[::1]'].some(host => req.headers.host === `${host}:${cfg.proxyPort}`);
}
