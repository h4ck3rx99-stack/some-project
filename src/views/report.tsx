/**
 * Report components. Everything shown here may come from a scanned site (attacker-controlled):
 * it is rendered only as escaped text via JSX (never raw HTML), and evidence was truncated at
 * scan time.
 */
import { CHECKS_BY_ID } from '../checks/registry';
import { CATEGORY_LABELS } from '../config/weights';
import type { schema } from '../db/client';
import type { Category, CheckRecord, CheckStatus } from '../scan/types';
import { CATEGORIES } from '../scan/types';
import { LATEST_VERSION } from '../ucp/versions';

export type ScanRow = typeof schema.scans.$inferSelect;

export interface CategoryScoreView {
  category: Category;
  score: number | null;
  counts: Record<CheckStatus, number>;
}

export function parseCategories(scan: ScanRow): { categories: CategoryScoreView[]; cappedBy: string | null } {
  if (!scan.categoryScoresJson) return { categories: [], cappedBy: null };
  try {
    const j = JSON.parse(scan.categoryScoresJson) as { categories: CategoryScoreView[]; cappedBy: string | null };
    return { categories: j.categories ?? [], cappedBy: j.cappedBy ?? null };
  } catch {
    return { categories: [], cappedBy: null };
  }
}

const STATUS_TEXT: Record<CheckStatus, string> = { pass: 'Passed', warn: 'Warning', fail: 'Failed', skip: 'Skipped', error: 'Error' };
const STATUS_ICON: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✕', skip: '–', error: '✕' };

export function StatusChip(p: { status: CheckStatus }) {
  return (
    <span class={`chip s-${p.status}`}>
      <span aria-hidden="true">{STATUS_ICON[p.status]} </span>
      {STATUS_TEXT[p.status]}
    </span>
  );
}

export function ScoreDial(p: { score: number | null; grade: string | null; size?: number }) {
  const size = p.size ?? 140;
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, p.score ?? 0));
  const color = v >= 90 ? 'var(--pass)' : v >= 70 ? 'var(--accent)' : v >= 40 ? 'var(--warn)' : 'var(--fail)';
  return (
    <svg class="dial" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Readiness score ${p.score ?? 'not available'} out of 100${p.grade ? `, ${p.grade}` : ''}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" stroke-width="10" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        stroke-width="10"
        stroke-linecap="round"
        stroke-dasharray={`${((v / 100) * c).toFixed(1)} ${c.toFixed(1)}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" font-size={size / 3.6} font-weight="700">
        {p.score ?? '–'}
      </text>
    </svg>
  );
}

export function CategoryBars(p: { categories: CategoryScoreView[] }) {
  return (
    <div class="bars">
      {CATEGORIES.map((cat) => {
        const c = p.categories.find((x) => x.category === cat);
        const score = c?.score ?? null;
        return (
          <div class="bar">
            <span>{CATEGORY_LABELS[cat]}</span>
            <div class="track" role="img" aria-label={`${CATEGORY_LABELS[cat]}: ${score === null ? 'not scored' : `${Math.round(score)} of 100`}`}>
              <div class="fill" style={`width:${score ?? 0}%`} />
            </div>
            <span class="small">{score === null ? 'n/a' : Math.round(score)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Sparkline(p: { values: number[]; width?: number; height?: number }) {
  const w = p.width ?? 90;
  const h = p.height ?? 24;
  if (p.values.length < 2) return <span class="muted small">–</span>;
  const pts = p.values.map((v, i) => `${((i / (p.values.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 2 - (v / 100) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg class="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Score trend: ${p.values.join(', ')}`}>
      <polyline points={pts} />
    </svg>
  );
}

export function HistoryChart(p: { points: { t: number; score: number }[] }) {
  const w = 640;
  const h = 180;
  const pad = 28;
  if (p.points.length < 2) return <p class="muted">The chart appears after two completed scans.</p>;
  const t0 = p.points[0]!.t;
  const t1 = p.points[p.points.length - 1]!.t;
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad * 2);
  const y = (s: number) => h - pad - (s / 100) * (h - pad * 2);
  return (
    <svg class="chart" viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label={`Score history: ${p.points.map((q) => q.score).join(', ')}`}>
      <g class="grid">
        {[0, 50, 100].map((s) => (
          <>
            <line x1={pad} x2={w - pad} y1={y(s)} y2={y(s)} />
            <text x={4} y={y(s) + 4}>
              {s}
            </text>
          </>
        ))}
      </g>
      <polyline points={p.points.map((q) => `${x(q.t).toFixed(1)},${y(q.score).toFixed(1)}`).join(' ')} />
      <text x={pad} y={h - 6}>
        {new Date(t0).toISOString().slice(0, 10)}
      </text>
      <text x={w - pad} y={h - 6} text-anchor="end">
        {new Date(t1).toISOString().slice(0, 10)}
      </text>
    </svg>
  );
}

function Evidence(p: { r: CheckRecord }) {
  if (!p.r.evidence.length) return null;
  return (
    <details>
      <summary>Evidence ({p.r.evidence.length})</summary>
      <ul class="evidence">
        {p.r.evidence.map((e) => (
          <li>
            <div>
              <b>{e.label}</b>
            </div>
            <dl class="ev">
              {e.url ? (
                <>
                  <dt>Fetched</dt>
                  <dd>
                    <code>{e.url}</code>
                  </dd>
                </>
              ) : null}
              {e.expected ? (
                <>
                  <dt>Expected</dt>
                  <dd>
                    <code>{e.expected}</code>
                  </dd>
                </>
              ) : null}
              {e.found ? (
                <>
                  <dt>Found</dt>
                  <dd>
                    <code>{e.found}</code>
                  </dd>
                </>
              ) : null}
            </dl>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function CheckList(p: { results: CheckRecord[]; categories: CategoryScoreView[]; fixLinks?: boolean }) {
  return (
    <>
      {CATEGORIES.map((cat) => {
        const rs = p.results.filter((r) => r.category === cat);
        if (!rs.length) return null;
        const notOffered = rs.every((r) => r.status === 'skip') && rs.some((r) => r.meta?.notOffered);
        const c = p.categories.find((x) => x.category === cat);
        return (
          <section class="card">
            <h2 style="margin-top:0">
              {CATEGORY_LABELS[cat]} <span class="muted small">{c?.score === null || c?.score === undefined ? (notOffered ? '· not offered' : '· not scored') : `· ${Math.round(c.score)}/100`}</span>
            </h2>
            {notOffered ? <p class="muted">Your profile does not offer this capability, so it is excluded from the score. Consider enabling it so agents can use it.</p> : null}
            {cat === 'checkout' && c?.score === null && !notOffered ? (
              <p class="muted small">Checkout is not scored until the store owner verifies ownership and configures a test-mode endpoint.</p>
            ) : null}
            <ul class="checks">
              {rs.map((r) => {
                const def = CHECKS_BY_ID.get(r.checkId);
                return (
                  <li>
                    <div class="check-head">
                      <StatusChip status={r.status} />
                      <span class="title">{r.title || def?.title || r.checkId}</span>
                      <span class="muted small">{r.severity}</span>
                    </div>
                    <p style="margin:4px 0 0">{r.summary}</p>
                    {(r.status === 'fail' || r.status === 'warn' || r.status === 'error') && def ? <p class="muted small" style="margin:4px 0 0">Why it matters: {def.why}</p> : null}
                    <Evidence r={r} />
                    {p.fixLinks !== false && r.status !== 'pass' && r.status !== 'skip' ? (
                      <p class="small" style="margin:6px 0 0">
                        <a href={`/fix/${encodeURIComponent(r.fixGuide)}`}>How to fix</a>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </>
  );
}

export function ReportHeader(p: { scan: ScanRow; label?: string }) {
  const s = p.scan;
  const t = s.finishedAt ?? s.createdAt;
  return (
    <div class="meta">
      <span>
        Store: <b>{s.domain}</b>
      </span>
      <span>
        Scanned: <time datetime={new Date(t).toISOString()}>{new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC</time>
      </span>
      <span>
        UCP version seen: <b>{s.specVersionSeen ?? 'none'}</b> (latest {LATEST_VERSION})
      </span>
      <span>
        Products sampled: <b>{s.productsSampled}</b>
      </span>
      <span>
        Requests made: <b>{s.requestsMade}</b>
      </span>
    </div>
  );
}

export function ReportBody(p: { scan: ScanRow; results: CheckRecord[]; fixLinks?: boolean }) {
  const { categories, cappedBy } = parseCategories(p.scan);
  const failing = p.results.filter((r) => r.status === 'fail' || r.status === 'error').length;
  const warnings = p.results.filter((r) => r.status === 'warn').length;
  const passed = p.results.filter((r) => r.status === 'pass').length;
  return (
    <>
      <div class="card report-head">
        <ScoreDial score={p.scan.score} grade={p.scan.grade} />
        <div style="flex:1 1 320px;min-width:0">
          <h2 style="margin:0 0 4px">{p.scan.grade ?? 'Not scored'}</h2>
          <p class="muted">
            {passed} checks passed · {warnings} warnings · {failing} issues found
          </p>
          {cappedBy ? (
            <p class="small">
              Score capped at 39 because “{CHECKS_BY_ID.get(cappedBy)?.title ?? cappedBy}” failed: without a readable UCP profile, agents cannot use the store.
            </p>
          ) : null}
          <ReportHeader scan={p.scan} />
        </div>
      </div>
      <div class="card">
        <CategoryBars categories={categories} />
      </div>
      <CheckList results={p.results} categories={categories} fixLinks={p.fixLinks} />
    </>
  );
}
