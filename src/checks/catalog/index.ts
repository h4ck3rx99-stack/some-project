import { LATENCY } from '../../config/weights';
import { extractHtml } from '../../scan/extract';
import type { CatalogProduct, CheckDefinition, ScanContext } from '../../scan/types';
import { formatAjvError, validate, validationVersion } from '../../ucp/validators';
import { describeFetch, isObj, result, skip, summarize, truncate, walkJson } from '../helpers';

export const CATALOG_CAPABILITY = 'dev.ucp.shopping.catalog.search';
const STOPWORDS = new Set(['home', 'homepage', 'shop', 'store', 'online', 'official', 'welcome', 'with', 'your', 'from', 'that', 'this', 'buy', 'best', 'page', 'site', 'the', 'and', 'for']);

/** Pick a benign search word from the homepage <title>, avoiding the brand/domain name. */
export function queryFromTitle(title: string | undefined, domain: string): string {
  const domainTokens = new Set(domain.toLowerCase().split(/[.-]/));
  const words = (title ?? '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 4 && w.length <= 20 && !STOPWORDS.has(w) && !domainTokens.has(w));
  return words[0] ?? 'shirt';
}

/** Headers every UCP REST request carries (spec: shopping/rest.openapi.json parameters). */
export function ucpHeaders(ctx: ScanContext, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'ucp-agent': `profile="${ctx.appUrl.replace(/\/$/, '')}/.well-known/ucp"`,
    'request-id': crypto.randomUUID(),
    ...extra,
  };
}

function parseCatalogProducts(json: unknown): CatalogProduct[] {
  if (!isObj(json) || !Array.isArray(json.products)) return [];
  return json.products.slice(0, 50).filter(isObj).map((p) => ({
    id: typeof p.id === 'string' ? p.id : undefined,
    title: typeof p.title === 'string' ? truncate(p.title, 200) : undefined,
    url: typeof p.url === 'string' ? p.url : undefined,
    variants: (Array.isArray(p.variants) ? p.variants : []).slice(0, 20).filter(isObj).map((v) => {
      const price = isObj(v.price) ? v.price : {};
      const avail = isObj(v.availability) ? v.availability : {};
      return {
        id: typeof v.id === 'string' ? v.id : undefined,
        sku: typeof v.sku === 'string' ? v.sku : undefined,
        url: typeof v.url === 'string' ? v.url : undefined,
        amount: price.amount,
        currency: price.currency,
        available: typeof avail.available === 'boolean' ? avail.available : undefined,
      };
    }),
  }));
}

export async function prepareCatalog(ctx: ScanContext): Promise<void> {
  // Homepage: used for the search word here and for basics.homepage_ttfb later.
  const home = await ctx.http.fetch(ctx.url + '/', { accept: 'text/html', maxBytes: 1_500_000 });
  let title: string | undefined;
  if (home.bodyText && /html/i.test(home.contentType ?? 'text/html')) {
    try {
      title = (await extractHtml(home.bodyText)).title;
    } catch {
      title = undefined;
    }
  }
  ctx.state.homepage = { fetch: summarize(home), title };

  const caps = ctx.state.results['discovery.capabilities_declared']?.meta?.capabilities as string[] | undefined;
  const query = queryFromTitle(title, ctx.domain);
  if (!caps?.includes(CATALOG_CAPABILITY)) {
    ctx.state.catalog = { query, products: [], skippedReason: 'not_offered' };
    return;
  }
  if (!ctx.state.restEndpoint) {
    ctx.state.catalog = { query, products: [], skippedReason: 'no_rest' };
    return;
  }
  const search = async (q: string) =>
    ctx.http.fetch(ctx.state.restEndpoint + '/catalog/search', {
      method: 'POST',
      accept: 'application/json',
      headers: ucpHeaders(ctx),
      body: JSON.stringify({ query: q, pagination: { limit: 10 } }),
      timeoutMs: 8000,
      maxBytes: 1_500_000,
      maxRedirects: 0,
    });
  let q = query;
  let r = await search(q);
  if (r.ok && isObj(r.json) && Array.isArray(r.json.products) && r.json.products.length === 0 && q !== 'shirt') {
    q = 'shirt';
    r = await search(q);
  }
  ctx.state.catalog = { query: q, fetch: summarize(r), json: r.json, products: parseCatalogProducts(r.json) };
  if (ctx.capture && r.bodyText) await ctx.capture('catalog-search.json', r.bodyText);
}

const searchUrl = (ctx: ScanContext) => (ctx.state.restEndpoint ?? '') + '/catalog/search';

function catalogSkip(ctx: ScanContext) {
  const c = ctx.state.catalog;
  if (c?.skippedReason === 'no_rest') {
    return skip('Your profile declares catalog search but no REST endpoint for dev.ucp.shopping. CartProbe currently probes the REST transport only.');
  }
  return null;
}

export const catalogChecks: CheckDefinition[] = [
  {
    id: 'catalog.search_responds',
    title: 'Catalog search responds',
    category: 'catalog',
    severity: 'critical',
    phase: 'catalog',
    requires: { capability: CATALOG_CAPABILITY },
    why: 'Agents search your catalog to find products to recommend; a failing search means no recommendations.',
    async run(ctx) {
      const s = catalogSkip(ctx);
      if (s) return s;
      const c = ctx.state.catalog!;
      const f = c.fetch!;
      const ev = [{ label: `POST /catalog/search {"query":"${c.query}"}`, url: searchUrl(ctx), expected: 'HTTP 200 with a JSON body', found: describeFetch(f) }];
      if (f.error) return result('fail', `Catalog search failed (${f.error.kind.replace(/_/g, ' ')}).`, ev);
      if (f.status < 200 || f.status >= 300) return result('fail', `Catalog search returned HTTP ${f.status}.`, ev);
      if (c.json === undefined) return result('fail', 'Catalog search responded, but not with JSON.', ev);
      return result('pass', `Catalog search for "${c.query}" returned HTTP ${f.status}.`, ev);
    },
  },
  {
    id: 'catalog.search_schema_valid',
    title: 'Search response matches the UCP schema',
    category: 'catalog',
    severity: 'high',
    phase: 'catalog',
    dependsOn: ['catalog.search_responds'],
    requires: { capability: CATALOG_CAPABILITY },
    why: 'Agents validate responses against the catalog schema and discard ones that do not match.',
    async run(ctx) {
      const json = ctx.state.catalog!.json;
      const declared = isObj(json) && isObj(json.ucp) ? json.ucp.version : undefined;
      const v = validationVersion(declared ?? ctx.state.profileVersion);
      const out = validate('catalogSearchResponse', json, v);
      if (out.valid) return result('pass', `The search response validates against the UCP ${v} catalog search schema.`);
      return result(
        'fail',
        `The search response has ${out.errors.length} schema error${out.errors.length === 1 ? '' : 's'} against the UCP ${v} catalog search schema.`,
        out.errors.slice(0, 20).map((e) => ({ label: 'Schema error', expected: e.schemaPath, found: formatAjvError(e) })),
      );
    },
  },
  {
    id: 'catalog.has_results',
    title: 'Search returns products',
    category: 'catalog',
    severity: 'medium',
    phase: 'catalog',
    dependsOn: ['catalog.search_responds'],
    requires: { capability: CATALOG_CAPABILITY },
    why: 'If common searches return nothing, agents conclude you do not sell it.',
    async run(ctx) {
      const c = ctx.state.catalog!;
      const n = c.products.length;
      if (n > 0) return result('pass', `Searching "${c.query}" returned ${n} product${n === 1 ? '' : 's'}.`);
      return result('warn', `Searching "${c.query}" returned no products.`, [{ label: 'Query', url: searchUrl(ctx), expected: 'at least 1 product', found: '0 products' }]);
    },
  },
  {
    id: 'catalog.product_fields',
    title: 'Products include required fields',
    category: 'catalog',
    severity: 'high',
    phase: 'catalog',
    dependsOn: ['catalog.search_responds'],
    requires: { capability: CATALOG_CAPABILITY },
    why: 'Agents need id, title, description, price and variants to present and buy a product.',
    async run(ctx) {
      const json = ctx.state.catalog!.json;
      const products = isObj(json) && Array.isArray(json.products) ? json.products.slice(0, 50) : [];
      if (products.length === 0) return skip('No products were returned, so there were no fields to check.');
      const missingRequired: string[] = [];
      const missingRecommended: string[] = [];
      products.forEach((p, i) => {
        const label = isObj(p) && typeof p.id === 'string' ? truncate(p.id, 60) : `products[${i}]`;
        if (!isObj(p)) return missingRequired.push(`${label}: not an object`);
        // Required per schemas/ucp/<v>/shopping/types/product.json and variant.json.
        const req = ['id', 'title', 'description', 'price_range', 'variants'].filter((k) => p[k] === undefined);
        const variants = Array.isArray(p.variants) ? p.variants : [];
        if (Array.isArray(p.variants) && variants.length === 0) req.push('variants (empty)');
        variants.slice(0, 20).forEach((v, j) => {
          if (!isObj(v)) return;
          for (const k of ['id', 'title', 'description', 'price']) if (v[k] === undefined) req.push(`variants[${j}].${k}`);
          if (isObj(v.price) && (!Number.isInteger(v.price.amount) || typeof v.price.currency !== 'string')) req.push(`variants[${j}].price (integer amount + currency)`);
          if (v.availability === undefined) missingRecommended.push(`${label}: variants[${j}].availability`);
        });
        if (req.length) missingRequired.push(`${label}: ${req.join(', ')}`);
        if (p.url === undefined) missingRecommended.push(`${label}: url`);
      });
      if (missingRequired.length) {
        return result('fail', `${missingRequired.length} of ${products.length} products are missing fields the spec requires.`, missingRequired.slice(0, 10).map((m) => ({ label: 'Missing', expected: 'id, title, description, price_range, variants[].{id,title,description,price}', found: truncate(m, 300) })));
      }
      if (missingRecommended.length) {
        return result('warn', 'All required fields are present, but some products lack a product URL or variant availability.', missingRecommended.slice(0, 10).map((m) => ({ label: 'Recommended field missing', found: truncate(m, 300) })));
      }
      return result('pass', `All ${products.length} returned products include the required fields, URLs and availability.`);
    },
  },
  {
    id: 'catalog.amounts_integer',
    title: 'Prices use integer minor units',
    category: 'catalog',
    severity: 'high',
    phase: 'catalog',
    dependsOn: ['catalog.search_responds'],
    requires: { capability: CATALOG_CAPABILITY },
    why: 'UCP amounts are integers in minor units (e.g. 1999 for $19.99); a decimal like 19.99 breaks every price an agent shows.',
    async run(ctx) {
      const bad: { path: string; value: string }[] = [];
      const priceKeys = new Set(['price', 'list_price', 'unit_price', 'min', 'max']);
      walkJson(ctx.state.catalog!.json, (v, path, key) => {
        if (typeof v !== 'number') return;
        const parent = path.split('.').slice(-2, -1)[0]?.replace(/\[\d+\]$/, '') ?? '';
        const moneyish = key === 'amount' || priceKeys.has(key) || priceKeys.has(parent);
        if (moneyish && !Number.isInteger(v)) bad.push({ path, value: String(v) });
      });
      if (bad.length) {
        return result('fail', `${bad.length} money value${bad.length === 1 ? ' is' : 's are'} not an integer.`, bad.slice(0, 10).map((b) => ({ label: b.path, expected: 'integer minor units, e.g. 1999', found: b.value })));
      }
      return result('pass', 'All money amounts in the search response are integers.');
    },
  },
  {
    id: 'catalog.latency',
    title: 'Catalog search is fast',
    category: 'catalog',
    severity: 'low',
    phase: 'catalog',
    dependsOn: ['catalog.search_responds'],
    requires: { capability: CATALOG_CAPABILITY },
    why: 'Slow search responses time out inside agent conversations.',
    async run(ctx) {
      const t = ctx.state.catalog!.fetch!.totalMs;
      const ev = [{ label: 'Response time', url: searchUrl(ctx), expected: `< ${LATENCY.catalog.pass} ms`, found: `${t} ms` }];
      if (t < LATENCY.catalog.pass) return result('pass', `Search responded in ${t} ms.`, ev);
      if (t < LATENCY.catalog.warn) return result('warn', `Search took ${t} ms.`, ev);
      return result('fail', `Search took ${t} ms.`, ev);
    },
  },
];
