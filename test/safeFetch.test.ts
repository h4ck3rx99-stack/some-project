import { describe, expect, it } from 'vitest';
import { checkUrl, FetchSession, safeFetch, type FetchLike } from '../src/lib/safeFetch';

function router(
  routes: Record<string, (req: Request) => Response | Promise<Response>>,
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (req: Request) => {
    calls.push(req.url);
    const h = routes[req.url];
    if (!h) return new Response('not found', { status: 404 });
    return h(req);
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('checkUrl', () => {
  const blocked = [
    'http://shop.example.com/',
    'ftp://shop.example.com/',
    'https://127.0.0.1/',
    'https://10.0.0.1/x',
    'https://[::1]/',
    'https://[fe80::1]/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://0x7f.1/',
    'https://localhost/',
    'https://foo.localhost/',
    'https://printer.local/',
    'https://metadata.google.internal/',
    'https://intranet/',
    'https://shop.example.com:8443/',
    'https://user:pass@shop.example.com/',
    'https://shop.test/',
    'not a url',
  ];
  for (const u of blocked) {
    it(`blocks ${u}`, () => expect(checkUrl(u).ok).toBe(false));
  }
  it('allows normal https hosts, explicit :443 and trailing dot', () => {
    expect(checkUrl('https://shop.example.com/a?b=1').ok).toBe(true);
    expect(checkUrl('https://shop.example.com:443/').ok).toBe(true);
    expect(checkUrl('https://shop.example.com./').ok).toBe(true);
  });
  it('allows http only when asked, on port 80', () => {
    expect(checkUrl('http://shop.example.com/', { allowHttp: true }).ok).toBe(true);
    expect(checkUrl('http://shop.example.com:8080/', { allowHttp: true }).ok).toBe(false);
  });
  it('allows .test only when asked', () => {
    expect(checkUrl('https://good.mockstore.test/', { allowTestTld: true }).ok).toBe(true);
  });
});

describe('safeFetch', () => {
  it('returns a blocked_url error without calling the transport', async () => {
    const f = router({});
    const r = await safeFetch('https://127.0.0.1/', { fetchImpl: f });
    expect(r.error?.kind).toBe('blocked_url');
    expect(f.calls).toHaveLength(0);
  });

  it('fetches JSON and parses it', async () => {
    const f = router({ 'https://a.example.com/x': () => Response.json({ a: 1 }) });
    const r = await safeFetch('https://a.example.com/x', { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(r.json).toEqual({ a: 1 });
    expect(r.contentType).toContain('application/json');
  });

  it('follows a relative redirect and re-validates it', async () => {
    const f = router({
      'https://a.example.com/x': () => new Response(null, { status: 301, headers: { location: '/y' } }),
      'https://a.example.com/y': () => new Response('hi'),
    });
    const r = await safeFetch('https://a.example.com/x', { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(r.finalUrl).toBe('https://a.example.com/y');
    expect(r.redirects).toHaveLength(1);
  });

  it('blocks a redirect from a good host to 127.0.0.1', async () => {
    const f = router({
      'https://a.example.com/x': () =>
        new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } }),
    });
    const r = await safeFetch('https://a.example.com/x', { fetchImpl: f });
    expect(r.error?.kind).toBe('blocked_url');
    expect(f.calls).toEqual(['https://a.example.com/x']);
  });

  it('blocks a redirect to http and to localhost', async () => {
    const f = router({
      'https://a.example.com/1': () =>
        new Response(null, { status: 302, headers: { location: 'http://a.example.com/' } }),
      'https://a.example.com/2': () =>
        new Response(null, { status: 302, headers: { location: 'https://localhost/' } }),
    });
    expect((await safeFetch('https://a.example.com/1', { fetchImpl: f })).error?.kind).toBe('blocked_url');
    expect((await safeFetch('https://a.example.com/2', { fetchImpl: f })).error?.kind).toBe('blocked_url');
  });

  it('detects redirect loops', async () => {
    const f = router({
      'https://a.example.com/x': () => new Response(null, { status: 302, headers: { location: '/y' } }),
      'https://a.example.com/y': () => new Response(null, { status: 302, headers: { location: '/x' } }),
    });
    const r = await safeFetch('https://a.example.com/x', { fetchImpl: f });
    expect(r.error?.kind).toBe('too_many_redirects');
    expect(r.error?.message).toContain('loop');
  });

  it('stops after maxRedirects', async () => {
    const f = router(
      Object.fromEntries(
        [0, 1, 2, 3, 4].map((i) => [
          `https://a.example.com/${i}`,
          () => new Response(null, { status: 302, headers: { location: `/${i + 1}` } }),
        ]),
      ),
    );
    const r = await safeFetch('https://a.example.com/0', { fetchImpl: f });
    expect(r.error?.kind).toBe('too_many_redirects');
    expect(r.redirects).toHaveLength(4);
  });

  it('with maxRedirects=0 returns the 3xx itself', async () => {
    const f = router({
      'https://a.example.com/x': () => new Response(null, { status: 301, headers: { location: '/y' } }),
    });
    const r = await safeFetch('https://a.example.com/x', { fetchImpl: f, maxRedirects: 0 });
    expect(r.status).toBe(301);
    expect(r.error).toBeUndefined();
    expect(r.redirects[0]?.to).toBe('https://a.example.com/y');
  });

  it('times out', async () => {
    const f: FetchLike = (req) =>
      new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    const r = await safeFetch('https://a.example.com/slow', { fetchImpl: f, timeoutMs: 50 });
    expect(r.error?.kind).toBe('timeout');
  });

  it('caps the body size and marks it truncated', async () => {
    const f = router({ 'https://a.example.com/big': () => new Response('x'.repeat(5000)) });
    const r = await safeFetch('https://a.example.com/big', { fetchImpl: f, maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.bodyText).toHaveLength(1000);
    expect(r.error?.kind).toBe('too_large');
    expect(r.ok).toBe(false);
  });

  it('rejects huge declared content-length before reading', async () => {
    const f = router({
      'https://a.example.com/big': () => new Response('x', { headers: { 'content-length': '999999999' } }),
    });
    const r = await safeFetch('https://a.example.com/big', { fetchImpl: f, maxBytes: 1000 });
    expect(r.error?.kind).toBe('too_large');
  });

  it('turns transport exceptions into network errors', async () => {
    const r = await safeFetch('https://a.example.com/', {
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(r.error?.kind).toBe('network');
  });

  it('enforces requireContentType', async () => {
    const f = router({ 'https://a.example.com/x': () => new Response('<html>') });
    const r = await safeFetch('https://a.example.com/x', { fetchImpl: f, requireContentType: /json/ });
    expect(r.error?.kind).toBe('bad_content_type');
  });
});

describe('FetchSession', () => {
  it('caches GETs, waits between requests to the same domain, and enforces the budget', async () => {
    const f = router({
      'https://a.example.com/1': () => new Response('1'),
      'https://a.example.com/2': () => new Response('2'),
      'https://a.example.com/3': () => new Response('3'),
    });
    let clock = 0;
    const sleeps: number[] = [];
    const s = new FetchSession({ fetchImpl: f, maxRequests: 2, now: () => clock }, async (ms) => {
      sleeps.push(ms);
      clock += ms;
    });
    await s.fetch('https://a.example.com/1');
    await s.fetch('https://a.example.com/1');
    await s.fetch('https://a.example.com/2');
    const third = await s.fetch('https://a.example.com/3');
    expect(f.calls).toEqual(['https://a.example.com/1', 'https://a.example.com/2']);
    expect(sleeps).toEqual([1000]);
    expect(third.error?.kind).toBe('budget_exceeded');
    expect(s.requests).toBe(2);
  });
});
