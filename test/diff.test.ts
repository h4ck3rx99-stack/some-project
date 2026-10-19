import { describe, expect, it } from 'vitest';
import { diffScans, shouldAlert, type ScanSnapshot } from '../src/scan/diff';

const snap = (score: number, statuses: ScanSnapshot['statuses'], v: string | null = '2026-08-25'): ScanSnapshot => ({ score, specVersionSeen: v, statuses });
const ok = { 'discovery.profile_reachable': 'pass', 'discovery.version_current': 'pass', 'consistency.price_match': 'pass', 'basics.sitemap_found': 'fail' } as const;

describe('diffScans', () => {
  it('first scan and unchanged scans produce no events', () => {
    expect(diffScans(snap(90, { ...ok }), null)).toEqual([]);
    expect(diffScans(snap(90, { ...ok }), snap(90, { ...ok }))).toEqual([]);
    expect(diffScans(snap(88, { ...ok }), snap(90, { ...ok }))).toEqual([]); // < 5 points
  });

  it('new failure + score drop are grouped', () => {
    const ev = diffScans(snap(70, { ...ok, 'consistency.price_match': 'fail' }), snap(90, { ...ok }));
    expect(ev.map((e) => e.kind)).toEqual(['new_failure', 'score_drop']);
    expect(shouldAlert(ev)).toBe(true);
  });

  it('recovered alone does not alert', () => {
    const ev = diffScans(snap(95, { ...ok, 'basics.sitemap_found': 'pass' }), snap(90, { ...ok }));
    expect(ev).toEqual([{ kind: 'recovered', checkId: 'basics.sitemap_found', title: 'basics.sitemap_found', from: 'fail' }]);
    expect(shouldAlert(ev)).toBe(false);
  });

  it('version falling behind', () => {
    const ev = diffScans(snap(90, { ...ok, 'discovery.version_current': 'warn' }, '2026-04-08'), snap(90, { ...ok }));
    expect(ev).toEqual([{ kind: 'version_outdated', version: '2026-04-08' }]);
  });

  it('endpoint_down only after two consecutive failures, and only once', () => {
    const down = { ...ok, 'discovery.profile_reachable': 'fail' } as const;
    expect(diffScans(snap(39, { ...down }), snap(90, { ...ok }))).toEqual([]);
    expect(diffScans(snap(39, { ...down }), snap(39, { ...down }), snap(90, { ...ok }))).toEqual([{ kind: 'endpoint_down', consecutive: 2 }]);
    expect(diffScans(snap(39, { ...down }), snap(39, { ...down }), snap(39, { ...down }))).toEqual([]);
  });

  it('warn → fail is a new failure; pass → warn is not', () => {
    expect(diffScans(snap(90, { ...ok, 'consistency.price_match': 'warn' }), snap(90, { ...ok }))).toEqual([]);
    const ev = diffScans(snap(90, { ...ok, 'consistency.price_match': 'error' }), snap(90, { ...ok, 'consistency.price_match': 'warn' }));
    expect(ev[0]).toMatchObject({ kind: 'new_failure', from: 'warn', to: 'error' });
  });
});
