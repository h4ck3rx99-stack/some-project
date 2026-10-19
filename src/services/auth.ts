import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client';
import { hmacHex, newId, randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { ensureUser } from './accounts';

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'cp_session';

/** Create a single-use magic-link token for `email`. Returns the raw token (only ever emailed). */
export async function createLoginToken(d1: D1Database, email: string, ipHash: string | null, now = Date.now()): Promise<string> {
  const token = randomToken(32);
  await getDb(d1)
    .insert(schema.loginTokens)
    .values({ id: newId('lt_'), email: email.trim().toLowerCase(), tokenHash: await sha256Hex(token), expiresAt: now + LOGIN_TOKEN_TTL_MS, ipHash, createdAt: now });
  return token;
}

/**
 * Consume a magic-link token: single use (atomic UPDATE … WHERE used_at IS NULL), 15-minute expiry.
 * Returns the user (created on first login) or null.
 */
export async function consumeLoginToken(d1: D1Database, token: string, adminEmails: string[], now = Date.now()) {
  const db = getDb(d1);
  const hash = await sha256Hex(token);
  const used = await db
    .update(schema.loginTokens)
    .set({ usedAt: now })
    .where(and(eq(schema.loginTokens.tokenHash, hash), isNull(schema.loginTokens.usedAt), gt(schema.loginTokens.expiresAt, now)))
    .returning({ id: schema.loginTokens.id, email: schema.loginTokens.email });
  const row = used[0];
  if (!row) return null;
  const user = await ensureUser(d1, row.email, adminEmails.includes(row.email) ? 'admin' : 'user');
  await db.update(schema.loginTokens).set({ userId: user.id }).where(eq(schema.loginTokens.id, row.id));
  return user;
}

export async function createSession(d1: D1Database, userId: string, now = Date.now()): Promise<string> {
  const token = randomToken(32);
  await getDb(d1)
    .insert(schema.sessions)
    .values({ id: newId('ses_'), userId, tokenHash: await sha256Hex(token), csrfSecret: randomToken(24), expiresAt: now + SESSION_TTL_MS, createdAt: now, lastSeenAt: now });
  return token;
}

export async function loadSession(d1: D1Database, token: string, now = Date.now()) {
  const db = getDb(d1);
  const rows = await db
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, await sha256Hex(token)), gt(schema.sessions.expiresAt, now)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  if (now - r.session.lastSeenAt > 60 * 60 * 1000) {
    await db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, r.session.id));
  }
  return r;
}

export async function destroySession(d1: D1Database, token: string) {
  await getDb(d1).delete(schema.sessions).where(eq(schema.sessions.tokenHash, await sha256Hex(token)));
}

/** CSRF token bound to the session: HMAC(session secret, csrf secret). */
export async function csrfToken(sessionSecret: string, csrfSecret: string): Promise<string> {
  return (await hmacHex(sessionSecret, `csrf:${csrfSecret}`)).slice(0, 40);
}

export async function checkCsrf(sessionSecret: string, csrfSecret: string, provided: string | undefined | null): Promise<boolean> {
  if (!provided) return false;
  return timingSafeEqual(provided, await csrfToken(sessionSecret, csrfSecret));
}

/** API keys: "cp_<prefix>_<secret>", stored as sha256. */
export async function createApiKey(d1: D1Database, accountId: string, label: string, now = Date.now()) {
  const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toLowerCase();
  const secret = randomToken(24);
  const key = `cp_${prefix}_${secret}`;
  const id = newId('key_');
  await getDb(d1).insert(schema.apiKeys).values({ id, accountId, keyHash: await sha256Hex(key), prefix, label, createdAt: now });
  return { id, key, prefix };
}

export async function verifyApiKey(d1: D1Database, header: string | undefined, now = Date.now()) {
  const m = /^Bearer\s+(cp_([a-z0-9]{8})_[A-Za-z0-9_-]{20,64})$/.exec(header ?? '');
  if (!m) return null;
  const db = getDb(d1);
  const row = await db.query.apiKeys.findFirst({ where: and(eq(schema.apiKeys.prefix, m[2]!), isNull(schema.apiKeys.revokedAt)) });
  if (!row || !timingSafeEqual(row.keyHash, await sha256Hex(m[1]!))) return null;
  if (!row.lastUsedAt || now - row.lastUsedAt > 60_000) await db.update(schema.apiKeys).set({ lastUsedAt: now }).where(eq(schema.apiKeys.id, row.id));
  return row;
}
