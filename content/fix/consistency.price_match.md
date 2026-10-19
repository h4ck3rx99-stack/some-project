# Catalog prices match product pages

For products that appear both in your catalog API and on your website, CartProbe converts both prices to minor units and compares them exactly. A mismatch means agents see one price and shoppers another.

## How to fix

- Make sure the UCP catalog and the product page read from the same price source, including sale prices and their schedule.
- Check currency conversion and tax display: if pages show tax-inclusive prices, the API should be consistent with how you charge.
- Clear caches after price changes (stale page cache is the most common cause).

## WooCommerce

- Sale prices: confirm the UCP plugin uses the active price (`get_price()`), not the regular price.
- Multi-currency plugins: make sure the API and the page use the same currency.
- Purge your page cache and CDN after bulk price edits.

## How to verify

Re-run the scan after clearing caches; evidence lists each URL with both values.

## Spec reference

UCP amounts: `source/schemas/common/types/amount.json` (integer minor units; no tolerance defined); UCP specification, `docs/specification/shopping/catalog/` (search.md, rest.md).
