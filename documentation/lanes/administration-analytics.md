# Administration and historical usage

**Audience:** Operators, Developers

**Owns:** routine Environment changes, historical usage storage, reporting, retention, and rollout checks. **Does not own:** live quota enforcement, first-run Setup orchestration, or private environment credentials.

## Contents

- [Runtime ownership](#runtime-ownership)
- [Enterprise capability profiles](#enterprise-capability-profiles)
- [D1 database and migrations](#d1-database-and-migrations)
- [Deployment credentials](#deployment-credentials)
- [Retention and reports](#retention-and-reports)
- [Operation envelope and logging](#operation-envelope-and-logging)
- [Design-source review](#design-source-review)
- [Integration acceptance checklist](#integration-acceptance-checklist)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

Administration is the routine control surface after Setup. Setup still owns first claim and first-run orchestration, presented as the same progressive operator experience across readiness, mode-applicable settings, review, apply, and result stages. Completed deployments keep **Initialization** in Administration navigation; after existing values load it shows Completed status and the effective mode. Failed hydration shows a retryable Unavailable state without rendering recovery defaults. ([REQ-SETUP-019](../../sdd/spec/setup.md#req-setup-019-administration-and-analytics-shell), [REQ-SETUP-022](../../sdd/spec/setup.md#req-setup-022-initialization-presentation-and-hydration)) <!-- @impl: web-ui/src/components/setup/SetupWizard.tsx::SetupWizard -->

Workspace settings point only to Administration. Sending an operator through full provisioning to change one report recipient would be a bad control plane, so routine changes use bounded Environment sections instead. ([REQ-SETUP-019](../../sdd/spec/setup.md#req-setup-019-administration-and-analytics-shell), [REQ-SETUP-026](../../sdd/spec/setup.md#req-setup-026-workspace-administration-entry)) <!-- @impl: web-ui/src/components/SettingsPanel.tsx::SettingsPanel --> <!-- @impl: web-ui/src/components/admin/EnvironmentIndex.tsx::EnvironmentIndex -->

User Management and Subscription Tiers reuse their established components and `/api/users` and `/api/admin/tiers` mutation paths; Administration only composes them into the new shell. ([REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel), [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel)) <!-- @impl: web-ui/src/App.tsx::AdministrationUsers --> <!-- @impl: web-ui/src/App.tsx::AdministrationSubscriptions --> <!-- @impl: web-ui/src/components/admin/UserManagement.tsx::UserManagement --> <!-- @impl: web-ui/src/components/admin/SubscriptionManagement.tsx::SubscriptionManagement -->

## Runtime ownership

Workers KV owns current Environment values, configuration revisions, active-run admission, and sanitized Activity records. Configuration runs stop at the first failed task and never roll back external provider work automatically. Activity expires after 90 days. ([REQ-SETUP-018](../../sdd/spec/setup.md#req-setup-018-bounded-routine-environment-changes)) <!-- @impl: src/lib/admin-configuration.ts::executeConfigurationTask -->

Timekeeper Durable Objects and KV remain the live quota owners. D1 owns historical organization usage, deleted-user tombstones, report delivery claims, and retention claims. Historical analytics starts empty after rollout and never reconstructs old usage from quota records. The absence of a backfill is deliberate; invented history would be worse than an empty chart. ([REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

Analytics, Reports, and Activity are demand-driven. They read on navigation, filter changes, explicit refresh, or run reconnect. They do not background-poll. Analytics charts a bounded history of actual totals from existing D1 period rows; `historyUpdatedAt` identifies the newest returned row because historical D1 snapshots can lag live Timekeeper usage. ([REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-usage-and-deletion-history), [REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/lib/admin-usage.ts::queryAdminUsageSeries --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage -->

## Enterprise capability profiles

Administration discovers Dynamic Routes from the configured AI Gateway. Each activated route has a positive context window and one checked Pi compatibility-profile revision; unrelated unconfigured gateway routes remain visible without blocking Save. The assignable built-ins are exactly `openai-gpt-chat-tools-reasoning`, `openai-gpt-chat-tools-off`, `workers-ai-gemma-thinking`, `workers-ai-kimi-k-thinking`, `workers-ai-glm-thinking`, and `codeflare-inference-mesh-binary-thinking`. GPT-OSS tool replay, Gemini Chat Completions tools, GPT-6 Astra tools, and Responses-required behavior appear only as nonassignable notices. ([REQ-ENTERPRISE-031](../../sdd/spec/enterprise-mode.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-034](../../sdd/spec/enterprise-mode.md#req-enterprise-034-enterprise-pi-route-administration))

Connection, Routes, and Access & fallback are separate sections. Routes start as a compact status overview; expanding one shows its detected models, Pi compatibility profile, context window, Map Profile, and Verify Profile. Inventory reads neither change assignments nor start paid checks. Advanced details hold revision references and required administrator-owned custom-backend descriptions. Description changes require another Verify, not Save first. Built-in labels identify tested providers: Workers AI · Kimi/GLM/Gemma, OpenAI · GPT, and Codeflare Inference Mesh · Qwen/Ornith. Labels do not identify the current backend or change immutable references. ([REQ-ENTERPRISE-033](../../sdd/spec/enterprise-mode.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence), [REQ-ENTERPRISE-034](../../sdd/spec/enterprise-mode.md#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-038](../../sdd/spec/enterprise-mode.md#req-enterprise-038-enterprise-pi-selected-profile-verification))

Choose an existing Pi compatibility profile, Verify it, and assign group access before Save. Alternatively, Map Profile runs the bounded Pi 0.84.4 check and may incur provider usage. Every passing enabled built-in or saved custom revision appears by name and supported levels. Assign profile selects the exact revision in the draft; mapping alone does not authorize activation. Different passing mappings remain choices, not ambiguity errors or backend-family identification. No duplicate custom revision is created for an existing match. ([REQ-ENTERPRISE-034](../../sdd/spec/enterprise-mode.md#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection))

When no existing profile fits, mapping can prepare an immutable custom draft from an unambiguous subset of passed modes. Failed modes and unproven off are excluded. Supply a name and choose **Create & Assign**: the revision is added to the configuration draft and selected for the same mapped route. Nothing is persisted until Save. Codeflare uses the bounded known protocol bank; it neither invents provider request properties nor asks administrators to author mappings. ([REQ-ENTERPRISE-036](../../sdd/spec/enterprise-mode.md#req-enterprise-036-enterprise-pi-custom-profile-draft-lifecycle), [REQ-ENTERPRISE-037](../../sdd/spec/enterprise-mode.md#req-enterprise-037-enterprise-pi-custom-profile-generation))

Both UI checks use a fixed 4,096 completion tokens per request, without token controls or a secondary Check button. Map Profile starts once when its editor opens; Verify Profile starts only on explicit activation. Neither retries nor escalates automatically. Exhausted tool calls or replays remain incomplete, not incompatible. **Technical check details** groups sanitized stages, levels, and counters by candidate; one candidate's failure does not color another matched profile. Authentication, quota, server, transport, and malformed-stream failures stop the scan. ([REQ-ENTERPRISE-034](../../sdd/spec/enterprise-mode.md#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection))

Verify Profile presents Selected profile checks as a level-by-check table: Compatibility, Tool call, and Tool replay. Passed, Failed, and Unclear labels distinguish evidence from incomplete or unattempted checks. Off-disabled evidence is separate. Accepted level fields and tool replay do not prove increasing reasoning effort. Multi-model success is eligible with an orange backup-untested warning: AI Gateway exercised a path, not every backend. No per-leg or whole-route evidence is fabricated. ([REQ-ENTERPRISE-038](../../sdd/spec/enterprise-mode.md#req-enterprise-038-enterprise-pi-selected-profile-verification))

Verification compares inventory before and after the check. Complete selected-profile success returns a temporary server receipt bound to the profile, gateway credential context, topology, declared provenance, and canary. Save validates that receipt or unchanged saved authority; client evidence flags cannot create eligibility. Reload requires current server-owned verification and matching fresh inventory. Profile or connection changes invalidate draft eligibility, and a failed recheck cannot retain it. A checked inactive draft can be saved without granting access. ([REQ-ENTERPRISE-038](../../sdd/spec/enterprise-mode.md#req-enterprise-038-enterprise-pi-selected-profile-verification), [REQ-ENTERPRISE-040](../../sdd/spec/enterprise-mode.md#req-enterprise-040-enterprise-pi-check-lifecycle))

New custom profiles and backend descriptions can be verified before Save. Group and optional fallback policies offer only eligible routes. A single available route is preselected when adding a group; new reasoning defaults prefer Medium, then Off, then the first supported level. Minimum Save is a working gateway and a verified route assigned to at least one group. Unfinished routes do not block it. Disabled fallback gives unmatched users no routes. The first matching configured group remains authoritative even when empty; it never falls through to a different group or fallback. ([REQ-ENTERPRISE-038](../../sdd/spec/enterprise-mode.md#req-enterprise-038-enterprise-pi-selected-profile-verification), [REQ-ENTERPRISE-039](../../sdd/spec/enterprise-mode.md#req-enterprise-039-enterprise-pi-default-reasoning-controls))

The interface marks named drafts unsaved until confirmation succeeds. Confirm Save summarizes Connection, Route profiles, Group access, and Fallback; technical execution details are secondary. Explicit warning acknowledgements and baseRevision checks remain. Custom revisions, assignments, server verification, and fallback policy are written in the existing reasoning configuration document. Runtime exposes only eligible policy-selected routes and denies an empty catalog before upstream inference, without management polling. ([REQ-ENTERPRISE-031](../../sdd/spec/enterprise-mode.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-032](../../sdd/spec/enterprise-mode.md#req-enterprise-032-enterprise-pi-route-selection-and-runtime-translation), [REQ-ENTERPRISE-034](../../sdd/spec/enterprise-mode.md#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-036](../../sdd/spec/enterprise-mode.md#req-enterprise-036-enterprise-pi-custom-profile-draft-lifecycle)) <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields --> <!-- @impl: src/lib/admin-configuration.ts::buildConfigurationPreview -->

## D1 database and migrations

Each deployment uses one D1 database named `<worker-name>-usage`, bound to the Worker as `USAGE_DB`. The deploy workflow lists exact names, rejects duplicates, creates the database when absent, writes its ID into the temporary `wrangler.toml`, and applies migrations before Worker deployment. Account IDs and database IDs do not belong in source. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: scripts/ci/prepare-usage-d1.mjs::prepareUsageD1 -->

`migrations/usage/0001_initial.sql` is additive. It creates historical user and period rows, report delivery records, and maintenance claims. Deploying Worker code before this migration is not supported. The workflow fails instead of publishing code against a missing schema. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: migrations/usage/0001_initial.sql::usage_users -->

D1 and KV must be restored as separate systems. A KV restore recovers live settings and run records; it does not recover historical usage or report claims. Use Cloudflare D1 Time Travel or the account's approved D1 backup procedure for `USAGE_DB`, then verify migration state before restoring Worker traffic. Restoring D1 to an older point can legitimately remove newer history and delivery evidence. Do not manufacture replacement rows from current quota totals. ([AD150](../decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records))

## Deployment credentials

Deployment continues to use the established `CLOUDFLARE_API_TOKEN`. It needs D1 Edit together with its existing Worker deployment permissions so the workflow can resolve the database, apply migrations, deploy, and preserve the same Worker secret. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: .github/workflows/deploy.yml::deploy -->

Store the deployment token and deployment account ID in the existing repository or target-environment Actions secret scope. They do not enter source, D1, Activity, or report history. These deployment values are distinct from session credentials: a non-Enterprise connected Cloudflare token and account ID enter that user's container, while Enterprise emits only the non-secret Browser Run token placeholder and configured account ID; the real Enterprise Browser Rendering token remains Worker-side. ([REQ-OPS-056](../../sdd/spec/operations.md#req-ops-056-non-destructive-d1-deployment-boundary)) <!-- @impl: .github/workflows/deploy.yml::deploy --> <!-- @impl: src/container/container-env.ts::buildEnvVars -->

## Retention and reports

Historical rows use UTC periods. Active day rows retain the current day plus 399 preceding days, week rows retain 59 preceding ISO weeks, month rows retain 59 preceding months, and year rows retain four preceding years. Deleted users and their named aggregate rows remain for 60 calendar months. Report delivery records remain for 60 calendar months. Maintenance claims remain for 35 UTC days. ([REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting), [REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-028](../../sdd/spec/subscription.md#req-sub-028-historical-usage-and-report-retention)) <!-- @impl: src/lib/usage-report-scheduler.ts::retentionCutoffs -->

One 15-minute scheduler owns report dispatch, recovery, and a once-daily token-guarded retention transaction. Reports are disabled by default. KV stores each schedule's next due instant under `admin:usage-reports:next:<settingsRevision>`, preventing a stale revision from consuming the current revision's schedule. When enabled, each recipient gets a separate claimed delivery with at most three attempts. `accepted` means Resend accepted the request. It does not claim inbox delivery, and no provider ID is invented. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods)) <!-- @impl: src/lib/usage-report-scheduler.ts::runUsageReportScheduler -->

CSV attachments stop at 8 MiB. Scheduled messages report the latest closed UTC month and use deterministic idempotency; test requests report the current UTC month and use their request identity so two test clicks remain two tests. ([REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods)) <!-- @impl: src/lib/usage-reports.ts::buildReportArtifacts --> <!-- @impl: src/routes/admin/usage-reports.ts::default -->

## Operation envelope and logging

At 2,000 active developers with three sessions each, a steady-state non-SaaS positive Timekeeper ping with cached period markers performs one sub-4-KB accounting-state write and no KV reads. A first marker observation can read Durable Object marker state and write up to four marker keys plus rollover outbox entries. SaaS pings additionally read the KV usage record, tier configuration, and user record for quota enforcement. Historical D1 writes run once per user on a hash-phased 15-minute duty, not once per session. Stable visible session status polls run every 60 seconds; transitions use five seconds; hidden pages stop polling. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

Integration and Enterprise Integration retain `head_sampling_rate = 1`. Production and Enterprise use `0.05`. D1 history metrics record rows read, rows written, SQL duration, backlog age, and snapshot count without email addresses or secrets. Before Production history is enabled, operators must add account-level D1 operation and spend alerts and verify caught structured errors plus uncaught exceptions remain discoverable under the intended sampling policy. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: scripts/ci/set-head-sampling.mjs::setHeadSampling -->

Pricing assumptions were checked on 29 August 2026. Refresh Cloudflare D1 included-operation and overage prices before Production approval. The continuous stress model stays under 48 million billed D1 rows written, including indexes and retention; CI guards that envelope. ([REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/timekeeper/index.ts::Timekeeper -->

## Design-source review

Source ownership was checked against the approved Administration design contract and journey catalog supplied for implementation. Current routes cover Overview, every mode-gated Environment section, preview, execution, Analytics overview and user detail, Reports and delivery history, Activity, deleted users, provider failures, conflicts, interruption, empty history, and mobile composition. Shared administration tokens and responsive rules remain in `web-ui/src/styles/administration.css`; no chart or component framework was added. <!-- @impl: web-ui/src/App.tsx::App --> <!-- @impl: web-ui/src/styles/administration.css::.admin-shell -->

This is a source review, not browser acceptance. Pixel composition, touch behavior, focus order, network cadence, and email rendering still need the Integration checks below.

## Integration acceptance checklist

Record exact commit and Deploy run before testing. Then verify:

- Mode-aware navigation and every applicable Environment section in Default, Onboarding, SaaS, and Enterprise.
- One non-destructive Environment review and apply, including conflict, reconnect, failure, and interrupted states.
- In Enterprise AI Routing, confirm the gateway route catalog loads without editable JSON; create and Apply one bounded immutable custom revision; inspect a route containing conditional and fallback legs; declare any custom-provider backend; and verify per-leg evidence does not change the selected route-wide profile.
- Run bounded discovery for one target and verify Pi 0.84.4 streaming, tool call, exact result replay, logical-probe/HTTP-attempt counts, and non-activation. Revalidate after a route version or declared backend changes.
- Activate one structurally valid profile with incomplete or heterogeneous evidence only after explicitly confirming the recomputed warning; verify a stale `baseRevision` is rejected.
- Start Pi for the global fallback and for a matching group: verify all allowed routes appear, startup route/reasoning match that scope, `/model` switches routes, and a tool call completes after replay.
- Analytics empty-history and data-start states, actual period-history chart, Timekeeper-lag disclosure, user detail, deleted-user history, and CSV download.
- Reports disabled state, schedule presentation, current-month test email, provider failure, and delivery history.
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

Owning requirements are [REQ-SETUP-017 through REQ-SETUP-023](../../sdd/spec/setup.md), [REQ-SUB-025 through REQ-SUB-028](../../sdd/spec/subscription.md), and [REQ-OPS-056 through REQ-OPS-057](../../sdd/spec/operations.md).

## Related Documentation

- [Configuration](configuration.md)
- [Development and Deployment](deployment.md)
- [API Reference](api-reference.md)
- [Billing and Subscription](billing.md)
- [Architecture decision AD150](../decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records)
