#!/usr/bin/env node
/*
 * e2e.mjs — Test de integración del harness.
 * Lee el server compilado (dist/llamaharness.js) sobre transporte stdio y
 * comprueba que las tools + recurso básicos funcionan.
 * Salida: 0 si todo OK, 1 si falla. No requiere puerto disponible.
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { exit, stderr } from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const useHttp = process.env.E2E_TRANSPORT === 'http';
const execPath = process.env.E2E_NODE_BIN || process.execPath;

const baseArgs = ['dist/llamaharness.js'];
const srv = useHttp
  ? spawn(execPath, [...baseArgs, '--transport', 'http', '--host', '127.0.0.1', '--port', '9909'], {
      stdio: 'pipe',
    })
  : spawn(execPath, [...baseArgs, '--transport', 'stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });

let log = '';
const sink = (n) => (d) => (log += d.toString());
srv.stderr.on('data', sink('err'));

function ok(msg) {
  stderr.write(`  \u2713 ${msg}\n`);
}
function fail(msg) {
  stderr.write(`  \u2717 ${msg}\n`);
}

let failures = 0;
function assert(cond, msg) {
  if (cond) ok(msg);
  else {
    fail(msg);
    failures++;
  }
}

try {
  await wait(2000);

  let tc;
  if (useHttp) {
    tc = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:9909/mcp'));
  } else {
    tc = new StdioClientTransport({ command: execPath, args: [...baseArgs, '--transport', 'stdio'] });
  }
  const client = new Client({ name: 'e2e-client', version: '0.1.0' }, { capabilities: {} });
  await client.connect(tc);
  ok('conexión establecida');

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert(
    ['create_note', 'list_notes', 'read_note', 'read_file', 'write_file', 'list_dir', 'path_info', 'run_bash'].every((n) => names.includes(n)),
    'todas las tools registradas',
  );

  const bash = await client.callTool({ name: 'run_bash', arguments: { command: 'echo e2e-ok' } });
  assert(bash.content[0].text.includes('e2e-ok'), 'run_bash ejecuta y devuelve stdout');

  const create = await client.callTool({ name: 'create_note', arguments: { name: 'demo', content: 'hola' } });
  assert(create.content[0].text.includes("Nota 'demo' creada"), 'create_note');

  const read = await client.callTool({ name: 'read_note', arguments: { name: 'demo' } });
  assert(read.content[0].text === 'hola', 'read_note');

  const lsn = await client.callTool({ name: 'list_notes', arguments: {} });
  assert(Array.isArray(JSON.parse(lsn.content[0].text)) && JSON.parse(lsn.content[0].text).includes('demo'), 'list_notes incluye demo');

  await client.close();
  ok('cierre limpio');

  if (failures === 0) {
    stderr.write('\nE2E PASS\n');
    exit(0);
  } else {
    stderr.write(`\nE2E FAIL (${failures})\n`);
    exit(1);
  }
} catch (e) {
  fail(`error: ${(e && e.message) || String(e)}`);
  exit(1);
} finally {
  srv.kill('SIGKILL');
}
