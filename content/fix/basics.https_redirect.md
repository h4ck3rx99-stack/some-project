# HTTP redirects to HTTPS

Requests to `http://` should permanently redirect (301 or 308) to `https://`. Agents only use HTTPS, and links shared with `http://` should land on the secure site.

## How to fix

Enable “Always use HTTPS” at your CDN or add a server rule redirecting all HTTP traffic to HTTPS with 301.

## WooCommerce

Set both WordPress Address and Site Address to `https://` in Settings → General; Cloudflare's “Always Use HTTPS” or your host's SSL setting adds the redirect.

## How to verify

`curl -sI http://<your-domain>/` should show `301` and `location: https://...`.

## Spec reference

General web practice; UCP requires HTTPS for profiles (UCP specification, `docs/specification/overview/index.md`, “Profile Requirements”).
