# Operator Interface foundation

**Audience:** Platform and operator developers

**Owns:** Enterprise Operator Interface input formats and reusable platform boundaries.

**Does not own:** Private Flue code, Review business logic, canonical local-review resources, enterprise permission grants or deployment secrets.

Implementation is incremental. The functions below do not constitute a deployed operator runtime. Requirements and remaining acceptance live in [Operators](../../sdd/spec/operators.md).

## Verified human context

`src/lib/jwt.ts::verifyHumanAccessJWT(token, authDomain, audience)` returns signed human subject/email/issuer/audiences and actual issued-at/expiry, or null. It shares cryptographic verification with the unchanged ordinary email API. It does not return the token, grant operator eligibility, resolve an owner bucket or renew authority. See [Authentication](authentication.md#human-access-claims-for-the-operator-interface).

## Distribution validation

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

`src/operators/loader.ts::loadOperatorWorker(loader, approvedBundle, capability, outbound)` creates a fresh Worker with `LOADER.load()` and returns its default entrypoint. The child receives only `env.OPERATOR`; the parent provides this service binding with bound principal/activity context. An explicit outbound service intercepts child networking, or `null` denies it. There is no inherited environment, cached `get()` path, automatic retry or fallback.

The caller owns artifact integrity/approval, current human authority, admission and creation of the principal-bound services. Durable checkpoints, cancellation, operation reconciliation and recovery belong to the activity, not the isolate. Production configuration declares `LOADER` and the SQLite `OPERATOR_ACTIVITY` owner; user-facing dispatch is added only through the later authenticated admission surfaces.

The isolated fixture at `src/__tests__/operators/fixtures/wrangler.toml` uses the repository's pinned Wrangler/workerd and target compatibility settings. Its RPC/egress services are synthetic and make no provider calls. It is not a production configuration or proof of live Cloudflare Access, deployed runtime behavior, inference eligibility or activity durability.

## Protected execution context

`src/operators/execution-context.ts` captures a currently verified human Access assertion under exact activity/operator, approved artifact and policy identities. It validates bounded identifiers/digests and actual signed expiry, then uses the existing fail-closed operator AES-GCM envelope with the activity ID as authenticated context. Durable state contains owner provenance and ciphertext, never a raw JWT. `projectOperatorExecution` removes ciphertext before parent-safe readback; nothing from this projection grants child authority.

Protected reopening verifies the ciphertext payload still matches every public pinned identity and rejects expired authority. Reauthentication decrypts the existing record and accepts only the same subject, normalized email, issuer and audience list before replacing ciphertext. It cannot change operator/artifact/policy identity, admit work or reconcile uncertain effects. `OperatorActivity.prepareAuthorized` atomically persists this context with prepared intent and bounds the intent deadline by signed expiry. Registry receipt artifact/policy identity must match before queueing.

## Activity-to-Worker driver

`src/operators/runtime.ts::driveOperatorRuntime(options)` reserves an admitted activity's next drive generation and creates fresh approved code with parent-built, generation-bound capabilities. The child receives a version-1 JSON request containing `action` (`start` or `resume`), `activityId`, `generation` and the last durable `checkpoint`. Credentials remain in the parent. Only a 200 JSON response, streamed within 64 KiB and a 30-second child deadline capped by human expiry, reaches the activity's checkpoint validator and generation comparison.

Thrown, oversized, malformed or expired execution is fenced as unknown rather than automatically replayed. Already-settled or active drives do not start another Worker. A waiting checkpoint can resume after activity eviction in a fresh isolate. This composes existing primitives; it adds no scheduler. The production Loader/activity bindings are declared, while authenticated dispatch remains in its dedicated package. Aborting a request/fencing a generation does not prove that owned sessions or SDK work were cancelled. Explicit cancellation dispatch and owned-compute cleanup remain required.

## Registration/admission ordering

`src/operators/registry.ts::OperatorRegistry` owns deployment-local ordering state on SQLite-backed DO storage. `create` starts disabled and unapproved. `approve` and `setEnabled` require the current revision and increment it; replacement approval disables the registration until separately enabled.

`setDistribution(operatorId, endpoint, connectionSecret, expectedRevision)` validates the HTTPS endpoint and encrypts the connection secret for that operator before a revision-checked transaction. Configuration replacement disables the registration and clears artifact approval, without changing already-admitted receipts. Invalid configuration or unavailable encryption leaves storage unchanged. Its response excludes secrets; `getProtectedDistribution` is a parent-only discovery/download accessor, never a public projection. Authenticated discovery, approval and policy persistence are composed by the admin backend described below; runtime policy enforcement remains separate.

`approveManifest(operatorId, manifestJson, expectedRevision)` stores compatible metadata and its digest together, after checking the stable ID and derived artifact URL against the current configured endpoint. The parent must authenticate discovery and verify the artifact before calling. Approval leaves the registration disabled. `getApprovedManifest` returns only approved data, not new discovery advertisements. Admission copies the full approved manifest into its receipt; later changes cannot rewrite it. Configuration replacement and digest-only ordering approval clear current metadata. The complete manifest crosses RPC as bounded JSON text (`manifestJson` in receipts), revalidated on approval. This avoids recursive RPC serialization types without weakening the typed manifest parser.

`admit` checks the enabled approved revision and absolute human deadline, then stores an immutable receipt for the activity/intent. Identical concurrent admissions reconcile that receipt. Reusing an activity ID with changed intent, operator, revision or deadline conflicts. A receipt created before disablement remains reconcilable under unexpired authority; disablement before receipt creation blocks admission. `getReceipt` remains read-only after expiry and does not renew authority.

Each mutation is one local storage transaction. The parent must authorize and validate RPC inputs, and never provide this DO binding to a child. Discovery/network calls stay outside transactions. The activity must separately reconcile admission and atomically consume its capability with queued execution; there is no cross-DO transaction. The admin routes and SQLite registry binding are now wired in source. Current human authorization, live endpoint acceptance and later execution/interceptor integration remain distinct verification boundaries.

## Enterprise registration backend

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

`parseOperatorPolicy` accepts only version-1 hostname, GitHub repository/method, owner-relative directory-prefix and inference allowlist/default declarations. Empty lists deny. Unknown identity/bucket fields, unsafe paths/host rules, duplicates and defaults outside allowlists fail closed. Host/repository names normalize to lowercase. JSON is bounded to 64 KiB, lists to 128 entries, and methods/reasoning to their supported finite sets. Policy replacement stores a new revision; admitted receipts retain their original JSON. This is restriction storage, not a claim that the direct/container interceptors are implemented.

The enterprise `/admin/operators` page now uses these APIs, sharing the existing Administration shell, form styles and mobile grid behavior. It exposes explicit registration, candidate versus approved digest, approval/enablement, connection replacement, restrictions and optional handoff-key controls. Empty registration restrictions deny external access. Key values remain in component memory only and clear on dismissal, selection change and unmount; rotation requires confirmation. Loading/error states are not presented as an empty registry, and conflicts never automatically repeat a mutation. Current changes still require package CI and actual desktop/mobile visual acceptance. Live Access allowed/denied proof and deployed acceptance remain required. Route fixtures use simulated identity/distribution boundaries plus native durable storage; separate signed-JWT and transport tests verify those primitives. They do not replace live authentication evidence.

## Activity admission

`src/operators/activity.ts::OperatorActivity` owns `prepare`, `start` and a verifier-free `getAdmission` projection. The authenticated parent supplies validated intent, the start capability's SHA-256 verifier and bounded human/capability deadlines. Preparing an activity does not admit it. Raw start tokens are never stored.

`start` validates the capability before registry I/O, persists pending intent and requests admission under the same activity ID. A lost RPC response leaves that intent pending and the capability unconsumed. A subsequent attempt reconciles the registry receipt, including receipt-first admission followed by disablement. After receipt validation and a fresh expiry check, one local transaction erases the verifier and records queued execution. Concurrent or repeated starts cannot queue twice.

Queued intent does not mean execution has started or completed. The full Phase-1 implementation still requires protected context, policy snapshots, execution/checkpoint/cancellation, production routes and deployed acceptance; these are not deferred to later phases.

## Durable drive checkpoints

`OperatorActivity.beginDrive()` reserves one running generation inside the activity's existing durable record. A waiting drive resumes with its persisted checkpoint and a new generation; active or settled work cannot restart automatically. `commitDrive(generation, update)` accepts only the current running generation while human authority remains valid.

Updates have `{ schemaVersion: 1, status, checkpoint, result? }`, with status `waiting`, `completed` or `failed`, JSON checkpoint/result values, and a combined 64 KiB UTF-8 limit. Unknown fields, incompatible versions and oversized data fail without changing state.

`cancelDrive()` fences commits with `cancel-requested`; `interruptDrive(generation)` fences interrupted work as `unknown`. Neither grants renewed execution authority or claims cleanup has stopped owned compute. The parent must bind the reserved generation to capabilities and perform the required session/Worker cleanup. The runtime fixture tests persistence across native DO eviction and instance replacement; deployed execution and cleanup acceptance remain mandatory.

## Protected secrets

`src/operators/protected-secrets.ts` supplies `sealOperatorSecret` and `openOperatorSecret` for parent-owned connection secrets, human Access credentials and webhook keys. Both reuse the existing AES-256-GCM primitives and `v1:` envelope. Authenticated context is the JSON tuple `["operator-secret-v1", purpose, recordId]`; the parent chooses the record and purpose, never the child.

An absent/invalid encryption key, plaintext value, wrong context or tampered ciphertext fails closed with a safe validation error. There is no plaintext migration, logging, persistence or alternate-key fallback in this boundary. The caller authorizes access, stores ciphertext and keeps decrypted values out of public projections/child bindings. Existing ordinary KV credential migration remains unchanged.

`createOperatorWebhookKey(recordId, env)` generates a fresh 32-byte cryptographically random base64url key and seals it for the operator's `webhook` context before returning either value. The authorized registration caller must atomically store only ciphertext, return the plaintext for one-time display, and replace the previous ciphertext on rotation. This helper does not implement persistence, display-once routing or consumer updates. The consuming Actions secret is `CODEFLARE_OPERATOR_WEBHOOK_KEY`, never the master encryption key.

`OperatorRegistry.rotateWebhookKey(operatorId, expectedRevision)` composes generation with transactional ciphertext replacement and a registration revision increment. Stale/concurrent losers receive no plaintext; encryption failure changes neither key nor revision. Ordinary registration responses omit the key and ciphertext. `getEncryptedWebhookKey` is a protected parent-only handoff-decryption seam, not an admin/public readback API. There is no retired-key fallback. A lost successful rotation response requires explicit new rotation with the current revision. The human-admin rotation route is wired in source; the display-once UI is implemented but awaits acceptance; consumer secret updates remain an explicit administrator action.

## Independent sync evidence

`src/operators/sync-verification.ts::verifyOperatorSync(expected, read)` reads the final `manifest.json` and declared objects from the parent-selected operation prefix. The owner-scoped reader must enforce the supplied byte bound before buffering. Version-1 manifests bind activity, session, operation, request digest and policy digest, with unique canonical relative file paths, sizes and SHA-256 hashes. Limits are 64 KiB for the manifest, 128 files and 8 MiB total declared output.

The verifier compares the independently read manifest's exact digest and scope before file reads, then checks each stored file's size/digest. Expired authority, missing/changed bytes and unsafe paths fail closed. Returned file/byte counts are verification facts, not an upload acknowledgment. The parent must seal the operation before recording durable completion; this helper does not implement upload, sealing, receipt persistence or shutdown. All remain required in Phase 1. Human bisync and timestamp-based final-sync behavior are untouched.

## Verification

Behavioral tests in `src/__tests__/lib/jwt.test.ts` cover signed human identity versus legacy email authentication. `src/__tests__/operators/distribution.test.ts` covers bounded metadata, origin confinement, exact-byte integrity, module restrictions and non-execution. Full live distribution/Worker acceptance remains a separate requirement; parser tests do not prove it.
