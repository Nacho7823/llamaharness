import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function imageMimeType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  const header = data.subarray(0, 6).toString('ascii');
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' &&
      data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

export function registerImageTools(server: McpServer, opts?: { cwd?: string }): void {
  const base = opts?.cwd ?? process.cwd();
  server.tool(
    'read_image',
    'Read a local PNG, JPEG, GIF or WebP image for visual inspection. Returns an MCP image content block. Maximum file size: 10 MiB.',
    { path: z.string().describe('Absolute or relative path to the image (relative to the server working directory)') },
    async ({ path }) => {
      const full = resolve(base, path);
      try {
        const file = await open(full, 'r');
        let data: Buffer;
        try {
          const stats = await file.stat();
          if (!stats.isFile()) throw new Error('Path must point to a regular file.');
          if (stats.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 10 MiB size limit.');
          // Read at most the limit plus one byte, even if the file grows after stat.
          const buffer = Buffer.alloc(Math.min(stats.size + 1, MAX_IMAGE_BYTES + 1));
          let total = 0;
          while (total < buffer.length) {
            const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
            if (bytesRead === 0) break;
            total += bytesRead;
          }
          if (total > MAX_IMAGE_BYTES || total > stats.size) {
            throw new Error('Image changed while reading or exceeds the 10 MiB size limit. Retry with a stable file.');
          }
          data = buffer.subarray(0, total);
        } finally {
          await file.close();
        }
        const mimeType = imageMimeType(data);
        if (!mimeType) throw new Error('Unsupported image format. Use PNG, JPEG, GIF or WebP.');
        return {
          content: [
            { type: 'text' as const, text: `path: ${full}\nsize: ${data.length} bytes\nmime_type: ${mimeType}` },
            { type: 'image' as const, data: data.toString('base64'), mimeType },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error reading image ${full}: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
