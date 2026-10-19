# Checkout capability is declared

Without `dev.ucp.shopping.checkout`, agents can recommend your products but cannot help a shopper buy them. For stores without verified ownership this result is informational and does not affect the score.

## How to fix

Implement the checkout capability (create, get, update, complete, cancel checkout sessions) and declare it in your profile.

## WooCommerce

Enable checkout in your UCP plugin and configure a supported payment handler.

## How to verify

Look for `dev.ucp.shopping.checkout` under `ucp.capabilities`.

## Spec reference

UCP specification, `docs/specification/shopping/checkout/` (index.md, rest.md).
