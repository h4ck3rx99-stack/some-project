# Additional transports (MCP / A2A)

Informational. Besides REST, UCP services can be offered over MCP (Model Context Protocol) and A2A (Agent-to-Agent). Some assistants prefer these. This check never lowers your score.

## How to fix

If your platform supports it, add an `mcp` (and/or `a2a`) binding to the `dev.ucp.shopping` service with its `endpoint`.

## WooCommerce

Check whether your UCP plugin offers an MCP endpoint and enable it.

## How to verify

The `ucp.services.dev.ucp.shopping` array lists entries with `transport` `mcp` or `a2a`.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Transport Layer”.
