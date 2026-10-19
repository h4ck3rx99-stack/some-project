# Test checkout session can be created

With your permission (verified ownership and a confirmed test-mode endpoint), CartProbe created a checkout session for one in-stock item and validated the response against the checkout schema. CartProbe never submits payment details and never completes a checkout.

## How to fix

- `POST /checkout-sessions` with `{"line_items":[{"item":{"id":"..."},"quantity":1}]}` must return 200/201 with a checkout object: `ucp`, `id`, `line_items`, `status`, `currency`, `totals`, `links`.
- Fix the schema errors listed in the evidence.

## WooCommerce

Point CartProbe at your plugin's test/sandbox endpoint and make sure the WooCommerce payment gateway is in test mode.

## How to verify

Re-run the scan from your dashboard after fixing.

## Spec reference

UCP specification, `docs/specification/shopping/checkout/` (index.md, rest.md); `source/schemas/shopping/checkout.json`.
