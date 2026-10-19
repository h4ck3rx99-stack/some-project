# Catalog search responds

CartProbe sent a harmless catalog search (`POST <endpoint>/catalog/search` with a common word) and it failed. Agents use search to find products to recommend.

## How to fix

- Implement `POST /catalog/search` under your REST endpoint, accepting a JSON body like `{"query": "shoes"}`.
- Requests from agents carry a `UCP-Agent` header with their profile URL; do not reject unknown agents outright for read-only search.
- Return HTTP 200 with a JSON body even when nothing matches (an empty `products` array).

## WooCommerce

- Confirm the plugin's catalog feature is enabled and the WooCommerce REST API works (`/wp-json/wc/v3/` should respond).
- Security plugins that block POST requests from non-browsers may need an allow rule for the UCP endpoint path.

## How to verify

Run `curl -s -X POST <endpoint>/catalog/search -H 'content-type: application/json' -H 'UCP-Agent: profile="https://example.com/.well-known/ucp"' -d '{"query":"shirt"}'`.

## Spec reference

UCP specification, `docs/specification/shopping/catalog/` (search.md, rest.md); REST binding `source/services/shopping/rest.openapi.json` operation `search_catalog`.
