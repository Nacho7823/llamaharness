import { readFile, writeFile, appendFile, readdir, stat, mkdir, copyFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const MAX_READ_BYTES = 200_000;
const MAX_LIMIT = 1_000_000;

/** Escribe atomicamente (temp + rename) sobre POSIX. Opcionalmente backup con ~. */
async function writeAtomic(full: string, content: string, opts: { backup?: boolean } = {}): Promise<void> {
  if (opts.backup) {
    try {
      await copyFile(full, `${full}~`);
    } catch {
      /* no existe aún, sin backup */
    }
  }
  await mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, full);
}

async function pathExists(full: string): Promise<boolean> {
  try {
    await stat(full);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(hay: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let i = 0;
  let idx: number;
  while ((idx = hay.indexOf(needle, i)) !== -1) {
    count++;
    i = idx + needle.length;
  }
  return count;
}

/** Convierte el contenido en líneas "reales": un trailing \n no cuenta como línea extra. */
function splitLines(content: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = content.endsWith('\n');
  const all = content.split('\n');
  if (trailingNewline) all.pop();
  return { lines: all, trailingNewline };
}

/** Hunk de diff unificado simplificado para un solo bloque (preview). */
function unifyHunk(oldLines: string[], newLines: string[], startLine: number): string {
  return [
    `@@ line ${startLine} @@`,
    ...oldLines.map((l) => `- ${l}`),
    ...newLines.map((l) => `+ ${l}`),
  ].join('\n');
}

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
        .describe(`Maximum number of characters to return. If omitted, capped at ${MAX_READ_BYTES} (safety).`),
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
    'Create or overwrite a file atomically. Use append=true to append instead of replacing.',
    {
      path: z.string().describe('Absolute or relative path to the file'),
      content: z.string().describe('Content to write'),
      append: z.boolean().optional().describe('If true, append to the file instead of overwriting (default false).'),
    },
    async ({ path, content, append }) => {
      const full = abs(path);
      if (append) {
        await mkdir(dirname(full), { recursive: true });
        await appendFile(full, content, 'utf8');
        return { content: [{ type: 'text', text: `Appended ${content.length} bytes to ${full}` }] };
      }
      const exists = await pathExists(full);
      await writeAtomic(full, content, { backup: exists });
      return {
        content: [
          {
            type: 'text',
            text: `${exists ? 'Overwrote' : 'Created'} ${content.length} bytes to ${full}${exists ? ' (backup at ' + full + '~)' : ''}`,
          },
        ],
      };
    },
  );

  server.tool(
    'edit_file',
    'Exact string replace (str_replace): find `old_string` and replace with `new_string`. ' +
      'Requires a unique match unless replace_all=true. No regex. dry_run=true returns a preview diff without writing.',
    {
      path: z.string().describe('Absolute or relative path to the file'),
      old_string: z.string().describe('Exact text to find (literal, no regex).'),
      new_string: z.string().describe('Replacement text.'),
      replace_all: z.boolean().optional().describe('If true, replace every occurrence (default false).'),
      dry_run: z.boolean().optional().describe('If true, return a diff preview without writing (default false).'),
    },
    async ({ path, old_string, new_string, replace_all = false, dry_run = false }) => {
      if (old_string === '') {
        return {
          content: [{ type: 'text', text: `Error: old_string is empty in ${path}` }],
          isError: true,
        };
      }
      const full = abs(path);
      const content = await readFile(full, 'utf8');
      const occurrences = countOccurrences(content, old_string);

      if (occurrences === 0) {
        return {
          content: [{ type: 'text', text: `Error: old_string not found in ${full}` }],
          isError: true,
        };
      }
      if (occurrences > 1 && !replace_all) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: old_string is ambiguous (${occurrences} matches) in ${full}. ` +
                'Set replace_all=true to replace all, or provide more context to make it unique.',
            },
          ],
          isError: true,
        };
      }

      const firstIdx = content.indexOf(old_string);
      const newContent = replace_all
        ? content.split(old_string).join(new_string)
        : content.slice(0, firstIdx) + new_string + content.slice(firstIdx + old_string.length);

      const oldLine = content.slice(0, firstIdx).split('\n').length;
      const hunk = unifyHunk(old_string.split('\n'), new_string.split('\n'), oldLine);

      if (dry_run) {
        return {
          content: [
            {
              type: 'text',
              text: `DRY RUN: would ${replace_all ? `replace all ${occurrences} occurrence(s)` : 'replace 1 occurrence'} in ${full}\n\n${hunk}`,
            },
          ],
        };
      }

      const exists = await pathExists(full);
      await writeAtomic(full, newContent, { backup: exists });
      return {
        content: [
          {
            type: 'text',
            text: `Replaced ${occurrences} occurrence(s) in ${full} (offset ${firstIdx}, old_chars ${old_string.length}, new_chars ${new_string.length}). Backup at ${full}~` +
              `\n\n${hunk}`,
          },
        ],
      };
    },
  );

  server.tool(
    'edit_lines',
    'Replace a 1-indexed inclusive line range [start_line..end_line] with new_text. dry_run=true previews without writing.',
    {
      path: z.string().describe('Absolute or relative path to the file'),
      start_line: z.number().int().positive().describe('First line to replace (1-indexed).'),
      end_line: z.number().int().positive().describe('Last line to replace (1-indexed, inclusive).'),
      new_text: z.string().describe('Replacement text (may contain newlines).'),
      dry_run: z.boolean().optional().describe('If true, return a diff preview without writing (default false).'),
    },
    async ({ path, start_line, end_line, new_text, dry_run = false }) => {
      const full = abs(path);
      const content = await readFile(full, 'utf8');
      const { lines, trailingNewline } = splitLines(content);
      const total = lines.length;

      if (start_line < 1 || end_line < start_line || end_line > total) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: invalid line range [${start_line}..${end_line}] in ${full} (file has ${total} line(s)).`,
            },
          ],
          isError: true,
        };
      }

      const removed = lines.slice(start_line - 1, end_line);
      const inserted = new_text.split('\n');
      const newLines = [
        ...lines.slice(0, start_line - 1),
        ...inserted,
        ...lines.slice(end_line),
      ];
      const newContent = newLines.join('\n') + (trailingNewline ? '\n' : '');

      const hunk = unifyHunk(removed, inserted, start_line);

      if (dry_run) {
        return {
          content: [
            {
              type: 'text',
              text: `DRY RUN: would replace lines ${start_line}..${end_line} in ${full} (${removed.length} removed, ${inserted.length} inserted)\n\n${hunk}`,
            },
          ],
        };
      }

      const exists = await pathExists(full);
      await writeAtomic(full, newContent, { backup: exists });
      return {
        content: [
          {
            type: 'text',
            text: `Replaced lines ${start_line}..${end_line} in ${full} (${removed.length} removed, ${inserted.length} inserted). Backup at ${full}~\n\n${hunk}`,
          },
        ],
      };
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
