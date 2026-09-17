# Operator Interface foundation

**Audience:** Platform and operator developers

**Owns:** Enterprise Operator Interface input formats and reusable platform boundaries.

**Does not own:** Private Flue code, Review business logic, canonical local-review resources, enterprise permission grants or deployment secrets.

The source boundaries identified below have focused behavioral evidence; the requirement file records which exact-head evidence is complete or pending. They do not by themselves prove a deployed operator runtime: live identity/egress/R2 behavior, responsive visual acceptance, and both integration-environment Gate 1 runs remain pending. Requirements and acceptance live in [Operators](../../sdd/spec/operators.md).

## Contents

- [Verified human context](#verified-human-context)
- [Distribution validation](#distribution-validation)
- [Worker Loader boundary](#worker-loader-boundary)
- [Shared interception restrictions](#shared-interception-restrictions)
- [Protected execution context](#protected-execution-context)
- [Activity-to-Worker driver](#activity-to-worker-driver)
- [Request-attached orchestration](#request-attached-orchestration)
- [Registration/admission ordering](#registrationadmission-ordering)
- [Enterprise registration backend](#enterprise-registration-backend)
- [Activity admission](#activity-admission)
- [Durable drive checkpoints](#durable-drive-checkpoints)
- [Protected secrets](#protected-secrets)
- [Webhook capability handoff](#webhook-capability-handoff)
- [Operator inference intersection](#operator-inference-intersection)
- [Owner-scoped activity surface](#owner-scoped-activity-surface)
- [Owned session and structured Pi](#owned-session-and-structured-pi)
- [Explicit scoped persistence](#explicit-scoped-persistence)
- [Independent sync evidence](#independent-sync-evidence)
- [Consumer contract and dependency inventory](#consumer-contract-and-dependency-inventory)
- [Verification](#verification)

## Verified human context

Implements [REQ-OPERATOR-001](../../sdd/spec/operators.md#req-operator-001-verified-human-access-claims).

`src/lib/jwt.ts::verifyHumanAccessJWT(token, authDomain, audience)` returns signed human subject/email/issuer/audiences and actual issued-at/expiry, or null. It shares cryptographic verification with the unchanged ordinary email API. It does not return the token, grant operator eligibility, resolve an owner bucket or renew authority. See [Authentication](authentication.md#human-access-claims-for-the-operator-interface).

## Distribution validation

Implements the distribution and registration boundaries in [REQ-OPERATOR-002](../../sdd/spec/operators.md#req-operator-002-enterprise-distribution-registration), [REQ-OPERATOR-010](../../sdd/spec/operators.md#req-operator-010-bounded-operator-discovery-document), [REQ-OPERATOR-030](../../sdd/spec/operators.md#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-034](../../sdd/spec/operators.md#req-operator-034-authenticated-discovery-transport), and [REQ-OPERATOR-035](../../sdd/spec/operators.md#req-operator-035-approved-artifact-transport).

`src/operators/distribution.ts` provides pure typed boundaries:

- `parseOperatorManifest(json, endpoint)` validates at most 64 KiB of discovery JSON and resolves a canonical artifact path only against the registered HTTPS origin.
- `parseOperatorBundle(bytes, approvedSha256)` checks at most 8 MiB of exact artifact bytes, validates compatible JS/text modules and returns data without executing it. The bundle cannot supply environment bindings or outbound configuration.

Both reject invalid input with a safe `ValidationError`. Network callers must still bound responses before buffering, authenticate the invoking human and connection secret, reject redirects/login responses and enforce artifact approval. An advertised digest is integrity metadata, not independent publisher authenticity or user eligibility.

### Authenticated discovery transport

`src/operators/distribution-client.ts::fetchOperatorManifest(endpoint, credentials)` shares `validateOperatorEndpoint` with the parser, checks actual human expiry, and sends the human JWT as `cf-access-jwt-assertion` plus the connection secret as Bearer Authorization. The parent must first verify that JWT and authorize the human; these credentials are never child bindings. This explicit endpoint authentication is independent of automatic JWT stamping settings.

The request rejects redirects, non-200/login responses and non-JSON content. It bounds streaming input to 64 KiB and aborts after at most 15 seconds or human expiry, whichever is earlier. Failed responses are cancelled; errors disclose neither credential nor remote diagnostics. No automatic retry or service-token fallback occurs. Transport fixtures are not evidence of real Access audience acceptance. The registration backend now composes this transport; deployed endpoint audience acceptance remains required.

`fetchOperatorBundle(endpoint, approvedManifest, credentials)` re-resolves the approved artifact path on the registered origin and rejects inconsistent URL metadata before I/O. It shares authenticated transport with discovery, using an 8 MiB streaming bound. Digest and module validation run inside the transport deadline, with an authority check after validation. It never updates the approved digest from a fetched response or evaluates the returned code.

### Discovery v1

```json
{
  "schemaVersion": 1,
  "interfaceVersion": 1,
  "id": "example-operator",
  "name": "Example operator",
  "description": "Platform acceptance fixture",
  "coreVersion": "1.0.0",
  "intentVersion": "1.0.0",
  "inputSchema": { "type": "object" },
  "requiredCapabilities": ["inference", "session", "storage"],
  "artifact": {
    "path": "/bundles/example.json",
    "sha256": "<lowercase SHA-256 of exact bundle bytes>"
  }
}
```

Supported capability names are `session`, `pi`, `storage`, `inference` and `fetch`. Declaring one requests compatibility, not permission. Duplicate/unknown capabilities, unknown schema/interface versions and caller identity/binding fields fail validation. `inputSchema` is bounded JSON metadata, not executable code or a new schema interpreter.

### Bundle v1

```json
{
  "schemaVersion": 1,
  "interfaceVersion": 1,
  "compatibilityDate": "2026-02-05",
  "compatibilityFlags": ["nodejs_compat"],
  "mainModule": "index.js",
  "modules": {
    "index.js": { "js": "export default {};" },
    "resources/intent.txt": { "text": "Approved intent resource" }
  }
}
```

This is a format example, not a functioning operator. At most 128 canonical relative module names are accepted and the declared main module must be JavaScript. Compatibility settings match the platform; accepting a new setting requires an explicit tested platform change. Parent-provided capabilities, execution, checkpointing, interception and activity admission are separate runtime responsibilities.

## Worker Loader boundary

Implements the isolate boundary in [REQ-OPERATOR-015](../../sdd/spec/operators.md#req-operator-015-isolated-approved-worker-loading).

`src/operators/loader.ts::loadOperatorWorker(loader, approvedBundle, capability, outbound)` creates a fresh Worker with `LOADER.load()` and returns its default entrypoint. The child receives only `env.OPERATOR`; the parent provides this service binding with bound principal/activity context. An explicit outbound service intercepts child networking, or `null` denies it. There is no inherited environment, cached `get()` path, automatic retry or fallback.

The caller owns artifact integrity/approval, current human authority, admission and creation of the principal-bound services. Durable checkpoints, cancellation, operation reconciliation and recovery belong to the activity, not the isolate. Production configuration declares `LOADER` and the SQLite `OPERATOR_ACTIVITY` owner. The request-attached orchestrator composes parent preparation and one direct drive; deployed execution remains pending.

The isolated fixture at `src/__tests__/operators/fixtures/wrangler.toml` uses the repository's pinned Wrangler/workerd and target compatibility settings. Its RPC/egress services are synthetic and make no provider calls. It is not a production configuration or proof of live Cloudflare Access, deployed runtime behavior, inference eligibility or activity durability.

## Shared interception restrictions

Implements [REQ-OPERATOR-004](../../sdd/spec/operators.md#req-operator-004-shared-restrictive-interception), [REQ-OPERATOR-019](../../sdd/spec/operators.md#req-operator-019-automatic-human-access-jwt-stamping), and [REQ-OPERATOR-028](../../sdd/spec/operators.md#req-operator-028-access-jwt-stamping-configuration).

`src/operators/interception-policy.ts` is the credential-free decision boundary shared by direct Worker capabilities and container interceptors. The parent supplies a previously validated `OperatorPolicy`; request identity cannot select or widen it. Exact network names and `*.example.test` subdomain rules are matched canonically (the wildcard excludes its apex). Standard and configured GitHub destinations never fall through a general-host allow rule. An operator marker also denies the enterprise Browser administrator-token interceptor outright; listing `api.cloudflare.com` as general egress cannot acquire that specialized credential.

GitHub decisions resolve only canonical REST `/repos/{owner}/{repo}/…` or Smart HTTP `{owner}/{repo}.git/…` paths and require both declared repository and method before `GitHubInterceptor` looks up a token. General egress decisions run before Gateway forwarding. Own-account R2 decisions run before scoped-key lookup/signing: GET/HEAD/list use read prefixes; PUT and multipart writes use write prefixes; copy, delete and unknown controls are denied. Multipart abort additionally requires the parent to identify the upload as activity-owned. Empty declarations deny; these restrictions never create human authority.

An operator profile forces the catch-all through the existing Egress binding even when the ordinary human strict-egress preference is off. Missing mandatory interception fails operator startup; absence of an operator profile preserves the existing human wiring and behavior.

The restricted-session package durably binds the parent-selected operator/profile identity to the session and restores it across container wake. Current human JWT authority remains memory-only and must be rebound against unchanged owner provenance after wake; failure keeps stamping closed. Inference selection separately intersects operator policy with current human route eligibility.

Automatic Access JWT stamping is configured in the existing **Security and egress** administration section as Off (default), an exact/subdomain-wildcard destination list, or All HTTPS destinations. All produces an explicit recipient echo/disclosure warning that must be confirmed. Configuration is validated and persisted through the existing preview/run revision flow.

`src/operators/jwt-stamping.ts` strips caller-supplied `cf-access-jwt-assertion`, preserves specialized Authorization, and stamps only a current verified human assertion on an eligible HTTPS request. The returned Request uses manual redirects. Generic egress, GitHub, AI Gateway, and enterprise Browser transports apply it to the actual recipient request only after their existing policy and credential decisions. The verified assertion does not replace GitHub, Gateway, or Browser Authorization.

Parent-only props carry policy/current authority between the container DO and interceptor entrypoints; no value enters the container environment. This adapter does not permit the destination, follow redirects, or renew authority. Explicit authenticated distribution transport remains independent when automatic stamping is Off.

## Protected execution context

Implements finite parent authority for [REQ-OPERATOR-003](../../sdd/spec/operators.md#req-operator-003-principal-bound-activity-context) and [REQ-OPERATOR-004](../../sdd/spec/operators.md#req-operator-004-shared-restrictive-interception).

`src/operators/execution-context.ts` captures a currently verified human Access assertion under exact activity/operator, approved artifact and policy identities. It validates bounded identifiers/digests and actual signed expiry, then uses the existing fail-closed operator AES-GCM envelope with the activity ID as authenticated context. Durable state contains owner provenance and ciphertext, never a raw JWT. `projectOperatorExecution` removes ciphertext before parent-safe readback; nothing from this projection grants child authority.

Protected reopening verifies the ciphertext payload still matches every public pinned identity and rejects expired authority. Reauthentication decrypts the existing record and accepts only the same subject, normalized email, issuer and audience list before replacing ciphertext. It cannot change operator/artifact/policy identity, admit work or reconcile uncertain effects. `OperatorActivity.prepareAuthorized` atomically persists this context with prepared intent and bounds the intent deadline by signed expiry. Registry receipt artifact/policy identity must match before queueing.

## Activity-to-Worker driver

Implements the generation-fenced runtime in [REQ-OPERATOR-017](../../sdd/spec/operators.md#req-operator-017-durable-drive-generations) and [REQ-OPERATOR-018](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration).

`src/operators/runtime.ts::driveOperatorRuntime(options)` reserves an admitted activity's next drive generation and creates fresh approved code with parent-built, generation-bound capabilities. The child receives a version-1 JSON request containing `action` (`start` or `resume`), `activityId`, `generation` and the last durable `checkpoint`. Credentials remain in the parent. Only a 200 JSON response, streamed within 64 KiB and the remainder of the request-attached 25-second attempt deadline capped by human expiry, reaches the activity's checkpoint validator and generation comparison.

Thrown, oversized, malformed or expired execution is fenced as unknown rather than automatically replayed. Already-settled or active drives do not start another Worker. A waiting checkpoint can resume after activity eviction in a fresh isolate. This composes existing primitives; it adds no scheduler.

The production Loader/activity bindings and owner-scoped dispatch/cancel surfaces are declared. Aborting a Worker request or fencing a generation alone does not prove that owned sessions or SDK work stopped; the owned-session shutdown path performs that cleanup. Deployed cleanup acceptance remains pending.

## Request-attached orchestration

Implements the production direct path in [REQ-OPERATOR-018](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration).

`POST /api/operator-activities` requires enterprise authentication, CSRF protection and verified current human Access authority. The server selects the registration revision and creates the activity identity, verifier-backed start capability, invocation digest and encrypted execution context. The bounded invocation cannot select principal, policy, artifact, bucket or credential. Prepared state remains private until successful admission publishes a queued owner summary, so an unstartable prepared record is never presented as queued work. <!-- @impl: src/routes/operator-activities.ts --> <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity -->

Before a winning browser or webhook start, the parent resolves `ctx.exports.OperatorRuntimeCapability`; missing loopback authority fails closed before the activity starts. The request then attaches one `runOperatorActivity` attempt, which reopens current authority, downloads the receipt-pinned artifact and forwards the generation-bound loopback fetcher to a fresh Worker with null outbound access. `OperatorRuntimeCapability.fetch` validates its activity and generation props, durable plan, fixed Gate 1 identity and session resource before constructing the finite production capability; direct-only and non-Gate work remains deny-by-default and creates no container. <!-- @impl: src/operators/orchestrator.ts::bindOperatorRuntimeCapability --> <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @impl: src/operators/gate1-production.ts::OperatorRuntimeCapability -->

Admission pins protected distribution configuration beside its immutable receipt. Bundle transport and Worker execution share one 25-second absolute deadline below the request-extension budget. Preparation or transport failure becomes durable `unknown`; duplicate/rejected starts schedule nothing and no scheduler or automatic replay is introduced. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity -->

## Registration/admission ordering

Implements [REQ-OPERATOR-011](../../sdd/spec/operators.md#req-operator-011-serialized-operator-admission).

`src/operators/registry.ts::OperatorRegistry` owns deployment-local ordering state on SQLite-backed DO storage. `create` starts disabled and unapproved. `approve` and `setEnabled` require the current revision and increment it; replacement approval disables the registration until separately enabled.

`setDistribution(operatorId, endpoint, connectionSecret, expectedRevision)` validates the HTTPS endpoint and encrypts the connection secret for that operator before a revision-checked transaction. Configuration replacement disables the registration and clears artifact approval, without changing already-admitted receipts. Invalid configuration or unavailable encryption leaves storage unchanged. Its response excludes secrets; `getProtectedDistribution` is a parent-only discovery/download accessor, never a public projection. Authenticated discovery, approval and policy persistence are composed by the admin backend described below; runtime policy enforcement remains separate.

`approveManifest(operatorId, manifestJson, expectedRevision)` stores compatible metadata and its digest together, after checking the stable ID and derived artifact URL against the current configured endpoint. The parent must authenticate discovery and verify the artifact before calling. Approval leaves the registration disabled. `getApprovedManifest` returns only approved data, not new discovery advertisements. Admission copies the full approved manifest into its receipt; later changes cannot rewrite it. Configuration replacement and digest-only ordering approval clear current metadata. The complete manifest crosses RPC as bounded JSON text (`manifestJson` in receipts), revalidated on approval. This avoids recursive RPC serialization types without weakening the typed manifest parser.

`admit` checks the enabled approved revision and absolute human deadline, then stores an immutable receipt for the activity/intent. Identical concurrent admissions reconcile that receipt. Reusing an activity ID with changed intent, operator, revision or deadline conflicts. A receipt created before disablement remains reconcilable under unexpired authority; disablement before receipt creation blocks admission. `getReceipt` remains read-only after expiry and does not renew authority.

Each mutation is one local storage transaction. The parent must authorize and validate RPC inputs, and never provide this DO binding to a child. Discovery/network calls stay outside transactions. The activity must separately reconcile admission and atomically consume its capability with queued execution; there is no cross-DO transaction. The admin routes and SQLite registry binding are now wired in source. Current human authorization, live endpoint acceptance and later execution/interceptor integration remain distinct verification boundaries.

## Enterprise registration backend

Implements [REQ-OPERATOR-002](../../sdd/spec/operators.md#req-operator-002-enterprise-distribution-registration), [REQ-OPERATOR-013](../../sdd/spec/operators.md#req-operator-013-enterprise-operator-administration-authorization), [REQ-OPERATOR-014](../../sdd/spec/operators.md#req-operator-014-restrictive-operator-policy), [REQ-OPERATOR-008](../../sdd/spec/operators.md#req-operator-008-enterprise-operator-administration-surface), [REQ-OPERATOR-010](../../sdd/spec/operators.md#req-operator-010-bounded-operator-discovery-document), [REQ-OPERATOR-034](../../sdd/spec/operators.md#req-operator-034-authenticated-discovery-transport), and [REQ-OPERATOR-035](../../sdd/spec/operators.md#req-operator-035-approved-artifact-transport).

`/api/admin/operators` is mounted in the Worker, with `OPERATOR_REGISTRY` backed by the additive `v3` SQLite migration. Non-enterprise requests return 404. Existing authentication and administrator/group authorization run before a stricter human Access check using the existing configured issuer/audiences. The verified email must match the authenticated identity; service/setup/session authentication cannot substitute. Bodies are bounded to 64 KiB and mutation schemas reject unknown fields.

- `GET /`: safe registration states, without credentials.
- `GET /:id`: one transaction reads a consistent metadata/policy/detail projection and configured-secret flags, without decrypting or fetching from the publisher.
- `POST /:id/discover`: explicit authenticated inspection of current metadata, without approval, enablement or code execution.
- `POST /`: endpoint, connection secret and explicit policy; authenticate discovery before atomically registering metadata/configuration/policy, disabled and unapproved.
- `POST /:id/approve`: expected revision and explicit artifact digest; authenticate discovery/download, verify the chosen artifact and persist approval without enabling.
- `POST /:id/enable`: revision-checked enable/disable.
- `POST /:id/distribution`: encrypted endpoint/secret replacement, disabling and clearing prior approval/discovery.
- `POST /:id/policy`: validated restrictions, disabling until separately enabled.
- `POST /:id/webhook-key`: return a new key only on successful revision-checked rotation. Readback never reveals it; a lost response needs explicit new rotation.

`src/operators/administration.ts` owns reusable discovery/approval composition outside HTTP and outside registry transactions. Its caller must supply an authorized human-admin context. It checks actual expiry around asynchronous distribution work and never substitutes a newly advertised digest for the requested approval.

`parseOperatorPolicy` accepts only version-1 hostname, GitHub repository/method, owner-relative directory-prefix and inference allowlist/default declarations. Empty lists deny. Unknown identity/bucket fields, unsafe paths/host rules, duplicates and defaults outside allowlists fail closed. Host/repository names normalize to lowercase.

JSON is bounded to 64 KiB, lists to 128 entries, and methods/reasoning to their supported finite sets. Policy replacement stores a new revision; admitted receipts retain their original JSON. Shared direct and container interceptors enforce the stored restriction; deployed escape and credential-isolation acceptance remains pending.

The enterprise `/admin/operators` page uses these APIs through the existing Administration shell, form styles, and mobile grid behavior. It exposes explicit registration, candidate versus approved digest, approval/enablement, connection replacement, restrictions, and optional handoff-key controls. Empty registration restrictions deny external access.

Key values remain in component memory only and clear on dismissal, selection change, and unmount; rotation requires confirmation. Loading/error states are not presented as an empty registry, and conflicts never automatically repeat a mutation. Package CI is complete; actual desktop/mobile visual acceptance remains pending.

Route fixtures use simulated identity/distribution boundaries plus native durable storage, while separate signed-JWT and transport tests verify those primitives. They do not replace live Access allowed/denied proof or deployed acceptance.

## Activity admission

Implements the durable admission owner in [REQ-OPERATOR-011](../../sdd/spec/operators.md#req-operator-011-serialized-operator-admission) and [REQ-OPERATOR-016](../../sdd/spec/operators.md#req-operator-016-durable-activity-admission-and-cleanup).

`src/operators/activity.ts::OperatorActivity` owns `prepare`, `start` and a verifier-free `getAdmission` projection. The authenticated parent supplies validated intent, the start capability's SHA-256 verifier and bounded human/capability deadlines. Preparing an activity does not admit it. Raw start tokens are never stored.

`start` validates the capability before registry I/O, persists pending intent and requests admission under the same activity ID. A lost RPC response leaves that intent pending and the capability unconsumed. A subsequent attempt reconciles the registry receipt, including receipt-first admission followed by disablement. After receipt validation and a fresh expiry check, one local transaction erases the verifier and records queued execution. Concurrent or repeated starts cannot queue twice.

Queued intent does not mean execution has started or completed. Protected context, immutable policy snapshots, execution generations, checkpointing, cancellation, owner-scoped activity routes, restricted host services and request-attached direct orchestration are implemented in their owning modules. Deployed start-to-result acceptance remains pending; queued state must not be presented as complete.

## Durable drive checkpoints

Implements durable recovery and cancellation for [REQ-OPERATOR-016](../../sdd/spec/operators.md#req-operator-016-durable-activity-admission-and-cleanup) and [REQ-OPERATOR-017](../../sdd/spec/operators.md#req-operator-017-durable-drive-generations).

`OperatorActivity.beginDrive()` reserves one running generation inside the activity's existing durable record. A waiting drive resumes with its persisted checkpoint and a new generation; active or settled work cannot restart automatically. `commitDrive(generation, update)` accepts only the current running generation while human authority remains valid.

Updates have `{ schemaVersion: 1, status, checkpoint, result? }`, with status `waiting`, `completed` or `failed`, JSON checkpoint/result values, and a combined 64 KiB UTF-8 limit. Unknown fields, incompatible versions and oversized data fail without changing state.

`cancelDrive()` fences commits with `cancel-requested`; `interruptDrive(generation)` fences interrupted work as `unknown`. Neither grants renewed execution authority or claims cleanup has stopped owned compute. The parent must bind the reserved generation to capabilities and perform the required session/Worker cleanup. The runtime fixture tests persistence across native DO eviction and instance replacement; deployed execution and cleanup acceptance remain mandatory.

## Protected secrets

Implements secret protection used by [REQ-OPERATOR-002](../../sdd/spec/operators.md#req-operator-002-enterprise-distribution-registration), [REQ-OPERATOR-012](../../sdd/spec/operators.md#req-operator-012-protected-operator-webhook-keys), and [REQ-OPERATOR-025](../../sdd/spec/operators.md#req-operator-025-optional-encrypted-webhook-handoff).

`src/operators/protected-secrets.ts` supplies `sealOperatorSecret` and `openOperatorSecret` for parent-owned connection secrets, human Access credentials and webhook keys. Both reuse the existing AES-256-GCM primitives and `v1:` envelope. Authenticated context is the JSON tuple `["operator-secret-v1", purpose, recordId]`; the parent chooses the record and purpose, never the child.

An absent/invalid encryption key, plaintext value, wrong context or tampered ciphertext fails closed with a safe validation error. There is no plaintext migration, logging, persistence or alternate-key fallback in this boundary. The caller authorizes access, stores ciphertext and keeps decrypted values out of public projections/child bindings. Existing ordinary KV credential migration remains unchanged.

`createOperatorWebhookKey(recordId, env)` generates a fresh 32-byte cryptographically random base64url key and seals it for the operator's `webhook` context before returning either value. The authorized registration caller must atomically store only ciphertext, return the plaintext for one-time display, and replace the previous ciphertext on rotation. This helper does not implement persistence, display-once routing or consumer updates. The consuming Actions secret is `CODEFLARE_OPERATOR_WEBHOOK_KEY`, never the master encryption key.

`OperatorRegistry.rotateWebhookKey(operatorId, expectedRevision)` composes generation with transactional ciphertext replacement and a registration revision increment. Stale/concurrent losers receive no plaintext; encryption failure changes neither key nor revision. Ordinary registration responses omit the key and ciphertext. `getEncryptedWebhookKey` is a protected parent-only handoff-decryption seam, not an admin/public readback API. There is no retired-key fallback. A lost successful rotation response requires explicit new rotation with the current revision. The human-admin rotation route is wired in source; the display-once UI is implemented but awaits acceptance; consumer secret updates remain an explicit administrator action.

## Webhook capability handoff

Implements [REQ-OPERATOR-006](../../sdd/spec/operators.md#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-025](../../sdd/spec/operators.md#req-operator-025-optional-encrypted-webhook-handoff), [REQ-OPERATOR-026](../../sdd/spec/operators.md#req-operator-026-managed-webhook-edge-bypass), [REQ-OPERATOR-029](../../sdd/spec/operators.md#req-operator-029-capability-authenticated-webhook-edge), and [REQ-OPERATOR-031](../../sdd/spec/operators.md#req-operator-031-non-consuming-webhook-observation).

The fixed enterprise `/operator-webhook/v1/activities/:activityId/{start,status,result}` family accepts no body and authorizes only a bearer capability for the exact activity/action. Start is single-use; status is bounded read authority; result is non-consuming while not ready and consuming when available. Responses are `no-store`, rate limited, and never reflect capabilities. Managed Access bypass is provisioned only for this route family; it does not bypass the handler's enterprise, path, method, capability, expiry, or activity checks. <!-- @impl: src/routes/operator-webhook.ts -->

`createWebhookHandoff` optionally wraps the one-time start capability with AES-GCM under the separately rotated webhook key and exact deployment/operator/activity/workflow/revision/expiry context. Without a configured key it returns the plaintext capability only with an explicit workflow-input visibility warning. This is generic dispatch plumbing, not a shipped Actions workflow, Flue integration, or operational Review publisher. Deployed bypass and workflow acceptance remain pending. <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff -->

## Operator inference intersection

Implements [REQ-OPERATOR-007](../../sdd/spec/operators.md#req-operator-007-operator-aware-inference-selection).

`resolveOperatorInference` intersects the current verified human/group route catalog with the immutable admitted operator policy. A trusted parent or Pi profile may select only within that intersection; otherwise the policy default or explicitly permitted inherited human default applies. Reasoning is narrowed independently. Missing, ineligible, or disallowed selections fail before Gateway credentials or upstream I/O. Direct capabilities and container interception share this result, and ordinary human inference remains unchanged. Deployed provider evidence remains pending. <!-- @impl: src/operators/inference-selection.ts::resolveOperatorInference -->

## Owner-scoped activity surface

Implements the browser-facing portion of [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface) and [REQ-OPERATOR-033](../../sdd/spec/operators.md#req-operator-033-activity-surface-resilience).

Enterprise activity list/detail/start/cancel/result routes derive the current signed human owner key and never accept owner identity from request data. Mutations require the existing CSRF boundary; projections remain bounded and secret-free. The responsive header control and activity detail states distinguish loading, empty, attention, terminal, and unknown outcomes without treating queued work as complete. Backend and UI tests are complete; actual desktop/mobile and deployed owner-isolation acceptance remain pending. <!-- @impl: src/routes/operator-activities.ts --> <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx --> <!-- @impl: web-ui/src/components/admin/ActivityPage.tsx -->

## Owned session and structured Pi

Implements [REQ-OPERATOR-005](../../sdd/spec/operators.md#req-operator-005-owned-operator-session-lifecycle) and [REQ-OPERATOR-021](../../sdd/spec/operators.md#req-operator-021-structured-owned-pi-conversation).

`src/operators/owned-session.ts` persists parent-owned orchestration under distinct activity, Codeflare session, Pi conversation, and task identities. Creation, configuration, task submission, explicit sync, and stopping are ordered durably. Exact repeats reconcile, changed stable identities conflict, and a lost response is observed rather than converted into a second effect. Stopping fences new work before ending only the restricted owned session.

The production Gate 1 composition is deliberately fixed rather than generic. `resolveGate1Resources` accepts only operator `codeflare-gate1-fixture`, session profile `gate1-pi-file-v1`, and storage scope `gate1-output-v1`; it derives the owner bucket, restricted container profile, approved route/model, output prefix, and marker from parent state. `Gate1OperatorCapability` is generation-bound and exposes only one HTTP operation. It orders owned-session readiness, one stable structured-Pi task, explicit upload, independent parent R2 verification, and restricted stop. Direct-only operators retain the deny-by-default capability. <!-- @impl: src/operators/gate1-production.ts::createGate1ProductionCapability --> <!-- @impl: src/operators/gate1-capability.ts::Gate1OperatorCapability -->

The restricted host composes `OperatorPiConversation` beside the ordinary PTY `SessionManager`. Trusted parent configuration fixes the activity/session root, provider, model, reasoning level, system prompt, and tools. The adapter creates once or reopens only the exact recorded JSONL and conversation ID, persists task intent before SDK submission, permits one pending follow-up and one steer, and awaits abort settlement. Its 1,024-event/1-MiB memory queue and 100-event/64-KiB cursor pages report gaps instead of claiming complete history. Ordinary PTYs and intentional human root execution are unchanged. <!-- @impl: host/src/operator-pi.ts::OperatorPiConversation --> <!-- @impl: host/src/operator-pi-service.ts::createOperatorPiService -->

Restricted PID1 startup validates the paired Pi/sync identities, creates only the private activity tree, and skips whole-home restore, managed-policy restore, bisync, Vault, and clone paths. Shutdown can wait for an already accepted upload but never starts persistence. See [Container — Restricted Operator Lifecycle](container.md#restricted-operator-lifecycle) and [Internal Operator Host APIs](api-reference.md#internal-operator-host-apis).

## Explicit scoped persistence

Also implements [REQ-OPERATOR-022](../../sdd/spec/operators.md#req-operator-022-restricted-operator-container-lifecycle) and [REQ-OPERATOR-023](../../sdd/spec/operators.md#req-operator-023-explicit-operator-synchronization).

The parent fixes the owner bucket, output root, policy digest, operation prefix, and authority deadline. The host stores a credential-free receipt before effects, validates regular non-symlink files against declared size and SHA-256, uploads each bounded file, and writes `manifest.json` last. Stable completed operations reconcile; a changed repeat conflicts; a nonterminal or lost outcome is fenced as unknown and is not replayed automatically. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @impl: host/src/operator-sync-io.ts::OwnedOperatorSyncFiles -->

`OperatorActivity` separately owns the durable prepared scope, write authorization, prefix seal, uploaded manifest digest, and independently verified evidence. Host upload acknowledgement is not verification. Ordinary whole-home bisync routes are denied in restricted sessions, and human session persistence is unchanged. See [Storage & Sync — Restricted Operator Persistence](storage-and-sync.md#restricted-operator-persistence).

## Independent sync evidence

Implements independent readback for [REQ-OPERATOR-024](../../sdd/spec/operators.md#req-operator-024-independent-synchronization-verification).

`src/operators/sync-verification.ts::verifyOperatorSync(expected, read)` reads the final `manifest.json` and declared objects from the parent-selected operation prefix. The owner-scoped reader must enforce the supplied byte bound before buffering. Version-1 manifests bind activity, session, operation, request digest and policy digest, with unique canonical relative file paths, sizes and SHA-256 hashes. Limits are 64 KiB for the manifest, 128 files and 8 MiB total declared output.

The verifier compares the independently read manifest's exact digest and scope before file reads, then checks each stored file's size/digest. Expired authority, missing/changed bytes and unsafe paths fail closed. Returned file/byte counts are verification facts, not an upload acknowledgment.

The host upload, activity-owned preparation/sealing/evidence state, private receipts, and restricted shutdown drain are implemented in their owning modules. Deployed real-R2 readback, restart, expiry, and incomplete-upload acceptance remain pending. Human bisync and timestamp-based final-sync behavior are untouched.

## Consumer contract and dependency inventory

Implements [REQ-OPERATOR-009](../../sdd/spec/operators.md#req-operator-009-reusable-platform-interfaces-and-bounded-consumer-fixtures).

`src/operators/consumer-contracts.ts` is the complete Phase-1 generic consumer wire seam. It binds stable consumer/activity/operator/run, source, revision and input digests; at most 16 opaque attachment references; and parent-selected inference/session/storage references. Exact repeats reconcile and changed immutable fields conflict. Nested credential/authority names, path-like attachment names, oversized JSON and recursive operator use of human session admission fail closed. The contract grants no repository history, Review clearance, credentials, resource access or execution authority.

Current consumers and dependency direction are:

| Consumer | Uses | Does not own |
|---|---|---|
| Enterprise Operators administration | Distribution registration, approval, policy and key rotation | Execution or private operator behavior |
| Activity DO / Loader runtime | Admission receipt, protected context, generation-bound child capabilities | Human UI sessions or consumer business intent |
| Restricted container host | Parent-owned session, structured Pi and explicit sync APIs | Activity admission, R2 credentials or whole-home persistence |
| Shared interceptors | Parent-bound policy, inference selection and current human authority | Identity selection or permission grants |
| Webhook edge | Activity-scoped verifier capabilities and optional handoff envelope | Interactive identity or automatic reruns |
| Future private Flue / Remote Reviews adapters | The versioned generic contracts above | Codeflare platform internals; not shipped in Phase 1 |

Dependencies point from Codeflare adapters to these platform interfaces and from loaded private code only to parent-bound capabilities. The stateless `fixtures/operator-gate1` Worker is deployed only by explicit dispatch to the enterprise-integration environment; it requires both the Access assertion and independently provisioned connection secret and has no storage/service binding. Codeflare does not import a private Flue core, Review prompts, enrollment/monitor/publisher code or production Actions workflow. The canonical local review packet builder remains unchanged at `preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs`; its inspected Phase-1 baseline SHA-256 is `110adda054e4e7569b3043cdffee030bef20a8dbc1136ff777dd35300ffcc80d`. Fixture compatibility is not deployed review/history acceptance and does not activate merge gates.

## Verification

Behavioral tests in `src/__tests__/lib/jwt.test.ts` cover signed human identity versus legacy email authentication. `src/__tests__/operators/distribution.test.ts` covers bounded metadata, origin confinement, exact-byte integrity, module restrictions and non-execution. Full live distribution/Worker acceptance remains a separate requirement; parser tests do not prove it.
