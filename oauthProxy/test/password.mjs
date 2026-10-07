import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, validPasswordHash, verifyPassword } from '../dist/password.js';
import { loadConfig, CHATGPT_REDIRECT_URI } from '../dist/config.js';
import { createSession, getSession } from '../dist/store.js';
import { parseCookies, setSessionCookie } from '../dist/session.js';
import { isAllowedRedirectUri } from '../dist/issuer.js';
import { isAllowedFormOrigin } from '../dist/formOrigin.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const password = 'test-password-with-spaces ';
const hash = await hashPassword(password);

test('scrypt utiliza sal aleatoria y verifica la contraseña exacta', async () => {
  assert.ok(validPasswordHash(hash));
  assert.notEqual(await hashPassword(password), hash);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.equal(await verifyPassword('incorrecta', hash), false);
  assert.equal(await verifyPassword('x'.repeat(1025), hash), false);
  await assert.rejects(hashPassword('corta'));
  assert.equal(validPasswordHash('scrypt$2$8$1$abc$def'), false);
});

test('arranque exige hash válido y HTTPS fuera de loopback', () => {
  const saved = { ...process.env };
  try {
    process.env.UPSTREAM_URL = 'http://127.0.0.1:9908';
    process.env.PROXY_HOST = '127.0.0.1';
    delete process.env.OAUTH_PASSWORD_HASH;
    assert.throws(() => loadConfig('/tmp/unused'), /OAUTH_PASSWORD_HASH/);
    process.env.OAUTH_PASSWORD_HASH = 'invalid';
    assert.throws(() => loadConfig('/tmp/unused'), /OAUTH_PASSWORD_HASH/);
    process.env.OAUTH_PASSWORD_HASH = hash;
    process.env.PROXY_PUBLIC_URL = 'http://public.example';
    assert.throws(() => loadConfig('/tmp/unused'), /HTTPS/);
    process.env.PROXY_PUBLIC_URL = 'http://127.0.0.1:9910';
    process.env.PROXY_HOST = '0.0.0.0';
    assert.throws(() => loadConfig('/tmp/unused'), /HTTPS/);
    process.env.PROXY_HOST = '127.0.0.1';
    assert.equal(loadConfig('/tmp/unused').passwordHash, hash);
    process.env.PROXY_PUBLIC_URL = 'https://public.example';
    assert.equal(loadConfig('/tmp/unused').publicUrl, 'https://public.example');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('cliente externo exige callback HTTPS exacto y un ID no reservado', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { UPSTREAM_URL: 'http://127.0.0.1:9908', PROXY_HOST: '127.0.0.1', PROXY_PUBLIC_URL: 'http://127.0.0.1:9910', OAUTH_PASSWORD_HASH: hash });
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_REDIRECT_URI;
    assert.deepEqual(loadConfig('/tmp/unused').externalClient, { id: 'chatgpt', redirectUri: CHATGPT_REDIRECT_URI });
    process.env.OAUTH_REDIRECT_URI = 'https://chatgpt.com/connector/oauth/test-callback';
    assert.deepEqual(loadConfig('/tmp/unused').externalClient, { id: 'chatgpt', redirectUri: process.env.OAUTH_REDIRECT_URI });
    const configured = loadConfig('/tmp/unused');
    assert.equal(isAllowedRedirectUri(configured, process.env.OAUTH_REDIRECT_URI, 'chatgpt'), true);
    assert.equal(isAllowedRedirectUri(configured, CHATGPT_REDIRECT_URI, 'chatgpt'), false);
    assert.equal(isAllowedRedirectUri(configured, process.env.OAUTH_REDIRECT_URI, 'other-client'), false);
    process.env.OAUTH_CLIENT_ID = 'other-client';
    assert.equal(loadConfig('/tmp/unused').externalClient.id, 'other-client');
    for (const uri of ['invalid', 'http://chatgpt.com/callback', 'https://user@chatgpt.com/callback', 'https://chatgpt.com/callback#fragment']) {
      process.env.OAUTH_REDIRECT_URI = uri;
      assert.throws(() => loadConfig('/tmp/unused'), /OAUTH_REDIRECT_URI/);
    }
    process.env.OAUTH_REDIRECT_URI = 'https://chatgpt.com/connector/oauth/test-callback';
    process.env.OAUTH_CLIENT_ID = 'local-browser';
    assert.throws(() => loadConfig('/tmp/unused'), /reservado/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('clientes adicionales conservan ChatGPT y validan cada callback exacto', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { UPSTREAM_URL: 'http://127.0.0.1:9908', PROXY_HOST: '127.0.0.1', PROXY_PUBLIC_URL: 'http://127.0.0.1:9910', OAUTH_PASSWORD_HASH: hash });
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_REDIRECT_URI;
    const grok = 'https://grok.com/connectors-oauth-exchange-code/';
    process.env.OAUTH_CLIENTS = JSON.stringify([{ id: 'chatgpt', redirectUri: grok }, { id: 'grok', redirectUri: grok }]);
    const cfg = loadConfig('/tmp/unused');
    assert.equal(isAllowedRedirectUri(cfg, CHATGPT_REDIRECT_URI, 'chatgpt'), true);
    assert.equal(isAllowedRedirectUri(cfg, grok, 'chatgpt'), true);
    assert.equal(isAllowedRedirectUri(cfg, grok, 'grok'), true);
    assert.equal(isAllowedRedirectUri(cfg, CHATGPT_REDIRECT_URI, 'grok'), false);
    for (const uri of [grok.slice(0, -1), grok + '?other=1', 'https://grok.com.evil.example/connectors-oauth-exchange-code/', cfg.publicUrl + '/oauth/callback']) {
      assert.equal(isAllowedRedirectUri(cfg, uri, 'chatgpt'), false);
    }
    assert.equal(isAllowedRedirectUri(cfg, grok, 'unknown'), false);
    for (const value of ['invalid', '{}', '[null]', JSON.stringify([{ id: '', redirectUri: grok }]), JSON.stringify([{ id: 'local-browser', redirectUri: grok }]), JSON.stringify([{ id: 'grok', redirectUri: 'http://grok.com/callback' }])]) {
      process.env.OAUTH_CLIENTS = value;
      assert.throws(() => loadConfig('/tmp/unused'), /OAUTH_CLIENTS/);
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('config.json carga clientes y el entorno puede reemplazar la lista', () => {
  const saved = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), 'oauth-config-'));
  const path = join(dir, 'config.json');
  try {
    Object.assign(process.env, { UPSTREAM_URL: 'http://127.0.0.1:9908', PROXY_HOST: '127.0.0.1', PROXY_PUBLIC_URL: 'http://127.0.0.1:9910', OAUTH_PASSWORD_HASH: hash });
    delete process.env.OAUTH_CLIENT_ID; delete process.env.OAUTH_REDIRECT_URI;
    delete process.env.OAUTH_CLIENTS; delete process.env.OAUTH_CONFIG_FILE;
    const grok = 'https://grok.com/connectors-oauth-exchange-code/';
    writeFileSync(path, JSON.stringify({ OAUTH_CLIENTS: [{ id: 'grok', redirectUri: grok }, { id: 'chatgpt', redirectUri: grok }] }));
    const cfg = loadConfig(join(dir, '.keys'));
    assert.equal(isAllowedRedirectUri(cfg, CHATGPT_REDIRECT_URI, 'chatgpt'), true);
    assert.equal(isAllowedRedirectUri(cfg, grok, 'grok'), true);
    assert.equal(isAllowedRedirectUri(cfg, grok, 'chatgpt'), true);
    process.env.OAUTH_CLIENTS = '[]';
    assert.equal(isAllowedRedirectUri(loadConfig(join(dir, '.keys')), grok, 'grok'), false);
    delete process.env.OAUTH_CLIENTS;
    process.env.OAUTH_CONFIG_FILE = path;
    assert.equal(isAllowedRedirectUri(loadConfig('/tmp/unused'), grok, 'grok'), true);
    for (const content of ['invalid', '{"OAUTH_CLIENTS":"invalid"}', '{"OAUTH_CLIENTS":[{"id":"grok","redirectUri":"http://grok.com"}]}']) {
      writeFileSync(path, content);
      assert.throws(() => loadConfig('/tmp/unused'), /config.json|OAUTH_CLIENTS/);
    }
    process.env.OAUTH_CONFIG_FILE = join(dir, 'missing.json');
    assert.throws(() => loadConfig('/tmp/unused'), /No se pudo leer config.json/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sesiones caducadas no autentican; cookie HTTPS protegida', () => {
  const session = createSession('local-user', 'mcp:tools', 300);
  assert.equal(getSession(session.id), session);
  session.expiresAt = Date.now() - 1;
  assert.equal(getSession(session.id), undefined);
  const headers = new Map();
  setSessionCookie({ getHeader: (k) => headers.get(k), setHeader: (k, v) => headers.set(k, v) }, 'session-id', 300, true);
  assert.match(headers.get('set-cookie')[0], /HttpOnly.*SameSite=Lax; Secure/);
  assert.deepEqual(parseCookies({ headers: { cookie: 'bad=%ZZ; lh_session=valid' } }), { lh_session: 'valid' });
});

test('origen reescrito de VS Code solo se acepta desde loopback y mismo origen', () => {
  const cfg = { publicUrl: 'https://test-9910.brs.devtunnels.ms', proxyPort: 9910 };
  const request = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { origin: 'http://localhost:9910', host: 'localhost:9910', 'sec-fetch-site': 'same-origin', 'x-forwarded-host': 'test-9910.brs.devtunnels.ms' } };
  assert.equal(isAllowedFormOrigin(request, cfg), true);
  assert.equal(isAllowedFormOrigin({ ...request, headers: { ...request.headers, origin: cfg.publicUrl } }, cfg), true);
  for (const headers of [
    { origin: 'null' }, { origin: 'https://evil.example' }, { origin: 'http://localhost:9920' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': undefined }, { 'x-forwarded-host': 'evil.example' },
  ]) assert.equal(isAllowedFormOrigin({ ...request, headers: { ...request.headers, ...headers } }, cfg), false);
  assert.equal(isAllowedFormOrigin({ ...request, socket: { remoteAddress: '203.0.113.10' } }, cfg), false);
  assert.equal(isAllowedFormOrigin(request, { ...cfg, publicUrl: 'https://other.example' }), false);
  assert.equal(isAllowedFormOrigin(request, { ...cfg, publicUrl: 'https://devtunnels.ms.evil.example' }), false);
  const withoutForwardedHost = { ...request, headers: { ...request.headers, 'x-forwarded-host': undefined } };
  assert.equal(isAllowedFormOrigin(withoutForwardedHost, cfg), true);
  assert.equal(isAllowedFormOrigin({ ...withoutForwardedHost, headers: { ...withoutForwardedHost.headers, host: 'evil.example' } }, cfg), false);
});
