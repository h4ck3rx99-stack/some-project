/**
 * Lease-based job processing for scans (D1 table scan_jobs, drained by cron and request waitUntil).
 *
 * - claim: atomically set lease_id + locked_until; attempts++ (so crashed runs count)
 * - advance: run phases until the wall-time budget is spent, persisting after every phase
 * - a crashed run's lease expires and the job is claimed again
 * - more than MAX_ATTEMPTS on one phase → that phase's checks are marked `error` and the scan moves on
 */
import { and, asc, eq, isNull, lt, lte, or } from 'drizzle-orm';
import { getDb, schema } from '../db/client';
import { newId } from '../lib/crypto';
import { log } from '../lib/log';
import type { FetchLike } from '../lib/safeFetch';
import { createContext } from '../scan/context';
import { errorPhase, runPhase } from '../scan/engine';
import type { Phase, ScanInput, ScanState } from '../scan/types';
import { finalizeScan, saveResults } from '../services/scans';

export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const DEFAULT_BUDGET_MS = 20_000;

export interface RunnerDeps {
  d1: D1Database;
  appUrl: string;
  appDomain: string;
  allowTestTld: boolean;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  captures?: R2Bucket;
  /** Called after a scan finishes (alerts for monitored stores). */
  onFinished?: (scanId: string) => Promise<void>;
}

export interface Lease {
  jobId: string;
  leaseId: string;
}

/** Try to lease one job. Returns null if someone else holds it or it is not due. */
export async function claimJob(deps: RunnerDeps, jobId: string): Promise<Lease | null> {
  const now = (deps.now ?? Date.now)();
  const leaseId = newId('lease_');
  const res = await deps.d1
    .prepare(
      `UPDATE scan_jobs SET lease_id = ?1, locked_until = ?2, attempts = attempts + 1, updated_at = ?3
       WHERE id = ?4 AND run_after <= ?3 AND (locked_until IS NULL OR locked_until < ?3)`,
    )
    .bind(leaseId, now + LEASE_MS, now, jobId)
    .run();
  return res.meta.changes === 1 ? { jobId, leaseId } : null;
}

/** Due, unleased jobs, oldest first. */
export async function dueJobs(deps: RunnerDeps, limit: number): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const db = getDb(deps.d1);
  const rows = await db
    .select({ id: schema.scanJobs.id })
    .from(schema.scanJobs)
    .where(
      and(
        lte(schema.scanJobs.runAfter, now),
        or(isNull(schema.scanJobs.lockedUntil), lt(schema.scanJobs.lockedUntil, now)),
      ),
    )
    .orderBy(asc(schema.scanJobs.runAfter))
    .limit(limit);
  return rows.map((r) => r.id);
}

function nextAfterFailure(phase: Phase): Phase {
  if (phase.startsWith('products:')) return 'consistency';
  const order: Phase[] = [
    'discovery',
    'catalog',
    'products:0',
    'consistency',
    'basics',
    'checkout',
    'finalize',
    'done',
  ];
  return order[order.indexOf(phase) + 1] ?? 'done';
}

/** Persist under the lease; returns false if the lease was lost (another runner took over). */
async function persist(
  deps: RunnerDeps,
  lease: Lease,
  phase: Phase,
  state: ScanState,
  extra: { attempts?: number; lastError?: string | null; release?: boolean; runAfter?: number } = {},
) {
  const now = (deps.now ?? Date.now)();
  const sets = ['phase = ?1', 'state_json = ?2', 'updated_at = ?3'];
  const binds: unknown[] = [phase, JSON.stringify(state), now];
  if (extra.attempts !== undefined) {
    binds.push(extra.attempts);
    sets.push(`attempts = ?${binds.length}`);
  }
  if (extra.lastError !== undefined) {
    binds.push(extra.lastError);
    sets.push(`last_error = ?${binds.length}`);
  }
  if (extra.runAfter !== undefined) {
    binds.push(extra.runAfter);
    sets.push(`run_after = ?${binds.length}`);
  }
  if (extra.release) sets.push('lease_id = NULL', 'locked_until = NULL');
  else {
    binds.push(now + LEASE_MS);
    sets.push(`locked_until = ?${binds.length}`);
  }
  binds.push(lease.jobId, lease.leaseId);
  const res = await deps.d1
    .prepare(
      `UPDATE scan_jobs SET ${sets.join(', ')} WHERE id = ?${binds.length - 1} AND lease_id = ?${binds.length}`,
    )
    .bind(...binds)
    .run();
  return res.meta.changes === 1;
}

/**
 * Advance a leased job through as many phases as fit in `budgetMs`.
 * Returns the phase it stopped at ('done' when the scan finished).
 */
export async function advanceJob(
  deps: RunnerDeps,
  lease: Lease,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<Phase> {
  const now = deps.now ?? Date.now;
  const started = now();
  const db = getDb(deps.d1);
  const job = await db.query.scanJobs.findFirst({ where: eq(schema.scanJobs.id, lease.jobId) });
  if (!job || job.leaseId !== lease.leaseId) return 'done';
  const input = JSON.parse(job.inputJson) as ScanInput;
  const state = JSON.parse(job.stateJson) as ScanState;
  let phase = job.phase as Phase;
  let attempts = job.attempts;

  await db
    .update(schema.scans)
    .set({ status: 'running', phase, startedAt: job.createdAt })
    .where(and(eq(schema.scans.id, job.scanId), eq(schema.scans.status, 'queued')));

  const capture = deps.captures
    ? async (name: string, body: string) => {
        await deps.captures!.put(`captures/${job.scanId}/${name}`, body.slice(0, 1_000_000), {
          customMetadata: { createdAt: String(now()) },
        });
      }
    : undefined;

  // Always make progress on at least one phase per invocation, then continue while budget remains.
  let first = true;
  while (phase !== 'done' && (first || now() - started < budgetMs)) {
    first = false;
    if (attempts > MAX_ATTEMPTS) {
      const ctx = createContext(input, state, { ...deps, capture });
      const errs = errorPhase(phase, ctx, job.lastError ?? 'phase failed repeatedly');
      await saveResults(deps.d1, job.scanId, errs);
      phase = nextAfterFailure(phase);
      attempts = 1;
      if (!(await persist(deps, lease, phase, state, { attempts: 1 }))) return phase;
      continue;
    }
    if (phase === 'finalize') {
      await finalizeScan(deps.d1, job.scanId, input, state, now());
      await db.delete(schema.scanJobs).where(eq(schema.scanJobs.id, lease.jobId));
      log.info({ msg: 'scan finished', scan_id: job.scanId, requests: state.requestsMade });
      if (deps.onFinished) {
        try {
          await deps.onFinished(job.scanId);
        } catch (e) {
          log.error({ msg: 'post-scan hook failed', scan_id: job.scanId, error: String(e) });
        }
      }
      return 'done';
    }
    try {
      const ctx = createContext(input, state, { ...deps, capture });
      const out = await runPhase(phase, ctx);
      await saveResults(deps.d1, job.scanId, out.results);
      phase = out.next;
      attempts = 1;
      await db.update(schema.scans).set({ phase }).where(eq(schema.scans.id, job.scanId));
      if (!(await persist(deps, lease, phase, state, { attempts: 1, lastError: null }))) return phase;
    } catch (e) {
      const message = String((e as Error)?.stack ?? e).slice(0, 1000);
      log.error({
        msg: 'scan phase failed',
        scan_id: job.scanId,
        job_id: lease.jobId,
        phase,
        error: message,
      });
      // Release with backoff; the next claim increments attempts.
      await persist(deps, lease, phase, state, {
        lastError: message,
        release: true,
        runAfter: now() + 5_000 * attempts,
      });
      return phase;
    }
  }
  await persist(deps, lease, phase, state, { release: true });
  return phase;
}

/** Claim and advance up to `max` due jobs within an overall budget (cron entry point). */
export async function drainJobs(deps: RunnerDeps, max = 5, budgetMs = 25_000): Promise<number> {
  const started = (deps.now ?? Date.now)();
  let processed = 0;
  for (const id of await dueJobs(deps, max)) {
    const remaining = budgetMs - ((deps.now ?? Date.now)() - started);
    if (remaining <= 1000) break;
    const lease = await claimJob(deps, id);
    if (!lease) continue;
    await advanceJob(deps, lease, Math.min(remaining, DEFAULT_BUDGET_MS));
    processed++;
  }
  return processed;
}

/** Advance the job of one scan if it is free (used by POST /scan and status polling). */
export async function kickScan(
  deps: RunnerDeps,
  scanId: string,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<void> {
  const job = await getDb(deps.d1).query.scanJobs.findFirst({ where: eq(schema.scanJobs.scanId, scanId) });
  if (!job) return;
  const lease = await claimJob(deps, job.id);
  if (lease) await advanceJob(deps, lease, budgetMs);
}
