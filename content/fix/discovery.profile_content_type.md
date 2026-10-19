# Profile is served as JSON

Your profile body should be sent with a JSON `Content-Type` header. Some clients refuse to parse a body declared as `text/html` or `text/plain`.

## How to fix

Set the response header `Content-Type: application/json` for `/.well-known/ucp`.

## WooCommerce

- Most UCP plugins set the header automatically. If you see `text/html`, a caching or optimisation plugin may be rewriting the response: exclude `/.well-known/ucp` from page caching and HTML minification.
- On Nginx you can add `location = /.well-known/ucp { default_type application/json; }`.

## How to verify

`curl -sI https://<your-domain>/.well-known/ucp | grep -i content-type` should print `application/json`.

## Spec reference

UCP specification, `docs/specification/overview/index.md`, “Profile Structure”.
