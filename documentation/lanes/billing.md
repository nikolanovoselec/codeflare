# Billing & Subscription System

Stripe payment integration, subscription tiers, usage tracking, and paygate enforcement for Codeflare SaaS mode.

**Audience:** Operators, Developers

See [Authentication](authentication.md) for auth flows. See [User Provisioning](user-provisioning.md) for JIT provisioning and subscription UX.

---

## Contents

- [Subscription Tiers](#subscription-tiers)
- [Stripe Payment Integration](#stripe-payment-integration)
- [Timekeeper DO (Usage Tracking)](#timekeeper-do-usage-tracking)
- [Paygate Enforcement](#paygate-enforcement)
- [Admin Subscription Management](#admin-subscription-management)
- [Email Notifications](#email-notifications)

## Subscription Tiers

Codeflare uses a multi-tier subscription system that controls monthly compute hours, max concurrent sessions, and session modes. Tier IDs: `blocked`, `pending`, `free`, `trial`, `standard`, `advanced`, `max`, `unlimited`.

**Default tier configuration** (from `getDefaultTiers()` in `src/lib/subscription.ts`):

| ID | Display Name | Hours/Month | Sessions | Modes | Storage |
|----|-------------|-------------|----------|-------|---------|
| `blocked` | Blocked | 0 | 0 | - | 0 |
| `pending` | Pending | 0 | 0 | - | 0 |
| `free` | Free | 4h | 1 | Standard | 250 MB |
| `trial` | Trial | 5h | 2 | Standard | 500 MB |
| `standard` | Starter | 40h | 1 | Standard, Pro | 500 MB |
| `advanced` | Advanced | 80h | 2 | Standard, Pro | 1 GB |
| `max` | Max | 160h | 3 | Standard, Pro | 2 GB |
| `unlimited` | Custom | Unlimited | 5 | Standard, Pro | Unlimited |

Prices, trial hours, and other parameters are configurable per deployment via the admin Subscription Management panel. Prices come from Stripe via admin-configured `stripePriceId` per tier (CF-027).

**Graceful degradation:** When `STRIPE_SECRET_KEY` is not set, all tiers work via direct `POST /api/auth/subscribe` without payment.

**Tier storage and caching:**
- Stored in `user:{email}` KV record as `subscriptionTier`
- `getTierConfig()` reads from KV with 60-second module-level TTL, falling back to defaults
- Admin changes via `/admin/subscriptions` write to `tiers:config` KV key; take effect within 60 seconds

**Tier resolution logic (`src/lib/subscription.ts`):**
- `isActiveTier(tier)` - returns true for free/trial/standard/advanced/max/unlimited (undefined -> true for backward compat)
- `getUserTier(tierValue, tiers)` - resolves tier config; falls back to the tier with `isDefault: true`
- `getMaxSessionsForTier(tierValue, tiers)` - max concurrent sessions
- `getAllowedSessionModes(tierValue, tiers)` - list of allowed session modes

**Backward compatibility:** Legacy `accessTier` field (4-tier system) is maintained. Code reads `subscriptionTier` first, falls back to `accessTier`. Non-SaaS users without a tier default to `unlimited` access.

---

## Stripe Payment Integration

When `STRIPE_SECRET_KEY` is set as a Worker secret, paid tiers (standard, advanced, max) require Stripe Checkout before activation. Free tier remains direct (no payment).

**Architecture - Signal and Sync pattern:** Webhooks are signals that trigger a fetch of the latest state from Stripe. KV is a read cache, not the source of truth.

- Library: `src/lib/stripe.ts` - checkout session creation, webhook signature verification, `fetchSubscription()` (Signal and Sync), Stripe API communication
- Currency detection: `src/lib/currency.ts` - `getCurrencyForCountry(country)` maps ISO country code to CHF/USD/EUR/GBP. Implements [REQ-SUB-020](../../sdd/spec/subscription.md#req-sub-020-multi-currency-pricing).
- Billing routes: `src/routes/billing.ts` - `POST /api/billing/checkout`, `GET /api/billing/status`, `POST /api/billing/switch`
- Webhook: `src/routes/stripe-webhook.ts` - `POST /public/stripe/webhook` (unauthenticated, HMAC-verified)

**Checkout flow:**
1. User selects paid tier -> frontend calls `POST /api/billing/checkout` with `{ tier, mode }`
2. Backend detects visitor currency from `CF-IPCountry` header, creates Stripe Checkout Session
3. Frontend redirects to Stripe-hosted checkout
4. After payment, Stripe redirects to `/app/subscribe?checkout=success`
5. Frontend polls `GET /api/auth/status` every 2s (max 30s) waiting for webhook activation
6. Stripe sends `checkout.session.completed` -> handler maps email->customer, calls `syncSubscriptionState()`

**Webhook events handled:**
- `checkout.session.completed` - maps email->customer in KV, calls `syncSubscriptionState()`, sends admin notification
- `customer.subscription.updated` - delegates entirely to `syncSubscriptionState()`
- `customer.subscription.deleted` - writes `billingStatus: 'canceled'`, resets tiers to `free`

**`syncSubscriptionState(customerId, subscriptionId, env)`:**
1. Resolves email from customer ID (KV lookup with Stripe API fallback)
2. Calls `fetchSubscription()` - fetches latest subscription state from Stripe
3. Timestamp guard: skips write if KV's `lastSyncedAt` > now (prevents stale webhook overwriting newer state)
4. Writes via `updateUserRecord()` (preserves existing KV fields)
5. **Auto-reconcile on mode change:** `reconcileAgentConfigs()` runs on upgrade/downgrade and subscription termination. Seeds the correct preseed set. Implements [REQ-SUB-015](../../sdd/spec/subscription.md#req-sub-015-stripe-webhook-signal-and-sync-pattern) AC6-AC7.

**Security:**
- Webhook at `/public/stripe/webhook` bypasses CF Access (same as `/public/auth/providers`)
- HMAC-SHA256 signature verification via `crypto.subtle.timingSafeEqual()`
- 5-minute timestamp tolerance prevents replay attacks
- Event deduplication via `stripe:event:{eventId}` KV key with 72-hour TTL

**KV fields added to user record (billing):** `stripeCustomerId`, `stripeSubscriptionId`, `stripePriceId`, `billingPeriodEnd`, `checkoutSessionId`, `billingStatus` (`active`/`trialing`/`past_due`/`canceled`), `lastSyncedAt`, `cancelAtPeriodEnd`.

**Billing enforcement (`getEffectiveTier()`):**
- `billingStatus === CANCELED` -> immediate downgrade to `free`
- `billingStatus === PAST_DUE` + future `billingPeriodEnd` -> keep paid tier (grace period)
- `billingPeriodEnd` expired + `billingStatus === ACTIVE` -> downgrade to `free` (catches missed webhooks, CF-015)
- Stored `subscriptionTier` preserved in KV so resubscription restores the correct plan

**Trial model:** Every paid tier has a configurable `trialQuotaHours`. Trial is compute-based, not time-based. When trial compute quota is consumed, Timekeeper calls `endTrialNow()` to end the Stripe trial immediately and trigger the first charge. `trialUsed: true` set in KV prevents infinite free trials via subscribe->cancel->resubscribe.

---

## Timekeeper DO (Usage Tracking)

One Timekeeper Durable Object per user tracks compute usage. Container DOs ping Timekeeper every 60 seconds with monotonic `totalSeconds` per session. Timekeeper computes deltas, accumulates `pendingSeconds`, and flushes to KV via alarm every 5 minutes.

```
Container DO (session 1) --> ping --> Timekeeper DO (user X)
Container DO (session 2) --> ping --> Timekeeper DO (user X)
                                           |
                                  flush every 5 min (alarm)
                                           |
                                           v
                                KV: timekeeper:{bucketName}
```

**Ping handler** (`POST /ping`): receives `{ bucketName, sessionId, totalSeconds, email }`, computes delta per session, accumulates pendingSeconds, arms alarm, checks quota. Returns `{ quotaExceeded, totalMonthlySeconds }`.

**Usage query** (`GET /usage`): returns real-time usage (KV flushed + pending in-memory).

**Mid-session eviction:** when Timekeeper returns `quotaExceeded: true`, the Container DO calls `stop('SIGTERM')` (not SIGKILL) so the entrypoint trap runs the final rclone bisync before exit. See [REQ-SUB-008](../../sdd/spec/subscription.md#req-sub-008-mid-session-quota-enforcement-graceful-stop).

KV value shape at `timekeeper:{bucketName}`:
```typescript
interface UsageRecord {
  today:     { date: string; seconds: number };
  thisWeek:  { weekStart: string; seconds: number };
  thisMonth: { month: string; seconds: number };
  thisYear:  { year: string; seconds: number };
  allTime:   { seconds: number };
  lastUpdatedAt: string;
}
```

**Crash resilience:** Constructor restores all state via `blockConcurrencyWhile()`. Persisted fields: `pendingSeconds`, `sessionTotals`, `bucketName`, `email`, `lastFlushedMonthlyTotal`. Only decrements `pendingSeconds` after successful KV write.

**Security:**
- Identity validation: stores `bucketName` and `email` on first ping; subsequent pings with mismatched identity are rejected 403
- Delta clamping: per-ping delta capped at 300s (`MAX_DELTA_PER_PING`) to prevent corruption-driven usage spikes
- `sessionTotals` map capped at 30 entries (oldest evicted first) to prevent unbounded growth
- Only reachable via internal Worker-to-DO RPC, not public internet

---

## Paygate Enforcement

Session start (`POST /api/container/start`) checks tier-based usage quota in `validateSessionAndCheckLimits()`:
1. Resolves user's tier from `subscriptionTier ?? accessTier`
2. Reads monthly usage from `timekeeper:{bucketName}` KV
3. Compares against `tier.monthlySeconds` (skip for `null`/unlimited)
4. Throws `QuotaExceededError` (HTTP 402, code `QUOTA_EXCEEDED`) if exceeded
5. Skips for non-SaaS mode and stress test mode; fail-open on KV errors

Frontend detects `code === 'QUOTA_EXCEEDED'` and shows upgrade CTA.

**Usage display:** The `GET /api/sessions/batch-status` response includes an optional `usage` field (SaaS mode only) with `{ dailySeconds, monthlySeconds, monthlyQuotaSeconds, tier }`. Warning banners appear at 80%, 95%, 100% of monthly quota. The 80%/95% banners are dismissible per UTC month (localStorage). The 100% banner is not dismissible and blocks session creation. Implements [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page).

---

## Admin Subscription Management

Standalone admin page at `/admin/subscriptions`. Features:
- Displays 6 editable tiers (free, trial, standard, advanced, max, unlimited; blocked/pending are read-only)
- Edit form: monthly compute hours, max sessions, allowed session modes, monthly price, trial period, description
- Submit -> `PUT /api/admin/tiers` -> validates 8-tier array -> writes `tiers:config` to KV
- Admin changes take effect within 60 seconds (module-level cache refresh)

---

## Email Notifications

Notifications via Resend API (`src/lib/email.ts`, sender: `RESEND_EMAIL` secret). All sending is non-blocking and non-fatal. `RESEND_API_KEY` must be a Worker secret (`wrangler secret put`), not just a GitHub Actions secret.

**Subscription emails** (`sendSubscriptionEmail`): Show old/new plan+mode, compute hours, sessions, price, trial/billing status, activation timestamp, instance URL.

**Admin notifications** (`sendSubscriptionAdminNotification`): Same format, sent to all admin-role users. Reply-to set to subscriber's email.

**Welcome email:** JIT-provisioned users receive a welcome email on first login. A `welcome-sent:{email}` KV flag with 24h TTL prevents duplicate sends.

---

## Specification Coverage

- [REQ-SUB-001](../../sdd/spec/subscription.md#req-sub-001-eight-tier-subscription-system) - Eight-Tier Subscription System
- [REQ-SUB-002](../../sdd/spec/subscription.md#req-sub-002-tier-property-definitions) - Tier Property Definitions
- [REQ-SUB-006](../../sdd/spec/subscription.md#req-sub-006-real-time-usage-tracking-via-timekeeper-do) - Real-Time Usage Tracking via Timekeeper DO
- [REQ-SUB-007](../../sdd/spec/subscription.md#req-sub-007-quota-enforcement-at-session-start-402) - Quota Enforcement at Session Start (402)
- [REQ-SUB-010](../../sdd/spec/subscription.md#req-sub-010-tier-config-cached-with-60-second-ttl) - Tier Config Cached with 60-Second TTL
- [REQ-SUB-012](../../sdd/spec/subscription.md#req-sub-012-billing-status-enforcement-effective-tier) - Billing Status Enforcement (Effective Tier)
- [REQ-SUB-013](../../sdd/spec/subscription.md#req-sub-013-concurrent-session-limits) - Concurrent Session Limits
- [REQ-SUB-014](../../sdd/spec/subscription.md#req-sub-014-session-mode-gating-by-tier) - Session Mode Gating by Tier
- [REQ-SUB-017](../../sdd/spec/subscription.md#req-sub-017-enterprise-tier-contact-flow) - Enterprise tier contact flow
- [REQ-SUB-019](../../sdd/spec/subscription.md#req-sub-019-session-limit-popup-in-frontend) - Session limit popup in frontend

---

## Related Documentation

- [Authentication](authentication.md) - Auth flows, SaaS mode, three-tier middleware
- [User Provisioning](user-provisioning.md) - JIT provisioning, subscribe page, frontend components
- [Configuration](configuration.md#secrets) - Worker secrets
- [Architecture](architecture.md) - System overview
