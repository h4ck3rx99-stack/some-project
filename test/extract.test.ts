import { describe, expect, it } from 'vitest';
import { extractProductPage, parseSitemapLocs, sampleEvenly, isSitemapIndex } from '../src/checks/products';
import { availabilityName, extractHtml } from '../src/scan/extract';
import { decimalToMinor, formatMinor, priceFormatProblem } from '../src/lib/money';
import { fixture } from './fixtures';

const page = (f: string) =>
  extractProductPage('https://s.example.com/p', 200, fixture(`pages/${f}`, 's.example.com'));

describe('JSON-LD extraction', () => {
  it('complete product', async () => {
    const p = await page('product.complete.html');
    expect(p.products).toHaveLength(1);
    const x = p.products[0]!;
    expect(x).toMatchObject({
      type: 'Product',
      name: 'Blue Runner Pro',
      hasImage: true,
      hasBrand: true,
      sku: 'BRP-BLU-10',
      gtin: '0012345678905',
    });
    expect(x.offers[0]).toMatchObject({
      price: '120.00',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      hasShippingDetails: true,
      hasReturnPolicy: true,
    });
  });

  it('@graph with organization return policy and offers array', async () => {
    const p = await page('product.graph.html');
    expect(p.jsonLdBlocks).toBe(2);
    expect(p.products).toHaveLength(1);
    expect(p.products[0]).toMatchObject({
      name: 'Trail Jacket',
      mpn: 'TJ-2026',
      hasReturnPolicy: true,
      hasImage: true,
    });
    expect(p.products[0]!.offers[0]!.price).toBe('89.50');
  });

  it('ProductGroup folds variants (inside an HTML comment wrapper)', async () => {
    const p = await page('product.variants.html');
    expect(p.products).toHaveLength(1);
    const g = p.products[0]!;
    expect(g.type).toBe('ProductGroup');
    expect(g.offers).toHaveLength(2);
    expect(g.sku).toBe('MT-BLK-S');
    expect(g.offers.every((o) => o.hasReturnPolicy)).toBe(true);
  });

  it('no JSON-LD', async () => {
    const p = await page('product.no-jsonld.html');
    expect(p.products).toHaveLength(0);
    expect(p.jsonLdBlocks).toBe(0);
  });

  it('array wrapper, AggregateOffer, and an unparseable block', async () => {
    const p = await page('product.missing-identifiers.html');
    expect(p.jsonLdErrors).toBe(1);
    expect(p.products[0]).toMatchObject({ name: 'Water Bottle', hasBrand: false });
    expect(p.products[0]!.offers[0]).toMatchObject({ lowPrice: '12.5', highPrice: '18.00' });
    expect(p.products[0]!.sku).toBeUndefined();
  });

  it('hostile page: extracted but strings are capped', async () => {
    const p = await page('product.hostile.html');
    expect(p.products).toHaveLength(1);
    expect(p.products[0]!.name!.length).toBeLessThanOrEqual(300);
    expect(p.products[0]!.name).toContain('<script>');
  });

  it('reads <title>', async () => {
    expect((await extractHtml('<html><head><title> A  &amp; B </title></head></html>')).title).toBe(
      'A &amp; B',
    );
  });

  it('availability URLs', () => {
    expect(availabilityName('https://schema.org/InStock')).toBe('InStock');
    expect(availabilityName('http://schema.org/OutOfStock')).toBe('OutOfStock');
    expect(availabilityName('InStock')).toBeNull();
    expect(availabilityName('https://schema.org/Banana')).toBeNull();
  });
});

describe('sitemaps & sampling', () => {
  it('parses locs and detects indexes', () => {
    const idx = fixture('sitemaps/index.xml', 's.example.com');
    expect(isSitemapIndex(idx)).toBe(true);
    expect(parseSitemapLocs(idx)).toContain('https://s.example.com/product-sitemap.xml');
    expect(
      parseSitemapLocs(
        '<urlset><url><loc><![CDATA[https://a.example.com/p?a=1&amp;b=2]]></loc></url></urlset>',
      ),
    ).toEqual(['https://a.example.com/p?a=1&b=2']);
  });
  it('samples evenly across the list', () => {
    const list = Array.from({ length: 100 }, (_, i) => i);
    expect(sampleEvenly(list, 4)).toEqual([0, 25, 50, 75]);
    expect(sampleEvenly([1, 2], 5)).toEqual([1, 2]);
  });
});

describe('money', () => {
  it('converts decimals to minor units exactly', () => {
    expect(decimalToMinor('120.00', 'USD')).toBe(12000);
    expect(decimalToMinor('89.5', 'USD')).toBe(8950);
    expect(decimalToMinor('1500', 'JPY')).toBe(1500);
    expect(decimalToMinor('1.234', 'KWD')).toBe(1234);
    expect(decimalToMinor('19.999', 'USD')).toBeNull();
    expect(decimalToMinor('1,299.00', 'USD')).toBeNull();
    expect(formatMinor(11000, 'USD')).toBe('110.00 USD');
  });
  it('validates price formats', () => {
    expect(priceFormatProblem('19.99', 'USD')).toBeNull();
    expect(priceFormatProblem('19.990', 'USD')).toBeNull();
    expect(priceFormatProblem('$19.99', 'USD')).toContain('not a plain decimal');
    expect(priceFormatProblem('19.999', 'USD')).toContain('more than 2 decimal places');
    expect(priceFormatProblem('0.00', 'USD')).toContain('not positive');
    expect(priceFormatProblem('100.5', 'JPY')).toContain('more than 0');
  });
});
