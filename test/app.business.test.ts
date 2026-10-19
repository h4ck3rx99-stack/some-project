import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client';
import { hmacHex } from '../src/lib/crypto';
import { env, login, post, req, setPlan } from './appHelpers';

describe('white-label print report', () => {
  it('renders with the agency name and logo, without CartProbe branding when hidden', async () => {
    const c = await login('print@agency.example');
    await setPlan(c.accountId, 'agency');
    await post(c, '/app/settings', {
      name: 'Acme',
      white_label_name: 'Pixel & Co Agency',
      white_label_logo_url: 'https://cdn.pixel.example/logo.png',
      hide_footer: '1',
    });
    const loc = (await post(c, '/app/stores/new', { url: 'print-shop.mockstore.test' })).headers.get(
      'location',
    )!;
    const scan = (await getDb(env.DB).query.scans.findFirst({
      where: eq(schema.scans.storeId, loc.split('/').pop()!),
    }))!;
    const r = await req(`/app/reports/${scan.id}/print`, { cookie: c.cookie });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Prepared by Pixel &amp; Co Agency');
    expect(html).toContain('src="https://cdn.pixel.example/logo.png"');
    expect(html).not.toContain('Generated with CartProbe');
    expect(html).not.toContain('<header class="site">');
    expect(r.headers.get('content-security-policy')).toContain(
      "img-src 'self' data: https://cdn.pixel.example;",
    );
  });

  it('is not available on the Store plan', async () => {
    const c = await login('print@store.example');
    await setPlan(c.accountId, 'store');
    const loc = (await post(c, '/app/stores/new', { url: 'print-store.mockstore.test' })).headers.get(
      'location',
    )!;
    const scan = (await getDb(env.DB).query.scans.findFirst({
      where: eq(schema.scans.storeId, loc.split('/').pop()!),
    }))!;
    expect((await req(`/app/reports/${scan.id}/print`, { cookie: c.cookie })).status).toBe(403);
  });
});

describe('vendor API and badge', () => {
  it('creates a key, runs a scan synchronously, fetches results, serves a badge', async () => {
    const c = await login('ci@vendor.example');
    await setPlan(c.accountId, 'vendor');
    const html = await (await post(c, '/app/api-keys', { label: 'GitHub Actions' })).text();
    const key = /cp_[a-z0-9]{8}_[A-Za-z0-9_-]+/.exec(html)![0];
    const keyRow = (await getDb(env.DB).query.apiKeys.findFirst({
      where: eq(schema.apiKeys.accountId, c.accountId),
    }))!;
    expect(keyRow.keyHash).not.toContain(key);

    const created = await req('/api/v1/scans', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://api-shop.mockstore.test', waitSeconds: 25, sampleSize: 2 }),
    });
    expect(created.status).toBe(200);
    const body = await created.json<{
      scanId: string;
      status: string;
      score: number;
      checks: { id: string; status: string; fixGuideUrl: string }[];
      reportUrl: string;
      productsSampled: number;
    }>();
    expect(body.status).toBe('done');
    expect(body.checks.filter((x) => x.status !== 'pass' && x.status !== 'skip')).toEqual([]);
    expect(body.score).toBe(100);
    expect(body.productsSampled).toBe(2);
    expect(body.checks.find((x) => x.id === 'consistency.price_match')!.fixGuideUrl).toBe(
      'https://cartprobe.test/fix/consistency.price_match',
    );
    const got = await (
      await req(`/api/v1/scans/${body.scanId}`, { headers: { authorization: `Bearer ${key}` } })
    ).json<{ score: number }>();
    expect(got.score).toBe(100);

    const bad = await req('/api/v1/scans', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://127.0.0.1', waitSeconds: 99 }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json<{ error: { code: string } }>()).error.code).toBe('bad_request');

    // Badge: off by default, on after enabling.
    const loc = (await post(c, '/app/stores/new', { url: 'badge-shop.mockstore.test' })).headers.get(
      'location',
    )!;
    const storeId = loc.split('/').pop()!;
    expect((await req(`/badge/${storeId}.svg`)).status).toBe(404);
    await post(c, `/app/stores/${storeId}/badge`, { badge: '1' });
    const badge = await req(`/badge/${storeId}.svg`);
    expect(badge.status).toBe(200);
    expect(badge.headers.get('content-type')).toBe('image/svg+xml');
    expect(await badge.text()).toContain('Agent-ready · 100');

    // Revoked keys stop working; non-vendor plans are refused.
    await post(c, `/app/api-keys/${keyRow.id}/revoke`);
    expect(
      (await req(`/api/v1/scans/${body.scanId}`, { headers: { authorization: `Bearer ${key}` } })).status,
    ).toBe(401);
  });

  it('refuses API access below the Vendor plan', async () => {
    const c = await login('notvendor@example.com');
    await setPlan(c.accountId, 'vendor');
    const key = /cp_[a-z0-9]{8}_[A-Za-z0-9_-]+/.exec(
      await (await post(c, '/app/api-keys', { label: 'k' })).text(),
    )![0];
    await setPlan(c.accountId, 'agency');
    expect((await req('/api/v1/scans/x', { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
  });
});

describe('admin', () => {
  it('plan override changes limits immediately', async () => {
    const admin = await login('admin@cartprobe.test');
    const u = await login('upgrade-me@example.com');
    expect((await post(u, '/app/stores/new', { url: 'upgrade.mockstore.test' })).status).toBe(402);
    const r = await post(admin, `/admin/accounts/${u.accountId}/plan`, {
      plan: 'store',
      status: 'active',
      period_end: '2099-01-01',
    });
    expect(r.status).toBe(303);
    expect((await post(u, '/app/stores/new', { url: 'upgrade.mockstore.test' })).status).toBe(303);
    const log = await getDb(env.DB).query.auditLog.findFirst({
      where: eq(schema.auditLog.action, 'admin.plan_override'),
    });
    expect(log).toBeTruthy();
  });

  it('retries a failed job', async () => {
    const admin = await login('admin@cartprobe.test');
    const db = getDb(env.DB);
    const now = Date.now();
    await db.insert(schema.scans).values({
      id: 'scn_failed',
      domain: 'x.mockstore.test',
      url: 'https://x.mockstore.test',
      trigger: 'anonymous',
      publicSlug: 'failedslug01',
      createdAt: now,
    });
    await db.insert(schema.scanJobs).values({
      id: 'job_failed',
      scanId: 'scn_failed',
      phase: 'catalog',
      inputJson: '{}',
      stateJson: '{"results":{},"requestsMade":0}',
      attempts: 4,
      lastError: 'boom',
      runAfter: now + 3_600_000,
      createdAt: now,
      updatedAt: now,
    });
    const page = await (await req('/admin', { cookie: admin.cookie })).text();
    expect(page).toContain('boom');
    await post(admin, '/admin/jobs/job_failed/retry');
    const job = (await db.query.scanJobs.findFirst({ where: eq(schema.scanJobs.id, 'job_failed') }))!;
    expect(job.attempts).toBe(0);
    expect(job.lastError).toBeNull();
    expect(job.runAfter).toBeLessThanOrEqual(Date.now());
    expect((await req('/admin/health', { cookie: admin.cookie })).status).toBe(200);
  });
});

async function signed(body: unknown, opts: { secret?: string; id?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? `evt_${crypto.randomUUID()}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = await hmacHex(opts.secret ?? 'whsec_test_secret', `${id}.${ts}.${raw}`);
  return {
    method: 'POST',
    body: raw,
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': ts,
      'webhook-signature': `v1=${sig}`,
    },
  };
}

describe('billing webhook', () => {
  it('valid signature updates the plan; duplicates are ignored; bad signatures are rejected', async () => {
    const u = await login('billing@example.com');
    const event = {
      type: 'subscription.updated',
      data: {
        account_id: u.accountId,
        customer_id: 'cus_1',
        subscription_id: 'sub_1',
        plan: 'agency_annual',
        status: 'active',
        current_period_end: '2027-01-01T00:00:00Z',
      },
    };
    const init = await signed(event, { id: 'evt_fixed_1' });
    const r = await req('/webhooks/billing', init);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const db = getDb(env.DB);
    let acc = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, u.accountId) }))!;
    expect(acc.plan).toBe('agency');
    expect(acc.status).toBe('active');
    expect(acc.currentPeriodEnd).toBe(Date.parse('2027-01-01T00:00:00Z'));
    expect(acc.providerSubscriptionId).toBe('sub_1');

    // Duplicate delivery of the same event id: acknowledged, not reprocessed.
    await db.update(schema.accounts).set({ plan: 'store' }).where(eq(schema.accounts.id, u.accountId));
    const dup = await req('/webhooks/billing', await signed(event, { id: 'evt_fixed_1' }));
    expect(await dup.json()).toEqual({ ok: true, duplicate: true });
    acc = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, u.accountId) }))!;
    expect(acc.plan).toBe('store');

    // Cancellation maps to status cancelled → effective plan falls back to free.
    await req(
      '/webhooks/billing',
      await signed({ type: 'subscription.cancelled', data: { account_id: u.accountId } }),
    );
    acc = (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, u.accountId) }))!;
    expect(acc.status).toBe('cancelled');

    expect((await req('/webhooks/billing', await signed(event, { secret: 'wrong' }))).status).toBe(401);
    expect(
      (await req('/webhooks/billing', await signed(event, { ts: Math.floor(Date.now() / 1000) - 3600 })))
        .status,
    ).toBe(400);
    const tampered = await signed(event);
    tampered.body = tampered.body.replace('agency_annual', 'vendor');
    expect((await req('/webhooks/billing', tampered)).status).toBe(401);
  });

  it('records processing errors for unknown accounts', async () => {
    const r = await req(
      '/webhooks/billing',
      await signed(
        {
          type: 'subscription.updated',
          data: { account_id: 'acc_missing', plan: 'store', status: 'active' },
        },
        { id: 'evt_unknown_acc' },
      ),
    );
    expect(r.status).toBe(200);
    const ev = (await getDb(env.DB).query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.eventId, 'evt_unknown_acc'),
    }))!;
    expect(ev.error).toContain('unknown account');
  });
});
