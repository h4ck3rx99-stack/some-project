# Product sitemap found

CartProbe could not find a sitemap listing your products (it looks at robots.txt `Sitemap:` lines, `sitemap_index.xml`, `product-sitemap.xml` and `sitemap.xml`).

## How to fix

Publish an XML sitemap that includes product URLs and reference it in robots.txt.

## WooCommerce

Yoast and Rank Math generate `product-sitemap.xml` automatically; WordPress core provides `wp-sitemap.xml`. Add the sitemap URL to robots.txt.

## How to verify

Open your sitemap and confirm product URLs are listed.

## Spec reference

sitemaps.org protocol.
