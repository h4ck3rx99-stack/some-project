import type { FetchLike } from './safeFetch';

/**
 * Outbound transport. In development only (ENVIRONMENT=development and MOCK_STORE_ORIGIN set),
 * requests to *.mockstore.test are routed to the local mock store, after safeFetch has already
 * validated the original URL. Production always uses the global fetch.
 */
export function makeTransport(env: { ENVIRONMENT?: string; MOCK_STORE_ORIGIN?: string }): FetchLike {
  const mock = env.ENVIRONMENT === 'development' && env.MOCK_STORE_ORIGIN ? env.MOCK_STORE_ORIGIN.replace(/\/$/, '') : '';
  return async (req) => {
    const url = new URL(req.url);
    if (mock && url.hostname.endsWith('.mockstore.test')) {
      const headers = new Headers(req.headers);
      headers.set('x-mock-host', url.hostname);
      if (url.protocol === 'http:') headers.set('x-mock-proto', 'http');
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
      return fetch(new Request(mock + url.pathname + url.search, { method: req.method, headers, body, redirect: 'manual', signal: req.signal }));
    }
    return fetch(req);
  };
}

export function allowTestTld(env: { ENVIRONMENT?: string }): boolean {
  return env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
}
