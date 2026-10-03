# Repository-only Dispatcher transport

**Audience:** Platform developers and Dispatcher package authors

**Owns:** Generic parent transport, immutable operation receipts, response bounds and recovery fences.

**Does not own:** Package prompts, Renovate decisions, permission grants, credentials, deployment configuration or Operator activation.

## Contents

- [Loader](#loader)
- [Request ownership and meaning of transport](#request-ownership-and-meaning-of-transport)
- [Explicit transport](#explicit-transport)
- [Receipt and resolution](#receipt-and-resolution-approved-package-code-only)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

Input remains `{ "repository": "owner/repository" }`. No context endpoint or new user setting exists. Host CI passed at `7ed88105` and pinned empty-discovery native compatibility passed at `31d57cc3`. Corrected live Activity `2a530b42` produced four successful inference calls, then local source403 and assessment rejection; installed v0.1.6 full live acceptance remains unverified. Native compatibility is not authenticated effects or terminal Activity collection proof.

## Loader

Repository-only generated code receives `env.OPERATOR` (generation-bound Fetcher) and `env.GITHUB_API_ORIGIN` (non-secret HTTPS origin derived from existing `GITHUB_API_HOST`, default `https://api.github.com`). Legacy single-PR Loader code receives only its existing OPERATOR binding. Credentials and original parent identity remain inside existing interceptors. Inference supplies the trusted stable Activity ID as the existing interceptor's `sessionId` replay namespace, not as a fabricated workspace session or additional authorization. This supports native Bedrock signed tool replay across turns while isolating replay from other Activities; user, groups, selected route, credential and expiry remain parent-owned. No interceptor behavior changes.

Current Access identity verification retains issuer, expiry, matching subject/email, response and size checks. Cloudflare's documented identity without `groups` asserts no memberships: explicit user grants remain eligible, group-only grants do not. Present malformed groups still deny. This preserves authenticated source composition without JWT group substitution, anonymous modes or alternate credentials. The real Access-helper/source regression covers this contract; the historical corrected Activity 47aa5357 confirmed source HTTP 200, while full journey acceptance remained unverified. Reference: [Cloudflare User Identity](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#user-identity).

## Request ownership and meaning of transport

```text
Dispatcher Dynamic Worker → parent OPERATOR capability → existing interceptor → remote HTTP API
```

Dispatcher selects the GitHub/Internet URL, method and permitted body. The parent supplies original human identity and credentials through GitHubInterceptor/EgressController; no independent credential-bearing GitHub client or repository mirror exists in the child. The response limit belongs to the Codeflare/package wrapper, not GitHub or Flue. Four complete PR objects can exceed100KiB because GitHub includes descriptions, nested repositories/users and many URLs. One-item pages reduce response size, not total eligible PR coverage.

The Loader supplies the approved non-secret decimal string `OPERATOR_SOURCE_RESPONSE_BYTES` only to repository-only code, alongside `GITHUB_API_ORIGIN`. Package validation uses that allowance but cannot widen host authority. Reusable components and model-facing bounded artifact windows: [template documentation](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/develop/documentation/reusable-dispatcher.md). Renovate selection remains all open verified bot PRs created within the inclusive rolling14-day window, with complete pagination and no silent omission; finite128-operation/deadline gates remain.

## Explicit transport

POST JSON to `https://operator.internal/v1/dispatcher/source` through OPERATOR:

```ts
{ operationId: string, url: string, method?: 'GET' | 'POST' | 'PUT', body?: string }
```

IDs match `[A-Za-z0-9_-]{1,128}`. URL is HTTPS, at most 4096 characters, without credentials, fragment or a nondefault port. URL-normalized HTTPS `:443` is permitted. Method defaults to GET. GET forbids body; POST/PUT require a string body, sent verbatim with parent-selected JSON content type. The encoded request remains limited to64KiB. Source-response UTF-8 envelope bytes use the approved installation's optional `sourceResponseBytes`, bounded by its operator policy and Environment management ceiling. Each omitted value defaults to65536bytes, including older saved records; no implicit raised inheritance or clamping applies. The supported-cap candidate is1MiB pending this correction's receipt-storage/native verification. Source body and final encoded envelope are both checked; escaping/headers add bytes. Changing the setting retains current revision and disable/re-enable fences. Requests, inference, final results and SDK update/history bounds do not increase. POST/PUT destinations must use GITHUB_API_ORIGIN and the existing authenticated GitHub interceptor; Internet GET uses the existing approved EgressController/Gateway. Resource-profile installations not supported by the current composition fail closed.

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


## Requirement and Source Map

| Contract | Owner and evidence |
|---|---|
| [Generic transport](../../sdd/spec/operator-registry.md#req-operator-062-repository-only-dispatcher-transport) | `src/operators/operator-runtime-capability.ts::createDispatcherOperation`, `src/operators/activity.ts::OperatorActivity`; `src/__tests__/operators/dispatcher-production.test.ts` |
| [Exact settlement](../../sdd/spec/operator-registry.md#req-operator-048-dispatcher-execution) | `src/operators/dispatcher-result.ts::readDispatcherUpdates`; compiled native fixtures and exact-submission tests |
| [Loader projection](../../sdd/spec/operators.md#req-operator-015-isolated-approved-worker-loading) | `src/operators/loader.ts::loadOperatorDispatcherClass`; `src/__tests__/operators/dispatcher-native.test.ts` |

## Related Documentation

- [Operator Interface](operators.md)
- [Registry contract](../../sdd/spec/operator-registry-contract.md)
- [Reusable Dispatcher package](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/develop/documentation/reusable-dispatcher.md)

Publication, installation, activation, deployment, settlement, effects and physical cleanup remain separate evidence gates. This document neither authorizes Operator activation nor certifies a complete live journey.
