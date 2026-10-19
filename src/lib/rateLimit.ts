/** D1-backed fixed-window rate limiter. */

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: number;
}

/**
 * Atomically increment the counter for `key` in the current window and report whether the
 * request is within `limit`. Uses an UPSERT so concurrent requests cannot both slip through.
 */
export async function hit(db: D1Database, key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitResult> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= limit, count, limit, resetAt: windowStart + windowMs };
}

/** Read-only peek (does not increment). */
export async function peek(db: D1Database, key: string, windowMs: number, now = Date.now()): Promise<number> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare('SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2').bind(key, windowStart).first<{ count: number }>();
  return row?.count ?? 0;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
