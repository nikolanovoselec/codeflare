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

<!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-001 describe -> 8 canonical IDs + 11 required fields + isDefault uniqueness + blocked/pending canLogin -> AC1..AC4) -->
### REQ-SUB-001: Eight-Tier Subscription System

<!-- @test: src/__tests__/lib/subscription.test.ts (SubscriptionTierSchema + getDefaultTiers describes → 8 tier IDs + required fields → AC1/AC2) -->

**Intent:** The platform must support a graduated set of subscription tiers that control access levels, compute quotas, session limits, and available features.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly 8 tier IDs exist: `blocked`, `pending`, `free`, `trial`, `standard`, `advanced`, `max`, `unlimited`. <!-- @impl: src/lib/subscription.ts::getDefaultTiers -->
2. Each tier defines a full property set: monthly compute allotment, maximum concurrent sessions, allowed session modes, login permission, monthly price, trial compute cap, storage cap, display name, description, sort order, and a default-tier flag. <!-- @impl: src/lib/subscription.ts::getDefaultTiers -->
3. The platform ships a hardcoded fallback containing the complete 8-tier set so configuration absence never produces an empty tier list. <!-- @impl: src/lib/subscription.ts::getDefaultTiers -->
4. Tier IDs are stable identifiers; display names may differ (for example, the `standard` tier can display as "Starter"). <!-- @impl: src/lib/subscription.ts::getDefaultTiers -->

**Constraints:**

- Exactly one tier carries the default-tier flag so users with no recorded tier always resolve deterministically.
- The `blocked` tier denies login; the `pending` tier permits login (because pending users still need to reach the subscribe page).

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-002 describe -> exact monthlySeconds + maxSessions + sessionModes + maxStorageBytes per tier from AC table -> AC1..AC4) -->
### REQ-SUB-002: Tier Property Definitions

<!-- @test: src/__tests__/lib/subscription.test.ts (SubscriptionTierConfig interface + getDefaultTiers describes → AC1-AC3) -->

**Intent:** Each tier must define a complete set of properties that drive quota enforcement, session limits, mode gating, and pricing.

**Applies To:** User

**Acceptance Criteria:**

| Tier | Hours/Month | Max Sessions | Modes | Storage | canLogin |
|------|-------------|-------------|-------|---------|----------|
| blocked | 0 | 0 | none | 0 | false |
| pending | 0 | 0 | none | 0 | true |
| free | 4 | 1 | Standard | 250 MB | true |
| trial | 5 | 2 | Standard | 500 MB | true |
| standard | 40 | 1 | Standard, Pro | 500 MB | true |
| advanced | 80 | 2 | Standard, Pro | 1 GB | true |
| max | 160 | 3 | Standard, Pro | 2 GB | true |
| unlimited | null (unlimited) | 5 | Standard, Pro | null (unlimited) | true |

1. An unset monthly compute allotment means unlimited compute. <!-- @impl: src/lib/subscription.ts::getDefaultTiers -->
2. An unset storage cap means unlimited storage. <!-- @impl: src/lib/subscription.ts::getDefaultTiers -->
3. The allowed session-modes field is a list of mode identifiers drawn from the supported set. <!-- @impl: src/lib/subscription.ts::getDefaultTiers -->

**Constraints:**

- These are default values; admins can override all operational parameters via the management panel.
- Prices are not hardcoded; they come from Stripe via the admin-configured price ID associated with each tier.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** [Automated test](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts)

**Status:** Implemented

---

### REQ-SUB-003: Free Tier Requires No Payment

<!-- @impl: src/routes/auth.ts -->
<!-- @impl: src/routes/billing.ts -->
<!-- @test: src/__tests__/lib/subscription.test.ts (getDefaultTiers describe → free tier priceMonthly=0 + canLogin=true + single session → AC2/AC4) -->
<!-- @test: src/__tests__/routes/auth.test.ts (auth route → free tier subscribe path bypasses Stripe → AC1/AC3) -->

**Intent:** Users must be able to use the platform at the free tier without providing payment information.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe endpoint activates the free tier directly without any payment-provider interaction.
2. The free tier has a zero monthly price.
3. Even when the payment provider is configured, the free tier still bypasses external checkout.
4. Free-tier users have no billing-state fields populated.

**Constraints:**

- Free-tier auto-sleep is locked to a fixed short timeout; users cannot extend it from the UI.
- Free tier is limited to a single concurrent session.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** [Automated test](../../src/__tests__/lib/subscription.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/auth-subscribe.test.ts (POST /auth/subscribe describe -> accepts tier=free, rejects paid tiers when STRIPE_SECRET_KEY set + 'Paid subscriptions require checkout' -> AC1) -->
<!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/checkout / REQ-SUB-004 describe -> creates Stripe Checkout Session with customer_email + tier/mode metadata + returns Stripe-hosted url -> AC2) -->
<!-- @test: src/__tests__/lib/stripe.test.ts (createCheckoutSession describe -> POST to Stripe with customer_email/metadata/trial_period_days/success_url/cancel_url + returns session url -> AC2) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 describe -> writes checkout fields and calls syncSubscriptionState -> AC3) -->
<!-- @test: src/__tests__/routes/billing.test.ts (POST /public/stripe/webhook describe -> handles checkout.session.completed + customer.subscription.updated + customer.subscription.deleted events -> AC5) -->
<!-- @test: src/__tests__/lib/stripe.test.ts (verifyWebhookSignature describe -> HMAC-SHA256 signature + 5-minute timestamp tolerance + rejects wrong sig + out-of-window -> AC6) -->
<!-- @test: src/__tests__/routes/billing.test.ts (POST /public/stripe/webhook describe -> deduplication via KV stripe:event:{eventId} with 72-hour TTL -> AC7) -->
### REQ-SUB-004: Paid Tiers Integrate with Stripe Checkout

<!-- @impl: src/routes/billing.ts -->

**Intent:** Paid tiers (standard, advanced, max) must collect payment via Stripe before activating the subscription.

**Applies To:** User

**Acceptance Criteria:**

1. When the payment provider is configured, the direct-subscribe endpoint rejects paid tiers with a clear "checkout required" error; only the free tier remains directly subscribable.
2. The checkout endpoint creates a hosted checkout session pre-populated with the visitor's email and the tier/mode metadata, and returns the externally-hosted checkout URL. <!-- @impl: src/lib/stripe.ts::createCheckoutSession -->
3. After payment, the provider sends a checkout-completed webhook that records the checkout outcome and triggers an authoritative state sync.
4. The frontend polls the auth-status endpoint after the checkout redirect on a fixed interval with no bounded total wait (the poll has no deadline and continues until activation is observed) so subscription activation feels immediate to the user.
5. The webhook handler covers the three relevant lifecycle events: checkout completion, subscription update, and subscription deletion.
6. The webhook endpoint is publicly reachable but enforces signed-payload verification with a short timestamp tolerance.
7. Webhook events are de-duplicated by event identifier with a multi-day retention window so replayed events do not double-apply.

**Constraints:**

- Tier and mode metadata must be present on the payment-provider price objects before deploy; the system reads metadata, not separate configuration.
- Tiers without a configured external price are hidden from the subscribe page.
- The customer-to-email mapping is recorded on checkout completion so subsequent webhooks can resolve the user.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-003](#req-sub-003-free-tier-requires-no-payment)

**Verification:** [Integration test](../../src/__tests__/routes/auth-subscribe.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/admin-tiers.test.ts (PUT /admin/tiers describe -> trialQuotaHours editable per tier in tiers:config -> AC1) -->
<!-- @test: src/__tests__/lib/stripe.test.ts (createCheckoutSession describe -> includes trial_period_days=30 when trialDays is set, excludes when undefined -> AC2) -->
<!-- @test: src/__tests__/timekeeper/index.test.ts (trial quota enforcement describe -> returns quotaExceeded=true when trialing user exceeds trialQuotaHours -> AC3) -->
<!-- @test: src/__tests__/lib/stripe.test.ts (endTrialNow describe -> POST to Stripe with trial_end=now + throws on unknown subscription id -> AC4) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleSubscriptionUpdated describe -> trialing->active flips billingStatus + unlocks monthlySeconds + past_due downgrades to free -> AC5) -->
<!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> sets trialUsed=true when transitioning away from trialing, prevents re-trial loop -> AC6) -->
### REQ-SUB-005: Trial Is Compute-Based, Not Time-Based

<!-- @impl: src/timekeeper/index.ts -->
<!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted + handleSubscriptionUpdated + handleSubscriptionDeleted + auto-recreate-on-downgrade describes -> AC2/AC4/AC5/AC6 trial state transitions + cap consumption + first-charge handling + trial-used marker) + src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> AC3 trial quota enforcement) -->

**Intent:** Trial periods must be capped by actual compute usage, not calendar days, so that inactive users do not burn through their trial.

**Applies To:** User

**Acceptance Criteria:**

1. Each paid tier has an admin-configurable trial compute cap.
2. Subscriptions are created with a maximum billing window so the trial cannot exceed a hard calendar limit even if the user never uses any compute.
3. Timekeeper enforces the trial compute cap as the active quota while the subscription is in trial state. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->
4. When the trial compute cap is consumed, Timekeeper ends the trial early at the payment provider, triggering the first real charge. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->
5. If the first charge succeeds the full monthly compute quota unlocks; if it fails the subscription enters the past-due state and the user is downgraded to the free tier. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
6. A trial-used marker is recorded when the subscription transitions out of trial state so users cannot loop subscribe-cancel-resubscribe to obtain unlimited free trials. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->

**Constraints:**

- Early trial termination is gated by an idempotency flag so the per-session ping cycle cannot issue duplicate provider calls.
- The webhook stale-write guard uses strict timestamp ordering so events sharing the same second are not silently discarded.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** [Integration test](../../src/__tests__/routes/admin-tiers.test.ts)

**Status:** Implemented

---

### REQ-SUB-006: Real-Time Usage Tracking via Timekeeper DO

<!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO describe → 60s pings + alarm flush + per-period counters → AC1-AC7) -->

**Intent:** Compute usage must be tracked accurately in real time so that quota enforcement and billing decisions use current data.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly one Timekeeper Durable Object instance exists per user. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->
2. Container DOs ping their user's Timekeeper with a monotonic per-session total on a short fixed cadence whenever the deployment runs in a billed mode. <!-- @impl: src/container/container-metrics.ts::collectMetrics -->
3. Timekeeper computes per-session deltas, accumulates pending usage in memory, and periodically flushes it to durable storage. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->
4. Timekeeper exposes a usage-read interface that returns flushed-plus-pending totals for live consumption. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->
5. The durable record tracks rolling daily, weekly, monthly, yearly, and all-time totals with automatic rollovers. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->
6. The flush handler retries on durable-storage write failure on a fixed 30-second interval (not exponential backoff). <!-- @impl: src/timekeeper/index.ts::Timekeeper -->
7. Pending usage is cleared only after a durable-storage write succeeds. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

**Constraints:**

- Usage tracking always runs regardless of stress-test mode; stress-test mode only bypasses rate limits and session limits.
- Multiple concurrent sessions from the same user all ping the same Timekeeper instance.

**Priority:** P0

**Dependencies:** None.

**Verification:** [Automated test](../../src/__tests__/timekeeper/index.test.ts)

**Status:** Implemented

---

### REQ-SUB-007: Quota Enforcement at Session Start (402)

<!-- @impl: src/routes/container/lifecycle.ts -->
<!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO describe → quota gate + 402 + fail-open + non-SaaS skip → AC1-AC6) -->

**Intent:** Users who have consumed their monthly compute quota must be prevented from starting new sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Session-start handlers read the user's current monthly usage and compare it to the tier's monthly compute allotment before provisioning a container.
2. The comparison is skipped for tiers with no compute cap (unlimited).
3. When usage exceeds the allotment, the handler returns a 402 response with a machine-readable quota-exceeded code.
4. The frontend recognizes the quota-exceeded code and surfaces an upgrade call-to-action instead of a generic error.
5. Enforcement is skipped in non-billed deployment modes and in stress-test mode.
6. Enforcement fails open on durable-storage errors so a transient backing-store outage does not lock all users out. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

**Constraints:**

- The quota check uses the effective tier (after billing-status downgrades), not the stored tier, so a lapsed payment downgrades enforcement in lockstep.
- A 402 status code is used (not 403) to distinguish quota exhaustion from access denial.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** [Automated test](../../src/__tests__/timekeeper/index.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/container-metrics.test.ts (REQ-SUB-008 AC1: calls stop("SIGTERM") when Timekeeper /ping returns quotaExceeded=true + does NOT stop when quotaExceeded=false -> AC1 graceful stop via SIGTERM, AC2 entrypoint trap runs final sync) -->
<!-- @test: src/__tests__/timekeeper/index.test.ts (POST /ping describe -> returns { quotaExceeded, totalMonthlySeconds } shape + trial quota enforcement returns quotaExceeded=true when over trialQuotaHours -> AC3 ping response shape) -->
### REQ-SUB-008: Mid-Session Quota Enforcement (Graceful Stop)

**Intent:** Sessions that exceed quota while running must be stopped gracefully, not left running indefinitely.

**Applies To:** User

**Acceptance Criteria:**

1. When Timekeeper's ping response indicates the user has exceeded quota, the Container DO initiates a graceful stop rather than a hard kill. <!-- @impl: src/container/container-metrics.ts::collectMetrics -->
2. The graceful stop signal allows the container to run its shutdown handler (including the final sync) before exiting. <!-- @impl: src/container/container-metrics.ts::collectMetrics -->
3. The ping response carries both the cumulative monthly usage and the quota-exceeded flag in a single round trip. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

**Constraints:**

- Mid-session eviction must allow the final sync to complete; abrupt termination would lose user data.
- The quota check happens on each ping cycle, not continuously, so enforcement granularity matches the ping cadence.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-007](#req-sub-007-quota-enforcement-at-session-start-402)

**Verification:** [Integration test](../../src/__tests__/container-metrics.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (getTierConfig KV-first with default fallback describe -> KV read + default fallback + merge backfill + Team->Custom migration -> AC3,4) -->
<!-- @test: src/__tests__/routes/admin-tiers.test.ts (PUT /admin/tiers describe -> writes tiers:config + persists maxStorageBytes + 403 non-admin + Zod rejects 7-tier/bad-id/negative -> AC1,5,6) -->
### REQ-SUB-009: Admin-Configurable Tiers via Management Panel

<!-- @impl: src/routes/admin -->
<!-- @test: src/__tests__/lib/stripe.test.ts (resolveTierFromPriceId describe → tier resolution from Stripe price metadata → AC1/AC4) -->

**Intent:** Administrators must be able to customize tier properties (quotas, prices, sessions, storage) without code changes.

**Applies To:** Admin

**Acceptance Criteria:**

1. The admin tier-update endpoint accepts a full tier-configuration array and persists it to durable storage.
2. The admin Subscription Management panel exposes editable fields for all tier properties, including storage cap, monthly compute, maximum concurrent sessions, trial cap, and external price IDs.
3. Tier-configuration reads return the persisted admin configuration when present and fall back to the hardcoded defaults when absent. <!-- @impl: src/lib/subscription.ts::getTierConfig -->
4. Admin-saved values always take priority over defaults; absent fields fall back to defaults, present fields override. <!-- @impl: src/lib/subscription.ts::getTierConfig -->
5. The admin tier-update endpoint validates its input against a schema that covers every persisted tier property, so a save never silently drops a field.
6. All tier-management endpoints are admin-gated.

**Constraints:**

- All tier changes require the admin role, enforced after the user is confirmed active.
- New fields added to defaults backfill automatically for deployments with pre-existing tier records.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** [Automated test](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-010 describe -> cache hit within 59s + miss after 61s + resetTierConfigCache forces re-read -> AC1..AC4) -->
### REQ-SUB-010: Tier Config Cached with 60-Second TTL

<!-- @test: src/__tests__/lib/subscription.test.ts (getTierConfig describe → KV fallback + module cache single-KV-read + resetTierConfigCache cache-bust → AC1-AC5) -->

**Intent:** Tier configuration reads must be fast (avoid KV round-trip on every request) while still reflecting admin changes within a bounded delay.

**Applies To:** User

**Acceptance Criteria:**

1. Tier-configuration reads are served from an in-process cache with a short TTL. <!-- @impl: src/lib/subscription.ts::getTierConfig -->
2. Within the TTL window, calls return the cached value without a durable-storage read. <!-- @impl: src/lib/subscription.ts::getTierConfig -->
3. After the TTL expires, the next call refreshes the cache from durable storage. <!-- @impl: src/lib/subscription.ts::getTierConfig -->
4. A test-only cache-invalidation hook is available so unit tests can exercise post-update behavior deterministically. <!-- @impl: src/lib/subscription.ts::resetTierConfigCache -->
5. Admin changes take effect within one TTL window across all Worker isolates. <!-- @impl: src/lib/subscription.ts::getTierConfig -->

**Constraints:**

- Each Worker isolate maintains its own cache; there is no cross-isolate invalidation.
- The TTL is per-isolate, not globally synchronized.

**Priority:** P1

**Dependencies:** [REQ-SUB-009](#req-sub-009-admin-configurable-tiers-via-management-panel)

**Verification:** [Automated test](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-011 describe -> getEffectiveTier no-downgrade when billingStatus null/undefined + both-undefined defaults to pending -> AC2,3) -->
### REQ-SUB-011: Graceful Degradation Without Stripe

<!-- @impl: src/routes/billing.ts -->
<!-- @impl: src/lib/stripe.ts -->
<!-- @test: src/__tests__/lib/stripe.test.ts (isStripeConfigured describe → graceful no-Stripe path → AC1/AC2/AC3/AC4) -->

**Intent:** The platform must function without Stripe for development, self-hosted, and non-SaaS deployments.

**Applies To:** User

**Acceptance Criteria:**

1. When the payment provider is not configured, all tiers can be activated via the direct-subscribe endpoint without an external payment step.
2. Billing-state fields remain unset in user records on payment-less activation.
3. The effective-tier resolver does not downgrade paid tiers when billing fields are absent and the payment provider is not configured.
4. The subscribe page renders normally, showing tier comparisons without payment buttons.

**Constraints:**

- Non-billed deployments treat users without an explicit tier as the highest-access tier for backward compatibility.
- A legacy access-tier field is preserved alongside the subscription tier; resolution prefers the new field and falls back to the legacy one.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** [Automated test](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts)

**Status:** Implemented

---

### REQ-SUB-012: Billing Status Enforcement (Effective Tier)

<!-- @impl: src/lib/subscription.ts::isActiveTier -->
<!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier describe → billing-status-driven downgrade matrix → AC1-AC7) -->

**Intent:** A user's effective tier must reflect their current billing state, automatically downgrading when payment lapses.

**Applies To:** User

**Acceptance Criteria:**

1. A single resolver combines the user's subscription tier, the legacy access-tier field, and the current billing state into the canonical effective tier. <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
2. A canceled billing state results in an immediate downgrade to the free tier with no grace period. <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
3. A past-due billing state with a future billing-period end retains the paid tier for the duration of the grace window. <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
4. A past-due billing state with an expired or absent billing-period end downgrades to the free tier. <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
5. An expired billing-period end with an otherwise-active billing state downgrades to the free tier so missed webhooks do not leave paid access stuck open. <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
6. The stored subscription tier is preserved through downgrades so resubscription restores the correct plan without admin intervention. <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
7. Tier enforcement is read-time (computed on access), not write-time (the stored tier is not mutated by the enforcement path). <!-- @impl: src/lib/subscription.ts::getEffectiveTier -->

**Constraints:**

- Free, unlimited, pending, and blocked tiers are exempt from billing-driven downgrades (none have an active billing cycle to expire).
- Billing-state comparisons go through typed constants, not raw string literals, so a renamed status value is a compile-time error.
- The billing-status vocabulary is closed: active, trialing, past-due, canceled.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout)

**Verification:** [Automated test](../../src/__tests__/lib/subscription.test.ts)

**Status:** Implemented

---

### REQ-SUB-013: Concurrent Session Limits

<!-- @impl: src/lib/subscription.ts::getUserTier -->
<!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits -->
<!-- @test: src/__tests__/routes/container-lifecycle.test.ts (Session limits describe → per-tier maxSessions enforcement + STRESS_TEST_MODE bypass → AC1-AC4) -->

**Intent:** Each tier must enforce a maximum number of simultaneously running sessions to control resource consumption.

**Applies To:** User

**Acceptance Criteria:**

1. The tier-configuration lookup exposes the maximum-concurrent-sessions value for any tier. <!-- @impl: src/lib/subscription.ts::getUserTier -->
2. Session creation is rejected when the count of running plus initializing sessions has reached the configured maximum. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits -->
3. The frontend prevents starting a new session once the session limit is reached: at the limit the start-session control does not open the create dialog, and the limit is surfaced to the user via the session-limit popup ([REQ-SUB-019](#req-sub-019-session-limit-popup-in-frontend)). <!-- @impl: web-ui/src/stores/session.ts::isAtSessionLimit --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard -->
4. The session-status batch endpoint returns the tier maximum so the frontend can enforce limits client-side without a separate fetch.

**Constraints:**

- The session-limit check uses the effective tier (after billing-status downgrades), not the stored tier.
- Stress-test mode bypasses session limits.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** [Automated test](../../src/__tests__/routes/container-lifecycle.test.ts)

**Status:** Implemented

---

### REQ-SUB-014: Session Mode Gating by Tier

<!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->
<!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (Pro-mode gating describe → per-tier allowed modes + rejection on unsupported → AC1-AC4) -->

**Intent:** Only tiers that include Pro (advanced) mode in their `sessionModes` array may create Pro sessions.

**Applies To:** User

**Acceptance Criteria:**

1. The tier-configuration lookup exposes the list of session modes allowed for any tier. <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes -->
2. Free and trial tiers only allow Standard mode. <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes -->
3. Standard, advanced, max, and unlimited tiers allow both Standard and Pro modes. <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes -->
4. Session creation and mode-change requests for a mode the tier does not allow are rejected.

**Constraints:**

- The user record's subscribed-mode field is the source of truth for Pro access; it is set by the payment-provider webhook or by admin override.
- Just-in-time provisioned users default to Standard mode.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** [Automated test](../../src/__tests__/lib/pro-mode-gating.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled) describe -> calls syncSubscriptionState which updates tier from Stripe API -> AC1, AC2) -->
<!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> skips write when KV lastSyncedAt is newer than current timestamp -> AC3 stale-webhook guard) -->
<!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> writes complete state to KV from Stripe snapshot -> AC4) -->
<!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> preserves tier when metadata is null (does not blank it) -> AC4) -->
<!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> preserves existing KV fields (addedBy, onboardingComplete, etc.) -> AC5) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (auto-recreate on downgrade describe -> calls reconcileAgentConfigs when mode changes from advanced to default -> AC6) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (auto-recreate on downgrade describe -> calls reconcileAgentConfigs on upgrade (default → advanced) -> AC6) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (auto-reconcile on subscription.deleted describe -> calls reconcileAgentConfigs with default mode on subscription deletion -> AC7) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (auto-recreate on downgrade describe -> downgrade Pro→Standard: recovers default mode from the price slot (null metadata) and reconciles -> AC6) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (auto-recreate on downgrade describe -> upgrade Standard→Pro: recovers advanced mode from the price slot (null metadata) and reconciles -> AC6) -->
### REQ-SUB-015: Stripe Webhook Signal-and-Sync Pattern

<!-- @impl: src/routes/stripe-webhook.ts -->

**Intent:** KV billing state must always reflect the latest Stripe state to prevent race conditions from incremental patching.

**Applies To:** User

**Acceptance Criteria:**

1. Webhooks are treated as signals that trigger a fresh fetch from the payment provider, not as the authoritative data source themselves. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
2. The state-sync routine fetches the latest subscription (with price items expanded) directly from the payment provider. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
3. A last-synced timestamp guard prevents stale webhooks from overwriting newer state. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
4. Persisted updates are built from the fetched snapshot; the persisted tier is updated only when price tier-metadata is present, so absent metadata preserves the existing tier. The subscribed mode is resolved per AC6. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
5. Writes use an atomic read-merge-write helper to prevent concurrent webhook writes from clobbering unrelated fields. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
6. On any mode change (upgrade or downgrade), the agent-config reconciler runs to seed the new mode's config set - recreating the new mode's skills and removing the previous mode's - and the session-mode preference (the UI mode) flips. The mode is resolved from the Stripe price even when the price carries no `mode` metadata: the price ID is matched against the tier configuration's Standard and Pro price slots (`stripePriceId` / `stripeAdvancedPriceId`) to recover it, so a Standard<->Pro subscription change always updates the subscribed mode and triggers this reconcile even when admins configure prices via slots rather than per-price metadata. The change is lazy: a running session is unaffected until its next start. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
7. On subscription termination, after resetting the persisted tier to free, the agent-config reconciler runs with the default mode to restore Standard configs.

**Constraints:**

- The stale-write guard uses strict timestamp ordering so events sharing the same second are not silently discarded.
- Auto-reconcile failure is non-fatal: a reconciliation error does not block the webhook from acknowledging.
- Cancellation scheduled for the end of the billing period does not trigger reconciliation; only the actual termination event does, so users retain Pro configs through the end of their paid period.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** [Integration test](../../src/__tests__/routes/stripe-webhook.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/portal / REQ-SUB-016 describe -> creates portal session via createPortalSession and returns { portalUrl } -> AC1) -->
<!-- @test: src/__tests__/lib/stripe.test.ts (createPortalSession describe -> POST to Stripe billing_portal/sessions with customer_id + return_url + flow_data subscription_update_confirm for switch flow -> AC2) -->
<!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/switch describe -> requires subscriptionItemId from fetchSubscription + cleans up stale KV when subscription no longer exists on Stripe -> AC3, AC4) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleSubscriptionUpdated describe -> customer.subscription.updated picked up by syncSubscriptionState propagates plan change to KV -> AC5) -->
<!-- @test: src/__tests__/routes/billing.test.ts (REQ-SUB-016 AC6 describe -> portal endpoint is rate-limited 5/min -> AC6) -->
### REQ-SUB-016: Customer Portal and Plan Switching

<!-- @impl: src/routes/billing.ts -->

**Intent:** Active subscribers must be able to manage their subscription (cancel, switch plans, update payment) via Stripe's billing portal.

**Applies To:** User

**Acceptance Criteria:**

1. The billing-portal endpoint creates a hosted billing-portal session and returns the portal URL. <!-- @impl: src/lib/stripe.ts::createPortalSession -->
2. The plan-switch endpoint creates a portal session deep-linked into the subscription-update-confirmation flow with the new price pre-selected.
3. Plan switching requires the active subscription-item identifier, which the switch endpoint resolves from the payment provider before opening the portal session.
4. If the subscription no longer exists at the payment provider, stale fields are cleaned up locally and the response asks the frontend to restart at checkout.
5. Plan changes trigger the subscription-updated webhook which the state-sync routine picks up to update the persisted record.
6. The portal endpoint requires an authenticated user with an associated payment-provider customer record and is rate-limited.

**Constraints:**

- Users compare plans on the in-product subscribe page (rich UI) and only see the payment provider for payment confirmation.
- The billing-status verification endpoint queries the payment provider as the source of truth and falls back to the persisted record when the provider is unreachable.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** [Integration test](../../src/__tests__/routes/billing.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/contact-team.test.ts (POST /auth/contact-team describe -> sendAccessRequestNotification called with userEmail+adminEmails+plan + defaults to Custom + 429 second-request + email-failure non-fatal + 401 unauth -> AC2,4,5) -->
### REQ-SUB-017: Enterprise tier contact flow

<!-- @impl: web-ui/src/components/SubscribePage.tsx -->
**Intent:** The Custom (enterprise) tier is not self-service. Users interested in enterprise-grade access can send an inquiry to admins without leaving the subscribe page.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe page shows a contact-style call-to-action for the Custom tier in place of a checkout button. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage -->
2. Activating the call-to-action sends an inquiry email to admins through a dedicated contact-team endpoint. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage -->
3. After activation, the control switches to a disabled confirmation state to prevent duplicate submissions. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage -->
4. The endpoint is rate-limited to one inquiry per hour per user.
5. When the email-provider integration is not configured, the endpoint still returns success and the inquiry is silently dropped.

**Constraints:**

- Must comply with the platform-wide rate-limiting constraint ([CON-SEC-004](constraints.md#con-sec-004-rate-limiting-on-all-mutation-endpoints)).
- The inquiry payload includes the user's email and selected tier so the recipient has the context to reply.

**Priority:** P2

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** [Integration test](../../src/__tests__/routes/contact-team.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/usage.test.ts (GET /api/usage / REQ-SUB-018 AC2 describe -> Timekeeper live data when binding present and 200, KV fallback on TK 500 or missing binding, zero seconds on UTC month rollover, billing-aware effective tier for monthlyQuotaSeconds -> AC2 poll + KV fallback) -->
<!-- @test: web-ui/src/__tests__/stores/session-usage.test.ts (session-usage dismissed quota level / REQ-SUB-018 describe -> persists 80/95 dismissals to localStorage under month-scoped keys + ignores dismissal from previous UTC month + clears on month advance + no throw without localStorage -> AC4 dismiss per UTC month, AC5 95-dismiss-implies-80) -->
### REQ-SUB-018: Usage dashboard page

<!-- @impl: web-ui/src/components/UsageInlineBadge.tsx -->
<!-- @impl: src/routes/usage.ts -->

**Intent:** Users can see their compute usage and understand how close they are to their quota.

**Applies To:** User

**Acceptance Criteria:**

1. The usage page shows a progress ring for monthly usage and stat cards for today, this month, and the tier quota. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage -->
2. The page polls the usage endpoint for real-time data from Timekeeper with a durable-store fallback when Timekeeper is unavailable. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage -->
3. Layout-level warning banners surface at the 80%, 95%, and 100% utilization thresholds.
4. The 80% and 95% banners include a dismiss control that hides the banner until the next monthly quota rollover; dismissal is persisted per calendar month so a page reload does not resurface the warning, and the warning returns automatically when the quota resets.
5. Dismissing the 95% banner also hides the 80% banner because reaching 95% implies the 80% threshold.
6. The 100% (quota-exceeded) banner is not dismissible because it explains why new sessions cannot start.

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** [Integration test](../../src/__tests__/routes/usage.test.ts)

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 describe -> session limit popup explains tier limit + lists running sessions with stop buttons + New Session button disabled when running+initializing >= maxSessions -> AC1, AC2, AC3) -->
### REQ-SUB-019: Session limit popup in frontend

<!-- @impl: web-ui/src/components/Dashboard.tsx -->
<!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 describe -> AC1/AC2/AC3 New-Session disable at cap + popup with running sessions + tier max from batch-status) -->

**Intent:** Users understand why they can't start more sessions and which ones to stop.

**Applies To:** User

**Acceptance Criteria:**

1. When the count of running plus initializing sessions reaches the tier maximum, the "New Session" control stays enabled but diverts to the session-limit popup instead of starting a session. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard -->
2. The popup explains the tier limit, showing the running-session count and a progress bar, with a dismiss control; it does not list individual sessions with per-session stop controls.
3. The tier maximum is sourced from the session-status batch endpoint so the frontend and backend agree without an additional request.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-013](#req-sub-013-concurrent-session-limits)

**Verification:** [Integration test](../../web-ui/src/__tests__/components/Dashboard.test.tsx)

**Status:** Implemented

---

### REQ-SUB-020: Multi-Currency Pricing

<!-- @test: src/__tests__/lib/stripe.test.ts (multi-currency describe → currency_options + Checkout currency passthrough → AC1/AC3) -->
<!-- @test: src/__tests__/routes/auth.test.ts (auth tiers route → CF-IPCountry detection → AC2/AC4) -->
<!-- @test: src/__tests__/routes/billing.test.ts (billing checkout route → currency passthrough → AC3/AC5) -->

**Intent:** Visitors must see subscription prices in their local currency (CHF, USD, EUR, GBP) with Stripe charging the exact displayed amount -- no surprise FX conversion on the bank statement.

**Applies To:** User

**Acceptance Criteria:**

1. Each payment-provider price object carries multi-currency options for USD, EUR, and GBP alongside the base currency CHF, all at the same nominal amount. <!-- @impl: src/lib/stripe.ts::getStripePrices -->
2. The public tiers endpoint detects visitor currency from the Cloudflare-provided country header and returns prices in that currency. <!-- @impl: src/lib/currency.ts::getCurrencyForCountry -->
3. The checkout endpoint detects visitor currency from the same country header and passes it through to the hosted checkout session so the payment provider charges in the visitor's local currency. <!-- @impl: src/lib/stripe.ts::createCheckoutSession -->
4. Country-to-currency mapping: Switzerland/Liechtenstein to CHF, United Kingdom to GBP, all other European countries to EUR, rest of world to USD. <!-- @impl: src/lib/currency.ts::getCurrencyForCountry -->
5. Currency detection is server-side only; there is no user-facing currency switcher. <!-- @impl: src/lib/currency.ts::getCurrencyForCountry -->

**Constraints:**

- Currency is auto-detected per request; there is no override mechanism.
- Multi-currency options must be pre-configured on each payment-provider price object before this feature works.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout)

**Verification:** [Automated test](../../src/__tests__/lib/stripe.test.ts)

**Status:** Implemented

---

### REQ-SUB-021: Billing Cycle Alignment

<!-- @impl: src/routes/stripe-webhook.ts -->
<!-- @test: src/__tests__/routes/billing.test.ts (billing-cycle-anchor describe → 1st-of-UTC-month anchor + proration + trial-end anchor → AC1-AC6) -->

**Intent:** New paid subscriptions are billed on the 1st of each UTC calendar month so that recurring charges and monthly quota resets happen on the same date, eliminating the mid-cycle quota refresh that previously gave users roughly twice the paid quota between two billing charges.

**Applies To:** User

**Acceptance Criteria:**

1. When a user starts checkout for a paid tier, the resulting subscription is anchored so that all recurring charges occur at the start of each calendar month (UTC).
2. The first charge is prorated for the partial period between the subscription's effective start (creation date for non-trial subscriptions, or trial end for trial subscriptions) and the next calendar-month boundary.
3. Subsequent monthly charges occur at the start of each calendar month.
4. The monthly compute-quota reset and the billing-cycle charge both occur on the same calendar date so users never see a half-cycle where one resets and the other does not. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->
5. Subscriptions created before this behavior was introduced retain their original billing anniversary; the spec does not require backfilling the new anchor.
6. When a free trial is active, the billing-cycle anchor is the first calendar-month boundary strictly after the trial ends, so billing begins on that anchor date once the trial completes (whether naturally or by early termination on quota consumption). Trial length itself is unaffected.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** [Automated test](../../src/__tests__/routes/billing.test.ts)

**Status:** Implemented
