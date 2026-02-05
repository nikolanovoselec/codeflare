# Deploy a Hello World Worker

Build and deploy a Hello World Cloudflare Worker using the Hono framework. No external
dependencies beyond what the scaffold provides.

## Routes

`GET /` returns plain text "Hello World" with status 200.

`GET /api/info` returns JSON with three fields: `status` ("ok"), `timestamp` (valid ISO 8601),
and `runtime` ("cloudflare-workers").

Any other route returns plain text "Not Found" with status 404.

## Development Approach

TDD: write failing tests first, then implement. All tests pass before deployment.
