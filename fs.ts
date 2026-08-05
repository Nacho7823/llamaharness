import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const MAX_READ_BYTES = 200_000;
const MAX_LIMIT = 1_000_000;

export function registerFsTools(server: McpServer, opts?: { cwd?: string }): void {
  const base = opts?.cwd ?? process.cwd();
  const abs = (path: string) => resolve(base, path);
  server.tool(
    'read_file',
    'Read the contents of a file at the given path. Supports paged reads via character `offset`/`limit`.',
    {
      path: z.string().describe('Absolute or relative path to the file'),
      offset: z
        .coerce.number()
        .int()
        .nonnegative()
        .optional()
        .describe('Character index to start reading from (default 0).'),
      limit: z
        .coerce.number()
        .int()
        .positive()
        .max(MAX_LIMIT)
        .optional()
        .describe(
          `Maximum number of characters to return. If omitted, capped at ${MAX_READ_BYTES} (safety).`,
        ),
    },
    async ({ path, offset = 0, limit }) => {
      const full = abs(path);
      const stats = await stat(full);
      const content = await readFile(full, 'utf8');
      const total = content.length;
      const start = Math.min(offset, total);
      const end = Math.min(start + (limit ?? MAX_READ_BYTES), total);
      const text = content.slice(start, end);
      const truncated = end < total;
      return {
        content: [
          {
            type: 'text',
            text: `path: ${full}\nsize: ${stats.size} bytes\noffset: ${start}\nreturned_chars: ${text.length}\ntotal_chars: ${total}\ntruncated: ${truncated}\n\n${text}`,
          },
        ],
      };
    },
  );

  server.tool(
    'write_file',
    'Write content to a file, creating parent directories as needed.',
    {
      path: z.string().describe('Absolute or relative path to the file'),
      content: z.string().describe('Content to write'),
    },
    async ({ path, content }) => {
      const full = abs(path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
      return { content: [{ type: 'text', text: `Wrote ${content.length} bytes to ${full}` }] };
    },
  );

  server.tool(
    'list_dir',
    'List the contents of a directory with type and size.',
    { path: z.string().default('.').describe('Directory to list') },
    async ({ path }) => {
      const full = abs(path);
      const entries = await readdir(full, { withFileTypes: true });
      const lines = await Promise.all(
        entries.map(async (entry) => {
          const childPath = `${full}/${entry.name}`;
          try {
            const s = await stat(childPath);
            const kind = entry.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
            return `${entry.name}\t${kind}\t${s.size}`;
          } catch {
            return `${entry.name}\tunknown\t-`;
          }
        }),
      );
      return { content: [{ type: 'text', text: `path: ${full}\n\n${lines.join('\n')}` }] };
    },
  );

  server.tool(
    'path_info',
    'Return info about a path: whether it exists, type, and size.',
    { path: z.string().describe('Path to inspect') },
    async ({ path }) => {
      const full = abs(path);
      try {
        const s = await stat(full);
        const type = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
        return { content: [{ type: 'text', text: `path: ${full}\ntype: ${type}\nsize: ${s.size}` }] };
      } catch {
        return { content: [{ type: 'text', text: `path: ${full}\nnot found` }] };
      }
    },
  );
}
