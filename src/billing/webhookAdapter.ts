/**
 * Generic signed-webhook billing adapter.
 *
 * Wire format (what CartProbe expects; put a small translation in front of it for your
 * merchant-of-record, see README "Switching billing providers"):
 *
 *   Headers:  webhook-id: <unique event id>
 *             webhook-timestamp: <unix seconds>
 *             webhook-signature: v1=<hex HMAC-SHA256(secret, "<id>.<timestamp>.<raw body>")>
 *   Body:     { "type": "subscription.updated", "data": {
 *                 "account_id": "<CartProbe account id, passed as custom data at checkout>",
 *                 "customer_id": "...", "subscription_id": "...",
 *                 "plan": "store|agency|vendor" (or a key of PLAN_ALIASES),
 *                 "status": "active|trialing|past_due|cancelled" (or a key of STATUS_ALIASES),
 *                 "current_period_end": <unix seconds or ISO date> } }
 *
 * The mapping layer (EVENT_TYPES, PLAN_ALIASES, STATUS_ALIASES) is the only place to edit when a
 * provider names things differently.
 */
import { z } from 'zod';
import { PLANS, type PlanId } from '../config/plans';
import { hmacHex, timingSafeEqual } from '../lib/crypto';
import type { BillingProvider, BillingUpdate, SubscriptionStatus } from './provider';

export const TIMESTAMP_TOLERANCE_S = 300;

/** Event types we act on. Anything else is recorded and acknowledged, but changes nothing. */
export const EVENT_TYPES = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.renewed',
  'subscription.past_due',
  'subscription.cancelled',
  'subscription.canceled',
  'subscription.expired',
]);

export const PLAN_ALIASES: Record<string, PlanId> = {
  store: 'store',
  store_monthly: 'store',
  store_annual: 'store',
  agency: 'agency',
  agency_monthly: 'agency',
  agency_annual: 'agency',
  vendor: 'vendor',
  vendor_monthly: 'vendor',
  vendor_annual: 'vendor',
  free: 'free',
};

export const STATUS_ALIASES: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  on_trial: 'trialing',
  past_due: 'past_due',
  unpaid: 'past_due',
  paused: 'past_due',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  expired: 'cancelled',
};

const bodySchema = z.object({
  type: z.string().min(1).max(100),
  data: z
    .object({
      account_id: z.string().max(100).nullish(),
      customer_id: z.string().max(200).nullish(),
      subscription_id: z.string().max(200).nullish(),
      plan: z.string().max(100).nullish(),
      status: z.string().max(50).nullish(),
      current_period_end: z.union([z.number(), z.string()]).nullish(),
    })
    .passthrough(),
});

function toMs(v: number | string | null | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

export function webhookBilling(opts: { secret: string; checkoutUrls: Partial<Record<PlanId, string>> }): BillingProvider {
  return {
    name: 'webhook',
    async parseWebhook(rawBody, headers, now = Date.now()) {
      const id = headers.get('webhook-id') ?? '';
      const ts = headers.get('webhook-timestamp') ?? '';
      const sigHeader = headers.get('webhook-signature') ?? '';
      if (!id || !/^\d{1,12}$/.test(ts) || !sigHeader) return { ok: false, status: 400, error: 'missing webhook-id, webhook-timestamp or webhook-signature' };
      if (Math.abs(now / 1000 - Number(ts)) > TIMESTAMP_TOLERANCE_S) return { ok: false, status: 400, error: 'timestamp outside tolerance' };
      const expected = await hmacHex(opts.secret, `${id}.${ts}.${rawBody}`);
      const provided = sigHeader
        .split(/[\s,]+/)
        .map((p) => p.replace(/^v1=/, ''))
        .filter(Boolean);
      if (!provided.some((p) => timingSafeEqual(p, expected))) return { ok: false, status: 401, error: 'invalid signature' };
      let parsed: z.infer<typeof bodySchema>;
      try {
        parsed = bodySchema.parse(JSON.parse(rawBody));
      } catch {
        return { ok: false, status: 400, error: 'invalid body' };
      }
      const d = parsed.data;
      const update: BillingUpdate = {
        eventId: id.slice(0, 200),
        type: parsed.type,
        accountId: d.account_id ?? null,
        customerId: d.customer_id ?? null,
        subscriptionId: d.subscription_id ?? null,
      };
      if (EVENT_TYPES.has(parsed.type)) {
        if (d.plan && PLAN_ALIASES[d.plan]) update.plan = PLAN_ALIASES[d.plan];
        if (d.status && STATUS_ALIASES[d.status]) update.status = STATUS_ALIASES[d.status];
        if (/cancel|expired/.test(parsed.type)) update.status = 'cancelled';
        if (parsed.type === 'subscription.past_due') update.status = 'past_due';
        const end = toMs(d.current_period_end);
        if (end !== undefined) update.currentPeriodEnd = end;
      }
      return { ok: true, update, raw: parsed };
    },
    checkoutUrl(plan, accountId) {
      const base = opts.checkoutUrls[plan];
      if (!base || !(plan in PLANS)) return null;
      const u = new URL(base);
      u.searchParams.set('account_id', accountId);
      return u.toString();
    },
  };
}
