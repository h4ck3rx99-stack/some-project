# Third-party components

All licences are on the allowed list (MIT, Apache-2.0, BSD-2/3, ISC; 0BSD is a public-domain-equivalent
variant used only by a transitive dev-time type helper).

## Runtime (bundled into the Worker)

| Package              | Version | Licence      | Purpose                                                    |
| -------------------- | ------- | ------------ | ---------------------------------------------------------- |
| hono                 | 4.13.13 | MIT          | HTTP routing, JSX server rendering, cookies                |
| drizzle-orm          | 0.45.4  | Apache-2.0   | D1 queries and schema                                      |
| zod                  | 4.6.7   | MIT          | Input and env validation                                   |
| ajv                  | 8.20.0  | MIT          | JSON Schema runtime helpers for the precompiled validators |
| ajv-formats          | 3.0.1   | MIT          | `uri`, `date`, … formats used by UCP schemas               |
| fast-deep-equal      | 3.1.3   | MIT          | (ajv dependency)                                           |
| fast-uri             | 3.1.8   | BSD-3-Clause | (ajv dependency)                                           |
| json-schema-traverse | 1.0.0   | MIT          | (ajv dependency)                                           |
| require-from-string  | 2.0.2   | MIT          | (ajv dependency)                                           |

## Development only

| Package                               | Licence           | Purpose                                                      |
| ------------------------------------- | ----------------- | ------------------------------------------------------------ |
| wrangler                              | MIT OR Apache-2.0 | Local dev, D1 migrations, deploy                             |
| @cloudflare/vitest-plugin             | MIT               | Tests inside workerd with real D1                            |
| @cloudflare/workers-types             | MIT OR Apache-2.0 | Types                                                        |
| vitest                                | MIT               | Test runner                                                  |
| typescript                            | Apache-2.0        | Type checking (6.0.x, the newest typescript-eslint supports) |
| eslint, @eslint/js, typescript-eslint | MIT               | Linting                                                      |
| prettier                              | MIT               | Formatting                                                   |
| drizzle-kit                           | MIT               | Migration generation                                         |
| tsx                                   | MIT               | Running scripts                                              |
| marked                                | MIT               | Compiling fix guides at build time                           |
| @types/node                           | MIT               | Types for scripts                                            |

## Vendored content

| Content                                                           | Licence    | Location                                                    |
| ----------------------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| Universal Commerce Protocol JSON Schemas (2026-04-08, 2026-08-25) | Apache-2.0 | `schemas/ucp/` with `LICENSE` and `NOTICE` (source commits) |

No code was copied from GPL WordPress plugins.
