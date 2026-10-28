// Verifies Firebase ID tokens (RS256 JWTs) in the browser with WebCrypto, so a host can
// trust which Google account a joining friend signed in with, without any backend.
// Rules: https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library

export interface VerifiedAccount {
  uid: string;
  name?: string;
  email?: string;
}

export type JwkSet = { keys: Array<JsonWebKey & { kid?: string }> };

const KEYS_URL = 'https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com';

let cachedKeys: { set: JwkSet; until: number } | null = null;

/** Google's current token-signing keys, cached for as long as Google says. */
export async function fetchGoogleKeys(): Promise<JwkSet> {
  if (cachedKeys && Date.now() < cachedKeys.until) return cachedKeys.set;
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new Error(`key fetch failed: ${res.status}`);
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  const set = (await res.json()) as JwkSet;
  cachedKeys = { set, until: Date.now() + maxAge * 1000 };
  return set;
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

/**
 * Returns the account if `token` is a valid, unexpired ID token for `projectId`, else null.
 * `nowSec` and `getKeys` are injectable for tests.
 */
export async function verifyIdToken(
  token: string,
  projectId: string,
  getKeys: () => Promise<JwkSet> = fetchGoogleKeys,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<VerifiedAccount | null> {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson(parts[0]);
    const p = b64urlJson(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    if (p.aud !== projectId || p.iss !== `https://securetoken.google.com/${projectId}`) return null;
    if (typeof p.exp !== 'number' || p.exp <= nowSec) return null;
    if (typeof p.iat !== 'number' || p.iat > nowSec + 300) return null;
    if (typeof p.auth_time !== 'number' || p.auth_time > nowSec + 300) return null;
    if (typeof p.sub !== 'string' || p.sub.length === 0 || p.sub.length > 128) return null;
    const jwk = (await getKeys()).keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    return {
      uid: p.sub,
      name: typeof p.name === 'string' ? p.name : undefined,
      email: typeof p.email === 'string' ? p.email : undefined,
    };
  } catch {
    return null;
  }
}
