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
2. Promotion accepts only bounded immutable assets with matching repository, approved workflow provenance and digest. <!-- @impl: src/operators/github-release-management.ts::acquireRelease --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
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
6. Parent-composed profiles may confine SDK filesystem tools to exact approved inputs and outputs without broader host access. <!-- @impl: host/src/operator-pi-review.ts::createOperatorPiReviewTools --> <!-- @test: host/__tests__/operator-pi-review.test.js (REQ-OPERATOR-021: parent-composed Pi filesystem sandbox) -->

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

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
6. The Dispatcher receives only bounded parent-authorized reads, inference and continuation scheduling, and cannot access sessions, containers, credentials or direct networking. <!-- @impl: src/operators/distribution.ts::parseDispatcherBundle --> <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-048: production Dispatcher bundle boundary) --> <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048: production Dispatcher Loader host) -->
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

1. The parent binds the Conductor to the exact activity generation, installation revisions, human expiry and cancellation state before every protected effect. <!-- @impl: src/operators/conductor-capability.ts::OperatorConductorCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->
2. The parent selects and owns the restricted session profile, bucket and fixed attachment destination; package input cannot replace them. <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->
3. Opaque attachments are restored only from the admitted digest-and-size-bound projection before Conductor work starts. <!-- @impl: src/operators/attachments.ts::projectOperatorAttachments --> <!-- @impl: scripts/restore-operator-attachments.mjs::restoreOperatorAttachments --> <!-- @test: src/__tests__/operators/attachments.test.ts (operator opaque attachment ownership) -->
4. Structured Pi tasks expose no credential or unrestricted filesystem authority. <!-- @impl: src/operators/conductor-capability.ts::OperatorConductorCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->
5. Synchronization seals exact declared outputs and requires independent verification before completion. <!-- @impl: src/operators/conductor-capability.ts::OperatorConductorCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->
6. Storage inspection is owner-scoped, canonical-path bounded and read-only. <!-- @impl: src/operators/conductor-production.ts::createConductorProductionCapability --> <!-- @test: src/__tests__/operators/conductor-capability.test.ts (generic installed Conductor capability) -->

**Notes:** Exact-head CI and deployed owned-session evidence remain incomplete.

**Constraints:** The interface contains no Review-specific route or policy, grants no GitHub publisher credential, and leaves packet, lane, finding, history and publication semantics package-owned.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission), [REQ-OPERATOR-005](operators.md#req-operator-005-owned-operator-session-lifecycle)

**Verification:** Adjacent capability, attachment and owned-session tests cover the delivered generic boundary; exact-head CI remains outstanding.

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
2. At an authenticated Enterprise PR boundary, the parent prebinds one visible activity to the verified human, installation, exact current PR revision and applicable protected Action; neither session ownership nor GitHub identity supplies human authority.
3. At the existing PR-boundary selection point only, a confirmed applicable trusted Action selects exclusive remote Review; confirmed absence selects the unchanged local reviewer path. Inconclusive detection, disabled operator, expired authority or failed configured remote execution never silently falls back or marks a check green. Local `/review` is not an operator entry point.
4. The status response exposes only metadata and the durable generation. Continuation claims that waiting generation once; a delayed accepted continuation cannot reserve a later drive. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @impl: src/operators/runtime.ts::driveOperatorRuntime --> <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-053: webhook continuation is single-use for each durable waiting generation) --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-053: a delayed continuation cannot reserve or execute against a newer waiting checkpoint after eviction) --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (REQ-OPERATOR-029: continuation wire response acknowledges work without echoing capability or issuing new authority) --> <!-- @test: src/__tests__/routes/operator-webhook.test.ts (REQ-OPERATOR-029: terminal status wire response is metadata-only even when the internal projection includes report bytes) -->
5. A separate trusted publisher binds artifacts, human-readable round comment and shadow check to the exact prepared repo/PR/head/base/merge-base, workflow/run/attempt and activity/generation. Pending/published receipts and current-context verification fence stale or ambiguous writes; red, missing or incomplete evidence stays non-green. Activating a required check needs separate explicit authorization.
6. The existing owner-scoped Operator activity view shows real waiting, running, cleanup and terminal states; local Pi monitors independently verified published Review and ordinary CI and retains triage/FIX without running a second reviewer wave.
7. Only the Action redeems one activity-specific start capability and separately redeems the terminal result once with its read capability, retaining an independent receipt before publication. Lost start/result responses cannot replay consumed authority. Browser JWTs and publisher credentials never enter Pi or the compiled child.

**Constraints:** No new identity broker, Pi/Codeflare `workflow_dispatch`, workflow-selected principal, JWT renewal, candidate-controlled workflow or change to local `/review`. Human authority expiry stops protected execution. Actions without matching Codeflare handoff fail closed. The parent independently verifies numeric repository, PR/head/base/merge-base, acknowledged-head ancestry and installed Action bytes. Bounded session-bound range and rejected-finding evidence are not principal authority. GitHub triggers the Action automatically; only its authenticated claim binds run/attempt. Conductor creates the canonical packet after Action start; rejected reasoning alone cannot resolve findings.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission), [REQ-OPERATOR-050](#req-operator-050-generic-conductor-capability), [REQ-OPERATOR-029](operators.md#req-operator-029-capability-authenticated-webhook-edge)

**Verification:** Generation-fenced webhook continuation passed exact-head Codeflare PR Checks at `c4b0cbc9` (run `35855161432`). The Conductor collector's scoped tests passed at `60257e1` (run `35857563056`), while that package workflow remained red for absent Action/publisher modules. Authenticated preparation, automatic Action claim, independent publication, compiled production-owner execution and current-head Enterprise Integration proof remain pending.

**Status:** Planned
