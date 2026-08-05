import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

const file = process.argv[2];
if (!file) {
  let d = '';
  stdin.on('data', (c) => (d += c));
  stdin.on('end', () => parse(d));
} else {
  parse(readFileSync(file, 'utf8'));
}

function parse(raw) {
  // MCP streamable HTTP responde como SSE (event: message\ndata: {...}).
  let data = raw;
  if (raw.includes('event:')) {
    const m = raw.match(/data:\s*(\{.*\})/s);
    if (m) data = m[1];
  }
  let j;
  try {
    j = JSON.parse(data);
  } catch {
    stdout.write(`[raw ${raw.length}b] ${raw.slice(0, 200)}\n`);
    return;
  }
  if (j.error) stdout.write(`ERROR ${j.error.code}: ${j.error.message}\n`);
  else if (j.result) {
    if (j.result.tools) {
      stdout.write(`tools (${j.result.tools.length}): ${j.result.tools.map((t) => t.name).sort().join(', ')}\n`);
    } else if (j.result.protocolVersion) {
      stdout.write(`init result: protocol=${j.result.protocolVersion}\n`);
    } else {
      stdout.write(`result: ${JSON.stringify(j.result).slice(0, 160)}\n`);
    }
  } else stdout.write(`json: ${JSON.stringify(j).slice(0, 200)}\n`);
}
