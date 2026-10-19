/**
 * Scan engine: runs checks phase by phase so a scan can be split across many short Worker
 * invocations (CPU limits). All state needed between phases lives in ScanState (JSON).
 *
 *   discovery → catalog → products:0 → products:10 … → consistency → basics → checkout → finalize → done
 */
import { CHECKS } from '../checks/registry';
import { deepCheckoutAllowed, prepareCheckout } from '../checks/checkout';
import { prepareBasics } from '../checks/basics';
import { prepareCatalog } from '../checks/catalog';
import { prepareDiscovery } from '../checks/discovery';
import { prepareProducts } from '../checks/products';
import { MAX_EVIDENCE, truncate } from '../checks/helpers';
import { hasCapability } from '../ucp/profile';
import type {
  CheckDefinition,
  CheckPhase,
  CheckRecord,
  Evidence,
  Phase,
  ScanContext,
  ScanState,
} from './types';

export function initialState(): ScanState {
  return { results: {}, requestsMade: 0 };
}

export function phaseLabel(phase: string): string {
  if (phase.startsWith('products:')) return 'Sampling product pages';
  return (
    (
      {
        discovery: 'Fetching UCP profile',
        catalog: 'Testing catalog search',
        consistency: 'Comparing catalog and pages',
        basics: 'Checking site basics',
        checkout: 'Checking checkout',
        finalize: 'Scoring',
        done: 'Done',
      } as Record<string, string>
    )[phase] ?? phase
  );
}

function cleanEvidence(ev: Evidence[]): Evidence[] {
  return ev.slice(0, MAX_EVIDENCE).map((e) => ({
    label: truncate(String(e.label ?? ''), 200),
    ...(e.url !== undefined ? { url: truncate(String(e.url), 500) } : {}),
    ...(e.expected !== undefined ? { expected: truncate(String(e.expected)) } : {}),
    ...(e.found !== undefined ? { found: truncate(String(e.found)) } : {}),
  }));
}

function record(
  def: CheckDefinition,
  status: CheckRecord['status'],
  summary: string,
  evidence: Evidence[],
  meta?: Record<string, unknown>,
  fixGuide?: string,
): CheckRecord {
  return {
    checkId: def.id,
    title: def.title,
    category: def.category,
    severity: def.severity,
    status,
    summary: truncate(summary, 600),
    evidence: cleanEvidence(evidence),
    fixGuide: fixGuide ?? def.id,
    ...(meta ? { meta } : {}),
  };
}

/** Run one check with dependency, requirement and error handling. Never throws. */
export async function runCheck(def: CheckDefinition, ctx: ScanContext): Promise<CheckRecord> {
  for (const dep of def.dependsOn ?? []) {
    const r = ctx.state.results[dep];
    // A dependency "passes" when it passed or passed with a warning.
    if (!r || (r.status !== 'pass' && r.status !== 'warn')) {
      const title = r?.title ?? dep;
      return record(def, 'skip', `Skipped because "${title}" did not pass.`, []);
    }
  }
  if (def.requires?.verifiedOwnership && !deepCheckoutAllowed(ctx)) {
    return record(
      def,
      'skip',
      'Runs only for stores with verified ownership and a confirmed test-mode checkout endpoint.',
      [],
    );
  }
  if (def.requires?.capability) {
    const json = ctx.state.profile?.json;
    if (json === undefined)
      return record(def, 'skip', 'Skipped because the UCP profile could not be read.', []);
    if (!hasCapability(json, def.requires.capability)) {
      return record(
        def,
        'skip',
        `Not offered: your profile does not declare ${def.requires.capability}. Consider enabling it so agents can use this feature.`,
        [],
        { notOffered: true },
      );
    }
  }
  try {
    const r = await def.run(ctx);
    return record(def, r.status, r.summary, r.evidence ?? [], r.meta, r.fixGuide);
  } catch (e) {
    return record(def, 'error', 'This check hit an internal error; the rest of the scan continued.', [
      { label: 'Error', found: truncate(String((e as Error)?.message ?? e), 300) },
    ]);
  }
}

async function runChecksFor(phase: CheckPhase, ctx: ScanContext): Promise<CheckRecord[]> {
  const out: CheckRecord[] = [];
  for (const def of CHECKS.filter((c) => c.phase === phase)) {
    const r = await runCheck(def, ctx);
    ctx.state.results[def.id] = r;
    out.push(r);
  }
  return out;
}

export interface PhaseOutcome {
  next: Phase;
  results: CheckRecord[];
}

/** Advance the scan by one phase. Throws only for infrastructure errors (job runner retries). */
export async function runPhase(phase: Phase, ctx: ScanContext): Promise<PhaseOutcome> {
  const before = ctx.http.requests;
  const finish = (next: Phase, results: CheckRecord[]): PhaseOutcome => {
    ctx.state.requestsMade += ctx.http.requests - before;
    return { next, results };
  };
  if (phase === 'discovery') {
    await prepareDiscovery(ctx);
    return finish('catalog', await runChecksFor('discovery', ctx));
  }
  if (phase === 'catalog') {
    await prepareCatalog(ctx);
    return finish('products:0', await runChecksFor('catalog', ctx));
  }
  if (phase.startsWith('products:')) {
    const offset = Number(phase.slice('products:'.length)) || 0;
    const next = await prepareProducts(ctx, offset);
    return finish(next === null ? 'consistency' : `products:${next}`, []);
  }
  if (phase === 'consistency') return finish('basics', await runChecksFor('consistency', ctx));
  if (phase === 'basics') {
    await prepareBasics(ctx);
    return finish('checkout', await runChecksFor('basics', ctx));
  }
  if (phase === 'checkout') {
    await prepareCheckout(ctx);
    return finish('finalize', await runChecksFor('checkout', ctx));
  }
  if (phase === 'finalize') return finish('done', []);
  return finish('done', []);
}

/** Checks of the given phase that have no result yet (used when giving up after max attempts). */
export function checksForPhase(phase: Phase): CheckDefinition[] {
  const p: CheckPhase | null = phase.startsWith('products:') ? null : (phase as CheckPhase);
  return CHECKS.filter((c) => c.phase === p);
}

/** Mark the checks of a failed phase as `error` so the scan can finish. */
export function errorPhase(phase: Phase, ctx: ScanContext, message: string): CheckRecord[] {
  return checksForPhase(phase).map((def) => {
    const r = record(def, 'error', 'This check could not run after several attempts.', [
      { label: 'Error', found: truncate(message, 300) },
    ]);
    ctx.state.results[def.id] = r;
    return r;
  });
}
