# Prices are machine-readable

Structured-data prices must be plain decimals with a dot (`1299.00`): no currency symbols, thousands separators or HTML, and no more decimal places than the currency uses.

## How to fix

Output `"price": "1299.00"` and put the currency in `priceCurrency`.

## WooCommerce

Check WooCommerce → Settings → General currency options; some themes print formatted prices (`$1,299.00`) into JSON-LD. Prefer the structured data from WooCommerce or your SEO plugin.

## How to verify

In page source, `price` should look like `19.99`.

## Spec reference

Google Search Central “Product structured data” and schema.org `Product`/`Offer`.
