import { CATEGORY_WEIGHTS, GRADE_BANDS, SEVERITY_WEIGHTS, type Grade } from '../config/weights';
import type { Category, CheckStatus, Severity } from './types';

export interface ScorableResult {
  category: Category;
  severity: Severity;
  status: CheckStatus;
}

export interface CategoryScore {
  category: Category;
  score: number | null; // null = not applicable (excluded)
  earned: number;
  possible: number;
  counts: Record<CheckStatus, number>;
}

export interface ScoreResult {
  score: number;
  grade: Grade;
  categories: CategoryScore[];
  /** Set when the score was capped because a critical discovery check failed. */
  cappedBy?: string;
}

/** Without a readable UCP profile agents cannot use the store at all, whatever else is right. */
export const DISCOVERY_GATE_CAP = 39;
/** A store with any failing critical check is never labelled "Agent-ready". */
export const CRITICAL_FAIL_CAP = 89;

const CREDIT: Record<CheckStatus, number | null> = { pass: 1, warn: 0.5, fail: 0, error: 0, skip: null };

export function scoreCategory(category: Category, results: ScorableResult[]): CategoryScore {
  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0, error: 0 };
  let earned = 0;
  let possible = 0;
  for (const r of results) {
    if (r.category !== category) continue;
    counts[r.status]++;
    const credit = CREDIT[r.status];
    const w = SEVERITY_WEIGHTS[r.severity];
    if (credit === null || w === 0) continue;
    earned += w * credit;
    possible += w;
  }
  return { category, score: possible > 0 ? Math.round((earned / possible) * 1000) / 10 : null, earned, possible, counts };
}

export function gradeFor(score: number): Grade {
  for (const b of GRADE_BANDS) if (score >= b.min) return b.grade;
  return 'Not ready';
}

/**
 * Overall score = weighted average of applicable categories, renormalised when categories are
 * excluded (no applicable checks, or checkout when not verified).
 */
export function scoreScan(results: ScorableResult[], opts: { includeCheckout: boolean }): ScoreResult {
  const cats = (Object.keys(CATEGORY_WEIGHTS) as Category[]).map((c) => scoreCategory(c, results));
  let weighted = 0;
  let totalWeight = 0;
  for (const c of cats) {
    if (c.category === 'checkout' && !opts.includeCheckout) {
      c.score = null;
      continue;
    }
    if (c.score === null) continue;
    weighted += c.score * CATEGORY_WEIGHTS[c.category];
    totalWeight += CATEGORY_WEIGHTS[c.category];
  }
  let score = totalWeight > 0 ? Math.round(weighted / totalWeight) : 0;
  const gate = (results as (ScorableResult & { checkId?: string })[]).find(
    (r) => r.category === 'discovery' && r.severity === 'critical' && (r.status === 'fail' || r.status === 'error'),
  );
  let cappedBy: string | undefined;
  if (gate && score > DISCOVERY_GATE_CAP) {
    score = DISCOVERY_GATE_CAP;
    cappedBy = gate.checkId ?? 'discovery';
  } else if (!gate) {
    const critical = (results as (ScorableResult & { checkId?: string })[]).find(
      (r) => r.severity === 'critical' && (r.status === 'fail' || r.status === 'error') && (r.category !== 'checkout' || opts.includeCheckout),
    );
    if (critical && score > CRITICAL_FAIL_CAP) {
      score = CRITICAL_FAIL_CAP;
      cappedBy = critical.checkId ?? critical.category;
    }
  }
  return { score, grade: gradeFor(score), categories: cats, ...(cappedBy ? { cappedBy } : {}) };
}
