import { createServer } from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { buildServer } from './server.js';
import { log } from './config.js';
import type { CliArgs } from './cli.js';

export async function runSse(args: CliArgs, cwd: string): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${args.host}:${args.port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        sessions.set(transport.sessionId, transport);
        await buildServer(cwd).connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Session not found');
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Internal server error: ${(err as Error).message}`);
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(args.port, args.host, resolve));
  log(`SSE server on ${args.host}:${args.port} (GET /sse)`);
}