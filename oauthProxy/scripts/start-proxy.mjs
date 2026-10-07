#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function main() {
  if (process.argv.includes('--help')) { console.log('Uso: pnpm dev:public https://tu-url\nTambién admite PROXY_PUBLIC_URL, o pnpm dev:tunnel con la URL guardada por pnpm tunnel:open.\nArranca solo el proxy y genera una contraseña nueva. PROXY_PORT: 9910 por defecto.'); return; }
  if (process.argv.length > 3) throw new Error('Uso: pnpm dev:public https://tu-url');
  let state;
  const publicUrl = (process.argv[2] ?? process.env.PROXY_PUBLIC_URL)?.trim().replace(/\/+$/, '');
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (url.protocol !== 'https:' || url.origin !== publicUrl) throw new Error();
    } catch { throw new Error('PROXY_PUBLIC_URL debe ser la URL HTTPS base, sin /mcp, credenciales, query ni fragmento.'); }
    const port = Number(process.env.PROXY_PORT || 9910);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROXY_PORT debe estar entre 1 y 65535.');
    state = { url: publicUrl, port };
  } else {
    try {
      state = JSON.parse(await readFile(process.env.TUNNEL_STATE_FILE || join(root, '.tunnel.json'), 'utf8'));
      const url = new URL(state.url);
      if (url.protocol !== 'https:' || url.origin !== state.url || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !Number.isInteger(state.pid) || state.pid <= 0) throw new Error();
      process.kill(state.pid, 0);
    } catch { throw new Error('Indicá PROXY_PUBLIC_URL para un túnel externo o ejecutá pnpm tunnel:open en otra terminal.'); }
  }
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(state.port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  } catch { throw new Error(`El puerto ${state.port} está ocupado. Detené la app anterior; dejá el túnel abierto.`); }
  let child;
  let stopped = false;
  const stop = signal => {
    stopped = true; process.exitCode = signal === 'SIGINT' ? 130 : 143;
    try { if (process.platform === 'win32') child?.kill(); else if (child) process.kill(-child.pid, 'SIGTERM'); } catch {}
  };
  const interrupt = () => stop('SIGINT'); const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  function run(command, args, env) {
    child = spawn(command, args, { cwd: root, env, stdio: 'inherit', detached: process.platform !== 'win32' });
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  }
  try {
    const built = await run('pnpm', ['build'], process.env);
    if (stopped) return;
    if (built !== 0) throw new Error('No se pudo compilar el proxy.');
    const { hashPassword } = await import(pathToFileURL(join(root, 'dist/password.js')).href);
    const password = randomBytes(32).toString('base64url');
    const hash = await hashPassword(password);
    if (stopped) return;
    const env = { ...process.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(state.port), PROXY_PUBLIC_URL: state.url, OAUTH_PASSWORD_HASH: hash };
    console.log(`\nContraseña de login: ${password}\nLogin: ${state.url}/oauth/login\nMCP: ${state.url}/mcp\nCtrl+C detiene solo la app; el túnel sigue abierto.\n`);
    const code = await run(process.execPath, [join(root, 'dist/index.js')], env);
    if (!stopped) process.exitCode = code ?? 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
main().catch(error => { if (!process.exitCode) { console.error(`[start-proxy] ${error.message}`); process.exitCode = 1; } });
