#!/usr/bin/env node
import { randomBytes } from 'node:crypto';

// Uso: npx tsx scripts/generate-key.ts [bytes]
// Genera una API key aleatoria (hex) para LLAMAHARNESS_API_KEY / --api-key.
const bytes = Number(process.argv[2] ?? 32);
if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
  console.error('Usage: generate-key.ts [bytes]  (16-128, default 32)');
  process.exit(1);
}

console.log(randomBytes(bytes).toString('hex'));
