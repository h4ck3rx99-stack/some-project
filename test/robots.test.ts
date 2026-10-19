import { describe, expect, it } from 'vitest';
import { isAllowed, parseRobots } from '../src/lib/robots';

describe('robots', () => {
  it('collects sitemaps and defaults to allow', () => {
    const r = parseRobots('Sitemap: https://s.example.com/sitemap_index.xml\nUser-agent: *\nDisallow:\n');
    expect(r.sitemaps).toEqual(['https://s.example.com/sitemap_index.xml']);
    expect(isAllowed(r, 'CartProbeBot', '/product/x').allowed).toBe(true);
  });

  it('longest match wins, allow wins ties', () => {
    const r = parseRobots(
      'User-agent: *\nDisallow: /product/\nAllow: /product/public\nAllow: /a\nDisallow: /a\n',
    );
    expect(isAllowed(r, 'CartProbeBot', '/product/x').allowed).toBe(false);
    expect(isAllowed(r, 'CartProbeBot', '/product/public-thing').allowed).toBe(true);
    expect(isAllowed(r, 'CartProbeBot', '/a').allowed).toBe(true);
  });

  it('supports * and $', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*?add-to-cart=\nDisallow: /*.pdf$\n');
    expect(isAllowed(r, 'CartProbeBot', '/shop?add-to-cart=12').allowed).toBe(false);
    expect(isAllowed(r, 'CartProbeBot', '/file.pdf').allowed).toBe(false);
    expect(isAllowed(r, 'CartProbeBot', '/file.pdf?x=1').allowed).toBe(true);
  });

  it('prefers the specific user-agent group over *', () => {
    const r = parseRobots(
      'User-agent: *\nDisallow: /\n\nUser-agent: CartProbeBot\nAllow: /\nDisallow: /cart\n',
    );
    expect(isAllowed(r, 'CartProbeBot', '/product/x').allowed).toBe(true);
    expect(isAllowed(r, 'CartProbeBot', '/cart').allowed).toBe(false);
    expect(isAllowed(r, 'OtherBot', '/product/x').allowed).toBe(false);
  });

  it('merges consecutive user-agent lines into one group and ignores comments', () => {
    const r = parseRobots('User-agent: a\nUser-agent: cartprobebot # us\nDisallow: /private\n');
    const d = isAllowed(r, 'CartProbeBot', '/private/1');
    expect(d.allowed).toBe(false);
    expect(d.rule?.path).toBe('/private');
  });
});
