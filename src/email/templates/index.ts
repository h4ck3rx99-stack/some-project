/** Plain, escaped email templates. All dynamic values pass through esc(). */
import type { AlertEvent } from '../../scan/diff';
import { describeEvent } from '../../scan/diff';
import type { EmailMessage } from '../provider';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#1a1a1a"><h2>${esc(title)}</h2>${body}<p style="color:#666;font-size:12px">CartProbe readiness monitoring. You receive this because of a setting in your CartProbe account.</p></body></html>`;
}

export function magicLinkEmail(to: string, link: string): EmailMessage {
  return {
    to,
    subject: 'Your CartProbe sign-in link',
    text: `Sign in to CartProbe:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you did not request it, ignore this email.`,
    html: layout('Sign in to CartProbe', `<p><a href="${esc(link)}">Sign in</a></p><p>This link works once and expires in 15 minutes. If you did not request it, ignore this email.</p>`),
  };
}

export interface AlertEmailInput {
  to: string;
  storeName: string;
  domain: string;
  score: number | null;
  reportUrl: string;
  events: AlertEvent[];
}

export function alertEmail(a: AlertEmailInput): EmailMessage {
  const lines = a.events.map(describeEvent);
  return {
    to: a.to,
    subject: `CartProbe: ${lines.length} change${lines.length === 1 ? '' : 's'} on ${a.storeName}`,
    text: `${a.storeName} (${a.domain}) — readiness score ${a.score ?? 'n/a'}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nFull report: ${a.reportUrl}`,
    html: layout(`Changes on ${a.storeName}`, `<p>${esc(a.domain)} — readiness score <b>${esc(a.score ?? 'n/a')}</b></p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p><a href="${esc(a.reportUrl)}">Open the full report</a></p>`),
  };
}

export interface DigestStore {
  name: string;
  domain: string;
  score: number | null;
  change: number | null;
  topFixes: string[];
}

export function digestEmail(to: string, accountName: string, stores: DigestStore[], appUrl: string): EmailMessage {
  const text = stores
    .map((s) => `${s.name} (${s.domain}): ${s.score ?? 'n/a'}${s.change ? ` (${s.change > 0 ? '+' : ''}${s.change} this week)` : ''}\n${s.topFixes.map((f) => `  - ${f}`).join('\n')}`)
    .join('\n\n');
  const html = stores
    .map((s) => `<h3>${esc(s.name)} <small>${esc(s.domain)}</small></h3><p>Score <b>${esc(s.score ?? 'n/a')}</b>${s.change ? ` (${s.change > 0 ? '+' : ''}${esc(s.change)} this week)` : ''}</p>${s.topFixes.length ? `<p>Top fixes:</p><ul>${s.topFixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}`)
    .join('');
  return {
    to,
    subject: `CartProbe weekly digest — ${accountName}`,
    text: `Weekly readiness digest for ${accountName}\n\n${text}\n\nDashboard: ${appUrl}/app`,
    html: layout(`Weekly digest — ${accountName}`, `${html}<p><a href="${esc(appUrl)}/app">Open your dashboard</a></p>`),
  };
}
