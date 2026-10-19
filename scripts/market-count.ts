/**
 * Market sizing: how many stores publish a UCP profile, and how good is it?
 *
 *   npx tsx scripts/market-count.ts stores.txt > results.csv
 *
 * stores.txt: one origin or domain per line (# comments allowed). Uses the same safeFetch rules
 * as the product (https only, no private hosts, no redirects for the profile, size/time caps),
 * 2 domains at a time, at most 1 request per second per domain, and validates profiles against
 * the vendored schemas. Needs network access; never run by tests.
 * Writes CSV to stdout and a summary to stderr.
 */
import { readFileSync } from 'node:fs';
import { safeFetch } from '../src/lib/safeFetch';
import { normaliseStoreUrl, userAgentFor } from '../src/scan/context';
import { capabilities, declaredVersion } from '../src/ucp/profile';
import { validate, validationVersion } from '../src/ucp/validators';
import { classifyVersion } from '../src/ucp/versions';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npx tsx scripts/market-count.ts <stores.txt>');
  process.exit(1);
}
const appDomain = process.env.APP_DOMAIN ?? 'cartprobe.example';
const origins = readFileSync(file, 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*/, '').trim())
  .filter(Boolean)
  .map((l) => normaliseStoreUrl(l))
  .filter((x): x is { origin: string; domain: string } => !!x);
const unique = [...new Map(origins.map((o) => [o.domain, o])).values()];

interface Row {
  domain: string;
  http_status: number | string;
  has_profile: boolean;
  valid: boolean;
  version: string;
  version_status: string;
  capabilities: string;
  error: string;
}
const rows: Row[] = [];
const csv = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;

async function probe(o: { origin: string; domain: string }): Promise<Row> {
  const r = await safeFetch(`${o.origin}/.well-known/ucp`, { accept: 'application/json', maxRedirects: 0, maxBytes: 1_000_000, timeoutMs: 8000, userAgent: userAgentFor(appDomain) });
  const base = { domain: o.domain, http_status: r.error ? r.error.kind : r.status, has_profile: false, valid: false, version: '', version_status: '', capabilities: '', error: r.error?.message ?? '' };
  if (!r.ok || !r.bodyText) return { ...base, error: base.error || (r.status >= 300 && r.status < 400 ? 'redirect' : `HTTP ${r.status}`) };
  let json: unknown;
  try {
    json = JSON.parse(r.bodyText);
  } catch {
    return { ...base, error: 'not JSON' };
  }
  const declared = declaredVersion(json);
  const v = validationVersion(declared);
  const res = validate('profile', json, v);
  return {
    ...base,
    has_profile: true,
    valid: res.valid,
    version: declared ?? '',
    version_status: classifyVersion(declared),
    capabilities: [...new Set(capabilities(json).map((c) => c.name))].join(' '),
    error: res.valid ? '' : `${res.errors.length} schema errors`,
  };
}

async function main() {
  const queue = [...unique];
  const workers = Array.from({ length: 2 }, async () => {
    for (let o = queue.shift(); o; o = queue.shift()) {
      rows.push(await probe(o));
      await new Promise((r) => setTimeout(r, 1000)); // politeness between domains per worker
    }
  });
  await Promise.all(workers);
  const cols: (keyof Row)[] = ['domain', 'http_status', 'has_profile', 'valid', 'version', 'version_status', 'capabilities', 'error'];
  process.stdout.write(cols.join(',') + '\n' + rows.map((r) => cols.map((c) => csv(r[c])).join(',')).join('\n') + '\n');
  const n = (f: (r: Row) => boolean) => rows.filter(f).length;
  console.error(
    [
      `total:          ${rows.length}`,
      `has profile:    ${n((r) => r.has_profile)}`,
      `valid:          ${n((r) => r.valid)}`,
      `latest version: ${n((r) => r.version_status === 'latest')}`,
      `previous:       ${n((r) => r.version_status === 'previous')}`,
      `invalid:        ${n((r) => r.has_profile && !r.valid)}`,
    ].join('\n'),
  );
}
main();
