# Catalog search is fast

Search took too long. Agents answer shoppers in real time and time out slow calls.

## How to fix

- Add database indexes for searched fields or use a search engine.
- Limit the default page size (agents can request more with pagination).

## WooCommerce

Use a search plugin with an index (e.g. a dedicated search service) rather than SQL `LIKE` queries over all products; enable object caching (Redis).

## How to verify

Time the curl command from “Catalog search responds”; aim for under 1.5 seconds.

## Spec reference

UCP specification, `docs/specification/shopping/catalog/` (search.md, rest.md).
