/** Cron handlers. Schedules live in wrangler.toml [triggers]. */
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { SEVERITY_WEIGHTS } from '../config/weights';
import { getDb, schema } from '../db/client';
import { digestEmail } from '../email/templates';
import type { EmailProvider } from '../email/provider';
import { log } from '../lib/log';
import { planOf } from '../services/accounts';
import { createScan } from '../services/scans';
import { CHECKS_BY_ID } from '../checks/registry';
import type { Severity } from '../scan/types';
import { drainJobs, type RunnerDeps } from './runner';

export const CRONS = {
  runner: '* * * * *',
  daily: '0 1 * * *',
  cleanup: '0 2 * * *',
  digest: '30 3 * * 1',
} as const;

export const ANON_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_SCAN_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

async function recordCron(d1: D1Database, name: string, started: number, result: string) {
  const now = Date.now();
  await getDb(d1)
    .insert(schema.cronRuns)
    .values({ name, lastRunAt: started, lastDurationMs: now - started, lastResult: result.slice(0, 500) })
    .onConflictDoUpdate({ target: schema.cronRuns.name, set: { lastRunAt: started, lastDurationMs: now - started, lastResult: result.slice(0, 500) } });
}

/** Deterministic 0..3599 s offset per store so daily scans spread across the hour. */
export function staggerSeconds(storeId: string): number {
  let h = 0;
  for (const ch of storeId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 3600;
}

export async function enqueueDailyScans(d1: D1Database, now = Date.now()): Promise<number> {
  const db = getDb(d1);
  const rows = await db.select({ s: schema.stores, a: schema.accounts }).from(schema.stores).innerJoin(schema.accounts, eq(schema.accounts.id, schema.stores.accountId)).where(eq(schema.stores.monitoring, 1));
  const busy = new Set(
    (await db.select({ storeId: schema.scans.storeId }).from(schema.scans).where(inArray(schema.scans.status, ['queued', 'running']))).map((r) => r.storeId),
  );
  let n = 0;
  for (const { s, a } of rows) {
    const plan = planOf(a, now);
    if (!plan.dailyMonitoring || busy.has(s.id)) continue;
    await createScan(d1, {
      url: s.url,
      domain: s.domain,
      trigger: 'scheduled',
      storeId: s.id,
      accountId: a.id,
      productsSampled: plan.productsSampled,
      verifiedOwnership: !!s.verifiedAt,
      testCheckoutEndpoint: s.testCheckoutEndpoint,
      testModeConfirmed: !!s.testModeConfirmedAt,
      runAfter: now + staggerSeconds(s.id) * 1000,
      now,
    });
    n++;
  }
  return n;
}

export async function cleanup(d1: D1Database, captures: R2Bucket | undefined, now = Date.now()) {
  const db = getDb(d1);
  const anon = await db.delete(schema.scans).where(and(eq(schema.scans.trigger, 'anonymous'), lt(schema.scans.createdAt, now - ANON_RETENTION_MS))).returning({ id: schema.scans.id });
  const old = await db.delete(schema.scans).where(lt(schema.scans.createdAt, now - ACCOUNT_SCAN_RETENTION_MS)).returning({ id: schema.scans.id });
  await db.delete(schema.loginTokens).where(lt(schema.loginTokens.expiresAt, now - 24 * 60 * 60 * 1000));
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
  await db.delete(schema.rateLimits).where(lt(schema.rateLimits.windowStart, now - 2 * 24 * 60 * 60 * 1000));
  let capturesDeleted = 0;
  if (captures) {
    let cursor: string | undefined;
    do {
      const list = await captures.list({ prefix: 'captures/', cursor, limit: 500 });
      const stale = list.objects.filter((o) => o.uploaded.getTime() < now - CAPTURE_RETENTION_MS).map((o) => o.key);
      if (stale.length) {
        await captures.delete(stale);
        capturesDeleted += stale.length;
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
  return { anonymousScans: anon.length, oldScans: old.length, capturesDeleted };
}

export async function weeklyDigest(d1: D1Database, email: EmailProvider, appUrl: string, now = Date.now()): Promise<number> {
  const db = getDb(d1);
  const accounts = await db.select().from(schema.accounts);
  let sent = 0;
  for (const a of accounts) {
    if (!planOf(a, now).dailyMonitoring) continue;
    const stores = await db.select().from(schema.stores).where(eq(schema.stores.accountId, a.id));
    if (!stores.length) continue;
    const owner = await db
      .select({ email: schema.users.email })
      .from(schema.accountMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.accountMembers.userId))
      .where(and(eq(schema.accountMembers.accountId, a.id), eq(schema.accountMembers.role, 'owner')))
      .limit(1);
    if (!owner[0]) continue;
    const digest = [];
    for (const s of stores) {
      const recent = await db.select().from(schema.scans).where(and(eq(schema.scans.storeId, s.id), eq(schema.scans.status, 'done'))).orderBy(desc(schema.scans.finishedAt)).limit(8);
      const latest = recent[0];
      const weekAgo = recent.find((x) => (x.finishedAt ?? 0) <= now - 6 * 24 * 60 * 60 * 1000);
      let topFixes: string[] = [];
      if (latest) {
        const failing = await db.select().from(schema.checkResults).where(and(eq(schema.checkResults.scanId, latest.id), inArray(schema.checkResults.status, ['fail', 'error', 'warn'])));
        topFixes = failing
          .sort((x, y) => SEVERITY_WEIGHTS[y.severity as Severity] - SEVERITY_WEIGHTS[x.severity as Severity] || (x.status === 'warn' ? 1 : 0) - (y.status === 'warn' ? 1 : 0))
          .slice(0, 3)
          .map((r) => `${CHECKS_BY_ID.get(r.checkId)?.title ?? r.checkId}: ${appUrl}/fix/${r.fixGuide}`);
      }
      digest.push({ name: s.name, domain: s.domain, score: latest?.score ?? null, change: latest && weekAgo ? (latest.score ?? 0) - (weekAgo.score ?? 0) : null, topFixes });
    }
    const r = await email.send(digestEmail(owner[0].email, a.name, digest, appUrl));
    if (r.ok) sent++;
  }
  return sent;
}

export interface CronDeps {
  runner: RunnerDeps;
  email: EmailProvider;
  appUrl: string;
  captures?: R2Bucket;
}

export async function runCron(cron: string, deps: CronDeps): Promise<string> {
  const started = Date.now();
  const d1 = deps.runner.d1;
  let result: string;
  try {
    if (cron === CRONS.runner) result = `processed ${await drainJobs(deps.runner, 5, 25_000)} jobs`;
    else if (cron === CRONS.daily) result = `enqueued ${await enqueueDailyScans(d1)} scans`;
    else if (cron === CRONS.cleanup) result = JSON.stringify(await cleanup(d1, deps.captures));
    else if (cron === CRONS.digest) result = `sent ${await weeklyDigest(d1, deps.email, deps.appUrl)} digests`;
    else result = `unknown cron ${cron}`;
  } catch (e) {
    result = `error: ${String((e as Error)?.message ?? e)}`;
    log.error({ msg: 'cron failed', cron, error: String((e as Error)?.stack ?? e) });
  }
  await recordCron(d1, cron, started, result);
  return result;
}
