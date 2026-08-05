#!/usr/bin/env node
// Este import DEBE ir primero: define globalThis.crypto antes de que el SDK se
// evalúe (ver crypto_polyfill.ts), necesario para el transporte streamable-http
// en Node.js 18.
import './crypto_polyfill.js';

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { registerBashTools } from './bash.js';
import { registerFsTools } from './fs.js';

const SERVER_NAME = 'llamaharness';
const SERVER_VERSION = '0.1.0';

interface CliArgs {
  transport: 'stdio' | 'http' | 'sse';
  host: string;
  port: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { transport: 'stdio', host: '0.0.0.0', port: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--transport':
        args.transport = argv[++i] as CliArgs['transport'];
        break;
      case '--host':
        args.host = argv[++i];
        break;
      case '--port':
        args.port = Number(argv[++i]);
        break;
      case '--help':
      case '-h':
        console.error(`Usage: llamaharness [--transport stdio|http|sse] [--host HOST] [--port PORT]`);
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  if (!['stdio', 'http', 'sse'].includes(args.transport)) {
    console.error(`Invalid transport: ${args.transport} (expected stdio, http or sse)`);
    process.exit(1);
  }
  return args;
}

// Simple in-memory store for the notepad tools
const notes = new Map<string, string>();

function registerNotesTools(server: McpServer): void {
  server.tool(
    'create_note',
    'Crea una nueva nota.',
    { name: z.string().describe('El nombre de la nota.'), content: z.string().describe('El contenido de la nota.') },
    async ({ name, content }) => {
      notes.set(name, content);
      return { content: [{ type: 'text', text: `Nota '${name}' creada con éxito.` }] };
    },
  );

  server.tool(
    'read_note',
    'Lee el contenido de una nota existente.',
    { name: z.string().describe('El nombre de la nota.') },
    async ({ name }) => {
      const content = notes.get(name);
      const text = content === undefined ? `Error: La nota '${name}' no existe.` : content;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.tool('list_notes', 'Lista los nombres de todas las notas guardadas.', {}, async () => {
    return { content: [{ type: 'text', text: JSON.stringify([...notes.keys()]) }] };
  });

  server.resource('notes://all', 'Todas las notas en formato JSON', async () => ({
    contents: [{ uri: 'notes://all', text: JSON.stringify(Object.fromEntries(notes), null, 2) }],
  }));
}

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerBashTools(server);
  registerFsTools(server);
  registerNotesTools(server);
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function log(msg: string): void {
  console.error(`[${SERVER_NAME}] ${msg}`);
}

async function runHttp(args: CliArgs): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await buildServer().connect(transport);

  const httpServer = createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Internal server error: ${(err as Error).message}`);
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(args.port, args.host, resolve));
  log(`Streamable HTTP server on ${args.host}:${args.port} (POST /mcp)`);
}

async function runSse(args: CliArgs): Promise<void> {
  const sessions = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${args.host}:${args.port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        sessions.set(transport.sessionId, transport);
        await buildServer().connect(transport);
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

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await buildServer().connect(transport);
  log('Using stdio transport');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log(`Starting MCP server...`);
  log(`Transport: ${args.transport}`);

  switch (args.transport) {
    case 'stdio':
      await runStdio();
      break;
    case 'http':
      await runHttp(args);
      break;
    case 'sse':
      await runSse(args);
      break;
  }
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] Fatal:`, err);
  process.exit(1);
});
