import type { BillingProvider } from './provider';

/** Manual billing: an admin sets plan + period end in /admin. No webhooks are accepted. */
export const manualBilling: BillingProvider = {
  name: 'manual',
  async parseWebhook() {
    return { ok: false, status: 404, error: 'billing webhooks are disabled (BILLING_PROVIDER=manual)' };
  },
  checkoutUrl() {
    return null;
  },
};
