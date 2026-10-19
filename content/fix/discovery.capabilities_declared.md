# Shopping capabilities are declared

Your profile lists no shopping capabilities, so agents have nothing they can call on your store.

## How to fix

Declare the capabilities you actually support under `ucp.capabilities`, for example:

```json
"dev.ucp.shopping.catalog.search": [{ "version": "2026-08-25", "spec": "https://ucp.dev/2026-08-25/specification/shopping/catalog/search", "schema": "https://ucp.dev/2026-08-25/schemas/shopping/catalog_search.json" }],
"dev.ucp.shopping.checkout": [{ "version": "2026-08-25", "spec": "https://ucp.dev/2026-08-25/specification/shopping/checkout", "schema": "https://ucp.dev/2026-08-25/schemas/shopping/checkout.json" }]
```

Only declare what your endpoints really implement.

## WooCommerce

In your UCP plugin's settings, enable catalog search and checkout. Some plugins disable capabilities until WooCommerce REST API keys or payment settings are configured.

## How to verify

The profile's `ucp.capabilities` object should list `dev.ucp.shopping.*` names.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Capabilities” and “Standard Capabilities”.
