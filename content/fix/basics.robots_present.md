# robots.txt is present

`/robots.txt` tells crawlers and agents what they may fetch and where your sitemaps are. It was missing or unreachable.

## How to fix

Serve a robots.txt at the site root with at least `User-agent: *` and a `Sitemap:` line pointing at your sitemap.

## WooCommerce

WordPress generates a virtual robots.txt; SEO plugins let you edit it. Make sure a physical file or security rule is not returning an error.

## How to verify

Open `https://<your-domain>/robots.txt`.

## Spec reference

RFC 9309 (Robots Exclusion Protocol).
