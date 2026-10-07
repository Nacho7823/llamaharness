#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTunnelUrl } from './start-tmole.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stateFile = process.env.TUNNEL_STATE_FILE || join(root, '.tunnel.json');
const port = Number(process.env.PROXY_PORT || 9910);
if (process.argv.includes('--help')) {
  console.log('Uso: pnpm tunnel:open\nAbre solamente el túnel al PROXY_PORT (9910 por defecto).\nEn otra terminal: pnpm dev:tunnel. Ctrl+C cierra únicamente el túnel.');
  process.exit(0);
}

function running(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROXY_PORT debe estar entre 1 y 65535.');
  try {
    const previous = JSON.parse(await readFile(stateFile, 'utf8'));
    if (running(previous.pid)) throw new Error('Ya hay un túnel abierto. Usá pnpm dev:tunnel en otra terminal.');
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }

  // Tunnelmole exige un puerto abierto. Este servidor solo responde 503 hasta
  // recibir la URL, luego libera el puerto para que la app pueda arrancar.
  const bootstrap = createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('El túnel está iniciando.');
  });
  await new Promise((resolve, reject) => {
    bootstrap.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
    bootstrap.listen(port, '127.0.0.1', resolve);
  });
  async function closeBootstrap() {
    if (bootstrap.listening) await new Promise(resolve => { bootstrap.close(resolve); bootstrap.closeAllConnections(); });
  }
  const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'SYSTEMROOT', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawn('pnpx', ['tmole', String(port)], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error })); });
  let stopped = false;
  const stop = signal => {
    stopped = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {}
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const id = randomBytes(16).toString('hex');
  let timer;
  try {
    const url = await new Promise((resolve, reject) => {
      const buffers = { stdout: '', stderr: '' };
      const seconds = Number(process.env.TMOLE_TIMEOUT_SEC || 45);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) return reject(new Error('TMOLE_TIMEOUT_SEC debe estar entre 1 y 300.'));
      timer = setTimeout(() => reject(new Error('Tunnelmole no anunció una URL HTTPS a tiempo.')), seconds * 1000);
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
        process[stream].write(chunk);
        buffers[stream] = (buffers[stream] + chunk).slice(-65536);
        const found = parseTunnelUrl(buffers[stream].slice(0, buffers[stream].lastIndexOf('\n') + 1), port);
        if (found) resolve(found);
      });
      done.then(() => reject(new Error('Tunnelmole terminó antes de anunciar su URL. Revisá el mensaje anterior.')));
    });
    clearTimeout(timer);
    await closeBootstrap();
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    await writeFile(`${stateFile}.${id}.tmp`, JSON.stringify({ url, port, pid: process.pid, id }) + '\n', { mode: 0o600 });
    await rename(`${stateFile}.${id}.tmp`, stateFile);
    console.log(`\nTúnel abierto: ${url}\nMCP: ${url}/mcp\nEn otra terminal ejecutá: pnpm dev:tunnel\nPodés reiniciar la app sin cerrar esta terminal. Ctrl+C cierra solo el túnel.\n`);
    const result = await done;
    if (!stopped) throw new Error(`Tunnelmole terminó (${result.code ?? result.signal ?? result.error?.message}).`);
  } finally {
    clearTimeout(timer);
    await closeBootstrap();
    try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 500))]);
    try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { if (JSON.parse(await readFile(stateFile, 'utf8')).id === id) await unlink(stateFile); } catch {}
    await unlink(`${stateFile}.${id}.tmp`).catch(() => {});
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
}
main().catch(error => { if (!process.exitCode) { console.error(`[open-tunnel] ${error.message}`); process.exitCode = 1; } });
