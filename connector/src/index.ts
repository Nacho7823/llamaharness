#!/usr/bin/env node
import { readFile, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorCode, errorStatus } from './errors.js';
import { readState, writeState } from './state.js';
import { cachedToken, deviceLogin } from './auth.js';
import { createManagement, prepareTunnel, createHost, publicOrigin, cancellationToken } from './tunnel.js';
import { assertPortAvailable, startProxy, verifyPublicProxy, resolveProxyEntry } from './proxy.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Uso: pnpm start\nCrea o reutiliza un Dev Tunnel público y arranca oauthProxy.\nConfiguración: connector/config.json. Identificación y túnel: connector/data.json.\nPrimera ejecución: autorizá GitHub con el código que aparece en la terminal.\nDEV_TUNNELS_GITHUB_TOKEN permite usar un token de GitHub existente.');
    return;
  }
  if (process.argv.length > 2) throw new Error('Uso: pnpm start (sin argumentos).');
  const config = JSON.parse(await readFile(join(ROOT, 'config.json'), 'utf8'));
  const port = config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('config.json requiere port entre 1 y 65535.');
  }
  const proxyEntry = resolveProxyEntry();
  await assertPortAvailable(port);

  // Evita que dos arranques creen túneles distintos o pisen las credenciales.
  const lockPath = join(ROOT, '.running');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (errorCode(error) === 'EEXIST') throw new Error('Connector ya está ejecutándose. Si terminó abruptamente, borrá connector/.running.');
    throw error;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const cancellation = cancellationToken(controller.signal);
  let host: ReturnType<typeof createHost> | undefined;
  let proxy: ReturnType<typeof startProxy> | undefined;
  try {
    const statePath = join(ROOT, 'data.json');
    const state = await readState(statePath);
    async function getToken(): Promise<string> {
      let token = cachedToken(state);
      if (!token) {
        state.auth = await deviceLogin({ signal: controller.signal });
        await writeState(statePath, state);
        token = state.auth.accessToken;
      }
      return token;
    }
    await getToken();
    controller.signal.throwIfAborted();
    console.log('[connector] Preparando el túnel público…');
    const management = createManagement(getToken);
    let tunnel;
    try {
      tunnel = await prepareTunnel(management, state.tunnel, port, async reference => {
        state.tunnel = reference;
        await writeState(statePath, state);
      }, cancellation);
    } catch (error) {
      if (errorStatus(error) === 401) {
        delete state.auth;
        await writeState(statePath, state);
        throw new Error('La autorización de GitHub venció. Ejecutá pnpm start para identificarte de nuevo.');
      }
      throw error;
    }
    controller.signal.throwIfAborted();
    host = createHost(management);
    host.connectionStatusChanged(event => {
      if (event.status === 'disconnected' && !controller.signal.aborted) {
        console.error('[connector] El túnel se desconectó y no pudo recuperar la conexión. Ejecutá pnpm start otra vez.');
        process.exitCode = 1;
        stop();
      }
    });
    await host.connect(tunnel, { enableRetry: false, enableReconnect: true }, cancellation);
    controller.signal.throwIfAborted();
    tunnel = await management.getTunnel(tunnel, { includePorts: true }, cancellation);
    const origin = publicOrigin(tunnel, port);
    state.publicUrl = origin;
    await writeState(statePath, state);
    proxy = startProxy(proxyEntry, port, origin);
    await proxy.ready(controller.signal);
    await verifyPublicProxy(origin, controller.signal);
    console.log([
      `Login: ${origin}/oauth/login`,
      `MCP: ${origin}/mcp`,
      `Endpoint de autorización: ${origin}/authorize`,
      `Endpoint de token: ${origin}/token`,
      'Ámbitos: mcp:tools',
    ].join('\n'));
    console.log(`[connector] Túnel listo: ${origin}\n[connector] Ctrl+C detiene el proxy y la conexión; conserva la URL para el próximo arranque.`);
    const result = await Promise.race([
      proxy.done,
      new Promise<null>(resolve => {
        if (controller.signal.aborted) resolve(null);
        else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
    ]);
    if (result && result.code !== 0) throw new Error('oauthProxy terminó inesperadamente.');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controller.abort();
    const cleanup = await Promise.allSettled([proxy?.stop(), host?.dispose()]);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await lock.close();
    await unlink(lockPath);
    if (cleanup.some(result => result.status === 'rejected')) {
      console.error('[connector] No se pudo completar el cierre de la conexión.');
      process.exitCode = 1;
    }
  }
}

main().catch(error => {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'CancellationError')) return;
  // Los errores del SDK pueden incluir cabeceras con tokens: nunca volcar el objeto.
  const status = errorStatus(error);
  console.error(`[connector] ${status ? `Dev Tunnels respondió HTTP ${status}.` : error instanceof Error ? error.message : 'Error inesperado.'}`);
  process.exitCode = 1;
});
