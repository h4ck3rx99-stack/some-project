/** Hashing, HMAC, random tokens and AES-GCM secret encryption (WebCrypto only). */

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toB64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

export async function hmacHex(secret: string, message: string | Uint8Array, hash: 'SHA-256' = 'SHA-256'): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash }, false, ['sign']);
  const data = typeof message === 'string' ? enc.encode(message) : message;
  return toHex(await crypto.subtle.sign('HMAC', key, data));
}

/** Constant-time string comparison (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Sortable unique id (time prefix + randomness), e.g. for rows shown in time order. */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36).padStart(9, '0');
  return prefix + t + randomToken(10).replace(/[-_]/g, 'x').slice(0, 12).toLowerCase();
}

/** IPs are never stored raw: HMAC(salt, ip + UTC date) so hashes rotate daily. */
export async function ipHash(salt: string, ip: string, now = Date.now()): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  return (await hmacHex(salt, `${ip}|${day}`)).slice(0, 32);
}

async function aesKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64(base64Key), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt a secret (alert targets) → "v1.<iv>.<ciphertext>" base64url. */
export async function encryptSecret(base64Key: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(base64Key), enc.encode(plaintext));
  return `v1.${toB64Url(iv)}.${toB64Url(new Uint8Array(ct))}`;
}

export async function decryptSecret(base64Key: string, payload: string): Promise<string> {
  const [v, iv, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('unsupported ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await aesKey(base64Key), fromB64(ct));
  return new TextDecoder().decode(pt);
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${(user ?? '').slice(0, 1)}***@${domain}`;
}
