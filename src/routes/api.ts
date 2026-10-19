import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { API_LIMITS } from '../config/plans';
import { getDb, schema } from '../db/client';
import { kickScan } from '../jobs/runner';
import { HOUR, hit } from '../lib/rateLimit';
import { checkUrl } from '../lib/safeFetch';
import { allowTestTld } from '../lib/transport';
import { normaliseStoreUrl } from '../scan/context';
import { planOf, type Account } from '../services/accounts';
import { verifyApiKey } from '../services/auth';
import { createScan, getResults } from '../services/scans';
import { parseCategories, type ScanRow } from '../views/report';
import { runnerDeps, type HonoEnv } from './helpers';

type ApiEnv = HonoEnv & { Variables: HonoEnv['Variables'] & { apiAccount: Account } };
export const apiRoutes = new Hono<ApiEnv>();

apiRoutes.use('*', async (c, next) => {
  const key = await verifyApiKey(c.env.DB, c.req.header('authorization'));
  if (!key) throw new HTTPException(401, { message: 'Missing or invalid API key.' });
  const account = await getDb(c.env.DB).query.accounts.findFirst({
    where: eq(schema.accounts.id, key.accountId),
  });
  if (!account || !planOf(account).apiAccess)
    throw new HTTPException(403, { message: 'API access requires an active Vendor plan.' });
  c.set('apiAccount', account);
  await next();
});

export async function scanJson(d1: D1Database, scan: ScanRow, appUrl: string) {
  const { categories, cappedBy } = parseCategories(scan);
  const done = scan.status === 'done';
  const results = done ? await getResults(d1, scan.id) : [];
  return {
    scanId: scan.id,
    status: scan.status,
    phase: scan.phase,
    url: scan.url,
    domain: scan.domain,
    score: scan.score,
    grade: scan.grade,
    cappedBy,
    specVersionSeen: scan.specVersionSeen,
    productsSampled: scan.productsSampled,
    requestsMade: scan.requestsMade,
    createdAt: new Date(scan.createdAt).toISOString(),
    finishedAt: scan.finishedAt ? new Date(scan.finishedAt).toISOString() : null,
    reportUrl: `${appUrl}/r/${scan.publicSlug}`,
    ...(done
      ? {
          categories: categories.map((x) => ({ category: x.category, score: x.score, counts: x.counts })),
          checks: results.map((r) => ({
            id: r.checkId,
            title: r.title,
            category: r.category,
            severity: r.severity,
            status: r.status,
            summary: r.summary,
            evidence: r.evidence,
            fixGuideUrl: `${appUrl}/fix/${r.fixGuide}`,
          })),
        }
      : {}),
  };
}

const createBody = z.object({
  url: z.string().trim().min(3).max(2048),
  sampleSize: z.number().int().min(1).max(API_LIMITS.maxSampleSize).optional(),
  waitSeconds: z.number().int().min(0).max(API_LIMITS.maxWaitSeconds).optional(),
});

apiRoutes.post('/scans', async (c) => {
  const account = c.var.apiAccount;
  const body = createBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success)
    throw new HTTPException(400, {
      message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    });
  const norm = normaliseStoreUrl(body.data.url);
  const ok = norm
    ? checkUrl(norm.origin, { allowTestTld: allowTestTld(c.var.env) })
    : { ok: false as const, reason: 'invalid URL' };
  if (!norm || !ok.ok) throw new HTTPException(400, { message: `url: ${ok.ok ? 'invalid' : ok.reason}` });
  const rl = await hit(c.env.DB, `api:scan:${account.id}`, API_LIMITS.scansPerHourPerAccount, HOUR);
  if (!rl.allowed)
    throw new HTTPException(429, {
      message: `Limit of ${API_LIMITS.scansPerHourPerAccount} API scans per hour reached.`,
    });
  const plan = planOf(account);
  const store = await getDb(c.env.DB).query.stores.findFirst({
    where: and(eq(schema.stores.accountId, account.id), eq(schema.stores.domain, norm.domain)),
  });
  const scan = await createScan(c.env.DB, {
    url: norm.origin,
    domain: norm.domain,
    trigger: 'api',
    accountId: account.id,
    storeId: store?.id ?? null,
    productsSampled: Math.min(body.data.sampleSize ?? plan.productsSampled, plan.productsSampled),
    verifiedOwnership: !!store?.verifiedAt,
    testCheckoutEndpoint: store?.testCheckoutEndpoint ?? null,
    testModeConfirmed: !!store?.testModeConfirmedAt,
  });
  const deps = runnerDeps(c.env, c.var.env, c.var.fetchImpl, c.var.sleep);
  const wait = (body.data.waitSeconds ?? 0) * 1000;
  if (wait > 0) await kickScan(deps, scan.id, wait);
  else c.executionCtx.waitUntil(kickScan(deps, scan.id, 25_000));
  const fresh = (await getDb(c.env.DB).query.scans.findFirst({ where: eq(schema.scans.id, scan.id) }))!;
  if (fresh.status !== 'done') c.executionCtx.waitUntil(kickScan(deps, scan.id, 25_000));
  return c.json(await scanJson(c.env.DB, fresh, c.var.env.APP_URL), fresh.status === 'done' ? 200 : 202);
});

apiRoutes.get('/scans/:id', async (c) => {
  const scan = await getDb(c.env.DB).query.scans.findFirst({
    where: and(eq(schema.scans.id, c.req.param('id')), eq(schema.scans.accountId, c.var.apiAccount.id)),
  });
  if (!scan) throw new HTTPException(404, { message: 'Scan not found' });
  return c.json(await scanJson(c.env.DB, scan, c.var.env.APP_URL));
});
