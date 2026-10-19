# Schema URLs match capability namespaces

UCP binds each capability name to the domain that serves its schema. The `schema` URL host, with its labels reversed, must equal the name or be a label-aligned prefix of it: `dev.ucp.shopping.checkout` must use a schema on `ucp.dev`. Agents must ignore entities whose schema URL fails this rule.

## How to fix

- For `dev.ucp.*` capabilities, point `schema` at `https://ucp.dev/<version>/schemas/...`, not at a copy on your CDN or plugin host.
- For your own extensions, use your own namespace (`com.yourcompany.*`) and serve the schema from `yourcompany.com`.
- The URL must be https and must not contain `user@` tricks.

## WooCommerce

If your UCP plugin rewrites schema URLs to a local copy, look for a setting to use the canonical ucp.dev URLs, or report it to the plugin author.

## How to verify

For each capability, reverse the schema host labels (`ucp.dev` → `dev.ucp`) and check the capability name starts with it followed by a dot.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Namespace Governance → Authority Binding → Derivation algorithm”.
