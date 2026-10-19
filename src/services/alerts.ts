import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { emailChannel } from '../alerts/email';
import { slackChannel } from '../alerts/slack';
import { webhookChannel } from '../alerts/webhook';
import type { AlertChannel, AlertPayload } from '../alerts/channel';
import { getDb, schema } from '../db/client';
import type { EmailProvider } from '../email/provider';
import { decryptSecret, newId } from '../lib/crypto';
import { log } from '../lib/log';
import type { FetchLike } from '../lib/safeFetch';
import { diffScans, shouldAlert, type AlertEvent, type ScanSnapshot } from '../scan/diff';
import type { CheckStatus } from '../scan/types';
import { planOf } from './accounts';

export interface AlertDeps {
  d1: D1Database;
  appUrl: string;
  encryptionKey: string;
  signingSecret: string;
  email: EmailProvider;
  userAgent: string;
  fetchImpl?: FetchLike;
}

async function snapshot(d1: D1Database, scan: typeof schema.scans.$inferSelect): Promise<ScanSnapshot> {
  const rows = await getDb(d1)
    .select({ checkId: schema.checkResults.checkId, status: schema.checkResults.status })
    .from(schema.checkResults)
    .where(eq(schema.checkResults.scanId, scan.id));
  return {
    score: scan.score ?? 0,
    specVersionSeen: scan.specVersionSeen,
    statuses: Object.fromEntries(rows.map((r) => [r.checkId, r.status as CheckStatus])),
  };
}

export function channelFor(type: string, deps: AlertDeps): AlertChannel | null {
  if (type === 'email') return emailChannel(deps.email);
  if (type === 'webhook')
    return webhookChannel({
      signingSecret: deps.signingSecret,
      fetchImpl: deps.fetchImpl,
      userAgent: deps.userAgent,
    });
  if (type === 'slack') return slackChannel({ fetchImpl: deps.fetchImpl, userAgent: deps.userAgent });
  return null;
}

/** Send `payload` to every allowed channel of the account; owner email when none is configured. */
export async function deliver(
  deps: AlertDeps,
  accountId: string,
  payload: AlertPayload,
  kind: string,
): Promise<{ sent: number; failed: number }> {
  const db = getDb(deps.d1);
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, accountId) });
  if (!account) return { sent: 0, failed: 0 };
  const allowed = planOf(account).alertChannels;
  const channels = (
    await db.select().from(schema.alertChannels).where(eq(schema.alertChannels.accountId, accountId))
  ).filter((c) => allowed.includes(c.type));
  const targets: { channelId: string | null; type: string; target: string }[] = [];
  for (const c of channels) {
    try {
      targets.push({
        channelId: c.id,
        type: c.type,
        target: await decryptSecret(deps.encryptionKey, c.targetEncrypted),
      });
    } catch {
      log.error({ msg: 'could not decrypt alert channel', channel_id: c.id });
    }
  }
  if (!targets.length && allowed.includes('email')) {
    const owner = await db
      .select({ email: schema.users.email })
      .from(schema.accountMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.accountMembers.userId))
      .where(and(eq(schema.accountMembers.accountId, accountId), eq(schema.accountMembers.role, 'owner')))
      .limit(1);
    if (owner[0]) targets.push({ channelId: null, type: 'email', target: owner[0].email });
  }
  let sent = 0;
  let failed = 0;
  for (const t of targets) {
    const ch = channelFor(t.type, deps);
    const r = ch ? await ch.send(t.target, payload) : { ok: false, error: 'unknown channel type' };
    if (r.ok) sent++;
    else failed++;
    await db.insert(schema.alerts).values({
      id: newId('alr_'),
      accountId,
      storeId: payload.storeId,
      scanId: payload.scanId || null,
      kind,
      payloadJson: JSON.stringify({ events: payload.events, score: payload.score }),
      channelId: t.channelId,
      status: r.ok ? 'sent' : 'failed',
      error: r.ok ? null : (r.error ?? 'unknown').slice(0, 500),
      sentAt: Date.now(),
    });
  }
  return { sent, failed };
}

/**
 * After a monitored store's scan finishes: diff against the previous completed scan and alert
 * once (scans.alerted_at is claimed atomically so retries never double-send).
 */
export async function processScanAlerts(deps: AlertDeps, scanId: string): Promise<AlertEvent[]> {
  const db = getDb(deps.d1);
  const scan = await db.query.scans.findFirst({ where: eq(schema.scans.id, scanId) });
  if (!scan?.storeId || scan.status !== 'done') return [];
  const store = await db.query.stores.findFirst({ where: eq(schema.stores.id, scan.storeId) });
  if (!store?.monitoring) return [];
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, store.accountId) });
  if (!account || !planOf(account).dailyMonitoring) return [];

  const claimed = await db
    .update(schema.scans)
    .set({ alertedAt: Date.now() })
    .where(and(eq(schema.scans.id, scanId), isNull(schema.scans.alertedAt)))
    .returning({ id: schema.scans.id });
  if (!claimed.length) return [];

  const prev = await db
    .select()
    .from(schema.scans)
    .where(
      and(eq(schema.scans.storeId, store.id), eq(schema.scans.status, 'done'), ne(schema.scans.id, scanId)),
    )
    .orderBy(desc(schema.scans.finishedAt))
    .limit(2);
  const current = await snapshot(deps.d1, scan);
  const previous = prev[0] ? await snapshot(deps.d1, prev[0]) : null;
  const before = prev[1] ? await snapshot(deps.d1, prev[1]) : null;
  const titles = Object.fromEntries((await import('../checks/registry')).CHECKS.map((c) => [c.id, c.title]));
  current.titles = titles;
  const events = diffScans(current, previous, before);
  if (!shouldAlert(events)) return events;
  await deliver(
    deps,
    account.id,
    {
      storeId: store.id,
      storeName: store.name,
      domain: store.domain,
      scanId,
      score: scan.score,
      reportUrl: `${deps.appUrl}/r/${scan.publicSlug}`,
      events,
    },
    events.map((e) => e.kind).join(','),
  );
  return events;
}
