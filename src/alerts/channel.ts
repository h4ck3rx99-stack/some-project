import type { AlertEvent } from '../scan/diff';

export interface AlertPayload {
  storeId: string;
  storeName: string;
  domain: string;
  scanId: string;
  score: number | null;
  reportUrl: string;
  events: AlertEvent[];
}

export interface AlertChannel {
  type: 'email' | 'webhook' | 'slack';
  send(target: string, payload: AlertPayload): Promise<{ ok: boolean; error?: string }>;
}

/** Validate a channel target at creation time. Returns an error message or null. */
export function validateTarget(type: AlertChannel['type'], target: string): string | null {
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) ? null : 'enter a valid email address';
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return 'enter a valid https URL';
  }
  if (u.protocol !== 'https:') return 'only https:// URLs are allowed';
  if (type === 'slack' && !target.startsWith('https://hooks.slack.com/')) return 'Slack webhook URLs must start with https://hooks.slack.com/';
  return null;
}
