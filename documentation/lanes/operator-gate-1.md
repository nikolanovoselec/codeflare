# Operator Gate 1 evidence matrix

**Audience:** Phase-1 implementers and acceptance operators  
**Owns:** Separation of fixture, native-runtime and deployed evidence for G1-01–29.  
**Does not own:** Flue, operational Remote Reviews, merge gates, production publisher workflows or Gate 3.

A source/CI entry means the primitive is implemented and regression-tested. It is not evidence that the public hostname, Access policy, provider, Pi process or R2 object worked in either integration deployment. Task #14 owns both deployed columns and may mark a row accepted only with captured environment-specific evidence.

| Case | Source / CI evidence before deployment | `enterprise-integration` | `integration` |
|---|---|---|---|
| G1-01 Registration | REQ-OPERATOR-002/011/013/014 distribution, admission, policy and admin-route tests | Pending | Pending |
| G1-02 Access eligibility | REQ-OPERATOR-001 signed-human and admin authorization tests | Pending | Pending |
| G1-03 Execution identity | Protected context, durable container-context and ownership tests | Pending | Pending |
| G1-04 Disable race | Registry admission ordering and capability tests | Pending | Pending |
| G1-05 Dynamic Worker | Native Loader/workerd fixture and durable runtime generations | Pending | Pending |
| G1-06 Session lifecycle | Owned-session, host Pi service/router and PID1 tests | Pending | Pending |
| G1-07 Ownership | Owned-session conflict, sync scope and browser owner-index tests | Pending | Pending |
| G1-08 Pi semantics | Structured conversation/task/recovery/abort and SDK characterization tests | Pending | Pending |
| G1-09 R2 smoke | Explicit upload, independent verifier and sealed-write tests; real bytes pending | Pending | Pending |
| G1-10 Sync failure | Unknown-outcome, reconciliation, expiry and manifest-last tests | Pending | Pending |
| G1-11 Restricted storage | Restricted env, sync I/O, interception and shutdown tests | Pending | Pending |
| G1-12 Shared home | Restricted activity roots and ordinary-session regression suites | Pending | Pending |
| G1-13 Interceptor profile | Egress/GitHub/R2/Browser policy tests | Pending | Pending |
| G1-14 JWT settings | JWT policy, transport stamping and redirect/spoof tests | Pending | Pending |
| G1-15 Enterprise backend | Distribution JWT and recipient transport fixtures; real RP pending | Pending | Pending |
| G1-16 Expiry/revocation | Execution-context expiry/reauth and PID1 shutdown tests | Pending | Pending |
| G1-17 AIGW | Shared inference resolver and effective interceptor payload tests | Pending | Pending |
| G1-18 Atomic capabilities | Concurrent activity start/result consumption tests | Pending | Pending |
| G1-19 Read lifetime | Non-consuming status/not-ready and dashboard owner projection tests | Pending | Pending |
| G1-20 Edge boundary | Managed Access bypass and exact Worker route tests | Pending | Pending |
| G1-21 Lost delivery | Admission lost-response and one-result-consumption tests | Pending | Pending |
| G1-22 Lifecycle failures | Runtime unknown fencing, owned stop and shutdown drain tests | Pending | Pending |
| G1-23 Browser/UI | Activity API/component tests; responsive visual proof pending | Pending | Pending |
| G1-24 Legacy/non-enterprise | Full CI human/non-enterprise regressions and absence tests | Pending | Pending |
| G1-25 Input compatibility | Bounded generic consumer and attachment fixtures | Pending | Pending |
| G1-26 Consumer seams | Direct/session/webhook acceptance fixture orchestration | Pending | Pending |
| G1-27 GitHub authority | Immutable source/revision/run conflict fixtures; no clearance claim | Pending | Pending |
| G1-28 Phase handoff | Versioned contracts and consumer inventory; later implementations excluded | Pending | Pending |
| G1-29 Reusable primitives | Typed modules, adjacent trust comments and shared policy tests | Pending | Pending |

## Fixture and regression baseline

- Phase-1 fixture implementation: `src/__tests__/operators/fixtures/platform-acceptance.ts`.
- Direct/session/webhook outcomes: `src/__tests__/operators/platform-acceptance-fixtures.test.ts`.
- Generic input/source/revision/run/resource contracts: `src/operators/consumer-contracts.ts` and its tests.
- Native Loader behavior: `src/__tests__/operators/loader-runtime.test.ts` plus the isolated Wrangler fixture.
- Deployable distribution fixture source: `fixtures/operator-gate1/`; successful Enterprise Integration deploys call `.github/workflows/deploy-operator-gate1.yml`, which also remains manually dispatchable. Access configuration and live authenticated retrieval remain pending.
- Fixed session acceptance composition: `src/operators/gate1-production.ts`, `src/operators/gate1-capability.ts`, `src/operators/gate1-runtime.ts`, and `src/operators/gate1-resources.ts`; CI does not count as deployed session/Pi/R2/stop evidence.
- Canonical local-review fence: `src/__tests__/operators/legacy-review-unchanged.test.ts`; inspected packet-builder SHA-256 `110adda054e4e7569b3043cdffee030bef20a8dbc1136ff777dd35300ffcc80d`.
- Full exact-head CI for this fixture package: commit `548159ac`, run `35175644803`.

## Gate execution rule

For each deployment, capture exact commit/version, endpoint, Access result, operation IDs and sanitized response/object evidence. Record denied and failure observations separately. A fixture, static file hash, 202 response, upload acknowledgment, UI render or CI success cannot fill a deployed cell. Unknown/lost effects stay unknown and are not replayed automatically.
