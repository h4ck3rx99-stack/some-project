import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Bindings } from '../env';
import { ipHash } from '../lib/crypto';
import { allowTestTld, makeTransport } from '../lib/transport';
import { accountForUser, planOf, storeForUser, type Account, type Store } from '../services/accounts';
import { checkCsrf, csrfToken, loadSession, SESSION_COOKIE } from '../services/auth';
import type { schema } from '../db/client';
import type { RunnerDeps } from '../jobs/runner';
import type { AlertDeps } from '../services/alerts';
import { emailProvider } from '../email';
import { userAgentFor } from '../scan/context';
import type { FetchLike } from '../lib/safeFetch';
import { processScanAlerts } from '../services/alerts';

export type User = typeof schema.users.$inferSelect;
export type Session = typeof schema.sessions.$inferSelect;

export interface Vars {
  requestId: string;
  env: AppEnv;
  user: User | null;
  session: Session | null;
  account: Account | null;
  csrf: string;
  /** Test hook: overrides the outbound transport (never set in production code paths). */
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export type HonoEnv = { Bindings: Bindings; Variables: Vars };
export type Ctx = Context<HonoEnv>;

export async function clientIpHash(c: Ctx): Promise<string> {
  const ip =
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return ipHash(c.var.env.IP_HASH_SALT, ip);
}

/** Load the session (if any) into c.var. Never throws for a bad cookie. */
export const sessionMiddleware: MiddlewareHandler<HonoEnv> = async (c, next) => {
  c.set('user', null);
  c.set('session', null);
  c.set('account', null);
  c.set('csrf', '');
  const token = getCookie(c, SESSION_COOKIE);
  if (token && token.length < 200) {
    const s = await loadSession(c.env.DB, token);
    if (s) {
      c.set('user', s.user);
      c.set('session', s.session);
      c.set('account', await accountForUser(c.env.DB, s.user.id));
      c.set('csrf', await csrfToken(c.var.env.SESSION_SECRET, s.session.csrfSecret));
    }
  }
  await next();
};

export function requireUser(c: Ctx): { user: User; account: Account; session: Session } {
  const user = c.var.user;
  const account = c.var.account;
  const session = c.var.session;
  if (!user || !account || !session) throw new HTTPException(401, { message: 'Please log in.' });
  return { user, account, session };
}

export function requireAdmin(c: Ctx): User {
  const { user } = requireUser(c);
  if (user.role !== 'admin') throw new HTTPException(404, { message: 'Not found' });
  return user;
}

/** Verify the CSRF token on a state-changing request (form field `_csrf` or header `x-csrf-token`). */
export async function requireCsrf(c: Ctx, form?: Record<string, unknown>): Promise<void> {
  const session = c.var.session;
  const provided = (typeof form?._csrf === 'string' ? form._csrf : undefined) ?? c.req.header('x-csrf-token');
  if (!session || !(await checkCsrf(c.var.env.SESSION_SECRET, session.csrfSecret, provided))) {
    throw new HTTPException(403, {
      message: 'Your session form token was missing or invalid. Reload the page and try again.',
    });
  }
}

/**
 * The one helper every store route uses: returns the store only when the logged-in user is a
 * member of its account; otherwise 404 (we do not reveal that the store exists).
 */
export async function requireStoreAccess(c: Ctx, storeId: string): Promise<Store> {
  const { user } = requireUser(c);
  const store = await storeForUser(c.env.DB, storeId, user.id);
  if (!store) throw new HTTPException(404, { message: 'Store not found' });
  return store;
}

export function currentPlan(c: Ctx) {
  const { account } = requireUser(c);
  return planOf(account);
}

export function alertDeps(c: { env: Bindings; var: Pick<Vars, 'env' | 'fetchImpl'> }): AlertDeps {
  const env = c.var.env;
  return {
    d1: c.env.DB,
    appUrl: env.APP_URL,
    encryptionKey: env.ENCRYPTION_KEY,
    signingSecret: env.SESSION_SECRET,
    email: emailProvider(env),
    userAgent: userAgentFor(env.APP_DOMAIN),
    fetchImpl: c.var.fetchImpl ?? makeTransport(env),
  };
}

export function runnerDeps(
  bindings: Bindings,
  env: AppEnv,
  fetchImpl?: FetchLike,
  sleep?: (ms: number) => Promise<void>,
): RunnerDeps {
  const deps: RunnerDeps = {
    d1: bindings.DB,
    appUrl: env.APP_URL,
    appDomain: env.APP_DOMAIN,
    allowTestTld: allowTestTld(env),
    fetchImpl: fetchImpl ?? makeTransport(env),
    captures: bindings.CAPTURES,
    sleep,
  };
  deps.onFinished = async (scanId) => {
    await processScanAlerts(alertDeps({ env: bindings, var: { env, fetchImpl } }), scanId);
  };
  return deps;
}

export function wantsJson(c: Ctx): boolean {
  const p = c.req.path;
  return (
    p.startsWith('/api/') ||
    p.startsWith('/webhooks/') ||
    p.endsWith('/status') ||
    p === '/healthz' ||
    (c.req.header('accept') ?? '').startsWith('application/json')
  );
}
