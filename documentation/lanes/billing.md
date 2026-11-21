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

| ID | Default display | Hours/month | Sessions | Modes | Storage | Default `canLogin` |
|---|---|---:|---:|---|---:|---|
| `blocked` | Blocked | 0 | 0 | — | 0 | no |
| `pending` | Pending | 0 | 0 | — | 0 | yes |
| `free` | Free | 4h | 1 | Standard | 250 MB | yes |
| `trial` | Trial | 5h | 2 | Standard | 500 MB | yes |
| `standard` | Starter | 40h | 1 | Standard, Pro | 500 MB | yes |
| `advanced` | Advanced | 80h | 2 | Standard, Pro | 1 GB | yes |
| `max` | Max | 160h | 3 | Standard, Pro | 2 GB | yes |
| `unlimited` | Custom | unlimited | 5 | Standard, Pro | unlimited | yes |

`tiers:config` in KV stores deployment overrides. `getTierConfig()` caches the result for sixty seconds. Absent data and caught KV read/JSON-parse failures use source-defined defaults; stored admin values take priority while missing fields merge from defaults. Stored shape is not validated here: valid JSON with an invalid shape can throw during the merge outside the read catch. Display prices prefer provider values and fall back to saved numeric prices when unavailable. Admin configuration owns Standard and Pro Stripe price slots. The shipped `isDefault` flag selects a fallback tier configuration, not identity admission. In SaaS, blocked and pending identities can authenticate to the status flow but cannot use active application APIs; blocked users cannot activate a plan. <!-- @impl: src/lib/subscription.ts::getTierConfig -->

### Effective entitlement

The effective tier is not a frontend label. Source resolves current `subscriptionTier`, compatible legacy `accessTier`, billing status, configured tier existence/default and deployment mode. Its configured allowed modes constrain the requested/stored session mode; `subscribedMode` remains subscription metadata, not an independent Pro entitlement. Billing downgrade rules can reduce entitlement despite stale higher-tier metadata. Provider truth is authoritative for paid subscription state; KV is its serving projection.

Legacy records without `subscriptionTier` retain their documented fallback. Non-SaaS deployments use their non-commercial access path; Enterprise applies its explicit override. [Authentication](authentication.md) owns identity and initial durable record creation.

<a id="stripe-payment-integration"></a>
## Checkout and Subscription Lifecycle

### Checkout initiation

When Stripe is configured, paid tiers use Stripe Checkout; the free tier remains direct. The backend derives supported currency from `CF-IPCountry`, creates a provider session, and redirects to hosted checkout. After `checkout=success`, the page waits three seconds between unsuccessful auth-status checks, with no total deadline while mounted. After five minutes it exposes a report-problem control without ending polling. The redirect checks `hasSubscribed`, which is also true for an existing Free entitlement. The redirect is not confirmation of a particular paid plan or a new payment. <!-- @impl: web-ui/src/components/SubscribePage.tsx::SubscribePage -->

New paid checkout requires configured Turnstile secret and site key, a token and successful verification before any Stripe or user mutation. Missing configuration or unavailable verification does not bypass the challenge. Active/trialing subscribers remain exempt.

When Stripe is intentionally not configured, selectable non-contact tiers are presented as payment-free direct choices, even with saved positive prices or Stripe price identifiers; stored administration configuration is unchanged and Custom retains its contact CTA. This is a configured mode, not a fail-open response to an unexpected provider outage. Payment-free direct activation retains conditional Turnstile behavior; its exact route contract belongs to [API Reference](api-reference.md#auth-saas-mode).

Custom remains contact-only under [AD41](../decisions/README.md#ad41-custom-tier-uses-contact-flow-not-self-service-checkout). The checkout and plan-switch routes reject Custom even if a saved price exists. This does not delete or rewrite the saved tier configuration, alter contact delivery, or affect current subscribers’ ordinary account management.

### Stripe signal-and-sync

Webhooks are authenticated signals. Checkout completion and subscription updates call `syncSubscriptionState()` to fetch current provider state. It resolves the user, obtains a monotonic per-user synchronization-start token from Timekeeper, and permits only the newest-started in-flight synchronization to apply. It preserves unrelated user fields; `lastSyncedAt` is recorded but is not ordering authority. Subscription deletion instead uses the same coordinator to apply billing cleanup and canceled/free/default state directly, without fetching a subscription snapshot. An accepted deletion of the same stored trialing subscription records `trialUsed` in that write, so a later checkout does not offer another trial. Rejected deletions do not change trial history, and accepted deletions without a subscription identity match do not create a trial marker. Ordinary snapshot sync differs: an accepted non-trialing snapshot sets `trialUsed` without requiring the prior record to say `trialing`. <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/timekeeper/index.ts::handleBillingSyncApply -->

Price metadata supplies mode when present; otherwise configured Standard/Pro price slots can recover mode only. Snapshot tier fields are written only when non-null; a missing snapshot tier preserves the prior tier, not inferred price-slot entitlement. On subscribed-mode changes, non-deletion synchronization reconciles the selected permitted mode: promotion preserves an explicit Standard selection and initializes Pro only when no mode is selected. Tier-only or same-mode entitlement changes do not enter that reconciliation branch. Downgrade/termination still reconcile Standard; deletion separately attempts default-mode reconciliation and preference reset after coordinated cleanup.

Successful webhook handling writes an event-ID marker for 72 hours; failed handling remains retryable. KV suppression is eventual and non-atomic: concurrent requests or propagation lag can process the same event again. Durable per-checkout receipts separately suppress checkout metadata and notice replay without that expiry. Checkout metadata applies with the provider snapshot; same-subscription date/trial history is retained, preferring provider creation time and using the timestamp from the first successful checkout apply only when creation time is absent. Stale different-subscription updates/deletions and timestamp-older checkouts cannot replace newer subscription state. An unavailable initial provider snapshot returns retryable failure without partial checkout activation. A transient stale-token checkout rejection likewise returns retryable failure without a processed event marker; confirmed completed or permanently superseded checkouts remain successful no-ops.

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

Pending usage is decremented only after a successful KV write. A flush credits the batch to the live KV periods current at flush time. Live usage reads add pending usage to matching daily and monthly KV totals; a failed KV read reports pending usage alone. A failed flush requests a retry after 30 seconds, but the shared alarm may wake sooner. Timekeeper identity mismatch fails closed with 403. Healthy session metrics report in every deployment mode; recovery and stopping ticks do not. Timekeeper makes quota and trial decisions for SaaS. It is an accounting and quota signal, not an atomic session-admission reservation. D1 history is separate and never overrides quota truth. <!-- @impl: src/timekeeper/index.ts::alarm --> <!-- @impl: src/timekeeper/index.ts::handleGetUsage -->

<a id="paygate-enforcement"></a>
## Enforcement

### Session-start quota gate

`POST /api/container/start` resolves effective tier and compares flushed current-month KV usage to its finite quota, returning HTTP 402 `QUOTA_EXCEEDED` at or above the cap. Pending Timekeeper usage and historical D1 totals are not part of the Start check. It skips commercial quota enforcement outside SaaS, in Enterprise, and in explicit stress mode. A failed usage KV read does not reject the start on quota uncertainty; the consequence is temporary overuse/cost exposure, not cross-user access. This is distinct from session-authority failure, which fails Start closed. <!-- @impl: src/routes/container/lifecycle-validation.ts::validateSessionAndCheckLimits -->

For [REQ-SUB-007](../../sdd/spec/subscription.md#req-sub-007-quota-enforcement-at-session-start-402), compare retained, authorized Start records with the effective tier and flushed UTC-month quota data available at admission. Distinguish a compute-limit `402 QUOTA_EXCEEDED` from the concurrent-session limit: a finite tier at or above the compute cap must be refused for quota before provisioning; below-cap and unlimited cases must not be refused on that basis. For an existing usage-only read failure, require successful session-authority validation and no quota refusal. Missing records remain unverified; this inspection authorizes no new starts, quota writes, fault injection, or billing changes.

Timekeeper `/ping` fixtures are not Start evidence. The Start-side Enterprise fixture covers the quota bypass, and the D1 failure fixture covers unavailable session authority. Neither establishes ordinary finite SaaS admission at the threshold or when only the usage read fails. <!-- @test: src/__tests__/routes/container-lifecycle-helpers.test.ts (REQ-ENTERPRISE-001 AC3: enterprise users are never blocked by the monthly compute quota) --> <!-- @test: src/__tests__/lib/session-authority-outcomes.test.ts (AC5: unavailable D1 rejects admission without changing durable authority) -->

### Mid-session quota response

Timekeeper checks quota on pings. A confirmed exceeded quota asks the Container DO to stop with `SIGTERM`, allowing the lifecycle-owned final persistence drain. If Timekeeper cannot read the quota projection, the active-session check fails open rather than evicting on uncertain state; subsequent pings retry. Container teardown mechanics belong to [Container](container.md).

### Concurrent-session and mode gates

Concurrent-session admission counts other D1 sessions in `starting`, `running`, `unreachable`, or `stopping`. SaaS uses effective-tier limits; non-SaaS retains role-based limits. The count and later generation claim are not atomic, so simultaneous starts can exceed the nominal limit. This remains best-effort resource protection, not a security boundary or hard billing reservation. D1 query failure fails Start closed; deployment `max_instances` is a separate platform ceiling.

SaaS `GET /api/user` projects billing-effective `allowedModes`, which Settings uses for non-admin Pro availability. Missing or failed availability does not enable Pro from saved preferences or `subscribedMode`; reopening Settings refreshes the projection. Backend preference-save and Start checks retain canonical tier/configuration enforcement, with existing admin and Enterprise behavior. Settings cannot manufacture paid entitlement.

### User consequence and observability

The frontend renders `QUOTA_EXCEEDED`, disables starts at the observed session limit, and displays SaaS usage from the separate ancillary status projection. [Monthly warnings](../../sdd/spec/subscription.md#req-sub-018-monthly-quota-warning-banners) appear at 80%, 95%, and 100% of quota. Only lower warnings are dismissible for the UTC month; the 100% banner explains why the server blocks starts. User-facing displays are projections; server enforcement remains authoritative.

## Administrative Operations

<a id="admin-subscription-management"></a>
Administrators manage six editable tiers; blocked and pending remain protected system states. The editor covers compute, sessions, storage, Standard/Pro provider price IDs, advanced-mode availability, trial quota, and description. Provider-returned display prices are read-only. `PUT /api/admin/tiers` validates the complete tier array and writes `tiers:config`. The 60-second TTL bounds when a subsequent lookup in that isolate will attempt a fresh KV read; it does not guarantee global propagation or that the first refresh sees the write. <!-- @impl: web-ui/src/components/admin/SubscriptionManagement.tsx::SubscriptionManagement -->

Changing a user to `advanced`, `max`, or `unlimited` may initialize the next-session preference to advanced, but effective authorization follows the complete policy above. [Authentication](authentication.md#approval-and-activation) owns user transitions. [Configuration](configuration.md#routine-administration) owns the routine Administration shell and Environment review/apply experience, not entitlement.

<a id="email-notifications"></a>
## Commercial Notifications

Subscription and administrator notifications are best-effort Resend messages scheduled without blocking the commercial state transition. Subscriber messages identify old/new plan and mode, quota/session effects, provider/trial status, and activation time. Subscription-notification administrator messages use the subscriber as reply-to. Administrator-initiated tier-change mail instead uses `changedBy` as reply-to when it contains an email address; the users route supplies the acting administrator, not the subscriber. Provider-secret placement belongs to [Configuration](configuration.md).

Welcome delivery is not a billing event. It is claimed through the strongly serialized provisioning path and uses deterministic provider idempotency; [Authentication](authentication.md#welcome-delivery-handoff) owns that handoff.

<a id="runtime-ownership"></a>
## Historical Accounting and Analytics

Historical `user_key` is lowercase hex SHA-256 of `codeflare-usage-user-v1\0` plus trimmed lowercase email. It exposes neither email nor bucket identity. D1 organization queries use `u.user_key ASC` as deterministic tie-breaker after the selected sort; versioned cursors for paginated JSON bind the complete filter and reject malformed or mismatched input. CSV exports are unpaginated and ignore a supplied cursor ([REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history)). <!-- @impl: src/lib/admin-usage.ts::userKeyForEmail -->

Timekeeper Durable Objects and KV remain live quota owners. D1 owns historical organization usage, deleted-user tombstones, report delivery claims, and retention claims. The same `USAGE_DB` binding also contains session lifecycle tables, but their authority belongs to [Architecture](architecture.md#state-ownership-and-durability) and [Container](container.md), not historical billing. Historical analytics starts empty after rollout and never reconstructs old usage from quota records. [REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting) owns per-ping accounting; [REQ-SUB-036](../../sdd/spec/subscription.md#req-sub-036-historical-usage-projection-to-d1) owns its independent D1 projection. <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

Overview reads current-day historical usage on navigation and lists applicable Environment areas. Analytics period buttons immediately request the selected period; editing a start date requires Apply filters. Weeks start Monday at 00:00 UTC. Equal day/week/month/year totals can reflect collection beginning within the current day; older quota usage is not backfilled. ([REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-SUB-036](../../sdd/spec/subscription.md#req-sub-036-historical-usage-projection-to-d1), [REQ-SETUP-019](../../sdd/spec/setup.md#req-setup-019-administration-and-analytics-shell))

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

Historical rows use UTC periods. Active day rows retain current day plus 399 preceding days, week rows retain 59 preceding ISO weeks, month rows retain 59 preceding months, and year rows retain four preceding years. Deleted users and named aggregate rows remain 60 calendar months; report deliveries remain 60 calendar months; maintenance claims remain 35 UTC days. ([REQ-SUB-036](../../sdd/spec/subscription.md#req-sub-036-historical-usage-projection-to-d1), [REQ-SUB-037](../../sdd/spec/subscription.md#req-sub-037-historical-usage-owner-lifecycle), [REQ-SUB-028](../../sdd/spec/subscription.md#req-sub-028-historical-usage-and-report-retention)) <!-- @impl: src/lib/usage-report-scheduler.ts::retentionCutoffs -->

One 15-minute scheduler owns report dispatch, recovery, and a once-daily token-guarded retention transaction. Test-send uses request `waitUntil()` only as a fast path; pending, failed and lease-expired scheduled/test deliveries remain scheduler-recoverable. Reports default disabled. KV stores schedule next-due instants under `admin:usage-reports:next:<settingsRevision>` so a stale revision cannot consume the current schedule. Each enabled recipient gets a separately claimed delivery with at most three attempts. `accepted` means Resend accepted the request, not inbox delivery; no provider ID is invented. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods)) <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler -->

Reports are informational views of persisted usage, not immutable invoices or accounting records. Delivery recovery regenerates the selected month's summary and CSV from current D1 usage; later recovery can therefore include newly persisted usage. It never rewrites the authoritative usage ledger or payment accounting. Dispatch identities and recipient Resend idempotency keys stay fixed across attempts. If Resend rejects a changed payload under the same key, the attempt remains a provider failure, not an accepted delivery.

CSV attachments stop at 8 MiB. Scheduled messages report latest closed UTC month with deterministic idempotency; tests report current UTC month using request identity so two test clicks remain distinct. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods)) <!-- @impl: src/lib/usage-reports.ts::buildReportArtifacts --> <!-- @impl: src/routes/admin/usage-reports.ts::default -->

## Operation Envelope and Logging

At 2,000 active developers with three sessions each, a steady-state non-SaaS positive Timekeeper ping with cached period markers performs one sub-4-KB accounting-state write and no KV reads. First marker observation can read durable marker state and write up to four marker keys plus rollover outbox entries. SaaS additionally reads quota KV, tier config, and user records. Historical D1 writes run once per user on a hash-phased 15-minute duty, not once per session. Stable visible session polls use 60 seconds, transitions five seconds, and hidden pages stop. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

D1 history metrics record rows read/written, SQL duration, backlog age and snapshot count without emails or secrets. Sampling placement and non-default rollout verification belong to the [private deployment-testing owner](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/verification/deployment-testing.md). History acceptance requires operation/spend alerts and discoverability of caught structured errors and uncaught exceptions under the intended sampling; reference prose is not completion evidence. ([REQ-OPS-168](../../sdd/spec/operations.md#req-ops-168-deployment-observability-and-d1-metrics), [REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope) AC5) <!-- @impl: scripts/ci/set-head-sampling.mjs::setHeadSampling -->

Verify current included-operation and overage prices through the deployment owner before approving new spend; workload envelopes are not price guarantees. The continuous stress model's under-48-million billed-row-write envelope includes indexes and retention; the existing CI guard is not a new acceptance claim. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

<a id="design-source-review"></a>
<a id="integration-acceptance-checklist"></a>
### Release qualification

Use the current [Integration checklist](deployment.md#integration-acceptance-checklist) and the account acceptance methods below. Bind observations to the release and tested environment; neither this procedure nor an earlier release's results establish current acceptance.

## Account acceptance methods

These [Subscription](../../sdd/spec/subscription.md) methods inspect existing authorized candidate records, not create accounts, charge customers or change configuration. Record revision, mode, redacted case identity and each result. Missing states or provider observations are unavailable, never passing. Future mutations require separate owner permission under the private runbook; never replay uncertain effects or disclose credentials.

### Direct activation and tier acceptance

REQ-SUB-003 AC3's supplemental source owner is the direct `POST /subscribe` handler: only configured-provider **paid** tiers require checkout; successful payment-less activation writes the selected tier after removing stale billing state. A same-tier, same-mode idempotent acknowledgment performs no write and leaves existing billing fields unchanged. <!-- @impl: src/routes/auth.ts::app --> <!-- @impl: src/routes/auth.ts::app --> The existing `allows free tier even when STRIPE_SECRET_KEY is set` assertion checks HTTP 200, not provider-side absence of effects. <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (allows free tier even when STRIPE_SECRET_KEY is set) --> REQ-SUB-011 AC1's endpoint cases assert successful accepted IDs (`free`, `standard`, `advanced`, `max`, `unlimited`) without a configured provider; `isStripeConfigured` alone asserts only a Boolean gate. <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=free) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=standard) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=advanced (now a subscribable tier)) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=max) --> <!-- @test: src/__tests__/routes/auth-subscribe.test.ts (accepts tier=unlimited) --> These inspected source/assertion bodies supplement, never execute or replace, the existing manual matrix below.

Under [AD39](../decisions/README.md#ad39-max-users-capacity-cap-counts-paid-slots-only), Free accounts do not occupy paid slots, but a full positive cap blocks new Free signups. The Free CTA reflects the capacity signal before activation. The existing HTTP 200 fixtures cover admitted requests, not full capacity. <!-- @impl: src/routes/auth.ts::countPaidSlots --> <!-- @impl: web-ui/src/components/SubscribePage.tsx::setCapacityReached -->

Use the existing Subscribe, Subscription Management and Dashboard surfaces with their corresponding [API responses](api-reference.md). Compare intentionally configured and unconfigured provider environments, not outages masquerading as absent configuration.

| Contract | Action and required outcome |
|---|---|
| REQ-SUB-003 AC1/3 | Compare admitted Free activation in both provider configurations. Auth status becomes active without checkout or provider interaction; require browser and provider-side observations. In retained full-cap cases, a new Free request is refused and no provider checkout occurs. |
| REQ-SUB-011 AC1 | Check every selectable subscription tier in the existing direct-activation matrix without a provider. Protected blocked/pending states remain non-purchasable. Record accepted and rejected selections explicitly; missing rows are unavailable. |
| REQ-SUB-009 AC1/6 | Compare an authorized tier-array PUT with GET after its 60-second cache. Values persist; anonymous/inactive/non-admin requests preserve the array. In management, identity, order, defaults and provider prices remain read-only. |
| REQ-SUB-014 AC1–5 | Compare configured modes with `getDefaultTiers`, `getAllowedSessionModes`, rejected preference requests and existing stale-preference startup records. Free/trial default-only; standard/advanced/max/unlimited permit both modes. Unsupported saved modes clamp to an allowed default. Never corrupt preferences to manufacture a case. |
| REQ-SUB-013 AC4; REQ-SUB-019 AC3 | Compare effective tier, displayed maximum and one complete Dashboard response cycle. Verify the authoritative ancillary response supplies `maxSessions`, agrees with backend admission and requires no separate entitlement-only fetch. |

### Checkout and provider lifecycle acceptance

Use existing authorized checkout, signed-event, portal and invoice records, matched to the same candidate and identity. Do not confirm payment, replay webhooks, switch plans or flood endpoints for this inspection. Missing historical invoices or negative cases stay unavailable.

| Contract | Action and required outcome |
|---|---|
| REQ-SUB-004 AC4 | Follow an existing `checkout=success` trace through pending activation and five minutes; compare successive unsuccessful auth-status checks for the three-second wait. The report-problem control must appear without ending polls. Verify the final redirect from `hasSubscribed`, then compare effective tier or the matching provider event separately before claiming paid activation. The component fixtures cover mocked pending-to-active redirects, not a Free-to-paid transition. |
| [REQ-SUB-035](../../sdd/spec/subscription.md#req-sub-035-signed-billing-webhook-lifecycle) AC1/3; [REQ-SUB-032](../../sdd/spec/subscription.md#req-sub-032-checkout-completion-and-replay) | Compare signed events, latest-provider synchronization, cleanup and retry evidence under the [full lifecycle conditions](#checkout-provider-lifecycle-conditions). |
| REQ-SUB-016 AC2/6 | Match hosted plan confirmation to selected price/subscription item. Portal creation is authenticated, customer-bound and limited to five per minute. Existing unauthorized/no-customer/over-limit cases return no portal URL. |
| REQ-SUB-021 AC2/3/5 | Compare new/trial-end subscriptions and invoices: initial charge prorates to the next UTC month; later monthly anchors fall on its first day. A pre-change subscription retains its recorded anniversary. Checkout parameters alone cannot prove recurring billing. |

<a id="checkout-provider-lifecycle-conditions"></a>
**Checkout provider lifecycle conditions (REQ-SUB-035 AC1/3 and REQ-SUB-032):** Match completed/updated signed events to latest-provider-state synchronization and deletions to coordinated canceled/free/default cleanup. Compare event-marker visibility separately from durable per-checkout receipts: replay after marker expiry preserves same-subscription date/trial history and does not claim notices again. Check stale different-subscription updates/deletions leave replacement state unchanged, and an unavailable initial snapshot or transient stale-token rejection leaves checkout retryable without partial activation or a processed event marker. Notices remain best-effort after claim, not guaranteed inbox delivery or billing-wide exactly-once effects.

### Integration analytics and report presentation acceptance

On an authorized Integration candidate, use existing admin/non-admin identities and dated histories. Do not delete/reactivate users, test-send/resend reports or change schedules.

| Contract | Action and required outcome |
|---|---|
| REQ-SUB-026 AC1 | Inspect Analytics and user detail across closed UTC periods, filters, sorting and cursor pages. Compare rendered rows/totals/download with matching JSON/CSV; CSV omits only pagination. Verify result-owned freshness, `dataSince` and access denials across available modes. Backend tests alone do not establish rendering. |
| REQ-SUB-027 AC6 | Compare Reports history with authenticated pending/sending/accepted/failed responses after explicit Refresh/navigation. Labels preserve provider-acceptance semantics; accepted never means inbox-delivered and missing provider IDs remain absent. |
| REQ-SUB-030 AC6 | Read the period explanation next to **Send test report**. It must state that the report uses the current UTC month. Do not send a report for this copy check. |

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
| Stripe checkout/sync | [REQ-SUB-004](../../sdd/spec/subscription.md#req-sub-004-paid-tiers-integrate-with-stripe-checkout), [REQ-SUB-035](../../sdd/spec/subscription.md#req-sub-035-signed-billing-webhook-lifecycle), [REQ-SUB-015](../../sdd/spec/subscription.md#req-sub-015-stripe-webhook-signal-and-sync-pattern), [REQ-SUB-032](../../sdd/spec/subscription.md#req-sub-032-checkout-completion-and-replay) | `src/lib/stripe.ts`, `src/routes/stripe-webhook.ts`; checkout/webhook suites |
| Subscription-driven agent configuration | [REQ-SUB-034](../../sdd/spec/subscription.md#req-sub-034-subscription-driven-agent-configuration) | `src/routes/stripe-webhook.ts`; mode transitions and actual termination, not scheduled cancellation |
| Accounting/quota | [REQ-SUB-006](../../sdd/spec/subscription.md#req-sub-006-real-time-usage-tracking-via-timekeeper-do), [REQ-SUB-007](../../sdd/spec/subscription.md#req-sub-007-quota-enforcement-at-session-start-402), [REQ-SUB-008](../../sdd/spec/subscription.md#req-sub-008-mid-session-quota-enforcement-graceful-stop) | `src/timekeeper/index.ts`, lifecycle validation; Timekeeper/lifecycle suites |
| Concurrent sessions | [REQ-SUB-013](../../sdd/spec/subscription.md#req-sub-013-concurrent-session-limits), [AD6](../decisions/README.md#ad6-kv-read-modify-write-races-and-collectmetrics-atomicity) | D1 lifecycle/counting; simultaneous-start evidence remains best effort |
| Personal usage display | [REQ-SUB-033](../../sdd/spec/subscription.md#req-sub-033-usage-dashboard-page), [REQ-SUB-024](../../sdd/spec/subscription.md#req-sub-024-usage-page-product-context) | usage/ancillary routes and frontend; behavioral suites |
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
