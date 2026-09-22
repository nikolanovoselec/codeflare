# Operator Registry

This release extends the existing Operator foundation with GitHub package installation, delegated Operator Management, and generic directed profiles. Codeflare owns the generic Operator Interface, Loader, lifecycle, resources, sessions, synchronization, GitHub and inference boundaries, and publication fencing. Conductor owns Review packet preparation, session orchestration, result collection, history reconciliation, and publication behavior. Codeflare retains generic host-side Pi sandbox and security confinement and distributes Conductor Review Pi extensions, skills, and references for configuring per-repository GitHub Actions. Existing endpoint registrations, Gate 1, human sessions, local review behavior, and Dispatcher code remain unchanged.

### REQ-OPERATOR-043: Catalog and installations

**Intent:** Authorized users can discover only accessible operators and independently configured installations.

**Applies To:** User

**Acceptance Criteria:**

1. Operators, immutable releases and named installations have separate stable identities. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
2. Catalog search and cursor pages are authorization-filtered before return, with a default page size of 50 and maximum of 100. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
3. A release or configuration change in one installation does not change another installation. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
4. An admitted package may optionally declare generic text resources; packages without resources retain existing behavior. <!-- @impl: src/operators/package-resources.ts --> <!-- @test: src/__tests__/operators/package-resources.test.ts (generic admitted Operator package resources) -->
5. The parent projects only digest-and-size-verified resource bytes from declared canonical paths beneath its fixed non-synced resource root. <!-- @impl: src/operators/package-resources.ts --> <!-- @test: src/__tests__/operators/package-resources.test.ts (generic admitted Operator package resources) -->
6. Resource persistence is inert and non-authoritative. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/package-resources.test.ts (generic admitted Operator package resources) -->
7. Wake restores resource restrictions before context configuration or startup. <!-- @impl: src/container/index.ts::configureOperatorResources --> <!-- @impl: entrypoint.sh --> <!-- @test: src/__tests__/operators/owned-session-runtime.test.ts (REQ-OPERATOR-005: owned container runtime) -->

**Constraints:** Package resources grant no authority and do not enter synchronized storage.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-030](operators.md#req-operator-030-immutable-approved-bundle-validation)

**Verification:** Adjacent catalog and package-resource tests cover the delivered behavior; exact-head CI and deployed restore evidence remain outstanding.

**Status:** Partial

**Notes:** Implementation is present, but exact-head CI and deployed restore evidence are incomplete.

---

### REQ-OPERATOR-044: GitHub immutable package acquisition

**Intent:** Codeflare installs only exact approved GitHub release assets.

**Applies To:** User

**Acceptance Criteria:**

1. Registration resolves a canonical GitHub repository identity and protects its acquisition-only PAT. <!-- @impl: src/operators/github-release-management.ts --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
2. Promotion accepts only bounded immutable assets with matching repository, approved workflow provenance and digest. <!-- @impl: src/operators/github-release-management.ts --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
3. Unsafe URLs or redirects, unavailable bytes, and provenance, digest, or schema mismatches fail without credential disclosure or enablement. <!-- @impl: src/operators/github-release-management.ts --> <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
4. The shared package compiler deterministically emits the approved bundle schema, exact resource digests and sizes, and a matching discovery manifest. <!-- @impl: scripts/operator-package/compiler.mjs::compileOperatorPackage --> <!-- @test: src/__tests__/operators/operator-package-compiler.test.ts (shared operator package compiler) -->
5. The package compiler rejects unsafe paths and package-supplied authority rather than inferring policy or bindings. <!-- @impl: scripts/operator-package/compiler.mjs::compileOperatorPackage --> <!-- @test: src/__tests__/operators/operator-package-compiler.test.ts (shared operator package compiler) -->

**Constraints:** Source credentials remain write-only; packages cannot grant capabilities.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-030](operators.md#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Adjacent acquisition and compiler tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

---

### REQ-OPERATOR-045: Delegated management and invocation

**Intent:** Operator management and invocation have separately enforced access.

**Applies To:** User

**Acceptance Criteria:**

1. Platform-managed users and groups may manage only owned operators within the configured ceiling. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
2. Invocation is a separate grant; managers do not gain another user's activities and invokers cannot mutate management state. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
3. Stable verified group membership, revocation and resolver failure are enforced server-side. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->

**Constraints:** Request bodies cannot grant global eligibility or execution identity.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-013](operators.md#req-operator-013-enterprise-operator-administration-authorization), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Adjacent access tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

---

### REQ-OPERATOR-046: Explicit release promotion

**Intent:** Discovery, approval, enablement and rollback are separate revision-safe operations.

**Applies To:** User

**Acceptance Criteria:**

1. Discovery never approves or enables, and approval never enables. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->
2. Mutations require the current revision and persist exact approved release and configuration bytes. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->
3. A source or trust change disables subsequent starts, and a retained approved release can be selected for rollback. <!-- @impl: src/operators/registry.ts --> <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->

**Constraints:** Promotion never expands installation policy or caller authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-044](#req-operator-044-github-immutable-package-acquisition)

**Verification:** Adjacent promotion tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

---

### REQ-OPERATOR-047: Generic directed profile admission

**Intent:** Installed profiles run only under the parent-selected human, resource scope and current activity authority.

**Applies To:** User

**Acceptance Criteria:**

1. The parent normalizes and digests input, selects the profile and resources, and rejects caller authority or resource substitution. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
2. Generation, expiry, cancellation and installation policy are checked before protected effects. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Protected operations recheck the current human and exact installation and release revisions through parent-owned interceptors. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
4. Repeated identical operations reconcile, changed input conflicts, and uncertain effects are not replayed. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
5. Completed output is bounded and durable before delivery; unknown completion is fenced. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
6. Parent-composed profiles may confine SDK filesystem tools to exact approved inputs and outputs without broader host access. <!-- @impl: host/src/operator-pi-review.ts::createOperatorPiReviewTools --> <!-- @test: host/__tests__/operator-pi-review.test.js (REQ-OPERATOR-021: parent-composed Pi filesystem sandbox) -->

**Constraints:** Profile admission can only narrow verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](operators.md#req-operator-003-principal-bound-activity-context), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Adjacent admission and production-composition tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.

---

### REQ-OPERATOR-048: Dispatcher execution

**Intent:** Dispatcher runs directed work under bounded Dynamic Worker authority without a session or container.

**Applies To:** User

**Acceptance Criteria:**

1. Native Worker proof executes the pinned generated Flue artifact with delegated recovery, isolated storage for two activities, and bounded continuation after eviction. <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
2. One durable execution lease remains bound to its original generation, submission, input, release and expiry. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Admission and status observation neither create a waiting checkpoint nor renew authority. <!-- @impl: src/operators/runtime.ts::driveDispatcherRuntime --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
4. Only exact completed settlement with no outstanding or unknown protected operation may commit waiting. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
5. Cancellation, expiry, revocation and stale warmed callers deny subsequent protected work. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
6. The Dispatcher receives only bounded parent-authorized reads, inference and continuation scheduling, and cannot access sessions, containers, credentials or direct networking. <!-- @impl: src/operators/distribution.ts::parseDispatcherBundle --> <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-048: production Dispatcher bundle boundary) --> <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048: production Dispatcher Loader host) -->
7. Existing activity identity, storage, Gate 1 and default-entrypoint behavior remain compatible. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018) -->

**Constraints:** Uncertain external effects are fenced, not replayed; execution cannot outlive verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-015](operators.md#req-operator-015-isolated-approved-worker-loading), [REQ-OPERATOR-017](operators.md#req-operator-017-durable-drive-generations), [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission)

**Verification:** Production-composition tests are instrumented rather than native. The existing native Loader fixture proves generated-artifact compatibility, not production eviction and alarm composition; exact-head CI and that native composition proof remain outstanding.

**Status:** Partial

**Notes:** Production composition exists, but exact-head CI and production native eviction and alarm evidence are incomplete.

---

### REQ-OPERATOR-049: Operators management interface

**Intent:** Authorized people manage and invoke operators from a separate responsive product area.

**Applies To:** User

**Acceptance Criteria:**

1. Operator management routes enforce management authorization independently of Administration navigation. <!-- @impl: src/routes/operator-management.ts --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
2. Catalog, registration, promotion, installation, grants and activity states expose no stored secrets. <!-- @impl: src/routes/operator-management.ts --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
3. Desktop, tablet and mobile retain usable controls, focus and scrolling for long names and errors. <!-- @impl: web-ui/src/components/OperatorManagement.tsx --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->

**Constraints:** The management surface cannot grant authority beyond server-side policy.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-045](#req-operator-045-delegated-management-and-invocation), [REQ-OPERATOR-046](#req-operator-046-explicit-release-promotion)

**Verification:** Adjacent route and UI tests cover the delivered behavior; exact-head CI and responsive browser evidence remain outstanding.

**Status:** Partial

**Notes:** Implementation is present, but exact-head CI and responsive browser evidence are incomplete.

---

### REQ-OPERATOR-051: Renovate Dispatcher assessment

**Intent:** A directed Dispatcher performs bounded read-only Renovate PR and CI assessment.

**Applies To:** User

**Acceptance Criteria:**

1. Only the authorized repository, approved Renovate bot and bounded pull-request, check and diff inputs are read. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->
2. Recommendations bind exact observed heads and make stale, truncated, rate-limited or insufficient evidence explicit. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->
3. The parent denies repository mutation, session or container creation, and unattended reruns. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->

**Constraints:** Assessment is read-only and remains bound to the admitted activity.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution)

**Verification:** Adjacent Renovate assessment tests cover the delivered behavior; exact-head CI remains outstanding.

**Status:** Partial

**Notes:** Implementation is present, but exact-head CI evidence is incomplete.
