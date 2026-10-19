# Capability versions are valid

Each capability entry carries a `version`. Agents negotiate by exact version match, so a malformed or unknown version means the capability is never activated.

## How to fix

- Use the `YYYY-MM-DD` format.
- For `dev.ucp.*` capabilities, use the UCP release date your implementation follows; in a profile for release D, those entries declare version D.
- Third-party (`com.vendor.*`) extensions use their author's version and only need the right format.

## WooCommerce

Update the UCP plugin; if versions are configurable, set them to the release your plugin implements.

## How to verify

Each `version` value in `ucp.capabilities` should look like `2026-08-25`.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Versioning → Capability Versions”.
