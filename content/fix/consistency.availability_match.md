# Catalog availability matches product pages

The catalog API and the product page disagree on whether an item is in stock. Agents may offer something shoppers cannot buy, or skip products that are available.

## How to fix

Use one inventory source for both; when stock changes, invalidate both the API response cache and page cache.

## WooCommerce

Enable WooCommerce stock management and make sure your page cache purges on stock changes (most cache plugins have a WooCommerce option for this).

## How to verify

Compare `availability` in the page JSON-LD with `variants[].availability.available` in search results.

## Spec reference

UCP specification, `docs/specification/shopping/catalog/` (search.md, rest.md); `source/schemas/shopping/types/availability.json`.
