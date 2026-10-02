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

**Dependencies:** [REQ-OPERATOR-030](operators.md#req-operator-030-immutable-approved-bundle-validation), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Existing acquisition, compiler and retention suites cover the baseline. Artifact-only host-family boundary regression coverage and final exact-head GREEN CI remain required; no new host is authorized by this prose correction, and live installation is a separate acceptance receipt.

**Status:** Planned

---

### REQ-OPERATOR-045: Delegated management and invocation

**Intent:** Operator management and invocation have separately enforced access.

**Applies To:** User

**Acceptance Criteria:**

1. Platform-managed users and groups may manage only owned operators within the configured ceiling. <!-- @impl: src/lib/access.ts::canManageOperator --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.withinManagementCeiling --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
2. Invocation is a separate grant; managers do not gain another user's activities and invokers cannot mutate management state. <!-- @impl: src/lib/access.ts::canInvokeOperator --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.getOwnedActivity --> <!-- @impl: src/routes/operator-management.ts::managed --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
3. Live verified identity controls authorization; absent memberships grant no group authority, while malformed identity, revocation, expiry and resolver failures deny access. <!-- @impl: src/lib/access.ts::resolveOperatorGroupIdentity --> <!-- @impl: src/lib/access.ts::operatorAccessSessionCurrent --> <!-- @impl: src/routes/operator-management.ts::managementContext --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-045/047: current Access identity gates Dispatcher GET source receipts) -->
4. Identity choices contain configured users and currently verified issuer-bound groups, not unresolved labels or a full directory for non-admin managers. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @test: src/__tests__/operators/operator-access.test.ts (projects only verified configured identity options and authorized limits to eligible managers, not Access credentials) -->
5. Grant edits retain saved identities absent from current choices until deliberately removed. Unavailable choices disable saves; an explicit stale-state refresh reloads choices. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (keeps saved identities absent from this session’s choices through unrelated grant edits and allows deliberate removal) --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (disables permission saves when identity choices are unavailable) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (reloads configured identity choices during explicit stale-state reconciliation) -->
6. Scoped capability edits require an exact revision and remain within Environment ceilings; invalid values deny rather than clamp. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @impl: src/operators/registry.ts::OperatorRegistry.setManagementCapabilities --> <!-- @test: src/__tests__/operators/operator-access.test.ts (edits operator capabilities within Environment limits and disables current runs without changing pins or installation restrictions) -->
7. A read-only invocation preview exposes only an authorized invoker's pinned package name, version and guided-form eligibility, without management access or Activity preparation. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (previews only an enabled, authorized pinned Renovate Dispatcher without creating an Activity or exposing credentials) -->

**Notes:** Evidence history and acceptance limitations remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Constraints:**

- Request bodies cannot grant global eligibility or execution identity.
- Absence of membership assertions cannot authorize group-only grants.

- Missing `sourceResponseBytes` means 65536 bytes; installation allowance ≤ operator allowance ≤ Environment ceiling, without inherited increases.
- Capability edits disable enabled installations while preserving pins, scope, grants and saved policies; out-of-ceiling policies cannot be enabled or admitted.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-013](operators.md#req-operator-013-enterprise-operator-administration-authorization), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Access/management and real identity/source regression passed host CI; live sourceHTTP200 was observed in47aa5357. Configurable response-ceiling tests and complete live acceptance remain pending.

**Status:** Implemented

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

1. The parent normalizes admitted input and resources; caller-supplied authority, code, profiles or connections cannot widen eligibility. <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
2. Generation, expiry, cancellation and installation policy gate every protected effect. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Protected operations recheck the current human and pinned installation/release revisions through parent interceptors; captured identity and workflow claims cannot substitute. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-045/047: current Access identity gates Dispatcher GET source receipts) -->
4. Identical operations reconcile; changed immutable arguments conflict; uncertain effects cannot replay or settle successfully. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
5. Completed output is bounded and durable before delivery; unknown completion remains fenced. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
6. Independent task sessions receive finite parent-approved input references and resources without shared principal authority or credentials. <!-- @impl: src/operators/session-initialization.ts::parseOperatorPiInitialization --> <!-- @impl: host/src/operator-pi-isolated.ts::createIsolatedPiTools --> <!-- @impl: host/src/operator-pi-isolated-runner.ts::runApprovedTasks --> <!-- @test: src/__tests__/operators/session-initialization.test.ts (REQ-OPERATOR-021: finite parent-approved Pi initialization) --> <!-- @test: host/__tests__/operator-pi-review.test.js (REQ-OPERATOR-021: Review composition exposes only fixed sandboxed read and write tools) --> <!-- @test: host/__tests__/operator-pi-isolated.test.js (REQ-OPERATOR-021: each SDK child sees only its declared inputs and can stage one immutable bounded output) --> <!-- @test: host/__tests__/operator-pi-isolated-runner.test.js (REQ-OPERATOR-021: one structured task creates independently isolated SDK sessions and durable identities) -->

**Notes:** Evidence history and acceptance limitations remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Constraints:** Profile admission can only narrow verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-003](operators.md#req-operator-003-principal-bound-activity-context), [REQ-OPERATOR-043](#req-operator-043-catalog-and-installations)

**Verification:** Prior admission/production-composition and real Access-helper/source tests passed CI36852325679attempt2 at51f976d3. Configurable source allowance and larger real journal/cache/native proof await this correction's integrated CI. Live settlement/collection, authenticated selected effects, SDK release and physical cleanup remain separate unverified gates.

**Status:** Implemented

---

### REQ-OPERATOR-048: Dispatcher execution

**Intent:** Dispatcher runs directed work under bounded Dynamic Worker authority without a session or container.

**Applies To:** User

**Acceptance Criteria:**

1. The delegated Loader executes only the pinned generated Flue artifact. <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-015: Worker Loader runtime boundary) -->
2. One durable lease retains its original generation, submission, input, release and human expiry; uncertain admission cannot create replacement work. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Pending settlement keeps at most one bounded recheck under the original lease; observation and repeated alarms cannot renew authority. <!-- @impl: src/operators/runtime.ts::driveDispatcherRuntime --> <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: repeated SDK alarms retain one pending recheck and the original deadline) -->
4. Only the exact completed settlement with one bounded assessment and no unresolved operation permits terminal collection; collection does not resubmit. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (fences a completed model turn with no submitted assessment instead of advertising waiting) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (completes a publishable second-turn assessment only after all parallel research receipts are released) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (settles a cited second-turn assessment after the former child timeout without extending human authority) -->
5. Cancellation, expiry, revocation and stale warmed callers deny protected work. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
6. Dispatcher capabilities include only approved parent transport, inference, scheduling and non-authorizing diagnostics; sessions, containers, credentials and direct networking remain unavailable. <!-- @impl: src/operators/distribution.ts::parseDispatcherBundle --> <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @impl: src/operators/activity.ts::OperatorDispatcherCapability --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-048: production Dispatcher bundle boundary) --> <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048: production Dispatcher Loader host) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
7. Existing Activity identity, storage, Gate 1 and default-entrypoint compatibility remain preserved. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018) -->

**Notes:** Evidence history and acceptance limitations remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Constraints:** Uncertain external effects are fenced, not replayed; execution cannot outlive verified human authority.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-015](operators.md#req-operator-015-isolated-approved-worker-loading), [REQ-OPERATOR-017](operators.md#req-operator-017-durable-drive-generations), [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission)

**Verification:** Production-composition tests are instrumented rather than native. The existing native Loader fixture proves generated-artifact compatibility, not production eviction and alarm composition; exact-head CI and that native composition proof remain outstanding.

**Status:** Planned

---

### REQ-OPERATOR-049: Operators management interface

**Intent:** Authorized people manage and invoke operators from a separate responsive product area.

**Applies To:** User

**Acceptance Criteria:**

1. Operator management routes enforce management authorization independently of Administration navigation. <!-- @impl: src/routes/operator-management.ts::managementContext --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-049 AC1: management route denies self-nominated users outside global eligibility) -->
2. Catalog, registration, promotion, installation, grants and activity states expose no stored secrets. <!-- @impl: src/routes/operator-management.ts::presentInstallation --> <!-- @impl: src/operators/registry.ts::managementProjection --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-049 AC2: management registration, detail and catalog never return the stored GitHub credential) --> <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-049 AC2: installed release and grant projections do not reveal stored credentials) -->
3. Detail leads with the uniquely enabled installed pin; ambiguous or unavailable pins remain distinguishable rather than borrowing another release. <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (REQ-OPERATOR-049: labels catalog enablement concisely for enabled and disabled operators) --> <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (refreshes verified metadata for an older installed pin without changing its enablement) --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (makes the installed version primary and updates the existing installation without creating another) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (reconciles a created but unpinned installation when %s without a duplicate or automatic enable) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (requires an explicit configuration choice when more than one is enabled) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (distinguishes an installed pin with unavailable release details from no installation) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (shows verified tag and publication time on installed and selectable versions while labelling legacy records honestly) --> <!-- @test: src/__tests__/operators/operator-catalog.test.ts (projects the uniquely enabled pinned version rather than an arbitrary other release for multiple installations) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (presents the authored name, category and verified installed version in the catalog instead of an opaque release number) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (does not pretend an unverified installed version is a release number) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (offers each alternative version once with its description and publication date beside the choice) -->
4. Search filters as the person types without submission; stale responses cannot replace newer results. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @impl: web-ui/src/api/operator-management.ts::listManagedOperators --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (presents first-party display names without replacing verified package identity or collapsing release details into status) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (does not assign the first-party name to a third-party Dispatcher or a mismatched repository identity) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (reveals Search beside Register, filters as the person types, and clears on close without a submit) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (ignores late search responses when a newer search has already resolved) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (separates verified package identity from the category and keeps source replacement out of restrictions) -->
5. Operator ceilings remain editable separately from installation restrictions; changes disable installations without discarding saved policies. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (separates verified package identity from the category and keeps source replacement out of restrictions) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (edits the operator capability ceiling after registration without silently editing an installation or keeping it enabled) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-redesign.test.tsx (keeps saved missing grants, distinguishes unverified choices and shows local save feedback) --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (explains global action limits and scope labels without raw capability keys or suggesting that an ID provisions resources) -->
6. Responsive controls retain focus and scrolling for long names and errors. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (retains the registration control and visible long error on a narrow viewport) --> <!-- @manual: Verify keyboard focus and scrolling on narrow and wide browser viewports. -->
7. Mobile sections remain horizontal and retain save feedback beside the action without silently enabling installations. <!-- @impl: web-ui/src/components/OperatorManagement.tsx::OperatorManagement --> <!-- @test: web-ui/src/__tests__/operators/operator-management-flow.test.tsx (confirms a restriction save beside its action without silently enabling the installation) -->

**Constraints:** The management surface cannot grant authority beyond server-side policy.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-045](#req-operator-045-delegated-management-and-invocation), [REQ-OPERATOR-046](#req-operator-046-explicit-release-promotion)

**Verification:** The remaining management criteria have current route and UI test anchors and were present in the earlier CI-proven management surface. Catalog Enabled/Disabled copy passed exact-head PR Checks `36497242563` at `5eaae7d470a4123fee0e0259bb702cadb61b3464` (frontend shard-3, Typecheck, aggregate). The guided-launcher acceptance still pending is owned by REQ-OPERATOR-058; Enterprise Integration responsive visual acceptance remains a separate release gate.

**Status:** Implemented

---

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

### REQ-OPERATOR-061: Prospective admin-session Renovate scan

**Intent:** An explicitly activated, session-owned hourly scan admits only new, verified Komodo Renovate PRs; the Dispatcher remains read-only and the separately fenced publisher retains all write authority.

**Applies To:** Admin

**Acceptance Criteria:**

1. Explicit current owner-admin activation binds the selected installation and active session generation to an immutable server cutoff. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-061: only a current authorized admin session can activate an immutable server-timed Komodo scan) --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (REQ-OPERATOR-061: durable prospective activation and admission) -->
2. Hourly observation admits only verified open Renovate PRs created after cutoff, including offline arrivals; complete pages are mandatory and uncertain observations skip admission. <!-- @impl: src/container/index.ts::container --> <!-- @impl: src/operators/renovate-prospective.ts::listProspectiveRenovatePrs --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061: an armed admin-session callback scans complete post-cutoff Komodo pages) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061: a lost scheduler acknowledgement is reconciled without creating another hourly callback) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061: a winning scan reconciles lost start and publishes a simulated result from one real Activity) -->
3. Current human, grant, installation and session authority gate durable admission. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @impl: src/container/index.ts::container --> <!-- @impl: src/operators/operator-runtime-capability.ts::authorizeDispatcherPlan --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (REQ-OPERATOR-061: durable prospective activation and admission) --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (fences Activity-bound read/inference authority) -->
4. Prospective publication requires exact admission proof and all fresh publisher gates; alarms and children cannot approve or merge independently. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @impl: src/operators/renovate-publication.ts::renovateGithub --> <!-- @test: src/__tests__/operators/renovate-publisher.test.ts (REQ-OPERATOR-061: prospective publication is tied to a fresh exact Registry admission and current owner session) -->

5. Failed scheduling acknowledgement cannot report successful activation; retry preserves the original cutoff. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061: a lost scheduler acknowledgement is reconciled without creating another hourly callback) -->
6. Concurrent valid actors elect one stable Activity/actor/session/generation identity. <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/renovate-prospective-registry.test.ts (REQ-OPERATOR-061: durable prospective activation and admission) -->
7. Uncertain preparation/starts reconcile that same identity without replacement work or a changed actor. <!-- @impl: src/container/index.ts::container --> <!-- @test: src/__tests__/container/index.test.ts (REQ-OPERATOR-061: a winning scan reconciles lost start and publishes a simulated result from one real Activity) -->

**Constraints:** Authority remains owner/session-bound; uncertain effects cannot replay.

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-051](#req-operator-051-renovate-dispatcher-assessment), [REQ-OPERATOR-060](#req-operator-060-fenced-renovate-publication)

**Verification:** Exact-head PR Checks `36490796134` at `188aee1162326fe817dfa11e745cf32e9dbdb500` passed Typecheck, backend Container, Registry, publisher and route shards, and the aggregate gate after test-only RED run `36485684846` failed on absent behavior. Tests exercise authenticated activation, concurrent durable admission, the scheduled callback contract with simulated SDK delivery, lost scheduling/start responses, an unchanged uncertain Activity, the real Activity collector on a synthetic settled-waiting snapshot, Activity-bound read/inference revocation and restricted publication. The connected fixture substitutes the child settlement and does not run a compiled Dispatcher, prove model judgment, activate scanning or demonstrate a naturally arriving post-activation Komodo PR; those remain separate acceptance boundaries.

**Status:** Implemented

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

1. Only Enterprise mode selects Operator Review; non-enterprise and confirmed local review remain unchanged. <!-- @impl: preseed/agents/pi/extensions/operator-review-selector.ts::selectOperatorReviewApplicability --> <!-- @impl: preseed/agents/pi/extensions/operator-review-selector.ts::registerOperatorReviewSelector --> <!-- @test: src/__tests__/lib/operator-review-selector.test.ts (REQ-OPERATOR-053 AC1: non-enterprise boundaries keep local Review) --> <!-- @test: src/__tests__/lib/operator-review-selector.test.ts (retains unchanged local behavior only for confirmed absence or inactive enrollment) --> <!-- @test: preseed/agents/pi/test/enterprise-routing.test.mjs (REQ-OPERATOR-053: Pi loads only the selector, not the separately auto-discovered local Review extension) -->
2. Preparation binds one visible reservation to the verified human, installation, exact PR revision, trusted Action and eligible inference/resource scope. <!-- @impl: src/github-interceptor.ts::GitHubInterceptor --> <!-- @impl: src/operators/review-boundary-preparation.ts::prepareVerifiedBoundary --> <!-- @impl: src/operators/registry.ts::OperatorRegistry --> <!-- @test: src/__tests__/operators/review-boundary-egress.test.ts (REQ-OPERATOR-053: authenticated Git push prepares exactly one visible boundary reservation) --> <!-- @test: src/__tests__/operators/review-boundary-reservation.test.ts (REQ-OPERATOR-053: exact-context preparation is one durable Registry reservation) --> <!-- @test: src/__tests__/operators/conductor-production-inference.test.ts (REQ-OPERATOR-053: a provider-default inference route admits a scoped Conductor session without a reasoning grade) -->
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

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission), [REQ-OPERATOR-050](#req-operator-050-generic-conductor-capability), [REQ-OPERATOR-029](operators.md#req-operator-029-capability-authenticated-webhook-edge)

**Verification:** Dedicated-extension test-only RED at `3a561549` failed the expected missing selector/consumer and published-read cases in `36447403897`. The first GREEN candidate `b6133eb0` failed exact-head Test `36452540739`: three new suites were erroneously assigned to the Worker rather than Node lane, backend Typecheck and two Host checks failed. The original local-only Review source is restored from the verified `f588867d^` blob; the dedicated selector and published-result consumer passed full exact-head Test `36457559457` at `65d1512409449b5e18a31ad36ba0dff17eafc597`. The finding-linked rejection test-only RED `2981b57c` failed its intended cases in Test `36461468216`, with a separate test typing error also observed. The first candidate `1cfde761` failed Test `36465802906` on generated seed drift, a TypeScript option and stale compiled-fixture fields. Corrected `73ec5e570f0d29c5955698cb24c53d2a202c199e` passed full exact-head Test `36467129972`, including compiled Conductor native fixture, generated-seed guard, Typecheck, Host and backend tests; this remains dormant evidence, not installed Action proof. None of these checks establishes runtime activation or an end-to-end live receipt. Generation-fenced webhook continuation passed exact-head Codeflare PR Checks at `c4b0cbc9` (run `35855161432`). The Conductor collector's scoped tests passed at `60257e1` (run `35857563056`), while that package workflow remained red for absent Action/publisher modules. Authenticated preparation and Pi remote selection passed exact-head PR Checks at `96d136a0` (run `35892316489`); the Action claim RED suite ran at `e4cbc923` (run `35896387844`) and its automated claim/Stop behavior passed exact-head PR Checks at `6812f243` (run `35903787791`). Earlier preparation checks `35890471868` and `35891520587` failed; the historical local Pi path carries bounded untrusted triage excerpts when a completed prior local round exists, otherwise explicitly reports unavailable evidence. The new dedicated remote path separately requires authenticated publisher readback, and neither an untrusted excerpt nor the precommit lifecycle checks establish clearance or an Action-redeemable handoff. Protected Action installer behavior had test-only RED at `00a213b5`; dormant proposal, pinned reusable-runtime validation and inactive protected-base trust passed exact-head Codeflare Test `36467842514` at `ef28440738b0ff095f697f072b8f60290dab7e48`. A real target-repository workflow installation, sandbox claim, independent publication, compiled production-owner execution and current-head Enterprise Integration proof remain pending.

**Status:** Planned

---

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

### REQ-OPERATOR-062: Repository-only Dispatcher transport

**Intent:** Bounded package-selected transport reuses existing parent authority.

**Applies To:** User

**Acceptance Criteria:**

1. Approved repository-only packages select bounded GET/POST/PUT requests with immutable arguments. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (exposes the configured API origin only to repository-only Loader code) -->
2. Unknown mutations retain generation for authorized readbacks; only verified original-request and completed-read receipts may resolve uncertainty without replay. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047: generic Activity mutation receipts and resolution) -->
3. Loader supplies only validated non-secret origins and response limits; package settings cannot widen host policy or disclose credentials. <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @impl: src/operators/dispatcher-source-limits.ts::sourceResponseBytes --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (exposes the configured API origin only to repository-only Loader code) --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-047: rejects a 100 KiB source under the default allowance) --> <!-- @test: src/__tests__/operators/dispatcher-source-identity.test.ts (REQ-OPERATOR-047: returns the exact large source envelope under approved 128 KiB) -->
4. Mutations use only the configured authenticated GitHub API transport. <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (exposes the configured API origin only to repository-only Loader code) -->

**Constraints:**

- Existing parent authority and original deadlines remain mandatory; no activation or new principal is implied.
- Detailed preserved wire and fencing clauses remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-047](#req-operator-047-generic-directed-profile-admission)

**Verification:** Automated test: [dispatcher-production.test.ts](../../src/__tests__/operators/dispatcher-production.test.ts), [dispatcher-source-identity.test.ts](../../src/__tests__/operators/dispatcher-source-identity.test.ts).

**Status:** Implemented

---

### REQ-OPERATOR-063: Bounded Dispatcher diagnostics

**Intent:** Diagnostics explain observed rejection boundaries without becoming authority.

**Applies To:** User

**Acceptance Criteria:**

1. Parent rejection diagnostics distinguish local fencing from observed upstream status without logging credentials, prompts, bodies or arbitrary child values. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherOperation --> <!-- @impl: src/operators/operator-runtime-capability.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048: emits bounded) -->
2. Failed settlement telemetry uses trusted Activity/generation and recognized fixed operation classes; foreign or malformed submission labels remain unknown. <!-- @impl: src/operators/activity.ts::OperatorActivity.reconcileDispatcherLease --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: diagnoses) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (REQ-OPERATOR-048: failed compiled durable direct submission carries its bounded Flue operation label) -->
3. Tail delivery accepts only allowlisted bounded child diagnostics and never establishes settlement, replay authority or a prior failure cause. <!-- @impl: src/operators/activity.ts::OperatorDispatcherTail --> <!-- @test: src/__tests__/operators/dispatcher-tail.test.ts (forwards only fixed warning codes with trusted Activity correlation) --> <!-- @test: src/__tests__/operators/dispatcher-tail.test.ts (drops arbitrary child logs, exceptions, extra fields and sensitive body text) --> <!-- @test: src/__tests__/operators/dispatcher-tail.test.ts (bounds work and forwarding even when a child floods valid-looking events) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (captures only sanitized child warnings through an actual Loader Tail Worker) -->
4. The Dispatcher-only diagnostic operation validates exact request shape, size and deadline, correlates trusted identity and rate-limits reports. <!-- @impl: src/operators/activity.ts::readDispatcherDiagnostic --> <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherDiagnosticReport --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report denies wrong route, method, content-type, syntax, byte size and stale generation) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report refuses an unfinished body without holding the Activity) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report caps concurrent valid reports at eight per live Activity generation) -->
5. Diagnostic transport failure is bounded and best-effort; reports cannot renew authority, mutate lifecycle, publish results or replace the original inference failure. <!-- @impl: src/operators/activity.ts::OperatorActivity.dispatcherDiagnosticReport --> <!-- @impl: src/operators/activity.ts::OperatorDispatcherCapability --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report uses trusted Activity/generation and leaves execution running) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report tolerates unavailable owner logging without publishing a result) --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-048: bounded diagnostic report never extends its original human deadline) --> <!-- @test: src/__tests__/operators/fixtures/flue-native-cases.ts (REQ-OPERATOR-048: compiled diagnostic report) -->

**Constraints:**

- Existing parent authority and original deadlines remain mandatory; no activation or new principal is implied.
- Detailed preserved wire and fencing clauses remain in [Operator Interface](../../documentation/lanes/operators.md#preserved-contract-details).

**Priority:** P0

**Dependencies:** [REQ-OPERATOR-048](#req-operator-048-dispatcher-execution)

**Verification:** Automated test: [dispatcher-production.test.ts](../../src/__tests__/operators/dispatcher-production.test.ts), [flue-native-cases.ts](../../src/__tests__/operators/fixtures/flue-native-cases.ts), [dispatcher-native.test.ts](../../src/__tests__/operators/dispatcher-native.test.ts), [dispatcher-tail.test.ts](../../src/__tests__/operators/dispatcher-tail.test.ts).

**Status:** Implemented

---

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

---

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

### REQ-OPERATOR-069: Owner summary metadata recovery

**Intent:** Historical summaries recover only trusted owner display metadata.

**Applies To:** User

**Acceptance Criteria:**

1. A five-entry owner page may recover missing pinned display metadata from the same owner's Activity without reading result bytes or changing history, status or cursors. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: recovers missing historical display metadata on the owner page without exposing result bytes) -->
2. Unavailable, mismatched or contradictory projections cannot supply substitute names or overwrite existing metadata. <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @test: src/__tests__/routes/operator-activities.test.ts (REQ-OPERATOR-027: preserves indexed status and existing metadata; ignores unavailable or mismatched Activity projections) -->

**Constraints:** Recovery cannot broaden owner access or mutate execution state.

**Priority:** P1

**Dependencies:** [REQ-OPERATOR-027](operators.md#req-operator-027-owned-activity-user-surface)

**Verification:** Automated test: [operator-activities.test.ts](../../src/__tests__/routes/operator-activities.test.ts).

**Status:** Implemented

---

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

---
