<a id="billing--subscription-system"></a>
<a id="billing-and-entitlement"></a>
<a id="administration-and-historical-usage"></a>
# Billing & Usage

**Audience:** Operators, Developers

**Owns:** tier configuration, effective entitlement, checkout/provider synchronization, Timekeeper accounting, quota consequences, concurrent-session/mode policy, administrative tier changes, commercial notifications, historical organization usage, analytics, deleted-user history, report delivery, and retention.

**Does not own:** identity proof, JIT creation, routine Environment editing, container teardown mechanics, webhook threat controls, provider-secret placement, or D1 session-lifecycle authority.

## Contents

- [Commercial Model](#commercial-model)
- [Checkout and Subscription Lifecycle](#checkout-and-subscription-lifecycle)
- [Usage Accounting](#usage-accounting)
- [Enforcement](#enforcement)
- [Administrative Operations](#administrative-operations)
- [Commercial Notifications](#commercial-notifications)
- [Historical Accounting and Analytics](#historical-accounting-and-analytics)
- [D1 Database and Migrations](#d1-database-and-migrations)
- [Retention and Reports](#retention-and-reports)
- [Operation Envelope and Logging](#operation-envelope-and-logging)
- [Failure Posture and Residual Risk](#failure-posture-and-residual-risk)
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

Legacy records without `subscriptionTier` retain their documented fallback. Non-SaaS deployments use their non-commercial access path; Enterprise applies its explicit override. [Authentication](authentication.md) owns identity and initial durable record creation.

<a id="stripe-payment-integration"></a>
## Checkout and Subscription Lifecycle

### Checkout initiation

When Stripe is configured, paid tiers use Stripe Checkout; the free tier remains direct. The backend derives supported currency from `CF-IPCountry`, creates a provider session, and redirects to hosted checkout. After `checkout=success`, the frontend polls auth status every three seconds without a total deadline; after five minutes it exposes a report-problem control and continues polling. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage -->

When Stripe is intentionally not configured, deployment policy may permit the direct subscription route. This is a configured mode, not a fail-open response to an unexpected provider outage. Turnstile behavior for initial activation is conditional on configuration and new-subscription state; the exact route contract belongs to [API Reference](api-reference.md#auth-saas-mode).

### Stripe signal-and-sync

Webhooks are authenticated signals, not subscription truth. `checkout.session.completed`, update, and deletion events cause Codeflare to fetch current provider state. `syncSubscriptionState()` resolves the user, obtains a monotonic per-user synchronization-start token from Timekeeper, and permits only the newest-started in-flight synchronization to apply. It preserves unrelated user fields; `lastSyncedAt` is recorded but is not ordering authority. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->

Price metadata supplies mode when present; otherwise configured Standard/Pro price slots determine tier and mode. A mode or entitlement change reconciles agent configuration so removed capabilities do not persist from the previous subscription.

### Cancellation, past due, and provider unavailability

Cancellation writes the canceled billing state and applies source-defined fallback entitlement. Billing-status enforcement controls whether provider grace/past-due states retain access. A missing or failed provider response never becomes newer subscription truth; reconciliation remains retryable and observable through the serving projection.

Webhook signature validation and replay/threat controls belong to [Security](security.md); exact envelopes belong to [API Reference](api-reference.md#billing).

<a id="timekeeper-do-usage-tracking"></a>
## Usage Accounting

One Timekeeper Durable Object owns each user's in-flight usage accumulator. A ping carries bound bucket, session, cumulative total, and email. Timekeeper validates the bound identity, calculates a per-session delta, clamps one ping to 300 seconds, caps remembered session totals at 30 hashed identities, persists accounting state, and arms its alarm. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

| State | Authority / behavior |
|---|---|
| `pendingSeconds`, per-session totals, live baseline, period counters | Versioned `accountingState:v2` in Timekeeper storage; restored through `blockConcurrencyWhile`, migrating legacy accumulator keys |
| Aggregated day/week/month/year/all-time serving record | `timekeeper:{bucket}` KV after successful flush |
| Real-time usage query | Flushed KV plus pending durable accumulator |
| Monthly entitlement | Effective tier configuration, not client-provided quota or a historical D1 total |
| Historical snapshots/outbox | Timekeeper period state and retained rollover outbox feed D1 separately; acknowledgment releases sent outbox entries |

Pending usage is decremented only after a successful KV write. Timekeeper identity mismatch fails closed with 403. Usage accumulates in every mode; SaaS additionally owns quota/trial decisions. Timekeeper is an accounting and quota signal, not an atomic session-admission reservation. D1 history may lag this live path and never overrides quota truth.

<a id="paygate-enforcement"></a>
## Enforcement

### Session-start quota gate

`POST /api/container/start` resolves effective tier, reads monthly usage, and returns HTTP 402 `QUOTA_EXCEEDED` when a finite quota is exhausted. It skips commercial quota enforcement outside SaaS, in Enterprise, and in explicit stress mode. A failed usage KV read does not reject the start on quota uncertainty; the consequence is temporary overuse/cost exposure, not cross-user access. This is distinct from session-authority failure, which fails Start closed. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits -->

### Mid-session quota response

Timekeeper checks quota on pings. A confirmed exceeded quota asks the Container DO to stop with `SIGTERM`, allowing the lifecycle-owned final persistence drain. If Timekeeper cannot read the quota projection, the active-session check fails open rather than evicting on uncertain state; subsequent pings retry. Container teardown mechanics belong to [Container](container.md).

### Concurrent-session and mode gates

Concurrent-session admission counts other D1 sessions in `starting`, `running`, `unreachable`, or `stopping`. SaaS uses effective-tier limits; non-SaaS retains role-based limits. The count and later generation claim are not atomic, so simultaneous starts can exceed the nominal limit. This remains best-effort resource protection, not a security boundary or hard billing reservation. D1 query failure fails Start closed; deployment `max_instances` is a separate platform ceiling.

Advanced session authorization combines configured allowed modes, effective tier, paid `subscribedMode`, stored preference, billing downgrade, and Enterprise override. Settings cannot manufacture paid entitlement.

### User consequence and observability

The frontend renders `QUOTA_EXCEEDED`, disables starts at the observed session limit, and displays SaaS usage from the separate ancillary status projection. Warnings appear at 80%, 95%, and 100% of monthly quota; only lower warnings are dismissible for the UTC month. User-facing displays are projections; server enforcement remains authoritative.

## Administrative Operations

<a id="admin-subscription-management"></a>
Administrators manage six editable tiers; blocked and pending remain protected system states. The editor covers compute, sessions, storage, Standard/Pro provider price IDs, advanced-mode availability, trial quota, and description. Provider-returned display prices are read-only. `PUT /api/admin/tiers` validates the complete tier array and writes `tiers:config`; cache propagation is bounded by the sixty-second TTL. <!-- @impl: web-ui/src/components/admin/SubscriptionManagement.tsx::SubscriptionManagement -->

Changing a user to `advanced`, `max`, or `unlimited` may initialize the next-session preference to advanced, but effective authorization follows the complete policy above. [Authentication](authentication.md#approval-and-activation) owns user transitions. [Configuration](configuration.md#routine-administration) owns the routine Administration shell and Environment review/apply experience, not entitlement.

<a id="email-notifications"></a>
## Commercial Notifications

Subscription and administrator notifications are best-effort Resend messages scheduled without blocking the commercial state transition. Subscriber messages identify old/new plan and mode, quota/session effects, provider/trial status, and activation time. Administrator messages use the subscriber as reply-to. Provider-secret placement belongs to [Configuration](configuration.md).

Welcome delivery is not a billing event. It is claimed through the strongly serialized provisioning path and uses deterministic provider idempotency; [Authentication](authentication.md#welcome-delivery-handoff) owns that handoff.

<a id="runtime-ownership"></a>
## Historical Accounting and Analytics

Timekeeper Durable Objects and KV remain live quota owners. D1 owns historical organization usage, deleted-user tombstones, report delivery claims, and retention claims. The same `USAGE_DB` binding also contains session lifecycle tables, but their authority belongs to [Architecture](architecture.md#state-ownership-and-durability) and [Container](container.md), not historical billing. Historical analytics starts empty after rollout and never reconstructs old usage from quota records. ([REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

Overview reads current-day historical usage on navigation and lists applicable Environment areas. Analytics period buttons immediately request the selected period; editing a start date requires Apply filters. Weeks start Monday at 00:00 UTC. Equal day/week/month/year totals can reflect collection beginning within the current day; older quota usage is not backfilled. ([REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting), [REQ-SETUP-019](../../sdd/spec/setup.md#req-setup-019-administration-and-analytics-shell))

Analytics and Reports are demand-driven: navigation, filter changes, explicit refresh, or run reconnect initiate reads, not background polling. Analytics charts bounded actual totals from existing D1 period rows; `historyUpdatedAt` identifies the newest returned row because snapshots can lag live Timekeeper usage. Activity follows the same demand-driven principle under Configuration. ([REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/lib/admin-usage.ts::queryAdminUsageSeries --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage -->

Historical rows retain normalized named user aggregates, including deleted-user history. Account cleanup first requires a D1 tombstone, rather than pretending retained history was removed with the live user record. User detail and CSV exports remain admin-gated; [API Reference](api-reference.md#admin) owns their request/response contracts.

## D1 Database and Migrations

Each deployment uses one D1 database named `<worker-name>-usage`, bound as `USAGE_DB`. Deployment lists exact names, rejects duplicates, creates the database when absent, writes its ID into temporary `wrangler.toml`, and applies migrations before Worker deployment. Account and database IDs do not belong in source. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 -->

`migrations/usage/0001_initial.sql` additively creates historical users/periods, report deliveries, and maintenance claims. It is not the complete current schema: `migrations/usage/0002_runtime_sessions.sql` also defines D1 session records and cutover admission. Apply the deployment's full migration set before traffic; do not publish against missing schema. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: migrations/usage/0001_initial.sql::usage_users -->

D1 and KV are separate restore systems. KV restoration recovers its configuration/run/usage projections, not D1 history, report claims, or runtime sessions. Use Cloudflare D1 Time Travel or the account's approved backup procedure for `USAGE_DB` and verify migrations before restoring traffic. An older D1 restore can remove newer history and delivery evidence; never manufacture replacement history from current quota totals. Session-generation/ownership consequences belong to the lifecycle owner. ([AD150](../decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records))

<a id="deployment-credentials"></a>
### Deployment credential boundary

Deployment continues to use established `CLOUDFLARE_API_TOKEN` with D1 Edit and existing Worker deployment permissions. It resolves/migrates the database, deploys, and preserves the Worker secret. Store the token and account ID only in existing repository/target-environment Actions secret scope, never source, D1, Activity, or report history. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: .github/workflows/deploy.yml::deploy -->

Deployment credentials are distinct from session credentials. Non-Enterprise PAT sessions may receive their connected real token/account ID; OAuth uses the Worker-mediated placeholder. Enterprise receives only the Browser Run placeholder and configured non-secret account ID; the real Browser Rendering token remains Worker-side. [Configuration](configuration.md) owns exact placement/precedence and [Security](security.md) owns containment. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @impl: src/container/container-env.ts::buildEnvVars -->

## Retention and Reports

Historical rows use UTC periods. Active day rows retain current day plus 399 preceding days, week rows retain 59 preceding ISO weeks, month rows retain 59 preceding months, and year rows retain four preceding years. Deleted users and named aggregate rows remain 60 calendar months; report deliveries remain 60 calendar months; maintenance claims remain 35 UTC days. ([REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting), [REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-028](../../sdd/spec/subscription.md#req-sub-028-historical-usage-and-report-retention)) <!-- @impl: src/lib/usage-report-scheduler.ts::retentionCutoffs -->

One 15-minute scheduler owns report dispatch, recovery, and a once-daily token-guarded retention transaction. Reports default disabled. KV stores schedule next-due instants under `admin:usage-reports:next:<settingsRevision>` so a stale revision cannot consume the current schedule. Each enabled recipient gets a separately claimed delivery with at most three attempts. `accepted` means Resend accepted the request, not inbox delivery; no provider ID is invented. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods)) <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler -->

CSV attachments stop at 8 MiB. Scheduled messages report latest closed UTC month with deterministic idempotency; tests report current UTC month using request identity so two test clicks remain distinct. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods)) <!-- @impl: src/lib/usage-reports.ts::buildReportArtifacts --> <!-- @impl: src/routes/admin/usage-reports.ts::default -->

## Operation Envelope and Logging

At 2,000 active developers with three sessions each, a steady-state non-SaaS positive Timekeeper ping with cached period markers performs one sub-4-KB accounting-state write and no KV reads. First marker observation can read durable marker state and write up to four marker keys plus rollover outbox entries. SaaS additionally reads quota KV, tier config, and user records. Historical D1 writes run once per user on a hash-phased 15-minute duty, not once per session. Stable visible session polls use 60 seconds, transitions five seconds, and hidden pages stop. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

D1 history metrics record rows read/written, SQL duration, backlog age and snapshot count without emails or secrets. Sampling placement and non-default rollout verification belong to the [private deployment-testing owner](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/verification/deployment-testing.md). History acceptance requires operation/spend alerts and discoverability of caught structured errors and uncaught exceptions under the intended sampling; reference prose is not completion evidence. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: scripts/ci/set-head-sampling.mjs::setHeadSampling -->

Historical pricing assumptions are not current price guarantees; the [original dated assumptions](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/administration-analytics.md#operation-envelope-and-logging) retain their observation scope. Verify included-operation and overage prices through the deployment owner before approving new spend. The continuous stress model's under-48-million billed-row-write envelope includes indexes and retention; the existing CI guard is not a new acceptance claim. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

<a id="design-source-review"></a>
<a id="integration-acceptance-checklist"></a>
### Historical rollout evidence

The [original design-source review](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/administration-analytics.md#design-source-review) and [Integration checklist](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/administration-analytics.md#integration-acceptance-checklist) preserve the historical checkpoint and its outstanding browser/manual checks. They are not current reference procedures or evidence that acceptance completed. Active status and verification qualifiers remain in SDD.

## Failure Posture and Residual Risk

| Boundary | Posture | Consequence / owner |
|---|---|---|
| Invalid checkout input or signature | Fail closed | No provider or user mutation; API/Security |
| Intentionally optional Stripe | Configured direct flow | Deployment policy must be explicit |
| Stale/out-of-order webhook | Newest-start token rejects older sync | Retry provider fetch; Billing |
| Tier-config read invalid/missing | Source defaults | Temporary configuration mismatch/cache window |
| Usage KV unavailable | Quota fails open | Temporary overrun/cost; later confirmed check retries |
| Session authority unavailable | Start fails closed | Never infer authority from quota, SDK, or client cache |
| Simultaneous starts | Best effort | Nominal per-user limit may be exceeded |
| Historical D1 unavailable | Retain outbox/retry; history can lag | Never reconstruct from quota totals |
| Tombstone unavailable | Account deletion fails closed before live cleanup | Authentication/offboarding handoff |
| Report accepted | Provider acceptance only | Never claim inbox delivery |

## Requirement and Source Map

This is navigation, not coverage or acceptance promotion. Status remains in [Subscription SDD](../../sdd/spec/subscription.md).

| Concern | Requirements / decisions | Source / behavioral evidence |
|---|---|---|
| Tier/effective entitlement | [REQ-SUB-001](../../sdd/spec/subscription.md#req-sub-001-eight-tier-subscription-system), [REQ-SUB-012](../../sdd/spec/subscription.md#req-sub-012-billing-status-enforcement-effective-tier) | `src/lib/subscription.ts`; subscription/access-tier suites |
| Stripe checkout/sync | [REQ-SUB-004](../../sdd/spec/subscription.md#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-015](../../sdd/spec/subscription.md#req-sub-015-stripe-webhook-signal-and-sync-pattern) | `src/lib/stripe.ts`, `src/routes/stripe-webhook.ts`; checkout/webhook suites |
| Accounting/quota | [REQ-SUB-006](../../sdd/spec/subscription.md#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-007](../../sdd/spec/subscription.md#req-sub-007-quota-enforcement-at-session-start-402), [REQ-SUB-008](../../sdd/spec/subscription.md#req-sub-008-mid-session-quota-enforcement-graceful-stop) | `src/timekeeper/index.ts`, lifecycle validation; Timekeeper/lifecycle suites |
| Concurrent sessions | [REQ-SUB-013](../../sdd/spec/subscription.md#req-sub-013-concurrent-session-limits), [AD6](../decisions/README.md#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) | D1 lifecycle/counting; simultaneous-start evidence remains best effort |
| Personal usage display | [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page), [REQ-SUB-024](../../sdd/spec/subscription.md#req-sub-024-usage-page-product-context) | usage/ancillary routes and frontend; behavioral suites |
| Currency | [REQ-SUB-020](../../sdd/spec/subscription.md#req-sub-020-multi-currency-pricing) | `src/lib/currency.ts`; currency suite <!-- @impl: src/lib/currency.ts::getCurrencyForCountry --> |
| Historical accounting/analytics | [REQ-SUB-025 through REQ-SUB-028](../../sdd/spec/subscription.md), [REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [AD150](../decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records) | `src/timekeeper/`, `src/lib/admin-usage.ts`, `src/routes/admin/usage.ts` |
| Reports/claims/email/retention | [REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-028](../../sdd/spec/subscription.md#req-sub-028-historical-usage-and-report-retention), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods) | `src/lib/usage-report-scheduler.ts`, `src/lib/usage-reports.ts`, `src/routes/admin/usage-reports.ts` |
| Administration UI/demand reads | [REQ-SETUP-019](../../sdd/spec/setup.md#req-setup-019-administration-and-analytics-shell), [REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope) | `web-ui/src/components/admin/`, `web-ui/src/api/client.ts` |
| Deployment boundary | [REQ-OPS-056 through REQ-OPS-057](../../sdd/spec/operations.md) | `scripts/ci/prepare-usage-d1.mjs`, `.github/workflows/deploy.yml` |

The session-store facade and recurring poller share the personal usage-state owner; neither reconstructs historical D1 analytics from quota totals. <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @impl: web-ui/src/stores/session-polling.ts::refreshSessionStatuses --> <!-- @impl: web-ui/src/stores/session-usage.ts::setUsageState -->

<a id="specification-coverage"></a>
## Related Documentation

- [Authentication](authentication.md) — verified principal, provisioning, offboarding
- [Configuration](configuration.md) — routine Environment settings and credential placement
- [Security](security.md) — webhook, credential, and abuse controls
- [API Reference](api-reference.md#billing) — checkout/status/webhook contracts
- [API Reference — Admin](api-reference.md#admin) — historical usage and report endpoints
- [Deployment](deployment.md) — migration/deploy/restore procedures
- [Architecture](architecture.md) — distinct session, quota, and historical authorities
