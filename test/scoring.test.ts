import { describe, expect, it } from 'vitest';
import { gradeFor, scoreCategory, scoreScan, type ScorableResult } from '../src/scan/scoring';

const r = (category: ScorableResult['category'], severity: ScorableResult['severity'], status: ScorableResult['status'], checkId?: string) => ({ category, severity, status, checkId });

describe('scoring', () => {
  it.each([
    ['all pass', [r('basics', 'high', 'pass'), r('basics', 'low', 'pass')], 100],
    ['warn = half credit', [r('basics', 'high', 'warn')], 50],
    ['fail and error = 0', [r('basics', 'high', 'fail'), r('basics', 'high', 'error')], 0],
    ['weighted by severity', [r('basics', 'critical', 'pass'), r('basics', 'low', 'fail')], 83.3],
    ['skip excluded', [r('basics', 'high', 'pass'), r('basics', 'critical', 'skip')], 100],
    ['info weight 0 ignored', [r('basics', 'info', 'fail'), r('basics', 'low', 'pass')], 100],
  ] as const)('%s', (_n, results, expected) => {
    expect(scoreCategory('basics', [...results]).score).toBe(expected);
  });

  it('category with only skips is not applicable', () => {
    expect(scoreCategory('catalog', [r('catalog', 'high', 'skip')]).score).toBeNull();
  });

  it('renormalises over applicable categories', () => {
    // discovery 100 (w30), products 0 (w25), catalog excluded → 30*100/55 = 54.5 → 55
    const s = scoreScan([r('discovery', 'high', 'pass'), r('products', 'high', 'fail'), r('catalog', 'high', 'skip')], { includeCheckout: false });
    expect(s.score).toBe(55);
    expect(s.categories.find((c) => c.category === 'catalog')!.score).toBeNull();
  });

  it('checkout is excluded unless verified, and counts with weight 20 when verified', () => {
    const results = [r('discovery', 'high', 'pass'), r('checkout', 'high', 'fail')];
    expect(scoreScan(results, { includeCheckout: false }).score).toBe(100);
    expect(scoreScan(results, { includeCheckout: true }).score).toBe(60); // 30*100/(30+20)
  });

  it('caps the score when a critical discovery check fails', () => {
    const s = scoreScan([r('discovery', 'critical', 'fail', 'discovery.profile_reachable'), r('products', 'high', 'pass'), r('basics', 'low', 'pass')], { includeCheckout: false });
    expect(s.score).toBe(39);
    expect(s.cappedBy).toBe('discovery.profile_reachable');
  });

  it('caps at 89 when any other critical check fails', () => {
    const s = scoreScan([r('discovery', 'high', 'pass'), r('discovery', 'high', 'pass'), r('consistency', 'critical', 'fail', 'consistency.price_match'), r('consistency', 'high', 'pass'), r('consistency', 'high', 'pass'), r('products', 'high', 'pass'), r('basics', 'high', 'pass')], { includeCheckout: false });
    expect(s.score).toBe(89);
    expect(s.grade).toBe('Mostly ready');
    expect(s.cappedBy).toBe('consistency.price_match');
    // Unscored checkout failures do not cap.
    expect(scoreScan([r('discovery', 'high', 'pass'), r('checkout', 'critical', 'fail')], { includeCheckout: false }).score).toBe(100);
  });

  it('nothing applicable → 0', () => {
    expect(scoreScan([], { includeCheckout: false }).score).toBe(0);
  });

  it.each([
    [100, 'Agent-ready'],
    [90, 'Agent-ready'],
    [89, 'Mostly ready'],
    [70, 'Mostly ready'],
    [69, 'Needs work'],
    [40, 'Needs work'],
    [39, 'Not ready'],
    [0, 'Not ready'],
  ] as const)('grade band %i → %s', (score, grade) => expect(gradeFor(score)).toBe(grade));
});
