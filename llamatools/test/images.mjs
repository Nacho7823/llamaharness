import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../dist/server.js';

test('read_image returns MCP images and handles invalid inputs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'llamatools-images-'));
  const server = buildServer(cwd);
  const client = new Client({ name: 'image-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert(tools.some(tool => tool.name === 'read_image'));
    const call = path => client.callTool({ name: 'read_image', arguments: { path } });

    // Use a real PNG and verify that all its bytes survive MCP serialization.
    const png = await readFile(new URL('../../docs/image.png', import.meta.url));
    await writeFile(join(cwd, 'picture.bin'), png);
    for (const path of ['picture.bin', join(cwd, 'picture.bin')]) {
      const result = await call(path);
      assert(!result.isError);
      const image = result.content.find(block => block.type === 'image');
      assert.equal(image.mimeType, 'image/png');
      assert.deepEqual(Buffer.from(image.data, 'base64'), png);
      assert(result.content[0].text.includes(join(cwd, 'picture.bin')));
    }

    // Signature detection is independent of the extension; these are header fixtures.
    for (const [name, bytes, mime] of [
      ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
      ['gif87', Buffer.from('GIF87a'), 'image/gif'],
      ['gif89', Buffer.from('GIF89a'), 'image/gif'],
      ['webp', Buffer.from('RIFF\x00\x00\x00\x00WEBP'), 'image/webp'],
    ]) {
      await writeFile(join(cwd, name), bytes);
      const result = await call(name);
      assert(!result.isError);
      assert.equal(result.content.find(block => block.type === 'image').mimeType, mime);
    }

    for (const [name, bytes] of [
      ['fake.png', Buffer.from('plain text')],
      ['empty', Buffer.alloc(0)],
      ['short.png', png.subarray(0, 4)],
      ['audio.webp', Buffer.from('RIFF\x00\x00\x00\x00WAVE')],
    ]) {
      await writeFile(join(cwd, name), bytes);
      const result = await call(name);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unsupported image format/);
    }
    const oversized = await open(join(cwd, 'large.png'), 'w');
    try { await oversized.truncate(10 * 1024 * 1024 + 1); }
    finally { await oversized.close(); }
    const largeResult = await call('large.png');
    assert.equal(largeResult.isError, true);
    assert.match(largeResult.content[0].text, /10 MiB/);
    assert.equal((await call('missing.png')).isError, true);
    assert.equal((await call('.')).isError, true);
    // A failed image call must leave the server usable.
    assert.equal((await call('picture.bin')).content[1].type, 'image');
  } finally {
    await client.close();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
