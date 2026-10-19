# Profile responds quickly

Your profile took long to start responding. Agents fetch it at the start of a conversation and may give up on slow stores.

## How to fix

- Serve the profile from cache (it changes rarely): a CDN edge cache or a static file is ideal.
- The spec already requires `Cache-Control: public, max-age` of at least 60 seconds, which lets CDNs cache it.

## WooCommerce

Use a page cache or CDN that caches `/.well-known/ucp`; avoid generating the profile with heavy database queries on each request.

## How to verify

`curl -s -o /dev/null -w '%{time_starttransfer}\n' https://<your-domain>/.well-known/ucp` should be under 0.8 seconds.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Profile Requirements → Hosting”.
