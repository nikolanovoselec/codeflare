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

1. A reusable verifier returns subject, email, issuer, audiences, issued-at and expiry from a signed, valid human Access application token; it returns no raw credential. <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-OPERATOR-001: verified human Access context) -->
2. Missing/empty human subject or email, a non-application token, or service-token provenance is rejected even if the token otherwise passes existing email authentication. <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-OPERATOR-001: verified human Access context) -->
3. Invalid signature, issuer, audience, expiration, issued-at or not-before claims fail closed through the same cryptographic verification used by the existing email API. <!-- @test: src/__tests__/lib/jwt.test.ts (REQ-OPERATOR-001: verified human Access context) -->
4. Existing email verification and its callers retain their current accepted claim shape and results; stricter operator eligibility does not narrow ordinary authentication. <!-- @test: src/__tests__/lib/jwt.test.ts (JWT verification / REQ-AUTH-003 (CF Access JWT validation + JWKS caching)) -->

**Constraints:** No service/setup/session-token or caller email fallback for human-context execution. This verifier does not itself grant enterprise access, resolve buckets, renew tokens or admit an activity.

**Priority:** P0

**Dependencies:** [REQ-AUTH-003](authentication.md#req-auth-003-cf-access-mode-for-all-other-deployments)

**Verification:** Signed-token behavioral tests, followed by real enterprise Access admission acceptance.

**Status:** Planned

---

### REQ-OPERATOR-002: Enterprise registration and serialized admission

**Intent:** Administrators register private operators without changing non-enterprise behavior or granting user eligibility.

**Applies To:** Admin, User

**Acceptance Criteria:**

1. Only enterprise administrators can register an HTTPS distribution URL and protected connection secret, discover metadata/interface compatibility, approve an immutable artifact and separately enable it. Secrets are encrypted server-side, redacted on readback, and never replace invoking-user Access eligibility.
2. Versioned registration changes reject stale revisions. A registry DO atomically orders enable/disable against idempotent activity admission receipts; the activity DO retains execution ownership. Disable blocks new admission but does not cancel already-admitted work or collection.
3. An optional randomly generated 256-bit per-operator webhook key is displayed once with repository/environment or selected-organization Actions-secret instructions under `CODEFLARE_OPERATOR_WEBHOOK_KEY`. Rotation does not retain old keys indefinitely. Codeflare's master encryption key is not distributed.
4. Non-enterprise operator routes are unavailable and ordinary human authentication, session quotas, routing and local review behavior are unchanged.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-001](#req-operator-001-verified-human-access-claims)

**Verification:** Behavioral route/DO tests and deployed allowed/denied registration/admission tests.

**Status:** Planned

---

### REQ-OPERATOR-003: Principal-bound durable activity runtime

**Intent:** Approved private code executes with narrowly bound platform capabilities under valid user authority.

**Applies To:** User

**Acceptance Criteria:**

1. Protected activity-owned credential storage retains only the invoking human's verified authority; child inputs cannot select principal, bucket, policy or credential. Reauthentication requires the same owner. Expiry blocks new protected work and uploads.
2. Approved versioned artifact bytes are bounded, digest-checked and loaded through the Worker Loader with explicit parent capabilities and outbound interception, never inherited unrestricted bindings/egress.
3. Activity DO state owns durable intent, operation IDs, bounded checkpoint/generation, progress, result and cleanup. Recovery reconciles known operations; unknown external effects are not automatically replayed. Stale drives cannot commit checkpoints or initiate work.
4. Cancellation/expiry stops only owned compute and records actual pending/failed/unknown cleanup without after-expiry final uploads. Overview reads use non-waking safe projections.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-002](#req-operator-002-enterprise-registration-and-serialized-admission)

**Verification:** Runtime/DO behavioral tests and real Dynamic Worker lifecycle, recovery and isolation acceptance.

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
