import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerBashTools } from './bash.js';
import { registerFsTools } from './fs.js';
import { registerNotesTools } from './notes.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';

export function buildServer(cwd: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerBashTools(server, { cwd });
  registerFsTools(server, { cwd });
  registerNotesTools(server);
  return server;
}