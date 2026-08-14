import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildServer } from './server.js';
import { log } from './config.js';

export async function runStdio(cwd: string): Promise<void> {
  const transport = new StdioServerTransport();
  await buildServer(cwd).connect(transport);
  log('Using stdio transport');
}