import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../src/db/client';
import { consoleOutbox } from '../src/email/console';
import { createLoginToken } from '../src/services/auth';
import { env, form, login, post, req, setPlan } from './appHelpers';

function lastLinkFor(email: string): string {
  const mail = [...consoleOutbox].reverse().find((m) => m.to === email)!;
  return /\/auth\/verify\?[^\s]+/.exec(mail.text)![0];
}

describe('magic link auth', () => {
  it('gives an identical response for any address and never reveals existence', async () => {
    const a = await req('/login', form({ email: 'new-person@example.com' }));
    const b = await req('/login', form({ email: 'new-person@example.com' }));
    expect(a.status).toBe(303);
    expect(a.headers.get('location')).toBe('/login?sent=1');
    expect(b.headers.get('location')).toBe('/login?sent=1');
    // No user is created until the link is used.
    const u = await getDb(env.DB).query.users.findFirst({ where: eq(schema.users.email, 'new-person@example.com') });
    expect(u).toBeUndefined();
  });

  it('links are single-use', async () => {
    await req('/login', form({ email: 'once@example.com' }));
    const link = lastLinkFor('once@example.com');
    const first = await req(link.slice(link.indexOf('/auth')));
    expect(first.status).toBe(303);
    const cookie = first.headers.get('set-cookie')!;
    expect(cookie).toMatch(/cp_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const second = await req(link.slice(link.indexOf('/auth')));
    expect(second.status).toBe(400);
  });

  it('links expire after 15 minutes', async () => {
    const token = await createLoginToken(env.DB, 'late@example.com', null, Date.now() - 16 * 60 * 1000);
    const r = await req(`/auth/verify?token=${token}`);
    expect(r.status).toBe(400);
  });

  it('rate limits login requests per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await req('/login', { ...form({ email: `x${i}@example.com` }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '198.51.100.99' } });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([303, 303, 303, 303, 303, 429]);
  });

  it('rate limits login emails per address silently (5/hour)', async () => {
    const before = consoleOutbox.filter((m) => m.to === 'spam-me@example.com').length;
    for (let i = 0; i < 7; i++) await req('/login', { ...form({ email: 'spam-me@example.com' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `198.51.100.${i + 10}` } });
    expect(consoleOutbox.filter((m) => m.to === 'spam-me@example.com').length - before).toBe(5);
  });

  it('only allows same-site redirects after login', async () => {
    await req('/login', form({ email: 'redir@example.com', next: 'https://evil.example.com/' }));
    const link = lastLinkFor('redir@example.com');
    const r = await req(link.slice(link.indexOf('/auth')));
    expect(r.headers.get('location')).toBe('/app');
  });

  it('requires login for /app and CSRF for dashboard POSTs', async () => {
    const anon = await req('/app');
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toBe('/login?next=%2Fapp');
    const c = await login('csrf@example.com');
    await setPlan(c.accountId, 'store');
    const noToken = await req('/app/stores/new', { ...form({ url: 'good.mockstore.test' }), cookie: c.cookie });
    expect(noToken.status).toBe(403);
    const badToken = await req('/app/stores/new', { ...form({ url: 'good.mockstore.test', _csrf: 'nope' }), cookie: c.cookie });
    expect(badToken.status).toBe(403);
    const ok = await post(c, '/app/stores/new', { url: 'good.mockstore.test' });
    expect(ok.status).toBe(303);
  });

  it('grants admin to ADMIN_EMAILS and hides /admin from others', async () => {
    const admin = await login('admin@cartprobe.test');
    expect((await req('/admin', { cookie: admin.cookie })).status).toBe(200);
    const user = await login('notadmin@example.com');
    expect((await req('/admin', { cookie: user.cookie })).status).toBe(404);
  });

  it('logout destroys the session', async () => {
    const c = await login('bye@example.com');
    const r = await post(c, '/logout');
    expect(r.status).toBe(303);
    expect((await req('/app', { cookie: c.cookie })).status).toBe(302);
  });
});
