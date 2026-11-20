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

`tiers:config` in KV stores deployment overrides. `getTierConfig()` caches the result for sixty seconds. Absent data and caught KV read/JSON-parse failures use source-defined defaults; stored admin values take priority while missing fields merge from defaults. Stored shape is not validated here: valid JSON with an invalid shape can throw during the merge outside the read catch. The provider returns display prices; admin configuration owns Standard and Pro Stripe price slots. <!-- @impl: src/lib/subscription.ts::getTierConfig -->

### Effective entitlement

The effective tier is not a frontend label. Source resolves current `subscriptionTier`, compatible legacy `accessTier`, billing status, configured tier existence/default and deployment mode. Its configured allowed modes constrain the requested/stored session mode; `subscribedMode` remains subscription metadata, not an independent Pro entitlement. Billing downgrade rules can reduce entitlement despite stale higher-tier metadata. Provider truth is authoritative for paid subscription state; KV is its serving projection.

Legacy records without `subscriptionTier` retain their documented fallback. Non-SaaS deployments use their non-commercial access path; Enterprise applies its explicit override. [Authentication](authentication.md) owns identity and initial durable record creation.

<a id="stripe-payment-integration"></a>
## Checkout and Subscription Lifecycle

### Checkout initiation

When Stripe is configured, paid tiers use Stripe Checkout; the free tier remains direct. The backend derives supported currency from `CF-IPCountry`, creates a provider session, and redirects to hosted checkout. After `checkout=success`, the frontend polls auth status every three seconds without a total deadline; after five minutes it exposes a report-problem control and continues polling. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage -->

New paid checkout requires configured Turnstile secret and site key, a token and successful verification before any Stripe or user mutation. Missing configuration or unavailable verification does not bypass the challenge. Active/trialing subscribers remain exempt.

When Stripe is intentionally not configured, selectable non-contact tiers are presented as payment-free direct choices, even with saved positive prices or Stripe price identifiers; stored administration configuration is unchanged and Custom retains its contact CTA. This is a configured mode, not a fail-open response to an unexpected provider outage. Payment-free direct activation retains conditional Turnstile behavior; its exact route contract belongs to [API Reference](api-reference.md#auth-saas-mode).

### Stripe signal-and-sync

Webhooks are authenticated signals. Checkout completion and subscription updates call `syncSubscriptionState()` to fetch current provider state. It resolves the user, obtains a monotonic per-user synchronization-start token from Timekeeper, and permits only the newest-started in-flight synchronization to apply. It preserves unrelated user fields; `lastSyncedAt` is recorded but is not ordering authority. Subscription deletion instead uses the same coordinator to apply billing cleanup and canceled/free/default state directly, without fetching a subscription snapshot. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState -->

Price metadata supplies mode when present; otherwise configured Standard/Pro price slots can recover mode only. Snapshot tier fields are written only when non-null; a missing snapshot tier preserves the prior tier, not inferred price-slot entitlement. On subscribed-mode changes, non-deletion synchronization reconciles the selected permitted mode: promotion preserves an explicit Standard selection and initializes Pro only when no mode is selected. Tier-only or same-mode entitlement changes do not enter that reconciliation branch. Downgrade/termination still reconcile Standard; deletion separately attempts default-mode reconciliation and preference reset after coordinated cleanup.

Successful webhook handling writes an event-ID marker for 72 hours; failed handling remains retryable. KV suppression is eventual and non-atomic: concurrent requests or propagation lag can process the same event again. Durable per-checkout receipts separately suppress checkout metadata and notice replay without that expiry. Checkout metadata applies with the provider snapshot; same-subscription date/trial history is retained, preferring provider creation time and using first processing time only when creation time is absent. Stale different-subscription updates/deletions and timestamp-older checkouts cannot replace newer subscription state. An unavailable initial provider snapshot returns retryable failure without partial checkout activation. A transient stale-token checkout rejection likewise returns retryable failure without a processed event marker; confirmed completed or permanently superseded checkouts remain successful no-ops.

Checkout notices are claimed before best-effort fire-and-forget sending: a crash or provider failure can omit a notice, so neither inbox delivery nor billing-wide exactly-once side effects are promised. KV, coordinator storage and provider operations are not one atomic transaction.

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

Positive historical accounting stages state and marker-cache changes until persistence succeeds, so a failed transaction does not publish speculative in-memory totals. The FIFO marker cache holds at most 128 keys; eviction reloads durable markers without recounting distinct sessions, independently of durable cleanup.

Pending usage is decremented only after a successful KV write. Timekeeper identity mismatch fails closed with 403. Usage accumulates in every mode; SaaS additionally owns quota/trial decisions. Timekeeper is an accounting and quota signal, not an atomic session-admission reservation. D1 history may lag this live path and never overrides quota truth.

<a id="paygate-enforcement"></a>
## Enforcement

### Session-start quota gate

`POST /api/container/start` resolves effective tier, reads monthly usage, and returns HTTP 402 `QUOTA_EXCEEDED` when a finite quota is exhausted. It skips commercial quota enforcement outside SaaS, in Enterprise, and in explicit stress mode. A failed usage KV read does not reject the start on quota uncertainty; the consequence is temporary overuse/cost exposure, not cross-user access. This is distinct from session-authority failure, which fails Start closed. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits -->

### Mid-session quota response

Timekeeper checks quota on pings. A confirmed exceeded quota asks the Container DO to stop with `SIGTERM`, allowing the lifecycle-owned final persistence drain. If Timekeeper cannot read the quota projection, the active-session check fails open rather than evicting on uncertain state; subsequent pings retry. Container teardown mechanics belong to [Container](container.md).

### Concurrent-session and mode gates

Concurrent-session admission counts other D1 sessions in `starting`, `running`, `unreachable`, or `stopping`. SaaS uses effective-tier limits; non-SaaS retains role-based limits. The count and later generation claim are not atomic, so simultaneous starts can exceed the nominal limit. This remains best-effort resource protection, not a security boundary or hard billing reservation. D1 query failure fails Start closed; deployment `max_instances` is a separate platform ceiling.

SaaS `GET /api/user` projects billing-effective `allowedModes`, which Settings uses for non-admin Pro availability. Missing or failed availability does not enable Pro from saved preferences or `subscribedMode`; reopening Settings refreshes the projection. Backend preference-save and Start checks retain canonical tier/configuration enforcement, with existing admin and Enterprise behavior. Settings cannot manufacture paid entitlement.

### User consequence and observability

The frontend renders `QUOTA_EXCEEDED`, disables starts at the observed session limit, and displays SaaS usage from the separate ancillary status projection. Warnings appear at 80%, 95%, and 100% of monthly quota; only lower warnings are dismissible for the UTC month. User-facing displays are projections; server enforcement remains authoritative.

## Administrative Operations

<a id="admin-subscription-management"></a>
Administrators manage six editable tiers; blocked and pending remain protected system states. The editor covers compute, sessions, storage, Standard/Pro provider price IDs, advanced-mode availability, trial quota, and description. Provider-returned display prices are read-only. `PUT /api/admin/tiers` validates the complete tier array and writes `tiers:config`; cache propagation is bounded by the sixty-second TTL. <!-- @impl: web-ui/src/components/admin/SubscriptionManagement.tsx::SubscriptionManagement -->

Changing a user to `advanced`, `max`, or `unlimited` may initialize the next-session preference to advanced, but effective authorization follows the complete policy above. [Authentication](authentication.md#approval-and-activation) owns user transitions. [Configuration](configuration.md#routine-administration) owns the routine Administration shell and Environment review/apply experience, not entitlement.

<a id="email-notifications"></a>
## Commercial Notifications

Subscription and administrator notifications are best-effort Resend messages scheduled without blocking the commercial state transition. Subscriber messages identify old/new plan and mode, quota/session effects, provider/trial status, and activation time. Subscription-notification administrator messages use the subscriber as reply-to. Administrator-initiated tier-change mail instead uses `changedBy` as reply-to when it contains an email address; the users route supplies the acting administrator, not the subscriber. Provider-secret placement belongs to [Configuration](configuration.md).

Welcome delivery is not a billing event. It is claimed through the strongly serialized provisioning path and uses deterministic provider idempotency; [Authentication](authentication.md#welcome-delivery-handoff) owns that handoff.

<a id="runtime-ownership"></a>
## Historical Accounting and Analytics

Historical `user_key` is lowercase hex SHA-256 of `codeflare-usage-user-v1\0` plus trimmed lowercase email. It exposes neither email nor bucket identity. D1 organization queries use `u.user_key ASC` as deterministic tie-breaker after the selected sort; versioned API cursors bind the complete filter and reject malformed or mismatched input ([REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history)). <!-- @impl: src/lib/admin-usage.ts::userKeyForEmail -->

Timekeeper Durable Objects and KV remain live quota owners. D1 owns historical organization usage, deleted-user tombstones, report delivery claims, and retention claims. The same `USAGE_DB` binding also contains session lifecycle tables, but their authority belongs to [Architecture](architecture.md#state-ownership-and-durability) and [Container](container.md), not historical billing. Historical analytics starts empty after rollout and never reconstructs old usage from quota records. ([REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

Overview reads current-day historical usage on navigation and lists applicable Environment areas. Analytics period buttons immediately request the selected period; editing a start date requires Apply filters. Weeks start Monday at 00:00 UTC. Equal day/week/month/year totals can reflect collection beginning within the current day; older quota usage is not backfilled. ([REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting), [REQ-SETUP-019](../../sdd/spec/setup.md#req-setup-019-administration-and-analytics-shell))

Analytics and Reports are demand-driven: navigation, filter changes, explicit refresh, or run reconnect initiate reads, not background polling. Analytics charts bounded actual totals from existing D1 period rows; `historyUpdatedAt` identifies the newest returned row because snapshots can lag live Timekeeper usage. Activity follows the same demand-driven principle under Configuration. ([REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/lib/admin-usage.ts::queryAdminUsageSeries --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage -->

Historical rows retain normalized named user aggregates, including deleted-user history. Account cleanup first requires a D1 tombstone, rather than pretending retained history was removed with the live user record. User detail and CSV exports remain admin-gated; [API Reference](api-reference.md#admin) owns their request/response contracts.

## D1 Database and Migrations

Each deployment uses one D1 database named `${WORKER_NAME}-usage`, bound as `USAGE_DB`. Deployment lists exact names, rejects duplicates, creates the database when absent, writes its ID into temporary `wrangler.toml`, and applies migrations before Worker deployment. Account and database IDs do not belong in source. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary), [REQ-OPS-166](../../sdd/spec/operations.md#req-ops-166-d1-type-validation-and-migration-ordering)) <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 -->

`migrations/usage/0001_initial.sql` additively creates historical users/periods, report deliveries, and maintenance claims. It is not the complete current schema: `migrations/usage/0002_runtime_sessions.sql` also defines D1 session records and cutover admission. Apply the deployment's full migration set before traffic; do not publish against missing schema. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: migrations/usage/0001_initial.sql::usage_users -->

### D1 additive migration review

For [SESSION-031 AC7](../../sdd/spec/session-lifecycle.md#req-session-031-d1-session-schema-stores-complete-ordered-authority), inspect the full session migration: it creates session/cutover objects and never changes analytics tables. Trace deployment through the existing Wrangler tracked-migration command; existing migration records distinguish already-applied work. Compare retained schema/history evidence before and after where available. Do not reapply SQL manually or create a deployment for this review; missing execution records remain unverified.

D1 and KV are separate restore systems. KV restoration recovers its configuration/run/usage projections, not D1 history, report claims, or runtime sessions. Use Cloudflare D1 Time Travel or the account's approved backup procedure for `USAGE_DB` and verify migrations before restoring traffic. An older D1 restore can remove newer history and delivery evidence; never manufacture replacement history from current quota totals. Session-generation/ownership consequences belong to the lifecycle owner. ([AD150](../decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records))

<a id="deployment-credentials"></a>
### Deployment credential boundary

Deployment continues to use established `CLOUDFLARE_API_TOKEN` with D1 Edit and existing Worker deployment permissions. It resolves/migrates the database, deploys, and preserves the Worker secret. Store the token and account ID only in existing repository/target-environment Actions secret scope, never source, D1, Activity, or report history. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: .github/workflows/deploy.yml::deploy -->

Deployment credentials are distinct from session credentials. Non-Enterprise PAT sessions may receive their connected real token/account ID; OAuth uses the Worker-mediated placeholder. Enterprise receives only the Browser Run placeholder and configured non-secret account ID; the real Browser Rendering token remains Worker-side. [Configuration](configuration.md) owns exact placement/precedence and [Security](security.md) owns containment. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @impl: src/container/container-env.ts::buildEnvVars -->

## Retention and Reports

Historical rows use UTC periods. Active day rows retain current day plus 399 preceding days, week rows retain 59 preceding ISO weeks, month rows retain 59 preceding months, and year rows retain four preceding years. Deleted users and named aggregate rows remain 60 calendar months; report deliveries remain 60 calendar months; maintenance claims remain 35 UTC days. ([REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting), [REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-028](../../sdd/spec/subscription.md#req-sub-028-historical-usage-and-report-retention)) <!-- @impl: src/lib/usage-report-scheduler.ts::retentionCutoffs -->

One 15-minute scheduler owns report dispatch, recovery, and a once-daily token-guarded retention transaction. Test-send uses request `waitUntil()` only as a fast path; pending, failed and lease-expired scheduled/test deliveries remain scheduler-recoverable. Reports default disabled. KV stores schedule next-due instants under `admin:usage-reports:next:<settingsRevision>` so a stale revision cannot consume the current schedule. Each enabled recipient gets a separately claimed delivery with at most three attempts. `accepted` means Resend accepted the request, not inbox delivery; no provider ID is invented. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods)) <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler -->

Reports are informational views of persisted usage, not immutable invoices or accounting records. Delivery recovery regenerates the selected month's summary and CSV from current D1 usage; later recovery can therefore include newly persisted usage. It never rewrites the authoritative usage ledger or payment accounting. Dispatch identities and recipient Resend idempotency keys stay fixed across attempts. If Resend rejects a changed payload under the same key, the attempt remains a provider failure, not an accepted delivery.

CSV attachments stop at 8 MiB. Scheduled messages report latest closed UTC month with deterministic idempotency; tests report current UTC month using request identity so two test clicks remain distinct. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods)) <!-- @impl: src/lib/usage-reports.ts::buildReportArtifacts --> <!-- @impl: src/routes/admin/usage-reports.ts::default -->

## Operation Envelope and Logging

At 2,000 active developers with three sessions each, a steady-state non-SaaS positive Timekeeper ping with cached period markers performs one sub-4-KB accounting-state write and no KV reads. First marker observation can read durable marker state and write up to four marker keys plus rollover outbox entries. SaaS additionally reads quota KV, tier config, and user records. Historical D1 writes run once per user on a hash-phased 15-minute duty, not once per session. Stable visible session polls use 60 seconds, transitions five seconds, and hidden pages stop. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

D1 history metrics record rows read/written, SQL duration, backlog age and snapshot count without emails or secrets. Sampling placement and non-default rollout verification belong to the [private deployment-testing owner](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/verification/deployment-testing.md). History acceptance requires operation/spend alerts and discoverability of caught structured errors and uncaught exceptions under the intended sampling; reference prose is not completion evidence. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: scripts/ci/set-head-sampling.mjs::setHeadSampling -->

Verify current included-operation and overage prices through the deployment owner before approving new spend; workload envelopes are not price guarantees. The continuous stress model's under-48-million billed-row-write envelope includes indexes and retention; the existing CI guard is not a new acceptance claim. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

<a id="design-source-review"></a>
<a id="integration-acceptance-checklist"></a>
### Release qualification

Use the current [Integration checklist](deployment.md#integration-acceptance-checklist) and the account acceptance methods below. Bind observations to the release and tested environment; neither this procedure nor an earlier release's results establish current acceptance.

## Account acceptance methods

These [Subscription](../../sdd/spec/subscription.md) methods inspect existing authorized candidate records, not create accounts, charge customers or change configuration. Record revision, mode, redacted case identity and each result. Missing states or provider observations are unavailable, never passing. Future mutations require separate owner permission under the private runbook; never replay uncertain effects or disclose credentials.

### Direct activation and tier acceptance

REQ-SUB-003 AC3's supplemental source owner is the direct `POST /subscribe` handler: only configured-provider **paid** tiers require checkout; successful payment-less activation writes the selected tier after removing stale billing state. <!-- @impl: src/routes/auth.ts::app --> <!-- @impl: src/routes/auth.ts::app --> The existing `allows free tier even when STRIPE_SECRET_KEY is set` assertion checks HTTP 200, not provider-side absence of effects. <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (allows free tier even when STRIPE_SECRET_KEY is set) --> REQ-SUB-011 AC1's endpoint cases assert successful accepted IDs (`free`, `standard`, `advanced`, `max`, `unlimited`) without a configured provider; `isStripeConfigured` alone asserts only a Boolean gate. <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=free) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=standard) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=advanced (now a subscribable tier)) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=max) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=unlimited) --> These inspected source/assertion bodies supplement, never execute or replace, the existing manual matrix below.

Use the existing Subscribe, Subscription Management and Dashboard surfaces with their corresponding [API responses](api-reference.md). Compare intentionally configured and unconfigured provider environments, not outages masquerading as absent configuration.

| Contract | Action and required outcome |
|---|---|
| REQ-SUB-003 AC1/3 | Compare free activation in both provider configurations. Auth status becomes active without checkout or provider interaction; require browser and provider-side observations, not browser silence alone. |
| REQ-SUB-011 AC1 | Check every selectable subscription tier in the existing direct-activation matrix without a provider. Protected blocked/pending states remain non-purchasable. Record accepted and rejected selections explicitly; missing rows are unavailable. |
| REQ-SUB-009 AC1/6 | Compare an authorized tier-array PUT with GET after its 60-second cache. Values persist; anonymous/inactive/non-admin requests preserve the array. In management, identity, order, defaults and provider prices remain read-only. |
| REQ-SUB-014 AC1–5 | Compare configured modes with `getDefaultTiers`, `getAllowedSessionModes`, rejected preference requests and existing stale-preference startup records. Free/trial default-only; standard/advanced/max/unlimited permit both modes. Unsupported saved modes clamp to an allowed default. Never corrupt preferences to manufacture a case. |
| REQ-SUB-013 AC4; REQ-SUB-019 AC3 | Compare effective tier, displayed maximum and one complete Dashboard response cycle. Verify the authoritative ancillary response supplies `maxSessions`, agrees with backend admission and requires no separate entitlement-only fetch. |

### Checkout and provider lifecycle acceptance

Use existing authorized checkout, signed-event, portal and invoice records, matched to the same candidate and identity. Do not confirm payment, replay webhooks, switch plans or flood endpoints for this inspection. Missing historical invoices or negative cases stay unavailable.

| Contract | Action and required outcome |
|---|---|
| REQ-SUB-004 AC4 | Follow an existing `checkout=success` trace through pending activation and five minutes. Auth polls every three seconds; report-problem appears without ending polling. Activation ends the flow. Read `SubscribePage.tsx` to verify no total polling deadline. |
| REQ-SUB-004 AC5/7 | Compare signed events, latest-provider synchronization, cleanup and retry evidence under the [full lifecycle conditions](#checkout-provider-lifecycle-conditions). |
| REQ-SUB-016 AC2/6 | Match hosted plan confirmation to selected price/subscription item. Portal creation is authenticated, customer-bound and limited to five per minute. Existing unauthorized/no-customer/over-limit cases return no portal URL. |
| REQ-SUB-021 AC2/3/5 | Compare new/trial-end subscriptions and invoices: initial charge prorates to the next UTC month; later monthly anchors fall on its first day. A pre-change subscription retains its recorded anniversary. Checkout parameters alone cannot prove recurring billing. |

<a id="checkout-provider-lifecycle-conditions"></a>
**REQ-SUB-004 AC5/7 lifecycle conditions:** Match completed/updated signed events to latest-provider-state synchronization and deletions to coordinated canceled/free/default cleanup. Compare event-marker visibility separately from durable per-checkout receipts: replay after marker expiry preserves same-subscription date/trial history and does not claim notices again. Check stale different-subscription updates/deletions leave replacement state unchanged, and an unavailable initial snapshot or transient stale-token rejection leaves checkout retryable without partial activation or a processed event marker. Notices remain best-effort after claim, not guaranteed inbox delivery or billing-wide exactly-once effects.

### Integration analytics and report presentation acceptance

On an authorized Integration candidate, use existing admin/non-admin identities and dated histories. Do not delete/reactivate users, test-send/resend reports or change schedules.

| Contract | Action and required outcome |
|---|---|
| REQ-SUB-026 AC1 | Inspect Analytics and user detail across closed UTC periods, filters, sorting and cursor pages. Compare rendered rows/totals/download with matching JSON/CSV; CSV omits only pagination. Verify result-owned freshness, `dataSince` and access denials across available modes. Backend tests alone do not establish rendering. |
| REQ-SUB-027 AC6 | Compare Reports history with authenticated pending/sending/accepted/failed responses after explicit Refresh/navigation. Labels preserve provider-acceptance semantics; accepted never means inbox-delivered and missing provider IDs remain absent. |

### Enterprise binding ownership review

For REQ-ENTERPRISE-001 AC4, search candidate production `src/` for `ENTERPRISE_MODE` and inspect every result. Separate type/configuration plumbing from interpretation. Pass only when `src/lib/subscription.ts::isEnterpriseMode` owns raw interpretation and runtime callers use it; another raw conditional or request-controlled override fails. Record paths, not binding values. This source review neither changes deployment mode nor invokes a rollout.

## Failure Posture and Residual Risk

| Boundary | Posture | Consequence / owner |
|---|---|---|
| Invalid checkout input or signature | Fail closed | No provider or user mutation; API/Security |
| Intentionally optional Stripe | Configured direct flow | Deployment policy must be explicit |
| Stale/out-of-order webhook | Newest-start token rejects older sync | Retry provider fetch; Billing |
| Tier-config data absent or read/parse fails | Source defaults | Temporary configuration mismatch/cache window; invalid stored shape can instead throw during merge |
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
