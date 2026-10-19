/**
 * Mock store serving fixture variants by hostname: https://<variant>.mockstore.test/…
 * (or the x-mock-host header when proxied in local dev). Any other subdomain defaults to `good`
 * and can be switched at runtime via POST /__mock/set?variant=<name> (in-memory, per isolate).
 *
 * Variants: good, outdated, broken-profile, no-ucp, price-mismatch, blocks-robots, slow,
 * redirect-loop, redirect-to-private.
 */
import { Hono } from 'hono';
import { fixture } from '../fixtures';

export const VARIANTS = ['good', 'outdated', 'broken-profile', 'no-ucp', 'price-mismatch', 'blocks-robots', 'slow', 'redirect-loop', 'redirect-to-private'] as const;
export type Variant = (typeof VARIANTS)[number];

const overrides = new Map<string, Variant>();
const verifyTokens = new Map<string, string>();
const cancelled = new Set<string>();

function hostOf(req: Request): string {
  return (req.headers.get('x-mock-host') ?? new URL(req.url).hostname).toLowerCase();
}

export function variantOf(host: string): Variant {
  const o = overrides.get(host);
  if (o) return o;
  const sub = host.split('.')[0] as Variant;
  return (VARIANTS as readonly string[]).includes(sub) ? sub : 'good';
}

/** Reset in-memory state (tests). */
export function resetMockStore(): void {
  overrides.clear();
  verifyTokens.clear();
  cancelled.clear();
}

const PRODUCT_PAGES: Record<string, string> = {
  'blue-runner-pro': 'pages/product.complete.html',
  'trail-jacket': 'pages/product.graph.html',
  'merino-tee': 'pages/product.variants.html',
};

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', etag: '"v1"' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const mockStore = new Hono();

// Control endpoints (dev/test only).
mockStore.post('/__mock/set', (c) => {
  const v = c.req.query('variant') as Variant;
  if (!(VARIANTS as readonly string[]).includes(v)) return c.text('unknown variant', 400);
  overrides.set(hostOf(c.req.raw), v);
  return c.text(`ok: ${hostOf(c.req.raw)} → ${v}`);
});
mockStore.post('/__mock/verify', (c) => {
  verifyTokens.set(hostOf(c.req.raw), c.req.query('token') ?? '');
  return c.text('ok');
});

mockStore.use('*', async (c, next) => {
  // http:// requests: redirect to https like a real store.
  if (new URL(c.req.url).protocol === 'http:' && !c.req.header('x-mock-host')) {
    return c.redirect(c.req.url.replace(/^http:/, 'https:'), 301);
  }
  if (c.req.header('x-mock-proto') === 'http') return c.redirect(`https://${hostOf(c.req.raw)}${new URL(c.req.url).pathname}`, 301);
  await next();
});

mockStore.get('/.well-known/ucp', async (c) => {
  const host = hostOf(c.req.raw);
  const v = variantOf(host);
  switch (v) {
    case 'no-ucp':
      return c.text('Not Found', 404);
    case 'broken-profile':
      return c.body(`{"ucp": {"version": "2026-08-25", "services": {,}}`, 200, { 'content-type': 'text/html' });
    case 'outdated':
      return c.body(fixture('ucp/2026-08-25/profile.previous-version.json', host), 200, JSON_HEADERS);
    case 'slow':
      await sleep(1600);
      break;
    case 'redirect-loop':
      return c.redirect('/.well-known/ucp/', 302);
    case 'redirect-to-private':
      return c.redirect('https://127.0.0.1/.well-known/ucp', 302);
  }
  return c.body(fixture('ucp/2026-08-25/profile.valid.json', host), 200, JSON_HEADERS);
});
mockStore.get('/.well-known/ucp/', (c) => c.redirect('/.well-known/ucp', 302));

mockStore.get('/.well-known/cartprobe-verify.txt', (c) => {
  const t = verifyTokens.get(hostOf(c.req.raw));
  return t ? c.text(t) : c.text('not found', 404);
});

mockStore.get('/ucp/v1', (c) => c.json({ error: 'use POST /catalog/search' }, 404));
mockStore.get('/ucp/mcp', (c) => c.text('Method Not Allowed', 405));

mockStore.post('/ucp/v1/catalog/search', async (c) => {
  const host = hostOf(c.req.raw);
  if (!c.req.header('ucp-agent')) return c.json({ code: 'invalid_request', content: 'UCP-Agent header required' }, 400);
  const v = variantOf(host);
  const file = v === 'price-mismatch' ? 'catalog.search.price-mismatch.json' : 'catalog.search.valid.json';
  return c.body(fixture(`ucp/2026-08-25/${file}`, host), 200, { 'content-type': 'application/json' });
});

mockStore.post('/ucp/v1/checkout-sessions', async (c) => {
  const host = hostOf(c.req.raw);
  const body = (await c.req.json().catch(() => null)) as { line_items?: { item?: { id?: string } }[] } | null;
  if (!body?.line_items?.[0]?.item?.id) return c.json({ code: 'invalid_request', content: 'line_items required' }, 400);
  return c.body(fixture('ucp/2026-08-25/checkout.session.valid.json', host), 201, { 'content-type': 'application/json' });
});
mockStore.post('/ucp/v1/checkout-sessions/:id/cancel', (c) => {
  const host = hostOf(c.req.raw);
  cancelled.add(`${host}/${c.req.param('id')}`);
  const s = JSON.parse(fixture('ucp/2026-08-25/checkout.session.valid.json', host)) as Record<string, unknown>;
  s.status = 'canceled';
  return c.json(s);
});

mockStore.get('/robots.txt', (c) => {
  const host = hostOf(c.req.raw);
  const v = variantOf(host);
  if (v === 'redirect-to-private') return c.redirect('https://10.0.0.1/robots.txt', 302);
  return c.text(fixture(v === 'blocks-robots' ? 'robots/blocks-products.txt' : 'robots/allow-all.txt', host));
});
mockStore.get('/sitemap_index.xml', (c) => c.body(fixture('sitemaps/index.xml', hostOf(c.req.raw)), 200, { 'content-type': 'application/xml' }));
mockStore.get('/product-sitemap.xml', (c) => c.body(fixture('sitemaps/product-sitemap.xml', hostOf(c.req.raw)), 200, { 'content-type': 'application/xml' }));

mockStore.get('/product/:handle', async (c) => {
  const host = hostOf(c.req.raw);
  const page = PRODUCT_PAGES[c.req.param('handle')];
  if (!page) return c.text('Not Found', 404);
  if (variantOf(host) === 'slow') await sleep(200);
  return c.html(fixture(page, host));
});

mockStore.get('/', async (c) => {
  const host = hostOf(c.req.raw);
  const v = variantOf(host);
  if (v === 'redirect-loop') return c.redirect('/home', 302);
  if (v === 'redirect-to-private') return c.redirect('https://192.168.1.1/', 302);
  if (v === 'slow') await sleep(1900);
  return c.html('<!doctype html><html><head><title>Example Outdoor | Running Shoes &amp; Jackets</title></head><body><h1>Example Outdoor</h1></body></html>');
});
mockStore.get('/home', (c) => c.redirect('/', 302));

export default mockStore;
