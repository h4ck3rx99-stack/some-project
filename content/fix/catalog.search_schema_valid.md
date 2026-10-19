# Search response matches the UCP schema

The search response does not match the catalog search response schema. Agents validate responses and may discard ones that fail.

## How to fix

- The response must have `ucp` (with `version`) and a `products` array.
- Each product needs `id`, `title`, `description` (e.g. `{"plain": "..."}`), `price_range` (`min` and `max` prices) and `variants`.
- Prices are objects `{"amount": <integer minor units>, "currency": "USD"}`.

## WooCommerce

Update the UCP plugin; schema mismatches usually mean the plugin targets an older spec version.

## How to verify

Re-run the scan; each error lists the JSON path to fix.

## Spec reference

`source/schemas/shopping/catalog_search.json` (`$defs/search_response`) and `shopping/types/product.json`; UCP specification, `docs/specification/shopping/catalog/` (search.md, rest.md).
