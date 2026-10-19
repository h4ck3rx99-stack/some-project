# Profile uses the current UCP version

`ucp.version` in your profile is not the latest published UCP release. Agents prefer the newest version both sides support; staying behind means newer features (and eventually older-version support) are lost.

## How to fix

- Upgrade your UCP implementation to the latest release and set `ucp.version` to it.
- If you must keep supporting an older version, keep the newest version at `/.well-known/ucp` and list older ones in `ucp.supported_versions`, each pointing to a complete profile for that version.
- `ucp.version` must be a dated release (`YYYY-MM-DD`); values like `"draft"` must never be published.

## WooCommerce

Update the UCP plugin. After updating, clear any page cache so the new profile is served.

## How to verify

Check `ucp.version` at `https://<your-domain>/.well-known/ucp` and compare with the latest release listed on ucp.dev.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Versioning → Protocol Version” and “Pre-release Versions”.
