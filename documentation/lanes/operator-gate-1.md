# Operator Gate 1 evidence matrix

**Audience:** Phase-1 implementers and acceptance operators  
**Owns:** Separation of fixture, native-runtime and deployed evidence for G1-01–29.  
**Does not own:** Flue, operational Remote Reviews, merge gates, production publisher workflows or Gate 3.

A source/CI entry proves deterministic behavior, rejection, race and recovery cases. Environment cells add exact deployed identity and the live observations that cannot be established in CI.

A row is accepted only from that combination. A deployment, 202 response, upload acknowledgement or UI render alone is not sufficient.

## Contents

- [Evidence matrix](#evidence-matrix)
- [Evidence record](#evidence-record)
- [Fixture and regression baseline](#fixture-and-regression-baseline)
- [Gate execution rule](#gate-execution-rule)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

## Evidence matrix

| Case | Source / CI evidence | `enterprise-integration` | `integration` |
|---|---|---|---|
| G1-01 Registration | REQ-OPERATOR-002/011/013/014 distribution, admission, policy and admin-route tests | Accepted: E1 + C1 | Accepted absent: N1 + C1 |
| G1-02 Access eligibility | REQ-OPERATOR-001 signed-human and admin authorization tests | Accepted: E1/E3 + C1 | Accepted absent: N1 + C1 |
| G1-03 Execution identity | Protected context, durable container-context and ownership tests | Accepted: E1/E2 + C1 | Accepted absent: N1 + C1 |
| G1-04 Disable race | Registry admission ordering and capability tests | Accepted: E4 + C1 | Accepted absent: N1 + C1 |
| G1-05 Dynamic Worker | Native Loader/workerd fixture and durable runtime generations | Accepted: E2 + C1 | Accepted absent: N1 + C1 |
| G1-06 Session lifecycle | Owned-session, host Pi service/router and PID1 tests | Accepted: E2/E4 + C1 | Accepted absent: N1 + C1 |
| G1-07 Ownership | Owned-session conflict, sync scope and browser owner-index tests | Accepted: E2 + C1 | Accepted absent: N1 + C1 |
| G1-08 Pi semantics | Structured conversation/task/recovery/abort and SDK characterization tests | Accepted: E2 + C1 | Accepted absent: N1 + C1 |
| G1-09 R2 smoke | Explicit upload, independent verifier and sealed-write tests | Accepted: E2 + C1 | Accepted absent: N1 + C1 |
| G1-10 Sync failure | Unknown-outcome, reconciliation, expiry and manifest-last tests | Accepted: F1 + C1 | Accepted absent: N1 + C1 |
| G1-11 Restricted storage | Restricted env, sync I/O, interception and shutdown tests | Accepted: E2/F1 + C1 | Accepted absent: N1 + C1 |
| G1-12 Shared home | Restricted activity roots and ordinary-session regression suites | Accepted: E2 + C1 | Accepted: N1 + C1 |
| G1-13 Interceptor profile | Egress/GitHub/R2/Browser policy tests | Accepted: E2/F1 + C1 | Accepted absent: N1 + C1 |
| G1-14 JWT settings | JWT policy, transport stamping and redirect/spoof tests | Accepted: E1/E3 + C1 | Accepted unchanged: N1 + C1 |
| G1-15 Enterprise backend | Distribution JWT and recipient transport fixtures | Accepted: E1/E2 + C1 | Accepted absent: N1 + C1 |
| G1-16 Expiry/revocation | Execution-context expiry/reauth and PID1 shutdown tests | Accepted: E4 + C1 | Accepted absent: N1 + C1 |
| G1-17 AIGW | Shared inference resolver and effective interceptor payload tests | Accepted: E1/E2 + C1 | Accepted unchanged: N1 + C1 |
| G1-18 Atomic capabilities | Concurrent activity start/result consumption tests | Accepted: E2/E4 + C1 | Accepted absent: N1 + C1 |
| G1-19 Read lifetime | Non-consuming status/not-ready and dashboard owner projection tests | Accepted: E4 + C1 | Accepted absent: N1 + C1 |
| G1-20 Edge boundary | Managed Access bypass and exact Worker route tests | Accepted: E3 + C1 | Accepted absent: N1 + C1 |
| G1-21 Lost delivery | Admission lost-response and one-result-consumption tests | Accepted: E4 + C1 | Accepted absent: N1 + C1 |
| G1-22 Lifecycle failures | Runtime unknown fencing, owned stop and shutdown drain tests | Accepted: E4 + C1 | Accepted absent: N1 + C1 |
| G1-23 Browser/UI | Activity API/component and responsive behavior tests | Accepted: E1/E4 + C1 | Accepted absent: N1 + C1 |
| G1-24 Legacy/non-enterprise | Human/non-enterprise regressions and absence tests | Accepted unchanged: E3 + C1 | Accepted: N1 + C1 |
| G1-25 Input compatibility | Bounded generic consumer and attachment fixtures | Accepted: E2 + C1 | Accepted absent: N1 + C1 |
| G1-26 Consumer seams | Direct/session/webhook acceptance fixture orchestration | Accepted: E1/E2 + C1 | Accepted absent: N1 + C1 |
| G1-27 GitHub authority | Immutable source/revision/run conflict fixtures; no clearance claim | Accepted within Phase-1 boundary: C1 | Accepted absent: N1 + C1 |
| G1-28 Phase handoff | Versioned contracts and consumer inventory; later implementations excluded | Accepted: C1 | Accepted: C1 |
| G1-29 Reusable primitives | Typed modules, adjacent trust comments and shared policy tests | Accepted: E2/F1 + C1 | Accepted unchanged: N1 + C1 |

## Evidence record

- **C1, exact-head source evidence:** commit `137ffcb55d89c97deb640ef3b07c8a7f122b3b68`; CI run [`35285707512`](https://github.com/nikolanovoselec/codeflare/actions/runs/35285707512) completed successfully with 32 jobs successful and only Dependency Review skipped.
- **D1, Enterprise Integration release:** deploy run [`35285908939`](https://github.com/nikolanovoselec/codeflare/actions/runs/35285908939) succeeded for C1. Container rollout `86ba77eb-d756-464c-a7b1-4c98df9bc4a9` completed at version `231`, image `in-dae39216baf12796`, with 7 target instances, 0 old instances and 7 healthy instances.
- **D2, Integration release:** deploy run [`35285908977`](https://github.com/nikolanovoselec/codeflare/actions/runs/35285908977) succeeded for C1. Container rollout `512a7cc4-0325-46f0-aa4a-1a662921c8ea` completed at version `753`, image `in-b9fe8e2fc3d90834`, with 7 target instances and 0 old instances.
- **E1, registration and Access:** authenticated operator inspection returned enabled registration revision `5` and approved artifact digest `83280218396a9a0f3b9be76ca450707e31722baf28220d8a645c2a7014e9796b`.
  - The inspection returned the `Operators/` storage scope and the `Development` inference route.
  - Authenticated preparation succeeded while an unauthenticated administration request redirected to Cloudflare Access.
- **E2, live end-to-end activity:** activity `e44f0abe-8097-46d5-9265-8a4750024b8e`, session `gate106842df73555f17e`, operation `gate1-output-v1`.
  - The deployed Loader invoked the platform capability, and headless bootstrap obtained bucket-scoped credentials.
  - The restricted container started, native Pi wrote the marker, and scoped Sync uploaded the declared output and private manifest.
  - The parent independently verified 1 file and 25 bytes. The terminal result was `completed` and was consumed once.
- **E2 object evidence:** `Operators/Gate 1/gate1-marker-e44f0abe-8097-46d5-9265-8a4750024b8e.txt` read back through the authenticated storage boundary as exactly `codeflare-gate1-marker-v1`, 25 bytes, SHA-256 `e1e5d65d8998c8b7f95d60c3a02b74cbb1fee205dba4edd76771856ae57a05aa`.
- **E3, edge and environment boundary:** the Enterprise public webhook returned capability denial without an Access login, the Enterprise administration API remained Access-protected, and both the operator webhook and operator activity API returned `404` in non-enterprise Integration.
- **E4, stop and durable read:** completion required the owned session stop to return `stopped`; the authenticated session index subsequently contained zero sessions.
  - The consumed activity remained readable with its immutable terminal result and verification counts.
  - Browser detail still reports the separate activity cleanup projection as `unknown`; it is not used as session-stop proof.
- **F1, scoped upload characterization and retained failure evidence:** activity `5c04a963-42d0-4a00-a02d-86a0e2916823` proved bootstrap, scoped credential injection, container start, Pi write and the exact R2 PUT path before a `403`.
  - Local request capture established that rclone's S3 backend ignores `--header-upload`, while `--header` carries the operation identifier outside SigV4 `SignedHeaders`.
  - `--s3-no-head` then completes after the authorized PUT. C1 contains that correction and the live E2 activity proves the final path.
- **N1, non-enterprise boundary:** the exact D2 deployment completed and its operator API/webhook surfaces remained absent (`404`), matching the full non-enterprise regression suite in C1.

## Fixture and regression baseline

- Phase-1 fixture implementation: `src/__tests__/operators/fixtures/platform-acceptance.ts`.
- Direct/session/webhook outcomes: `src/__tests__/operators/platform-acceptance-fixtures.test.ts`.
- Generic input/source/revision/run/resource contracts: `src/operators/consumer-contracts.ts` and its tests.
- Native Loader behavior: `src/__tests__/operators/loader-runtime.test.ts` plus the isolated Wrangler fixture.
- Deployable distribution fixture: `fixtures/operator-gate1/` and `.github/workflows/deploy-operator-gate1.yml` ([REQ-OPERATOR-009](../../sdd/spec/operators.md#req-operator-009-reusable-platform-interfaces-and-bounded-consumer-fixtures)).
- Fixed acceptance composition: `src/operators/gate1-production.ts`, `src/operators/session-bootstrap.ts`, `src/operators/gate1-capability.ts`, `src/operators/gate1-runtime.ts` and `src/operators/gate1-resources.ts`.
- Canonical local-review fence: `src/__tests__/operators/legacy-review-unchanged.test.ts`; inspected packet-builder SHA-256 `110adda054e4e7569b3043cdffee030bef20a8dbc1136ff777dd35300ffcc80d`.

## Gate execution rule

Capture exact commit/version, endpoint, Access result, activity/operation IDs and sanitized object evidence. Record denied and failure observations separately.

Unknown or lost effects stay unknown and are never replayed automatically. Successful host upload acknowledgement is not persistence proof; parent verification and an independent object read are required.

## Requirement and Source Map

- [Gate 1 acceptance](../../sdd/spec/operators.md#req-operator-009-reusable-platform-interfaces-and-bounded-consumer-fixtures): `src/__tests__/operators/platform-acceptance-fixtures.test.ts`, `src/__tests__/operators/loader-runtime.test.ts`, and `fixtures/operator-gate1/`.
- [Owned lifecycle and sync](../../sdd/spec/operators.md#req-operator-005-owned-operator-session-lifecycle): `src/operators/gate1-production.ts`, `src/operators/gate1-capability.ts`, `src/operators/session-bootstrap.ts`, and `src/operators/gate1-runtime.ts`.
- [Admission, webhook, and owner boundaries](../../sdd/spec/operators.md#req-operator-006-capability-authenticated-webhook-activity): `src/operators/activity.ts`, `src/routes/operator-webhook.ts`, and `src/routes/operator-activities.ts`.
- [Evidence environments](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration): `.github/workflows/deploy-operator-gate1.yml` and the `enterprise-integration` / `integration` deployment observations recorded above.

## Related Documentation

- [Operators](operators.md)
- [Container — Restricted Operator Lifecycle](container.md#restricted-operator-lifecycle)
- [Storage & Sync — Restricted Operator Persistence](storage-and-sync.md#restricted-operator-persistence)
- [Authentication — Human Access claims](authentication.md#human-access-claims-for-the-operator-interface)
