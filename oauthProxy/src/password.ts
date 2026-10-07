import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const FORMAT = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

export function validPasswordHash(hash: string): boolean {
  return FORMAT.test(hash);
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error('La contraseña debe tener al menos 12 caracteres y como máximo 1024 bytes.');
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$131072$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const fields = hash.match(FORMAT);
  if (!fields || !password || Buffer.byteLength(password) > 1024) return false;
  const key = await derive(password, Buffer.from(fields[1], 'hex'));
  return timingSafeEqual(key, Buffer.from(fields[2], 'hex'));
}
