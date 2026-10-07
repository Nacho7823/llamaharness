import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { getLoginCredentials } from '../dist/data.js';
import { verifyPassword } from '../dist/password.js';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('contraseña, sesión y renovación sobreviven a cierres abruptos; expiración y logout persisten', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-persistence-'));
  const path = join(dir, 'data.json');
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port), PROXY_PUBLIC_URL: base,
    UPSTREAM_URL: 'http://127.0.0.1:1', KEYS_DIR: join(dir, 'keys'), OAUTH_DATA_FILE: path,
    OAUTH_PASSWORD_HASH: '', OAUTH_CLIENT_ID: '', OAUTH_REDIRECT_URI: '', OAUTH_CLIENTS: '' };
  let child, ended, output;
  async function start(extra = {}) {
    output = '';
    child = spawn(process.execPath, [entry], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
    ended = new Promise(resolve => child.once('exit', resolve));
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error('Proxy no arrancó');
      if (output.includes('listening on')) return;
      await delay(25);
    }
    throw new Error('Proxy no arrancó a tiempo');
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGKILL'); await ended; } }
  const headers = cookie => ({ cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' });
  const post = (route, fields, cookie = '') => fetch(base + route, { method: 'POST', redirect: 'manual', headers: headers(cookie), body: new URLSearchParams(fields) });
  const verifier = 'persistence-test-verifier';
  const auth = new URL(base + '/authorize');
  auth.search = new URLSearchParams({ response_type: 'code', client_id: 'test', redirect_uri: base + '/oauth/callback', state: 'test',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  function fields(html) { return Object.fromEntries([...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(x => [x[1], x[2].replaceAll('&amp;', '&')])); }
  try {
    await start();
    const credentials = await getLoginCredentials(path);
    assert.ok(await verifyPassword(credentials.password, credentials.hash));
    assert.ok(output.includes(`Contraseña de login: ${credentials.password}`));
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
    const page = await fetch(auth);
    const login = fields(await page.text());
    const loginCookie = page.headers.getSetCookie().find(x => x.startsWith('lh_login='))?.split(';')[0];
    const signin = await post('/oauth/signin', { csrf_token: login.csrf_token, password: credentials.password }, loginCookie);
    assert.equal(signin.status, 302);
    const cookie = signin.headers.getSetCookie().find(x => x.startsWith('lh_session='))?.split(';')[0];
    const consent = fields(await (await fetch(auth, { headers: { cookie } })).text());
    const approved = await post('/authorize/approve', consent, cookie);
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    const tokenResponse = await post('/token', { grant_type: 'authorization_code', client_id: 'test', redirect_uri: base + '/oauth/callback', code, code_verifier: verifier });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    await stop();
    await start();
    assert.ok(output.includes(`Contraseña de login: ${credentials.password}`), 'reutiliza contraseña en otro proceso');
    assert.equal((await fetch(base + '/userinfo', { headers: { cookie } })).status, 200, 'sesión restaurada');
    assert.equal((await fetch(base + '/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 200, 'llave y JWT conservados');
    assert.equal((await post('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'wrong' })).status, 400);
    const renewed = await post('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'test' });
    assert.equal(renewed.status, 200, 'renovación restaurada');
    const renewedAccess = (await renewed.json()).access_token;
    assert.equal((await fetch(base + '/userinfo', { headers: { authorization: `Bearer ${renewedAccess}` } })).status, 200);
    assert.equal((await post('/oauth/logout', { csrf_token: consent.csrf_token }, cookie)).status, 302);
    await stop(); await start();
    assert.equal((await fetch(base + '/userinfo', { headers: { cookie } })).status, 401, 'logout persiste');
    await stop();
    const data = JSON.parse(await readFile(path, 'utf8'));
    data.issuers[base].sessions.push({ id: 'expired', csrfToken: 'expired', sub: 'local-user', scope: 'mcp:tools', createdAt: 1, expiresAt: 2 });
    for (const refresh of data.issuers[base].refreshTokens) refresh.expiresAt = 2;
    await writeFile(path, JSON.stringify(data));
    await start();
    assert.equal((await fetch(base + '/userinfo', { headers: { cookie: 'lh_session=expired' } })).status, 401);
    assert.equal((await post('/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'test' })).status, 400, 'no restaura tokens vencidos');
    await stop();
    // Una URL pública diferente no hereda las cookies de otra integración.
    data.issuers[base].sessions[0].expiresAt = Date.now() + 60000;
    await writeFile(path, JSON.stringify(data));
    await start({ PROXY_PUBLIC_URL: 'https://other.example' });
    assert.equal((await fetch(base + '/userinfo', { headers: { cookie: 'lh_session=expired' } })).status, 401);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

test('un data.json corrupto no se sobrescribe ni cambia la contraseña', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oauth-invalid-data-'));
  const path = join(dir, 'data.json');
  try {
    await writeFile(path, '{broken');
    await assert.rejects(getLoginCredentials(path), /Archivo de datos inválido/);
    assert.equal(await readFile(path, 'utf8'), '{broken');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
