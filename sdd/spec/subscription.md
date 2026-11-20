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
3. The platform ships a hardcoded fallback containing the complete 8-tier set so configuration absence never produces an empty tier list. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-009 AC3: falls back to getDefaultTiers when KV is empty) --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-001 AC3: getDefaultTiers returns the complete 8-tier hardcoded fallback) -->
4. Tier IDs are stable identifiers; display names may differ (for example, the `standard` tier can display as "Starter"). <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-001 AC1: exactly 8 tier IDs exist with the canonical names) --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-001 AC4: renamed display labels preserve canonical selection identifiers) -->

**Constraints:**

- The shipped table has one default flag, used for tier-configuration lookup rather than identity admission. A missing identity tier follows [REQ-SUB-011](#req-sub-011-graceful-degradation-without-stripe).
- In SaaS, `blocked` and `pending` visitors may authenticate and see their subscription status. Both are denied active application APIs; `blocked` also cannot activate a plan. <!-- @impl: src/routes/github-auth.ts::app --> <!-- @impl: src/middleware/auth.ts::requireActiveUser -->

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated: [subscription-req-sub-gaps.test.ts](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts), [subscription.test.ts](../../src/__tests__/lib/subscription.test.ts)

**Status:** Implemented

---

### REQ-SUB-002: Tier Property Definitions

**Intent:** Each tier must define a complete set of properties that drive quota enforcement, session limits, mode gating, and pricing.

**Applies To:** User

**Acceptance Criteria:**

1. An unset monthly compute allotment means unlimited compute. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-002 AC1: unlimited monthlySeconds=null (unlimited)) -->
2. An unset storage cap means unlimited storage. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-002 AC2: unlimited maxStorageBytes=null (unlimited)) --> <!-- @test: src/__tests__/routes/session-public-d1.test.ts (REQ-SUB-002 AC2: unlimited storage admits creation despite high cached usage) -->
3. The allowed session-modes field is a list of mode identifiers drawn from the supported set. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-002 AC3: standard/advanced/max/unlimited sessionModes=[default,advanced]) -->

**Notes:** Concrete per-tier values (hours/month, max sessions, modes, storage, canLogin) are documented in [Subscription Tiers](../../documentation/lanes/billing.md#subscription-tiers).

**Constraints:**

- Administration edits the operational fields exposed by its panel, not the blocked/pending system tiers or Custom's fixed compute/storage controls.
- Checkout uses the configured Stripe Price. Displayed prices prefer provider values and may fall back to saved numeric prices.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated: [subscription-req-sub-gaps.test.ts](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts), [session-public-d1.test.ts](../../src/__tests__/routes/session-public-d1.test.ts)

**Status:** Implemented

---

### REQ-SUB-003: Free Tier Requires No Payment

**Intent:** Users must be able to use the platform at the free tier without providing payment information.

**Applies To:** User

**Acceptance Criteria:**

1. An admitted Free signup activates directly without payment-provider interaction. New Free signups remain subject to the paid-slot capacity gate under [AD39](../../documentation/decisions/README.md#ad39-max-users-capacity-cap-counts-paid-slots-only). <!-- @impl: src/routes/auth.ts::app --> <!-- @manual -->
2. The free tier has a zero monthly price. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription.test.ts (getDefaultTiers / REQ-SUB-001 AC1/AC2 (8 default tiers in canonical order) / REQ-SUB-003 (free tier requires no payment)) -->
3. Even when the payment provider is configured, the free tier still bypasses external checkout. <!-- @impl: src/routes/auth.ts::app --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (allows free tier even when STRIPE_SECRET_KEY is set) --> <!-- @manual -->
4. Free-tier activation removes all provider-owned billing-state fields while preserving unrelated user fields; persisted records contain no `undefined` patch values. <!-- @impl: src/routes/auth.ts::default --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-18-001/004: payment-less activation removes stale billing state without undefined values) -->

**Constraints:**

- Free users do not occupy paid slots, but a full positive cap can block a new Free signup. <!-- @impl: src/lib/subscription.ts::countPaidSlots --> <!-- @test: src/__tests__/lib/subscription.test.ts (excludes free, pending, and blocked users) -->
- Free uses the common idle preference and one-hour default under [REQ-SESSION-014](session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings).
- Free defaults to one concurrent session. Start uses the configured tier cap and best-effort admission under [REQ-SESSION-007](session-lifecycle.md#req-session-007-running-session-count-limited-per-tier).

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated: [subscription.test.ts](../../src/__tests__/lib/subscription.test.ts), [auth-subscribe.test.ts](../../src/__tests__/routes/auth-subscribe.test.ts); Manual: [Direct activation and tier acceptance](../../documentation/lanes/billing.md#direct-activation-and-tier-acceptance)

**Status:** Implemented

---

### REQ-SUB-004: Paid Tiers Integrate with Stripe Checkout

**Intent:** Paid tiers (standard, advanced, max) must collect payment via Stripe before activating the subscription.

**Applies To:** User

**Acceptance Criteria:**

1. When the payment provider is configured, the direct-subscribe endpoint rejects paid tiers with a clear "checkout required" error; only the free tier remains directly subscribable. <!-- @impl: src/routes/auth.ts::isStripeConfigured --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (POST /auth/subscribe) -->
2. The checkout endpoint creates a hosted checkout session pre-populated with the visitor's email and the tier/mode metadata, and returns the externally-hosted checkout URL. <!-- @impl: src/lib/stripe.ts::createCheckoutSession --> <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/checkout / REQ-SUB-020 (multi-currency pricing from CF-IPCountry) / REQ-SUB-004 (Stripe checkout session creation)) -->
3. After payment, the provider sends a checkout-completed webhook under [REQ-SUB-035](#req-sub-035-signed-billing-webhook-lifecycle) that records the checkout outcome and triggers authoritative state sync. <!-- @impl: src/routes/stripe-webhook.ts::handleCheckoutCompleted --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->
4. The frontend polls the auth-status endpoint after the checkout redirect on a fixed interval with no bounded total wait (the poll has no deadline and continues until activation is observed) so subscription activation feels immediate to the user. <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SUB-004 AC4: post-checkout activation polling) --> <!-- @manual -->

**Constraints:**

- Keep tier metadata on Stripe Prices; an absent snapshot tier preserves the stored tier. Mode metadata takes precedence; when absent, the configured Standard/Pro Price slot can supply the mode without inferring a tier. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->
- When Stripe is configured, the tier-list endpoint keeps Custom and choices configured with a zero monthly price visible without an external price ID. Other choices need a Standard Price ID to appear. Payment-free direct choices without Stripe follow [REQ-SUB-011](#req-sub-011-graceful-degradation-without-stripe). <!-- @impl: src/routes/auth.ts::app -->
- Record the customer-to-email mapping at checkout completion for user resolution by subsequent webhooks.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-003](#req-sub-003-free-tier-requires-no-payment)

**Verification:** Automated: [auth-subscribe.test.ts](../../src/__tests__/routes/auth-subscribe.test.ts), [billing.test.ts](../../src/__tests__/routes/billing.test.ts), [stripe-webhook.test.ts](../../src/__tests__/routes/stripe-webhook.test.ts), [SubscribePage.test.tsx](../../web-ui/src/__tests__/components/SubscribePage.test.tsx); Manual: [Checkout and provider lifecycle acceptance](../../documentation/lanes/billing.md#checkout-and-provider-lifecycle-acceptance)

**Status:** Implemented

---

### REQ-SUB-035: Signed billing webhook lifecycle

**Intent:** Public Stripe event intake verifies authenticity and suppresses known successful replay without claiming exactly-once delivery.

**Applies To:** User

**Acceptance Criteria:**

1. The webhook handler covers the three relevant lifecycle events: checkout completion, subscription update, and subscription deletion. <!-- @test: src/__tests__/routes/billing.test.ts (POST /public/stripe/webhook) --> <!-- @manual -->
2. The webhook endpoint is publicly reachable but enforces signed-payload verification with a short timestamp tolerance. <!-- @impl: src/lib/stripe.ts::verifyWebhookSignature --> <!-- @test: src/__tests__/lib/stripe.test.ts (rejects missing timestamp) -->
3. Successful webhook handling records the event ID for 72 hours. A visible marker suppresses replay; concurrent delivery or propagation lag can still cause reprocessing. <!-- @impl: src/routes/stripe-webhook.ts::app --> <!-- @test: src/__tests__/routes/billing.test.ts (deduplicates visible successful events for 72 hours and leaves failed handling retryable) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: stale duplicate plus newer provider failure leaves checkout retryable until an apply succeeds) --> <!-- @manual -->

**Constraints:** Event-marker suppression is not a billing-wide exactly-once guarantee or an atomic KV/DO/provider transaction.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout)

**Verification:** Automated: [billing.test.ts](../../src/__tests__/routes/billing.test.ts), [stripe-webhook.test.ts](../../src/__tests__/routes/stripe-webhook.test.ts), [stripe.test.ts](../../src/__tests__/lib/stripe.test.ts); Manual: [Checkout provider lifecycle conditions](../../documentation/lanes/billing.md#checkout-provider-lifecycle-conditions)

**Status:** Implemented

---

### REQ-SUB-032: Checkout completion and replay

**Intent:** Checkout completion retains the authoritative subscription state and remains safe to retry after the webhook event marker expires.

**Applies To:** User

**Acceptance Criteria:**

1. Durable per-checkout receipts suppress checkout metadata and notice replay without the event marker's 72-hour expiry. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: checkout replay after visible marker expiry preserves date and sends no repeated notices) --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-SUB-004 AC7: checkout receipts suppress reapplication and retain subscription date/trial history) -->
2. Checkout metadata applies with the provider snapshot, preserving same-subscription date and trial history. Use the original provider creation timestamp when present; otherwise use the timestamp from the first processing attempt that successfully applies the checkout. <!-- @impl: src/routes/stripe-webhook.ts::handleCheckoutCompleted --> <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: stale duplicate plus newer provider failure leaves checkout retryable until an apply succeeds) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: checkout replay after visible marker expiry preserves date and sends no repeated notices) --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-SUB-004 AC7: checkout receipts suppress reapplication and retain subscription date/trial history) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-032 AC2: a timestamp-free checkout uses the successful retry time) -->
3. Stale updates or deletions for a different subscription, and timestamp-older replacement checkouts, cannot overwrite the current subscription. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: a replayed old checkout or deletion cannot reset a replacement subscription) --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-SUB-004 AC7: late deletion and update for a different subscription preserve current billing state) -->
4. Claim checkout notices before best-effort sending; interruption or provider failure can omit delivery. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @impl: src/routes/stripe-webhook.ts::handleCheckoutCompleted --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: checkout replay after visible marker expiry preserves date and sends no repeated notices) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (admin notification failure does not break the webhook) -->
5. An unavailable initial snapshot remains retryable without partial activation; a transient stale-token rejection remains retryable without writing a processed marker. Confirmed completed or permanently superseded checkouts are successful no-ops. <!-- @impl: src/routes/stripe-webhook.ts::handleCheckoutCompleted --> <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (returns 500 without checkout fields when fetchSubscription returns null) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: stale duplicate plus newer provider failure leaves checkout retryable until an apply succeeds) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: checkout replay after visible marker expiry preserves date and sends no repeated notices) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-004 AC7: a replayed old checkout or deletion cannot reset a replacement subscription) -->

**Notes:** Hosted inspection is documented under [Checkout provider lifecycle conditions](../../documentation/lanes/billing.md#checkout-provider-lifecycle-conditions).

**Constraints:** Checkout receipts do not guarantee billing-wide exactly-once side effects or an atomic KV/DO/provider transaction.

**Priority:** P1

**Dependencies:** [REQ-SUB-035](#req-sub-035-signed-billing-webhook-lifecycle), [REQ-SUB-015](#req-sub-015-stripe-webhook-signal-and-sync-pattern)

**Verification:** Automated: [stripe-webhook.test.ts](../../src/__tests__/routes/stripe-webhook.test.ts), [index.test.ts](../../src/__tests__/timekeeper/index.test.ts)

**Status:** Implemented

---

### REQ-SUB-005: Trial Is Compute-Based, Not Time-Based

**Intent:** Trial periods must be capped by actual compute usage, not calendar days, so that inactive users do not burn through their trial.

**Applies To:** User

**Acceptance Criteria:**

1. Each paid tier has an admin-configurable trial compute cap. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @test: src/__tests__/lib/subscription.test.ts (getDefaultTiers / REQ-SUB-001 AC1/AC2 (8 default tiers in canonical order) / REQ-SUB-003 (free tier requires no payment)) -->
2. Subscriptions are created with a maximum billing window so the trial cannot exceed a hard calendar limit even if the user never uses any compute. <!-- @impl: src/lib/stripe.ts::createCheckoutSession --> <!-- @test: src/__tests__/lib/stripe.test.ts (includes trial_period_days when trialDays is set) -->
3. Timekeeper enforces the trial compute cap as the active quota while the subscription is in trial state. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (ends the provider trial at its distinct trial cap before the monthly cap) -->
4. When the trial compute cap is consumed, Timekeeper ends the trial early at the payment provider, triggering the first real charge. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (ends the provider trial at its distinct trial cap before the monthly cap) -->
5. If the first charge succeeds, the full monthly compute quota unlocks. If payment produces `past_due`, paid access remains through a valid future `billingPeriodEnd`; an absent, invalid, or expired period end downgrades to free. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (past_due + future billingPeriodEnd keeps paid tier (grace period)) --> <!-- @test: src/__tests__/lib/subscription.test.ts (past_due + expired billingPeriodEnd downgrades to free) -->
6. Record trial use when a subscription transitions out of trial, including an accepted deletion of the same subscription while the stored state is trialing. A rejected deletion never changes trial history. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/timekeeper/index.ts::handleBillingSyncApply --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-005 AC6: deletion trial history follows the guarded subscription ($scenario)) -->

**Constraints:**

- Early trial termination uses an idempotency flag; session pings cannot issue duplicate provider calls.
- The webhook stale-write guard uses strict timestamp ordering; events sharing a second are not silently discarded.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated: [stripe.test.ts](../../src/__tests__/lib/stripe.test.ts), [subscription.test.ts](../../src/__tests__/lib/subscription.test.ts), [admin-tiers.test.ts](../../src/__tests__/routes/admin-tiers.test.ts), [stripe-webhook-sync.test.ts](../../src/__tests__/routes/stripe-webhook-sync.test.ts), [index.test.ts](../../src/__tests__/timekeeper/index.test.ts)

**Status:** Implemented

---

### REQ-SUB-006: Real-Time Usage Tracking via Timekeeper DO

**Intent:** Compute usage must be tracked accurately in real time so every user can monitor personal consumption and billed deployments can enforce current quotas.

**Applies To:** User

**Acceptance Criteria:**

1. Each user has exactly one authoritative in-flight usage accumulator. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
2. Healthy session metrics report cumulative usage to the owner's accumulator on the normal 60-second cadence in every deployment mode. Recovery probes, uncertain projections, and stopping ticks do not report usage. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SUB-006 AC2 + REQ-SUB-007 AC5: records usage outside SaaS without enforcing a quota response) -->
3. Timekeeper computes per-session deltas, accumulates pending usage in memory, and periodically flushes it to durable storage. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
4. Timekeeper returns current flushed daily and monthly KV usage plus pending usage. If the KV read fails, the response reports pending usage alone. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
5. The live KV serving record tracks daily, weekly, monthly, yearly, and all-time totals. Each flush credits its batch to the UTC periods current at flush time; the historical D1 projection is separate. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
6. A failed live KV flush requests a retry after 30 seconds without exponential backoff. An earlier shared alarm can attempt the flush sooner. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->
7. Pending usage is cleared only after a durable-storage write succeeds. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->

**Constraints:**

- Deployment and stress mode do not gate normal usage reports. SaaS quota enforcement is separate.
- Multiple concurrent sessions from the same user all ping the same Timekeeper instance.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [index.test.ts](../../src/__tests__/timekeeper/index.test.ts)

**Status:** Implemented

---

### REQ-SUB-007: Quota Enforcement at Session Start (402)

**Intent:** Users who have consumed their monthly compute quota must be prevented from starting new sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Before provisioning a container, Start compares the user's flushed current-month KV usage with the effective tier's compute allotment. Pending Timekeeper usage and historical D1 totals are not part of this comparison. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @manual: Match retained finite SaaS Start records and observed quota authority as described in the billing lane. -->
2. The comparison is skipped for tiers with no compute cap (unlimited). <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @manual: Match retained unlimited-tier Start records and observed quota authority as described in the billing lane. -->
3. When the recorded usage reaches or exceeds the allotment, Start returns HTTP 402 with `QUOTA_EXCEEDED`. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @manual: Match retained finite SaaS Start records and observed quota authority as described in the billing lane. -->
4. In SaaS mode, when the frontend's usage state has a positive monthly quota and usage reaches or exceeds it, Layout displays a non-dismissible quota-exceeded banner with an upgrade link to `/app/subscribe`; this banner is absent outside SaaS mode. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/stores/session-usage.ts::getUsageWarningLevel --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (offers the subscription upgrade from the SaaS quota-exceeded banner) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (AC3: surfaces no usage banner outside SaaS mode even at 100% usage) -->
5. Quota enforcement is skipped in non-billed deployment modes and in stress-test mode. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-SUB-007 AC5 + REQ-SUB-022 AC1: accumulates the durable monthly total without enforcing quota outside SaaS) --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-ENTERPRISE-001 AC3: enterprise users are never blocked by the monthly compute quota) -->
6. A live usage KV read failure skips the quota check. D1 session-authority failure still fails Start closed. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC5: unavailable D1 rejects admission without changing durable authority) --> <!-- @manual: Match retained finite SaaS Start records and observed quota authority as described in the billing lane. -->

**Constraints:**

- The quota check uses the effective tier after billing-status downgrades, never the stored tier.
- Quota exhaustion returns 402, not 403.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated: [index.test.ts](../../src/__tests__/timekeeper/index.test.ts), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [container-lifecycle-helpers.test.ts](../../src/__tests__/routes/container-lifecycle-helpers.test.ts), [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts); Manual: [Session-start quota gate](../../documentation/lanes/billing.md#session-start-quota-gate)

**Status:** Implemented

---

### REQ-SUB-008: Mid-Session Quota Enforcement (Graceful Stop)

**Intent:** Sessions that exceed quota while running must be stopped gracefully, not left running indefinitely.

**Applies To:** User

**Acceptance Criteria:**

1. When Timekeeper's ping response indicates the user has exceeded quota, the Container DO initiates a graceful stop rather than a hard kill. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SUB-008 AC1: calls stop("SIGTERM") when Timekeeper /ping returns quotaExceeded=true) -->
2. Quota stop attempts the bounded agent-event drain and authenticated final sync before SIGTERM. A failed or timed-out sync does not prevent stop; the signal handler is only a best-effort backstop. <!-- @impl: src/container/container-metrics.ts::collectMetrics --> <!-- @test: src/__tests__/container-metrics.test.ts (REQ-SESSION-011 AC6 / REQ-SESSION-032 AC1: quota-stop drains final agent events, then final sync, then stop) -->
3. The ping response carries both the cumulative monthly usage and the quota-exceeded flag in a single round trip. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO / REQ-SUB-008 (activity-based usage tracking via Timekeeper DO) / REQ-SUB-006 (real-time usage tracking: /ping increments seconds, /usage reads, alarm flushes to KV) / REQ-SUB-007 (quota enforcement: 402 returned when /ping detects over-quota mid-session)) -->

**Constraints:**

- Final-sync order and deadline follow [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync).
- Check quota on each ping cycle, not continuously.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-007](#req-sub-007-quota-enforcement-at-session-start-402)

**Verification:** Automated: [container-metrics.test.ts](../../src/__tests__/container-metrics.test.ts), [index.test.ts](../../src/__tests__/timekeeper/index.test.ts)

**Status:** Implemented

---

<a id="req-sub-009-admin-tier-management"></a>
### REQ-SUB-009: Admin-Configurable Tiers via Management Panel

**Intent:** Administrators must be able to customize tier properties (quotas, prices, sessions, storage) without code changes.

**Applies To:** Admin

**Acceptance Criteria:**

1. The admin tier-update endpoint accepts a full tier-configuration array and persists it to durable storage. <!-- @test: src/__tests__/routes/admin-tiers.test.ts (REQ-SUB-009 AC1: writes accepted tier array to tiers:config KV key) --> <!-- @manual -->
2. Subscription Management edits only persisted operational limits, descriptions, allowed modes, and external price IDs; identity, policy, ordering, defaults, and provider prices remain read-only. <!-- @impl: web-ui/src/components/admin/SubscriptionManagement.tsx::SubscriptionManagement --> <!-- @test: web-ui/src/__tests__/components/admin/SubscriptionManagement.test.tsx (SubscriptionManagement (Admin)) --> <!-- @test: web-ui/src/__tests__/components/admin/SubscriptionManagement.test.tsx (REQ-SUB-009 AC2: saves changed operational fields and reads them back without changing protected tier fields) -->
3. Tier-configuration reads return the persisted admin configuration when present and fall back to the hardcoded defaults when absent. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-009: getTierConfig KV-first with default fallback) -->
4. Admin-saved values always take priority over defaults; absent fields fall back to defaults, present fields override. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-009: getTierConfig KV-first with default fallback) -->
5. The admin tier-update endpoint validates and preserves every field in the current tier schema. Fields outside that schema are not persisted by the update. <!-- @impl: src/routes/admin/tiers.ts::PutTiersBodySchema --> <!-- @test: src/__tests__/routes/admin-tiers.test.ts (PUT /admin/tiers — REQ-SUB-009) --> <!-- @test: src/__tests__/routes/admin-tiers.test.ts (REQ-SUB-009 AC5: saves and reads back every configurable tier field without dropping values) -->
6. All tier-management endpoints are admin-gated. <!-- @test: src/__tests__/routes/admin-tiers.test.ts (REQ-SUB-009 AC6: returns 403 when user is not admin) --> <!-- @manual -->

**Constraints:**

- All tier changes require the admin role, enforced after the user is confirmed active.
- New fields added to defaults backfill automatically for deployments with pre-existing tier records.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** Automated: [admin-tiers.test.ts](../../src/__tests__/routes/admin-tiers.test.ts), [SubscriptionManagement.test.tsx](../../web-ui/src/__tests__/components/admin/SubscriptionManagement.test.tsx), [subscription-req-sub-gaps.test.ts](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts); Manual: [Direct activation and tier acceptance](../../documentation/lanes/billing.md#direct-activation-and-tier-acceptance)

**Status:** Implemented

---

### REQ-SUB-010: Tier Config Cached with 60-Second TTL

**Intent:** Tier configuration reads must be fast (avoid KV round-trip on every request) while refreshing each isolate's cached configuration after its TTL, independently of KV propagation.

**Applies To:** User

**Acceptance Criteria:**

1. Tier-configuration reads are served from an in-process cache with a short TTL. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription.test.ts (getTierConfig / REQ-SUB-010 (tier config cached with 60-second TTL; KV-fallback-to-defaults; resetTierConfigCache busts the cache)) -->
2. Within the TTL window, calls return the cached value without a durable-storage read. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-010 AC1/AC2: second call within TTL window returns cached config without KV read) -->
3. After the TTL expires, the next call refreshes the cache from durable storage. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription.test.ts (getTierConfig / REQ-SUB-010 (tier config cached with 60-second TTL; KV-fallback-to-defaults; resetTierConfigCache busts the cache)) -->
4. After the local tier-configuration cache is reset, the next lookup refreshes from durable storage instead of returning the previously cached configuration. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-010 AC4: next lookup returns updated tier values after local cache reset) -->
5. Each Worker isolate refreshes its tier configuration on the first lookup after its own 60-second cache TTL expires. Visibility of admin changes also depends on KV propagation; the local TTL is not a global cross-isolate propagation deadline. <!-- @impl: src/lib/subscription.ts::getTierConfig --> <!-- @test: src/__tests__/lib/subscription.test.ts (getTierConfig / REQ-SUB-010 (tier config cached with 60-second TTL; KV-fallback-to-defaults; resetTierConfigCache busts the cache)) -->

**Notes:** `resetTierConfigCache()` clears the local cache for deterministic tests or known configuration changes; it is a supporting mechanism, not a user-facing feature. Local cache tests do not certify hosted KV propagation or change independent authentication and revocation guarantees.

**Constraints:**

- Each Worker isolate maintains its own cache; there is no cross-isolate invalidation.
- The TTL is per-isolate, not globally synchronized.

**Priority:** P1

**Dependencies:** [REQ-SUB-009](#req-sub-009-admin-configurable-tiers-via-management-panel)

**Verification:** Automated: [subscription-req-sub-gaps.test.ts](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts), [subscription.test.ts](../../src/__tests__/lib/subscription.test.ts)

**Status:** Implemented

---

### REQ-SUB-011: Graceful Degradation Without Stripe

**Intent:** The platform must function without Stripe for development, self-hosted, and non-SaaS deployments.

**Applies To:** User

**Acceptance Criteria:**

1. When the payment provider is not configured, all selectable subscription tiers can be activated via the direct-subscribe endpoint without an external payment step. <!-- @impl: src/routes/auth.ts::app --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=free) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=standard) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=max) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=unlimited) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=advanced (now a subscribable tier)) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (sets subscriptionTier on user KV record) --> <!-- @manual -->
2. Payment-less activation removes all provider-owned billing-state fields while preserving unrelated user fields; persisted records contain no `undefined` patch values. <!-- @impl: src/routes/auth.ts::default --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (DEEP-18-001/004: payment-less activation removes stale billing state without undefined values) -->
3. The effective-tier resolver does not downgrade paid tiers when billing fields are absent and the payment provider is not configured. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-011 AC3: getEffectiveTier does not downgrade paid tier when billingStatus is null) -->
4. Without a configured provider, the subscribe page presents selectable non-contact tiers as payment-free direct choices, even with saved positive prices or provider price identifiers; Custom/contact retains its contact CTA. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage --> <!-- @test: web-ui/src/__tests__/components/SubscribePage.test.tsx (REQ-SUB-011 AC4: payment-free tier projection activates directly despite retained Stripe price identifiers) -->
5. Without a configured provider, the API projects zero displayed mode prices without mutating stored administration prices or identifiers. <!-- @impl: src/routes/auth.ts::app --> <!-- @test: src/__tests__/routes/auth.test.ts (REQ-SUB-011 AC1/4: stored positive prices without provider produce payment-free selectable comparisons, without changing configuration) -->

**Constraints:**

- Raw effective-tier inputs missing both `subscriptionTier` and legacy `accessTier` fall back to `pending`, even without billing fields, except for the Enterprise override.
- Identity resolution can normalize legacy records before the middleware resolves effective tier; missing persisted tier fields do not necessarily make an existing identity pending.
- A legacy access-tier field is preserved alongside the subscription tier; resolution prefers the new field and falls back to the legacy one.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated: [auth.test.ts](../../src/__tests__/routes/auth.test.ts), [SubscribePage.test.tsx](../../web-ui/src/__tests__/components/SubscribePage.test.tsx), [stripe.test.ts](../../src/__tests__/lib/stripe.test.ts), [auth-subscribe.test.ts](../../src/__tests__/routes/auth-subscribe.test.ts), [subscription-req-sub-gaps.test.ts](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts); Manual: [Direct activation and tier acceptance](../../documentation/lanes/billing.md#direct-activation-and-tier-acceptance)

**Status:** Implemented

---

### REQ-SUB-012: Billing Status Enforcement (Effective Tier)

**Intent:** A user's effective tier must reflect their current billing state, automatically downgrading when payment lapses.

**Applies To:** User

**Acceptance Criteria:**

1. A single resolver combines the user's subscription tier, the legacy access-tier field, and the current billing state into the canonical effective tier. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (returns paid tier when billing is active) --> <!-- @test: src/__tests__/lib/subscription.test.ts (falls back to accessTier when subscriptionTier undefined) --> <!-- @test: src/__tests__/lib/subscription.test.ts (falls back to pending when both tiers undefined) -->
2. A canceled billing state results in an immediate downgrade to the free tier with no grace period. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
3. A past-due billing state with a future billing-period end retains the paid tier for the duration of the grace window. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
4. A past-due billing state with an expired or absent billing-period end downgrades to the free tier. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
5. An expired billing-period end with an otherwise-active billing state downgrades to the free tier so missed webhooks do not leave paid access stuck open. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
6. The stored subscription tier is preserved through downgrades so resubscription restores the correct plan without admin intervention. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->
7. Tier enforcement is read-time (computed on access), not write-time (the stored tier is not mutated by the enforcement path). <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier / REQ-SUB-012 (billing status enforcement: subscriptionTier clamped by billingStatus, canceled/past_due demotes paid to free)) -->

**Constraints:**

- Free, unlimited, pending, and blocked tiers are exempt from billing-driven downgrades.
- Billing-state comparisons use typed constants, not raw string literals; a renamed status value must fail compilation.
- The billing-status vocabulary is closed: active, trialing, past-due, canceled.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout)

**Verification:** Automated: [subscription.test.ts](../../src/__tests__/lib/subscription.test.ts)

**Status:** Implemented

---

### REQ-SUB-013: Concurrent Session Limits

**Intent:** Each tier exposes a maximum used by a best-effort start-time admission check to control resource consumption.

**Applies To:** User

**Acceptance Criteria:**

1. The tier-configuration lookup exposes the maximum-concurrent-sessions value for any tier. <!-- @impl: src/lib/subscription.ts::getUserTier --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (Session limits / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN with env overrides) / REQ-SEC-019 AC2 (per-user concurrent session caps)) -->
2. A start request is rejected when its observed count of other D1-owned sessions in `starting`, `running`, `unreachable` or `stopping` reaches the configured maximum, excluding the session being started. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (REQ-SESSION-007: actual D1-backed capacity outcomes) --> <!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (DEEP-18-005: running and initializing sessions consume capacity) -->
3. At the session limit, the frontend shows the limit popup instead of opening the create dialog ([REQ-SUB-019](#req-sub-019-session-limit-popup-in-frontend)). <!-- @impl: web-ui/src/stores/session.ts::isAtSessionLimit --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-SUB-013 AC3 / REQ-SUB-019: shows limit feedback without opening the create dialog) -->
4. Ancillary session status returns the tier maximum so the frontend can apply the same best-effort limit client-side without a separate entitlement fetch. <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (Container lifecycle extracted helpers / REQ-SESSION-007 (validateSessionAndCheckLimits enforces per-tier MAX_SESSIONS at session start) / REQ-SUB-013 (concurrent session caps from MAX_SESSIONS_USER/MAX_SESSIONS_ADMIN)) --> <!-- @manual -->
5. The check is not an atomic reservation: simultaneous starts may both observe available capacity and exceed the nominal limit. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (REQ-SESSION-007 AC6 / REQ-SUB-013 AC5: simultaneous starts can exceed the best-effort limit) -->

**Constraints:**

- The session-limit check uses the effective tier (after billing-status downgrades), not the stored tier.
- Stress-test mode bypasses session limits.
- Best-effort concurrency semantics follow [REQ-SESSION-007](session-lifecycle.md#req-session-007-running-session-count-limited-per-tier).

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated: [container-lifecycle.test.ts](../../src/__tests__/routes/container-lifecycle.test.ts), [session-authority-outcomes.test.ts](../../src/__tests__/lib/session-authority-outcomes.test.ts), [subscription-req-sub-gaps.test.ts](../../src/__tests__/lib/subscription-req-sub-gaps.test.ts), [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx), [container-lifecycle-helpers.test.ts](../../src/__tests__/routes/container-lifecycle-helpers.test.ts); Manual: [Direct activation and tier acceptance](../../documentation/lanes/billing.md#direct-activation-and-tier-acceptance)

**Status:** Implemented

---

### REQ-SUB-014: Session Mode Gating by Tier

**Intent:** Only tiers that include Pro (advanced) mode in their `sessionModes` array may create Pro sessions.

**Applies To:** User

**Acceptance Criteria:**

1. The tier-configuration lookup exposes the list of session modes allowed for any tier. <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes --> <!-- @manual -->
2. By default, free and trial tiers only allow Standard mode. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes --> <!-- @manual -->
3. By default, standard, advanced, max, and unlimited tiers allow both Standard and Pro modes. <!-- @impl: src/lib/subscription.ts::getDefaultTiers --> <!-- @impl: src/lib/subscription.ts::getAllowedSessionModes --> <!-- @manual -->
4. Explicit preference mode changes that the tier does not allow are rejected. <!-- @manual -->
5. Container startup clamps an unsupported stored mode to the tier's allowed default so stale preferences cannot retain advanced entitlement. <!-- @impl: src/lib/session-mode.ts::clampSessionModeToTier --> <!-- @impl: src/routes/container/lifecycle.ts::startOrRestartContainer --> <!-- @manual -->
6. Non-admin SaaS Settings uses the canonical allowed-mode list for Pro availability rather than subscription metadata; missing or failed availability stays unavailable. <!-- @impl: web-ui/src/components/SettingsPanel.tsx::canUseAdvanced --> <!-- @test: web-ui/src/__tests__/components/SettingsPanel.test.tsx (REQ-SUB-014: Pro availability follows allowedModes, not $metadata metadata ($enabled)) --> <!-- @test: web-ui/src/__tests__/components/preferences-hydration.test.tsx (REQ-SUB-014: real user parsing enables entitled default metadata, then denies revoked stale Advanced on reopen) -->

**Constraints:**

- In SaaS mode, the effective session mode is the saved preference (Standard when absent), clamped to the effective tier's allowed modes.
- The user record's `subscribedMode` is distinct provider/admin subscription metadata, not sole authority for Pro access; non-SaaS and enterprise mode resolution remain unchanged.
- Just-in-time provisioned users default to Standard mode.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-009](#req-sub-009-admin-configurable-tiers-via-management-panel), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** Automated: [SettingsPanel.test.tsx](../../web-ui/src/__tests__/components/SettingsPanel.test.tsx), [preferences-hydration.test.tsx](../../web-ui/src/__tests__/components/preferences-hydration.test.tsx); Manual: [Direct activation and tier acceptance](../../documentation/lanes/billing.md#direct-activation-and-tier-acceptance)

**Status:** Implemented

---

### REQ-SUB-015: Stripe Webhook Signal-and-Sync Pattern

**Intent:** KV billing state must always reflect the latest Stripe state to prevent race conditions from incremental patching.

**Applies To:** User

**Acceptance Criteria:**

1. Webhooks are treated as signals that trigger a fresh fetch from the payment provider, not as the authoritative data source themselves. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->
2. The state-sync routine fetches the latest subscription (with price items expanded) directly from the payment provider. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->
3. Subscription updates and terminations are ordered per user so a later-started termination atomically clears billing fields, applies canceled/free/default state, and prevents an older in-flight update from restoring entitlements. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/routes/stripe-webhook.ts::handleSubscriptionDeleted --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (DEEP-22-002: an older in-flight provider result cannot overwrite a later-started sync) --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (serializes a newer sync while an older apply is delayed after its guard) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-SUB-015 AC3: a deletion prevents an older in-flight update from restoring entitlements) --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-SUB-015 AC3: canceled/free cleanup rejects an older paid apply) -->
4. Persisted updates are built from the fetched snapshot; the persisted tier is updated only when price tier-metadata is present, so absent metadata preserves the existing tier. Mode changes follow [REQ-SUB-034](#req-sub-034-subscription-driven-agent-configuration). <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState) -->
5. The Timekeeper checks the synchronization token and applies the update as one serialized operation, preserving unrelated user fields and never storing undefined patch values. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState) -->

**Constraints:** Sync ordering uses per-user monotonic tokens, including for starts in the same millisecond.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated: [stripe-webhook-sync.test.ts](../../src/__tests__/routes/stripe-webhook-sync.test.ts), [stripe-webhook.test.ts](../../src/__tests__/routes/stripe-webhook.test.ts), [index.test.ts](../../src/__tests__/timekeeper/index.test.ts)

**Status:** Implemented

---

### REQ-SUB-034: Subscription-driven agent configuration

**Intent:** Actual subscription mode transitions reconcile the agent environment without turning a scheduled cancellation into an early downgrade.

**Applies To:** User

**Acceptance Criteria:**

1. On a subscribed-mode change, reconcile the permitted selected mode's agent configs with overwrite and cleanup, then persist that mode as the session preference. On promotion preserve an explicit Standard selection; an unset preference takes the newly subscribed mode. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (calls reconcileAgentConfigs when mode changes from advanced to default) --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (REQ-AGENT-004: promotion preserves explicit %s preference while granting Pro) -->
2. On subscription termination, after resetting the persisted tier to free, the agent-config reconciler runs with the default mode to restore Standard configs. <!-- @impl: src/routes/stripe-webhook.ts::handleSubscriptionDeleted --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->

**Constraints:**

- Auto-reconcile failure is non-fatal: a reconciliation error does not block the webhook from acknowledging.
- Scheduled cancellation does not trigger termination reconciliation; retain Pro configuration through the paid period.

**Priority:** P1

**Dependencies:** [REQ-SUB-015](#req-sub-015-stripe-webhook-signal-and-sync-pattern)

**Verification:** Automated: [stripe-webhook.test.ts](../../src/__tests__/routes/stripe-webhook.test.ts)

**Status:** Implemented

---

### REQ-SUB-016: Customer Portal and Plan Switching

**Intent:** Active subscribers must be able to manage their subscription (cancel, switch plans, update payment) via Stripe's billing portal.

**Applies To:** User

**Acceptance Criteria:**

1. The billing-portal endpoint creates a hosted billing-portal session and returns the portal URL. <!-- @impl: src/lib/stripe.ts::createPortalSession --> <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/portal / REQ-SUB-016 (Stripe customer portal for cancel/payment-method)) -->
2. The plan-switch endpoint creates a portal session deep-linked into the subscription-update-confirmation flow with the new price pre-selected. <!-- @test: src/__tests__/lib/stripe.test.ts (CF-022: Stripe response validation) --> <!-- @manual --> <!-- @test: src/__tests__/lib/stripe.test.ts (REQ-SUB-016: sends the selected subscription item and price to the confirmation flow) -->
3. Plan switching requires the active subscription-item identifier, which the switch endpoint resolves from the payment provider before opening the portal session. <!-- @impl: src/routes/billing.ts::SwitchSchema --> <!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/switch) -->
4. If the subscription no longer exists at the payment provider, all provider-owned identifiers and billing fields are removed locally without storing `undefined`, identity fields are preserved, and the response asks the frontend to restart at checkout. <!-- @impl: src/routes/billing.ts::default --> <!-- @test: src/__tests__/routes/billing.test.ts (returns nulls and cleans KV when subscription is gone from Stripe) -->
5. Plan changes trigger the subscription-updated webhook which the state-sync routine picks up to update the persisted record. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 (Stripe webhook syncs subscription state) / REQ-SUB-015 (webhook handlers for updated/deleted/canceled)) -->
6. The portal endpoint requires an authenticated user with an associated payment-provider customer record and is rate-limited. <!-- @test: src/__tests__/routes/billing.test.ts (REQ-SUB-016 AC6: portal endpoint is rate-limited to 5 requests per minute per user) --> <!-- @manual -->

**Constraints:**

- Users compare plans on the in-product subscribe page (rich UI) and only see the payment provider for payment confirmation.
- The billing-status verification endpoint queries the payment provider as the source of truth and falls back to the persisted record when the provider is unreachable.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated: [billing.test.ts](../../src/__tests__/routes/billing.test.ts), [stripe.test.ts](../../src/__tests__/lib/stripe.test.ts), [stripe-webhook.test.ts](../../src/__tests__/routes/stripe-webhook.test.ts); Manual: [Checkout and provider lifecycle acceptance](../../documentation/lanes/billing.md#checkout-and-provider-lifecycle-acceptance)

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
- The inquiry payload includes the user's email and selected tier for the recipient.

**Priority:** P2

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated: [contact-team.test.ts](../../src/__tests__/routes/contact-team.test.ts), [SubscribePage.test.tsx](../../web-ui/src/__tests__/components/SubscribePage.test.tsx)

**Status:** Implemented

---

<a id="req-sub-018-usage-dashboard-page"></a>
### REQ-SUB-018: Monthly quota warning banners

**Intent:** Users with a billed compute quota receive actionable threshold warnings outside the Usage page.

**Applies To:** User

**Acceptance Criteria:**

1. Layout-level warning banners surface at the 80%, 95%, and 100% utilization thresholds. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-SUB-018 AC3/AC6 (usage quota banners)) -->
2. The 80% and 95% banners include a dismiss control that hides the banner until the next monthly quota rollover; dismissal is persisted per calendar month so a page reload does not resurface the warning, and the warning returns automatically when the quota resets. <!-- @impl: web-ui/src/stores/session-usage.ts::setDismissedQuotaLevel --> <!-- @test: web-ui/src/__tests__/stores/session-usage.test.ts (session-usage dismissed quota level / REQ-SUB-018 (usage banner dismiss persistence per UTC month)) -->
3. Dismissing the 95% banner also hides the 80% banner. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-SUB-018 AC5: a dismissed 95% warning also hides the lower 80% warning) -->
4. The 100% quota-exceeded banner is not dismissible. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (AC6: the 80% and 95% banners carry a dismiss control; the 100% banner does not) -->

**Constraints:** Banners project quota state; server-side start admission remains authoritative.

**Priority:** P2

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated: [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [session-usage.test.ts](../../web-ui/src/__tests__/stores/session-usage.test.ts)

**Status:** Implemented

---

### REQ-SUB-033: Usage dashboard page

**Intent:** Users with a billed compute quota can see current utilization alongside their plan context.

**Applies To:** User

**Acceptance Criteria:**

1. When the usage response carries a monthly quota, the page renders the quota stat and progress bar. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage --> <!-- @test: web-ui/src/__tests__/components/UsagePage.test.tsx (UsagePage / REQ-SUB-018 AC1 / REQ-SUB-022 AC4 (usage stat and quota rendering)) -->
2. The page polls the usage endpoint and renders the returned usage data. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage --> <!-- @test: web-ui/src/__tests__/components/UsagePage.test.tsx (REQ-SUB-018 AC2: polling refreshes the displayed usage at the next interval) -->
3. The page shows a centered tier-and-mode label only for metered SaaS plans; non-SaaS and custom unmetered plans show usage time without a plan label. <!-- @impl: web-ui/src/components/UsagePage.tsx::UsagePage --> <!-- @test: web-ui/src/__tests__/components/UsagePage.test.tsx (UsagePage / REQ-SUB-018 AC1 / REQ-SUB-022 AC4 (usage stat and quota rendering)) -->

**Constraints:** The page accepts live or fallback values from [REQ-SUB-022](#req-sub-022-cross-mode-personal-usage-data), which also owns non-SaaS visibility; account-menu actions are owned by [REQ-SUB-023](#req-sub-023-deployment-mode-account-actions).

**Priority:** P2

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated: [UsagePage.test.tsx](../../web-ui/src/__tests__/components/UsagePage.test.tsx)

**Status:** Implemented

---

### REQ-SUB-019: Session limit popup in frontend

**Intent:** Users understand why they can't start more sessions and which ones to stop.

**Applies To:** User

**Acceptance Criteria:**

1. When the count of running plus initializing sessions reaches the tier maximum, the "New Session" control stays enabled but diverts to the session-limit popup instead of starting a session. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) -->
2. The popup explains the tier limit, showing the running-session count and a progress bar, with a dismiss control; it does not list individual sessions with per-session stop controls. <!-- @impl: web-ui/src/components/SessionLimitPopup.tsx::SessionLimitPopup --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) --> <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (REQ-SUB-019 AC2: the real limit popup shows counts and progress and dismisses without per-session actions) -->
3. The authoritative session-status flow supplies the tier maximum so the frontend and backend agree without a separate entitlement-only request. <!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 (session limit popup in frontend)) --> <!-- @manual -->

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-013](#req-sub-013-concurrent-session-limits)

**Verification:** Automated: [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx); Manual: [Direct activation and tier acceptance](../../documentation/lanes/billing.md#direct-activation-and-tier-acceptance)

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

**Verification:** Automated: [currency.test.ts](../../src/__tests__/lib/currency.test.ts), [stripe.test.ts](../../src/__tests__/lib/stripe.test.ts), [auth.test.ts](../../src/__tests__/routes/auth.test.ts), [billing.test.ts](../../src/__tests__/routes/billing.test.ts)

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

**Verification:** Automated: [billing.test.ts](../../src/__tests__/routes/billing.test.ts), [index.test.ts](../../src/__tests__/timekeeper/index.test.ts); Manual: [Checkout and provider lifecycle acceptance](../../documentation/lanes/billing.md#checkout-and-provider-lifecycle-acceptance)

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
5. The usage endpoint prefers live Timekeeper totals and falls back to durable usage when Timekeeper is unavailable. <!-- @impl: src/routes/usage.ts::app --> <!-- @test: src/__tests__/routes/usage.test.ts (falls back to KV record when Timekeeper DO returns non-200) --> <!-- @test: src/__tests__/routes/usage.test.ts (falls back to KV when TIMEKEEPER binding is absent) -->

**Constraints:** Usage recording and display do not authorize quota, trial, or billing enforcement outside SaaS mode.

**Priority:** P1

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated: [index.test.ts](../../src/__tests__/timekeeper/index.test.ts), [usage.test.ts](../../src/__tests__/routes/usage.test.ts), [UsagePage.test.tsx](../../web-ui/src/__tests__/components/UsagePage.test.tsx)

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

**Verification:** Automated: [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx), [Dashboard.test.tsx](../../web-ui/src/__tests__/components/Dashboard.test.tsx)

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

**Dependencies:** [REQ-SUB-033](#req-sub-033-usage-dashboard-page)

**Verification:** Automated: [SubscribePage.test.tsx](../../web-ui/src/__tests__/components/SubscribePage.test.tsx)

**Status:** Implemented

---

### REQ-SUB-025: Durable historical usage accounting

**Intent:** Organization analytics needs historical period data without moving live quota authority out of Timekeeper and KV.

**Applies To:** System

**Acceptance Criteria:**

1. Each positive Timekeeper delta updates durable UTC day, ISO week, UTC month, and UTC year accumulators and counts each distinct positive-runtime session once per period. <!-- @impl: src/timekeeper/accounting.ts::applyPositiveDelta --> <!-- @test: src/__tests__/timekeeper/accounting.test.ts (AccountingStateV2 (REQ-SUB-025)) --> <!-- @test: src/__tests__/timekeeper/accounting-integration.test.ts (REQ-SUB-025 AC1/2: failed commit leaves retry totals and distinct-session counts unchanged) -->
2. One versioned state under 4 KB atomically replaces legacy keys. Publish state and marker cache after persistence; failure preserves retry accounting. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/accounting-integration.test.ts (Timekeeper AccountingStateV2 integration (REQ-SUB-025)) --> <!-- @test: src/__tests__/timekeeper/accounting-integration.test.ts (REQ-SUB-025 AC1/2: failed commit leaves retry totals and distinct-session counts unchanged) -->
3. Hash-only session markers survive restart and period rollover; evicted entries reload from durable storage without recounting a session. <!-- @impl: src/timekeeper/accounting.ts::hashSessionId --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/accounting.test.ts (AccountingStateV2 (REQ-SUB-025)) --> <!-- @test: src/__tests__/timekeeper/accounting-integration.test.ts (REQ-SUB-025 AC5: evicted markers are read durably, including after restart, without recounting a session) -->
4. Normal historical pings add one accounting-state write and no KV reads beyond required SaaS live-quota and entitlement reads. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/timekeeper/accounting-load.test.ts (historical accounting operation fixture (REQ-OPS-057 AC6)) -->

**Constraints:**

- Timekeeper remains live quota owner.
- D1 failure never blocks quota persistence or enforcement; [REQ-SUB-036](#req-sub-036-historical-usage-projection-to-d1) owns D1 projection.
- Marker identities are domain-separated hashes; the FIFO cache holds at most 128 keys and durable cleanup is independent of eviction (see [Usage Accounting](../../documentation/lanes/billing.md#usage-accounting)).
- Personal usage and quota behavior remain compatible. <!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO) -->

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-022](#req-sub-022-cross-mode-personal-usage-data), [REQ-OPS-056](operations.md#req-ops-056-non-destructive-d1-deployment-boundary)

**Verification:** Automated: [accounting.test.ts](../../src/__tests__/timekeeper/accounting.test.ts), [accounting-integration.test.ts](../../src/__tests__/timekeeper/accounting-integration.test.ts), [accounting-load.test.ts](../../src/__tests__/timekeeper/accounting-load.test.ts), [index.test.ts](../../src/__tests__/timekeeper/index.test.ts)

**Status:** Implemented

---

### REQ-SUB-036: Historical usage projection to D1

**Intent:** Project live-captured usage to historical records independently of quota persistence and without inventing earlier history.

**Applies To:** System

**Acceptance Criteria:**

1. The existing alarm performs five-minute KV work and one hash-phased 15-minute D1 duty; no second alarm exists. <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @impl: src/timekeeper/accounting.ts::historyPhase --> <!-- @test: src/__tests__/timekeeper/alarm-history.test.ts (Timekeeper single-alarm history duty (REQ-SUB-025)) -->
2. Current absolute accumulators and closed-period outbox entries retry independently from KV checkpoints, and sequence-guarded D1 upserts cannot double-count. <!-- @impl: src/lib/admin-usage.ts::writeUsageHistory --> <!-- @impl: src/timekeeper/index.ts::Timekeeper --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (historical usage D1 guards (REQ-SUB-025, REQ-SUB-026)) --> <!-- @test: src/__tests__/timekeeper/alarm-history.test.ts (Timekeeper single-alarm history duty (REQ-SUB-025)) -->
3. The first successful D1 commit establishes history from its earliest included live-captured snapshot, without backfilling legacy quota counters. <!-- @impl: src/lib/admin-usage.ts::writeUsageHistory --> <!-- @impl: src/timekeeper/accounting.ts::createAccountingState --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (REQ-SUB-025 AC6: first successful history commit records the earliest included live snapshot without legacy backfill) -->

**Constraints:** D1 failure never blocks quota persistence or enforcement.

**Priority:** P0

**Dependencies:** [REQ-SUB-025](#req-sub-025-durable-historical-usage-accounting), [REQ-OPS-056](operations.md#req-ops-056-non-destructive-d1-deployment-boundary)

**Verification:** Automated: [alarm-history.test.ts](../../src/__tests__/timekeeper/alarm-history.test.ts), [usage-report-claims.test.ts](../../src/__tests__/lib/usage-report-claims.test.ts)

**Status:** Implemented

---

### REQ-SUB-026: Admin organization analytics and deletion history

**Intent:** Administrators can inspect stable, bounded organization and per-user usage history.

**Applies To:** Admin

**Acceptance Criteria:**

1. In every deployment mode, only admins can query organization or user detail by UTC closed-period parameters: period, start, sort, direction, cursor, limit, and format. Organization results offer JSON or downloadable CSV; the requested user's detail is JSON even for `format=csv`. <!-- @impl: src/routes/admin/usage.ts::default --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (admin organization usage routes (REQ-SUB-026)) --> <!-- @test: web-ui/src/__tests__/components/AnalyticsPage.test.tsx (Analytics historical usage presentation) --> <!-- @manual -->
2. Opaque versioned cursors bind the complete filter; malformed or mismatched cursors are rejected. <!-- @impl: src/routes/admin/usage.ts::decodeCursor --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (admin organization usage routes (REQ-SUB-026)) -->
3. JSON and CSV return the same filtered rows in the same order, using stable opaque user IDs to break ties. Only CSV omits pagination. <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (filters the requested period and paginates equal totals without losing tied owners) --> <!-- @impl: src/lib/admin-usage.ts::queryAdminUsageRows --> <!-- @impl: src/routes/admin/usage.ts::usageCsv --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (admin organization usage routes (REQ-SUB-026)) -->
4. The opaque user identifier is stable lowercase hex SHA-256 over a versioned, domain-separated normalized-email input and exposes neither email nor bucket identity. <!-- @impl: src/lib/admin-usage.ts::userKeyForEmail --> <!-- @test: src/__tests__/lib/admin-usage.test.ts (historical usage helpers (REQ-SUB-025)) -->
5. Responses disclose `dataSince` and result-owned `historyUpdatedAt` without claiming global outbox freshness. <!-- @impl: src/routes/admin/usage.ts::default --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (admin organization usage routes (REQ-SUB-026)) -->

**Notes:** Historical usage and report architecture is documented in [AD150](../../documentation/decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records).

**Constraints:** No cache, second aggregate table, session-state catalog, or timezone parameter is added.

**Priority:** P1

**Dependencies:** [REQ-SUB-036](#req-sub-036-historical-usage-projection-to-d1), [REQ-SUB-037](#req-sub-037-historical-usage-owner-lifecycle)

**Verification:** Automated: [admin-usage.test.ts](../../src/__tests__/routes/admin-usage.test.ts), [AnalyticsPage.test.tsx](../../web-ui/src/__tests__/components/AnalyticsPage.test.tsx), [admin-usage.test.ts](../../src/__tests__/lib/admin-usage.test.ts); Manual: [Integration analytics and report presentation acceptance](../../documentation/lanes/billing.md#integration-analytics-and-report-presentation-acceptance)

**Status:** Implemented

---

### REQ-SUB-037: Historical usage owner lifecycle

**Intent:** Preserve recorded usage history through authorized offboarding and reprovisioning without admitting writes for deleted owners.

**Applies To:** System

**Acceptance Criteria:**

1. User deletion writes a D1 tombstone before live cleanup; failure returns typed `503` and leaves live data unchanged. <!-- @impl: src/lib/user-cleanup.ts::cleanupUserData --> <!-- @impl: src/lib/admin-usage.ts::tombstoneUsageUser --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (resolves ownership, then writes a D1 tombstone before live cleanup) --> <!-- @test: src/__tests__/lib/user-cleanup.test.ts (fails closed with typed 503 evidence and leaves live data unchanged when tombstoning fails) -->
2. Explicit same-email provisioning reactivates ownership without erasing prior history. <!-- @impl: src/lib/admin-usage.ts::reactivateUsageUser --> <!-- @impl: src/lib/access.ts::resolveOrProvisionUser --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (keeps newer history, blocks deleted owners, and resumes the same owner after reactivation) -->

**Constraints:** Historical ownership changes do not alter authorization or cleanup ordering under [REQ-AUTH-026](authentication.md#req-auth-026-admin-user-offboarding).

**Priority:** P1

**Dependencies:** [REQ-SUB-036](#req-sub-036-historical-usage-projection-to-d1), [REQ-AUTH-026](authentication.md#req-auth-026-admin-user-offboarding)

**Verification:** Automated: [user-cleanup.test.ts](../../src/__tests__/lib/user-cleanup.test.ts), [usage-report-claims.test.ts](../../src/__tests__/lib/usage-report-claims.test.ts)

**Status:** Implemented

---

### REQ-SUB-027: Monthly organization usage reports

**Intent:** Administrators can schedule private monthly usage reports with recoverable per-recipient delivery evidence.

**Applies To:** Admin

**Acceptance Criteria:**

1. Revisioned settings accept disabled-by-default state, at most 25 normalized recipients, day 1 through 31, whole local hour, and canonical IANA timezone. <!-- @impl: src/lib/usage-reports.ts::normalizeReportSettings --> <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask --> <!-- @test: src/__tests__/lib/usage-reports.test.ts (usage report settings and schedule (REQ-SUB-027)) -->
2. Delivery recovery regenerates the month's summaries and exact CSVs from current persisted usage. Report bytes may change per dispatch; authoritative usage and payment accounting do not. <!-- @impl: src/lib/usage-report-scheduler.ts::recoverReportDeliveries --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (REQ-SUB-027 AC2: recovery regenerates current persisted usage but keeps identity and records provider rejection as failure) --> <!-- @impl: src/lib/usage-reports.ts::buildReportArtifacts --> <!-- @test: src/__tests__/lib/usage-report-delivery.test.ts (usage report artifacts and email boundary (REQ-SUB-027)) -->
3. Delivery uses conditional claims, random claim tokens, bounded leases, and at most three attempts. <!-- @impl: src/lib/usage-report-scheduler.ts::claimReportDelivery --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (usage report delivery claims (REQ-SUB-027)) -->
4. Stale claim tokens cannot complete reclaimed rows; deterministic Resend idempotency suppresses the remaining ambiguous duplicate window. <!-- @impl: src/lib/usage-report-scheduler.ts::completeReportDelivery --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (usage report delivery claims (REQ-SUB-027)) -->
5. The 15-minute scheduler independently recovers pending, failed, and lease-expired scheduled or test rows; request-attached background work is only the test-send fast path. <!-- @impl: src/index.ts::scheduled --> <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler --> <!-- @impl: src/routes/admin/usage-reports.ts::default --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (scheduled recovery sends failed, expired and test rows independently of request work while respecting leases and attempts) --> <!-- @test: src/__tests__/routes/admin-usage-reports.test.ts (admin usage report routes (REQ-SUB-027)) -->
6. Delivery history reports pending, sending, accepted, or failed provider-acceptance state without inventing provider delivery state or IDs. <!-- @impl: src/routes/admin/usage-reports.ts::default --> <!-- @impl: web-ui/src/components/admin/ReportsPage.tsx::ReportsPage --> <!-- @test: src/__tests__/routes/admin-usage-reports.test.ts (admin usage report routes (REQ-SUB-027)) --> <!-- @manual -->
7. On delivery recovery, reports send separate messages per recipient with an 8 MiB attachment limit. <!-- @impl: src/lib/email.ts::sendUsageReportEmail --> <!-- @test: src/__tests__/lib/usage-report-delivery.test.ts (usage report artifacts and email boundary (REQ-SUB-027)) -->

**Notes:** Historical usage and report architecture is documented in [AD150](../../documentation/decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records).

**Constraints:**

- Resend credentials and sender identity remain deployment-managed.
- Reports do not background-poll and never promise exactly-once delivery.

**Priority:** P1

**Dependencies:** [REQ-SUB-026](#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SETUP-018](setup.md#req-setup-018-stateless-environment-preview-and-bounded-execution)

**Verification:** Automated: [usage-reports.test.ts](../../src/__tests__/lib/usage-reports.test.ts), [usage-report-delivery.test.ts](../../src/__tests__/lib/usage-report-delivery.test.ts), [usage-report-claims.test.ts](../../src/__tests__/lib/usage-report-claims.test.ts), [admin-usage-reports.test.ts](../../src/__tests__/routes/admin-usage-reports.test.ts); Manual: [Integration analytics and report presentation acceptance](../../documentation/lanes/billing.md#integration-analytics-and-report-presentation-acceptance)

**Status:** Implemented

---

### REQ-SUB-028: Historical usage and report retention

**Intent:** Historical usage and report evidence remain bounded without overlapping daily retention owners.

**Applies To:** Admin

**Acceptance Criteria:**

1. Retention runs at most once per UTC day, and only the winning execution prunes eligible history. <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageRetention --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (REQ-SUB-028 AC1: daily retention claim) -->
2. If any prune fails, the daily claim and all pruning roll back so a later execution can retry. <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageRetention --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (REQ-SUB-028 AC2: retention rollback) -->
3. Retention keeps 400 days, 60 ISO weeks, 60 months, and five years using exact calendar cutoffs. <!-- @impl: src/lib/usage-report-scheduler.ts::retentionCutoffs --> <!-- @test: src/__tests__/lib/usage-report-scheduler.test.ts (usage report retention cutoffs (REQ-SUB-026, REQ-SUB-028)) -->
4. Deleted users retain named aggregate history for 60 months. <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageRetention --> <!-- @test: src/__tests__/lib/usage-report-scheduler.test.ts (usage report retention cutoffs (REQ-SUB-026, REQ-SUB-028)) -->

**Notes:** Historical usage and report architecture is documented in [AD150](../../documentation/decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records).

**Constraints:** Retention uses the existing deployment-scoped usage database and scheduler; no second timer or coordinator is added.

**Priority:** P1

**Dependencies:** [REQ-SUB-036](#req-sub-036-historical-usage-projection-to-d1), [REQ-SUB-026](#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-027](#req-sub-027-monthly-organization-usage-reports)

**Verification:** Automated: [usage-report-claims.test.ts](../../src/__tests__/lib/usage-report-claims.test.ts), [usage-report-scheduler.test.ts](../../src/__tests__/lib/usage-report-scheduler.test.ts)

**Status:** Implemented

---

### REQ-SUB-029: Bounded organization usage history presentation

**Intent:** Administrators can inspect actual historical organization usage even when the selected period has no aggregate row.

**Applies To:** Admin

**Acceptance Criteria:**

1. Organization usage returns a chronological series of existing aggregates bounded to 14 days, 12 weeks, 12 months, or five years. <!-- @impl: src/lib/admin-usage.ts::queryAdminUsageSeries --> <!-- @impl: src/routes/admin/usage.ts::default --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (returns chronological existing history aggregates and deterministic user rows) --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (bounds every history series to its configured period limit) --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (returns only the configured latest aggregates in chronological order for every period) -->
2. Analytics renders returned history when the selected period has no aggregate row and shows the empty state only when no historical series exists. <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::UsageChart --> <!-- @test: web-ui/src/__tests__/components/AnalyticsPage.test.tsx (charts earlier history when the selected period has no aggregate row) -->

3. Selecting a period immediately requests that period’s totals rather than retaining the previous selection’s data. <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage --> <!-- @test: web-ui/src/__tests__/components/AnalyticsPage.test.tsx (requests the selected period immediately rather than leaving day totals under a week selection) -->
4. Overview derives its usage state from the historical usage response, not a static empty-history message. <!-- @impl: web-ui/src/components/admin/AdministrationOverview.tsx::AdministrationOverview --> <!-- @test: web-ui/src/__tests__/components/AdministrationOverview.test.tsx (renders returned history instead of claiming history is empty) -->

**Constraints:**

- History uses existing D1 period rows without synthetic points, a second aggregate table, or a cache.
- Weeks start Monday at 00:00 UTC; they are not relabelled as local-time aggregates.

**Priority:** P1

**Dependencies:** [REQ-SUB-036](#req-sub-036-historical-usage-projection-to-d1), [REQ-SUB-026](#req-sub-026-admin-organization-analytics-and-deletion-history)

**Verification:** Automated: [admin-usage.test.ts](../../src/__tests__/routes/admin-usage.test.ts), [AdministrationOverview.test.tsx](../../web-ui/src/__tests__/components/AdministrationOverview.test.tsx), [AnalyticsPage.test.tsx](../../web-ui/src/__tests__/components/AnalyticsPage.test.tsx), [usage-report-claims.test.ts](../../src/__tests__/lib/usage-report-claims.test.ts)

**Status:** Implemented

---

### REQ-SUB-030: Monthly usage report schedule periods

**Intent:** Scheduled and test usage reports select predictable UTC reporting periods while local delivery schedules remain stable across configuration revisions.

**Applies To:** Admin

**Acceptance Criteria:**

1. Scheduled report dispatches use the latest closed UTC month. <!-- @impl: src/lib/usage-reports.ts::latestClosedMonth --> <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler --> <!-- @test: src/__tests__/lib/usage-reports.test.ts (usage report settings and schedule (REQ-SUB-027)) --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (persists the previous UTC month when a dispatch is due at %s) -->
2. Test report dispatches use the current UTC month. <!-- @impl: src/routes/admin/usage-reports.ts::default --> <!-- @test: src/__tests__/routes/admin-usage-reports.test.ts (admin usage report routes (REQ-SUB-027)) -->
3. Delivery schedules apply last-valid-day and DST rules. <!-- @impl: src/lib/usage-reports.ts::nextReportDelivery --> <!-- @test: src/__tests__/lib/usage-reports.test.ts (usage report settings and schedule (REQ-SUB-027)) -->
4. A settings revision cannot consume the next due instant owned by another revision. <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler --> <!-- @test: src/__tests__/lib/usage-report-scheduler.test.ts (usage report scheduling recovery (REQ-SUB-027)) -->
5. Test and scheduled dispatches use distinct identities and persist one row per recipient per dispatch. <!-- @impl: src/lib/usage-report-scheduler.ts::createReportDispatch --> <!-- @test: src/__tests__/lib/usage-report-claims.test.ts (persists one recipient row per dispatch and keeps test dispatch identities independent) -->
6. The test-send UI describes the report period as the current UTC month. <!-- @impl: web-ui/src/components/admin/ReportsPage.tsx::ReportsPage --> <!-- @manual -->

**Constraints:** Scheduling uses the existing 15-minute Worker schedule and deployment-scoped usage database.

**Priority:** P1

**Dependencies:** [REQ-SUB-027](#req-sub-027-monthly-organization-usage-reports)

**Verification:** Automated: [usage-reports.test.ts](../../src/__tests__/lib/usage-reports.test.ts), [admin-usage-reports.test.ts](../../src/__tests__/routes/admin-usage-reports.test.ts), [usage-report-scheduler.test.ts](../../src/__tests__/lib/usage-report-scheduler.test.ts), [usage-report-claims.test.ts](../../src/__tests__/lib/usage-report-claims.test.ts); Manual: [Integration analytics and report presentation acceptance](../../documentation/lanes/billing.md#integration-analytics-and-report-presentation-acceptance)

**Status:** Implemented

---

### REQ-SUB-031: Canonical administration usage period starts

**Intent:** Administration usage queries identify real UTC calendar periods consistently.

**Applies To:** Admin

**Acceptance Criteria:**

1. Day and week starts use `YYYY-MM-DD`, month starts use `YYYY-MM`, year starts use `YYYY`, and week starts are Mondays. <!-- @impl: src/routes/admin/usage.ts::validStart --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (bounds every history series to its configured period limit) -->
2. Malformed dates, invalid months, and non-Monday week starts are rejected before usage data is queried. <!-- @impl: src/routes/admin/usage.ts::parseQuery --> <!-- @test: src/__tests__/routes/admin-usage.test.ts (rejects malformed calendar starts before SQL) -->

**Constraints:** Period validation remains UTC-only and adds no timezone parameter.

**Priority:** P1

**Dependencies:** [REQ-SUB-026](#req-sub-026-admin-organization-analytics-and-deletion-history)

**Verification:** Automated: [admin-usage.test.ts](../../src/__tests__/routes/admin-usage.test.ts)

**Status:** Implemented

---

<a id="req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode"></a>
### REQ-ENTERPRISE-315: Enterprise Pro seed migration

**Intent:** Enterprise users become current only after their bucket has successfully applied the Pro agent configuration.

**Applies To:** User

**Acceptance Criteria:**

1. An Enterprise user remains upgrade-pending until the bucket's Pro agent configuration reconciles successfully, including initial reconciliation for a new bucket. Only then is the stored mode marked Pro. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @impl: src/routes/session/lifecycle.ts::preseedNeedsUpgrade --> <!-- @impl: src/routes/storage/seed.ts::updatedPreferences --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-ENTERPRISE-001 AC6: enterprise upgrade reconcile for pre-existing users) --> <!-- @test: src/__tests__/routes/session-ancillary-status.test.ts (REQ-ENTERPRISE-001 AC6: ancillary polling requires enterprise Pro reconciliation for stored mode %s with current baked inputs) --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (enterprise: reconciles as advanced and stamps sessionMode alongside lastPreseedHash) -->
2. If initial or upgrade reconciliation fails, the preference is not stamped and the upgrade retries on the next trigger. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @impl: src/routes/storage/seed.ts::updatedPreferences --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (DEEP-18-007/008: a failed new-bucket reconcile leaves Pro unstamped for retry) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (enterprise: a failed upgrade reconcile does NOT stamp the preference (retries next start) and the start still succeeds) --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (enterprise: a failed reconcile returns 500 and does NOT stamp sessionMode or lastPreseedHash) -->

**Constraints:** Successful upgrade stamps preserve the latest preference fields they do not own. <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @impl: src/routes/storage/seed.ts::updatedPreferences --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-ENTERPRISE-001 constraint: enterprise upgrade preserves preferences changed while reconciliation is running) --> <!-- @test: src/__tests__/routes/storage-seed.test.ts (REQ-ENTERPRISE-001 constraint: enterprise reseed preserves preferences changed during reconciliation) -->

**Priority:** P1

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode)

**Verification:** Automated: [container-r2-start.test.ts](../../src/__tests__/routes/container-r2-start.test.ts), [session-ancillary-status.test.ts](../../src/__tests__/routes/session-ancillary-status.test.ts), [storage-seed.test.ts](../../src/__tests__/routes/storage-seed.test.ts)

**Status:** Implemented

---

### REQ-ENTERPRISE-001: ENTERPRISE_MODE Forces Unlimited Tier and Pro Mode

**Intent:** A deploy-time Enterprise-mode flag must turn a deployment into a single-tenant enterprise instance where every user gets full access without subscription friction.

**Applies To:** User

**Acceptance Criteria:**

1. When the Enterprise-mode binding is set, every user's effective tier resolves to `unlimited` regardless of stored tier, billing status, or trial state. <!-- @impl: src/lib/subscription.ts::getEffectiveTier --> <!-- @test: src/__tests__/lib/enterprise-mode.test.ts (REQ-ENTERPRISE-001 AC1: getEffectiveTier enterprise override) -->
2. When the Enterprise-mode binding is set, session-mode resolution returns Pro (`advanced`) for every user regardless of the stored preference. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @impl: src/lib/session-mode.ts::withEffectiveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-ENTERPRISE-001 AC2 (enterprise forces Pro regardless of the stored preference)) --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (AC2 (REQ-ENTERPRISE-001): GET returns sessionMode=advanced under enterprise with no stored preference) --> <!-- @test: src/__tests__/routes/container-lifecycle.test.ts (REQ-ENTERPRISE-001 AC2: enterprise start resolves sessionMode=advanced with no stored preference (JIT user)) -->
3. When the Enterprise-mode binding is set, monthly Timekeeper quota enforcement is disabled. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits --> <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-ENTERPRISE-001 AC3: enterprise users are never blocked by the monthly compute quota) --> <!-- @test: src/__tests__/timekeeper/index.test.ts (REQ-ENTERPRISE-001 AC3: enterprise pings retain accounting beyond SaaS quota without enforcement) -->
4. The flag is read from a single resolver; all callers consult the resolver rather than reading the raw binding. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @manual: Search production source for raw ENTERPRISE_MODE reads and confirm only the resolver owns binding interpretation. -->
5. When the Enterprise-mode binding is unset, tier resolution, session-mode resolution, and subscription enforcement are byte-identical to current behavior across the Default, Onboarding, and SaaS deployment modes. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/preferences-enterprise.test.ts (Preferences Routes under ENTERPRISE_MODE / REQ-ENTERPRISE-001 + REQ-ENTERPRISE-003) -->


**Constraints:**

- The deploy-time Worker binding selects the flag; request data cannot override it.
- When the flag is unset there is no new code path: every enterprise branch is gated behind the resolver returning false.
- [REQ-ENTERPRISE-315](#req-enterprise-315-enterprise-pro-seed-migration) owns successful applied-mode publication, separate from effective tier and mode resolution.
- Enterprise deployment-variable values, rollout, and rollback procedures are owned by the private [Enterprise deployment runbook](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/deployment/enterprise.md); this public specification records only runtime behavior.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-014](#req-sub-014-session-mode-gating-by-tier), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** Automated: [enterprise-mode.test.ts](../../src/__tests__/lib/enterprise-mode.test.ts), [session-mode.test.ts](../../src/__tests__/lib/session-mode.test.ts), [preferences-enterprise.test.ts](../../src/__tests__/routes/preferences-enterprise.test.ts), [container-lifecycle.test.ts](../../src/__tests__/routes/container-lifecycle.test.ts), [container-lifecycle-helpers.test.ts](../../src/__tests__/routes/container-lifecycle-helpers.test.ts), [index.test.ts](../../src/__tests__/timekeeper/index.test.ts); Manual: [Enterprise binding ownership review](../../documentation/lanes/billing.md#enterprise-binding-ownership-review)

**Status:** Implemented

---

### REQ-ENTERPRISE-002: Subscription UI Hidden and Subscribe Route Guarded

**Intent:** When the deployment is in Enterprise Mode there is no self-serve billing, so the subscription UI and the subscribe route must not be reachable.

**Applies To:** User

**Acceptance Criteria:**

1. When the Enterprise-mode binding is set, the subscription/billing settings surfaces (tier display, plan switching, usage-quota controls) are hidden in the frontend. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component / REQ-VAULT-012 (vault button render and readiness gating) / REQ-AUTH-016 (header user dropdown)) -->
2. When the Enterprise-mode binding is set, subscription navigation is guarded so it renders neither tier selection nor checkout. <!-- @impl: web-ui/src/App.tsx::SubscribeGuard --> <!-- @test: web-ui/src/__tests__/components/enterprise-app-routing.test.tsx (REQ-ENTERPRISE-002 AC2: subscribe route guard) -->
3. The frontend determines whether to hide billing surfaces from a deploy-time mode signal, not from the user's tier. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/user-profile-enterprise.test.ts (GET /api/user enterpriseMode flag / REQ-ENTERPRISE-002) -->
4. When the Enterprise-mode binding is unset, subscription navigation and UI remain byte-identical to existing behavior. <!-- @impl: src/lib/subscription.ts::isEnterpriseMode --> <!-- @test: src/__tests__/routes/user-profile-enterprise.test.ts (GET /api/user enterpriseMode flag / REQ-ENTERPRISE-002) -->

**Constraints:**

- Guarding the subscribe route must not break links from non-enterprise deployments; the guard is conditional on the resolver.
- Hiding the billing UI does not delete a user's stored tier; the field is retained and simply unused while the flag is set.

**Priority:** P2

**Dependencies:** [REQ-ENTERPRISE-001](#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SUB-016](#req-sub-016-customer-portal-and-plan-switching), [REQ-SUB-017](#req-sub-017-enterprise-tier-contact-flow)

**Verification:** Automated: [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx), [enterprise-app-routing.test.tsx](../../web-ui/src/__tests__/components/enterprise-app-routing.test.tsx), [user-profile-enterprise.test.ts](../../src/__tests__/routes/user-profile-enterprise.test.ts)

**Status:** Implemented

---
