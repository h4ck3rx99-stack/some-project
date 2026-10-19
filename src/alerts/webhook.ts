import { hmacHex } from '../lib/crypto';
import { safeFetch, type FetchLike } from '../lib/safeFetch';
import type { AlertChannel } from './channel';

/**
 * Generic JSON webhook. Goes through safeFetch so alert channels cannot be used for SSRF.
 * Body is signed: header `x-cartprobe-signature: sha256=<hex HMAC of "<timestamp>.<body>">`.
 */
export function webhookChannel(opts: { signingSecret: string; fetchImpl?: FetchLike; userAgent: string }): AlertChannel {
  return {
    type: 'webhook',
    async send(url, p) {
      const body = JSON.stringify({ type: 'cartprobe.scan.changes', ...p });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = await hmacHex(opts.signingSecret, `${ts}.${body}`);
      const r = await safeFetch(url, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', 'x-cartprobe-timestamp': ts, 'x-cartprobe-signature': `sha256=${sig}` },
        maxRedirects: 0,
        timeoutMs: 8000,
        maxBytes: 64_000,
        fetchImpl: opts.fetchImpl,
        userAgent: opts.userAgent,
      });
      return r.status >= 200 && r.status < 300 ? { ok: true } : { ok: false, error: r.error ? `${r.error.kind}: ${r.error.message}` : `HTTP ${r.status}` };
    },
  };
}
