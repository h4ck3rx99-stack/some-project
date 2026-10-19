import type { EmailProvider } from './provider';

/** Resend-compatible HTTP API (POST /emails). */
export function resendEmail(
  apiKey: string,
  from: string,
  endpoint = 'https://api.resend.com/emails',
): EmailProvider {
  return {
    name: 'resend',
    async send(msg) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
        });
        if (!res.ok) return { ok: false, error: `email API returned HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `email API unreachable: ${String((e as Error).message).slice(0, 200)}` };
      }
    },
  };
}
