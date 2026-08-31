# Subscription Domain Specification

Tiers, billing, usage tracking, and quotas.

### Key Concepts

| Concept | Definition |
|---------|-----------|
| Tier | One of 8 subscription levels (`blocked`, `pending`, `free`, `trial`, `standard`, `advanced`, `max`, `unlimited`) that define compute quotas, session limits, storage caps, and feature access |
| BillingStatus | Stripe-sourced state (`active`, `trialing`, `past_due`, `canceled`) that modifies a user's effective tier at read time |
| Effective Tier | The canonical tier after applying billing status rules via `getEffectiveTier()` -- may differ from the stored `subscriptionTier` when payment lapses |
| Timekeeper | A per-user Durable Object that accumulates real-time compute usage from session pings, flushes to KV, and enforces quota limits |
| Trial | A compute-based (not time-based) evaluation period capped by `trialQuotaHours`; Stripe `trial_period_days` sets only the maximum billing window |
| Stripe Checkout | External payment flow where users are redirected to a Stripe-hosted page; webhook events signal completion back to the Worker |

### Out of Scope

- **Per-feature billing** -- All features within a tier are available to all users on that tier. No add-on purchases or feature flags gated by separate payments.
- **Usage-based overage billing** -- Users who exceed quota are stopped, not charged extra. No metered billing or pay-per-minute beyond the tier allowance.

### Domain Dependencies

| Domain | Dependency |
|--------|-----------|
| Authentication | User identity (email, role) from auth middleware; `requireActiveUser` enforces tier-based access |
| Security | Rate limiting on billing endpoints; encryption of billing-related KV data when `ENCRYPTION_KEY` is set |

---

### REQ-SUB-001: Eight-Tier Subscription System

**Intent:** The platform must support a graduated set of subscription tiers that control access levels, compute quotas, session limits, and available features.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly 8 tier IDs exist: `blocked`, `pending`, `free`, `trial`, `standard`, `advanced`, `max`, `unlimited`. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-001 AC1: exactly 8 tier IDs exist with the canonical names) -->
2. Each tier defines a full property set: monthly compute allotment, maximum concurrent sessions, allowed session modes, login permission, monthly price, trial compute cap, storage cap, display name, description, sort order, and a default-tier flag. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription.test.ts (getDefaultTiers / REQ-SUB-001 AC1/AC2 (8 default tiers in canonical order) / REQ-SUB-003 (free tier requires no payment)) -->
3. The platform ships a hardcoded fallback containing the complete 8-tier set so configuration absence never produces an empty tier list. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-001 AC3: getDefaultTiers returns the complete 8-tier hardcoded fallback) -->
4. Tier IDs are stable identifiers; display names may differ (for example, the `standard` tier can display as "Starter"). <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-001 AC1: exactly 8 tier IDs exist with the canonical names) -->

**Constraints:**

- Exactly one tier carries the default-tier flag so users with no recorded tier always resolve deterministically.
- The `blocked` tier denies login.
- The `pending` tier permits login so pending users can reach the subscribe page.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([subscription-req-sub-gaps](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts))

**Status:** Implemented

---

### REQ-SUB-002: Tier Property Definitions

**Intent:** Each tier must define a complete set of properties that drive quota enforcement, session limits, mode gating, and pricing.

**Applies To:** User

**Acceptance Criteria:**

1. An unset monthly compute allotment means unlimited compute. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-002 AC1: unlimited monthlySeconds=null (unlimited)) -->
2. An unset storage cap means unlimited storage. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-002 AC2: unlimited maxStorageBytes=null (unlimited)) -->
3. The allowed session-modes field is a list of mode identifiers drawn from the supported set. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-002 AC3: standard/advanced/max/unlimited sessionModes=[default,advanced]) -->

**Notes:** Concrete per-tier values (hours/month, max sessions, modes, storage, canLogin) are documented in [Subscription Tiers](../../documentation/lanes/billing.md#subscription-tiers).

**Constraints:**

- These are default values; admins can override all operational parameters via the management panel.
- Prices are not hardcoded; they come from Stripe via the admin-configured price ID associated with each tier.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated test ([subscription-req-sub-gaps](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts))

**Status:** Implemented

---

### REQ-SUB-003: Free Tier Requires No Payment

**Intent:** Users must be able to use the platform at the free tier without providing payment information.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe endpoint activates the free tier directly without any payment-provider interaction. <!-- @manual -->
2. The free tier has a zero monthly price. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription.test.ts (getDefaultTiers / REQ-SUB-001 AC1/AC2 (8 default tiers in canonical order) / REQ-SUB-003 (free tier requires no payment)) -->
3. Even when the payment provider is configured, the free tier still bypasses external checkout. <!-- @test: src/__tests__/lib/subscription.test.ts (getDefaultTiers / REQ-SUB-001 AC1/AC2 (8 default tiers in canonical order) / REQ-SUB-003 (free tier requires no payment)) --> <!-- @manual -->
4. Free-tier activation removes all provider-owned billing-state fields while preserving unrelated user fields; persisted records contain no `undefined` patch values. <!-- @impl: src/routes/auth.ts::default --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-18-001/004: payment-less activation removes stale billing state without undefined values) -->

**Constraints:**

- Free-tier auto-sleep is locked to a fixed short timeout; users cannot extend it from the UI.
- Free tier is limited to a single concurrent session.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated test ([subscription](../../src/__tests__/lib/subscription.test.ts))

**Status:** Implemented

---

### REQ-SUB-004: Paid Tiers Integrate with Stripe Checkout

**Intent:** Paid tiers (standard, advanced, max) must collect payment via Stripe before activating the subscription.

**Applies To:** User

**Acceptance Criteria:**

1. When the payment provider is configured, the direct-subscribe endpoint rejects paid tiers with a clear "checkout required" error; only the free tier remains directly subscribable. <!-- @impl: src/routes/auth.ts::isStripeConfigured --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (POST /auth/subscribe) -->
2. The checkout endpoint creates a hosted checkout session pre-populated with the visitor's email and the tier/mode metadata, and returns the externally-hosted checkout URL. <!-- @impl: src/lib/stripe.ts::createCheckoutSession --> <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/checkout / REQ-SUB-020 (multi-currency pricing from CF-IPCountry) / REQ-SUB-004 (Stripe checkout session creation)) -->
3. After payment, the provider sends a checkout-completed webhook that records the checkout outcome and triggers an authoritative state sync. <!-- @impl: src/routes/stripe-webhook.ts::handleCheckoutCompleted --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->
4. The frontend polls the auth-status endpoint after the checkout redirect on a fixed interval with no bounded total wait (the poll has no deadline and continues until activation is observed) so subscription activation feels immediate to the user. <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SUB-004 AC4: post-checkout activation polling) --> <!-- @manual -->
5. The webhook handler covers the three relevant lifecycle events: checkout completion, subscription update, and subscription deletion. <!-- @test: src/__tests__/routes/billing.test.ts (POST /public/stripe/webhook) --> <!-- @manual -->
6. The webhook endpoint is publicly reachable but enforces signed-payload verification with a short timestamp tolerance. <!-- @impl: src/lib/stripe.ts::verifyWebhookSignature --> <!-- @test: src/__tests__/lib/stripe.test.ts (rejects missing timestamp) -->
7. Webhook events are de-duplicated by event identifier with a multi-day retention window so replayed events do not double-apply. <!-- @test: src/__tests__/routes/billing.test.ts (POST /public/stripe/webhook) --> <!-- @manual -->

**Constraints:**

- Tier and mode metadata must be present on the payment-provider price objects before deploy; the system reads metadata, not separate configuration.
- Tiers without a configured external price are hidden from the subscribe page.
- The customer-to-email mapping is recorded on checkout completion so subsequent webhooks can resolve the user.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-003](#req-sub-003-free-tier-requires-no-payment)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-005: Trial Is Compute-Based, Not Time-Based

**Intent:** Trial periods must be capped by actual compute usage, not calendar days, so that inactive users do not burn through their trial.

**Applies To:** User

**Acceptance Criteria:**

1. Each paid tier has an admin-configurable trial compute cap. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription.test.ts (getDefaultTiers / REQ-SUB-001 AC1/AC2 (8 default tiers in canonical order) / REQ-SUB-003 (free tier requires no payment)) -->
2. Subscriptions are created with a maximum billing window so the trial cannot exceed a hard calendar limit even if the user never uses any compute. <!-- @impl: src/lib/stripe.ts::createCheckoutSession --> <!-- @test: src/__tests__/lib/stripe.test.ts (includes trial_period_days when trialDays is set) -->
3. Timekeeper enforces the trial compute cap as the active quota while the subscription is in trial state. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
4. When the trial compute cap is consumed, Timekeeper ends the trial early at the payment provider, triggering the first real charge. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
5. If the first charge succeeds, the full monthly compute quota unlocks. If payment produces `past_due`, paid access remains through a valid future `billingPeriodEnd`; an absent, invalid, or expired period end downgrades to free. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (past_due + future billingPeriodEnd keeps paid tier (grace period)) --> <!-- @test: src/__tests__/lib/subscription.test.ts (past_due + expired billingPeriodEnd downgrades to free) -->
6. A trial-used marker is recorded when the subscription transitions out of trial state so users cannot loop subscribe-cancel-resubscribe to obtain unlimited free trials. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState) -->

**Constraints:**

- Early trial termination is gated by an idempotency flag so the per-session ping cycle cannot issue duplicate provider calls.
- The webhook stale-write guard uses strict timestamp ordering so events sharing the same second are not silently discarded.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/admin-tiers.test.ts))

**Status:** Implemented

---

### REQ-SUB-006: Real-Time Usage Tracking via Timekeeper DO

**Intent:** Compute usage must be tracked accurately in real time so every user can monitor personal consumption and billed deployments can enforce current quotas.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly one Timekeeper Durable Object instance exists per user. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
2. Container DOs ping their user's Timekeeper with a monotonic per-session total on a short fixed cadence in every deployment mode. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SUB-006 AC2 + REQ-SUB-007 AC5: records usage outside SaaS without enforcing a quota response) -->
3. Timekeeper computes per-session deltas, accumulates pending usage in memory, and periodically flushes it to durable storage. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
4. Timekeeper exposes a usage-read interface that returns flushed-plus-pending totals for live consumption. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
5. The durable record tracks rolling daily, weekly, monthly, yearly, and all-time totals with automatic rollovers. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
6. The flush handler retries on durable-storage write failure on a fixed 30-second interval (not exponential backoff). <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
7. Pending usage is cleared only after a durable-storage write succeeds. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->

**Constraints:**

- Usage tracking always runs regardless of deployment or stress-test mode; billing and quota enforcement remain SaaS-only.
- Multiple concurrent sessions from the same user all ping the same Timekeeper instance.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test ([index](../../src/__tests__/timekeeper/index.test.ts))

**Status:** Implemented

---

### REQ-SUB-007: Quota Enforcement at Session Start (402)

**Intent:** Users who have consumed their monthly compute quota must be prevented from starting new sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Session-start handlers read the user's current monthly usage and compare it to the tier's monthly compute allotment before provisioning a container. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
2. The comparison is skipped for tiers with no compute cap (unlimited). <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
3. When usage exceeds the allotment, the handler returns a 402 response with a machine-readable quota-exceeded code. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
4. The frontend recognizes the quota-exceeded code and surfaces an upgrade call-to-action instead of a generic error. <!-- @impl: web-ui/src/stores/session-usage.ts::isAtUsageQuota --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
5. Quota enforcement is skipped in non-billed deployment modes and in stress-test mode. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-SUB-007 AC5 + REQ-SUB-022 AC1: accumulates the durable monthly total without enforcing quota outside SaaS) -->
6. Enforcement fails open on durable-storage errors so a transient backing-store outage does not lock all users out. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->

**Constraints:**

- The quota check uses the effective tier (after billing-status downgrades), not the stored tier, so a lapsed payment downgrades enforcement in lockstep.
- A 402 status code is used (not 403) to distinguish quota exhaustion from access denial.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated test ([index](../../src/__tests__/timekeeper/index.test.ts))

**Status:** Implemented

---

### REQ-SUB-008: Mid-Session Quota Enforcement (Graceful Stop)

**Intent:** Sessions that exceed quota while running must be stopped gracefully, not left running indefinitely.

**Applies To:** User

**Acceptance Criteria:**

1. When Timekeeper's ping response indicates the user has exceeded quota, the Container DO initiates a graceful stop rather than a hard kill. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SUB-008 AC1: calls stop("SIGTERM") when Timekeeper /ping returns quotaExceeded=true) -->
2. The graceful stop signal allows the container to run its shutdown handler (including the final sync) before exiting. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (collectMetrics) -->
3. The ping response carries both the cumulative monthly usage and the quota-exceeded flag in a single round trip. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->

**Constraints:**

- Mid-session eviction must allow the final sync to complete; abrupt termination would lose user data.
- The quota check happens on each ping cycle, not continuously, so enforcement granularity matches the ping cadence.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-007](#req-sub-007-quota-enforcement-at-session-start-402)

**Verification:** Automated test ([Integration test](../../src/__tests__/container-metrics.test.ts))

**Status:** Implemented

---

### REQ-SUB-009: Admin-Configurable Tiers via Management Panel

**Intent:** Administrators must be able to customize tier properties (quotas, prices, sessions, storage) without code changes.

**Applies To:** Admin

**Acceptance Criteria:**

1. The admin tier-update endpoint accepts a full tier-configuration array and persists it to durable storage. <!-- @test: src/__tests__/routes/admin-tiers.test.ts (REQ-SUB-009 AC1: writes accepted tier array to tiers:config KV key) --> <!-- @manual -->
2. Subscription Management edits only persisted operational limits, descriptions, allowed modes, and external price IDs; identity, policy, ordering, defaults, and provider prices remain read-only. <!-- @impl: web-ui/src/components/admin/SubscriptionManagement.tsx::SubscriptionManagement --> <!-- @test: web-ui/src/__tests__/components/admin/SubscriptionManagement.test.tsx (SubscriptionManagement (Admin)) -->
3. Tier-configuration reads return the persisted admin configuration when present and fall back to the hardcoded defaults when absent. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-009: getTierConfig KV-first with default fallback) -->
4. Admin-saved values always take priority over defaults; absent fields fall back to defaults, present fields override. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-009: getTierConfig KV-first with default fallback) -->
5. The admin tier-update endpoint validates its input against a schema that covers every persisted tier property, so a save never silently drops a field. <!-- @impl: src/routes/admin/tiers.ts::PutTiersBodySchema --> <!-- @test: src/__tests__/routes/admin-tiers.test.ts (PUT /admin/tiers — REQ-SUB-009) -->
6. All tier-management endpoints are admin-gated. <!-- @test: src/__tests__/routes/admin-tiers.test.ts (REQ-SUB-009 AC6: returns 403 when user is not admin) --> <!-- @manual -->

**Constraints:**

- All tier changes require the admin role, enforced after the user is confirmed active.
- New fields added to defaults backfill automatically for deployments with pre-existing tier records.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-010: Tier Config Cached with 60-Second TTL

**Intent:** Tier configuration reads must be fast (avoid KV round-trip on every request) while still reflecting admin changes within a bounded delay.

**Applies To:** User

**Acceptance Criteria:**

1. Tier-configuration reads are served from an in-process cache with a short TTL. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription.test.ts (getTierConfig / REQ-SUB-010 (tier config cached with 60-second TTL; KV-fallback-to-defaults; resetTierConfigCache busts the cache)) -->
2. Within the TTL window, calls return the cached value without a durable-storage read. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-010 AC1/AC2: second call within TTL window returns cached config without KV read) -->
3. After the TTL expires, the next call refreshes the cache from durable storage. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription.test.ts (getTierConfig / REQ-SUB-010 (tier config cached with 60-second TTL; KV-fallback-to-defaults; resetTierConfigCache busts the cache)) -->
4. A test-only cache-invalidation hook is available so unit tests can exercise post-update behavior deterministically. <!-- @impl: src/lib/subscription.ts::resetTierConfigCache --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-010 AC4: resetTierConfigCache forces next call to read from KV) -->
5. Admin changes take effect within one TTL window across all Worker isolates. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription.test.ts (getTierConfig / REQ-SUB-010 (tier config cached with 60-second TTL; KV-fallback-to-defaults; resetTierConfigCache busts the cache)) -->

**Constraints:**

- Each Worker isolate maintains its own cache; there is no cross-isolate invalidation.
- The TTL is per-isolate, not globally synchronized.

**Priority:** P1

**Dependencies:** [REQ-SUB-009](#req-sub-009-admin-configurable-tiers-via-management-panel)

**Verification:** Automated test ([subscription-req-sub-gaps](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts))

**Status:** Implemented

---

### REQ-SUB-011: Graceful Degradation Without Stripe

**Intent:** The platform must function without Stripe for development, self-hosted, and non-SaaS deployments.

**Applies To:** User

**Acceptance Criteria:**

1. When the payment provider is not configured, all tiers can be activated via the direct-subscribe endpoint without an external payment step. <!-- @test: src/__tests__/lib/stripe.test.ts (isStripeConfigured / REQ-SUB-011 (graceful degradation without Stripe: when STRIPE_SECRET_KEY unset, free tier remains usable, paid tiers are hidden)) --> <!-- @manual -->
2. Payment-less activation removes all provider-owned billing-state fields while preserving unrelated user fields; persisted records contain no `undefined` patch values. <!-- @impl: src/routes/auth.ts::default --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-18-001/004: payment-less activation removes stale billing state without undefined values) -->
3. The effective-tier resolver does not downgrade paid tiers when billing fields are absent and the payment provider is not configured. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-011 AC3: getEffectiveTier does not downgrade paid tier when billingStatus is null) -->
4. The subscribe page renders normally, showing tier comparisons without payment buttons. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: src/__tests__/lib/stripe.test.ts (isStripeConfigured / REQ-SUB-011 (graceful degradation without Stripe: when STRIPE_SECRET_KEY unset, free tier remains usable, paid tiers are hidden)) -->

**Constraints:**

- Non-billed deployments treat users without an explicit tier as the highest-access tier for backward compatibility.
- A legacy access-tier field is preserved alongside the subscription tier; resolution prefers the new field and falls back to the legacy one.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-012: Billing Status Enforcement (Effective Tier)

**Intent:** A user's effective tier must reflect their current billing state, automatically downgrading when payment lapses.

**Applies To:** User

**Acceptance Criteria:**

1. A single resolver combines the user's subscription tier, the legacy access-tier field, and the current billing state into the canonical effective tier. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getDefaultTiers / REQ-SUB-001 AC1/AC2 (8 default tiers in canonical order) / REQ-SUB-003 (free tier requires no payment)) -->
2. A canceled billing state results in an immediate downgrade to the free tier with no grace period. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
3. A past-due billing state with a future billing-period end retains the paid tier for the duration of the grace window. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
4. A past-due billing state with an expired or absent billing-period end downgrades to the free tier. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
5. An expired billing-period end with an otherwise-active billing state downgrades to the free tier so missed webhooks do not leave paid access stuck open. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
6. The stored subscription tier is preserved through downgrades so resubscription restores the correct plan without admin intervention. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
7. Tier enforcement is read-time (computed on access), not write-time (the stored tier is not mutated by the enforcement path). <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->

**Constraints:**

- Free, unlimited, pending, and blocked tiers are exempt from billing-driven downgrades (none have an active billing cycle to expire).
- Billing-state comparisons go through typed constants, not raw string literals, so a renamed status value is a compile-time error.
- The billing-status vocabulary is closed: active, trialing, past-due, canceled.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout)

**Verification:** Automated test ([subscription](../../src/__tests__/lib/subscription.test.ts))

**Status:** Implemented

---

### REQ-SUB-013: Concurrent Session Limits

**Intent:** Each tier exposes a maximum used by a best-effort start-time admission check to control resource consumption.

**Applies To:** User

**Acceptance Criteria:**

1. The tier-configuration lookup exposes the maximum-concurrent-sessions value for any tier. <!-- @impl: src/lib/subscription.ts::getUserTier --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (Session limits / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN with env overrides) / REQ-SEC-019 AC2 (per-user concurrent session caps)) -->
2. A start request is rejected when its observed count of running plus initializing sessions, excluding the session currently being started, has reached the configured maximum. Both compressed list metadata and legacy full records are counted. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (DEEP-18-005: running and initializing sessions consume capacity) -->
3. At the session limit, the frontend shows the limit popup instead of opening the create dialog ([REQ-SUB-019](#req-sub-019-session-limit-popup-in-frontend)). <!-- @impl: web-ui/src/stores/session.ts::isAtSessionLimit --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-SUB-013 AC3 / REQ-SUB-019: shows limit feedback without opening the create dialog) -->
4. The session-status batch endpoint returns the tier maximum so the frontend can apply the same best-effort limit client-side without a separate fetch. <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (Container lifecycle extracted helpers / REQ-SESSION-007 (validateSessionAndCheckLimits enforces per-tier MAX_SESSIONS at session start) / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN)) --> <!-- @manual -->
5. The check is not an atomic reservation: simultaneous starts may both observe available capacity and exceed the nominal limit. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (REQ-SESSION-007 AC6 / REQ-SUB-013 AC5: simultaneous starts can exceed the best-effort limit) -->

**Constraints:**

- The session-limit check uses the effective tier (after billing-status downgrades), not the stored tier.
- Stress-test mode bypasses session limits.
- Best-effort concurrency semantics follow [REQ-SESSION-007](session-lifecycle.md#req-session-007-running-session-count-limited-per-tier).

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated test ([container-lifecycle](../../src/__tests__/routes/container-lifecycle.test.ts))

**Status:** Implemented

---

### REQ-SUB-014: Session Mode Gating by Tier

**Intent:** Only tiers that include Pro (advanced) mode in their `sessionModes` array may create Pro sessions.

**Applies To:** User

**Acceptance Criteria:**

1. The tier-configuration lookup exposes the list of session modes allowed for any tier. <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes --> <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)) -->
2. Free and trial tiers only allow Standard mode. <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes --> <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)) -->
3. Standard, advanced, max, and unlimited tiers allow both Standard and Pro modes. <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes --> <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)) -->
4. Explicit preference mode changes that the tier does not allow are rejected. Container startup clamps an unsupported stored mode to the tier's allowed default so stale preferences cannot retain advanced entitlement. <!-- @impl: src/lib/session-mode.ts::clampSessionModeToTier --> <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)) -->

**Constraints:**

- The user record's subscribed-mode field is the source of truth for Pro access; it is set by the payment-provider webhook or by admin override.
- Just-in-time provisioned users default to Standard mode.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** Automated test ([pro-mode-gating](../../src/__tests__/lib/pro-mode-gating.test.ts))

**Status:** Implemented

---

### REQ-SUB-015: Stripe Webhook Signal-and-Sync Pattern

**Intent:** KV billing state must always reflect the latest Stripe state to prevent race conditions from incremental patching.

**Applies To:** User

**Acceptance Criteria:**

1. Webhooks are treated as signals that trigger a fresh fetch from the payment provider, not as the authoritative data source themselves. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->
2. The state-sync routine fetches the latest subscription (with price items expanded) directly from the payment provider. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->
3. Subscription updates and terminations are ordered per user so a later-started termination atomically clears billing fields, applies canceled/free/default state, and prevents an older in-flight update from restoring entitlements. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/routes/stripe-webhook.ts::handleSubscriptionDeleted --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (DEEP-22-002: an older in-flight provider result cannot overwrite a later-started sync) --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (serializes a newer sync while an older apply is delayed after its guard) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-015 AC3: a deletion prevents an older in-flight update from restoring entitlements) --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-SUB-015 AC3: canceled/free cleanup rejects an older paid apply) -->
4. Persisted updates are built from the fetched snapshot; the persisted tier is updated only when price tier-metadata is present, so absent metadata preserves the existing tier. The subscribed mode is resolved per AC6. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState) -->
5. The Timekeeper coordinator performs the token check and read-merge-write as one serialized operation, preserving unrelated user fields without serializing undefined patch values. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState) -->
6. On any mode change, the agent-config reconciler runs to seed the new mode's config set - recreating the new mode's skills and removing the previous mode's - and the session-mode preference (the UI mode) flips. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (auto-recreate on downgrade) -->
7. On subscription termination, after resetting the persisted tier to free, the agent-config reconciler runs with the default mode to restore Standard configs. <!-- @impl: src/routes/stripe-webhook.ts::handleSubscriptionDeleted --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->

**Constraints:**

- Sync ordering uses per-user monotonic tokens, including for starts in the same millisecond.
- Auto-reconcile failure is non-fatal: a reconciliation error does not block the webhook from acknowledging.
- Cancellation scheduled for the end of the billing period does not trigger reconciliation; only the actual termination event does, so users retain Pro configs through the end of their paid period.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/stripe-webhook.test.ts))

**Status:** Implemented

---

### REQ-SUB-016: Customer Portal and Plan Switching

**Intent:** Active subscribers must be able to manage their subscription (cancel, switch plans, update payment) via Stripe's billing portal.

**Applies To:** User

**Acceptance Criteria:**

1. The billing-portal endpoint creates a hosted billing-portal session and returns the portal URL. <!-- @impl: src/lib/stripe.ts::createPortalSession --> <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/portal / REQ-SUB-016 (Stripe customer portal for cancel/payment-method)) -->
2. The plan-switch endpoint creates a portal session deep-linked into the subscription-update-confirmation flow with the new price pre-selected. <!-- @test: src/__tests__/lib/stripe.test.ts (CF-022: Stripe response validation) --> <!-- @manual -->
3. Plan switching requires the active subscription-item identifier, which the switch endpoint resolves from the payment provider before opening the portal session. <!-- @impl: src/routes/billing.ts::SwitchSchema --> <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/switch) -->
4. If the subscription no longer exists at the payment provider, all provider-owned identifiers and billing fields are removed locally without storing `undefined`, identity fields are preserved, and the response asks the frontend to restart at checkout. <!-- @impl: src/routes/billing.ts::default --> <!-- @test: src/__tests__/routes/billing.test.ts (returns nulls and cleans KV when subscription is gone from Stripe) -->
5. Plan changes trigger the subscription-updated webhook which the state-sync routine picks up to update the persisted record. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->
6. The portal endpoint requires an authenticated user with an associated payment-provider customer record and is rate-limited. <!-- @test: src/__tests__/routes/billing.test.ts (REQ-SUB-016 AC6: portal endpoint is rate-limited to 5 requests per minute per user) --> <!-- @manual -->

**Constraints:**

- Users compare plans on the in-product subscribe page (rich UI) and only see the payment provider for payment confirmation.
- The billing-status verification endpoint queries the payment provider as the source of truth and falls back to the persisted record when the provider is unreachable.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-017: Enterprise tier contact flow

**Intent:** The Custom (enterprise) tier is not self-service. Users interested in enterprise-grade access can send an inquiry to admins without leaving the subscribe page.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe page shows a contact-style call-to-action for the Custom tier in place of a checkout button. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (AC1: selecting the Custom tier renders a contact CTA, not a checkout button) -->
2. Activating the call-to-action sends an inquiry through the dedicated contact-team endpoint, which returns success only after the admin notification provider accepts delivery. <!-- @impl: src/routes/auth.ts::app --> <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: src/__tests__/routes/contact-team.test.ts (REQ-SUB-017 AC2: returns { success: true } and calls sendAccessRequestNotification) -->
3. The frontend awaits the endpoint response and switches to a disabled confirmation state only on success; non-2xx or network failure retains an actionable retry state. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (AC3: confirms and disables only after successful delivery) --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (AC3/AC5: non-2xx delivery keeps an actionable retry state) --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (AC3/AC5: network failure keeps the inquiry retryable) -->
4. The endpoint is rate-limited to one inquiry per hour per user. <!-- @impl: src/routes/auth.ts::contactTeamRateLimiter --> <!-- @test: src/__tests__/routes/contact-team.test.ts (REQ-SUB-017 AC4: returns 429 on second request within rate-limit window) -->
5. Provider rejection, missing provider configuration, or provider failure returns a retryable non-2xx response and never reports inquiry success. <!-- @impl: src/routes/auth.ts::default --> <!-- @test: src/__tests__/routes/contact-team.test.ts (REQ-SUB-017 AC5: returns retryable failure when notification is rejected) --> <!-- @test: src/__tests__/routes/contact-team.test.ts (REQ-SUB-017 AC5: returns retryable failure when notification throws) -->

**Constraints:**

- Must comply with the platform-wide rate-limiting constraint ([CON-SEC-004](constraints.md#con-sec-004-rate-limiting-on-all-mutation-endpoints)).
- The inquiry payload includes the user's email and selected tier so the recipient has the context to reply.

**Priority:** P2

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-018: Usage dashboard page

**Intent:** Users with a billed compute quota can see current utilization and actionable threshold warnings.

**Applies To:** User

**Acceptance Criteria:**

1. When the usage response carries a monthly quota, the page renders the quota stat and progress bar. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage --> <!-- @test: web-ui/src/__tests__/components/UsagePage.test.tsx (UsagePage / REQ-SUB-018 AC1 / REQ-SUB-022 AC4 (usage stat and quota rendering)) -->
2. The page polls the usage endpoint for real-time Timekeeper data and accepts the endpoint's durable-store fallback. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage --> <!-- @test: src/__tests__/routes/usage.test.ts (GET /api/usage / REQ-SUB-018 AC2 (real-time Timekeeper DO with KV fallback)) -->
3. Layout-level warning banners surface at the 80%, 95%, and 100% utilization thresholds. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 (session expiry handling on 401)) -->
4. The 80% and 95% banners include a dismiss control that hides the banner until the next monthly quota rollover; dismissal is persisted per calendar month so a page reload does not resurface the warning, and the warning returns automatically when the quota resets. <!-- @impl: web-ui/src/stores/session-usage.ts::setDismissedQuotaLevel --> <!-- @test: web-ui/src/__tests__/stores/session-usage.test.ts (session-usage dismissed quota level / REQ-SUB-018 (usage banner dismiss persistence per UTC month)) -->
5. Dismissing the 95% banner also hides the 80% banner because reaching 95% implies the 80% threshold. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 (session expiry handling on 401)) -->
6. The 100% (quota-exceeded) banner is not dismissible because it explains why new sessions cannot start. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 (session expiry handling on 401)) -->
7. The page shows a centered tier-and-mode label only for metered SaaS plans; non-SaaS and custom unmetered plans show usage time without a plan label. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage --> <!-- @test: web-ui/src/__tests__/components/UsagePage.test.tsx (UsagePage / REQ-SUB-018 AC1 / REQ-SUB-022 AC4 (usage stat and quota rendering)) -->

**Constraints:** Non-SaaS personal usage visibility is owned by [REQ-SUB-022](#req-sub-022-cross-mode-personal-usage-data); account-menu actions are owned by [REQ-SUB-023](#req-sub-023-deployment-mode-account-actions).

**Priority:** P2

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated test ([Integration test](../../src/__tests__/routes/usage.test.ts))

**Status:** Implemented

---

### REQ-SUB-019: Session limit popup in frontend

**Intent:** Users understand why they can't start more sessions and which ones to stop.

**Applies To:** User

**Acceptance Criteria:**

1. When the count of running plus initializing sessions reaches the tier maximum, the "New Session" control stays enabled but diverts to the session-limit popup instead of starting a session. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) -->
2. The popup explains the tier limit, showing the running-session count and a progress bar, with a dismiss control; it does not list individual sessions with per-session stop controls. <!-- @impl: web-ui/src/components/SessionLimitPopup.tsx::SessionLimitPopup --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) -->
3. The tier maximum is sourced from the session-status batch endpoint so the frontend and backend agree without an additional request. <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) --> <!-- @manual -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-013](#req-sub-013-concurrent-session-limits)

**Verification:** Automated test ([Dashboard](../../web-ui/src/__tests__/components/Dashboard.test.tsx))

**Status:** Implemented

---

### REQ-SUB-020: Multi-Currency Pricing

**Intent:** Visitors must see subscription prices in their local currency (CHF, USD, EUR, GBP) with Stripe charging the exact displayed amount -- no surprise FX conversion on the bank statement.

**Applies To:** User

**Acceptance Criteria:**

1. Each payment-provider price object carries multi-currency options for USD, EUR, and GBP alongside the base currency CHF, all at the same nominal amount. <!-- @impl: src/lib/stripe.ts::getStripePrices --> <!-- @test: src/__tests__/lib/stripe.test.ts (getStripePrices with currency) -->
2. The public tiers endpoint detects visitor currency from the Cloudflare-provided country header and returns prices in that currency. <!-- @impl: src/lib/currency.ts::getCurrencyForCountry --> <!-- @test: src/__tests__/routes/auth.test.ts (Auth routes / REQ-SEC-015 (auth-bypass prevention on public endpoints)) -->
3. The checkout endpoint detects visitor currency from the same country header and passes it through to the hosted checkout session so the payment provider charges in the visitor's local currency. <!-- @impl: src/lib/stripe.ts::createCheckoutSession --> <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/checkout / REQ-SUB-020 (multi-currency pricing from CF-IPCountry) / REQ-SUB-004 (Stripe checkout session creation)) -->
4. Country-to-currency mapping: Switzerland/Liechtenstein to CHF, United Kingdom and its listed territories to GBP, all other European countries (including Russia and Turkey) to EUR, and the rest of the world to USD. <!-- @impl: src/lib/currency.ts::getCurrencyForCountry --> <!-- @test: src/__tests__/lib/currency.test.ts (returns EUR for non-Eurozone and transcontinental European countries) -->
5. Currency detection is server-side only; there is no user-facing currency switcher. <!-- @impl: src/lib/currency.ts::getCurrencyForCountry --> <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/checkout / REQ-SUB-020 (multi-currency pricing from CF-IPCountry) / REQ-SUB-004 (Stripe checkout session creation)) -->

**Constraints:**

- Currency is auto-detected per request; there is no override mechanism.
- Multi-currency options must be pre-configured on each payment-provider price object before this feature works.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout)

**Verification:** Automated test ([stripe](../../src/__tests__/lib/stripe.test.ts))

**Status:** Implemented

---

### REQ-SUB-021: Billing Cycle Alignment

**Intent:** New paid subscriptions are billed on the first day of each UTC month so recurring charges and monthly quota resets share one boundary.

**Applies To:** User

**Acceptance Criteria:**

1. When a user starts checkout for a paid tier, the resulting subscription is anchored so that all recurring charges occur at the start of each calendar month (UTC). <!-- @impl: src/lib/kv-keys.ts::getNextUtcMonthStart --> <!-- @test: src/__tests__/routes/billing.test.ts (passes billingCycleAnchor for next 1st of month when trial already used (REQ-SUB-021)) -->
2. The first charge is prorated for the partial period between the subscription's effective start (creation date for non-trial subscriptions, or trial end for trial subscriptions) and the next calendar-month boundary. <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/checkout / REQ-SUB-020 (multi-currency pricing from CF-IPCountry) / REQ-SUB-004 (Stripe checkout session creation)) --> <!-- @manual -->
3. Subsequent monthly charges occur at the start of each calendar month. <!-- @impl: src/lib/kv-keys.ts::getNextUtcMonthStart --> <!-- @manual -->
4. The monthly compute-quota reset and the billing-cycle charge both occur on the same calendar date so users never see a half-cycle where one resets and the other does not. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
5. Subscriptions created before this behavior was introduced retain their original billing anniversary; the spec does not require backfilling the new anchor. <!-- @test: src/__tests__/routes/billing.test.ts (POST /public/stripe/webhook) --> <!-- @manual -->
6. When checkout schedules a free trial, the billing-cycle anchor is the first calendar-month boundary strictly after the scheduled trial end. <!-- @impl: src/routes/billing.ts::default --> <!-- @impl: src/lib/kv-keys.ts::getNextUtcMonthStart --> <!-- @test: src/__tests__/routes/billing.test.ts (passes billingCycleAnchor after trial end when trial is active (REQ-SUB-021)) -->
7. When quota enforcement terminates a trial early, the provider billing-cycle anchor is recomputed from the actual early end before billing begins. <!-- @impl: src/lib/stripe.ts::endTrialNow --> <!-- @test: src/__tests__/routes/billing.test.ts (anchors billing at the first UTC month boundary after the actual early end) -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-022: Cross-Mode Personal Usage Data

**Intent:** Each user can see accurate personal compute consumption regardless of whether the deployment bills or enforces quotas.

**Applies To:** User

**Acceptance Criteria:**

1. Timekeeper reports the current month's durable total plus pending usage in every deployment mode. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-SUB-007 AC5 + REQ-SUB-022 AC1: accumulates the durable monthly total without enforcing quota outside SaaS) -->
2. The usage endpoint returns personal usage statistics in every deployment mode. <!-- @impl: src/routes/usage.ts::app --> <!-- @test: src/__tests__/routes/usage.test.ts (REQ-SUB-022 AC2-AC3: returns live usage with no billing quota outside SaaS mode) -->
3. A non-SaaS usage response carries `null` instead of a billing quota. <!-- @impl: src/routes/usage.ts::app --> <!-- @test: src/__tests__/routes/usage.test.ts (REQ-SUB-022 AC2-AC3: returns live usage with no billing quota outside SaaS mode) -->
4. The usage page renders today's and this month's stat cards when no billing quota exists. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage --> <!-- @test: web-ui/src/__tests__/components/UsagePage.test.tsx (REQ-SUB-022 AC4: renders only personal usage times outside SaaS) -->

**Constraints:** Usage recording and display do not authorize quota, trial, or billing enforcement outside SaaS mode.

**Priority:** P1

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated tests ([Timekeeper](../../src/__tests__/timekeeper/index.test.ts), [usage API](../../src/__tests__/routes/usage.test.ts), and [Usage page](../../web-ui/src/__tests__/components/UsagePage.test.tsx))

**Status:** Implemented

---

### REQ-SUB-023: Deployment-Mode Account Actions

**Intent:** Account menus expose only actions supported by the active deployment mode while personal usage remains reachable everywhere.

**Applies To:** User

**Acceptance Criteria:**

1. The Header account menu exposes Usage in SaaS, onboarding/default, and enterprise modes. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Subscription/Usage gating) --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (opens a Usage-only dropdown in enterprise mode) -->
2. The Dashboard account menu exposes Usage in SaaS, onboarding/default, and enterprise modes. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (opens a Usage-only dropdown in enterprise mode) -->
3. Subscription appears only in SaaS account menus. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Subscription/Usage gating) -->
4. Guided Setup is absent from enterprise account menus. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (opens a Usage-only dropdown in enterprise mode) -->
5. Logout is absent from enterprise account menus. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (opens a Usage-only dropdown in enterprise mode) -->
6. Guided Setup remains available in SaaS and onboarding/default account menus. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Subscription/Usage gating) -->
7. Logout remains available in SaaS and onboarding/default account menus. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Subscription/Usage gating) -->

**Constraints:** Deployment-mode gating changes the available actions, not the user's recorded usage.

**Priority:** P1

**Dependencies:** [REQ-SUB-022](#req-sub-022-cross-mode-personal-usage-data)

**Verification:** Automated tests ([Header](../../web-ui/src/__tests__/components/Header.test.tsx) and [Dashboard](../../web-ui/src/__tests__/components/Dashboard.test.tsx))

**Status:** Implemented

---

### REQ-SUB-024: Usage Page Product Context

**Intent:** The Usage page may address engineers in its own voice instead of repeating subscription positioning.

**Applies To:** User

**Acceptance Criteria:**

1. The Usage page renders a non-empty page-specific subtitle. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SUB-024 AC1+AC2: Usage and Subscribe render distinct non-empty positioning) -->
2. The Subscribe page renders a non-empty subtitle distinct from Usage. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SUB-024 AC1+AC2: Usage and Subscribe render distinct non-empty positioning) -->

**Constraints:** Exact marketing prose is not a behavioral contract and is not pinned in tests.

**Priority:** P2

**Dependencies:** [REQ-SUB-018](#req-sub-018-usage-dashboard-page)

**Verification:** Automated distinct-positioning component test

**Status:** Implemented

---

### REQ-SUB-025: Durable historical usage accounting

**Intent:** Organization analytics needs historical period data without moving live quota authority out of Timekeeper and KV.

**Applies To:** System

**Acceptance Criteria:**

1. Each positive Timekeeper delta updates durable UTC day, ISO week, UTC month, and UTC year accumulators and counts each distinct positive-runtime session once per period. <!-- @impl: src/timekeeper/accounting.ts::applyPositiveDelta --> <!-- @test: src/__tests__/timekeeper/accounting.test.ts (AccountingStateV2 (REQ-SUB-025)) -->
2. One versioned sub-4-KB accounting state replaces legacy accounting keys atomically and performs one state write with zero KV reads on the normal ping path. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/accounting-integration.test.ts (Timekeeper AccountingStateV2 integration (REQ-SUB-025)) --> <!-- @test: src/__tests__/timekeeper/accounting-load.test.ts (historical accounting operation fixture (REQ-OPS-057 AC6)) -->
3. The existing alarm performs five-minute KV work and one hash-phased 15-minute D1 duty; no second alarm exists. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @impl: src/timekeeper/accounting.ts::historyPhase --> <!-- @test: src/__tests__/timekeeper/alarm-history.test.ts (Timekeeper single-alarm history duty (REQ-SUB-025)) -->
4. Current absolute accumulators and closed-period outbox entries retry independently from KV checkpoints, and sequence-guarded D1 upserts cannot double-count. <!-- @impl: src/lib/admin-usage.ts::writeUsageHistory --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/lib/admin-usage.test.ts (historical usage SQL owner (REQ-SUB-025)) --> <!-- @test: src/__tests__/timekeeper/alarm-history.test.ts (Timekeeper single-alarm history duty (REQ-SUB-025)) -->
5. Session markers store only domain-separated hashes, use bounded cache and cleanup, and survive restart and period rollover. <!-- @impl: src/timekeeper/accounting.ts::hashSessionId --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/accounting.test.ts (AccountingStateV2 (REQ-SUB-025)) -->
6. History begins at the first successful D1 write with no backfill; personal usage and quota behavior remain compatible. <!-- @impl: src/lib/admin-usage.ts::writeUsageHistory --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO) -->
7. Retention keeps 400 days, 60 ISO weeks, 60 months, and five years using exact calendar cutoffs. <!-- @impl: src/lib/usage-report-scheduler.ts::retentionCutoffs --> <!-- @test: src/__tests__/lib/usage-report-scheduler.test.ts (usage report retention transaction (REQ-SUB-026, REQ-SUB-027)) -->

**Constraints:** Timekeeper remains live quota owner. D1 failure never blocks quota persistence or enforcement.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-022](#req-sub-022-cross-mode-personal-usage-data), [REQ-OPS-056](operations.md#req-ops-056-non-destructive-d1-deployment-boundary)

**Verification:** Automated migration, attribution, retry, rollover, retention, and operation-count tests

**Status:** Implemented

---

### REQ-SUB-026: Admin organization analytics and deletion history

**Intent:** Administrators can inspect stable organization usage while deleted-user history remains truthful and bounded.

**Applies To:** Admin

**Acceptance Criteria:**

1. Admin-only organization and user-detail routes work in every deployment mode and accept closed period, start, sort, cursor, limit, and JSON or CSV parameters in UTC. <!-- @impl: src/routes/admin/usage.ts::default --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (admin organization usage routes (REQ-SUB-026)) --> <!-- @manual -->
2. Opaque versioned cursors bind the complete filter and use deterministic `user_key` tie-breaking; malformed or mismatched cursors are rejected. <!-- @impl: src/routes/admin/usage.ts::decodeCursor --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (admin organization usage routes (REQ-SUB-026)) -->
3. JSON and CSV share one query and row mapper, with identical filtering and ordering; CSV ignores pagination only. <!-- @impl: src/lib/admin-usage.ts::queryAdminUsageRows --> <!-- @impl: src/routes/admin/usage.ts::usageCsv --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (admin organization usage routes (REQ-SUB-026)) -->
4. `user_key` is stable lowercase hex SHA-256 over a versioned, domain-separated normalized-email input and exposes neither email nor bucket identity. <!-- @impl: src/lib/admin-usage.ts::userKeyForEmail --> <!-- @test: src/__tests__/lib/admin-usage.test.ts (historical usage SQL owner (REQ-SUB-025)) -->
5. User deletion writes a D1 tombstone before live cleanup; failure returns typed `503` and leaves live data unchanged. <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @impl: src/lib/admin-usage.ts::tombstoneUsageUser --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (cleanupUserData) -->
6. Deleted users retain named aggregate history for 60 months; explicit same-email provisioning reactivates ownership without erasing prior history. <!-- @impl: src/lib/admin-usage.ts::reactivateUsageUser --> <!-- @impl: src/lib/access.ts::resolveOrProvisionUser --> <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageRetention --> <!-- @test: src/__tests__/lib/admin-usage.test.ts (historical usage SQL owner (REQ-SUB-025)) --> <!-- @test: src/__tests__/lib/usage-report-scheduler.test.ts (usage report retention transaction (REQ-SUB-026, REQ-SUB-027)) -->
7. Responses disclose `dataSince` and result-owned `historyUpdatedAt` without claiming global outbox freshness. <!-- @impl: src/routes/admin/usage.ts::default --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (admin organization usage routes (REQ-SUB-026)) -->

**Constraints:** No cache, second aggregate table, session-state catalog, or timezone parameter is added.

**Priority:** P1

**Dependencies:** [REQ-SUB-025](#req-sub-025-durable-historical-usage-accounting), [REQ-AUTH-018](authentication.md#req-auth-018-admin-user-management), [AD150](../../documentation/decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records)

**Verification:** Automated authorization, deletion-race, reactivation, retention, cursor, aggregate, and JSON/CSV-equivalence tests; UI manual validation on Integration

**Status:** Implemented

---

### REQ-SUB-027: Monthly organization usage reports

**Intent:** Administrators can schedule private monthly usage reports with recoverable per-recipient delivery evidence.

**Applies To:** Admin

**Acceptance Criteria:**

1. Revisioned settings accept disabled-by-default state, at most 25 normalized recipients, day 1 through 31, whole local hour, and canonical IANA timezone. <!-- @impl: src/lib/usage-reports.ts::normalizeReportSettings --> <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/lib/usage-reports.test.ts (usage report settings and schedule (REQ-SUB-027)) -->
2. Scheduling chooses the latest closed UTC month, applies last-valid-day and DST rules, and stores its next instant under a revision-specific key. <!-- @impl: src/lib/usage-reports.ts::nextReportDelivery --> <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler --> <!-- @test: src/__tests__/lib/usage-reports.test.ts (usage report settings and schedule (REQ-SUB-027)) -->
3. One immutable summary and exact CSV are generated per dispatch, then sent as separate messages with an 8 MiB attachment limit. <!-- @impl: src/lib/usage-reports.ts::buildReportArtifacts --> <!-- @impl: src/lib/email.ts::sendUsageReportEmail --> <!-- @test: src/__tests__/lib/usage-report-delivery.test.ts (usage report artifacts and email boundary (REQ-SUB-027)) -->
4. Scheduled and test dispatches use distinct identities, one row per recipient, conditional claims, random claim tokens, bounded leases, and at most three attempts. <!-- @impl: src/lib/usage-report-scheduler.ts::createReportDispatch --> <!-- @impl: src/lib/usage-report-scheduler.ts::claimReportDelivery --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (usage report delivery claims (REQ-SUB-027)) -->
5. Stale claim tokens cannot complete reclaimed rows; deterministic Resend idempotency suppresses the remaining ambiguous duplicate window. <!-- @impl: src/lib/usage-report-scheduler.ts::completeReportDelivery --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (usage report delivery claims (REQ-SUB-027)) -->
6. The 15-minute scheduler independently recovers pending, failed, and lease-expired scheduled or test rows; `waitUntil()` is only the test-send fast path. <!-- @impl: src/index.ts::scheduled --> <!-- @impl: src/routes/admin/usage-reports.ts::default --> <!-- @test: src/__tests__/routes/admin-usage-reports.test.ts (admin usage report routes (REQ-SUB-027)) -->
7. Delivery history reports pending, sending, accepted, or failed provider-acceptance state without inventing provider delivery state or IDs. <!-- @impl: src/routes/admin/usage-reports.ts::default --> <!-- @impl: web-ui/src/components/admin/ReportsPage.tsx::ReportsPage --> <!-- @test: src/__tests__/routes/admin-usage-reports.test.ts (admin usage report routes (REQ-SUB-027)) --> <!-- @manual -->
8. Once-daily retention uses one random token-guarded transactional D1 batch and rolls back the claim when any prune fails. <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageRetention --> <!-- @test: src/__tests__/lib/usage-report-scheduler.test.ts (usage report retention transaction (REQ-SUB-026, REQ-SUB-027)) -->

**Constraints:** Resend credentials and sender identity remain deployment-managed. Reports do not background-poll and never promise exactly-once delivery.

**Priority:** P1

**Dependencies:** [REQ-SUB-026](#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SETUP-018](setup.md#req-setup-018-stateless-environment-preview-and-bounded-execution), [AD150](../../documentation/decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records)

**Verification:** Automated timezone, claim, retry, retention, email, CSV, and delivery-history tests; UI manual validation on Integration

**Status:** Implemented

---
