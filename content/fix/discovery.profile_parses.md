# Profile is valid JSON

The profile body could not be parsed as a JSON object. A stray PHP warning, an HTML error page, or a trailing comma is enough to break it.

## How to fix

- Fetch the URL and paste the body into a JSON validator to find the exact error.
- Remove anything printed before the JSON (debug output, BOM characters, PHP notices).
- The top level must be an object with a `ucp` member.

## WooCommerce

- Turn off `WP_DEBUG_DISPLAY` on production so PHP notices are not printed into responses.
- Update the UCP plugin; if the problem started after an update, check the plugin's support forum.

## How to verify

`curl -s https://<your-domain>/.well-known/ucp | python3 -m json.tool` should pretty-print without an error.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Profile Structure”.
