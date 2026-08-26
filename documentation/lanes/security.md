# Security

**Audience:** Operators, Security reviewers, Developers

**Owns:** threats, trust boundaries, technical controls, fail-closed/degraded behavior, exceptions, residual risk, encryption, credential containment, and supply-chain acceptance.

**Does not own:** authentication user flow, runtime composition, endpoint catalogues, workflow procedure, private secret placement, or immutable penetration-test observations.

For vulnerability reporting and supported versions, see [SECURITY.md](../../SECURITY.md).

## Contents

- [Security Posture](#security-posture)
- [Threat Model](#threat-model)
- [Identity and Authorization Controls](#identity-and-authorization-controls)
- [Credential Controls](#credential-controls)
- [Network and Egress Controls](#network-and-egress-controls)
- [Data Controls](#data-controls)
- [Browser and Proxy Boundaries](#browser-and-proxy-boundaries)
- [Abuse and Resource Controls](#abuse-and-resource-controls)
- [Supply-chain Controls](#supply-chain-controls)
- [Accepted Exceptions and Residual Risks](#accepted-exceptions-and-residual-risks)
- [Verification and Source Map](#verification-and-source-map)
- [Related Documentation](#related-documentation)

## Security Posture

Codeflare constrains trusted engineering agents at identity, tenancy, routing, credential, persistence, network, browser-proxy, and delivery boundaries. Agents, terminals, and trusted IDE extensions retain broad command and filesystem power inside their session container. Controls reduce standing and cross-session exposure; they do not make arbitrary commands harmless, undo external side effects, or constitute independent certification.

Security records below state the protected asset, threat/failure, control, failure posture, exceptions, residual risk, and source owner. Current contracts remain separate from dated probe evidence in [Penetration Testing](pentest.md).

## Threat Model

| Asset / boundary | Threat or failure | Control and failure posture | Residual risk / owner |
|---|---|---|---|
| User identity and session | Forged, expired, unverified, or cross-user request | Verify configured issuer/session, normalize principal, bind durable lookup to verified identity, reject uncertainty | Provider availability; [Authentication](authentication.md) owns flow |
| Worker-to-container authority | Guessed session, direct host reachability, cross-session forwarding | Worker/DO ownership checks plus lifecycle-scoped bearer on private hop | Shared runtime defect; Container owns supervision |
| Provider/deployment credentials | Prompt injection or compromised container reads/exfiltrates token | Withhold master credentials, scope what enters, boundary-inject where interception exists | Legitimately scoped operation may still be destructive |
| Durable user data | Cross-bucket selection, stale encryption regime, partial shutdown, overwrite race | Server-derived claim, encryption where configured, mixed-regime reconciliation, audited final drain | Eventual consistency, key rotation, concurrent same-path writes |
| Public/authenticated APIs | Flooding, oversized/malformed input, CSRF, privileged bypass | Validation, body bounds, origin/request marker, route-specific auth/limits | General resource limiters may degrade open |
| Network egress | Credential use on wrong host/account, bypass of inspection | Exact host/path/account interception; optional strict Gateway routing | DNS rebinding/allowed-provider and startup availability trade-offs |
| Build/release inputs | Mutable artifact, malicious dependency, vulnerable image | Governed pins, source/image scans, exact-tree checks, provenance/SBOM/signing | Scanner/advisory incompleteness and reviewed exceptions |

## Identity and Authorization Controls

<a id="authentication-gate"></a>
### Authenticated-surface gate

All protected application/API/setup surfaces use the configured Access or Worker-session path. Invalid credentials fail that branch and never fall through to a weaker user mechanism. JIT persistence requires verifier provenance. [Authentication](authentication.md#authentication-modes) owns mode selection and sessions. <!-- @impl: src/lib/access.ts::authenticateRequest -->

### Administrative elevation

Durable admin role is authoritative outside request-local Enterprise elevation. The optional Enterprise admin-group lookup executes only for admin-gated routes and fails closed on missing/invalid Access evidence, unsafe Access domain, non-membership, or fetch error. Elevation writes no durable role and is revoked on the next request after group removal. <!-- @impl: src/middleware/auth.ts::requireAdmin -->

### Service-auth residual risk

`X-Service-Auth` is compared in constant time and currently returns an admin automation identity before user authentication in every mode when configured. The stress-mode, SaaS-mode, and hostname restrictions accepted by [AD68](../decisions/README.md#ad68-service-token-admin-bypass-must-be-environment-gated-and-hostname-restricted) remain unimplemented (issue #130). Treat this as privileged accepted residual risk, not as deployed environment gating. <!-- @impl: src/lib/access.ts::validateServiceAuthHeader -->

<a id="onboarding-access-request-oauth-gated"></a>
### Onboarding abuse boundary

Onboarding access requests are reachable only after completed provider authentication, so verified provider identity is the abuse gate. The anonymous contact/waitlist path uses Turnstile separately. Email dispatch is best effort and carries no internal system details; delivery does not grant admission.

## Credential Controls

<a id="api-token-containment"></a>
### Master and user provider credentials

The Worker's deployment/account-management token never enters a session container. Non-Enterprise pasted user PATs may enter the user's own container at startup and must be scoped accordingly. <!-- @impl: src/container/container-env.ts::buildEnvVars -->

Non-Enterprise Cloudflare OAuth uses a non-secret placeholder and refreshes/injects the real access token at validated `api.cloudflare.com` and AI Gateway boundaries. <!-- @impl: src/cloudflare-browser-interceptor.ts::CloudflareBrowserInterceptor -->

Enterprise interception withholds supported real credentials and injects them only at the configured Cloudflare account boundary ([REQ-BROWSER-008](../../sdd/spec/browser-run.md#req-browser-008-browser-rendering-token-interception-never-in-the-container)), the session-bound GitHub host and identity boundary ([REQ-GITHUB-003](../../sdd/spec/github.md#req-github-003-enterprise-egress-injected-github-credentials)), or the model-routing boundary ([REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway)). <!-- @impl: src/cloudflare-browser-interceptor.ts::CloudflareBrowserInterceptor --> <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @impl: src/llm-interceptor.ts::LlmInterceptor -->

A compromised container can still exercise any legitimate capability represented by a credential or boundary interceptor. Prompt isolation is not authorization; provider scope and branch/deployment policy remain necessary.

<a id="non-enterprise-cloudflare-oauth-token"></a>
### Session-bound resolution

Boundary interceptors resolve credentials from the session-bound bucket/configuration, never a caller-selected bucket header. Missing, expired, unrefreshable, wrong-account, or wrong-host requests fail before an upstream credential is attached. OAuth placeholders are distinct from Enterprise placeholders so modes cannot collide.

<a id="github-token-handling"></a>
### GitHub credentials

Non-Enterprise GitHub PATs remain direct and user-scoped. Enterprise git traffic uses the configured organization/repository boundary and does not expose the real token in the container. GitHub App/OAuth disconnect and offboarding attempt provider revocation, log failures, and clear the local GitHub credential even when revocation is unconfirmed so local cleanup can continue ([REQ-GITHUB-005](../../sdd/spec/github.md#req-github-005-disconnect-and-offboarding-revocation)). Cloudflare OAuth retains its provider-owned failure and retry-state contract. <!-- @impl: src/lib/cloudflare-token.ts::disconnectCloudflare -->

<a id="container-auth-token-req-sec-012-req-sec-022"></a>
### Worker-to-container bearer

Each lifecycle instance generates an unpredictable bearer credential for private host HTTP and WebSocket forwarding. The credential is lifecycle-scoped and not a public user token. <!-- @impl: src/container/container-config.ts::updateEnvVars -->

The host rejects missing/invalid credentials before route dispatch except for explicitly bearer-exempt private SDK health behavior. <!-- @impl: host/src/auth-check.ts::checkContainerAuth -->

<a id="dual-r2-credential-architecture"></a>
### R2 authority separation

The deployment token creates/manages resources but never enters containers. Containers receive only the user-scoped R2 credential needed by the sync runtime. Bucket selection is derived from verified user ownership. Exact creation and rotation procedures belong to Configuration/private operations.

<a id="credential-encryption-at-rest"></a>
### Encryption at rest and missing-key posture

When `ENCRYPTION_KEY` is configured, protected KV values use AES-256-GCM with key-specific additional authenticated data. <!-- @impl: src/lib/kv-crypto.ts::encryptForKV -->

When `ENCRYPTION_KEY` is configured, R2 uses SSE-C unless the bucket's governed-mode policy disables it ([REQ-ENTERPRISE-018](../../sdd/spec/enterprise-mode.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface)). <!-- @impl: entrypoint.sh::sse_customer_key_base64 -->

Vault derives a bucket-specific browser key through HKDF. <!-- @impl: src/routes/vault/crypto.ts::getVaultEncryptionKey -->

Transparent reads migrate supported legacy plaintext KV entries after successful decryption/write conditions. <!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt -->

AD32 permits plaintext fallback for covered legacy values when the optional key is absent; current source emits a critical warning. Vault bootstrap requires the key and fails without it. Provider client-secret save paths that require encryption reject plaintext storage rather than silently widening exposure. Rotation changes derived Vault keys and can require explicit browser/store recovery.

Generate a candidate 32-byte key with `openssl rand -base64 32`; the decoded value must be exactly 32 bytes. Secret placement and rotation execution remain Configuration/private-operations responsibilities.

## Network and Egress Controls

<a id="enterprise-mode-credential-containment-and-ca-trust"></a>
### Interception and CA trust

Supported Enterprise model/provider traffic is intercepted at exact Worker-owned boundaries. The container trusts only the platform-mounted interception CA through the configured runtime stores. If the expected CA file is missing, current entrypoint behavior logs a warning and continues startup; intercepted provider calls then fail. It does not silently fall back to sending the real credential directly.

<a id="strict-gateway-egress-enterprise-mode"></a>
### Strict Gateway Egress

When enabled, supported HTTP, HTTPS, and WebSocket direct-internet traffic uses the customer's Cloudflare Gateway path; raw internet TCP/UDP is denied. The account's own required Cloudflare control/data-plane destinations use documented scoped exceptions. Once strict routing is wired, Codeflare does not fall back to unrestricted direct egress on Gateway failure.

Own-account R2 accepts only the session's exact bound bucket in path-style or virtual-hosted form. `EgressController` re-signs with that user's memory-only bucket-scoped credential; another bucket or missing credentials fail before any send, and deployment-wide R2 credentials are never a fallback. <!-- @impl: src/container/container-interception.ts::strictEgress --> <!-- @impl: src/egress-controller.ts::EgressController --> See [REQ-ENTERPRISE-023](../../sdd/spec/enterprise-mode.md#req-enterprise-023-strict-gateway-egress-controller-transport) and [REQ-SEC-003](../../sdd/spec/security.md#req-sec-003-per-user-r2-tokens-scoped-to-user-bucket).

Gateway policy remains customer-owned. Codeflare does not create or weaken external allow/deny/DLP rules. Hostname policy cannot eliminate every DNS-rebinding or allowed-provider abuse scenario; account/path interception and provider policy remain defense in depth.

### Startup availability exception

Some strict-egress runtime configuration is read from eventually consistent KV during startup. The accepted availability trade-off is to avoid falsely bricking an already configured deployment on transient state uncertainty where the contract says so; this must not be generalized into credential or account-boundary fail-open behavior. Exact activation/rollback remains private operations material.

<a id="view-only-storage-enterprise-anti-exfil"></a>
### View-only storage

Enterprise anti-exfil policy can disable downloads while preserving approved viewing. Backend enforcement, not hidden UI alone, is authoritative. Error or missing-policy reads follow the SDD-defined posture and must not fabricate a successful download decision.

## Data Controls

### Bucket and path authority

User bucket authority is resolved server-side. Storage keys reject traversal, null bytes, malformed encoding, and disallowed prefixes at the route boundary. `PROTECTED_PATHS` is intentionally empty because a user already has unrestricted access to the same bucket-scoped files inside their own container; this is an explicit negative control, not a missing implementation.

### Input and response hardening

<a id="session-id-validation"></a>
Session IDs are strict bounded lowercase alphanumeric values before routing. Request bodies use route schemas and a global API body bound; upload/streaming routes declare their explicit exception. Downloads use safe content disposition and inline-content policy so stored bytes do not become an unintended active browser origin.

<a id="body-limit"></a>
Oversized bounded API bodies fail before handler parsing. File upload boundaries have their own size/streaming contract in the API/Storage owners rather than inheriting an unsafe unlimited exemption.

### Push notification capabilities

Authenticated notification routes isolate enrollment to the current user, accept only bounded exact-shape subscriptions for reviewed HTTPS Push providers, and never return or log endpoint or encryption-key capability material. User deletion removes that user's enrollments. The public VAPID key is the only sender configuration returned to the browser; the private key remains deployment-only ([REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries)). <!-- @impl: src/routes/notifications.ts::app --> <!-- @impl: src/routes/notifications.ts::parsePushSubscription -->

The DO enriches fixed host events from its trusted Session record, bounds event and subscription fan-out, and sends through a cancellable provider budget. Only processed terminal outcomes are acknowledged; transient and timed-out outcomes remain eligible without exposing provider errors. Browser display accepts fixed payload fields and canonical same-origin session paths only ([REQ-SEC-024](../../sdd/spec/security.md#req-sec-024-agent-notification-delivery-trust-boundaries)). <!-- @impl: src/lib/push-sender.ts::sendAgentEventPushes --> <!-- @impl: src/container/container-metrics.ts::collectMetrics -->

### Outbound email boundary

Interpolated email values are HTML-escaped. Provider calls have a ten-second timeout and remain non-fatal to the successful primary operation. Failure logs may identify the recipient and provider error, but never include the email body.

### Governed-mode encryption regime

<a id="governed-mode--r2-sse-c-governance-trade-off"></a>
When operator encryption is configured, R2 objects use SSE-C. Governed Mode deliberately disables SSE-C so customer security tooling can inspect corporate-owned bucket data while Vault/KV secret encryption remains active. [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile) owns the current gated, chunked, verified migration; AD89 remains superseded history. Mixed-regime reads, writer gates, verification, and recovery are mandatory during transition.

## Browser and Proxy Boundaries

<a id="security-headers"></a>
### Default response headers

The Worker's global Hono middleware applies HSTS, content-type protection, framing, referrer, permissions, and the non-document CSP to routed responses, including validation and security errors. <!-- @impl: src/index.ts::app.use -->

Early responses built outside the Hono pipeline use `withSecurityHeaders`; route-specific callers may select a narrower CSP or same-origin framing policy. Current literal values remain source-owned by the Worker rather than duplicated into policy files. <!-- @impl: src/index.ts::withSecurityHeaders -->

### Framing exceptions

Vault/SilverBullet and Browser IDE require narrowly scoped framing/proxy behavior inside the authenticated Codeflare application. Exceptions are path-specific and do not relax default public document framing. Validation failure still receives the security-header set.

<a id="code-server-supply-chain-and-reverse-proxy-boundary"></a>
### Browser IDE proxy boundary

Public workspace selectors are rejected independently by Worker and host. Only the private loopback root request receives the fixed workspace. This constrains browser navigation, not terminal/trusted-extension filesystem access. The package is pinned and image-verified without patching code-server/Code OSS or Anthropic's official extension.

<a id="browser-ide-user-extensions"></a>
### User-installed Browser IDE extensions

A user-installed extension is arbitrary root-capable code inside the session container. Pinned code-server also exposes proposed APIs broadly and disables VSIX signature verification; Open VSX over TLS is the v1 transport boundary. Before an extension identity is first persisted or any unacknowledged restored intent can execute, the workbench requires one durable warning acknowledgement ([REQ-IDE-038](../../sdd/spec/browser-ide.md#req-ide-038-extension-warning-acknowledgement)). Managed `extensions.allowed` deliberately supplies the same wildcard allowance to fresh installation and lazy restoration; it neither replaces nor weakens a stricter code-server operator policy ([REQ-IDE-040](../../sdd/spec/browser-ide.md#req-ide-040-user-extension-allowance-policy)).

Persistence stores only the validated 64 KiB intent manifest: lowercase IDs, exact versions, optional audit metadata, and bounded contributed global settings. It stores no VSIX/extracted bytes, extension/global/workspace storage, SecretStorage, Accounts, enablement, keybindings, snippets, or secondary downloads. Malformed or redirected content fails closed and remains unchanged. Pi, Claude, welcome, and unsupported base inventories remain image-owned; user directories exist only under writable `/run/codeflare/openvscode/data/extensions`. Whole-file R2 convergence remains newest-wins, so simultaneous sessions are not serialized. [REQ-IDE-036](../../sdd/spec/browser-ide.md#req-ide-036-persistent-user-managed-extensions), [REQ-IDE-037](../../sdd/spec/browser-ide.md#req-ide-037-lazy-extension-restoration), and [AD132](../decisions/README.md#ad132-user-extensions-are-a-bounded-manifest-over-an-immutable-base-inventory) own this accepted boundary.

<a id="browser-ide-native-agents"></a>
### Unsandboxed native agents

Terminal Pi, panel Pi, and Claude IDE agents run with owner-approved broad container capability. A native Pi Inline Chat turn is narrower: the same serialized IDE process temporarily exposes only the owned result tool and current Inline turn suffix. The OpenAI Chat Completions and Responses boundaries force that exact tool and disable parallel calls. The host binds the result to its active generation and validates edit outcomes before controller-owned Keep/Close; no-change outcomes invoke no text-edit method.

Settlement restores the exact unrestricted panel tool set, and malformed or duplicate state fails closed. Credentials, IDE configuration projection, and public routing remain constrained, but a compromised trusted panel agent can still act with its legitimate session capabilities. [Browser IDE requirements](../../sdd/spec/browser-ide.md), [AD127](../decisions/README.md#ad127-native-inline-chat-uses-proposal-only-pi-turns-and-host-owned-text-edits), [AD128](../decisions/README.md#ad128-inline-review-lifecycle-belongs-to-the-pinned-controller), and [AD135](../decisions/README.md#ad135-inline-chat-requires-one-host-correlated-result) own the split contract. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::constrainInlineOpenAiPayload --> <!-- @impl: openvscode/agent-sidebar/src/pi/inline-edit-validation.ts::validateInlineTextEdits --> <!-- @test: host/__tests__/pi-inline-edit-mode.test.js (REQ-IDE-025: inline result mode isolates provider tools and context then restores panel tools) -->

## Abuse and Resource Controls

<a id="rate-limiting"></a>
### HTTP and WebSocket limits

Rate limiters use authenticated user/session identity where available, bounded in-memory fallback where defined, and route-specific responses/headers. WebSocket connection limits exclude retryable stopped-container outcomes from budget consumption. Exact values belong to the [API Reference](api-reference.md).

General resource-protection limiters may degrade open on KV failure to preserve availability; security-sensitive limiters selected under [AD66](../decisions/README.md#ad66-security-sensitive-rate-limiters-fail-closed-on-kv-outage) fail closed. Every new limiter must explicitly choose and test its failure posture rather than inherit one silently.

<a id="websocket-rate-limit-req-sec-007"></a>
### WebSocket boundary

WebSocket upgrades authenticate and validate route/session ownership before forwarding. Private host upgrades require the same lifecycle bearer as HTTP. Malformed/unknown control frames do not become privileged input; payload and connection bounds fail predictably.

### Stress-test bypass

Only exact `STRESS_TEST_MODE=active` activates the integration bypass and warning. SaaS plus stress is invalid and fails requests rather than silently disabling production limits. This mode is for prepared integration targets only; [Stress Testing](stress-test.md) owns execution safety.

### Session limits are not a security boundary

Per-user session admission is best effort: KV counting and the later running write are non-atomic. Simultaneous starts can exceed the nominal limit. Billing owns the resource/cost consequence; deployment `max_instances` is the separate platform ceiling.

## Supply-chain Controls

### Artifact identity

Governed dependencies/actions/images are pinned through their owning lock/manifest/workflow. Exact-tree checks, dependency review, static analysis, generated-artifact coherence, SBOM/provenance, and keyless release signing make the reviewed source and promoted artifact traceable. Workflow procedure belongs to [CI/CD](ci-cd.md).

### Managed curation signing and repository credentials

The private curation build job is read-only. Only its publication job receives release-write permission, and only its signing step receives the Ed25519 private PEM, scoped to the dedicated `managed-seed-production` GitHub environment. Approval rules on that environment are deployment configuration, so the workflow does not assume they are present. Production workflow acceptance is defined by [REQ-AGENT-148](../../sdd/spec/agents.md#req-agent-148-protected-managed-release-publication).

The matching raw 64-hex public key is non-secret verification material. Codeflare Setup stores only that public key and an AES-256-GCM-encrypted repository-scoped read PAT. A replacement key is selected only after its signed release verifies without rolling back or conflicting with the active sequence; failure preserves the prior trust boundary. Neither value enters a user bucket or container. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment -->

The Worker strips GitHub authorization before the single allowlisted asset redirect, verifies immutable GitHub asset digests before signature validation, and accepts company-extension metadata in the Browser IDE only when its release digest matches the Worker-applied digest transported to that container. Registry ID/version/platform metadata is not treated as byte identity: each active company requirement is reinstalled from its exact signed size- and SHA-256-verified VSIX, and temporary bytes are deleted. <!-- @impl: src/lib/remote-curation.ts::downloadManagedAsset --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::reconcileCompanyExtensions -->

Under [REQ-IDE-042](../../sdd/spec/browser-ide.md#req-ide-042-additive-company-extension-reconciliation), removed company IDs are uninstalled before personal restoration; failures remain company-protected, are reported, and retry later. Fresh users fail closed when enabled curation has no verified cache; already-applied users may continue from their last verified state during a transient outage. <!-- @impl: src/routes/container/lifecycle.ts::default --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::reconcileCompanyExtensions --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence -->

<a id="container-image-scanning-req-sec-011"></a>
### Container image vulnerability gate

Fresh images are scanned for HIGH/CRITICAL findings with a locked Trivy binary; scan and SBOM traversal run concurrently against isolated Trivy cache copies, but the bounded verdict still gates push. <!-- @impl: .github/workflows/container-image.yml::image -->

Fixable findings have two reviewed exception paths. Trivy first applies CVE-level suppressions from [`.trivyignore`](../../.trivyignore); each matches that CVE across scanner targets. The newly added Go stdlib batch carries adjacent scope, impact, and removal rationale. <!-- @impl: .github/workflows/container-image.yml::image -->

The executable validator then accepts only its separately listed exact vulnerability/package/path/PURL tuples and fails on unexpected, missing, duplicate, or drifted identities. Dated scan occurrences belong to CI evidence rather than current policy. <!-- @impl: scripts/ci/validate-trivy-result.mjs::validateTrivyResult -->

Historical provenance: retirement of the `gh` CVE-2026-56852 occurrence was verified by workflow run `30612952117` at head `82244a1d117194227c0082b9555f3654f903fbd2`. This receipt is immutable evidence for that occurrence, not a current scanner result.

<a id="keyless-source-release-identity"></a>
### Release identity alias

Eligibility, deterministic archives, checksums, Sigstore bundles, and provenance are owned by [CI/CD — Keyless release signing](ci-cd.md#keyless-release-signing). Security owns the requirement that identity and reachability checks fail closed.

## Accepted Exceptions and Residual Risks

<a id="security-hardening-pre-launch-review"></a>
| Exception / residual risk | Current decision | Owner / review signal |
|---|---|---|
| AD68 service-auth environment/host restrictions absent | Accepted but unimplemented; privileged secret grants automation admin | Security/Auth; issue #130 |
| Trusted session agents are unsandboxed | Required for engineering work; boundary is the session/container/provider scope | Product/security review on capability expansion |
| Optional encryption key permits covered plaintext fallback | AD32 compatibility; critical warning, Vault unavailable | Operator/configuration; production readiness |
| Strict-egress startup state can favor availability in bounded cases | Accepted availability trade-off, not credential fallback | Enterprise operations |
| `PROTECTED_PATHS` empty | Bucket authority is the isolation boundary | Storage/security review if in-container trust changes |
| General rate-limit KV failure may degrade open | Resource/cost exposure, not authentication bypass | Owning route/Billing |
| Concurrent session cap is best effort | Nominal limit can overrun | Billing/Operations; issue #880 tracks Enterprise simplification |
| Scanner/advisory coverage incomplete ([REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-container-image-scanned-for-cves-before-deploy)) | Layered checks plus reviewed CVE-level and exact-tuple exceptions | CI/Security review on new findings |

<a id="static-analyzer-false-positives"></a>
Static-analysis dispositions require a concrete source boundary and rationale. Suppressions remain adjacent to the finding and must be revisited when the guarded code or analyzer rule changes; historical alert counts are not current policy.

<a id="graceful-shutdown"></a>
Durability during teardown is owned by [Storage & Sync](storage-and-sync.md#manual-sync-triggers-req-stor-015) and [Container](container.md). Security treats unconfirmed final drain as integrity/availability exposure but does not duplicate the lifecycle procedure.

## Verification and Source Map

Exhaustive SDD status remains in `sdd/spec/security.md` and related domains. Partial requirements remain Partial; this map does not convert them into completed coverage.

| Control family | Requirements / decisions | Implementation | Evidence |
|---|---|---|---|
| Authentication and authorization | [REQ-SEC-001](../../sdd/spec/security.md#req-sec-001-authenticated-endpoints-reject-unauthenticated-requests), [Authentication requirements](../../sdd/spec/authentication.md) | `src/lib/access.ts`, auth middleware | access/auth route suites |
| Credential containment | [REQ-SEC-002](../../sdd/spec/security.md#req-sec-002-api-tokens-never-enter-containers), [Enterprise requirements](../../sdd/spec/enterprise-mode.md), [Agent requirements](../../sdd/spec/agents.md) | container env and interception registry | containment/interceptor suites |
| Container bearer | [REQ-SEC-012](../../sdd/spec/security.md#req-sec-012-container-auth-token-per-do-lifecycle), [REQ-SEC-022](../../sdd/spec/security.md#req-sec-022-container-proxy-bearer-validation) | host auth check and proxies | host HTTP/WS auth suites |
| Encryption | [REQ-SEC-005](../../sdd/spec/security.md#req-sec-005-r2-files-encrypted-at-rest-with-sse-c-when-operator-configures-an-encryption-key), [AD32](../decisions/README.md#ad32-encryption_key-is-optional), [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile) | KV crypto, R2 SSE, migration engine | crypto/migration suites |
| Headers/input/body | [REQ-SEC-008](../../sdd/spec/security.md#req-sec-008-security-headers-on-every-response), [REQ-SEC-009](../../sdd/spec/security.md#req-sec-009-input-validation-at-system-boundaries) | Worker header/input boundaries | header/validation/fuzz suites |
| Rate limits | [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure), [REQ-SEC-019](../../sdd/spec/security.md#req-sec-019-per-endpoint-rate-limit-policy), [AD66](../decisions/README.md#ad66-security-sensitive-rate-limiters-fail-closed-on-kv-outage) | rate-limit middleware/routes | limiter and stress-bypass suites |
| Push notification capabilities | [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries), [REQ-SEC-024](../../sdd/spec/security.md#req-sec-024-agent-notification-delivery-trust-boundaries) | notification routes, Push sender, metric-drain orchestration | route, sender, drain, and service-worker suites |
| Supply chain | [REQ-SEC-011](../../sdd/spec/security.md#req-sec-011-container-image-scanned-for-cves-before-deploy), [Operations requirements](../../sdd/spec/operations.md) | workflows and exact exception validator | host/workflow contracts, CI receipts |
| Browser IDE residual boundary | [Browser IDE requirements](../../sdd/spec/browser-ide.md), [AD114](../decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration), [AD127](../decisions/README.md#ad127-native-inline-chat-uses-proposal-only-pi-turns-and-host-owned-text-edits) | package/proxy/config preparation and inline proposal gate | Browser IDE package/image suites; Partial/manual states remain in the linked requirements |

<!-- Preserved source-evidence anchors for the controls summarized above. -->
<!-- @impl: .github/workflows/sign-release.yml::sign -->
<!-- @impl: Dockerfile::CODE_SERVER_VERSION = "4.133.0" -->
<!-- @impl: Dockerfile::JS_YAML_SHA512 -->
<!-- @impl: entrypoint.sh::_openvscode_launch_once -->
<!-- @impl: entrypoint.sh::_openvscode_prepare_agent -->
<!-- @impl: host/src/request-router.ts::createRequestHandler -->
<!-- @impl: host/src/upgrade-dispatcher.ts::createUpgradeDispatcher -->
<!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace -->
<!-- @impl: host/src/vscode-proxy.ts::vscodeUpstreamPath -->
<!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate -->
<!-- @impl: openvscode/agent-sidebar/src/package-extension.ts::stageSidebarExtension -->
<!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime -->
<!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt -->
<!-- @impl: openvscode/agent-sidebar/src/pi/vscode-approval-host.ts::VsCodeApprovalHost -->
<!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::canonicalWorkspaceFilePath -->
<!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput -->
<!-- @impl: openvscode/agent-sidebar/src/process-generation.ts::reapSidebarGeneration -->
<!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings -->
<!-- @impl: openvscode/claude/managed-settings.mjs::buildManagedSettings -->
<!-- @impl: openvscode/claude/managed-settings.mjs::buildOpenVscodeSettings -->
<!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings -->
<!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareOfficialClaudeIde -->
<!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::prepareSidebarConfig -->
<!-- @impl: openvscode/claude/prepare-sidebar-config.mjs::writeOpenVscodeProfileState -->
<!-- @impl: preseed/agents/pi/extensions/sidebar-approval.ts::sidebarApproval -->
<!-- @impl: preseed/agents/pi/package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/undici -->
<!-- @impl: preseed/npm-tools/package-lock.json::node_modules/@earendil-works/pi-coding-agent/node_modules/undici -->
<!-- @impl: scripts/browser-ide-ui-state.py::capture -->
<!-- @impl: scripts/ci/sign-release.sh::validate_release_source -->
<!-- @impl: scripts/ci/smoke-openvscode-sidebar-image.mjs::main -->
<!-- @impl: scripts/ci/validate-trivy-result.mjs::REVIEWED_FINDINGS -->
<!-- @impl: scripts/ci/validate-trivy-result.mjs::validateTrivyResult -->
<!-- @impl: src/index.ts::withSecurityHeaders -->
<!-- @impl: src/lib/access.ts::getUserFromRequest -->
<!-- @impl: src/lib/kv-crypto.ts::getAndDecrypt -->
<!-- @impl: src/lib/kv-crypto.ts::getOrImportKey -->
<!-- @impl: src/routes/github-auth.ts::Set-Cookie = HttpOnly; Secure; SameSite=Lax -->
<!-- @impl: src/routes/vault/index.ts::handleVaultRequest -->
<!-- @impl: src/routes/vscode.ts::handleVscodeRequest -->
<!-- @test: host/__tests__/trivy-exception-gate.test.js (rejects p7zip RCE findings without a reviewed exception) -->
<!-- @test: host/__tests__/trivy-exception-gate.test.js (rejects retired Pi findings after the runtime upgrade) -->

<a id="adding-a-new-rate-limiter"></a>
<a id="admin-elevation-via-access-group-enterprise"></a>
<a id="browser-ide-native-agents-req-ide-005-req-ide-006-req-ide-007-req-ide-008-req-ide-009-req-ide-010-req-ide-011-req-ide-013-req-ide-014-req-ide-017-req-ide-019-req-ide-020-req-ide-021-req-ide-022"></a>
<a id="browser-ide-rate-limit-req-ide-001--req-sec-007"></a>
<a id="browser-ide-response-headers"></a>
<a id="container-image-scanning"></a>
<a id="content-disposition-hardening"></a>
<a id="github-token-containment"></a>
<a id="input-validation-atob"></a>
<a id="key-generation-and-setup"></a>
<a id="kv-encryption-aes-256-gcm-via-web-crypto-api"></a>
<a id="native-agent-browser-notifications-req-term-023-req-term-024"></a>
<a id="path-traversal-prevention-req-sec-010"></a>
<a id="protected-r2-paths"></a>
<a id="r2-sse-c-encryption"></a>
<a id="session-limits-req-sub-013"></a>
<a id="transparent-kv-migration-req-sec-006"></a>
<a id="vault-editor-rate-limit-req-vault-005--req-sec-007"></a>
<a id="what-gets-encrypted"></a>
<a id="specification-coverage"></a>
## Related Documentation

- [Security Policy](../../SECURITY.md) — reporting and supported versions
- [Authentication](authentication.md) — identity and sessions
- [Billing](billing.md) — quota/session-limit failure posture
- [Container](container.md) — runtime supervision and teardown
- [Storage & Sync](storage-and-sync.md) — persistence and encryption-regime recovery
- [CI/CD](ci-cd.md) — workflow and release procedure
- [Penetration Testing](pentest.md) — current probes and immutable observations
- [Architecture](architecture.md) — trust/component boundaries
