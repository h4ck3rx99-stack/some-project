# Product pages have structured data

Product pages should include schema.org `Product` (or `ProductGroup` for variants) as JSON-LD. Agents and shopping surfaces read it to understand what a page sells.

## How to fix

Add a `<script type="application/ld+json">` block with a `Product` (name, image, offers…) to every product page.

## WooCommerce

- WooCommerce outputs basic Product JSON-LD by default; it can be removed by themes or page builders. SEO plugins (Yoast WooCommerce SEO, Rank Math) output richer markup.
- Check your theme does not dequeue WooCommerce structured data.

## How to verify

Paste a product URL into Google's Rich Results Test or Schema.org validator.

## Spec reference

Google Search Central “Product structured data” and schema.org `Product`/`Offer`.
