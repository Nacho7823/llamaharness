import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { CliArgs } from './cli.js';

/** Resuelve la API key esperada (ya normalizada en cli.ts). Vacía => undefined. */
export function resolveApiKey(args: CliArgs): string | undefined {
  const raw = args.apiKey?.trim();
  return raw ? raw : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function headerValue(h: string | string[] | undefined): string | undefined {
  if (Array.isArray(h)) h = h[0];
  if (typeof h !== 'string') return undefined;
  const v = h.trim();
  return v ? v : undefined;
}

/** Extrae la key provista vía `Authorization: Bearer <key>` o `x-api-key: <key>`. */
export function extractProvidedKey(req: IncomingMessage): string | undefined {
  const xKey = headerValue(req.headers['x-api-key']);
  if (xKey) return xKey;
  const auth = headerValue(req.headers['authorization']);
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) {
      const token = m[1].trim();
      if (token) return token;
    }
  }
  return undefined;
}

/** Query fallback para SSE (EventSource no permite headers custom en navegadores). */
export function extractQueryKey(url: URL): string | undefined {
  for (const name of ['apiKey', 'api_key']) {
    const v = url.searchParams.get(name)?.trim();
    if (v) return v;
  }
  return undefined;
}

/**
 * true si el request está autorizado.
 * - Sin `expected` => modo abierto (backward-compat con stdio/e2e sin key).
 * - Con `expected` => compara en tiempo constante contra header o (opcional) query.
 */
export function isAuthorized(
  req: IncomingMessage,
  expected: string | undefined,
  queryKey?: string | undefined,
): boolean {
  if (!expected) return true;
  const provided = extractProvidedKey(req) ?? queryKey?.trim() ?? undefined;
  if (!provided) return false;
  return safeEqual(provided, expected);
}

/** Responde 401 sin filtrar la key esperada. */
export function sendUnauthorized(res: { writeHead: Function; end: Function }): void {
  (res.writeHead as (code: number, headers: Record<string, string>) => void)(401, {
    'content-type': 'text/plain',
    'www-authenticate': 'Bearer realm="mcp"',
  });
  (res.end as (body: string) => void)('Unauthorized: missing or invalid API key');
}
