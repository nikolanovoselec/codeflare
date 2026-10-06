<a id="operators"></a>
<a id="operator-registry"></a>
# Operators

<a id="domain-dependencies"></a>
Enterprise-only Operator identity, installation, admission, execution, confinement, persistence, webhook and user-surface contracts. This is the single owner of REQ-OPERATOR-001–075. Existing authentication, enterprise authorization, session admission/lifecycle, storage, setup and provider routing remain their own authorities: Operator restrictions can narrow but never extend those permissions. Root sessions and existing human/local-review behavior remain unchanged. Required merge-check activation remains out of scope.

**Domain owner:** Backend (Worker), container host and enterprise frontend

Codeflare owns the generic Worker/container platform, compiler, runtime, baked seed, Operator Interface and publication fences. Conductor owns Review packet, orchestration, result, history and publication policy; Dispatcher owns Renovate policy. Generic host-side Pi confinement remains Codeflare-owned. Managed content belongs to curation; non-default operational values and secrets belong to the private operator library. This consolidation changes no ABI, compiler pin, capability or acceptance status.

Requirement IDs, obligations and verification qualifications remain stable. Historical evidence is not current-head or deployment acceptance. The normative appendix owns the concrete shared registry contract; its schemas and capability wires are subordinate to the corresponding authorization and lifecycle requirements. Legacy record fragments remain explicit aliases in this canonical owner.

## Human identity, policy and protected authority

<a id="req-operator-001-verified-human-access-claims"></a>
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

<a id="req-operator-003-principal-bound-activity-context"></a>
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

<a id="req-operator-014-restrictive-operator-policy"></a>
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

<a id="req-operator-004-shared-restrictive-interception"></a>
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

<a id="req-operator-007-operator-aware-inference-selection"></a>
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

<a id="req-operator-019-automatic-human-access-jwt-stamping"></a>
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

<a id="req-operator-028-access-jwt-stamping-configuration"></a>
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

## Distribution, immutable packages and registry administration

<a id="req-operator-002-enterprise-distribution-registration"></a>
### REQ-OPERATOR-002: Enterprise distribution registration

**Intent:** Historical default-entrypoint distribution records remain protected internally; the test registration interface is retired in favor of installed releases.

**Applies To:** Admin

**Acceptance Criteria:**

1. Existing default-entrypoint distribution state retains validated HTTPS endpoint and protected connection-secret invariants. <!-- @impl: src/operators/registry.ts::setDistribution --> <!-- @impl: src/operators/protected-secrets.ts::sealOperatorSecret --> <!-- @impl: src/operators/protected-secrets.ts::openOperatorSecret --> <!-- @test: src/__tests__/operators/registry-distribution.test.ts (REQ-OPERATOR-002: protected distribution registration) -->
2. The legacy registration and discovery HTTP paths are unavailable even in Enterprise mode; new registrations use the managed release catalog. <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/index.test.ts (returns 404 for the retired legacy operator administration) -->
3. Existing internal approval still requires an explicit artifact digest and does not enable the record. <!-- @impl: src/operators/registry.ts::approve --> <!-- @test: src/__tests__/operators/registry-manifest.test.ts (REQ-OPERATOR-011: approved manifest snapshots) -->
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

**Verification:** Legacy internal distribution and protected-secret invariants are covered by the adjacent tests. The historical exact-head CI 35148669515 at `c9fd121d` predates retirement of the test HTTP surface.

**Status:** Implemented

---

<a id="req-operator-010-bounded-operator-discovery-document"></a>
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

**Verification:** Discovery and bundle parser behavior passed exact-head CI 35285707512 at `137ffcb5`; historical fixture registration does not prove current installed-release execution.

**Status:** Implemented

---

<a id="req-operator-030-immutable-approved-bundle-validation"></a>
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

<a id="req-operator-034-authenticated-discovery-transport"></a>
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

<a id="req-operator-035-approved-artifact-transport"></a>
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

---

<a id="req-operator-013-enterprise-operator-administration-authorization"></a>
### REQ-OPERATOR-013: Enterprise operator administration authorization

**Intent:** Only the Enterprise managed release catalog can mutate operator installations; the old test registration HTTP surface is gone.

**Applies To:** Admin

**Acceptance Criteria:**

1. The legacy operator administration HTTP route, including nested mutations, returns 404 even in Enterprise mode. <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/index.test.ts (returns 404 for the retired legacy operator administration) -->
2. Managed operator mutations require a verified current human and delegated management authorization. <!-- @impl: src/routes/operator-management.ts::managementContext --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
3. Service or mixed-principal authentication cannot grant managed operator administration. <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
4. Failed release discovery does not admit a release or enable an installation. <!-- @impl: src/operators/github-release-management.ts::acquireRelease --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
5. Managed mutations reject stale revisions without replaying mutations. <!-- @impl: src/operators/registry.ts::OperatorRegistry.promoteManagementInstallation --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->
6. Identity collisions cannot silently replace another managed operator. <!-- @impl: src/operators/registry.ts::OperatorRegistry.registerManagement --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
7. Retiring the test route leaves the ordinary API and installed management routes available. <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/index.test.ts (Edge-level setup redirect) --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->

**Constraints:** Administration grants neither user eligibility nor execution authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-001](#req-operator-001-verified-human-access-claims), [REQ-OPERATOR-002](#req-operator-002-enterprise-distribution-registration)

**Verification:** The retired route is absent in active Enterprise mode; management authorization and mutation tests remain separate.

**Status:** Implemented

---

<a id="req-operator-032-secret-safe-administration-readback"></a>
### REQ-OPERATOR-032: Secret-safe administration readback

**Intent:** Managed operator readback cannot recover stored acquisition secrets or perform side effects; the old key-rotation test UI is retired.

**Applies To:** Admin

**Acceptance Criteria:**

1. Managed release and installation readback project safe public metadata, not stored credentials. <!-- @impl: src/operators/registry.ts::managementProjection --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
2. The retired legacy HTTP endpoint cannot list connection secrets or rotate webhook keys. <!-- @impl: src/index.ts --> <!-- @test: src/__tests__/index.test.ts (returns 404 for the retired legacy operator administration) -->
3. The new management UI does not display acquisition credentials when listing operators. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
4. Existing internal default-entrypoint detail reads do not discover or decrypt secrets. <!-- @impl: src/operators/registry.ts::getAdminDetail --> <!-- @test: src/__tests__/operators/registry-distribution.test.ts (REQ-OPERATOR-002) -->

**Constraints:** Readback never returns plaintext or ciphertext secrets.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-012](#req-operator-012-protected-operator-webhook-keys), [REQ-OPERATOR-013](#req-operator-013-enterprise-operator-administration-authorization)

**Verification:** Management projections, retired-route denial, and internal default-entrypoint readback are covered by the adjacent tests.

**Status:** Implemented

---

<a id="req-operator-043-catalog-and-installations"></a>
### REQ-OPERATOR-043: Catalog and installations

**Intent:** Authorized users can discover only accessible operators and independently configured installations.

**Applies To:** User

**Acceptance Criteria:**

1. Operators, immutable releases and named installations have separate stable identities. <!-- @impl: src/operators/registry.ts::OperatorRegistry.registerManagement --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.replaceManagementReleases --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.createManagementInstallation --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
2. Catalog search and cursor pages are authorization-filtered before return, with a default page size of 50 and maximum of 100. <!-- @impl: src/routes/operator-management.ts::query --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.listManagementOperators --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
3. A release or configuration change in one installation does not change another installation. <!-- @impl: src/operators/registry.ts::OperatorRegistry.promoteManagementInstallation --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.configureManagementInstallation --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->

**Notes:** Implementation is present, but exact-head CI and deployed restore evidence are incomplete.

**Constraints:** Catalog and installation projections contain no stored source credential or hidden unauthorized count.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-030](#req-operator-030-immutable-approved-bundle-validation)

**Verification:** Adjacent catalog and package-resource tests cover the delivered behavior; exact-head CI and deployed restore evidence remain outstanding.

**Status:** Partial

---

<a id="req-operator-044-github-immutable-package-acquisition"></a>
### REQ-OPERATOR-044: GitHub immutable package acquisition

**Intent:** Codeflare installs only exact approved GitHub release assets.

**Applies To:** User

**Acceptance Criteria:**

1. Registration resolves a canonical GitHub repository identity and protects its acquisition-only PAT. <!-- @impl: src/operators/github-release-management.ts::registerGithubOperator --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
2. Promotion accepts bounded immutable assets only with matching repository, approved workflow provenance and digest. <!-- @impl: src/operators/github-release-management.ts::acquireRelease --> <!-- @impl: src/operators/github-release-management.ts::refreshGithubReleases --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
3. Unsafe URLs, redirects, unavailable bytes and provenance, digest or schema mismatches deny acquisition without exposing credentials or enabling releases. <!-- @impl: src/operators/github-release-management.ts::githubBytes --> <!-- @impl: src/operators/github-release-management.ts::acquireRelease --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
4. The shared package compiler deterministically emits the approved bundle schema, exact resource digests and sizes, and a matching discovery manifest. <!-- @impl: scripts/operator-package/compiler.mjs::compileOperatorPackage --> <!-- @test: src/__tests__/operators/operator-package-compiler.test.ts (shared operator package compiler) -->
5. The package compiler rejects unsafe paths and package-supplied authority rather than inferring policy or bindings. <!-- @impl: scripts/operator-package/compiler.mjs::compileOperatorPackage --> <!-- @test: src/__tests__/operators/operator-package-compiler.test.ts (shared operator package compiler) -->
6. Discovery retains the verified GitHub release tag and publication time for display. Re-discovery may enrich missing legacy display metadata only after comparing the immutable release identity; installed pins and enablement remain unchanged. <!-- @impl: src/operators/github-release-management.ts::acquireRelease --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.replaceManagementReleases --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (stores a canonical repository identity) --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (enriches a legacy retained release) -->

**Notes:** Evidence history and acceptance limitations remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Constraints:** Source credentials remain write-only; packages cannot grant capabilities.

- Release assets use the existing exact GitHub CDN allowlist; only authenticated API Actions artifact ZIP endpoints additionally accept the existing Azure blob-account host family (`[a-z0-9]{3,24}.blob.core.windows.net`).
- At most one uncredentialed HTTPS redirect is allowed; nondefault ports, userinfo, fragments, lookalikes and onward redirects remain denied.
- Artifact identity, deadline, bounded bytes and release/build digest equality remain mandatory; this clarification authorizes no additional origin.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-030](#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Existing acquisition, compiler and retention suites cover the baseline. Artifact-only host-family boundary regression coverage and final exact-head GREEN CI remain required; no new host is authorized by this prose correction, and live installation is a separate acceptance receipt.

**Status:** Planned

---

<a id="req-operator-045-delegated-management-and-invocation"></a>
### REQ-OPERATOR-045: Delegated management and invocation

**Intent:** Operator management and invocation have separately enforced access.

**Applies To:** User

**Acceptance Criteria:**

1. Platform-managed users and groups may manage only owned operators within the configured ceiling. <!-- @impl: src/lib/access.ts::canManageOperator --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.withinManagementCeiling --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
2. Invocation is a separate grant; managers do not gain another user's activities and invokers cannot mutate management state. <!-- @impl: src/lib/access.ts::canInvokeOperator --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.getOwnedActivity --> <!-- @impl: src/routes/operator-management.ts::managed --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
3. Live verified identity controls authorization; absent memberships grant no group authority, while malformed identity, revocation, expiry and resolver failures deny access. <!-- @impl: src/lib/access.ts::resolveOperatorGroupIdentity --> <!-- @impl: src/lib/access.ts::operatorAccessSessionCurrent --> <!-- @impl: src/routes/operator-management.ts::managementContext --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-045/047: current Access identity gates Dispatcher GET source receipts) -->
4. Identity choices contain configured users and currently verified issuer-bound groups, not unresolved labels or a full directory for non-admin managers. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @test: src/__tests__/operators/operator-access.test.ts (projects only verified configured identity options and authorized limits to eligible managers, not Access credentials) -->
5. Grant edits retain saved identities absent from current choices until deliberately removed. Unavailable choices disable saves; an explicit stale-state refresh reloads choices. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (keeps saved identities absent from this session’s choices through unrelated grant edits and allows deliberate removal) --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (disables permission saves when identity choices are unavailable) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (reloads configured identity choices during explicit stale-state reconciliation) -->
6. Scoped capability and Dispatcher budget edits require an exact revision; invalid values deny rather than clamp. Environment capability/source ceilings remain mandatory. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.setManagementCapabilities --> <!-- @test: src/__tests__/operators/operator-access.test.ts (edits operator capabilities within Environment limits and disables current runs without changing pins or installation restrictions) --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045: persists operator inference bytes with revision fencing and unchanged installation policy) --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045: operator inference maximum persists independently of installation source bytes) -->
7. A read-only invocation preview exposes only an authorized invoker's pinned package name, version and guided-form eligibility, without management access or Activity preparation. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (previews only an enabled, authorized pinned Renovate Dispatcher without creating an Activity or exposing credentials) -->

**Notes:** Evidence history and acceptance limitations remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Constraints:**

- Request bodies cannot grant global eligibility/execution identity.
- Missing memberships cannot authorize group-only grants.
- Bounded group labels preserve matching live human identity. <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (REQ-OPERATOR-045/027: valid %s admits explicit email managers and admins without exposing foreign activity) -->
- Labels cannot authorize issuer-bound stable-ID group grants. <!-- @impl: src/lib/access.ts::resolveOperatorGroupIdentity --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-045/047: label-only memberships %j preserve email invocation but cannot authorize a group-only source receipt) -->
- Verified platform admins bypass global/Operator management grants for catalog/detail reads. <!-- @impl: src/routes/operator-management.ts::scopedManager --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.listManagementOperators --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (REQ-OPERATOR-045: verified admin with %s reads ungranted catalog entries and management details; other managers and invalid admins cannot) -->
- Current Access binds `user_uuid` to verified subject despite extra `id`; legacy `id`-only remains supported. <!-- @impl: src/lib/access.ts::operatorAccessSessionCurrent --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (REQ-OPERATOR-045/027: canonical UUID with %s admits catalog and only the verified owner activity page) -->
- Foreign UUID or email denies catalog and owner-scoped activity access. <!-- @impl: src/lib/access.ts::operatorAccessSessionCurrent --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (REQ-OPERATOR-045/027: foreign %s denies both browser surfaces even for a platform admin) -->
- Human-context diagnostics: closed stage/reason labels, optional numeric HTTP status; exclude credentials/claims/identifiers/bodies/URLs/exception-text. <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (REQ-OPERATOR-045: denied live identity reports only closed diagnostic outcomes, never credentials or identity data) --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (REQ-OPERATOR-045: distinguishes missing credential/configuration, invalid JWT and mismatched verified principal without revealing them) -->
- Public human-context denials remain generic. <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (REQ-OPERATOR-045: distinguishes missing credential/configuration, invalid JWT and mismatched verified principal without revealing them) -->

- Absent `sourceResponseBytes`: 1048576; installation ≤ operator ≤ Environment; no inheritance/clamp.
- Dispatcher `inferenceRequestBytes`: operator-only, default 1048576, positive safe integer. <!-- @impl: src/operators/dispatcher-inference-limits.ts::inferenceRequestBytes --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.setManagementCapabilities -->
- Dispatcher `operationLimit`: operator-only, default 1024, positive safe integer. <!-- @impl: src/operators/dispatcher-operation-limits.ts::dispatcherOperationLimit --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.setManagementCapabilities --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045: persists operator operation limit with revision fencing and unchanged installation policy) -->
- Omitted budget edits preserve saved values. <!-- @impl: src/operators/registry.ts::OperatorRegistry.setManagementCapabilities --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045: operator inference bytes default without being added on an unrelated save) -->
- Budget no-ops retain revisions/enablement. <!-- @impl: src/operators/registry.ts::OperatorRegistry.setManagementCapabilities --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045: persists operator inference bytes with revision fencing and unchanged installation policy) -->
- Originally admitted policy selects inference bytes and operation capacity. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047: admitted operator inference bytes forward %i-byte content without child authority) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047: operator inference bytes enforce exact UTF-8 request boundaries) -->
- Edits disable installations, preserving pins/scope/grants/policies; out-of-ceiling policies cannot enable/admit.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-013](#req-operator-013-enterprise-operator-administration-authorization), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Access/management and real identity/source regression passed host CI; live sourceHTTP200 was observed in47aa5357. Configurable response-ceiling tests and complete live acceptance remain pending.

**Status:** Implemented

---

<a id="req-operator-046-explicit-release-promotion"></a>
### REQ-OPERATOR-046: Explicit release promotion

**Intent:** Discovery, approval, enablement and rollback are separate revision-safe operations.

**Applies To:** User

**Acceptance Criteria:**

1. Discovery never approves or enables, and approval never enables. <!-- @impl: src/operators/registry.ts::OperatorRegistry.replaceManagementReleases --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.promoteManagementInstallation --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->
2. Mutations require the current revision and persist exact approved release and configuration bytes. <!-- @impl: src/operators/registry.ts::OperatorRegistry.promoteManagementInstallation --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.configureManagementInstallation --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->
3. A source or trust change disables subsequent starts, and a retained approved release can be selected for rollback. <!-- @impl: src/operators/registry.ts::OperatorRegistry.setManagementSource --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.promoteManagementInstallation --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

**Constraints:** Promotion never expands installation policy or caller authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-044](#req-operator-044-github-immutable-package-acquisition)

**Verification:** Adjacent promotion tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

## Admission, runtime and durable execution

<a id="req-operator-011-serialized-operator-admission"></a>
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

<a id="req-operator-015-isolated-approved-worker-loading"></a>
### REQ-OPERATOR-015: Isolated approved Worker loading

**Intent:** Every execution loads approved code inside a bounded parent-controlled runtime.

**Applies To:** User

**Acceptance Criteria:**

1. Each execution freshly loads the bounded, digest-matched approved artifact. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
2. The loaded Worker receives only parent-provided Operator Interface capabilities and intercepted outbound access. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
3. Child code inherits neither unrestricted bindings nor durable isolate state. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
4. Native-runtime fixtures prove parent-bound identity and outbound allow/deny behavior, but do not count as deployment acceptance. <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->

**Constraints:** Child code receives no unrestricted binding or inherited outbound access. Default-entrypoint rules remain deny-by-default; [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution) owns the bounded Dispatcher extension.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](#req-operator-003-principal-bound-activity-context), [REQ-OPERATOR-030](#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-035](#req-operator-035-approved-artifact-transport)

**Verification:** Worker Loader runtime-boundary behavior is covered by the adjacent tests. Deployed acceptance remains unverified.

**Status:** Implemented

---

<a id="req-operator-016-durable-activity-admission-and-cleanup"></a>
### REQ-OPERATOR-016: Durable activity admission and cleanup

**Intent:** Durable state serializes activity admission and reports owned cleanup honestly.

**Applies To:** User

**Acceptance Criteria:**

1. Durable activity state owns intent, operation IDs, progress, result and cleanup. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
2. Admission persists private pending intent before registry reconciliation; prepared state is not published as queued. <!-- @impl: src/operators/activity.ts::prepareAuthorized --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
3. Admission consumes start authority only after a matching receipt and fresh expiry check. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
4. Concurrent starts queue once, and uncertain responses reconcile against the same receipt. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
5. Disable-first admission remains unqueued, and unknown effects are never replayed automatically. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-016: activity admission consume and queue) -->
6. Cancellation or expiry stops only owned compute and records actual pending, failed or unknown cleanup without final uploads after expiry. <!-- @impl: src/operators/activity.ts::cancelDrive --> <!-- @manual: Verify owned compute stops, cleanup receipts and no post-expiry uploads on an authorized fresh activity; a cancellation fence alone is insufficient. -->
7. Overview reads use non-waking safe projections. <!-- @impl: src/operators/registry.ts::listOwnedActivities --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->

**Constraints:** Unknown external effects are fenced rather than replayed.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-011](#req-operator-011-serialized-operator-admission), [REQ-OPERATOR-003](#req-operator-003-principal-bound-activity-context)

**Verification:** Activity admission behavior is covered by the adjacent tests. Physical owned-compute cessation, cleanup and post-expiry uploads remain unverified; no unknown activity is replayed for this check.

**Status:** Planned

---

<a id="req-operator-017-durable-drive-generations"></a>
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

**Constraints:** Generation transitions do not extend human authority. [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution) reuses this generation authority without treating admission or status reads as renewal.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-016](#req-operator-016-durable-activity-admission-and-cleanup)

**Verification:** Durable drive generation and checkpoint behavior is covered by the adjacent tests.

**Status:** Implemented

---

<a id="req-operator-018-request-attached-operator-orchestration"></a>
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

**Constraints:** Runtime deadlines never exceed verified human authority. Supported direct work remains request-attached; [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution) owns asynchronous Dispatcher execution.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-015](#req-operator-015-isolated-approved-worker-loading), [REQ-OPERATOR-017](#req-operator-017-durable-drive-generations)

**Verification:** Runtime-driver and request-attached orchestration behavior is covered by the adjacent tests. Legacy Gate 1 preparation and already-prepared execution are denied by separate retirement tests; deployment readback remains a separate release gate.

**Status:** Implemented

---

<a id="req-operator-039-retired-gate-1-fixture"></a>
### REQ-OPERATOR-039: Retired Gate 1 fixture

**Intent:** The obsolete Gate 1 fixture cannot admit or execute new work, and deployment never reinstalls it.

**Applies To:** Admin

**Acceptance Criteria:**

1. New fixture admission fails before Registry or Activity I/O. <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018: request-attached production orchestration) -->
2. An already-prepared fixture receipt receives a denied capability without creating an owned session. <!-- @impl: src/operators/operator-runtime-capability.ts::OperatorRuntimeCapability --> <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-018: retired Gate 1 execution) -->
3. Enterprise deployment does not dispatch the retired fixture. <!-- @impl: .github/workflows/deploy.yml --> <!-- @test: host/__tests__/deploy-requires-tests.test.js (never dispatches the retired Gate 1 fixture with an Enterprise deploy) -->

**Constraints:** Historical records are not deleted; installed Conductor and Dispatcher stay available.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-018](#req-operator-018-request-attached-operator-orchestration)

**Verification:** Behavioral admission, already-prepared execution and deploy-graph tests cover retirement; exact-head CI and Enterprise Integration rollout remain release gates.

**Status:** Implemented

---

<a id="req-operator-047-generic-directed-profile-admission"></a>
### REQ-OPERATOR-047: Generic directed profile admission

**Intent:** Installed profiles run only under the parent-selected human, resource scope and current activity authority.

**Applies To:** User

**Acceptance Criteria:**

1. The parent normalizes admitted input and resources; caller-supplied authority, code, profiles or connections cannot widen eligibility. <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
2. Generation, expiry, cancellation and installation policy gate every protected effect. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Protected operations recheck the current human and pinned installation/release revisions through parent interceptors; captured identity and workflow claims cannot substitute. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-045/047: current Access identity gates Dispatcher GET source receipts) -->
4. Identical operations reconcile; changed immutable arguments conflict; uncertain effects cannot replay or settle successfully. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
5. Completed output is bounded and durable before delivery; unknown completion remains fenced. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
6. Independent task sessions receive finite parent-approved input references and resources without shared principal authority or credentials. <!-- @impl: src/operators/session-initialization.ts::parseOperatorPiInitialization --> <!-- @impl: host/src/operator-pi-isolated.ts::createIsolatedPiTools --> <!-- @impl: host/src/operator-pi-isolated-runner.ts::runApprovedTasks --> <!-- @test: src/__tests__/operators/session-initialization.test.ts (REQ-OPERATOR-021: finite parent-approved Pi initialization) --> <!-- @test: host/__tests__/operator-pi-review.test.js (REQ-OPERATOR-021: Review composition exposes only fixed sandboxed read and write tools) --> <!-- @test: host/__tests__/operator-pi-isolated.test.js (REQ-OPERATOR-021: each SDK child sees only its declared inputs and can stage one immutable bounded output) --> <!-- @test: host/__tests__/operator-pi-isolated-runner.test.js (REQ-OPERATOR-021: one structured task creates independently isolated SDK sessions and durable identities) -->

**Notes:** Evidence history and acceptance limitations remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Constraints:** Profile admission can only narrow verified human authority. Original operator policy supplies finite journal capacity, default1024; distinct reservations consume entries, completed retries reuse them, and receipt/resolution calls consume none. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047: default 1024 journal counts distinct reads and inference while cached operations reuse slots) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047: admitted %i-operation budget denies fresh work at its exact boundary) -->

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](#req-operator-003-principal-bound-activity-context), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Prior admission/production-composition and real Access-helper/source tests passed CI36852325679attempt2 at51f976d3. Configurable source allowance and larger real journal/cache/native proof await this correction's integrated CI. Live settlement/collection, authenticated selected effects, SDK release and physical cleanup remain separate unverified gates.

**Status:** Implemented

---

<a id="req-operator-048-dispatcher-execution"></a>
### REQ-OPERATOR-048: Dispatcher execution

**Intent:** Dispatcher runs directed work under bounded Dynamic Worker authority without a session or container.

**Applies To:** User

**Acceptance Criteria:**

1. The delegated Loader executes only the pinned generated Flue artifact. <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
2. One durable lease retains its original generation, submission, input, release and human expiry; uncertain admission cannot create replacement work. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Pending settlement keeps at most one bounded recheck under the original lease; observation and repeated alarms cannot renew authority. <!-- @impl: src/operators/runtime.ts::driveDispatcherRuntime --> <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: repeated SDK alarms retain one pending recheck and the original deadline) -->
4. Only the exact completed settlement with one bounded assessment and no unresolved operation permits terminal collection; collection does not resubmit. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (fences a completed model turn with no submitted assessment instead of advertising waiting) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (completes a publishable second-turn assessment only after all parallel research receipts are released) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (settles a cited second-turn assessment after the former child timeout without extending human authority) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: terminal diagnostic wire distinguishes) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: unassociated assessment) -->
5. Cancellation, expiry, revocation and stale warmed callers deny protected work. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
6. Dispatcher capabilities include only approved parent transport, inference, scheduling and non-authorizing diagnostics; sessions, containers, credentials and direct networking remain unavailable. <!-- @impl: src/operators/distribution.ts::parseDispatcherBundle --> <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @impl: src/operators/activity.ts::OperatorDispatcherCapability --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-048: production Dispatcher bundle boundary) --> <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048: production Dispatcher Loader host) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
7. Existing Activity identity, storage, Gate 1 and default-entrypoint compatibility remain preserved. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018) -->

**Notes:** Evidence history and acceptance limitations remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Constraints:** Uncertain external effects are fenced, not replayed; execution cannot outlive verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-015](#req-operator-015-isolated-approved-worker-loading), [REQ-OPERATOR-017](#req-operator-017-durable-drive-generations), [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission)

**Verification:** Production-composition tests are instrumented rather than native. The existing native Loader fixture proves generated-artifact compatibility, not production eviction and alarm composition; exact-head CI and that native composition proof remain outstanding.

**Status:** Planned

---

<a id="req-operator-062-repository-only-dispatcher-transport"></a>
### REQ-OPERATOR-062: Repository-only Dispatcher transport

**Intent:** Bounded package-selected transport reuses existing parent authority.

**Applies To:** User

**Acceptance Criteria:**

1. Approved repository-only packages select bounded GET/POST/PUT requests with immutable arguments. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (exposes the configured API origin only to repository-only Loader code) -->
2. Unknown mutations retain generation for authorized readbacks; only verified original-request and completed-read receipts may resolve uncertainty without replay. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047: generic Activity mutation receipts and resolution) -->
3. Loader supplies validated non-secret origins, response limits and an optional immutable admitted-target restriction; package settings cannot widen host policy or disclose credentials. <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @impl: src/operators/dispatcher-source-limits.ts::sourceResponseBytes --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (exposes the configured API origin only to repository-only Loader code) --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-047: rejects a 100 KiB source under an explicitly saved 64 KiB allowance) --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-047: returns the exact large source envelope under approved 128 KiB) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (authorizes repository-only work and projects one closed nonsecret target into the actual Loader, identically after reconstruction) -->
4. Mutations use only the configured authenticated GitHub API transport. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (exposes the configured API origin only to repository-only Loader code) -->

**Constraints:**

- Existing parent authority and original deadlines remain mandatory; no activation or new principal is implied.
- Detailed preserved wire and fencing clauses remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission)

**Verification:** Automated test: [dispatcher-production.test.ts](../../src/__tests__/operators/dispatcher-production.test.ts), [dispatcher-source-identity.test.ts](../../src/__tests__/operators/dispatcher-source-identity.test.ts).

**Status:** Implemented

---

<a id="req-operator-063-bounded-dispatcher-diagnostics"></a>
### REQ-OPERATOR-063: Bounded Dispatcher diagnostics

**Intent:** Diagnostics explain observed rejection boundaries without becoming authority.

**Applies To:** User

**Acceptance Criteria:**

1. Parent rejection diagnostics distinguish local fencing from observed upstream status without logging credentials, prompts, bodies or arbitrary child values. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048: emits bounded) -->
2. Failed settlement telemetry uses trusted Activity/generation and recognized fixed operation classes; foreign or malformed submission labels remain unknown. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: diagnoses) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (REQ-OPERATOR-048: failed compiled durable direct submission carries its bounded Flue operation label) -->
3. Tail delivery accepts only allowlisted bounded child diagnostics and never establishes settlement, replay authority or a prior failure cause. <!-- @impl: src/operators/activity.ts::OperatorDispatcherTail --> <!-- @test: src/__tests__/operators/dispatcher-tail.test.ts (forwards only fixed warning codes with trusted Activity correlation) --> <!-- @test: src/__tests__/operators/dispatcher-tail.test.ts (drops arbitrary child logs, exceptions, extra fields and sensitive body text) --> <!-- @test: src/__tests__/operators/dispatcher-tail.test.ts (bounds work and forwarding even when a child floods valid-looking events) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (captures only sanitized child warnings through an actual Loader Tail Worker) -->
4. The Dispatcher-only diagnostic operation validates exact request shape, size and deadline, correlates trusted identity and rate-limits reports. <!-- @impl: src/operators/activity.ts::readDispatcherDiagnostic --> <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherDiagnosticReport --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report denies wrong route, method, content-type, syntax, byte size and stale generation) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report refuses an unfinished body without holding the Activity) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report caps concurrent valid reports at eight per live Activity generation) -->
5. Diagnostic transport failure is bounded and best-effort; reports cannot renew authority, mutate lifecycle, publish results or replace the original inference failure. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherDiagnosticReport --> <!-- @impl: src/operators/activity.ts::OperatorDispatcherCapability --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report uses trusted Activity/generation and leaves execution running) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report tolerates unavailable owner logging without publishing a result) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: preparation logging outage preserves denial and later authorized work) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report never extends its original human deadline) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (REQ-OPERATOR-048: compiled diagnostic report) -->
6. Pre-reservation parsing/capability failures report fixed categories, bounded validation-rule labels and parent-owned Activity/generation without logging credentials, prompts, bodies, arbitrary child values or exception text. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: preparation rejection $name preserves denial and private diagnostic wire) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: identifies $name without exposing rejected data or changing authority) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: bounds multiple rejected rules without retaining arbitrary issue paths or values) -->

7. Terminal settlement diagnostics distinguish observed completion-tool outcomes from assessment projection using trusted Activity/generation and bounded counters. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: terminal diagnostic wire) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: observes completion) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (REQ-OPERATOR-048: authentic pinned SDK inference producer compatibility) -->

**Constraints:**

- Original parent authority and deadlines remain mandatory; no activation or new principal.
- Preserved wire/fencing details: [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).
- Completion: ≤32 correlations, ≤256 characters each; reset preserves observed outcomes and foreign messages cannot spend the requested budget. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: caps completion observations) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: later compaction) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: foreign reset calls cannot hide requested completion) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: reset completion cap remains shared across requested messages) -->
- Terminal logging: best-effort, no tool/model/assessment content or opaque identifiers; collection authority unchanged. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: unavailable terminal diagnostic logging) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: unassociated assessment) -->
- Schema diagnostics: ≤4 unique closed rule labels plus truncation; no raw validation issues/arbitrary field names.
- Reservation denials distinguish lease-mismatch/operation-limit using transaction-observed lease and parent-owned Activity/generation. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: reservation diagnostic wire reports) -->
- Exhaustion: journal count/configured operation limit; existing receipt/conflict/unknown-effect-resolution admission order preserved. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047: full Dispatcher journal preserves receipts cached retries conflicts and unknown-mutation resolution) -->
- Reservation logging outages preserve generic403/lifecycle/original authority, including owner transport. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: owner reservation logging outage preserves) -->
- Producer readiness observations follow [REQ-OPERATOR-077](#req-operator-077-bounded-producer-readiness-diagnostics).
- Exclude bodies, assessment values, prompts, tool inputs/outputs, raw errors, credentials and opaque identifiers; never assessment/settlement authority.
- Diagnostic data excluded from existing projected-result accounting; page/record/result/source bounds unchanged; operation capacity follows admitted policy.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution)

**Verification:** Automated test: [dispatcher-production.test.ts](../../src/__tests__/operators/dispatcher-production.test.ts), [flue-native-cases.ts](../../src/__tests__/operators/fixtures/flue-native-cases.ts), [dispatcher-native.test.ts](../../src/__tests__/operators/dispatcher-native.test.ts), [dispatcher-tail.test.ts](../../src/__tests__/operators/dispatcher-tail.test.ts).

**Status:** Implemented

---

### REQ-OPERATOR-077: Bounded producer readiness diagnostics

**Intent:** Explain observed producer readiness without changing result authority.

**Applies To:** User

**Acceptance Criteria:**

1. Exact-submission producer readiness observations appear as bounded, non-authorizing flags, counts and fixed categories in the existing trusted terminal diagnostic. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: readiness.v1 projects an exact producer snapshot without granting assessment authority) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: readiness.v1 terminal wire exposes trusted closed %s metadata without accepting a missing assessment) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: invalid readiness.v1 terminal wire cannot expose content or block validated collection) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: readiness.v1 logging outage preserves actual result and SDK release) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (REQ-OPERATOR-063: authentic failed finish emits undiscovered readiness but no assessment or effects) -->

**Constraints:**

- Allowlist: discovered/sealed booleans, target/decision/result/unknown-operation nonnegative safe-integer counts, ready/undiscovered/unknown-operation/incomplete-results/schema/oversized/emission categories.
- ≤512 encoded bytes/32 observations; latest-valid exact-submission metadata survives compaction; replayed positions deduplicated. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: readiness.v1 caps observation work at32 without consuming result allowance) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: readiness.v1 survives compaction which omits earlier producer metadata) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: readiness.v1 replay cannot consume the observation allowance twice) -->
- Malformed/excessive metadata only truncates diagnostics; foreign records cannot affect requested observations or otherwise-valid assessment/collection/SDK release. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: invalid readiness.v1 %s cannot retain content or deny a valid assessment) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: foreign readiness.v1 records cannot create metadata or truncate exact metadata) -->
- Original authority, deadlines and page/record/result/operation/source bounds remain mandatory; diagnostic data is excluded from projected-result accounting.
- No bodies, assessments, prompts, tool content, raw errors, credentials or opaque identifiers; logging remains best-effort and never result/settlement authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution)

**Verification:** Named projection/production/native tests above.

**Status:** Implemented

---

### REQ-OPERATOR-076: Bounded seal preflight diagnostics

**Intent:** Explain observed producer seal branches without changing result authority or lifecycle outcomes.

**Applies To:** User

**Acceptance Criteria:**

1. Exact-submission seal observations retain only the [closed preflight fields](../../documentation/lanes/operators.md#non-authorizing-dispatcher-diagnostics). <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 projects exact %s metadata without assessment authority) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 %s retains unknown counts as null not fabricated zero) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 exact reset association survives %s member order) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: foreign seal-preflight.v1 cannot consume exact observations or alter validated assessment) -->
2. Advancing updates retain the latest valid seal observation. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 keeps latest valid metadata across pages and replay without result accounting) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 survives reset omission of earlier metadata) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 retains latest valid observation when later metadata is invalid) -->
3. Replayed update positions cannot duplicate seal observations. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 keeps latest valid metadata across pages and replay without result accounting) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: distinct seal records count across resets while replayed positions do not) -->
4. Invalid seal metadata only marks diagnostic truncation. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: invalid seal-preflight.v1 %s cannot retain content or deny actual assessment) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 data-before-name overflow truncates only diagnostic work) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 never relaxes oversized actual assessment denial) -->
5. Seal observations have a separate admission cap from readiness metadata and result accounting. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal-preflight.v1 limits32 observations separately from valid assessment and readiness) -->
6. Trusted terminal diagnostics report bounded seal fields without granting result authority. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-076: seal-preflight.v1 trusted terminal %s metadata cannot authorize missing assessment) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-076: invalid seal-preflight.v1 cannot expose private content or block validated collection) -->
7. Authorized collection remains available through diagnostic logger failure. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-076: seal-preflight.v1 logger outage preserves actual collection and SDK release) -->

**Constraints:**

- Separate `dispatcher-seal-preflight` channel; original readiness fields/categories and result authority unchanged.
- Exactly category, targetCount, decisionCount, operationCount, operationLimit, requiredOperationCount and sealed; closed categories and count bounds follow the linked contract. <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-076: seal metadata accepts configured %i capacity without granting assessment authority) -->
- At most512 encoded bytes/value and32 exact-submission observations; invalid/excess metadata only truncates diagnostics.
- Diagnostic data is excluded from existing result-record accounting; page/record/result/source/operation bounds and authorization/revision/generation/deadline fences remain unchanged.
- No prompts, bodies, assessment values, tool payloads, raw errors, credentials or opaque identifiers; foreign records never affect exact observations.
- Best-effort terminal logging leaves collection and SDK release unchanged; missing metadata proves neither skipped sealing nor a historical cause.
- Ready sealing is not effects, finish, validated result, collection or cleanup; nullable producer counts are observations, never capacity reservations.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-063](#req-operator-063-bounded-dispatcher-diagnostics).

**Verification:** Named projection/production tests above; authentic generated SDK emission uses [flue-native-cases.ts](../../src/__tests__/operators/fixtures/flue-native-cases.ts). <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (REQ-OPERATOR-076: authentic SDK emits seal observations across refused, ordinary, overflow and retry journeys) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (REQ-OPERATOR-076: authentic failed seal emits closed undiscovered preflight without effects or assessment) --> Hosted RED closure37432344160 verified missing diagnostics; hosted GREEN, official artifact identity/release/installation, live effects, validated collection, SDK release and cleanup are separate gates.

**Status:** Implemented

---

## Owned sessions, inert inputs and explicit persistence

<a id="req-operator-005-owned-operator-session-lifecycle"></a>
### REQ-OPERATOR-005: Owned operator session lifecycle

**Intent:** Session identity, ownership and authority remain durable and independently controllable.

**Applies To:** User

**Acceptance Criteria:**

1. Owned-session services preserve distinct activity, Codeflare session, Pi conversation and task identities. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) -->
2. Session ownership and restrictions persist before startup. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/operators/activity.ts::saveOwnedSession --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-003: instrumented activity state outcomes) -->
3. Lost startup responses reconcile against the same reservation, while uncertain configuration remains uncertain. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/operators/owned-session-runtime.ts::ContainerOwnedSessionRuntime --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) --> <!-- @test: src/__tests__/operators/owned-session-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->
4. Stop affects only the owned session. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/container/index.ts::stopOperatorSession --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) --> <!-- @test: src/__tests__/operators/owned-session-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->
5. Wake restores restrictions but requires same-human authority rebind. <!-- @impl: src/container/operator-context.ts --> <!-- @test: src/__tests__/container/operator-context.test.ts (operator container context) -->
6. Operator/operator and operator/human overlap cannot corrupt unrelated state or stop another activity. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @test: src/__tests__/operators/owned-session.test.ts (owned operator session service) -->
7. Before startup, the parent programmatically reconciles the verified human's bucket and passes fresh bucket-scoped credentials plus the applied managed-resource identity to the owned container. <!-- @impl: src/operators/session-bootstrap.ts::bootstrapOperatorSession --> <!-- @impl: src/operators/owned-session-runtime.ts::ContainerOwnedSessionRuntime --> <!-- @test: src/__tests__/operators/session-bootstrap.test.ts (REQ-OPERATOR-005: programmatic operator session bootstrap) --> <!-- @test: src/__tests__/operators/owned-session-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->

**Constraints:** Non-operator sessions remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-004](#req-operator-004-shared-restrictive-interception)

**Verification:** Owned-session and container-context behavior is covered by the adjacent tests. Deployed stop and concurrency acceptance remain unverified.

**Status:** Implemented

---

<a id="req-operator-021-structured-owned-pi-conversation"></a>
### REQ-OPERATOR-021: Structured owned Pi conversation

**Intent:** The host exposes one bounded, durable Pi SDK conversation per owned session.

**Applies To:** User

**Acceptance Criteria:**

1. The host manages one owned structured SDK conversation with stable operation IDs. <!-- @impl: host/src/operator-pi.ts::OperatorPiConversation --> <!-- @impl: host/src/operator-pi-sdk.ts::createProvisionedOperatorPiFactory --> <!-- @test: host/__tests__/operator-pi.test.js (REQ-OPERATOR-021: creates once, persists exact identity and reopens only the recorded file) -->
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

<a id="req-operator-022-restricted-operator-container-lifecycle"></a>
### REQ-OPERATOR-022: Restricted operator container lifecycle

**Intent:** Restricted containers avoid ordinary persistence paths during startup and shutdown.

**Applies To:** User

**Acceptance Criteria:**

1. Restricted startup restores only approved inputs. <!-- @impl: entrypoint.sh::run_operator_startup --> <!-- @test: host/__tests__/entrypoint-operator-startup.test.js (REQ-OPERATOR-022: operator startup selects only restricted initialization) -->
2. Restricted startup never enters ordinary whole-home restore, bisync or baseline-daemon paths. <!-- @impl: entrypoint.sh::run_operator_startup --> <!-- @test: host/__tests__/entrypoint-operator-startup.test.js (REQ-OPERATOR-022: operator startup selects only restricted initialization) -->
3. Restricted shutdown may drain an accepted explicit upload but never starts bisync. <!-- @impl: entrypoint.sh::drain_operator_sync_shutdown --> <!-- @impl: src/container/index.ts::stopOperatorSession --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPERATOR-022: restricted shutdown drains only accepted explicit upload and never starts bisync) --> <!-- @test: src/__tests__/operators/owned-session-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->
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

<a id="req-operator-020-operator-scoped-r2-interception"></a>
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

<a id="req-operator-023-explicit-operator-synchronization"></a>
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

<a id="req-operator-024-independent-synchronization-verification"></a>
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

<a id="req-operator-050-generic-conductor-capability"></a>
### REQ-OPERATOR-050: Generic Conductor capability

**Intent:** Any admitted Conductor package can use a profile-neutral owned session without receiving parent authority.

**Applies To:** User

**Acceptance Criteria:**

1. The parent binds the Conductor to the exact activity generation, installation revisions, human expiry and cancellation state before every protected effect except cleanup-only stopping of its already-owned session; revocation never grants new work. <!-- @impl: src/operators/conductor-capability.ts::OperatorConductorCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->
2. The parent selects and owns the restricted session profile, bucket and fixed attachment destination; package input cannot replace them. <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->
3. Before Conductor work, the parent restores only immutable attachment bytes bound to the admitted digest and size, including any claimed packets. Changed or undeclared bytes cannot enter the reviewer session. <!-- @impl: src/operators/attachments.ts::projectOperatorAttachments --> <!-- @impl: src/operators/attachments.ts::persistApprovedPacketAttachment --> <!-- @impl: src/operators/activity.ts::OperatorActivity.saveApprovedPacketAttachment --> <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @impl: scripts/restore-operator-attachments.mjs::restoreOperatorAttachments --> <!-- @test: src/__tests__/operators/attachments.test.ts (operator opaque attachment ownership) --> <!-- @test: src/__tests__/operators/approved-packet-storage.test.ts (REQ-OPERATOR-050/052: parent-owned immutable packet storage) --> <!-- @test: src/__tests__/operators/conductor-production-packet.test.ts (REQ-OPERATOR-050/053: claimed parent packet crosses only the ordinary Host and sealed storage) -->
4. For claimed packets, the parent compares requested initialization with the private current-generation Activity checkpoint before Pi startup. <!-- @impl: src/operators/activity.ts::OperatorActivity.getCurrentDriveCheckpointJson --> <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @test: src/__tests__/operators/conductor-production-packet.test.ts (REQ-OPERATOR-050: claimed packet initialization requires its private Activity checkpoint) -->
5. Structured Pi tasks expose no credential or unrestricted filesystem authority. <!-- @impl: src/operators/conductor-capability.ts::OperatorConductorCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->
6. Synchronization seals exact declared outputs and requires independent verification before completion. <!-- @impl: src/operators/conductor-capability.ts::OperatorConductorCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->
7. Storage inspection is owner-scoped, canonical-path bounded and read-only. <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->

**Notes:** The parent checks initialization only when claimed packets exist; complete-checkpoint matching for every initialization remains unmet. Deployed owned-session evidence is also incomplete.

**Constraints:**

- The interface contains no Review-specific route or policy, grants no GitHub publisher credential, and leaves packet, lane, finding, history and publication semantics package-owned.
- Claimed packets require the signed claim and drive, the fixed credential-free source Host task, conditional owner-bucket storage with exact readback or verified replay, and immutable Activity descriptors.
- Under [REQ-OPERATOR-005](#req-operator-005-owned-operator-session-lifecycle), owned-session reservation binds the request digest to the current attachment projection and denies later additions.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission), [REQ-OPERATOR-005](#req-operator-005-owned-operator-session-lifecycle)

**Verification:** Adjacent capability, attachment and owned-session tests cover the delivered generic boundary. The claimed packet path and compiled Conductor fixture are candidates pending exact-head CI; no deployed protected Action or live restore receipt is proven.

**Status:** Partial

---

<a id="req-operator-052-opaque-package-resources"></a>
### REQ-OPERATOR-052: Opaque package resources

**Intent:** Admitted packages may receive inert resources without gaining storage or path authority.

**Applies To:** User

**Acceptance Criteria:**

1. An admitted package may declare bounded generic resources; packages without resources retain existing behavior. <!-- @impl: src/operators/package-resources.ts::projectOperatorPackageResources --> <!-- @test: src/__tests__/operators/package-resources.test.ts (generic admitted Operator package resources) -->
2. The parent projects only digest-and-size-verified bytes from canonical declared paths. <!-- @impl: src/operators/package-resources.ts::projectOperatorPackageResources --> <!-- @impl: src/operators/package-resources.ts::verifyOperatorPackageResourceProjection --> <!-- @test: src/__tests__/operators/package-resources.test.ts (generic admitted Operator package resources) -->
3. Activity-owned resource persistence remains inert and non-authoritative. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/package-resources.test.ts (generic admitted Operator package resources) -->
4. Verified resources are available before package work starts and never enter synchronized user storage. <!-- @impl: src/container/index.ts::configureOperatorResources --> <!-- @impl: src/operators/package-resources.ts::verifyOperatorPackageResourceProjection --> <!-- @test: src/__tests__/operators/owned-session-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->
5. Missing, oversized, path-escaping, symlinked or digest-mismatched resources fail closed before package work starts. <!-- @impl: scripts/restore-operator-attachments.mjs::restoreOperatorAttachments --> <!-- @test: host/__tests__/operator-attachment-restore.test.js (opaque operator attachments reject missing, oversized, unsafe and mismatched resources) -->

**Notes:** Exact-head CI and deployed restore evidence remain incomplete.

**Constraints:** Package resources grant no authority; Codeflare stores only opaque locator and integrity metadata, and package code alone interprets contents.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-030](#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-050](#req-operator-050-generic-conductor-capability)

**Verification:** Adjacent package, attachment and startup tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

---

<a id="req-operator-009-reusable-platform-interfaces-and-bounded-consumer-fixtures"></a>
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

<a id="req-operator-037-bounded-operator-consumer-inputs"></a>
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

<a id="req-operator-038-bounded-operator-consumer-fixtures"></a>
### REQ-OPERATOR-038: Bounded operator consumer fixtures

**Intent:** Small fixtures prove each reusable consumer seam without implementing private workflows.

**Applies To:** User

**Acceptance Criteria:**

1. A direct fixture proves bounded execution without a session. <!-- @impl: src/__tests__/operators/fixtures/platform-acceptance.ts::runDirectFixture --> <!-- @test: src/__tests__/operators/platform-acceptance-fixtures.test.ts (REQ-OPERATOR-009: platform acceptance fixtures) -->
2. A session fixture proves bounded owned-session execution. <!-- @impl: src/__tests__/operators/fixtures/platform-acceptance.ts::runSessionFixture --> <!-- @test: src/__tests__/operators/platform-acceptance-fixtures.test.ts (REQ-OPERATOR-009: platform acceptance fixtures) -->
3. A webhook fixture proves capability-authenticated handoff. <!-- @impl: src/__tests__/operators/fixtures/platform-acceptance.ts::runWebhookCallerFixture --> <!-- @test: src/__tests__/operators/platform-acceptance-fixtures.test.ts (REQ-OPERATOR-009: platform acceptance fixtures) -->
4. Fixture execution leaves local-review resources unchanged. <!-- @impl: preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs::buildReviewPacket --> <!-- @test: src/__tests__/operators/legacy-review-unchanged.test.ts (REQ-OPERATOR-009: unchanged canonical local-review resource) -->

**Constraints:**

- Consumer fixtures carry no credentials.
- Consumer fixtures carry no publisher authority.
- Consumer fixtures contain no private business workflow.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-009](#req-operator-009-reusable-platform-interfaces-and-bounded-consumer-fixtures), [REQ-OPERATOR-037](#req-operator-037-bounded-operator-consumer-inputs)

**Verification:** Direct, session, webhook and local-review regression fixtures are covered by the adjacent tests.

**Status:** Implemented

## Webhook capabilities and edge handoff

<a id="req-operator-012-protected-operator-webhook-keys"></a>
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

<a id="req-operator-006-capability-authenticated-webhook-activity"></a>
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

<a id="req-operator-025-optional-encrypted-webhook-handoff"></a>
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

<a id="req-operator-026-managed-webhook-edge-bypass"></a>
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

<a id="req-operator-029-capability-authenticated-webhook-edge"></a>
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

<a id="req-operator-031-non-consuming-webhook-observation"></a>
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

## Catalog, installation and invocation presentation

<a id="req-operator-008-enterprise-operator-administration-surface"></a>
### REQ-OPERATOR-008: Enterprise operator administration surface

**Intent:** Enterprise Administration opens the installed release catalog instead of the retired Gate 1 test editor, without granting authority through navigation.

**Applies To:** Admin

**Acceptance Criteria:**

1. The Enterprise Administration Operators link opens `/operators`; bookmarked `/admin/operators` addresses reach that same catalog instead of the old Endpoint URL editor. <!-- @impl: web-ui/src/components/admin/AdministrationLayout.tsx::AdministrationLayout --> <!-- @impl: web-ui/src/App.tsx::App --> <!-- @test: web-ui/src/__tests__/components/AdministrationLayout.test.tsx (renders the %s navigation) --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (opens the installed release catalog) -->
2. The catalog presents release registration, installation configuration, promotion and enablement as separate controls, with server-side grants rather than navigation as authority. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
3. Newly registered managed operators cannot start until separately approved and enabled. <!-- @impl: src/operators/registry.ts::OperatorRegistry.registerManagement --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->
4. Conflicts require explicit reconciliation, and management mutations are never replayed automatically. <!-- @impl: web-ui/src/api/operator-management.ts::request --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
5. Enterprise admins reach the catalog through Administration; authorized non-admin managers have a separate entry, with mobile navigation below the header. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (uses Enterprise Administration navigation for admins while preserving manager access) -->
6. Display names preserve verified package identity; an unavailable pin cannot borrow another release’s purpose. <!-- @impl: src/operators/registry.ts::OperatorRegistry.getManagementReleases --> <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (projects the uniquely enabled pinned version rather than an arbitrary other release for multiple installations) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (presents first-party display names without replacing verified package identity or collapsing release details into status) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (does not assign the first-party name to a third-party Dispatcher or a mismatched repository identity) --> <!-- @manual: Verify an unavailable pin does not borrow another release's purpose. -->
7. Environment → Access & Identity owns global management eligibility and limits; installation permission presentation remains separately governed by REQ-OPERATOR-075. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/components/EnvironmentIndex.test.tsx (edits global eligibility alongside Access and Identity, not inside an operator) -->

**Constraints:**

- The catalog and its APIs are enterprise-only; SaaS has no legacy administration API.
- Secret readback is prohibited.
- The retired Gate 1 editor is not reinstated.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-013](#req-operator-013-enterprise-operator-administration-authorization), [REQ-OPERATOR-045](#req-operator-045-delegated-management-and-invocation), [REQ-OPERATOR-049](#req-operator-049-operators-management-interface), [REQ-OPERATOR-032](#req-operator-032-secret-safe-administration-readback)

**Verification:** Enterprise operator administration is covered by the adjacent component and client tests.

**Status:** Implemented

---

<a id="req-operator-049-operators-management-interface"></a>
### REQ-OPERATOR-049: Operators management interface

**Intent:** Authorized people manage and invoke operators from a separate responsive product area.

**Applies To:** User

**Acceptance Criteria:**

1. Operator management routes enforce management authorization independently of Administration navigation. <!-- @impl: src/routes/operator-management.ts::managementContext --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-049 AC1: management route denies self-nominated users outside global eligibility) -->
2. Catalog, registration, promotion, installation, grants and activity states expose no stored secrets. <!-- @impl: src/routes/operator-management.ts::presentInstallation --> <!-- @impl: src/operators/registry.ts::managementProjection --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-049 AC2: management registration, detail and catalog never return the stored GitHub credential) --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-049 AC2: installed release and grant projections do not reveal stored credentials) -->
3. Detail leads with the uniquely enabled installed pin; ambiguous or unavailable pins remain distinguishable rather than borrowing another release. <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (REQ-OPERATOR-049: labels catalog enablement concisely for enabled and disabled operators) --> <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (refreshes verified metadata for an older installed pin without changing its enablement) --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (makes the installed version primary and updates the existing installation without creating another) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (reconciles a created but unpinned installation when %s without a duplicate or automatic enable) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (requires an explicit configuration choice when more than one is enabled) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (distinguishes an installed pin with unavailable release details from no installation) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (shows verified tag and publication time on installed and selectable versions while labelling legacy records honestly) --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (projects the uniquely enabled pinned version rather than an arbitrary other release for multiple installations) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (presents the authored name, category and verified installed version in the catalog instead of an opaque release number) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (does not pretend an unverified installed version is a release number) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (offers each alternative version once with its description and publication date beside the choice) -->
4. Search filters as the person types without submission; stale responses cannot replace newer results. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @impl: web-ui/src/api/operator-management.ts::listManagedOperators --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (presents first-party display names without replacing verified package identity or collapsing release details into status) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (does not assign the first-party name to a third-party Dispatcher or a mismatched repository identity) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (reveals Search beside Register, filters as the person types, and clears on close without a submit) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (ignores late search responses when a newer search has already resolved) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (separates verified package identity from the category and keeps source replacement out of restrictions) -->
5. Operator ceilings remain editable separately from installation restrictions; changes disable installations without discarding saved policies. <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045/049: explains limit ownership and resets inference to its default without changing other fields) --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045/049: source default resets update only the selected ceiling or installation draft) --> <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (separates verified package identity from the category and keeps source replacement out of restrictions) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (edits the operator capability ceiling after registration without silently editing an installation or keeping it enabled) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (keeps saved missing grants, distinguishes unverified choices and shows local save feedback) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (explains global action limits and scope labels without raw capability keys or suggesting that an ID provisions resources) -->
6. Responsive controls retain focus and scrolling for long names and errors. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (retains the registration control and visible long error on a narrow viewport) --> <!-- @manual: Verify keyboard focus and scrolling on narrow and wide browser viewports. -->
7. Mobile sections remain horizontal and retain save feedback beside the action without silently enabling installations. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (confirms a restriction save beside its action without silently enabling the installation) -->

**Constraints:**

- The management surface cannot grant authority beyond server-side policy.
- Size guidance distinguishes received-response ceilings/allowances from model-input limits. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045/049: explains limit ownership and resets inference to its default without changing other fields) -->
- MDI autorenew resets edit drafts to1MiB defaults, without saving or bypassing ceilings. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045/049: source default resets update only the selected ceiling or installation draft) -->
- Operator operation capacity defaults/reset to1024; guidance explains journal accounting and workload headroom, not guaranteed completion. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorDetail --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045/049: explains and persists operation budget independently then resets to 1024) --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-049: reset defaults remain subject to a lower inherited source ceiling) -->
- Catalog profile pills use the selected theme accent; detail pills and muted catalog metadata retain their colors. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @manual: Run scripts/browser/check-operator-pill-colors.js in a real browser on the catalog and each profile's detail view under two selected accent themes; every returned color comparison must match. -->

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-045](#req-operator-045-delegated-management-and-invocation), [REQ-OPERATOR-046](#req-operator-046-explicit-release-promotion)

**Verification:** The remaining management criteria have current route and UI test anchors and were present in the earlier CI-proven management surface. Catalog Enabled/Disabled copy passed exact-head PR Checks `36497242563` at `5eaae7d470a4123fee0e0259bb702cadb61b3464` (frontend shard-3, Typecheck, aggregate). The guided-launcher acceptance still pending is owned by REQ-OPERATOR-058; Enterprise Integration responsive visual acceptance remains a separate release gate.

**Status:** Implemented

---

<a id="req-operator-058-guided-dispatcher-invocation"></a>
### REQ-OPERATOR-058: Guided Dispatcher invocation

**Intent:** Authorized owners select an editable Renovate repository and explicitly start the installed package's approved journey or legacy single-PR assessment.

**Applies To:** User

**Acceptance Criteria:**

1. Only authorized pinned Dispatcher installations expose a guided launcher; other packages have none. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @impl: web-ui/src/components/OperatorManagementActivity.tsx::OperatorManagementActivity --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (binds invocation to the selected installation and never renders its single-use start capability) -->
2. Selected repository and PR values prefill editable fields without a global default or an Activity start on opening. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (REQ-OPERATOR-058: carries a user-chosen editable repository and PR to the guided Dispatcher form without preparing activity) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (REQ-OPERATOR-058: never supplies a universal repository or PR when no target was selected) -->
3. Repository journeys submit only the selected repository under the installed manifest contract and disclose discovery, research, comments and conditional merges. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @impl: web-ui/src/components/OperatorManagementActivity.tsx::OperatorManagementActivity --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (uses the installed repository-only contract, discloses effects, and ignores PR query input until explicit start) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (preserves legacy read-only disclosure and rejects nonpositive PR input) -->
4. An uncertain start blocks another start until the exact prepared activity is reconciled by its owner. <!-- @impl: web-ui/src/components/OperatorManagementActivity.tsx::OperatorManagementActivity --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (does not allow another start after an uncertain response until the prepared activity is reconciled) -->
5. Failed preparation cannot be reconciled against a previous activity. <!-- @impl: web-ui/src/components/OperatorManagementActivity.tsx::OperatorManagementActivity --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (does not reconcile failed preparation against an earlier accepted activity) -->

6. Explicit legacy single-PR assessments submit the selected repository and positive PR under the installed manifest contract with read-only disclosure. <!-- @impl: web-ui/src/components/OperatorManagementActivity.tsx::OperatorManagementActivity --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (preserves legacy read-only disclosure and rejects nonpositive PR input) -->
7. Unsupported installed schemas expose no guided launcher. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (does not offer a Renovate form for an unsupported installed package) -->

**Constraints:** The guided launcher cannot widen server-side invocation authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-049](#req-operator-049-operators-management-interface), [REQ-OPERATOR-045](#req-operator-045-delegated-management-and-invocation)

**Verification:** Schema-derived journey/legacy guidance and behavioral wire/copy tests are implemented locally but have not run at this correction head. The earlier failed PR Checks 36363151786 is historical, not verification of this candidate. Exact-head CI and responsive Enterprise Integration acceptance remain pending.

**Status:** Implemented

---

<a id="req-operator-073-installed-release-selection-and-first-installation"></a>
### REQ-OPERATOR-073: Installed release selection and first installation

**Intent:** The catalog distinguishes the installed release from other available versions without granting start authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. Detail defaults to the uniquely enabled installed release, with other versions and permissions secondary; multiple enabled configurations require explicit selection. <!-- @impl: src/operators/registry.ts::OperatorRegistry.getManagementReleases --> <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (projects the uniquely enabled pinned version rather than an arbitrary other release for multiple installations) --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (makes the installed version primary and updates the existing installation without creating another) -->
2. First installation pins an exact version without enabling it. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (offers guided first installation, pins the exact release, and never enables it automatically) -->
3. Reconciliation reuses an existing unpinned installation rather than creating another. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (makes the installed version primary and updates the existing installation without creating another) -->
4. Verified tag and publication time label available releases when retained, with a numeric ID fallback. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @manual -->

**Constraints:**

- Navigation and release selection never grant authority.
- Secret readback and the retired Gate 1 editor remain prohibited.
- Horizontal mobile sections remain explicit in [REQ-OPERATOR-049](#req-operator-049-operators-management-interface), and navigation below the header remains in [REQ-OPERATOR-008](#req-operator-008-enterprise-operator-administration-surface).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-008](#req-operator-008-enterprise-operator-administration-surface), [REQ-OPERATOR-049](#req-operator-049-operators-management-interface)

**Verification:** Installed-selection and first-installation tests at the adjacent anchors; retained release metadata/fallback rendering remains manual, with current-head regression/CI pending.

**Status:** Implemented

---

<a id="req-operator-075-installation-permission-choices-and-explanation"></a>
### REQ-OPERATOR-075: Installation permission choices and explanation

**Intent:** Per-installation restrictions select existing authority without implying global identity or resource provisioning.

**Applies To:** Admin

**Acceptance Criteria:**

1. Operator permission selectors offer only existing configured users and stable groups rather than free-text identities. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (assigns only configured users, stable groups and supported limits without free-text identities) -->
2. Supported actions and resource limits are explained without implying provisioning. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @manual -->

**Constraints:** Global management eligibility and limits belong to Environment → Access & Identity under [REQ-OPERATOR-008](#req-operator-008-enterprise-operator-administration-surface); per-installation choices never widen those limits.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-008](#req-operator-008-enterprise-operator-administration-surface), [REQ-OPERATOR-049](#req-operator-049-operators-management-interface)

**Verification:** Configured-identity selection is covered by the adjacent public form/save test. Explanatory action/resource wording remains manual, not established by selector or source assertions; current-head CI is pending.

**Status:** Implemented

---

<a id="req-operator-066-verified-release-presentation"></a>
### REQ-OPERATOR-066: Verified release presentation

**Intent:** Verified release presentation preserves verified identity and caller authority.

**Applies To:** User

**Acceptance Criteria:**

1. Release choices show verified tags and UTC publication times; legacy gaps are labelled rather than inventing versions. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (shows verified tag and publication time on installed and selectable versions while labelling legacy records honestly) -->
2. Each alternative version appears once with its description and publication date. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (offers each alternative version once with its description and publication date beside the choice) -->
3. Uncertain promotion reconciles without duplicate installation or automatic enablement. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (reconciles a created but unpinned installation when %s without a duplicate or automatic enable) -->
4. Ambiguous enabled configurations require explicit selection. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (requires an explicit configuration choice when more than one is enabled) -->
5. Metadata refresh enriches an older pin without changing enablement. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (refreshes verified metadata for an older installed pin without changing its enablement) -->
6. Catalog enablement reads Enabled or Disabled. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (REQ-OPERATOR-049: labels catalog enablement concisely for enabled and disabled operators) -->

**Constraints:** Presentation cannot grant execution or management authority.

**Priority:** P1

**Dependencies:** [REQ-OPERATOR-049](#req-operator-049-operators-management-interface)

**Verification:** Automated test: [operator-management-redesign.test.tsx](../../web-ui/src/__tests__/operators/operator-management-redesign.test.tsx), [operator-management.test.tsx](../../web-ui/src/__tests__/operators/operator-management.test.tsx), [operator-management-flow.test.tsx](../../web-ui/src/__tests__/operators/operator-management-flow.test.tsx), [operator-catalog.test.ts](../../src/__tests__/operators/operator-catalog.test.ts).

**Status:** Implemented

---

<a id="req-operator-067-verified-catalog-identity-and-search"></a>
### REQ-OPERATOR-067: Verified catalog identity and search

**Intent:** Verified catalog identity and search preserves verified identity and caller authority.

**Applies To:** User

**Acceptance Criteria:**

1. First-party display names require verified repository identity; other packages retain their authored names. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (presents first-party display names without replacing verified package identity or collapsing release details into status) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (does not assign the first-party name to a third-party Dispatcher or a mismatched repository identity) -->
2. Catalog keeps purpose, version, publication and status distinct from technical identity. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (presents first-party display names without replacing verified package identity or collapsing release details into status) -->
3. Search is revealed beside Register and clears on close without submission. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (reveals Search beside Register, filters as the person types, and clears on close without a submit) -->
4. Category presentation does not replace verified package identity. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (separates verified package identity from the category and keeps source replacement out of restrictions) -->

**Constraints:** Presentation cannot grant execution or management authority.

**Priority:** P1

**Dependencies:** [REQ-OPERATOR-049](#req-operator-049-operators-management-interface)

**Verification:** Automated test: [operator-management-redesign.test.tsx](../../web-ui/src/__tests__/operators/operator-management-redesign.test.tsx).

**Status:** Implemented

---

<a id="req-operator-068-scoped-restriction-controls"></a>
### REQ-OPERATOR-068: Scoped restriction controls

**Intent:** Scoped restriction controls preserves verified identity and caller authority.

**Applies To:** User

**Acceptance Criteria:**

1. Capability ceiling edits preserve installation policies and disable existing enablement. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (edits the operator capability ceiling after registration without silently editing an installation or keeping it enabled) -->
2. Saved missing grants remain distinguishable from unverified choices, with local save feedback. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (keeps saved missing grants, distinguishes unverified choices and shows local save feedback) -->
3. Global limits use human scope labels; choosing an ID does not provision resources. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::ManagementAccessPanel --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (explains global action limits and scope labels without raw capability keys or suggesting that an ID provisions resources) -->
4. Source and technical identity stay outside restriction edits. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (separates verified package identity from the category and keeps source replacement out of restrictions) -->
5. Realm remains compatibility metadata, not a registration choice, filter or permission boundary. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (does not present realm as a registration choice, catalog filter, or permission boundary) -->
6. Dispatcher has no resource profile; Conductor scope IDs select configured resources rather than provisioning profiles or an ad hoc launcher. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::ManagementAccessPanel --> <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (explains why Dispatcher has no resource profile and opens its invocation without a reload or start) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (explains that allowed scope IDs match requests rather than creating profiles) -->
7. Registration rejects blank limits. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (requires explicit usable registration limits before accepting a source) -->

**Constraints:** Presentation cannot grant execution or management authority.

**Priority:** P1

**Dependencies:** [REQ-OPERATOR-049](#req-operator-049-operators-management-interface)

**Verification:** Automated test: [operator-management-redesign.test.tsx](../../web-ui/src/__tests__/operators/operator-management-redesign.test.tsx), [operator-management-flow.test.tsx](../../web-ui/src/__tests__/operators/operator-management-flow.test.tsx).

**Status:** Implemented

---

<a id="req-operator-070-installation-configuration-retention"></a>
### REQ-OPERATOR-070: Installation configuration retention

**Intent:** Restriction edits retain saved installation configuration.

**Applies To:** User

**Acceptance Criteria:**

1. Saving installation restrictions preserves saved unused configuration without requiring a JSON editor. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (keeps persisted configuration when saving restrictions, without an unused JSON editor) -->

**Constraints:** Restriction edits cannot enable an installation or expand caller authority.

**Priority:** P1

**Dependencies:** [REQ-OPERATOR-068](#req-operator-068-scoped-restriction-controls)

**Verification:** Automated test: [Installation restriction tests](../../web-ui/src/__tests__/operators/operator-management.test.tsx).

**Status:** Implemented

## Owner-scoped observation and control

<a id="req-operator-027-owned-activity-user-surface"></a>
### REQ-OPERATOR-027: Owned activity user surface

**Intent:** Users observe and control owned activities without conflating execution, storage and collection outcomes.

**Applies To:** User

**Acceptance Criteria:**

1. The operator control remains accessible with zero activity. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
2. The control distinguishes unread new summaries from working activity state. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-059: shows new summaries since last open and opening acknowledges only observed admissions) -->
3. The overview exposes only trusted pinned names and allowlisted admitted task coordinates. <!-- @impl: src/operators/activity.ts::browserSummary --> <!-- @impl: src/operators/activity.ts::OperatorActivity.getBrowserSummary --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-027: projects only trusted pinned name and allowlisted admitted task coordinates) -->
4. Unknown activity values are never displayed as zero or offered replay. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: readable owned activity and bounded history) -->
5. The overview pages five owner-scoped entries at a time across at most 20 browsable summaries per operator, and navigates retained history without skips on updates. <!-- @impl: src/operators/registry.ts::listOwnedActivityPage --> <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-027: retains at most 20 browsable summaries per operator without discarding owned results) --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-027: retains only 20 per operator and pages by last seen ID across a new arrival and status update) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: readable owned activity and bounded history) -->
6. An expired or foreign cursor is rejected rather than silently omitting history. <!-- @impl: src/operators/registry.ts::listOwnedActivityPage --> <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: exposes five owner-scoped entries and all-working count using a validated stable cursor) -->
7. The paged response counts persisted working owner activities, including those beyond the retained display index; pending boundary preparations without summaries contribute only when in the displayed projection. <!-- @impl: src/operators/registry.ts::upsertOwnedActivity --> <!-- @impl: src/operators/registry.ts::listOwnedActivityPage --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-027: counts still-working activities after their historical rows leave the 100-entry index) --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-027: recovers persisted working count beyond 1,000 historical summaries) --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: exposes five owner-scoped entries and all-working count using a validated stable cursor) -->

**Constraints:**

- Data routes are enterprise-only.
- Data routes are owner-scoped.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-016](#req-operator-016-durable-activity-admission-and-cleanup)

**Verification:** Earlier activity behavior passed exact-head CI 35174509964 at `e03c48ec`. The current five-entry owner history, unread and overview behavior passed exact-head PR Checks `36494117864` at `369e11db3824ee1973a79a67da7463a0df44881d`. Authenticated Enterprise Integration browser observations covered mobile/desktop guided prefill, in-app owner detail, and header paging 5→5→5→4 and back, but older persisted summaries displayed UUID titles. Historical metadata RED at `7730c0526c151555f63cab0ff263e636f2893f80` / PR Checks `36533355151` failed the expected missing Activity summary method and missing owner-page enrichment, alongside six typing errors in the new route tests, corrected before implementation; the bounded correction at `b2f25cf7da48372a70a8440d38b1f062d06e6815` passed exact-head PR Checks `36534633865` attempt 2, including the owner-route/Activity tests, Typecheck, Node-Flue and aggregate. Attempt 1 failed only because Wrangler returned a non-JSON `Error: Net...` response in the unchanged malformed-model Node-Flue test; its root cause remains unproved. Enterprise Integration rollout `36536119109` deployed the correction at `05ab38a4d3851fc6f4db2f5d43ef79aeb432c590` with inline exact-tree CI. On the Access-protected Enterprise Integration origin `https://enterprise.codeflare.ch`, fresh authenticated DOM/content inspection showed historical Renovate Dispatcher and Codeflare Gate 1 fixture names rather than UUIDs, with available `repository · PR` context at 390×844; its 19 entries paged 5→5→5→4 and back. The completed owned Activity opened readable in-app assessment detail; the 1440×900 header retained resolved labels. Measured horizontal overflow was absent in both viewports. Mobile and desktop screenshots showed readable historical labels and owned detail; long repository/PR context wrapped within the desktop card without clipping. This verifies the observed visual presentation, not the untested admission and isolation edges. A later, separately authorized one-off Komodo #1299 admission created Activity `b4375b9f-f985-4c01-af35-4ef973e9d5b0`: the header unread badge showed 1, opening the dropdown acknowledged it, and the owner row and detail showed waiting execution with a saved checkpoint and pending result. This is natural new-admission and unread-acknowledgement evidence, not settled execution or a fabricated UI test. The 20-per-operator edge is unverified, and the user elected to test second-account isolation themselves; neither may be claimed from this one-account observation.

**Status:** Implemented

---

<a id="req-operator-059-new-activity-observation"></a>
### REQ-OPERATOR-059: New activity observation

**Intent:** Owners notice new activity summaries since their last successfully acknowledged open without changing execution or collecting results.

**Applies To:** User

**Acceptance Criteria:**

1. Each new owned admission increases the unread count; status updates do not. <!-- @impl: src/operators/registry.ts::upsertOwnedActivity --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-059: counts only new admissions, resets through the observed revision and preserves later arrivals) -->
2. Opening the overview acknowledges only observed admissions for the authenticated owner, under CSRF protection; later admissions remain unread. <!-- @impl: src/operators/registry.ts::listOwnedActivityPage --> <!-- @impl: src/operators/registry.ts::acknowledgeOwnedActivities --> <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-059: counts only new admissions, resets through the observed revision and preserves later arrivals) --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-059: does not acknowledge an admission arriving during page construction) --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-059: opening acknowledges only the authenticated owner through the observed sequence and requires CSRF) -->
3. The icon badge shows unread summaries rather than the working count. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-059: shows new summaries since last open and opening acknowledges only observed admissions) -->
4. Opening the overview clears successfully acknowledged unread without a button, result collection or replay. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-059: shows new summaries since last open and opening acknowledges only observed admissions) --> <!-- @test: web-ui/src/__tests__/api/operator-activities.test.ts (REQ-OPERATOR-059: acknowledges the observed summary revision with authenticated CSRF POST) -->

**Constraints:** Activity state and the separate working count remain unchanged by acknowledgment.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-027](#req-operator-027-owned-activity-user-surface), [REQ-OPERATOR-041](#req-operator-041-owned-activity-browser-reads)

**Verification:** New behavior awaits exact-head CI and Enterprise Integration desktop/mobile inspection.

**Status:** Planned

---

<a id="req-operator-057-readable-owned-activity-results"></a>
### REQ-OPERATOR-057: Readable owned activity results

**Intent:** Owners can inspect complete Review and Dispatcher outcomes in the activity detail without exposing opaque result fields.

**Applies To:** User

**Acceptance Criteria:**

1. Owned in-app detail presents published Review reports as readable fields, without raw API JSON or arbitrary result fields. <!-- @impl: src/operators/activity.ts::getBrowserDetail --> <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::resultView --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-041: browser GET preserves original Review reports and settled Dispatcher assessment without collection) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: presents original Review lane findings and incomplete reports as readable evidence, not raw JSON) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: summarizes the actual Dispatcher assessment and rejects opaque result bytes) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: reads the cited Dispatcher compatibility assessment without equating safe with merge readiness) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: distinguishes unsafe assessment and refuses malformed or unreadable evidence) -->
2. Every published Review report, omission and finding remains represented beyond the former preview limits; fields outside the safe readable limit are explicitly marked unavailable. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::resultView --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: presents every Review report, omission and finding without hiding later evidence) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: keeps early and late Review findings and omissions readable together) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: marks unreadable Review evidence explicitly without exposing unsafe text) -->
3. Detail distinguishes execution, cleanup, collection and explicit attention without turning stale observations into alerts, retaining progress and source/session links. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (opens an in-app owner-scoped readable result, with diagnostics and a way back, without collecting or restarting) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: labels an old working observation as stale but reserves attention for an explicit signal) -->

4. Owned in-app detail presents settled Dispatcher evidence as readable fields, without raw API JSON or arbitrary result fields. <!-- @impl: src/operators/activity.ts::getBrowserDetail --> <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::resultView --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: summarizes the actual Dispatcher assessment and rejects opaque result bytes) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: reads the cited Dispatcher compatibility assessment without equating safe with merge readiness) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: distinguishes unsafe assessment and refuses malformed or unreadable evidence) -->

**Constraints:**

- Detail remains authenticated and owner-scoped under [REQ-OPERATOR-041](#req-operator-041-owned-activity-browser-reads).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-027](#req-operator-027-owned-activity-user-surface), [REQ-OPERATOR-041](#req-operator-041-owned-activity-browser-reads)

**Verification:** Exact-head PR Checks `36494117864` at `369e11db3824ee1973a79a67da7463a0df44881d` passed current in-app Review and nested Dispatcher-result tests, Typecheck and aggregate. The cited compatibility assessment is not merge authorization. Mobile result navigation on Enterprise Integration remains unverified under separate acceptance tasks.

**Status:** Implemented

---

<a id="req-operator-040-owned-activity-control-presentation"></a>
### REQ-OPERATOR-040: Owned activity control presentation

**Intent:** Users can find and understand the owned activity control across dashboard and terminal layouts.

**Applies To:** User

**Acceptance Criteria:**

1. The dashboard header places the operator control after the user control and before Settings. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-OPERATOR-040 AC1: places the operator control between the user menu and settings in enterprise mode) --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-OPERATOR-040: Enterprise operator placement) -->
2. Terminal headers place the operator control between VS Code and Storage. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (REQ-OPERATOR-040: Enterprise operator placement) -->
3. The panel is called “Operator overview.” <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-040: uses concise explanatory copy without redundant refresh or close controls) -->
4. The panel explains that operators are autonomous agents that work in the background. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-040: uses concise explanatory copy without redundant refresh or close controls) -->
5. Desktop and tablet render the activity control as an anchored popover. <!-- @impl: web-ui/src/styles/header.css::.operator-activity-panel --> <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (renders the panel outside the control so no filtered ancestor can contain it, anchored to the trigger) --> <!-- @manual: Owner verifies the opened overview remains anchored at desktop and tablet widths. -->
6. Mobile renders the activity control as a bottom sheet. <!-- @impl: web-ui/src/styles/header.css::.operator-activity-panel --> <!-- @manual: Owner verifies the opened overview is bottom-fixed at mobile width. -->
7. An open overview closes when the viewport width changes. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (closes on a width change so a measured layout cannot outlive the width it was measured at, but survives height-only resizes) -->

**Constraints:**

- The control is enterprise-only.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-027](#req-operator-027-owned-activity-user-surface)

**Verification:** Placement and copy are covered by adjacent component tests (`Dashboard.test.tsx`, `Header.test.tsx`, `OperatorActivityButton.test.tsx`). AC5 and AC6 are owner-verified manually.

**Status:** Implemented

---

<a id="req-operator-042-activity-overview-sizing-follows-working-state"></a>
### REQ-OPERATOR-042: Activity overview sizing follows working state

**Intent:** Users can inspect operator activity without an oversized idle overview or losing access to active history.

**Applies To:** User

**Acceptance Criteria:**

1. An empty or single-completed-entry overview uses a compact 168px height. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (uses compact sizing for completed-only history) --> <!-- @manual: Owner verifies the 168px compact height at desktop, tablet, and mobile viewports. -->
2. An overview with working activities or multiple retained entries, including completed-only history, occupies a bounded panel of up to 60vh within the viewport. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @impl: web-ui/src/styles/header.css::.operator-activity-panel--active --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (uses compact sizing for completed history and returns to it when work completes) --> <!-- @manual: Owner verifies the 60vh working height at desktop, tablet, and mobile viewports. -->
3. The bounded multi-entry overview scrolls its activity list while preserving accessible history and keyboard navigation. <!-- @impl: web-ui/src/styles/header.css::.operator-activity-list --> <!-- @manual: Owner verifies list scrolling at desktop, tablet, and mobile viewports. -->

**Constraints:**

- The responsive presentation rules of [REQ-OPERATOR-040](#req-operator-040-owned-activity-control-presentation) remain authoritative.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-040](#req-operator-040-owned-activity-control-presentation)

**Verification:** Manual check.

**Status:** Partial

---

<a id="req-operator-041-owned-activity-browser-reads"></a>
### REQ-OPERATOR-041: Owned activity browser reads

**Intent:** Users retrieve owned activity information without widening authority or changing activity state.

**Applies To:** User

**Acceptance Criteria:**

1. Authenticated activity-detail requests expose only account-owned activities. <!-- @impl: src/routes/operator-activities.ts::owned --> <!-- @impl: src/routes/operator-activities.ts::browserDetail --> <!-- @impl: src/operators/registry.ts::listOwnedActivities --> <!-- @impl: src/operators/activity.ts::getBrowserDetail --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-041: reads detail and result only after the durable index proves exact ownership without mutation) -->
2. Authenticated result requests expose only account-owned activities, including the in-app result read. <!-- @impl: src/routes/operator-activities.ts::owned --> <!-- @impl: src/routes/operator-activities.ts::browserDetail --> <!-- @impl: web-ui/src/api/operator-activities.ts::getOperatorActivity --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-041: browser result stays owner-scoped even when another account knows the ID) --> <!-- @test: web-ui/src/__tests__/api/operator-activities.test.ts (reads owned result through the authenticated non-consuming GET) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (opens an in-app owner-scoped readable result, with diagnostics and a way back, without collecting or restarting) -->
3. Activity GET requests are non-effectful. <!-- @impl: src/routes/operator-activities.ts::handleBrowserDetail --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-041: reads detail and result only after the durable index proves exact ownership without mutation) -->

**Constraints:**

- Data routes are enterprise-only.
- Data routes are owner-scoped.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-006](#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-016](#req-operator-016-durable-activity-admission-and-cleanup)

**Verification:** Server ownership is covered by the route tests. In-app client/result tests are added for GREEN; RED PR Checks 36362489370 failed before the client existed, so final exact-head verification is pending.

**Status:** Implemented

---

<a id="req-operator-036-owned-activity-user-mutations"></a>
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

<a id="req-operator-033-activity-surface-resilience"></a>
### REQ-OPERATOR-033: Activity surface resilience

**Intent:** The owned-activity surface remains absent outside enterprise mode and usable across interaction states.

**Applies To:** User

**Acceptance Criteria:**

1. Non-enterprise mode renders no operator UI. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
2. Non-enterprise mode issues no operator data request. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) -->
3. Keyboard and focus behavior remains usable. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: operator activity header control) --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-033 AC3: moves focus into the portalled panel and returns it to the trigger on dismissal) -->
4. Stale, loading and error states remain distinguishable and recoverable; in-app detail distinguishes pending, failed, unknown, unavailable, incomplete and already-collected outcomes without consuming result authority. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-027: readable owned activity and bounded history) -->
5. Account switching does not expose another owner's activity. <!-- @impl: src/routes/operator-activities.ts --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: authenticated owned activity browser surfaces) -->
6. The activity surface remains usable on mobile. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @manual: Verify the opened activity surface, controls and scrolling at a mobile viewport; inline-style assertions are not visual acceptance. -->

**Constraints:** Visual acceptance does not substitute for owner-scoped API enforcement.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-027](#req-operator-027-owned-activity-user-surface)

**Verification:** Component and owner-route behavior is automated; actual account-switch and activity-surface mobile acceptance remain pending. Operators catalog mobile acceptance does not establish this activity-surface criterion.

**Status:** Planned

---

<a id="req-operator-069-owner-summary-metadata-recovery"></a>
### REQ-OPERATOR-069: Owner summary metadata recovery

**Intent:** Historical summaries recover only trusted owner display metadata.

**Applies To:** User

**Acceptance Criteria:**

1. A five-entry owner page may recover missing pinned display metadata from the same owner's Activity without reading result bytes or changing history, status or cursors. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: recovers missing historical display metadata on the owner page without exposing result bytes) -->
2. Unavailable, mismatched or contradictory projections cannot supply substitute names or overwrite existing metadata. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: preserves indexed status and existing metadata; ignores unavailable or mismatched Activity projections) -->

**Constraints:** Recovery cannot broaden owner access or mutate execution state.

**Priority:** P1

**Dependencies:** [REQ-OPERATOR-027](#req-operator-027-owned-activity-user-surface)

**Verification:** Automated test: [operator-activities.test.ts](../../src/__tests__/routes/operator-activities.test.ts).

**Status:** Implemented

## Protected Review enrollment, claims and independent evidence

<a id="req-operator-053-enterprise-pr-boundary-review-handoff"></a>
### REQ-OPERATOR-053: Enterprise PR-boundary Review handoff

**Intent:** A trusted GitHub Action starts and publishes independent Review under the already-authenticated Codeflare actor's bounded operator context, while the existing local review procedure remains available unchanged.

**Applies To:** User

**Acceptance Criteria:**

1. Only Enterprise mode selects Operator Review; non-enterprise and confirmed local review remain unchanged. <!-- @impl: preseed/agents/pi/extensions/operator-review-selector.ts::selectOperatorReviewApplicability --> <!-- @impl: preseed/agents/pi/extensions/operator-review-selector.ts::registerOperatorReviewSelector --> <!-- @test: src/__tests__/lib/operator-review-selector.test.ts (REQ-OPERATOR-053 AC1: non-enterprise boundaries keep local Review) --> <!-- @test: src/__tests__/lib/operator-review-selector.test.ts (retains unchanged local behavior only for confirmed absence or inactive enrollment) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-OPERATOR-053: Pi loads only the selector, not the separately auto-discovered local Review extension) -->
2. Preparation binds one visible reservation to the verified human, installation, exact PR revision, trusted Action and eligible inference/resource scope. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @impl: src/operators/review-boundary-preparation.ts::prepareVerifiedBoundary --> <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/review-boundary-egress.test.ts (REQ-OPERATOR-053: authenticated Git push prepares exactly one visible boundary reservation) --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-053: exact-context preparation is one durable Registry reservation) --> <!-- @test: src/__tests__/operators/conductor-production-inference.test.ts (REQ-OPERATOR-053: a provider-default inference route admits a scoped Conductor session without a reasoning grade) --> <!-- @impl: src/operators/conductor-production.ts::bindClaimedConductorInvocation --> <!-- @test: src/__tests__/operators/conductor-prepared-runtime.test.ts (REQ-OPERATOR-053/056/074: prepared Conductor runtime projection (controlled composition, not native acceptance)) -->
3. Each target selects exactly one local, remote or unavailable path; repository changes reselect before the boundary without modifying canonical local Review. <!-- @impl: preseed/agents/pi/extensions/operator-review-selector.ts::registerOperatorReviewSelector --> <!-- @impl: src/operators/review-boundary-preparation.ts::selectVerifiedBoundaryAction --> <!-- @test: src/__tests__/lib/operator-review-selector.test.ts (REQ-OPERATOR-053: exclusive local versus dedicated remote Review extensions) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-OPERATOR-053: Pi loads only the selector) --> <!-- @test: src/__tests__/operators/review-action-applicability.test.ts (REQ-OPERATOR-053: approved target Action applicability, not release provenance) -->
4. Status exposes metadata and durable generation only; a continuation consumes its waiting generation once and cannot reserve a later drive. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @impl: src/operators/runtime.ts::driveOperatorRuntime --> <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-053: webhook continuation is single-use for each durable waiting generation) --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-053: a delayed continuation cannot reserve or execute against a newer waiting checkpoint after eviction) --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (REQ-OPERATOR-029: continuation wire response acknowledges work without echoing capability or issuing new authority) --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (REQ-OPERATOR-029: terminal status wire response is metadata-only even when the internal projection includes report bytes) -->
5. Only an independent trusted publisher holds publication credentials; fixed GitHub identity verification cannot be replaced by repository variables. <!-- @impl: scripts/operator-boundary-action.mjs::resolvePublisherIdentity --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: independent publisher discovers GitHub Actions identity without per-repository variables) -->
6. Owner-visible progress reflects actual execution and cleanup; failed destruction or SDK stopped state cannot prove physical child cessation. <!-- @impl: src/operators/owned-session.ts::OwnedOperatorSessionService --> <!-- @impl: src/operators/owned-session-runtime.ts::ContainerOwnedSessionRuntime --> <!-- @impl: src/container/index.ts::container.stopOperatorSession --> <!-- @test: src/__tests__/operators/owned-session-runtime.test.ts (keeps Review child cleanup uncertain until the external container destruction is observed) --> <!-- @test: src/__tests__/container/index.test.ts (Review child stop requires the owned container destruction to finish) -->
7. Original result-read authority may reread identical terminal bytes only until the Activity deadline plus two hours; reread cannot restart work or mint authority. <!-- @impl: src/operators/activity.ts::OperatorActivity.redeemWebhookResult --> <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: scripts/operator-boundary-action.mjs::collectBoundaryResult --> <!-- @test: src/__tests__/operators/activity-state.test.ts (rereads identical immutable terminal bytes after lost delivery only with the original read capability) --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-053: original read authority survives only until activity deadline plus two hours) --> <!-- @test: src/__tests__/operators/activity-state.test.ts (caps an already-issued read capability at the deadline plus two hours) --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-053: lost result delivery rereads the identical terminal bytes without another start) -->

**Constraints:**

- Neither session ownership nor GitHub identity supplies human authority.
- No new identity broker, workflow-selected principal, JWT renewal or candidate-controlled workflow.
- Pi and Codeflare do not dispatch the automatically triggered GitHub workflow.
- Only the authenticated claim binds run/attempt under [REQ-OPERATOR-054](#req-operator-054-protected-action-claim-and-stop-fence).
- Local `/review` remains unchanged and never starts the operator.
- Uncertain applicability, expired authority or failed **active** remote execution cannot silently fall back or clear a check.
- Explicitly inactive/unconfigured enrollment permits existing local review; verification must not activate remote execution.
- Human authority expiry stops protected execution.
- An Action without a matching Codeflare handoff fails closed; terminal reread never reclaims start or mints read authority.
- Consumed status and continuation capabilities cannot be reused.
- Browser JWTs and publisher credentials never enter Pi or the compiled child.
- The parent verifies numeric repository, PR/head/base/merge-base, acknowledged-head ancestry and installed Action bytes.
- Session-bound range and rejected-finding evidence are not principal authority.
- An independent terminal receipt is retained before publication under [REQ-OPERATOR-055](#req-operator-055-pr-wide-publication-ordering).
- Conductor creates the canonical packet after Action start.
- Rejected reasoning alone cannot resolve findings.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission), [REQ-OPERATOR-050](#req-operator-050-generic-conductor-capability), [REQ-OPERATOR-029](#req-operator-029-capability-authenticated-webhook-edge)

**Verification:** Dedicated-extension test-only RED at `3a561549` failed the expected missing selector/consumer and published-read cases in `36447403897`. The first GREEN candidate `b6133eb0` failed exact-head Test `36452540739`: three new suites were erroneously assigned to the Worker rather than Node lane, backend Typecheck and two Host checks failed. The original local-only Review source is restored from the verified `f588867d^` blob; the dedicated selector and published-result consumer passed full exact-head Test `36457559457` at `65d1512409449b5e18a31ad36ba0dff17eafc597`. The finding-linked rejection test-only RED `2981b57c` failed its intended cases in Test `36461468216`, with a separate test typing error also observed. The first candidate `1cfde761` failed Test `36465802906` on generated seed drift, a TypeScript option and stale compiled-fixture fields. Corrected `73ec5e570f0d29c5955698cb24c53d2a202c199e` passed full exact-head Test `36467129972`, including compiled Conductor native fixture, generated-seed guard, Typecheck, Host and backend tests; this remains dormant evidence, not installed Action proof. None of these checks establishes runtime activation or an end-to-end live receipt. Generation-fenced webhook continuation passed exact-head Codeflare PR Checks at `c4b0cbc9` (run `35855161432`). The Conductor collector's scoped tests passed at `60257e1` (run `35857563056`), while that package workflow remained red for absent Action/publisher modules. Authenticated preparation and Pi remote selection passed exact-head PR Checks at `96d136a0` (run `35892316489`); the Action claim RED suite ran at `e4cbc923` (run `35896387844`) and its automated claim/Stop behavior passed exact-head PR Checks at `6812f243` (run `35903787791`). Earlier preparation checks `35890471868` and `35891520587` failed; the historical local Pi path carries bounded untrusted triage excerpts when a completed prior local round exists, otherwise explicitly reports unavailable evidence. The new dedicated remote path separately requires authenticated publisher readback, and neither an untrusted excerpt nor the precommit lifecycle checks establish clearance or an Action-redeemable handoff. Protected Action installer behavior had test-only RED at `00a213b5`; dormant proposal, pinned reusable-runtime validation and inactive protected-base trust passed exact-head Codeflare Test `36467842514` at `ef28440738b0ff095f697f072b8f60290dab7e48`. A real target-repository workflow installation, sandbox claim, independent publication, compiled production-owner execution and current-head Enterprise Integration proof remain pending.

**Status:** Planned

---

<a id="req-operator-054-protected-action-claim-and-stop-fence"></a>
### REQ-OPERATOR-054: Protected Action claim and Stop fence

**Intent:** The automatically triggered protected Action can start only its actor-bound prepared activity; session Stop and ambiguous responses cannot turn that handoff into unowned execution.

**Applies To:** User

**Acceptance Criteria:**

1. Only the exact signed protected caller and maintained reusable runtime together authorize the one-time prepared start for the current PR, human and session generation. <!-- @impl: src/operators/boundary-action-oidc.ts::verifyBoundaryActionOidc --> <!-- @impl: src/operators/review-boundary-claim.ts::claimVerifiedBoundaryAction --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.claimBoundaryPreparation --> <!-- @test: src/__tests__/operators/review-action-oidc.test.ts (REQ-OPERATOR-054: trusted Action OIDC run identity) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) --> <!-- @test: src/__tests__/operators/review-action-run.test.ts (REQ-OPERATOR-054: protected Action run and fresh GitHub PR context) --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-054: a verified run and attempt alone win the prepared exact revision once) --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (rejects redirected %s transport without consuming the protected handoff) -->
2. A D1 Stop intent closes claim and start admission for the exact session generation. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository.claimStop --> <!-- @impl: src/operators/review-boundary-claim.ts::claimVerifiedBoundaryAction --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-OPERATOR-054: Stop wins before claim or retains the exact Action activity until durable cancellation) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) -->
3. The exact Activity is durably cancelled before Stop confirmation or restart, even when admission responds late. <!-- @impl: src/operators/activity.ts::OperatorActivity.cancelBoundaryStart --> <!-- @impl: src/routes/session/boundary-stop.ts::fencePendingBoundaryStart --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) --> <!-- @test: src/__tests__/routes/boundary-stop.test.ts (Stop boundary admission fence) -->
4. A lost accepted claim response never redelivers start authority or creates a second Activity. <!-- @impl: src/operators/registry.ts::OperatorRegistry.claimBoundaryPreparation --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) -->
5. A lost Activity cancellation response preserves pending Stop until the exact durable fence is reconciled. <!-- @impl: src/routes/session/boundary-stop.ts::fencePendingBoundaryStart --> <!-- @impl: src/lib/session-repository.ts::D1SessionRepository --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: a lost durable cancellation response retains pending Stop until exact reconciliation) -->
6. The claim response carries the prepared context digest and session lifecycle generation. <!-- @impl: src/operators/review-boundary-claim.ts::claimVerifiedBoundaryAction --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) -->
7. Caller-supplied context digest or session generation cannot select claim authority. <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @test: src/__tests__/routes/operator-boundary-claim.test.ts (operator boundary claim route) -->

**Constraints:**

- No workflow dispatch, workflow-selected principal, cross-owner transaction, new scheduler, replay on lost response or candidate-controlled workflow.
- The parent keeps Access and GitHub credentials out of Action and child execution.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-053](#req-operator-053-enterprise-pr-boundary-review-handoff), [REQ-SESSION-018](session-lifecycle.md#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

**Verification:** The test-only RED suite ran at `e4cbc923` (PR Checks `35896387844`). Implementation heads `0818d60f`, `8f673c87`, `eff95b47` and `93ed85e8` failed exact-head CI; claim/Stop and restart tests passed exact-head PR Checks at `6812f243` (run `35903787791`). Protected Action sandbox claim remains unproven; this requirement remains Planned.

**Status:** Planned

---

<a id="req-operator-055-pr-wide-publication-ordering"></a>
### REQ-OPERATOR-055: PR-wide publication ordering

**Intent:** The trusted independent publisher cannot mistake a stale or ambiguous Review effect for current PR clearance.

**Applies To:** User

**Acceptance Criteria:**

1. The Registry admits journal effects only for the current claimed PR reservation, exact protected run/attempt and parent-verified terminal Activity drive generation. <!-- @impl: src/operators/registry.ts::OperatorRegistry.beginBoundaryPublication --> <!-- @impl: src/operators/review-boundary-claim.ts::operateBoundaryPublication --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-055: durable PR-wide publication ordering) --> <!-- @impl: src/operators/activity.ts::OperatorActivity.getBoundaryPublicationState --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-055: Activity publishes only non-driving collected terminal generation metadata) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-055: protected run and collected terminal drive alone reach the PR journal) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-055: changed protected controls invalidate a previously claimed publication) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-055: cancellation during GitHub verification fences journal admission) --> <!-- @test: src/__tests__/routes/operator-boundary-claim.test.ts (REQ-OPERATOR-055: trusted publication journal boundary) --> <!-- @test: src/__tests__/operators/review-action-oidc.test.ts (REQ-OPERATOR-055: publication OIDC uses its own audience under the same protected workflow identity) -->
2. Artifact, comment and shadow-check effects each retain an independent pending digest across Registry reconstruction. <!-- @impl: src/operators/registry.ts::OperatorRegistry.beginBoundaryPublication --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-055: durable PR-wide publication ordering) -->
3. Repeating a pending effect cannot authorize another write. <!-- @impl: src/operators/registry.ts::OperatorRegistry.beginBoundaryPublication --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-055: durable PR-wide publication ordering) -->
4. An exact external effect ID binds once to its immutable pending digest. <!-- @impl: src/operators/registry.ts::OperatorRegistry.completeBoundaryPublication --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-055: durable PR-wide publication ordering) -->
5. A lost completion acknowledgement retains the exact recorded ID without authorizing a replacement write. <!-- @impl: src/operators/registry.ts::OperatorRegistry.getBoundaryPublication --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.getBoundaryPublicationGuard --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-055: durable PR-wide publication ordering) -->
6. A newer PR reservation fences an older effect's completion. <!-- @impl: src/operators/registry.ts::OperatorRegistry.completeBoundaryPublication --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-055: durable PR-wide publication ordering) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-055: protected run and collected terminal drive alone reach the PR journal) -->

**Constraints:** The Registry stores only opaque effect digests and IDs, never credentials, findings or publication policy. No cross-owner transaction or lock spanning GitHub I/O. An old successful shadow check cannot itself clear the current PR.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-053](#req-operator-053-enterprise-pr-boundary-review-handoff), [REQ-OPERATOR-054](#req-operator-054-protected-action-claim-and-stop-fence)

**Verification:** Owner journal and protected route behavior passed exact-head Codeflare PR Checks `36165253903` at `1f59d8b142857490c81ed7a5560d781485627922`. The independent publisher's separate Conductor Test `36165671477` passed at `03ea03189df882deb58288106c09746f4cddc178`. Neither run proves installed protected Action execution or external publication readback.

**Status:** Planned

---

<a id="req-operator-056-independent-review-publication"></a>
### REQ-OPERATOR-056: Independent Review publication

**Intent:** A separate protected publisher uses original verified Review evidence and exact current GitHub identity to publish a non-authoritative shadow round.

**Applies To:** User

**Acceptance Criteria:**

1. Only the separate protected publisher holds publication credentials; Pi, candidate code and child cannot access them. <!-- @impl: .github/workflows/boundary-runtime.yml::publish --> <!-- @manual: Verify credential separation in a genuine protected PR Action run; live Action publication remains unproved. -->
2. Clearance requires original reports and independently verified GitHub history matching the authenticated reservation and terminal Activity. <!-- @impl: src/operators/review-boundary-claim.ts::prepareBoundaryPublication --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-056: authenticated publication-preparation projection) -->
3. One immutable artifact retains canonical terminal evidence and original reports under exact repository, revision, run and Activity identity. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: exact projection and journal allow one authenticated artifact, comment and shadow check) -->
4. A round comment binds that generation and artifact digest without discarding unresolved findings. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: a completed review with unresolved findings publishes only a failing check) -->
5. A generation-specific shadow check binds exact external IDs and immutable content digest. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: exact projection and journal allow one authenticated artifact, comment and shadow check) -->
6. Red, partial, missing or incomplete evidence never publishes green. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: a completed review with unresolved findings publishes only a failing check) -->
7. Current-context verification prevents an old check clearing a newer revision. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: a changed PR revision after comment publication fences the old shadow check) -->

**Constraints:**

- The projection freezes admission policy and round identity, invocation and package/resource digests, accepted packet descriptors, owned-session initialization and consumed terminal-result digest.
- The parent supplies only identity and evidence; the package publisher interprets Review lanes and history.
- Bounded parent-authenticated fixed-operation history reads never pass a GitHub bearer to the child. <!-- @impl: src/operators/review-history-transport.ts::createAuthenticatedHistoryTransport --> <!-- @test: src/__tests__/operators/review-history-transport.test.ts (REQ-OPERATOR-050/056: parent-only fixed GitHub history reads) -->
- Publication uses the credential-free [REQ-OPERATOR-055](#req-operator-055-pr-wide-publication-ordering) journal but never treats its receipt alone as GitHub evidence.
- Actions concurrency and matching check names are not serialization or clearance proofs.
- Required-check activation and production deployment need separate explicit authorization.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-053](#req-operator-053-enterprise-pr-boundary-review-handoff), [REQ-OPERATOR-055](#req-operator-055-pr-wide-publication-ordering)

**Verification:** Codeflare's frozen-owner projection and route passed PR Checks `36165253903` at `1f59d8b142857490c81ed7a5560d781485627922`. Conductor's publisher, artifact/history reader and ledger tests passed Test `36165671477` at `03ea03189df882deb58288106c09746f4cddc178`. The workflow is not installed; there is no live protected job, exact-ID GitHub receipt or shadow clearance proof. This requirement remains Planned.

**Status:** Planned

---

<a id="req-operator-064-protected-review-enrollment-and-discovery"></a>
### REQ-OPERATOR-064: Protected Review enrollment and discovery

**Intent:** Enrollment and origin discovery remain separate from activation and human authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. Authorized administrators propose fixed-origin protected workflows through reviewed PRs. <!-- @impl: src/operators/boundary-action-installation.ts::proposeBoundaryWorkflow --> <!-- @test: src/__tests__/operators/boundary-workflow-enrollment.test.ts (creates a reviewable protected-workflow proposal without enabling Review or writing the protected base) -->
2. Only exact protected-base bytes and valid runtime identity permit verification. <!-- @impl: src/operators/boundary-action-installation.ts::verifyBoundaryWorkflow --> <!-- @test: src/__tests__/operators/boundary-workflow-enrollment.test.ts (refuses a moved protected head, unexpected workflow bytes and a revoked admin before binding) --> <!-- @test: src/__tests__/operators/boundary-workflow-enrollment.test.ts (rejects a pinned runtime that has named jobs but cannot execute collection or publication) -->
3. Verification persists inactive trust and cannot mint start authority. <!-- @impl: src/operators/boundary-action-installation.ts::verifyBoundaryWorkflow --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.getBoundaryAction --> <!-- @test: src/__tests__/operators/review-boundary-action-trust.test.ts (REQ-OPERATOR-053: an explicitly inactive verified workflow leaves local review available without granting claim trust) -->
4. Pending proposals, moved bases and denied writes cannot install trust. <!-- @impl: src/operators/boundary-action-installation.ts::verifyBoundaryWorkflow --> <!-- @test: src/__tests__/operators/boundary-workflow-enrollment.test.ts (creates a reviewable protected-workflow proposal without enabling Review or writing the protected base) --> <!-- @test: src/__tests__/operators/boundary-workflow-enrollment.test.ts (fails closed on missing sdd, unprotected/wrong base, absent workflow-write permission and denied write) -->
5. Lost accepted enrollment writes reconcile exact receipts. <!-- @impl: src/operators/boundary-action-installation.ts::proposeBoundaryWorkflow --> <!-- @test: src/__tests__/operators/boundary-workflow-enrollment.test.ts (reconciles exact accepted branch, workflow and PR after lost responses without another target PR) -->
6. Generic edits and unrelated branch changes cannot forge protected workflow identity. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @impl: src/operators/boundary-action-installation.ts::proposeBoundaryWorkflow --> <!-- @test: src/__tests__/operators/boundary-workflow-enrollment.test.ts (refuses to propose an existing branch containing unrelated changes) --> <!-- @test: src/__tests__/operators/boundary-workflow-enrollment.test.ts (creates a reviewable protected-workflow proposal without enabling Review or writing the protected base) -->
7. Platform-admin registration accepts protected pull_request_target only. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-053: accepts protected pull_request_target registration only for a platform admin with CSRF protection) -->

**Constraints:**

- Existing parent authority and original deadlines remain mandatory; no activation or new principal is implied.
- Detailed preserved wire and fencing clauses remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-053](#req-operator-053-enterprise-pr-boundary-review-handoff)

**Verification:** Automated test: [boundary-workflow-enrollment.test.ts](../../src/__tests__/operators/boundary-workflow-enrollment.test.ts), [review-boundary-action-trust.test.ts](../../src/__tests__/operators/review-boundary-action-trust.test.ts), [operator-access.test.ts](../../src/__tests__/operators/operator-access.test.ts), [operator-boundary-action.test.js](../../host/__tests__/operator-boundary-action.test.js), [operator-boundary-claim.test.ts](../../src/__tests__/routes/operator-boundary-claim.test.ts), [review-boundary-claim.test.ts](../../src/__tests__/operators/review-boundary-claim.test.ts).

**Status:** Planned

---

<a id="req-operator-072-protected-review-registration-and-discovery-fences"></a>
### REQ-OPERATOR-072: Protected Review registration and discovery fences

**Intent:** Registration security and non-consuming discovery do not activate execution or mint authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. Registration rejects workflow_dispatch and unsupported events. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-053: accepts protected pull_request_target registration only for a platform admin with CSRF protection) -->
2. Registration requires CSRF protection. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-053: accepts protected pull_request_target registration only for a platform admin with CSRF protection) -->
3. Concurrent audience-bound probes select exactly one affirmative fixed origin within ten seconds. <!-- @impl: scripts/operator-boundary-action.mjs::selectBoundaryOrigin --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-053: exactly one observed affirmative selects its fixed origin despite an errored or timed-out peer) -->
4. Authenticated actor-bound discovery cannot consume a handoff or return capabilities. <!-- @impl: src/operators/review-boundary-claim.ts::discoverVerifiedBoundaryAction --> <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @test: src/__tests__/routes/operator-boundary-claim.test.ts (REQ-OPERATOR-053: non-consuming protected Action discovery route) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-053: discovers a verified actor-bound match without consuming start authority) --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (rejects redirected %s transport without consuming the protected handoff) -->

**Constraints:** Existing parent authority and original deadlines remain mandatory; no activation or new principal is implied, and preserved wire/fencing clauses remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-064](#req-operator-064-protected-review-enrollment-and-discovery)

**Verification:** Automated tests at the adjacent registration, concurrent origin-probe and non-consuming discovery anchors; live protected Action and final exact-head CI remain unverified.

**Status:** Planned

---

<a id="req-operator-065-actor-bound-review-evidence-and-reassessment"></a>
### REQ-OPERATOR-065: Actor-bound Review evidence and reassessment

**Intent:** Published evidence and rejected findings remain independently authenticated and advisory.

**Applies To:** User

**Acceptance Criteria:**

1. Only the current actor/session may read its associated immutable published Review through existing repository access. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @impl: src/operators/review-history-transport.ts::readPublishedReview --> <!-- @test: src/__tests__/operators/review-published-result.test.ts (REQ-OPERATOR-053/056: independently published original Review evidence) -->
2. Reads independently authenticate publisher, workflow, run and artifact receipts, including complete bounded pages. <!-- @impl: src/operators/review-history-transport.ts::readPublishedReview --> <!-- @impl: src/operators/review-history-transport.ts::readGithubActionsPublisherIdentity --> <!-- @test: src/__tests__/operators/review-history-transport.test.ts (projects authenticated artifact pages completely for the compiled reader without silently truncating) -->
3. Incomplete, unavailable or foreign evidence cannot appear as empty successful findings or clearance. <!-- @impl: src/operators/review-history-transport.ts::readPublishedReview --> <!-- @impl: preseed/agents/pi/extensions/operator-review-remote.ts::registerOperatorReviewRemote --> <!-- @test: src/__tests__/operators/review-published-result.test.ts (REQ-OPERATOR-053/056: independently published original Review evidence) --> <!-- @test: src/__tests__/lib/operator-review-remote.test.ts (REQ-OPERATOR-053: dedicated remote Operator Review result consumer) -->
4. Result reads never start work or mint authority. <!-- @impl: src/operators/review-history-transport.ts::readPublishedReview --> <!-- @test: src/__tests__/operators/review-boundary-result.test.ts (REQ-OPERATOR-053/056: read-only authenticated Review publication projection) -->

**Constraints:**

- Existing parent authority and original deadlines remain mandatory; no activation or new principal is implied.
- Detailed preserved wire and fencing clauses remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-053](#req-operator-053-enterprise-pr-boundary-review-handoff)

**Verification:** Automated publication-reader and read-only projection tests at the adjacent anchors. Current-head reader regressions and live publication receipts remain pending.

**Status:** Planned

---

<a id="req-operator-074-finding-linked-rejection-and-independent-reassessment"></a>
### REQ-OPERATOR-074: Finding-linked rejection and independent reassessment

**Intent:** Authenticated disagreement preserves the original finding for independent next-round reassessment rather than granting caller clearance.

**Applies To:** User

**Acceptance Criteria:**

1. Finding-linked rejection records bind the same session, repository, PR and later head. <!-- @impl: preseed/agents/pi/extensions/operator-review-remote.ts::registerOperatorReviewRemote --> <!-- @test: src/__tests__/lib/operator-review-remote.test.ts (transmits only a matching published rejection on %s) -->
2. Rationale is bounded and publication references are independently verified. <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @test: src/__tests__/operators/conductor-production-packet.test.ts (rejects mismatched publication references and extraneous authority fields before sealing) -->
3. The parent rejects forged, omitted, truncated or duplicate references before packet persistence. <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @test: src/__tests__/operators/conductor-production-packet.test.ts (rejects mismatched publication references and extraneous authority fields before sealing) -->
4. Each accepted rejection retains its independently verified original finding. <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @test: src/__tests__/operators/conductor-production-packet.test.ts (puts an independently authenticated prior finding in the actor-bound approved packet) -->
5. Only independent next-round reassessment may resolve a prior finding; caller disagreement alone never supplies clearance. <!-- @impl: src/__tests__/operators/fixtures/conductor-review.generated.json::reconcileProtectedReviewHistory --> <!-- @test: src/__tests__/operators/review-connected-lifecycle.test.ts (connects protected collection through authenticated Pi rejection and compiled next-round reassessment) -->

**Constraints:**

- Reassessment policy remains package-owned; see [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details) for the packaged-source trace.
- Existing parent authority and original deadlines remain mandatory; no activation or new principal is implied.
- Detailed preserved wire and fencing clauses remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-053](#req-operator-053-enterprise-pr-boundary-review-handoff)

**Verification:** Automated test: [review-published-result.test.ts](../../src/__tests__/operators/review-published-result.test.ts), [review-connected-lifecycle.test.ts](../../src/__tests__/operators/review-connected-lifecycle.test.ts), [review-history-transport.test.ts](../../src/__tests__/operators/review-history-transport.test.ts), [review-boundary-result.test.ts](../../src/__tests__/operators/review-boundary-result.test.ts), [operator-review-remote.test.ts](../../src/__tests__/lib/operator-review-remote.test.ts), [conductor-production-packet.test.ts](../../src/__tests__/operators/conductor-production-packet.test.ts).

**Status:** Planned

## Renovate assessment and separately fenced publication

<a id="req-operator-051-renovate-dispatcher-assessment"></a>
### REQ-OPERATOR-051: Renovate Dispatcher assessment

**Intent:** A directed Dispatcher performs bounded read-only Renovate PR and CI assessment.

**Applies To:** User

**Acceptance Criteria:**

1. Admitted read-only assessment receives bounded PR, check and secret-safe diff evidence through parent authorization; package policy selects eligible bot changes. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @impl: src/operators/dispatcher-compose-projection.ts::projectDispatcherFiles --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (passes only complete image deltas from PR files, never secret-bearing patch context or other changes) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (sends the parent-owned GitHub REST User-Agent for both bounded PR and files reads) -->
2. Compiled recommendations bind observed heads; stale, truncated or insufficient evidence remains unknown rather than implying compatibility. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (binds a two-turn research→submit $name decision to pinned parent receipts) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (records unknown for $name rather than inventing compatibility or mutating) -->
3. Assessment cannot mutate repositories, create sessions/containers or trigger unattended reruns. <!-- @impl: src/operators/activity.ts::OperatorDispatcherCapability --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (denies foreign resources, unknown routes, oversized input and foreign/root scheduling while allowed reads work) -->
4. Upstream release evidence must derive from complete admitted image changes and immutable PR revisions; unknown or changed sources cannot establish compatibility. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (reads one cited upstream release for thirteen compose image changes of Komodo #1299) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (derives a later eligible upstream release from the admitted PR rather than hardcoding #1299) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (rejects release evidence when the PR head changes after the files read) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (rejects release evidence when the PR head changes during the upstream read) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (does not return late upstream notes even when a transport ignores abort) --> <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @test: src/__tests__/github-interceptor.test.ts (cancels the credentialed upstream request when the authorized caller deadline expires) --> <!-- @test: src/__tests__/github-interceptor.test.ts (stops an upstream response body when the authorized caller deadline expires) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (carries a cited release receipt through the pinned compiled Dispatcher and parent read bridge) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (does not call an omitted Compose patch proof of no upstream change) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (does not fetch upstream for) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (rejects unverified, redirecting or oversized upstream notes) -->
5. Configuration evidence binds complete changed Compose files to immutable blobs and returns only secret-safe projections; unchanged configuration does not prove understood compatibility. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @impl: src/operators/dispatcher-compose-projection.ts::projectChangedCompose --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (projects version-relevant default server and agent configuration without disclosing stable private values) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (does not hide harmless unchanged ports and Docker socket mounts on a default server) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (keeps $name unresolved despite unchanged image-excluded configuration) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (rejects $name changed Compose provenance) -->
6. Official guide evidence binds the admitted version to an observed immutable commit; child-selected sources, redirects and late or incomplete reads deny evidence. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (reads an immutable version-tagged official agent guide through a fixed parent source) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (also binds a lightweight tag directly to a pinned guide commit) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (rejects a $name without exposing a guide to the child) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (rejects a late guide even when the upstream transport ignores abort) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (denies child-selected guide URL, repository and ref before upstream I/O) -->

**Notes:** Evidence history and acceptance limitations remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Constraints:** Assessment is read-only and remains bound to the admitted activity.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution)

**Verification:** Assessment test-only RED at `ba7cf5c1` dispatched ordinary Test `36416699933`; the existing bounded release-read slice previously passed. RED runs `36409071181` and `36410197692` failed intended parent release-evidence cases; parent correction exact-head Test `36410922334` passed at `72456a74`. Dispatcher package Test `36411884907` passed at `453d14f`, and its missing-patch correction passed `36412984001` at `2d8df70`; compiled-bridge RED run `36411798335` failed its missing-citation assertion at `f385d6c3`. A second test-only run `36412555479` could not reach its added missing-patch case after that prior failure. The pinned compiled child and parent evidence tests passed Codeflare exact-head Test `36413314483` at `bcf083d0` (cited release and omitted-patch unknown outcomes). Dispatcher package Test `36419749747` passed at `ae5a050`; Codeflare's prior structured-declaration candidate `aba3428a` passed exact-head Test `36422322395`, including privacy and incomplete-settlement fencing. That candidate did not establish normal upstream-prose reasoning; corrected test-only RED heads `fda6de6` (Dispatcher `36425054534`) and `109e0420` (Codeflare `36425083563`) failed the intended cases. Dispatcher exact-head Test `36426967071` passed 36 tests at `838086026f6a859db822fa04fce5a56ce24ce344`; its official compiled bundle SHA-256 is `59657efc915abc07c707725f00066779a575feb609d3c2d80bdd349ea1a10ac4`. Codeflare compiled-parent Test `36429791230` passed node-native, node-Flue, backend shard-5, Typecheck and aggregate at `17313b1b5ddd4846893b1fae3550c7336e79ca5a`. Live #1299 assessment and any conditional effect are separate, still-unverified gates.

**Status:** Implemented

---

<a id="req-operator-060-fenced-renovate-publication"></a>
### REQ-OPERATOR-060: Fenced Renovate publication

**Intent:** A parent-owned publisher may act on an already-persisted Dispatcher assessment only under a fresh, explicit, owner-bound admin-session command. Assessment and result reads remain read-only.

**Applies To:** Admin

**Acceptance Criteria:**

1. Only a fresh authenticated owner-admin command on an explicitly selected active session generation may publish an admitted Activity assessment. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @impl: src/lib/access.ts::operatorAccessSessionCurrent --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-060: explicit authenticated publisher admission) --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->
2. Expiry, logout, Stop, revoked grants, changed installation or changed session fence every write; child capabilities and result reads cannot publish. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @impl: src/lib/access.ts::operatorAccessSessionCurrent --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-060: explicit authenticated publisher admission) --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->
3. Write targets and judgment come from admitted immutable Activity evidence, never caller/model-selected targets. <!-- @impl: src/operators/renovate-publication.ts::renovateGithub --> <!-- @impl: src/operators/renovate-publication.ts::parsePublishableAssessment --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (binds a two-turn research→submit $name decision to pinned parent receipts) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (collects the settled pinned assessment once as a terminal result without another submission) --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060: rejects absent, malformed, flattened or contradictory Dispatcher assessments before writes) --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->
4. Unsafe or unknown assessments may produce bounded comments only; approval and merge require a cited safe compiled assessment. <!-- @impl: src/operators/renovate-publication.ts::renovateGithub --> <!-- @impl: src/operators/renovate-publication.ts::parsePublishableAssessment --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (binds a two-turn research→submit $name decision to pinned parent receipts) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (collects the settled pinned assessment once as a terminal result without another submission) --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060: rejects absent, malformed, flattened or contradictory Dispatcher assessments before writes) --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->
5. Every comment requires current repository/PR/bot identity, base/head revisions and protected publication permission; unavailable or ambiguous identity/current authority denies comments, but failed merge checks do not suppress authorized explanatory comments. <!-- @impl: src/operators/renovate-publication.ts::renovateGithub --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->
6. Every effect reserves an exact-generation durable intent before the external write. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->
7. Merge supplies the admitted expected head SHA. <!-- @impl: src/operators/renovate-publication.ts::renovateGithub --> <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->

**Constraints:** Authority remains owner/session-bound; uncertain effects cannot replay.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-051](#req-operator-051-renovate-dispatcher-assessment)

**Verification:** Test-only RED `8c4c6af0` failed the intended publisher and route cases in PR Checks `36432738228`. Final code head `7006520a9b00a8ee9982f287fda886d7ee0458c8` passed PR Checks `36436401592`, including backend publisher and route tests, node-native/Flue, Typecheck and aggregate. The pinned compiled-output interoperability RED at `4335bb313ad6485f9bb8b78e46c27b02a24b2307` failed the expected parser and publisher cases in PR Checks `36505023626`. The first correction `4ab7ada6` failed PR Checks `36505696468` only because the prospective-scan test still injected a flattened synthetic child result; the fixture was corrected without relaxing the publication boundary. Exact-head `b5c5e30d90fce91fbd999a2473f07f9bd1972b1c` passed PR Checks `36506071749`, including Node-Flue, backend shards 3 and 7, Typecheck and aggregate. The compiled producer-to-parser assertion, synthetic settled snapshot through real Activity collection, and real publisher against mocked GitHub effects are complementary, not a single live end-to-end run. No live Komodo #1299 assessment, comment, approval, merge, activation or deployment occurred. The prospective post-cutoff scheduler remains separate.

**Status:** Implemented

---

<a id="req-operator-071-renovate-publication-policy-and-reconciliation"></a>
### REQ-OPERATOR-071: Renovate publication policy and reconciliation

**Intent:** Protected approval/merge policy and uncertain-effect reconciliation remain independent of explanatory comment admission.

**Applies To:** Admin

**Acceptance Criteria:**

1. Prospective write targets require exact separate Registry admission proof. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-061: prospective publication is tied to a fresh exact Registry admission and current owner session) -->
2. Duplicate or uncertain responses reconcile exact-generation receipts without blind replay. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (reconciles an ambiguous comment by its durable external marker without reposting it) --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (retains an unattributed merged readback after a lost merge response without replay) -->
3. Base revisions are rechecked immediately before merge. <!-- @impl: src/operators/renovate-publication.ts::renovateGithub --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->
4. The base cannot be atomically frozen; residual races are disclosed rather than attributed as certainty. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (retains an unattributed merged readback after a lost merge response without replay) -->
5. Approval/merge additionally require compatible checks/statuses, reviews, applicable rules and mergeability; incomplete or ambiguous policy evidence denies those phases, not otherwise authorized explanatory comments. <!-- @impl: src/operators/renovate-publication.ts::renovateGithub --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-060) -->

**Constraints:** All owner/session/current-human and assessment gates of [REQ-OPERATOR-060](#req-operator-060-fenced-renovate-publication) remain mandatory; neither children nor result reads acquire publication authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-060](#req-operator-060-fenced-renovate-publication)

**Verification:** Automated test: [renovate-publisher.test.ts](../../src/__tests__/operators/renovate-publisher.test.ts). Concurrency/restart and phase-specific regression execution at the final head remain pending; historical receipt details remain in [Operator Interface](../../documentation/lanes/operators.md#fenced-renovate-publication).

**Status:** Implemented

---

<a id="req-operator-061-prospective-admin-session-renovate-scan"></a>
### REQ-OPERATOR-061: Prospective admin-session Renovate scan

**Intent:** An explicitly activated, session-owned hourly scan admits only new, verified Komodo Renovate PRs; the supported repository-only package selects its own effects within exact parent-fenced target authority. Legacy read-only assessment/publication remains separate.

**Applies To:** Admin

**Acceptance Criteria:**

1. Explicit current owner-admin activation binds the selected installation and active session generation to an immutable server cutoff. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-061: only a current authorized admin session can activate an immutable server-timed Komodo scan) --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (REQ-OPERATOR-061: durable prospective activation and admission) -->
2. Hourly observation admits only verified open Renovate PRs created after cutoff, including offline arrivals; complete pages are mandatory and uncertain observations skip admission. <!-- @impl: src/container/index.ts::container --> <!-- @impl: src/operators/renovate-prospective.ts::listProspectiveRenovatePrs --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061: an armed admin-session callback scans complete post-cutoff Komodo pages) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061: a lost scheduler acknowledgement is reconciled without creating another hourly callback) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061/048: a winning scan retains repository-only admission) -->
3. Current human, grant, installation and session authority gate durable admission. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @impl: src/container/index.ts::container --> <!-- @impl: src/operators/operator-runtime-capability.ts::authorizeDispatcherPlan --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (REQ-OPERATOR-061: durable prospective activation and admission) --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (fences Activity-bound read/inference authority) -->
4. Current-package effects require exact admission proof, admitted target and fresh parent authority; the package selects domain decisions/comments/merges. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048/061/062/071: repository-only prospective parent authority) -->

5. Failed scheduling acknowledgement cannot report successful activation; retry preserves the original cutoff. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061: a lost scheduler acknowledgement is reconciled without creating another hourly callback) -->
6. Concurrent valid actors elect one stable Activity/actor/session/generation identity. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (REQ-OPERATOR-061: durable prospective activation and admission) -->
7. Uncertain preparation/starts reconcile that same identity without replacement work or a changed actor. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061/048: a winning scan retains repository-only admission) -->

**Constraints:**

- Only the declared supported first-party intent3 contract may activate; repository-only input alone does not prove support. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (REQ-OPERATOR-061: durable prospective activation and admission) -->
- Authority remains owner/session-bound; uncertain effects cannot replay. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-061: prospective publication is tied to a fresh exact Registry admission and current owner session) -->
- Legacy assessed-publication retains its separate publisher gates. <!-- @impl: src/operators/renovate-publication.ts::renovateGithub --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-061: prospective publication is tied to a fresh exact Registry admission and current owner session) -->

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-051](#req-operator-051-renovate-dispatcher-assessment), [REQ-OPERATOR-060](#req-operator-060-fenced-renovate-publication)

**Verification:** Exact-head PR Checks `36490796134` at `188aee1162326fe817dfa11e745cf32e9dbdb500` passed Typecheck, backend Container, Registry, publisher and route shards, and the aggregate gate after test-only RED run `36485684846` failed on absent behavior. Tests exercise authenticated activation, concurrent durable admission, the scheduled callback contract with simulated SDK delivery, lost scheduling/start responses, an unchanged uncertain Activity, the real Activity collector on a synthetic settled-waiting snapshot, Activity-bound read/inference revocation and restricted publication. The connected fixture substitutes the child settlement and does not run a compiled Dispatcher, prove model judgment, activate scanning or demonstrate a naturally arriving post-activation Komodo PR; those remain separate acceptance boundaries.

**Status:** Implemented

<a id="operator-registry-contract"></a>
## Normative appendix: Operator Registry contract

This appendix retains the shared registry, management API, package and directed-profile contract formerly owned by `operator-registry-contract.md`. It adds no authority, backend or public behavior. Codeflare owns generic Interface, Loader, lifecycle, resources, sessions, synchronization, GitHub/inference boundaries and publication fencing; Conductor owns Review business behavior. Codeflare retains generic host-side Pi sandbox/security confinement and distributes the Conductor Review Pi extensions, skills and references used for per-repository GitHub Actions. No Review-specific Activity or adapter is introduced.

The original “frozen before RED” timing is historical, not a claim that later requirements are absent. REQ-OPERATOR-002/013/032/039 supersede the old summary that endpoint registration and Gate 1 remain unchanged: historical internal records/default-entrypoint compatibility remain, while legacy HTTP administration and new Gate 1 execution are retired. REQ-OPERATOR-062 extends repository-only transport and exact prospective target fencing; current package-owned effects do not relax the retained read-only legacy assessment or its independently fenced parent publisher. Verification/status qualifiers in each record remain unchanged.

<a id="records"></a>
### Records

The complete original shared data shapes are retained, with the already-delivered optional response allowance added to the policy shape. These are shared records, not permission grants or an exhaustive serialization of every private helper.

```ts
type OperatorProfile = 'conductor' | 'dispatcher';
type OperatorRealm = 'internal' | 'external';
type OperatorGrant = { users: string[]; groups: Array<{ issuer: string; id: string }> };
type GitHubReleaseSource = {
  kind: 'github-release'; repositoryUrl: string; repositoryId: number;
  credentialConfigured: boolean; approvedWorkflow: { id: number; ref: string };
};
type OperatorRelease = {
  id: string; operatorId: string; githubReleaseId: number; sourceCommit: string;
  manifestDigest: string; bundleDigest: string; interfaceVersion: 1; approved: boolean;
};
type OperatorInstallation = {
  id: string; operatorId: string; name: string; releaseId: string | null;
  revision: number; enabled: boolean;
  policy: { capabilities: string[]; resourceProfileId: string | null; sourceResponseBytes?: number };
};
```

The acquisition PAT is registration/source-replacement input only, write-only and never returned. Repository URL is also validated input but remains public source metadata; it is not a secret. Release approval and enablement are separate. Retained default-entrypoint state uses its compatibility adapter and cannot reinstate retired registration routes or Gate 1.

Current retained release metadata includes verified `tagName?: string` and `publishedAt?: string`; older gaps remain distinguishable. Name/description are verified display projections, not changes to immutable release identity. REQ-OPERATOR-044/049/066 preserve those semantics. Current installation RPC stores configuration as bounded `configurationJson: string` and public readback parses it into the configuration object; this does not replace the shared policy/revision/release shape.

<a id="management-api"></a>
### Management API

All routes are Enterprise-only and reauthorize server-side. Unknown fields fail validation. List results are authorization-filtered and use `{ items, cursor }` with default 50/max 100.

One admin-owned control record lives in the existing OperatorRegistry:

```ts
{ revision: number, managers: OperatorGrant,
  ceiling: { capabilities: string[], resourceProfileIds: string[], sourceResponseBytes?: number } }
```

Missing controls mean revision 0 and empty grants/ceiling. Only a current verified human platform admin may read/change this record. Other managers need its explicit eligibility grant AND the operator's manager grant; request-body ACLs cannot grant global eligibility. Verified platform-admin management authority is preserved, but ceiling restrictions apply to everyone. A null resource profile requests no profile; other IDs and capabilities must be within the ceiling, and installation policy must only narrow its operator. Recheck controls/current grants after upstream I/O and CAS the controls revision with target mutations; no separate ACL service or hierarchy.

The optional `sourceResponseBytes` field is an integer from 1 through 1048576 in current management validation. Every omitted value means1048576 (1 MiB), including older saved records; installation allowance ≤ operator allowance ≤ Environment ceiling, without implicit raised inheritance or clamping. Edits preserve pins, scope, grants and saved installation policies, disable enabled installations and require explicit re-enablement. Out-of-ceiling policies cannot be enabled or admitted. The source allowance does not increase request, inference, result or SDK-history bounds.

The three byte fields default to1048576 (1 MiB), not extra model context. Input-adjacent autorenew icons reset drafts to these defaults; saving uses the same authorization, validation and revision fences. Confirmed source-response failures tune installation allowance first, then operator/Environment ceilings if necessary; inference body-limit failures tune operator input bytes. Token-context, authentication and SDK-history failures need separate remedies. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045/049: explains limit ownership and resets inference to its default without changing other fields) -->

| Method and route | Body / result |
|---|---|
| `GET /api/operator-management/access` | admin-only global management-control record |
| `POST /api/operator-management/access` | admin-only `{ revision, managers, ceiling }` → revision-CAS control record |
| `GET /api/operator-management/operators` | filtered catalog; query `cursor`, `limit`, `query`, `profile`, `realm`, `state` |
| `POST /api/operator-management/operators` | `{ repositoryUrl, githubPat, profile, realm, managers, invokers, policy }` → disabled operator projection; omitted `realm` defaults to `internal` |
| `GET /api/operator-management/operators/:operatorId` | operator, releases, installations and grants, never PAT/ciphertext |
| `POST /api/operator-management/operators/:operatorId/source` | `{ revision, repositoryUrl, githubPat }` → operator projection; source/trust change invalidates approval; PAT remains write-only |
| `POST /api/operator-management/operators/:operatorId/releases/refresh` | `{ revision }` → discovered releases only; reload detail for the new revision |
| `POST /api/operator-management/operators/:operatorId/installations` | `{ name, policy, revision, configuration? }` → disabled installation; omitted configuration is `{}` |
| `POST /api/operator-management/installations/:installationId/configure` | `{ revision, policy, configuration }` → installation; configuration JSON bounded to 64 KiB |
| `POST /api/operator-management/installations/:installationId/promote` | `{ releaseId, revision }` → approved pinned disabled installation |
| `POST /api/operator-management/installations/:installationId/enable` | `{ revision, enabled }` → installation |
| `POST /api/operator-management/operators/:operatorId/grants` | `{ managers, invokers, revision }` → operator projection |
| `POST /api/operator-management/operators/:operatorId/capabilities` | `{ revision, capabilities, sourceResponseBytes?, inferenceRequestBytes?, operationLimit? }` → scoped operator projection; Dispatcher-only inference bytes/operation capacity, preserved installation policies, changed limits disable enablement |
| `GET /api/operator-management/options` | authorized configured users, verified issuer-bound groups and limits; non-admin managers do not receive the full directory |

Outcomes use existing error envelopes: validation 400, unauthenticated 401, denied/non-enumerating 404, conflict 409, unavailable/upstream failure 503. CSRF-protected mutation failure may return the existing 403; the old outcome summary is not an exhaustive status-code allowlist. A public invocation cannot select human identity, resource authority, source credentials, publisher authority or arbitrary artifact URLs. Management's explicitly authorized source input and bounded policy resource IDs are not prohibited by that invocation restriction. Realm remains compatibility metadata: the UI does not make it a security choice, even though the API retains the field/query for compatibility.

Installed invocation uses existing `POST /api/operator-activities` with `{ installationId, invocation }`, returning the existing prepared activity/start-capability envelope. The parent resolves installation/release/profile/configuration and verifies independent invocation rights before admission. Legacy `{ operatorId, invocation }` remains a compatibility shape for retained registrations; alternatives are exclusive, and retired Gate 1 is denied before I/O. Neither path accepts execution identity, profile or resource authority from the caller.

Protected Review enrollment/discovery/claim and publication remain separately governed by REQ-OPERATOR-053–056/064/072, not release provenance. No management shape can forge an activated protected binding.

<a id="parent-capability-operations"></a>
### Parent capability operations

The platform derives identity, input digest, release, installation and resource scope before loading a package. A package receives only its profile-specific fetcher. Package-owned Flue/Renovate execution receives activity-scoped parent primitives and the fixed non-authorizing diagnostic below. Existing `/v1/dispatcher/renovate` start/progress semantics select the admitted package operation; they are not a parent implementation of the model/tool loop. The generic Conductor uses REQ-OPERATOR-050's owned-session boundary, not Dispatcher session authority.

Dispatcher production requests use `https://operator.internal` and JSON bodies. Inference uses the admitted operator's `inferenceRequestBytes`, default1MiB, configurable through `Number.MAX_SAFE_INTEGER`; platform limits still apply. Other request bytes retain the 64 KiB ceiling. Default primitive responses remain 64 KiB; only the repository-only source-response allowance below is separately configurable. An Activity retains at most its originally admitted operator operationLimit records (default1024); completed response bodies are separate bounded storage values. Lost, oversized or upstream-uncertain completion fences the lease and is never replayed, with REQ-OPERATOR-062's explicit authorized readback resolution for unknown mutations. A non-null Dispatcher resource profile is rejected until an existing parent resource resolver supports it; this slice adds no resolver or setting for one.

- `POST /v1/dispatcher/github/read`: the original wire `{ operationId, resource: "pull-request" | "files" | "checks" }` remains for legacy admitted repository/PR reads. The parent confirms Renovate login/ID and observed head; files are bounded to the first 100-item page and checks to at most 100 in bounded 10-run pages, returning `{ data, observedHead, truncated }`. Incomplete/overlapping/over-limit pages cannot claim complete evidence. Installation must permit `fetch`. Already-delivered read resources also include `release-notes`, `upstream-guide`, `changed-compose` and `open-pull-requests`; optional target is `{ pullRequest: positive safe integer, headSha: lowercase 40-hex SHA }`, or the corresponding optional top-level fields, never both forms. Discovery forbids target fields. Fixed-PR invocation cannot select another PR; repository-only targeted reads require a head. These compatibility routes do not make a generic child-selected crawler out of the legacy projections.
- `POST /v1/dispatcher/inference`: `{ operationId, input: { messages, tools?, tool_choice?, max_tokens?, temperature?, stream?, stream_options? } }`. Messages contain 1–128 JSON values, tools at most 32. `max_tokens` is an integer 1–8192 (default 8192); temperature is 0–2; stream is boolean; if present `stream_options` is exactly `{ include_usage: true }`. The installation must permit `inference`. The parent selects only the current human default eligible route/reasoning and sends OpenAI Chat Completions wire through `LlmInterceptor`; no child-selected model, identity, token, URL or headers are forwarded. Trusted stable Activity ID is the existing native inference replay namespace, not a workspace session or additional permission.
- `POST /v1/dispatcher/diagnostic`: exact `{ "stage": "fetch-rejected" }` or `{ "stage": "http-rejected", "status": 300..599 }`. At most 256 bytes are read within 250 ms and at most eight valid reports per live Activity instance/generation are logged with binding-trusted identity. It creates no protected receipt, renewal, replay, settlement or result. Tail is separately filtered and supplementary. Malformed, stale and unauthorized reports fail closed; no child error text, model input or provider body is forwarded.
- The capability's only RPC methods are the nine pinned Agents facet schedule/list/cancel, keepalive and fiber-registration methods. Paths must name the exact Activity and fixed `dispatcher` facet. Only Flue's `__flueWakeAgentSubmissions` callback is schedulable, with bounded timing/counts; root callbacks and foreign paths are denied. No direct egress or unrestricted parent namespace is supplied. For legacy code outbound is null; repository-only code may use the parent-authorized standard-fetch adapter, not direct networking.

The parent rejects unknown routes, mismatched activity/generation, expired/cancelled authority, changed operation digest and capability/resource requests outside installed policy. Dispatcher routes never create or expose a session/container. Outcomes are bounded and structured; upstream credentials remain parent-owned. Legacy comment/merge and separately fenced publisher contracts stay separate from generic transport; parsing a route never grants an effect.

### Repository-only source, receipt and resolution wire

Repository-only input remains `{ "repository": "owner/repository" }`, not a new context endpoint or user setting. The Loader supplies only `env.OPERATOR`, validated non-secret `env.GITHUB_API_ORIGIN` derived from existing `GITHUB_API_HOST` (default `https://api.github.com`) and decimal-string `env.OPERATOR_SOURCE_RESPONSE_BYTES` from admitted policy. Legacy single-PR bindings remain unchanged.

POST JSON through OPERATOR to `https://operator.internal/v1/dispatcher/source`:

```ts
{ operationId: string, url: string, method?: 'GET' | 'POST' | 'PUT', body?: string }
// Parent HTTP 200 envelope, not a claim of remote success:
{ url: string, status: number, headers: Record<string,string>, body: string }
```

IDs match `[A-Za-z0-9_-]{1,128}`. URL is HTTPS, at most 4096 characters, without credentials, fragment or nondefault port; normalized HTTPS `:443` is permitted. GET is default and forbids body; POST/PUT require a string body sent verbatim with parent-selected JSON content type. Encoded request remains 64 KiB. Upstream UTF-8 body and final encoded envelope both obey approved `sourceResponseBytes`; escaping and headers count. Requests/inference/final results/SDK history do not inherit the source allowance. POST/PUT must use GITHUB_API_ORIGIN and existing authenticated GitHubInterceptor. Internet GET uses approved EgressController/Gateway. No caller identity, credential, selector or header map is accepted. Redirects are manual. Response headers are limited to content-type, etag, last-modified, date, link and location. Current human authority, pins, capabilities, generation, cancellation and original expiry gate every operation.

Loader globalOutbound's parent adapter supports standard GET/POST/PUT only with `x-codeflare-operator-operation-id`; string bodies are bounded, caller headers cannot select upstream headers and credential-bearing requests deny. It unwraps the source envelope into a standard Response, retaining parent failure codes. This is intercepted transport, not direct egress.

Completed identical requests return cached receipts. Changed immutable arguments return HTTP 409 `OPERATOR_OPERATION_CONFLICT`. Uncertain mutation returns HTTP 409 `OPERATOR_OPERATION_UNKNOWN`, never resends and preserves the live generation for safe reads. Do not replace IDs after uncertainty. Any unresolved operation fences final settlement.

POST JSON to `https://operator.internal/v1/dispatcher/receipt`:

```ts
{ operationId: string }
// HTTP 200
{ operationId: string, generation: number, requestDigest: string,
  method: 'GET' | 'POST' | 'PUT', url: string,
  phase: 'reserved' | 'unknown' | 'completed', responseDigest?: string,
  operationCount: number, operationLimit: number }
```

Request digest is SHA-256 of `JSON.stringify({path, body})` for parsed immutable operation: use returned digest, not reconstruction. Response digest is SHA-256 of exact persisted response body (the source envelope, not just inner body). Projection exposes no credential, journal internal or remote body. Count includes all Activity journal entries, inference and earlier generations; it is an observation, not a capacity reservation or permission for unbounded inference.

Approved package deterministic code first validates positive unique remote evidence for original target/head/text/publisher/outcome as applicable. Model assertion, absent receipt, ambiguous evidence or generic merged flag is not domain proof. Then POST to `https://operator.internal/v1/dispatcher/resolve`:

```ts
{ operationId: string, requestDigest: string,
  readbacks: Array<{ operationId: string, requestDigest: string, responseDigest: string }> }
// HTTP 200
{ resolved: true, operationId: string, requestDigest: string }
```

There must be 1–16 unique references. Parent verifies original unknown mutation/digest and every immutable completed successful GET receipt reserved later than that mutation in the same currently authorized Activity/generation. It durably records references and caches resolution. Identical resolution is idempotent; changed references conflict. Invalid/unavailable references stay unknown; authority loss denies. Parent does not interpret GitHub/Dozzle/branch semantics or assert remote success. Resolved mutation's cached response is this resolution object, not a fabricated upstream envelope: consumer uses resolve receipt rather than unwrapping it as source response. Generic transport does not invoke legacy publisher routes, convert POST to GET, require blanket admin, add anonymous routing or change interceptor auth. Package owns its safeguards and must disclose protection/head/base races honestly.

<a id="package-release-files"></a>
### Package release files

Each immutable GitHub release supplies exactly `operator-manifest.json`, `operator-bundle.json` and `operator-provenance.json`. Manifest extends existing v1 metadata with profile, declared input/output schemas and requested capability names. Parent verifies repository identity, approved workflow/ref, source commit and asset/bundle digests before approval. Package requests never grant capability. Compiler deterministically emits existing approved schemas, exact resource digests/sizes and matching discovery manifest; it rejects unsafe paths and package-supplied policy, bindings, credentials, environment or outbound authority. This documentation move changes no compiler/package ABI or exact compiler pin.

<a id="dispatcher-durable-host"></a>
### Dispatcher durable host

REQ-OPERATOR-047/048/051 extend existing 015–018 owners, not a second lifecycle service. `OperatorActivity` owns admission, protected operation receipts and one Activity-private facet containing real Flue code and isolated SQLite. Package CI builds generated Flue Durable Object class; Codeflare selects approved class export through Worker Loader, never arbitrary caller export. Legacy default-entrypoint bundles remain valid. Vite is package build tooling, not a new Codeflare build pipeline.

Facets have no independent physical alarm. Reuse pinned Agents SDK root alarm/fiber machinery in existing Activity with a narrowly scoped dynamic-facet/root bridge. SDK-internal resolution/init seams must be pinned and proven in native fixture before production base-class integration. No copied scheduler, new DO namespace/migration, per-operator deployment, container, full Activity stub or unrestricted namespace binding. Bundle compatibility is child-specific; any parent compatibility change requires demonstrated API need and regression tests.

One durable execution lease binds generation, submission, input/release digests, expiry and state. Async admission leaves execution running: HTTP return/status polling cannot commit false `waiting`, increment generation or renew lease. Only persisted safe quiescent checkpoint permits explicit continuation. Each effect carries original generation and stable operation ID/digest. Recheck current human eligibility/policy, expiry/cancellation and result generation; never upgrade stale warmed caller. Complete receipts reconcile, changed digest conflicts, unknown completion never blindly replays. Fence cancellation before signaling Flue; alarm recovery/settlement grants no new execution authority. No discretionary whole-assessment cap overrides authorized work; original human deadline still fences late settlement. Legacy exact completed assessment settles to waiting before terminal collection; repository-only exact completed result settles to completed without checkpoint. Both require one bounded result and no unresolved operation.

Child receives scoped parent transport/inference and required scheduler bridge only: no other Activity/facet, arbitrary parent callback, credentials, sessions/containers or direct outbound network. All resource limits remain bounded. Native proof must execute actual pinned generated Flue artifact, delegated alarm/fiber work, eviction/recovery, two-Activity isolation, safe continuation, stale/expired/cancelled denial and completed/uncertain operations. Mock capability tests are not native proof. This appendix does not upgrade any requirement's incomplete evidence.
