import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client';
import { consoleOutbox } from '../src/email/console';
import { drainJobs } from '../src/jobs/runner';
import { cleanup, enqueueDailyScans } from '../src/jobs/schedule';
import { processScanAlerts } from '../src/services/alerts';
import { alertDeps, runnerDeps } from '../src/routes/helpers';
import { appEnv } from '../src/env';
import { mockFetch } from './helpers';
import { mockStore, resetMockStore } from './mock-store/app';
import { env, login, post, req, setPlan, type Client } from './appHelpers';

beforeEach(() => resetMockStore());

const deps = () => ({ ...runnerDeps(env, appEnv(env), mockFetch), sleep: async () => undefined });

async function addStore(c: Client, host: string) {
  const r = await post(c, '/app/stores/new', { url: host });
  expect(r.status).toBe(303);
  return r.headers.get('location')!.split('/').pop()!;
}

describe('tenant isolation', () => {
  it('user B cannot read or change user A’s stores, scans, alerts, keys or reports', async () => {
    const a = await login('tenant-a@example.com');
    const b = await login('tenant-b@example.com');
    await setPlan(a.accountId, 'vendor');
    await setPlan(b.accountId, 'vendor');
    const storeA = await addStore(a, 'tenant-a.mockstore.test');
    const db = getDb(env.DB);
    const scanA = (await db.query.scans.findFirst({ where: eq(schema.scans.storeId, storeA) }))!;
    expect(scanA.status).toBe('done');

    // Reads
    expect((await req(`/app/stores/${storeA}`, { cookie: a.cookie })).status).toBe(200);
    expect((await req(`/app/stores/${storeA}`, { cookie: b.cookie })).status).toBe(404);
    expect((await req(`/app/stores/${storeA}/verify`, { cookie: b.cookie })).status).toBe(404);
    expect((await req(`/app/reports/${scanA.id}/print`, { cookie: b.cookie })).status).toBe(404);
    expect((await req(`/r/${scanA.publicSlug}`, { cookie: b.cookie })).status).toBe(404);
    expect((await req(`/r/${scanA.publicSlug}`)).status).toBe(404); // anonymous visitor
    expect((await req(`/r/${scanA.publicSlug}`, { cookie: a.cookie })).status).toBe(200);
    const dashB = await (await req('/app', { cookie: b.cookie })).text();
    expect(dashB).not.toContain('tenant-a.mockstore.test');

    // Writes
    expect((await post(b, `/app/stores/${storeA}/rescan`)).status).toBe(404);
    expect((await post(b, `/app/stores/${storeA}/monitoring`, { monitoring: '0' })).status).toBe(404);
    expect(
      (
        await post(b, `/app/stores/${storeA}/checkout-testing`, {
          endpoint: 'https://tenant-a.mockstore.test/ucp/v1',
          confirm: '1',
        })
      ).status,
    ).toBe(404);
    expect((await post(b, `/app/stores/${storeA}/delete`)).status).toBe(404);
    expect(await db.query.stores.findFirst({ where: eq(schema.stores.id, storeA) })).toBeTruthy();

    // Alert channels
    await post(a, '/app/alerts', { type: 'webhook', target: 'https://hooks.example.com/a', label: 'A hook' });
    const chA = (await db.query.alertChannels.findFirst({
      where: eq(schema.alertChannels.accountId, a.accountId),
    }))!;
    expect(chA.targetEncrypted).not.toContain('hooks.example.com');
    await post(b, `/app/alerts/${chA.id}/delete`);
    expect(
      await db.query.alertChannels.findFirst({ where: eq(schema.alertChannels.id, chA.id) }),
    ).toBeTruthy();
    expect(await (await req('/app/alerts', { cookie: b.cookie })).text()).not.toContain('A hook');

    // API keys
    const created = await (await post(a, '/app/api-keys', { label: 'ci' })).text();
    const keyA = /cp_[a-z0-9]{8}_[A-Za-z0-9_-]+/.exec(created)![0];
    const keyRowA = (await db.query.apiKeys.findFirst({ where: eq(schema.apiKeys.accountId, a.accountId) }))!;
    await post(b, `/app/api-keys/${keyRowA.id}/revoke`);
    expect(
      (await db.query.apiKeys.findFirst({ where: eq(schema.apiKeys.id, keyRowA.id) }))!.revokedAt,
    ).toBeNull();
    const createdB = await (await post(b, '/app/api-keys', { label: 'ci' })).text();
    const keyB = /cp_[a-z0-9]{8}_[A-Za-z0-9_-]+/.exec(createdB)![0];
    expect(
      (await req(`/api/v1/scans/${scanA.id}`, { headers: { authorization: `Bearer ${keyB}` } })).status,
    ).toBe(404);
    expect(
      (await req(`/api/v1/scans/${scanA.id}`, { headers: { authorization: `Bearer ${keyA}` } })).status,
    ).toBe(200);
  });
});

describe('monitoring end to end', () => {
  it('verifies ownership, scans daily, and alerts exactly once on a regression', async () => {
    const c = await login('owner@agency.example');
    await setPlan(c.accountId, 'agency');
    const host = 'agency-shop.mockstore.test';
    const storeId = await addStore(c, host);
    const db = getDb(env.DB);
    const store = (await db.query.stores.findFirst({ where: eq(schema.stores.id, storeId) }))!;
    expect(store.monitoring).toBe(1);

    // Ownership via the well-known file on the mock store.
    expect((await post(c, `/app/stores/${storeId}/verify`)).status).toBe(400);
    await mockStore.fetch(
      new Request(`https://${host}/__mock/verify?token=${store.verifyToken}`, { method: 'POST' }),
    );
    expect((await post(c, `/app/stores/${storeId}/verify`)).status).toBe(303);
    expect(
      (await db.query.stores.findFirst({ where: eq(schema.stores.id, storeId) }))!.verifiedAt,
    ).toBeTruthy();

    // Day 2: unchanged → no alert.
    const sentBefore = consoleOutbox.length;
    expect(await enqueueDailyScans(env.DB, Date.now() - 3_600_000)).toBeGreaterThanOrEqual(1);
    await drainJobs(deps(), 50, 120_000);
    const alerts1 = await db.select().from(schema.alerts).where(eq(schema.alerts.storeId, storeId));
    expect(alerts1).toHaveLength(0);

    // Regression in the store: prices drift.
    await mockStore.fetch(
      new Request(`https://${host}/__mock/set?variant=price-mismatch`, { method: 'POST' }),
    );
    await enqueueDailyScans(env.DB, Date.now() - 3_600_000);
    await drainJobs(deps(), 50, 120_000);
    const alerts2 = await db.select().from(schema.alerts).where(eq(schema.alerts.storeId, storeId));
    expect(alerts2).toHaveLength(1);
    expect(alerts2[0]!.kind).toContain('new_failure');
    const payload = JSON.parse(alerts2[0]!.payloadJson) as { events: { kind: string; checkId?: string }[] };
    expect(
      payload.events.some((e) => e.kind === 'new_failure' && e.checkId === 'consistency.price_match'),
    ).toBe(true);
    const mail = consoleOutbox
      .slice(sentBefore)
      .find((m) => m.to === 'owner@agency.example' && m.subject.startsWith('CartProbe:'));
    expect(mail?.text).toContain('Catalog prices match product pages');

    // Re-processing the same scan never double-sends.
    const latest = (
      await db
        .select()
        .from(schema.scans)
        .where(and(eq(schema.scans.storeId, storeId), eq(schema.scans.trigger, 'scheduled')))
    ).sort((x, y) => (y.finishedAt ?? 0) - (x.finishedAt ?? 0))[0]!;
    await processScanAlerts(alertDeps({ env, var: { env: appEnv(env), fetchImpl: mockFetch } }), latest.id);
    expect(await db.select().from(schema.alerts).where(eq(schema.alerts.storeId, storeId))).toHaveLength(1);
  });

  it('runs a deep checkout test only after verification + test mode', async () => {
    const c = await login('deep@agency.example');
    await setPlan(c.accountId, 'agency');
    const host = 'deep-shop.mockstore.test';
    const storeId = await addStore(c, host);
    const db = getDb(env.DB);
    // Not verified → checkout testing is refused.
    expect(
      (
        await post(c, `/app/stores/${storeId}/checkout-testing`, {
          endpoint: `https://${host}/ucp/v1`,
          confirm: '1',
        })
      ).status,
    ).toBe(403);
    const store = (await db.query.stores.findFirst({ where: eq(schema.stores.id, storeId) }))!;
    await mockStore.fetch(
      new Request(`https://${host}/__mock/verify?token=${store.verifyToken}`, { method: 'POST' }),
    );
    await post(c, `/app/stores/${storeId}/verify`);
    // Off-domain endpoint is refused.
    expect(
      (
        await post(c, `/app/stores/${storeId}/checkout-testing`, {
          endpoint: 'https://other.example.com/ucp/v1',
          confirm: '1',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(c, `/app/stores/${storeId}/checkout-testing`, {
          endpoint: `https://${host}/ucp/v1`,
          confirm: '1',
        })
      ).status,
    ).toBe(303);
    await db.update(schema.stores).set({ lastManualScanAt: null }).where(eq(schema.stores.id, storeId));
    expect((await post(c, `/app/stores/${storeId}/rescan`)).status).toBe(303);
    const scan = (await db.select().from(schema.scans).where(eq(schema.scans.storeId, storeId))).sort(
      (x, y) => y.createdAt - x.createdAt,
    )[0]!;
    expect(scan.includeCheckout).toBe(1);
    const r = await db.query.checkResults.findFirst({
      where: and(
        eq(schema.checkResults.scanId, scan.id),
        eq(schema.checkResults.checkId, 'checkout.session_cleanup'),
      ),
    });
    expect(r?.status).toBe('pass');
    // Re-scan cooldown.
    expect((await post(c, `/app/stores/${storeId}/rescan`)).status).toBe(429);
  });

  it('enforces the plan store limit with an upgrade prompt', async () => {
    const c = await login('limit@store.example');
    await setPlan(c.accountId, 'store');
    await addStore(c, 'limit-one.mockstore.test');
    const r = await post(c, '/app/stores/new', { url: 'limit-two.mockstore.test' });
    expect(r.status).toBe(402);
    expect(await r.text()).toContain('Upgrade your plan');
  });

  it('cleanup removes anonymous scans older than 30 days', async () => {
    await req('/scan', {
      method: 'POST',
      body: new URLSearchParams({ url: 'old-anon.mockstore.test' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '192.0.2.201' },
    });
    const db = getDb(env.DB);
    await db
      .update(schema.scans)
      .set({ createdAt: Date.now() - 31 * 24 * 3600 * 1000 })
      .where(eq(schema.scans.domain, 'old-anon.mockstore.test'));
    const out = await cleanup(env.DB, undefined);
    expect(out.anonymousScans).toBeGreaterThanOrEqual(1);
    expect(
      await db.query.scans.findFirst({ where: eq(schema.scans.domain, 'old-anon.mockstore.test') }),
    ).toBeUndefined();
  });
});
