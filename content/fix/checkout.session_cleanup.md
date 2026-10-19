# Test checkout session is cancelled

After creating the test session CartProbe immediately cancelled it with `POST /checkout-sessions/{id}/cancel`. The response should show `status: "canceled"` so no stock stays reserved.

## How to fix

Implement the cancel operation and return the updated checkout with status `canceled`.

## WooCommerce

Make sure the plugin releases held stock when a session is cancelled.

## How to verify

Create and cancel a session manually against your test endpoint.

## Spec reference

UCP specification, `docs/specification/shopping/checkout/` (index.md, rest.md), “Cancel Checkout”.
