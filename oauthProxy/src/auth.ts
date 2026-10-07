// auth.ts — Verificación de credenciales. Solo llaves locales, sin red.
// Acepta `Authorization: Bearer <JWT-local>` o cookie de sesión válida.
// Todo lo demás => 401 con `WWW-Authenticate` que apunta al resource metadata (spec MCP).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProxyConfig } from './config.js';
import { getKeys } from './keys.js';
import { getSessionFromReq } from './session.js';

export interface AuthInfo {
  sub: string;
  scope: string;
  via: 'bearer' | 'session';
}

function extractBearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = h.match(/^Bearer\s+(.+)$/i);
  const t = m?.[1]?.trim();
  return t || undefined;
}

export async function authenticate(req: IncomingMessage, cfg: ProxyConfig): Promise<AuthInfo | undefined> {
  const token = extractBearer(req);
  if (token) {
    try {
      const keys = await getKeys(cfg.keysDir);
      const { payload } = await keys.verifier(token, { issuer: cfg.publicUrl, audience: cfg.audience });
      if (payload.sub) {
        return { sub: String(payload.sub), scope: String(payload.scope ?? ''), via: 'bearer' };
      }
    } catch {
      return undefined;
    }
  }
  const sess = getSessionFromReq(req);
  if (sess) return { sub: sess.sub, scope: sess.scope, via: 'session' };
  return undefined;
}

export function sendAuthRequired(res: ServerResponse, publicUrl: string): void {
  res.writeHead(401, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'www-authenticate': `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", error="invalid_token", error_description="valid local bearer or session required"`,
  });
  res.end(JSON.stringify({ error: 'unauthorized', error_description: 'valid local bearer or session required' }));
}
