# Administration and historical usage

**Audience:** Operators, Developers

**Owns:** routine Environment changes, historical usage storage, reporting, retention, and rollout checks. **Does not own:** live quota enforcement, first-run Setup orchestration, or private environment credentials.

## Contents

- [Runtime ownership](#runtime-ownership)
- [D1 database and migrations](#d1-database-and-migrations)
- [Deployment credentials](#deployment-credentials)
- [Retention and reports](#retention-and-reports)
- [Operation envelope and logging](#operation-envelope-and-logging)
- [Design-source review](#design-source-review)
- [Integration acceptance checklist](#integration-acceptance-checklist)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

Administration is the routine control surface after Setup. Setup still owns first claim and first-run orchestration, presented as the same progressive operator experience across readiness, mode-applicable settings, review, apply, and result stages. Completed deployments keep **Initialization** in Administration navigation; after existing values load it shows Completed status and the effective mode. Failed hydration shows a retryable Unavailable state without rendering recovery defaults. Workspace settings point only to Administration. Sending an operator through full provisioning to change one report recipient would be a bad control plane, so routine changes use bounded Environment sections instead. ([REQ-SETUP-019](../../sdd/spec/setup.md#req-setup-019-administration-and-analytics-shell), [REQ-SETUP-022](../../sdd/spec/setup.md#req-setup-022-initialization-presentation-and-hydration)) <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard -->

## Runtime ownership

Workers KV owns current Environment values, configuration revisions, active-run admission, and sanitized Activity records. Configuration runs stop at the first failed task and never roll back external provider work automatically. Activity expires after 90 days. ([REQ-SETUP-018](../../sdd/spec/setup.md#req-setup-018-bounded-routine-environment-changes)) <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask -->

Timekeeper Durable Objects and KV remain the live quota owners. D1 owns historical organization usage, deleted-user tombstones, report delivery claims, and retention claims. Historical analytics starts empty after rollout and never reconstructs old usage from quota records. The absence of a backfill is deliberate; invented history would be worse than an empty chart. ([REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

Analytics, Reports, and Activity are demand-driven. They read on navigation, filter changes, explicit refresh, or run reconnect. They do not background-poll. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage -->

## D1 database and migrations

Each deployment uses one D1 database named `<worker-name>-usage`, bound to the Worker as `USAGE_DB`. The deploy workflow lists exact names, rejects duplicates, creates the database when absent, writes its ID into the temporary `wrangler.toml`, and applies migrations before Worker deployment. Account IDs and database IDs do not belong in source. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 -->

`migrations/usage/0001_initial.sql` is additive. It creates historical user and period rows, report delivery records, and maintenance claims. Deploying Worker code before this migration is not supported. The workflow fails instead of publishing code against a missing schema. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: migrations/usage/0001_initial.sql::usage_users -->

D1 and KV must be restored as separate systems. A KV restore recovers live settings and run records; it does not recover historical usage or report claims. Use Cloudflare D1 Time Travel or the account's approved D1 backup procedure for `USAGE_DB`, then verify migration state before restoring Worker traffic. Restoring D1 to an older point can legitimately remove newer history and delivery evidence. Do not manufacture replacement rows from current quota totals. ([AD150](../decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records))

## Deployment credentials

Deployment continues to use the established `CLOUDFLARE_API_TOKEN`. It needs D1 Edit together with its existing Worker deployment permissions so the workflow can resolve the database, apply migrations, deploy, and preserve the same Worker secret. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: .github/workflows/deploy.yml::deploy -->

Store the token and `CLOUDFLARE_ACCOUNT_ID` in the existing repository or target-environment Actions secret scope. Neither value enters source, D1, Activity, report history, or a session container. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: .github/workflows/deploy.yml::deploy -->

## Retention and reports

Historical rows use UTC periods. Active day rows retain the current day plus 399 preceding days, week rows retain 59 preceding ISO weeks, month rows retain 59 preceding months, and year rows retain four preceding years. Deleted users and their named aggregate rows remain for 60 calendar months. Report delivery records remain for 60 calendar months. Maintenance claims remain for 35 UTC days. ([REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports)) <!-- @impl: src/lib/usage-report-scheduler.ts::retentionCutoffs -->

One 15-minute scheduler owns report dispatch, recovery, and a once-daily token-guarded retention transaction. Reports are disabled by default. When enabled, each recipient gets a separate claimed delivery with at most three attempts. `accepted` means Resend accepted the request. It does not claim inbox delivery, and no provider ID is invented. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports)) <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler -->

CSV attachments stop at 8 MiB. Scheduled messages use deterministic idempotency; test requests use their request identity so two test clicks remain two tests. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports)) <!-- @impl: src/lib/usage-reports.ts::buildReportArtifacts -->

## Operation envelope and logging

At 2,000 active developers with three sessions each, positive Timekeeper pings perform one sub-4-KB Durable Object state write and no KV reads. Historical D1 writes run once per user on a hash-phased 15-minute duty, not once per session. Stable visible session status polls run every 60 seconds; transitions use five seconds; hidden pages stop polling. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/accounting.ts::applyPositiveDelta -->

Integration and Enterprise Integration retain `head_sampling_rate = 1`. Production and Enterprise use `0.05`. D1 history metrics record rows read, rows written, SQL duration, backlog age, and snapshot count without email addresses or secrets. Before Production history is enabled, operators must add account-level D1 operation and spend alerts and verify caught structured errors plus uncaught exceptions remain discoverable under the intended sampling policy. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: scripts/ci/set-head-sampling.mjs::setHeadSampling -->

Pricing assumptions were checked on 29 August 2026. Refresh Cloudflare D1 included-operation and overage prices before Production approval. The continuous stress model stays under 48 million billed D1 rows written, including indexes and retention; CI guards that envelope. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

## Design-source review

Source ownership was checked against the approved Administration design contract and journey catalog supplied for implementation. Current routes cover Overview, every mode-gated Environment section, preview, execution, Analytics overview and user detail, Reports and delivery history, Activity, deleted users, provider failures, conflicts, interruption, empty history, and mobile composition. Shared administration tokens and responsive rules remain in `web-ui/src/styles/administration.css`; no chart or component framework was added. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @impl: web-ui/src/styles/administration.css::.admin-shell -->

This is a source review, not browser acceptance. Pixel composition, touch behavior, focus order, network cadence, and email rendering still need the Integration checks below.

## Integration acceptance checklist

Record exact commit and Deploy run before testing. Then verify:

- Mode-aware navigation and every applicable Environment section in Default, Onboarding, SaaS, and Enterprise.
- One non-destructive Environment review and apply, including conflict, reconnect, failure, and interrupted states.
- Analytics empty-history and data-start states, user detail, deleted-user history, and CSV export.
- Reports disabled state, schedule presentation, test email, provider failure, and delivery history.
- Activity empty and retained-run states. Confirm records contain no submitted secrets.
- Five-second transition polling, 60-second stable polling, hidden cancellation, immediate visible refresh, and no overlapping requests in browser network tools.
- Desktop and mobile hierarchy against the approved Administration and Analytics design catalog.
- One caught structured error and one uncaught route exception are discoverable in Integration logs.

Browser and visual acceptance belongs to the operator on Integration. CI does not pretend a component snapshot proved any of this.

## Requirement and Source Map

| Contract | Primary source |
|---|---|
| Environment read, preview, and runs | `src/routes/admin/configuration*.ts`, `src/lib/admin-configuration.ts` |
| Historical accounting and analytics | `src/timekeeper/`, `src/lib/admin-usage.ts`, `src/routes/admin/usage.ts` |
| Reports, claims, email, and retention | `src/lib/usage-report-scheduler.ts`, `src/lib/usage-reports.ts`, `src/routes/admin/usage-reports.ts` |
| Administration UI and demand-driven reads | `web-ui/src/components/admin/`, `web-ui/src/api/client.ts` |
| Deployment boundary | `scripts/ci/prepare-usage-d1.mjs`, `.github/workflows/deploy.yml` |

Owning requirements are [REQ-SETUP-017 through REQ-SETUP-022](../../sdd/spec/setup.md), [REQ-SUB-025 through REQ-SUB-027](../../sdd/spec/subscription.md), and [REQ-OPS-056 through REQ-OPS-057](../../sdd/spec/operations.md).

## Related Documentation

- [Configuration](configuration.md)
- [Development and Deployment](deployment.md)
- [API Reference](api-reference.md)
- [Billing and Subscription](billing.md)
- [Architecture decision AD150](../decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records)
