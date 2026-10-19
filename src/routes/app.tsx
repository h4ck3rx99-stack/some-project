import { and, count, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { validateTarget } from '../alerts/channel';
import { billingProvider } from '../billing';
import { checkoutEndpointAllowed } from '../checks/checkout';
import { PLAN_ORDER, PLANS, type PlanId } from '../config/plans';
import { getDb, schema } from '../db/client';
import { encryptSecret, newId, randomToken } from '../lib/crypto';
import { kickScan } from '../jobs/runner';
import { checkUrl } from '../lib/safeFetch';
import { allowTestTld, makeTransport } from '../lib/transport';
import { normaliseStoreUrl, userAgentFor } from '../scan/context';
import { planOf, type Store } from '../services/accounts';
import { deliver } from '../services/alerts';
import { audit } from '../services/audit';
import { createApiKey } from '../services/auth';
import { createScan, getResults, storeScans } from '../services/scans';
import { verifyOwnership } from '../services/verify';
import { Csrf, Layout, Notice } from '../views/layout';
import { HistoryChart, ReportBody, Sparkline } from '../views/report';
import {
  alertDeps,
  requireCsrf,
  requireStoreAccess,
  requireUser,
  runnerDeps,
  type Ctx,
  type HonoEnv,
} from './helpers';

export const appRoutes = new Hono<HonoEnv>();

appRoutes.use('*', async (c, next) => {
  requireUser(c);
  await next();
});

/** Parse a form and enforce CSRF in one step (every dashboard POST goes through this). */
async function form(c: Ctx): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  await requireCsrf(c, body);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === 'string') out[k] = v;
  return out;
}

function Page(p: { c: Ctx; title: string; children?: unknown }) {
  return (
    <Layout title={p.title} user={p.c.var.user} csrf={p.c.var.csrf} noindex>
      {p.children as never}
    </Layout>
  );
}

function fmtTime(t: number | null | undefined) {
  if (!t) return '–';
  return (
    <time datetime={new Date(t).toISOString()}>
      {new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC
    </time>
  );
}

async function startStoreScan(c: Ctx, store: Store, trigger: 'manual' | 'scheduled') {
  const { account } = requireUser(c);
  const plan = planOf(account);
  const scan = await createScan(c.env.DB, {
    url: store.url,
    domain: store.domain,
    trigger,
    storeId: store.id,
    accountId: store.accountId,
    productsSampled: plan.productsSampled,
    verifiedOwnership: !!store.verifiedAt,
    testCheckoutEndpoint: store.testCheckoutEndpoint,
    testModeConfirmed: !!store.testModeConfirmedAt,
  });
  c.executionCtx.waitUntil(
    kickScan(runnerDeps(c.env, c.var.env, c.var.fetchImpl, c.var.sleep), scan.id, 25_000),
  );
  return scan;
}

/* ------------------------------- dashboard ------------------------------- */

appRoutes.get('/', async (c) => {
  const { account } = requireUser(c);
  const db = getDb(c.env.DB);
  const plan = planOf(account);
  const stores = await db
    .select()
    .from(schema.stores)
    .where(eq(schema.stores.accountId, account.id))
    .orderBy(schema.stores.name);
  const ids = stores.map((s) => s.id);
  const history = ids.length
    ? await db
        .select({
          storeId: schema.scans.storeId,
          score: schema.scans.score,
          finishedAt: schema.scans.finishedAt,
          status: schema.scans.status,
        })
        .from(schema.scans)
        .where(and(inArray(schema.scans.storeId, ids), isNotNull(schema.scans.finishedAt)))
        .orderBy(desc(schema.scans.finishedAt))
        .limit(400)
    : [];
  return c.html(
    <Page c={c} title="Dashboard">
      <div class="row" style="align-items:center">
        <h1 style="margin:0">Your stores</h1>
        <a class="btn" href="/app/stores/new">
          Add store
        </a>
      </div>
      <p class="muted">
        Plan: <b>{plan.name}</b> · {stores.length} of {plan.maxStores} stores ·{' '}
        <a href="/app/billing">Billing</a> · <a href="/app/alerts">Alerts</a> ·{' '}
        <a href="/app/settings">Settings</a>
        {plan.apiAccess ? (
          <>
            {' '}
            · <a href="/app/api-keys">API keys</a>
          </>
        ) : null}
      </p>
      {plan.id === 'free' ? (
        <Notice>
          Monitoring needs a paid plan. You can still add a store after upgrading, or run free one-off scans
          from the homepage.
        </Notice>
      ) : null}
      {stores.length === 0 ? (
        <div class="card">
          <p>No stores yet.</p>
        </div>
      ) : (
        <div class="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Store</th>
                <th>Score</th>
                <th>Trend</th>
                <th>Last scan</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => {
                const h = history.filter((x) => x.storeId === s.id && x.status === 'done');
                const trend = h
                  .slice(0, 10)
                  .map((x) => x.score ?? 0)
                  .reverse();
                return (
                  <tr>
                    <td>
                      <a href={`/app/stores/${s.id}`}>{s.name}</a>
                      <div class="muted small">{s.domain}</div>
                    </td>
                    <td>{s.lastScore ?? '–'}</td>
                    <td>
                      <Sparkline values={trend} />
                    </td>
                    <td>{fmtTime(h[0]?.finishedAt)}</td>
                    <td>
                      <span class={`chip ${s.monitoring ? 's-pass' : ''}`}>
                        {s.monitoring ? 'Monitoring' : 'Not monitored'}
                      </span>{' '}
                      {s.verifiedAt ? (
                        <span class="chip s-pass">Verified</span>
                      ) : (
                        <span class="chip">Unverified</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Page>,
  );
});

/* ------------------------------- stores ------------------------------- */

appRoutes.get('/stores/new', (c) => {
  const plan = planOf(requireUser(c).account);
  return c.html(
    <Page c={c} title="Add store">
      <h1>Add a store</h1>
      {plan.maxStores === 0 ? (
        <Notice kind="warn">
          Your plan does not include monitored stores. <a href="/app/billing">Upgrade</a> to add one.
        </Notice>
      ) : null}
      <form method="post" action="/app/stores/new" class="card" style="max-width:560px">
        <Csrf token={c.var.csrf} />
        <label for="url">Store URL</label>
        <input
          id="url"
          name="url"
          type="text"
          required
          value={c.req.query('url') ?? ''}
          placeholder="https://yourstore.com"
        />
        <label for="name" style="margin-top:12px">
          Name (optional)
        </label>
        <input id="name" name="name" type="text" maxlength={80} />
        <p style="margin-top:12px">
          <button type="submit">Add and scan</button>
        </p>
      </form>
    </Page>,
  );
});

const newStoreSchema = z.object({
  url: z.string().trim().min(3).max(2048),
  name: z.string().trim().max(80).optional(),
});

appRoutes.post('/stores/new', async (c) => {
  const f = newStoreSchema.safeParse(await form(c));
  const { account, user } = requireUser(c);
  const plan = planOf(account);
  if (!f.success) throw new HTTPException(400, { message: 'Enter a store URL.' });
  const norm = normaliseStoreUrl(f.data.url);
  const check = norm
    ? checkUrl(norm.origin, { allowTestTld: allowTestTld(c.var.env) })
    : { ok: false as const, reason: 'invalid address' };
  if (!norm || !check.ok)
    throw new HTTPException(400, {
      message: `We can't monitor that address: ${check.ok ? 'invalid' : check.reason}.`,
    });
  const db = getDb(c.env.DB);
  const [{ n }] = (await db
    .select({ n: count() })
    .from(schema.stores)
    .where(eq(schema.stores.accountId, account.id))) as [{ n: number }];
  if (n >= plan.maxStores) {
    return c.html(
      <Page c={c} title="Upgrade needed">
        <h1>Store limit reached</h1>
        <p>
          Your {plan.name} plan includes {plan.maxStores} monitored store{plan.maxStores === 1 ? '' : 's'}.{' '}
          <a href="/app/billing">Upgrade your plan</a> to add more.
        </p>
      </Page>,
      402,
    );
  }
  const existing = await db.query.stores.findFirst({
    where: and(eq(schema.stores.accountId, account.id), eq(schema.stores.domain, norm.domain)),
  });
  if (existing) return c.redirect(`/app/stores/${existing.id}`, 303);
  const store = {
    id: newId('sto_'),
    accountId: account.id,
    url: norm.origin,
    domain: norm.domain,
    name: f.data.name || norm.domain,
    monitoring: plan.dailyMonitoring ? 1 : 0,
    verifyToken: randomToken(18).replace(/[-_]/g, 'x'),
    createdAt: Date.now(),
  };
  await db.insert(schema.stores).values(store);
  await audit(
    c.env.DB,
    'store.create',
    { storeId: store.id, domain: store.domain },
    { accountId: account.id, userId: user.id },
  );
  await startStoreScan(
    c,
    {
      ...store,
      verifiedAt: null,
      testCheckoutEndpoint: null,
      testModeConfirmedAt: null,
      badgeEnabled: 0,
      lastScanId: null,
      lastScore: null,
      lastManualScanAt: null,
    },
    'manual',
  );
  return c.redirect(`/app/stores/${store.id}`, 303);
});

appRoutes.get('/stores/:id', async (c) => {
  const store = await requireStoreAccess(c, c.req.param('id'));
  const { account } = requireUser(c);
  const plan = planOf(account);
  const db = getDb(c.env.DB);
  const history = await storeScans(c.env.DB, store.id, 60);
  const cutoff = Date.now() - plan.historyDays * 24 * 60 * 60 * 1000;
  const visible = history.filter((s) => (s.finishedAt ?? 0) >= cutoff);
  const running = await db.query.scans.findFirst({
    where: and(eq(schema.scans.storeId, store.id), inArray(schema.scans.status, ['queued', 'running'])),
    orderBy: desc(schema.scans.createdAt),
  });
  const latest = visible[0];
  const results = latest ? await getResults(c.env.DB, latest.id) : [];
  const cooldownMs = plan.rescanCooldownMin * 60_000;
  const coolingDown = store.lastManualScanAt && Date.now() - store.lastManualScanAt < cooldownMs;
  return c.html(
    <Page c={c} title={store.name}>
      <p class="small">
        <a href="/app">← All stores</a>
      </p>
      <h1>{store.name}</h1>
      <p class="muted">
        {store.domain} ·{' '}
        {store.verifiedAt ? (
          'ownership verified'
        ) : (
          <a href={`/app/stores/${store.id}/verify`}>verify ownership</a>
        )}{' '}
        · <a href={`/app/stores/${store.id}/checkout-testing`}>checkout testing</a>
        {plan.whiteLabel && latest ? (
          <>
            {' '}
            · <a href={`/app/reports/${latest.id}/print`}>printable report</a>
          </>
        ) : null}
      </p>
      {running ? (
        <div class="card" data-poll={`/r/${running.publicSlug}/status`}>
          <p>
            Scan in progress: <span data-phase>…</span>
          </p>
          <div class="progress">
            <div style="width:5%" />
          </div>
        </div>
      ) : null}
      <div class="card">
        <div class="row">
          <form method="post" action={`/app/stores/${store.id}/rescan`}>
            <Csrf token={c.var.csrf} />
            <button type="submit" disabled={!!coolingDown || !!running}>
              Re-scan now
            </button>
            {coolingDown ? (
              <span class="muted small">
                {' '}
                Available {plan.rescanCooldownMin} minutes after the last manual scan.
              </span>
            ) : null}
          </form>
          <form method="post" action={`/app/stores/${store.id}/monitoring`}>
            <Csrf token={c.var.csrf} />
            <input type="hidden" name="monitoring" value={store.monitoring ? '0' : '1'} />
            <button class="secondary" type="submit" disabled={!plan.dailyMonitoring}>
              {store.monitoring ? 'Pause daily monitoring' : 'Enable daily monitoring'}
            </button>
          </form>
          {plan.badges ? (
            <form method="post" action={`/app/stores/${store.id}/badge`}>
              <Csrf token={c.var.csrf} />
              <input type="hidden" name="badge" value={store.badgeEnabled ? '0' : '1'} />
              <button class="secondary" type="submit">
                {store.badgeEnabled ? 'Disable badge' : 'Enable badge'}
              </button>
            </form>
          ) : null}
          <form
            method="post"
            action={`/app/stores/${store.id}/delete`}
            data-confirm="Delete this store and its scan history?"
          >
            <Csrf token={c.var.csrf} />
            <button class="danger" type="submit">
              Delete store
            </button>
          </form>
        </div>
        {store.badgeEnabled && plan.badges ? (
          <p class="small" style="margin-top:10px">
            Badge: <code id="badge-url" class="mono">{`${c.var.env.APP_URL}/badge/${store.id}.svg`}</code>
            <button class="secondary copy" type="button" data-copy="badge-url">
              Copy
            </button>
          </p>
        ) : null}
      </div>
      <h2>Score history</h2>
      <div class="card">
        <HistoryChart
          points={[...visible]
            .reverse()
            .map((s) => ({ t: s.finishedAt ?? s.createdAt, score: s.score ?? 0 }))}
        />
      </div>
      {latest ? (
        <>
          <h2>Latest report</h2>
          <ReportBody scan={latest} results={results} />
        </>
      ) : (
        <p class="muted">No completed scans yet.</p>
      )}
      <h2>Scan history</h2>
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Finished</th>
              <th>Trigger</th>
              <th>Score</th>
              <th>Grade</th>
              <th>Report</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr>
                <td>{fmtTime(s.finishedAt)}</td>
                <td>{s.trigger}</td>
                <td>{s.score ?? '–'}</td>
                <td>{s.grade ?? '–'}</td>
                <td>
                  <a href={`/r/${s.publicSlug}`}>View</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>,
  );
});

appRoutes.post('/stores/:id/rescan', async (c) => {
  await form(c);
  const store = await requireStoreAccess(c, c.req.param('id'));
  const plan = planOf(requireUser(c).account);
  const now = Date.now();
  // Atomic cooldown claim: only one request per cooldown window can start a scan.
  const claimed = await c.env.DB.prepare(
    'UPDATE stores SET last_manual_scan_at = ?1 WHERE id = ?2 AND (last_manual_scan_at IS NULL OR last_manual_scan_at < ?3)',
  )
    .bind(now, store.id, now - plan.rescanCooldownMin * 60_000)
    .run();
  if (claimed.meta.changes !== 1)
    throw new HTTPException(429, {
      message: `You can re-scan once every ${plan.rescanCooldownMin} minutes.`,
    });
  await startStoreScan(c, store, 'manual');
  return c.redirect(`/app/stores/${store.id}`, 303);
});

appRoutes.post('/stores/:id/monitoring', async (c) => {
  const f = await form(c);
  const store = await requireStoreAccess(c, c.req.param('id'));
  const plan = planOf(requireUser(c).account);
  const on = f.monitoring === '1' && plan.dailyMonitoring ? 1 : 0;
  await getDb(c.env.DB).update(schema.stores).set({ monitoring: on }).where(eq(schema.stores.id, store.id));
  return c.redirect(`/app/stores/${store.id}`, 303);
});

appRoutes.post('/stores/:id/badge', async (c) => {
  const f = await form(c);
  const store = await requireStoreAccess(c, c.req.param('id'));
  const plan = planOf(requireUser(c).account);
  await getDb(c.env.DB)
    .update(schema.stores)
    .set({ badgeEnabled: f.badge === '1' && plan.badges ? 1 : 0 })
    .where(eq(schema.stores.id, store.id));
  return c.redirect(`/app/stores/${store.id}`, 303);
});

appRoutes.post('/stores/:id/delete', async (c) => {
  await form(c);
  const store = await requireStoreAccess(c, c.req.param('id'));
  const { user } = requireUser(c);
  await getDb(c.env.DB).delete(schema.stores).where(eq(schema.stores.id, store.id));
  await audit(
    c.env.DB,
    'store.delete',
    { storeId: store.id, domain: store.domain },
    { accountId: store.accountId, userId: user.id },
  );
  return c.redirect('/app', 303);
});

/* ------------------------------- verification ------------------------------- */

function VerifyPage(p: { c: Ctx; store: Store; result?: { ok: boolean; details: string[] } }) {
  const s = p.store;
  return (
    <Page c={p.c} title="Verify ownership">
      <p class="small">
        <a href={`/app/stores/${s.id}`}>← {s.name}</a>
      </p>
      <h1>Verify ownership of {s.domain}</h1>
      {s.verifiedAt ? <Notice>Verified {fmtTime(s.verifiedAt)}.</Notice> : null}
      {p.result && !p.result.ok ? (
        <Notice kind="error">
          Not verified yet.{' '}
          {p.result.details.map((d) => (
            <span>{d} </span>
          ))}
        </Notice>
      ) : null}
      <p>Verification unlocks deep checkout testing. Use either method:</p>
      <div class="grid two">
        <div class="card">
          <h3 style="margin-top:0">DNS TXT record</h3>
          <p>
            Add a TXT record on <code>{s.domain}</code> with the value:
          </p>
          <p>
            <code id="txt" class="mono">{`cartprobe-verify=${s.verifyToken}`}</code>{' '}
            <button class="secondary copy" type="button" data-copy="txt">
              Copy
            </button>
          </p>
        </div>
        <div class="card">
          <h3 style="margin-top:0">File</h3>
          <p>
            Serve <code>{`https://${s.domain}/.well-known/cartprobe-verify.txt`}</code> containing only:
          </p>
          <p>
            <code id="tok" class="mono">
              {s.verifyToken}
            </code>{' '}
            <button class="secondary copy" type="button" data-copy="tok">
              Copy
            </button>
          </p>
        </div>
      </div>
      <form method="post" action={`/app/stores/${s.id}/verify`}>
        <Csrf token={p.c.var.csrf} />
        <button type="submit">Check now</button>
      </form>
    </Page>
  );
}

appRoutes.get('/stores/:id/verify', async (c) => {
  const store = await requireStoreAccess(c, c.req.param('id'));
  return c.html(<VerifyPage c={c} store={store} />);
});

appRoutes.post('/stores/:id/verify', async (c) => {
  await form(c);
  const store = await requireStoreAccess(c, c.req.param('id'));
  const env = c.var.env;
  const r = await verifyOwnership(store.domain, store.verifyToken, {
    fetchImpl: c.var.fetchImpl ?? makeTransport(env),
    allowTestTld: allowTestTld(env),
    userAgent: userAgentFor(env.APP_DOMAIN),
  });
  if (r.ok) {
    await getDb(c.env.DB)
      .update(schema.stores)
      .set({ verifiedAt: Date.now() })
      .where(eq(schema.stores.id, store.id));
    await audit(
      c.env.DB,
      'store.verified',
      { storeId: store.id, method: r.method },
      { accountId: store.accountId, userId: requireUser(c).user.id },
    );
    return c.redirect(`/app/stores/${store.id}/verify`, 303);
  }
  return c.html(<VerifyPage c={c} store={store} result={r} />, 400);
});

/* ------------------------------- checkout testing ------------------------------- */

appRoutes.get('/stores/:id/checkout-testing', async (c) => {
  const store = await requireStoreAccess(c, c.req.param('id'));
  return c.html(
    <Page c={c} title="Checkout testing">
      <p class="small">
        <a href={`/app/stores/${store.id}`}>← {store.name}</a>
      </p>
      <h1>Checkout testing</h1>
      {!store.verifiedAt ? (
        <Notice kind="warn">
          Verify ownership first. <a href={`/app/stores/${store.id}/verify`}>Verify {store.domain}</a>
        </Notice>
      ) : (
        <>
          <p>
            With checkout testing on, each scan creates one checkout session for a single in-stock item on the
            endpoint below, validates it, and immediately cancels it. CartProbe never sends payment details
            and never completes a checkout.
          </p>
          <form
            method="post"
            action={`/app/stores/${store.id}/checkout-testing`}
            class="card"
            style="max-width:640px"
          >
            <Csrf token={c.var.csrf} />
            <label for="endpoint">Test-mode REST endpoint (UCP shopping service base URL)</label>
            <input
              id="endpoint"
              name="endpoint"
              type="url"
              value={store.testCheckoutEndpoint ?? ''}
              placeholder={`https://${store.domain}/ucp/v1`}
            />
            <p class="muted small">Must be https on {store.domain} or a subdomain.</p>
            <p>
              <label style="font-weight:400">
                <input type="checkbox" name="confirm" value="1" checked={!!store.testModeConfirmedAt} /> I
                confirm this endpoint is in test mode
              </label>
            </p>
            <button type="submit">Save</button>
          </form>
        </>
      )}
    </Page>,
  );
});

appRoutes.post('/stores/:id/checkout-testing', async (c) => {
  const f = await form(c);
  const store = await requireStoreAccess(c, c.req.param('id'));
  if (!store.verifiedAt)
    throw new HTTPException(403, { message: 'Verify ownership before enabling checkout testing.' });
  const endpoint = (f.endpoint ?? '').trim();
  if (endpoint && !checkoutEndpointAllowed(endpoint, store.domain))
    throw new HTTPException(400, {
      message: `The endpoint must be an https URL on ${store.domain} or one of its subdomains.`,
    });
  const confirmed = f.confirm === '1' && !!endpoint;
  await getDb(c.env.DB)
    .update(schema.stores)
    .set({ testCheckoutEndpoint: endpoint || null, testModeConfirmedAt: confirmed ? Date.now() : null })
    .where(eq(schema.stores.id, store.id));
  await audit(
    c.env.DB,
    'store.checkout_testing',
    { storeId: store.id, enabled: confirmed },
    { accountId: store.accountId, userId: requireUser(c).user.id },
  );
  return c.redirect(`/app/stores/${store.id}`, 303);
});

/* ------------------------------- alerts ------------------------------- */

appRoutes.get('/alerts', async (c) => {
  const { account } = requireUser(c);
  const plan = planOf(account);
  const db = getDb(c.env.DB);
  const channels = await db
    .select()
    .from(schema.alertChannels)
    .where(eq(schema.alertChannels.accountId, account.id));
  const recent = await db
    .select()
    .from(schema.alerts)
    .where(eq(schema.alerts.accountId, account.id))
    .orderBy(desc(schema.alerts.sentAt))
    .limit(20);
  return c.html(
    <Page c={c} title="Alerts">
      <h1>Alert channels</h1>
      <p class="muted">
        Alerts are sent only when a monitored store changes meaningfully: a new failure, a score drop of 5
        points or more, an outdated UCP version, or the profile being unreachable twice in a row. Without
        channels, alerts go to the account owner's email. Your plan allows:{' '}
        {plan.alertChannels.join(', ') || 'none'}.
      </p>
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Type</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {channels.map((ch) => (
              <tr>
                <td>{ch.label}</td>
                <td>{ch.type}</td>
                <td>{fmtTime(ch.createdAt)}</td>
                <td>
                  <form method="post" action={`/app/alerts/${ch.id}/delete`}>
                    <Csrf token={c.var.csrf} />
                    <button class="link" type="submit">
                      Remove
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.alertChannels.length ? (
        <form method="post" action="/app/alerts" class="card" style="max-width:640px">
          <Csrf token={c.var.csrf} />
          <h3 style="margin-top:0">Add a channel</h3>
          <label for="type">Type</label>
          <select id="type" name="type">
            {plan.alertChannels.map((t) => (
              <option value={t}>{t}</option>
            ))}
          </select>
          <label for="target" style="margin-top:10px">
            Email address or https URL (Slack: https://hooks.slack.com/…)
          </label>
          <input id="target" name="target" type="text" required maxlength={500} />
          <label for="label" style="margin-top:10px">
            Label
          </label>
          <input id="label" name="label" type="text" maxlength={60} />
          <p style="margin-top:12px">
            <button type="submit">Add channel</button>
          </p>
        </form>
      ) : null}
      <form method="post" action="/app/alerts/test">
        <Csrf token={c.var.csrf} />
        <button class="secondary" type="submit">
          Send test alert
        </button>
      </form>
      <h2>Recent alerts</h2>
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Sent</th>
              <th>Kind</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((a) => (
              <tr>
                <td>{fmtTime(a.sentAt)}</td>
                <td>{a.kind}</td>
                <td>
                  {a.status}
                  {a.error ? <div class="muted small">{a.error}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>,
  );
});

const channelSchema = z.object({
  type: z.enum(['email', 'webhook', 'slack']),
  target: z.string().trim().min(3).max(500),
  label: z.string().trim().max(60).optional(),
});

appRoutes.post('/alerts', async (c) => {
  const f = channelSchema.safeParse(await form(c));
  const { account, user } = requireUser(c);
  if (!f.success) throw new HTTPException(400, { message: 'Choose a type and enter a target.' });
  if (!planOf(account).alertChannels.includes(f.data.type))
    throw new HTTPException(403, { message: `Your plan does not include ${f.data.type} alerts.` });
  const problem = validateTarget(f.data.type, f.data.target);
  if (problem) throw new HTTPException(400, { message: problem });
  if (f.data.type !== 'email' && !checkUrl(f.data.target).ok)
    throw new HTTPException(400, { message: 'That URL is not allowed (public https hosts only).' });
  await getDb(c.env.DB)
    .insert(schema.alertChannels)
    .values({
      id: newId('ach_'),
      accountId: account.id,
      type: f.data.type,
      targetEncrypted: await encryptSecret(c.var.env.ENCRYPTION_KEY, f.data.target),
      label: f.data.label || f.data.type,
      createdAt: Date.now(),
    });
  await audit(
    c.env.DB,
    'alert_channel.create',
    { type: f.data.type },
    { accountId: account.id, userId: user.id },
  );
  return c.redirect('/app/alerts', 303);
});

appRoutes.post('/alerts/:id/delete', async (c) => {
  await form(c);
  const { account } = requireUser(c);
  await getDb(c.env.DB)
    .delete(schema.alertChannels)
    .where(
      and(eq(schema.alertChannels.id, c.req.param('id')), eq(schema.alertChannels.accountId, account.id)),
    );
  return c.redirect('/app/alerts', 303);
});

appRoutes.post('/alerts/test', async (c) => {
  await form(c);
  const { account } = requireUser(c);
  const r = await deliver(
    alertDeps(c),
    account.id,
    {
      storeId: '',
      storeName: 'Test store',
      domain: 'example.com',
      scanId: '',
      score: 87,
      reportUrl: `${c.var.env.APP_URL}/app`,
      events: [{ kind: 'score_drop', from: 92, to: 87 }],
    },
    'test',
  );
  return c.html(
    <Page c={c} title="Test alert">
      <h1>Test alert sent</h1>
      <p>
        {r.sent} delivered, {r.failed} failed. <a href="/app/alerts">Back to alerts</a>
      </p>
    </Page>,
  );
});

/* ------------------------------- billing ------------------------------- */

appRoutes.get('/billing', async (c) => {
  const { account } = requireUser(c);
  const plan = planOf(account);
  const provider = billingProvider(c.var.env);
  const db = getDb(c.env.DB);
  const [{ n }] = (await db
    .select({ n: count() })
    .from(schema.stores)
    .where(eq(schema.stores.accountId, account.id))) as [{ n: number }];
  return c.html(
    <Page c={c} title="Billing">
      <h1>Billing</h1>
      <div class="card">
        <p>
          Current plan: <b>{plan.name}</b> ({account.status})
          {account.currentPeriodEnd ? <> · renews or ends {fmtTime(account.currentPeriodEnd)}</> : null}
        </p>
        <p>
          Stores: {n} of {plan.maxStores} · products sampled per scan: {plan.productsSampled} · history:{' '}
          {plan.historyDays} days
        </p>
      </div>
      <div class="grid three">
        {PLAN_ORDER.filter((p): p is Exclude<PlanId, 'free'> => p !== 'free').map((id) => {
          const url = provider.checkoutUrl(id, account.id);
          return (
            <div class="card">
              <h3 style="margin-top:0">{PLANS[id].name}</h3>
              <p>${PLANS[id].priceMonthlyUsd}/month</p>
              {plan.id === id ? (
                <span class="chip s-pass">Current plan</span>
              ) : url ? (
                <a class="btn" href={url} rel="noopener">
                  Switch to {PLANS[id].name}
                </a>
              ) : (
                <p class="muted small">Contact us to switch plans; billing is handled manually for now.</p>
              )}
            </div>
          );
        })}
      </div>
    </Page>,
  );
});

/* ------------------------------- white-label print ------------------------------- */

appRoutes.get('/reports/:scanId/print', async (c) => {
  const { account } = requireUser(c);
  const plan = planOf(account);
  if (!plan.whiteLabel)
    throw new HTTPException(403, { message: 'Printable white-label reports are part of the Agency plan.' });
  const scan = await getDb(c.env.DB).query.scans.findFirst({
    where: eq(schema.scans.id, c.req.param('scanId')),
  });
  if (!scan?.storeId || scan.status !== 'done') throw new HTTPException(404, { message: 'Report not found' });
  await requireStoreAccess(c, scan.storeId);
  const results = await getResults(c.env.DB, scan.id);
  const brand = account.whiteLabelName || account.name;
  let logo: string | null = null;
  if (account.whiteLabelLogoUrl) {
    try {
      const u = new URL(account.whiteLabelLogoUrl);
      if (u.protocol === 'https:') logo = u.toString();
    } catch {
      logo = null;
    }
  }
  if (logo)
    c.header(
      'content-security-policy',
      `default-src 'self'; img-src 'self' data: ${new URL(logo).origin}; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    );
  const html = (
    <Layout title={`${scan.domain} — ${brand}`} bare noindex>
      <div class="row no-print" style="margin-bottom:12px">
        <p class="muted small">Use your browser's Print → Save as PDF to create a PDF.</p>
      </div>
      <header style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
        {logo ? <img src={logo} alt={brand} style="max-height:48px;max-width:200px" /> : null}
        <div>
          <h1 style="margin:0">Agent readiness report</h1>
          <p class="muted" style="margin:0">
            Prepared by {brand}
          </p>
        </div>
      </header>
      <ReportBody scan={scan} results={results} fixLinks={false} />
      {account.whiteLabelHideFooter ? null : <p class="muted small">Generated with CartProbe.</p>}
    </Layout>
  );
  return c.html(html);
});

/* ------------------------------- API keys ------------------------------- */

appRoutes.get('/api-keys', async (c) => {
  const { account } = requireUser(c);
  if (!planOf(account).apiAccess)
    throw new HTTPException(403, { message: 'API keys are part of the Vendor plan.' });
  const keys = await getDb(c.env.DB)
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.accountId, account.id))
    .orderBy(desc(schema.apiKeys.createdAt));
  return c.html(
    <Page c={c} title="API keys">
      <h1>API keys</h1>
      <p>
        See the <a href="/docs/api">API documentation</a>.
      </p>
      <div class="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr>
                <td>{k.label}</td>
                <td class="mono">cp_{k.prefix}_…</td>
                <td>{fmtTime(k.createdAt)}</td>
                <td>{fmtTime(k.lastUsedAt)}</td>
                <td>
                  {k.revokedAt ? (
                    'revoked'
                  ) : (
                    <form
                      method="post"
                      action={`/app/api-keys/${k.id}/revoke`}
                      data-confirm="Revoke this key? CI jobs using it will stop working."
                    >
                      <Csrf token={c.var.csrf} />
                      <button class="link" type="submit">
                        Revoke
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form method="post" action="/app/api-keys" class="card row" style="max-width:640px">
        <Csrf token={c.var.csrf} />
        <div>
          <label for="label">Label</label>
          <input id="label" name="label" type="text" required maxlength={60} placeholder="GitHub Actions" />
        </div>
        <button type="submit">Create key</button>
      </form>
    </Page>,
  );
});

appRoutes.post('/api-keys', async (c) => {
  const f = await form(c);
  const { account, user } = requireUser(c);
  if (!planOf(account).apiAccess)
    throw new HTTPException(403, { message: 'API keys are part of the Vendor plan.' });
  const label = (f.label ?? '').trim().slice(0, 60) || 'API key';
  const k = await createApiKey(c.env.DB, account.id, label);
  await audit(c.env.DB, 'api_key.create', { keyId: k.id }, { accountId: account.id, userId: user.id });
  return c.html(
    <Page c={c} title="API key created">
      <h1>API key created</h1>
      <Notice kind="warn">Copy it now. We store only a hash and cannot show it again.</Notice>
      <p>
        <code id="key" class="mono">
          {k.key}
        </code>{' '}
        <button class="secondary copy" type="button" data-copy="key">
          Copy
        </button>
      </p>
      <p>
        <a href="/app/api-keys">Done</a>
      </p>
    </Page>,
  );
});

appRoutes.post('/api-keys/:id/revoke', async (c) => {
  await form(c);
  const { account } = requireUser(c);
  await getDb(c.env.DB)
    .update(schema.apiKeys)
    .set({ revokedAt: Date.now() })
    .where(and(eq(schema.apiKeys.id, c.req.param('id')), eq(schema.apiKeys.accountId, account.id)));
  return c.redirect('/app/api-keys', 303);
});

/* ------------------------------- settings ------------------------------- */

appRoutes.get('/settings', async (c) => {
  const { account } = requireUser(c);
  const plan = planOf(account);
  const members = await getDb(c.env.DB)
    .select({ email: schema.users.email, role: schema.accountMembers.role })
    .from(schema.accountMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.accountMembers.userId))
    .where(eq(schema.accountMembers.accountId, account.id));
  return c.html(
    <Page c={c} title="Settings">
      <h1>Settings</h1>
      <form method="post" action="/app/settings" class="card" style="max-width:640px">
        <Csrf token={c.var.csrf} />
        <label for="name">Account name</label>
        <input id="name" name="name" type="text" required maxlength={80} value={account.name} />
        {plan.whiteLabel ? (
          <>
            <h3>White-label reports</h3>
            <label for="wl_name">Agency name shown on reports</label>
            <input
              id="wl_name"
              name="white_label_name"
              type="text"
              maxlength={80}
              value={account.whiteLabelName ?? ''}
            />
            <label for="wl_logo" style="margin-top:10px">
              Logo URL (https)
            </label>
            <input
              id="wl_logo"
              name="white_label_logo_url"
              type="url"
              maxlength={500}
              value={account.whiteLabelLogoUrl ?? ''}
            />
            <p>
              <label style="font-weight:400">
                <input
                  type="checkbox"
                  name="hide_footer"
                  value="1"
                  checked={!!account.whiteLabelHideFooter}
                />{' '}
                Hide the “Generated with CartProbe” footer
              </label>
            </p>
          </>
        ) : null}
        <p style="margin-top:12px">
          <button type="submit">Save</button>
        </p>
      </form>
      {plan.maxMembers > 1 ? (
        <div class="card" style="max-width:640px">
          <h3 style="margin-top:0">Members</h3>
          <ul>
            {members.map((m) => (
              <li>
                {m.email} <span class="muted small">({m.role})</span>
              </li>
            ))}
          </ul>
          <p class="muted small">Inviting team members is not yet implemented.</p>
        </div>
      ) : null}
    </Page>,
  );
});

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  white_label_name: z.string().trim().max(80).optional(),
  white_label_logo_url: z
    .union([
      z.literal(''),
      z
        .url()
        .max(500)
        .refine((u) => u.startsWith('https://'), 'logo URL must be https'),
    ])
    .optional(),
  hide_footer: z.string().optional(),
});

appRoutes.post('/settings', async (c) => {
  const f = settingsSchema.safeParse(await form(c));
  const { account, user } = requireUser(c);
  if (!f.success) throw new HTTPException(400, { message: f.error.issues.map((i) => i.message).join('; ') });
  const wl = planOf(account).whiteLabel;
  await getDb(c.env.DB)
    .update(schema.accounts)
    .set({
      name: f.data.name,
      ...(wl
        ? {
            whiteLabelName: f.data.white_label_name || null,
            whiteLabelLogoUrl: f.data.white_label_logo_url || null,
            whiteLabelHideFooter: f.data.hide_footer === '1' ? 1 : 0,
          }
        : {}),
    })
    .where(eq(schema.accounts.id, account.id));
  await audit(c.env.DB, 'account.settings', {}, { accountId: account.id, userId: user.id });
  return c.redirect('/app/settings', 303);
});
