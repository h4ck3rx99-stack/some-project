import { describe, expect, it } from 'vitest';
import { renderToString } from 'hono/jsx/dom/server';
import { CHECKS } from '../src/checks/registry';
import { FIX_GUIDES } from '../src/content/fixGuides.generated';
import { ReportBody } from '../src/views/report';
import { runScan } from './helpers';
import { fixture } from './fixtures';
import { mockStore } from './mock-store/app';
import type { CheckRecord } from '../src/scan/types';
import type { ScanRow } from '../src/views/report';

// Bundled at build time by Vite: every template/source file and every fix guide.
const SOURCES = import.meta.glob(
  ['../src/**/*.{ts,tsx}', '!../src/**/*.generated.ts', '!../src/ucp/generated/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;
const GUIDES_MD = import.meta.glob('../content/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const DOCS_MD = import.meta.glob(['../docs/**/*.md', '../README.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const FORBIDDEN = /\b(compliant|certified|guaranteed|ai visibility guaranteed)\b/i;

describe('claims discipline', () => {
  it('no forbidden claim words in source, templates, fix guides or docs', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(30);
    expect(Object.keys(GUIDES_MD).length).toBe(CHECKS.length);
    const hits: string[] = [];
    for (const [file, text] of Object.entries({ ...SOURCES, ...GUIDES_MD, ...DOCS_MD })) {
      text.split('\n').forEach((line, i) => {
        // The forbidden-words list itself is allowed to name them.
        if (FORBIDDEN.test(line) && !line.includes('FORBIDDEN') && !line.includes('forbidden'))
          hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe('CSP compatibility', () => {
  it('views and routes use no inline style attributes (blocked by style-src self)', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([f]) => f.endsWith('.tsx'))
      .flatMap(([f, text]) => text.split('\n').map((l, i) => [f, i + 1, l] as const))
      .filter(([, , l]) => /\sstyle=/.test(l))
      .map(([f, i, l]) => `${f}:${i}: ${l.trim()}`);
    expect(offenders).toEqual([]);
  });
});

describe('fix guides', () => {
  it('every check has a fix guide with fix, WooCommerce and verify sections', () => {
    for (const c of CHECKS) {
      const g = FIX_GUIDES[c.id];
      expect(g, c.id).toBeDefined();
      expect(g!.markdown).toContain('## How to fix');
      expect(g!.markdown).toContain('## WooCommerce');
      expect(g!.markdown).toContain('## How to verify');
      expect(g!.markdown).toContain('## Spec reference');
    }
    expect(Object.keys(FIX_GUIDES).sort()).toEqual(CHECKS.map((c) => c.id).sort());
  });

  it('check ids are unique and well formed', () => {
    const ids = CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CHECKS) expect(c.id.startsWith(`${c.category}.`)).toBe(true);
  });
});

const baseScan: ScanRow = {
  id: 'scn_x',
  storeId: null,
  accountId: null,
  domain: 'evil.example.com',
  url: 'https://evil.example.com',
  trigger: 'anonymous',
  requesterIpHash: null,
  status: 'done',
  phase: 'done',
  score: 12,
  grade: 'Not ready',
  categoryScoresJson: null,
  specVersionSeen: '<img src=x onerror=alert(9)>',
  productsSampled: 1,
  requestsMade: 3,
  includeCheckout: 0,
  alertedAt: null,
  publicSlug: 'abc',
  isPublic: 0,
  startedAt: null,
  finishedAt: Date.now(),
  createdAt: Date.now(),
};

describe('hostile content is escaped', () => {
  it('renders attacker-controlled strings as text', () => {
    const r: CheckRecord = {
      checkId: 'products.price_format',
      title: 'Prices are machine-readable',
      category: 'products',
      severity: 'medium',
      status: 'fail',
      summary: '<script>alert(1)</script> ‮evil',
      fixGuide: 'products.price_format',
      evidence: [
        {
          label: '<b>label</b>',
          url: 'javascript:alert(2)',
          expected: '"><svg onload=alert(3)>',
          found: "</code><script>alert('x')</script>",
        },
      ],
    };
    const html = renderToString(<ReportBody scan={baseScan} results={[r]} />);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>label</b>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(9)&gt;');
  });

  it('a scan of a hostile store page produces truncated, escaped evidence', async () => {
    const host = 'hostile.mockstore.test';
    const r = await runScan(host, {}, async (req) => {
      const u = new URL(req.url);
      if (u.pathname.startsWith('/product/'))
        return new Response(fixture('pages/product.hostile.html', host), {
          headers: { 'content-type': 'text/html' },
        });
      return mockStore.fetch(req) as Promise<Response>;
    });
    const all = Object.values(r.results);
    const longest = Math.max(
      ...all.flatMap((x) =>
        x.evidence.flatMap((e) =>
          [e.label, e.url ?? '', e.expected ?? '', e.found ?? ''].map((s) => s.length),
        ),
      ),
    );
    expect(longest).toBeLessThanOrEqual(501);
    const evidence = JSON.stringify(all.map((x) => x.evidence));
    expect(evidence).toContain('<b>9.99</b>'); // raw in data…
    const html = renderToString(
      <ReportBody scan={{ ...baseScan, specVersionSeen: '2026-08-25' }} results={all} />,
    );
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toContain('<b>9.99</b>'); // …escaped on render
    expect(html).toContain('&lt;b&gt;9.99&lt;/b&gt;');
    expect(html.length).toBeLessThan(100_000);
  });
});
