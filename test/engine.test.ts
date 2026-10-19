import { beforeEach, describe, expect, it } from 'vitest';
import { CHECKS } from '../src/checks/registry';
import { runScan } from './helpers';
import { resetMockStore } from './mock-store/app';

beforeEach(() => resetMockStore());

describe('engine against mock store variants', () => {
  it('good store: every check passes or is legitimately skipped', async () => {
    const r = await runScan('good.mockstore.test');
    const notPass = Object.values(r.results).filter((x) => x.status !== 'pass' && x.status !== 'skip');
    expect(notPass.map((x) => `${x.checkId}: ${x.status} ${x.summary}`)).toEqual([]);
    expect(r.status('consistency.price_match')).toBe('pass');
    expect(r.status('products.jsonld_present')).toBe('pass');
    expect(r.status('checkout.session_create')).toBe('skip');
    expect(r.score.score).toBe(100);
    expect(r.score.grade).toBe('Agent-ready');
    expect(r.phases).toEqual([
      'discovery',
      'catalog',
      'products:0',
      'consistency',
      'basics',
      'checkout',
      'finalize',
    ]);
    expect(Object.keys(r.results).sort()).toEqual(CHECKS.map((c) => c.id).sort());
    expect(r.state.sampled).toHaveLength(3);
  });

  it('outdated store: version check warns', async () => {
    const r = await runScan('outdated.mockstore.test');
    expect(r.status('discovery.version_current')).toBe('warn');
    expect(r.results['discovery.version_current']!.summary).toContain('2026-04-08');
    expect(r.results['discovery.version_current']!.summary).toContain('2026-08-25');
    expect(r.status('discovery.profile_schema_valid')).toBe('pass');
  });

  it('broken profile: parse fails, dependants skip', async () => {
    const r = await runScan('broken-profile.mockstore.test');
    expect(r.status('discovery.profile_reachable')).toBe('pass');
    expect(r.status('discovery.profile_content_type')).toBe('fail');
    expect(r.status('discovery.profile_parses')).toBe('fail');
    expect(r.status('discovery.profile_schema_valid')).toBe('skip');
    expect(r.results['discovery.profile_schema_valid']!.summary).toContain('Profile is valid JSON');
    expect(r.status('catalog.search_responds')).toBe('skip');
  });

  it('no-ucp store: profile fails, catalog excluded, products still scored', async () => {
    const r = await runScan('no-ucp.mockstore.test');
    expect(r.status('discovery.profile_reachable')).toBe('fail');
    expect(r.status('catalog.search_responds')).toBe('skip');
    expect(r.status('products.jsonld_present')).toBe('pass');
    const cat = r.score.categories.find((c) => c.category === 'catalog')!;
    expect(cat.score).toBeNull();
    expect(r.score.score).toBe(39);
    expect(r.score.cappedBy).toBe('discovery.profile_reachable');
  });

  it('price-mismatch store: price check fails with evidence', async () => {
    const r = await runScan('price-mismatch.mockstore.test');
    expect(r.status('consistency.price_match')).toBe('fail');
    const ev = r.results['consistency.price_match']!.evidence[0]!;
    expect(ev.url).toBe('https://price-mismatch.mockstore.test/product/blue-runner-pro');
    expect(ev.expected).toContain('120.00 USD');
    expect(ev.found).toContain('110.00 USD');
  });

  it('blocks-robots store: products not fetched, robots warns', async () => {
    const r = await runScan('blocks-robots.mockstore.test');
    expect(r.status('basics.robots_allows_products')).toBe('warn');
    expect(r.results['basics.robots_allows_products']!.evidence[0]!.found).toContain('Disallow /product/');
    expect(r.state.sampled).toHaveLength(0);
    expect(r.status('products.jsonld_present')).toBe('skip');
  });

  it('slow store: latency checks degrade', async () => {
    const r = await runScan('slow.mockstore.test');
    expect(r.status('discovery.profile_latency')).toBe('fail');
    expect(r.status('basics.homepage_ttfb')).toBe('fail');
  });

  it('redirect-loop store: profile redirect is reported, not followed', async () => {
    const r = await runScan('redirect-loop.mockstore.test');
    expect(r.status('discovery.profile_reachable')).toBe('fail');
    expect(r.results['discovery.profile_reachable']!.summary).toContain('redirects');
    expect(r.status('basics.homepage_ttfb')).toBe('fail');
  });

  it('redirect-to-private store: private redirect targets are never fetched', async () => {
    const seen: string[] = [];
    const { mockStore } = await import('./mock-store/app');
    const r = await runScan('redirect-to-private.mockstore.test', {}, async (req) => {
      seen.push(req.url);
      return mockStore.fetch(req) as Promise<Response>;
    });
    expect(seen.some((u) => /127\.0\.0\.1|10\.0\.0\.1|192\.168/.test(u))).toBe(false);
    expect(r.status('basics.homepage_ttfb')).toBe('fail');
    expect(r.state.homepage!.fetch.error?.kind).toBe('blocked_url');
  });

  it('verified store in test mode runs and cleans up a checkout session', async () => {
    const r = await runScan('good.mockstore.test', {
      verifiedOwnership: true,
      testModeConfirmed: true,
      testCheckoutEndpoint: 'https://good.mockstore.test/ucp/v1',
    });
    expect(r.status('checkout.session_create')).toBe('pass');
    expect(r.status('checkout.session_totals_integer')).toBe('pass');
    expect(r.status('checkout.session_cleanup')).toBe('pass');
    expect(r.score.categories.find((c) => c.category === 'checkout')!.score).toBe(100);
  });

  it('checkout deep checks never run against an endpoint off the verified domain', async () => {
    const r = await runScan('good.mockstore.test', {
      verifiedOwnership: true,
      testModeConfirmed: true,
      testCheckoutEndpoint: 'https://other.mockstore.test/ucp/v1',
    });
    expect(r.status('checkout.session_create')).toBe('skip');
  });

  it('a throwing check becomes error and the scan continues', async () => {
    const def = CHECKS.find((c) => c.id === 'basics.sitemap_found')!;
    const orig = def.run;
    def.run = async () => {
      throw new Error('boom');
    };
    try {
      const r = await runScan('good.mockstore.test');
      expect(r.status('basics.sitemap_found')).toBe('error');
      expect(r.results['basics.sitemap_found']!.evidence[0]!.found).toContain('boom');
      expect(r.status('checkout.capability_declared')).toBe('pass');
    } finally {
      def.run = orig;
    }
  });
});
