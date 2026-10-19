import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client';
import { env, form, req } from './appHelpers';
import { SECURITY_HEADERS } from '../src/app';

describe('public scan flow', () => {
  it('runs an anonymous scan end to end and renders the report', async () => {
    const r = await req('/scan', form({ url: 'good.mockstore.test' }));
    expect(r.status).toBe(303);
    const loc = r.headers.get('location')!;
    expect(loc).toMatch(/^\/r\/[A-Za-z0-9]+$/);
    const status = await (await req(`${loc}/status`)).json<{ status: string; progress: number }>();
    expect(status.status).toBe('done');
    expect(status.progress).toBe(100);
    const page = await req(loc);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Agent-ready');
    expect(html).toContain('UCP profile is reachable');
    expect(html).toContain('2026-08-25');
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(page.headers.get(k)).toBe(v);
    expect(page.headers.get('x-request-id')).toBeTruthy();
  });

  it('reuses a fresh scan of the same domain', async () => {
    const a = await req('/scan', form({ url: 'https://outdated.mockstore.test/some/page' }));
    const b = await req('/scan', form({ url: 'outdated.mockstore.test' }));
    expect(a.headers.get('location')).toBe(b.headers.get('location'));
  });

  it('rejects private and malformed targets', async () => {
    for (const url of ['127.0.0.1', 'localhost', 'http://10.0.0.1', 'javascript:alert(1)', 'intranet']) {
      const r = await req('/scan', form({ url }));
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toMatch(/^\/\?error=/);
    }
  });

  it('honeypot submissions do not create scans', async () => {
    const before = await env.DB.prepare('SELECT count(*) AS n FROM scans').first<{ n: number }>();
    const r = await req('/scan', form({ url: 'slow.mockstore.test', website: 'http://spam' }));
    expect(r.headers.get('location')).toBe('/');
    const after = await env.DB.prepare('SELECT count(*) AS n FROM scans').first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('rate limits anonymous scans per IP (5/hour)', async () => {
    const ip = '192.0.2.55';
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await req('/scan', { ...form({ url: `rl${i}.mockstore.test` }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip } });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([303, 303, 303, 303, 303, 429]);
  });

  it('rate limits anonymous scans per domain (3/day)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await req('/scan', { ...form({ url: 'perdomain.mockstore.test' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `192.0.2.${100 + i}` } });
      statuses.push(r.status);
      // Age the scan so the "fresh scan" reuse does not kick in.
      await getDb(env.DB).update(schema.scans).set({ createdAt: Date.now() - 2 * 60 * 60 * 1000 }).where(eq(schema.scans.domain, 'perdomain.mockstore.test'));
    }
    expect(statuses).toEqual([303, 303, 303, 429]);
  });

  it('serves fix guides, docs, pricing, bot page and our platform profile', async () => {
    expect((await req('/fix/consistency.price_match')).status).toBe(200);
    expect((await req('/fix/nope')).status).toBe(404);
    const docs = await (await req('/docs')).text();
    expect(docs).toContain('discovery.namespace_host_rule');
    expect((await req('/pricing')).status).toBe(200);
    expect(await (await req('/bot')).text()).toContain('CartProbeBot/1.0 (+https://cartprobe.test/bot)');
    const profile = await (await req('/.well-known/ucp')).json<{ ucp: { version: string } }>();
    expect(profile.ucp.version).toBe('2026-08-25');
    expect(await (await req('/healthz')).json()).toEqual({ ok: true, version: '0.1.0', db: 'ok' });
  });

  it('returns JSON errors for API routes and HTML for pages', async () => {
    const api = await req('/api/v1/scans/x');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: { code: 'unauthorized', message: 'Missing or invalid API key.' } });
    const page = await req('/r/doesnotexist1');
    expect(page.status).toBe(404);
    expect(page.headers.get('content-type')).toContain('text/html');
  });

  it('blocks cross-site form posts', async () => {
    const r = await req('/scan', { ...form({ url: 'good.mockstore.test' }), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' } });
    expect(r.status).toBe(403);
  });
});
