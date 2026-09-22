# Operator Registry

This release extends the existing Operator foundation with GitHub package installation, delegated Operator Management, generic directed profiles, and the Review and Renovate proofs of concept. It preserves existing endpoint registrations, Gate 1, human sessions and local review behavior.

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
2. Generation, expiry, cancellation and installation policy are checked before protected effects. <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->
3. Repeated identical operations reconcile; changed input conflicts; uncertain effects are not replayed. <!-- @test: src/__tests__/operators/generic-profile-admission.test.ts (REQ-OPERATOR-047) -->

**Status:** Planned

## REQ-OPERATOR-048: Dispatcher execution

**Intent:** Dispatcher runs real Flue work under Dynamic Worker authority without a session/container.

**Acceptance Criteria:**
1. Native Worker tests prove approved Flue code, activity-private durable state and bounded continuation across isolate restart. <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048) -->
2. Cancellation/expiry deny subsequent protected work and completed operations are not repeated. <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048) -->
3. Dispatcher cannot create or access a session/container or bypass parent egress/credential policy. <!-- @test: src/__tests__/operators/dispatcher-native.test.ts (REQ-OPERATOR-048) -->

**Status:** Planned

## REQ-OPERATOR-049: Operators management interface

**Intent:** Authorized people manage and invoke operators from a separate responsive product area.

**Acceptance Criteria:**
1. `/operators` and `/api/operator-management/*` enforce management authorization independently of Administration navigation. <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
2. Catalog, registration, promotion, installation, grants and activity states expose no stored secrets. <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->
3. Desktop, tablet and mobile retain usable controls, focus and scrolling for long names and errors. <!-- @test: web-ui/src/__tests__/operators/operator-management.test.tsx (REQ-OPERATOR-049) -->

**Status:** Planned

## REQ-OPERATOR-050: Review Conductor integration

**Intent:** Directed remote Review uses trusted evidence/resources and GitHub-authoritative history without weakening existing local review.

**Acceptance Criteria:**
1. Canonical packet/evidence, required lanes, approved parent/child resources and independently verified output are required for a complete round. <!-- @test: src/__tests__/operators/review-conductor.test.ts (REQ-OPERATOR-050) -->
2. Stale/partial rounds cannot clear findings; authorized rebuttals and unresolved findings remain correlated with exact repository/revision context. <!-- @test: src/__tests__/operators/review-conductor.test.ts (REQ-OPERATOR-050) -->
3. Publisher credentials remain outside candidate/reviewer execution; stale publication cannot clear a newer generation; remote failure has no automatic local fallback. <!-- @test: src/__tests__/operators/review-conductor.test.ts (REQ-OPERATOR-050) -->

**Status:** Planned

## REQ-OPERATOR-051: Renovate Dispatcher assessment

**Intent:** A directed Dispatcher performs bounded read-only Renovate PR/CI assessment.

**Acceptance Criteria:**
1. Only the authorized repository, approved Renovate bot and bounded PR/check/diff inputs are read. <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->
2. Recommendations bind exact observed heads and make stale, truncated, rate-limited or insufficient evidence explicit. <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->
3. The parent denies repository mutation, session/container creation and unattended reruns. <!-- @test: src/__tests__/operators/renovate-dispatcher.test.ts (REQ-OPERATOR-051) -->

**Status:** Planned
