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

## REQ-SUB-001: Eight-Tier Subscription System

**Intent:** The platform must support a graduated set of subscription tiers that control access levels, compute quotas, session limits, and available features.

**Acceptance Criteria:**
1. Exactly 8 tier IDs exist: `blocked`, `pending`, `free`, `trial`, `standard`, `advanced`, `max`, `unlimited`.
2. Each tier defines all of: `monthlySeconds`, `maxSessions`, `sessionModes`, `canLogin`, `priceMonthly`, `trialQuotaHours`, `maxStorageBytes`, `displayName`, `description`, `order`, `isDefault`.
3. `getDefaultTiers()` returns the complete 8-tier array as the hardcoded fallback.
4. Tier IDs are stable identifiers; display names may differ (e.g., `standard` displays as "Starter").

**Constraints:**
- One tier must have `isDefault: true` (currently `standard`) as fallback for undefined/missing users.
- The `blocked` tier must have `canLogin: false`; `pending` must have `canLogin: true` (to access the subscribe page).

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-002: Tier Property Definitions

**Intent:** Each tier must define a complete set of properties that drive quota enforcement, session limits, mode gating, and pricing.

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

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SUB-001
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-003: Free Tier Requires No Payment

**Intent:** Users must be able to use the platform at the free tier without providing payment information.

**Acceptance Criteria:**
1. `POST /api/auth/subscribe` with `tier: 'free'` activates the tier directly via KV write, no Stripe interaction.
2. The free tier has `priceMonthly: 0`.
3. When `STRIPE_SECRET_KEY` is set, the free tier still bypasses Stripe Checkout.
4. Free-tier users have `billingStatus` fields that remain null/absent.

**Constraints:**
- Free-tier auto-sleep is locked to 15 minutes; the dropdown is disabled in the frontend.
- Free tier is limited to 1 concurrent session.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SUB-001
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-004: Paid Tiers Integrate with Stripe Checkout

**Intent:** Paid tiers (standard, advanced, max) must collect payment via Stripe before activating the subscription.

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

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-001, REQ-SUB-003
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SUB-005: Trial Is Compute-Based, Not Time-Based

**Intent:** Trial periods must be capped by actual compute usage, not calendar days, so that inactive users do not burn through their trial.

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

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-004, REQ-SUB-006
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SUB-006: Real-Time Usage Tracking via Timekeeper DO

**Intent:** Compute usage must be tracked accurately in real time so that quota enforcement and billing decisions use current data.

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

**Applies To:** User
**Priority:** P0
**Dependencies:** None
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-007: Quota Enforcement at Session Start (402)

**Intent:** Users who have consumed their monthly compute quota must be prevented from starting new sessions.

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

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SUB-006, REQ-SUB-012
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-008: Mid-Session Quota Enforcement (Graceful Stop)

**Intent:** Sessions that exceed quota while running must be stopped gracefully, not left running indefinitely.

**Acceptance Criteria:**
1. When Timekeeper's ping handler returns `quotaExceeded: true`, the Container DO calls `stop('SIGTERM')` for graceful shutdown.
2. The SIGTERM signal allows the container to perform final sync before exit.
3. The `quotaExceeded` flag is returned alongside `totalMonthlySeconds` in the ping response.

**Constraints:**
- Mid-session eviction must allow the final bisync to complete (graceful, not immediate kill).
- The check happens on each 60-second ping, not continuously.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SUB-006, REQ-SUB-007
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SUB-009: Admin-Configurable Tiers via Management Panel

**Intent:** Administrators must be able to customize tier properties (quotas, prices, sessions, storage) without code changes.

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

**Applies To:** Admin
**Priority:** P1
**Dependencies:** REQ-SUB-001, REQ-AUTH-005
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-010: Tier Config Cached with 60-Second TTL

**Intent:** Tier configuration reads must be fast (avoid KV round-trip on every request) while still reflecting admin changes within a bounded delay.

**Acceptance Criteria:**
1. `getTierConfig()` uses a module-level cache with 60-second TTL.
2. Within the TTL window, cached tier config is returned without KV read.
3. After TTL expiry, the next call reads from KV and refreshes the cache.
4. `resetTierConfigCache()` allows tests to force cache invalidation.
5. Admin changes take effect within 60 seconds across all isolates.

**Constraints:**
- Each Cloudflare Worker isolate maintains its own cache; there is no cross-isolate invalidation.
- The 60-second TTL is per-isolate, not globally synchronized.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-009
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-011: Graceful Degradation Without Stripe

**Intent:** The platform must function without Stripe for development, self-hosted, and non-SaaS deployments.

**Acceptance Criteria:**
1. When `STRIPE_SECRET_KEY` is not set, all tiers work via direct `POST /api/auth/subscribe` without payment.
2. Billing status fields remain null in user records.
3. `getEffectiveTier()` does not downgrade paid tiers when billing fields are absent and Stripe is not configured.
4. The subscribe page functions normally, showing tiers without payment buttons.

**Constraints:**
- Non-SaaS users without a tier default to `unlimited` access for backward compatibility.
- Legacy `accessTier` field is maintained in KV; code reads `subscriptionTier` first, falls back to `accessTier`.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-001
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-012: Billing Status Enforcement (Effective Tier)

**Intent:** A user's effective tier must reflect their current billing state, automatically downgrading when payment lapses.

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

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SUB-001, REQ-SUB-004
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-013: Concurrent Session Limits

**Intent:** Each tier must enforce a maximum number of simultaneously running sessions to control resource consumption.

**Acceptance Criteria:**
1. `getMaxSessionsForTier(tierValue, tiers)` returns the `maxSessions` value for the user's tier.
2. Session creation is rejected when running + initializing sessions >= `maxSessions`.
3. The frontend disables the start button when `isAtSessionLimit()` returns true and shows a popup explaining the limit.
4. `batch-status` returns `maxSessions` so the frontend can enforce limits client-side.

**Constraints:**
- Session limit check uses the effective tier, not the stored tier.
- `STRESS_TEST_MODE` bypasses session limits.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SUB-001, REQ-SUB-012
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-014: Session Mode Gating by Tier

**Intent:** Only tiers that include Pro (advanced) mode in their `sessionModes` array may create Pro sessions.

**Acceptance Criteria:**
1. `getAllowedSessionModes(tierValue, tiers)` returns the list of modes allowed for the user's tier.
2. Free and trial tiers only allow `['default']` (Standard mode).
3. Standard, advanced, max, and unlimited tiers allow `['default', 'advanced']` (Standard and Pro modes).
4. Session creation or mode change requests for an unsupported mode are rejected.

**Constraints:**
- `subscribedMode` in the user record is the source of truth for Pro access (set by Stripe webhook or admin).
- JIT-provisioned users default to `'default'` mode.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-SUB-001, REQ-AGENT-004
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-015: Stripe Webhook Signal-and-Sync Pattern

**Intent:** KV billing state must always reflect the latest Stripe state to prevent race conditions from incremental patching.

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

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-004, REQ-SUB-012
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SUB-016: Customer Portal and Plan Switching

**Intent:** Active subscribers must be able to manage their subscription (cancel, switch plans, update payment) via Stripe's billing portal.

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

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-004, REQ-SUB-012
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SUB-017: Enterprise tier contact flow

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
**Dependencies:** REQ-SUB-001
**Verification:** Integration test
**Status:** Implemented

---

## REQ-SUB-018: Usage dashboard page

**Intent:** Users can see their compute usage and understand how close they are to their quota.

**Acceptance Criteria:**
1. `/app/usage` page shows progress ring for monthly usage, stat cards (today, this month, tier quota).
2. Polls `GET /api/usage` for real-time data from Timekeeper DO with KV fallback.
3. Warning banners at 80%, 95%, 100% thresholds in Layout.
4. The 80% and 95% banners include a dismiss button (×) that hides the banner until the next monthly quota rollover. Dismissal is persisted per UTC month so a page reload does not resurface the warning, but the warning returns automatically when the quota resets at the start of the next month. Dismissing the 95% banner also hides the 80% banner (since 95% implies 80%).
5. The 100% (quota exceeded) banner is not dismissible since it blocks session creation.

**Constraints:**
- None

**Applies To:** User
**Priority:** P2
**Dependencies:** REQ-SUB-006
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SUB-019: Session limit popup in frontend

**Intent:** Users understand why they can't start more sessions and which ones to stop.

**Acceptance Criteria:**
1. When running + initializing sessions >= `maxSessions`, the "New Session" button is disabled.
2. A popup explains the tier limit and lists running sessions with stop buttons.
3. `maxSessions` synced from `batch-status` endpoint.

**Constraints:**
- None

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-013
**Verification:** Integration test

**Status:** Implemented

---

## REQ-SUB-020: Multi-Currency Pricing

**Intent:** Visitors must see subscription prices in their local currency (CHF, USD, EUR, GBP) with Stripe charging the exact displayed amount -- no surprise FX conversion on the bank statement.

**Acceptance Criteria:**
1. Each Stripe Price object has `currency_options` for USD, EUR, and GBP (CHF is the base currency), all at the same nominal amount.
2. `GET /api/auth/tiers` detects visitor currency from the `CF-IPCountry` request header and returns Stripe prices in that currency.
3. `POST /api/billing/checkout` detects visitor currency from `CF-IPCountry` and passes it to the Stripe Checkout Session so Stripe charges in the visitor's currency.
4. Country-to-currency mapping: CH/LI to CHF, GB to GBP, all other European countries to EUR, rest of world to USD.
5. Currency detection is server-side only; no user-facing currency switcher.

**Constraints:**
- Currency is auto-detected per request; there is no override mechanism.
- Stripe `currency_options` must be configured on each Price object in the Stripe Dashboard before this feature works.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-004
**Verification:** Automated test

**Status:** Implemented

---

## REQ-SUB-021: Billing Cycle Alignment

**Intent:** New paid subscriptions are billed on the 1st of each UTC calendar month so that recurring charges and monthly quota resets happen on the same date, eliminating the mid-cycle quota refresh that previously gave users roughly twice the paid quota between two billing charges.

**Acceptance Criteria:**
1. When a user starts a Stripe checkout for a paid tier, the resulting subscription is anchored so that all recurring charges occur on the 1st of UTC month at 00:00:00.
2. The first charge is prorated for the partial period between the subscription's effective start (subscription creation for non-trial subscriptions, or trial end for trial subscriptions) and the next 1st of UTC month (e.g., subscribing on the 15th of a 30-day month with no trial results in a roughly 50% prorated first charge).
3. Subsequent monthly charges occur on the 1st of each UTC month.
4. Monthly quota reset and billing cycle both roll over on the same calendar date.
5. Existing subscriptions created before this behavior are not migrated — they retain their original billing anniversary.
6. When a free trial is active, the billing cycle anchor is the first 1st of UTC month strictly after the trial ends, so billing begins on that anchor date once the trial completes (or is ended early by quota consumption). Trial length itself is unaffected.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-004, REQ-SUB-006
**Verification:** Automated test

**Status:** Implemented
