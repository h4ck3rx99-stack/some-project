/**
 * Compare a monitored store's latest scan with its previous completed scan and emit alert events.
 * No events → no alert. Events for one scan are grouped into a single message per store.
 */
import type { CheckStatus } from './types';

export interface ScanSnapshot {
  score: number;
  specVersionSeen: string | null;
  statuses: Record<string, CheckStatus>;
  titles?: Record<string, string>;
}

export type AlertEvent =
  | { kind: 'new_failure'; checkId: string; title: string; from: CheckStatus; to: CheckStatus }
  | { kind: 'recovered'; checkId: string; title: string; from: CheckStatus }
  | { kind: 'score_drop'; from: number; to: number }
  | { kind: 'version_outdated'; version: string | null }
  | { kind: 'endpoint_down'; consecutive: number };

export const SCORE_DROP_THRESHOLD = 5;
const PROFILE_CHECK = 'discovery.profile_reachable';
const VERSION_CHECK = 'discovery.version_current';

const isBad = (s: CheckStatus | undefined) => s === 'fail' || s === 'error';
const isOk = (s: CheckStatus | undefined) => s === 'pass' || s === 'warn';

/**
 * @param current        the scan that just finished
 * @param previous       the store's previous completed scan (null for the first scan)
 * @param beforePrevious the one before that (used so endpoint_down fires once per outage)
 */
export function diffScans(current: ScanSnapshot, previous: ScanSnapshot | null, beforePrevious: ScanSnapshot | null = null): AlertEvent[] {
  if (!previous) return [];
  const profileNow = current.statuses[PROFILE_CHECK];
  const profilePrev = previous.statuses[PROFILE_CHECK];

  // A single failed profile fetch may be a blip: wait for a second consecutive failure.
  if (isBad(profileNow) && !isBad(profilePrev)) return [];

  const events: AlertEvent[] = [];
  if (isBad(profileNow) && isBad(profilePrev)) {
    // Fire once when the outage is confirmed, not on every following day.
    if (!beforePrevious || !isBad(beforePrevious.statuses[PROFILE_CHECK])) events.push({ kind: 'endpoint_down', consecutive: 2 });
    return events;
  }

  const title = (id: string) => current.titles?.[id] ?? previous.titles?.[id] ?? id;
  for (const [id, now] of Object.entries(current.statuses)) {
    const before = previous.statuses[id];
    if (isOk(before) && isBad(now)) events.push({ kind: 'new_failure', checkId: id, title: title(id), from: before!, to: now });
    else if (isBad(before) && now === 'pass') events.push({ kind: 'recovered', checkId: id, title: title(id), from: before! });
  }
  if (previous.score - current.score >= SCORE_DROP_THRESHOLD) events.push({ kind: 'score_drop', from: previous.score, to: current.score });
  if (previous.statuses[VERSION_CHECK] === 'pass' && current.statuses[VERSION_CHECK] !== undefined && current.statuses[VERSION_CHECK] !== 'pass' && current.statuses[VERSION_CHECK] !== 'skip') {
    events.push({ kind: 'version_outdated', version: current.specVersionSeen });
  }
  return events;
}

/** Only these event kinds are worth interrupting someone for; `recovered` rides along with them. */
export function shouldAlert(events: AlertEvent[]): boolean {
  return events.some((e) => e.kind !== 'recovered');
}

export function describeEvent(e: AlertEvent): string {
  switch (e.kind) {
    case 'new_failure':
      return `New issue: ${e.title} (was ${e.from}, now ${e.to})`;
    case 'recovered':
      return `Fixed: ${e.title}`;
    case 'score_drop':
      return `Readiness score dropped from ${e.from} to ${e.to}`;
    case 'version_outdated':
      return `UCP profile version ${e.version ?? '(unknown)'} is no longer the latest release`;
    case 'endpoint_down':
      return `UCP profile unreachable in ${e.consecutive} consecutive scans`;
  }
}
