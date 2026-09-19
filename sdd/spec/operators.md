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

### REQ-OPERATOR-002: Enterprise distribution registration

**Intent:** Administrators register private operator distributions without granting user eligibility.

**Applies To:** Admin

**Acceptance Criteria:**

1. Enterprise administrators can register a validated HTTPS distribution and protected connection secret. <!-- @impl: src/operators/registry.ts::setDistribution --> <!-- @impl: src/operators/protected-secrets.ts::sealOperatorSecret --> <!-- @impl: src/operators/protected-secrets.ts::openOperatorSecret --> <!-- @test: src/__tests__/operators/registry-distribution.test.ts (REQ-OPERATOR-002: protected distribution registration) -->
2. Administrators can discover a registered operator without approving it. <!-- @impl: src/operators/administration.ts::discoverRegisteredOperator --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-013: enterprise human-admin operator routes) -->
3. Administrators approve an explicitly selected artifact digest without enabling the operator. <!-- @impl: src/operators/administration.ts::approveRegisteredOperator --> <!-- @test: src/__tests__/operators/registry-manifest.test.ts (REQ-OPERATOR-011: approved manifest snapshots) -->
4. Administrators enable an approved operator through a separate mutation. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-011: SQLite registration and admission ordering) -->
5. Distribution-credential replacement rejects stale revisions, disables the registration and clears approval without changing admitted receipts. <!-- @impl: src/operators/registry.ts::setDistribution --> <!-- @test: src/__tests__/operators/registry-distribution.test.ts (REQ-OPERATOR-002: protected distribution registration) -->
6. Invalid distribution input or secret-encryption failure leaves registration state unchanged. <!-- @impl: src/operators/protected-secrets.ts::sealOperatorSecret --> <!-- @test: src/__tests__/operators/protected-secrets.test.ts (REQ-OPERATOR-002: fail-closed protected secrets) -->
7. Ordinary registration readback exposes no secret material. <!-- @impl: src/operators/protected-secrets.ts::openOperatorSecret --> <!-- @test: src/__tests__/operators/registry-distribution.test.ts (REQ-OPERATOR-002: protected distribution registration) -->

**Constraints:**

- Registration never grants human eligibility or execution authority.
- Secrets remain parent-readable only in protected form.
- Ordinary projections are secret-free.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-001](#req-operator-001-verified-human-access-claims)

**Verification:** Distribution registration and protected-secret behavior is covered by the adjacent tests. Exact-head CI 35148669515 at `c9fd121d` is GREEN.

**Status:** Implemented

---

### REQ-OPERATOR-011: Serialized operator admission

**Intent:** Admission is revision-safe, idempotent and immutable after authorization.

**Applies To:** User

**Acceptance Criteria:**

1. Admission stores an idempotent receipt pinning the approved manifest, policy, revision, activity intent and deadline. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-011: SQLite registration and admission ordering) -->
2. Later registration changes cannot mutate an admitted receipt. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-011: SQLite registration and admission ordering) -->
3. Identical concurrent admission requests reconcile to the same receipt. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-011: SQLite registration and admission ordering) -->
4. Reusing an admission identity with changed input returns a conflict. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-011: SQLite registration and admission ordering) -->
5. A disable committed before admission denies the request. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-011: SQLite registration and admission ordering) -->
6. A receipt committed before disablement remains readable for reconciliation. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-011: SQLite registration and admission ordering) -->

**Constraints:** No transaction spans registry and activity Durable Objects.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-distribution-registration), [REQ-OPERATOR-014](#req-operator-014-restrictive-operator-policy)

**Verification:** Manifest snapshots and SQLite admission ordering are covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-012: Protected operator webhook keys

**Intent:** Administrators manage optional webhook encryption keys without exposing retained key material.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administrators can generate an optional 256-bit per-operator webhook key. <!-- @impl: src/operators/registry.ts::rotateWebhookKey --> <!-- @impl: src/operators/protected-secrets.ts::createOperatorWebhookKey --> <!-- @test: src/__tests__/operators/webhook-key.test.ts (REQ-OPERATOR-012: optional per-operator webhook key) -->
2. Webhook-key rotation is revision-checked. <!-- @impl: src/operators/registry.ts::rotateWebhookKey --> <!-- @test: src/__tests__/operators/registry-webhook-key.test.ts (REQ-OPERATOR-012: encrypted registry webhook key rotation) -->
3. Only the winning mutation displays plaintext once, together with observable placement instructions. <!-- @impl: src/operators/registry.ts::rotateWebhookKey --> <!-- @test: src/__tests__/operators/registry-webhook-key.test.ts (REQ-OPERATOR-012: encrypted registry webhook key rotation) -->
4. Normal projections expose neither webhook-key plaintext nor ciphertext. <!-- @impl: src/operators/registry.ts::rotateWebhookKey --> <!-- @test: src/__tests__/operators/registry-webhook-key.test.ts (REQ-OPERATOR-012: encrypted registry webhook key rotation) -->
5. Stale rotation or encryption failure preserves the prior revision and key. <!-- @impl: src/operators/protected-secrets.ts::createOperatorWebhookKey --> <!-- @test: src/__tests__/operators/registry-webhook-key.test.ts (REQ-OPERATOR-012: encrypted registry webhook key rotation) -->
6. Retired webhook keys are not accepted indefinitely. <!-- @impl: src/operators/protected-secrets.ts::createOperatorWebhookKey --> <!-- @test: src/__tests__/operators/webhook-key.test.ts (REQ-OPERATOR-012: optional per-operator webhook key) -->

**Constraints:** Retained keys remain protected and absent from ordinary projections.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-distribution-registration)

**Verification:** Webhook-key generation, rotation and protected storage are covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-013: Enterprise operator administration authorization

**Intent:** Operator administration is enterprise-only and bound to a current verified human administrator.

**Applies To:** Admin

**Acceptance Criteria:**

1. Operator administration is unavailable outside enterprise mode. <!-- @impl: src/routes/admin/operators.ts --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-013: enterprise human-admin operator routes) -->
2. Every administration mutation requires current administrator authorization and matching verified human Access claims. <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-013: enterprise human-admin operator routes) -->
3. Service or mixed-principal authentication cannot authorize an administration mutation. <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-013: enterprise human-admin operator routes) -->
4. Failed discovery changes no registration state. <!-- @impl: src/operators/administration.ts::registerDiscoveredOperator --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-013: enterprise human-admin operator routes) -->
5. Registration mutations reject stale revisions without replaying mutations. <!-- @impl: src/operators/administration.ts::approveRegisteredOperator --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-013: enterprise human-admin operator routes) -->
6. Identity collisions return conflicts without changing registration state. <!-- @impl: src/operators/administration.ts::registerDiscoveredOperator --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-013: enterprise human-admin operator routes) -->
7. Operator administration leaves ordinary authentication, quotas, routing and local reviews unchanged. <!-- @impl: src/routes/admin/operators.ts --> <!-- @test: src/__tests__/routes/admin-operators.test.ts (REQ-OPERATOR-013: enterprise human-admin operator routes) -->

**Constraints:** Administration grants neither user eligibility nor execution authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-001](#req-operator-001-verified-human-access-claims), [REQ-OPERATOR-002](#req-operator-002-enterprise-distribution-registration)

**Verification:** Enterprise human-administrator routes are covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-014: Restrictive operator policy

**Intent:** Registered policy narrows operator capabilities and remains pinned for admitted activity.

**Applies To:** Admin

**Acceptance Criteria:**

1. Version-1 policy explicitly limits network hosts, GitHub repositories and methods, owner-relative storage prefixes, and inference route and reasoning choices. <!-- @impl: src/operators/policy.ts::parseOperatorPolicy --> <!-- @test: src/__tests__/operators/policy.test.ts (REQ-OPERATOR-014: bounded restrictive registration policy) -->
2. Empty policy lists deny access. <!-- @impl: src/operators/policy.ts::parseOperatorPolicy --> <!-- @test: src/__tests__/operators/policy.test.ts (REQ-OPERATOR-014: bounded restrictive registration policy) -->
3. Policy cannot select a principal or bucket. <!-- @impl: src/operators/policy.ts::parseOperatorPolicy --> <!-- @test: src/__tests__/operators/policy.test.ts (REQ-OPERATOR-014: bounded restrictive registration policy) -->
4. Unknown, unsafe, duplicate, oversized or internally inconsistent policy input is rejected. <!-- @impl: src/operators/policy.ts::parseOperatorPolicy --> <!-- @test: src/__tests__/operators/policy.test.ts (REQ-OPERATOR-014: bounded restrictive registration policy) -->
5. Policy replacement rejects stale revisions and disables new admission. <!-- @impl: src/operators/registry.ts::setPolicy --> <!-- @test: src/__tests__/operators/registry-policy.test.ts (REQ-OPERATOR-014: restrictive policy snapshots and safe listing) -->
6. Admitted receipts retain their pinned policy after policy replacement. <!-- @impl: src/operators/registry.ts::setPolicy --> <!-- @test: src/__tests__/operators/registry-policy.test.ts (REQ-OPERATOR-014: restrictive policy snapshots and safe listing) -->

**Constraints:** Policy can narrow but cannot grant authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-distribution-registration)

**Verification:** Policy parsing and immutable policy snapshots are covered by the adjacent tests. Runtime enforcement and deployed allowed/denied acceptance remain separate requirements.

**Status:** Implemented

---

### REQ-OPERATOR-003: Principal-bound activity context

**Intent:** Each activity retains only its invoking human's verified authority and pinned identities.

**Applies To:** User

**Acceptance Criteria:**

1. Each activity retains only its invoking human's verified authority and pinned operator, artifact and policy identity. <!-- @impl: src/operators/execution-context.ts --> <!-- @test: src/__tests__/operators/execution-context.test.ts (REQ-OPERATOR-003: protected verified execution context) -->
2. Child input cannot select a principal, bucket, policy or credential. <!-- @impl: src/operators/execution-context.ts --> <!-- @test: src/__tests__/operators/execution-context.test.ts (REQ-OPERATOR-003: protected verified execution context) -->
3. Reauthentication requires the same human provenance. <!-- @impl: src/operators/activity.ts::prepareAuthorized --> <!-- @test: src/__tests__/operators/execution-context.test.ts (REQ-OPERATOR-003: protected verified execution context) -->
4. Human-authority expiry blocks new protected work and uploads. <!-- @impl: src/operators/activity.ts::prepareAuthorized --> <!-- @test: src/__tests__/operators/execution-context.test.ts (REQ-OPERATOR-003: protected verified execution context) -->
5. Public activity projections expose no credential. <!-- @impl: src/operators/execution-context.ts --> <!-- @test: src/__tests__/operators/execution-context.test.ts (REQ-OPERATOR-003: protected verified execution context) -->

**Constraints:** Child code receives no raw human credential.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-011](#req-operator-011-serialized-operator-admission)

**Verification:** Protected execution-context behavior is covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-015: Isolated approved Worker loading

**Intent:** Every execution loads approved code inside a bounded parent-controlled runtime.

**Applies To:** User

**Acceptance Criteria:**

1. Each execution freshly loads the bounded, digest-matched approved artifact. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
2. The loaded Worker receives only parent-provided Operator Interface capabilities and intercepted outbound access. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
3. Child code inherits neither unrestricted bindings nor durable isolate state. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
4. Native-runtime fixtures prove parent-bound identity and outbound allow/deny behavior, but do not count as deployment acceptance. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->

**Constraints:** Child code receives no unrestricted binding or inherited outbound access.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](#req-operator-003-principal-bound-activity-context), [REQ-OPERATOR-030](#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-035](#req-operator-035-approved-artifact-transport)

**Verification:** Worker Loader runtime-boundary behavior is covered by the adjacent tests. Deployed acceptance remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-016: Durable activity admission and cleanup

**Intent:** Durable state serializes activity admission and reports owned cleanup honestly.

**Applies To:** User

**Acceptance Criteria:**

1. Durable activity state owns intent, operation IDs, progress, result and cleanup. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
2. Admission persists private pending intent before registry reconciliation; prepared state is not published as queued. <!-- @impl: src/operators/activity.ts::prepareAuthorized --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
3. Admission consumes start authority only after a matching receipt and fresh expiry check. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
4. Concurrent starts queue once, and uncertain responses reconcile against the same receipt. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
5. Disable-first admission remains unqueued, and unknown effects are never replayed automatically. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
6. Cancellation or expiry stops only owned compute and records actual pending, failed or unknown cleanup without final uploads after expiry. <!-- @manual: documentation/lanes/operator-gate-1.md G1-16 and G1-22 -->
7. Overview reads use non-waking safe projections. <!-- @impl: src/operators/registry.ts::listOwnedActivities --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->

**Constraints:** Unknown external effects are fenced rather than replayed.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-011](#req-operator-011-serialized-operator-admission), [REQ-OPERATOR-003](#req-operator-003-principal-bound-activity-context)

**Verification:** Activity admission behavior is covered by the adjacent tests. Owned-compute cancellation remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-017: Durable drive generations

**Intent:** Generation fencing permits durable resumption without replaying terminal or uncertain work.

**Applies To:** User

**Acceptance Criteria:**

1. One drive generation runs per admitted activity. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-017: durable drive generation and checkpoint) -->
2. Only the current generation may commit a bounded waiting, completed or failed update. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-017: durable drive generation and checkpoint) -->
3. Waiting work resumes from its durable checkpoint under a new generation. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-017: durable drive generation and checkpoint) -->
4. Terminal, cancelled or unknown-effect work does not restart automatically. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-017: durable drive generation and checkpoint) -->
5. Late generation results are rejected. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-017: durable drive generation and checkpoint) -->
6. Drive begin and commit recheck actual human-authority expiry. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-017: durable drive generation and checkpoint) -->
7. The owning human explicitly resumes durable waiting work through a protected request. <!-- @impl: src/routes/operator-activities.ts::handleContinue --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->

**Constraints:** Generation transitions do not extend human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-016](#req-operator-016-durable-activity-admission-and-cleanup)

**Verification:** Durable drive generation and checkpoint behavior is covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-018: Request-attached operator orchestration

**Intent:** The parent prepares and drives one bounded approved Worker execution.

**Applies To:** User

**Acceptance Criteria:**

1. The parent reserves a generation before loading the approved Worker. <!-- @impl: src/operators/runtime.ts::driveOperatorRuntime --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-018: activity-driven Worker execution) -->
2. Start or resume input contains activity identity, generation, bounded invocation and durable checkpoint, but no credential; supplied capabilities are generation-bound. <!-- @impl: src/operators/runtime.ts::driveOperatorRuntime --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-018: activity-driven Worker execution) -->
3. Authenticated preparation selects the enabled revision and pins protected distribution state at admission. <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018: request-attached production orchestration) -->
4. Preparation schedules one direct drive only for the winning start. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018: request-attached production orchestration) -->
5. The runtime accepts only bounded current-generation JSON output. <!-- @impl: src/operators/runtime.ts::driveOperatorRuntime --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-018: activity-driven Worker execution) -->
6. Preparation or transport uncertainty fences the drive as unknown. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018: request-attached production orchestration) -->
7. Request-attached bundle transport and runtime share one 25-second deadline that never exceeds invoking-human authority. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018: request-attached production orchestration) -->

**Constraints:** Runtime deadlines never exceed verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-015](#req-operator-015-isolated-approved-worker-loading), [REQ-OPERATOR-017](#req-operator-017-durable-drive-generations)

**Verification:** Runtime-driver and request-attached orchestration behavior is covered by the adjacent tests. Exact-head CI 35285707512 at `137ffcb5` is GREEN; deployed evidence is recorded in `documentation/lanes/operator-gate-1.md`.

**Status:** Implemented

---

### REQ-OPERATOR-004: Shared restrictive interception

**Intent:** Direct calls and owned sessions enforce identical additional restrictions.

**Applies To:** User

**Acceptance Criteria:**

1. Effective access intersects current human authority with admitted operator restrictions before credential lookup, signing or forwarding. <!-- @impl: src/operators/interception-policy.ts --> <!-- @test: src/__tests__/operators/interception-policy.test.ts (REQ-OPERATOR-004: shared operator restriction decisions) -->
2. Specialized-service denial cannot be bypassed through generic egress. <!-- @impl: src/github-interceptor.ts --> <!-- @test: src/__tests__/github-interceptor.test.ts (REQ-OPERATOR-004: GitHub restrictions before credentials) -->
3. Network permission never grants the Browser administrator credential. <!-- @impl: src/cloudflare-browser-interceptor.ts --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-OPERATOR-004: denies the specialized admin Browser credential to operator sessions before forwarding) -->
4. Network, GitHub and owner-relative storage decisions are shared across transports. <!-- @impl: src/operators/interception-policy.ts --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-004: operator restrictions precede egress and R2 credentials) -->
5. Restricted interception is mandatory regardless of ordinary human strict-egress preferences. <!-- @impl: src/container/container-interception.ts --> <!-- @test: src/__tests__/container/operator-env.test.ts (operator container environment) -->
6. Approved inference, platform and storage access remains distinct from general Internet permission. <!-- @impl: src/operators/interception-policy.ts --> <!-- @test: src/__tests__/operators/interception-policy.test.ts (REQ-OPERATOR-004: shared operator restriction decisions) -->
7. Existing SWG transport remains intact. <!-- @impl: src/egress-controller.ts --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-004: operator restrictions precede egress and R2 credentials) -->

**Constraints:**

- Operator policy can only narrow current human authority.
- Specialized service credentials never enter child-controlled state.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](#req-operator-003-principal-bound-activity-context), [REQ-OPERATOR-014](#req-operator-014-restrictive-operator-policy)

**Verification:** Shared interception and Browser denial are covered by the adjacent transport tests. Deployed direct and session egress acceptance remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-019: Automatic human Access JWT stamping

**Intent:** Authorized outbound requests can receive a verified human assertion without changing service authentication.

**Applies To:** User

**Acceptance Criteria:**

1. Every redirect destination is independently authorized without automatic redirect following. <!-- @impl: src/operators/jwt-stamping.ts --> <!-- @test: src/__tests__/operators/jwt-stamping.test.ts (REQ-OPERATOR-019: automatic human Access JWT stamping) -->
2. Stamping removes caller assertions while preserving specialized Authorization. <!-- @impl: src/operators/jwt-stamping.ts::prepareJwtStampedRequest --> <!-- @test: src/__tests__/github-interceptor.test.ts (stamps verified Access after repository authorization while preserving the GitHub credential) -->
3. Generic egress stamps only after its existing authorization decision. <!-- @impl: src/egress-controller.ts --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-019: verified Access stamping in generic egress) -->
4. GitHub, AI Gateway and Browser transports stamp only after their existing authorization decisions. <!-- @impl: src/github-interceptor.ts --> <!-- @impl: src/llm-interceptor.ts --> <!-- @impl: src/cloudflare-browser-interceptor.ts --> <!-- @test: src/__tests__/github-interceptor.test.ts (stamps verified Access after repository authorization while preserving the GitHub credential) --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-OPERATOR-004: stamps the verified assertion on the actual Gateway recipient without replacing gateway auth) --> <!-- @test: src/__tests__/cloudflare-browser-interceptor.test.ts (REQ-OPERATOR-004: stamps verified Access while preserving the Browser credential) -->
5. Explicit endpoint authentication remains independent of automatic stamping. <!-- @impl: src/operators/jwt-stamping.ts --> <!-- @test: src/__tests__/operators/jwt-stamping.test.ts (REQ-OPERATOR-019: automatic human Access JWT stamping) -->

**Constraints:** Stamping never authorizes egress or renews authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception), [REQ-OPERATOR-028](#req-operator-028-access-jwt-stamping-configuration)

**Verification:** JWT-stamping behavior is covered by the adjacent transport tests. Exact-head CI 35159474090 at `3c7731e6` is GREEN. Deployed relying-party acceptance remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-020: Operator-scoped R2 interception

**Intent:** Operator storage operations remain bound to admitted owner and activity scope.

**Applies To:** User

**Acceptance Criteria:**

1. R2 reads, listing, writes and multipart operations are server-bound to permitted owner and activity scope; explicit Sync writes carry a stripped internal operation identity and are authorized against exact prepared keys. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @impl: src/operators/activity.ts::authorizeSyncWrite --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-004: operator restrictions precede egress and R2 credentials) -->
2. Unsupported copy, deletion and control operations are denied. <!-- @impl: src/operators/interception-policy.ts::decideOperatorStorage --> <!-- @test: src/__tests__/operators/interception-policy.test.ts (REQ-OPERATOR-004: shared operator restriction decisions) -->
3. Writes to sealed operations are denied. <!-- @impl: src/operators/activity.ts::authorizeSyncWrite --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) -->
4. Existing managed-resource protections remain enforced. <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-004: operator restrictions precede egress and R2 credentials) -->

**Constraints:** Storage access cannot escape the admitted owner or activity scope.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception)

**Verification:** R2 transport behavior passed exact-head CI 35285707512 at `137ffcb5` and deployed activity `e44f0abe-8097-46d5-9265-8a4750024b8e` independently verified the exact uploaded marker bytes.

**Status:** Implemented

---

### REQ-OPERATOR-005: Owned operator session lifecycle

**Intent:** Session identity, ownership and authority remain durable and independently controllable.

**Applies To:** User

**Acceptance Criteria:**

1. Owned-session services preserve distinct activity, Codeflare session, Pi conversation and task identities. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/operators/gate1-resources.ts::resolveGate1Resources --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) --> <!-- @test: src/__tests__/operators/gate1-resources.test.ts (REQ-OPERATOR-005: parent-owned Gate 1 resource mapping) -->
2. Session ownership and restrictions persist before startup. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/operators/activity.ts::saveOwnedSession --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) -->
3. Lost startup responses reconcile against the same reservation, while uncertain configuration remains uncertain. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/operators/gate1-runtime.ts::ContainerOwnedSessionRuntime --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) --> <!-- @test: src/__tests__/operators/gate1-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->
4. Stop affects only the owned session. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/container/index.ts::stopOperatorSession --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) --> <!-- @test: src/__tests__/operators/gate1-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->
5. Wake restores restrictions but requires same-human authority rebind. <!-- @impl: src/container/operator-context.ts --> <!-- @test: src/__tests__/container/operator-context.test.ts (operator container context) -->
6. Operator/operator and operator/human overlap cannot corrupt unrelated state or stop another activity. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) -->
7. Before startup, the parent programmatically reconciles the verified human's bucket and passes fresh bucket-scoped credentials plus the applied managed-resource identity to the owned container. <!-- @impl: src/operators/session-bootstrap.ts::bootstrapOperatorSession --> <!-- @impl: src/operators/gate1-runtime.ts::ContainerOwnedSessionRuntime --> <!-- @test: src/__tests__/operators/session-bootstrap.test.ts (REQ-OPERATOR-005: programmatic operator session bootstrap) --> <!-- @test: src/__tests__/operators/gate1-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->

**Constraints:** Non-operator sessions remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception)

**Verification:** Owned-session and container-context behavior is covered by the adjacent tests. Deployed stop and concurrency acceptance remain unverified.

**Status:** Implemented

---

### REQ-OPERATOR-021: Structured owned Pi conversation

**Intent:** The host exposes one bounded, durable Pi SDK conversation per owned session.

**Applies To:** User

**Acceptance Criteria:**

1. The host manages one owned structured SDK conversation with stable operation IDs. <!-- @impl: host/src/operator-pi.ts::OperatorPiConversation --> <!-- @impl: host/src/operator-pi-sdk.ts::createProvisionedOperatorPiFactory --> <!-- @impl: src/operators/gate1-capability.ts::Gate1OperatorCapability --> <!-- @test: host/__tests__/operator-pi.test.js (REQ-OPERATOR-021: creates once, persists exact identity and reopens only the recorded file) --> <!-- @test: src/__tests__/operators/gate1-capability.test.ts (REQ-OPERATOR-005: finite Gate 1 session capability) -->
2. The conversation supports bounded prompt, follow-up, steer, approved native-tool execution and observation, explicit approval-needed state, and awaited cancellation. <!-- @impl: host/src/operator-pi-http.ts::OperatorPiHttpController --> <!-- @test: host/__tests__/operator-pi-http.test.js (REQ-OPERATOR-021: fixed ensure/send/observe/abort API omits the private session file) -->
3. Conversation intent persists before submission, and same-ID retries, including concurrent submissions, reconcile to one invocation. <!-- @impl: host/src/operator-pi.ts::OperatorPiConversation --> <!-- @test: host/__tests__/operator-pi.test.js (REQ-OPERATOR-021: concurrent same-ID submission reserves one prompt invocation) -->
4. Only the recorded session file and ID may reopen a conversation. <!-- @impl: host/src/operator-pi-sdk.ts::createProvisionedOperatorPiFactory --> <!-- @test: host/__tests__/operator-pi-sdk.test.js (REQ-OPERATOR-021: reopens only a canonical file inside the owned session directory) -->
5. Missing conversations and uncertain tool effects are neither replaced nor replayed. <!-- @impl: host/src/operator-pi-service.ts::createOperatorPiService --> <!-- @test: host/__tests__/operator-pi-service.test.js (REQ-OPERATOR-021: trusted config binds identity/root/profile and produces a ready service) -->
6. The Pi router authenticates requests before forwarding its fixed request and response contract. <!-- @impl: host/src/request-router.ts --> <!-- @test: host/__tests__/operator-pi-router.test.js (REQ-OPERATOR-021: router authenticates then forwards fixed Pi request bytes/query and response) -->
7. Ordinary PTYs and root execution remain unchanged. <!-- @impl: host/src/request-router.ts --> <!-- @test: host/__tests__/request-router.test.js (request router) -->

**Constraints:** Unknown SDK effects are not replayed.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-005](#req-operator-005-owned-operator-session-lifecycle)

**Verification:** Structured Pi conversation behavior is covered by the adjacent host tests.

**Status:** Implemented

---

### REQ-OPERATOR-022: Restricted operator container lifecycle

**Intent:** Restricted containers avoid ordinary persistence paths during startup and shutdown.

**Applies To:** User

**Acceptance Criteria:**

1. Restricted startup restores only approved inputs. <!-- @impl: entrypoint.sh::run_operator_startup --> <!-- @test: host/__tests__/entrypoint-operator-startup.test.js (REQ-OPERATOR-022: operator startup selects only restricted initialization) -->
2. Restricted startup never enters ordinary whole-home restore, bisync or baseline-daemon paths. <!-- @impl: entrypoint.sh::run_operator_startup --> <!-- @test: host/__tests__/entrypoint-operator-startup.test.js (REQ-OPERATOR-022: operator startup selects only restricted initialization) -->
3. Restricted shutdown may drain an accepted explicit upload but never starts bisync. <!-- @impl: entrypoint.sh::drain_operator_sync_shutdown --> <!-- @impl: src/container/index.ts::stopOperatorSession --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPERATOR-022: restricted shutdown drains only accepted explicit upload and never starts bisync) --> <!-- @test: src/__tests__/operators/gate1-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->
4. A stop under valid authority drains explicit persistence. <!-- @impl: entrypoint.sh::drain_operator_sync_shutdown --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPERATOR-022: restricted shutdown drains only accepted explicit upload and never starts bisync) -->
5. Expired authority blocks persistence before an upload is accepted. <!-- @impl: src/operators/activity.ts::prepareSync --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) -->
6. Expired authority blocks persistence during shutdown drain. <!-- @impl: entrypoint.sh::drain_operator_sync_shutdown --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPERATOR-022: restricted shutdown drains only accepted explicit upload and never starts bisync) -->
7. Stop awaits owned SDK cancellation and reports unsynced output honestly. <!-- @impl: host/src/operator-pi.ts::OperatorPiConversation --> <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @test: host/__tests__/operator-pi.test.js (REQ-OPERATOR-021: creates once, persists exact identity and reopens only the recorded file) -->

**Constraints:** Ordinary non-operator persistence remains unchanged.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-005](#req-operator-005-owned-operator-session-lifecycle), [REQ-OPERATOR-021](#req-operator-021-structured-owned-pi-conversation)

**Verification:** Restricted startup and shutdown selection is covered by the adjacent tests. Deployed stop acceptance remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-023: Explicit operator synchronization

**Intent:** Scoped Sync now persists only declared canonical files from the human-readable Operators folder through idempotent requests.

**Applies To:** User

**Acceptance Criteria:**

1. Scoped Sync now accepts only canonical files beneath `~/Operators` matching their declared exact size and hash. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @impl: host/src/operator-sync-io.ts --> <!-- @test: host/__tests__/operator-sync-io.test.js (REQ-OPERATOR-023: local adapter reads only exact regular non-symlink files beneath the owned root) -->
2. Scoped Sync now mirrors declared paths under the `Operators/` storage prefix and writes no implicit deletions. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @test: host/__tests__/operator-sync.test.js (REQ-OPERATOR-023: persists intent then uploads exact files and canonical manifest last) -->
3. Scoped Sync now publishes the canonical manifest under private `.codeflare/operators/` metadata after all declared files. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @test: host/__tests__/operator-sync.test.js (REQ-OPERATOR-023: persists intent then uploads exact files and canonical manifest last) -->
4. Stable receipts reconcile identical sync requests, including concurrent identical requests without duplicate upload, while changed request reuse conflicts. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @impl: host/src/operator-sync-service.ts::ConfiguredCoordinator --> <!-- @test: host/__tests__/operator-sync.test.js (REQ-OPERATOR-023: concurrent same-operation requests upload once and reconcile the receipt) -->
5. Interrupted sync effects become unknown before any further writes. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @test: host/__tests__/operator-sync.test.js (REQ-OPERATOR-023: persists intent then uploads exact files and canonical manifest last) -->
6. The sync router authenticates requests before forwarding the fixed explicit-sync contract. <!-- @impl: host/src/request-router.ts --> <!-- @test: host/__tests__/operator-sync-router.test.js (REQ-OPERATOR-023: router authenticates before forwarding fixed explicit-sync requests) -->

**Constraints:** Unknown upload effects are not replayed.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-020](#req-operator-020-operator-scoped-r2-interception), [REQ-OPERATOR-022](#req-operator-022-restricted-operator-container-lifecycle)

**Verification:** Explicit-sync behavior is covered by the adjacent host tests.

**Status:** Implemented

---

### REQ-OPERATOR-024: Independent synchronization verification

**Intent:** Uploaded output becomes durable only after bounded independent verification.

**Applies To:** User

**Acceptance Criteria:**

1. Durability requires independent bounded reads matching the sealed activity, session, operation, request and policy identity. <!-- @impl: src/operators/activity.ts::prepareSync --> <!-- @impl: src/egress-controller.ts::EgressController --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) --> <!-- @test: src/__tests__/egress-controller.test.ts (REQ-OPERATOR-004: operator restrictions precede egress and R2 credentials) -->
2. Independent reads must match every declared file hash and size. <!-- @impl: src/operators/sync-verification.ts::verifyOperatorSync --> <!-- @test: src/__tests__/operators/sync-verification.test.ts (REQ-OPERATOR-024: independently verified sync bytes) -->
3. Upload completion seals the operation against further writes. <!-- @impl: src/operators/activity.ts::prepareSync --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) -->
4. Missing, corrupt, expired or out-of-scope evidence fails verification. <!-- @impl: src/operators/sync-verification.ts::verifyOperatorSync --> <!-- @test: src/__tests__/operators/sync-verification.test.ts (REQ-OPERATOR-024: independently verified sync bytes) -->
5. Uploader timestamps alone are not durability evidence. <!-- @impl: src/operators/sync-verification.ts::verifyOperatorSync --> <!-- @test: src/__tests__/operators/sync-verification.test.ts (REQ-OPERATOR-024: independently verified sync bytes) -->

**Constraints:** Fixture upload success is not durability evidence.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-023](#req-operator-023-explicit-operator-synchronization)

**Verification:** Independent byte verification is covered by the adjacent tests. Exact-head CI 35169456503 at `0ce22c80` is GREEN. Deployed file-to-R2 restoration remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-006: Capability-authenticated webhook activity

**Intent:** External consumers start fixed activities and collect results without an independent execution identity.

**Applies To:** User

**Acceptance Criteria:**

1. Versioned webhook routes use distinct 256-bit capabilities for start, status and terminal-result redemption. <!-- @impl: src/operators/activity.ts::startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
2. Capability scope is fixed before issuance. <!-- @impl: src/operators/activity.ts::startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
3. Concurrent start-capability consumers produce one winner. <!-- @impl: src/operators/activity.ts::startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
4. Consuming a start capability durably queues execution. <!-- @impl: src/operators/activity.ts::startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
5. Terminal failure, cancellation, expiry and supersession produce bounded results. <!-- @impl: src/operators/activity.ts::startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
6. Valid result authority remains collectible after user JWT expiry or operator disablement without extending execution. <!-- @impl: src/operators/activity.ts::startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
7. Lost terminal-result delivery remains consumed and never triggers execution rerun. <!-- @impl: src/operators/activity.ts::startWebhook --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->

**Constraints:**

- Capabilities are route-, activity-, operation- and purpose-bound.
- Capabilities do not renew human authority.
- Capabilities do not create an independent execution identity.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-016](#req-operator-016-durable-activity-admission-and-cleanup), [REQ-OPERATOR-018](#req-operator-018-request-attached-operator-orchestration)

**Verification:** Capability consumption and activity-result behavior is covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-025: Optional encrypted webhook handoff

**Intent:** Webhook handoff protects capability delivery when an operator key is configured.

**Applies To:** User

**Acceptance Criteria:**

1. A configured optional operator webhook key protects handoff with authenticated encryption and bound context. <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff --> <!-- @test: src/__tests__/operators/webhook-handoff.test.ts (REQ-OPERATOR-025: optional encrypted webhook handoff) -->
2. Without a configured key, handoff permits the one-time token alone. <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff --> <!-- @test: src/__tests__/operators/webhook-handoff.test.ts (REQ-OPERATOR-025: optional encrypted webhook handoff) -->
3. Unencrypted handoff emits a dispatch-visibility warning. <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff --> <!-- @test: src/__tests__/operators/webhook-handoff.test.ts (REQ-OPERATOR-025: optional encrypted webhook handoff) -->
4. Configured encryption failure never silently downgrades to unencrypted handoff. <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff --> <!-- @test: src/__tests__/operators/webhook-handoff.test.ts (REQ-OPERATOR-025: optional encrypted webhook handoff) -->
5. Webhook tokens and keys stay out of logs and candidate-controlled steps. <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff --> <!-- @test: src/__tests__/operators/webhook-handoff.test.ts (REQ-OPERATOR-025: optional encrypted webhook handoff) -->

**Constraints:** Handoff reveals no reusable execution credential.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-012](#req-operator-012-protected-operator-webhook-keys)

**Verification:** Optional encrypted webhook handoff is covered by the adjacent tests. Public-host callback acceptance in both handoff modes remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-026: Managed webhook edge bypass

**Intent:** Enterprise setup exposes only the capability-authenticated webhook path through Access.

**Applies To:** Admin

**Acceptance Criteria:**

1. Enterprise Access setup idempotently manages a narrow, higher-precedence bypass for the versioned operator webhook activity surface. <!-- @impl: web-ui/src/components/admin/EnvironmentAreaFields.tsx::EnvironmentAreaFields --> <!-- @test: web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx (REQ-OPERATOR-026: shows managed Webhook Endpoint Access bypass status only for enterprise Access) -->
2. Setup reports bypass provisioning failure. <!-- @impl: web-ui/src/components/admin/EnvironmentAreaFields.tsx::EnvironmentAreaFields --> <!-- @test: web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx (REQ-OPERATOR-026: shows managed Webhook Endpoint Access bypass status only for enterprise Access) -->
3. Setup removes an incomplete new bypass configuration. <!-- @impl: src/routes/setup/access.ts::upsertOperatorWebhookBypassAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (REQ-OPERATOR-026: removes a newly-created incomplete operator bypass and reports policy failure) -->
4. Bypass provisioning failure preserves all other Access protection. <!-- @impl: src/routes/setup/access.ts::upsertOperatorWebhookBypassAccessApp --> <!-- @test: src/__tests__/routes/setup/access.test.ts (REQ-OPERATOR-026: removes a newly-created incomplete operator bypass and reports policy failure) -->

**Constraints:** The bypass weakens no protection outside its exact versioned path.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-webhook-activity)

**Verification:** Managed bypass behavior is covered by the adjacent tests. Exact-head CI 35171737437 at `2ac5a5c0` is GREEN.

**Status:** Implemented

---

### REQ-OPERATOR-007: Operator-aware inference selection

**Intent:** Operator defaults and restrictions reuse current provider eligibility rather than grant new inference access.

**Applies To:** User

**Acceptance Criteria:**

1. Resolve current eligible verified catalog, intersect registered allowed routes, then apply valid trusted invocation selection or registered defaults; user defaults are inherited only explicitly. <!-- @impl: src/operators/inference-selection.ts::resolveOperatorInference --> <!-- @test: src/__tests__/operators/inference-selection.test.ts (REQ-OPERATOR-007: operator inference intersection) -->
2. Unsupported or unauthorized route/reasoning selection fails without substitution. Child payload and lane/resource settings cannot override trusted selection; provider-default remains distinct from Off. <!-- @impl: src/operators/inference-selection.ts::resolveOperatorInference --> <!-- @test: src/__tests__/operators/inference-selection.test.ts (REQ-OPERATOR-007: operator inference intersection) -->
3. Direct and Pi calls enforce the same effective selection and trusted activity attribution while preserving ordinary human fallback. <!-- @impl: src/llm-interceptor.ts::LlmInterceptor --> <!-- @impl: src/container/container-interception.ts --> <!-- @test: src/__tests__/llm-interceptor.test.ts (REQ-OPERATOR-007: enforces parent-trusted route/reasoning over child payload and stamps trusted attribution) -->

**Constraints:**

- Operator selection can only narrow the current verified provider catalog.
- Child input cannot choose or override trusted routing.
- Child input cannot choose or override trusted reasoning.
- Child input cannot choose or override trusted attribution.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception)

**Verification:** Selection and interceptor behavior is covered by the adjacent tests. Exact-head CI 35172865340 at `d51d0039` is GREEN. Actual provider-request acceptance remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-008: Enterprise operator administration surface

**Intent:** Administrators manage operator lifecycle and configuration without secret disclosure or implicit replay.

**Applies To:** Admin

**Acceptance Criteria:**

1. Enterprise Administration presents registration, discovery, digest approval and enablement as separate actions. <!-- @impl: web-ui/src/components/admin/OperatorsPage.tsx::OperatorsPage --> <!-- @test: web-ui/src/__tests__/components/OperatorsPage.test.tsx (REQ-OPERATOR-008: enterprise Operators administration) -->
2. The administration surface exposes restrictive policy, inference, webhook-key and managed-bypass state through existing responsive patterns. <!-- @impl: web-ui/src/components/admin/OperatorsPage.tsx::OperatorsPage --> <!-- @test: web-ui/src/__tests__/components/OperatorsPage.test.tsx (REQ-OPERATOR-008: enterprise Operators administration) -->
3. New registrations deny by default. <!-- @impl: src/operators/administration.ts::discoverRegisteredOperator --> <!-- @test: web-ui/src/__tests__/api/operators.test.ts (REQ-OPERATOR-008: operator administration client) -->
4. Conflicts require explicit reconciliation, and administration mutations are never replayed automatically. <!-- @impl: web-ui/src/api/operators.ts --> <!-- @test: web-ui/src/__tests__/api/operators.test.ts (REQ-OPERATOR-008: operator administration client) -->

**Constraints:**

- Administration UI is enterprise-only.
- Secret readback is prohibited.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-013](#req-operator-013-enterprise-operator-administration-authorization), [REQ-OPERATOR-014](#req-operator-014-restrictive-operator-policy), [REQ-OPERATOR-026](#req-operator-026-managed-webhook-edge-bypass), [REQ-OPERATOR-032](#req-operator-032-secret-safe-administration-readback)

**Verification:** Enterprise operator administration is covered by the adjacent component and client tests.

**Status:** Implemented

---

### REQ-OPERATOR-027: Owned activity user surface

**Intent:** Users observe and control owned activities without conflating execution, storage and collection outcomes.

**Applies To:** User

**Acceptance Criteria:**

1. The header operator control follows the user control, remains accessible with zero activity and counts working activities. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
2. Desktop and tablet render the activity control as a popover; mobile renders it as a bottom sheet. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
3. Progress, source and session links, result, and execution, cleanup, collection and attention states remain distinct. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
4. Unknown activity values are never displayed as zero. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
5. Authenticated activity-detail requests expose only account-owned activities. <!-- @impl: src/routes/operator-activities.ts::owned --> <!-- @impl: src/routes/operator-activities.ts::browserDetail --> <!-- @impl: src/operators/registry.ts::listOwnedActivities --> <!-- @impl: src/operators/activity.ts::getBrowserDetail --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->
6. Authenticated result requests expose only account-owned activity results. <!-- @impl: src/routes/operator-activities.ts::owned --> <!-- @impl: src/routes/operator-activities.ts::browserDetail --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->
7. Activity GET requests are non-effectful; browser closure neither loses valid activity progress nor extends authority. <!-- @impl: src/routes/operator-activities.ts::handleBrowserDetail --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->

**Constraints:**

- Data routes are enterprise-only.
- Data routes are owner-scoped.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-016](#req-operator-016-durable-activity-admission-and-cleanup)

**Verification:** Activity control and owner-scoped browser API behavior is covered by the adjacent tests. Exact-head CI 35174509964 at `e03c48ec` is GREEN. Deployed desktop, tablet and mobile acceptance remains unverified.

**Status:** Implemented

---

### REQ-OPERATOR-036: Owned activity user mutations

**Intent:** Users mutate only their own activities through authenticated, non-replayed requests.

**Applies To:** User

**Acceptance Criteria:**

1. Authenticated cancellation requests affect only account-owned activities. <!-- @impl: src/routes/operator-activities.ts::owned --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->
2. Browser activity-start requests require CSRF protection. <!-- @impl: src/routes/operator-activities.ts::requireMutationCsrf --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->
3. Browser activity-start requests affect only account-owned activities. <!-- @impl: src/routes/operator-activities.ts::owned --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->
4. Activity mutations are never replayed automatically. <!-- @impl: web-ui/src/api/operator-activities.ts::cancelOperatorActivity --> <!-- @test: web-ui/src/__tests__/api/operators.test.ts (REQ-OPERATOR-036: activity client mutations are not replayed automatically) -->

**Constraints:**

- Mutation routes are enterprise-only.
- Mutation routes are owner-scoped.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-016](#req-operator-016-durable-activity-admission-and-cleanup), [REQ-OPERATOR-027](#req-operator-027-owned-activity-user-surface)

**Verification:** Owner-scoped cancellation and CSRF-protected browser start are covered by the adjacent route tests. The browser client test proves rejected mutations are attempted once.

**Status:** Implemented

---

### REQ-OPERATOR-009: Reusable platform interfaces and bounded consumer fixtures

**Intent:** Later operator implementations consume one versioned invocation contract without gaining business-workflow authority.

**Applies To:** User

**Acceptance Criteria:**

1. Version-1 direct, session and webhook invocation shapes are accepted without business-specific fields. <!-- @impl: src/operators/consumer-contracts.ts::invocationSchema = schemaVersion: z.literal(1), interfaceVersion: z.literal(1) --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
2. A changed source reference conflicts with the admitted invocation. <!-- @impl: src/operators/consumer-contracts.ts::reconcileOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
3. A changed revision digest conflicts with the admitted invocation. <!-- @impl: src/operators/consumer-contracts.ts::reconcileOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
4. A changed input digest conflicts with the admitted invocation. <!-- @impl: src/operators/consumer-contracts.ts::reconcileOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
5. Operator-origin sessions cannot enter human admission recursively. <!-- @impl: src/operators/consumer-contracts.ts::validateOperatorSessionOrigin --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
6. Operator session origin must match the parent activity. <!-- @impl: src/operators/consumer-contracts.ts::validateOperatorSessionOrigin --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
7. A changed run identity conflicts with the admitted invocation. <!-- @impl: src/operators/consumer-contracts.ts::reconcileOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->

**Constraints:**

- Consumer compatibility grants no Review authority.
- Consumer compatibility grants no history authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-021](#req-operator-021-structured-owned-pi-conversation), [REQ-OPERATOR-024](#req-operator-024-independent-synchronization-verification), [REQ-OPERATOR-025](#req-operator-025-optional-encrypted-webhook-handoff), [REQ-OPERATOR-027](#req-operator-027-owned-activity-user-surface)

**Verification:** Consumer invocation acceptance, immutable reconciliation and session-origin behavior are covered by the adjacent behavioral tests.

**Status:** Implemented

---

### REQ-OPERATOR-037: Bounded operator consumer inputs

**Intent:** Consumer-provided attachments and payloads remain bounded and carry no credentials.

**Applies To:** User

**Acceptance Criteria:**

1. Consumer invocations accept at most 16 attachments. <!-- @impl: src/operators/consumer-contracts.ts::invocationSchema = .max(16) --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
2. Declared attachment bytes stay within the 8 MiB total limit. <!-- @impl: src/operators/consumer-contracts.ts::invocationSchema = <= 8 * 1024 * 1024 --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
3. Attachment names are canonical non-path identifiers. <!-- @impl: src/operators/consumer-contracts.ts::parseOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
4. Credential-bearing consumer fields are rejected. <!-- @impl: src/operators/consumer-contracts.ts::parseOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->
5. Nested authority payloads are rejected. <!-- @impl: src/operators/consumer-contracts.ts::parseOperatorConsumerInvocation --> <!-- @test: src/__tests__/operators/consumer-contracts.test.ts (REQ-OPERATOR-009: reusable bounded consumer contracts) -->

**Constraints:**

- Consumer input cannot grant platform authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-009](#req-operator-009-reusable-platform-interfaces-and-bounded-consumer-fixtures)

**Verification:** Attachment bounds, canonical names and authority rejection are covered by the adjacent consumer-contract tests.

**Status:** Implemented

---

### REQ-OPERATOR-038: Bounded operator consumer fixtures

**Intent:** Small fixtures prove each reusable consumer seam without implementing private workflows.

**Applies To:** User

**Acceptance Criteria:**

1. A distribution fixture proves approved artifact loading. <!-- @impl: fixtures/operator-gate1/src/index.ts::handleGate1FixtureRequest --> <!-- @test: src/__tests__/operators/gate1-fixture-distribution.test.ts (REQ-OPERATOR-009: live Gate 1 fixture distribution) -->
2. A direct fixture proves bounded execution without a session. <!-- @impl: src/__tests__/operators/fixtures/platform-acceptance.ts::runDirectFixture --> <!-- @test: src/__tests__/operators/platform-acceptance-fixtures.test.ts (REQ-OPERATOR-009: platform acceptance fixtures) -->
3. A session fixture proves bounded owned-session execution. <!-- @impl: src/__tests__/operators/fixtures/platform-acceptance.ts::runSessionFixture --> <!-- @test: src/__tests__/operators/platform-acceptance-fixtures.test.ts (REQ-OPERATOR-009: platform acceptance fixtures) -->
4. A webhook fixture proves capability-authenticated handoff. <!-- @impl: src/__tests__/operators/fixtures/platform-acceptance.ts::runWebhookCallerFixture --> <!-- @test: src/__tests__/operators/platform-acceptance-fixtures.test.ts (REQ-OPERATOR-009: platform acceptance fixtures) -->
5. Fixture execution leaves local-review resources unchanged. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @test: src/__tests__/operators/legacy-review-unchanged.test.ts (REQ-OPERATOR-009: unchanged canonical local-review resource) -->

**Constraints:**

- Consumer fixtures carry no credentials.
- Consumer fixtures carry no publisher authority.
- Consumer fixtures contain no private business workflow.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-009](#req-operator-009-reusable-platform-interfaces-and-bounded-consumer-fixtures), [REQ-OPERATOR-037](#req-operator-037-bounded-operator-consumer-inputs)

**Verification:** Distribution, direct, session, webhook and local-review regression fixtures are covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-039: Gate 1 fixture deployment

**Intent:** Deployment automation invokes the stateless fixture only after the intended Enterprise Integration release.

**Applies To:** Admin

**Acceptance Criteria:**

1. A successful Enterprise Integration deploy invokes the stateless Gate 1 fixture. <!-- @impl: .github/workflows/deploy.yml::operator-gate1-fixture --> <!-- @impl: .github/workflows/deploy-operator-gate1.yml::deploy --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (gates automatic Gate 1 fixture deployment on a successful Enterprise Integration deploy) -->
2. A failed primary deploy does not invoke the fixture. <!-- @impl: .github/workflows/deploy.yml::operator-gate1-fixture --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (gates automatic Gate 1 fixture deployment on a successful Enterprise Integration deploy) -->
3. Other deployment targets do not invoke the fixture. <!-- @impl: .github/workflows/deploy.yml::operator-gate1-fixture --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (gates automatic Gate 1 fixture deployment on a successful Enterprise Integration deploy) -->
4. The fixture call inherits repository credentials. <!-- @impl: .github/workflows/deploy.yml::operator-gate1-fixture --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (gates automatic Gate 1 fixture deployment on a successful Enterprise Integration deploy) -->
5. The fixture connection secret remains owned by the Enterprise Integration environment. <!-- @impl: .github/workflows/deploy-operator-gate1.yml::deploy --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (gates automatic Gate 1 fixture deployment on a successful Enterprise Integration deploy) -->

**Constraints:**

- Fixture success is not deployment acceptance.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-038](#req-operator-038-bounded-operator-consumer-fixtures)

**Verification:** Deployment gating is covered by the adjacent host tests. Enterprise and non-enterprise deployment evidence is recorded separately in `documentation/lanes/operator-gate-1.md`; implementation completion does not substitute for deployed acceptance. Exact-head CI 35285707512 at `137ffcb5` is GREEN.

**Status:** Implemented

---

### REQ-OPERATOR-010: Bounded operator discovery document

**Intent:** Administrators discover one versioned operator manifest without executing its content or accepting caller-selected authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. A discovery document is at most 64 KiB and declares version-1 schema/interface, stable identity, descriptive metadata, core/intent versions, bounded input metadata, supported capabilities and artifact path/digest. <!-- @impl: src/operators/distribution.ts::parseOperatorManifest --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: operator discovery boundary) -->
2. Unknown versions or capabilities, duplicate capabilities, malformed fields, missing fields and caller identity or binding fields are rejected. <!-- @impl: src/operators/distribution.ts::parseOperatorManifest --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: operator discovery boundary) -->
3. A distribution endpoint is a credential-free, fragment-free HTTPS URL with a DNS hostname. <!-- @impl: src/operators/distribution.ts::validateOperatorEndpoint --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: operator discovery boundary) -->
4. Artifact paths are canonical origin-relative paths without query, fragment, encoded ambiguity, traversal or backslash, and cannot leave the registered origin. <!-- @impl: src/operators/distribution.ts::parseOperatorManifest --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: operator discovery boundary) -->
5. Manifest parsing returns validated data without granting network, Access or execution authority. <!-- @impl: src/operators/distribution.ts::parseOperatorManifest --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: operator discovery boundary) -->
6. Invalid, oversized or incompatible manifests return typed safe errors without source bytes or credentials. <!-- @impl: src/operators/distribution.ts::parseOperatorManifest --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-010: operator discovery boundary) -->

**Constraints:** Discovery validation does not establish invoking-user eligibility or execute an operator.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-001](#req-operator-001-verified-human-access-claims), [REQ-OPERATOR-002](#req-operator-002-enterprise-distribution-registration), [REQ-OPERATOR-034](#req-operator-034-authenticated-discovery-transport)

**Verification:** Discovery and bundle parser behavior passed exact-head CI 35285707512 at `137ffcb5`; deployed registration revision 5 and the approved artifact digest are recorded in `documentation/lanes/operator-gate-1.md`.

**Status:** Implemented

---

### REQ-OPERATOR-028: Access JWT stamping configuration

**Intent:** Administrators explicitly choose which HTTPS destinations may receive automatic human Access assertions.

**Applies To:** Admin

**Acceptance Criteria:**

1. Automatic HTTPS Access stamping defaults Off. <!-- @impl: src/operators/jwt-stamping.ts --> <!-- @test: src/__tests__/operators/jwt-stamping.test.ts (REQ-OPERATOR-019: automatic human Access JWT stamping) -->
2. Configuration accepts exact hosts and subdomain-only wildcards. <!-- @impl: src/operators/jwt-stamping.ts --> <!-- @test: src/__tests__/routes/admin-configuration-preview.test.ts (previews, applies and reloads automatic JWT stamping without mutating during preview) -->
3. All-destination mode requires explicit disclosure confirmation. <!-- @impl: src/lib/admin-configuration.ts --> <!-- @test: web-ui/src/__tests__/components/EnvironmentAreaFields.test.tsx (REQ-OPERATOR-028: renders Off/list/All stamping controls and serializes canonical destination lines) -->

**Constraints:** Configuration grants neither egress nor renewable identity.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-013](#req-operator-013-enterprise-operator-administration-authorization)

**Verification:** Configuration preview, apply, reload and UI behavior are covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-029: Capability-authenticated webhook edge

**Intent:** Users reach only the fixed enterprise webhook contract through the managed edge path.

**Applies To:** User

**Acceptance Criteria:**

1. Webhook-path requests reach the fixed Worker contract rather than the SPA fallback. <!-- @impl: wrangler.toml::run_worker_first --> <!-- @impl: src/index.ts::fetch --> <!-- @test: host/__tests__/wrangler-static-assets.test.js (REQ-AUTH-020 AC1, REQ-AUTH-022 AC7, REQ-OPERATOR-029 AC1: Worker-first asset routing) --> <!-- @test: src/__tests__/index.test.ts (REQ-OPERATOR-029: routes the public webhook family through Hono instead of SPA assets) -->
2. The Worker rejects invalid capabilities, methods, paths and non-enterprise requests. <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (rejects non-enterprise, missing capability, unknown paths, wrong methods and request bodies before activity RPC) -->
3. Webhook edge operations return fixed response shapes. <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (routes fixed operations with exact response shapes, no-store and no token reflection) -->
4. Webhook edge responses are non-cacheable. <!-- @impl: src/routes/operator-webhook.ts::response --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (routes fixed operations with exact response shapes, no-store and no token reflection) -->
5. Repeated webhook requests are throttled before activity execution. <!-- @impl: src/routes/operator-webhook.ts::throttle --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (throttles repeated webhook requests before activity RPC) -->

**Constraints:** Edge access grants no identity outside the presented capability.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-026](#req-operator-026-managed-webhook-edge-bypass)

**Verification:** Webhook edge behavior is covered by the adjacent route tests.

**Status:** Implemented

---

### REQ-OPERATOR-030: Immutable approved bundle validation

**Intent:** User execution accepts only the approved bounded Worker bundle without inheriting parent authority.

**Applies To:** User

**Acceptance Criteria:**

1. Bundle validation accepts at most 8 MiB whose exact bytes match the approved SHA-256. <!-- @impl: src/operators/distribution.ts::parseOperatorBundle --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-030: approved bundle boundary) -->
2. Version-1 bundles declare a main module, fixed supported compatibility settings and at most 128 JavaScript or text modules. <!-- @impl: src/operators/distribution.ts::parseOperatorBundle --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-030: approved bundle boundary) -->
3. Bundles require a declared JavaScript main module and canonical relative module names. <!-- @impl: src/operators/distribution.ts::parseOperatorBundle --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-030: approved bundle boundary) -->
4. Undeclared loader options, environment, bindings, script execution and inherited global outbound are rejected. <!-- @impl: src/operators/distribution.ts::parseOperatorBundle --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-030: approved bundle boundary) -->
5. The platform owns every capability and outbound configuration. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
6. Bundle parsing validates data without evaluating module source. <!-- @impl: src/operators/distribution.ts::parseOperatorBundle --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-030: approved bundle boundary) -->
7. Invalid, oversized or incompatible bundles return typed safe errors without source bytes or credentials. <!-- @impl: src/operators/distribution.ts::parseOperatorBundle --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-030: approved bundle boundary) -->

**Constraints:**

- Version 1 uses the platform's current Worker compatibility date and `nodejs_compat`.
- Static intent resources may be text modules.
- Validation does not execute the operator.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-010](#req-operator-010-bounded-operator-discovery-document)

**Verification:** Approved bundle validation is covered by the adjacent parser and Loader tests.

**Status:** Implemented

---

### REQ-OPERATOR-031: Non-consuming webhook observation

**Intent:** Users can observe pending webhook activity without consuming terminal result authority.

**Applies To:** User

**Acceptance Criteria:**

1. Status reads do not consume result authority. <!-- @impl: src/operators/activity.ts::getWebhookStatus --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->
2. A not-ready result read does not consume result authority. <!-- @impl: src/operators/activity.ts::redeemWebhookResult --> <!-- @test: src/__tests__/operators/activity-state.test.ts (issues a distinct read capability only to the single start winner and consumes one terminal redemption) -->

**Constraints:** Observation cannot extend execution or capability expiry.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-webhook-activity)

**Verification:** Non-consuming status and not-ready behavior is covered by the adjacent activity test.

**Status:** Implemented

---

### REQ-OPERATOR-032: Secret-safe administration readback

**Intent:** Administrators inspect operator state without recovering retained secrets or causing side effects.

**Applies To:** Admin

**Acceptance Criteria:**

1. Administrative readback exposes secret-presence flags instead of secret values. <!-- @impl: src/operators/registry.ts::getAdminDetail --> <!-- @test: web-ui/src/__tests__/components/OperatorsPage.test.tsx (REQ-OPERATOR-008: enterprise Operators administration) -->
2. A newly rotated plaintext key remains visible only until dismissal. <!-- @impl: web-ui/src/components/admin/OperatorsPage.tsx::OperatorsPage --> <!-- @test: web-ui/src/__tests__/components/OperatorsPage.test.tsx (REQ-OPERATOR-008: enterprise Operators administration) -->
3. Webhook-key rotation requires administrator confirmation. <!-- @impl: web-ui/src/components/admin/OperatorsPage.tsx::OperatorsPage --> <!-- @test: web-ui/src/__tests__/components/OperatorsPage.test.tsx (REQ-OPERATOR-008: enterprise Operators administration) -->
4. Operator detail reads perform neither discovery nor secret decryption. <!-- @impl: src/operators/registry.ts::getAdminDetail --> <!-- @test: web-ui/src/__tests__/api/operators.test.ts (REQ-OPERATOR-008: operator administration client) -->

**Constraints:** Readback never returns plaintext or ciphertext secrets.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-012](#req-operator-012-protected-operator-webhook-keys), [REQ-OPERATOR-013](#req-operator-013-enterprise-operator-administration-authorization)

**Verification:** Secret-safe readback and key interaction behavior are covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-033: Activity surface resilience

**Intent:** The owned-activity surface remains absent outside enterprise mode and usable across interaction states.

**Applies To:** User

**Acceptance Criteria:**

1. Non-enterprise mode renders no operator UI. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
2. Non-enterprise mode issues no operator data request. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
3. Keyboard and focus behavior remains usable. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
4. Stale, loading and error states remain distinguishable and recoverable. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
5. Account switching does not expose another owner's activity. <!-- @manual: documentation/lanes/operator-gate-1.md G1-07 and G1-23 -->
6. The activity surface remains usable on mobile. <!-- @manual: documentation/lanes/operator-gate-1.md G1-23 -->

**Constraints:** Visual acceptance does not substitute for owner-scoped API enforcement.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-027](#req-operator-027-owned-activity-user-surface)

**Verification:** Component behavior is automated; account-switch and mobile acceptance remain assigned to Gate 1.

**Status:** Implemented

---

### REQ-OPERATOR-034: Authenticated discovery transport

**Intent:** Administrators fetch discovery metadata through one bounded, independently authenticated transport.

**Applies To:** Admin

**Acceptance Criteria:**

1. Discovery sends the verified unexpired human assertion and separate connection secret in their designated headers. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorManifest --> <!-- @test: src/__tests__/operators/distribution-client.test.ts (REQ-OPERATOR-034: authenticated bounded discovery transport) -->
2. A validated endpoint and both independent credentials are required before I/O; the connection secret cannot replace human eligibility. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorManifest --> <!-- @test: src/__tests__/operators/distribution-client.test.ts (REQ-OPERATOR-034: authenticated bounded discovery transport) -->
3. Discovery uses manual redirects and accepts only HTTP 200 JSON. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorManifest --> <!-- @test: src/__tests__/operators/distribution-client.test.ts (REQ-OPERATOR-034: authenticated bounded discovery transport) -->
4. Discovery enforces the 64 KiB limit while streaming. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorManifest --> <!-- @test: src/__tests__/operators/distribution-client.test.ts (REQ-OPERATOR-034: authenticated bounded discovery transport) -->
5. The request deadline is at most 15 seconds and never exceeds human authority. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorManifest --> <!-- @test: src/__tests__/operators/distribution-client.test.ts (REQ-OPERATOR-034: authenticated bounded discovery transport) -->
6. Rejected bodies are cancelled and authority is rechecked after reading. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorManifest --> <!-- @test: src/__tests__/operators/distribution-client.test.ts (REQ-OPERATOR-034: authenticated bounded discovery transport) -->
7. Transport failures return safe errors without credential or network diagnostics. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorManifest --> <!-- @test: src/__tests__/operators/distribution-client.test.ts (REQ-OPERATOR-034: authenticated bounded discovery transport) -->

**Constraints:** Discovery transport grants no execution authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-001](#req-operator-001-verified-human-access-claims), [REQ-OPERATOR-002](#req-operator-002-enterprise-distribution-registration)

**Verification:** Authenticated bounded discovery transport is covered by the adjacent tests.

**Status:** Implemented

---

### REQ-OPERATOR-035: Approved artifact transport

**Intent:** User execution downloads only the approved artifact through the authenticated bounded transport.

**Applies To:** User

**Acceptance Criteria:**

1. Artifact download uses the same explicit human and connection authentication as discovery. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorBundle --> <!-- @test: src/__tests__/operators/artifact-download.test.ts (REQ-OPERATOR-035: authenticated approved artifact download) -->
2. Artifact download shares discovery's bounded transport deadline. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorBundle --> <!-- @test: src/__tests__/operators/artifact-download.test.ts (REQ-OPERATOR-035: authenticated approved artifact download) -->
3. Artifact download enforces an 8 MiB streaming limit. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorBundle --> <!-- @test: src/__tests__/operators/artifact-download.test.ts (REQ-OPERATOR-035: authenticated approved artifact download) -->
4. Exact received bytes must match the pinned approved digest before module data is returned. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorBundle --> <!-- @test: src/__tests__/operators/artifact-download.test.ts (REQ-OPERATOR-035: authenticated approved artifact download) -->
5. The derived artifact URL matches the approved canonical path and registered origin before credentials are sent. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorBundle --> <!-- @test: src/__tests__/operators/artifact-download.test.ts (REQ-OPERATOR-035: authenticated approved artifact download) -->
6. Redirect responses, login responses and expired authority are rejected. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorBundle --> <!-- @test: src/__tests__/operators/artifact-download.test.ts (REQ-OPERATOR-035: authenticated approved artifact download) -->
7. A newly discovered digest never replaces the approved digest. <!-- @impl: src/operators/distribution-client.ts::fetchOperatorBundle --> <!-- @test: src/__tests__/operators/artifact-download.test.ts (REQ-OPERATOR-035: authenticated approved artifact download) -->

**Constraints:** Download does not establish eligibility or execute module source.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-030](#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-034](#req-operator-034-authenticated-discovery-transport)

**Verification:** Authenticated approved artifact download is covered by the adjacent tests.

**Status:** Implemented
