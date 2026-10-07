// keys.ts — Llave RS256 local auto-contenida. Sin red, sin IdP externo.
// Genera la llave al primer arranque y la persiste en KEYS_DIR (.gitignore).
// `kid` estable ("local-dev-1") mientras la llave persista.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from 'jose';

const KID = 'local-dev-1';
const ALG = 'RS256';

interface KeyMaterial {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  privateKey: any;
  publicJwk: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jwks: { keys: Record<string, unknown>[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifier: (jwt: string, opts: { issuer: string; audience: string }) => Promise<{ payload: JWTPayload }>;
  kid: string;
}

let cached: KeyMaterial | undefined;

const PRIV_NAME = 'private.pem';

export async function getKeys(keysDir: string): Promise<KeyMaterial> {
  if (cached) return cached;
  await mkdir(keysDir, { recursive: true });

  // 1) PEM vía env (inyectable en prod local sin archivos).
  const fromEnv = process.env.DEV_PRIVATE_KEY_PEM?.trim();
  if (fromEnv) {
    const normalized = fromEnv.replace(/\\n/g, '\n');
    const privateKey = await importPKCS8(normalized, ALG);
    cached = await toMaterial(privateKey);
    return cached;
  }

  // 2) PEM persistido en disco.
  try {
    const pem = (await readFile(join(keysDir, PRIV_NAME), 'utf8')).trim();
    if (pem) {
      const privateKey = await importPKCS8(pem, ALG);
      cached = await toMaterial(privateKey);
      return cached;
    }
  } catch {
    // No existe: generar.
  }

  const { privateKey } = await generateKeyPair(ALG, { extractable: true });
  const pem = await exportPKCS8(privateKey);
  await writeFile(join(keysDir, PRIV_NAME), pem + '\n', { mode: 0o600 });
  cached = await toMaterial(privateKey);
  return cached;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toMaterial(privateKey: any): Promise<KeyMaterial> {
  const publicJwk = (await exportJWK(privateKey)) as never as Record<string, unknown>;
  // generateKeyPair devuelve {publicKey, privateKey}; exportJWK(privateKey) expone
  // partes privadas. Derivamos la pública quedándonos solo con campos públicos.
  const { kty, n, e } = publicJwk as { kty?: string; n?: string; e?: string };
  const pub: Record<string, unknown> = { kty, alg: ALG, use: 'sig', kid: KID, n, e };
  const jwks = { keys: [pub] };
  const localSet = createLocalJWKSet(jwks as never);
  return {
    privateKey,
    publicJwk: pub,
    jwks,
    kid: KID,
    verifier: async (jwt: string, opts: { issuer: string; audience: string }) => {
      const { payload } = await jwtVerify(jwt, localSet, {
        issuer: opts.issuer,
        audience: opts.audience,
      });
      return { payload };
    },
  };
}

export async function signAccessToken(
  keys: KeyMaterial,
  opts: { issuer: string; audience: string; subject: string; scope: string; ttlSec: number },
): Promise<string> {
  return await new SignJWT({ scope: opts.scope })
    .setProtectedHeader({ alg: ALG, kid: keys.kid, typ: 'JWT' })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setSubject(opts.subject)
    .setExpirationTime(`${opts.ttlSec}s`)
    .sign(keys.privateKey);
}

/** Solo para tests: limpia la caché en proceso. */
export function __resetKeysCache(): void {
  cached = undefined;
}
