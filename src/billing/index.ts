import type { AppEnv } from '../env';
import { manualBilling } from './manual';
import type { BillingProvider } from './provider';
import { webhookBilling } from './webhookAdapter';

export function billingProvider(env: AppEnv): BillingProvider {
  if (env.BILLING_PROVIDER === 'webhook' && env.BILLING_WEBHOOK_SECRET) {
    return webhookBilling({
      secret: env.BILLING_WEBHOOK_SECRET,
      checkoutUrls: { store: env.CHECKOUT_URL_STORE || undefined, agency: env.CHECKOUT_URL_AGENCY || undefined, vendor: env.CHECKOUT_URL_VENDOR || undefined },
    });
  }
  return manualBilling;
}
