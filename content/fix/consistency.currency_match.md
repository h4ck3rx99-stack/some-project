# Catalog currency matches product pages

The catalog uses a different currency than the product page for the same product.

## How to fix

Report prices in the same currency in both places, or make sure the catalog honours the buyer's context consistently.

## WooCommerce

Check multi-currency or geolocation plugins: CartProbe fetches pages without cookies from Cloudflare's network, so the default currency is used.

## How to verify

Compare `priceCurrency` on the page with `price.currency` in search results.

## Spec reference

UCP amounts: `source/schemas/common/types/amount.json` (integer minor units; no tolerance defined).
