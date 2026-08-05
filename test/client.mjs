#!/usr/bin/env node
import { argv, exit, stderr } from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function getArg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] ?? def : def;
}

const transport = getArg('transport', 'stdio');
const command = getArg('command', 'npx');
const args = getArg('server', 'tsx llamaharness.ts --transport stdio').split(' ');
const url = getArg('url', 'http://127.0.0.1:9908/mcp');
const callIdx = argv.indexOf('--call');

let tc;
if (transport === 'stdio') {
  tc = new StdioClientTransport({ command, args });
} else if (transport === 'sse') {
  tc = new SSEClientTransport(new URL(url.replace('/messages', '').replace(/\/$/, '')));
} else {
  tc = new StreamableHTTPClientTransport(new URL(url));
}

const client = new Client({ name: 'mcp-test-client', version: '0.1.0' }, { capabilities: {} });
await client.connect(tc);
stderr.write(`[client] connected via ${transport}\n`);

if (callIdx !== -1) {
  const name = argv[callIdx + 1];
  const rest = argv.slice(callIdx + 2);
  const input = {};
  if (rest.length % 2 === 0) {
    for (let i = 0; i < rest.length; i += 2) input[rest[i]] = rest[i + 1];
  }
  const r = await client.callTool({ name, arguments: Object.keys(input).length ? input : {} });
  for (const c of r.content) {
    if (c.type === 'text') process.stdout.write(c.text + '\n');
    else process.stdout.write(JSON.stringify(c) + '\n');
  }
} else {
  const { tools } = await client.listTools();
  stderr.write(`[client] tools: ${tools.map((t) => t.name).join(', ')}\n`);
}

await client.close();
exit(0);
