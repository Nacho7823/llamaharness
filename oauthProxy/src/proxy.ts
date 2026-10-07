// proxy.ts — Reverse proxy con deny-by-default hacia llamaharness (sin api-key, solo loopback).
// - Valida Bearer JWT local o cookie de sesión ANTES de tocar el upstream.
// - Stripea `authorization`, `x-api-key`, `cookie` y `?apiKey=` al reenviar: el backend
//   corre abierto y esos valores son solo del borde (evita que el fallback legacy
//   `?apiKey=` de sse.ts se convierta en vía de entrada si una URL se reutiliza).
// - Streaming SSE sin bufferizar (pipe directo).
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ProxyConfig } from './config.js';
import { authenticate, sendAuthRequired } from './auth.js';

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** Quita del query los fallbacks legacy de api-key antes de reenviar al backend abierto. */
export function stripUpstreamSearch(search: string): string {
  const p = new URLSearchParams(search);
  p.delete('apiKey');
  p.delete('api_key');
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function handleProxy(req: IncomingMessage, res: ServerResponse, cfg: ProxyConfig): Promise<void> {
  const auth = await authenticate(req, cfg);
  if (!auth) {
    sendAuthRequired(res, cfg.publicUrl);
    return;
  }

  const incoming = new URL(req.url ?? '/', cfg.publicUrl);
  const upstream = new URL(cfg.upstreamUrl);
  upstream.pathname = incoming.pathname;
  upstream.search = stripUpstreamSearch(incoming.search);

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_HEADERS.has(lk)) continue;
    if (lk === 'authorization' || lk === 'x-api-key' || lk === 'cookie') continue; // credenciales del borde, no del backend
    if (v !== undefined) headers[k] = v;
  }

  const isTls = upstream.protocol === 'https:';
  const doRequest = isTls ? httpsRequest : httpRequest;

  await new Promise<void>((resolve) => {
    const up = doRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port || (isTls ? 443 : 80),
        path: upstream.pathname + upstream.search, // search ya trae '?' o es ''
        method: req.method,
        headers,
      },
      (upRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          const lk = k.toLowerCase();
          if (HOP_HEADERS.has(lk) && lk !== 'content-length') continue;
          if (v !== undefined) outHeaders[k] = v;
        }
        // MCP acepta notificaciones con 202 y cuerpo vacío. Declarar longitud cero
        // evita que un túnel reconstruya esa respuesta como un stream chunked.
        if (upRes.statusCode === 202) {
          outHeaders['content-length'] = '0';
          res.writeHead(202, outHeaders);
          res.end();
          upRes.resume();
          upRes.on('end', () => resolve());
          upRes.on('error', () => resolve());
          return;
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
        upRes.on('end', () => resolve());
        upRes.on('error', () => resolve());
      },
    );
    up.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'bad_gateway', error_description: 'upstream unreachable' }));
      }
      resolve();
    });
    // GET/HEAD sin cuerpo: el pipe termina el request upstream. Resto: reenviar stream.
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') {
      up.end();
      // Nota: DELETE sin body es suficiente para el `session termination` de StreamableHTTP.
    } else {
      req.pipe(up);
    }
    res.on('close', () => {
      try {
        up.destroy();
      } catch {
        // socket ya cerrado
      }
    });
  });
}
