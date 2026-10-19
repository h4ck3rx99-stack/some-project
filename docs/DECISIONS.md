# Decisions

Each entry: decision, options considered, why.

## Precompiled Ajv validators (standalone)

Workers forbid `new Function`/`eval`, which Ajv uses to compile schemas at runtime. Options: Ajv
runtime compile (fails on Workers), an interpreting validator such as `@cfworker/json-schema`, or Ajv
"standalone" code generation. Chose Ajv standalone: `scripts/compile-validators.ts` emits
`src/ucp/generated/validators-<version>.js` at build time, keeping Ajv's exact semantics and error
paths. The generated `require()` calls for Ajv runtime helpers are hoisted into static imports so
both wrangler (esbuild) and Vitest (Vite) bundle them. `strict: false` because UCP schemas carry
custom annotations (`ucp_request`, `name`, …). Re-run `npm run build:validators` after updating schemas.

## Profile schema for 2026-04-08

That release has no `profile.json`. Its overview documents the profile as an object with `ucp` and
`signing_keys`. We validate with a minimal wrapper `{ type: object, required: [ucp], properties: { ucp:
ucp.json#/$defs/business_schema } }` defined in the compile script (not added to the vendored folder).
`signing_keys` is not validated for that version.

## Which version validates a document

A document is validated against the vendored version it declares (`ucp.version`); undeclared or
unknown versions are validated against the latest vendored version, and the check says so.

## Namespace rule across versions

2026-08-25 binds only the `schema` URL host (label-aligned reversed prefix); 2026-04-08 said `spec`
and `schema` origins must match. We apply the 2026-08-25 algorithm to every entity with a `schema`
(fail), and report a non-https `spec` URL as a warning. We do not fail 2026-04-08 profiles whose `spec`
is on another host, because the newest spec explicitly allows it (interpretation → warn, not fail).

## Catalog capability name

The brief says `dev.ucp.shopping.catalog`; the spec uses `dev.ucp.shopping.catalog.search` (and
`.lookup`). Catalog checks require `dev.ucp.shopping.catalog.search`.

## Catalog probing over REST only

CartProbe calls `POST <rest endpoint>/catalog/search`. Profiles that offer the shopping service only
over MCP/embedded (observed on a live Shopify store) get "skip" with an explanation. MCP probing is a
follow-up (README "Not yet implemented").

## Benign search query

The query is the first word of 4–20 letters in the homepage `<title>` that is not a stop word or part
of the domain; fallback `shirt`, and one retry with `shirt` if the first query returns no products.
`pagination.limit` is 10. Search is read-only, so it runs for unverified stores.

## Checkout probing for unverified stores

The spec does not document a response for an empty or invalid create-checkout body, so CartProbe sends
no checkout POST to unverified stores (brief rule 1(c) → skip). Only `checkout.capability_declared`
runs, as information.

## Deep checkout: same-domain endpoint

The owner-supplied test endpoint must be https on the verified domain or a subdomain, enforced both
in the form and in the engine. This stops a verified owner from pointing CartProbe's POSTs at someone
else's API. The engine creates one session and cancels it immediately in the same phase, so cleanup
happens even if later checks fail. `complete_checkout` is never called (tested).

## Profile fetched without following redirects

The spec forbids profile redirects and says platforms must not follow them, so the profile is fetched
with `maxRedirects: 0`; a 3xx is a `fail` with the target shown. Other fetches follow up to 3
re-validated redirects.

## Extra spec-grounded check: `discovery.profile_cache_headers`

Not in the brief's table, but the hosting MUST (public, max-age ≥ 60) is concrete and commonly
broken by WordPress. Missing/forbidden directives → fail; no ETag/Last-Modified → warn.

## SSRF model

Workers cannot resolve DNS before fetching, so `safeFetch` validates hostnames (no IP literals in
any encoding, since WHATWG parsing normalises decimal/octal/hex forms first; no localhost/`.local`/
`.internal`/single-label hosts; https and default port only; no userinfo), re-validates every
redirect, and relies on Cloudflare egress, which cannot reach private networks, as defence in depth. `.test`
hosts are allowed only when `ENVIRONMENT` is development/test (the mock store). Alert webhooks and
DNS-over-HTTPS lookups also use `safeFetch`.

## Local dev transport

`MOCK_STORE_ORIGIN` (development only) routes `*.mockstore.test` to the local mock store with an
`x-mock-host` header, after `safeFetch` validated the original URL. Production ignores it.

## Dependencies "pass" = pass or warn

`dependsOn` skips a check when a dependency failed, errored or was skipped. A warning does not skip
dependants (e.g. JSON served as text/plain still gets schema-validated).

## Scoring caps

Two caps on top of the brief's formula, so grades cannot mislead:

1. A failing critical discovery check (profile unreachable or not JSON) caps the score at 39
   ("Not ready"). Without the cap a store with no UCP at all scored 54 because catalog was excluded.
2. Any other failing critical check (e.g. `consistency.price_match`) caps at 89, so it is never
   graded "Agent-ready". Checkout failures only cap when checkout is scored.

## Product sampling

Catalog result URLs (same site only) are sampled first because they enable consistency checks, then
the remaining budget is spread evenly over sitemap product URLs. Sitemaps are always looked up so
`basics.sitemap_found` is accurate. Pages disallowed for `CartProbeBot` are never fetched.

## Price comparison

Page price (decimal, major units) is converted to minor units with string arithmetic using ISO 4217
exponents (0 for JPY etc., 3 for KWD etc.) and compared exactly. A single `price` must equal one of
the product's variant amounts; an `AggregateOffer` `lowPrice` must equal the lowest variant amount.

## Users created on verify

Login tokens store the email; the user and their personal account are created when the link is used.
`POST /login` therefore cannot be used to mass-create accounts, and responses are identical whether or
not an address exists. Per-email limiting is silent (same response).

## One account per user

The MVP shows the first account a user belongs to. Inviting members is not yet implemented; the
settings page lists members only.

## Alert semantics

A single failed profile fetch does not alert (it may be a blip); `endpoint_down` fires once, when the
second consecutive failure confirms an outage. `recovered` events never trigger an alert on their own
but are included when something else alerts. `scans.alerted_at` is claimed atomically so a retried
finalize never double-sends. With no channels configured, alerts go to the account owner's email.

## Billing webhook wire format

Paddle, Lemon Squeezy and Dodo all sign differently. The adapter accepts one documented format
(Standard-Webhooks style: `webhook-id`, `webhook-timestamp`, `webhook-signature: v1=<hex HMAC-SHA256
of "id.timestamp.body">`, 5-minute tolerance) with a small alias table for plan and status names.
Connecting a real provider means a translation step (README). Duplicate `event_id`s are acknowledged
without reprocessing; processing errors return 200 (so the provider stops retrying) and appear in /admin.

## Anonymous reports are link-shareable; account scans are private

Anonymous scan reports are visible to anyone with the unguessable slug (and `noindex`). Scans owned by
an account require membership unless made public. Alert emails link to `/r/<slug>`, which asks for
login.

## Markdown compiled at build time

Fix guides are compiled to HTML by `scripts/build-content.ts` (marked) so the Worker ships no Markdown
parser. Test fixtures are bundled the same way because workerd has no filesystem.

## Seed data is synthetic

`scripts/seed.ts` writes demo scans with registry-derived statuses (summaries say "Demo data") rather
than running the engine in Node, because extraction uses the Workers-only `HTMLRewriter`.

## Time budget per invocation

Each invocation runs at least one phase, then continues while under the budget (20 s per job, 25 s
per cron tick). Product pages are fetched in chunks of 10 (the 1 req/s politeness rule makes a chunk
take about 10 s).
