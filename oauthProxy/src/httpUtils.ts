// httpUtils.ts — Helpers mínimos sobre node:http (sin framework).
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY = 10 * 1024 * 1024;

export function readBody(req: IncomingMessage, maxBytes = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  res.end(body);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

export function parseForm(body: Buffer, contentType?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const ct = contentType ?? '';
  if (ct.includes('application/json')) {
    try {
      const j = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(j)) if (typeof v === 'string') out[k] = v;
    } catch {
      // cuerpo inválido: se devuelve vacío y el llamante responde 400
    }
    return out;
  }
  // Por defecto application/x-www-form-urlencoded (OAuth2).
  for (const [k, v] of new URLSearchParams(body.toString('utf8'))) out[k] = v;
  return out;
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
