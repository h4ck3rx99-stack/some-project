import { FetchSession, type FetchLike } from '../lib/safeFetch';
import { REQUEST_OVERHEAD } from '../config/plans';
import type { PlanLimits, ScanContext, ScanInput, ScanState } from './types';

export interface ContextDeps {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  appUrl: string;
  appDomain: string;
  allowTestTld: boolean;
  capture?: (name: string, body: string) => Promise<void>;
}

export function limitsFor(productsSampled: number): PlanLimits {
  return { maxProducts: productsSampled, maxRequests: productsSampled + REQUEST_OVERHEAD };
}

export function userAgentFor(appDomain: string): string {
  return `CartProbeBot/1.0 (+https://${appDomain.replace(/^https?:\/\//, '')}/bot)`;
}

/** Build a ScanContext for one invocation. The request budget continues from previous phases. */
export function createContext(input: ScanInput, state: ScanState, deps: ContextDeps): ScanContext {
  const userAgent = userAgentFor(deps.appDomain);
  const http = new FetchSession(
    {
      fetchImpl: deps.fetchImpl,
      allowTestTld: deps.allowTestTld,
      userAgent,
      now: deps.now,
      maxRequests: Math.max(0, input.limits.maxRequests - state.requestsMade),
    },
    deps.sleep,
  );
  return { ...input, http, state, appUrl: deps.appUrl, userAgent, now: deps.now ?? (() => Date.now()), capture: deps.capture };
}

/** Normalise user input to an https origin. Returns null when it is not a usable store URL. */
export function normaliseStoreUrl(input: string): { origin: string; domain: string } | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return { origin: `https://${host}${u.port && u.port !== '443' ? `:${u.port}` : ''}`, domain: host };
  } catch {
    return null;
  }
}
