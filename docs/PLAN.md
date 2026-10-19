# CartProbe MVP plan

The working folder was an empty git repository (no `docs/INSPECTION.md` needed), so everything was
scaffolded fresh. Build order followed the brief's priority list; each step was committed with
tests before the next began.

| #   | Step                                                                                                              | Status |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Clone UCP spec, study it, vendor schemas for 2026-08-25 (latest) and 2026-04-08 (previous), precompile validators | Done   |
| 2   | `safeFetch` + robots parser, with tests                                                                           | Done   |
| 3   | Check engine: 37 checks, scoring, diff, fixtures derived from spec examples, mock store (9 variants)              | Done   |
| 4   | Public scan + report with live progress                                                                           | Done   |
| 5   | Magic-link auth, stores, ownership verification, monitoring, alerts (email/webhook/Slack)                         | Done   |
| 6   | Billing: provider interface, manual mode, generic signed-webhook adapter                                          | Done   |
| 7   | Admin: plan override, failed jobs + retry, alert/webhook errors, health                                           | Done   |
| 8   | Vendor API, API keys, badges                                                                                      | Done   |
| 9   | Cron jobs: runner, daily enqueue, cleanup, weekly digest                                                          | Done   |
| 10  | Seed, market-count, docs, CI                                                                                      | Done   |

## Architecture in one paragraph

A single Cloudflare Worker (Hono + hono/jsx SSR) serves every page and API. Scans are rows in D1
(`scans`, `check_results`) driven by a `scan_jobs` table: each job moves through phases
(`discovery → catalog → products:<offset> → consistency → basics → checkout → finalize`) with
its state in JSON, so a scan can be split across many short invocations. Work is picked up by the
per-minute cron, by `waitUntil` after `POST /scan`, and by report-page status polling, all guarded
by a lease. All outbound requests go through `safeFetch`. Raw captures go to R2 for 7 days.
