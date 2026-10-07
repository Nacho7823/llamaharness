import { createServer, type IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { buildServer } from './server.js';
import { log } from './config.js';
import type { CliArgs } from './cli.js';
import { isAuthorized, resolveApiKey, sendUnauthorized } from './auth.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function runHttp(args: CliArgs, cwd: string): Promise<void> {
  // Modo **stateless**: se crea un transporte y servidor MCP frescos POR request
  // y se destruyen al finalizar. No hay cookies ni `mcp-session-id`, por lo que:
  //   - reenviar `initialize` (p.ej. un cors-proxy reintenta) NO lanza "Server
  //     already initialized", ya que cada request parte de cero;
  //   - `notifications/initialized` y `tools/list`/`tools/call` funcionan de forma
  //     independiente.
  // Es el modo recomendado para servidores MCP simples detrás de proxies/cors que
  // no emiten notificaciones server-push. Los datos persisten porque el store de
  // notas (`notes`) es un módulo (compartido entre requests).
  const expectedApiKey = resolveApiKey(args);
  const httpServer = createServer(async (req, res) => {
    // Auth primero: no leer body ni instanciar MCP si la key es inválida.
    if (!isAuthorized(req, expectedApiKey)) {
      sendUnauthorized(res);
      return;
    }
    try {
      const body = await readBody(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer(cwd);
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      await transport.close();
      await server.close();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Internal server error: ${(err as Error).message}`);
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(args.port, args.host, resolve));
  log(`Streamable HTTP server (stateless) on ${args.host}:${args.port} (POST /mcp)`);
  log(`Auth: ${expectedApiKey ? 'enabled (Authorization: Bearer / x-api-key)' : 'disabled (no API key configured)'}`);
}