import { describeEvent } from '../scan/diff';
import { safeFetch, type FetchLike } from '../lib/safeFetch';
import type { AlertChannel } from './channel';

/** Slack incoming webhook (https://hooks.slack.com/... only, enforced at creation and here). */
export function slackChannel(opts: { fetchImpl?: FetchLike; userAgent: string }): AlertChannel {
  return {
    type: 'slack',
    async send(url, p) {
      if (!url.startsWith('https://hooks.slack.com/')) return { ok: false, error: 'not a Slack webhook URL' };
      // Slack mrkdwn: escape &, <, > in user-controlled strings.
      const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const text = `*${e(p.storeName)}* (${e(p.domain)}): readiness score ${p.score ?? 'n/a'}\n${p.events.map((x) => `• ${e(describeEvent(x))}`).join('\n')}\n<${p.reportUrl}|Open report>`;
      const r = await safeFetch(url, { method: 'POST', body: JSON.stringify({ text }), headers: { 'content-type': 'application/json' }, maxRedirects: 0, timeoutMs: 8000, maxBytes: 16_000, fetchImpl: opts.fetchImpl, userAgent: opts.userAgent });
      return r.status >= 200 && r.status < 300 ? { ok: true } : { ok: false, error: r.error ? `${r.error.kind}: ${r.error.message}` : `HTTP ${r.status}` };
    },
  };
}
