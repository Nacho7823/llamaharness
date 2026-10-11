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
    ['create_note', 'list_notes', 'read_note', 'read_file', 'read_image', 'write_file', 'list_dir', 'path_info', 'run_bash'].every((n) => names.includes(n)),
    'todas las tools registradas',
  );

  const image = await client.callTool({ name: 'read_image', arguments: { path: '../docs/image.png' } });
  assert(!image.isError && image.content.some(block => block.type === 'image' && block.mimeType === 'image/png' && block.data.length > 0), 'read_image devuelve una imagen MCP');

  const bash = await client.callTool({ name: 'run_bash', arguments: { command: 'echo e2e-ok' } });
  assert(bash.content[0].text.includes('e2e-ok'), 'run_bash ejecuta y devuelve stdout');

  const create = await client.callTool({ name: 'create_note', arguments: { name: 'demo', content: 'hola' } });
  assert(create.content[0].text.includes("Nota 'demo' creada"), 'create_note');

  const read = await client.callTool({ name: 'read_note', arguments: { name: 'demo' } });
  assert(read.content[0].text === 'hola', 'read_note');

  const lsn = await client.callTool({ name: 'list_notes', arguments: {} });
  assert(Array.isArray(JSON.parse(lsn.content[0].text)) && JSON.parse(lsn.content[0].text).includes('demo'), 'list_notes incluye demo');

  // read_file con offset/limit (paginado en caracteres)
  const big = 'A'.repeat(300);
  await client.callTool({ name: 'write_file', arguments: { path: '/tmp/_e2e_readfile.txt', content: big } });
  const paged = await client.callTool({ name: 'read_file', arguments: { path: '/tmp/_e2e_readfile.txt', limit: 50 } });
  {
    const m = paged.content[0].text.match(/returned_chars: (\d+).*?total_chars: (\d+).*?truncated: (true|false)/s);
    assert(m && Number(m[1]) === 50 && Number(m[2]) === 300 && m[3] === 'true', 'read_file limit=50 -> returned_chars=50, total=300, truncated=true');
  }
  const slice = await client.callTool({ name: 'read_file', arguments: { path: '/tmp/_e2e_readfile.txt', offset: 260, limit: 50 } });
  {
    const m = slice.content[0].text.match(/returned_chars: (\d+).*?truncated: (true|false)/s);
    assert(m && Number(m[1]) === 40 && m[2] === 'false', 'read_file offset=260 limit=50 -> returned_chars=40, truncated=false');
  }
  await client.callTool({ name: 'run_bash', arguments: { command: 'rm -f /tmp/_e2e_readfile.txt' } });

  // write_file atómico + append
  await client.callTool({ name: 'write_file', arguments: { path: '/tmp/_e2e_write.txt', content: 'line1\nline2\n' } });
  const app = await client.callTool({ name: 'write_file', arguments: { path: '/tmp/_e2e_write.txt', content: 'line3\n', append: true } });
  assert(app.content[0].text.includes('Appended'), 'write_file append=true funciona');

  // edit_file: str_replace
  await client.callTool({ name: 'write_file', arguments: { path: '/tmp/_e2e_edit.txt', content: 'apple\nbanana\nbanana\ncherry\n' } });
  const amb = await client.callTool({ name: 'edit_file', arguments: { path: '/tmp/_e2e_edit.txt', old_string: 'banana', new_string: 'kiwi' } });
  assert(/ambiguous/.test(amb.content[0].text), 'edit_file rechaza match ambigüo (2 ocurrencias)');

  const okSingle = await client.callTool({ name: 'edit_file', arguments: { path: '/tmp/_e2e_edit.txt', old_string: 'apple', new_string: 'APPLE' } });
  assert(okSingle.content[0].text.includes('Replaced 1 occurrence'), 'edit_file str_replace unico');

  const ra = await client.callTool({ name: 'edit_file', arguments: { path: '/tmp/_e2e_edit.txt', old_string: 'banana', new_string: 'kiwi', replace_all: true } });
  assert(ra.content[0].text.includes('Replaced 2 occurrence'), 'edit_file replace_all=true');

  const dry = await client.callTool({ name: 'edit_file', arguments: { path: '/tmp/_e2e_edit.txt', old_string: 'cherry', new_string: 'CHERRY', dry_run: true } });
  assert(dry.content[0].text.startsWith('DRY RUN'), 'edit_file dry_run no escribe');
  const afterDry = await client.callTool({ name: 'read_file', arguments: { path: '/tmp/_e2e_edit.txt' } });
  assert(!afterDry.content[0].text.includes('CHERRY'), 'dry_run no modifica el archivo');

  const nf = await client.callTool({ name: 'edit_file', arguments: { path: '/tmp/_e2e_edit.txt', old_string: 'nope', new_string: 'x' } });
  assert(/not found/.test(nf.content[0].text), 'edit_file error si old_string no existe');

  // edit_lines
  await client.callTool({ name: 'write_file', arguments: { path: '/tmp/_e2e_lines.txt', content: 'l1\nl2\nl3\nl4\n' } });
  const el = await client.callTool({ name: 'edit_lines', arguments: { path: '/tmp/_e2e_lines.txt', start_line: 2, end_line: 3, new_text: 'X\nY\nZ' } });
  assert(el.content[0].text.includes('Replaced lines 2..3'), 'edit_lines range válido');
  const elAfter = await client.callTool({ name: 'read_file', arguments: { path: '/tmp/_e2e_lines.txt' } });
  assert(elAfter.content[0].text.includes('l1\nX\nY\nZ\nl4'), 'edit_lines contenido correcto');
  const elBad = await client.callTool({ name: 'edit_lines', arguments: { path: '/tmp/_e2e_lines.txt', start_line: 1, end_line: 99, new_text: 'q' } });
  assert(/invalid line range/.test(elBad.content[0].text), 'edit_lines rechaza rango fuera de rango');

  await client.callTool({ name: 'run_bash', arguments: { command: 'rm -f /tmp/_e2e_edit.txt /tmp/_e2e_write.txt /tmp/_e2e_lines.txt' } });

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
