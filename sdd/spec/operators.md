# Operators

Enterprise-only Codeflare Operator Interface, registration, activity execution and administration. This domain specifies the Codeflare foundation only. Private Flue implementation, operational Remote Reviews adapters/publisher and required merge-check activation are outside this phase. Root sessions and existing human/local-review behavior remain unchanged.

**Domain owner:** Backend (Worker), container host and enterprise frontend

## Domain Dependencies

Existing authentication, enterprise authorization, session admission/lifecycle, storage, setup and provider routing remain their own authorities. Operator restrictions can narrow but never extend those permissions.

---

### REQ-OPERATOR-001: Verified human Access claims

**Intent:** The platform can distinguish a verified human Access credential from other supported authentication modes and retain its real expiry without changing existing authentication behavior.

**Applies To:** User

**Acceptance Criteria:**

1. A reusable verifier returns subject, email, issuer, audiences, issued-at and expiry from a signed, valid human Access application token; it returns no raw credential. <!-- @impl: src/lib/jwt.ts::verifyHumanAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-OPERATOR-001: verified human Access context) -->
2. Missing/empty human subject or email, a non-application token, or service-token provenance is rejected even if the token otherwise passes existing email authentication. <!-- @impl: src/lib/jwt.ts::verifyHumanAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-OPERATOR-001: verified human Access context) -->
3. Invalid signature, issuer, audience, expiration, issued-at or not-before claims fail closed through the same cryptographic verification used by the existing email API. <!-- @impl: src/lib/jwt.ts::verifyHumanAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-OPERATOR-001: verified human Access context) -->
4. Existing email verification and its callers retain their current accepted claim shape and results; stricter operator eligibility does not narrow ordinary authentication. <!-- @impl: src/lib/jwt.ts::verifyAccessJWT --> <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 (CF Access JWT validation + JWKS caching)) -->

**Constraints:** No service/setup/session-token or caller email fallback for human-context execution. This verifier does not itself grant enterprise access, resolve buckets, renew tokens or admit an activity.

**Priority:** P0

**Dependencies:** [REQ-AUTH-003](authentication.md#req-auth-003-cf-access-mode-for-all-other-deployments)

**Verification:** Signed-token behavioral tests: RED at `28c40a97` (CI 35119689823), GREEN at `18960850` (CI 35120031781). Actual enterprise operator admission remains separately required by REQ-OPERATOR-002/003; this primitive is not deployed operator acceptance.

**Status:** Implemented

---

### REQ-OPERATOR-002: Enterprise registration and serialized admission

**Intent:** Administrators register private operators without changing non-enterprise behavior or granting user eligibility.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Enterprise administrators can register a validated HTTPS distribution and protected connection secret, then independently discover, approve and enable an operator. Replacing distribution credentials is revision-checked, disables the registration and clears approval without changing admitted receipts. Invalid input or encryption failure leaves state unchanged; ordinary readback exposes no secret material. <!-- @impl: src/operators/registry.ts::OperatorRegistry.setDistribution --> <!-- @impl: src/operators/protected-secrets.ts::sealOperatorSecret --> <!-- @impl: src/operators/protected-secrets.ts::openOperatorSecret --> <!-- @test: src/__tests__/operators/registry-distribution.test.ts (REQ-OPERATOR-002: protected distribution registration) --> <!-- @test: src/__tests__/operators/protected-secrets.test.ts (REQ-OPERATOR-002: fail-closed protected secrets) -->
2. Registration mutations reject stale revisions. New records are disabled and unapproved; approval and enablement are separate. Admission pins the approved manifest, policy, revision, activity intent and deadline in an idempotent receipt that later changes cannot mutate. Identical concurrent admission reconciles; changed reuse conflicts; disable-first denies new admission and receipt-first remains readable for reconciliation. <!-- @impl: src/operators/registry.ts::OperatorRegistry.approveManifest --> <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/registry-manifest.test.ts (REQ-OPERATOR-002: approved manifest snapshots) --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-002: SQLite registration and admission ordering) -->
3. Administrators can generate or revision-check rotate an optional 256-bit per-operator webhook key. Only the winning mutation displays plaintext once with `CODEFLARE_OPERATOR_WEBHOOK_KEY` placement instructions; normal projections expose no plaintext or ciphertext. Stale rotation or encryption failure preserves the prior revision and key, and retired keys are not accepted indefinitely. <!-- @impl: src/operators/registry.ts::OperatorRegistry.rotateWebhookKey --> <!-- @impl: src/operators/protected-secrets.ts::createOperatorWebhookKey --> <!-- @test: src/__tests__/operators/registry-webhook-key.test.ts (REQ-OPERATOR-002: encrypted registry webhook key rotation) --> <!-- @test: src/__tests__/operators/webhook-key.test.ts (REQ-OPERATOR-002: optional per-operator webhook key) -->
4. Operator administration is unavailable outside enterprise mode. Every mutation requires current administrator authorization and matching verified human Access claims; service or mixed-principal authentication cannot substitute. Failed discovery changes nothing, while identity collisions and stale revisions return conflicts without replay. Ordinary authentication, quotas, routing and local reviews remain unchanged. <!-- @impl: src/routes/admin/operators.ts --> <!-- @impl: src/operators/administration.ts::registerDiscoveredOperator --> <!-- @impl: src/operators/administration.ts::approveRegisteredOperator --> <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-002: enterprise human-admin operator routes) -->
5. Version-1 policy explicitly limits network hosts, GitHub repositories/methods, owner-relative storage prefixes and inference route/reasoning choices. Empty lists deny; policy cannot select a principal or bucket. Unknown, unsafe, duplicate, oversized or internally inconsistent input is rejected. Revision-checked replacement disables new admission, while admitted receipts retain their pinned policy. <!-- @impl: src/operators/policy.ts::parseOperatorPolicy --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.setPolicy --> <!-- @test: src/__tests__/operators/policy.test.ts (REQ-OPERATOR-002: bounded restrictive registration policy) --> <!-- @test: src/__tests__/operators/registry-policy.test.ts (REQ-OPERATOR-002: restrictive policy snapshots and safe listing) -->

**Constraints:** Registration never grants human eligibility or execution authority. Secrets remain parent-readable only in protected form; ordinary projections are secret-free. No transaction spans registry and activity Durable Objects.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-001](#req-operator-001-verified-human-access-claims)

**Verification:** Registration, policy, protected-secret, webhook-key and administration-route behavior is covered by the adjacent tests. Exact-head CI 35148669515 at `c9fd121d` is GREEN. Runtime enforcement and deployed allowed/denied acceptance are separate requirements.

**Status:** Implemented

---

### REQ-OPERATOR-003: Principal-bound durable activity runtime

**Intent:** Approved private code executes with narrowly bound platform capabilities under valid user authority.

**Applies To:** User

**Acceptance Criteria:**

1. Each activity retains only its invoking human's verified authority and pinned operator, artifact and policy identity. Child input cannot select principal, bucket, policy or credential. Reauthentication requires the same human provenance; expiry blocks new protected work and uploads. Public projections expose no credential. <!-- @impl: src/operators/execution-context.ts --> <!-- @impl: src/operators/activity.ts::OperatorActivity.prepareAuthorized --> <!-- @test: src/__tests__/operators/execution-context.test.ts (REQ-OPERATOR-003: protected verified execution context) -->
2. Each execution loads the bounded digest-matched approved artifact afresh with only parent-provided Operator Interface capabilities and intercepted outbound access. Child code inherits no unrestricted bindings or durable isolate state. Native-runtime fixtures prove parent-bound identity and outbound allow/deny behavior but do not substitute for deployment acceptance. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-003: Worker Loader runtime boundary) -->
3. Durable activity state owns intent, operation IDs, progress, result and cleanup. Admission persists pending intent before registry reconciliation and consumes start authority only after a matching receipt and fresh expiry check. Concurrent starts queue once; uncertain responses reconcile the same receipt, disable-first stays unqueued and unknown effects are never replayed automatically. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-003: activity admission consume and queue) -->
4. Cancellation/expiry stops only owned compute and records actual pending/failed/unknown cleanup without after-expiry final uploads. Overview reads use non-waking safe projections.
5. One drive generation runs per admitted activity. Only the current generation may commit a bounded waiting, completed or failed update. Waiting resumes from its durable checkpoint under a new generation; terminal, cancelled or unknown-effect work does not restart automatically. Late results are rejected, and drive begin/commit recheck actual authority expiry. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-003: durable drive generation and checkpoint) -->
6. The parent reserves a generation before loading the approved Worker. Start/resume input contains activity identity, generation, bounded invocation and durable checkpoint but no credential; capabilities are generation-bound. Authenticated preparation selects the enabled revision, pins protected distribution state at admission and schedules one direct drive only for the winning start. Only bounded current-generation JSON output is accepted. Preparation or transport uncertainty fences the drive as unknown, and runtime never exceeds 30 seconds or human expiry. <!-- @impl: src/operators/runtime.ts::driveOperatorRuntime --> <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity --> <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-003: activity-driven Worker execution) --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-003: request-attached production orchestration) -->

**Constraints:** Child code receives no raw human credential, unrestricted binding or inherited outbound access. Unknown external effects are fenced rather than replayed. Runtime deadlines never exceed verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-registration-and-serialized-admission)

**Verification:** Loader, activity-state, protected-context, runtime-driver and request-attached orchestration behavior is covered by the adjacent tests. Prior exact-head CI 35154419607 at `981c0694` is GREEN; orchestration review-fix CI is pending. Owned-compute cancellation and deployed acceptance remain unverified.

**Status:** Planned

---

### REQ-OPERATOR-004: Shared restrictive interception and JWT stamping

**Intent:** Direct operator calls and owned sessions enforce the same additional restrictions while preserving downstream enterprise authorization.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Effective access intersects current human authority with the admitted operator restrictions before credential lookup, signing or forwarding. Specialized-service denial cannot escape through generic egress, and network permission never grants the Browser administrator credential. Network, GitHub and owner-relative storage decisions are shared across transports. <!-- @impl: src/operators/interception-policy.ts --> <!-- @test: src/__tests__/operators/interception-policy.test.ts (REQ-OPERATOR-004: shared operator restriction decisions) --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-OPERATOR-004: GitHub restrictions before credentials) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-004: operator restrictions precede egress and R2 credentials) -->
2. Restricted interception is mandatory regardless of ordinary human strict-egress preferences. Approved inference/platform/storage access is distinct from general Internet permission; existing SWG transport remains intact.
3. Automatic HTTPS Access stamping defaults Off and supports exact hosts, subdomain-only wildcards and a disclosure-confirmed All mode. Every redirect is independently authorized; caller assertions are removed and specialized Authorization is preserved. Generic egress, GitHub, AI Gateway and Browser stamp only after their existing authorization decisions. Explicit endpoint authentication remains independent. <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-004: verified Access stamping in generic egress) --> <!-- @test: src/__tests__/github-interceptor.test.ts (stamps verified Access after repository authorization while preserving the GitHub credential) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-OPERATOR-004: stamps the verified assertion on the actual Gateway recipient without replacing gateway auth) --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-OPERATOR-004: stamps verified Access while preserving the Browser credential) --> <!-- @impl: src/operators/jwt-stamping.ts --> <!-- @test: src/__tests__/operators/jwt-stamping.test.ts (REQ-OPERATOR-004: automatic human Access JWT stamping) --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (previews, applies and reloads automatic JWT stamping without mutating during preview) --> <!-- @test: web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx (REQ-OPERATOR-004: renders Off/list/All stamping controls and serializes canonical destination lines) -->
4. R2 reads/listing/writes/multipart operations are server-bound to permitted owner/activity scope. Unsupported copy/deletion/control operations and writes to sealed operations are denied; managed-resource protections remain enforced.

**Constraints:** Operator policy can only narrow current human authority. Stamping never authorizes egress, follows redirects or renews authority. Specialized service credentials never enter child-controlled state.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](#req-operator-003-principal-bound-durable-activity-runtime)

**Verification:** Shared interception, Browser denial and JWT-stamping behavior is covered by the adjacent transport tests. Exact-head CI 35159474090 at `3c7731e6` is GREEN. Deployed direct/session egress, R2 and relying-party acceptance remain unverified.

**Status:** Planned

---

### REQ-OPERATOR-005: Owned session, structured Pi and explicit persistence

**Intent:** Session readiness, Pi task completion, durable synchronization and shutdown are independently controllable and observable.

**Applies To:** User

**Acceptance Criteria:**

1. Owned-session services preserve distinct activity, Codeflare session, Pi conversation and task identities. Ownership and restrictions persist before startup; lost responses reconcile against the same reservation, uncertain configuration remains uncertain, and stop affects only the owned session. Wake restores restrictions but requires same-human authority rebind. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/container/operator-context.ts --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) --> <!-- @test: src/__tests__/container/operator-context.test.ts (operator container context) -->
2. The host manages one owned structured SDK conversation with stable operation IDs, bounded prompt/follow-up/steer and observation, explicit approval-needed state and awaited cancellation. Intent persists before submission; retries reconcile and only the recorded session file and ID may reopen. Missing conversations and uncertain tool effects are not replaced or replayed. Ordinary PTYs and root execution are unchanged. <!-- @impl: host/src/operator-pi.ts::OperatorPiConversation --> <!-- @impl: host/src/operator-pi-sdk.ts::createProvisionedOperatorPiFactory --> <!-- @impl: host/src/operator-pi-http.ts::OperatorPiHttpController --> <!-- @impl: host/src/operator-pi-service.ts::createOperatorPiService --> <!-- @test: host/__tests__/operator-pi.test.js (REQ-OPERATOR-005: creates once, persists exact identity and reopens only the recorded file) --> <!-- @test: host/__tests__/operator-pi-sdk.test.js (REQ-OPERATOR-005: reopens only a canonical file inside the owned session directory) --> <!-- @test: host/__tests__/operator-pi-http.test.js (REQ-OPERATOR-005: fixed ensure/send/observe/abort API omits the private session file) --> <!-- @test: host/__tests__/operator-pi-service.test.js (REQ-OPERATOR-005: trusted config binds identity/root/profile and produces a ready service) --> <!-- @test: host/__tests__/operator-pi-router.test.js (REQ-OPERATOR-005: router authenticates then forwards fixed Pi request bytes/query and response) -->
3. Restricted startup restores only approved inputs and never enters ordinary whole-home restore, bisync or baseline-daemon paths. Restricted shutdown may drain an accepted explicit upload but never starts bisync. <!-- @impl: entrypoint.sh::run_operator_startup --> <!-- @impl: entrypoint.sh::drain_operator_sync_shutdown --> <!-- @test: host/__tests__/entrypoint-operator-startup.test.js (REQ-OPERATOR-005: operator startup selects only restricted initialization) --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPERATOR-005: restricted shutdown drains only accepted explicit upload and never starts bisync) --> Explicit sync validates canonical files and exact size/hash, writes no implicit deletes and publishes the manifest last. Stable receipts reconcile identical requests; changed reuse conflicts and interrupted effects become unknown before further writes. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @impl: host/src/operator-sync-io.ts --> <!-- @impl: host/src/operator-sync-http.ts::OperatorSyncHttpController --> <!-- @impl: host/src/operator-sync-service.ts::createOperatorSyncService --> <!-- @test: host/__tests__/operator-sync.test.js (REQ-OPERATOR-005: persists intent then uploads exact files and canonical manifest last) --> <!-- @test: host/__tests__/operator-sync-io.test.js (REQ-OPERATOR-005: local adapter reads only exact regular non-symlink files beneath the owned root) --> <!-- @test: host/__tests__/operator-sync-http.test.js (REQ-OPERATOR-005: fixed POST upload and GET receipt expose uploaded but not verified state) --> <!-- @test: host/__tests__/operator-sync-service.test.js (REQ-OPERATOR-005: trusted config composes an exact upload with durable receipt) --> <!-- @test: host/__tests__/operator-sync-router.test.js (REQ-OPERATOR-005: router authenticates before forwarding fixed explicit-sync requests) --> Durability requires independent bounded reads matching the sealed activity/session/operation/request/policy identity and every declared hash and size. Upload seals further writes; missing, corrupt, expired or out-of-scope evidence fails. Uploader timestamps alone are not evidence. <!-- @impl: src/operators/activity.ts::OperatorActivity.prepareSync --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/operators/sync-verification.ts::verifyOperatorSync --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-004: operator restrictions precede egress and R2 credentials) --> <!-- @test: src/__tests__/operators/sync-verification.test.ts (REQ-OPERATOR-005: independently verified sync bytes) -->
4. Valid-authority stop drains explicitly; expiry blocks upload in both DO and PID1 paths, awaits owned SDK cancellation and reports unsynced output honestly. Operator/operator and operator/human overlap cannot corrupt unrelated state or stop another activity.

**Constraints:** Ordinary PTYs, root sessions and non-operator persistence remain unchanged. Unknown SDK or upload effects are not replayed. Restricted startup cannot invoke ordinary whole-home restore or bisync.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception-and-jwt-stamping)

**Verification:** Owned-session, Pi, restricted lifecycle, explicit-sync and independent-verification behavior is covered by the adjacent tests. Exact-head CI 35169456503 at `0ce22c80` is GREEN. Deployed file-to-R2 restoration, stop and concurrency acceptance remain unverified.

**Status:** Planned

---

### REQ-OPERATOR-006: Capability-authenticated Codeflare Webhook Endpoint

**Intent:** External consumers start a fixed activity and collect results without interactive Access login or independent execution identity.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Versioned webhook routes use distinct 256-bit capabilities for start, status and terminal-result redemption. Scope is fixed before issuance; concurrent consumers have one winner, while status and not-ready reads are non-consuming. <!-- @impl: src/operators/activity.ts::OperatorActivity.startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
2. Consumed start durably queues execution. Terminal failure, cancellation, expiry and supersession produce bounded results. Valid result authority remains collectible after user JWT expiry or operator disablement without extending execution; lost delivery remains consumed and never triggers rerun. <!-- @impl: src/operators/activity.ts::OperatorActivity.startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
3. A configured optional operator webhook key encrypts handoff using AES-GCM and bound context; absent key permits the one-time token alone with a dispatch-visibility warning. Configured encryption failure never silently downgrades. Tokens/keys stay out of logs and candidate-controlled steps. <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff --> <!-- @test: src/__tests__/operators/webhook-handoff.test.ts (REQ-OPERATOR-006: optional encrypted webhook handoff) -->
4. Enterprise Access setup idempotently manages a narrow higher-precedence bypass for `/operator-webhook/v1/activities/*`, reports provisioning failure and removes incomplete new configuration without weakening other protection. The Worker rejects invalid capability, method, path and non-enterprise requests with bounded non-cacheable responses. <!-- @impl: src/routes/operator-webhook.ts --> <!-- @impl: web-ui/src/components/admin/EnvironmentAreaFields.tsx::EnvironmentAreaFields --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (REQ-OPERATOR-006: capability-authenticated webhook edge) --> <!-- @test: web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx (REQ-OPERATOR-006: shows managed Webhook Endpoint Access bypass status only for enterprise Access) -->

**Constraints:** Capabilities are route-, activity-, operation- and purpose-bound. They neither renew human authority nor create an independent execution identity. Responses are bounded, throttled and non-cacheable.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](#req-operator-003-principal-bound-durable-activity-runtime)

**Verification:** Capability, webhook edge, encrypted handoff and managed-bypass behavior is covered by the adjacent tests. Exact-head CI 35171737437 at `2ac5a5c0` is GREEN. Public-host callback acceptance in both handoff modes remains unverified.

**Status:** Planned

---

### REQ-OPERATOR-007: Operator-aware inference selection

**Intent:** Operator defaults and restrictions reuse current provider eligibility rather than grant new inference access.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Resolve current eligible verified catalog, intersect registered allowed routes, then apply valid trusted invocation selection or registered defaults; user defaults are inherited only explicitly. <!-- @impl: src/operators/inference-selection.ts::resolveOperatorInference --> <!-- @test: src/__tests__/operators/inference-selection.test.ts (REQ-OPERATOR-007: operator inference intersection) -->
2. Unsupported or unauthorized route/reasoning selection fails without substitution. Child payload and lane/resource settings cannot override trusted selection; provider-default remains distinct from Off. <!-- @impl: src/operators/inference-selection.ts::resolveOperatorInference --> <!-- @test: src/__tests__/operators/inference-selection.test.ts (REQ-OPERATOR-007: operator inference intersection) -->
3. Direct and Pi calls enforce the same effective selection and trusted activity attribution while preserving ordinary human fallback. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/container/container-interception.ts --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-OPERATOR-007: enforces parent-trusted route/reasoning over child payload and stamps trusted attribution) -->

**Constraints:** Operator selection can only narrow the current verified provider catalog. Child input cannot choose or override trusted routing, reasoning or attribution.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception-and-jwt-stamping)

**Verification:** Selection and interceptor behavior is covered by the adjacent tests. Exact-head CI 35172865340 at `d51d0039` is GREEN. Actual provider-request acceptance remains unverified.

**Status:** Planned

---

### REQ-OPERATOR-008: Enterprise administration and activity surfaces

**Intent:** Users can observe and control owned activities without confusing execution, storage and collection outcomes.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Enterprise Administration separates registration, discovery, digest approval and enablement, and exposes restrictive policy, inference, webhook-key and managed-bypass state through existing responsive patterns. New registrations deny by default. Readback exposes flags rather than secrets; one-time keys remain only until dismissal and rotation requires confirmation. Conflicts require explicit reconciliation and mutations are never replayed. Detail reads perform no discovery or decryption. <!-- @impl: web-ui/src/components/admin/OperatorsPage.tsx::OperatorsPage --> <!-- @impl: web-ui/src/api/operators.ts --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.getAdminDetail --> <!-- @impl: src/operators/administration.ts::discoverRegisteredOperator --> <!-- @test: web-ui/src/__tests__/components/OperatorsPage.test.tsx (REQ-OPERATOR-008: enterprise Operators administration) --> <!-- @test: web-ui/src/__tests__/api/operators.test.ts (REQ-OPERATOR-008: operator administration client) -->
2. The header operator control follows the user control, remains accessible at zero activity and counts working activities. Desktop/tablet use a popover and mobile uses a bottom sheet. Progress, source/session links, result and execution/cleanup/collection/attention states remain distinct; unknown is never shown as zero. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-008: operator activity header control) -->
3. Authenticated account-scoped details/results/cancel and CSRF-protected browser summary → Start POST preserve ownership. GET is not effectful; browser closure neither loses valid activity progress nor extends authority. <!-- @impl: src/routes/operator-activities.ts --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.listOwnedActivities --> <!-- @impl: src/operators/activity.ts::OperatorActivity.getBrowserDetail --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-008: authenticated owned activity browser surfaces) -->
4. Non-enterprise renders no operator UI and issues no operator data requests. Keyboard/focus, stale/loading/error, account-switch and mobile behavior remain usable.

**Constraints:** Operator UI and data routes are enterprise-only and owner-scoped. Reads are non-effectful; writes require CSRF protection and are never replayed automatically. Secret readback is prohibited.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-registration-and-serialized-admission), [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-codeflare-webhook-endpoint)

**Verification:** Administration, activity control and owner-scoped browser API behavior is covered by the adjacent tests. Exact-head CI 35174509964 at `e03c48ec` is GREEN. Deployed desktop, tablet and mobile acceptance remains unverified.

**Status:** Planned

---

### REQ-OPERATOR-009: Reusable platform interfaces and bounded consumer fixtures

**Intent:** Later operator implementations consume tested Codeflare primitives without Phase 1 implementing private business workflows.

**Applies To:** User

**Acceptance Criteria:**

1. Touched services/interceptors expose typed reusable interfaces with adjacent ownership, trust, error, side-effect, retry/expiry and compatibility documentation. Shared behavior has one implementation; no fabricated route-header facade or general plugin framework. <!-- @impl: src/operators/consumer-contracts.ts::parseOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
2. Bounded attachments and immutable source, revision and run references reject spoofed identity, changed inputs and recursive use of human admission. Fixture compatibility grants no Review or history authority. <!-- @impl: src/operators/consumer-contracts.ts::parseOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
3. Minimal distribution/direct/session/webhook fixtures prove platform seams. Existing local-review resources remain unchanged; no private Flue core, operational Review hooks/enrollment/monitor/publisher or merge-gate activation ships in this phase. <!-- @test: src/__tests__/operators/platform-acceptance-fixtures.test.ts (REQ-OPERATOR-009: platform acceptance fixtures) --> <!-- @test: src/__tests__/operators/legacy-review-unchanged.test.ts (REQ-OPERATOR-009: unchanged canonical local-review resource) -->
4. Behavioral TDD governs changes. Enterprise and non-enterprise deployment evidence is recorded separately from fixtures; implementation completion never substitutes for deployed acceptance.

**Constraints:** Consumer fixtures carry no credentials, publisher authority, Review authority or business workflow. Fixture success is not deployment acceptance.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-005](#req-operator-005-owned-session-structured-pi-and-explicit-persistence), [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-codeflare-webhook-endpoint)

**Verification:** Consumer contracts and direct/session/webhook fixtures are covered by the adjacent tests. Exact-head CI 35175644803 at `548159ac` is GREEN. Deployed Gate 1 evidence remains pending.

**Status:** Planned

---

### REQ-OPERATOR-010: Bounded discovery and immutable bundle validation

**Intent:** Registration and loading share one versioned input boundary that cannot execute discovery content, inherit parent bindings or silently accept incompatible code.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. A discovery JSON document of at most 64 KiB declares schema/interface version 1, stable ID, name/description, core/intent versions, bounded input-contract metadata, supported required capabilities and an artifact path/SHA-256. Unknown versions/capabilities, duplicate capabilities, malformed/missing fields and caller identity/binding fields are rejected. <!-- @impl: src/operators/distribution.ts::parseOperatorManifest --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: operator discovery boundary) -->
2. Distribution uses a credential-free, fragment-free HTTPS URL with a DNS hostname. Artifact paths are canonical origin-relative paths without query/fragment, encoded ambiguity, traversal or backslash; a validated artifact URL cannot leave the registered origin. Network discovery must independently reject redirects/login responses; parsing grants no network or Access permission. <!-- @impl: src/operators/distribution.ts::parseOperatorManifest --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: operator discovery boundary) -->
3. Before loading, validate at most 8 MiB of exact artifact bytes against the approved SHA-256, then parse schema/interface version 1, main module, fixed supported compatibility date/flags and at most 128 JS/text modules. Require a declared JS main module, canonical relative module names and no undeclared loader options, env/bindings, script execution or inherited global outbound. The platform owns all capabilities and outbound configuration. <!-- @impl: src/operators/distribution.ts::parseOperatorBundle --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: approved bundle boundary) -->
4. Parsing produces validated data only and never evaluates module source. Invalid/oversized/incompatible inputs return typed safe validation errors without including source bytes or credentials. <!-- @impl: src/operators/distribution.ts::parseOperatorBundle --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: approved bundle boundary) -->

5. Discovery transport sends the already-verified, unexpired human assertion in `cf-access-jwt-assertion` and the separate connection secret as Bearer Authorization. Validate the endpoint and require both credentials before I/O. Use manual redirects; accept only HTTP 200 JSON, enforce the 64 KiB bound while streaming and a maximum 15-second request deadline (never beyond human expiry), cancel rejected bodies, recheck authority after reading, and return safe errors without credential/network diagnostics. A connection secret cannot substitute for human Access eligibility. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorManifest --> <!-- @test: src/__tests__/operators/distribution-client.test.ts (REQ-OPERATOR-010: authenticated bounded discovery transport) -->

6. Approved artifact download uses the same explicit human/connection authentication and transport deadline as discovery, enforces an 8 MiB streaming limit, and validates exact received bytes against the pinned approved digest before returning module data. The derived artifact URL must match the approved canonical path on the registered origin before credentials are sent. Reject redirect/login responses and expired authority; never substitute a newly discovered digest for the approved one. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorBundle --> <!-- @test: src/__tests__/operators/artifact-download.test.ts (REQ-OPERATOR-010: authenticated approved artifact download) -->

**Constraints:** Version 1 uses the platform's current Worker compatibility date and `nodejs_compat` flag; dependency/runtime upgrades are not implicit. Static intent resources can be text modules. Discovery and bundle validation alone do not establish invoking-user eligibility or execute an operator.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-registration-and-serialized-admission), [REQ-OPERATOR-003](#req-operator-003-principal-bound-durable-activity-runtime)

**Verification:** RED at `5b530c82`, CI 35121144349: 47 discovery/bundle behavioral cases fail against unimplemented boundaries. Parser GREEN at `798fccda`, CI 35122553530. Authenticated transport RED at `a745099a`, CI 35123769141: 26 failing behavioral cases against the unimplemented boundary. Transport GREEN at `d186e79f`, CI 35124293226. Artifact download RED at `0bd575cc`, CI 35135422114: nine failing behavioral cases against the unimplemented boundary. Artifact transport GREEN at `7edcbe88`, CI 35136427822; deployed registration/Worker Loader acceptance remains required. Interface reference: [Operators](../../documentation/lanes/operators.md).

**Status:** Implemented
