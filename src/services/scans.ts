import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { getDb, schema } from '../db/client';
import { newId, randomToken } from '../lib/crypto';
import { limitsFor } from '../scan/context';
import { initialState } from '../scan/engine';
import { scoreScan } from '../scan/scoring';
import type { CheckRecord, ScanInput, ScanState } from '../scan/types';
import { deepCheckoutAllowed } from '../checks/checkout';
import { CHECKS, CHECKS_BY_ID } from '../checks/registry';

export interface CreateScanArgs {
  url: string;
  domain: string;
  trigger: 'anonymous' | 'manual' | 'scheduled' | 'api';
  productsSampled: number;
  storeId?: string | null;
  accountId?: string | null;
  requesterIpHash?: string | null;
  verifiedOwnership?: boolean;
  testCheckoutEndpoint?: string | null;
  testModeConfirmed?: boolean;
  runAfter?: number;
  isPublic?: boolean;
  now?: number;
}

export async function createScan(d1: D1Database, a: CreateScanArgs) {
  const db = getDb(d1);
  const now = a.now ?? Date.now();
  const id = newId('scn_');
  const slug = randomToken(9).replace(/[-_]/g, 'z').slice(0, 12);
  const input: ScanInput = {
    scanId: id,
    url: a.url,
    domain: a.domain,
    limits: limitsFor(a.productsSampled),
    verifiedOwnership: !!a.verifiedOwnership,
    testCheckoutEndpoint: a.testCheckoutEndpoint ?? null,
    testModeConfirmed: !!a.testModeConfirmed,
  };
  const scan = {
    id,
    storeId: a.storeId ?? null,
    accountId: a.accountId ?? null,
    domain: a.domain,
    url: a.url,
    trigger: a.trigger,
    requesterIpHash: a.requesterIpHash ?? null,
    status: 'queued' as const,
    phase: 'discovery',
    publicSlug: slug,
    isPublic: a.isPublic ? 1 : 0,
    includeCheckout: deepCheckoutAllowed(input) ? 1 : 0,
    createdAt: now,
  };
  await db.batch([
    db.insert(schema.scans).values(scan),
    db.insert(schema.scanJobs).values({
      id: newId('job_'),
      scanId: id,
      phase: 'discovery',
      inputJson: JSON.stringify(input),
      stateJson: JSON.stringify(initialState()),
      runAfter: a.runAfter ?? now,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  return scan;
}

export function recordToRow(scanId: string, r: CheckRecord, now: number) {
  return {
    id: `${scanId}:${r.checkId}`,
    scanId,
    checkId: r.checkId,
    category: r.category,
    severity: r.severity,
    status: r.status,
    summary: r.summary,
    evidenceJson: JSON.stringify(r.evidence),
    fixGuide: r.fixGuide,
    metaJson: r.meta ? JSON.stringify(r.meta) : null,
    createdAt: now,
  };
}

/** Upsert check results for a scan (a retried phase overwrites its earlier partial results). */
export async function saveResults(d1: D1Database, scanId: string, results: CheckRecord[], now = Date.now()) {
  if (!results.length) return;
  const db = getDb(d1);
  const stmts = results.map((r) => {
    const row = recordToRow(scanId, r, now);
    return db.insert(schema.checkResults).values(row).onConflictDoUpdate({
      target: [schema.checkResults.scanId, schema.checkResults.checkId],
      set: { status: row.status, summary: row.summary, evidenceJson: row.evidenceJson, fixGuide: row.fixGuide, metaJson: row.metaJson, createdAt: now },
    });
  });
  await db.batch(stmts as [typeof stmts[number], ...typeof stmts]);
}

/** Compute and store the final score; returns the finished scan row. */
export async function finalizeScan(d1: D1Database, scanId: string, input: ScanInput, state: ScanState, now = Date.now()) {
  const db = getDb(d1);
  const results = Object.values(state.results);
  const s = scoreScan(results, { includeCheckout: deepCheckoutAllowed(input) });
  const sampled = (state.productPages ?? []).length;
  await db
    .update(schema.scans)
    .set({
      status: 'done',
      phase: 'done',
      score: s.score,
      grade: s.grade,
      categoryScoresJson: JSON.stringify({ categories: s.categories.map((c) => ({ category: c.category, score: c.score, counts: c.counts })), cappedBy: s.cappedBy ?? null }),
      specVersionSeen: state.profileVersion ?? null,
      productsSampled: sampled,
      requestsMade: state.requestsMade,
      finishedAt: now,
    })
    .where(eq(schema.scans.id, scanId));
  const scan = await db.query.scans.findFirst({ where: eq(schema.scans.id, scanId) });
  if (scan?.storeId) {
    await db.update(schema.stores).set({ lastScanId: scanId, lastScore: s.score }).where(eq(schema.stores.id, scan.storeId));
  }
  return scan!;
}

export async function getScanBySlug(d1: D1Database, slug: string) {
  return getDb(d1).query.scans.findFirst({ where: eq(schema.scans.publicSlug, slug) });
}

export async function getResults(d1: D1Database, scanId: string): Promise<CheckRecord[]> {
  const rows = await getDb(d1).select().from(schema.checkResults).where(eq(schema.checkResults.scanId, scanId));
  const order = new Map(CHECKS.map((c, i) => [c.id, i]));
  rows.sort((a, b) => (order.get(a.checkId) ?? 999) - (order.get(b.checkId) ?? 999));
  return rows.map((r) => ({
    checkId: r.checkId,
    title: CHECKS_BY_ID.get(r.checkId)?.title ?? r.checkId,
    category: r.category as CheckRecord['category'],
    severity: r.severity as CheckRecord['severity'],
    status: r.status as CheckRecord['status'],
    summary: r.summary,
    evidence: JSON.parse(r.evidenceJson) as CheckRecord['evidence'],
    fixGuide: r.fixGuide,
    ...(r.metaJson ? { meta: JSON.parse(r.metaJson) as Record<string, unknown> } : {}),
  }));
}

/** Completed scans of a store, newest first. */
export async function storeScans(d1: D1Database, storeId: string, limit = 30) {
  return getDb(d1)
    .select()
    .from(schema.scans)
    .where(and(eq(schema.scans.storeId, storeId), eq(schema.scans.status, 'done'), isNotNull(schema.scans.finishedAt)))
    .orderBy(desc(schema.scans.finishedAt))
    .limit(limit);
}
