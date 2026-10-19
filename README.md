# CartProbe

CartProbe is "Lighthouse for AI shopping agents". Paste a store URL and it checks the store's
Universal Commerce Protocol (UCP) profile, catalog API, product structured data and site basics the
way an AI shopping agent would, then shows a 0–100 readiness score with evidence and a fix guide for
every issue. Paid plans re-scan monitored stores daily and alert only on meaningful changes; agencies
get white-label reports and vendors get a CI API and badges. Everything is deterministic: no LLM calls.

**Screenshots (to add):** homepage, scan progress, report (good store), report (failing store),
dashboard with sparklines, store page with history chart, printable white-label report, admin.

## Architecture

```
            ┌──────────────────────── Cloudflare Worker (Hono, SSR) ─────────────────────────┐
 browser ──▶│ public pages · /scan · /r/:slug · /app/* · /admin · /api/v1 · /webhooks/billing │
 CI/API  ──▶│        │ create scan + job          ▲ status polling kicks the job              │
 billing ──▶│        ▼                            │                                           │
            │   D1: scans, check_results, scan_jobs (lease, phase, state_json), accounts…    │
            │        ▲                                                                       │
 cron ─────▶│ scheduled(): * * * * * drain jobs · 0 1 daily enqueue · 0 2 cleanup · Mon digest│
            │        │                                                                       │
            │   scan engine: discovery → catalog → products:N → consistency → basics →        │
            │                checkout → finalize   (37 checks, scoring, diff → alerts)          │
            │        │ every outbound request                                                │
            │        ▼                                                                       │
            │   safeFetch (https only, no private hosts, redirect re-validation, caps, 1 rps) │
            └────────┼───────────────────────────────────────────────────────────────────────┘
                     ▼
     store: /.well-known/ucp · catalog search · robots/sitemaps · product pages      R2: raw captures (7 days)
```

Code map: `src/lib/safeFetch.ts` (security boundary), `src/checks/*` (checks), `src/scan/*` (engine,
scoring, diff, extraction), `src/jobs/*` (runner, cron), `src/routes/*` and `src/views/*` (UI),
`src/config/plans.ts` and `src/config/weights.ts` (every price, limit and weight).

## Local setup (offline, against the mock store)

Requirements: Node 20+ and npm.

```sh
git clone https://github.com/h4ck3rx99-stack/cartprobe && cd cartprobe
npm ci
cp .dev.vars.example .dev.vars          # local secrets; ADMIN_EMAILS=admin@example.com
npm run db:migrate:local                 # creates the local D1 database in .wrangler/
npm run seed:local                       # demo admin, Agency account, 3 stores, 15 scans; prints an API key
npm run mock-store                       # terminal 1: mock store on http://127.0.0.1:8788
npm run dev                              # terminal 2: app on http://localhost:8787
```

Then:

1. Open http://localhost:8787 and scan `good.mockstore.test` (or `outdated`, `broken-profile`,
   `no-ucp`, `price-mismatch`, `blocks-robots`, `slow`, `redirect-loop`, `redirect-to-private`).
   In development, `*.mockstore.test` is routed to the mock store; any other subdomain behaves like `good`.
2. Log in as `admin@example.com`. The magic link is printed in the `npm run dev` terminal
   (console email provider).
3. Add a store such as `my-shop.mockstore.test`. To verify ownership, make the mock store serve your
   token, then press "Check now":
   `curl -X POST -H 'x-mock-host: my-shop.mockstore.test' 'http://127.0.0.1:8788/__mock/verify?token=<token from the page>'`
4. Trigger the daily cron by hand, then the job runner:
   `curl 'http://localhost:8787/__scheduled?cron=0+1+*+*+*'` and
   `curl 'http://localhost:8787/__scheduled?cron=*+*+*+*+*'` (repeat until scans finish; each takes ~20 s
   because of the 1 request/second politeness rule).
5. Introduce a regression and repeat step 4; exactly one alert email is printed:
   `curl -X POST -H 'x-mock-host: my-shop.mockstore.test' 'http://127.0.0.1:8788/__mock/set?variant=price-mismatch'`

## Environment variables

Vars live in `wrangler.toml` `[vars]`; secrets via `wrangler secret put NAME`; locally everything comes
from `.dev.vars`. Validated with zod on first request (`src/env.ts`); a bad value gives a clear error.

| Name                                         | Required            | Example                            | Purpose                                                          |
| -------------------------------------------- | ------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `ENVIRONMENT`                                | yes                 | `production`                       | `development` enables the mock-store transport and `.test` hosts |
| `APP_URL`                                    | yes                 | `https://cartprobe.app`            | Absolute links, Origin check                                     |
| `APP_DOMAIN`                                 | yes                 | `cartprobe.app`                    | Bot user agent `CartProbeBot/1.0 (+https://<APP_DOMAIN>/bot)`    |
| `SESSION_SECRET`                             | yes (secret)        | 32+ random chars                   | CSRF token HMAC, webhook alert signing                           |
| `IP_HASH_SALT`                               | yes (secret)        | random                             | IPs stored only as `HMAC(salt, ip + date)`                       |
| `ENCRYPTION_KEY`                             | yes (secret)        | `openssl rand -base64 32`          | AES-GCM for alert targets                                        |
| `EMAIL_PROVIDER`                             | yes                 | `resend` / `console`               | Email transport                                                  |
| `EMAIL_API_KEY`                              | if resend (secret)  | `re_…`                             | Resend-compatible API key                                        |
| `EMAIL_FROM`                                 | yes                 | `CartProbe <alerts@cartprobe.app>` | Sender                                                           |
| `BILLING_PROVIDER`                           | yes                 | `manual` / `webhook`               | Billing mode                                                     |
| `BILLING_WEBHOOK_SECRET`                     | if webhook (secret) | random                             | Webhook HMAC secret                                              |
| `CHECKOUT_URL_STORE` / `_AGENCY` / `_VENDOR` | no                  | provider checkout links            | Upgrade buttons (`?account_id=` is appended)                     |
| `ADMIN_EMAILS`                               | no                  | `you@domain.com`                   | Comma-separated; these users become admins at login              |
| `MOCK_STORE_ORIGIN`                          | dev only            | `http://127.0.0.1:8788`            | Local mock store                                                 |

Bindings: `DB` (D1 `cartprobe`), `CAPTURES` (R2 `cartprobe-captures`).

## Database

Schema: `src/db/schema.ts` (Drizzle). After changing it: `npm run db:generate` (writes
`migrations/NNNN_*.sql`; commit it), then `npm run db:migrate:local` / `npm run db:migrate:remote`.

## Tests and checks

```sh
npm run typecheck && npm run lint && npm test
```

Tests run inside workerd (`@cloudflare/vitest-plugin`) with real local D1 and the mock store injected
as the transport. No test touches the network. `npm test` first regenerates fix-guide HTML and the
fixture bundle (`npm run build:content`).

## Deploying to Cloudflare

1. `npx wrangler login`
2. `npx wrangler d1 create cartprobe`; paste the `database_id` into `wrangler.toml`
3. `npx wrangler r2 bucket create cartprobe-captures`
4. Edit `[vars]` in `wrangler.toml` (`APP_URL`, `APP_DOMAIN`, `EMAIL_*`, `ADMIN_EMAILS`, `BILLING_PROVIDER`)
5. `npx wrangler secret put SESSION_SECRET` (repeat for `IP_HASH_SALT`, `ENCRYPTION_KEY`, `EMAIL_API_KEY`, `BILLING_WEBHOOK_SECRET`)
6. `npm run db:migrate:remote && npm run deploy`
7. Workers → your Worker → Settings → Domains & Routes → add the custom domain

GitHub Actions: `.github/workflows/ci.yml` runs typecheck, lint and tests on PRs and pushes.
`deploy.yml` deploys on push to `main` after the same checks; it needs repository secrets
`CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit + D1:Edit) and `CLOUDFLARE_ACCOUNT_ID`.

## Billing providers

`BILLING_PROVIDER=manual` (default): an admin sets plan, status and period end in `/admin`.

`BILLING_PROVIDER=webhook`: `POST /webhooks/billing` accepts one documented signed format (see the
header of `src/billing/webhookAdapter.ts`): headers `webhook-id`, `webhook-timestamp`,
`webhook-signature: v1=<hex HMAC-SHA256(secret, "id.timestamp.body")>`, and body
`{ type, data: { account_id, customer_id, subscription_id, plan, status, current_period_end } }`.
Pass CartProbe's `account_id` as custom data at checkout (the upgrade links append it).

Paddle, Lemon Squeezy and Dodo Payments each sign and shape events differently, so connecting one
takes a small translation step: a few lines that verify the provider's own signature, then map its
event to the format above, either in a tiny Worker in front or as a new `BillingProvider`
implementation next to `webhookAdapter.ts`. Plan and status names are mapped in `PLAN_ALIASES` and
`STATUS_ALIASES`. Duplicate event ids are ignored; processing errors show in `/admin`.

## How checks and scoring work

Each check (`src/checks/<category>/index.ts`) has a stable id, title, category, severity, the engine
phase it runs in, optional `dependsOn` and `requires`, and a `run(ctx)` returning
`pass | warn | fail | skip | error`, a one-sentence summary and evidence. A check that throws becomes
`error`; the scan continues.

Scoring (`src/scan/scoring.ts`): severity points (critical 5, high 3, medium 2, low 1, info 0), pass
full, warn half, fail/error zero, skip excluded; category weights from `src/config/weights.ts`,
renormalised over applicable categories; checkout counts only when verified and in test mode. A failed
critical discovery check caps the score at 39; any other failed critical check caps it at 89.
Grades: 90+ Agent-ready, 70–89 Mostly ready, 40–69 Needs work, below 40 Not ready.

### Adding a check

1. Add a `CheckDefinition` to the right category file (pick the phase whose data it needs).
2. Write `content/fix/<check id>.md` with the sections How to fix / WooCommerce / How to verify / Spec reference.
3. Add pass/warn/fail/skip tests in `test/checks.test.ts` (use `withRoutes` to serve fixtures).
4. `npm test` (coverage tests fail if the guide is missing or the copy uses a forbidden claim word).

### Updating to a new UCP version

1. `npm run schemas:update -- 2026-12-01` (clones tag `v2026-12-01`; or `-- 2026-12-01 --from <checkout>`)
2. Add the version to `UCP_VERSIONS` and `KNOWN_RELEASES` in `src/ucp/versions.ts`; drop the oldest vendored one if you only keep two
3. Add the import to `src/ucp/validators.ts`, run `npm run build:validators`
4. Read the release's overview for changed rules (profile shape, namespace binding, capability names); update checks, `docs/UCP_NOTES.md` and fixtures
5. `npm test` (a test fails if schema folders and `versions.ts` disagree)

## Market sizing

```sh
npx tsx scripts/market-count.ts stores.txt > results.csv
```

`stores.txt` has one domain or origin per line. The script fetches each `/.well-known/ucp` with
the product's safety rules (2 domains at a time, about 1 request/second each), validates against the
vendored schemas and prints a CSV plus a summary (total, has profile, valid, latest, previous, invalid).
It needs network access and is never run by tests.

## Scanning ethics

CartProbe never places orders, never submits payment data and never calls `complete_checkout`. It
sends no checkout requests to unverified stores. Deep checkout tests (create one session, cancel it)
run only for stores whose owner verified ownership (DNS TXT or well-known file), entered a test-mode
endpoint on their own domain and ticked the test-mode confirmation. It honours robots.txt for product
pages (`CartProbeBot`), sends at most 1 request/second per domain with hard caps per plan, explains
itself at `/bot`, stores no personal data from scanned sites, deletes raw captures after 7 days and
anonymous scans after 30.

## Costs

Runs on Workers Paid ($5/month includes 10M requests and 30M CPU-ms). D1 and R2 usage at MVP scale
fits the included allowances. A scan is about 15–45 requests to the store and a few hundred ms of CPU,
split across invocations. The per-minute cron runs about 43,000 times a month and costs little when
idle. No Queues, Browser Rendering or AI calls.

## Troubleshooting

- **"Invalid environment configuration"**: a var or secret is missing or malformed; the message names it.
- **Magic link email not arriving locally**: with `EMAIL_PROVIDER=console` the link is printed in the dev terminal.
- **Scans stuck at "Fetching UCP profile"**: the cron is not running locally; trigger it with `/__scheduled` (see setup) or keep the report page open (polling advances the scan).
- **`.test` hosts rejected**: set `ENVIRONMENT=development` in `.dev.vars`.
- **`npm install` fails with "edgesOut"**: an npm 10 resolver bug when adding packages; `npx npm@11 install <pkg>` works, and `npm ci` from the lockfile is unaffected.
- **Typecheck errors after editing schemas**: run `npm run build:validators`.

## Not yet implemented

- Catalog search over **MCP** (only REST is probed; MCP-only profiles, common on Shopify, get "skip")
- A2A and embedded transport probing
- `supported_versions` leaf-profile checks
- Inviting team members to an account (members are listed only)
- A real merchant-of-record integration: the generic webhook format needs a per-provider translation (see Billing)
- PDF generation: printable reports use the browser's Print → Save as PDF
- Per-store alert routing and alert muting
- Using the demo API key from the seed requires switching the demo account to the Vendor plan in /admin
