#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function main() {
  if (process.argv.includes('--help')) { console.log('Uso: pnpm dev:public https://tu-url\nTambién admite PROXY_PUBLIC_URL.\nArranca solo el proxy y reutiliza la contraseña guardada en data.json. PROXY_PORT: 9910 por defecto.'); return; }
  if (process.argv.length > 3) throw new Error('Uso: pnpm dev:public https://tu-url');
  const publicUrl = (process.argv[2] ?? process.env.PROXY_PUBLIC_URL)?.trim().replace(/\/+$/, '');
  if (!publicUrl) throw new Error('Indicá la URL HTTPS: pnpm dev:public https://tu-url, o configurá PROXY_PUBLIC_URL.');
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' || url.origin !== publicUrl) throw new Error();
  } catch { throw new Error('PROXY_PUBLIC_URL debe ser la URL HTTPS base, sin /mcp, credenciales, query ni fragmento.'); }
  const port = Number(process.env.PROXY_PORT || 9910);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROXY_PORT debe estar entre 1 y 65535.');
  const state = { url: publicUrl, port };
  const probe = createServer();
  try {
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(state.port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  } catch { throw new Error(`El puerto ${state.port} está ocupado. Detené la app anterior; dejá el túnel abierto.`); }
  let child;
  let stopped = false;
  const stop = signal => {
    stopped = true; process.exitCode = signal === 'SIGINT' ? 130 : 143;
    try { if (process.platform === 'win32') child?.kill(); else if (child) process.kill(-child.pid, 'SIGTERM'); } catch { }
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
    const { dataFile, getLoginCredentials } = await import(pathToFileURL(join(root, 'dist/data.js')).href);
    const { password, hash } = await getLoginCredentials(dataFile(root));
    if (stopped) return;
    const env = { ...process.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(state.port), PROXY_PUBLIC_URL: state.url, OAUTH_PASSWORD_HASH: hash };
    console.log(`\nContraseña de login: ${password}\nLogin: ${state.url}/oauth/login\nMCP: ${state.url}/mcp\n` +
      `Endpoint de autorización: ${state.url}/authorize\nEndpoint de token: ${state.url}/token\nÁmbitos: mcp:tools\n` +
      'Ctrl+C detiene solo la app; el túnel sigue abierto.\n');
    const code = await run(process.execPath, [join(root, 'dist/index.js')], env);
    if (!stopped) process.exitCode = code ?? 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
main().catch(error => { if (!process.exitCode) { console.error(`[start-proxy] ${error.message}`); process.exitCode = 1; } });
