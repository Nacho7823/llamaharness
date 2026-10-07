import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const app = fileURLToPath(new URL('../scripts/start-proxy.mjs', import.meta.url));
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(50); }
  throw new Error('Tiempo de espera agotado.');
}
async function listening(port) {
  return new Promise(resolve => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
}
function launch(path, env, args = []) {
  const child = spawn(process.execPath, [path, ...args], { env, cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, done, output: () => output };
}
async function stop(process) { if (process) { process.child.kill('SIGTERM'); await process.done; } }

test('arranque público valida URL, conserva contraseña y admite OAuth por Dev Tunnels', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'public-proxy-'));
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  await writeFile(join(dir, 'pnpm'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROXY_PORT: String(port), PROXY_PUBLIC_URL: '',
    OAUTH_DATA_FILE: join(dir, 'data.json'), KEYS_DIR: join(dir, 'keys'), UPSTREAM_URL: 'http://127.0.0.1:1',
    OAUTH_PASSWORD_HASH: 'not-used', OAUTH_CLIENT_ID: '', OAUTH_REDIRECT_URI: '', OAUTH_CLIENTS: '' };
  let proxy;
  try {
    const passwords = [];
    for (let i = 0; i < 2; i++) {
      proxy = launch(app, { ...env, PROXY_PUBLIC_URL: 'https://test.devtunnels.ms' });
      await waitFor(() => listening(port));
      passwords.push(proxy.output().match(/Contraseña de login: ([A-Za-z0-9_-]{43})/)?.[1]);
      assert.ok(passwords[i]);
      const occupied = launch(app, env, ['https://test.devtunnels.ms']);
      assert.equal((await occupied.done).code, 1);
      assert.match(occupied.output(), /puerto .* ocupado/);
      assert.equal(await listening(port), true, 'no detiene una app existente');
      await stop(proxy); proxy = undefined;
      await waitFor(async () => !(await listening(port)));
    }
    assert.equal(passwords[0], passwords[1], 'reutiliza contraseña tras reiniciar');
    const missing = launch(app, env);
    assert.equal((await missing.done).code, 1);
    assert.match(missing.output(), /Indicá.*PROXY_PUBLIC_URL/);
    for (const url of ['http://external.example', 'https://external.example/mcp', 'https://user@external.example', 'https://external.example#fragment']) {
      const invalid = launch(app, env, [url]);
      assert.equal((await invalid.done).code, 1);
      assert.match(invalid.output(), /URL HTTPS base/);
      assert.equal(invalid.output().includes('Contraseña de login:'), false);
    }
    const external = 'https://test-vscode-9910.devtunnels.ms';
    proxy = launch(app, { ...env, PROXY_PUBLIC_URL: 'http://must-not-use.example' }, [external + '/']);
    await waitFor(() => listening(port));
    const metadata = await (await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`)).json();
    assert.equal(metadata.issuer, external, 'argumento URL tiene prioridad sobre entorno');
    assert.equal(metadata.authorization_endpoint, external + '/authorize');
    for (const clientId of ['grok', 'chatgpt']) {
      const grokAuth = new URL(`http://127.0.0.1:${port}/authorize`);
      grokAuth.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://grok.com/connectors-oauth-exchange-code/', state: 'grok-config', code_challenge: 'test-challenge', code_challenge_method: 'S256' }).toString();
      const grokPage = await fetch(grokAuth);
      assert.equal(grokPage.status, 200, `arranque sin OAUTH_CLIENTS carga Grok con ID ${clientId} desde config.json`);
      assert.match(await grokPage.text(), /name="password"/);
    }
    const auth = new URL(`http://127.0.0.1:${port}/authorize`);
    auth.search = new URLSearchParams({ response_type: 'code', client_id: 'chatgpt', redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', state: 'external-test', code_challenge: 'test-challenge', code_challenge_method: 'S256' }).toString();
    const page = await fetch(auth);
    const csrf = (await page.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const cookie = page.headers.get('set-cookie')?.split(';')[0];
    const password = proxy.output().match(/Contraseña de login: ([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(password);
    assert.match(page.headers.get('set-cookie'), /Secure/);
    const signin = await fetch(`http://127.0.0.1:${port}/oauth/signin`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: external, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password, csrf_token: csrf }) });
    assert.equal(signin.status, 302, 'contraseña impresa autentica con URL externa');
    const rewrittenHeaders = {
      origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin',
      'x-forwarded-host': new URL(external).host,
      'content-type': 'application/x-www-form-urlencoded',
    };
    const secondPage = await fetch(auth);
    const secondCsrf = (await secondPage.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const loginCookie = secondPage.headers.get('set-cookie')?.split(';')[0];
    const invalidSignin = await fetch(`http://127.0.0.1:${port}/oauth/signin`, {
      method: 'POST', redirect: 'manual', headers: { ...rewrittenHeaders, cookie: loginCookie },
      body: new URLSearchParams({ password, csrf_token: 'invalid' }),
    });
    assert.equal(invalidSignin.status, 403, 'reescritura no omite CSRF');
    const rewrittenSignin = await fetch(`http://127.0.0.1:${port}/oauth/signin`, {
      method: 'POST', redirect: 'manual', headers: { ...rewrittenHeaders, cookie: loginCookie },
      body: new URLSearchParams({ password, csrf_token: secondCsrf }),
    });
    assert.equal(rewrittenSignin.status, 302, 'login acepta origen local reescrito por VS Code');
    const sessionCookie = rewrittenSignin.headers.getSetCookie().find(x => x.startsWith('lh_session='))?.split(';')[0];
    assert.ok(sessionCookie);
    const consent = await fetch(auth, { headers: { cookie: sessionCookie } });
    const consentHtml = await consent.text();
    const fields = new URLSearchParams([...consentHtml.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map(x => [x[1], x[2]]));
    const approved = await fetch(`http://127.0.0.1:${port}/authorize/approve`, {
      method: 'POST', redirect: 'manual', headers: { ...rewrittenHeaders, cookie: sessionCookie }, body: fields,
    });
    assert.equal(approved.status, 302, 'consentimiento acepta origen reescrito');
    assert.equal(new URL(approved.headers.get('location')).origin, 'https://chatgpt.com');
    const logout = await fetch(`http://127.0.0.1:${port}/oauth/logout`, {
      method: 'POST', redirect: 'manual', headers: { ...rewrittenHeaders, cookie: sessionCookie },
      body: new URLSearchParams({ csrf_token: fields.get('csrf_token') }),
    });
    assert.equal(logout.status, 302, 'logout acepta origen reescrito');
  } finally { await stop(proxy); await rm(dir, { recursive: true, force: true }); }
});
