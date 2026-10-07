import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { readState, writeState } from '../dist/state.js';
import { cachedToken, deviceLogin } from '../dist/auth.js';
import { prepareTunnel, publicOrigin, cancellationToken } from '../dist/tunnel.js';
import { assertPortAvailable, startProxy, verifyPublicProxy, resolveProxyEntry } from '../dist/proxy.js';

const reply = value => ({ ok: true, json: async () => value });

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'connector-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('la autorización y el túnel sobreviven a un reinicio, con archivo privado', async t => {
  const root = await temporary(t);
  const path = join(root, 'data.json');
  const state = await readState(path);
  state.auth = { accessToken: 'test-only', expiresAt: 200_000 };
  state.tunnel = { clusterId: 'brs', tunnelId: 'saved-id' };
  await writeState(path, state);
  assert.deepEqual(await readState(path), state);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(cachedToken(state, {}, 100_000), 'test-only');
  assert.equal(cachedToken(state, {}, 150_000), undefined);
  assert.equal(cachedToken(state, { DEV_TUNNELS_GITHUB_TOKEN: 'external' }, 300_000), 'external');
  await writeFile(path, '{broken');
  await assert.rejects(readState(path), SyntaxError);
});

test('device flow respeta espera y slow_down; no imprime el token ni device_code', async () => {
  const intervals = [], logs = [], requests = [];
  const responses = [
    { device_code: 'secret-device', user_code: 'PUBLIC-CODE', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 },
    { error: 'authorization_pending' }, { error: 'slow_down' },
    { access_token: 'secret-access', expires_in: 3600 },
  ];
  const auth = await deviceLogin({
    now: () => 1000,
    wait: async interval => intervals.push(interval),
    log: message => logs.push(message),
    fetcher: async (url, options) => { requests.push({ url, fields: options.body }); return reply(responses.shift()); },
  });
  assert.deepEqual(intervals, [5000, 5000, 10000]);
  assert.equal(auth.expiresAt, 3_601_000);
  assert.equal(requests[1].fields.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.ok(requests[0].fields.get('client_id'));
  assert.match(logs.join(''), /PUBLIC-CODE/);
  assert.doesNotMatch(logs.join(''), /secret-access|secret-device/);
});

test('rechazo y cancelación de GitHub terminan la espera', async () => {
  let count = 0;
  await assert.rejects(deviceLogin({
    wait: async () => {}, log: () => {},
    fetcher: async () => reply(count++ === 0 ? {
      device_code: 'secret', user_code: 'code', verification_uri: 'https://github.com/login/device', expires_in: 900,
    } : { error: 'access_denied' }),
  }), /rechazada/);
  const controller = new AbortController();
  await assert.rejects(deviceLogin({
    signal: controller.signal, log: () => {},
    fetcher: async () => {
      controller.abort();
      return reply({ device_code: 'secret', user_code: 'code', verification_uri: 'https://github.com/login/device', expires_in: 900 });
    },
  }), { name: 'AbortError' });
});

test('crear y recuperar usa el mismo túnel, expone solo el proxy y no permite host anónimo', async () => {
  let tunnel, creates = 0, reference;
  const client = {
    async createTunnel(value, options) {
      creates++;
      assert.deepEqual(options.tokenScopes, ['host', 'connect']);
      tunnel = { ...value, tunnelId: 'stable-id', clusterId: 'brs' };
      return tunnel;
    },
    async getTunnel(value) { assert.deepEqual(value, reference); return tunnel; },
    async updateTunnel(value) {
      assert.equal(value.ports, undefined, 'La API rechaza actualizaciones de puertos en updateTunnel');
      tunnel = { ...tunnel, ...value };
      return { ...tunnel, ports: undefined };
    },
    async updateTunnelPort(_, value) { tunnel.ports = [value]; return value; },
  };
  const save = async value => { reference = value; };
  await prepareTunnel(client, undefined, 9910, save);
  assert.equal(creates, 1);
  const initial = reference;
  await prepareTunnel(client, reference, 9910, save);
  assert.equal(creates, 1);
  assert.deepEqual(reference, initial);
  assert.deepEqual(tunnel.ports.map(p => p.portNumber), [9910]);
  for (const access of [tunnel.accessControl, tunnel.ports[0].accessControl]) {
    assert.deepEqual(access.entries[0].scopes, ['connect']);
  }
  tunnel.ports.push({ portNumber: 9908 });
  await assert.rejects(prepareTunnel(client, reference, 9910, save), /únicamente/);
  assert.equal(creates, 1);
});

test('un túnel eliminado no cambia la URL silenciosamente', async () => {
  const client = { getTunnel: async () => null, createTunnel: () => assert.fail('No debe crear otro túnel') };
  await assert.rejects(prepareTunnel(client, { tunnelId: 'gone', clusterId: 'brs' }, 9910, () => {}), /ya no existe/);
  client.getTunnel = async () => { throw { response: { status: 404 } }; };
  await assert.rejects(prepareTunnel(client, { tunnelId: 'gone', clusterId: 'brs' }, 9910, () => {}), /ya no existe/);
});

test('obtiene HTTPS de la respuesta del SDK y admite el formato de endpoint', () => {
  assert.equal(publicOrigin({ ports: [{ portNumber: 9910, portForwardingUris: ['http://example.test', 'https://stable.devtunnels.ms/'] }] }, 9910), 'https://stable.devtunnels.ms');
  assert.equal(publicOrigin({ endpoints: [{ portUriFormat: 'https://saved-{port}.brs.devtunnels.ms/' }] }, 9910), 'https://saved-9910.brs.devtunnels.ms');
  assert.throws(() => publicOrigin({ ports: [] }, 9910), /HTTPS/);
});

test('la cancelación llega al SDK y se pueden retirar sus listeners', () => {
  const controller = new AbortController();
  const token = cancellationToken(controller.signal);
  let calls = 0;
  const disposed = token.onCancellationRequested(() => calls++);
  disposed.dispose();
  token.onCancellationRequested(() => calls++);
  controller.abort();
  assert.equal(token.isCancellationRequested, true);
  assert.equal(calls, 1);
});

test('el proxy arranca con la URL pública, responde healthz y se cierra', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.mjs'), `
    import {createServer} from 'node:http';
    const server=createServer((req,res)=>{
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({ok:true,issuer:process.env.PROXY_PUBLIC_URL}));
    }).listen(Number(process.env.PROXY_PORT),'127.0.0.1');
    process.on('SIGTERM',()=>server.close());
  `);
  const port = await freePort();
  const origin = 'https://saved-9910.brs.devtunnels.ms';
  await assertPortAvailable(port);
  const proxy = startProxy(join(root, 'dist/index.mjs'), port, origin);
  t.after(() => proxy.stop());
  await proxy.ready(new AbortController().signal);
  await assert.rejects(assertPortAvailable(port), /ocupado/);
  await proxy.stop();
  assert.equal((await proxy.done).code, 0);
  await assertPortAvailable(port);
});

test('una caída del proxy durante el arranque se detecta', async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.mjs'), 'process.exitCode = 1;');
  const proxy = startProxy(join(root, 'dist/index.mjs'), await freePort(), 'https://example.test');
  t.after(() => proxy.stop());
  await assert.rejects(proxy.ready(new AbortController().signal), /terminó/);
});

test('la verificación pública valida el issuer y no necesita tokens de GitHub', async () => {
  const origin = 'https://example.devtunnels.ms';
  await verifyPublicProxy(origin, new AbortController().signal, async (url, options) => {
    assert.equal(url, `${origin}/healthz`);
    assert.equal(options.headers.Authorization, undefined);
    return reply({ ok: true, issuer: origin });
  });
});


test('ejecuta la entrada del paquete real y reutiliza su contraseña sin scripts intermediarios', async t => {
  const root = await temporary(t);
  const entry = resolveProxyEntry();
  assert.match(entry.replaceAll('\\', '/'), /oauthProxy\/dist\/index\.js$/);
  const port = await freePort();
  const origin = 'https://connector-test.devtunnels.ms';
  const dataPath = join(root, 'data.json');
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ OAUTH_CLIENTS: [] }));
  const options = {
    stdio: 'ignore',
    env: {
      OAUTH_DATA_FILE: dataPath,
      OAUTH_CONFIG_FILE: configPath,
      KEYS_DIR: join(root, '.keys'),
      OAUTH_PASSWORD_HASH: '',
    },
  };
  const proxy = startProxy(entry, port, origin, options);
  t.after(() => proxy.stop());
  await proxy.ready(new AbortController().signal);
  const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/openid-configuration`).then(r => r.json());
  assert.equal(metadata.authorization_endpoint, `${origin}/authorize`);
  assert.equal(metadata.token_endpoint, `${origin}/token`);
  const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
  assert.equal(denied.status, 401);
  const initial = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.ok(initial.login.password);
  await proxy.stop();
  const restarted = startProxy(entry, port, origin, options);
  t.after(() => restarted.stop());
  await restarted.ready(new AbortController().signal);
  const persisted = JSON.parse(await readFile(dataPath, 'utf8'));
  assert.deepEqual(persisted.login, initial.login);
  await restarted.stop();
  await assertPortAvailable(port);
});
