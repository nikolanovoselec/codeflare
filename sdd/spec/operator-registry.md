# Operator Registry

This release extends the existing Operator foundation with GitHub package installation, delegated Operator Management, and generic directed profiles. Codeflare owns the generic Operator Interface, Loader, lifecycle, resources, sessions, synchronization, GitHub and inference boundaries, and publication fencing. Conductor owns Review packet preparation, session orchestration, result collection, history reconciliation, and publication behavior. Codeflare retains generic host-side Pi sandbox and security confinement and distributes Conductor Review Pi extensions, skills, and references for configuring per-repository GitHub Actions. Existing endpoint registrations, Gate 1, human sessions, local review behavior, and Dispatcher code remain unchanged.

## REQ-OPERATOR-043: Catalog and installations

**Intent:** Authorized users can discover only accessible operators and independently configured installations.

**Acceptance Criteria:**
1. Operators, immutable releases and named installations have separate stable identities. <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
2. The server filters catalog search and cursor pages by authorization before returning data; default page size is 50 and maximum is 100. <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->
3. A release/configuration change in one installation does not change another installation. <!-- @test: src/__tests__/operators/operator-catalog.test.ts (REQ-OPERATOR-043) -->

**Status:** Planned

## REQ-OPERATOR-044: GitHub immutable package acquisition

**Intent:** Codeflare installs only exact approved GitHub release assets.

**Acceptance Criteria:**
1. Registration resolves a canonical GitHub repository identity and protects its acquisition-only PAT. <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
2. Promotion accepts only bounded immutable assets with matching repository, approved workflow provenance and digest. <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->
3. Unsafe URLs/redirects, provenance/digest/schema mismatches and unavailable bytes fail without credential disclosure or enablement. <!-- @test: src/__tests__/operators/github-release-source.test.ts (REQ-OPERATOR-044) -->

**Status:** Planned

## REQ-OPERATOR-045: Delegated management and invocation

**Intent:** Operator management and invocation have separately enforced access.

**Acceptance Criteria:**
1. Platform-managed users/groups may manage only owned operators within the configured ceiling. <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
2. Invocation is a separate grant; managers do not gain another user's activities and invokers cannot mutate management state. <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->
3. Stable verified group membership, revocation and resolver failure are enforced server-side. <!-- @test: src/__tests__/operators/operator-access.test.ts (REQ-OPERATOR-045) -->

**Status:** Planned

## REQ-OPERATOR-046: Explicit release promotion

**Intent:** Discovery, approval, enablement and rollback are separate revision-safe operations.

**Acceptance Criteria:**
1. Discovery never approves or enables; approval never enables. <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->
2. Mutations require the current revision and persist exact approved release/configuration bytes. <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->
3. Source/trust change disables subsequent starts and a retained approved release can be selected for rollback. <!-- @test: src/__tests__/operators/operator-promotion.test.ts (REQ-OPERATOR-046) -->

**Status:** Planned

## REQ-OPERATOR-047: Generic directed profile admission

**Intent:** Installed profiles run only under the parent-selected human, resource scope and current activity authority.

**Acceptance Criteria:**
1. The parent normalizes and digests input, selects the profile/resources and rejects caller authority/resource substitution. <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
2. Generation, expiry, cancellation and installation policy are checked before protected effects. Dispatcher primitives re-open the current human and exact installation/release revisions before forwarding through the existing parent GitHub/LLM interceptors. <!-- @impl: src/operators/gate1-production.ts::createDispatcherOperation --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
3. Repeated identical operations reconcile; changed input conflicts; uncertain effects are not replayed. Dispatcher reserves an Activity-owned operation record before forwarding, persists bounded completed output before delivery, and fences unknown completion. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) --> <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->

**Status:** Planned

## REQ-OPERATOR-048: Dispatcher execution

**Intent:** Dispatcher runs real Flue work under Dynamic Worker authority without a session/container.

**Acceptance Criteria:**
1. Native Worker tests execute the actual pinned generated Flue class in an activity-private facet, including delegated SDK alarms/fiber recovery, isolated SQLite for two activities and bounded continuation after native eviction. Mock capability responses do not establish native proof. <!-- @test: src/__tests__/operators/loader-runtime.test.ts (REQ-OPERATOR-048/051: pinned generated Flue in native workerd) -->
2. One durable execution lease remains bound to its original generation/submission/input/release and expiry across asynchronous admission. HTTP completion and status polling neither create a waiting checkpoint nor renew authority. Explicit continuation requires safe quiescence. The managed Dispatcher driver calls the existing drive reservation once, then admits the exact pinned bundle to the fixed facet; only exact completed settlement with no outstanding/unknown operation can commit waiting. Uncertain admission, failed settlement and the non-renewing 30-second/authority deadline fence the original generation. <!-- @impl: src/operators/runtime.ts::driveDispatcherRuntime --> <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
3. Cancellation/expiry/revocation and stale warmed callers deny subsequent protected work. Completed operations reconcile by stable ID/digest; uncertain accepted effects are not replayed. Flue's recovery does not itself establish exactly-once external effects. Cancellation commits the existing drive fence before signaling the exact facet's Flue abort route. Constructor recovery and SDK alarm reconciliation reuse, rather than replace, the durable lease. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) -->
4. Dispatcher runs its own Flue model/tool loop using only restricted parent read/inference primitives. It cannot create/access a session/container, obtain credentials or supervisor storage/stubs, select another facet, schedule arbitrary parent callbacks, or bypass parent egress. <!-- @impl: src/operators/distribution.ts::parseDispatcherBundle --> <!-- @impl: src/operators/loader.ts::loadOperatorDispatcherClass --> <!-- @test: src/__tests__/operators/distribution.test.ts (REQ-OPERATOR-048: production Dispatcher bundle boundary) --> <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048: production Dispatcher Loader host) -->
5. Existing OperatorActivity identity/storage and Gate 1/default-entrypoint behavior remain compatible. Reuse SDK scheduling in that owner; no second namespace, per-operator migration, copied scheduler or Codeflare-wide Vite conversion. Only a managed admission receipt whose profile is Dispatcher selects the new driver; legacy and managed default-entrypoint paths remain unchanged. <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity --> <!-- @test: src/__tests__/operators/dispatcher-production.test.ts (REQ-OPERATOR-047/048) --> <!-- @test: src/__tests__/operators/orchestrator.test.ts (REQ-OPERATOR-018) -->

**Verification gate:** Production now composes the pinned Agent owner, activity-private generated-class facet, exact lease reconciliation and restricted interceptor-backed capability. The new `dispatcher-production.test.ts` suite exercises that composition with instrumented child/interceptor transports; it is not native Flue proof and has not been run in this syntax-only implementation batch. The existing `loader-runtime.test.ts` executes the real profile-built artifact in its separate native compatibility fixture, not this production composition. Exact-head behavioral/type CI and production-composition native eviction/alarm proof remain required; this requirement therefore remains Planned, not verified Implemented.

**Status:** Planned

## REQ-OPERATOR-049: Operators management interface

**Intent:** Authorized people manage and invoke operators from a separate responsive product area.

**Acceptance Criteria:**
1. `/operators` and `/api/operator-management/*` enforce management authorization independently of Administration navigation. <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
2. Catalog, registration, promotion, installation, grants and activity states expose no stored secrets. <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
3. Desktop, tablet and mobile retain usable controls, focus and scrolling for long names and errors. <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->

**Status:** Planned

## REQ-OPERATOR-051: Renovate Dispatcher assessment

**Intent:** A directed Dispatcher performs bounded read-only Renovate PR/CI assessment.

**Acceptance Criteria:**
1. Only the authorized repository, approved Renovate bot and bounded PR/check/diff inputs are read. <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->
2. Recommendations bind exact observed heads and make stale, truncated, rate-limited or insufficient evidence explicit. <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->
3. The parent denies repository mutation, session/container creation and unattended reruns. <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->

**Status:** Planned
