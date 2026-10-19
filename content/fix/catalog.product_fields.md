# Products include required fields

Some products returned by search are missing fields the spec requires, or lack a product URL or variant availability that agents rely on.

## How to fix

Required on each product: `id`, `title`, `description`, `price_range`, `variants`. Required on each variant: `id`, `title`, `description`, `price` (integer `amount` + `currency`). Strongly recommended: product `url` and variant `availability` (`{"available": true}`).

## WooCommerce

Fill in product descriptions in WooCommerce (empty descriptions are common) and make sure each variation has a price.

## How to verify

Re-run the scan; evidence lists each product id and the missing fields.

## Spec reference

`source/schemas/shopping/types/product.json`, `variant.json`, `availability.json`.
