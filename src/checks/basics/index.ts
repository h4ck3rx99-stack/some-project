import { LATENCY } from '../../config/weights';
import type { CheckDefinition, ScanContext } from '../../scan/types';
import { fetchRobots } from '../products';
import { describeFetch, result, skip, summarize } from '../helpers';

export async function prepareBasics(ctx: ScanContext): Promise<void> {
  await fetchRobots(ctx);
  if (!ctx.state.homepage) {
    const home = await ctx.http.fetch(ctx.url + '/', { accept: 'text/html', maxBytes: 1_500_000 });
    ctx.state.homepage = { fetch: summarize(home) };
  }
}

export const basicsChecks: CheckDefinition[] = [
  {
    id: 'basics.https_redirect',
    title: 'HTTP redirects to HTTPS',
    category: 'basics',
    severity: 'medium',
    phase: 'basics',
    why: 'Links shared as http:// should land on your secure site, which is the only one agents will use.',
    async run(ctx) {
      const httpUrl = `http://${ctx.domain}/`;
      // The one request CartProbe ever sends over plain http, with the same guards (port 80 only).
      const r = await ctx.http.fetch(httpUrl, {
        allowHttp: true,
        maxRedirects: 0,
        method: 'GET',
        maxBytes: 64_000,
        timeoutMs: 5000,
      });
      const loc = r.redirects[0]?.to ?? r.headers.location;
      const ev = [
        {
          label: 'Request',
          url: httpUrl,
          expected: '301/308 redirect to https://',
          found: r.error ? describeFetch(summarize(r)) : `HTTP ${r.status}${loc ? ` → ${loc}` : ''}`,
        },
      ];
      if (r.error?.kind === 'blocked_url' && loc?.startsWith('https://'))
        return result('pass', 'http:// redirects to https://.', ev);
      if (r.error)
        return result('warn', 'We could not reach your site over http:// to check the redirect.', ev);
      if (r.status >= 300 && r.status < 400 && loc?.startsWith('https://')) {
        return result(
          r.status === 301 || r.status === 308 ? 'pass' : 'warn',
          r.status === 301 || r.status === 308
            ? 'http:// permanently redirects to https://.'
            : `http:// redirects to https:// with a temporary ${r.status}; use 301 or 308.`,
          ev,
        );
      }
      return result('fail', `http:// does not redirect to https:// (HTTP ${r.status}).`, ev);
    },
  },
  {
    id: 'basics.homepage_ttfb',
    title: 'Homepage responds quickly',
    category: 'basics',
    severity: 'low',
    phase: 'basics',
    why: 'A slow origin slows every page and API call an agent makes.',
    async run(ctx) {
      const f = ctx.state.homepage!.fetch;
      const ev = [
        {
          label: 'Homepage',
          url: ctx.url + '/',
          expected: `< ${LATENCY.homepageTtfb.pass} ms to first byte`,
          found: describeFetch(f),
        },
      ];
      if (f.error || f.status >= 400)
        return result(
          'fail',
          `Your homepage did not load (${f.error ? f.error.kind.replace(/_/g, ' ') : `HTTP ${f.status}`}).`,
          ev,
        );
      if (f.ttfbMs < LATENCY.homepageTtfb.pass)
        return result('pass', `Your homepage responded in ${f.ttfbMs} ms.`, ev);
      if (f.ttfbMs < LATENCY.homepageTtfb.warn)
        return result('warn', `Your homepage took ${f.ttfbMs} ms to respond.`, ev);
      return result('fail', `Your homepage took ${f.ttfbMs} ms to respond.`, ev);
    },
  },
  {
    id: 'basics.robots_present',
    title: 'robots.txt is present',
    category: 'basics',
    severity: 'low',
    phase: 'basics',
    why: 'robots.txt tells crawlers and agents what they may fetch and where your sitemaps are.',
    async run(ctx) {
      const f = ctx.state.robots!.fetch;
      const ev = [
        { label: 'Request', url: ctx.url + '/robots.txt', expected: 'HTTP 200', found: describeFetch(f) },
      ];
      if (f.ok) return result('pass', 'robots.txt is reachable.', ev);
      return result('warn', 'robots.txt is missing or unreachable.', ev);
    },
  },
  {
    id: 'basics.robots_allows_products',
    title: 'robots.txt allows product pages',
    category: 'basics',
    severity: 'medium',
    phase: 'basics',
    why: 'If robots.txt blocks product pages, well-behaved agents and crawlers will not read them.',
    async run(ctx) {
      const blocked = ctx.state.robotsBlocked ?? [];
      const total = (ctx.state.productUrls?.length ?? 0) + blocked.length;
      if (total === 0) return skip('No product URLs were found to test against robots.txt.');
      if (blocked.length) {
        return result(
          'warn',
          `robots.txt blocks ${blocked.length} product URL${blocked.length === 1 ? '' : 's'} for CartProbeBot (and likely other agents).`,
          blocked.slice(0, 10).map((b) => ({ label: 'Blocked', url: b.url, found: b.rule })),
        );
      }
      return result('pass', `robots.txt allows all ${total} product URLs we found.`);
    },
  },
  {
    id: 'basics.sitemap_found',
    title: 'Product sitemap found',
    category: 'basics',
    severity: 'low',
    phase: 'basics',
    why: 'A product sitemap is how agents and crawlers find all your products.',
    async run(ctx) {
      const s = ctx.state.sitemaps;
      const ev = [{ label: 'Sitemaps tried', found: s?.tried.join(', ') || '(none)' }];
      if (s?.productSitemap)
        return result('pass', `Found a product sitemap at ${s.productSitemap}.`, [
          { label: 'Product sitemap', url: s.productSitemap },
        ]);
      if (s?.found.length) return result('warn', 'We found a sitemap, but no product URLs in it.', ev);
      return result('fail', 'We found no sitemap listing your products.', ev);
    },
  },
];
