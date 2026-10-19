# Homepage responds quickly

Your homepage was slow to start responding, a sign that every page and API call is slow.

## How to fix

Enable full-page caching and a CDN; check for slow plugins or database queries.

## WooCommerce

Use a caching plugin (or your host's built-in cache), enable object caching, and audit slow plugins with Query Monitor.

## How to verify

Measure time to first byte with `curl -s -o /dev/null -w '%{time_starttransfer}\n' https://<your-domain>/`.

## Spec reference

General web performance practice.
