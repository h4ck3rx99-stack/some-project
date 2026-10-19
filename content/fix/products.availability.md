# Products state availability

`offers.availability` should use a schema.org ItemAvailability URL such as `https://schema.org/InStock` or `https://schema.org/OutOfStock`. Bare words like `InStock` or `in stock` are not reliably understood.

## How to fix

Output the full URL form, e.g. `"availability": "https://schema.org/InStock"`.

## WooCommerce

Enable stock management in WooCommerce → Settings → Products → Inventory so availability is accurate; SEO plugins output the URL form.

## How to verify

Look for `"availability": "https://schema.org/..."` in the page source.

## Spec reference

schema.org `ItemAvailability`.
