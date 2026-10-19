import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createApp } from '../src/app';
import { getDb, schema } from '../src/db/client';
import { consoleOutbox } from '../src/email/console';
import { eq } from 'drizzle-orm';
import { mockFetch } from './helpers';
import type { FetchLike } from '../src/lib/safeFetch';
import type { PlanId } from '../src/config/plans';

export { env };

export interface Client {
  cookie: string;
  csrf: string;
  email: string;
  userId: string;
  accountId: string;
}

export function makeApp(fetchImpl: FetchLike = mockFetch) {
  return createApp({ fetchImpl, sleep: async () => undefined });
}

let defaultApp = makeApp();
export function useApp(fetchImpl: FetchLike) {
  defaultApp = makeApp(fetchImpl);
}
export function resetApp() {
  defaultApp = makeApp();
}

/** Make a request and wait for every waitUntil() (background scan work) to settle. */
export async function req(path: string, init: RequestInit & { cookie?: string } = {}, app = defaultApp): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '203.0.113.7');
  const ctx = createExecutionContext();
  const res = await app.request(`https://cartprobe.test${path}`, { ...init, headers, redirect: 'manual' }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function form(data: Record<string, string>): RequestInit {
  return { method: 'POST', body: new URLSearchParams(data), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
}

export function csrfFrom(html: string): string {
  return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
}

export async function login(email: string, ip = '198.51.100.1'): Promise<Client> {
  const r = await req('/login', { ...form({ email }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip } });
  if (r.status !== 303) throw new Error(`login POST ${r.status}`);
  const mail = [...consoleOutbox].reverse().find((m) => m.to === email);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1];
  if (!token) throw new Error('no magic link');
  const v = await req(`/auth/verify?token=${token}`);
  const cookie = (v.headers.get('set-cookie') ?? '').split(';')[0]!;
  const page = await req('/app', { cookie });
  const html = await page.text();
  const db = getDb(env.DB);
  const user = (await db.query.users.findFirst({ where: eq(schema.users.email, email) }))!;
  const member = (await db.query.accountMembers.findFirst({ where: eq(schema.accountMembers.userId, user.id) }))!;
  return { cookie, csrf: csrfFrom(html), email, userId: user.id, accountId: member.accountId };
}

export async function setPlan(accountId: string, plan: PlanId, status: 'active' | 'cancelled' = 'active') {
  await getDb(env.DB).update(schema.accounts).set({ plan, status, currentPeriodEnd: null }).where(eq(schema.accounts.id, accountId));
}

export function post(c: Client, path: string, data: Record<string, string> = {}) {
  return req(path, { ...form({ _csrf: c.csrf, ...data }), cookie: c.cookie });
}
