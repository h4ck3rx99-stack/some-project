/**
 * Local demo data. Prints SQL to stdout (applied by `npm run seed:local`) and the one-time API key
 * to stderr.
 *
 * Creates: admin user (first ADMIN_EMAILS entry from .dev.vars, default admin@example.com) owning an
 * Agency account with 3 stores on the local mock store, each with 5 historical scans whose check
 * results are derived from the check registry (statuses vary per day so charts and diffs render),
 * one console-email alert channel and one API key.
 *
 * Seeded scan results are synthetic demo data (marked "Demo data" in their summaries), not the
 * output of real scans. Run a real scan from the dashboard to replace them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { CHECKS } from '../src/checks/registry';
import { encryptSecret, randomToken, sha256Hex } from '../src/lib/crypto';
import { scoreScan } from '../src/scan/scoring';
import type { CheckStatus } from '../src/scan/types';

function devVars(): Record<string, string> {
  const file = existsSync('.dev.vars') ? '.dev.vars' : '.dev.vars.example';
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const q = (v: unknown) =>
  v === null || v === undefined
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`;
const insert = (table: string, row: Record<string, unknown>) =>
  `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')});`;

async function main() {
  const vars = devVars();
  const adminEmail = (vars.ADMIN_EMAILS ?? 'admin@example.com').split(',')[0]!.trim() || 'admin@example.com';
  const key = vars.ENCRYPTION_KEY ?? 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const sql: string[] = ['PRAGMA foreign_keys = ON;'];

  sql.push(
    insert('users', {
      id: 'usr_demo_admin',
      email: adminEmail,
      name: 'Demo Admin',
      role: 'admin',
      created_at: now,
    }),
  );
  sql.push(
    insert('accounts', {
      id: 'acc_demo_agency',
      name: 'Demo Agency',
      plan: 'agency',
      status: 'active',
      current_period_end: now + 30 * day,
      billing_provider: 'manual',
      white_label_name: 'Demo Agency Ltd',
      white_label_hide_footer: 0,
      created_at: now,
    }),
  );
  sql.push(
    insert('account_members', { account_id: 'acc_demo_agency', user_id: 'usr_demo_admin', role: 'owner' }),
  );

  const stores = [
    {
      id: 'sto_demo_good',
      host: 'demo-good.mockstore.test',
      name: 'Demo Outdoor (good)',
      trend: [72, 80, 86, 93, 100],
    },
    {
      id: 'sto_demo_old',
      host: 'outdated.mockstore.test',
      name: 'Demo Legacy (outdated)',
      trend: [95, 95, 90, 90, 88],
    },
    {
      id: 'sto_demo_drift',
      host: 'price-mismatch.mockstore.test',
      name: 'Demo Drift (prices)',
      trend: [100, 100, 97, 88, 79],
    },
  ];
  // Checks that degrade first as the synthetic score falls.
  const degrade = [
    'consistency.price_match',
    'discovery.version_current',
    'products.identifiers',
    'products.shipping_details',
    'catalog.latency',
    'basics.sitemap_found',
    'discovery.profile_cache_headers',
  ];

  for (const s of stores) {
    let lastScan = '';
    let lastScore = 0;
    s.trend.forEach((target, i) => {
      const scanId = `scn_demo_${s.id.slice(9)}_${i}`;
      const finishedAt = now - (s.trend.length - i) * day;
      const failCount = Math.round(((100 - target) / 100) * degrade.length * 1.6);
      const statuses: Record<string, CheckStatus> = {};
      for (const c of CHECKS) {
        statuses[c.id] =
          c.category === 'checkout' && c.id !== 'checkout.capability_declared' ? 'skip' : 'pass';
      }
      degrade.slice(0, failCount).forEach((id, j) => (statuses[id] = j % 2 ? 'warn' : 'fail'));
      const results = CHECKS.map((c) => ({
        checkId: c.id,
        category: c.category,
        severity: c.severity,
        status: statuses[c.id]!,
      }));
      const score = scoreScan(results, { includeCheckout: false });
      sql.push(
        insert('scans', {
          id: scanId,
          store_id: s.id,
          account_id: 'acc_demo_agency',
          domain: s.host,
          url: `https://${s.host}`,
          trigger: 'scheduled',
          status: 'done',
          phase: 'done',
          score: score.score,
          grade: score.grade,
          category_scores_json: JSON.stringify({
            categories: score.categories.map((x) => ({
              category: x.category,
              score: x.score,
              counts: x.counts,
            })),
            cappedBy: null,
          }),
          spec_version_seen: s.id === 'sto_demo_old' ? '2026-04-08' : '2026-08-25',
          products_sampled: 3,
          requests_made: 16,
          include_checkout: 0,
          alerted_at: finishedAt,
          public_slug: `demo${s.id.slice(9)}${i}`.replace(/[^A-Za-z0-9]/g, ''),
          is_public: 0,
          started_at: finishedAt - 60_000,
          finished_at: finishedAt,
          created_at: finishedAt - 60_000,
        }),
      );
      for (const c of CHECKS) {
        const st = statuses[c.id]!;
        sql.push(
          insert('check_results', {
            id: `${scanId}:${c.id}`,
            scan_id: scanId,
            check_id: c.id,
            category: c.category,
            severity: c.severity,
            status: st,
            summary:
              st === 'pass'
                ? `Demo data: ${c.title.toLowerCase()} — passed.`
                : st === 'skip'
                  ? 'Demo data: skipped.'
                  : `Demo data: ${c.title.toLowerCase()} — needs attention.`,
            evidence_json: '[]',
            fix_guide: c.id,
            meta_json: null,
            created_at: finishedAt,
          }),
        );
      }
      lastScan = scanId;
      lastScore = score.score;
    });
    sql.push(
      insert('stores', {
        id: s.id,
        account_id: 'acc_demo_agency',
        url: `https://${s.host}`,
        domain: s.host,
        name: s.name,
        monitoring: 1,
        verify_token: randomToken(18).replace(/[-_]/g, 'x'),
        verified_at: null,
        test_checkout_endpoint: null,
        test_mode_confirmed_at: null,
        badge_enabled: 0,
        last_scan_id: lastScan,
        last_score: lastScore,
        last_manual_scan_at: null,
        created_at: now - 10 * day,
      }),
    );
  }
  // Stores must exist before their scans (foreign keys): move store inserts to the front.
  const storeLines = sql.filter((l) => l.startsWith('INSERT OR REPLACE INTO stores'));
  const rest = sql.filter((l) => !l.startsWith('INSERT OR REPLACE INTO stores'));
  const ordered = [...rest.slice(0, 4), ...storeLines, ...rest.slice(4)];

  ordered.push(
    insert('alert_channels', {
      id: 'ach_demo_email',
      account_id: 'acc_demo_agency',
      type: 'email',
      target_encrypted: await encryptSecret(key, adminEmail),
      label: 'Owner email (console)',
      verified_at: now,
      created_at: now,
    }),
  );
  const prefix = randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toLowerCase();
  const apiKey = `cp_${prefix}_${randomToken(24)}`;
  ordered.push(
    insert('api_keys', {
      id: 'key_demo',
      account_id: 'acc_demo_agency',
      key_hash: await sha256Hex(apiKey),
      prefix,
      label: 'Demo key',
      last_used_at: null,
      revoked_at: null,
      created_at: now,
    }),
  );

  process.stdout.write(ordered.join('\n') + '\n');
  process.stderr.write(
    `\nSeeded demo data for ${adminEmail} (Agency plan, 3 stores, 15 scans).\nDemo API key (shown once): ${apiKey}\nThe API needs the Vendor plan: switch the demo account to vendor in /admin to use it.\n\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
