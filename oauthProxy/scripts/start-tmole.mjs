#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Solo tomar la URL que Tunnelmole anuncia como destino del puerto solicitado.
export function parseTunnelUrl(output, port) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  const match = text.match(new RegExp(`https://[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?=\\s+(?:is forwarding to|[→⟶])\\s+(?:http://)?(?:localhost|127\\.0\\.0\\.1):${port}(?![0-9]))`, 'i'));
  return match?.[0];
}

export async function startTunnel() {
  if (process.argv.includes('--help')) {
    console.log('Uso: pnpm tunnel\nRequiere pnpm/pnpx y el backend ejecutándose. Genera una contraseña aleatoria para el login.\nPROXY_PORT: 9910 por defecto. TMOLE_TIMEOUT_SEC: 45 por defecto.\nCtrl+C cierra el proxy y el túnel creados por este script.');
    return;
  }
  const port = Number(process.env.PROXY_PORT || 9910);
  const timeoutSec = Number(process.env.TMOLE_TIMEOUT_SEC || 45);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROXY_PORT debe ser un puerto entre 1 y 65535.');
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 300) throw new Error('TMOLE_TIMEOUT_SEC debe estar entre 1 y 300.');
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  } catch {
    throw new Error(`El puerto ${port} está ocupado o no se puede usar. Detené el pnpm dev anterior o elegí otro PROXY_PORT.`);
  }

  const children = new Set();
  const bootstrap = createHttpServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '1' });
    res.end('El proxy está iniciando. Volvé a intentar en unos segundos.');
  });
  async function closeBootstrap() {
    if (!bootstrap.listening) return;
    await new Promise(resolve => {
      bootstrap.close(resolve);
      bootstrap.closeAllConnections();
    });
  }
  const controller = new AbortController();
  let signalCode = 0;
  function terminate(child, signal = 'SIGTERM') {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch { /* El proceso o su grupo ya terminó. */ }
  }
  function stop(signal) {
    signalCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort();
    for (const child of children) terminate(child);
  }
  const interrupt = () => stop('SIGINT');
  const terminateSignal = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminateSignal);

  function launch(command, args, env, stdio) {
    const child = spawn(command, args, { cwd: root, env, stdio, detached: process.platform !== 'win32' });
    const done = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    children.add(child);
    return { child, done };
  }

  try {
    // Construir antes de abrir el túnel: nunca publicar un proxy que no compila.
    const build = launch('pnpm', ['build'], process.env, 'inherit');
    const result = await build.done;
    if (controller.signal.aborted) return;
    if (result.error || result.code !== 0) throw new Error('No se pudo compilar el proxy. Ejecutá pnpm install y pnpm build.');
    children.delete(build.child);
    const { hashPassword } = await import(pathToFileURL(join(root, 'dist/password.js')).href);
    const password = randomBytes(32).toString('base64url');
    const passwordHash = await hashPassword(password);
    if (controller.signal.aborted) return;
    const { loadConfig } = await import(pathToFileURL(join(root, 'dist/config.js')).href);
    // Validar toda la configuración antes de crear el túnel; su URL reemplazará esta base local.
    const previousHash = process.env.OAUTH_PASSWORD_HASH;
    const previousHost = process.env.PROXY_HOST;
    const previousUrl = process.env.PROXY_PUBLIC_URL;
    let config;
    try {
      process.env.OAUTH_PASSWORD_HASH = passwordHash;
      process.env.PROXY_HOST = '127.0.0.1';
      process.env.PROXY_PUBLIC_URL = `http://127.0.0.1:${port}`;
      config = loadConfig(join(root, '.keys'));
    } finally {
      if (previousHash === undefined) delete process.env.OAUTH_PASSWORD_HASH; else process.env.OAUTH_PASSWORD_HASH = previousHash;
      if (previousHost === undefined) delete process.env.PROXY_HOST; else process.env.PROXY_HOST = previousHost;
      if (previousUrl === undefined) delete process.env.PROXY_PUBLIC_URL; else process.env.PROXY_PUBLIC_URL = previousUrl;
    }

    // El proceso del túnel no necesita las credenciales ni la llave privada del proxy.
    const tunnelEnv = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'SYSTEMROOT', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    // Tunnelmole comprueba que el puerto esté abierto antes de crear el túnel.
    // Hasta conocer la URL, responder solo 503: no ofrecer login ni emitir tokens.
    await new Promise((resolve, reject) => {
      bootstrap.once('error', reject);
      bootstrap.listen(port, '127.0.0.1', resolve);
    });
    if (controller.signal.aborted) return;
    const tunnel = launch('pnpx', ['tmole', String(port)], tunnelEnv, ['ignore', 'pipe', 'pipe']);
    const url = await new Promise((resolve, reject) => {
      const output = { stdout: '', stderr: '' };
      let settled = false;
      function finish(action, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', abort);
        action(value);
      }
      function abort() { finish(reject, new Error('Inicio cancelado.')); }
      const timer = setTimeout(() => finish(reject, new Error('Tunnelmole no anunció una URL HTTPS a tiempo.')), timeoutSec * 1000);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      function inspect(chunk, stream) {
        if (settled) return;
        output[stream] = (output[stream] + chunk.toString()).slice(-65536);
        // Esperar una línea completa para no confundir un puerto parcialmente recibido.
        const found = parseTunnelUrl(output[stream].slice(0, output[stream].lastIndexOf('\n') + 1), port);
        if (found) finish(resolve, found);
      }
      tunnel.child.stdout.on('data', chunk => { process.stdout.write(chunk); inspect(chunk, 'stdout'); });
      tunnel.child.stderr.on('data', chunk => { process.stderr.write(chunk); inspect(chunk, 'stderr'); });
      tunnel.done.then(result => finish(reject, new Error(result.error?.code === 'ENOENT'
        ? 'No se encontró pnpx. Instalá pnpm para poder ejecutar pnpx tmole.'
        : 'Tunnelmole terminó antes de anunciar una URL HTTPS.')));
    });
    if (controller.signal.aborted) return;
    await closeBootstrap();
    if (controller.signal.aborted) return;
    const app = launch(process.execPath, [join(root, 'dist/index.js')], {
      ...process.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port), PROXY_PUBLIC_URL: url, OAUTH_PASSWORD_HASH: passwordHash,
    }, 'inherit');
    // No anunciar éxito antes de que el proxy responda con el emisor correcto.
    let ready = false;
    for (let i = 0; i < 100 && !controller.signal.aborted; i++) {
      if (app.child.exitCode !== null || app.child.signalCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        const body = await response.json();
        if (response.ok && body.issuer === url) { ready = true; break; }
      } catch { /* El servidor todavía está iniciándose. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (controller.signal.aborted) return;
    if (!ready) throw new Error('El proxy no arrancó correctamente. Revisá los errores anteriores.');
    console.log(`\nProxy listo.\nContraseña de login: ${password}\nLogin: ${url}/oauth/login\nMCP: ${url}/mcp\n` +
      (config.externalClient ? `ID de cliente OAuth: ${config.externalClient.id}\nCallback: ${config.externalClient.redirectUri}\n` : '') +
      'Ctrl+C para cerrar el proxy y el túnel.\n');
    const ended = await Promise.race([
      app.done.then(result => ({ name: 'proxy', ...result })),
      tunnel.done.then(result => ({ name: 'túnel', ...result })),
    ]);
    if (!controller.signal.aborted) throw new Error(`El ${ended.name} terminó; se cerrará el otro proceso.`);
  } finally {
    await closeBootstrap();
    for (const child of children) terminate(child);
    // Dar un margen breve para cerrar; matar solo los grupos creados por este script.
    if ([...children].some(child => child.exitCode === null && child.signalCode === null)) {
      await new Promise(resolve => setTimeout(resolve, 500));
      for (const child of children) terminate(child, 'SIGKILL');
    }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminateSignal);
    if (signalCode) process.exitCode = signalCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startTunnel().catch(error => {
    if (process.exitCode === 130 || process.exitCode === 143) return;
    console.error(`[start-tmole] ${error.message}`);
    process.exitCode = 1;
  });
}
