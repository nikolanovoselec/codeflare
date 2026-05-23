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

<!-- @impl: src/lib/subscription.ts::getDefaultTiers -->
<!-- @test: src/__tests__/lib/subscription.test.ts (SubscriptionTierSchema + getDefaultTiers describes → 8 tier IDs + required fields → AC1/AC2) -->

**Intent:** The platform must support a graduated set of subscription tiers that control access levels, compute quotas, session limits, and available features.

**Applies To:** User

**Acceptance Criteria:**

1. Exactly 8 tier IDs exist: `blocked`, `pending`, `free`, `trial`, `standard`, `advanced`, `max`, `unlimited`.
2. Each tier defines all of: `monthlySeconds`, `maxSessions`, `sessionModes`, `canLogin`, `priceMonthly`, `trialQuotaHours`, `maxStorageBytes`, `displayName`, `description`, `order`, `isDefault`.
3. `getDefaultTiers()` returns the complete 8-tier array as the hardcoded fallback.
4. Tier IDs are stable identifiers; display names may differ (e.g., `standard` displays as "Starter").

**Constraints:**

- One tier must have `isDefault: true` (currently `standard`) as fallback for undefined/missing users.
- The `blocked` tier must have `canLogin: false`; `pending` must have `canLogin: true` (to access the subscribe page).

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-002 describe -> exact monthlySeconds + maxSessions + sessionModes + maxStorageBytes per tier from AC table -> AC1..AC4) -->
### REQ-SUB-002: Tier Property Definitions

<!-- @impl: src/lib/subscription.ts::getDefaultTiers -->
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

1. `monthlySeconds` of `null` means unlimited compute.
2. `maxStorageBytes` of `null` means unlimited storage.
3. `sessionModes` is an array of `'default'` and/or `'advanced'` values.

**Constraints:**

- These are default values; admins can override all operational parameters via the management panel.
- Prices are not hardcoded; they come from Stripe via admin-configured `stripePriceId` per tier.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated test

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

1. `POST /api/auth/subscribe` with `tier: 'free'` activates the tier directly via KV write, no Stripe interaction.
2. The free tier has `priceMonthly: 0`.
3. When `STRIPE_SECRET_KEY` is set, the free tier still bypasses Stripe Checkout.
4. Free-tier users have `billingStatus` fields that remain null/absent.

**Constraints:**

- Free-tier auto-sleep is locked to 15 minutes; the dropdown is disabled in the frontend.
- Free tier is limited to 1 concurrent session.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated test

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
<!-- @impl: src/lib/stripe.ts::createCheckoutSession -->

**Intent:** Paid tiers (standard, advanced, max) must collect payment via Stripe before activating the subscription.

**Applies To:** User

**Acceptance Criteria:**

1. When `STRIPE_SECRET_KEY` is set, `POST /api/auth/subscribe` rejects paid tiers with "Paid subscriptions require checkout." Only `free` is allowed through direct subscribe.
2. `POST /api/billing/checkout` creates a Stripe Checkout Session with `customer_email` and tier/mode metadata, returning a Stripe-hosted checkout URL.
3. After payment, Stripe sends a `checkout.session.completed` webhook that writes checkout fields and calls `syncSubscriptionState()`.
4. The frontend polls `GET /api/auth/status` every 2s (max 30s) after checkout redirect, waiting for the webhook to activate the subscription.
5. Three webhook events are handled: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
6. Webhook endpoint at `/public/stripe/webhook` is unauthenticated but verified via HMAC-SHA256 signature with 5-minute timestamp tolerance.
7. Event deduplication via KV key `stripe:event:{eventId}` with 72-hour TTL.

**Constraints:**

- Price metadata (tier, mode) must be set on Stripe Price objects before deploy.
- Tiers without a configured `stripePriceId` are hidden from the subscribe page.
- Customer mapping (`stripe-customer:{customerId}` -> email) is stored in KV on checkout completion.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-003](#req-sub-003-free-tier-requires-no-payment)

**Verification:** Integration test

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

**Intent:** Trial periods must be capped by actual compute usage, not calendar days, so that inactive users do not burn through their trial.

**Applies To:** User

**Acceptance Criteria:**

1. Each paid tier has a configurable `trialQuotaHours` (set via admin panel).
2. Stripe subscriptions are created with `trial_period_days: 30` as a maximum billing window.
3. Timekeeper enforces `trialQuotaHours` as the compute cap during trial (when `billingStatus === 'trialing'`).
4. When trial compute quota is consumed, Timekeeper calls `endTrialNow()` which posts to Stripe API (`trial_end=now`), triggering the first charge.
5. If payment succeeds, the full `monthlySeconds` quota unlocks; if it fails, `billingStatus` becomes `past_due` and the user is downgraded to free.
6. `trialUsed: true` is set in KV when the subscription transitions away from `'trialing'`, preventing unlimited free trials via subscribe-cancel-resubscribe.

**Constraints:**

- `endTrialNow` in Timekeeper is guarded by a `trialEnded` flag in DO storage, preventing it from being called every 60s ping (which would cause O(sessions) Stripe API calls per minute).
- `lastSyncedAt` timestamp guard uses `>` (not `>=`) so same-second webhook events are not silently discarded.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SUB-006: Real-Time Usage Tracking via Timekeeper DO

<!-- @impl: src/timekeeper/index.ts::Timekeeper -->
<!-- @impl: src/container/container-metrics.ts -->
<!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO describe → 60s pings + alarm flush + per-period counters → AC1-AC7) -->

**Intent:** Compute usage must be tracked accurately in real time so that quota enforcement and billing decisions use current data.

**Applies To:** User

**Acceptance Criteria:**

1. One Timekeeper Durable Object exists per user.
2. Container DOs ping Timekeeper with monotonic `totalSeconds` per session every 60 seconds (when `SAAS_MODE=active`).
3. Timekeeper computes deltas per session, accumulates `pendingSeconds`, and flushes to KV via alarm every 5 minutes.
4. `GET /usage` on Timekeeper returns real-time usage (KV flushed + pending).
5. KV record at `timekeeper:{bucketName}` tracks: daily, weekly, monthly, yearly, and all-time counters with automatic rollovers.
6. The alarm handler retries on KV write failure with 30-second backoff.
7. `pendingSeconds` is reset only after successful KV write.

**Constraints:**

- Usage tracking always runs regardless of `STRESS_TEST_MODE` (stress test only bypasses rate limits and session limits).
- Multiple concurrent sessions from the same user all ping the same Timekeeper DO.

**Priority:** P0

**Dependencies:** None.

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-007: Quota Enforcement at Session Start (402)

<!-- @impl: src/routes/container/lifecycle.ts -->
<!-- @impl: src/timekeeper/index.ts::Timekeeper -->
<!-- @test: src/__tests__/timekeeper/index.test.ts (Timekeeper DO describe → quota gate + 402 + fail-open + non-SaaS skip → AC1-AC6) -->

**Intent:** Users who have consumed their monthly compute quota must be prevented from starting new sessions.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/container/start` calls `validateSessionAndCheckLimits()` which reads monthly usage from `timekeeper:{bucketName}` KV.
2. Usage is compared against `tier.monthlySeconds` (skipped when `null`/unlimited).
3. When quota is exceeded, a `QuotaExceededError` is thrown (HTTP 402, code `QUOTA_EXCEEDED`).
4. The frontend detects `code === 'QUOTA_EXCEEDED'` via `ApiError.code` and shows an upgrade CTA.
5. Enforcement is skipped for non-SaaS mode and stress test mode.
6. Enforcement fails open on KV errors (user is not blocked if KV is unavailable).

**Constraints:**

- Quota check uses the effective tier from `getEffectiveTier()`, which accounts for billing status downgrades.
- The 402 status code must be used (not 403) to distinguish quota exhaustion from access denial.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/container-metrics.test.ts (REQ-SUB-008 AC1: calls stop("SIGTERM") when Timekeeper /ping returns quotaExceeded=true + does NOT stop when quotaExceeded=false -> AC1 graceful stop via SIGTERM, AC2 entrypoint trap runs final sync) -->
<!-- @test: src/__tests__/timekeeper/index.test.ts (POST /ping describe -> returns { quotaExceeded, totalMonthlySeconds } shape + trial quota enforcement returns quotaExceeded=true when over trialQuotaHours -> AC3 ping response shape) -->
### REQ-SUB-008: Mid-Session Quota Enforcement (Graceful Stop)

<!-- @impl: src/container/container-metrics.ts::collectMetrics -->
<!-- @impl: src/timekeeper/index.ts -->

**Intent:** Sessions that exceed quota while running must be stopped gracefully, not left running indefinitely.

**Applies To:** User

**Acceptance Criteria:**

1. When Timekeeper's ping handler returns `quotaExceeded: true`, the Container DO calls `stop('SIGTERM')` for graceful shutdown.
2. The SIGTERM signal allows the container to perform final sync before exit.
3. The `quotaExceeded` flag is returned alongside `totalMonthlySeconds` in the ping response.

**Constraints:**

- Mid-session eviction must allow the final bisync to complete (graceful, not immediate kill).
- The check happens on each 60-second ping, not continuously.

**Priority:** P0

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-007](#req-sub-007-quota-enforcement-at-session-start-402)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (getTierConfig KV-first with default fallback describe -> KV read + default fallback + merge backfill + Team->Custom migration -> AC3,4) -->
<!-- @test: src/__tests__/routes/admin-tiers.test.ts (PUT /admin/tiers describe -> writes tiers:config + persists maxStorageBytes + 403 non-admin + Zod rejects 7-tier/bad-id/negative -> AC1,5,6) -->
### REQ-SUB-009: Admin-Configurable Tiers via Management Panel

<!-- @impl: src/routes/admin -->
<!-- @impl: src/lib/subscription.ts::getTierConfig -->
<!-- @test: src/__tests__/lib/stripe.test.ts (resolveTierFromPriceId describe → tier resolution from Stripe price metadata → AC1/AC4) -->

**Intent:** Administrators must be able to customize tier properties (quotas, prices, sessions, storage) without code changes.

**Applies To:** Admin

**Acceptance Criteria:**

1. `PUT /api/admin/tiers` accepts a tier configuration array and writes it to `tiers:config` KV key.
2. The admin Subscription Management panel has editable fields for all tier properties including storage quota (MB), monthly hours, max sessions, trial hours, and Stripe price IDs.
3. `getTierConfig()` reads from KV first, falling back to `getDefaultTiers()` if unavailable.
4. Admin-saved values always take priority over defaults via `{ ...default, ...stored }` merge.
5. The Zod schema for `PUT /api/admin/tiers` includes `maxStorageBytes` so it persists on save.
6. The `requireAdmin` middleware protects tier management endpoints.

**Constraints:**

- Changes require admin role (checked after `requireActiveUser`).
- New fields added to defaults backfill automatically for deployments with pre-existing KV data.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-AUTH-005](authentication.md#req-auth-005-three-tier-authorization-middleware)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/lib/subscription-req-sub-gaps.test.ts (REQ-SUB-010 describe -> cache hit within 59s + miss after 61s + resetTierConfigCache forces re-read -> AC1..AC4) -->
### REQ-SUB-010: Tier Config Cached with 60-Second TTL

<!-- @impl: src/lib/subscription.ts::getTierConfig -->
<!-- @impl: src/lib/cache-reset.ts -->
<!-- @test: src/__tests__/lib/subscription.test.ts (getTierConfig describe → KV fallback + module cache single-KV-read + resetTierConfigCache cache-bust → AC1-AC5) -->

**Intent:** Tier configuration reads must be fast (avoid KV round-trip on every request) while still reflecting admin changes within a bounded delay.

**Applies To:** User

**Acceptance Criteria:**

1. `getTierConfig()` uses a module-level cache with 60-second TTL.
2. Within the TTL window, cached tier config is returned without KV read.
3. After TTL expiry, the next call reads from KV and refreshes the cache.
4. `resetTierConfigCache()` allows tests to force cache invalidation.
5. Admin changes take effect within 60 seconds across all isolates.

**Constraints:**

- Each Cloudflare Worker isolate maintains its own cache; there is no cross-isolate invalidation.
- The 60-second TTL is per-isolate, not globally synchronized.

**Priority:** P1

**Dependencies:** [REQ-SUB-009](#req-sub-009-admin-configurable-tiers-via-management-panel)

**Verification:** Automated test

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

1. When `STRIPE_SECRET_KEY` is not set, all tiers work via direct `POST /api/auth/subscribe` without payment.
2. Billing status fields remain null in user records.
3. `getEffectiveTier()` does not downgrade paid tiers when billing fields are absent and Stripe is not configured.
4. The subscribe page functions normally, showing tiers without payment buttons.

**Constraints:**

- Non-SaaS users without a tier default to `unlimited` access for backward compatibility.
- Legacy `accessTier` field is maintained in KV; code reads `subscriptionTier` first, falls back to `accessTier`.

**Priority:** P1

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-012: Billing Status Enforcement (Effective Tier)

<!-- @impl: src/lib/subscription.ts::getEffectiveTier -->
<!-- @impl: src/lib/subscription.ts::isActiveTier -->
<!-- @test: src/__tests__/lib/subscription.test.ts (getEffectiveTier describe → billing-status-driven downgrade matrix → AC1-AC7) -->

**Intent:** A user's effective tier must reflect their current billing state, automatically downgrading when payment lapses.

**Applies To:** User

**Acceptance Criteria:**

1. `getEffectiveTier()` is the canonical tier resolution function combining `subscriptionTier`, `accessTier`, and billing state.
2. `billingStatus === 'canceled'` results in immediate downgrade to `free` (no grace period).
3. `billingStatus === 'past_due'` with a future `billingPeriodEnd` keeps the paid tier (grace period).
4. `billingStatus === 'past_due'` with an expired or missing `billingPeriodEnd` downgrades to `free`.
5. `billingPeriodEnd` expired with `billingStatus === 'active'` downgrades to `free` (catches missed webhooks).
6. The stored `subscriptionTier` is preserved in KV so resubscription restores the correct plan.
7. Enforcement is read-time (computed on access), not write-time (not mutated in KV).

**Constraints:**

- Exempt tiers: `free` (no billing), `unlimited` (enterprise/admin-managed), `pending`, `blocked`.
- Uses `BILLING_STATUS` constants from `types.ts` for type-safe comparisons, not raw strings.
- `BillingStatus` union type: `'active' | 'trialing' | 'past_due' | 'canceled'`.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-013: Concurrent Session Limits

<!-- @impl: src/lib/subscription.ts::getMaxSessionsForTier -->
<!-- @impl: src/routes/container/lifecycle.ts::validateSessionAndCheckLimits -->
<!-- @test: src/__tests__/routes/container-lifecycle.test.ts (Session limits describe → per-tier maxSessions enforcement + STRESS_TEST_MODE bypass → AC1-AC4) -->

**Intent:** Each tier must enforce a maximum number of simultaneously running sessions to control resource consumption.

**Applies To:** User

**Acceptance Criteria:**

1. `getMaxSessionsForTier(tierValue, tiers)` returns the `maxSessions` value for the user's tier.
2. Session creation is rejected when running + initializing sessions >= `maxSessions`.
3. The frontend disables the start button when `isAtSessionLimit()` returns true and shows a popup explaining the limit.
4. `batch-status` returns `maxSessions` so the frontend can enforce limits client-side.

**Constraints:**

- Session limit check uses the effective tier, not the stored tier.
- `STRESS_TEST_MODE` bypasses session limits.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-014: Session Mode Gating by Tier

<!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->
<!-- @impl: src/lib/subscription.ts -->
<!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (Pro-mode gating describe → per-tier allowed modes + rejection on unsupported → AC1-AC4) -->

**Intent:** Only tiers that include Pro (advanced) mode in their `sessionModes` array may create Pro sessions.

**Applies To:** User

**Acceptance Criteria:**

1. `getAllowedSessionModes(tierValue, tiers)` returns the list of modes allowed for the user's tier.
2. Free and trial tiers only allow `['default']` (Standard mode).
3. Standard, advanced, max, and unlimited tiers allow `['default', 'advanced']` (Standard and Pro modes).
4. Session creation or mode change requests for an unsupported mode are rejected.

**Constraints:**

- `subscribedMode` in the user record is the source of truth for Pro access (set by Stripe webhook or admin).
- JIT-provisioned users default to `'default'` mode.

**Priority:** P0

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system), [REQ-AGENT-004](agents.md#req-agent-004-two-session-modes-standard-and-pro)

**Verification:** Automated test

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleCheckoutCompleted / REQ-SUB-005 / REQ-SUB-015 describe -> webhook treated as signal that triggers syncSubscriptionState refetch from Stripe -> AC1, AC2) -->
<!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> skips write when KV lastSyncedAt is newer than current timestamp -> AC3 stale-webhook guard) -->
<!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> writes complete state from snapshot + preserves tier when metadata is null -> AC4 patch from fetched snapshot) -->
<!-- @test: src/__tests__/routes/stripe-webhook-sync.test.ts (syncSubscriptionState describe -> preserves existing KV fields (addedBy, onboardingComplete, etc.) via updateUserRecord atomic merge -> AC5) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (auto-recreate on downgrade describe -> mode-change triggers reconcileAgentConfigs with new mode -> AC6) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (auto-reconcile on subscription.deleted describe -> calls reconcileAgentConfigs with default mode after KV reset to free -> AC7) -->
### REQ-SUB-015: Stripe Webhook Signal-and-Sync Pattern

<!-- @impl: src/routes/stripe-webhook.ts -->
<!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->

**Intent:** KV billing state must always reflect the latest Stripe state to prevent race conditions from incremental patching.

**Applies To:** User

**Acceptance Criteria:**

1. Webhooks are treated as signals that trigger a fresh fetch from the Stripe API, not as the data source.
2. `syncSubscriptionState()` fetches the latest subscription via `GET /v1/subscriptions/{id}` (expanded with price items).
3. A `lastSyncedAt` timestamp guard prevents stale webhooks from overwriting newer state.
4. KV patches are built from the fetched snapshot; only tier/mode is set when price metadata is present (preserves existing values when null).
5. Writes use `updateUserRecord()` (atomic read-merge-write) to prevent concurrent webhook writes from losing fields.
6. On any mode change (upgrade or downgrade), `reconcileAgentConfigs` is called to seed the correct config set for the new mode.
7. On subscription termination (`customer.subscription.deleted`), after resetting KV tier to `free`, `reconcileAgentConfigs` is called with `default` mode to restore Standard configs.

**Constraints:**

- `lastSyncedAt` guard uses `>` (not `>=`) to avoid discarding same-second events.
- Auto-reconcile on mode change or deletion is non-fatal (try/catch); failure does not block the webhook.
- Subscription cancellation (`cancel_at_period_end`) does NOT trigger reconciliation; only actual termination (period end or revocation) does.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/portal / REQ-SUB-016 describe -> creates portal session via createPortalSession and returns { portalUrl } -> AC1) -->
<!-- @test: src/__tests__/lib/stripe.test.ts (createPortalSession describe -> POST to Stripe billing_portal/sessions with customer_id + return_url + flow_data subscription_update_confirm for switch flow -> AC2) -->
<!-- @test: src/__tests__/routes/billing.test.ts (POST /billing/switch describe -> requires subscriptionItemId from fetchSubscription + cleans up stale KV when subscription no longer exists on Stripe -> AC3, AC4) -->
<!-- @test: src/__tests__/routes/stripe-webhook.test.ts (handleSubscriptionUpdated describe -> customer.subscription.updated picked up by syncSubscriptionState propagates plan change to KV -> AC5) -->
<!-- @test: src/__tests__/routes/rate-limits.test.ts (POST /billing/portal rate-limit describe -> blocks after 5 requests in 60s window -> AC6 5/min rate-limit) -->
### REQ-SUB-016: Customer Portal and Plan Switching

<!-- @impl: src/lib/stripe.ts::createPortalSession -->
<!-- @impl: src/routes/billing.ts -->

**Intent:** Active subscribers must be able to manage their subscription (cancel, switch plans, update payment) via Stripe's billing portal.

**Applies To:** User

**Acceptance Criteria:**

1. `POST /api/billing/portal` creates a Stripe Billing Portal session and returns `{ portalUrl }`.
2. `POST /api/billing/switch` creates a portal session with `flow_data[type]=subscription_update_confirm` deep-linking to the Stripe confirmation page with the new price pre-selected.
3. Plan switching requires `subscriptionItemId` from `fetchSubscription()`.
4. If the subscription no longer exists on Stripe, stale KV fields are cleaned up and an error is returned so the frontend redirects to checkout.
5. Plan changes trigger `customer.subscription.updated` webhook which `syncSubscriptionState()` picks up.
6. Portal endpoint requires authenticated user with `stripeCustomerId` in KV and is rate-limited (5/min).

**Constraints:**

- Users compare plans on the Codeflare subscribe page (rich UI) and only see Stripe for payment confirmation.
- `billingStatus` verification endpoint (`GET /api/billing/status`) verifies against Stripe API as source of truth, falling back to KV when Stripe is unavailable.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-012](#req-sub-012-billing-status-enforcement-effective-tier)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/contact-team.test.ts (POST /auth/contact-team describe -> sendAccessRequestNotification called with userEmail+adminEmails+plan + defaults to Custom + 429 second-request + email-failure non-fatal + 401 unauth -> AC2,4,5) -->
### REQ-SUB-017: Enterprise tier contact flow

<!-- @impl: web-ui/src/components/SubscribePage.tsx -->

**Intent:** The Custom (enterprise) tier is not self-service. Users interested in enterprise-grade access can send an inquiry to admins without leaving the subscribe page.

**Applies To:** User

**Acceptance Criteria:**

1. The subscribe page shows "Let's talk" for the Custom tier instead of a checkout button
2. Clicking sends an inquiry email to admins via `POST /api/auth/contact-team`
3. After clicking, the button changes to "We'll get in touch" (disabled) to prevent duplicates
4. Rate-limited to 1 request per hour per user
5. When RESEND_API_KEY is not configured, the endpoint returns success but no email is sent

**Constraints:**

- Must comply with CON-SEC-004 (rate limiting)
- Email content includes the user's email and selected tier

**Priority:** P2

**Dependencies:** [REQ-SUB-001](#req-sub-001-eight-tier-subscription-system)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/usage.test.ts (GET /api/usage / REQ-SUB-018 AC2 describe -> Timekeeper live data when binding present and 200, KV fallback on TK 500 or missing binding, zero seconds on UTC month rollover, billing-aware effective tier for monthlyQuotaSeconds -> AC2 poll + KV fallback) -->
<!-- @test: web-ui/src/__tests__/stores/session-usage.test.ts (session-usage dismissed quota level / REQ-SUB-018 describe -> persists 80/95 dismissals to localStorage under month-scoped keys + ignores dismissal from previous UTC month + clears on month advance + no throw without localStorage -> AC4 dismiss per UTC month, AC5 95-dismiss-implies-80) -->
### REQ-SUB-018: Usage dashboard page

<!-- @impl: web-ui/src/components/UsagePage.tsx -->
<!-- @impl: web-ui/src/components/UsageInlineBadge.tsx -->
<!-- @impl: src/routes/usage.ts -->

**Intent:** Users can see their compute usage and understand how close they are to their quota.

**Applies To:** User

**Acceptance Criteria:**

1. `/app/usage` page shows progress ring for monthly usage, stat cards (today, this month, tier quota).
2. Polls `GET /api/usage` for real-time data from Timekeeper DO with KV fallback.
3. Warning banners at 80%, 95%, 100% thresholds in Layout.
4. The 80% and 95% banners include a dismiss button (x) that hides the banner until the next monthly quota rollover; dismissal is persisted per UTC month so a page reload does not resurface the warning, and the warning returns automatically when the quota resets at the start of the next month.
5. Dismissing the 95% banner also hides the 80% banner (since 95% implies 80%).
6. The 100% (quota exceeded) banner is not dismissible since it blocks session creation.

**Constraints:** None.

**Priority:** P2

**Dependencies:** [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Integration test

**Status:** Implemented

---

<!-- @test: web-ui/src/__tests__/components/Dashboard.test.tsx (Dashboard / REQ-SUB-019 describe -> session limit popup explains tier limit + lists running sessions with stop buttons + New Session button disabled when running+initializing >= maxSessions -> AC1, AC2, AC3) -->
### REQ-SUB-019: Session limit popup in frontend

<!-- @impl: web-ui/src/components/Dashboard.tsx -->

**Intent:** Users understand why they can't start more sessions and which ones to stop.

**Applies To:** User

**Acceptance Criteria:**

1. When running + initializing sessions >= `maxSessions`, the "New Session" button is disabled.
2. A popup explains the tier limit and lists running sessions with stop buttons.
3. `maxSessions` synced from `batch-status` endpoint.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-013](#req-sub-013-concurrent-session-limits)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-SUB-020: Multi-Currency Pricing

<!-- @impl: src/lib/currency.ts -->
<!-- @impl: src/lib/stripe.ts -->
<!-- @test: src/__tests__/lib/stripe.test.ts (multi-currency describe → currency_options + Checkout currency passthrough → AC1/AC3) -->
<!-- @test: src/__tests__/routes/auth.test.ts (auth tiers route → CF-IPCountry detection → AC2/AC4) -->
<!-- @test: src/__tests__/routes/billing.test.ts (billing checkout route → currency passthrough → AC3/AC5) -->

**Intent:** Visitors must see subscription prices in their local currency (CHF, USD, EUR, GBP) with Stripe charging the exact displayed amount -- no surprise FX conversion on the bank statement.

**Applies To:** User

**Acceptance Criteria:**

1. Each Stripe Price object has `currency_options` for USD, EUR, and GBP (CHF is the base currency), all at the same nominal amount.
2. `GET /api/auth/tiers` detects visitor currency from the `CF-IPCountry` request header and returns Stripe prices in that currency.
3. `POST /api/billing/checkout` detects visitor currency from `CF-IPCountry` and passes it to the Stripe Checkout Session so Stripe charges in the visitor's currency.
4. Country-to-currency mapping: CH/LI to CHF, GB to GBP, all other European countries to EUR, rest of world to USD.
5. Currency detection is server-side only; no user-facing currency switcher.

**Constraints:**

- Currency is auto-detected per request; there is no override mechanism.
- Stripe `currency_options` must be configured on each Price object in the Stripe Dashboard before this feature works.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-SUB-021: Billing Cycle Alignment

<!-- @impl: src/routes/stripe-webhook.ts -->
<!-- @impl: src/timekeeper/index.ts -->
<!-- @test: src/__tests__/routes/billing.test.ts (billing-cycle-anchor describe → 1st-of-UTC-month anchor + proration + trial-end anchor → AC1-AC6) -->

**Intent:** New paid subscriptions are billed on the 1st of each UTC calendar month so that recurring charges and monthly quota resets happen on the same date, eliminating the mid-cycle quota refresh that previously gave users roughly twice the paid quota between two billing charges.

**Applies To:** User

**Acceptance Criteria:**

1. When a user starts a Stripe checkout for a paid tier, the resulting subscription is anchored so that all recurring charges occur on the 1st of UTC month at 00:00:00.
2. The first charge is prorated for the partial period between the subscription's effective start (subscription creation for non-trial subscriptions, or trial end for trial subscriptions) and the next 1st of UTC month (e.g., subscribing on the 15th of a 30-day month with no trial results in a roughly 50% prorated first charge).
3. Subsequent monthly charges occur on the 1st of each UTC month.
4. Monthly quota reset and billing cycle both roll over on the same calendar date.
5. Existing subscriptions created before this behavior are not migrated - they retain their original billing anniversary.
6. When a free trial is active, the billing cycle anchor is the first 1st of UTC month strictly after the trial ends, so billing begins on that anchor date once the trial completes (or is ended early by quota consumption). Trial length itself is unaffected.

**Constraints:** None.

**Priority:** P1

**Dependencies:** [REQ-SUB-004](#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-006](#req-sub-006-real-time-usage-tracking-via-timekeeper-do)

**Verification:** Automated test

**Status:** Implemented
