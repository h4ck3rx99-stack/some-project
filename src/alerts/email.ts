import { alertEmail } from '../email/templates';
import type { EmailProvider } from '../email/provider';
import type { AlertChannel } from './channel';

export function emailChannel(provider: EmailProvider): AlertChannel {
  return {
    type: 'email',
    async send(to, p) {
      return provider.send(
        alertEmail({
          to,
          storeName: p.storeName,
          domain: p.domain,
          score: p.score,
          reportUrl: p.reportUrl,
          events: p.events,
        }),
      );
    },
  };
}
