# Operator Interface foundation

**Audience:** Platform and operator developers

**Owns:** Enterprise Operator Interface input formats; Loader, lifecycle, resource, session, synchronization, GitHub, inference, and publication-fencing boundaries; generic host-side Pi execution confinement; and the Conductor Review Pi extensions, skills, and references used to configure per-repository GitHub Actions.

**Does not own:** Private Flue code; Review packet, session, result, history, or publication business logic owned by Conductor; canonical local-review resources; enterprise permission grants; or deployment secrets.

The source boundaries identified below have focused behavioral evidence; the requirement file records which exact-head evidence is complete or pending. They do not by themselves prove every deployed operator boundary: live identity/egress/R2 and physical cleanup evidence remain distinct. Gate 1 fixture admission, execution and deployment are retired; installed Conductor and Dispatcher acceptance is recorded separately. Requirements and acceptance live in [Operators](../../sdd/spec/operators.md).

## Contents

- [Managed Dispatcher host](#managed-dispatcher-host)
- [Fenced Renovate publication](#fenced-renovate-publication)
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
- [Opaque package attachment restore](#opaque-package-attachment-restore-req-operator-052)
- [Explicit scoped persistence](#explicit-scoped-persistence)
- [Independent sync evidence](#independent-sync-evidence)
- [Consumer contract and dependency inventory](#consumer-contract-and-dependency-inventory)
- [Verification](#verification)
- [Requirement and Source Map](#requirement-and-source-map)
- [Preserved contract details](#preserved-contract-details)
- [Related Documentation](#related-documentation)

## Managed Dispatcher host

Managed receipts selecting `dispatcher` under [REQ-OPERATOR-048](../../sdd/spec/operator-registry.md#req-operator-048-dispatcher-execution) use `driveDispatcherRuntime`: reserve the existing drive once, then admit the pinned generated Flue class into the fixed Activity-private `dispatcher` facet. `OperatorActivity` extends pinned Agents 0.20.1; its constructor resumes the exact lease and its alarm delegates to the SDK before reconciliation. No namespace, migration, container or separate scheduler is introduced. Default-entrypoint dispatch remains compatible; new Gate 1 fixture execution is denied. <!-- @impl: src/operators/runtime.ts::driveDispatcherRuntime --> <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @impl: src/operators/activity.ts::OperatorActivity -->

The non-renewing lease binds generation, submission, input/release digest and the original human expiry; there is no separate custom whole-assessment cutoff. Admission/status responses remain running. Only persisted exact completed settlement, with all protected operations completed, commits waiting through `commitDrive`. Owner collection reads exactly one bounded `data-assessment` from that same completed submission and stores a terminal result without continuation or resubmission. SDK facet cleanup is a separate, exact-generation receipt; `sdkCleanupReleased` is true only after cleanup and keepalive release are durably recorded. The generic `cleanupStatus` remains conservative and does not claim physical child cessation. Cancellation fences before sending Flue abort; uncertain admission/effects interrupt rather than retry. <!-- @impl: src/operators/activity.ts::OperatorActivity -->

`OperatorDispatcherCapability` exposes bounded GitHub reads, inference, the exact pinned facet scheduler/fiber bridge, and one non-authorizing fixed diagnostic report for child-reported inference fetch/HTTP failures. The report's 256-byte/250-ms read bound, per-live-instance eight-report cap and binding-sourced Activity/generation correlation do not renew authority or enter the protected-operation ledger; strict Dispatcher-only Tail remains supplementary. The parent rechecks human eligibility and pinned installation revisions, then constructs existing `GitHubInterceptor`/`LlmInterceptor` loopbacks with parent-owned props. Credentials, the Activity stub, namespaces and direct networking never enter the child. Read scope is the invocation repository/PR, first-page files, at most 100 checks in bounded 10-run pages, and observed head; only the check fields used by the package cross the parent boundary. Raw PR patches may include secrets, so the parent passes at most an image-only, complete changed-line delta; every other patch and unrelated filename is withheld. Missing, overlapping or over-limit pages cannot become complete evidence. For Dozzle image assessments (including the selected v11.1.1→v11.1.2 PR), a separately bounded parent read derives one release tag from the admitted PR's complete Compose-image diff, accepts multiple identical old/new image updates, and rereads the unchanged PR head before and after retrieving the fixed allowlisted `amir20/dozzle` release source. Other upstream sources remain unknown rather than granting a generic crawler. A separate fixed `changed-compose` read binds complete changed files to immutable base/head blobs and returns only secret-safe Dozzle image, default UI/explicit agent command modes, option names, parent-computed non-image configuration equality and receipt references; it never returns raw inline Compose values to the child. An unchanged setting is not necessarily an understood setting: unresolved external agent topology, persistent `/data`, external overrides, interpolation, unknown mode or moved blobs remain evidence gaps. A fixed `upstream-guide` read resolves the diff-derived Dozzle version tag to an observed immutable commit and exposes only its bounded official agent guide with a commit-pinned citation source. The child cannot select a web URL, file path or credentials. Missing, conflicting, redirected or oversized evidence fails closed; release notes and guide alone are not a compatibility verdict or merge authority. The package's two-turn assessment asks the model to reason from authentic quoted upstream passages and complete projected configuration, retaining `unknown` when support is insufficient; the validator binds quotes and references to parent receipts rather than pretending to prove prose semantics. Check observations remain separate from later current-head merge policy. Inference uses the current eligible human default. Non-null resource profiles fail closed. The precise wire/limits live in the [registry contract](../../sdd/spec/operator-registry-contract.md#parent-capability-operations). <!-- @impl: src/operators/activity.ts::OperatorDispatcherCapability -->

Verification: `dispatcher-production.test.ts` covers bounded pages, release-source derivation and head/timeout fencing, exact-settlement result collection, fail-closed output and SDK cleanup with instrumented transports. The pinned generated-Flue native fixture tests the compiled child requesting and carrying a cited release through a synthetic parent transport; it does not independently prove the live protected upstream bridge or physical production eviction. Enterprise Integration's installed v0.1.2 Activity returned a durable read-only PR #1173 result with incomplete assessment; this is execution proof, not a positive Renovate finding or production test.

## Fenced Renovate publication

[REQ-OPERATOR-060](../../sdd/spec/operator-registry.md#req-operator-060-fenced-renovate-publication) separates the explicit authenticated admin publication command from assessment/result reads. The command selects an active owner session and lifecycle generation; the Activity pins that binding and its immutable completed assessment, rereads Access identity, current admin role, installation/grants and exact session before protected I/O, and holds a durable per-effect intent before the parent's credentialed GitHub transport writes. The legacy single-PR assessment child has no publication command or credential. Repository-only packages may request GET/POST/PUT through the existing parent-authorized transport; see [Dispatcher transport](dispatcher-generic-transport.md). The independent one-off target remains the user's selected Komodo #1299 (numeric repository ID 973175879). Separately, the dormant prospective gate requires explicit current admin/session activation and SDK-scheduled scans of authenticated, complete Komodo GitHub pages; only PRs created strictly after its immutable server cutoff can receive one Registry-elected Activity, and publication requires matching live actor, session, installation, owner and head proof. A schedule failure returns an error and can be retried without advancing the cutoff; the callback can request publication only through the separate independently fenced Activity publisher; the child cannot publish. No historical PR is authorized through this prospective path. Unsafe/unknown findings can produce a bounded comment; safe requires cited release, guide and configuration evidence plus fresh bot, revision, permission, check, status, review, branch/ruleset and mergeability observations before review approval and expected-head merge. An unavailable or unfamiliar protection rule blocks rather than guessing. Uncertain writes are read back under the pinned effect marker and are never blindly replayed; an externally merged PR is not falsely attributed to this command. GitHub supports a compare-and-swap head SHA for merge, **not an atomic base-SHA guard**: the base is checked immediately before each effect, and a concurrent base change after that check remains a documented race. This is dormant implementation, not a live #1299 verdict, deployment, activation or merge.

## Verified human context

Implements [REQ-OPERATOR-001](../../sdd/spec/operators.md#req-operator-001-verified-human-access-claims).

`src/lib/jwt.ts::verifyHumanAccessJWT(token, authDomain, audience)` returns signed human subject/email/issuer/audiences and actual issued-at/expiry, or null. It shares cryptographic verification with the unchanged ordinary email API. It does not return the token, grant operator eligibility, resolve an owner bucket or renew authority. See [Authentication](authentication.md#human-access-claims-for-the-operator-interface).

## Distribution validation

Implements the distribution and registration boundaries in [REQ-OPERATOR-002](../../sdd/spec/operators.md#req-operator-002-enterprise-distribution-registration), [REQ-OPERATOR-010](../../sdd/spec/operators.md#req-operator-010-bounded-operator-discovery-document), [REQ-OPERATOR-030](../../sdd/spec/operators.md#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-034](../../sdd/spec/operators.md#req-operator-034-authenticated-discovery-transport), and [REQ-OPERATOR-035](../../sdd/spec/operators.md#req-operator-035-approved-artifact-transport).

`src/operators/distribution.ts` provides pure typed boundaries:

- `parseOperatorManifest(json, endpoint)` validates at most 64 KiB of discovery JSON and resolves a canonical artifact path only against the registered HTTPS origin.
- `parseOperatorBundle(bytes, approvedSha256)` checks at most 8 MiB of exact artifact bytes, validates compatible JS/text modules and returns data without executing it. The bundle cannot supply environment bindings or outbound configuration.

Both reject invalid input with a safe `ValidationError`. `npm run compile:operator-package -- <configuration.json> <output-directory>` deterministically emits those existing manifest and Operator/Dispatcher bundle shapes, plus optional registry provenance, while deriving exact bundle/resource digests and sizes. The compiler accepts no policy, bindings, credentials, environment, or outbound authority.

Network callers must still bound responses before buffering, authenticate the invoking human and connection secret, reject redirects/login responses and enforce artifact approval. An advertised digest is integrity metadata, not independent publisher authenticity or user eligibility.

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

GitHub decisions resolve only canonical REST `/repos/{owner}/{repo}/…` or Smart HTTP `{owner}/{repo}.git/…` paths and require both declared repository and method before `GitHubInterceptor` looks up a token. General egress decisions run before Gateway forwarding.

Own-account R2 decisions run before scoped-key lookup/signing: GET/HEAD/list use read prefixes; PUT and multipart writes use write prefixes; copy, delete and unknown controls are denied. Multipart abort additionally requires the parent to identify the upload as activity-owned. Empty declarations deny; these restrictions never create human authority.

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

Before a winning browser or webhook start, the parent resolves `ctx.exports.OperatorRuntimeCapability`; missing loopback authority fails closed before the activity starts. The request then attaches one `runOperatorActivity` attempt, which reopens current authority, downloads the receipt-pinned artifact and forwards the generation-bound loopback fetcher to a fresh Worker with null outbound access. `OperatorRuntimeCapability.fetch` validates its activity and generation props and durable plan, delegates supported Conductor and read-only Renovate assessment behavior, and denies retired Gate 1 and unsupported profiles without creating a container. Installed Dispatcher effects use the separate Activity-bound capability. <!-- @impl: src/operators/orchestrator.ts::bindOperatorRuntimeCapability --> <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @impl: src/operators/operator-runtime-capability.ts::OperatorRuntimeCapability -->

Admission pins protected distribution configuration beside its immutable receipt. <!-- @impl: src/operators/registry.ts::OperatorRegistry.admit --> Bundle transport and Worker execution share one 25-second absolute deadline below the request-extension budget. Bundle preparation or transport failure after a winning start becomes durable `unknown`; duplicate/rejected starts schedule nothing and no scheduler or automatic replay is introduced. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @impl: src/operators/activity.ts::OperatorActivity.start --> <!-- @impl: src/routes/operator-activities.ts -->

## Registration/admission ordering

Implements [REQ-OPERATOR-011](../../sdd/spec/operators.md#req-operator-011-serialized-operator-admission).

`src/operators/registry.ts::OperatorRegistry` owns deployment-local ordering state on SQLite-backed DO storage. `create` starts disabled and unapproved. `approve` and `setEnabled` require the current revision and increment it; replacement approval disables the registration until separately enabled.

`setDistribution(operatorId, endpoint, connectionSecret, expectedRevision)` validates the HTTPS endpoint and encrypts the connection secret for that operator before a revision-checked transaction. Configuration replacement disables the registration and clears artifact approval, without changing already-admitted receipts. Invalid configuration or unavailable encryption leaves storage unchanged. Its response excludes secrets; `getProtectedDistribution` is a parent-only discovery/download accessor, never a public projection. Authenticated discovery, approval and policy persistence are composed by the admin backend described below; runtime policy enforcement remains separate.

`approveManifest(operatorId, manifestJson, expectedRevision)` stores compatible metadata and its digest together, after checking the stable ID and derived artifact URL against the current configured endpoint. The parent must authenticate discovery and verify the artifact before calling. Approval leaves the registration disabled. `getApprovedManifest` returns only approved data, not new discovery advertisements. Admission copies the full approved manifest into its receipt; later changes cannot rewrite it. Configuration replacement and digest-only ordering approval clear current metadata. The complete manifest crosses RPC as bounded JSON text (`manifestJson` in receipts), revalidated on approval. This avoids recursive RPC serialization types without weakening the typed manifest parser.

`admit` checks the enabled approved revision and absolute human deadline, then stores an immutable receipt for the activity/intent. Identical concurrent admissions reconcile that receipt. Reusing an activity ID with changed intent, operator, revision or deadline conflicts. A receipt created before disablement remains reconcilable under unexpired authority; disablement before receipt creation blocks admission. `getReceipt` remains read-only after expiry and does not renew authority.

Each mutation is one local storage transaction. The parent must authorize and validate RPC inputs, and never provide this DO binding to a child. Discovery/network calls stay outside transactions. The activity must separately reconcile admission and atomically consume its capability with queued execution; there is no cross-DO transaction. The SQLite registry still supports historical default-entrypoint state, but the Gate 1 administration HTTP route is retired. Installed release management uses `/api/operator-management`. Current human authorization, live endpoint acceptance and later execution/interceptor integration remain distinct verification boundaries.

## Historical Gate 1 distribution and installed release management

Implements [REQ-OPERATOR-002](../../sdd/spec/operators.md#req-operator-002-enterprise-distribution-registration) and [REQ-OPERATOR-013](../../sdd/spec/operators.md#req-operator-013-enterprise-operator-administration-authorization). The old `/api/admin/operators` registration, discovery, approval, and webhook-key HTTP endpoints have been removed; even Enterprise requests return 404. The old `/admin/operators` bookmark redirects to `/operators`. Enterprise admins now manage the catalog inside the incumbent Administration navigation, with a selected-operator overview and direct release, installation and grant sections; eligible non-admin managers retain the standalone workspace entry. Source credentials are write-only, release pinning and enablement remain separate, and a status badge never substitutes for authorization.

Release presentation implements [REQ-OPERATOR-049](../../sdd/spec/operator-registry.md#req-operator-049-operators-management-interface). When package metadata omits a display version, the verified GitHub release tag labels the option and pinned installation. The catalog says version details are unavailable when an installed pin has no tag; legacy release choices may show a numeric GitHub release identifier, not as the version. The exact digest remains available for audit. Its release/installation management API is `/api/operator-management`, with independent human and grant checks. Existing internal default-entrypoint registry invariants are retained for historical activity compatibility; deleting the old HTTP/UI surface does not delete or alter installed release records.

`parseOperatorPolicy` accepts only version-1 hostname, GitHub repository/method, owner-relative directory-prefix and inference allowlist/default declarations. Empty lists deny. Unknown identity/bucket fields, unsafe paths/host rules, duplicates and defaults outside allowlists fail closed. Host/repository names normalize to lowercase.

JSON is bounded to 64 KiB, lists to 128 entries, and methods/reasoning to their supported finite sets. Policy replacement stores a new revision; admitted receipts retain their original JSON. Shared direct and container interceptors enforce the stored restriction; deployed escape and credential-isolation acceptance remains pending.

The retired test editor and its browser client have been removed. The installed operator catalog is the only user-facing management area. Its usability and responsive visual acceptance remain a separate open task after functional execution proof; release/installation tests do not substitute for that acceptance.

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

The fixed enterprise `/operator-webhook/v1/activities/:activityId/{start,status,continue,result}` family authorizes only a bearer capability for the exact activity/action. Only POST `continue` accepts bounded JSON `{ "generation": 1 }`; other operations accept no body. Start is single-use; status returns metadata and generation without result bytes. Continuation atomically claims one safely waiting observed generation, and its scheduled drive reservation denies delayed or duplicate claims. Result is non-consuming while not ready and consuming when available. Responses are `no-store`, rate limited, and never reflect capabilities. Managed Access bypass is provisioned only for this route family; it does not bypass the handler's enterprise, path, method, capability, expiry, or activity checks. <!-- @impl: src/routes/operator-webhook.ts -->

`createWebhookHandoff` optionally wraps the one-time start capability with AES-GCM under the separately rotated webhook key and exact deployment/operator/activity/workflow/revision/expiry context. Without a configured key it returns the plaintext capability only with an explicit workflow-input visibility warning. This is generic dispatch plumbing, not a shipped Actions workflow, Flue integration, or operational Review publisher. Deployed bypass and workflow acceptance remain pending. <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff -->

## Operator inference intersection

Implements [REQ-OPERATOR-007](../../sdd/spec/operators.md#req-operator-007-operator-aware-inference-selection).

`resolveOperatorInference` intersects the current verified human/group route catalog with the immutable admitted operator policy. A trusted parent or Pi profile may select only within that intersection; otherwise the policy default or explicitly permitted inherited human default applies. Reasoning is narrowed independently. Missing, ineligible, or disallowed selections fail before Gateway credentials or upstream I/O. Direct capabilities and container interception share this result, and ordinary human inference remains unchanged. Deployed provider evidence remains pending. <!-- @impl: src/operators/inference-selection.ts::resolveOperatorInference -->

## Owner-scoped activity surface

Implements the browser-facing portion of [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface), [REQ-OPERATOR-057](../../sdd/spec/operators.md#req-operator-057-readable-owned-activity-results), [REQ-OPERATOR-033](../../sdd/spec/operators.md#req-operator-033-activity-surface-resilience), and [REQ-OPERATOR-040](../../sdd/spec/operators.md#req-operator-040-owned-activity-control-presentation).

Enterprise activity routes derive the signed human owner key; request data cannot select another owner. Mutations require CSRF; projections remain bounded and secret-free. <!-- @impl: src/routes/operator-activities.ts -->

The header control and detail distinguish loading, empty, attention, terminal and unknown outcomes without treating queued work as complete. The overview renders at document level so a filtered ancestor cannot contain it. Desktop anchoring uses measured trigger coordinates; width changes close the panel. Focus moves into the panel on open and returns to the trigger when still inside at dismissal. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx -->

Five-at-a-time owner history retains at most 20 browsable summaries per operator without deleting historical Activity results. The icon badge shows admissions since the owner's last successfully acknowledged open; a failed acknowledgment leaves them unread. Opening acknowledges only the observed revision and does not collect a result. Readable Review reports have behavioral tests. Final exact-head GREEN, desktop/mobile inspection and deployed owner-isolation acceptance remain pending. <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx --> <!-- @test: web-ui/src/__tests__/components/OperatorActivityButton.test.tsx (REQ-OPERATOR-057: presents original Review lane findings and incomplete reports as readable evidence, not raw JSON) -->

## Owned session and structured Pi

Implements [REQ-OPERATOR-005](../../sdd/spec/operators.md#req-operator-005-owned-operator-session-lifecycle) and [REQ-OPERATOR-021](../../sdd/spec/operators.md#req-operator-021-structured-owned-pi-conversation).

`src/operators/owned-session.ts` persists parent-owned orchestration under distinct activity, Codeflare session, Pi conversation, and task identities. Creation, configuration, task submission, explicit sync, and stopping are ordered durably.

Exact repeats reconcile, changed stable identities conflict, and a lost response is observed rather than converted into a second effect. Stopping fences new work before ending only the restricted owned session.

The legacy Gate 1 fixture backend and its deployment workflow are retired. Historical Activity records remain, but its operator identity cannot prepare new work and an already-prepared fixture receipt receives a deny-by-default loopback. Installed Dispatcher and Conductor paths are unaffected. <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity --> <!-- @impl: src/operators/operator-runtime-capability.ts::OperatorRuntimeCapability -->

The restricted host composes `OperatorPiConversation` beside the ordinary PTY `SessionManager`. Trusted parent configuration fixes the activity/session root, provider, model, reasoning level, system prompt, and tools. The adapter creates once or reopens only the exact recorded JSONL and conversation ID, then persists task intent before SDK submission.

It invokes an active approved Pi tool directly for deterministic tool tasks, permits one pending follow-up and one steer, and awaits abort settlement. Native tool execution uses the SDK session's active tool definitions rather than asking a model to choose a tool.

Its 1,024-event/1-MiB memory queue and 100-event/64-KiB cursor pages report gaps instead of claiming complete history. Ordinary PTYs and intentional human root execution are unchanged. <!-- @impl: host/src/operator-pi.ts::OperatorPiConversation --> <!-- @impl: host/src/operator-pi-service.ts::createOperatorPiService -->

Restricted PID1 startup validates the paired Pi/sync identities, creates the private activity tree plus the human-readable `~/Operators` folder, and skips whole-home restore, managed-policy restore, bisync, Vault, and clone paths. Shutdown can wait for an already accepted upload but never starts persistence. See [Container — Restricted Operator Lifecycle](container.md#restricted-operator-lifecycle) and [Internal Operator Host APIs](api-reference.md#internal-operator-host-apis).

## Opaque package attachment restore ([REQ-OPERATOR-052](../../sdd/spec/operator-registry.md#req-operator-052-opaque-package-resources))

At admission the parent owns attachment locator metadata, canonical relative paths, exact sizes and SHA-256 digests; package code receives no bucket credentials or arbitrary destination. The activity persists this bounded projection, and owned-session configuration exposes it only to restricted startup. After port 8080 is confirmed bound with readiness still closed, PID1 restores at most 16 attachments and 8 MiB beneath `/run/codeflare/operator-resources/input/`, rejects symlinks and path escapes, and verifies every restored file before initialization completes.

Missing R2 configuration, an unbound terminal port, unavailable bytes, or an identity mismatch fails closed before Operator work starts. These inputs remain outside synchronized human storage; packages alone interpret their contents. <!-- @impl: src/operators/attachments.ts --> <!-- @impl: src/container/index.ts::configureOperatorAttachments --> <!-- @impl: scripts/restore-operator-attachments.mjs --> <!-- @impl: entrypoint.sh -->

## Explicit scoped persistence

Also implements [REQ-OPERATOR-022](../../sdd/spec/operators.md#req-operator-022-restricted-operator-container-lifecycle) and [REQ-OPERATOR-023](../../sdd/spec/operators.md#req-operator-023-explicit-operator-synchronization).

The parent fixes the owner bucket, `~/Operators` output root, policy digest, private manifest prefix, and authority deadline. The authenticated `/internal/bisync-trigger` is the operator's scoped Sync now control: the host stores a credential-free receipt before effects, validates regular non-symlink declared files against size and SHA-256, mirrors those paths under `Operators/`, and writes the private `.codeflare/operators/` manifest last. It never performs implicit deletion or whole-home fan-out. Stable completed operations reconcile; a changed repeat conflicts; a nonterminal or lost outcome is fenced as unknown and is not replayed automatically. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @impl: host/src/operator-sync-io.ts::OwnedOperatorSyncFiles -->

`OperatorActivity` separately owns the durable prepared scope, write authorization, prefix seal, uploaded manifest digest, and independently verified evidence. Host upload acknowledgement is not verification. Ordinary human Sync now remains unchanged, while restricted final sync stays denied. See [Storage & Sync — Restricted Operator Persistence](storage-and-sync.md#restricted-operator-persistence).

## Independent sync evidence

Implements independent readback for [REQ-OPERATOR-024](../../sdd/spec/operators.md#req-operator-024-independent-synchronization-verification).

`src/operators/sync-verification.ts::verifyOperatorSync(expected, read)` reads the final manifest from the private operation prefix and declared objects from `Operators/`. The owner-scoped reader must enforce the supplied byte bound before buffering. Version-1 manifests bind activity, session, operation, request digest and policy digest, with unique canonical relative file paths, sizes and SHA-256 hashes. Limits are 64 KiB for the manifest, 128 files and 8 MiB total declared output.

The verifier compares the independently read manifest's exact digest and scope before file reads, then checks each stored file's size/digest. Expired authority, missing/changed bytes and unsafe paths fail closed. Returned file/byte counts are verification facts, not an upload acknowledgment.

The host upload, activity-owned preparation/sealing/evidence state, private receipts, and restricted shutdown drain are implemented in their owning modules. Deployed real-R2 readback, restart, expiry, and incomplete-upload acceptance remain pending. Human bisync and timestamp-based final-sync behavior are untouched.

## Consumer contract and dependency inventory

Implements [REQ-OPERATOR-009](../../sdd/spec/operators.md#req-operator-009-reusable-platform-interfaces-and-bounded-consumer-fixtures).

`src/operators/consumer-contracts.ts` is the complete Phase-1 generic consumer wire seam. It binds stable consumer/activity/operator/run, source, revision and input digests; at most 16 opaque attachment references; and parent-selected inference/session/storage references.

Exact repeats reconcile and changed immutable fields conflict. Nested credential/authority names, path-like attachment names, oversized JSON and recursive operator use of human session admission fail closed. The contract grants no repository history, Review clearance, credentials, resource access or execution authority.

Current consumers and dependency direction are:

| Consumer | Uses | Does not own |
|---|---|---|
| Enterprise Operators administration | Distribution registration, approval, policy and key rotation | Execution or private operator behavior |
| Activity DO / Loader runtime | Admission receipt, protected context, generation-bound child capabilities | Human UI sessions or consumer business intent |
| Restricted container host | Parent-owned session, structured Pi and explicit sync APIs | Activity admission, R2 credentials or whole-home persistence |
| Shared interceptors | Parent-bound policy, inference selection and current human authority | Identity selection or permission grants |
| Webhook edge | Activity-scoped verifier capabilities and optional handoff envelope | Interactive identity or automatic reruns |
| Conductor Review package | Generic Operator Interface, lifecycle, resources, sessions, synchronization, GitHub/inference boundaries and publication fencing | Review packet, session, result, history and publication business behavior |
| Future private Flue adapters | The versioned generic contracts above | Codeflare platform internals; not shipped in Phase 1 |

Dependencies point from Codeflare adapters to these platform interfaces and from loaded private code only to parent-bound capabilities. The retired Gate 1 fixture is no longer a deploy target.

Codeflare does not implement Review packet preparation, session orchestration, result semantics, history reconciliation, or publication policy; those behaviors belong to the installed Conductor. Codeflare distributes Conductor Review Pi extensions, skills, and references, while generic host-side Pi sandbox/security primitives remain Codeflare execution confinement.

The obsolete Codeflare-repository `boundary-reviews.yml` shadow workflow is retired from development: its single-origin variable could not run the three-origin collector. The dormant enrollment candidate instead proposes a reviewed target-repository workflow PR referring to an immutable Codeflare `boundary-runtime.yml` commit. That reusable workflow checks out **only** the pinned Codeflare runtime (not target PR code or the target's root package), and gives the collect job no publisher privileges; installer-fixed dev/Integration/production origins and non-consuming discovery must select one preprepared user-owned Activity before claim. The separate publish job independently revalidates the terminal result and PR context. <!-- @impl: src/operators/boundary-action-installation.ts::proposeBoundaryWorkflow --> <!-- @impl: .github/workflows/boundary-runtime.yml::publish --> <!-- @impl: scripts/operator-boundary-action.mjs::selectBoundaryOrigin -->

Pi Review routing is separate from the protected Action's origin selection. At an eligible PR boundary, the external `operator-review-selector.ts` registers only the dedicated `operator-review-remote.ts` handlers when Codeflare confirms an active applicable Action; confirmed absence or inactivity invokes the unchanged local Review extension; ambiguous or broken active enrollment invokes neither. The runtime excludes direct autoload of the local implementation so it cannot run beside the remote path, and reselects when the active repository changes. Remote Review reads the parent's independently authenticated GitHub artifact, comment, check and run under the current user's GitHub repository access; it does not read another user's private Activity, run local reviewers or publish. A selected Activity without independent publication and exact-head CI is pending, not cleared. The dedicated dormant selector/result consumer passed full exact-head Test `36457559457` at `65d1512409449b5e18a31ad36ba0dff17eafc597`; this verifies neither an activated Action nor a live receipt. After complete same-session triage, a rejected published finding may be carried to the next matching PR/head with its immutable publication reference, rationale and evidence. The current actor's parent reauthenticates that publication before putting bounded context in approved reviewer packets; Conductor alone independently reassesses it. Submission, silence or missing publication evidence never clears the prior finding. The compiled Conductor fixture comes from exact-source `c40527ee21664012d326d73efcfd26889302deff` release run `36465347782` (bundle SHA-256 `a80a049069a33038c281804c9eb6f7f0ba3c24f486659928929b750c7e21cf4e`); this is package evidence, not installed live proof. Enrollment activation and live runtime proof require separate authorization and verification. <!-- @impl: preseed/agents/pi/extensions/operator-review-selector.ts::registerOperatorReviewSelector --> <!-- @impl: preseed/agents/pi/extensions/operator-review-remote.ts::registerOperatorReviewRemote -->

Dormant administrator enrollment procedure (not remote activation): configure `OPERATOR_REVIEW_EXECUTABLE_SHA` to the exact tested Codeflare runtime commit and `OPERATOR_REVIEW_ORIGINS` to a JSON object with precisely `dev`, `integration`, `production` HTTPS origins maintained by the installer. Do not derive these from a target PR or a request; missing or unverified configuration rejects enrollment. A platform administrator with a current Codeflare GitHub connection and repository workflow-write permission submits `{ "repositoryUrl": "https://github.com/OWNER/REPO", "protectedRef": "refs/heads/main", "installationId": "APPROVED_CONDUCTOR_INSTALLATION" }` to `POST /api/operator-management/boundary-actions/propose` with authenticated Codeflare Access and CSRF protection. The proposal is an ordinary target-repository PR; inspect and merge it under that repository's protected-branch policy. Only afterwards submit the same target to `POST /api/operator-management/boundary-actions/verify`; Codeflare rereads the protected-base workflow ID/path/bytes and stores an **inactive** binding. A pending PR, successful test or verification alone never starts Review or grants Action claim authority. Actual activation, production use and live publication require separate authorization and end-to-end proof. An explicitly inactive binding permits local review only when the repository has no competing active Review binding. The maintained runtime pin, target installation and live publication remain unverified until independently exercised. <!-- @impl: src/operators/boundary-action-installation.ts::verifyBoundaryWorkflow -->

The canonical local review packet builder remains unchanged at `preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs`; its inspected Phase-1 baseline SHA-256 is `110adda054e4e7569b3043cdffee030bef20a8dbc1136ff777dd35300ffcc80d`. Fixture compatibility is not deployed review/history acceptance and does not activate merge gates.

The bounded approved-packet Host route is composed only for Enterprise user sessions, not restricted operator sessions; this candidate has not been deployed. It accepts inert Git pack bytes and fixed metadata, executes the image-baked script in the isolated runner without a Git credential, and returns bounded bytes. The source session's ordinary container token authenticates the Host hop; that token alone is **not** a claimed-Action authorization.

The private Conductor packet operation is a candidate parent caller under [REQ-OPERATOR-050](../../sdd/spec/operator-registry.md#req-operator-050-generic-conductor-capability). It checks the claimed activity, current human/installation, exact PR/Action and D1 generation before Git upload-pack, source-session Host execution and accepting the output (`src/operators/conductor-production.ts`). The parent conditionally stores exact bytes in the owner bucket, reads them back, then commits the Activity's immutable descriptor (`src/operators/activity.ts`).

The owned reviewer session projects those descriptors before startup, and restoration verifies digest and size (`scripts/materialize-operator-inputs.mjs`). These code paths and fixtures still require exact-head CI, an installed current package, deployment and a protected sandbox receipt; they are not production Review proof.

## Verification

Behavioral tests in `src/__tests__/lib/jwt.test.ts` cover signed human identity versus legacy email authentication. `src/__tests__/operators/distribution.test.ts` covers bounded metadata, origin confinement, exact-byte integrity, module restrictions and non-execution. Full live distribution/Worker acceptance remains a separate requirement; parser tests do not prove it.

## Requirement and Source Map

- [Operator identity and distribution](../../sdd/spec/operators.md#req-operator-001-verified-human-access-claims): `src/lib/jwt.ts`, `src/operators/distribution.ts`, and `src/operators/distribution-client.ts`.
- [Admission and execution](../../sdd/spec/operators.md#req-operator-011-serialized-operator-admission): `src/operators/registry.ts`, `src/operators/activity.ts`, `src/operators/execution-context.ts`, and `src/operators/runtime.ts`.
- [Owned session and persistence](../../sdd/spec/operators.md#req-operator-005-owned-operator-session-lifecycle): `src/operators/owned-session.ts`, `host/src/operator-pi.ts`, `host/src/operator-sync.ts`, and `src/operators/sync-verification.ts`.
- [Supported runtime capability](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration): `src/operators/operator-runtime-capability.ts`.
- [Management, webhook, and consumer seams](../../sdd/spec/operators.md#req-operator-008-enterprise-operator-administration-surface): `src/routes/operator-management.ts`, `src/routes/operator-webhook.ts`, and `src/operators/consumer-contracts.ts`.

## Related Documentation

- [Container — Restricted Operator Lifecycle](container.md#restricted-operator-lifecycle)
- [Storage & Sync — Restricted Operator Persistence](storage-and-sync.md#restricted-operator-persistence)
- [Authentication — Human Access claims](authentication.md#human-access-claims-for-the-operator-interface)
- [API Reference — Operator APIs](api-reference.md)

## Preserved contract details

These clauses retain the existing transport and fencing contract after the requirement granularity correction. Their requirement/test evidence remains in the [registry specification](../../sdd/spec/operator-registry.md). This relocation grants no new capability or activation.

### REQ-OPERATOR-047 contract details

- The parent normalizes and digests input, selects the profile and resources, and rejects caller authority or resource substitution.
- Generation, expiry, cancellation and installation policy are checked before protected effects.
- Protected operations recheck the current human and exact installation and release revisions through parent-owned interceptors. A matching current Cloudflare identity without group assertions can use an explicit user grant but cannot satisfy a group-only grant; malformed or mismatched identity remains denied.
- Repeated identical operations reconcile, changed input conflicts, and uncertain effects are not replayed.
- Completed output is bounded and durable before delivery; unknown completion is fenced.
- Parent-composed profiles confine independent SDK task sessions to finite parent-approved input references, exact filesystem reads and outputs, immutable report staging, and no candidate extension or broader Host access.
- Repository-only Dispatcher source transport accepts bounded GET/POST/PUT operations with immutable IDs and bodies; mutations use only the original parent's configured authenticated GitHub API transport. Unknown mutations preserve the generation for readbacks and never replay.
- Approved package code validates domain readback semantics before requesting generic resolution. The parent seals only original request-digest and immutable later completed GET receipt references in the same authorized Activity/generation; missing references, conflicts and revoked authority cannot resolve. The unresolved completion fence remains.
- Repository-only Loader code receives the validated non-secret configured GitHub API origin and decimal-string `OPERATOR_SOURCE_RESPONSE_BYTES` from its admitted installation policy; legacy bindings remain unchanged. The configurable source allowance applies to upstream body, encoded source envelope, Activity receipt reader/cache and globalOutbound unwrapping, not requests/inference/final results/SDK-history limits.

### REQ-OPERATOR-048 contract details

- The child runtime executes the pinned generated Flue artifact through the delegated Loader capability.
- One durable execution lease remains bound to its original generation, submission, input, release and expiry. No separate fixed whole-assessment cap cuts off an otherwise authorized second inference or settled assessment; the original human-authorization deadline still bounds the lease and fences late settlement.
- Admission and status observation neither create a waiting checkpoint nor renew authority. An empty early child snapshot schedules bounded rechecks within the original lease, not a new admission or an extension past expiry. Repeated SDK alarms while settlement is pending must retain at most one pending recheck and the original deadline; an exact later settlement remains collectable without readmission, while the original deadline still fences pending work.
- Only the exact completed settlement with one bounded `data-assessment` and no outstanding or unknown protected operation may commit waiting. A text-only completed turn, duplicate result, late settlement or failed work stays fenced; a valid settlement arriving after an empty snapshot can be observed before expiry without caller continuation.
- Cancellation, expiry, revocation and stale warmed callers deny subsequent protected work.
- The legacy assessment Dispatcher receives only bounded parent-authorized reads, inference and scheduling plus the scoped diagnostic report; repository-only approved transport is governed by REQ-OPERATOR-062. It receives not sessions, containers, credentials or direct networking. The facet bridge denies foreign paths, generations and oversized notices and exposes no parent connections or broadcasts.
- Existing activity identity, storage, Gate 1 and default-entrypoint behavior remain compatible.
- The parent operation path emits one bounded structured rejection diagnostic for conflicts, uncertain protected effects, expired authority and upstream rejection alongside the existing fenced response. The diagnostic contains only a fixed observed stage (`reservation`, `effect`, `authority`, `upstream`, `forwarded-upstream`, `commit`), the parsed resource enum or `unparsed` when authority denies before parsing, whether the lease deadline is `current`, `expired` or `unavailable` when no lease is present, and response status; it contains no request body, credentials, evidence, arbitrary exception text or identifiers. A forwarded upstream HTTP 409 retains its body and running lease while receiving a `forwarded-upstream` diagnostic, distinguishable from a parent-generated fenced 409 after a rejected upstream response (`upstream`). A returned disallowed upstream HTTP status is distinguishable from a rejected transport or unreadable completed response (`effect`), and from a result-commit failure. A nested release/guide error thrown before an HTTP response remains an `effect` failure; these stages do not diagnose the earlier live execution.
- Before fencing a failed child settlement, the owner emits bounded structured telemetry with its trusted Activity ID and generation, allowlisted error type and operation, and recognized failure class; unrecognized or malformed child metadata is `unknown`. The pinned Flue durable submission labels the operation `direct(<submission id>)`; only a direct label matching the current lease's validated submission ID yields the fixed `direct` class, never the dynamic ID. A foreign or malformed ID is unknown. Recognized reasons require exact matches, not substring matches. The existing owner state remains the authority; no new durable record or endpoint is introduced. No arbitrary reason, prompt, credential, or tool arguments enter the diagnostic. This telemetry cannot authorize collection, replay or continuation.
- The approved Dispatcher Dynamic Worker alone attaches a Tail Worker bound to its trusted Activity ID and generation. It examines at most 64 Tail events and 128 log records per invocation and forwards at most eight **child-reported** diagnostics: exact fixed `fetch-rejected` or `http-rejected` with an integer non-success HTTP status (300–599), as bounded structured owner-side telemetry. Every other child log, exception, prompt, response body, unknown field and identifier is dropped; the Tail Worker grants no child operation or authorization. A missing or delayed Tail event does not reclassify settlement, authorize replay, or imply a successful assessment; Tail is supplementary, not the acceptance channel for compiled-child inference failures.
- The same two fixed adapter classifications reach the owner through an explicit POST `/v1/dispatcher/diagnostic` on the existing Dispatcher-only service binding, independently of Tail delivery. The owner accepts only exact JSON `{ "stage": "fetch-rejected" }` or `{ "stage": "http-rejected", "status": 300..599 }` with at most 256 request bytes and a 250 ms read bound; wrong method/path/content type/syntax/status, unknown fields, oversized or unfinished bodies fail closed. At most eight valid reports are logged per live Activity instance/generation (the transient count resets on eviction; no durable telemetry ledger is added). It correlates using the binding's trusted Activity and current generation, never any child-supplied identity, and emits only those fixed fields in structured owner-side telemetry. Reporting is bounded and best-effort: no authority renewal, settlement/cleanup mutation, replay, result publication or exposure to other children; failure or unavailability cannot replace the original inference error or postpone settlement indefinitely. A diagnostic is an observed child-reported failure boundary, not proof of the cause of a prior live Activity.

### REQ-OPERATOR-051 contract details

- The parent permits only admitted-repository, bounded PR, check and secret-safe diff reads; package-owned bot policy decides which read-only requests qualify.
- Compiled recommendations bind exact observed heads and report stale, truncated, rate-limited or insufficient evidence as unknown, never a positive compatibility inference.
- The parent denies repository mutation, session or container creation, and unattended reruns.
- The parent may return bounded, cited upstream release notes only when the admitted PR's complete Compose image diff establishes one allowlisted source and consistent old/new tags (not a permanently pinned #1299 version), including multiple identical image updates. It rereads the exact PR head before and after the upstream fetch and rejects moved, missing, conflicting, truncated, redirecting, oversized or child-selected sources, without inferring compatibility or conferring merge authority.
- A fixed, child-path-free `changed-compose` read obtains all changed Compose files from the admitted PR at immutable base/head revisions through the parent's credentialed interceptor, verifying complete listing, safe paths, blob identities, bytes and final unchanged PR revisions. It returns only bounded Dozzle-service projections, the documented default UI/explicit agent command mode, environment option names, parent-computed non-image configuration equality and receipt-bound references, never inline secret-bearing YAML values. Ordinary unchanged port/socket settings need not hide the service, but equality is not completeness: persistent `/data`, external agent topology, overrides, interpolation, unknown commands or hidden relevant settings cannot establish safe compatibility.
- A second fixed, child-path-free `upstream-guide` read derives the same version from the admitted image diff, resolves a lightweight or annotated tag to an observed immutable commit and reads only the bounded official agent guide at that commit, checking bytes, blob identity, moved PR revisions, deadlines and redirects. It permits a cited guide passage but does not itself certify cross-version compatibility.

### REQ-OPERATOR-053 contract details

- Only Enterprise deployment mode may select the operator Review path, prepare its activity, call the Action handoff or expose operator progress. Non-enterprise PR-boundary and local `/review` behavior remains unchanged.
- At an authenticated Enterprise PR boundary, the parent prebinds one visible activity to the verified human, installation, exact current PR revision and applicable protected Action, with eligible inference and the selected installation's resource-profile scope.
- An external selector registers exactly one Review path per target: dedicated Operator Review extensions for an applicable trusted Action, the unchanged local Review extensions for confirmed absence or inactivity, and neither for broken or ambiguous active configuration. Switching repositories within one Pi session reselects before the boundary; the original local extension source remains unchanged.
- The status response exposes only metadata and the durable generation. Continuation claims that waiting generation once; a delayed accepted continuation cannot reserve a later drive.
- Only a separate trusted publisher holds credentials for Review publication; neither local Pi nor the compiled child may publish. The publisher verifies its GitHub Actions bot/App identity from GitHub's fixed API rather than requiring per-repository identity variables. Journal ordering and independent publication are governed by [REQ-OPERATOR-055](#req-operator-055-pr-wide-publication-ordering) and [REQ-OPERATOR-056](#req-operator-056-independent-review-publication).
- The existing owner-scoped Operator activity view shows real waiting, running, cleanup and terminal states; dedicated remote Pi extensions monitor independently verified published Review and ordinary CI and retain triage/FIX without running a second reviewer wave. Confirmed local mode keeps the existing local procedure unchanged. Owned child cleanup remains uncertain until the parent receives confirmed destruction from the exact container; an SDK `stopped` reading or failed destruction is not confirmation.
- The protected Action may reread only the same immutable terminal bytes with its original read capability until the Activity deadline plus two hours after a lost delivery; older issued read capabilities with a later persisted expiry are capped at the same boundary.
- An authorized administrator can propose a self-contained, fixed-origin protected Review workflow by reviewed PR without bypassing branch protection. Only exact protected-base workflow bytes and active GitHub identity may be verified; a pending proposal, moved base, denied workflow write or unavailable fixed runtime never installs trust. Verification alone remains inactive and cannot mint a start capability; explicit inactivity retains local review when the repository has no competing active binding. An advanced proposal branch may contain only the intended workflow diff, and the commit-pinned runtime must have executable collect/publish steps and publisher dependencies. Exact accepted target writes can be reread after a lost response, never blindly retried; generic controls cannot erase or forge verified workflow identity.
- Platform-admin management registration accepts the protected `pull_request_target` event without admitting `workflow_dispatch` or allowing a forged activated binding.
- The fixed three origins are probed concurrently under one ten-second deadline using audience-specific OIDC and a non-consuming exact-context discovery endpoint. Exactly one observed affirmative permits claim at that origin despite another endpoint error/timeout; zero or multiple affirmatives block. Discovery cannot return start/read authority or consume the prepared handoff.
- Remote Pi receives an actor/session-bound Activity reference through protected applicability selection, including read-only reconciliation after pending preparation. Its own fixed result read verifies a GitHub-published artifact, comment, check and protected workflow/run/attempt under the current user's repository access before displaying bounded original findings in the active session branch for joint CI triage; arbitrary shell output and a foreign user's private Activity cannot supply them. Unavailable or incomplete publication is not an empty successful report or clearance. This read never stages/starts an Activity or grants Action authority.
- After complete joint triage, the dedicated remote path records a finding-linked rejection with bounded rationale and evidence for only the same Pi session, repository, PR and later head. The authenticated parent independently rechecks each cited prior artifact/comment/check/run and finding under the current actor's repository permission, rejects forged, omitted, truncated or duplicate references before packet persistence, and includes the verified original finding alongside each rejection in the approved lane packets. No caller-supplied actor, Pi claim or rejection resolves the prior finding without Conductor's explicit independent next-round reassessment.

### REQ-OPERATOR-056 contract details

- Only the separate protected publisher job holds GitHub publication credentials; Pi, candidate code and the compiled child cannot access them.
- A round cannot clear unless original reports and independently verified GitHub history match the bounded OIDC-authenticated projection of its claimed reservation and collected terminal Activity; missing or stale identity denies publication.
- A bounded artifact retains the single canonical terminal result, including the original reports once, under the exact prepared repository, PR, revision, run and activity identity.
- A human-readable round comment binds the same generation and artifact digest; the artifact retains unresolved original findings.
- A generation-specific shadow check binds exact external IDs and the immutable content digest.
- Red, partial, missing or incomplete evidence never publishes a green round.
- Independent current-context verification rejects a late old check from clearing a newer revision.
- Actor-authorized PR-wide original-report readback authenticates the exact GitHub Actions publisher identity, installed protected workflow/run/attempt, immutable downloaded artifact digest and independently reread comment/check before exposing bounded findings to Pi. Prior reported findings remain advisory and are not resolution.

### REQ-OPERATOR-060 contract details

- Publication has a separate authenticated command; it derives repository, PR, base/head and judgment from the admitted Activity, not caller or model-selected write targets. The same owner must have current admin authority and an explicitly selected active D1 session/lifecycle generation, pinned before effects and rechecked before each protected operation. Expired Access, logout, Stop, revocation, changed installation or session denies writes. Child capabilities and GET/result collection cannot publish.
- Before prospective activation, only the explicitly selected Komodo #1299 target can publish; future post-cutoff PRs require the separate scheduler admission gate. An authenticated `unsafe` or `unknown` assessment may produce a bounded comment but never approval/merge. Only the pinned compiled Dispatcher's nested assessment may establish a cited `safe` result; flattened, missing, malformed, or contradictory envelope evidence cannot authorize publication. Parent write targets remain admission-derived. Current repository/PR identity, base/head, permission, applicable checks/reviews/rules and mergeability must be complete and compatible. Zero configured checks is not itself proof of safety or a blocker; missing, pending, failed, paginated or ambiguous policy evidence blocks merge.
- Before each write, reserve a durable exact-generation effect intent. Duplicate/concurrent or uncertain responses reconcile current remote receipts without blind replay. Merge supplies the admitted expected head SHA; a changing base is revalidated but cannot be frozen atomically, so the residual race is reported rather than hidden. Publication grants no child repository-write capability.

### REQ-OPERATOR-061 contract details

- An authenticated, currently authorized admin explicitly activates an enabled Dispatcher installation for Komodo repository ID 973175879 and an active D1 session generation. The server records an immutable activation timestamp, never accepts a caller-supplied cutoff, and seals the authenticated assertion for that exact admin/session. A failed Container scheduling acknowledgement is not a successful activation response; a retry must preserve the original cutoff. #1299 remains an independent, explicitly selected one-off; activating the prospective scan cannot make older PRs eligible.
- An hourly callback multiplexed with the existing session Container scheduling considers all open Komodo PRs created strictly after the cutoff, including PRs created while the admin was offline. It obtains complete bounded GitHub pages and verifies repository identity, Renovate App author identity and GitHub `created_at`; reopening or updating an older PR does not qualify. Incomplete, stale or unavailable observations skip rather than admit work. The callback does not start privileged work based on browser presence or a permanent technical identity.
- Before a read-only Dispatcher Activity is admitted, the parent validates the current sealed Access session, current admin/invocation grant, selected installation revision and active D1 session generation. Stop, logout, expiry and revocation fence each privileged transition. Among simultaneously valid admins, Registry deterministically chooses one actor/session/generation for a PR/revision and atomically reserves one stable Activity identity. An uncertain preparation/start reconciles that same identity, never creates replacement work or changes the actor; a changed head requires separate revalidation without admitting a pre-cutoff PR.
- A non-#1299 publication requires that exact Registry admission proof as well as the publisher's fresh current-session, PR/head/base, Renovate author, check/review/rules and cited-assessment gates. Only an independently supported `safe` result may approve or attempt expected-head merge; uncertain or missing evidence never becomes safe. Neither an alarm nor a child can publish by itself.
