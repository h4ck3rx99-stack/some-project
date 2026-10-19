# Prices use integer minor units

UCP money amounts are integers in the currency's minor unit: $19.99 is `1999`, ¥1500 is `1500`. A decimal like `19.99` in an `amount` field is invalid and breaks price display and comparisons.

## How to fix

Convert prices with exact arithmetic: `amount = round(price × 10^exponent)` where the exponent is 2 for USD/EUR/INR, 0 for JPY/KRW, 3 for KWD/BHD. Never send floats.

## WooCommerce

If your plugin outputs decimals, update it or report the bug; WooCommerce stores prices as decimal strings, so the plugin must convert them.

## How to verify

In the search response, every `amount` should be a whole number.

## Spec reference

`source/schemas/common/types/amount.json` (integer, minimum 0) and `price.json`.
