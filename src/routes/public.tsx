import { and, desc, eq, gt, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { raw } from 'hono/html';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { CHECKS } from '../checks/registry';
import { ANON_LIMITS, annualPriceUsd, PLAN_ORDER, PLANS } from '../config/plans';
import { CATEGORY_LABELS, CATEGORY_WEIGHTS, GRADE_BANDS, SEVERITY_WEIGHTS } from '../config/weights';
import { FIX_GUIDES } from '../content/fixGuides.generated';
import { getDb, schema } from '../db/client';
import { kickScan } from '../jobs/runner';
import { DAY, HOUR, hit } from '../lib/rateLimit';
import { checkUrl } from '../lib/safeFetch';
import { allowTestTld } from '../lib/transport';
import { normaliseStoreUrl } from '../scan/context';
import { phaseLabel } from '../scan/engine';
import { CATEGORIES } from '../scan/types';
import { isMember, planOf } from '../services/accounts';
import { createScan, getResults, getScanBySlug } from '../services/scans';
import { LATEST_VERSION } from '../ucp/versions';
import { Layout, Notice } from '../views/layout';
import { ReportBody } from '../views/report';
import { clientIpHash, runnerDeps, type Ctx, type HonoEnv } from './helpers';

export const publicRoutes = new Hono<HonoEnv>();

const scanForm = z.object({
  url: z.string().trim().min(3).max(2048),
  website: z.string().max(200).optional(),
});

function ScanForm(p: { value?: string }) {
  return (
    <form method="post" action="/scan" class="scanform">
      <label for="url" class="hp">
        Store URL
      </label>
      <input
        id="url"
        type="text"
        name="url"
        placeholder="yourstore.com"
        required
        value={p.value ?? ''}
        autocomplete="url"
        inputmode="url"
        aria-label="Store URL"
      />
      <div class="hp" aria-hidden="true">
        <label for="website">Leave this empty</label>
        <input id="website" type="text" name="website" tabindex={-1} autocomplete="off" />
      </div>
      <button type="submit">Scan my store</button>
    </form>
  );
}

publicRoutes.get('/', (c) => {
  const err = c.req.query('error');
  return c.html(
    <Layout
      title="CartProbe"
      description="See your store the way AI shopping agents see it. Free UCP readiness scan."
      user={c.var.user}
      csrf={c.var.csrf}
    >
      <section class="hero">
        <h1>See your store the way AI shopping agents see it</h1>
        <p class="muted lead">
          CartProbe checks your Universal Commerce Protocol (UCP) profile, catalog API and product data the
          way an AI shopping agent would, and tells you exactly what to fix. Free, in about a minute.
        </p>
        {err ? <Notice kind="error">{err}</Notice> : null}
        <ScanForm value={c.req.query('url')} />
        <p class="muted small mt8">
          Read-only: we never place orders or submit payments. We honour robots.txt.{' '}
          <a href="/bot">What we fetch</a>.
        </p>
      </section>
      <h2>What we check</h2>
      <div class="grid three">
        {CATEGORIES.map((cat) => (
          <div class="card">
            <h3 class="mt0">{CATEGORY_LABELS[cat]}</h3>
            <p class="muted small">
              {CHECKS.filter((x) => x.category === cat)
                .map((x) => x.title)
                .join(' · ')}
            </p>
          </div>
        ))}
      </div>
      <h2>Monitoring for stores and agencies</h2>
      <div class="grid three">
        {PLAN_ORDER.filter((p) => p !== 'free').map((id) => (
          <div class="card">
            <h3 class="mt0">{PLANS[id].name}</h3>
            <p>
              <b>${PLANS[id].priceMonthlyUsd}</b>/month · {PLANS[id].maxStores} store
              {PLANS[id].maxStores === 1 ? '' : 's'}
            </p>
          </div>
        ))}
      </div>
      <p>
        <a href="/pricing">Compare plans</a>
      </p>
    </Layout>,
  );
});

publicRoutes.post('/scan', async (c) => {
  const env = c.var.env;
  const form = scanForm.safeParse(await c.req.parseBody());
  if (!form.success)
    return c.redirect(
      `/?error=${encodeURIComponent('Enter your store address, for example yourstore.com')}`,
      303,
    );
  // Honeypot: bots fill hidden fields. Pretend all is well without scanning.
  if (form.data.website) return c.redirect('/', 303);
  const norm = normaliseStoreUrl(form.data.url);
  const check = norm
    ? checkUrl(norm.origin, { allowTestTld: allowTestTld(env) })
    : { ok: false as const, reason: 'not a valid address' };
  if (!norm || !check.ok) {
    return c.redirect(
      `/?error=${encodeURIComponent(`We can't scan that address (${check.ok ? 'invalid' : check.reason}). Use your public store domain.`)}&url=${encodeURIComponent(form.data.url.slice(0, 200))}`,
      303,
    );
  }
  const db = getDb(c.env.DB);
  const now = Date.now();
  const fresh = await db.query.scans.findFirst({
    where: and(
      eq(schema.scans.domain, norm.domain),
      eq(schema.scans.trigger, 'anonymous'),
      gt(schema.scans.createdAt, now - ANON_LIMITS.reuseFreshScanMs),
      ne(schema.scans.status, 'failed'),
    ),
    orderBy: desc(schema.scans.createdAt),
  });
  if (fresh) return c.redirect(`/r/${fresh.publicSlug}`, 303);

  const ip = await clientIpHash(c);
  const perIp = await hit(c.env.DB, `scan:ip:${ip}`, ANON_LIMITS.scansPerHourPerIp, HOUR, now);
  if (!perIp.allowed)
    throw new HTTPException(429, {
      message: `You have reached ${ANON_LIMITS.scansPerHourPerIp} free scans this hour. Please try again later.`,
    });
  const perDomain = await hit(
    c.env.DB,
    `scan:domain:${norm.domain}`,
    ANON_LIMITS.scansPerDayPerDomain,
    DAY,
    now,
  );
  if (!perDomain.allowed)
    throw new HTTPException(429, {
      message: `This store has been scanned ${ANON_LIMITS.scansPerDayPerDomain} times today. Please try again tomorrow, or monitor it from a paid plan.`,
    });

  const scan = await createScan(c.env.DB, {
    url: norm.origin,
    domain: norm.domain,
    trigger: 'anonymous',
    productsSampled: PLANS.free.productsSampled,
    requesterIpHash: ip,
  });
  c.executionCtx.waitUntil(kickScan(runnerDeps(c.env, env, c.var.fetchImpl, c.var.sleep), scan.id, 25_000));
  return c.redirect(`/r/${scan.publicSlug}`, 303);
});

/** Scans owned by an account are private unless made public; anonymous scans are link-shareable. */
async function viewableScan(c: Ctx, slug: string) {
  if (!/^[A-Za-z0-9]{6,20}$/.test(slug)) return null;
  const scan = await getScanBySlug(c.env.DB, slug);
  if (!scan) return null;
  if (scan.accountId && !scan.isPublic) {
    const user = c.var.user;
    if (!user || !(await isMember(c.env.DB, scan.accountId, user.id))) return null;
  }
  return scan;
}

const PHASE_ORDER = [
  'discovery',
  'catalog',
  'products',
  'consistency',
  'basics',
  'checkout',
  'finalize',
  'done',
];
function progressOf(phase: string, state?: { sampled?: string[] }): number {
  const base = phase.startsWith('products:') ? 'products' : phase;
  const i = Math.max(0, PHASE_ORDER.indexOf(base));
  let pct = (i / (PHASE_ORDER.length - 1)) * 100;
  if (base === 'products' && state?.sampled?.length) {
    const offset = Number(phase.split(':')[1] ?? 0);
    pct += (Math.min(1, offset / state.sampled.length) * 100) / (PHASE_ORDER.length - 1);
  }
  return Math.round(pct);
}

publicRoutes.get('/r/:slug/status', async (c) => {
  const scan = await viewableScan(c, c.req.param('slug'));
  if (!scan) return c.json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  let progress = scan.status === 'done' ? 100 : progressOf(scan.phase);
  if (scan.status !== 'done' && scan.status !== 'failed') {
    const job = await getDb(c.env.DB).query.scanJobs.findFirst({
      where: eq(schema.scanJobs.scanId, scan.id),
    });
    if (job) {
      try {
        progress = progressOf(job.phase, JSON.parse(job.stateJson) as { sampled?: string[] });
      } catch {
        /* keep approximate progress */
      }
      // Polling keeps an anonymous scan moving without waiting for cron. The lease prevents double work.
      if (!job.lockedUntil || job.lockedUntil < Date.now())
        c.executionCtx.waitUntil(
          kickScan(runnerDeps(c.env, c.var.env, c.var.fetchImpl, c.var.sleep), scan.id, 25_000),
        );
    }
  }
  return c.json(
    {
      status: scan.status,
      phase: scan.phase,
      phaseLabel: phaseLabel(scan.phase),
      progress,
      score: scan.score,
      grade: scan.grade,
    },
    200,
    { 'cache-control': 'no-store' },
  );
});

publicRoutes.get('/r/:slug', async (c) => {
  const scan = await viewableScan(c, c.req.param('slug'));
  if (!scan) throw new HTTPException(404, { message: 'This report does not exist or is private.' });
  const noindex = !scan.isPublic;
  if (scan.status !== 'done') {
    return c.html(
      <Layout title={`Scanning ${scan.domain}`} user={c.var.user} csrf={c.var.csrf} noindex>
        <h1>Scanning {scan.domain}</h1>
        <div class="card" data-poll={`/r/${scan.publicSlug}/status`}>
          <p>
            <span data-phase>{phaseLabel(scan.phase)}</span>…
          </p>
          <progress class="progress" max={100} value={progressOf(scan.phase)} aria-label="Scan progress" />
          <p class="muted small">
            We fetch at most one page per second from your store, so sampling product pages takes a little
            while. This page refreshes itself.
          </p>
          <noscript>
            <p>
              <a href={`/r/${scan.publicSlug}`}>Refresh</a> to see progress.
            </p>
          </noscript>
        </div>
      </Layout>,
    );
  }
  const results = await getResults(c.env.DB, scan.id);
  return c.html(
    <Layout title={`${scan.domain} readiness report`} user={c.var.user} csrf={c.var.csrf} noindex={noindex}>
      <h1>Agent readiness report</h1>
      <ReportBody scan={scan} results={results} />
      {scan.trigger === 'anonymous' ? (
        <div class="card">
          <h2 class="mt0">Monitor this store</h2>
          <p>
            Things break silently after plugin updates, theme changes and spec releases. CartProbe re-scans
            daily and alerts you only when something meaningful changes.
          </p>
          <p>
            <a class="btn" href={`/login?next=${encodeURIComponent(`/app/stores/new?url=${scan.url}`)}`}>
              Start monitoring
            </a>{' '}
            <a class="btn secondary" href="/pricing">
              See plans
            </a>
          </p>
        </div>
      ) : null}
    </Layout>,
  );
});

publicRoutes.get('/fix/:slug', (c) => {
  const g = FIX_GUIDES[c.req.param('slug')];
  if (!g) throw new HTTPException(404, { message: 'No such fix guide.' });
  return c.html(
    <Layout title={g.title} user={c.var.user} csrf={c.var.csrf}>
      <article class="prose">
        <p class="small">
          <a href="/docs">All checks</a>
        </p>
        <h1>{g.title}</h1>
        {/* Trusted, build-time compiled content from content/fix/*.md — never scanned data. */}
        {raw(g.html)}
      </article>
    </Layout>,
  );
});

publicRoutes.get('/pricing', (c) =>
  c.html(
    <Layout
      title="Pricing"
      user={c.var.user}
      csrf={c.var.csrf}
      description="CartProbe plans for stores, agencies and platform vendors."
    >
      <h1>Pricing</h1>
      <p class="muted">
        Prices in USD. Annual billing is 10× the monthly price (two months free). Taxes are handled by our
        payment provider.
      </p>
      <div class="grid two">
        {PLAN_ORDER.map((id) => {
          const p = PLANS[id];
          return (
            <div class="card plan">
              <h2 class="mt0">{p.name}</h2>
              <p>
                <span class="price">${p.priceMonthlyUsd}</span>
                {p.priceMonthlyUsd ? <span class="muted">/month · ${annualPriceUsd(p)}/year</span> : null}
              </p>
              <ul>
                {id === 'free' ? (
                  <li>Anonymous on-demand scans with a shareable report link</li>
                ) : (
                  <li>
                    {p.maxStores} monitored store{p.maxStores === 1 ? '' : 's'}, scanned daily
                  </li>
                )}
                <li>Up to {p.productsSampled} product pages sampled per scan</li>
                {id === 'free' ? (
                  <li>Rate-limited ({ANON_LIMITS.scansPerHourPerIp} scans/hour)</li>
                ) : (
                  <li>{p.historyDays}-day score history</li>
                )}
                {p.alertChannels.length ? <li>Alerts by {p.alertChannels.join(', ')}</li> : null}
                {p.whiteLabel ? <li>White-label printable reports</li> : null}
                {p.apiAccess ? <li>API keys, CI scan endpoint and status badges</li> : null}
              </ul>
              {id === 'free' ? (
                <a class="btn secondary" href="/">
                  Run a free scan
                </a>
              ) : (
                <a class="btn" href="/app/billing">
                  Choose {p.name}
                </a>
              )}
            </div>
          );
        })}
      </div>
    </Layout>,
  ),
);

publicRoutes.get('/docs', (c) =>
  c.html(
    <Layout title="How scoring works" user={c.var.user} csrf={c.var.csrf}>
      <article class="prose wnone">
        <h1>How CartProbe scores your store</h1>
        <p>
          Every check returns pass, warning, fail, skip or error. Inside a category each applicable check is
          worth points by severity (
          {Object.entries(SEVERITY_WEIGHTS)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ')}
          ). A pass earns full points, a warning half, a fail or error none; skipped checks do not count.
        </p>
        <p>
          The overall score is the weighted average of the categories that apply to your store (
          {CATEGORIES.map((k) => `${CATEGORY_LABELS[k]} ${CATEGORY_WEIGHTS[k]}`).join(', ')}
          ), re-normalised when a category does not apply (for example a store that does not offer catalog
          search). Checkout counts only for stores whose owner verified ownership and set up a test-mode
          endpoint. If your UCP profile cannot be fetched or parsed, the score is capped at 39, because agents
          cannot use the store at all. If any other critical check fails, the score is capped at 89, so a
          store with a critical problem is never graded Agent-ready.
        </p>
        <p>Grades: {GRADE_BANDS.map((b) => `${b.min}+ ${b.grade}`).join(' · ')}.</p>
        <p>
          Checks follow the UCP specification, currently version <b>{LATEST_VERSION}</b>. Where the spec is
          ambiguous we report a warning, not a failure. Scores are estimates from automated checks and do not
          predict how any particular agent will treat your store.
        </p>
        <p>
          <a href="/docs/api">API documentation</a>
        </p>
        <h2>All checks</h2>
        {CATEGORIES.map((cat) => (
          <>
            <h3>{CATEGORY_LABELS[cat]}</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Severity</th>
                    <th>Why it matters</th>
                  </tr>
                </thead>
                <tbody>
                  {CHECKS.filter((x) => x.category === cat).map((x) => (
                    <tr>
                      <td>
                        <a href={`/fix/${x.id}`}>{x.title}</a>
                        <div class="mono muted">{x.id}</div>
                      </td>
                      <td>{x.severity}</td>
                      <td>{x.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ))}
      </article>
    </Layout>,
  ),
);

publicRoutes.get('/docs/api', (c) => {
  const base = c.var.env.APP_URL;
  const curlCreate = `curl -s -X POST ${base}/api/v1/scans \\\n  -H "Authorization: Bearer $CARTPROBE_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"url":"https://staging.yourstore.com","waitSeconds":25}'`;
  const curlGet = `curl -s ${base}/api/v1/scans/<scanId> -H "Authorization: Bearer $CARTPROBE_API_KEY"`;
  const gha = `- name: CartProbe readiness gate
  env:
    CARTPROBE_API_KEY: \${{ secrets.CARTPROBE_API_KEY }}
    STORE_URL: https://staging.yourstore.com
    MIN_SCORE: "80"
  run: |
    id=$(curl -sf -X POST ${base}/api/v1/scans -H "Authorization: Bearer $CARTPROBE_API_KEY" \\
      -H "Content-Type: application/json" -d "{\\"url\\":\\"$STORE_URL\\",\\"waitSeconds\\":25}" | jq -r .scanId)
    for i in $(seq 1 30); do
      res=$(curl -sf ${base}/api/v1/scans/$id -H "Authorization: Bearer $CARTPROBE_API_KEY")
      [ "$(echo "$res" | jq -r .status)" = "done" ] && break
      sleep 10
    done
    score=$(echo "$res" | jq -r .score)
    echo "CartProbe score: $score"; echo "$res" | jq -r '.checks[] | select(.status=="fail") | "FAIL \\(.id): \\(.summary)"'
    [ "$score" -ge "$MIN_SCORE" ]`;
  return c.html(
    <Layout title="API" user={c.var.user} csrf={c.var.csrf}>
      <article class="prose">
        <h1>CartProbe API (Vendor plan)</h1>
        <p>
          Authenticate with an API key from <a href="/app/api-keys">API keys</a>:{' '}
          <code>Authorization: Bearer cp_…</code>. Keys are shown once; we store only a hash.
        </p>
        <h2>Start a scan</h2>
        <p>
          <code>POST /api/v1/scans</code> with{' '}
          <code>{'{ "url": string, "sampleSize"?: 1–200, "waitSeconds"?: 0–25 }'}</code>. Returns{' '}
          <code>{'{ scanId, status, reportUrl }'}</code>, plus the full result if the scan completed within{' '}
          <code>waitSeconds</code>. Rate limit: 60 scans per hour per account.
        </p>
        <pre>
          <code>{curlCreate}</code>
        </pre>
        <h2>Get a result</h2>
        <p>
          <code>GET /api/v1/scans/:id</code> returns status, score, grade, category scores and every check
          with evidence.
        </p>
        <pre>
          <code>{curlGet}</code>
        </pre>
        <h2>GitHub Actions example</h2>
        <p>Fails the job when the readiness score is below a threshold:</p>
        <pre>
          <code>{gha}</code>
        </pre>
        <h2>Badges</h2>
        <p>
          Enable the badge on a store page, then embed <code>{`${base}/badge/<storeId>.svg`}</code>.
        </p>
        <h2>Errors</h2>
        <p>
          Errors are JSON: <code>{'{ "error": { "code": "...", "message": "..." } }'}</code> with codes{' '}
          <code>unauthorized</code>, <code>forbidden</code>, <code>bad_request</code>, <code>not_found</code>,{' '}
          <code>rate_limited</code>.
        </p>
      </article>
    </Layout>,
  );
});

publicRoutes.get('/bot', (c) => {
  const ua = `CartProbeBot/1.0 (+https://${c.var.env.APP_DOMAIN}/bot)`;
  return c.html(
    <Layout title="CartProbeBot" user={c.var.user} csrf={c.var.csrf}>
      <article class="prose">
        <h1>About CartProbeBot</h1>
        <p>
          CartProbeBot fetches public pages of online stores when someone requests a readiness scan, or once a
          day for stores whose owners subscribed to monitoring. It identifies itself as:
        </p>
        <pre>
          <code>{ua}</code>
        </pre>
        <h2>What we fetch</h2>
        <ul>
          <li>
            <code>/.well-known/ucp</code> (your UCP profile) and the endpoints it declares (a plain GET)
          </li>
          <li>One catalog search with a common word (read-only)</li>
          <li>
            <code>/robots.txt</code>, sitemaps, your homepage and a sample of product pages (at most{' '}
            {PLANS.free.productsSampled} for free scans, {PLANS.store.productsSampled} for paid)
          </li>
          <li>
            A single request to <code>http://</code> to check that it redirects to https
          </li>
        </ul>
        <h2>What we never do</h2>
        <ul>
          <li>We never place orders, submit payments or create accounts.</li>
          <li>
            We only create (and immediately cancel) a test checkout session when the store owner verified
            ownership and confirmed a test-mode endpoint.
          </li>
          <li>
            We do not store personal data from your site. Raw responses are deleted after 7 days; anonymous
            scans after 30 days.
          </li>
        </ul>
        <h2>Politeness</h2>
        <p>
          At most one request per second to your domain, hard caps per scan, and we honour robots.txt for
          product pages using the user-agent token CartProbeBot.
        </p>
        <h2>How to block us</h2>
        <pre>
          <code>{'User-agent: CartProbeBot\nDisallow: /'}</code>
        </pre>
        <p>
          Note: the UCP profile itself is meant for agents; blocking it in robots.txt does not stop us reading
          it, but blocking product paths does stop product sampling. To opt out entirely, contact us and we
          will block your domain.
        </p>
      </article>
    </Layout>,
  );
});

function Legal(p: { title: string; children?: unknown }) {
  return (
    <article class="prose">
      <h1>{p.title}</h1>
      <div class="notice warn">Placeholder text. Have a lawyer review before launch.</div>
      {p.children as never}
    </article>
  );
}

publicRoutes.get('/terms', (c) =>
  c.html(
    <Layout title="Terms" user={c.var.user} csrf={c.var.csrf}>
      <Legal title="Terms of service">
        <p>
          CartProbe is operated by Aayush Kumar, an independent developer in Bengaluru, India. By using
          CartProbe you agree to these terms.
        </p>
        <p>
          Scores and findings are automated estimates based on public responses at the time of the scan. They
          are not an endorsement by any standards body or AI company and do not promise how any agent will
          treat your store.
        </p>
        <p>
          Only scan stores you own or have permission to test. Paid plans renew until cancelled; you can
          cancel at any time and keep access until the end of the paid period.
        </p>
        <p>The service is provided as is, without warranties, to the extent permitted by law.</p>
      </Legal>
    </Layout>,
  ),
);
publicRoutes.get('/privacy', (c) =>
  c.html(
    <Layout title="Privacy" user={c.var.user} csrf={c.var.csrf}>
      <Legal title="Privacy policy">
        <p>
          We store your email address to sign you in and send alerts you configure. We store IP addresses only
          as daily-rotating keyed hashes for rate limiting.
        </p>
        <p>
          We do not store personal data from scanned sites. Raw captures are deleted after 7 days, anonymous
          scans after 30 days. Alert webhook and Slack URLs are encrypted at rest.
        </p>
        <p>
          Payments are processed by our merchant-of-record provider; we never see card details. Email is
          delivered through a transactional email provider.
        </p>
      </Legal>
    </Layout>,
  ),
);
publicRoutes.get('/aup', (c) =>
  c.html(
    <Layout title="Acceptable use" user={c.var.user} csrf={c.var.csrf}>
      <Legal title="Acceptable use policy">
        <p>
          Do not use CartProbe to scan sites you are not authorised to test, to generate load against a site,
          to probe internal networks, or to circumvent rate limits.
        </p>
        <p>
          We may block domains, accounts or IP ranges that abuse the service. Report abuse to the contact
          address on this site.
        </p>
      </Legal>
    </Layout>,
  ),
);

/** CartProbe's own minimal platform profile, referenced by the UCP-Agent header on our requests. */
publicRoutes.get('/.well-known/ucp', (c) =>
  c.json({ ucp: { version: LATEST_VERSION, services: {}, capabilities: {}, payment_handlers: {} } }, 200, {
    'cache-control': 'public, max-age=3600',
  }),
);

publicRoutes.get('/badge/:file', async (c) => {
  const m = /^([A-Za-z0-9_]+)\.svg$/.exec(c.req.param('file'));
  if (!m) throw new HTTPException(404, { message: 'Not found' });
  const db = getDb(c.env.DB);
  const store = await db.query.stores.findFirst({ where: eq(schema.stores.id, m[1]!) });
  const account = store
    ? await db.query.accounts.findFirst({ where: eq(schema.accounts.id, store.accountId) })
    : null;
  if (!store || !account || !store.badgeEnabled || !planOf(account).badges)
    throw new HTTPException(404, { message: 'Not found' });
  const scan = store.lastScanId
    ? await db.query.scans.findFirst({ where: eq(schema.scans.id, store.lastScanId) })
    : null;
  const label = 'agent readiness';
  const value = scan?.grade ? `${scan.grade} · ${scan.score}` : 'not scanned';
  const color =
    (scan?.score ?? 0) >= 90
      ? '#1d7a46'
      : (scan?.score ?? 0) >= 70
        ? '#2f5bea'
        : (scan?.score ?? 0) >= 40
          ? '#8a5a00'
          : '#b3261e';
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const lw = label.length * 6.5 + 12;
  const vw = value.length * 6.5 + 12;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="6" y="14">${esc(label)}</text><text x="${lw + 6}" y="14">${esc(value)}</text></g></svg>`;
  return c.body(svg, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' });
});
