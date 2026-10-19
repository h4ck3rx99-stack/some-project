# robots.txt allows product pages

Your robots.txt blocks product URLs for CartProbeBot (and the rules shown probably block other agents too). CartProbe honours robots.txt, so those pages were not sampled.

## How to fix

Remove `Disallow` rules covering product paths, or add an `Allow` for them. Keep blocking cart, checkout and account pages.

## WooCommerce

Check robots.txt rules added by SEO or security plugins; `Disallow: /product/` is a common mistake.

## How to verify

Use a robots.txt tester with a product URL and the user agent `CartProbeBot`.

## Spec reference

RFC 9309; see also CartProbe's /bot page.
