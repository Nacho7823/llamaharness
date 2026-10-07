import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { parseTunnelUrl } from '../scripts/start-tmole.mjs';

const launcher = fileURLToPath(new URL('../scripts/start-tmole.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(condition, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await delay(50); }
  throw new Error('La verificación no terminó a tiempo.');
}
async function listening(port) {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}
async function fixture(body) {
  const dir = await mkdtemp(join(tmpdir(), 'tmole-launcher-test-'));
  await writeFile(join(dir, 'pnpm'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o700 });
  await writeFile(join(dir, 'pnpx'), `#!${process.execPath}\n${body}`, { mode: 0o700 });
  const port = await freePort();
  const child = spawn(process.execPath, [launcher], { cwd: tmpdir(), env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, PROXY_PORT: String(port),
    UPSTREAM_URL: 'http://127.0.0.1:9908', KEYS_DIR: join(dir, 'keys'),
    OAUTH_PASSWORD_HASH: 'inherited-must-not-be-used', TMOLE_TIMEOUT_SEC: '1',
    OAUTH_CLIENT_ID: '', OAUTH_REDIRECT_URI: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { dir, port, child, done, output: () => output };
}
async function cleanup(f) {
  f.child.kill('SIGTERM');
  await f.done;
  await rm(f.dir, { recursive: true, force: true });
}

test('extrae únicamente la URL HTTPS del puerto indicado', () => {
  assert.equal(parseTunnelUrl('http://test.tunnelmole.net is forwarding to localhost:9910\n', 9910), undefined);
  assert.equal(parseTunnelUrl('https://docs.example/help\nhttps://test.tunnelmole.net is forwarding to localhost:99101\n', 9910), undefined);
  assert.equal(parseTunnelUrl('\x1b[32mhttps://test.tunnelmole.net\x1b[0m is forwarding to localhost:9910\n', 9910), 'https://test.tunnelmole.net');
  assert.equal(parseTunnelUrl('https://test.tunnelmole.net ⟶ http://localhost:9910\n', 9910), 'https://test.tunnelmole.net');
});

test('lanza pnpx tmole, contraseña aleatoria válida y limpieza de procesos', { timeout: 15000 }, async () => {
  const f = await fixture(`
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
writeFileSync(join(__dirname, 'tunnel.json'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2), hasPasswordHash: 'OAUTH_PASSWORD_HASH' in process.env }));
const port = process.argv[3];
const { get } = require('node:http');
get('http://127.0.0.1:' + port + '/authorize', response => {
  if (response.statusCode !== 503 || response.headers['set-cookie']) process.exit(2);
  response.resume();
  response.on('end', () => {
    process.stdout.write('https://test.tunnelmole.net is forwarding to local');
    setTimeout(() => { process.stderr.write('Aviso de descarga de pnpx\\n'); process.stdout.write('host:' + port + '\\n'); }, 25);
  });
}).on('error', () => { console.error('No hay servicio en el puerto'); process.exit(1); });
setInterval(() => {}, 1000);
`);
  try {
    await waitFor(() => f.output().includes('Proxy listo.'));
    assert.match(f.output(), /ID de cliente OAuth: chatgpt\nCallback: https:\/\/chatgpt.com\/connector_platform_oauth_redirect/);
    const generated = f.output().match(/Contraseña de login: ([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(generated, 'imprime una contraseña aleatoria de 256 bits');
    const tunnel = JSON.parse(await readFile(join(f.dir, 'tunnel.json'), 'utf8'));
    assert.deepEqual(tunnel.args, ['tmole', String(f.port)]);
    assert.equal(tunnel.hasPasswordHash, false);
    const base = `http://127.0.0.1:${f.port}`;
    const health = await fetch(base + '/healthz');
    assert.equal((await health.json()).issuer, 'https://test.tunnelmole.net');
    const authorize = new URL(base + '/authorize');
    const verifier = 'test-launcher-pkce-verifier';
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: 'launcher-test', redirect_uri: 'https://test.tunnelmole.net/oauth/callback', state: 'launcher-test-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    const page = await fetch(authorize);
    const csrf = (await page.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const cookie = page.headers.get('set-cookie').split(';')[0];
    assert.match(page.headers.get('set-cookie'), /Secure/);
    const signin = password => fetch(base + '/oauth/signin', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password, csrf_token: csrf }) });
    const wrong = await signin('inherited-must-not-be-used');
    assert.equal(wrong.status, 401);
    const success = await signin(generated);
    assert.equal(success.status, 302, 'la contraseña impresa es la usada para login');
    assert.ok(success.headers.getSetCookie().some(cookie => cookie.startsWith('lh_session=') && cookie.includes('Secure')));
    f.child.kill('SIGTERM');
    assert.equal((await f.done).code, 143);
    await waitFor(async () => !(await listening(f.port)));
    assert.throws(() => process.kill(tunnel.pid, 0), /ESRCH/);
  } finally { await cleanup(f); }
});

test('si el túnel no anuncia URL, termina y limpia sin lanzar el proxy', { timeout: 10000 }, async () => {
  const f = await fixture("setInterval(() => {}, 1000);\n");
  try {
    assert.equal((await f.done).code, 1);
    assert.match(f.output(), /no anunció una URL HTTPS/);
    assert.equal(f.output().includes('Contraseña de login:'), false);
    assert.equal(await listening(f.port), false);
  } finally { await cleanup(f); }
});

test('si pnpx falla, no deja un proxy en ejecución', { timeout: 10000 }, async () => {
  const f = await fixture('process.exit(1);\n');
  try {
    assert.equal((await f.done).code, 1);
    assert.match(f.output(), /terminó antes de anunciar/);
    assert.equal(await listening(f.port), false);
  } finally { await cleanup(f); }
});

test('puerto ocupado: no toca el servidor existente ni intenta crear un túnel', { timeout: 5000 }, async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const child = spawn(process.execPath, [launcher], { env: { ...process.env, PROXY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(output, /puerto .* ocupado/);
    assert.equal(output.includes('Contraseña de login:'), false);
    assert.equal(await listening(port), true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
