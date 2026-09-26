# Operator Registry

This release extends the existing Operator foundation with GitHub package installation, delegated Operator Management, and generic directed profiles. Codeflare owns the generic Operator Interface, Loader, lifecycle, resources, sessions, synchronization, GitHub and inference boundaries, and publication fencing. Conductor owns Review packet preparation, session orchestration, result collection, history reconciliation, and publication behavior. Codeflare retains generic host-side Pi sandbox and security confinement and distributes Conductor Review Pi extensions, skills, and references for configuring per-repository GitHub Actions. Existing endpoint registrations, Gate 1, human sessions, local review behavior, and Dispatcher code remain unchanged.

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

**Dependencies:** [REQ-OPERATOR-030](operators.md#req-operator-030-immutable-approved-bundle-validation)

**Verification:** Adjacent catalog and package-resource tests cover the delivered behavior; exact-head CI and deployed restore evidence remain outstanding.

**Status:** Partial

---

### REQ-OPERATOR-044: GitHub immutable package acquisition

**Intent:** Codeflare installs only exact approved GitHub release assets.

**Applies To:** User

**Acceptance Criteria:**

1. Registration resolves a canonical GitHub repository identity and protects its acquisition-only PAT. <!-- @impl: src/operators/github-release-management.ts::registerGithubOperator --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
2. Promotion accepts only bounded immutable assets with matching repository, approved workflow provenance and digest. Provenance may name the approved workflow as its exact path-qualified ref or its exact branch ref; both require the same verified workflow ID, run path and branch. <!-- @impl: src/operators/github-release-management.ts::acquireRelease --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
3. Unsafe URLs or redirects, unavailable bytes, and provenance, digest, or schema mismatches fail without credential disclosure or enablement. <!-- @impl: src/operators/github-release-management.ts::githubBytes --> <!-- @impl: src/operators/github-release-management.ts::acquireRelease --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
4. The shared package compiler deterministically emits the approved bundle schema, exact resource digests and sizes, and a matching discovery manifest. <!-- @impl: scripts/operator-package/compiler.mjs::compileOperatorPackage --> <!-- @test: src/__tests__/operators/operator-package-compiler.test.ts (shared operator package compiler) -->
5. The package compiler rejects unsafe paths and package-supplied authority rather than inferring policy or bindings. <!-- @impl: scripts/operator-package/compiler.mjs::compileOperatorPackage --> <!-- @test: src/__tests__/operators/operator-package-compiler.test.ts (shared operator package compiler) -->

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

**Constraints:** Source credentials remain write-only; packages cannot grant capabilities.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-030](operators.md#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Adjacent acquisition and compiler tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

---

### REQ-OPERATOR-045: Delegated management and invocation

**Intent:** Operator management and invocation have separately enforced access.

**Applies To:** User

**Acceptance Criteria:**

1. Platform-managed users and groups may manage only owned operators within the configured ceiling. <!-- @impl: src/lib/access.ts::canManageOperator --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.withinManagementCeiling --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
2. Invocation is a separate grant; managers do not gain another user's activities and invokers cannot mutate management state. <!-- @impl: src/lib/access.ts::canInvokeOperator --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.getOwnedActivity --> <!-- @impl: src/routes/operator-management.ts::managed --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
3. Stable verified group membership, revocation and resolver failure are enforced server-side. <!-- @impl: src/lib/access.ts::resolveOperatorGroupIdentity --> <!-- @impl: src/routes/operator-management.ts::managementContext --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

**Constraints:** Request bodies cannot grant global eligibility or execution identity.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-013](operators.md#req-operator-013-enterprise-operator-administration-authorization), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Adjacent access tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

---

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

---

### REQ-OPERATOR-047: Generic directed profile admission

**Intent:** Installed profiles run only under the parent-selected human, resource scope and current activity authority.

**Applies To:** User

**Acceptance Criteria:**

1. The parent normalizes and digests input, selects the profile and resources, and rejects caller authority or resource substitution. <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
2. Generation, expiry, cancellation and installation policy are checked before protected effects. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Protected operations recheck the current human and exact installation and release revisions through parent-owned interceptors. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
4. Repeated identical operations reconcile, changed input conflicts, and uncertain effects are not replayed. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
5. Completed output is bounded and durable before delivery; unknown completion is fenced. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
6. Parent-composed profiles confine independent SDK task sessions to finite parent-approved input references, exact filesystem reads and outputs, immutable report staging, and no candidate extension or broader Host access. <!-- @impl: src/operators/session-initialization.ts::parseOperatorPiInitialization --> <!-- @impl: host/src/operator-pi-isolated.ts::createIsolatedPiTools --> <!-- @impl: host/src/operator-pi-isolated-runner.ts::runApprovedTasks --> <!-- @test: src/__tests__/operators/session-initialization.test.ts (REQ-OPERATOR-021: finite parent-approved Pi initialization) --> <!-- @test: host/__tests__/operator-pi-review.test.js (REQ-OPERATOR-021: Review composition exposes only fixed sandboxed read and write tools) --> <!-- @test: host/__tests__/operator-pi-isolated.test.js (REQ-OPERATOR-021: each SDK child sees only its declared inputs and can stage one immutable bounded output) --> <!-- @test: host/__tests__/operator-pi-isolated-runner.test.js (REQ-OPERATOR-021: one structured task creates independently isolated SDK sessions and durable identities) -->

**Notes:** The isolated child-session candidate and restored-input tests are local and unverified by exact-head CI or the real protected Action; do not claim live acceptance from these anchors.

**Constraints:** Profile admission can only narrow verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](operators.md#req-operator-003-principal-bound-activity-context), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Adjacent admission and production-composition tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

---

### REQ-OPERATOR-048: Dispatcher execution

**Intent:** Dispatcher runs directed work under bounded Dynamic Worker authority without a session or container.

**Applies To:** User

**Acceptance Criteria:**

1. The child runtime executes the pinned generated Flue artifact through the delegated Loader capability. <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
2. One durable execution lease remains bound to its original generation, submission, input, release and expiry. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Admission and status observation neither create a waiting checkpoint nor renew authority. <!-- @impl: src/operators/runtime.ts::driveDispatcherRuntime --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
4. Only exact completed settlement with no outstanding or unknown protected operation may commit waiting. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
5. Cancellation, expiry, revocation and stale warmed callers deny subsequent protected work. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
6. The Dispatcher receives only bounded parent-authorized reads, inference and continuation scheduling, and cannot access sessions, containers, credentials or direct networking. Its activity-bound facet bridge returns no parent connections or broadcast effects for the pinned SDK's connection-free notifications; foreign paths, generations and oversized notices remain denied. <!-- @impl: src/operators/distribution.ts::parseDispatcherBundle --> <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @impl: src/operators/activity.ts::OperatorDispatcherCapability --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-048: production Dispatcher bundle boundary) --> <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048: production Dispatcher Loader host) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
7. Existing activity identity, storage, Gate 1 and default-entrypoint behavior remain compatible. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018) -->

**Notes:** Production composition exists, but exact-head CI and production native eviction and alarm evidence are incomplete.

**Constraints:** Uncertain external effects are fenced, not replayed; execution cannot outlive verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-015](operators.md#req-operator-015-isolated-approved-worker-loading), [REQ-OPERATOR-017](operators.md#req-operator-017-durable-drive-generations), [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission)

**Verification:** Production-composition tests are instrumented rather than native. The existing native Loader fixture proves generated-artifact compatibility, not production eviction and alarm composition; exact-head CI and that native composition proof remain outstanding.

**Status:** Partial

---

### REQ-OPERATOR-049: Operators management interface

**Intent:** Authorized people manage and invoke operators from a separate responsive product area.

**Applies To:** User

**Acceptance Criteria:**

1. Operator management routes enforce management authorization independently of Administration navigation. <!-- @impl: src/routes/operator-management.ts::managementContext --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
2. Catalog, registration, promotion, installation, grants and activity states expose no stored secrets. <!-- @impl: src/routes/operator-management.ts::presentInstallation --> <!-- @impl: src/operators/registry.ts::managementProjection --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
3. Desktop, tablet and mobile retain usable controls, focus and scrolling for long names and errors. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
4. An uncertain start blocks another start until its prepared activity is reconciled through owner-scoped detail. <!-- @impl: web-ui/src/components/OperatorManagementActivity.tsx::OperatorManagementActivity --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (does not allow another start after an uncertain response until the prepared activity is reconciled) -->
5. Failed preparation cannot be reconciled against a previous activity. <!-- @impl: web-ui/src/components/OperatorManagementActivity.tsx::OperatorManagementActivity --> <!-- @test: web-ui/src/__tests__/operators/operator-management-activity.test.tsx (does not reconcile failed preparation against an earlier accepted activity) -->

**Notes:** Implementation is present, but exact-head CI and responsive browser evidence are incomplete.

**Constraints:** The management surface cannot grant authority beyond server-side policy.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-045](#req-operator-045-delegated-management-and-invocation), [REQ-OPERATOR-046](#req-operator-046-explicit-release-promotion)

**Verification:** Adjacent route and UI tests cover the delivered behavior; exact-head CI and responsive browser evidence remain outstanding.

**Status:** Partial

---

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
- Under [REQ-OPERATOR-005](operators.md#req-operator-005-owned-operator-session-lifecycle), owned-session reservation binds the request digest to the current attachment projection and denies later additions.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission), [REQ-OPERATOR-005](operators.md#req-operator-005-owned-operator-session-lifecycle)

**Verification:** Adjacent capability, attachment and owned-session tests cover the delivered generic boundary. The claimed packet path and compiled Conductor fixture are candidates pending exact-head CI; no deployed protected Action or live restore receipt is proven.

**Status:** Partial

---

### REQ-OPERATOR-051: Renovate Dispatcher assessment

**Intent:** A directed Dispatcher performs bounded read-only Renovate PR and CI assessment.

**Applies To:** User

**Acceptance Criteria:**

1. The parent permits reads only for the admitted repository and bounded pull-request, check and diff inputs; package-owned policy determines which bot-authored requests qualify for assessment. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->
2. Recommendations bind exact observed heads and make stale, truncated, rate-limited or insufficient evidence explicit. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->
3. The parent denies repository mutation, session or container creation, and unattended reruns. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

**Constraints:** Assessment is read-only and remains bound to the admitted activity.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution)

**Verification:** Adjacent Renovate assessment tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

---

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

**Dependencies:** [REQ-OPERATOR-030](operators.md#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-050](#req-operator-050-generic-conductor-capability)

**Verification:** Adjacent package, attachment and startup tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

---

### REQ-OPERATOR-053: Enterprise PR-boundary Review handoff

**Intent:** A trusted GitHub Action starts and publishes independent Review under the already-authenticated Codeflare actor's bounded operator context, while the existing local review procedure remains available unchanged.

**Applies To:** User

**Acceptance Criteria:**

1. Only Enterprise deployment mode may select the operator Review path, prepare its activity, call the Action handoff or expose operator progress. Non-enterprise PR-boundary and local `/review` behavior remains unchanged.
2. At an authenticated Enterprise PR boundary, the parent prebinds one visible activity to the verified human, installation, exact current PR revision and applicable protected Action, with eligible inference and the selected installation's resource-profile scope. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @impl: src/operators/review-boundary-preparation.ts::prepareVerifiedBoundary --> <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/review-boundary-egress.test.ts (REQ-OPERATOR-053: authenticated Git push prepares exactly one visible boundary reservation) --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-053: exact-context preparation is one durable Registry reservation) --> <!-- @test: src/__tests__/operators/conductor-production-inference.test.ts (REQ-OPERATOR-053: a provider-default inference route admits a scoped Conductor session without a reasoning grade) -->
3. At an eligible PR boundary, selection is remote only for an applicable trusted Action, local only for confirmed absence, and unavailable otherwise. <!-- @impl: preseed/agents/pi/extensions/review-enforcement.ts::registerReviewEnforcement --> <!-- @impl: src/operators/review-boundary-preparation.ts::selectVerifiedBoundaryAction --> <!-- @test: src/__tests__/lib/review-enforcement.test.ts (REQ-OPERATOR-053: Enterprise PR-boundary remote review selection) --> <!-- @test: src/__tests__/operators/review-action-applicability.test.ts (REQ-OPERATOR-053: approved target Action applicability, not release provenance) -->
4. The status response exposes only metadata and the durable generation. Continuation claims that waiting generation once; a delayed accepted continuation cannot reserve a later drive. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @impl: src/operators/runtime.ts::driveOperatorRuntime --> <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-053: webhook continuation is single-use for each durable waiting generation) --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-053: a delayed continuation cannot reserve or execute against a newer waiting checkpoint after eviction) --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (REQ-OPERATOR-029: continuation wire response acknowledges work without echoing capability or issuing new authority) --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (REQ-OPERATOR-029: terminal status wire response is metadata-only even when the internal projection includes report bytes) -->
5. Only a separate trusted publisher holds credentials for Review publication; neither local Pi nor the compiled child may publish. Journal ordering and independent publication are governed by [REQ-OPERATOR-055](#req-operator-055-pr-wide-publication-ordering) and [REQ-OPERATOR-056](#req-operator-056-independent-review-publication).
6. The existing owner-scoped Operator activity view shows real waiting, running, cleanup and terminal states; local Pi monitors independently verified published Review and ordinary CI and retains triage/FIX without running a second reviewer wave.
7. The protected Action may reread only the same immutable terminal bytes with its original unexpired read capability after a lost delivery. <!-- @impl: src/operators/activity.ts::OperatorActivity.redeemWebhookResult --> <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: scripts/operator-boundary-action.mjs::collectBoundaryResult --> <!-- @test: src/__tests__/operators/activity-state.test.ts (rereads identical immutable terminal bytes after lost delivery only with the original read capability) --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-053: lost result delivery rereads the identical terminal bytes without another start) -->

**Constraints:**

- Neither session ownership nor GitHub identity supplies human authority.
- No new identity broker, workflow-selected principal, JWT renewal or candidate-controlled workflow.
- Pi and Codeflare do not dispatch the automatically triggered GitHub workflow.
- Only the authenticated claim binds run/attempt under [REQ-OPERATOR-054](#req-operator-054-protected-action-claim-and-stop-fence).
- Local `/review` remains unchanged and never starts the operator.
- Uncertain applicability, disabled configuration, expired authority or failed remote execution cannot silently fall back or clear a check.
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

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission), [REQ-OPERATOR-050](#req-operator-050-generic-conductor-capability), [REQ-OPERATOR-029](operators.md#req-operator-029-capability-authenticated-webhook-edge)

**Verification:** Generation-fenced webhook continuation passed exact-head Codeflare PR Checks at `c4b0cbc9` (run `35855161432`). The Conductor collector's scoped tests passed at `60257e1` (run `35857563056`), while that package workflow remained red for absent Action/publisher modules. Authenticated preparation and Pi remote selection passed exact-head PR Checks at `96d136a0` (run `35892316489`); the Action claim RED suite ran at `e4cbc923` (run `35896387844`) and its automated claim/Stop behavior passed exact-head PR Checks at `6812f243` (run `35903787791`). Earlier preparation checks `35890471868` and `35891520587` failed; the Pi transcript carries bounded untrusted triage excerpts when a completed prior local round exists, otherwise explicitly reports unavailable evidence. Neither this data nor the precommit lifecycle checks establish clearance or an Action-redeemable handoff. Protected Action installation and sandbox claim, independent publication, compiled production-owner execution and current-head Enterprise Integration proof remain pending.

**Status:** Planned

---

### REQ-OPERATOR-054: Protected Action claim and Stop fence

**Intent:** The automatically triggered protected Action can start only its actor-bound prepared activity; session Stop and ambiguous responses cannot turn that handoff into unowned execution.

**Applies To:** User

**Acceptance Criteria:**

1. A signed protected `pull_request_target` run wins the prepared one-time start handoff only for the current PR revision, eligible human and exact session generation. <!-- @impl: src/operators/boundary-action-oidc.ts::verifyBoundaryActionOidc --> <!-- @impl: src/operators/review-boundary-claim.ts::claimVerifiedBoundaryAction --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.claimBoundaryPreparation --> <!-- @test: src/__tests__/operators/review-action-oidc.test.ts (REQ-OPERATOR-054: trusted Action OIDC run identity) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) --> <!-- @test: src/__tests__/operators/review-action-run.test.ts (REQ-OPERATOR-054: protected Action run and fresh GitHub PR context) --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-054: a verified run and attempt alone win the prepared exact revision once) -->
2. A D1 Stop intent closes claim and start admission for the exact session generation. <!-- @impl: src/lib/session-repository.ts::D1SessionRepository.claimStop --> <!-- @impl: src/operators/review-boundary-claim.ts::claimVerifiedBoundaryAction --> <!-- @test: src/__tests__/lib/session-d1-lifecycle.test.ts (REQ-OPERATOR-054: Stop wins before claim or retains the exact Action activity until durable cancellation) --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) -->
3. The exact Activity is durably cancelled before Stop confirmation or restart, even when admission responds late. <!-- @impl: src/operators/activity.ts::OperatorActivity.cancelBoundaryStart --> <!-- @impl: src/routes/session/boundary-stop.ts::fencePendingBoundaryStart --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) --> <!-- @test: src/__tests__/routes/boundary-stop.test.ts (Stop boundary admission fence) -->
4. A lost accepted claim response never redelivers start authority or creates a second Activity. <!-- @impl: src/operators/registry.ts::OperatorRegistry.claimBoundaryPreparation --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) -->
5. A lost Activity cancellation response preserves pending Stop until the exact durable fence is reconciled. <!-- @impl: src/routes/session/boundary-stop.ts::fencePendingBoundaryStart --> <!-- @impl: src/lib/session-repository.ts::D1SessionRepository --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: a lost durable cancellation response retains pending Stop until exact reconciliation) -->
6. The claim response carries the prepared context digest and session lifecycle generation. <!-- @impl: src/operators/review-boundary-claim.ts::claimVerifiedBoundaryAction --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-054: real prepared Registry and Activity owners at protected Action claim) -->
7. Caller-supplied context digest or session generation cannot select claim authority. <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @test: src/__tests__/routes/operator-boundary-claim.test.ts (operator boundary claim route) -->

**Constraints:** No workflow dispatch, workflow-selected principal, cross-owner transaction, new scheduler, replay on lost response or candidate-controlled workflow. The parent keeps Access and GitHub credentials out of Action and child execution.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-053](#req-operator-053-enterprise-pr-boundary-review-handoff), [REQ-SESSION-018](session-lifecycle.md#req-session-018-d1-lifecycle-evidence-is-generation-fenced)

**Verification:** The test-only RED suite ran at `e4cbc923` (PR Checks `35896387844`). Implementation heads `0818d60f`, `8f673c87`, `eff95b47` and `93ed85e8` failed exact-head CI; claim/Stop and restart tests passed exact-head PR Checks at `6812f243` (run `35903787791`). Protected Action sandbox claim remains unproven; this requirement remains Planned.

**Status:** Planned

---

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

### REQ-OPERATOR-056: Independent Review publication

**Intent:** A separate protected publisher uses original verified Review evidence and exact current GitHub identity to publish a non-authoritative shadow round.

**Applies To:** User

**Acceptance Criteria:**

1. Only the separate protected publisher job holds GitHub publication credentials; Pi, candidate code and the compiled child cannot access them. <!-- @impl: .github/workflows/boundary-reviews.yml::publish -->
2. A round cannot clear unless original reports and independently verified GitHub history match the bounded OIDC-authenticated projection of its claimed reservation and collected terminal Activity; missing or stale identity denies publication. <!-- @impl: src/operators/review-boundary-claim.ts::prepareBoundaryPublication --> <!-- @test: src/__tests__/operators/review-boundary-claim.test.ts (REQ-OPERATOR-056: authenticated publication-preparation projection) -->
3. A bounded artifact retains the single canonical terminal result, including the original reports once, under the exact prepared repository, PR, revision, run and activity identity. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: exact projection and journal allow one authenticated artifact, comment and shadow check) -->
4. A human-readable round comment binds the same generation and artifact digest; the artifact retains unresolved original findings. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: a completed review with unresolved findings publishes only a failing check) -->
5. A generation-specific shadow check binds exact external IDs and the immutable content digest. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: exact projection and journal allow one authenticated artifact, comment and shadow check) -->
6. Red, partial, missing or incomplete evidence never publishes a green round. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: a completed review with unresolved findings publishes only a failing check) -->
7. Independent current-context verification rejects a late old check from clearing a newer revision. <!-- @impl: scripts/operator-boundary-action.mjs::publishBoundaryResult --> <!-- @test: host/__tests__/operator-boundary-action.test.js (REQ-OPERATOR-056: a changed PR revision after comment publication fences the old shadow check) -->

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
