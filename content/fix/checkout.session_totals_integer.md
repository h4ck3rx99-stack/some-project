# Checkout totals are consistent integers

Checkout `totals` must be integers in minor units, contain exactly one `subtotal` and one `total`, and all non-total entries must add up to the total. The spec says platforms must not autonomously complete a checkout whose totals do not add up.

## How to fix

Compute totals with integer arithmetic in minor units; include every adjustment (tax, shipping, discounts as negative amounts) as its own entry.

## WooCommerce

Rounding differences between WooCommerce's tax calculation and the plugin's conversion are a common cause; make the plugin convert the final WooCommerce totals rather than recomputing them.

## How to verify

Check that `sum(amount for entries except total) == total`.

## Spec reference

UCP specification, `docs/specification/shopping/checkout/` (index.md, rest.md), “Totals → Verification”; `source/schemas/common/types/totals.json`.
