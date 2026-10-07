import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

interface ProxyExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function resolveProxyEntry(): string {
  return createRequire(import.meta.url).resolve('oauthProxy');
}

export async function assertPortAvailable(port: number): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch {
    throw new Error(`El puerto ${port} está ocupado. Detené el oauthProxy anterior antes de ejecutar connector.`);
  }
}

export function startProxy(entry: string, port: number, origin: string, options: { env?: NodeJS.ProcessEnv; stdio?: 'inherit' | 'ignore' } = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(dirname(entry)), stdio: options.stdio ?? 'inherit',
    env: { ...process.env, ...options.env, PROXY_HOST: '127.0.0.1', PROXY_PORT: String(port), PROXY_PUBLIC_URL: origin },
  });
  const done = new Promise<ProxyExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    done,
    async ready(signal: AbortSignal): Promise<void> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const result = await Promise.race([
          done.then(() => 'ended'),
          (async () => {
            try {
              const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
              });
              const body = await r.json();
              return r.ok && body.ok === true && body.issuer === origin;
            } catch { return false; }
          })(),
        ]);
        if (result === 'ended') throw new Error('oauthProxy terminó antes de estar listo.');
        if (result === true) return;
        await delay(200, undefined, { signal });
      }
      throw new Error('oauthProxy no arrancó en 60 segundos.');
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      timer.unref();
      try { await done; } finally { clearTimeout(timer); }
    },
  };
}

export async function verifyPublicProxy(origin: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetcher(`${origin}/healthz`, {
        headers: { Accept: 'application/json', 'User-Agent': 'llamaharness-connector/0.1' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      const body = await response.json();
      if (response.ok && body.ok === true && body.issuer === origin) return;
    } catch { /* El relay puede tardar en activar el puerto. */ }
    if (attempt < 2) await delay(1000, undefined, { signal });
  }
  throw new Error('No se pudo verificar /healthz desde la URL pública. Revisá el acceso público del túnel y la conexión.');
}
