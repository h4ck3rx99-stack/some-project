import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { appEnv } from './env';
import { log } from './lib/log';
import { newId } from './lib/crypto';
import { sessionMiddleware, wantsJson, type HonoEnv } from './routes/helpers';
import { publicRoutes } from './routes/public';
import { authRoutes } from './routes/auth';
import { appRoutes } from './routes/app';
import { apiRoutes } from './routes/api';
import { adminRoutes } from './routes/admin';
import { webhookRoutes } from './routes/webhooks';
import { Layout } from './views/layout';
import { CSS } from './views/css';
import { JS } from './views/js';
import type { FetchLike } from './lib/safeFetch';

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export interface AppOptions {
  /** Outbound transport override for tests (the mock store). Production passes nothing. */
  fetchImpl?: FetchLike;
  /** Politeness delay override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono<HonoEnv>();

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const rid = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : newId('req_');
    c.set('requestId', rid);
    c.set('env', appEnv(c.env));
    if (opts.fetchImpl) c.set('fetchImpl', opts.fetchImpl);
    if (opts.sleep) c.set('sleep', opts.sleep);
    await next();
    c.header('x-request-id', rid);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    if (c.var.env.ENVIRONMENT === 'production') c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });

  // Reject cross-site state-changing browser requests early (defence in depth next to CSRF tokens).
  app.use('*', async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && !c.req.path.startsWith('/api/') && !c.req.path.startsWith('/webhooks/')) {
      const origin = c.req.header('origin');
      if (origin && origin !== 'null' && origin !== new URL(c.var.env.APP_URL).origin) {
        throw new HTTPException(403, { message: 'Cross-site request blocked.' });
      }
    }
    await next();
  });

  app.get('/static/app.css', (c) => c.body(CSS, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' }));
  app.get('/static/app.js', (c) => c.body(JS, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' }));

  app.get('/healthz', async (c) => {
    let db: 'ok' | 'error' = 'ok';
    try {
      await c.env.DB.prepare('SELECT 1').first();
    } catch {
      db = 'error';
    }
    return c.json({ ok: db === 'ok', version: '0.1.0', db }, db === 'ok' ? 200 : 503);
  });

  app.use('*', sessionMiddleware);
  app.route('/', publicRoutes);
  app.route('/', authRoutes);
  app.route('/app', appRoutes);
  app.route('/api/v1', apiRoutes);
  app.route('/admin', adminRoutes);
  app.route('/webhooks', webhookRoutes);

  app.notFound((c) => {
    if (wantsJson(c)) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
    return c.html(
      <Layout title="Not found" user={c.var.user} csrf={c.var.csrf} noindex>
        <h1>Page not found</h1>
        <p>
          <a href="/">Go to the homepage</a>
        </p>
      </Layout>,
      404,
    );
  });

  app.onError((err, c) => {
    const status = err instanceof HTTPException ? err.status : 500;
    const message = err instanceof HTTPException ? err.message : 'Something went wrong on our side. Please try again.';
    if (status >= 500) log.error({ msg: 'unhandled error', request_id: c.var.requestId, route: c.req.path, error: String(err?.stack ?? err).slice(0, 2000) });
    if (status === 401 && !wantsJson(c)) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`);
    if (wantsJson(c)) {
      const codes: Record<number, string> = { 400: 'bad_request', 401: 'unauthorized', 402: 'payment_required', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'rate_limited' };
      const code = codes[status] ?? 'internal_error';
      return c.json({ error: { code, message } }, status as 400);
    }
    let user = null;
    try {
      user = c.var.user;
    } catch {
      user = null;
    }
    return c.html(
      <Layout title="Error" user={user} csrf={c.var.csrf} noindex>
        <h1>{status === 404 ? 'Not found' : status === 429 ? 'Slow down' : status >= 500 ? 'Something went wrong' : 'Request not allowed'}</h1>
        <p>{message}</p>
        <p class="muted small">Reference: {c.var.requestId}</p>
      </Layout>,
      status as 400,
    );
  });

  return app;
}
