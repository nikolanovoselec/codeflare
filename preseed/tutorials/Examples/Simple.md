# Deploy a Hello World Worker

Build and deploy a small Cloudflare Worker with Hono. Use only dependencies supplied by the scaffold. Small means small. If this turns into a framework comparison or a twelve-file architecture exercise, something has gone wrong.

## Routes

`GET /` returns `Hello World` as plain text with status 200.

`GET /api/info` returns JSON with exactly three fields:

- `status`: `ok`
- `timestamp`: a valid ISO 8601 timestamp
- `runtime`: `cloudflare-workers`

Every other route returns `Not Found` as plain text with status 404.

## Delivery contract

Write failing behavioral tests first. Prove both successful routes, response content types, timestamp validity, and the 404 path. Implement only what those behaviors need. All tests and required CI must pass before deployment.
