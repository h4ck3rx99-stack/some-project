# Products have brand and identifiers

Brand plus a global identifier (GTIN/EAN/UPC or MPN) or at least a SKU lets agents match your product to what the shopper asked for and compare offers.

## How to fix

Add `brand` (`{"@type":"Brand","name":"..."}`) and `gtin13`/`gtin`/`mpn`/`sku` to Product markup.

## WooCommerce

- WooCommerce has a built-in “GTIN, UPC, EAN, or ISBN” field (since 9.2) under Inventory; fill it in.
- Brands: use WooCommerce Brands, and make sure your SEO plugin maps it to `brand`.

## How to verify

Check the JSON-LD contains `brand` and one identifier.

## Spec reference

Google Search Central “Product structured data” and schema.org `Product`/`Offer`.
