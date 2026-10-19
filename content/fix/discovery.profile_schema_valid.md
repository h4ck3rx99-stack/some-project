# Profile matches the UCP schema

Your profile is JSON but does not match the published UCP business profile schema for the version it declares. Each listed error shows the JSON path that is wrong and the schema rule it breaks.

## How to fix

- Work through the errors from the top; one structural problem (for example a missing `payment_handlers` object) often causes several messages.
- Required at `ucp`: `version`, `services` and `payment_handlers` (both registries must exist even when empty, e.g. `"payment_handlers": {}`).
- Each service entry needs `version` and a `transport` of `rest`, `mcp`, `a2a` or `embedded`; REST/MCP/A2A bindings need an `endpoint`.
- Each capability entry needs `version` and a `schema` URL.

## WooCommerce

Update your UCP plugin to its latest release; most schema errors come from plugins written against an older spec version. If the plugin lets you edit the profile manually, fix the fields named in the errors.

## How to verify

Re-run the CartProbe scan. You can also validate locally with the UCP `ucp-schema` tool from the specification repository.

## Spec reference

Schemas: `source/schemas/profile.json` (`$defs/business_schema`), `ucp.json`, `service.json`, `capability.json` in the UCP repository; UCP specification, `docs/specification/overview/index.md`, “Profile Structure”.
