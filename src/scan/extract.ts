/**
 * HTML + JSON-LD extraction using the Workers built-in HTMLRewriter (streaming, no DOM,
 * no dependency). Scanned HTML is never rendered; we only pull out <title> and
 * <script type="application/ld+json"> text, capped in size.
 */
import type { ExtractedOffer, ExtractedProduct } from './types';

const MAX_JSONLD_CHARS = 1_500_000;
/** Extracted strings are attacker-controlled: keep them short in scan state. */
const MAX_FIELD_CHARS = 300;
const MAX_BLOCKS = 20;

export interface HtmlExtract {
  title?: string;
  jsonLd: string[];
}

export async function extractHtml(html: string): Promise<HtmlExtract> {
  const out: HtmlExtract = { jsonLd: [] };
  let inLd = false;
  let buf = '';
  let titleBuf = '';
  let inTitle = false;
  let total = 0;
  const rewriter = new HTMLRewriter()
    .on('script', {
      element(el) {
        const type = (el.getAttribute('type') ?? '').toLowerCase().split(';')[0]!.trim();
        inLd = type === 'application/ld+json' && out.jsonLd.length < MAX_BLOCKS;
        buf = '';
        if (inLd) {
          el.onEndTag(() => {
            if (buf.trim()) out.jsonLd.push(buf);
            inLd = false;
            buf = '';
          });
        }
      },
      text(t) {
        if (!inLd) return;
        if (total + t.text.length <= MAX_JSONLD_CHARS) {
          buf += t.text;
          total += t.text.length;
        }
      },
    })
    .on('title', {
      element(el) {
        if (out.title !== undefined) return;
        inTitle = true;
        titleBuf = '';
        el.onEndTag(() => {
          out.title = titleBuf.replace(/\s+/g, ' ').trim().slice(0, 300);
          inTitle = false;
        });
      },
      text(t) {
        if (inTitle && titleBuf.length < 1000) titleBuf += t.text;
      },
    });
  await rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html' } })).arrayBuffer();
  return out;
}

/** Parse JSON-LD blocks leniently (strip HTML comments / CDATA wrappers some themes add). */
export function parseJsonLdBlocks(blocks: string[]): { nodes: unknown[]; errors: number } {
  const nodes: unknown[] = [];
  let errors = 0;
  for (const raw of blocks) {
    const cleaned = raw
      .replace(/^\s*<!--/, '')
      .replace(/-->\s*$/, '')
      .replace(/^\s*\/\/\s*<!\[CDATA\[/, '')
      .replace(/\/\/\s*\]\]>\s*$/, '')
      .trim();
    try {
      nodes.push(JSON.parse(cleaned));
    } catch {
      errors++;
    }
  }
  return { nodes, errors };
}

function types(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  const arr = Array.isArray(t) ? t : [t];
  return arr.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^https?:\/\/schema\.org\//, ''));
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim().slice(0, MAX_FIELD_CHARS) || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function present(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.some(present);
  return true;
}

function asArray(v: unknown): unknown[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractOffers(v: unknown): ExtractedOffer[] {
  const out: ExtractedOffer[] = [];
  for (const o of asArray(v)) {
    if (!isObj(o)) continue;
    const t = types(o);
    // AggregateOffer may also nest concrete offers.
    if (t.includes('AggregateOffer') && o.offers) out.push(...extractOffers(o.offers));
    const priceSpec = asArray(o.priceSpecification).find(isObj);
    out.push({
      price: str(o.price) ?? (priceSpec ? str(priceSpec.price) : undefined),
      lowPrice: str(o.lowPrice),
      highPrice: str(o.highPrice),
      priceCurrency: str(o.priceCurrency) ?? (priceSpec ? str(priceSpec.priceCurrency) : undefined),
      availability: str(o.availability),
      hasShippingDetails: present(o.shippingDetails),
      hasReturnPolicy: present(o.hasMerchantReturnPolicy),
    });
  }
  return out;
}

function gtinOf(n: Record<string, unknown>): string | undefined {
  for (const k of ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'isbn']) {
    const v = str(n[k]);
    if (v) return v;
  }
  return undefined;
}

function toProduct(n: Record<string, unknown>, type: 'Product' | 'ProductGroup'): ExtractedProduct {
  const p: ExtractedProduct = {
    type,
    name: str(n.name),
    hasImage: present(n.image),
    hasBrand: present(n.brand),
    sku: str(n.sku),
    gtin: gtinOf(n),
    mpn: str(n.mpn),
    url: str(n.url),
    offers: extractOffers(n.offers),
    hasReturnPolicy: present(n.hasMerchantReturnPolicy),
  };
  if (type === 'ProductGroup') {
    for (const v of asArray(n.hasVariant)) {
      if (!isObj(v)) continue;
      p.offers.push(...extractOffers(v.offers));
      p.sku ??= str(v.sku);
      p.gtin ??= gtinOf(v);
      p.mpn ??= str(v.mpn);
      p.hasImage ||= present(v.image);
      p.hasBrand ||= present(v.brand);
      p.hasReturnPolicy ||= present(v.hasMerchantReturnPolicy);
    }
  }
  return p;
}

/**
 * Find Product / ProductGroup nodes anywhere in parsed JSON-LD (arrays, @graph, nesting).
 * Variants listed under a ProductGroup are folded into the group, not reported separately.
 * Organization-level hasMerchantReturnPolicy is reported via `orgReturnPolicy`.
 */
export function findProducts(nodes: unknown[]): { products: ExtractedProduct[]; orgReturnPolicy: boolean } {
  const products: ExtractedProduct[] = [];
  let orgReturnPolicy = false;
  const seen = new Set<unknown>();
  let budget = 20_000;
  const walk = (v: unknown, insideGroup: boolean): void => {
    if (budget-- <= 0 || v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, insideGroup);
      return;
    }
    const n = v as Record<string, unknown>;
    const t = types(n);
    if (t.includes('ProductGroup')) {
      products.push(toProduct(n, 'ProductGroup'));
      for (const [k, child] of Object.entries(n)) if (k !== 'hasVariant') walk(child, true);
      for (const variant of asArray(n.hasVariant)) seen.add(variant);
      return;
    }
    if (t.includes('Product') && !insideGroup) {
      products.push(toProduct(n, 'Product'));
    }
    if ((t.includes('Organization') || t.includes('OnlineStore') || t.includes('Store')) && present(n.hasMerchantReturnPolicy)) {
      orgReturnPolicy = true;
    }
    for (const child of Object.values(n)) walk(child, insideGroup);
  };
  walk(nodes, false);
  if (orgReturnPolicy) for (const p of products) p.hasReturnPolicy = true;
  return { products, orgReturnPolicy };
}

export const IN_STOCK_VALUES = ['InStock', 'LimitedAvailability', 'OnlineOnly', 'InStoreOnly', 'PreOrder', 'PreSale', 'BackOrder', 'MadeToOrder'];
export const OUT_OF_STOCK_VALUES = ['OutOfStock', 'SoldOut', 'Discontinued'];
const ALL_AVAILABILITY = [...IN_STOCK_VALUES, ...OUT_OF_STOCK_VALUES, 'Reserved'];

/** schema.org ItemAvailability URL (http/https, schema.org/…) → short name, or null. */
export function availabilityName(v: string | undefined): string | null {
  if (!v) return null;
  const m = /^https?:\/\/schema\.org\/([A-Za-z]+)$/.exec(v.trim());
  if (!m) return null;
  return ALL_AVAILABILITY.includes(m[1]!) ? m[1]! : null;
}

/** Lenient: accepts short names too; used for consistency comparison only. */
export function availabilityIsInStock(v: string | undefined): boolean | null {
  if (!v) return null;
  const name = v.trim().replace(/^https?:\/\/schema\.org\//, '');
  if (IN_STOCK_VALUES.includes(name)) return true;
  if (OUT_OF_STOCK_VALUES.includes(name)) return false;
  return null;
}
