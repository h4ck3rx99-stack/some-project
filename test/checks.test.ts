import { beforeEach, describe, expect, it } from 'vitest';
import { runScan } from './helpers';
import { fixture } from './fixtures';
import { mockStore, resetMockStore } from './mock-store/app';
import type { FetchLike } from '../src/lib/safeFetch';

beforeEach(() => resetMockStore());

const HOST = 'good.mockstore.test';
type Route = (req: Request) => Response | Promise<Response>;

/** Mock store with specific paths overridden. */
function withRoutes(routes: Record<string, Route>): FetchLike {
  return async (req) => {
    const u = new URL(req.url);
    const r = routes[`${req.method} ${u.pathname}`] ?? routes[u.pathname];
    return r ? r(req) : (mockStore.fetch(req) as Promise<Response>);
  };
}

const json = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300',
      etag: '"1"',
      ...headers,
    },
  });
const profile = (name: string, headers?: Record<string, string>) => () =>
  json(fixture(`ucp/2026-08-25/${name}`, HOST), headers);
const catalog = (name: string) => () => json(fixture(`ucp/2026-08-25/${name}`, HOST));
const scan = (routes: Record<string, Route>, over = {}) => runScan(HOST, over, withRoutes(routes));

describe('discovery checks', () => {
  it('schema-invalid profile fails with Ajv error paths', async () => {
    const r = await scan({ '/.well-known/ucp': profile('profile.schema-invalid.json') });
    const c = r.results['discovery.profile_schema_valid']!;
    expect(c.status).toBe('fail');
    const found = c.evidence.map((e) => e.found).join('\n');
    expect(found).toContain("/ucp must have required property 'payment_handlers'");
    expect(found).toContain('/ucp/services/dev.ucp.shopping/0/transport');
    expect(c.evidence.length).toBeLessThanOrEqual(20);
  });

  it('bad namespace hosts fail (CDN host and userinfo trick)', async () => {
    const r = await scan({ '/.well-known/ucp': profile('profile.bad-namespace-host.json') });
    const c = r.results['discovery.namespace_host_rule']!;
    expect(c.status).toBe('fail');
    expect(c.evidence.map((e) => e.label)).toEqual(['dev.ucp.shopping.checkout', 'dev.ucp.shopping.order']);
    expect(c.evidence[0]!.found).toContain('com.shopplugin-assets.cdn');
    expect(c.evidence[1]!.found).toContain('userinfo');
  });

  it('profile with no capabilities fails and skips dependants', async () => {
    const r = await scan({ '/.well-known/ucp': profile('profile.no-capabilities.json') });
    expect(r.status('discovery.capabilities_declared')).toBe('fail');
    expect(r.status('discovery.namespace_host_rule')).toBe('skip');
    expect(r.status('catalog.search_responds')).toBe('skip');
    expect(r.results['catalog.search_responds']!.meta?.notOffered).toBe(true);
  });

  it('ancient version fails; previous warns', async () => {
    const a = await scan({ '/.well-known/ucp': profile('profile.ancient-version.json') });
    expect(a.status('discovery.version_current')).toBe('fail');
    expect(a.results['discovery.version_current']!.summary).toContain('2026-01-11');
    // Ancient profile does not declare catalog search: catalog category is "not offered".
    expect(a.score.categories.find((c) => c.category === 'catalog')!.score).toBeNull();
    const p = await scan({ '/.well-known/ucp': profile('profile.previous-version.json') });
    expect(p.status('discovery.version_current')).toBe('warn');
  });

  it('JSON served as text/plain warns on content type', async () => {
    const r = await scan({
      '/.well-known/ucp': profile('profile.valid.json', { 'content-type': 'text/plain' }),
    });
    expect(r.status('discovery.profile_content_type')).toBe('warn');
    expect(r.status('discovery.profile_parses')).toBe('pass');
  });

  it('cache headers: missing → fail, no validator → warn', async () => {
    const miss = await scan({
      '/.well-known/ucp': profile('profile.valid.json', { 'cache-control': 'no-store' }),
    });
    expect(miss.status('discovery.profile_cache_headers')).toBe('fail');
    const noEtag = await scan({
      '/.well-known/ucp': () =>
        new Response(fixture('ucp/2026-08-25/profile.valid.json', HOST), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
        }),
    });
    expect(noEtag.status('discovery.profile_cache_headers')).toBe('warn');
  });

  it('unknown version string fails, a newer-than-known date warns', async () => {
    const body = (v: string) => () =>
      json(
        fixture('ucp/2026-08-25/profile.valid.json', HOST).replace(
          '"version": "2026-08-25",\n    "services"',
          `"version": "${v}",\n    "services"`,
        ),
      );
    expect((await scan({ '/.well-known/ucp': body('draft') })).status('discovery.version_current')).toBe(
      'fail',
    );
    expect((await scan({ '/.well-known/ucp': body('2027-03-01') })).status('discovery.version_current')).toBe(
      'warn',
    );
  });

  it('dead endpoint fails endpoints_reachable', async () => {
    const r = await scan({ 'GET /ucp/mcp': () => new Response('down', { status: 503 }) });
    expect(r.status('discovery.endpoints_reachable')).toBe('fail');
  });
});

describe('catalog checks', () => {
  it('empty search warns', async () => {
    const r = await scan({ 'POST /ucp/v1/catalog/search': catalog('catalog.search.empty.json') });
    expect(r.status('catalog.has_results')).toBe('warn');
    expect(r.status('catalog.product_fields')).toBe('skip');
  });

  it('float amounts fail amounts_integer and schema validation', async () => {
    const r = await scan({ 'POST /ucp/v1/catalog/search': catalog('catalog.search.float-amounts.json') });
    expect(r.status('catalog.amounts_integer')).toBe('fail');
    expect(r.results['catalog.amounts_integer']!.evidence.map((e) => e.label)).toContain(
      '$.products[0].variants[0].price.amount',
    );
    expect(r.status('catalog.search_schema_valid')).toBe('fail');
  });

  it('missing fields fail product_fields', async () => {
    const r = await scan({ 'POST /ucp/v1/catalog/search': catalog('catalog.search.missing-fields.json') });
    const c = r.results['catalog.product_fields']!;
    expect(c.status).toBe('fail');
    expect(c.evidence.map((e) => e.found).join(' ')).toContain('prod_brp: description');
  });

  it('5xx search fails and skips dependants', async () => {
    const r = await scan({ 'POST /ucp/v1/catalog/search': () => new Response('err', { status: 500 }) });
    expect(r.status('catalog.search_responds')).toBe('fail');
    expect(r.status('catalog.latency')).toBe('skip');
  });

  it('sends the UCP-Agent and Request-Id headers', async () => {
    let seen: Headers | undefined;
    await scan({
      'POST /ucp/v1/catalog/search': (req) => {
        seen = req.headers;
        return catalog('catalog.search.valid.json')();
      },
    });
    expect(seen!.get('ucp-agent')).toBe('profile="https://cartprobe.test/.well-known/ucp"');
    expect(seen!.get('request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen!.get('user-agent')).toBe('CartProbeBot/1.0 (+https://cartprobe.test/bot)');
  });
});

describe('product checks', () => {
  const pages: Record<string, string> = {
    'blue-runner-pro': 'pages/product.no-jsonld.html',
    'trail-jacket': 'pages/product.missing-identifiers.html',
    'merino-tee': 'pages/product.hostile.html',
  };
  const routes: Record<string, Route> = Object.fromEntries(
    Object.entries(pages).map(([h, f]) => [
      `/product/${h}`,
      () => new Response(fixture(f, HOST), { headers: { 'content-type': 'text/html' } }),
    ]),
  );

  it('poor structured data produces fail/warn with example URLs', async () => {
    const r = await scan(routes);
    expect(r.status('products.jsonld_present')).toBe('warn'); // 2 of 3 = 67%
    expect(r.results['products.jsonld_present']!.evidence[0]!.url).toBe(
      `https://${HOST}/product/blue-runner-pro`,
    );
    expect(r.status('products.identifiers')).toBe('fail'); // missing-identifiers has neither brand nor ids → 1 of 2
    expect(r.status('products.price_format')).toBe('fail'); // "12.5" ok, "<b>9.99</b>" not
    expect(r.status('products.shipping_details')).toBe('fail');
    expect(r.status('products.availability')).toBe('fail');
  });

  it('price match compares lowPrice and skips uncomparable pairs', async () => {
    const r = await scan(routes);
    expect(r.status('consistency.price_match')).toBe('fail'); // 12.50 lowPrice vs 89.50 catalog
  });
});

describe('checkout checks (verified + test mode)', () => {
  const verified = {
    verifiedOwnership: true,
    testModeConfirmed: true,
    testCheckoutEndpoint: `https://${HOST}/ucp/v1`,
  };

  it('bad totals fail with explanation', async () => {
    const r = await scan(
      {
        'POST /ucp/v1/checkout-sessions': () =>
          json(fixture('ucp/2026-08-25/checkout.session.bad-totals.json', HOST)),
      },
      verified,
    );
    expect(r.status('checkout.session_create')).toBe('fail'); // schema rejects the float tax
  });

  it('totals that do not add up fail the totals check', async () => {
    const body = fixture('ucp/2026-08-25/checkout.session.valid.json', HOST).replace(
      '"amount": 12960',
      '"amount": 13000',
    );
    const r = await scan({ 'POST /ucp/v1/checkout-sessions': () => json(body) }, verified);
    expect(r.status('checkout.session_create')).toBe('pass');
    expect(r.status('checkout.session_totals_integer')).toBe('fail');
    expect(r.results['checkout.session_totals_integer']!.evidence[0]!.found).toContain(
      'entries sum to 12960 but total is 13000',
    );
  });

  it('never calls complete and always cancels', async () => {
    const calls: string[] = [];
    await runScan(HOST, verified, async (req) => {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      return mockStore.fetch(req) as Promise<Response>;
    });
    expect(calls).toContain('POST /ucp/v1/checkout-sessions');
    expect(calls).toContain('POST /ucp/v1/checkout-sessions/chk_test_0001/cancel');
    expect(calls.some((c) => c.includes('/complete'))).toBe(false);
  });

  it('unverified stores never receive checkout POSTs', async () => {
    const calls: string[] = [];
    await runScan(HOST, {}, async (req) => {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      return mockStore.fetch(req) as Promise<Response>;
    });
    expect(calls.filter((c) => c.includes('checkout'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('POST')).map((c) => c.split(' ')[1])).toEqual([
      '/ucp/v1/catalog/search',
    ]);
  });
});
