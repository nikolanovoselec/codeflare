# Repository-only Dispatcher transport (implementation candidate)

Input remains `{ "repository": "owner/repository" }`. No context endpoint or new user setting exists. This contract is implemented locally but not CI/native/live verified.

## Loader

Repository-only generated code receives `env.OPERATOR` (generation-bound Fetcher) and `env.GITHUB_API_ORIGIN` (non-secret HTTPS origin derived from existing `GITHUB_API_HOST`, default `https://api.github.com`). Legacy single-PR Loader code receives only its existing OPERATOR binding. Credentials and original parent identity remain inside existing interceptors.

## Explicit transport

POST JSON to `https://operator.internal/v1/dispatcher/source` through OPERATOR:

```ts
{ operationId: string, url: string, method?: 'GET' | 'POST' | 'PUT', body?: string }
```

IDs match `[A-Za-z0-9_-]{1,128}`. URL is HTTPS, at most 4096 characters, without credentials, fragment or explicit port. Method defaults to GET. GET forbids body; POST/PUT require a string body, sent verbatim with parent-selected JSON content type. The entire encoded request and response envelope are limited to 64 KiB. POST/PUT destinations must use GITHUB_API_ORIGIN and the existing authenticated GitHub interceptor; Internet GET uses the existing approved EgressController/Gateway. Resource-profile installations not supported by the current composition fail closed.

Success is a parent response HTTP 200 containing:

```ts
{ url: string, status: number, headers: Record<string,string>, body: string }
```

Headers are limited to content-type, etag, last-modified, date, link and location. Remote HTTP rejection remains in `status`; it is not platform success. No caller identity, credentials, transport selector or header map is accepted. Redirects are manual. Parent current authority, installation pins, capability, generation, cancellation and original expiry remain gates.

Loader globalOutbound standard fetch supports GET/POST/PUT with the required `x-codeflare-operator-operation-id` header. Bodies are bounded strings; caller headers do not select upstream headers. Credential-bearing requests are denied. The adapter unwraps source envelopes into standard Responses; parent failure responses retain their codes.

Completed identical requests return cached receipts. Any changed immutable arguments conflict with HTTP 409 `OPERATOR_OPERATION_CONFLICT`. An uncertain mutation returns HTTP 409 `OPERATOR_OPERATION_UNKNOWN`, never resends, and preserves its live generation for safe reads. IDs must not be replaced after uncertainty. Final settlement remains fenced while any operation is unresolved.

## Receipt and resolution (approved package code only)

POST JSON to `https://operator.internal/v1/dispatcher/receipt`:

```ts
{ operationId: string }
// HTTP 200
{ operationId: string, generation: number, requestDigest: string,
  method: 'GET' | 'POST' | 'PUT', url: string,
  phase: 'reserved' | 'unknown' | 'completed', responseDigest?: string,
  operationCount: number, operationLimit: 128 }
```

Request digest is SHA-256 of `JSON.stringify({path, body})` for the parsed immutable operation; use the returned digest, do not reconstruct it. Response digest is SHA-256 of the exact persisted response body (the source envelope, not only its inner body). Receipt projection exposes no credentials, journal internals or remote body. `operationCount` counts all entries in the Activity operation journal, including inference and earlier generations, not only package source calls. It is a point-in-time observation, not a reservation or a guarantee against future unbounded inference.

Package-owned deterministic code must first validate positive, unique remote domain evidence: original target/head/text/publisher/outcome as applicable. Missing or ambiguous evidence stays unknown. A model assertion, absent receipt or a generic merged flag is not domain proof. Then POST JSON to `https://operator.internal/v1/dispatcher/resolve`:

```ts
{ operationId: string, requestDigest: string,
  readbacks: Array<{ operationId: string, requestDigest: string, responseDigest: string }> }
// HTTP 200
{ resolved: true, operationId: string, requestDigest: string }
```

There must be 1–16 unique references. Parent verifies the original unknown mutation/digest and each immutable completed successful GET receipt, reserved later than the original mutation, within the same currently authorized Activity/generation. It durably records those references and caches resolution. Identical resolution is idempotent; changed resolution references conflict. Invalid/unavailable references stay unknown; authority loss denies. The parent does not interpret GitHub/Dozzle/branch semantics or assert remote success. The resolved mutation's cached response is the resolution object, not a fabricated original upstream response: consumer code uses the resolve receipt for recovery rather than unwrapping it as a source response.

Legacy GitHub read/comment/merge and publisher contracts remain separate. This generic path does not invoke them, convert POST to GET, require blanket admin authority, add anonymous routing, or modify existing interceptor authentication. The package owns its GitHub safeguards and must account for protection/head/base races honestly.
