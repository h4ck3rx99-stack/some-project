import { safeFetch, type FetchLike } from '../lib/safeFetch';

export interface VerifyOutcome {
  ok: boolean;
  method?: 'dns' | 'file';
  details: string[];
}

/**
 * Ownership proof, either:
 *  - DNS TXT record on the store domain: cartprobe-verify=<token>  (looked up via DNS-over-HTTPS)
 *  - https://<domain>/.well-known/cartprobe-verify.txt containing exactly <token>
 */
export async function verifyOwnership(domain: string, token: string, opts: { fetchImpl?: FetchLike; allowTestTld: boolean; userAgent: string }): Promise<VerifyOutcome> {
  const details: string[] = [];
  const expected = `cartprobe-verify=${token}`;
  const doh = await safeFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`, {
    accept: 'application/dns-json',
    timeoutMs: 5000,
    maxBytes: 64_000,
    fetchImpl: opts.fetchImpl,
    userAgent: opts.userAgent,
  });
  const answers = (doh.json as { Answer?: { type: number; data: string }[] } | undefined)?.Answer ?? [];
  // TXT data arrives quoted and may be split into several quoted strings.
  const txts = answers.filter((a) => a.type === 16).map((a) => a.data.replace(/"\s*"/g, '').replace(/^"|"$/g, ''));
  if (txts.some((t) => t.trim() === expected)) return { ok: true, method: 'dns', details: ['Found the TXT record.'] };
  details.push(doh.error ? `DNS lookup failed (${doh.error.kind}).` : `DNS: no TXT record "${expected}" on ${domain} (found ${txts.length} TXT record${txts.length === 1 ? '' : 's'}).`);

  const file = await safeFetch(`https://${domain}/.well-known/cartprobe-verify.txt`, {
    timeoutMs: 5000,
    maxBytes: 4096,
    maxRedirects: 0,
    fetchImpl: opts.fetchImpl,
    allowTestTld: opts.allowTestTld,
    userAgent: opts.userAgent,
  });
  if (file.ok && (file.bodyText ?? '').trim() === token) return { ok: true, method: 'file', details: ['Found the verification file.'] };
  details.push(file.error ? `File: ${file.error.kind} (${file.error.message}).` : `File: HTTP ${file.status}${file.ok ? ', but its content did not match the token' : ''}.`);
  return { ok: false, details };
}
