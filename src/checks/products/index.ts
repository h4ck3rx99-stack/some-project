import { isAllowed, parseRobots } from '../../lib/robots';
import { priceFormatProblem } from '../../lib/money';
import { availabilityName, extractHtml, findProducts, parseJsonLdBlocks } from '../../scan/extract';
import type { CheckDefinition, ExtractedProduct, ProductPage, ScanContext } from '../../scan/types';
import { pct, ratioStatus, result, skip, summarize, truncate } from '../helpers';

export const PRODUCT_CHUNK = 10;
const BOT_TOKEN = 'CartProbeBot';

function sameSite(url: string, domain: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const d = domain.toLowerCase().replace(/^www\./, '');
    return h === d || h === `www.${d}`;
  } catch {
    return false;
  }
}

export function parseSitemapLocs(xml: string, limit = 50_000): string[] {
  const out: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < limit) {
    out.push(
      m[1]!
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    );
  }
  return out;
}

export function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/** Pick `n` items spread evenly across the list (not just the first n). */
export function sampleEvenly<T>(list: T[], n: number): T[] {
  if (list.length <= n) return [...list];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]!);
  return out;
}

const PRODUCT_PATH_RE = /\/(product|products|produkt|produit|producto|p|item|items|shop)\/[^/]+/i;

async function fetchRobots(ctx: ScanContext) {
  if (ctx.state.robots) return;
  const r = await ctx.http.fetch(ctx.url + '/robots.txt', { accept: 'text/plain', maxBytes: 500_000 });
  ctx.state.robots = { fetch: summarize(r), text: r.ok ? (r.bodyText ?? '').slice(0, 200_000) : undefined };
}

/** Find product URLs: catalog results first, then sitemaps (robots Sitemap lines, Yoast/RankMath/WooCommerce patterns). */
async function discoverProductUrls(ctx: ScanContext): Promise<void> {
  await fetchRobots(ctx);
  const robots = parseRobots(ctx.state.robots?.text ?? '');
  const sm = {
    tried: [] as string[],
    found: [] as string[],
    productSitemap: undefined as string | undefined,
  };

  const fromCatalog = (ctx.state.catalog?.products ?? [])
    .flatMap((p) => [p.url, ...p.variants.map((v) => v.url)])
    .filter((u): u is string => typeof u === 'string' && sameSite(u, ctx.domain));
  const urls = [...new Set(fromCatalog.map((u) => u.split('#')[0]!))];

  const fetchXml = async (u: string): Promise<string | null> => {
    if (sm.tried.includes(u) || sm.tried.length >= 8) return null;
    sm.tried.push(u);
    const r = await ctx.http.fetch(u, {
      accept: 'application/xml, text/xml',
      maxBytes: 5_000_000,
      timeoutMs: 8000,
    });
    if (!r.ok || !r.bodyText || !/<(urlset|sitemapindex)[\s>]/i.test(r.bodyText)) return null;
    sm.found.push(u);
    return r.bodyText;
  };

  const sitemapProductUrls: string[] = [];
  // Always look for sitemaps: basics.sitemap_found reports on them even when the catalog gave enough URLs.
  {
    const candidates = [
      ...robots.sitemaps.filter((u) => sameSite(u, ctx.domain)),
      `${ctx.url}/sitemap_index.xml`,
      `${ctx.url}/product-sitemap.xml`,
      `${ctx.url}/sitemap.xml`,
    ];
    const productLocs: string[] = [];
    for (const c of [...new Set(candidates)]) {
      if (productLocs.length) break;
      const xml = await fetchXml(c);
      if (!xml) continue;
      if (isSitemapIndex(xml)) {
        const children = parseSitemapLocs(xml, 500).filter((u) => sameSite(u, ctx.domain));
        const productChildren = children.filter((u) => /product/i.test(u));
        for (const child of (productChildren.length ? productChildren : children).slice(0, 3)) {
          const cx = await fetchXml(child);
          if (!cx || isSitemapIndex(cx)) continue;
          if (/product/i.test(child)) sm.productSitemap ??= child;
          productLocs.push(...parseSitemapLocs(cx).filter((u) => sameSite(u, ctx.domain)));
        }
      } else {
        const locs = parseSitemapLocs(xml).filter((u) => sameSite(u, ctx.domain));
        if (/product/i.test(c)) {
          sm.productSitemap ??= c;
          productLocs.push(...locs);
        } else {
          const filtered = locs.filter((u) => PRODUCT_PATH_RE.test(new URL(u).pathname));
          if (filtered.length) sm.productSitemap ??= c;
          productLocs.push(...filtered);
        }
      }
    }
    sitemapProductUrls.push(...productLocs.filter((u) => !urls.includes(u)));
  }
  ctx.state.sitemaps = sm;

  const blocked: { url: string; rule: string }[] = [];
  const isAllowedUrl = (u: string) => {
    const p = new URL(u);
    const d = isAllowed(robots, BOT_TOKEN, p.pathname + p.search);
    if (!d.allowed) blocked.push({ url: u, rule: `${d.agent ?? '*'}: Disallow ${d.rule?.path ?? ''}` });
    return d.allowed;
  };
  const fromCatalogAllowed = urls.filter(isAllowedUrl);
  const fromSitemapAllowed = [...new Set(sitemapProductUrls)].filter(isAllowedUrl);
  ctx.state.productUrls = [...fromCatalogAllowed, ...fromSitemapAllowed].slice(0, 5000);
  ctx.state.robotsBlocked = blocked.slice(0, 50);
  // Catalog URLs first (they enable consistency checks), then an even spread of the sitemap.
  const head = fromCatalogAllowed.slice(0, ctx.limits.maxProducts);
  ctx.state.sampled = [...head, ...sampleEvenly(fromSitemapAllowed, ctx.limits.maxProducts - head.length)];
  ctx.state.productPages = [];
}

export async function extractProductPage(
  url: string,
  status: number,
  html: string | undefined,
  error?: string,
): Promise<ProductPage> {
  if (!html) return { url, status, error, products: [], jsonLdBlocks: 0, jsonLdErrors: 0 };
  const ex = await extractHtml(html);
  const { nodes, errors } = parseJsonLdBlocks(ex.jsonLd);
  const { products } = findProducts(nodes);
  return {
    url,
    status,
    error,
    products: products.slice(0, 5),
    jsonLdBlocks: ex.jsonLd.length,
    jsonLdErrors: errors,
  };
}

/** Run one products:<offset> phase. Returns the next offset, or null when sampling is complete. */
export async function prepareProducts(ctx: ScanContext, offset: number): Promise<number | null> {
  if (offset === 0 || !ctx.state.sampled) await discoverProductUrls(ctx);
  const sample = ctx.state.sampled ?? [];
  const chunk = sample.slice(offset, offset + PRODUCT_CHUNK);
  for (const url of chunk) {
    const r = await ctx.http.fetch(url, { accept: 'text/html', maxBytes: 2_000_000, timeoutMs: 8000 });
    const html = r.ok && /html/i.test(r.contentType ?? 'text/html') ? r.bodyText : undefined;
    const page = await extractProductPage(
      url,
      r.status,
      html,
      r.error ? `${r.error.kind}: ${r.error.message}` : !r.ok ? `HTTP ${r.status}` : undefined,
    );
    ctx.state.productPages!.push(page);
  }
  const next = offset + PRODUCT_CHUNK;
  return next < sample.length ? next : null;
}

/* ------------------------------ checks ------------------------------ */

type Fetched = ProductPage & { products: ExtractedProduct[] };

function fetchedPages(ctx: ScanContext): ProductPage[] {
  return (ctx.state.productPages ?? []).filter((p) => !p.error);
}
function pagesWithProduct(ctx: ScanContext): Fetched[] {
  return fetchedPages(ctx).filter((p) => p.products.length > 0);
}

function noSample(ctx: ScanContext) {
  if (fetchedPages(ctx).length === 0) {
    const tried = ctx.state.sampled?.length ?? 0;
    return skip(
      tried
        ? `None of the ${tried} sampled product pages could be fetched.`
        : 'We could not find product pages to sample (no catalog URLs or product sitemap).',
    );
  }
  return null;
}

/** Shared shape for "share of pages where predicate holds" checks. */
function ratioCheck(
  ctx: ScanContext,
  test: (p: ExtractedProduct) => string | null, // null = ok, string = what is missing
  okSummary: (share: string, n: number) => string,
  badSummary: (share: string, n: number) => string,
) {
  const ns = noSample(ctx);
  if (ns) return ns;
  const pages = pagesWithProduct(ctx);
  if (pages.length === 0) return skip('No sampled page has Product structured data to check.');
  const failures: { url: string; missing: string }[] = [];
  for (const page of pages) {
    const problem = test(page.products[0]!);
    if (problem) failures.push({ url: page.url, missing: problem });
  }
  const ok = pages.length - failures.length;
  const status = ratioStatus(ok, pages.length);
  const share = pct(ok, pages.length);
  const ev = failures
    .slice(0, 10)
    .map((f) => ({ label: 'Product page', url: f.url, found: truncate(f.missing, 300) }));
  return result(
    status,
    status === 'pass' ? okSummary(share, pages.length) : badSummary(share, pages.length),
    ev,
    { ok, total: pages.length },
  );
}

const offerPrice = (p: ExtractedProduct) =>
  p.offers.find((o) => o.price !== undefined || o.lowPrice !== undefined);

export const productChecks: CheckDefinition[] = [
  {
    id: 'products.jsonld_present',
    title: 'Product pages have structured data',
    category: 'products',
    severity: 'high',
    phase: 'consistency',
    why: 'Agents read schema.org Product data to understand what a page sells; without it they guess or skip the product.',
    async run(ctx) {
      const ns = noSample(ctx);
      if (ns) return ns;
      const pages = fetchedPages(ctx);
      const missing = pages.filter((p) => p.products.length === 0);
      const ok = pages.length - missing.length;
      const status = ratioStatus(ok, pages.length);
      const ev = missing.slice(0, 10).map((p) => ({
        label: 'No Product found',
        url: p.url,
        expected: 'a schema.org Product or ProductGroup in JSON-LD',
        found:
          p.jsonLdBlocks === 0
            ? 'no JSON-LD blocks'
            : `${p.jsonLdBlocks} JSON-LD block(s)${p.jsonLdErrors ? `, ${p.jsonLdErrors} unparseable` : ''}, none a Product`,
      }));
      return result(
        status,
        `${pct(ok, pages.length)} of ${pages.length} sampled product pages have Product structured data.`,
        ev,
        { ok, total: pages.length },
      );
    },
  },
  {
    id: 'products.core_fields',
    title: 'Products have name, image and price',
    category: 'products',
    severity: 'high',
    phase: 'consistency',
    dependsOn: ['products.jsonld_present'],
    why: 'Name, image, price and currency are the minimum an agent needs to show a product.',
    async run(ctx) {
      return ratioCheck(
        ctx,
        (p) => {
          const miss: string[] = [];
          if (!p.name) miss.push('name');
          if (!p.hasImage) miss.push('image');
          const o = offerPrice(p);
          if (!o) miss.push('offers.price');
          if (!p.offers.some((x) => x.priceCurrency)) miss.push('offers.priceCurrency');
          return miss.length ? `missing ${miss.join(', ')}` : null;
        },
        (s, n) => `${s} of ${n} products include name, image, price and currency.`,
        (s, n) => `Only ${s} of ${n} products include name, image, price and currency.`,
      );
    },
  },
  {
    id: 'products.availability',
    title: 'Products state availability',
    category: 'products',
    severity: 'medium',
    phase: 'consistency',
    dependsOn: ['products.jsonld_present'],
    why: 'Agents avoid recommending products they cannot confirm are in stock.',
    async run(ctx) {
      return ratioCheck(
        ctx,
        (p) => {
          const vals = p.offers.map((o) => o.availability).filter(Boolean) as string[];
          if (!vals.length) return 'missing offers.availability';
          const badVal = vals.find((v) => !availabilityName(v));
          return badVal
            ? `availability "${truncate(badVal, 60)}" is not a schema.org ItemAvailability URL (e.g. https://schema.org/InStock)`
            : null;
        },
        (s, n) => `${s} of ${n} products declare availability using schema.org values.`,
        (s, n) => `Only ${s} of ${n} products declare availability using schema.org values.`,
      );
    },
  },
  {
    id: 'products.identifiers',
    title: 'Products have brand and identifiers',
    category: 'products',
    severity: 'medium',
    phase: 'consistency',
    dependsOn: ['products.jsonld_present'],
    why: 'Brand plus a GTIN, MPN or SKU lets agents match your product to what the shopper asked for.',
    async run(ctx) {
      return ratioCheck(
        ctx,
        (p) => {
          const miss: string[] = [];
          if (!p.hasBrand) miss.push('brand');
          if (!p.gtin && !p.mpn && !p.sku) miss.push('gtin/mpn/sku');
          return miss.length ? `missing ${miss.join(' and ')}` : null;
        },
        (s, n) => `${s} of ${n} products have a brand and a GTIN, MPN or SKU.`,
        (s, n) => `Only ${s} of ${n} products have a brand and a GTIN, MPN or SKU.`,
      );
    },
  },
  {
    id: 'products.shipping_details',
    title: 'Offers include shipping details',
    category: 'products',
    severity: 'low',
    phase: 'consistency',
    dependsOn: ['products.jsonld_present'],
    why: 'Shoppers ask agents about delivery cost and speed; shippingDetails answers that.',
    async run(ctx) {
      return ratioCheck(
        ctx,
        (p) => (p.offers.some((o) => o.hasShippingDetails) ? null : 'missing offers.shippingDetails'),
        (s, n) => `${s} of ${n} products include shipping details.`,
        (s, n) => `Only ${s} of ${n} products include shipping details.`,
      );
    },
  },
  {
    id: 'products.return_policy',
    title: 'Return policy is declared',
    category: 'products',
    severity: 'low',
    phase: 'consistency',
    dependsOn: ['products.jsonld_present'],
    why: 'Agents surface return terms when shoppers compare stores.',
    async run(ctx) {
      return ratioCheck(
        ctx,
        (p) =>
          p.hasReturnPolicy || p.offers.some((o) => o.hasReturnPolicy)
            ? null
            : 'missing hasMerchantReturnPolicy (offer or organization)',
        (s, n) => `${s} of ${n} products have a return policy (on the offer or your organization).`,
        (s, n) => `Only ${s} of ${n} products have a return policy (on the offer or your organization).`,
      );
    },
  },
  {
    id: 'products.price_format',
    title: 'Prices are machine-readable',
    category: 'products',
    severity: 'medium',
    phase: 'consistency',
    dependsOn: ['products.jsonld_present'],
    why: 'A price like "$1,299.00" or "19.999" cannot be parsed reliably by agents.',
    async run(ctx) {
      return ratioCheck(
        ctx,
        (p) => {
          const o = offerPrice(p);
          if (!o) return 'no price to check';
          return priceFormatProblem(o.price ?? o.lowPrice, o.priceCurrency);
        },
        (s, n) => `${s} of ${n} product prices are plain positive decimals.`,
        (s, n) => `Only ${s} of ${n} product prices are plain positive decimals.`,
      );
    },
  },
];

export { fetchRobots };
