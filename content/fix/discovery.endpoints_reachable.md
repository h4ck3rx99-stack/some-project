# Declared service endpoints respond

Your profile declares service endpoints (REST, MCP or A2A) that returned a server error or did not respond. CartProbe sends only a plain GET with no side effects; any response below 500 counts as alive.

## How to fix

- Check the `endpoint` URLs under `ucp.services` are correct and publicly reachable over HTTPS.
- Look at server logs for 5xx errors on those paths.
- Endpoints should not have a trailing slash; OpenAPI paths are appended directly.

## WooCommerce

- Make sure the WordPress REST API is enabled (some security plugins disable it for logged-out users).
- Re-save permalinks after installing the UCP plugin.

## How to verify

`curl -s -o /dev/null -w '%{http_code}' <endpoint>` should print a status below 500.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Services → Endpoint Resolution”.
