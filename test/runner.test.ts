import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getDb, schema } from '../src/db/client';
import { advanceJob, claimJob, drainJobs, dueJobs, LEASE_MS, MAX_ATTEMPTS, type RunnerDeps } from '../src/jobs/runner';
import { createScan } from '../src/services/scans';
import { mockFetch } from './helpers';

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps {
  return { d1: env.DB, appUrl: 'https://cartprobe.test', appDomain: 'cartprobe.test', allowTestTld: true, fetchImpl: mockFetch, sleep: async () => undefined, ...over };
}

const newScan = (domain: string) => createScan(env.DB, { url: `https://${domain}`, domain, trigger: 'anonymous', productsSampled: 30 });
const jobOf = async (scanId: string) => getDb(env.DB).query.scanJobs.findFirst({ where: eq(schema.scanJobs.scanId, scanId) });
const scanOf = async (id: string) => (await getDb(env.DB).query.scans.findFirst({ where: eq(schema.scans.id, id) }))!;

describe('job runner', () => {
  it('progresses phase by phase and persists state between invocations', async () => {
    const scan = await newScan('phases.mockstore.test');
    const seen: string[] = [];
    let clock = Date.now();
    for (let i = 0; i < 20; i++) {
      const job = await jobOf(scan.id);
      if (!job) break;
      seen.push(job.phase);
      const lease = await claimJob(deps({ now: () => clock }), job.id);
      expect(lease).not.toBeNull();
      // A clock that ticks on every read + a 1 ms budget → exactly one phase per invocation.
      await advanceJob(deps({ now: () => (clock += 2) }), lease!, 1);
    }
    expect(seen).toEqual(['discovery', 'catalog', 'products:0', 'consistency', 'basics', 'checkout', 'finalize']);
    const s = await scanOf(scan.id);
    expect(s.status).toBe('done');
    expect(s.score).toBe(100);
    expect(await jobOf(scan.id)).toBeUndefined();
  });

  it('a leased job is not claimed again until the lease expires (crash recovery)', async () => {
    const scan = await newScan('crash.mockstore.test');
    const t0 = Date.now();
    const job = (await jobOf(scan.id))!;
    const lease = await claimJob(deps({ now: () => t0 }), job.id);
    expect(lease).not.toBeNull();
    // Simulated crash: the worker dies holding the lease, nothing advanced.
    expect(await claimJob(deps({ now: () => t0 + 1000 }), job.id)).toBeNull();
    expect(await dueJobs(deps({ now: () => t0 + 1000 }), 100)).not.toContain(job.id);
    // After expiry another run picks it up; the crashed attempt counted.
    const later = t0 + LEASE_MS + 1;
    const lease2 = await claimJob(deps({ now: () => later }), job.id);
    expect(lease2).not.toBeNull();
    expect((await jobOf(scan.id))!.attempts).toBe(2);
    // The stale lease can no longer write.
    await advanceJob(deps({ now: () => later }), lease!, 1);
    expect((await jobOf(scan.id))!.phase).toBe('discovery');
    await advanceJob(deps({ now: () => later }), lease2!, 60_000);
    expect((await scanOf(scan.id)).status).toBe('done');
  });

  it('after max attempts a failing phase is marked error and the scan still finishes', async () => {
    const scan = await newScan('flaky.mockstore.test');
    // An R2 bucket that always throws makes the discovery phase fail (infrastructure error).
    const broken = { put: async () => { throw new Error('R2 unavailable'); } } as unknown as R2Bucket;
    let clock = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      const job = (await jobOf(scan.id))!;
      if (job.phase !== 'discovery') break;
      const lease = await claimJob(deps({ now: () => clock, captures: broken }), job.id);
      expect(lease).not.toBeNull();
      await advanceJob(deps({ now: () => clock, captures: broken }), lease!, 60_000);
      const after = (await jobOf(scan.id))!;
      if (i < MAX_ATTEMPTS) expect(after.lastError).toContain('R2 unavailable');
      clock += 60_000;
    }
    await drainJobs(deps({ now: () => clock }), 10, 60_000);
    const s = await scanOf(scan.id);
    expect(s.status).toBe('done');
    const r = await getDb(env.DB).query.checkResults.findFirst({ where: eq(schema.checkResults.id, `${scan.id}:discovery.profile_reachable`) });
    expect(r?.status).toBe('error');
    expect(r?.evidenceJson).toContain('R2 unavailable');
  });

  it('migrations created every table', async () => {
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    for (const t of ['users', 'login_tokens', 'sessions', 'accounts', 'account_members', 'stores', 'scans', 'check_results', 'scan_jobs', 'alert_channels', 'alerts', 'api_keys', 'webhook_events', 'rate_limits', 'audit_log', 'cron_runs']) {
      expect(names).toContain(t);
    }
  });
});
