# Billing and Entitlement

**Audience:** Operators, Developers

**Owns:** tier configuration, effective entitlement, checkout and provider synchronization, Timekeeper accounting, quota consequences, concurrent-session/mode policy, administrative tier changes, and commercial notifications.

**Does not own:** identity proof, JIT record creation, container teardown mechanics, webhook threat controls, or provider-secret placement.

## Contents

- [Commercial Model](#commercial-model)
- [Checkout and Subscription Lifecycle](#checkout-and-subscription-lifecycle)
- [Usage Accounting](#usage-accounting)
- [Enforcement](#enforcement)
- [Administrative Operations](#administrative-operations)
- [Commercial Notifications](#commercial-notifications)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

<a id="subscription-tiers"></a>
## Commercial Model

Codeflare uses eight stable tier IDs. Deployments may edit commercial values, but IDs and compatibility semantics remain part of the contract.

| ID | Default display | Hours/month | Sessions | Modes | Storage | Login |
|---|---|---:|---:|---|---:|---|
| `blocked` | Blocked | 0 | 0 | — | 0 | no |
| `pending` | Pending | 0 | 0 | — | 0 | yes, activation flow only |
| `free` | Free | 4h | 1 | Standard | 250 MB | yes |
| `trial` | Trial | 5h | 2 | Standard | 500 MB | yes |
| `standard` | Starter | 40h | 1 | Standard, Pro | 500 MB | yes |
| `advanced` | Advanced | 80h | 2 | Standard, Pro | 1 GB | yes |
| `max` | Max | 160h | 3 | Standard, Pro | 2 GB | yes |
| `unlimited` | Custom | unlimited | 5 | Standard, Pro | unlimited | yes |

`tiers:config` in KV stores deployment overrides. `getTierConfig()` caches the record for sixty seconds and falls back to source-defined defaults when no valid override is available. The provider returns display prices; admin configuration owns Standard and Pro Stripe price slots. <!-- @impl: src/lib/subscription.ts::getTierConfig -->

### Effective entitlement

The effective tier is not a frontend label. Source resolves current `subscriptionTier`, compatible legacy `accessTier`, billing status, configured tier existence/default, deployment mode, paid `subscribedMode`, and requested/stored session mode. Billing downgrade rules can reduce effective entitlement even when a stale user record names a higher tier. Provider truth is authoritative for paid subscription state; KV is its serving projection.

Legacy records without `subscriptionTier` retain their documented fallback. Non-SaaS deployments use their non-commercial access path; Enterprise applies its explicit override. [Authentication](authentication.md) owns identity and [User Provisioning](user-provisioning.md) owns initial record creation.

<a id="stripe-payment-integration"></a>
## Checkout and Subscription Lifecycle

### Checkout initiation

When Stripe is configured, paid tiers use Stripe Checkout; the free tier remains direct. The backend derives supported currency from `CF-IPCountry`, creates a provider session, and redirects to the hosted checkout. After `checkout=success`, the frontend polls auth status every three seconds without a total deadline; after five minutes it exposes a report-problem control and continues polling. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage -->

When Stripe is intentionally not configured, deployment policy may permit the direct subscription route. This is a configured mode, not a fail-open response to an unexpected provider outage. Turnstile behavior for initial activation is conditional on configuration and new-subscription state; the exact route contract belongs to the [API Reference](api-reference.md#auth-saas-mode).

### Stripe signal-and-sync

Webhooks are authenticated signals, not subscription truth. `checkout.session.completed`, update, and deletion events cause Codeflare to fetch the current provider state. `syncSubscriptionState()` resolves the user, obtains a monotonic per-user synchronization-start token from Timekeeper, and permits only the newest-started in-flight synchronization to apply. It preserves unrelated user fields; `lastSyncedAt` is recorded but is not the ordering authority. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->

Price metadata supplies mode when present; otherwise configured Standard/Pro price slots determine tier and mode. A mode or entitlement change reconciles agent configuration so removed capabilities do not persist from the previous subscription.

### Cancellation, past due, and provider unavailability

Cancellation writes the canceled billing state and applies the source-defined fallback entitlement. Billing-status enforcement controls whether provider grace/past-due states retain access. A missing or failed provider response never becomes newer subscription truth; reconciliation remains retryable and observable through the serving projection.

Webhook signature validation and replay/threat controls belong to [Security](security.md); exact webhook and checkout envelopes belong to the [API Reference](api-reference.md#billing).

<a id="timekeeper-do-usage-tracking"></a>
## Usage Accounting

One Timekeeper Durable Object owns each user's in-flight usage accumulator. A ping carries the bound bucket, session, cumulative total, and email. Timekeeper validates the bound identity, calculates a per-session delta, clamps one ping to 300 seconds, caps remembered sessions, persists accumulator state, and arms the flush alarm. <!-- @impl: src/timekeeper/index.ts -->

| State | Authority / behavior |
|---|---|
| `pendingSeconds` and per-session totals | Durable Object storage; restored through `blockConcurrencyWhile` |
| Aggregated day/week/month/year/all-time record | `timekeeper:{bucket}` KV after successful flush |
| Real-time usage query | Flushed KV plus pending durable accumulator |
| Monthly entitlement | Effective tier configuration, not a client-provided value |

Pending usage is decremented only after a successful KV write. Timekeeper identity mismatch fails closed with 403. Timekeeper itself is an accounting and quota signal, not an atomic session-admission reservation.

<a id="paygate-enforcement"></a>
## Enforcement

### Session-start quota gate

`POST /api/container/start` resolves effective tier, reads monthly usage, and returns HTTP 402 `QUOTA_EXCEEDED` when a finite quota is exhausted. It skips commercial quota enforcement outside SaaS and in explicit stress mode. If the quota KV read fails, the start check fails open to availability; the consequence is temporary overuse/cost exposure, not cross-user access. The error is logged and later accounting remains authoritative. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits -->

### Mid-session quota response

Timekeeper checks quota on pings. A confirmed exceeded quota asks the Container DO to stop with `SIGTERM`, allowing the lifecycle-owned final persistence drain. If Timekeeper cannot read the quota projection, the active-session check fails open rather than evicting on uncertain state; subsequent pings retry. Container teardown mechanics belong to [Container](container.md).

### Concurrent-session and mode gates

Concurrent-session admission uses the configured effective-tier limit and counts observed `running` plus `initializing` sessions. The KV count and later running write are not atomic, so simultaneous starts can exceed the nominal limit; this is best-effort resource protection, not a security boundary or hard billing reservation. Deployment `max_instances` remains a separate platform ceiling.

Advanced session authorization combines configured allowed modes, effective tier, paid `subscribedMode`, stored preference, billing downgrade, and Enterprise override. Settings cannot manufacture paid entitlement.

### User consequence and observability

The frontend renders `QUOTA_EXCEEDED`, disables starts at the observed session limit, and displays SaaS usage from batch status. Warnings appear at 80%, 95%, and 100% of monthly quota; only lower warnings are dismissible for the UTC month. User-facing displays are projections; server enforcement remains authoritative.

## Administrative Operations

<a id="admin-subscription-management"></a>
Administrators manage the six editable tiers; blocked and pending remain protected system states. The editor covers compute, sessions, storage, Standard/Pro provider price IDs, advanced-mode availability, trial quota, and description. Provider-returned display prices are read-only. `PUT /api/admin/tiers` validates the complete tier array and writes `tiers:config`; cache propagation is bounded by the sixty-second TTL. <!-- @impl: web-ui/src/components/admin/SubscriptionManagement.tsx::SubscriptionManagement -->

Changing a user to `advanced`, `max`, or `unlimited` may initialize the next-session preference to advanced, but effective authorization still follows the complete policy above. User transition mechanics belong to [User Provisioning](user-provisioning.md).

<a id="email-notifications"></a>
## Commercial Notifications

Subscription and administrator notifications are best-effort Resend messages scheduled without blocking the commercial state transition. Subscriber messages identify old/new plan and mode, quota/session effects, provider/trial status, and activation time. Administrator messages use the subscriber as reply-to. Provider-secret placement belongs to [Configuration](configuration.md).

Welcome delivery is not a billing event. It is claimed through the strongly serialized provisioning path and uses deterministic provider idempotency; [User Provisioning](user-provisioning.md) owns that handoff.

## Failure Posture and Residual Risk

| Boundary | Posture | Consequence / owner |
|---|---|---|
| Invalid checkout input or signature | Fail closed | No provider or user mutation; API/Security owners |
| Missing intentionally optional Stripe configuration | Configured direct-flow behavior | Deployment policy must make this explicit |
| Stale/out-of-order webhook | Newest-start token prevents older sync applying | Retry provider fetch; Billing owner |
| Tier-config read invalid/missing | Source defaults | Temporary configuration mismatch; operator logs/cache window |
| Session-start usage KV unavailable | Fail open | Temporary quota overrun/cost; Billing owner |
| Active-session quota projection unavailable | Fail open | Session continues until a later confirmed check |
| Simultaneous starts | Best effort | Nominal per-user limit may be exceeded; not a security boundary |

## Requirement and Source Map

Exhaustive requirement status remains in `sdd/spec/subscription.md`. This map records canonical concern entry points.

| Concern | Requirements / decisions | Implementation | Evidence |
|---|---|---|---|
| Tier and effective entitlement | [REQ-SUB-001](../../sdd/spec/subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-SUB-012](../../sdd/spec/subscription.md#req-sub-012-billing-status-enforcement-effective-tier) | `src/lib/subscription.ts` | subscription/access-tier suites |
| Stripe checkout and synchronization | [REQ-SUB-006](../../sdd/spec/subscription.md#req-sub-006-stripe-checkout-integration), [REQ-SUB-015](../../sdd/spec/subscription.md#req-sub-015-stripe-webhook-signal-and-sync-pattern) | `src/lib/stripe.ts`, `src/routes/stripe-webhook.ts` | checkout/webhook suites |
| Usage accounting and quota | [REQ-SUB-007](../../sdd/spec/subscription.md#req-sub-007-usage-tracking-via-timekeeper-durable-object), [REQ-SUB-008](../../sdd/spec/subscription.md#req-sub-008-mid-session-quota-enforcement-graceful-stop) | `src/timekeeper/index.ts`, lifecycle validation | Timekeeper/lifecycle suites |
| Concurrent sessions | [REQ-SUB-013](../../sdd/spec/subscription.md#req-sub-013-concurrent-session-limits), [AD6](../decisions/README.md#ad6-session-count-limits-use-kv-prefix-listing) | session lifecycle/counting | simultaneous-start evidence documents best-effort behavior |
| Usage display | [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page) | batch status and frontend usage surfaces | frontend behavioral suites |
| Currency | [REQ-SUB-020](../../sdd/spec/subscription.md#req-sub-020-multi-currency-pricing) | `src/lib/currency.ts` | currency suite |

<a id="specification-coverage"></a>
## Related Documentation

- [Authentication](authentication.md) — verified principal and middleware
- [User Provisioning](user-provisioning.md) — durable user transitions
- [Security](security.md) — webhook, credential, and abuse controls
- [API Reference](api-reference.md#billing) — checkout/status/webhook envelopes
- [Configuration](configuration.md) — public provider settings
- [Subscription requirements](../../sdd/spec/subscription.md) — exhaustive normative behavior
