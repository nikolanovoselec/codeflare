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

Overview reads current-day historical usage on navigation and lists every applicable Environment area. Analytics period buttons immediately request the selected period; editing a start date still requires Apply filters. Weeks start Monday at 00:00 UTC, not local midnight. Equal day/week/month/year totals can reflect collection beginning within the current day; older quota usage is not backfilled. ([REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-SUB-025](../../sdd/spec/subscription.md#req-sub-025-durable-historical-usage-accounting), [REQ-SETUP-019](../../sdd/spec/setup.md#req-setup-019-administration-and-analytics-shell))

Analytics, Reports, and Activity are demand-driven. They read on navigation, filter changes, explicit refresh, or run reconnect. They do not background-poll. Analytics charts a bounded history of actual totals from existing D1 period rows; `historyUpdatedAt` identifies the newest returned row because historical D1 snapshots can lag live Timekeeper usage. ([REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-OPS-057](../../sdd/spec/operations.md#req-ops-057-bounded-administration-operation-envelope)) <!-- @impl: src/lib/admin-usage.ts::queryAdminUsageSeries --> <!-- @impl: web-ui/src/components/admin/AnalyticsPage.tsx::AnalyticsPage -->

## Enterprise capability profiles

<!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/routes/admin/ai-capability-discovery.ts::routes -->

Administration discovers gateway-owned Dynamic Routes; each enabled target has a positive context window and an authorized Pi compatibility contract. Unrelated unconfigured targets remain visible without blocking Save. The normal workflow is **select target → Discover → review result → Save**. There is no profile chooser, naming task, per-model mapping authoring or second Verify step. The dedicated [target capability component](target-capability-discovery.md) automatically selects and verifies shared protocol handling. ([REQ-ENTERPRISE-034](../../sdd/spec/enterprise-mode.md#req-enterprise-034-enterprise-pi-route-administration), [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection))

Connection, Dynamic routes, Native routes, and Access & fallback remain separate sections. Routes begin as compact status rows; Native readiness distinguishes Live-verified from Administrator-confirmed, with Not ready when current proof is absent. Expanding a Dynamic Route shows detected models, typed context and Discover; expanding a native target shows its exact provider/model/region and Discover. Successful discovery automatically attaches the canonical contract and server-issued receipt to the exact draft. A visible **Check result** sits below Discover and outside **Advanced: choose a profile**. Its verdict and next action stay visible while technical details are collapsed.

Assign access/fallback policy as needed, choose **Review changes**, then **Confirm Save**; saved changes apply at the next normal session start. Native rechecks immediately clear old success and draft receipts, including while pending. The UI discards results if target, connection or inventory changed during the check. ([REQ-ENTERPRISE-054](../../sdd/spec/enterprise-mode.md#req-enterprise-054-native-target-profile-and-lifecycle-administration), [REQ-ENTERPRISE-056](../../sdd/spec/enterprise-mode.md#req-enterprise-056-native-target-disclosure-and-readiness)) <!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields -->

Native automation is deliberately **Bedrock-only**, based on its observed Runtime/compatibility boundary. Azure and other native protocols retain their existing advanced workflows until a separate adapter extension is justified. New Anthropic Messages candidates reuse `bedrock-anthropic-native-provider-default`, explicit region and automatic native transport. Their namespace suggests a protocol candidate, not availability or entitlement. No per-release profile definition is generated. Existing Invoke and compatibility targets never silently migrate; compatibility rejects a region. See [generic model support](bedrock-generic-model-support.md). ([REQ-ENTERPRISE-074](../../sdd/spec/enterprise-mode.md#req-enterprise-074-provider-native-bedrock-target-identity), [REQ-ENTERPRISE-075](../../sdd/spec/enterprise-mode.md#req-enterprise-075-provider-native-bedrock-administration-authority))

The grading priority is tools with exact replay, caching, reasoning, streaming. **Minimum** requires tools/replay plus provider prefix-read evidence or Gateway HIT, separately labelled. **Acceptable** adds Provider-default or observed enabled reasoning (visible reasoning output or positive structured reasoning-token evidence). **Optimal** adds cold incremental public delivery before completion. Without qualifying Gateway HIT or positive prefix reads, missing cache evidence is inconclusive, not proof of unsupported caching. Failure exposes sanitized stage, HTTP status and provider code, not raw content. Refused cache-fill results distinguish observed writes from the unattempted paired read. Missing cache reuse and an incompatible buffered envelope have separate messages; neither is mislabeled as connection failure. A new discovered contract cannot use administrator confirmation to bypass this minimum. ([REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection)) <!-- @impl: src/lib/ai-capability-discovery/contract.ts::capabilityMinimum --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility -->

Provider-default and generated normalized contracts expose all seven Pi preferences without expanding canonical mappings or verification receipts. Provider-default policy controls display Provider default and all preferences normalize at the Worker without asserting seven provider controls or true Off. Discovered enabled forms normalize to one tested mapping. Existing evidence-specific Sonnet/Opus profiles retain their validated mappings and explicit aliases. Automatic Opus XHigh/Max still select Invoke; this historical rule is not applied to new model names. Zero executable provider mappings must not mean zero selectable Pi preferences. <!-- @impl: src/lib/reasoning-profiles.ts::translateRuntimeReasoningRequest --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig --> ([REQ-ENTERPRISE-072](../../sdd/spec/enterprise-mode.md#req-enterprise-072-provider-native-bedrock-reasoning-profiles), [REQ-ENTERPRISE-039](../../sdd/spec/enterprise-mode.md#req-enterprise-039-enterprise-pi-default-reasoning-controls))

Dynamic discovery constructs/reuses content-addressed OpenAI wire contracts across providers/models, with an explicit compatibility endpoint, narrow complete-tool-name repair, and a bounded completed-JSON alternative. Native cache serialization never leaks into Dynamic. Gateway HIT meets the relaxed cache minimum but does not establish Dynamic prefix caching. Evidence covers only the exercised branch; conflicting known backend identities cannot be combined across reasoning, tools/replay and cache, and capability-checked multi-distinct-backend routes require selected-backend identity. Historical Advanced verification retains its existing evidence semantics; other branches remain unverified. ([REQ-ENTERPRISE-033](../../sdd/spec/enterprise-mode.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence))

Discover discloses at most **40 submissions**, 2,048 output tokens each, 90 seconds per request and 10 minutes overall. The finite current search uses at most 38; native Runtime and ordinary Provider-default success use four. The approximately 60-KiB public prefix has model-dependent token count, so the check is billable rather than free. There are no retries, real tools, model substitutions or startup/background probes. Tools/replay failure prevents that contract's cache checks. Authentication, rate-limit, provider/server, framing and timeout boundaries stop the campaign. Gateway keys/TTLs/policies are not changed. ([REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection)) <!-- @impl: src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverCache -->

Inventory loading is read-only and never starts inference or changes assignments. Context/model suggestions and any existing custom-backend descriptions remain available without claiming authoritative model capability. Profile/catalog labels are provenance, not identification of the current backend. Exact provider binding, model, region, profile/hash, transport and adapter identity are checked server-side before issuing a receipt and again by the existing Save/authorization workflow. Old receipts remain readable but require explicit upgrade/reconfirmation where their adapter identity is stale; unrelated stale entries can remain unchanged and disabled. A checked inactive draft can be saved without granting access. ([REQ-ENTERPRISE-038](../../sdd/spec/enterprise-mode.md#req-enterprise-038-enterprise-pi-selected-profile-verification)) <!-- @impl: src/lib/native-ai-targets.ts::nativeVerificationMatches -->

Authentic native replay remains confidential and isolated by user/session/target/tool and verified provider/model/region/profile/transport/adapter authority. Signed, redacted and unsigned assistant blocks are restored unchanged. Missing active state fails before provider I/O even for Provider default or Off. Valid tool continuations retain Eventstream where the selected operation supports it. Explicit Invoke and the historical Opus upper-effort rule remain non-streaming. Response-DLP buffering is a separate Gateway policy boundary, not repaired by profile choice. ([REQ-ENTERPRISE-073](../../sdd/spec/enterprise-mode.md#req-enterprise-073-provider-native-bedrock-replay-integrity), [REQ-ENTERPRISE-077](../../sdd/spec/enterprise-mode.md#req-enterprise-077-provider-native-bedrock-transport-dispatch), [REQ-ENTERPRISE-080](../../sdd/spec/enterprise-mode.md#req-enterprise-080-provider-native-bedrock-stream-completion)) <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::assistantContent --> <!-- @impl: src/lib/bedrock-anthropic-native-adapter.ts::selectBedrockAnthropicTransport -->

### Retained Advanced workflows

<!-- @impl: web-ui/src/components/admin/AiRoutingFields.tsx::AiRoutingFields -->

The previous profile picker, Discover Profile matching editor, selected-profile Verify and eligible historical Mark as verified controls share **Advanced: choose a profile**. Selected-profile verification updates the same visible Check result; administrator assessment is not automated evidence. Other native providers keep that workflow. They are not required by normal target discovery. The built-in registry and saved custom revisions remain immutable and backward compatible; no fixed model/catalog count is an eligibility rule.

Advanced Discover Profile offers compatible existing revisions, or a named Create & Assign draft from an unambiguous compatible subset. Failed/unproven modes are excluded. These historical actions retain their separate 4,096-token defaults, explicit selection/Verify semantics and rate-limit notices. Their canary identifier still names the original Pi 0.84.4 contract; offline integration also tests the real locked Pi 0.85.1 parser/serializer. No model-family or graduated-effort claim follows from matching. ([REQ-ENTERPRISE-036](../../sdd/spec/enterprise-mode.md#req-enterprise-036-enterprise-pi-custom-profile-draft-lifecycle), [REQ-ENTERPRISE-037](../../sdd/spec/enterprise-mode.md#req-enterprise-037-enterprise-pi-custom-profile-generation))

Selected-profile verification retains its per-level tool/replay details. Eligible historical administrator confirmation makes no inference request and remains visibly distinct from automated evidence. It cannot invent a discovered-contract grade. Profile edits/rechecks invalidate draft eligibility; connection changes use the existing binding-preserving revalidation/Review path rather than silently trusting browser evidence. Save requires warning confirmation at the current base revision. Configuration review, credential isolation and normal next-start application remain unchanged. ([REQ-ENTERPRISE-038](../../sdd/spec/enterprise-mode.md#req-enterprise-038-enterprise-pi-selected-profile-verification), [REQ-ENTERPRISE-040](../../sdd/spec/enterprise-mode.md#req-enterprise-040-enterprise-pi-check-lifecycle), [REQ-ENTERPRISE-057](../../sdd/spec/enterprise-mode.md#req-enterprise-057-ai-gateway-connection-rotation))

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
- In Enterprise AI Routing, confirm the compact gateway route catalog loads without editable JSON; use Create & Assign for a bounded custom draft, supply required custom-backend descriptions, and Verify the exact selection before assigning access and confirming Save.
- Run bounded discovery for one target and verify Pi 0.84.4 streaming, tool call, exact result replay, logical-probe/HTTP-attempt counts, and non-activation. Revalidate after a route version or declared backend changes.
- Activate a successfully checked route through explicit Review changes and Confirm Save; observed-path success requires acknowledging that other backends remain untested. Verify unchecked routes cannot be activated and a stale `baseRevision` is rejected.
- Start Pi for an explicitly enabled fallback policy and a matching group: verify only eligible allowed routes appear, startup defaults match the policy, `/model` switches routes, and tool replay completes. Disabled fallback and empty first-matching policies must grant no routes.
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
| Enterprise discovery and exact receipt authority — [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-075](../../sdd/spec/enterprise-mode.md#req-enterprise-075-provider-native-bedrock-administration-authority) | `src/lib/ai-capability-discovery/index.ts::discoverTargetCapabilities`, `src/routes/admin/ai-capability-discovery.ts::routes` |
| Native identity, replay, and cache — [REQ-ENTERPRISE-074](../../sdd/spec/enterprise-mode.md#req-enterprise-074-provider-native-bedrock-target-identity), [REQ-ENTERPRISE-073](../../sdd/spec/enterprise-mode.md#req-enterprise-073-provider-native-bedrock-replay-integrity), [REQ-ENTERPRISE-083](../../sdd/spec/enterprise-mode.md#req-enterprise-083-native-bedrock-prompt-cache-checkpoints) | `src/lib/native-ai-targets.ts::nativeVerificationMatches`, `nativePromptCacheSupported`, `src/lib/bedrock-anthropic-native-adapter.ts::assistantContent` |
| Historical accounting and analytics | `src/timekeeper/`, `src/lib/admin-usage.ts`, `src/routes/admin/usage.ts` |
| Reports, claims, email, and retention | `src/lib/usage-report-scheduler.ts`, `src/lib/usage-reports.ts`, `src/routes/admin/usage-reports.ts` |
| Administration UI and demand-driven reads | `web-ui/src/components/admin/`, `web-ui/src/api/client.ts` |
| Deployment boundary | `scripts/ci/prepare-usage-d1.mjs`, `.github/workflows/deploy.yml` |

Owning requirements are [REQ-SETUP-017 through REQ-SETUP-023](../../sdd/spec/setup.md), [REQ-SETUP-027](../../sdd/spec/setup.md#req-setup-027-native-target-configuration-projection), [REQ-SUB-025 through REQ-SUB-028](../../sdd/spec/subscription.md), and [REQ-OPS-056 through REQ-OPS-057](../../sdd/spec/operations.md). Native-target projection returns before provider management when storage is absent or malformed. <!-- @impl: src/lib/admin-configuration.ts::readNativeTargetViews -->

## Related Documentation

- [Configuration](configuration.md)
- [Target capability discovery](target-capability-discovery.md)
- [Generic Anthropic Bedrock model support](bedrock-generic-model-support.md)
- [Bedrock prompt caching](bedrock-prompt-caching.md)
- [Development and Deployment](deployment.md)
- [API Reference](api-reference.md)
- [Billing and Subscription](billing.md)
- [Architecture decision AD150](../decisions/README.md#ad150-d1-owns-historical-usage-and-report-delivery-records)
