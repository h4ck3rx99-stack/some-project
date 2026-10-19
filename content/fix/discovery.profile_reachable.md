# UCP profile is reachable

AI shopping agents discover your store by requesting `https://<your-domain>/.well-known/ucp`. If that URL returns an error, times out, or redirects, agents treat your store as not supporting UCP.

## How to fix

- Publish a JSON business profile at exactly `/.well-known/ucp` on your store's main domain, served over HTTPS with status 200.
- Do **not** redirect this URL (no 301/302 to `www.` or to a trailing-slash version). The spec says profile endpoints must not use redirects and agents must not follow them. Serve it on the exact host shoppers use.
- Make sure firewalls, bot protection or "maintenance mode" plugins do not block `/.well-known/` paths.

## WooCommerce

- Install and activate a UCP plugin (for example "UCP Ready" or "WebToffee Universal Commerce Protocol Enabler"), then re-save your permalinks (Settings → Permalinks → Save) so WordPress registers the `/.well-known/ucp` route.
- If you use Cloudflare or a security plugin (Wordfence, iThemes), allow requests to `/.well-known/ucp`.
- If your site redirects between `www` and the bare domain, scan the domain you actually serve and make sure the profile is served there without a redirect.

## How to verify

Open `https://<your-domain>/.well-known/ucp` in a private browser window: you should see JSON, and the address bar must not change. Or run `curl -sI https://<your-domain>/.well-known/ucp` and check for `HTTP/2 200` with no `location:` header.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, sections “Profile Structure → Business Profile” and “Profile Requirements → Hosting”.
