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

1. Only enterprise administrators can register an HTTPS distribution URL and protected connection secret, discover metadata/interface compatibility, approve an immutable artifact and separately enable it. Secrets are encrypted server-side, redacted on readback, and never replace invoking-user Access eligibility. The protected-secret boundary reuses existing AES-256-GCM primitives with authenticated purpose/record context. Missing or invalid encryption keys, plaintext legacy values, wrong contexts and tampered ciphertext fail closed without exposing secret values or adopting the ordinary plaintext fallback. <!-- @test: src/__tests__/operators/protected-secrets.test.ts (REQ-OPERATOR-002: fail-closed protected secrets) -->
2. Versioned registration changes reject stale revisions. A SQLite-backed registry DO atomically orders enable/disable against idempotent activity admission receipts; the activity DO retains execution ownership. New records start disabled without an approved artifact; approval and enablement are separate revision-checked changes. Receipt creation records the activity/intent identity, approved artifact, registration revision and deadline. Concurrent identical admissions return the same receipt; changed intent/operator/revision/deadline under the same activity ID conflicts. Disable-first denies new admission; receipt-first permits reconciliation of that receipt without consulting the new enablement revision. Expired authority cannot admit or replay execution, but stored receipts remain readable for reconciliation. No transaction spans the registry and activity DOs. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-002: SQLite registration and admission ordering) -->
3. An optional randomly generated 256-bit per-operator webhook key is displayed once with repository/environment or selected-organization Actions-secret instructions under `CODEFLARE_OPERATOR_WEBHOOK_KEY`. Rotation does not retain old keys indefinitely. Codeflare's master encryption key is not distributed.
4. Non-enterprise operator routes are unavailable and ordinary human authentication, session quotas, routing and local review behavior are unchanged.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-001](#req-operator-001-verified-human-access-claims)

**Verification:** SQLite registry fixture RED at `7916f5b8`, CI 35127226112: 13 cases reached the unimplemented registry. Transactional ordering GREEN at `2154eca0`, CI 35127781945. Protected registration/policy data, route authorization, activity-side consume/queue and deployed allowed/denied acceptance remain outstanding.

**Status:** Planned

---

### REQ-OPERATOR-003: Principal-bound durable activity runtime

**Intent:** Approved private code executes with narrowly bound platform capabilities under valid user authority.

**Applies To:** User

**Acceptance Criteria:**

1. Protected activity-owned credential storage retains only the invoking human's verified authority; child inputs cannot select principal, bucket, policy or credential. Reauthentication requires the same owner. Expiry blocks new protected work and uploads.
2. Approved versioned artifact bytes are bounded, digest-checked and loaded through fresh `LOADER.load()` calls with explicit parent capabilities and outbound interception, never inherited unrestricted bindings/egress. The loader accepts validated bundle data and parent-owned service bindings, passes only the Operator Interface binding to children, and does not use isolate memory as durable state. A CI-only Wrangler fixture must demonstrate fresh loads, unspoofable parent-bound identity and controlled outbound allow/deny outcomes in workerd. This fixture is not deployed activity/DO acceptance. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-003: Worker Loader runtime boundary) -->
3. Activity DO state owns durable intent, operation IDs, bounded checkpoint/generation, progress, result and cleanup. Recovery reconciles known operations; unknown external effects are not automatically replayed. Stale drives cannot commit checkpoints or initiate work. Admission validates the verifier-backed start capability and its expiry before registry I/O, persists pending intent, and atomically consumes the capability with queued execution only after a matching registry receipt and a fresh authority/expiry check. Concurrent starts queue once. An uncertain registry response leaves pending intent unconsumed; retry reconciles the same activity receipt rather than creating new intent. Disable-first leaves the activity unqueued. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-003: activity admission consume and queue) -->
4. Cancellation/expiry stops only owned compute and records actual pending/failed/unknown cleanup without after-expiry final uploads. Overview reads use non-waking safe projections.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-registration-and-serialized-admission)

**Verification:** Worker Loader fixture RED at `b35285c9`, CI 35125373725: four behavioral cases reached the unimplemented loader in real local workerd. Loader GREEN at `60ca739a`, CI 35125886157. Activity consume/queue RED at `b21ae953`, CI 35128657132: seven cases reached the unimplemented activity boundary. Implementation at `96c0fac9` awaits GREEN in CI 35129016828. Full activity execution, protected context, checkpoints/cancellation and deployed acceptance remain required within this phase.

**Status:** Planned

---

### REQ-OPERATOR-004: Shared restrictive interception and JWT stamping

**Intent:** Direct operator calls and owned sessions enforce the same additional restrictions while preserving downstream enterprise authorization.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Trusted user/operator/activity context determines effective access: current user authority intersected with admitted operator restrictions. Denial precedes credential lookup/signing/forwarding. Denied specialized services cannot escape through generic egress.
2. Restricted interception is mandatory regardless of ordinary human strict-egress preferences. Approved inference/platform/storage access is distinct from general Internet permission; existing SWG transport remains intact.
3. Existing Security and egress settings support Off by default, exact/wildcard destinations and All for automatic HTTPS JWT stamping. Wildcards match subdomains, not the apex; redirects are independently authorized, spoofed assertions removed, specialized authorization preserved and All warns about bearer disclosure. Off does not disable explicit endpoint authentication.
4. R2 reads/listing/writes/multipart operations are server-bound to permitted owner/activity scope. Unsupported copy/deletion/control operations and writes to sealed operations are denied; managed-resource protections remain enforced.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](#req-operator-003-principal-bound-durable-activity-runtime)

**Verification:** Shared direct/container behavioral tests and deployed egress/R2/RP acceptance.

**Status:** Planned

---

### REQ-OPERATOR-005: Owned session, structured Pi and explicit persistence

**Intent:** Session readiness, Pi task completion, durable synchronization and shutdown are independently controllable and observable.

**Applies To:** User

**Acceptance Criteria:**

1. Reusable owned-session services compose existing quota/admission/start/readiness/stop behavior. Activity, Codeflare session, Pi conversation and task IDs remain distinct; cross-user and cross-activity operations fail.
2. The existing host manages one structured SDK conversation with stable operation IDs, prompt/follow-up/steer, bounded observation/output, approval-needed and cancellation. Retries reconcile; missing conversation or uncertain tool execution is not silently replaced/replayed. Ordinary PTYs and root execution are unchanged.
3. Operator startup restores only approved inputs/resources without broad credentials or a whole-home bisync baseline. Explicit scoped sync uses exact request/operation receipts, uploads no implicit deletes and verifies independently read R2 bytes before reporting durability. Fast completion, timeout and lost responses cannot produce false success.
4. Valid-authority stop drains explicitly; expiry blocks upload in both DO and PID1 paths, awaits owned SDK cancellation and reports unsynced output honestly. Operator/operator and operator/human overlap cannot corrupt unrelated state or stop another activity.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception-and-jwt-stamping)

**Verification:** Host/service behavioral tests; deployed file → explicit sync → independent R2 bytes → stop → fresh restoration proof and concurrency tests.

**Status:** Planned

---

### REQ-OPERATOR-006: Capability-authenticated Codeflare Webhook Endpoint

**Intent:** External consumers start a fixed activity and collect results without interactive Access login or independent execution identity.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Reserved versioned webhook routes accept POST start, non-consuming GET status and POST terminal-result redemption, authenticated by distinct random 256-bit verifier-backed capabilities. Scope is fixed before issuance; concurrent starts/results have one consumption winner. Status and not-ready reads do not consume the read token.
2. Start consumption durably queues accepted execution. Terminal failure/cancel/expiry/supersession has a bounded result envelope. A valid read token can collect produced results after user JWT expiry/operator disablement without extending execution. Lost terminal delivery stays consumed; dashboard retrieval is independent; no automatic reissue/rerun.
3. A configured optional operator webhook key encrypts handoff using AES-GCM and bound context; absent key permits the one-time token alone with a dispatch-visibility warning. Configured encryption failure never silently downgrades. Tokens/keys stay out of logs and candidate-controlled steps.
4. Administration Access setup/reconfiguration automatically manages a narrow higher-precedence bypass for `/operator-webhook/v1/activities/*`, following the existing SilverBullet bypass pattern. It reports provisioning failure, cleans incomplete newly created apps, preserves host-wide/SilverBullet protection and is idempotent. The Worker still rejects invalid capability/method/path and non-enterprise requests; use no-store responses and bounded throttling.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](#req-operator-003-principal-bound-durable-activity-runtime)

**Verification:** Concurrent capability/edge-provisioning behavioral tests and actual public-host callback acceptance in both handoff modes.

**Status:** Planned

---

### REQ-OPERATOR-007: Operator-aware inference selection

**Intent:** Operator defaults and restrictions reuse current provider eligibility rather than grant new inference access.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Resolve current eligible verified catalog, intersect registered allowed routes, then apply valid trusted invocation selection or registered defaults; user defaults are inherited only explicitly.
2. Unsupported/unauthorized operator route or reasoning fails without silent substitution. Child payload and lane/resource settings cannot override trusted selection; provider-default is distinct from Off.
3. Direct and Pi calls enforce identical effective selection and trusted activity attribution, preserving existing human fallback behavior.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception-and-jwt-stamping)

**Verification:** Behavioral catalog/interceptor tests and actual provider-request acceptance.

**Status:** Planned

---

### REQ-OPERATOR-008: Enterprise administration and activity surfaces

**Intent:** Users can observe and control owned activities without confusing execution, storage and collection outcomes.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Enterprise Administration exposes registration/discovery/approval/enablement, restrictive policies, route/reasoning, optional webhook-key instructions and managed Access-bypass status using existing responsive patterns.
2. The header operator icon immediately follows the user icon, retains zero-state access, counts working activities rather than lanes and uses desktop/tablet popover and mobile bottom sheet. Render bounded progress, exact source/session links, result and separate execution/cleanup/collection/attention states; unknown is not zero.
3. Authenticated account-scoped details/results/cancel and CSRF-protected browser summary → Start POST preserve ownership. GET is not effectful; browser closure neither loses valid activity progress nor extends authority.
4. Non-enterprise renders no operator UI and issues no operator data requests. Keyboard/focus, stale/loading/error, account-switch and mobile behavior remain usable.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-registration-and-serialized-admission), [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-codeflare-webhook-endpoint)

**Verification:** Behavioral component/route tests and deployed desktop/tablet/mobile acceptance.

**Status:** Planned

---

### REQ-OPERATOR-009: Reusable platform interfaces and bounded consumer fixtures

**Intent:** Later operator implementations consume tested Codeflare primitives without Phase 1 implementing private business workflows.

**Applies To:** User

**Acceptance Criteria:**

1. Touched services/interceptors expose typed reusable interfaces with adjacent ownership, trust, error, side-effect, retry/expiry and compatibility documentation. Shared behavior has one implementation; no fabricated route-header facade or general plugin framework.
2. Bounded opaque attachments, source/revision/run references and parent-bound session-origin admission reject spoofed identity, changed immutable inputs and recursive operator use of human admission. Fixture compatibility does not confer Review/history authority.
3. Minimal distribution/direct/session/webhook fixtures prove platform seams. Existing local-review resources remain unchanged; no private Flue core, operational Review hooks/enrollment/monitor/publisher or merge-gate activation ships in this phase.
4. Existing SDD and behavioral TDD govern all changes. Deployed enterprise and non-enterprise integration acceptance records versions and evidence separately from unit fixtures; no implementation completion claim replaces deployment proof.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-005](#req-operator-005-owned-session-structured-pi-and-explicit-persistence), [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-codeflare-webhook-endpoint)

**Verification:** Shared component/fixture tests, unchanged-resource regression evidence and recorded integration acceptance.

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

**Constraints:** Version 1 uses the platform's current Worker compatibility date and `nodejs_compat` flag; dependency/runtime upgrades are not implicit. Static intent resources can be text modules. Discovery and bundle validation alone do not establish invoking-user eligibility or execute an operator.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-registration-and-serialized-admission), [REQ-OPERATOR-003](#req-operator-003-principal-bound-durable-activity-runtime)

**Verification:** RED at `5b530c82`, CI 35121144349: 47 discovery/bundle behavioral cases fail against unimplemented boundaries. Parser GREEN at `798fccda`, CI 35122553530. Authenticated transport RED at `a745099a`, CI 35123769141: 26 failing behavioral cases against the unimplemented boundary. Transport GREEN at `d186e79f`, CI 35124293226. Deployed registration/Worker Loader acceptance remains outstanding. Interface reference: [Operators](../../documentation/lanes/operators.md).

**Status:** Planned
