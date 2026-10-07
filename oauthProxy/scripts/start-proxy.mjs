#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = '127.0.0.1';
const USAGE = 'Uso: pnpm dev:public https://tu-url';
const HELP = [
  USAGE,
  'También admite PROXY_PUBLIC_URL.',
  'Arranca solo el proxy y reutiliza la contraseña guardada en data.json.',
  'PROXY_PORT: 9910 por defecto.',
].join('\n');

function readOptions(args, env) {
  if (args.length > 1) throw new Error(USAGE);

  const publicUrl = (args[0] ?? env.PROXY_PUBLIC_URL)?.trim().replace(/\/+$/, '');
  if (!publicUrl) {
    throw new Error('Indicá la URL HTTPS: pnpm dev:public https://tu-url, o configurá PROXY_PUBLIC_URL.');
  }
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.origin !== publicUrl) throw new Error();
  } catch {
    throw new Error('PROXY_PUBLIC_URL debe ser la URL HTTPS base, sin /mcp, credenciales, query ni fragmento.');
  }

  const port = Number(env.PROXY_PORT || 9910);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PROXY_PORT debe estar entre 1 y 65535.');
  }
  return { publicUrl, port };
}

async function assertPortAvailable(port) {
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, HOST, resolve);
    });
    await new Promise((resolve, reject) => {
      probe.close(error => error ? reject(error) : resolve());
    });
  } catch {
    throw new Error(`El puerto ${port} está ocupado. Detené la app anterior; dejá el túnel abierto.`);
  }
}

// Compilación y proxy comparten el manejo de señales y ejecutan un hijo por vez.
function createProcessRunner() {
  let child;
  let stopped = false;

  function stop(signal) {
    stopped = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      // El hijo puede haber terminado antes de recibir la señal.
    }
  }

  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);

  return {
    get stopped() { return stopped; },
    run(command, args, env = process.env) {
      const running = spawn(command, args, {
        cwd: ROOT,
        env,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      });
      child = running;
      return new Promise((resolve, reject) => {
        running.once('error', reject);
        running.once('close', code => {
          child = undefined;
          resolve(code);
        });
      });
    },
    dispose() {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    },
  };
}

async function loadLoginCredentials() {
  const moduleUrl = pathToFileURL(join(ROOT, 'dist/data.js')).href;
  const { dataFile, getLoginCredentials } = await import(moduleUrl);
  return getLoginCredentials(dataFile(ROOT));
}

function printConnectionInfo(publicUrl, password) {
  console.log([
    '',
    `Contraseña de login: ${password}`,
    `Login: ${publicUrl}/oauth/login`,
    `MCP: ${publicUrl}/mcp`,
    `Endpoint de autorización: ${publicUrl}/authorize`,
    `Endpoint de token: ${publicUrl}/token`,
    'Ámbitos: mcp:tools',
    'Ctrl+C detiene solo la app; el túnel sigue abierto.',
    '',
  ].join('\n'));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const { publicUrl, port } = readOptions(args, process.env);
  await assertPortAvailable(port);

  const runner = createProcessRunner();
  try {
    const buildCode = await runner.run('pnpm', ['build']);
    if (runner.stopped) return;
    if (buildCode !== 0) throw new Error('No se pudo compilar el proxy.');

    const { password, hash } = await loadLoginCredentials();
    if (runner.stopped) return;

    const env = {
      ...process.env,
      PROXY_HOST: HOST,
      PROXY_PORT: String(port),
      PROXY_PUBLIC_URL: publicUrl,
      OAUTH_PASSWORD_HASH: hash,
    };
    printConnectionInfo(publicUrl, password);
    const code = await runner.run(process.execPath, [join(ROOT, 'dist/index.js')], env);
    if (!runner.stopped) process.exitCode = code ?? 1;
  } finally {
    runner.dispose();
  }
}

main().catch(error => {
  if (process.exitCode) return;
  console.error(`[start-proxy] ${error.message}`);
  process.exitCode = 1;
});
