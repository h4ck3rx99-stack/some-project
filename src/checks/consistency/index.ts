import { decimalToMinor, formatMinor } from '../../lib/money';
import { availabilityIsInStock } from '../../scan/extract';
import type { CatalogProduct, CheckDefinition, ExtractedProduct, ScanContext } from '../../scan/types';
import { CATALOG_CAPABILITY } from '../catalog';
import { result, skip, truncate } from '../helpers';

export function normaliseUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u;
  }
}

export interface MatchedPair {
  url: string;
  catalog: CatalogProduct;
  page: ExtractedProduct;
}

/** Pair catalog products with sampled pages by URL, falling back to SKU. */
export function matchPairs(ctx: ScanContext): MatchedPair[] {
  const pages = (ctx.state.productPages ?? []).filter((p) => p.products.length > 0);
  const byUrl = new Map(pages.map((p) => [normaliseUrl(p.url), p]));
  const pairs: MatchedPair[] = [];
  for (const c of ctx.state.catalog?.products ?? []) {
    const urls = [c.url, ...c.variants.map((v) => v.url)].filter((x): x is string => !!x).map(normaliseUrl);
    let page = urls.map((u) => byUrl.get(u)).find(Boolean);
    if (!page) {
      const skus = new Set(c.variants.map((v) => v.sku).filter(Boolean));
      page = pages.find((p) => p.products.some((x) => x.sku && skus.has(x.sku)));
    }
    if (page) pairs.push({ url: page.url, catalog: c, page: page.products[0]! });
  }
  return pairs;
}

function noPairs(ctx: ScanContext) {
  if (!(ctx.state.catalog?.products.length ?? 0))
    return skip('The catalog search returned no products to compare with your product pages.');
  if (!(ctx.state.productPages ?? []).some((p) => p.products.length))
    return skip('No sampled page had Product structured data to compare with the catalog.');
  return null;
}

const pageCurrencies = (p: ExtractedProduct) =>
  new Set(p.offers.map((o) => o.priceCurrency?.toUpperCase()).filter((x): x is string => !!x));
const catalogCurrencies = (c: CatalogProduct) =>
  new Set(
    c.variants
      .map((v) => (typeof v.currency === 'string' ? v.currency.toUpperCase() : undefined))
      .filter((x): x is string => !!x),
  );

export const consistencyChecks: CheckDefinition[] = [
  {
    id: 'consistency.price_match',
    title: 'Catalog prices match product pages',
    category: 'consistency',
    severity: 'critical',
    phase: 'consistency',
    requires: { capability: CATALOG_CAPABILITY },
    why: 'If the API and the page disagree on price, agents cannot trust either and may drop the product.',
    async run(ctx) {
      const np = noPairs(ctx);
      if (np) return np;
      const pairs = matchPairs(ctx);
      if (!pairs.length)
        return skip('No product appeared both in the catalog response and among sampled pages.');
      const mismatches: { url: string; page: string; catalog: string }[] = [];
      let compared = 0;
      for (const { url, catalog, page } of pairs) {
        const pageOffer = page.offers.find((o) => (o.price ?? o.lowPrice) && o.priceCurrency);
        if (!pageOffer) continue;
        const currency = pageOffer.priceCurrency!.toUpperCase();
        const pageMinor = decimalToMinor(pageOffer.price ?? pageOffer.lowPrice!, currency);
        const amounts = catalog.variants
          .filter(
            (v) =>
              typeof v.currency === 'string' &&
              v.currency.toUpperCase() === currency &&
              Number.isInteger(v.amount),
          )
          .map((v) => v.amount as number);
        if (pageMinor === null || amounts.length === 0) continue;
        compared++;
        // Single price: must equal some variant price. Price range (lowPrice): must equal the lowest variant price.
        const ok =
          pageOffer.price !== undefined ? amounts.includes(pageMinor) : Math.min(...amounts) === pageMinor;
        if (!ok) {
          mismatches.push({
            url,
            page: `${pageOffer.price ?? `from ${pageOffer.lowPrice}`} ${currency}`,
            catalog: amounts
              .slice(0, 5)
              .map((a) => formatMinor(a, currency))
              .join(', '),
          });
        }
      }
      if (compared === 0) return skip('Matched products had no comparable price in the same currency.');
      const ev = mismatches.slice(0, 10).map((m) => ({
        label: 'Price mismatch',
        url: m.url,
        expected: `page price: ${truncate(m.page, 60)}`,
        found: `catalog: ${truncate(m.catalog, 120)}`,
      }));
      if (mismatches.length)
        return result(
          'fail',
          `${mismatches.length} of ${compared} products have a different price in the catalog API than on the product page.`,
          ev,
        );
      return result(
        'pass',
        `Prices match exactly for all ${compared} products found in both the catalog and on product pages.`,
      );
    },
  },
  {
    id: 'consistency.availability_match',
    title: 'Catalog availability matches product pages',
    category: 'consistency',
    severity: 'high',
    phase: 'consistency',
    requires: { capability: CATALOG_CAPABILITY },
    why: 'An agent that offers an item the page says is sold out creates a failed purchase.',
    async run(ctx) {
      const np = noPairs(ctx);
      if (np) return np;
      const bad: { url: string; page: string; catalog: string }[] = [];
      let compared = 0;
      for (const { url, catalog, page } of matchPairs(ctx)) {
        const pageVals = page.offers
          .map((o) => availabilityIsInStock(o.availability))
          .filter((x): x is boolean => x !== null);
        const catVals = catalog.variants
          .map((v) => v.available)
          .filter((x): x is boolean => typeof x === 'boolean');
        if (!pageVals.length || !catVals.length) continue;
        compared++;
        const pageIn = pageVals.includes(true);
        const catIn = catVals.includes(true);
        if (pageIn !== catIn)
          bad.push({
            url,
            page: pageIn ? 'in stock' : 'out of stock',
            catalog: catIn ? 'available' : 'not available',
          });
      }
      if (compared === 0) return skip('Matched products did not state availability in both places.');
      if (bad.length)
        return result(
          'fail',
          `${bad.length} of ${compared} products disagree on availability between the catalog and the page.`,
          bad.slice(0, 10).map((b) => ({
            label: 'Availability mismatch',
            url: b.url,
            expected: `page: ${b.page}`,
            found: `catalog: ${b.catalog}`,
          })),
        );
      return result('pass', `Availability agrees for all ${compared} compared products.`);
    },
  },
  {
    id: 'consistency.currency_match',
    title: 'Catalog currency matches product pages',
    category: 'consistency',
    severity: 'high',
    phase: 'consistency',
    requires: { capability: CATALOG_CAPABILITY },
    why: 'A currency mismatch makes every price comparison wrong.',
    async run(ctx) {
      const np = noPairs(ctx);
      if (np) return np;
      const bad: { url: string; page: string; catalog: string }[] = [];
      let compared = 0;
      for (const { url, catalog, page } of matchPairs(ctx)) {
        const p = pageCurrencies(page);
        const c = catalogCurrencies(catalog);
        if (!p.size || !c.size) continue;
        compared++;
        if (![...p].some((x) => c.has(x)))
          bad.push({ url, page: [...p].join(', '), catalog: [...c].join(', ') });
      }
      if (compared === 0) return skip('Matched products did not state a currency in both places.');
      if (bad.length)
        return result(
          'fail',
          `${bad.length} of ${compared} products use a different currency in the catalog than on the page.`,
          bad.slice(0, 10).map((b) => ({
            label: 'Currency mismatch',
            url: b.url,
            expected: `page: ${truncate(b.page, 40)}`,
            found: `catalog: ${truncate(b.catalog, 40)}`,
          })),
        );
      return result('pass', `Currencies agree for all ${compared} compared products.`);
    },
  },
];
