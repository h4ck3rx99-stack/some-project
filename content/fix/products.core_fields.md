# Products have name, image and price

The basic fields an agent needs to present a product are missing on some pages: `name`, `image`, `offers.price` (or `lowPrice` for a range) and `offers.priceCurrency`.

## How to fix

Make sure every Product has all four. For variable products use `ProductGroup` with `hasVariant`, or an `AggregateOffer` with `lowPrice`/`highPrice`.

## WooCommerce

Set a featured image and a price on every product and variation; WooCommerce omits `offers` when a product has no price.

## How to verify

Validate a few product URLs in the Rich Results Test.

## Spec reference

Google Search Central “Product structured data” and schema.org `Product`/`Offer`.
