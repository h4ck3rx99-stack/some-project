import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { LOGIN_LIMITS } from '../config/plans';
import { adminEmails } from '../env';
import { emailProvider } from '../email';
import { magicLinkEmail } from '../email/templates';
import { maskEmail, sha256Hex } from '../lib/crypto';
import { log } from '../lib/log';
import { HOUR, hit } from '../lib/rateLimit';
import { audit } from '../services/audit';
import {
  consumeLoginToken,
  createLoginToken,
  createSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../services/auth';
import { Layout, Notice } from '../views/layout';
import { clientIpHash, requireCsrf, type HonoEnv } from './helpers';

export const authRoutes = new Hono<HonoEnv>();

const loginForm = z.object({ email: z.email().max(254), next: z.string().max(500).optional() });

/** Only allow same-site relative redirects after login. */
export function safeNext(next: string | undefined | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/app';
  return next;
}

authRoutes.get('/login', (c) => {
  const sent = c.req.query('sent') === '1';
  const next = safeNext(c.req.query('next'));
  return c.html(
    <Layout title="Log in" user={c.var.user} csrf={c.var.csrf}>
      <div class="w440">
        <h1>Log in or sign up</h1>
        {sent ? (
          <Notice>
            If that address can receive email, a sign-in link is on its way. It works once and expires in 15
            minutes.
          </Notice>
        ) : (
          <>
            <p class="muted">We email you a one-time sign-in link. No password needed.</p>
            <form method="post" action="/login" class="card">
              <label for="email">Email</label>
              <input id="email" name="email" type="email" required autocomplete="email" />
              <input type="hidden" name="next" value={next} />
              <p class="mt12">
                <button type="submit">Email me a link</button>
              </p>
            </form>
          </>
        )}
      </div>
    </Layout>,
  );
});

authRoutes.post('/login', async (c) => {
  const env = c.var.env;
  const parsed = loginForm.safeParse(await c.req.parseBody());
  if (!parsed.success) throw new HTTPException(400, { message: 'Enter a valid email address.' });
  const email = parsed.data.email.trim().toLowerCase();
  const ip = await clientIpHash(c);
  const byEmail = await hit(
    c.env.DB,
    `login:email:${await sha256Hex(email)}`,
    LOGIN_LIMITS.perHourPerEmail,
    HOUR,
  );
  const byIp = await hit(c.env.DB, `login:ip:${ip}`, LOGIN_LIMITS.perHourPerIp, HOUR);
  if (!byIp.allowed)
    throw new HTTPException(429, { message: 'Too many sign-in requests. Please try again in an hour.' });
  // Same response whether or not the address exists or is rate limited per email.
  if (byEmail.allowed) {
    const token = await createLoginToken(c.env.DB, email, ip);
    const link = `${env.APP_URL}/auth/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(safeNext(parsed.data.next))}`;
    const r = await emailProvider(env).send(magicLinkEmail(email, link));
    if (!r.ok) log.error({ msg: 'magic link email failed', to_masked: maskEmail(email), error: r.error });
  } else {
    log.warn({ msg: 'login rate limited for email', to_masked: maskEmail(email) });
  }
  return c.redirect('/login?sent=1', 303);
});

authRoutes.get('/auth/verify', async (c) => {
  const env = c.var.env;
  const token = c.req.query('token') ?? '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token))
    throw new HTTPException(400, { message: 'This sign-in link is invalid.' });
  const user = await consumeLoginToken(c.env.DB, token, adminEmails(env));
  if (!user) {
    return c.html(
      <Layout title="Link expired" user={null} noindex>
        <h1>This sign-in link has expired or was already used</h1>
        <p>
          <a href="/login">Request a new link</a>
        </p>
      </Layout>,
      400,
    );
  }
  // Rotate: drop any existing session cookie's session, issue a fresh one.
  const old = getCookie(c, SESSION_COOKIE);
  if (old) await destroySession(c.env.DB, old);
  const sessionToken = await createSession(c.env.DB, user.id);
  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: true, // browsers accept Secure cookies on http://localhost too
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  await audit(c.env.DB, 'login', {}, { userId: user.id });
  return c.redirect(safeNext(c.req.query('next')), 303);
});

authRoutes.post('/logout', async (c) => {
  const form = await c.req.parseBody();
  if (c.var.session) await requireCsrf(c, form);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(c.env.DB, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.redirect('/', 303);
});
