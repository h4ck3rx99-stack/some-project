import { asc, desc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { PLAN_ORDER } from '../config/plans';
import { getDb, schema } from '../db/client';
import { audit } from '../services/audit';
import { Csrf, Layout } from '../views/layout';
import { requireAdmin, requireCsrf, type Ctx, type HonoEnv } from './helpers';

export const adminRoutes = new Hono<HonoEnv>();

adminRoutes.use('*', async (c, next) => {
  requireAdmin(c);
  await next();
});

const t = (ms: number | null | undefined) =>
  ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '–';

function Page(p: { c: Ctx; title: string; children?: unknown }) {
  return (
    <Layout title={p.title} user={p.c.var.user} csrf={p.c.var.csrf} noindex>
      <p class="small">
        <a href="/admin">Admin</a> · <a href="/admin/health">Health</a>
      </p>
      {p.children as never}
    </Layout>
  );
}

adminRoutes.get('/', async (c) => {
  const db = getDb(c.env.DB);
  const accounts = await db
    .select()
    .from(schema.accounts)
    .orderBy(desc(schema.accounts.createdAt))
    .limit(100);
  const scans = await db.select().from(schema.scans).orderBy(desc(schema.scans.createdAt)).limit(30);
  const failedJobs = await db
    .select()
    .from(schema.scanJobs)
    .where(isNotNull(schema.scanJobs.lastError))
    .orderBy(desc(schema.scanJobs.updatedAt))
    .limit(30);
  const alertFailures = await db
    .select()
    .from(schema.alerts)
    .where(eq(schema.alerts.status, 'failed'))
    .orderBy(desc(schema.alerts.sentAt))
    .limit(30);
  const hookErrors = await db
    .select()
    .from(schema.webhookEvents)
    .where(isNotNull(schema.webhookEvents.error))
    .limit(30);
  return c.html(
    <Page c={c} title="Admin">
      <h1>Admin</h1>
      <h2>Accounts</h2>
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Plan / status / period end</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr>
                <td>
                  {a.name}
                  <div class="mono muted">{a.id}</div>
                </td>
                <td>
                  <form method="post" action={`/admin/accounts/${a.id}/plan`} class="row">
                    <Csrf token={c.var.csrf} />
                    <select name="plan" aria-label="Plan">
                      {PLAN_ORDER.map((p) => (
                        <option value={p} selected={p === a.plan}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <select name="status" aria-label="Status">
                      {(['active', 'trialing', 'past_due', 'cancelled'] as const).map((s) => (
                        <option value={s} selected={s === a.status}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <input
                      type="date"
                      name="period_end"
                      aria-label="Period end"
                      value={
                        a.currentPeriodEnd ? new Date(a.currentPeriodEnd).toISOString().slice(0, 10) : ''
                      }
                    />
                    <button type="submit">Save</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Recent scans</h2>
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Domain</th>
              <th>Trigger</th>
              <th>Status</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {scans.map((s) => (
              <tr>
                <td>{t(s.createdAt)}</td>
                <td>
                  <a href={`/r/${s.publicSlug}`}>{s.domain}</a>
                </td>
                <td>{s.trigger}</td>
                <td>
                  {s.status} ({s.phase})
                </td>
                <td>{s.score ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Failed or retrying jobs</h2>
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Phase / attempts</th>
              <th>Last error</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {failedJobs.map((j) => (
              <tr>
                <td class="mono">{j.scanId}</td>
                <td>
                  {j.phase} / {j.attempts}
                </td>
                <td class="mono small">{(j.lastError ?? '').slice(0, 400)}</td>
                <td>
                  <form method="post" action={`/admin/jobs/${j.id}/retry`}>
                    <Csrf token={c.var.csrf} />
                    <button type="submit">Retry</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Alert failures</h2>
      <div class="card table-wrap">
        <table>
          <tbody>
            {alertFailures.map((a) => (
              <tr>
                <td>{t(a.sentAt)}</td>
                <td>{a.kind}</td>
                <td class="small">{a.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Webhook events with errors</h2>
      <div class="card table-wrap">
        <table>
          <tbody>
            {hookErrors.map((w) => (
              <tr>
                <td class="mono">{w.eventId}</td>
                <td>{w.type}</td>
                <td class="small">{w.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>,
  );
});

const planForm = z.object({
  plan: z.enum(['free', 'store', 'agency', 'vendor']),
  status: z.enum(['active', 'trialing', 'past_due', 'cancelled']),
  period_end: z.union([z.literal(''), z.iso.date()]).optional(),
  _csrf: z.string(),
});

adminRoutes.post('/accounts/:id/plan', async (c) => {
  const body = await c.req.parseBody();
  await requireCsrf(c, body);
  const f = planForm.safeParse(body);
  if (!f.success) throw new HTTPException(400, { message: 'Invalid plan form.' });
  const admin = requireAdmin(c);
  const periodEnd = f.data.period_end ? Date.parse(`${f.data.period_end}T23:59:59Z`) : null;
  await getDb(c.env.DB)
    .update(schema.accounts)
    .set({ plan: f.data.plan, status: f.data.status, currentPeriodEnd: periodEnd, billingProvider: 'manual' })
    .where(eq(schema.accounts.id, c.req.param('id')));
  await audit(
    c.env.DB,
    'admin.plan_override',
    { plan: f.data.plan, status: f.data.status, periodEnd },
    { accountId: c.req.param('id'), userId: admin.id },
  );
  return c.redirect('/admin', 303);
});

adminRoutes.post('/jobs/:id/retry', async (c) => {
  await requireCsrf(c, await c.req.parseBody());
  const admin = requireAdmin(c);
  await getDb(c.env.DB)
    .update(schema.scanJobs)
    .set({ attempts: 0, lastError: null, leaseId: null, lockedUntil: null, runAfter: Date.now() })
    .where(eq(schema.scanJobs.id, c.req.param('id')));
  await audit(c.env.DB, 'admin.job_retry', { jobId: c.req.param('id') }, { userId: admin.id });
  return c.redirect('/admin', 303);
});

adminRoutes.get('/health', async (c) => {
  const db = getDb(c.env.DB);
  const now = Date.now();
  let dbOk = true;
  try {
    await c.env.DB.prepare('SELECT 1').first();
  } catch {
    dbOk = false;
  }
  const backlog = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.scanJobs)
    .where(lte(schema.scanJobs.runAfter, now));
  const oldest = await db
    .select({ createdAt: schema.scanJobs.createdAt })
    .from(schema.scanJobs)
    .where(isNull(schema.scanJobs.lockedUntil))
    .orderBy(asc(schema.scanJobs.createdAt))
    .limit(1);
  const crons = await db.select().from(schema.cronRuns);
  return c.html(
    <Page c={c} title="Health">
      <h1>Health</h1>
      <div class="card">
        <p>Database: {dbOk ? 'ok' : 'error'}</p>
        <p>Job backlog (due now): {backlog[0]?.n ?? 0}</p>
        <p>
          Oldest queued job: {oldest[0] ? `${Math.round((now - oldest[0].createdAt) / 1000)} s old` : 'none'}
        </p>
      </div>
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cron</th>
              <th>Last run</th>
              <th>Duration</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {crons.map((r) => (
              <tr>
                <td class="mono">{r.name}</td>
                <td>{t(r.lastRunAt)}</td>
                <td>{r.lastDurationMs ?? '–'} ms</td>
                <td class="small">{r.lastResult}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>,
  );
});
