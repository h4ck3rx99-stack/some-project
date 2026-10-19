/**
 * Every plan price and limit lives here. Change pricing/limits in this file only.
 * Annual price = 10 × monthly.
 */
export type PlanId = 'free' | 'store' | 'agency' | 'vendor';

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthlyUsd: number;
  maxStores: number;
  productsSampled: number;
  historyDays: number;
  alertChannels: ('email' | 'webhook' | 'slack')[];
  whiteLabel: boolean;
  apiAccess: boolean;
  badges: boolean;
  dailyMonitoring: boolean;
  /** Members per account (owner included). */
  maxMembers: number;
  /** Manual re-scan cooldown in minutes. */
  rescanCooldownMin: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthlyUsd: 0,
    maxStores: 0,
    productsSampled: 30,
    historyDays: 30,
    alertChannels: [],
    whiteLabel: false,
    apiAccess: false,
    badges: false,
    dailyMonitoring: false,
    maxMembers: 1,
    rescanCooldownMin: 10,
  },
  store: {
    id: 'store',
    name: 'Store',
    priceMonthlyUsd: 19,
    maxStores: 1,
    productsSampled: 200,
    historyDays: 90,
    alertChannels: ['email'],
    whiteLabel: false,
    apiAccess: false,
    badges: false,
    dailyMonitoring: true,
    maxMembers: 1,
    rescanCooldownMin: 10,
  },
  agency: {
    id: 'agency',
    name: 'Agency',
    priceMonthlyUsd: 79,
    maxStores: 25,
    productsSampled: 200,
    historyDays: 365,
    alertChannels: ['email', 'webhook', 'slack'],
    whiteLabel: true,
    apiAccess: false,
    badges: false,
    dailyMonitoring: true,
    maxMembers: 10,
    rescanCooldownMin: 10,
  },
  vendor: {
    id: 'vendor',
    name: 'Vendor',
    priceMonthlyUsd: 199,
    maxStores: 25,
    productsSampled: 200,
    historyDays: 365,
    alertChannels: ['email', 'webhook', 'slack'],
    whiteLabel: true,
    apiAccess: true,
    badges: true,
    dailyMonitoring: true,
    maxMembers: 10,
    rescanCooldownMin: 10,
  },
};

export const PLAN_ORDER: PlanId[] = ['free', 'store', 'agency', 'vendor'];

export function annualPriceUsd(p: Plan): number {
  return p.priceMonthlyUsd * 10;
}

/** Extra requests on top of product pages: profile, catalog, robots, sitemaps, endpoints, checkout. */
export const REQUEST_OVERHEAD = 40;

/** Anonymous scan rate limits. */
export const ANON_LIMITS = {
  scansPerHourPerIp: 5,
  scansPerDayPerDomain: 3,
  reuseFreshScanMs: 60 * 60 * 1000,
};

export const LOGIN_LIMITS = { perHourPerEmail: 5, perHourPerIp: 5 };

export const API_LIMITS = { scansPerHourPerAccount: 60, maxWaitSeconds: 25, maxSampleSize: 200 };

/**
 * Effective plan for an account: a paid plan only counts while active/trialing (or past_due within
 * its period). Anything else falls back to free limits.
 */
export function effectivePlan(
  plan: string,
  status: string,
  periodEnd: number | null,
  now = Date.now(),
): Plan {
  const p = PLANS[(plan in PLANS ? plan : 'free') as PlanId];
  if (p.id === 'free') return p;
  const inPeriod = periodEnd === null || periodEnd > now;
  if ((status === 'active' || status === 'trialing' || status === 'past_due') && inPeriod) return p;
  return PLANS.free;
}
