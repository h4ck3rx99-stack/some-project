# Profile is cacheable

The spec requires published profiles to send `Cache-Control` with `public` and a `max-age` of at least 60 seconds, and forbids `private`, `no-store` and `no-cache`. It also recommends an `ETag` or `Last-Modified` header.

## How to fix

Send for example `Cache-Control: public, max-age=300` and an `ETag` on `/.well-known/ucp`.

## WooCommerce

- WordPress often adds `no-cache` headers for dynamic routes. Your UCP plugin may need a setting, or add a header rule in your web server or CDN for this path.
- Cloudflare: a Cache Rule for `/.well-known/ucp` with an edge TTL plus a Transform Rule that sets `Cache-Control`.

## How to verify

`curl -sI https://<your-domain>/.well-known/ucp | grep -iE 'cache-control|etag|last-modified'`.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Profile Requirements → Hosting” (items 3 and 4).
