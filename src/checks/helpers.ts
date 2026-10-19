import type { SafeFetchResult } from '../lib/safeFetch';
import { PRODUCT_THRESHOLDS } from '../config/weights';
import type { CheckResult, CheckStatus, Evidence, FetchSummary } from '../scan/types';

export const MAX_EVIDENCE = 20;
export const MAX_EVIDENCE_CHARS = 500;

export function truncate(s: string, n = MAX_EVIDENCE_CHARS): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function summarize(r: SafeFetchResult): FetchSummary {
  return {
    url: r.url,
    finalUrl: r.finalUrl,
    status: r.status,
    ok: r.ok,
    contentType: r.contentType,
    headers: r.headers,
    ttfbMs: r.timings.ttfbMs,
    totalMs: r.timings.totalMs,
    redirects: r.redirects,
    error: r.error,
    truncated: r.truncated || undefined,
  };
}

export function describeFetch(f: FetchSummary | undefined): string {
  if (!f) return 'not fetched';
  if (f.error) return `${f.error.kind}: ${f.error.message}`;
  return `HTTP ${f.status}${f.contentType ? `, ${f.contentType}` : ''}, ${f.ttfbMs} ms to first byte`;
}

export function result(status: CheckStatus, summary: string, evidence: Evidence[] = [], meta?: Record<string, unknown>): CheckResult {
  return { status, summary, evidence, ...(meta ? { meta } : {}) };
}

export function skip(summary: string): CheckResult {
  return { status: 'skip', summary, evidence: [] };
}

export function ratioStatus(ok: number, total: number): CheckStatus {
  if (total === 0) return 'skip';
  const r = ok / total;
  if (r >= PRODUCT_THRESHOLDS.pass) return 'pass';
  if (r >= PRODUCT_THRESHOLDS.warn) return 'warn';
  return 'fail';
}

export function pct(ok: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((ok / total) * 100)}%`;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Visit every value in a JSON document with its path. Bounded to protect CPU on hostile input. */
export function walkJson(v: unknown, visit: (value: unknown, path: string, key: string) => void, limit = 50_000): void {
  let budget = limit;
  const go = (x: unknown, path: string, key: string): void => {
    if (budget-- <= 0) return;
    visit(x, path, key);
    if (Array.isArray(x)) x.forEach((c, i) => go(c, `${path}[${i}]`, key));
    else if (isObj(x)) for (const [k, c] of Object.entries(x)) go(c, `${path}.${k}`, k);
  };
  go(v, '$', '');
}
