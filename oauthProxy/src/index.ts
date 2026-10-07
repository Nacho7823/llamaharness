#!/usr/bin/env node
// index.ts — Servidor del oauth-proxy local. Sin IdP externo.
// El backend llamaharness se lanza SIN api-key; este proxy es el único borde.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { getKeys } from './keys.js';
import {
  callbackUrl,
  discoveryDoc,
  handleApprove,
  handleAuthorize,
  handleCallback,
  handleLogin,
  handleLogout,
  handleToken,
  handleUserinfo,
  protectedResourceDoc,
} from './issuer.js';
import { handleSignin } from './signin.js';
import { handleProxy } from './proxy.js';
import { sendJson } from './httpUtils.js';
import { dataFile, getLoginCredentials } from './data.js';
import { initializeStore } from './store.js';

const SERVER = 'llamaharness-oauth-proxy';

function log(msg: string): void {
  console.error(`[${SERVER}] ${msg}`);
}

function packageRoot(): string {
  const dir = dirname(fileURLToPath(import.meta.url)); // dist/ en build, src/ con tsx
  return join(dir, '..');
}

const storage = dataFile(packageRoot());
if (!process.env.OAUTH_PASSWORD_HASH?.trim()) {
  const credentials = await getLoginCredentials(storage);
  process.env.OAUTH_PASSWORD_HASH = credentials.hash;
  console.log(`Contraseña de login: ${credentials.password}`);
}
const cfg = loadConfig(join(packageRoot(), '.keys'));

function pathOf(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0];
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);

  // Registrar el resultado sin query, cuerpo ni cabeceras: pueden contener
  // códigos OAuth, contraseñas o tokens. Útil al diagnosticar clientes remotos.
  res.once('finish', () => {
    log(`${method} ${path.replace(/[\r\n\t]/g, '')} -> ${res.statusCode}`);
  });

  try {
    // no-referrer convierte Origin en "null" en POST de formularios del navegador.
    // same-origin conserva el origen del login sin enviar Referer a callbacks externos.
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    // ---- Públicos (sin auth) ----
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true, issuer: cfg.publicUrl, upstream: cfg.upstreamUrl });
      return;
    }
    if (method === 'GET' && path === '/.well-known/openid-configuration') {
      sendJson(res, 200, discoveryDoc(cfg));
      return;
    }
    if (method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
      // RFC9728: el path puede llevar sufijo del recurso; respondemos el mismo doc.
      res.setHeader('cache-control', 'public, max-age=3600');
      sendJson(res, 200, protectedResourceDoc(cfg));
      return;
    }
    if (method === 'GET' && (path === '/jwks.json' || path === '/.well-known/jwks.json')) {
      const keys = await getKeys(cfg.keysDir);
      res.setHeader('cache-control', 'public, max-age=3600');
      sendJson(res, 200, keys.jwks);
      return;
    }
    if (method === 'GET' && path === '/authorize') {
      handleAuthorize(req, res, cfg);
      return;
    }
    if (method === 'POST' && path === '/authorize/approve') {
      await handleApprove(req, res, cfg);
      return;
    }
    if (method === 'POST' && path === '/oauth/signin') {
      await handleSignin(req, res, cfg);
      return;
    }
    if (method === 'POST' && path === '/token') {
      await handleToken(req, res, cfg);
      return;
    }
    if (method === 'GET' && path === '/userinfo') {
      await handleUserinfo(req, res, cfg);
      return;
    }
    if (method === 'GET' && path === '/oauth/login') {
      handleLogin(req, res, cfg);
      return;
    }
    if (method === 'GET' && path === '/oauth/callback') {
      await handleCallback(req, res, cfg);
      return;
    }
    if ((method === 'GET' || method === 'POST') && path === '/oauth/logout') {
      await handleLogout(req, res, cfg);
      return;
    }

    // ---- Protegidos (deny-by-default + proxy) ----
    if (
      path === '/mcp' ||
      path === '/sse' ||
      path === '/messages' ||
      path.startsWith('/messages/')
    ) {
      await handleProxy(req, res, cfg);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    // Nunca filtrar tokens en logs: solo método + path + mensaje.
    log(`${method} ${path} -> 500 ${(err as Error).message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
  }
}

async function main(): Promise<void> {
  await getKeys(cfg.keysDir); // genera la llave en el primer arranque si falta
  initializeStore(storage, cfg.publicUrl);
  const server = createServer(route);
  await new Promise<void>((resolve) => server.listen(cfg.proxyPort, cfg.proxyHost, resolve));
  log(`listening on ${cfg.proxyHost}:${cfg.proxyPort} (issuer ${cfg.publicUrl})`);
  log(`upstream ${cfg.upstreamUrl} (llamaharness SIN api-key, solo loopback)`);
  log(`login browser: ${cfg.publicUrl}/oauth/login`);
  log(`callback (registrado en el flujo browser): ${callbackUrl(cfg)}`);
  log(`Sesiones y tokens de renovación guardados en ${storage}`);
}

main().catch((err) => {
  console.error(`[${SERVER}] Fatal:`, err);
  process.exit(1);
});
