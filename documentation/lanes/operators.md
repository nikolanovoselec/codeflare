<a id="operator-interface-foundation"></a>
<a id="repository-only-dispatcher-transport"></a>
# Operators

**Audience:** Platform and operator developers, Dispatcher package authors, security readers

**Owns:** Enterprise Operator Interface formats; generic Loader, lifecycle, resource, session, synchronization, GitHub/inference and publication-fencing boundaries; parent Dispatcher transport, receipts, response bounds and recovery fences; generic host-side Pi confinement; baked Conductor Review Pi extensions, skills and references for per-repository GitHub Actions.

**Does not own:** Private Flue implementation; Conductor Review packet, orchestration, result, history or publication policy; Dispatcher Renovate prompts/decisions; canonical local-review resources; enterprise permission-grant configuration; managed curation; deployment secrets, operational values or activation.

[Operators specification](../../sdd/spec/operators.md) owns all Operator requirements and their evidence qualifiers. Its [normative Registry appendix](../../sdd/spec/operators.md#operator-registry-contract) owns the shared data/API/wire/host contract. Historical CI, Git and deployment references remain in requirement verification and existing history, not a new execution-report collection. A fixture, source boundary or diagnostic does not certify complete deployed acceptance.

<a id="contents"></a>
## Contents

- [Identity and restrictive policy](#verified-human-context)
- [Distribution and package formats](#distribution-validation)
- [Registry management and admission](#registrationadmission-ordering)
- [Runtime and Dispatcher host](#worker-loader-boundary)
- [Repository-only transport and recovery](#repository-only-transport-and-recovery)
- [Owned sessions, resources and persistence](#owned-session-and-structured-pi)
- [Webhook capabilities](#webhook-capability-handoff)
- [Owned activity presentation](#owner-scoped-activity-surface)
- [Protected Review boundary](#consumer-contract-and-dependency-inventory)
- [Separately fenced Renovate publication](#fenced-renovate-publication)
- [Preserved contract details](#preserved-contract-details)
- [Verification boundaries](#verification-boundaries)
- [Requirement and source map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

<a id="verified-human-context"></a>
<a id="req-operator-045-preserved-clauses"></a>
## Identity and restrictive policy

`src/lib/jwt.ts::verifyHumanAccessJWT(token, authDomain, audience)` returns signed human subject/email/issuer/audiences and actual issued-at/expiry, or null; cryptographic verification is shared with unchanged ordinary email authentication. It returns no token and does not grant eligibility, resolve a bucket or renew authority. <!-- @impl: src/lib/jwt.ts::verifyHumanAccessJWT -->

Current Access identity uses documented `user_uuid` before legacy `id`; unrelated extra `id` cannot veto matching UUID/email. Missing `groups` asserts no memberships: explicit email grants may authorize, group-only grants cannot. Bounded group labels and name/email-only records preserve valid matching human metadata but cannot satisfy issuer-bound stable-ID grants. Malformed/oversized supplied groups, invalid stable IDs, identity mismatch, revoked/expired sessions and failed or redirected identity lookups deny. JWT group claims never substitute. Verified platform admins can read catalog/detail without global/per-Operator management grants, but cannot read another owner's Activity or bypass Environment ceilings. Diagnostics expose only closed stage/reason labels and optional numeric HTTP status, never credentials, claims, identifiers, bodies, URLs or exception text. <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @impl: src/routes/operator-management.ts::scopedManager --> <!-- @test: src/__tests__/operators/operator-live-identity.test.ts (REQ-OPERATOR-045: verified admin with %s reads ungranted catalog entries and management details; other managers and invalid admins cannot) -->

See [Authentication](authentication.md#human-access-claims-for-the-operator-interface) and [Cloudflare User Identity](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#user-identity).

<a id="shared-interception-restrictions"></a>
### Shared interception restrictions

`src/operators/interception-policy.ts` is the credential-free shared decision boundary for direct capabilities and container interception. Parent-validated policy narrows current human authority before credential lookup/signing/forwarding. Exact network hosts and `*.example.test` subdomains are canonical; wildcard excludes apex. Standard/configured GitHub hosts never fall through generic-host permission. Operator sessions cannot acquire the enterprise Browser administrator token by listing `api.cloudflare.com`. Canonical REST `/repos/{owner}/{repo}/…` and Smart HTTP `{owner}/{repo}.git/…` paths require both declared repository and method before token lookup. General egress decisions precede Gateway forwarding.

Own-account R2 GET/HEAD/list require read prefixes; PUT/multipart require write prefixes; copy/delete/unknown controls deny. Multipart abort additionally requires parent proof of activity ownership. Restricted sessions force catch-all through Egress regardless of ordinary strict-egress preference; missing mandatory interception fails startup. Non-operator wiring remains unchanged.

Automatic Access stamping is Off by default, an exact/subdomain-wildcard host list, or All HTTPS destinations with explicit recipient echo/disclosure confirmation, in Security and egress administration's existing preview/run revision flow. `jwt-stamping.ts` strips caller assertions, preserves specialized Authorization, uses manual redirects and stamps a current verified human JWT only on the actual authorized recipient after existing policy/credential decisions. Every redirect destination needs independent authorization. Parent-only props carry current authority; no JWT enters the container environment. Stamping grants no egress and renews no authority; explicit distribution authentication is independent when Off.

<a id="operator-inference-intersection"></a>
### Inference intersection

`resolveOperatorInference` intersects current verified human/group eligible routes with admitted policy, then applies trusted invocation/Pi selection or permitted policy/default inheritance. Reasoning narrows independently; provider-default differs from Off. Missing/ineligible/disallowed choice denies before Gateway I/O. Child payload/lane/resource settings cannot replace route, reasoning or trusted activity attribution. Direct/container paths share selection; ordinary human fallback remains unchanged. See [REQ-OPERATOR-007](../../sdd/spec/operators.md#req-operator-007-operator-aware-inference-selection). <!-- @impl: src/operators/inference-selection.ts::resolveOperatorInference -->

**Configure the route in Administration → Environment → AI Gateway and routing → Access & fallback.** Open the invoking user's **Group access** policy, grant the desired Dynamic or Native route under **Available routes**, select **Default route** and **Default reasoning**, then choose **Review changes → Confirm Save**. There is no separate per-operator route selector in Operator management; its **Inference** capability permits inference, not a particular route. This changes the user's policy default, not an operator-only preference. <!-- @impl: web-ui/src/components/admin/environment-areas.ts --> <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx --> <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx --> <!-- @impl: web-ui/src/components/OperatorManagement.tsx -->

The first matching configured group policy supplies the eligible routes and default. With no matching policy, including users with no groups, configure **Users without a group policy** on the same screen: enable fallback access, grant routes and select its default. Disabled fallback or no eligible routes leaves inference unavailable. A matching group policy with no eligible routes does not fall through to fallback. See [REQ-ENTERPRISE-013](../../sdd/spec/models-and-routing.md#req-enterprise-013-per-group-dynamic-routing). <!-- @impl: src/lib/access.ts::resolveRouteCatalog -->

The current production Dispatcher resolves that effective default for each inference operation. The production Conductor PR-boundary flow captures the same default when preparing its invocation; runtime rechecks the pinned selection against current eligibility and binds its Pi profile to `codeflare-gateway`. A later default change does not replace Conductor's captured route. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @impl: src/operators/review-boundary-preparation.ts --> <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability -->

A managed **Native route** is an administrator-configured AI Gateway target, not a personal Pi provider login. Neither flow inherits the interactive Pi `/model` selection or an OpenAI subscription OAuth login. Operator Pi startup uses image-owned managed models and an empty isolated `auth.json`; Dispatcher receives parent capability bindings, not inherited credentials. `inheritUserDefaults` refers to eligible route/reasoning defaults, never credential inheritance. <!-- @impl: entrypoint.sh --> <!-- @impl: src/operators/loader.ts::loadOperatorWorker --> <!-- @impl: src/operators/inference-selection.ts::resolveOperatorInference -->

<a id="protected-execution-context"></a>
### Protected execution context

`execution-context.ts` binds verified current Access authority to exact activity/operator, artifact and policy identities and actual signed expiry. Durable state retains owner provenance and ciphertext, not raw JWT. Parent-safe projection excludes ciphertext. Reopening rechecks pinned identity and expiry. Same-human reauthentication requires matching subject, normalized email, issuer and audiences; it cannot change operator/artifact/policy, admit work or reconcile unknown effects. `prepareAuthorized` persists context with prepared intent; receipt policy/artifact must match before queueing.

<a id="protected-secrets"></a>
### Protected secrets

`sealOperatorSecret`/`openOperatorSecret` reuse AES-256-GCM and `v1:` envelope with authenticated JSON tuple `["operator-secret-v1", purpose, recordId]`. Parent chooses purpose/record; absent/invalid master key, plaintext, wrong context or tampering fails safely, without plaintext migration/logging/persistence or alternate-key fallback. Ordinary credential migration remains unchanged.

`createOperatorWebhookKey` creates 32 random bytes as base64url and seals under `webhook` context. Revision-checked Registry rotation stores ciphertext atomically, returns plaintext only to winner once, and omits both plaintext/ciphertext from ordinary projections. Stale/encryption-failed rotation preserves state; no retired-key fallback. Lost winning response requires explicit new rotation, not secret readback. `getEncryptedWebhookKey` is parent-only. Consumer secret is `CODEFLARE_OPERATOR_WEBHOOK_KEY`, never master encryption key. Retained internal rotation does not reinstate retired HTTP/UI administration.

<a id="distribution-validation"></a>
<a id="req-operator-044-preserved-clauses"></a>
## Distribution and package formats

`distribution.ts` validates at most 64 KiB discovery JSON and at most 8 MiB exact approved-digest bundle bytes without executing source. Typed errors expose no bytes/credentials. Compiler `npm run compile:operator-package -- <configuration.json> <output-directory>` deterministically emits existing manifest/bundle schemas, exact resource digests/sizes and optional provenance; no inferred policy, bindings, credentials, environment or outbound authority. Package/compiler ABI and pins are unchanged.

GitHub acquisition verifies canonical repository, immutable assets, approved workflow ID/ref, run path/branch, source commit and digests. Provenance accepts exact path-qualified workflow ref or exact branch ref only with the same verified ID/path/branch. Refresh reuses unchanged verified same-source releases, rejects changed retained identity and keeps newly acquired bytes under aggregate budget before one atomic Registry commit. Installed pins/rollback releases remain. Release assets use exact GitHub CDN allowlist; only authenticated API Actions artifact ZIP endpoints additionally accept `[a-z0-9]{3,24}.blob.core.windows.net`. One uncredentialed HTTPS redirect is permitted; no nondefault ports, userinfo, fragments, lookalikes or onward redirects. PAT remains on locally constructed API URL. Deadlines, bounded bytes and release/build-byte equality remain mandatory; advertised digest alone proves neither publisher authenticity nor human eligibility.

<a id="authenticated-discovery-transport"></a>
### Authenticated discovery transport

`fetchOperatorManifest(endpoint, credentials)` validates credential-free/fragment-free HTTPS DNS endpoint, requires independently verified unexpired human JWT plus connection secret, sends `cf-access-jwt-assertion` and Bearer Authorization respectively, rejects redirects/non-200/login/non-JSON, streams at most 64 KiB, and aborts within 15 seconds or human expiry. Rejected bodies cancel; authority rechecks after read. No automatic retry/service-token fallback or leaked network diagnostics. `fetchOperatorBundle` re-resolves canonical approved path on registered origin before I/O, streams at most 8 MiB, verifies digest/modules inside deadline and rechecks authority after validation. New discovery cannot replace approved digest. Retained transport is not a user-facing registration revival.

<a id="discovery-v1"></a>
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

Supported capability names: `session`, `pi`, `storage`, `inference`, `fetch`. Declaration requests compatibility, not permission. Duplicate/unknown capability, schema/interface mismatch and caller identity/binding fields reject. `inputSchema` is bounded inert JSON metadata, not executable interpreter. Artifact path is canonical origin-relative without query/fragment/encoded ambiguity/traversal/backslash and cannot escape origin. Installed packages extend v1 with profile, declared input/output schemas and requests; exact three release files and approval contract live in the normative appendix.

<a id="bundle-v1"></a>
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

Format example, not functioning operator. At most 128 canonical relative JS/text modules, declared JavaScript main and fixed platform-compatible settings. New compatibility setting needs explicit tested platform change. Parent owns capabilities/outbound; undeclared options/environment/bindings/inherited networking reject. Dispatcher selects the approved generated class, not caller exports.

<a id="registrationadmission-ordering"></a>
<a id="enterprise-registration-backend"></a>
<a id="historical-gate-1-distribution-and-installed-release-management"></a>
## Registry management and admission

SQLite-backed `OperatorRegistry` owns local revision/order transactions, not human authorization or network I/O. Create starts disabled/unapproved; approval and enablement are separate current-revision mutations. Distribution replacement validates/encrypts before CAS, disables/clears approval and leaves admitted receipts unchanged. Bad input/encryption preserves state. `getProtectedDistribution` is parent-only. Manifest approval stores full compatible metadata/digest against stable ID/current endpoint; receipt copies it, later changes cannot rewrite it. Bounded `manifestJson` RPC text avoids recursive serialization without weakening validation. Policy JSON is bounded 64 KiB, lists 128, finite supported methods/reasoning, lowercased hosts/repos; unknown identity/bucket, unsafe paths, duplicate or invalid defaults reject. Replacement disables admission and leaves pinned receipts unchanged.

`admit` checks enabled approved revision and absolute human deadline; identical concurrent intent/activity reconciles, changed identity/input/revision/deadline conflicts. <!-- @impl: src/operators/registry.ts::OperatorRegistry.admit --> Receipt-before-disable can reconcile under remaining authority; disable-before-receipt denies. Readback after expiry grants no renewal. No cross-DO transaction or child Registry binding.

Old `/api/admin/operators` registration/discovery/approval/key routes return 404 even Enterprise; `/admin/operators` bookmark redirects to `/operators`. Installed release catalog uses `/api/operator-management` with independent human/grant checks. Enterprise admins use incumbent Administration navigation, eligible non-admin managers standalone entry; navigation below header on mobile is not authority. Gate 1 records are retained but cannot prepare new work; already-prepared fixture loopback denies and deployment does not dispatch it.

<a id="req-operator-008-preserved-clauses"></a>
<a id="req-operator-049-preserved-clauses"></a>
<a id="catalog-profile-pill-colors"></a>
### Catalog and installation presentation

Detail leads with uniquely enabled pin; ambiguous configurations require explicit selection and unavailable pins cannot borrow another purpose/version. First installation pins exact release without enabling, uncertain creation/promotion reconciles existing unpinned installation without duplication. Verified tags and UTC publication time label available/pinned releases; gaps remain labelled, numeric IDs are not invented versions. Each alternative occurs once with description/date; older-pin metadata refresh cannot change enablement. Compatibility/technical identity stay in technical details. Catalog status is Enabled/Disabled; purpose/category/version/date/status remain distinct. Verified first-party repositories may display Pull Request Reviewer or Renovate Manager; others retain authored names, and authored identity remains disclosed.

Search opens beside Register via existing MDI icon, filters while typing without submission, clears on close and ignores stale responses. Catalog profile pills use selected accent; detail pills/muted metadata stay unchanged. REQ-OPERATOR-049's real-browser `checkOperatorPillColors` check remains a manual obligation under two accents, not jsdom evidence. Mobile sections remain horizontal with local action/save feedback; long names/errors must retain focus/scrolling.

Managers/runners/saved grants/unverified choices stay distinct. Selectors use configured users and live verified stable groups, retain saved missing choices until deliberately removed, disable saves when choices unavailable and reload on explicit stale refresh. Global eligibility/limits belong to Environment → Access & Identity, not an operator. Ceiling edits within Environment limits use exact revision, preserve pins/scope/grants/policies, disable installations and require explicit re-enable; reject rather than clamp. Source/technical disclosures stay outside restrictions. Conductor scope IDs match configured session/storage labels, do not provision profiles; Dispatcher has no session/resource profile. Realm is compatibility metadata, not UI choice/filter/permission boundary. Blank registration limits reject; restriction saves preserve saved unused configuration without JSON editor.

Guided launcher exists only for authorized pinned supported Dispatcher manifests: repository-only journey submits chosen editable repository and discloses discovery/research/comments/conditional merges; legacy submits editable repository and positive PR with read-only disclosure. No universal target, start on open or unsupported-schema launcher. Uncertain start blocks another until exact owner Activity reconciles; failed preparation cannot reuse previous Activity. Conductor Review has no ad hoc launcher.

<a id="activity-admission"></a>
### Activity admission

Activity persists private prepare intent/start SHA-256 verifier/deadlines before Registry reconciliation; raw token is never stored and prepared is not queued. `start` validates capability before I/O, persists pending intent, requests same Activity receipt, and on lost response keeps pending/unconsumed. After matching receipt/fresh expiry one local transaction erases verifier and queues once. <!-- @impl: src/operators/activity.ts::OperatorActivity.start --> Queued is not started/completed; unknown effects are fenced, not replayed.

<a id="worker-loader-boundary"></a>
<a id="loader"></a>
## Runtime and Dispatcher host

`loadOperatorWorker` uses fresh `LOADER.load()` default entrypoint with only parent `env.OPERATOR`, explicit intercepted outbound or null, no inherited environment, cached `get()`, retry or fallback. Parent owns approval/authority/admission and capability construction; Activity owns durability/cancellation/reconciliation. Production declares Loader and SQLite Activity owner. Synthetic pinned Wrangler/workerd fixture is not live Access/provider/durability proof.

<a id="activity-to-worker-driver"></a>
<a id="request-attached-orchestration"></a>
### Direct execution

Enterprise CSRF-protected `POST /api/operator-activities` derives owner, selects enabled revision and pins bounded invocation/artifact/policy/context; caller cannot select principal/bucket/credential. Missing parent loopback authority fails before start. Winning start attaches one `runOperatorActivity`; duplicate/rejected starts schedule nothing. It reopens authority, fetches receipt-pinned artifact and drives fresh Worker under generation-bound capability with null outbound. Bundle transport and execution share 25-second absolute request-attached deadline bounded by human expiry. Malformed/oversized/expired/uncertain preparation or execution becomes unknown, not replay. Installed Dispatcher effects use Activity-bound capability; retired Gate 1 and unsupported profiles deny without container. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @impl: src/operators/orchestrator.ts::bindOperatorRuntimeCapability --> <!-- @impl: src/operators/operator-runtime-capability.ts::OperatorRuntimeCapability -->

<a id="durable-drive-checkpoints"></a>
### Drive checkpoints

`beginDrive` reserves one admitted generation; only safely waiting checkpoint resumes under new generation. `commitDrive` requires current running generation and valid human authority. Updates are `{ schemaVersion: 1, status, checkpoint, result? }`, status waiting/completed/failed, JSON values with combined 64 KiB UTF-8 bound; unknown fields/version/oversize preserve state. Cancel fences `cancel-requested`; interrupt fences unknown. Neither claims compute stopped. Cleanup must stop only owned compute, honestly retain pending/failed/unknown and forbid post-expiry uploads.

<a id="managed-dispatcher-host"></a>
<a id="req-operator-048-preserved-clauses"></a>
<a id="req-operator-048-contract-details"></a>
### Managed Dispatcher host

Managed `dispatcher` receipts use `driveDispatcherRuntime` and existing `OperatorActivity` with pinned Agents 0.20.1 and Activity-private fixed facet, actual generated Flue class and isolated SQLite. Constructor resumes exact lease; alarm delegates to SDK then reconciles. No new namespace/migration/container/scheduler. Default-entrypoint compatibility does not revive Gate 1. <!-- @impl: src/operators/runtime.ts::driveDispatcherRuntime --> <!-- @impl: src/operators/activity.ts::OperatorActivity -->

Lease pins original generation/submission/input/release/human expiry; no separate discretionary whole-assessment cap. Admission/status remains running, not false waiting/renewal. Empty early snapshot and repeated alarms retain at most one bounded recheck within original lease; later exact settlement is observable before expiry without readmission. Legacy fixed-PR exact completed settlement with all protected operations completed commits waiting; collection stores one bounded `data-assessment` terminal result without continuation/resubmission. Repository-only exact completed `data-result` or named `result` commits completed without checkpoint. Both require exact submission, one 64-KiB result, current authority, original expiry and no unresolved operation. Text-only turn, duplicates, late/failed/unknown work stays fenced. Stream-checkpoint incarnation must be bounded nonempty and unchanged across pages; conversation/submission/result guards remain. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (accepts pinned SDK page checkpoints and retains immutable stream identity across reads) -->

Cancel fences before Flue abort; uncertainty interrupts instead of retry. `sdkCleanupReleased` is true only after exact-generation SDK cleanup/keepalive release durably recorded; generic cleanup stays conservative, not proof of physical cessation. Stale warmed callers never inherit new generation authority. Scoped nine-method pinned facet scheduler/fiber bridge allows only exact Activity/dispatcher and `__flueWakeAgentSubmissions`, not root callbacks/foreign paths/connections/broadcasts. Credentials, Activity stub, unrestricted namespace, sessions/containers and direct networking never reach child. Native artifact compatibility is not production eviction/alarm or live-effect proof.

<a id="req-operator-051-preserved-clauses"></a>
<a id="req-operator-051-contract-details"></a>
### Legacy read-only assessment boundary

Legacy reads are admitted repository/PR/head, bounded first-page files/checks with only required fields and no secret-bearing patches. Parent passes only complete image-line deltas, withholding other patches/unrelated filenames. Truncation, overlap/rate-limit/insufficient evidence remains unknown. Package bot/reasoning policy owns eligibility/verdict, not Codeflare transport.

Fixed `release-notes` derives one allowlisted Dozzle source and old/new tags from complete Compose image diff, including identical repeated updates, then rechecks head before/after bounded read; not hardcoded PR/version or arbitrary crawler.

Fixed `changed-compose` verifies complete listing, canonical paths, immutable base/head blobs/bytes and final revisions, returns only secret-safe Dozzle-service projection, default UI/explicit agent mode, option names, non-image equality and receipt references, never raw inline YAML values. Harmless unchanged ports/socket mounts need not hide service; unchanged is not understood: persistent `/data`, external agents/overrides/interpolation/unknown mode or hidden relevant settings stay gaps.

Fixed `upstream-guide` derives admitted version/tag, resolves lightweight/annotated tag to immutable observed commit, verifies blob/bytes/deadline/revisions and returns bounded official guide with commit-pinned citation. Child cannot select URL/file/ref/credentials. Moved/conflicting/missing/redirected/oversized evidence denies, notes/guide alone never certify compatibility or merge. Package reasons from authentic quoted prose/configuration, validator binds receipts/quotes not semantic certainty. Later merge policy is separate.

<a id="req-operator-047-contract-details"></a>
<a id="req-operator-047-preserved-clauses"></a>
<a id="request-ownership-and-meaning-of-transport"></a>
## Repository-only transport and recovery

```text
Dispatcher Dynamic Worker → parent OPERATOR capability → existing interceptor → remote HTTP API
```

Package chooses URL/method/permitted body; parent uses original human and GitHubInterceptor/EgressController credentials, never independent child credential-bearing client/repository mirror. Wrapper response limit is not GitHub or Flue's server limit. Large PR objects can exceed default envelope allowance; smaller pages reduce individual size, not eligible coverage. Renovate rolling inclusive 14-day/all-open-verified-bot discovery and complete pagination are package policy, not a new Codeflare platform selection rule. The operator-only “Inference request limit (bytes)” defaults to1048576 (1 MiB) and accepts positive safe integers through `Number.MAX_SAFE_INTEGER` ([REQ-OPERATOR-045](../../sdd/spec/operators.md#req-operator-045-delegated-management-and-invocation)). Source/response/result limits and operator-configured operation/deadline gates remain separate. Platform limits still apply. Package composition/source inventory lives in [Reusable Dispatcher](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/develop/documentation/reusable-dispatcher.md).

Parent-normalized input/resource/release/installation identities precede loading. Every protected effect rechecks generation/current human/pinned revisions/policy/expiry/cancellation; captured JWT/workflow identity cannot substitute. Loader exposes approved non-secret GitHub API origin, decimal source response allowance and optional closed admitted-target metadata to repository-only code; legacy bindings unchanged. Trusted Activity ID supplies existing native inference replay namespace, with signed tool replay isolated between Activities; it creates no workspace session or new auth. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/llm-interceptor.test.ts (Dispatcher uses real native inference with stable Activity-isolated signed tool replay) -->

An existing prospective singleton reservation requires the supported first-party intent3 contract ([REQ-OPERATOR-061](../../sdd/spec/operators.md#req-operator-061-prospective-admin-session-renovate-scan)). Public input remains repository-only; parent-derived `OPERATOR_ADMITTED_TARGET` restricts repository/ID, PR/head, creation/cutoff and base branch. Package authenticates that singleton, including older offline arrivals. Parent independently restricts canonical new comment/merge requests and exact singleton collection, with fresh current-target/authority checks. Completed receipts and unknown-write no-replay are unchanged. Ordinary journeys retain complete rolling discovery; legacy read-only assessment and its explicit publisher remain separate. Candidate compilation, release, installation, activation, natural arrival and live effects/cleanup require independent receipts. <!-- @impl: src/operators/operator-runtime-capability.ts::authorizeDispatcherPlan --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts -->

### How is the operation budget calculated?

The Dispatcher operator's **Operation limit per run** defaults to 1024 and accepts positive safe integers under [REQ-OPERATOR-045](../../sdd/spec/operators.md#req-operator-045-delegated-management-and-invocation). The parent uses the originally admitted operator policy; an installation or package cannot override it. Each distinct journal reservation consumes one slot across source reads, discovery, research, inference and effects. Completed identical operations reuse their entry; receipt lookups, resolution and finish add none. Authorized recovery reads consume slots; interceptor-internal HTTP requests are not separate reservations. [REQ-OPERATOR-047](../../sdd/spec/operators.md#req-operator-047-generic-directed-profile-admission) defines this accounting. <!-- @impl: src/operators/dispatcher-operation-limits.ts::dispatcherOperationLimit --> <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation -->

[Ordinary discovery](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/7f25b52bc0a1573cb3fbd487f05c940688b9700f/src/renovate-discovery.ts) costs two initial reads plus one per visited one-item PR page. A fresh ordinary [comment](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/7f25b52bc0a1573cb3fbd487f05c940688b9700f/src/github-effects.ts) costs five entries; its repeated baseline read reuses the identity assigned by the [journey](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/7f25b52bc0a1573cb3fbd487f05c940688b9700f/fixtures/native/src/renovate-journey.ts). Merging, research, inference and recovery need further headroom. Receipts supply actual used/limit counts; 1024 is not guaranteed coverage and changes no token, byte, SDK-history, deadline, authority or uncertainty fence.

Capability changes require a revision-fenced save and explicit installation re-enablement; effective no-ops preserve revisions/enablement. <!-- @impl: src/operators/registry.ts::OperatorRegistry.setManagementCapabilities --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045: persists operator operation limit with revision fencing and unchanged installation policy) -->

### Which size limit should I tune?

All three byte fields default to1MiB (1048576 bytes), not extra model context or guaranteed workload capacity. Their input-adjacent MDI autorenew icons reset drafts only; save explicitly. Explicit saved values and restrictive ceilings remain unchanged. A reset above a saved ceiling blocks saving rather than bypassing it. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045/049: explains limit ownership and resets inference to its default without changing other fields) -->

- **Operator source-response ceiling:** recommended 1 MiB (1048576 bytes), Environment permitting. Raise when an installation needs more response allowance than this ceiling permits; an administrator must raise the Environment maximum first if necessary.
- **Installation source-response allowance:** recommended 1 MiB when its operator permits. Tune first for a confirmed source-response size failure; this bounds received HTTP body and headers for this installation, not model input.
- **Inference request limit:** suggested 1 MiB transport headroom for messages/tools, not extra model context. Tune confirmed body-limit failures only within the model token budget; token-context failures need less input, while authentication/history failures need separate fixes.

Default resets remain available as draft edits even above a restrictive source ceiling; out-of-ceiling drafts block saving without clamping or bypassing authority. Inference request size has no installation override. Raising a byte ceiling never increases a model's token window; JSON/escaping/tools make byte-to-token estimates approximate. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-source-response.test.tsx (REQ-OPERATOR-045/049: source default resets update only the selected ceiling or installation draft) -->

<a id="explicit-transport"></a>
### Explicit transport

POST JSON through OPERATOR to `https://operator.internal/v1/dispatcher/source`:

```ts
{ operationId: string, url: string, method?: 'GET' | 'POST' | 'PUT', body?: string }
// Parent HTTP 200; remote rejection is represented in status:
{ url: string, status: number, headers: Record<string,string>, body: string }
```

IDs `[A-Za-z0-9_-]{1,128}`; HTTPS URL ≤4096 characters, no credentials/fragment/nondefault port (normalized :443 allowed). GET defaults and forbids body; POST/PUT require verbatim string body with parent JSON type. Encoded request ≤64 KiB. Approved sourceResponseBytes applies both UTF-8 upstream body and final encoded envelope including escaping/headers, Activity receipt reader/cache and globalOutbound unwrapping; omitted installation/operator/Environment fields each mean1048576 (1 MiB), no raised inheritance/clamp. Current supported maximum is 1 MiB in source; this is not a verification/status upgrade. Non-inference requests, inference responses, result and SDK bounds remain separate. Setting edits retain CAS/disable/re-enable fences.

POST/PUT only configured GitHub API origin and authenticated GitHubInterceptor; Internet GET only existing approved EgressController/Gateway. Parent selects headers; returned allowlist is content-type, etag, last-modified, date, link, location. Manual redirects. No caller identity/token/transport/header map. Unsupported resource profile denies. Standard Loader fetch uses required `x-codeflare-operator-operation-id`, bounded string body, no credential-bearing request and no caller upstream header control; adapter unwraps source envelope and retains parent error codes. It is intercepted, not direct networking.

Identical complete operations cache. Immutable mismatch is 409 `OPERATOR_OPERATION_CONFLICT`; unknown mutation is 409 `OPERATOR_OPERATION_UNKNOWN`, preserves live generation for authorized reads, never resends/replaces ID, and fences settlement until resolved.

<a id="receipt-and-resolution-approved-package-code-only"></a>
### Receipt and resolution (approved package code only)

```ts
// POST /v1/dispatcher/receipt
{ operationId: string }
// HTTP 200
{ operationId: string, generation: number, requestDigest: string,
  method: 'GET' | 'POST' | 'PUT', url: string,
  phase: 'reserved' | 'unknown' | 'completed', responseDigest?: string,
  operationCount: number, operationLimit: number }
```

Request digest is SHA-256 of parsed immutable `JSON.stringify({path, body})`; use returned digest. Response digest covers exact persisted envelope, not inner body. Projection exposes no remote body, secret or journal internals. Count covers all journal entries including inference/earlier generations, only point-in-time observation, no reservation.

Approved package deterministic code must first validate unique positive domain evidence for original target/head/text/publisher/outcome. Model claim, absent receipt or generic merged flag is not proof. Then:

```ts
// POST /v1/dispatcher/resolve
{ operationId: string, requestDigest: string,
  readbacks: Array<{ operationId: string, requestDigest: string, responseDigest: string }> }
// HTTP 200
{ resolved: true, operationId: string, requestDigest: string }
```

1–16 unique references. Parent verifies exact original unknown mutation/digest and later reserved immutable completed successful GET receipts in same currently authorized Activity/generation, records references durably and caches resolution. Identical resolution reconciles; changed references conflict. Missing/invalid/unavailable evidence or revoked authority never resolves. Parent does not interpret domain semantics or assert remote success; cached resolved response is resolution object, not fabricated source envelope. Generic path remains separate from legacy read/comment/merge/publisher, grants no blanket admin requirement/anonymous mode and does not alter interceptor auth. Package safeguards must disclose protection/head/base races.

### Non-authorizing Dispatcher diagnostics

The host's `operator-inference` structured log uses `schemaVersion: 1` and a closed stage/outcome schema ([REQ-OPERATOR-063 AC8](../../sdd/spec/operators.md#req-operator-063-bounded-dispatcher-diagnostics)). Admission, authority, journal reservation/cache/conflict, upstream delivery, native validation/replay, response commit, settlement, assessment, collection and SDK release are separate observations. Correlation uses parent-owned Activity/generation, durable operation ordinal and SHA-256 request/response digests—not opaque operation, tool or submission IDs. Allowed metadata consists of fixed categories, statuses, counts, byte sizes, elapsed durations and flags. Prompts, bodies, signed thinking, signatures, credentials, URLs and raw error text are excluded.

Native diagnostics distinguish framing/integrity/payload errors, provider exceptions, event ordering, replay limits, incomplete EOF, unsupported stops, invalid tool input and persistence failures. Source read failures and consumer cancellations retain their original behavior. HTTP200 or `[DONE]` does not establish successful native completion. Cached response inspection observes only the final64KiB and at most256 lines, marking sampling; it cannot authorize recovery or synthesize a finish. Original cached bytes remain unchanged, and every logging sink is best-effort.

An authorized owner's existing Activity-detail read can inspect persisted journal metadata without replay, migration, lifecycle mutation or a new response field. At most1,024 records are scanned in32-record pages; at most8 newest records within that scan are observed. Cached body observations require a matching stored response digest. This can diagnose an already-failed Activity's cached transport without starting another Activity solely for logs. SDK bookkeeping release remains separate from physical cleanup: a terminal summary reporting `unknown` is logged honestly, never promoted to stopped-compute proof. Diagnostics consume no operation reservations and renew no authority.

The separate `dispatcher-seal-preflight` channel reports seven fields: `category`, `targetCount`, `decisionCount`, `operationCount`, `operationLimit`, `requiredOperationCount` and `sealed` ([REQ-OPERATOR-076](../../sdd/spec/operators.md#req-operator-076-bounded-seal-preflight-diagnostics)). Categories are `undiscovered`, `incomplete-decisions`, `receipt`, `capacity`, `schema`, `oversized`, `ready`. Target/decision counts are nonnegative safe integers; operation count and limit are positive safe integers ornull, count≤limit, reserve a positive safe integer ornull, and sealed a boolean. The producer leaves all three capacity fields null before validated receipt data; these observations are not reservations or authority to execute effects. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates -->

Each encoded seal value is limited to512bytes, with32 observations independently of readiness. Latest-valid exact-submission observations survive advancing pages/reset; replay positions deduplicate. Invalid/excess metadata truncates only diagnostics, including data preceding its name/type; foreign records cannot affect exact observations or valid assessment/collection/SDK release. Diagnostic data does not consume the original result-record allowance. Missing best-effort metadata does not prove sealing was skipped. Official reviewed package bytes and installation are separate from host projection and live acceptance. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates -->

The existing trusted terminal warning adds `producerSealObserved`, `producerSealTruncated` and, when valid metadata exists, `producerSealCategory`, `producerSealTargetCount`, `producerSealDecisionCount`, `producerSealSealed`, `producerSealOperationCount`, `producerSealOperationLimit`, `producerSealRequiredOperationCount`. No receipt references/bodies, private content or arbitrary identifiers enter it. Logging outages leave the original collection and SDK release unchanged. Ready sealing proves neither actual effects nor finish, validated assessment, collection or cleanup. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-076: seal-preflight.v1 trusted terminal %s metadata cannot authorize missing assessment) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-076: seal-preflight.v1 logger outage preserves actual collection and SDK release) -->

A reviewed diagnostic Dispatcher package supplies `dispatcher-readiness` through that same stream ([REQ-OPERATOR-077 AC1](../../sdd/spec/operators.md#req-operator-077-bounded-producer-readiness-diagnostics)). The reader accepts only discovered/sealed flags, nonnegative safe-integer target/decision/result/unknown-operation counts, and ready/undiscovered/unknown-operation/incomplete-results/schema/oversized/emission categories. It bounds each encoded value to512bytes and observations to32, retaining the latest valid exact-submission record across pages/reset and deduplicating positions. Invalid/excessive metadata sets diagnostic truncation only; foreign values are ignored and no content or opaque IDs are retained. The existing terminal observation adds closed producer fields only when metadata was observed; `ready` cannot authorize an absent assessment or prove cleanup. Logger/metadata outages cannot block valid collection or SDK release. Unlike parent-only completion logging, this producer channel requires official package release/installation. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: readiness.v1) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: readiness.v1) -->

At an observed terminal SDK settlement, [REQ-OPERATOR-063](../../sdd/spec/operators.md#req-operator-063-bounded-dispatcher-diagnostics)'s `Dispatcher settlement observed` reports trusted Activity/generation, outcome, projected-write/message counts, assessment presence and sampled `finish_dispatcher` success/failure/pending counts. `completionTruncated` marks incomplete observations; `unmatchedAssessment` means named assessment/result data lacked exact-submission message association. Neither flag proves a cause. A successful tool observation does not prove a valid assessment. Inputs, outputs, error text, assessment values and opaque tool IDs never enter this log. Logging failure preserves settlement and collection. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: terminal diagnostic wire) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: unavailable terminal diagnostic logging) -->

The existing SDK stream supplies these observations without a package reinstall. Projection retains ≤32 completion correlations with ≤256-character IDs and closed outcomes, discarding tool bodies. Exact-submission reset metadata merges with prior observed outcomes; compaction cannot erase them. Replay positions still deduplicate; foreign tools cannot supply completion counts or consume the requested submission's observation budget. Overflow or oversized diagnostic metadata does not deny a valid assessment or consume its existing record allowance. SDK outcome, assessment validity and unresolved-operation fences remain authoritative; diagnostics grant no collection, replay or continuation. <!-- @impl: src/operators/dispatcher-result.ts::readDispatcherUpdates --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: caps completion observations) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: oversized diagnostic metadata) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: foreign and unrelated tools) --> <!-- @test: src/__tests__/operators/dispatcher-result.test.ts (REQ-OPERATOR-063: foreign reset calls cannot hide requested completion) -->

Pre-reservation `preparation` rejections report trusted Activity/generation, step `parse` or `capability`, fixed class `body-limit`, `invalid-json`, `invalid-wire`, `request-denied` or `authority-denied`, deadline and numeric status. Capability-construction classification does not identify a provider or finer cause. Logging failure preserves the original 403 response and lifecycle. No request or exception text crosses this diagnostic wire. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: preparation rejection $name preserves denial and private diagnostic wire) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: preparation logging outage preserves denial and later authorized work) -->

For `invalid-wire`, private `wireRules` identifies at most four unique closed validation rules, with `wireRulesTruncated` when more apply. Labels distinguish envelope/operation identity, inference input/messages/tools shape or count, token shape/bound, SDK completion-token alias, temperature, stream/options and unsupported fields. Raw keys, paths, values and Zod errors remain excluded; public denial stays generic403. A rule identifies the rejected boundary, not an earlier Activity's cause. <!-- @impl: src/operators/operator-runtime-capability.ts::dispatcherWireRules --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: identifies $name without exposing rejected data or changing authority) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: bounds multiple rejected rules without retaining arbitrary issue paths or values) -->

Parent rejection stages are `reservation`, `effect`, `authority`, `upstream`, `forwarded-upstream`, `commit`; resource is a parsed enum or `unparsed`, with current/expired/unavailable deadline and numeric response status. Reservation403 additionally reports transaction-derived `lease-mismatch` or `operation-limit`, parent-owned Activity/generation and the transaction-observed lease deadline. Exhaustion includes actual journal count and configured limit. Existing receipt/retry/conflict/unknown-resolution ordering is preserved; owner logging failure cannot replace denial or mutate lifecycle. No body/credentials/evidence/arbitrary exception or caller-supplied identifier. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: reservation diagnostic wire reports) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-063: owner reservation logging outage preserves) -->

Forwarded HTTP409 preserves its body/running lease and differs from parent-fenced409; unreadable/rejected transport or nested release/guide pre-response failure is effect, not inferred historical cause. Failed settlement telemetry uses trusted Activity/generation and exact allowlisted error/operation/failure; `direct(<submission id>)` maps to fixed direct only for current validated submission, foreign/malformed becomes unknown. Telemetry is not new durable authority, collection/replay/continuation or past-cause proof. <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (emits bounded $name diagnostic with its fenced response) -->

Dispatcher-only Tail examines ≤64 events/128 log records and forwards ≤8 exact child-reported fetch-rejected or http-rejected integer300–599; arbitrary logs/exceptions/extra fields/prompts/bodies/IDs drop. Missing/delayed Tail proves nothing. Explicit POST `/v1/dispatcher/diagnostic` carries same exact two JSON forms, ≤256 bytes/250ms and ≤8 valid logs per live instance/generation (transient reset on eviction, no durable ledger). Trusted binding correlates; wrong route/method/type/syntax/status/size/unfinished/stale denies. Best-effort failure cannot replace original inference error, postpone settlement indefinitely, renew authority or mutate cleanup/results. <!-- @impl: src/operators/activity.ts::readDispatcherDiagnostic --> <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherDiagnosticReport -->

<a id="owned-session-and-structured-pi"></a>
## Owned sessions, resources and persistence

`OwnedOperatorSessionService` preserves distinct Activity/Codeflare session/Pi conversation/task identities and durable order before effects. Exact repeats reconcile, changed stable identity conflicts; lost response observes same reservation, uncertain configuration never becomes success/replacement. Stop fences new work and stops only owned session. Bucket/bootstrap reconciles invoking human and supplies fresh scoped credentials/applied managed identity parent-to-container; overlap must not corrupt unrelated operator/human work. Restrictions persist over wake, JWT remains memory-only and same-human rebind required.

`OperatorPiConversation` runs beside ordinary PTY manager, trusted config fixes root/provider/model/reasoning/prompt/tools. Create once/reopen exact canonical recorded JSONL/ID; persist task intent before SDK call. Supports bounded prompt, one pending follow-up/steer, direct approved active native tool (not model selection), approval-needed, observation and awaited cancellation; missing/unknown SDK effect is not replaced/replayed. Memory queue 1024 events/1 MiB and cursor page100 events/64 KiB report gaps. Independent task SDK sessions see finite parent-approved input refs/exact reads/immutable staged bounded outputs, no candidate extension/broader Host authority. Ordinary human root/PTYS unchanged. <!-- @impl: host/src/operator-pi.ts::OperatorPiConversation --> <!-- @impl: host/src/operator-pi-service.ts::createOperatorPiService -->

Restricted PID1 validates paired Pi/sync identity, creates private Activity tree and `~/Operators`, skips whole-home/managed-policy restore, bisync/baseline daemon/Vault/clone. Shutdown drains only accepted explicit upload under unexpired authority, never starts persistence; awaits owned SDK cancellation and reports unsynced output honestly. See [Container](container.md#restricted-operator-lifecycle), [Host APIs](api-reference.md#internal-operator-host-apis).

<a id="opaque-package-attachment-restore-req-operator-052"></a>
### Opaque package attachment restore

Parent admission owns locators/canonical paths/exact sizes/SHA-256; package cannot choose bucket/destination. Activity persists inert metadata; parent projects bytes digest-and-size verified. After port8080 binds while readiness closed, PID1 restores ≤16 attachments/8 MiB under `/run/codeflare/operator-resources/input/`, rejects path escapes/symlinks and verifies before work. Missing config/port/bytes/identity mismatch fails closed, never enters synchronized human storage; package alone interprets contents. Claimed packet path additionally requires signed claim/current drive, fixed credential-free source Host task, conditional owner-bucket write/readback or verified replay and immutable Activity descriptors. Initialization must match private current-generation checkpoint for claimed packets; reservation binds current attachments and denies later additions. No claim of complete-checkpoint matching for all initialization beyond REQ-OPERATOR-050's recorded limitation. <!-- @impl: src/operators/attachments.ts --> <!-- @impl: src/container/index.ts::configureOperatorAttachments --> <!-- @impl: scripts/restore-operator-attachments.mjs --> <!-- @impl: entrypoint.sh -->

<a id="explicit-scoped-persistence"></a>
<a id="independent-sync-evidence"></a>
### Explicit scoped persistence and independent verification

Parent fixes owner bucket, `~/Operators`, policy digest, private prefix/deadline. Authenticated `/internal/bisync-trigger` is scoped Sync now: persist credential-free receipt before effects, exact regular non-symlink declared files matching hash/size, mirror `Operators/`, private `.codeflare/operators/` manifest last. No implicit delete/whole-home fanout/final sync. Complete identical sync reconciles incl concurrent; changed repeat conflicts, interrupted/lost nonterminal effects become unknown before writes and never replay. Activity prepares scope/exact-key internal stripped-operation write auth/seal/uploaded digest/independent evidence; sealed writes deny.

Verifier independently bounds/reads private manifest exact digest/scope then declared objects. V1 manifest binds activity/session/operation/request/policy digest, unique canonical paths/sizes/SHA-256, ≤64-KiB manifest/128 files/8-MiB total. Every hash/size must match; expired/missing/corrupt/out-of-scope denies. Upload success/timestamp is not durability or file-to-R2 restoration proof. Human bisync/final-sync unchanged. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @impl: host/src/operator-sync-io.ts::OwnedOperatorSyncFiles --> <!-- @impl: src/operators/sync-verification.ts::verifyOperatorSync --> See [Storage](storage-and-sync.md#restricted-operator-persistence).

<a id="webhook-capability-handoff"></a>
## Webhook capabilities

Enterprise fixed `/operator-webhook/v1/activities/:activityId/{start,status,continue,result}` requires bearer capability bound to route/activity/operation/purpose, not independent identity. Start wins once and durably queues; status is metadata/generation only. Only POST continue accepts bounded `{ "generation": 1 }`, atomically claims one safely waiting generation; delayed/duplicate claim cannot reserve newer drive. Other operations accept no body. Result not-ready is nonconsuming; ready redemption is consuming, no rerun after lost delivery. Protected Review's explicit bounded exception permits original read authority to reread identical terminal bytes only until Activity deadline+2h, incl caps on older later-expiry records; never remints start/read. Capabilities renew neither JWT nor execution; valid result authority may survive JWT expiry/disablement.

Fixed bounded terminal failure/cancel/expiry/supersession outcomes, no-store/rate-limit/no token reflection. Worker-first routing prevents SPA fallback; narrow managed Access bypass weakens nothing else and handler retains enterprise/path/method/capability/expiry/activity checks. Provision failure preserves other protection and removes incomplete new bypass.

`createWebhookHandoff` optional AES-GCM uses separately rotated operator key and deployment/operator/activity/workflow/revision/expiry context; without configured key token-only handoff has workflow-input visibility warning. Configured encryption failure cannot downgrade; tokens/keys never logs/candidate-controlled steps. Plumbing is not activation or shipped trusted publisher proof. <!-- @impl: src/routes/operator-webhook.ts --> <!-- @impl: src/operators/webhook-handoff.ts::createWebhookHandoff -->

<a id="owner-scoped-activity-surface"></a>
<a id="req-operator-027-preserved-clauses"></a>
## Owned activity presentation

Enterprise routes derive signed human owner key, validate durable index ownership before detail/result/cancel/start; CSRF on mutations, no replay. GET detail/result is non-effectful/nonconsuming, bounded secret-free. Header control exists even empty, dashboard between user/Settings and terminal between VSCode/Storage. Operator overview explains autonomous background agents. Desktop/tablet anchored portal popover avoids filtered ancestor; mobile bottom sheet, focus enters/returns, width change closes (height-only survives). Empty/single-completed height168px; working/multiple retained incl completed bounded≤60vh with scrolling/keyboard accessible. Manual visual/focus obligations remain independent of component tests.

Five-at-a-time owner history retains≤20 browsable summaries/operator without deleting Activity results. Stable cursor rejects expired/foreign, updates don't skip. Working count covers persisted entries beyond display index; pending no-summary preparation contributes only when displayed. Unread counts new admissions only, opening CSRF-acknowledges observed sequence, later arrivals stay unread, failed ack keeps unread; no result collection/replay. Trusted pinned names and allowlisted admitted repository/PR/progress only; historical five-entry page may recover missing metadata from same-owner pinned Activity without result reads/status/cursor/history rewrite; mismatched/contradictory unavailable never substitutes.

Detail separately shows execution/cleanup/collection/attention/progress/source/session links; stale observation is not alert. All published Review reports/findings/omissions and settled Dispatcher evidence render safe readable fields beyond preview limits, unavailable unsafe fields explicitly marked; no opaque arbitrary JSON, compatibility-safe never equals merge authorization. Error text “Activity unavailable / Last known state cannot be treated as current” is list-read fallback, not execution state. Nonenterprise renders/requests none; account-switch/mobile acceptance remains qualified by owning requirements. <!-- @impl: src/routes/operator-activities.ts --> <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx::OperatorActivityButton --> <!-- @impl: web-ui/src/components/OperatorActivityButton.tsx -->

<a id="consumer-contract-and-dependency-inventory"></a>
<a id="req-operator-053-contract-details"></a>
<a id="req-operator-054-preserved-clauses"></a>
<a id="req-operator-056-contract-details"></a>
## Protected Review boundary

Generic `consumer-contracts.ts` v1 binds consumer/activity/operator/run/source/revision/input digests, ≤16 opaque non-path attachments/8MiB and parent inference/session/storage references. Exact repeats reconcile, changed stable field conflicts; bounded JSON rejects nested credentials/authority, recursive operator-to-human admission and foreign origin. Direct/session/webhook fixtures and unchanged canonical local-review resource prove seams, not private workflow or clearance authority.

Conductor owns canonical packet, reviewer session orchestration, lane/findings/result semantics, history reconciliation and publication policy. Codeflare parent authenticates/fences original actor, scope, resource bytes, transport and receipts; generic host confinement stays Codeflare. Baked distribution is not managed curation's runtime master. Canonical reassessment implementation is package `src/review-action-history.js::reconcileProtectedReviewHistory`, traced via immutable `conductor-review.generated.json` module and compiled lifecycle test, not a local Codeflare policy. Canonical local packet builder remains `preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs` unchanged.

Enterprise authenticated PR boundary reserves one visible actor/installation/exact PR/protected Action/inference/resource session context. Selector chooses exactly one remote (active applicable trusted Action), unchanged local (confirmed absent/inactive) or unavailable (broken/ambiguous active); target switch reselects. No direct autoload dual path, no Pi/Codeflare dispatch of auto-trigger workflow. Local `/review` never starts operator; failed active remote cannot silently fall back/clear. Range/rejection/Pi claims aren't principal authority; human expiry stops protected work.

Enrollment proposes fixed-origin protected workflow through reviewed target PR without protected-base bypass; pinned runtime checks out only Codeflare runtime, not target code/root package, separates unprivileged collect and protected publish. Exact protected-base workflow bytes plus valid maintained runtime identity verify inactive trust only; pending/moved/denied/unavailable runtime never trusts/activates. Proposal branch cannot contain unrelated changes; runtime must execute collect/publish and dependencies. Lost accepted target writes reconcile exact receipts, not retry. Generic edits cannot forge trust. Registration platform-admin/CSRF protected pull_request_target only, no workflow_dispatch. Enrollment procedure remains [Deployment](deployment.md#dormant-review-enrollment), activation/deployment/required-check change require separate authorization.

Fixed three origins concurrent audience-specific OIDC probes have one10s deadline: exactly one affirmative wins despite peer error/timeout, zero/multiple block. Non-consuming exact actor/context discovery returns no capabilities. Signed workflow_ref/workflow_sha protected caller AND job_workflow_ref exact maintained runtime commit both required. Claim binds current PR/human/exact session generation; caller digest/generation cannot select. D1 Stop closes claim/start, exact Activity durably cancelled before Stop confirmation/restart incl late admission; lost cancellation keeps pending Stop, lost accepted claim never redelivers/replaces. Parent JWT/GitHub never reach Action/Pi/child.

Claimed packet parent path verifies current Action/human/installation/PR/D1 generation before Git upload-pack, fixed source-session Host task and output acceptance; ordinary Enterprise source Host route (not restricted operator session) authenticates via container token, not alone claim authority. Inert Git pack/fixed metadata executes baked isolated credential-free script; conditional owner storage/exact readback/descriptors then digest/size-verified reviewer restore. Package creates canonical packet after Action start; no credential enters reviewer.

After claim and real drive reservation, the existing async runtime binding enriches only the local invocation copy with parent-verified boundary/round, workflow/run/attempt, publisher identity and original input/package/resource/policy digests ([REQ-OPERATOR-053](../../sdd/spec/operators.md#req-operator-053-enterprise-pr-boundary-review-handoff)). Persisted intent and input digest are not rewritten; the original invocation separately remains the request digest source. Current claim, actor, session, installation, drive and deadlines are rechecked around identity lookup. Missing identity or changed authority fails closed. Ordinary consumers retain their existing path. This composition is not authenticated live reviewer execution or physical-cleanup proof. <!-- @impl: src/operators/conductor-production.ts::bindClaimedConductorInvocation --> <!-- @test: src/__tests__/operators/conductor-prepared-runtime.test.ts -->

Publication requires exact current reservation/protected run/attempt/terminal non-driving collected Activity generation. Registry stores opaque effect digests/IDs only, independent pending artifact/comment/check persists reconstruction, repeats don't authorize writes, externalID binds once, lost ack reconciles recorded ID, newer reservation fences older completion. No lock/transaction spanning GitHub. Journal/concurrency/check-name alone never clears.

Separate publisher verifies fixed GitHub Actions bot/App identity via API (not per-repo variables), original reports and authenticated history; canonical immutable terminal artifact incl original reports once binds repository/PR/revision/run/Activity, readable comment generation/digest and shadow check exact external IDs. Red/partial/missing/incomplete never green, unresolved findings retained, late old check cannot clear new revision. Parent frozen projection pins admission/round/invocation/package/resource/packet/session/consumed-result digest, supplies identity/evidence while package interprets policy. Physical cleanup stays uncertain until exact container destruction confirmed; SDK stopped/failed destruction not proof.

Remote Pi reads only parent independently authenticated publisher/workflow/run/attempt/artifact digest/comment/check via current actor repository access and actor/session-associated reference, never foreign private Activity/arbitrary shell findings, start or minted authority. Unavailable/incomplete is not empty success. It retains joint CI triage/FIX without second wave; Activity without publication/exact-head CI remains pending. After complete same-session triage a finding-linked rejection for same repo/PR/later head carries bounded rationale/evidence/publication references; parent independently rechecks original finding/publisher/pages, forged/omitted/truncated/duplicate denies sealing. Approved packets retain original finding; only package independent next round reassesses, disagreement/silence alone never clears.

<a id="fenced-renovate-publication"></a>
<a id="req-operator-060-contract-details"></a>
<a id="req-operator-061-contract-details"></a>
## Separately fenced Renovate publication

Legacy read-only assessment/result collection never publishes. Independent explicit authenticated owner-admin command selects active D1 session/lifecycle generation and admitted completed nested compiled assessment, not caller/model target. Pins owner/session/evidence before effects; rechecks live Access/admin/install/grants/session/repository/PR/Renovate/base/head/publication permission before each. Expiry/logout/Stop/revocation/changed session/install denies. Every effect reserves exact-generation durable intent; duplicate/uncertain writes reconcile exact remote marker/receipts, never blind replay or falsely attribute external merge. Unsafe/unknown may authorize bounded explanatory DO_NOT_MERGE comment but not approval/merge; malformed/flattened/missing/contradictory result denies. Safe additionally needs cited release/guide/config evidence and complete compatible checks/statuses/reviews/rules/mergeability. Unavailable/ambiguous/unknown protection denies, failed merge checks need not suppress authorized comment; zero configured checks alone proves neither safe nor blocked. Merge supplies expected head SHA; base rechecks immediately before each effect, cannot atomic-freeze base, residual race disclosed.

An explicitly selected one-off publication remains distinct from prospective scanning. Prospective activation binds the currently authorized admin/session, enabled installation and fixed repository scope, with immutable server cutoff and sealed exact admin session; no caller cutoff or permanent technical identity. Failed scheduling acknowledgement is an error, and retry retains the same cutoff; older, reopened or updated old PRs are ineligible.

Existing hourly Container scheduling obtains complete bounded authenticated pages, current verified Renovate App and created_at, including offline arrivals strictly post-cutoff; incomplete/stale/unavailable evidence skips. Before admission it rechecks sealed Access/admin/invoker/pinned installation/active D1 generation. Concurrent valid admins elect stable actor/session/generation/Activity; uncertain prepare/start reconciles that identity rather than replacing it. Changed heads revalidate without pre-cutoff admission.

Current supported intent3 packages select comments/merges within exact Registry admission, the admitted target and fresh parent authority; this path does not invoke every legacy assessment publisher gate. Legacy assessed-publication retains its separate publisher gates; alarms and child requests cannot bypass parent authority. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048/061/062/071: repository-only prospective parent authority) -->

The original fixed-scope obligations remain whole in REQ-OPERATOR-060/061/071; non-default activation and operational target selection belong to the [private operator owner](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/README.md). No activation or live effect is certified by this reference.

<a id="preserved-contract-details"></a>
## Preserved contract details

Legacy preserved-clause and contract-detail fragment aliases above now lead to their durable concern owners; they do not collect campaign histories. Concrete Registry records/API/Dispatcher wire/host obligations remain in the [normative Operators appendix](../../sdd/spec/operators.md#operator-registry-contract). Requirement status and historical proof remain in original verification records; this consolidation does not upgrade incomplete live identity/egress/R2/restore/settlement/physical cleanup/Action/publication/visual acceptance. It authorizes no activation, deploy, pin or ABI change.

<a id="verification"></a>
## Verification boundaries

Signed-token/parsers prove identity and input boundaries; native Loader/generated SDK fixtures prove only exercised native composition. Instrumented parent transport is not authenticated upstream or deployed end-to-end evidence. Host upload is not independent durability, fencing is not physical cessation, child warning is not root-cause diagnosis, compatible assessment is not merge readiness. Owning requirements separately qualify exact-head CI, native eviction/alarm, deployed effects/collection/cleanup, browser/manual and protected Action evidence. No campaign head or prior deployment is asserted as current.

<a id="requirement-and-source-map"></a>
## Requirement and Source Map

| Concern | Requirements and source/evidence |
|---|---|
| Human/policy/interception | REQ-OPERATOR-001/003/004/007/014/019/028: `src/lib/jwt.ts`, `src/lib/access.ts`, `execution-context.ts`, `interception-policy.ts`, `jwt-stamping.ts`, `inference-selection.ts`; adjacent signed-token/interceptor tests |
| Distribution/management/admission | REQ-OPERATOR-002/010/011/013/030/032/034/035/043–046: `distribution.ts`, `distribution-client.ts`, `github-release-management.ts`, `registry.ts`, `src/routes/operator-management.ts`; parser/catalog/access/promotion/acquisition tests |
| Runtime/transport/diagnostics | REQ-OPERATOR-015–018/039/047/048/062/063: `loader.ts`, `orchestrator.ts`, `runtime.ts`, `activity.ts`, `operator-runtime-capability.ts`, `dispatcher-result.ts`, `dispatcher-source-limits.ts`; Loader/native/production/source-identity/result/Tail tests |
| Session/resources/persistence | REQ-OPERATOR-005/009/020–024/037/038/050/052: owned-session/bootstrap/resources/attachments/consumer/sync modules, `host/src/operator-pi.ts`, `host/src/operator-sync.ts`, restore scripts/PID1; adjacent Host/session/sync tests |
| Webhook/edge | REQ-OPERATOR-006/012/025/026/029/031: protected secrets/handoff/Activity, webhook route/setup/Worker-first assets; adjacent edge/capability/setup tests |
| Catalog/invocation | REQ-OPERATOR-008/049/058/066–068/070/073/075: management routes/Registry and `OperatorManagement.tsx`/`OperatorManagementActivity.tsx`; management-flow/redesign/launcher tests and manual browser checks |
| Owner activity | REQ-OPERATOR-027/033/036/040–042/057/059/069: Activity/Registry/owner routes, `OperatorActivityButton.tsx`; owner-page/result/UI tests and manual isolation/visual boundaries |
| Protected Review | REQ-OPERATOR-053–056/064/065/072/074: boundary enrollment/claim/OIDC/reservation/history, independent workflow/script, dedicated selector/remote extension, compiled Conductor fixture; adjacent original evidence anchors |
| Renovate assessment/publication | REQ-OPERATOR-051/060/061/071: parent evidence projection/compiled Dispatcher, `renovate-publication.ts`, `renovate-prospective.ts`, Registry/Activity/Container/routes; exact-output/publisher/scan tests, not live policy verdict |

Paths without directory qualification above are under `src/operators/`. Detailed original `@impl`, `@test`, `@manual`, statuses, dependencies and verification qualifiers remain in [Operators](../../sdd/spec/operators.md), not replaced by this map. Package references own package inventories.

<a id="related-documentation"></a>
## Related Documentation

- [Normative Operators and Registry appendix](../../sdd/spec/operators.md#operator-registry-contract)
- [Container — Restricted Operator Lifecycle](container.md#restricted-operator-lifecycle)
- [Storage & Sync — Restricted Operator Persistence](storage-and-sync.md#restricted-operator-persistence)
- [Authentication — Human Access claims](authentication.md#human-access-claims-for-the-operator-interface)
- [API Reference — Operator APIs](api-reference.md)
- [Reusable Dispatcher package](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/develop/documentation/reusable-dispatcher.md)
- [Private operator library](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/README.md) for non-default operational values and runbooks
