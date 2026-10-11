#!/usr/bin/env node
import { parseArgs } from './cli.js';
import { SERVER_NAME, log } from './config.js';
import { runHttp } from './http.js';
import { runSse } from './sse.js';
import { runStdio } from './stdio.js';

// Working directory estrictamente igual a la carpeta desde donde se lanza el
// comando. Se ancla explícitamente para que todas las tools (bash, fs) operen
// contra este directorio y no dependan de cambios de cwd posteriores.
const WORK_DIR = process.cwd();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Anclar la carpeta de trabajo (la donde se lanza el comando) antes de arrancar.
  process.chdir(WORK_DIR);
  log(`Starting MCP server...`);
  log(`Transport: ${args.transport}`);
  log(`Working directory: ${WORK_DIR}`);

  switch (args.transport) {
    case 'stdio':
      await runStdio(WORK_DIR);
      break;
    case 'http':
      await runHttp(args, WORK_DIR);
      break;
    case 'sse':
      await runSse(args, WORK_DIR);
      break;
  }
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] Fatal:`, err);
  process.exit(1);
});
