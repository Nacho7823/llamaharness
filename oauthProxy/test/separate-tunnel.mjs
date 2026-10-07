import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const open = fileURLToPath(new URL('../scripts/open-tunnel.mjs', import.meta.url));
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

test('túnel independiente conserva URL al reiniciar el proxy y limpia solo sus procesos', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'separate-tunnel-'));
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const stateFile = join(dir, 'state.json');
  await writeFile(join(dir, 'pnpm'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  await writeFile(join(dir, 'pnpx'), `#!${process.execPath}\n
const http = require('node:http');
const fs = require('node:fs');
fs.writeFileSync(__dirname + '/calls.json', JSON.stringify({ args: process.argv.slice(2), hasHash: 'OAUTH_PASSWORD_HASH' in process.env }));
http.get('http://127.0.0.1:' + process.argv[3] + '/authorize', res => {
  if (res.statusCode !== 503) process.exit(2);
  res.resume(); res.on('end', () => console.log('https://independent.tunnelmole.net is forwarding to localhost:' + process.argv[3]));
}).on('error', () => process.exit(3));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROXY_PORT: String(port), PROXY_PUBLIC_URL: '', TUNNEL_STATE_FILE: stateFile, KEYS_DIR: join(dir, 'keys'), UPSTREAM_URL: 'http://127.0.0.1:1', OAUTH_PASSWORD_HASH: 'not-for-tunnel', OAUTH_CLIENT_ID: '', OAUTH_REDIRECT_URI: '' };
  let tunnel, proxy;
  try {
    tunnel = launch(open, env);
    await waitFor(() => tunnel.output().includes('Túnel abierto:'));
    assert.equal(await listening(port), false, 'túnel libera el puerto y no inicia la app');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.url, 'https://independent.tunnelmole.net');
    assert.equal(state.port, port);
    assert.equal(state.pid, tunnel.child.pid);
    assert.equal(tunnel.output().includes('Contraseña'), false);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'calls.json'), 'utf8')), { args: ['tmole', String(port)], hasHash: false });
    const duplicate = launch(open, env);
    assert.equal((await duplicate.done).code, 1);
    assert.match(duplicate.output(), /Ya hay un túnel abierto/);
    const passwords = [];
    for (let i = 0; i < 2; i++) {
      proxy = launch(app, env);
      await waitFor(() => listening(port));
      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal((await health.json()).issuer, state.url);
      passwords.push(proxy.output().match(/Contraseña de login: ([A-Za-z0-9_-]{43})/)?.[1]);
      assert.ok(passwords[i]);
      await stop(proxy); proxy = undefined;
      await waitFor(async () => !(await listening(port)));
      assert.equal(tunnel.child.exitCode, null, 'detener app no cierra túnel');
      assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).id, state.id);
    }
    assert.notEqual(passwords[0], passwords[1]);
    await stop(tunnel); tunnel = undefined;
    await assert.rejects(readFile(stateFile), { code: 'ENOENT' });
    const missing = launch(app, env);
    assert.equal((await missing.done).code, 1);
    assert.match(missing.output(), /Indicá PROXY_PUBLIC_URL/);
    for (const url of ['http://external.example', 'https://external.example/mcp', 'https://user@external.example', 'https://external.example#fragment']) {
      const invalid = launch(app, env, [url]);
      assert.equal((await invalid.done).code, 1);
      assert.match(invalid.output(), /URL HTTPS base/);
      assert.equal(invalid.output().includes('Contraseña de login:'), false);
    }
    const external = 'https://test-vscode-9910.devtunnels.ms';
    await writeFile(stateFile, 'invalid-state', 'utf8');
    proxy = launch(app, { ...env, PROXY_PUBLIC_URL: 'http://must-not-use.example' }, [external + '/']);
    await waitFor(() => listening(port));
    const metadata = await (await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`)).json();
    assert.equal(metadata.issuer, external, 'argumento URL tiene prioridad sobre entorno y estado de Tunnelmole');
    assert.equal(metadata.authorization_endpoint, external + '/authorize');
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
  } finally { await stop(proxy); await stop(tunnel); await rm(dir, { recursive: true, force: true }); }
});
