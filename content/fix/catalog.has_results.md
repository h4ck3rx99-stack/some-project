# Search returns products

A common search returned no products. If agents get empty results for ordinary words, they assume you do not sell those items.

## How to fix

- Make sure published, in-stock products are included in the search index the UCP endpoint uses.
- Support simple keyword matching on title and description at minimum.

## WooCommerce

Check that the UCP plugin includes all published product types (simple, variable) and is not limited to a category.

## How to verify

Search your catalog endpoint for a word that appears in several product titles.

## Spec reference

UCP specification, `docs/specification/shopping/catalog/` (search.md, rest.md).
