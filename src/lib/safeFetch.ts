/**
 * safeFetch — the security boundary for every outbound request CartProbe makes to a
 * user-supplied URL (scans, ownership verification, alert webhooks).
 *
 * Guarantees:
 *  - only https (http only when `allowHttp` is set, used by the single https-redirect probe)
 *  - no IP-literal, localhost/.local/.internal/single-label hosts, no userinfo, no odd ports
 *  - redirects followed manually (max 3), each Location re-validated, loops detected
 *  - timeout + streamed body with a byte cap
 *  - never throws for network problems: returns a typed error instead
 *
 * Workers cannot resolve DNS before fetching, so we cannot check the resolved IP. Defence in
 * depth: hostname rules here + Cloudflare's egress, which cannot reach private networks.
 * See docs/DECISIONS.md ("SSRF model").
 */

export type FetchLike = (req: Request) => Promise<Response>;

export type SafeFetchErrorKind =
  | 'blocked_url'
  | 'timeout'
  | 'too_large'
  | 'network'
  | 'too_many_redirects'
  | 'bad_content_type'
  | 'budget_exceeded';

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Value for the Accept header. */
  accept?: string;
  /** If set, a response whose content-type does not match yields error `bad_content_type`. */
  requireContentType?: RegExp;
  /** Allow `http:` (only for the https-redirect probe). */
  allowHttp?: boolean;
  /** Allow `*.test` hostnames (development/tests only — used by the mock store). */
  allowTestTld?: boolean;
  /** Transport. Defaults to global fetch. Tests inject the mock store here. */
  fetchImpl?: FetchLike;
  userAgent?: string;
  now?: () => number;
}

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
  redirects: RedirectHop[];
  headers: Record<string, string>;
  contentType: string | null;
  bodyText?: string;
  json?: unknown;
  truncated: boolean;
  timings: { ttfbMs: number; totalMs: number };
  error?: { kind: SafeFetchErrorKind; message: string };
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_BYTES = 2_000_000;
export const DEFAULT_MAX_REDIRECTS = 3;

const SELECTED_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'location',
  'retry-after',
  'x-robots-tag',
  'server',
];

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.home.arpa',
  '.arpa',
  '.onion',
  '.invalid',
  '.example',
];
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Validate a URL against CartProbe's outbound rules. Pure; exported for tests and forms. */
export function checkUrl(input: string, opts: { allowHttp?: boolean; allowTestTld?: boolean } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  const httpAllowed = opts.allowHttp === true;
  if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:')) {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed (https only)` };
  }
  if (url.username || url.password) return { ok: false, reason: 'URLs with credentials are not allowed' };
  // WHATWG URL drops default ports, so a non-empty port is always non-default.
  if (url.port !== '') return { ok: false, reason: `port ${url.port} is not allowed` };

  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'IP address hosts are not allowed' };
  // WHATWG parsing normalises decimal/octal/hex IPv4 forms (e.g. 2130706433, 0x7f.1) to dotted quads.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, reason: 'IP address hosts are not allowed' };
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => l.length === 0)) {
    return { ok: false, reason: 'single-label hosts are not allowed' };
  }
  if (/^(0x[0-9a-f]+|\d+)$/i.test(labels[labels.length - 1]!)) {
    return { ok: false, reason: 'numeric top-level labels are not allowed' };
  }
  if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: `${host} is not allowed` };
  for (const s of BLOCKED_SUFFIXES) {
    if (host.endsWith(s)) return { ok: false, reason: `hosts ending in ${s} are not allowed` };
  }
  if (host.endsWith('.test') && !opts.allowTestTld) return { ok: false, reason: 'hosts ending in .test are not allowed' };
  return { ok: true, url };
}

function pickHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SELECTED_HEADERS) {
    const v = h.get(k);
    if (v !== null) out[k] = v.slice(0, 500);
  }
  return out;
}

function errorResult(
  url: string,
  finalUrl: string,
  redirects: RedirectHop[],
  kind: SafeFetchErrorKind,
  message: string,
  timings = { ttfbMs: 0, totalMs: 0 },
  status = 0,
  headers: Record<string, string> = {},
): SafeFetchResult {
  return {
    ok: false,
    status,
    url,
    finalUrl,
    redirects,
    headers,
    contentType: headers['content-type'] ?? null,
    truncated: false,
    timings,
    error: { kind, message },
  };
}

async function readCapped(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), truncated };
}

function looksJson(ct: string | null): boolean {
  return !!ct && /(^|\/|\+)json\b/i.test(ct);
}

export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((r) => fetch(r));
  const method = opts.method ?? 'GET';
  const redirects: RedirectHop[] = [];
  const started = now();

  const first = checkUrl(input, opts);
  if (!first.ok) return errorResult(input, input, redirects, 'blocked_url', first.reason);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const seen = new Set<string>();
  let current = first.url;
  let currentMethod = method;
  let body = opts.body;

  try {
    for (;;) {
      seen.add(current.href);
      const reqHeaders = new Headers(opts.headers ?? {});
      reqHeaders.set('user-agent', opts.userAgent ?? 'CartProbeBot/1.0');
      if (opts.accept) reqHeaders.set('accept', opts.accept);
      let res: Response;
      try {
        res = await fetchImpl(
          new Request(current.href, {
            method: currentMethod,
            headers: reqHeaders,
            body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : body,
            redirect: 'manual',
            signal: controller.signal,
          }),
        );
      } catch (e) {
        const timedOut = controller.signal.aborted;
        return errorResult(
          input,
          current.href,
          redirects,
          timedOut ? 'timeout' : 'network',
          timedOut ? `no response within ${timeoutMs} ms` : `network error: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
          { ttfbMs: now() - started, totalMs: now() - started },
        );
      }
      const ttfbMs = now() - started;

      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        const location = res.headers.get('location')!;
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return errorResult(input, current.href, redirects, 'network', 'invalid redirect Location header', { ttfbMs, totalMs: now() - started }, res.status, pickHeaders(res.headers));
        }
        redirects.push({ from: current.href, to: next.href, status: res.status });
        await res.body?.cancel().catch(() => undefined);
        if (redirects.length > maxRedirects) {
          // maxRedirects=0 callers want to see the 3xx itself, not an error.
          if (maxRedirects === 0) {
            return {
              ok: false,
              status: res.status,
              url: input,
              finalUrl: current.href,
              redirects,
              headers: pickHeaders(res.headers),
              contentType: res.headers.get('content-type'),
              truncated: false,
              timings: { ttfbMs, totalMs: now() - started },
            };
          }
          return errorResult(input, current.href, redirects, 'too_many_redirects', `more than ${maxRedirects} redirects`, { ttfbMs, totalMs: now() - started });
        }
        if (seen.has(next.href)) {
          return errorResult(input, current.href, redirects, 'too_many_redirects', 'redirect loop detected', { ttfbMs, totalMs: now() - started });
        }
        const check = checkUrl(next.href, opts);
        if (!check.ok) {
          return errorResult(input, next.href, redirects, 'blocked_url', `redirect target blocked: ${check.reason}`, { ttfbMs, totalMs: now() - started });
        }
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          body = undefined;
        }
        current = check.url;
        continue;
      }

      const headers = pickHeaders(res.headers);
      const contentType = res.headers.get('content-type');
      if (opts.requireContentType && !(contentType && opts.requireContentType.test(contentType))) {
        await res.body?.cancel().catch(() => undefined);
        return errorResult(input, current.href, redirects, 'bad_content_type', `unexpected content-type ${contentType ?? '(none)'}`, { ttfbMs, totalMs: now() - started }, res.status, headers);
      }
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes * 4) {
        await res.body?.cancel().catch(() => undefined);
        return errorResult(input, current.href, redirects, 'too_large', `response is ${declared} bytes (limit ${maxBytes})`, { ttfbMs, totalMs: now() - started }, res.status, headers);
      }
      let text = '';
      let truncated = false;
      if (currentMethod !== 'HEAD') {
        try {
          ({ text, truncated } = await readCapped(res, maxBytes, controller.signal));
        } catch {
          const timedOut = controller.signal.aborted;
          return errorResult(input, current.href, redirects, timedOut ? 'timeout' : 'network', timedOut ? `body not received within ${timeoutMs} ms` : 'error reading body', { ttfbMs, totalMs: now() - started }, res.status, headers);
        }
      }
      let json: unknown;
      if (!truncated && text && (looksJson(contentType) || /^\s*[[{]/.test(text))) {
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      const result: SafeFetchResult = {
        ok: res.status >= 200 && res.status < 300 && !truncated,
        status: res.status,
        url: input,
        finalUrl: current.href,
        redirects,
        headers,
        contentType,
        bodyText: text,
        json,
        truncated,
        timings: { ttfbMs, totalMs: now() - started },
      };
      if (truncated) result.error = { kind: 'too_large', message: `response exceeded ${maxBytes} bytes` };
      return result;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Per-domain politeness + per-scan cache + request budget. One instance per scan run. */
export class FetchSession {
  private cache = new Map<string, SafeFetchResult>();
  private lastByDomain = new Map<string, number>();
  requests = 0;

  constructor(
    private readonly base: SafeFetchOptions & { maxRequests: number; minIntervalMs?: number },
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async fetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const merged = { ...this.base, ...opts };
    const method = merged.method ?? 'GET';
    const key = `${method} ${url} ${merged.body ?? ''}`;
    const cacheable = method === 'GET' || method === 'HEAD';
    if (cacheable && this.cache.has(key)) return this.cache.get(key)!;
    if (this.requests >= this.base.maxRequests) {
      return errorResult(url, url, [], 'budget_exceeded', `request budget of ${this.base.maxRequests} reached for this scan`);
    }
    let domain = '';
    try {
      domain = new URL(url).hostname;
    } catch {
      /* invalid URL is rejected by safeFetch below */
    }
    const now = this.base.now ?? (() => Date.now());
    const interval = this.base.minIntervalMs ?? 1000;
    const last = this.lastByDomain.get(domain);
    if (last !== undefined) {
      const wait = last + interval - now();
      if (wait > 0) await this.sleep(wait);
    }
    this.requests++;
    this.lastByDomain.set(domain, now());
    const res = await safeFetch(url, merged);
    if (cacheable) this.cache.set(key, res);
    return res;
  }
}
