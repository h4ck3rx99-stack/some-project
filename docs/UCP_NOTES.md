# UCP notes: what CartProbe's checks rely on

Source: `https://github.com/Universal-Commerce-Protocol/ucp`, tags `v2026-08-25`
(commit `cd78fb38e819de77d9b527d110476eccb876f1bd`) and `v2026-04-08` (commit
`a25a4a24e738b74c8fa83254448d0666e478f595`). Paths below are relative to the spec repository at
`v2026-08-25` unless stated. Published releases (git tags): 2026-01-11, 2026-01-23, 2026-04-08,
2026-08-25.

## Profile location and structure

- Businesses publish at `/.well-known/ucp` (`docs/specification/overview/index.md`, "Profile Structure → Business Profile").
- A profile is a JSON object with a required `ucp` member; `ucp.version`, `ucp.services` and
  `ucp.payment_handlers` are required (registries must exist even when empty), `ucp.capabilities` is
  optional (same section). Signing keys live in top-level `keys[]` (2026-08-25); 2026-04-08 used
  `signing_keys`.
- Schema: `source/schemas/profile.json#/$defs/business_schema` → `ucp.json#/$defs/business_schema`,
  `service.json#/$defs/business_schema`, `capability.json#/$defs/business_schema` (requires `schema`),
  `payment_handler.json`. 2026-04-08 has no `profile.json`; see DECISIONS "Profile schema for 2026-04-08".
- `ucp.supported_versions` maps older versions to leaf profile URLs (overview "Versioning → Protocol Version").

## Hosting rules (used by discovery checks)

`overview/index.md` "Profile Requirements → Hosting": HTTPS; profile endpoints **must not** redirect;
`Cache-Control` with `public` and `max-age` ≥ 60, not `private`/`no-store`/`no-cache`; `ETag` or
`Last-Modified` recommended. "Fetching": platforms must not follow redirects, should bound body size
(no lower than 128 KiB), must reject special-use IPs.

## Versions

- Format `YYYY-MM-DD` (`ucp.json#/$defs/version`, pattern `^\d{4}-\d{2}-\d{2}$`).
- Non-date versions like `"draft"` must not be published (overview "Pre-release Versions").
- Capability versions negotiate by exact equality; `dev.ucp.*` entries in a release-D profile declare
  version D; third-party versions are author-controlled (overview "Capability Versions").

## Capability names

Reverse-domain `{reverse-domain}.{service}.{capability}` (overview "Naming Convention"). Shopping
capabilities in 2026-08-25 include `dev.ucp.shopping.checkout`, `.cart`, `.order`, `.fulfillment`,
`.discount`, `.catalog.search`, `.catalog.lookup`, `.buyer_consent`, `.permalink`. **Catalog is
`dev.ucp.shopping.catalog.search`**, not `dev.ucp.shopping.catalog` (`docs/specification/shopping/catalog/rest.md`).

## Namespace / host rule

2026-08-25 overview "Authority Binding → Derivation algorithm": only the `schema` URL is bound. Parse
with WHATWG URL; must be https, no userinfo, ≥2-label non-IP host; reverse host labels to form
`authority_prefix`; valid iff name equals it or starts with it plus `.` (label-aligned). Table of
accept/reject cases in the same section (all are in `test/ucp.test.ts`). `spec` URLs only need https.
2026-04-08 (`docs/specification/overview.md` "Spec URL Binding") required both `spec` and `schema`
origins to match; see DECISIONS.

## Transports and endpoints

`service.json`: transports `rest`, `mcp`, `a2a`, `embedded`; business bindings for REST/MCP/A2A require
`endpoint`. Endpoint resolution: OpenAPI paths appended to `endpoint` (overview "Endpoint Resolution").
REST operations (`source/services/shopping/rest.openapi.json`): `POST /catalog/search`,
`POST /catalog/lookup`, `POST /catalog/product`, `POST /checkout-sessions`,
`GET|PUT /checkout-sessions/{id}`, `POST /checkout-sessions/{id}/complete`,
`POST /checkout-sessions/{id}/cancel`, carts, `GET /orders/{id}`. Required request headers include
`UCP-Agent: profile="<platform profile URL>"` and `Request-Id` (UUID); state-changing operations
take `Idempotency-Key`.

## Catalog search

Request `shopping/catalog_search.json#/$defs/search_request` (all optional: `query`, `filters`,
`pagination`…). Response `#/$defs/search_response`: required `ucp` and `products[]`. Product
(`shopping/types/product.json`) requires `id`, `title`, `description`, `price_range`, `variants`;
variant (`variant.json`) requires `id`, `title`, `description`, `price`; `url` and `availability`
(`{available, status}`) are optional.

## Money

`common/types/amount.json`: integer, minimum 0, ISO 4217 minor units. `price.json`: `{amount, currency}`
with `currency` matching `^[A-Z]{3}$`. Totals use `signed_amount.json`. No rounding tolerance is defined.

## Checkout

`shopping/checkout.json` requires `ucp, id, line_items, status, currency, totals, links`. Create request
example: `{"line_items":[{"item":{"id":"..."},"quantity":1}]}` (`docs/specification/shopping/checkout/rest.md`).
Totals (`common/types/totals.json`, checkout `index.md` "Totals"): exactly one `subtotal` and one
`total`; sum of all non-total entries must equal `total` (Verification section); platforms must not
autonomously complete a checkout with mismatched totals. Cancel returns status `canceled`.

## Errors

`common/types/error_response.json`: `ucp.status = "error"` plus `messages[]` with `code`, `content`,
`severity`. Business outcomes return HTTP 200 with messages; protocol errors use 4xx/5xx
(`checkout/rest.md` "Status Codes"/"Error Responses"). The spec does not document a response for an
empty or invalid create-checkout body, so CartProbe sends **no** checkout requests to unverified stores.
