import type { PlanId } from '../config/plans';

export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled' | 'trialing';

/** Normalised billing change, whatever the provider. */
export interface BillingUpdate {
  eventId: string;
  type: string;
  accountId: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  plan?: PlanId;
  status?: SubscriptionStatus;
  currentPeriodEnd?: number | null;
}

export interface VerifiedEvent {
  ok: true;
  update: BillingUpdate;
  raw: unknown;
}
export interface RejectedEvent {
  ok: false;
  status: number;
  error: string;
}

export interface BillingProvider {
  name: string;
  /** Verify the raw webhook request (signature, timestamp) and map it to a BillingUpdate. */
  parseWebhook(rawBody: string, headers: Headers, now?: number): Promise<VerifiedEvent | RejectedEvent>;
  /** Where to send a user to buy/upgrade, or null when billing is handled manually. */
  checkoutUrl(plan: PlanId, accountId: string): string | null;
}
