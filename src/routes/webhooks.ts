import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { billingProvider } from '../billing';
import { getDb, schema } from '../db/client';
import { newId } from '../lib/crypto';
import { log } from '../lib/log';
import { audit } from '../services/audit';
import type { HonoEnv } from './helpers';

export const webhookRoutes = new Hono<HonoEnv>();

const MAX_BODY = 256 * 1024;

webhookRoutes.post('/billing', async (c) => {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return c.json({ error: { code: 'too_large', message: 'Body too large' } }, 413);
  const provider = billingProvider(c.var.env);
  const parsed = await provider.parseWebhook(raw, c.req.raw.headers);
  if (!parsed.ok) {
    log.warn({ msg: 'billing webhook rejected', request_id: c.var.requestId, reason: parsed.error });
    return c.json(
      { error: { code: parsed.status === 401 ? 'unauthorized' : 'bad_request', message: parsed.error } },
      parsed.status as 400,
    );
  }
  const u = parsed.update;
  const db = getDb(c.env.DB);
  // Idempotency: event_id is UNIQUE; a duplicate delivery is acknowledged without reprocessing.
  const inserted = await db
    .insert(schema.webhookEvents)
    .values({
      id: newId('whe_'),
      provider: provider.name,
      eventId: u.eventId,
      type: u.type,
      payloadJson: raw.slice(0, 64_000),
    })
    .onConflictDoNothing({ target: schema.webhookEvents.eventId })
    .returning({ id: schema.webhookEvents.id });
  if (!inserted.length) return c.json({ ok: true, duplicate: true });
  const eventRowId = inserted[0]!.id;
  try {
    const hasChange = u.plan !== undefined || u.status !== undefined || u.currentPeriodEnd !== undefined;
    if (hasChange) {
      if (!u.accountId) throw new Error('event has no account_id');
      const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, u.accountId) });
      if (!account) throw new Error(`unknown account ${u.accountId}`);
      await db
        .update(schema.accounts)
        .set({
          ...(u.plan ? { plan: u.plan } : {}),
          ...(u.status ? { status: u.status } : {}),
          ...(u.currentPeriodEnd !== undefined ? { currentPeriodEnd: u.currentPeriodEnd } : {}),
          billingProvider: provider.name,
          ...(u.customerId ? { providerCustomerId: u.customerId } : {}),
          ...(u.subscriptionId ? { providerSubscriptionId: u.subscriptionId } : {}),
        })
        .where(eq(schema.accounts.id, account.id));
      await audit(
        c.env.DB,
        'billing.webhook',
        { eventId: u.eventId, type: u.type, plan: u.plan, status: u.status },
        { accountId: account.id },
      );
    }
    await db
      .update(schema.webhookEvents)
      .set({ processedAt: Date.now() })
      .where(eq(schema.webhookEvents.id, eventRowId));
    return c.json({ ok: true });
  } catch (e) {
    const message = String((e as Error).message ?? e).slice(0, 500);
    await db
      .update(schema.webhookEvents)
      .set({ error: message })
      .where(eq(schema.webhookEvents.id, eventRowId));
    log.error({ msg: 'billing webhook processing failed', request_id: c.var.requestId, error: message });
    // 200 so the provider does not retry forever; the error is visible in /admin.
    return c.json({ ok: false, error: { code: 'processing_failed', message } });
  }
});
