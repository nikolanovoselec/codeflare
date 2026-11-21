# API Reference

Public Worker, authenticated proxy, and integration endpoint contracts for Codeflare. Private host-only routes are identified but owned by the runtime lanes.

**Audience:** Developers

**Owns:** method, public path, authorization, request, response, error, rate-limit, requirement, and handler contracts. **Does not own:** provisioning implementation, private host mechanics, deployment values, security rationale, or operator policy/procedure. Conductor's [requirements](https://github.com/nikolanovoselec/codeflare-operator-conductor/blob/develop/sdd/spec/conductor.md) own packet/lane/reviewer behavior, history/reassessment and publication format. Existing `review-*` handler names identify actual Root adapters, not ownership of that application policy.

## Contents

- [Conventions](#conventions)
- [Session Management](#session-management)
- [Container Lifecycle](#container-lifecycle)
- [Operator Activities](#operator-activities)
- [Internal Review enrollment](#internal-review-enrollment)
- [Internal Operator Host APIs](#internal-operator-host-apis)
- [Terminal](#terminal)
- [Vault](#vault)
- [Browser IDE](#browser-ide)
- [User Management](#user-management)
- [Notifications](#notifications)
- [Auth (SaaS Mode)](#auth-saas-mode)
- [Usage](#usage)
- [Admin](#admin)
- [Billing](#billing)
- [Deploy Keys](#deploy-keys)
- [GitHub Integration](#github-integration)
- [Cloudflare Integration](#cloudflare-integration)
- [Public (Unauthenticated)](#public-unauthenticated)
- [Discoverability Documents](#discoverability-documents)
- [Setup](#setup)
- [Storage (R2 File Browser)](#storage-r2-file-browser)
- [Preferences](#preferences)
- [LLM API Keys](#llm-api-keys)
- [Public (Onboarding)](#public-onboarding)
- [Public (Landing)](#public-landing)
- [Health](#health)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

---

<a id="conventions"></a>
## Contract Conventions

### Route Ownership

| Surface | Owner and exposure |
|---|---|
| Worker `/api/*` and `/public/*` | Public edge API. Each table below states whether the route is unauthenticated, cookie-authenticated, or service-authenticated. |
| Worker `/api/container/*` | Authenticated edge proxy into the caller's session container; these are not direct host URLs. |
| Host `/health`, `/activity`, `/internal/runtime-observation`, `/terminal` | Private container-server routes reached through the Durable Object or Worker proxy. Rich health and consolidated runtime observation include metrics; normal metrics collection uses the authenticated consolidated observation. There is no separate `/metrics` route. Runtime mechanics belong to [Container](container.md). |
| Worker and host `/api/vscode/:sessionId/*` | Authenticated Worker route with private forwarding to the same host path; IDE process and proxy mechanics belong to [Terminal & IDE](terminal-and-ide.md#browser-ide-internals). |

Route paths in this reference are externally callable only where their row says so; a private host path is not an alternate public endpoint.

### Common Response Headers

| Header | Description |
|--------|-------------|
| `X-Request-ID` | Correlation ID: caller value matching `[A-Za-z0-9_-]{1,64}`, otherwise a generated eight-character ID; not guaranteed unique |
| `X-RateLimit-Limit` | Max requests per window (rate-limited endpoints) |
| `X-RateLimit-Remaining` | Requests remaining (rate-limited endpoints) |

### Error Response Format

Typed `AppError` responses use this shared envelope. Route-specific and framework errors can differ; an unexpected generic `500` has no `code`. <!-- @impl: src/index.ts::app -->

```json
{ "error": "User-friendly message", "code": "ERROR_CODE" }
```

Codes: `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `CONTAINER_ERROR` (500), `AUTH_ERROR` (401), `FORBIDDEN` (403), `SETUP_ERROR` (400), `RATE_LIMIT_ERROR` (429), `QUOTA_EXCEEDED` (402), `CIRCUIT_BREAKER_OPEN` (503).

A `SetupError` handled outside the stream uses `{ success: false, steps, error, code }`. A failure after the Setup NDJSON stream starts uses the [stream completion envelope](#ndjson-stream-contract) instead.

## Session Management

`POST /api/sessions` accepts optional request-body `agentType` for the coding-agent choice; validation and defaulting remain server-owned ([REQ-AGENT-002](../../sdd/spec/agents.md#req-agent-002-agent-selection-at-session-creation)).

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/sessions` | Session cookie | [REQ-SESSION-028](../../sdd/spec/session-lifecycle.md#req-session-028-session-authority-has-no-kv-compatibility-path) AC1 | List the authenticated owner’s D1 sessions. |
| POST | `/api/sessions` | Session cookie | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-ENTERPRISE-003](../../sdd/spec/agents.md#req-enterprise-003-agent-allowlist-in-enterprise-mode), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions) | Create session record (10 requests/user/minute; snapshots the server-owned entitled default workspace; strict body validation rejects client-supplied `workspace`; does not consume a concurrent-running slot; under enterprise mode `agentType` outside the wizard-governed allowlist is rejected 400) |
| GET | `/api/sessions/:id` | Session cookie | [REQ-SESSION-028](../../sdd/spec/session-lifecycle.md#req-session-028-session-authority-has-no-kv-compatibility-path) AC1 | Read one owner-scoped D1 session. |
| PATCH | `/api/sessions/:id` | Session cookie | [REQ-SESSION-027](../../sdd/spec/session-lifecycle.md#req-session-027-user-can-rename-sessions) | Update session (rename or `tabConfig`); the accepted `name` is sanitized and returned. <!-- @impl: src/routes/session/crud.ts::app.patch --> |
| DELETE | `/api/sessions/:id` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions) AC5–AC6; [REQ-SESSION-009](../../sdd/spec/session-lifecycle.md#req-session-009-container-destroy-wipes-session-state) AC5 | Gracefully stop the captured generation if needed and delete only that confirmed-stopped D1 row. Ambiguity or a newer generation prevents deletion. |
| POST | `/api/sessions/:id/touch` | Session cookie | [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-d1-lifecycle-evidence-is-generation-fenced) AC5 | Update `lastAccessedAt` and advance the response revision without changing lifecycle state. |
| POST | `/api/sessions/:id/stop` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions) AC3/AC6; [REQ-SESSION-035](../../sdd/spec/session-lifecycle.md#req-session-035-stale-stopping-retains-ownership-until-confirmed-exit) AC4–AC5 | The owning DO claims or reuses the captured generation’s termination intent and confirms stopped only after exit evidence. Already stopped is a no-op. |
| POST | `/api/sessions/:id/kill` | Session cookie (owner) | [REQ-SESSION-039](../../sdd/spec/session-lifecycle.md#req-session-039-authorized-do-owned-native-kill), [REQ-SESSION-040](../../sdd/spec/session-lifecycle.md#req-session-040-kill-confirmation-retry-and-generation-fencing) | Force-destroy independently of graceful Stop (10 requests/user/minute); confirmed exit required, uncertainty retryable. Retains the session row and persisted R2 files. Bypasses final sync; unsynced container-local edits can be lost. Hosted native qualification and owner acceptance remain pending. |
| GET | `/api/sessions/:id/status` | Session cookie | [REQ-SESSION-028](../../sdd/spec/session-lifecycle.md#req-session-028-session-authority-has-no-kv-compatibility-path) AC1, [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-d1-lifecycle-evidence-is-generation-fenced) AC1 | Return the owner’s stored D1 session and lifecycle status without a live container probe. |
| GET | `/api/sessions/batch-status` | Session cookie | [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard) AC1–AC3, [REQ-SESSION-035](../../sdd/spec/session-lifecycle.md#req-session-035-stale-stopping-retains-ownership-until-confirmed-exit) AC1 | Return this owner's lifecycle, readiness, activity, and metrics projection from D1 without changing stale `stopping` ownership; successful projections are `no-store`. |
| GET | `/api/sessions/ancillary-status` | Session cookie | [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release), [REQ-STOR-036](../../sdd/spec/storage.md#req-stor-036-managed-reconciliation-progress-reads), [REQ-ENTERPRISE-315](../../sdd/spec/subscription.md#req-enterprise-315-enterprise-pro-seed-migration) AC1 | Slower usage, storage-cache, entitlement, managed-release, preseed, and governed-migration projection; always `no-store` |
| POST | `/api/sessions/sync` | Session cookie | [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui) | Trigger bisync across the authenticated user's workload-owning sessions (`starting`, `running`, `unreachable`, `stopping`), returning `{sessions, count}` with one trigger result per selected session. During bucket migration, returns `{sessions: [], count: 0}` without sending triggers. |

The ancillary response may include a nonempty opaque `preseedUpgradeTarget` derived from the desired release or baked hash, sequence, mode, policy, and projection. This target stays stable across progress updates and supports page-local attempt suppression; it is neither applied state nor mutation authority. On the baked path a hash mismatch or an Enterprise session not yet stored as Advanced calls for reconciliation; a workload-owning session suppresses the upgrade offer. See [REQ-STOR-023](../../sdd/spec/storage.md#req-stor-023-managed-release-status-projection) AC6 and [REQ-SESSION-244](../../sdd/spec/session-lifecycle.md#req-session-244-lifecycle-polling-and-ancillary-scheduling) AC2.

While a managed release is `upgrading`, a valid progress record with the active release digest may add `managedReleaseProgress: { phase, completed, total }`; it is not matched against the full `preseedUpgradeTarget`. After application, ancillary status may briefly show `finalizing` as `upgrading` and attempts to clear that record. Concurrent reads or failed cleanup can repeat this display; progress is not proof that the release was applied. See [REQ-STOR-036](../../sdd/spec/storage.md#req-stor-036-managed-reconciliation-progress-reads) AC2/AC4.

Session responses normalize `workspace` to `terminal` or `vscode`; historical records without the field resolve to `terminal`, while new D1 records persist an explicit `terminal` or `vscode` workspace snapshot. The snapshot is immutable after creation and preference changes affect future sessions only ([REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions)).

A successful stop ends Container vCPU, provisioned-memory, and local-disk metering once the Container sleeps. Local disk is ephemeral rather than hibernated state; a later start restores durable files from R2. This endpoint contract makes no zero-total-platform-cost claim: Workers, Durable Objects, R2, requests, logs, storage, and network usage may still be billable.

## Container Lifecycle

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/container/start` | Session cookie | [REQ-SESSION-007](../../sdd/spec/session-lifecycle.md#req-session-007-running-session-count-limited-per-tier), [REQ-SUB-007](../../sdd/spec/subscription.md#req-sub-007-quota-enforcement-at-session-start-402) | Start container (5 requests/user/minute; checks other workload-owning sessions and applicable SaaS compute quota; non-blocking) |
| POST | `/api/container/destroy` | Session cookie | [REQ-SESSION-009](../../sdd/spec/session-lifecycle.md#req-session-009-container-destroy-wipes-session-state) AC1–AC5; [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions) AC3/AC6 | Stop the captured D1 run and confirm stopped only after exit evidence; an already stopped run is a no-op. Retains the session row and R2 files. |
| GET | `/api/container/startup-status` | Session cookie | [REQ-SESSION-017](../../sdd/spec/session-lifecycle.md#req-session-017-container-health-and-startup-status-api) AC2, AC3 | Poll startup progress |
| GET | `/api/container/health` | Session cookie | [REQ-SESSION-017](../../sdd/spec/session-lifecycle.md#req-session-017-container-health-and-startup-status-api) AC1 | Health check |

`GET /api/container/startup-status` returns a derived `stage`, numeric `progress`, human-readable `message`, and `details`. Its observable progress contract is:

| Stage | Progress | Condition |
|---|---:|---|
| `stopped` | 0 | Container state is unavailable |
| `starting` | 10 | Platform state is not `running` or `healthy` |
| `starting` | 20 | Platform state is up but host health is unavailable |
| `syncing` | 30 | Initial sync is pending |
| `syncing` | 45 | Initial sync is active |
| `verifying` | 85 | Initial sync completed but the host service is not ready |
| `mounting` | 90 | Terminal workspace: the backend terminal service is registered but PTY pre-warm is incomplete, so visible clients remain disconnected until `ready`. VS Code workspace: code-server is still preparing. |
| `ready` | 100 | Terminal workspace: terminal service and PTY pre-warm are ready. VS Code workspace: `editorReady` is true; `terminalServerOk` may remain false because no host PTY is created. |
| `error` | 0 | Initial sync failed, VS Code editor warming reached its bounded timeout, or the startup-status handler failed |

These are endpoint observations, not persisted lifecycle states. `details` identifies container, sync, host, terminal, editor (`editorReady`), and metric observations when available. A VS Code editor timeout returns retry guidance and persists `editorReadyError` for dashboard actions ([REQ-IDE-049](../../sdd/spec/browser-ide.md#req-ide-049-dashboard-vs-code-startup-and-recovery)).

Session creation may reject the enterprise agent allowlist or SaaS storage quota before writing a record. Start may reject an active bucket migration, an agent absent from the deployed image, the current concurrent-session policy check, or compute quota. The session-count check and later generation-bound D1 lifecycle claim are not atomic. Concurrent-session admission is explicitly best effort, so simultaneous starts may exceed the nominal per-user limit; deployment `max_instances` is a separate hard platform boundary. Enterprise currently follows the non-SaaS role-based resolver, while [issue #880](https://github.com/nikolanovoselec/codeflare/issues/880) tracks one role-independent Enterprise limit.

A successful Start returns the acknowledged `generation`; `starting` means the DO owns the asynchronous launch, not that ports are ready. `/startup-status` includes the observed generation. Only `ready` for the acknowledged generation completes that Start in the browser. SDK startup failure does not establish stopped. See [Troubleshooting](troubleshooting.md#container-start-is-rejected-or-returns-to-stopped).

## Operator Activities

These Worker routes exist only in enterprise mode and implement [REQ-OPERATOR-016](../../sdd/spec/operators.md#req-operator-016-durable-activity-admission-and-cleanup), [REQ-OPERATOR-017](../../sdd/spec/operators.md#req-operator-017-durable-drive-generations), [REQ-OPERATOR-018](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration), [REQ-OPERATOR-006](../../sdd/spec/operators.md#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-026](../../sdd/spec/operators.md#req-operator-026-managed-webhook-edge-bypass), [REQ-OPERATOR-029](../../sdd/spec/operators.md#req-operator-029-capability-authenticated-webhook-edge), [REQ-OPERATOR-031](../../sdd/spec/operators.md#req-operator-031-non-consuming-webhook-observation), [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface), [REQ-OPERATOR-033](../../sdd/spec/operators.md#req-operator-033-activity-surface-resilience), and [REQ-OPERATOR-217](../../sdd/spec/operators.md#req-operator-217-owned-activity-browser-lifetimes).

| Method | Path | Auth | Implements | Description |
|---|---|---|---|---|
| POST | `/api/operator-activities` | Session, verified current human Access, CSRF | [REQ-OPERATOR-018](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration) AC3 | Prepare an activity and issue its start capability. <!-- @impl: src/operators/orchestrator.ts::prepareOperatorActivity --> |
| GET | `/api/operator-activities` (`?limit=5[&after=<activityId>]`) | Session and verified human Access | [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface) | List owner-scoped activity summaries, optionally five per page. |
| GET | `/api/operator-activities/installations` (`?cursor=<installationId>`) | Session, verified current human Access, invocation or eligible management visibility | [REQ-OPERATOR-086](../../sdd/spec/operators.md#req-operator-086-dropdown-runs-and-installed-workspace) | List bounded installed metadata without granting execution. |
| GET | `/api/operator-activities/installations/:installationId/preview` | Session, verified current human Access and invocation grant | [REQ-OPERATOR-086](../../sdd/spec/operators.md#req-operator-086-dropdown-runs-and-installed-workspace) | Read the current enabled/approved pin's guided input contract. |
| POST | `/api/operator-activities/automatic/activation` | Current owner-admin Access session, invoker grant, CSRF | [REQ-OPERATOR-216](../../sdd/spec/operators.md#req-operator-216-explicit-application-schedule-activation) | Activate the declared installation schedule at the supplied revision. |
| POST | `/api/operator-activities/:activityId/publish` | Exact owner, current administrator, CSRF | Compatibility refusal | Returns `409 {ok:false, reason:"application-owned"}` after request validation; performs no publication. |
| POST | `/api/operator-activities/read` | Session, exact owner, CSRF | [REQ-OPERATOR-059](../../sdd/spec/operators.md#req-operator-059-new-activity-observation) | Acknowledge admissions through an observed sequence without collecting results. |
| GET | `/api/operator-activities/:activityId` | Session and exact owner | [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface), [REQ-OPERATOR-227](../../sdd/spec/operators.md#req-operator-227-owned-activity-detail-and-result-reads) | Read one bounded activity detail. |
| POST | `/api/operator-activities/:activityId/start` | Session, exact owner, CSRF | [REQ-OPERATOR-016](../../sdd/spec/operators.md#req-operator-016-durable-activity-admission-and-cleanup), [REQ-OPERATOR-018](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration), [REQ-OPERATOR-036](../../sdd/spec/operators.md#req-operator-036-owned-activity-user-mutations) AC2–AC3 | Admit and schedule one winning direct drive. |
| POST | `/api/operator-activities/:activityId/continue` | Session, exact owner, CSRF | [REQ-OPERATOR-017](../../sdd/spec/operators.md#req-operator-017-durable-drive-generations), [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface) | Schedule a new generation for durable waiting work. |
| POST | `/api/operator-activities/:activityId/cancel` | Session, exact owner, CSRF | [REQ-OPERATOR-016](../../sdd/spec/operators.md#req-operator-016-durable-activity-admission-and-cleanup), [REQ-OPERATOR-036](../../sdd/spec/operators.md#req-operator-036-owned-activity-user-mutations) AC1 | Fence the owned drive without overstating cleanup. |
| GET | `/api/operator-activities/:activityId/result` | Session and exact owner | [REQ-OPERATOR-227](../../sdd/spec/operators.md#req-operator-227-owned-activity-detail-and-result-reads), [REQ-OPERATOR-041](../../sdd/spec/operators.md#req-operator-041-retired-protected-write-receipt-reads) | Read owned detail and optional retired receipts. |
| POST | `/api/operator-activities/:activityId/result` | Session, exact owner, CSRF | Source-only collection contract | Collect a completed or failed browser result. |
| GET | `/api/operator-activities/diagnostics/v2/raw` | Verified current human administrator and original owner | [REQ-OPERATOR-228](../../sdd/spec/operators.md#req-operator-228-original-owner-protected-raw-log-readback) AC1 | Discover authenticated private archive locators for one observation or Activity generation. |
| GET | `/api/operator-activities/diagnostics/v2/raw/export` | Same current administrator and original owner | [REQ-OPERATOR-228](../../sdd/spec/operators.md#req-operator-228-original-owner-protected-raw-log-readback) AC1–AC2 | Stream one verified unredacted archive; a final completion frame certifies the export. |
| GET | `/api/operator-activities/:activityId/diagnostics` | Session, verified human Access and exact account ownership | [REQ-OPERATOR-080](../../sdd/spec/operators.md#req-operator-080-owned-dispatcher-lifecycle-readback) | Non-consuming, non-initializing parent and compatible-SDK lifecycle metadata. |
| GET | `/api/operator-activities/:activityId/diagnostics/v2` | Session, verified human Access and exact account ownership | [REQ-OPERATOR-081](../../sdd/spec/operators.md#req-operator-081-retained-dispatcher-causal-evidence), [REQ-OPERATOR-083](../../sdd/spec/operators.md#req-operator-083-retained-diagnostic-readback) | Retained cause/gap, original binding, fence, source capabilities and recorder health. |
| GET | `/api/operator-activities/:activityId/diagnostics/v2/history` | Same exact owner | [REQ-OPERATOR-081](../../sdd/spec/operators.md#req-operator-081-retained-dispatcher-causal-evidence), [REQ-OPERATOR-083](../../sdd/spec/operators.md#req-operator-083-retained-diagnostic-readback) | Bounded retained metadata page; one optional opaque cursor. |
| GET | `/api/operator-activities/:activityId/diagnostics/v2/records/:recordId` | Same exact owner | [REQ-OPERATOR-081](../../sdd/spec/operators.md#req-operator-081-retained-dispatcher-causal-evidence), [REQ-OPERATOR-083](../../sdd/spec/operators.md#req-operator-083-retained-diagnostic-readback) | One retained record and its available bounded failure/terminal capsule. |
| GET | `/api/operator-activities/:activityId/diagnostics/v2/export` | Same exact owner | [REQ-OPERATOR-081](../../sdd/spec/operators.md#req-operator-081-retained-dispatcher-causal-evidence), [REQ-OPERATOR-083](../../sdd/spec/operators.md#req-operator-083-retained-diagnostic-readback) | Resumable public metadata parts with snapshot/part digests; not an unbounded download. |
| POST | `/operator-webhook/v1/activities/claims/discovery` | Signed protected Action OIDC bearer, bounded JSON | [REQ-OPERATOR-215](../../sdd/spec/operators.md#req-operator-215-protected-action-discovery) | Discover an actor-bound match without consuming the handoff or returning capabilities. |
| POST | `/operator-webhook/v1/activities/claims/boundary` | Signed protected Action OIDC bearer and bounded JSON claim | [REQ-OPERATOR-054](../../sdd/spec/operators.md#req-operator-054-protected-action-claim-and-stop-fence) | Claim the exact prepared Action start handoff once. |
| POST | `/operator-webhook/v1/activities/claims/publication` | Signed protected Action OIDC bearer and bounded JSON intent | [REQ-OPERATOR-055](../../sdd/spec/operators.md#req-operator-055-pr-wide-publication-ordering) | Reconcile an opaque PR-wide effect receipt; no GitHub write or publication credential. |
| POST | `/operator-webhook/v1/activities/claims/publication-preparation` | Signed protected Action OIDC bearer and bounded JSON binding | [REQ-OPERATOR-056](../../sdd/spec/operators.md#req-operator-056-independent-review-publication) | Read the frozen owner-backed publication projection for an already collected terminal result; no publication write. |
| POST | `/operator-webhook/v1/activities/:activityId/start` | Activity start bearer capability | [REQ-OPERATOR-006](../../sdd/spec/operators.md#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-029](../../sdd/spec/operators.md#req-operator-029-capability-authenticated-webhook-edge) | Queue one activity and issue read authority once. |
| GET | `/operator-webhook/v1/activities/:activityId/status` | Activity read bearer capability | [REQ-OPERATOR-029](../../sdd/spec/operators.md#req-operator-029-capability-authenticated-webhook-edge), [REQ-OPERATOR-031](../../sdd/spec/operators.md#req-operator-031-non-consuming-webhook-observation) | Read bounded status and generation without consumption. |
| POST | `/operator-webhook/v1/activities/:activityId/continue` | Activity read bearer capability, JSON `{ "generation": 1 }` | [REQ-OPERATOR-053](../../sdd/spec/operators.md#req-operator-053-enterprise-pr-boundary-review-handoff) | Claim one observed waiting generation for a fenced resume. |
| POST | `/operator-webhook/v1/activities/:activityId/result` | Activity read bearer capability | [REQ-OPERATOR-006](../../sdd/spec/operators.md#req-operator-006-capability-authenticated-webhook-activity), [REQ-OPERATOR-029](../../sdd/spec/operators.md#req-operator-029-capability-authenticated-webhook-edge), [REQ-OPERATOR-031](../../sdd/spec/operators.md#req-operator-031-non-consuming-webhook-observation), [REQ-OPERATOR-053](../../sdd/spec/operators.md#req-operator-053-enterprise-pr-boundary-review-handoff) AC7 | Consume on the first terminal redemption; the same read authority can reread identical retained evidence within its original lifetime. |

### Browser activity endpoint details

All browser activity routes are enterprise-only. Missing bindings return `503`; a missing authenticated-account email header returns `401`, while failure of the verified-current-human Access gate returns `403`; POST without the CSRF header returns `403`. Activity-bound routes return `404` for invalid, absent or other-owner Activity IDs. <!-- @impl: src/routes/operator-activities.ts::app -->

Private raw discovery/export uses exactly one scope: `kind=observation&observationId=<id>` or `kind=activity&activityId=<id>&generation=<positive-integer>`. Both accept one optional 64-hex locator `cursor`; export also requires `captureId` from the selected page. Unknown, duplicate or incompatible fields are rejected. The server derives the owner from current verified authentication, never caller-supplied ownership or role. Registry observation reads need no Activity; Activity reads retain original generation, installation, release and logging-policy bindings. [REQ-OPERATOR-091](../../sdd/spec/operators.md#req-operator-091-protected-raw-logging-transport-and-delivery) <!-- @impl: src/routes/operator-activities.ts::handleOwnerRawRead --> <!-- @impl: src/operators/raw-capture-read.ts::requireOwnerRawReader --> <!-- @impl: src/operators/registry.ts::readOwnerRawCaptures --> <!-- @impl: src/operators/activity.ts::readOwnerRawCaptures -->

Discovery returns `{status, bindings, cursor}` for one authenticated page of up to 100 locators, not an archive-completeness certificate. The returned `cursor` continues to the next page. Export must reuse the cursor used to request the selected page, omitted for the first page, together with its `captureId`; passing the returned continuation instead selects the next page. [REQ-OPERATOR-091](../../sdd/spec/operators.md#req-operator-091-protected-raw-logging-transport-and-delivery) <!-- @impl: src/operators/raw-capture-read.ts::readOwnerRawCapturePage --> <!-- @impl: src/operators/raw-capture-storage.ts::discoverRawCaptures -->

Private export returns `application/x-ndjson`: ordered `{type:"record",stage,value}` frames followed by `{type:"complete",receipt}` only after full verification and final authorization. HTTP success or EOF alone does not establish completeness. Missing or corrupt archives fail preflight; interruption or lost authority after streaming begins omits completion and fails the stream. Reads reuse existing encryption and incremental per-batch processing, not whole-archive collection. All responses are non-cacheable. This read grants no execution, renewal, recovery, cancellation or collection authority; bounded public diagnostic exports remain separate. [REQ-OPERATOR-091](../../sdd/spec/operators.md#req-operator-091-protected-raw-logging-transport-and-delivery) <!-- @impl: src/operators/raw-capture-storage.ts::exportRawCapture --> <!-- @impl: src/index.ts::app -->

`GET /api/operator-activities/installations` accepts only one optional `cursor`: an installation ID matching `[A-Za-z0-9_-]{1,128}`. Duplicate/malformed cursors or other query keys return400; missing/unauthorized cursor installations return404. Success is `{ items, cursor }`, with up to five authorized installations per page, ordered by installation ID across operators; `cursor` identifies the last returned installation when more remain. Invocation-only visibility is allowed; management requires eligibility and grants, except platform administrators retain management visibility. Administration does not confer invocation. Responses use `Cache-Control: no-store`. [REQ-OPERATOR-086](../../sdd/spec/operators.md#req-operator-086-dropdown-runs-and-installed-workspace)

Each item contains `id`, `operatorId`, `name`, `installationName`, `revision`, `enabled`, `approved`, nullable `version`, verified `profile` (`conductor` or `dispatcher`), `canInvoke`, `canManage`, advisory `canActivateAutomaticRuns`, nullable `guidedMode`, `repository`, `automaticRuns`, `repetitionIntervalSeconds` and `application`, plus `automaticRunStatus` (`active`, `expired`, `inactive`, or `unconfirmed`). Permission flags are not readiness. Supported scheduling remains inspectable while disabled; manual launch still requires current execution readiness and invocation authority. Unsupported/stale selections do not acquire support from another release. Private configuration, grants and credentials are omitted. Candidate qualification remains pending. <!-- @impl: src/routes/operator-activities.ts::app -->

The Installed profile identifies role help, never name matching. `canActivateAutomaticRuns` indicates current administrator/invocation and supported saved-installation eligibility, not a live session or armed schedule. Explicit activation independently rechecks the current human Access session and exact installation/release pins; it requires no running workspace Host or source-session generation. Listing neither registers nor renews scheduling ([REQ-OPERATOR-226](../../sdd/spec/operators.md#req-operator-226-installed-role-and-activation-projection)). <!-- @impl: src/routes/operator-activities.ts::app -->

`GET /api/operator-activities/installations/:installationId/preview` returns `{ name, description, version, inputSchema, application, requiresSourceHost, guidedAssessment, guidedMode }`. `application` may be null. `guidedAssessment: false` and `guidedMode: null` are compatibility values, not input-support verdicts; use the declared input schema. <!-- @impl: src/routes/operator-activities.ts::guidedPreview --> <!-- @impl: src/routes/operator-activities.ts::app.get('/installations/:installationId/preview', -->

The read requires a current enabled/approved selection and invocation authority, not management visibility alone. A malformed installation ID, unavailable execution selection, or missing invocation grant returns `404`. Malformed pinned manifest content can instead surface as a validation error. Preview never prepares or starts an Activity. [REQ-OPERATOR-209](../../sdd/spec/operators.md#req-operator-209-installed-schema-and-scheduling-safeguards) AC1. [REQ-OPERATOR-086](../../sdd/spec/operators.md#req-operator-086-dropdown-runs-and-installed-workspace) <!-- @impl: src/routes/operator-activities.ts::app.get('/installations/:installationId/preview', --> <!-- @impl: src/operators/distribution.ts::parsePinnedOperatorManifest -->

The mandatory boolean `requiresSourceHost` is `false`; configured Dispatcher preparation neither requires nor binds a source Host or parent-level `sourceSession`. This implements the [Planned session-independent SDK replacement](operators.md#normal-dispatcher-hosting), not a claim of deployed replacement behavior. Qualify exact Root/App artifacts and fresh hosted inference/result/collection separately. [REQ-OPERATOR-058](../../sdd/spec/operators.md#req-operator-058-guided-dispatcher-invocation) <!-- @impl: src/routes/operator-activities.ts::app -->

- `POST /api/operator-activities` accepts bounded JSON `{ operatorId, invocation }`. A `201` response is `{ activityId, startCapability, startExpiresAt }`; activity identity, registration revision, policy, artifact, and authority are server-selected. [REQ-OPERATOR-018](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration)
- `GET /api/operator-activities` returns `{ items }` with at most 100 owner-scoped, secret-free summaries. `?limit=5` returns `{ items, nextCursor, workingCount, unreadCount, latestSequence }` for five entries. [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface)

The display index retains at most 20 browsable rows per operator and 100 per owner. Pass `after=<nextCursor>` for five older rows or omit `after` for the newest entries; an evicted or foreign cursor returns `409 HISTORY_CHANGED`. `workingCount` covers persisted working activities beyond the display index; pending boundary preparations without a persisted summary contribute only while visible. `unreadCount` counts newly admitted summaries since the owner's last acknowledged `latestSequence`, independently of working state. [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface), [REQ-OPERATOR-059](../../sdd/spec/operators.md#req-operator-059-new-activity-observation)

- `POST /api/operator-activities/read` accepts `{ through: latestSequence }` under owner authentication and CSRF; success returns `200 { unreadCount }`. [REQ-OPERATOR-059](../../sdd/spec/operators.md#req-operator-059-new-activity-observation)

Opening the dropdown acknowledges only admissions through that observed sequence; newer admissions remain unread. This never collects results or changes execution. [REQ-OPERATOR-059](../../sdd/spec/operators.md#req-operator-059-new-activity-observation)
- `GET /api/operator-activities/:activityId` returns bounded execution, cleanup, collection, checkpoint, and result state without credentials. [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface), [REQ-OPERATOR-057](../../sdd/spec/operators.md#req-operator-057-readable-owned-activity-results)
- `POST /api/operator-activities/:activityId/start` accepts `{ capability }`. One winning admission returns the queued outcome and schedules one request-attached drive; rejected or repeated starts return `409` with the durable reason and schedule nothing. [REQ-OPERATOR-016](../../sdd/spec/operators.md#req-operator-016-durable-activity-admission-and-cleanup), [REQ-OPERATOR-018](../../sdd/spec/operators.md#req-operator-018-request-attached-operator-orchestration)
- `POST /api/operator-activities/:activityId/continue` accepts no body. For exact owner-scoped durable `waiting` work with a checkpoint, it returns `202 { ok: true, phase: "queued" }` and schedules one generation-fenced request-attached drive. Other states return `409 CONTINUATION_NOT_READY`. [REQ-OPERATOR-017](../../sdd/spec/operators.md#req-operator-017-durable-drive-generations), [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface)
- `POST /api/operator-activities/:activityId/cancel` returns current bounded detail after fencing. Rejection returns `409` with the durable reason; success does not claim that compute cleanup has completed. [REQ-OPERATOR-016](../../sdd/spec/operators.md#req-operator-016-durable-activity-admission-and-cleanup), [REQ-OPERATOR-027](../../sdd/spec/operators.md#req-operator-027-owned-activity-user-surface)
- `GET /api/operator-activities/:activityId/result` returns bounded detail and optional retired Dispatcher receipts without invoking the explicit collection action. Plain detail does not include this wire. [REQ-OPERATOR-041](../../sdd/spec/operators.md#req-operator-041-retired-protected-write-receipt-reads) owns the retired receipts.

Both ordinary owner reads can schedule cold recovery of the original lease; this is distinct from the direct response and from passive diagnostics. [REQ-OPERATOR-227](../../sdd/spec/operators.md#req-operator-227-owned-activity-detail-and-result-reads) owns those GET paths.
- `POST /api/operator-activities/:activityId/result` marks a completed or failed browser result collected. Other drive states return `409 RESULT_NOT_READY`. The route checks owner scope before calling the collector. <!-- @impl: src/routes/operator-activities.ts::app.post('/:activityId/result', --> <!-- @impl: src/operators/activity.ts::collectBrowserResult -->

Recovery of the original lease may send its first keyed SDK dispatch, resume a pending phase of the same application, or commit verified completion through automatic collection. See [REQ-OPERATOR-106](../../sdd/spec/operators.md#req-operator-106-dispatcher-observation-recovery) and [REQ-OPERATOR-098](../../sdd/spec/operators.md#req-operator-098-automatic-owned-dispatcher-result-collection).

#### Dispatcher lifecycle diagnostics

`GET /api/operator-activities/:activityId/diagnostics` accepts no query parameters or SQL. It returns `version: 1`, `activityId`, `capturedAt`, `consistency`, `parent` and `sdk`, with `Cache-Control: no-store`. Other-owner/absent IDs remain404; an owned request with selection parameters returns400. The server method is `OperatorActivity.getDispatcherDiagnostics(ownerKey)`.

`parent` reports stored admission/drive/lease status, original generation and deadline, phase index, receipt and result/checkpoint presence, journal counters, and opaque submission/delivery digests.

`parent.operations` scans at most1,024 stored logical-operation entries and returns at most8 records, ordered by highest stored logical `ordinal` within that scan; missing ordinals sort last. `selection: "highest-logical-ordinals"` is not latest-retry ordering. Records are grouped under the stored journal generation and contain operation/request/response digests, status, optional `binding` with hashed submission/delivery identities and closed phase/resource labels, and the separately named current retained `hostInference` index, charged ordinal, status, classification and response digest. Binding `scope` is `requested` for the stored lease submission or `other` for another submission; a null binding or host attempt means unavailable association or metadata, not proof of absence. A phase binding supplies no SDK attempt ID.

`status` and a closed unavailable `reason` qualify the operation read. `scan` is `complete`, `bounded` or `unavailable`; completeness comes from exhausting enumeration, not `journal.count`, which also charges inference retries. `omittedEntries` is true when the scan cap or eight-record selection omits history. No response cache is read or stored body inspected or exported. Bound original parent metadata remains readable when SDK work is retired; legacy journals are never migrated by this endpoint.

`sdk.status` is `available` or `unavailable` with a closed reason. For compatible historical SDK storage, available data contains bound submission/attempt and settlement metadata, stream counters, and at most32 newest canonical batch metadata rows and64 selected lifecycle records. `canonical.scope: "latest-instance-batches"` denotes an instance-wide tail. Record `scope` values `requested`, `other` and `unassociated` classify submission attribution, not the current attempt; match submission/attempt digests before attributing records to the current phase. Content deltas, private tool/state/output bodies, raw errors and identifiers are excluded. `nameDigest`, `toolCallDigest` and other correlations are SHA-256 of the exact UTF-8 metadata string, not readable private values.

Normal stock-SDK admissions additionally support `sdk.public` with `format: "flue-public-v3"`: original receipt digests/acceptance time, nullable observed attempt counters, and at most64 retained public observations. This is an additive projection, not fabricated values for the historical `submission`, `stream` or `canonical` fields. Runtime event indices, import sequence, public attempt counts and opaque offset digests remain distinct. Public `turn_messages` witnesses a committed tool batch, not a private canonical sequence or operational-row finalization. Conversation metadata is captured from reads already required by active reconciliation, never fetched to serve diagnostics. `coverage.complete` is false; best-effort capture, logging OFF and omitted/unobserved evidence remain explicit. This retained projection remains readable after retirement.

Legacy diagnostic reads do not call SDK startup, fetch, initialization, recovery, or a custom fixture method. For a compatible, still-bound legacy lease, the reader can obtain the child facet and query its base storage method; this is not the parent-only read used by diagnostics v2. Unsupported SDK tuples are unavailable, not upgraded. An unbound phase or retired facet returns parent metadata without constructing SDK work. The original approved class, artifact, generation and facet key are retained. Receipt instance UID is verified against root birth metadata, not the independently generated stream incarnation; unverifiable identity remains unavailable. Execution authority and result collection are unchanged.

Parent operation enumeration and SDK access share a10-second response-wait deadline; the response is bounded to64KiB. `consistency: "changed-binding"` discards operation records and SDK data when parent state changes during the read. `stable-binding` validates that binding, not cross-object atomicity, RPC cancellation, child receipt or SDK persistence. `olderBatchesOmitted`, `recordLimitReached`, non-inline batches and `inlineMetadataComplete: false` mark incomplete evidence. Missing records in a bounded tail do not prove a tool, finish or output was never produced. Use this interface for compatible Dispatcher workloads; it is not tied to a Renovate repository or a replacement execution. See [REQ-OPERATOR-080](../../sdd/spec/operators.md#req-operator-080-owned-dispatcher-lifecycle-readback).

#### Retained causal diagnostics version2 <!-- @impl: src/routes/operator-activities.ts::handleDiagnosticsV2 --> <!-- @impl: src/operators/dispatcher-diagnostics-read.ts::readActivityDiagnostics -->

This additive contract is under implementation and awaits exact-source CI and hosted qualification; it is not evidence of a deployed version2 rollout. Version1's historical fields above remain unchanged; the public projection is additive. The owning contract is [REQ-OPERATOR-081](../../sdd/spec/operators.md#req-operator-081-retained-dispatcher-causal-evidence); see [retention and interpretation](operators.md#retained-dispatcher-causal-evidence).

All four version2 routes return `Cache-Control: no-store`, including errors, and require the same verified human and exact owner checks. Only history/export accept one optional `cursor`; summary/detail reject selectors. Missing/other-owner IDs remain404 before selector errors. Invalid selectors/cursors return400, changed original binding or expired retention epoch409, and unavailable reads/sealing503. Existing `ENCRYPTION_KEY` seals cursors with owner/Activity AAD; absent/invalid keys fail closed without a plaintext fallback, new secret or GET write. No SQL, caller-selected tables, body selectors or executable probes are accepted. See [route validation](../../src/routes/operator-activities.ts) and [cursor sealing](../../src/operators/dispatcher-diagnostics-read.ts).

Common response metadata includes `version:2`, Activity/read time, current original-lease generation/artifact/input binding, `highWater`, `health`, `retention` and `consistency:'stable-binding'`. `highWater.operations` is the original generation's persisted next logical ordinal, not its charged operation count. Authorized continuation under the same admitted artifact/input retains prior-generation records, advances this snapshot binding/epoch and invalidates old cursors; each retained record and capsule keeps its actual original generation. See [continuation initialization](../../src/operators/dispatcher-diagnostics-store.ts). <!-- @impl: src/operators/dispatcher-diagnostics-store.ts::initializeDiagnostics -->

Summary additionally exposes `capture`, nullable source provenance, per-boundary capabilities, the actual retained SDK binding, essential `fence` and `diagnosis`. Diagnostic fence generation identifies the original fenced generation, not the separately incremented authoritative drive generation. Diagnosis distinguishes observed, recovered and uncaptured failures; `nextCheck` is an evidence suggestion, never execution permission. Optional `health.sdkImportReason:'retirement-tail-unwitnessed'` explains a pending SDK import tail when the last observed watermark is persisted but later child cleanup capture is unwitnessed, not an observed dropped-record count. See [summary and import-health projection](../../src/operators/dispatcher-diagnostics-read.ts).

History returns `records`, `nextCursor`, `pageStatus`, `retainedStatus` and `sourceOrder:'diagnostic-sequence-then-operation-storage-key'`. Host persistence sequence and legacy operation storage order are explicit segments, not a fabricated cross-object chronology or global logical-ordinal order. Operation records use `o-<generation>-<operationDigest>` identities so repeated keys across continuations remain distinct, preserving the separately named `operationDigest`, logical ordinal, host attempt and available SDK correlations. A missing association remains unavailable, not zero or a guessed attempt. See [operation projection](../../src/operators/activity.ts) and [history ordering](../../src/operators/dispatcher-diagnostics-read.ts).

Each request shares a ten-second wait and returns at most32 metadata records and65536 serialized UTF-8 bytes, stopping earlier on bytes. A cursor is authenticated and encrypted, fixes owner/Activity/original generation/artifact/input/index/high-water/retention epoch and position, and exposes no reversible private storage identity; later events cannot silently join that snapshot. Legacy aggregate keys form a separate immutable cursor segment; migration/removal invalidates its cursor with409, rather than deriving an ordinal bound from aggregate cardinality or the keyed journal.

Follow every returned cursor to exhaust retained metadata. `pageStatus:'complete'` does not erase `retainedStatus:'loss'`, missing legacy capture or SDK import gaps. Export adds deterministic `snapshotDigest` and `partDigest`; one part is not a whole export. The browser [download](../../web-ui/src/components/OperatorActivityDiagnostics.tsx) combines validated parts, retaining loss and record-level metadata but not the summary-only capability manifest or source provenance. See [REQ-OPERATOR-083](../../sdd/spec/operators.md#req-operator-083-retained-diagnostic-readback) AC7. <!-- @impl: web-ui/src/components/OperatorActivityDiagnostics.tsx::exportMetadata --> Each byte-limited page makes progress for every valid retained record; see [paging and export](../../src/operators/dispatcher-diagnostics-read.ts).

Parent operation metadata additionally exposes `operationKind` (`sdk-model-http`, `host-inference`, `source-read`, `source-mutation`, `unknown`), nullable `sdkHttp:{state,attempts}` and nullable `terminalOutcome:'not-sent'`. SDK HTTP states are `ready`, `sending`, `completed`, `unknown` and `not-sent`; attempts counts claims (zero or one), not confirmed vendor deliveries. These validated parent-journal fields do not require phase association, an SDK attempt record or SDK diagnostic provenance. Existing current records can expose their retained kind/state without rewriting them. Missing/malformed/conflicting evidence stays unknown. Request bodies/URLs, owner scope, selection, permit IDs and delivery tokens are never exported. A not-sent terminal record retains its charged ordinal/count and has no fabricated response digest or receipt. <!-- @impl: src/operators/dispatcher-runtime-diagnostics.ts::projectDispatcherOperationEvidence -->

A Root-observed `journal-unaccounted` failure keeps the completed final assessment distinct from refused collection. Optional `error.journal` (also projected as `diagnosis.journal`) contains a closed gate (`final-binding`, `operation-binding`, `terminal-binding`, `disposition-coverage`, `read-coverage`, `mutation-kind`, `mutation-coverage`, `unresolved-count`), optional offending `operationDigest`, `unresolved`, `inspectedUnresolved`, observed `phase` and nullable `phaseIndex`. Counts describe the journal and traversal up to refusal, not a new full audit. The failure's correlation retains the observed original submission/root/delivery digests, and its capsule links the offending operation when known; capsule settlement remains unknown. This is Root evidence, not SDK-origin failure or performed-write proof. Child envelopes cannot assert it. Logging OFF still preserves the essential closed fence but suppresses optional detail. Source revision/SDK provenance stay unavailable unless verified; no revision is inferred from the observer's checkout. <!-- @impl: src/operators/activity.ts::OperatorActivity --> <!-- @impl: src/operators/dispatcher-diagnostics-wire.ts::journalFailureSchema -->

Detail addresses only closed event or generation-qualified operation identities returned by the API, with their available bounded capsule. Error values contain closed kinds/codes, bounded fingerprints and loss flags, not arbitrary exception text. Optional `error.transportStatus` is an integer300–599; `error.transportReason` and `error.transportDisposition` use the [closed protected-refusal vocabulary](operators.md#closed-protected-refusals). Validated producer reports carry those same names as flat fields; retained owner history/detail/export preserve them through reconstruction without creating a new stream or API version. Transport-only evidence uses kind `other`; absent fingerprints remain unavailable. <!-- @impl: src/operators/dispatcher-diagnostics-wire.ts::captureError -->

Optional parent-observed `error.admissionType` is limited to the pinned SDK public type allowlist; arbitrary error messages/details/meta and unknown types are omitted. It is evidence, not retry authority. <!-- @impl: src/operators/dispatcher-diagnostics-wire.ts::captureError -->

Missing metadata is an evidence gap, not effect proof, retry permission or permanent revocation; logging OFF suppresses optional detail. Source links require verified public immutable mappings; patch-boundary mappings are labelled separately from originating stack frames. Prompts, response/cache bodies, tool/state/output bodies, private SDK identities, credentials and signed URLs are excluded. These GETs never initialize/recover a child, migrate a journal, refresh authority, collect results or retry effects. See [detail projection](../../src/operators/dispatcher-diagnostics-read.ts), [source mapping validation](../../src/operators/dispatcher-diagnostics-wire.ts) and the [immutable SDK source/provenance ownership boundary](operators.md#source-owned-sdk-observations).

#### Retired Dispatcher receipt pages

An exactly bound immediately retired intent4 lease can expose `effectReceipts` with `version: 1` on result GET. Each request scans at most 1,024 stored metadata entries and selects at most eight candidate response bodies. `scan` describes complete, partial or unavailable enumeration; individual `binding` values separately identify verified or unresolved evidence. Complete enumeration is not proof that every effect is verified.

For another ascending page, pass the returned `nextAfterOrdinal` as one canonical nonnegative safe-integer `receiptAfter`. Malformed, duplicate, nonexistent or unavailable cursors return `400` after existing authentication and ownership checks; an other-owner Activity remains `404`. Plain detail and POST collection retain their existing contracts. These reads add no execution or collection authority. See [REQ-OPERATOR-041](../../sdd/spec/operators.md#req-operator-041-retired-protected-write-receipt-reads) and [retained evidence limitations](operators.md#owner-scoped-activity-surface) for original bindings, privacy and missing-history caveats.

<a id="legacy-renovate-route-compatibility"></a>
#### Schedule activation and publication compatibility

`POST /api/operator-activities/automatic/activation` accepts a strict JSON object with exactly these required fields: <!-- @impl: src/routes/operator-activities.ts::applicationActivationBody -->

- `installationId`: a JSON string matching `^[A-Za-z0-9_-]{1,128}$` (1–128 ASCII letters, digits, underscores or hyphens).
- `revision`: a JSON number that is a positive safe integer (`1` through `9007199254740991`), matching the current saved installation revision; a numeric string is not accepted.

Use the deployment's normal Access sign-in and existing same-origin browser API transport. The [browser client](../../web-ui/src/api/operator-activities.ts) (`activateApplicationRuns`) uses `credentials: 'same-origin'`; its [transport](../../web-ui/src/api/fetch-helper.ts) sends `Content-Type: application/json` and `X-Requested-With: XMLHttpRequest`. This route requires that exact CSRF header value; it is a fixed transport marker, not a token to acquire. It does not authenticate or authorize the caller. The server requires current verified human Access authentication and a matching authenticated administrator identity; an email header alone is insufficient. Do not spoof identity/role headers or put credentials in the JSON body. Authentication and sign-in ownership remain with [Identity & Access](authentication.md#human-access-claims-for-the-operator-interface) and [the authentication source](../../src/lib/access.ts) (`requireOperatorHumanContext`, `authenticateRequest`, `operatorAccessSessionCurrent`), not a standalone curl credential recipe. <!-- @impl: src/routes/operator-activities.ts::requireMutationCsrf --> <!-- @impl: src/lib/access.ts::requireOperatorHumanContext --> <!-- @impl: web-ui/src/api/operator-activities.ts::activateApplicationRuns -->

Saving configuration, approving the pinned release, enabling the installation and explicitly activating its schedule are separate gates. Activation requires the current enabled/approved execution selection, the exact installation revision, an invoker grant and a declared schedule resolving to enabled automatic runs with a valid interval. Administrator or manager status does not confer invocation. The activation POST itself is explicit scheduling consent: the [handler](../../src/routes/operator-activities.ts) re-verifies current Access identity/session, derives delegation from the observed routing groups and passes that authority to the Registry. The [schedule owner](../../src/operators/application-schedule.ts) captures it in a protected execution context for the original human credential lifetime. No separate consent API or caller-supplied delegation is required; saved configuration alone never arms the timer. <!-- @impl: src/operators/application-schedule.ts::activateApplicationSchedule -->

Successful registration returns HTTP `202` with `{activatedAt}`, where `activatedAt` is a JSON string containing the UTC ISO 8601 timestamp produced by `Date.toISOString()`. Registration does not execute application work or prove that a timer fired, an Activity completed or a result was collected. Source implementation is not deployed or hosted acceptance evidence. The former `/renovate/activation` route is not registered.

The retained `/:activityId/publish` route accepts `{sessionId, sessionGeneration}` and validates owner, administrator and request before returning `409 {ok:false, reason:"application-owned"}`. [Publication policy and procedures](https://github.com/nikolanovoselec/codeflare-operator-dispatcher/blob/develop/sdd/spec/renovate.md#req-operator-060-fenced-renovate-publication) belong to Dispatcher; this route grants no publication authority. Original records and fences are retained.

<a id="application-workflow-control"></a>
#### Application workflow control (integration contract; not a live-availability claim)

[REQ-OPERATOR-048](../../sdd/spec/operators.md#req-operator-048-dispatcher-execution), [REQ-OPERATOR-061](../../sdd/spec/operators.md#req-operator-061-authorized-application-triggers-and-coordination) and [REQ-OPERATOR-062](../../sdd/spec/operators.md#req-operator-062-repository-only-dispatcher-transport). <!-- @impl: src/operators/activity.ts::#planApplication --> <!-- @impl: src/operators/activity.ts::#applicationCallback --> <!-- @impl: src/operators/registry.ts::applyApplicationState --> <!-- @impl: src/operators/registry.ts::applyApplicationExecution -->

Approved packages may declare `manifest.application = { controlVersion: 1, configurationSchema?, githubWriteRepositoriesPath?, schedule?: { enabledPath, intervalSecondsPath }, recovery?: { label, description, prefix } }`. The schedule and write-repository fields are configuration pointers. The write selector must resolve a repository name or array; omitting it denies GitHub mutations. Root renders existing simple fields and enforces generic shape/bounds; the application interprets domain configuration. Manual and timer intake pass the same immutable configuration/input. Save/enable/activation and human authority remain separate gates. <!-- @impl: src/operators/application-configuration.ts::applicationSetting --> <!-- @impl: src/operators/application-configuration.ts::applicationSchedule --> <!-- @impl: src/operators/application-schedule.ts::activateApplicationSchedule --> <!-- @test: src/__tests__/operators/application-schedule.test.ts (configured defaults alone never arm a timer; OFF still permits the same manual prepare/start/run) -->

Installation-authenticated normal `POST /control/plan` receives the original run/deployment identity, immutable `initialData`, nullable opaque `checkpoint`, delivery `{token, ordinal}`, and optional exact confirmed settlement:

```ts
// Successful SDK settlement: unchanged public reply, including coalesced data.
{ receipt, reply }
// Failed SDK settlement: actual named data for this submission only.
{ status: 'failed', receipt, data: Record<string, JsonValue[]> }
```

`receipt` retains `{submissionId, uid, acceptedAt, deduplicated?: true}`. Root accepts failure evidence only from the exact current installation-authenticated `/control/read` response `{status:'failed', receipt, submissionId, data}`. The SDK observer verifies the same UID and terminal `failed` history, then projects only messages for that submission; no unrelated or coalesced reply fallback supplies failed data. A verified empty projection may be `{}`; failed or missing history is unavailable, not empty. <!-- @impl: src/operators/activity.ts::#reconcileNormalDispatcher --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (confirmed failure can continue to later work and a truthful final result without changing authority) --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (%s cannot release the next application decision or collect a final result) -->

The current decision wire is one of:

```ts
{ kind: 'dispatch', checkpoint, message, context }
{ kind: 'complete', checkpoint, result }
```

`message` is a normal SDK user/signal message; `context`, `checkpoint` and `result` are bounded JSON. Root persists original key/payload before dispatch and the current confirmed settlement before subsequent planner I/O. Lost planner responses reuse that bounded settlement rather than rereading or replacing the SDK outcome; committing the next decision consumes it. Root checks the exact SDK receipt/settlement independently. Pending, aborted, unavailable or mismatched proof cannot advance planning. Original authority, native-login, generation, deadline and unresolved-journal fences remain mandatory. Pending planning denies protected source/model calls; state/CAS remains available. The callback cannot mint receipts, renew deadlines or dispatch a second runtime. <!-- @impl: src/operators/activity.ts::#planApplication --> <!-- @impl: src/operators/activity.ts::#phaseTokenMatches --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (uncertain admission replays exactly the saved key/input/configuration after cold reconstruction) -->

After any SDK work, `complete` requires the successful final settlement; a confirmed failure can inform another dispatch but cannot certify final completion. An initial Root-committed no-work completion is separately allowed, with no SDK submission or receipt. Both paths retain validated output and original journal/authority fences; application result validation never replaces Root authorization. <!-- @impl: src/operators/activity.ts::#planApplication --> <!-- @impl: src/operators/activity.ts::commitDrive --> <!-- @impl: src/operators/activity.ts::#normalSettlementObserved --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (failed SDK work cannot certify final completion even after reconstruction, cold=%s) --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts ($trigger automaticRuns=$automaticRuns held=$held preserves the original target and decision) -->

The existing admitted `assessmentBytes` allowance bounds each opaque checkpoint and result independently through decision validation and commit/collection. For application commits, the existing 64 KiB drive envelope excludes checkpoint/result values; it must not silently impose that smaller limit on either. Dispatch message/context and total decision bounds remain enforced by the existing parser. No new limit or configuration is introduced. <!-- @impl: src/operators/application-workflow.ts::parseApplicationDecision --> <!-- @impl: src/operators/activity.ts::commitDrive --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (collects an admitted checkpoint above64KiB within its allowance, cold=%s) --> <!-- @test: src/__tests__/operators/application-workflow.test.ts (rejects a decision that exceeds its actual admitted capacity) -->

Through the existing authenticated `OPERATOR` callback, `POST /v1/dispatcher/state` accepts:

```ts
{ operation: 'read', keys: string[] }
{ operation: 'compare-exchange', expected: [{key, version: string | null}], writes: [{key, value, coordination?}] }
```

Read returns `{entries}` containing `{key,status:'absent',version:null}`, owner-private `{key,status:'value',version,value}`, same-scope `{key,status:'coordination',version,coordination}`, `{key,status:'vacant',version}` after a verified release, or `{key,status:'conflict'}` without private payload. Optional `coordination` is explicitly nonprivate application JSON; Root stamps its approved operator/work-repository scope. Applications without that projection remain private.

A vacancy retains its non-null CAS version and discloses no prior private value; consuming it stamps the fresh authorized claimant. Compare/exchange returns `{status:'committed'|'conflict'}`; version mismatch commits no writes. Keys/values are bounded opaque application data, not arbitrary Registry paths. Root derives source/application scope, owner, installation, live Activity/generation and original deadline; current grants and release/configuration revisions remain mandatory. Trusted legacy mapping preserves original records and cross-registration collisions, never caller-selected namespaces or safety flags. Unknown/malformed state fails closed. <!-- @impl: src/operators/activity.ts::#applicationCallback --> <!-- @impl: src/operators/registry.ts::applyApplicationState --> <!-- @impl: src/operators/application-state.ts::ApplicationStateStore --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (checks every expected version before committing any member of a multi-key exchange) --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (foreign %s receives neither private values nor replacement ownership) --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (legacy %s remains held across passive reads, failed reset and reconstruction) -->

`POST /v1/dispatcher/context` returns `{context, delivery, receipt}` for the current admitted delivery only; a pending plan has no execution context authority. `POST /v1/dispatcher/execution` accepts `{operation:'read'|'read-delivery'|'retire', key, version, activityId}` tied to an owned state entry and the original execution. A read returns `{status:'value', activityId, terminal}` (original verified settlement/collection facts, or `terminal:null` only for proven never-started work), or `conflict`/`unavailable`. Retirement returns `{status:'retired'|'held'|'conflict'|'unavailable', activityId}`. Only original non-admission/atomic retirement evidence permits retirement; no missing lease or arbitrary application-supplied ID does. These operations neither open an old SDK job nor decide application retry policy. <!-- @impl: src/operators/activity.ts::#applicationCallback --> <!-- @impl: src/operators/registry.ts::applyApplicationExecution --> <!-- @impl: src/operators/activity.ts::readApplicationExecutionFacts --> <!-- @impl: src/operators/activity.ts::retireApplicationExecution --> <!-- @test: src/__tests__/operators/application-execution.test.ts (returns opaque original result/checkpoint only with exact collection and settlement, without retiring or driving) --> <!-- @test: src/__tests__/operators/application-execution.test.ts (%s between read and retirement cannot consume a stale internal proof) -->

`read-coordination` and `release-coordination` use only `{key,version}`. Root selects the original internally and returns safe processing facts or a functional hold, never historical identities or private results. Release rechecks authority, original proof and version before creating a verified vacancy. Fenced no-write evidence for an unknown historical attempt requires explicit authorized recovery; it is not automatic failed-settlement proof. Recognized legacy aliases expose only a mechanical nonprivate target projection; the package retains all processing and retry interpretation.

`read-delivery` selects the original submission from Root-stamped claim metadata, not application JSON or a caller-supplied safety flag. The first trusted delivery stays pinned across updates by the same owner/installation/Activity/generation; a new attempt uses its own Root binding rather than inheriting historical origin. Matching retained proof returns `{status:'delivery', activityId, generation, releaseDigest, inputDigest, terminalAt, sdkSubmissionId, settled:true, fenced:true, noExternalWrites, outcome:'completed'|'failed'}`. Root retains this compact proof before planner I/O; it does not require unrelated later completion or collection. Unlike ordinary historical `read`, `read-delivery` does not enter the historical archival path. Missing, malformed or mismatched proof is unavailable, never fabricated settlement or permission to retry effects. See [REQ-OPERATOR-211](../../sdd/spec/operators.md#req-operator-211-original-delivery-evidence). <!-- @impl: src/operators/activity.ts::readApplicationExecutionFacts --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (REQ-OPERATOR-048: a failed delivery retains original proof before planner I/O, sourceWrite=%s) -->

Authorized shared-coordination recovery uses the existing browser-management authentication and CSRF boundary. `POST /api/operator-management/installations/:installationId/recovery/preview` takes `{revision, after?}` and returns `{items, nextCursor, scopeCursor?}`; each item has `{key, version, label, status:'resettable'|'blocked', reason}`. Follow opaque cursors to completion before resetting; scope discovery also advances through bounded pages. Retain the returned `scopeCursor` unchanged. `POST` to the same installation's `/recovery/reset` takes `{revision, requestId, entries:[{key,version}], scopeCursor?}` with a UUID request ID and at most 64 entries. It returns `{requestId, reset, skipped:[{key,reason}]}`. Repeat an uncertain request with its exact original body and ID, never a fresh ID. <!-- @impl: src/routes/operator-management.ts::recoverInstallation --> <!-- @impl: src/operators/registry.ts::recoverApplication -->

Recovery requires package metadata, current management authority, matching application/work-repository scope, version-matched state and closed, fully accounted no-write execution. Root verifies the original stored identity internally; the requester need not be that actor. Original records, private history and admission/effect evidence remain retained. A Root-verified vacancy preserves original and requester provenance through successor updates; package-written reset values alone grant no replacement. <!-- @impl: src/operators/activity.ts::readRecoveryFacts --> <!-- @impl: src/operators/registry.ts::recoverApplication --> <!-- @impl: src/operators/application-state.ts::verifyApplicationStateRecovery --> <!-- @impl: src/operators/application-state.ts::ApplicationStateStore -->

A missing SDK receipt is neither non-admission proof nor an automatic refusal of otherwise qualified recovery. The installation-authenticated `/control/recovery` callback supplies package-owned scope and proposals only. Root validates and commits them; no recovery call starts an SDK job, schedules work, or changes configuration. Installation, scope and request conflicts return `409`; individual changed records appear in `skipped` within a successful, possibly partial response. Denied authority is non-disclosing `404`, and unavailable recovery services return `503`. See [REQ-OPERATOR-210](../../sdd/spec/operators.md#req-operator-210-owner-authorized-application-state-recovery); hosted acceptance remains separate. <!-- @impl: src/operators/application-recovery.ts::callApplicationRecovery --> <!-- @impl: src/operators/registry.ts::recoverApplication --> <!-- @impl: src/routes/operator-management.ts::recoverInstallation -->

Historical execution inspection reads native KV full values sequentially (`limit: 1`, using the documented `noCache` hint), without a total-record/history cutoff or a new index. When capture is authorized, complete originals are flushed to the encrypted archive before the next value; only proof metadata is retained for execution decisions. This does not replace stored payloads with digests or truncate raw diagnostics. Other existing 128-entry metadata scans are unchanged. <!-- @impl: src/operators/activity.ts::#applicationExecutionSnapshot --> <!-- @test: src/__tests__/operators/application-execution.test.ts (retains complete supported large responses without exceeding the source live-payload allowance) --> <!-- @test: src/__tests__/operators/application-execution.test.ts (persists each large history page before reading the next and reconstructs every original record) -->

Original admission and current observation policy independently govern historical capture; current logging cannot enable or copy an original OFF/unknown-policy record. Interrupted/unprovable capture remains incomplete, never evidence of absence or safe replay. Complete encrypted DO persistence and independently reconstructed readback remain required under [REQ-OPERATOR-090](../../sdd/spec/operators.md#req-operator-090-protected-raw-execution-logs) and [REQ-OPERATOR-091](../../sdd/spec/operators.md#req-operator-091-protected-raw-logging-transport-and-delivery), for manual and automatic intake. <!-- @impl: src/operators/activity.ts::#applicationExecutionCapture --> <!-- @impl: src/operators/activity.ts::#correlateApplicationCapture --> <!-- @test: src/__tests__/operators/application-execution.test.ts (original=%s current=%s captures only proven ON history) --> <!-- @test: src/__tests__/operators/dispatcher-application-ownership.test.ts (original=%s current=%s does not copy historical responses into the current archive) -->

These application callbacks are not owner diagnostic APIs. Existing passive v2 reads/export provide bounded metadata; the separately authorized private raw archive provides complete captured originals. Neither surface grants replay or execution authority. Source implementation, generated package CI, compatible Root delivery and hosted acceptance are distinct pending gates.

<a id="protected-action-discovery"></a>
### Protected Action discovery [REQ-OPERATOR-215](../../sdd/spec/operators.md#req-operator-215-protected-action-discovery) <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: src/operators/review-boundary-claim.ts::discoverVerifiedBoundaryAction -->

`POST /operator-webhook/v1/activities/claims/discovery` is Enterprise-only and uses the same bounded claim JSON and signed protected Action OIDC identity described below. `200` returns a bounded `match` or `no-match` observation; uncertain service/identity observation returns `503 { status: "unavailable" }`. Invalid bodies return `400`, missing/invalid bearer `401`, wrong method `405`, and non-Enterprise `404`. Responses are `no-store`; discovery never consumes the start handoff, returns capabilities or authorizes work.

### Protected Action boundary claim [REQ-OPERATOR-054](../../sdd/spec/operators.md#req-operator-054-protected-action-claim-and-stop-fence) <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: src/operators/review-boundary-claim.ts::claimVerifiedBoundaryAction -->

`POST /operator-webhook/v1/activities/claims/boundary` is Enterprise-only. It requires a signed GitHub `pull_request_target` OIDC bearer for the configured protected workflow and deployment audience, not a browser Access JWT. Its `application/json` body is at most 4096 bytes and contains exactly positive integers `repositoryId`, `pullRequest`, `runId`, `runAttempt` and lowercase 40-character SHA strings `head`, `base`, `mergeBase`; a stalled body is cancelled after two seconds.

On verified current PR/run, human authority and session generation, `200` returns `{ activityId, origin, startCapability, repositoryId, pullRequest, head, base, mergeBase, workflowId, runId, runAttempt, generation, contextDigest }` once; `generation` is the session lifecycle generation, while `contextDigest` is the prepared context digest. Invalid bodies return `400`, absent Action bearer `401`, denied claims `403`, stale/absent handoffs `409`, and uncertain claims `503`; none return the capability. Responses are `no-store`. A lost successful response cannot redeem the consumed handoff again.

<a id="protected-publication-journal"></a>
### Protected publication journal [REQ-OPERATOR-055](../../sdd/spec/operators.md#req-operator-055-pr-wide-publication-ordering) <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: src/operators/review-boundary-claim.ts::operateBoundaryPublication -->

`POST /operator-webhook/v1/activities/claims/publication` is Enterprise-only. Its signed protected `pull_request_target` OIDC bearer has a deployment-specific audience, distinct from the start-claim audience. Strict JSON (at most 4096 bytes; two-second stalled-body deadline) binds numeric repository/PR/workflow/run/attempt, exact head/base/merge-base, activity and session/terminal-drive generations, context and effect digests, one `artifact|comment|check` effect, and `begin|read|complete`. Only `complete` accepts a positive numeric `externalId`.

The parent rechecks protected workflow bytes and current GitHub PR, the consumed run handoff, and non-driving collected terminal Activity metadata before the Registry records an effect. `200` returns `new` once, then `pending` until a trusted publisher-reported numeric external ID is acknowledged; the journal binds only that ID as `published` metadata, not as GitHub provenance. No bearer, browser JWT, GitHub credential or result bytes are returned. Invalid JSON returns `400`, absent OIDC `401`, denied identity `403`, stale/conflicting context `409`, and uncertain I/O `503`; all responses are `no-store`.

A pending receipt never authorizes a blind second write. Execution expiry does not renew a start capability: existing receipts remain reconcilable, but new effects are denied. This journal does not itself prove independent GitHub publication, current check selection or required-check activation.

### Protected publication preparation [REQ-OPERATOR-056](../../sdd/spec/operators.md#req-operator-056-independent-review-publication) <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: src/operators/review-boundary-claim.ts::prepareBoundaryPublication -->

`POST /operator-webhook/v1/activities/claims/publication-preparation` is an existing Enterprise-only read of frozen evidence, not publication or new execution. The signed protected Action OIDC bearer uses this route's own deployment audience and the verified exact reusable-runtime pin. Strict JSON has the same 4096-byte/two-second body bound and exact repository/PR/head/base/merge-base/workflow/run/attempt/activity/session-generation/terminal-generation/context binding as the journal, but supplies `resultDigest` instead of `effect`, `digest`, `operation` or `externalId`.

`200 { status: "ready", projection }` is returned only after current human/installation/claim/PR/session checks and matching collected terminal evidence. The projection contains `schemaVersion`, `admission`, `context`, `contextDigest`, resource and packet descriptors, frozen `initialization`, `packetDigest`, `resultDigest` and `activityGeneration`; the response is bounded to 64 KiB and contains no credential. Absent or changed evidence cannot be substituted by caller labels. Invalid JSON returns `400`, absent/malformed bearer `401`, denied identity `403`, stale context `409`, uncertain I/O `503`, wrong method `405` and non-Enterprise `404`; all responses are `no-store`.

This contract authenticates existing evidence; it does not define Review lanes, report or comment format, finding clearance or check conclusions. Those belong to [Conductor's protected publisher](https://github.com/nikolanovoselec/codeflare-operator-conductor/blob/develop/sdd/spec/conductor.md#req-conductor-005-trusted-boundary-reviews-action-and-publisher). Root's current compatibility publisher and fixed adapters remain implemented here; the docs split does not replace them or prove deployment.

### Webhook activity endpoint details [REQ-OPERATOR-029](../../sdd/spec/operators.md#req-operator-029-capability-authenticated-webhook-edge) <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: src/operators/activity.ts::OperatorActivity -->

For activity-specific webhook operations, only continuation accepts a request body: `Content-Type: application/json` and at most 128 bytes of JSON with exactly one positive integer `generation`; a stalled body is cancelled after two seconds. Start, status and result reject bodies.

These activity-specific operations are throttled to 30 requests/minute per edge key. All webhook operations use `Cache-Control: no-store` and remain within the narrow managed Access bypass. Start success queues one admitted activity and returns its read capability once. Status is non-consuming and returns metadata including generation, never result bytes. Continuation atomically claims only the observed waiting generation and refuses a duplicate or stale generation. Result returns `202` while not ready. The first terminal redemption consumes status/continuation authority before delivery; the same read capability can reread the identical terminal evidence within its original bounded lifetime, without restarting work or renewing authority. <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: src/operators/activity.ts::redeemWebhookResult --> <!-- @impl: src/routes/setup/access.ts::upsertOperatorWebhookBypassAccessApp -->

| Operation outcome | Status | Response envelope |
|---|---:|---|
| Start queued | `200` | `{ "ok": true, "phase": "queued", "readCapability": "<capability>" }` |
| Status available | `200` | `{ "ok": true, "terminal": false, "status": "queued", "generation": 0 }` before the first drive while authority is valid; pre-drive expiry instead reports `status: "expired", terminal: true, generation: 0`. A waiting drive reports its observed generation. Terminal status never includes result bytes |
| Continuation claimed | `200` | `{ "ok": true, "phase": "queued" }`; a stale or already-claimed generation returns `409` |
| Result not ready | `202` | `{ "error": "Webhook capability operation rejected", "code": "WEBHOOK_NOT_READY" }` |

These fixed envelopes are produced by the webhook route from the durable activity result. The adapter fixture asserts start, generation-free status and not-ready result envelopes, no-store and capability nonreflection only. <!-- @test: src/__tests__/routes/operator-webhook.test.ts (routes fixed operations with exact response shapes, no-store and no token reflection) --> The separate continuation fixture asserts its queued envelope, invalid-body rejection and stale-generation 409. <!-- @test: src/__tests__/routes/operator-webhook.test.ts (REQ-OPERATOR-029: continuation wire response acknowledges work without echoing capability or issuing new authority) --> Durable continuation assertions cover waiting generations 1/2, duplicate claims and stale-generation denial. <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-053: webhook continuation is single-use for each durable waiting generation) --> The terminal-outcome fixture covers expired result redemption, not the exact pre-drive status envelope. <!-- @test: src/__tests__/operators/activity-state.test.ts (REQ-OPERATOR-006: returns bounded terminal evidence for %s without rerunning work) --> Exact queued/expired generation-zero status assertions remain missing T08 evidence; neither these fixtures nor source anchors supply deployed acceptance.

Non-enterprise or unknown routes return `404`; an invalid method returns `405`; invalid or unexpected bodies return `400`; throttling returns `429`; and missing or invalid capability returns `401`. Durable capability outcomes map expiry to `410`, consumed/already-started to `409`, missing preparation to `404`, admission or authority denial to `403`, and uncertain/unavailable service to `503`. Static assets run the Worker first for every request, so `/operator-webhook/*` reaches Worker logic before SPA fallback. <!-- @impl: wrangler.toml::run_worker_first = true --> <!-- @impl: src/routes/operator-activities.ts::app --> <!-- @impl: src/routes/operator-webhook.ts::app --> <!-- @impl: src/operators/orchestrator.ts::runOperatorActivity -->

### Installed Dispatcher connection

These enterprise-only management mutations require a current verified human manager and same-origin CSRF protection under [REQ-OPERATOR-045](../../sdd/spec/operators.md#req-operator-045-delegated-management-and-invocation) and [REQ-OPERATOR-046](../../sdd/spec/operators.md#req-operator-046-explicit-release-promotion). [REQ-OPERATOR-225](../../sdd/spec/operators.md#req-operator-225-exact-normal-dispatcher-activation) owns verified activation.

| Method | Path | Auth | Implements | Request | Outcome |
|---|---|---|---|---|---|
| POST | `/api/operator-management/installations/:installationId/dispatcher-connection` | Verified human manager, CSRF | [REQ-OPERATOR-045](../../sdd/spec/operators.md#req-operator-045-delegated-management-and-invocation), [REQ-OPERATOR-046](../../sdd/spec/operators.md#req-operator-046-explicit-release-promotion), [REQ-OPERATOR-225](../../sdd/spec/operators.md#req-operator-225-exact-normal-dispatcher-activation) | `{ revision, connectionSecret, workerName, workerVersionId, releaseId, sourceCommit, compilerCommit, manifestDigest, bundleDigest }` | Saves exact approved release/deployment pins, increments installation and connection revisions, disables starts and invalidates prior deployment verification |
| POST | `/api/operator-management/installations/:installationId/enable` | Verified human manager, CSRF | [REQ-OPERATOR-045](../../sdd/spec/operators.md#req-operator-045-delegated-management-and-invocation), [REQ-OPERATOR-225](../../sdd/spec/operators.md#req-operator-225-exact-normal-dispatcher-activation), [REQ-OPERATOR-107](../../sdd/spec/operators.md#req-operator-107-obsolete-dispatcher-deployment-retirement) | `{ revision, enabled: true }`, using the current installation revision | Verifies/provisions and selects the approved normal deployment, enables it, then cleans proven-owned obsolete infrastructure; matching connections are verified/reused. Incomplete cleanup is reported without disabling the replacement |

The normal UI contract is **Install selected version → Enable**. Promotion stays disabled. The authorized Enable operation uses exact acquired modules, the deployment's existing protected Cloudflare account authority and fixed parent service identity; it generates an installation-only connection secret and selects a uniquely named shared deployment using the existing Registry revision fence. It creates no execution admission and changes no saved provider/configuration/policy. Caller-supplied account, service or control URL is not accepted. Uncertain upload, failed verification, revoked authority or a lost revision race cannot enable work. Qualify obsolete-resource cleanup independently; it does not establish SDK inference, settlement or application-processing acceptance.

After verified enablement, cleanup identifies obsolete Workers through platform installation/parent bindings, fences their original admissions and deletes their Worker/SDK namespaces without force. The selected Worker is excluded by name, even after same-name rotation. Root history, receipts, results, journals and uncertain-write holds remain unchanged. Incomplete cleanup is reported while the replacement stays enabled; re-read the current installation before retrying authorized Enable, which reuses the replacement. Deletion does not certify SDK settlement or permit replay. See [REQ-OPERATOR-107](../../sdd/spec/operators.md#req-operator-107-exact-normal-dispatcher-activation).

The separate `dispatcher-connection` mutation remains an advanced explicit handoff, not a prerequisite for normal UI activation. `connectionSecret` is write-only and encrypted at rest; ordinary projections never return its plaintext or ciphertext. Re-read after a conflict instead of resending a stale revision. Actual deployment commands and secret values belong in the private operator runbook. <!-- @impl: src/routes/operator-management.ts::app --> <!-- @impl: src/operators/registry.ts::configureManagementDispatcherConnection --> <!-- @impl: src/operators/dispatcher-deployment.ts::verifyDispatcherDeployment -->

### Protected Review workflow enrollment

Both requests are Enterprise-only and require a verified platform administrator, CSRF protection and the existing GitHub workflow authority. <!-- @impl: src/routes/operator-management.ts::enrollmentContext --> [Enterprise and mutation middleware](../../src/routes/operator-management.ts#L101-L123). <!-- @impl: src/routes/operator-management.ts::requireMutationCsrf --> <!-- @impl: src/operators/boundary-action-installation.ts::context -->

They accept a strict JSON object with `repositoryUrl`, `protectedRef` (`refs/heads/main`, `refs/heads/develop` or `refs/heads/master`) and `installationId`. See [Dormant Review enrollment](deployment.md#dormant-review-enrollment) for operator steps. <!-- @impl: src/routes/operator-management.ts::boundaryEnrollmentBody -->

| Method | Path | Auth | Implements | Description |
|---|---|---|---|---|
| POST | `/api/operator-management/boundary-actions/propose` | Platform admin, CSRF | [REQ-OPERATOR-064](../../sdd/spec/operators.md#req-operator-064-protected-workflow-enrollment-and-discovery) AC1/AC5 | Return `202 { status: "pending", pullRequest }` for the ordinary proposal PR. No protected-base write or activation. <!-- @impl: src/operators/boundary-action-installation.ts::proposeBoundaryWorkflow --> <!-- @impl: src/routes/operator-management.ts::app.post('/boundary-actions/propose', --> |
| POST | `/api/operator-management/boundary-actions/verify` | Platform admin, CSRF | [REQ-OPERATOR-064](../../sdd/spec/operators.md#req-operator-064-protected-workflow-enrollment-and-discovery) AC2–AC4 | Return `200 { status: "installed", enabled: false, workflowId }` only after matching the protected-base workflow and maintained runtime. No start authority. <!-- @impl: src/operators/boundary-action-installation.ts::verifyBoundaryWorkflow --> <!-- @impl: src/routes/operator-management.ts::app.post('/boundary-actions/verify', --> |

## Internal Review enrollment

This fixed outbound Worker lookup serves ordinary Enterprise sessions under [REQ-OPERATOR-053](../../sdd/spec/operators.md#req-operator-053-enterprise-pr-boundary-review-handoff). It is not a public HTTP route or an Operator execution grant. Owner identity comes from parent-bound bucket, session and user properties, never the request body. The owner and session generation are checked before and after enrollment lookup; no Activity, Conductor or native-provider grant is required. <!-- @impl: src/operators/dispatcher-owner-inference.ts::OperatorOwnerInferenceAuthority -->

| Method | Fixed URL | Request | Response |
|---|---|---|---|
| POST | `https://operator.internal/v1/review/applicability` | Exactly `{ "repository": "owner/repo" }`; no query or fragment; UTF-8 JSON bounded to 4096 bytes and a five-second body-read budget | `200 { "selection": "local" }`, with `Cache-Control: no-store`; selection is `local`, `remote-candidate` or `unavailable` |

Absent or disabled enrollment, or enrollment only for another known repository, returns `local`. Matching enabled enrollment or an enabled legacy record without repository identity returns `remote-candidate`; this still requires exact-PR trust and authorization. An unreadable or malformed enrollment configuration returns `unavailable`. Invalid input, missing ownership or a changed session returns `403 { "error": "Owner inference denied" }`, also with `no-store`. Selection neither launches Review nor clears a boundary. <!-- @impl: src/operators/review-enrollment.ts::selectReviewEnrollment -->

## Internal Operator Host APIs

These routes are private container-host contracts for a restricted operator session; they are not public Worker endpoints. Every request first requires the container Bearer token. The routes exist only when trusted parent startup supplied the matching operator service configuration, use `Cache-Control: no-store`, accept at most 64 KiB of JSON, and are governed by [REQ-OPERATOR-021](../../sdd/spec/operators.md#req-operator-021-structured-owned-pi-conversation) and [REQ-OPERATOR-023](../../sdd/spec/operators.md#req-operator-023-explicit-operator-synchronization). Candidate input cannot choose the activity, Codeflare session, filesystem root, model, tools, bucket, R2 credentials, policy, remote prefix, or authority deadline.

### Configured Dispatcher inference on an ordinary source Host

These two authenticated, `no-store` routes are separate from the restricted conversation/sync APIs below. They implement [REQ-OPERATOR-007](../../sdd/spec/operators.md#req-operator-007-operator-aware-inference-selection), [REQ-OPERATOR-047](../../sdd/spec/operators.md#req-operator-047-generic-directed-profile-admission) and [REQ-OPERATOR-048](../../sdd/spec/operators.md#req-operator-048-dispatcher-execution).

The ordinary Host uses configured public Pi services and genuine headless, in-memory SDK context for model execution, with no SDK tools or prompt loop. Parent-bound source-session identity, original Activity generation, deadline, logical selection and all current grants are revalidated before SDK discovery, model dispatch and delivery. Caller JSON cannot choose owner, paths, SDK root, destination or credentials.

| Method | Private host path | Request | Success |
|---|---|---|---|
| POST | `/operator-inference/profile` | `{ schemaVersion: 1, activityId, generation, sessionGeneration }` | Nonsecret `{ provider, model, api, reasoningLevel, profileDigest }`; managed provider-default reasoning is `null`, not Off |
| POST | `/operator-inference` | Same identity plus `{ operationId, context, options, requestDigest, profileDigest }`; normalized SDK transcript/tools and provider-neutral options only | Complete bounded `{ events, result }`, after final authority recheck; no partial late delivery |

The parent supplies `x-codeflare-operator-activity` and `x-codeflare-operator-generation` lookup headers so the admitted transcript allowance is not reduced to the 64 KiB unresolved-metadata limit. Header/body mismatches deny execution. Without separate lookup metadata, the initial body is bounded to 64 KiB and ten seconds; the resolved owner's original inference allowance/deadline still governs the call. The fixed container-bound `https://operator.internal/v1/dispatcher/owner-context` lookup derives the owner from server props, never caller identity. It is not an installed application's general context endpoint. Missing authority, selection drift, malformed input, unsupported SDK behavior and exceeded bounds fail closed. Closed SDK missing-credential evidence can return safe `PI_LOGIN_REQUIRED`; arbitrary provider text is not authentication evidence. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: host/src/operator-inference.ts::ownerInference --> <!-- @impl: host/src/operator-inference-owner.ts::createOperatorInferenceOwnerResolver --> <!-- @impl: src/operators/dispatcher-owner-inference.ts::OperatorOwnerInferenceAuthority -->

### Structured Pi

| Method | Private host path | Request | Success response | Errors |
|---|---|---|---|---|
| POST | `/internal/operator/pi/auth-bind` | Exactly `{ descriptor, auth, expiresAt, env? }`, as defined below; no query parameters | `200 { bound: true }`; installs the private derived request auth for the trusted native profile | `400 PI_REQUEST_INVALID`; `409 PI_OPERATION_CONFLICT` for a mismatched descriptor or changed binding; `409` login recovery (below); `500 PI_OPERATION_FAILED` |
| POST | `/internal/operator/pi/ensure` | Empty JSON object; native execution requires an installed private auth binding | `200 { conversationId, ready: true }`; creates once or reopens only the exact persisted conversation | `400 PI_REQUEST_INVALID`; `409 PI_OPERATION_CONFLICT` if the owned conversation is lost or cannot be reconciled; `409` login recovery (below); `500 PI_OPERATION_FAILED` |
| POST | `/internal/operator/pi/tasks` | Prompt form: `{ taskId, digest, text, mode }`, where mode is `prompt`, `follow-up`, or `steer`. Native-tool form: `{ taskId, digest, mode: "tool", toolName, arguments }`. IDs are 1–128 safe characters, digest is lowercase SHA-256, and text/tool arguments are bounded to 32 KiB. | `202 { taskId, status, authFailure? }`; stable task identity reconciles an exact repeat. Tool mode invokes only an active tool already approved by the trusted Pi profile. | `400 PI_REQUEST_INVALID`, `PI_TASK_IDENTITY_INVALID`, or `PI_TOOL_TASK_INVALID`; `409 PI_OPERATION_CONFLICT` for changed identity, busy state, or a full pending follow-up/steer slot; `409` login recovery (below); `500 PI_OPERATION_FAILED` |
| GET | `/internal/operator/pi/events?cursor=<sequence>` | Optional nonnegative safe-integer cursor; no other query keys | `200 { events, nextCursor, gap }`; at most 100 events and 64 KiB of summed serialized event payloads (sequence/wrapper, array, and response-envelope bytes are additional), with `gap: true` when retained history no longer covers the cursor | `400 PI_REQUEST_INVALID`; `500 PI_OPERATION_FAILED` |
| POST | `/internal/operator/pi/tasks/:taskId/abort` | Empty JSON object | `200 { taskId, status: "cancelled" }` after SDK abort and current prompt settlement | `400 PI_REQUEST_INVALID`; `404 PI_TASK_NOT_FOUND`; `409 PI_OPERATION_CONFLICT`; `500 PI_OPERATION_FAILED` |

The private native `auth-bind` descriptor must exactly match trusted parent startup: `{ ownerKey, activityId, sessionId, generation, selectionDigest, profileDigest, deadline }`, with no extra fields. `ownerKey`, `selectionDigest` and `profileDigest` are lowercase SHA-256 digests; Activity/session IDs use 1–128 alphanumeric, underscore or hyphen characters; `generation` and the epoch-millisecond `deadline` are positive safe integers. Candidate input cannot select or replace this binding. <!-- @impl: host/src/operator-pi-auth.ts::parsePiAuthDescriptor --> <!-- @impl: host/src/operator-pi-auth.ts::OperatorPiAuthBinding -->

`auth` contains only derived Pi `ModelAuth` fields `{ apiKey?, headers?, baseUrl? }`, never raw saved API-key/OAuth records or refresh tokens. Optional `env` contains only provider-allowlisted string values; `expiresAt` is a positive safe-integer epoch-millisecond expiry or `null`. The service holds derived auth/env only in memory, with no credential-store mutation or persistence; abort, stop and disposal clear and fence the binding. This is not a public credential-upload API. <!-- @impl: host/src/operator-pi-auth.ts::OperatorPiAuthBinding --> <!-- @impl: host/src/operator-pi-http.ts::OperatorPiHttpController -->

A task response may include safe `authFailure: { code: "PI_LOGIN_REQUIRED", reason: "missing" | "expired" | "rejected", provider }`. When the controller catches that typed failure, it returns `409 { error, authFailure }`, where `error` is the fixed recovery instruction: open Pi, run `/login` or update the API key, wait for successful R2 synchronization, then explicitly retry. This envelope has no top-level `code` and is distinct from `409 { error, code: "PI_OPERATION_CONFLICT" }`; neither response authorizes replay of an uncertain effect. Only closed authentication metadata is returned, not credentials or raw provider errors. [REQ-OPERATOR-218](../../sdd/spec/operators.md#req-operator-218-dispatcher-authentication-receipts-and-settlement) owns exact receipt settlement. <!-- @impl: host/src/operator-pi-auth.ts::safePiAuthFailure --> <!-- @impl: host/src/operator-pi-auth.ts::PI_LOGIN_RECOVERY --> <!-- @impl: host/src/operator-pi-http.ts::OperatorPiHttpController -->

Unsupported methods return `405 METHOD_NOT_ALLOWED`; unknown paths under the prefix return `404 PI_ROUTE_NOT_FOUND`. Task intent is persisted before SDK submission. The service does not replace a missing conversation or automatically replay an uncertain effect. <!-- @impl: host/src/operator-pi-http.ts::OperatorPiHttpController --> <!-- @impl: host/src/operator-pi-service.ts::createOperatorPiService -->

### Explicit operator output sync <!-- @impl: host/src/operator-sync-http.ts::OperatorSyncHttpController -->

| Method | Private host path | Request | Success response | Errors |
|---|---|---|---|---|
| POST | `/internal/bisync-trigger` | Scoped operator Sync now body `{ operationId, requestDigest, files }`; at most 128 unique canonical paths beneath `~/Operators` and 8 MiB total, each with exact `path`, `size`, and lowercase SHA-256 | `200` with a persisted version-1 receipt: an exact retained repeat may return `status: "uploaded"` or `status: "failed"`; only `uploaded` establishes that every declared file and the private final manifest were uploaded; an uncertain remote outcome returns `202 { status: "unknown", code: "SYNC_OUTCOME_UNKNOWN" }` | `400 SYNC_REQUEST_INVALID`; `403 SYNC_AUTHORITY_EXPIRED`; `409 SYNC_CONFLICT`, `SYNC_OUTPUT_NOT_FOUND`, or `SYNC_OUTPUT_MISMATCH`; `413 REQUEST_TOO_LARGE`; `500 SYNC_OPERATION_FAILED`; `503 SYNC_STATE_FAILED` |
| POST | `/internal/operator/sync/inspect` | Exactly `{ paths }`, containing 1–128 unique canonical paths and at most 64 KiB of JSON | `200 { files }`, with each fixed-root `~/Operators` file represented by path, size and SHA-256; aggregate bytes are bounded to 8 MiB | `400 SYNC_REQUEST_INVALID`; `409 SYNC_OUTPUT_NOT_FOUND` or `SYNC_OUTPUT_MISMATCH`; `413 REQUEST_TOO_LARGE`; `500 SYNC_OPERATION_FAILED`; `503 SYNC_STATE_FAILED` |
| GET | `/internal/operator/sync/operations/:operationId` | No query parameters; a request body up to 64 KiB is ignored | `200` with the current credential-free receipt | `400 SYNC_REQUEST_INVALID` for query parameters; `404 SYNC_NOT_FOUND`; `413 REQUEST_TOO_LARGE` for a larger body |

Inspection and upload read declared files from the fixed `~/Operators` root set by the host. [Host startup wiring](../../host/src/server.ts#L277-L279) supplies it; the sync service enforces the configured root. <!-- @impl: host/src/operator-sync-service.ts::createOperatorSyncService --> File reads reject final-file symlinks and require canonical-root and opened-descriptor containment. Intermediate directory links may resolve within that same root; cross-root escapes are forbidden. <!-- @impl: host/src/operator-sync-io.ts::OwnedOperatorSyncFiles --> [REQ-OPERATOR-023](../../sdd/spec/operators.md#req-operator-023-explicit-operator-synchronization) AC1–3.

Inspection returns bounded size/digest identity without persisting or uploading. <!-- @impl: host/src/operator-sync-io.ts::OwnedOperatorSyncFiles --> [Inspection call](../../host/src/operator-sync-service.ts#L59-L63). Upload checks the declared identity and mirrors files beneath R2 `Operators/**`. The private parent-selected `.codeflare/operators/<activity>/<operation>/` prefix receives `manifest.json` only after every declared file upload. <!-- @impl: host/src/operator-sync.ts::OperatorSyncService -->

Exact retained uploaded or failed repeats return their receipt without replay; clients must inspect `status`, not treat HTTP 200 alone as upload proof. Changed repeats conflict, and a pre-existing nonterminal receipt is fenced as unknown rather than replayed. Restricted sessions use `/internal/bisync-trigger` for this scoped Sync now contract; only `/internal/final-sync` remains denied with `403 OPERATOR_BISYNC_DENIED`. <!-- @impl: host/src/operator-sync-http.ts::OperatorSyncHttpController --> <!-- @impl: host/src/operator-sync.ts::OperatorSyncService --> <!-- @impl: host/src/request-router.ts::createRequestHandler -->

## Terminal

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| WS | `/api/terminal/:compoundId/ws` | Session cookie | [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002-websocket-connection-to-container-pty) AC1–3/AC5–7, [REQ-SESSION-012](../../sdd/spec/session-lifecycle.md#req-session-012-transport-retry-never-invents-lifecycle-state) AC1–2/AC4/AC7, [REQ-TERM-019](../../sdd/spec/terminal.md#req-term-019-terminal-websocket-control-frames-and-protocol-guards) AC1, [REQ-TERM-016](../../sdd/spec/terminal.md#req-term-016-terminal-pane-reconnect-and-resize-authority) AC2/AC4–5 | Terminal WebSocket (`sessionId-1..6` for classic; `sessionId-1` only for Herdr after session lookup); raw terminal input/output plus JSON control frames for resize authority (`focus`, `resize`) and terminal restore. Focus claims are cleared when a pane loses focus before open. |
| GET | `/api/terminal/:sessionId/status` | Session cookie | [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition) (startup context only) | Read owned D1 state and probe existing compute. JSON can include `terminalServerReady`, `ptyActive` and a legacy `wsUrl`; use the compound URL above for upgrades. <!-- @impl: src/routes/terminal.ts::app.get --> |

The status GET and the upgrade do not report not-ready in the same way. A failed upgrade can translate an upstream HTTP `503` to WebSocket close `1013`; the upgrade also has a separate lifecycle close `4503`. <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade -->

**Terminal mode contract:** `PATCH /api/preferences` accepts optional `herdrEnabled`; omitting it preserves the current preference, while a missing stored preference makes newly created sessions classic. `POST /api/sessions` does not accept terminal mode and stamps it server-side. Session responses expose resolved `terminalMode`; missing or invalid stored values resolve `classic`. Classic authorizes terminal IDs `1` through `6`; Herdr authorizes only `1` after authenticated session lookup. <!-- @impl: src/routes/preferences.ts::mergePreferences --> <!-- @impl: src/routes/session/crud.ts::toWorkspaceApiSession --> <!-- @impl: src/types.ts::resolveTerminalMode -->

**Enterprise reconnect authority:** After session ownership, lifecycle, readiness and rate-limit gates, terminal reconnect refreshes the sealed current-human credential without compute restart. Invalid human context revokes only the same-generation credential, not the immutable principal; failed revocation rejects reconnect with close code `1011`. Native provider requests independently require bound-session authority, current Administration permission and generation/shutdown checks, not a browser-derived lease, under [REQ-ENTERPRISE-090](../../sdd/spec/models-and-routing.md#req-enterprise-090-native-pi-forwarding-under-current-administration-permission). <!-- @impl: src/routes/terminal.ts::handleWebSocketUpgrade -->

**Terminal frame contract:** Client→server sends raw PTY input or JSON control frames `{type:"focus"}`, `{type:"resize", cols, rows}`, or `{type:"kill"}`. Server→client sends raw PTY output or JSON frames `{type:"restore", state}` and `{type:"process-name", terminalId, processName}`. <!-- @impl: host/src/terminal-ws.ts::attachTerminalConnectionHandler --> <!-- @impl: host/src/session.ts::attach --> <!-- @impl: host/src/session.ts::start -->

## Vault

The in-container SilverBullet editor is reached through the Worker proxy. Under [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) the SilverBullet app is served under a **bucket-stable** path `/api/vault/<token>/` (token = opaque 32-hex `SHA-256(salt+bucketName)`, no PII), so the IndexedDB names persist across sessions; the session-keyed `/api/vault/:sid/` path is an entry that sets `cf_vault_sid` and 302-redirects to the token path.

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/vault/:sid/` | Session cookie | [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) AC2 | Authorized tier-gated entry sets HttpOnly `cf_vault_sid`, then redirects (`302`) to the bucket path. Session ownership and health apply on the next proxy request. Valid entries receive Vault framing headers; parser errors retain defaults. |
| GET | `/api/vault/:sid/status` | Session cookie | [REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC2 | Probe includes `vaultReady`, `session`, `containerRunning` and branch-dependent `url` or `bucketMigrating`. Default CSP and `X-Frame-Options: DENY` apply. |
| GET / WS | `/api/vault/<token>/*` | Session auth plus `cf_vault_sid` routing cookie | [REQ-VAULT-005](../../sdd/spec/vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) AC3–5/AC7, [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) AC1–4, [REQ-VAULT-013](../../sdd/spec/vault.md#req-vault-013-silverbullet-subpath-adapter) AC1, [REQ-SEC-008](../../sdd/spec/security.md#req-sec-008-security-headers-on-every-response) AC2/AC4 | Rewrite `<base href>` to the bucket path. Handled HTTP sets `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, not default script/style CSP. `101` bypasses the wrapper. Normal WS limit: 30/user/60s shared with terminal and Browser IDE. |
| GET | `/api/vault/<token>/service_worker.js` | None on exact service-worker script request | [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker) AC1–4 | Exact GET with `Service-Worker: script` serves the native worker regardless of cookies. |
| GET | `/api/vault/<token>/.codeflare-bootstrap` | Session auth plus `cf_vault_sid` routing cookie | [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC1–2/AC7, [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) AC5 | Bootstrap HTML hands the bucket key to the canonical worker. The browser sets `codeflare_vault_bootstrap` and redirects only after key acknowledgement and successful browser persistence. |
| GET | `/api/vault/<token>/.vault-key` | Session auth plus `cf_vault_sid` routing cookie | [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC5, [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) AC5 | No-store `{ key }` supplies the bucket HKDF key. The worker fetches for in-memory recovery; missing memory is not a server precondition. |

## Browser IDE

The in-container code-server runtime (full Code OSS editor) is reached through the Worker proxy. Unlike the Vault, the IDE is **session-keyed** ([REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable)): the browser and Worker retain `/api/vscode/<sessionId>/`, while the trusted host strips only that exact session prefix before forwarding HTTP or WebSocket traffic to loopback code-server. Canonical forwarded host/protocol identity preserves Origin enforcement. Public `folder`, `workspace`, and `ew` selectors are rejected at Worker and host boundaries; the private root hop selects `/home/user/workspace`, and the successful root response projects its equivalent fixed `folderUri` into Code OSS while the browser location remains clean.

The sessionId in the URL is the sole container selector under [REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable); there is no bucket-stable serving path. A bounded per-user UI snapshot is storage state, not a route selector.

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| HTTP proxy / WS | `/api/vscode/<sessionId>/*` | Session cookie (shared vault auth chain) | [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](../../sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-012](../../sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection), [REQ-IDE-015](../../sdd/spec/browser-ide.md#req-ide-015-clean-browser-ide-url-and-private-workspace-selection), [REQ-IDE-035](../../sdd/spec/browser-ide.md#req-ide-035-canonical-browser-ide-workspace-projection) | Before Hono, the session-keyed proxy forwards HTTP methods and WebSocket upgrades. Worker retains the external path; host strips only the exact session prefix. The normal upgrade allowance is 30 per user per 60 seconds, shared with terminal and Vault. |

**Error responses:**

- Public `folder`, `workspace`, or `ew` selector → 400 `VSCODE_WORKSPACE_SELECTOR_FORBIDDEN` before container/code-server access.
- Missing, duplicate, malformed, compressed, or oversized pinned root workbench configuration → 502 `VSCODE_WORKBENCH_CONFIGURATION_INVALID` instead of an empty editor window.
- Malformed sessionId → 400 `INVALID_SESSION` (`src/routes/vscode-validation.ts`); unowned session → 404 `SESSION_NOT_FOUND` and stopped session → 503 `CONTAINER_STOPPED` (`src/routes/vault/access.ts::assertSessionOwnership`, shared with the vault auth chain).
- Non-advanced session → 409 for HTTP (host-layer HTML page, the IDE is not enabled for the session mode) and a refused upgrade for WebSocket ([REQ-IDE-003](../../sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability) AC7).
- Unhealthy container → 503 `CONTAINER_NOT_READY` for a WebSocket upgrade; a navigable request instead gets an auto-refreshing HTML page, because the IDE opens in a bare tab where a JSON body renders as raw text (`src/routes/vscode.ts::warmingPage`).
- That page refreshes every 3 s and gives up with 504 once the wait passes 120 s (`WARM_GIVE_UP_MS`, `WARM_REFRESH_SECONDS`).
- The Worker is stateless, so the episode start rides in a `cf_since` query parameter and the page measures elapsed time against it. A client-forged future value is ignored (`src/routes/vscode.ts::warmStartedAt`).
- Once the container answers, the Worker redirects `cf_since` back out of the tab's URL, so a later cold start is not born already expired (`src/routes/vscode.ts::redirectAwayFromWarmParam`).
- code-server still lazy-starting (container healthy, editor not yet bound) → the host serves its own 503 auto-refreshing HTML warming page with no JSON `code`, which likewise stops refreshing and returns 504 after 120 s (`host/src/vscode-proxy.ts::vscodeWarmingResponse`, `VSCODE_WARMING_GIVE_UP_MS`).

The pre-Hono parser’s `400` keeps default security headers. Handled non-`101` responses use `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` instead of the restrictive default script/style CSP. Successful `101` upgrades bypass the header wrapper. See [REQ-SEC-019](../../sdd/spec/security.md#req-sec-019-per-endpoint-rate-limit-policy) for the shared rate limit. <!-- @impl: src/index.ts::dispatch -->

## User Management

When the Enterprise binding is set, GET/PUT/DELETE/PATCH under `/api/users` return 403 without mutation; Cloudflare Access owns user administration ([REQ-ENTERPRISE-308](../../sdd/spec/security.md#req-enterprise-308-enterprise-administration-route-boundary) AC1). Billing checkout, portal and switch reject before their route-specific limiters; billing status returns empty/disabled state without Stripe ([REQ-ENTERPRISE-307](../../sdd/spec/security.md#req-enterprise-307-enterprise-stripe-route-boundary) AC1–2).

POST `/api/auth/subscribe` and `/api/auth/request-access` likewise return 403 before their specific limiters and send no email. `PATCH /api/preferences` is the explicit exception: Enterprise bypasses the SaaS advanced-mode entitlement gate, permits Pro selection and forces effective Pro regardless of stored mode ([REQ-ENTERPRISE-009](../../sdd/spec/security.md#req-enterprise-009-enterprise-backend-route-hardening)).

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/user` | Mode-aware active-user auth | [REQ-AUTH-019](../../sdd/spec/authentication.md#req-auth-019-user-identity-and-account-status-api) AC1, [REQ-ENTERPRISE-003](../../sdd/spec/agents.md#req-enterprise-003-agent-allowlist-in-enterprise-mode) AC4 (creation UI context), [REQ-AGENT-123](../../sdd/spec/agents.md#req-agent-123-installed-agent-runtime-availability) AC3 | Authenticated user info (includes `onboardingActive`, `onboardingComplete`, `allowedAgents` — the build-installed, policy-filtered creation set) |
| POST | `/api/user/onboarding-complete` | Mode-aware active-user auth; CSRF on writes | [REQ-AUTH-019](../../sdd/spec/authentication.md#req-auth-019-user-identity-and-account-status-api) AC2 | Mark Guided Setup complete on the existing user record; if absent after authentication, success is a no-op. |
| GET | `/api/user/r2-status` | Mode-aware active-user auth | [REQ-AUTH-019](../../sdd/spec/authentication.md#req-auth-019-user-identity-and-account-status-api) AC3 | Report cached R2 credential presence, not provider validity. |
| POST | `/api/user/ensure-r2-token` | Mode-aware active-user auth; CSRF on writes | [REQ-AUTH-019](../../sdd/spec/authentication.md#req-auth-019-user-identity-and-account-status-api) AC4, AC6 | Ensure a scoped R2 token for the current user (rate limited). |
| GET | `/api/users` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-005](../../sdd/spec/authentication.md#req-auth-005-three-tier-authorization-middleware) AC3, [REQ-ENTERPRISE-308](../../sdd/spec/security.md#req-enterprise-308-enterprise-administration-route-boundary) AC1/AC3, [REQ-AUTH-023](../../sdd/spec/authentication.md#req-auth-023-admin-user-browsing-and-mode-specific-controls) AC1/AC3 (consumer context) | Return `{ users, maxUsers }` to the authenticated administrator. |
| DELETE | `/api/users/:email` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-026](../../sdd/spec/authentication.md#req-auth-026-admin-user-offboarding) AC1–4, [REQ-ENTERPRISE-308](../../sdd/spec/security.md#req-enterprise-308-enterprise-administration-route-boundary) AC1 | Offboard the named user; not merely an allowlist removal. |
| PATCH | `/api/users/:email` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) AC1–2, [REQ-AUTH-023](../../sdd/spec/authentication.md#req-auth-023-admin-user-browsing-and-mode-specific-controls) AC4, [REQ-ENTERPRISE-308](../../sdd/spec/security.md#req-enterprise-308-enterprise-administration-route-boundary) AC1 | SaaS/onboarding only. Requires `subscriptionTier` or legacy `accessTier`; omitted `subscribedMode` defaults to `default`. Preserves `role`. |

In SaaS mode, `GET /api/user` also projects optional `allowedModes` (`default` and/or `advanced`) from the canonical billing-effective configured tier. Settings uses this list rather than `subscribedMode`; an older response omitting availability does not grant non-admin Pro access. Preference-save and Start authorization remain server-side ([REQ-SUB-014](../../sdd/spec/subscription.md#req-sub-014-session-mode-gating-by-tier) AC6).

`GET /api/user` also exposes `downloadsDisabled`; Storage Panel controls remain visible and tappable in their blocked styling, and interactions show the administrator-disabled notice instead of fetching ([REQ-ENTERPRISE-019](../../sdd/spec/storage.md#req-enterprise-019-view-only-storage-download-disable) AC2).

For `GET /api/user`, current workers return `allowedAgents`. During a rolling upgrade, a successful response from an older worker may omit this optional field; the UI then hydrates the deployment-mode legacy catalog rather than remaining in its pre-hydration state ([REQ-AGENT-124](../../sdd/spec/agents.md#req-agent-124-agent-choice-profile-hydration)).

## Notifications

| Method | Path | Auth | Implements | Description |
|--------|------|------|------------|-------------|
| GET | `/api/notifications/config` | Mode-aware active-user auth | [REQ-TERM-025](../../sdd/spec/terminal.md#req-term-025-per-device-notification-enrollment), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries) | Return only the public VAPID enrollment key; `503` when notification delivery is not configured. |
| POST | `/api/notifications/subscription` | Mode-aware active-user auth | [REQ-TERM-025](../../sdd/spec/terminal.md#req-term-025-per-device-notification-enrollment), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries) | Validate and register one Push subscription for the authenticated user; returns `{ success: true }`. |
| DELETE | `/api/notifications/subscription` | Mode-aware active-user auth | [REQ-TERM-025](../../sdd/spec/terminal.md#req-term-025-per-device-notification-enrollment), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries) | Validate an endpoint and remove that authenticated user's matching enrollment; returns `{ success: true }`. |

## Auth (SaaS Mode)

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/auth/providers` | Public | Source-only lookup | Return `{ providers }` from configured IdP KV state, or an empty list. The login chooser uses the separate `/public/auth/providers` endpoint. <!-- @impl: src/routes/auth.ts::app.get('/providers', --> |
| GET | `/api/auth/status` | Verified identity; active tier not required | [REQ-AUTH-005](../../sdd/spec/authentication.md#req-auth-005-three-tier-authorization-middleware) AC1 (identity), [REQ-SUB-012](../../sdd/spec/subscription.md#req-sub-012-billing-status-enforcement-effective-tier) AC1–5/AC7 (effective tier) | Auth status (tier, email, role, turnstile key, session/billing state) |
| GET | `/api/auth/tiers` | Verified identity; active tier not required | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) AC3–4 (configuration), [REQ-SUB-011](../../sdd/spec/subscription.md#req-sub-011-graceful-degradation-without-stripe) AC5, [REQ-SUB-020](../../sdd/spec/subscription.md#req-sub-020-multi-currency-pricing) AC2, [REQ-SETUP-009](../../sdd/spec/setup.md#req-setup-009-subscribe-page-with-tier-selection) AC1 (consumer) | Identity-gated tier offer, distinct from the anonymous catalog. |
| GET | `/api/auth/onboarding-config` | Verified identity; active tier not required | Source-only | Return `{ active: true, turnstileSiteKey }` for authenticated onboarding. No dedicated response AC. <!-- @impl: src/routes/auth.ts::app --> |
| POST | `/api/auth/subscribe` | Verified identity; active tier not required | [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment) AC1/AC3–4, [REQ-SUB-011](../../sdd/spec/subscription.md#req-sub-011-graceful-degradation-without-stripe) AC1–2, [REQ-SEC-015](../../sdd/spec/security.md#req-sec-015-blocked-user-cannot-self-upgrade-subscription) AC1, [REQ-ENTERPRISE-009](../../sdd/spec/security.md#req-enterprise-009-enterprise-backend-route-hardening) AC1 | Direct activation, not Stripe checkout (3/minute). |
| POST | `/api/auth/request-access` | Verified identity; active tier not required | [REQ-AUTH-006](../../sdd/spec/authentication.md#req-auth-006-user-email-normalized) (normalization context), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure), [REQ-SEC-019](../../sdd/spec/security.md#req-sec-019-per-endpoint-rate-limit-policy) AC3, [REQ-ENTERPRISE-009](../../sdd/spec/security.md#req-enterprise-009-enterprise-backend-route-hardening) AC1 | First requests require Turnstile; an already recorded request does not notify twice. Active or blocked users are refused (3/hour). |
| POST | `/api/auth/contact-team` | Verified identity; active tier not required | [REQ-SUB-017](../../sdd/spec/subscription.md#req-sub-017-enterprise-tier-contact-flow), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Deliver an enterprise-tier inquiry email (rate-limited 1/hr). Returns `200 { success: true }` only after provider acceptance; provider rejection, missing configuration, or network failure returns retryable `503 { success: false, error }`. |

## Usage

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/usage` | Mode-aware active-user auth | [REQ-SUB-022](../../sdd/spec/subscription.md#req-sub-022-cross-mode-personal-usage-data) AC2–3/AC5, [REQ-SUB-033](../../sdd/spec/subscription.md#req-sub-033-usage-dashboard-page) (dashboard consumption context) | Current user's real-time usage (Timekeeper DO with KV fallback). `monthlyQuotaSeconds` is the resolved tier's configured `monthlySeconds` when `SAAS_MODE` is active, otherwise `null`. Enterprise defaults normally yield `null`, but combined SaaS/Enterprise flags with a retained finite unlimited-tier configuration can expose a finite value; this field is not proof of quota enforcement. |

## Admin

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/admin/tiers` | Admin role | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel), [REQ-ENTERPRISE-308](../../sdd/spec/security.md#req-enterprise-308-enterprise-administration-route-boundary) AC2 | Get current tier config (admin only) |
| PUT | `/api/admin/tiers` | Admin role | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel), [REQ-ENTERPRISE-308](../../sdd/spec/security.md#req-enterprise-308-enterprise-administration-route-boundary) AC2 | Update tier config (admin only, 8-tier array) |
| GET | `/api/admin/configuration` | Admin role | [REQ-SETUP-017](../../sdd/spec/setup.md#req-setup-017-mode-aware-administration-configuration-read), [REQ-SETUP-027](../../sdd/spec/setup.md#req-setup-027-native-target-configuration-projection) | Read mode-gated Environment values, revision, active run, sanitized latest summaries, and sanitized native targets for the applicable Enterprise AI-routing section. Absent or malformed native-target storage yields an empty projection; unreadable storage fails the request. |
| GET | `/api/admin/configuration/mcp-portals` | Admin role | [REQ-AGENT-227](../../sdd/spec/mcp.md#req-agent-227-instance-administration-and-pi-use-of-mcp-portals) | Read this instance's named HTTPS MCP portal array; unset configuration is `[]`. <!-- @impl: src/routes/admin/configuration.ts::app --> |
| PUT | `/api/admin/configuration/mcp-portals` | Admin role | [REQ-AGENT-227](../../sdd/spec/mcp.md#req-agent-227-instance-administration-and-pi-use-of-mcp-portals) | Validate and persist `[{name,url}]`, returning saved values. Invalid input returns 400 without writes; no secret fields, provisioning, authentication or session restart. <!-- @impl: src/routes/admin/configuration.ts::app --> |
| GET | `/api/mcp-portals` | Authenticated active owner | [REQ-AGENT-251](../../sdd/spec/mcp.md#req-agent-251-owner-bound-mcp-settings-return-and-status) AC3–4, [REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization) (grant context) | `{portals:[{name,url,connected}]}` only; no credentials. Connected means a matching locally unexpired or refreshable grant, not live upstream authorization. <!-- @impl: src/routes/mcp-oauth.ts::createMcpPortalApiRoutes --> |
| GET | `/auth/mcp/client-metadata` | Public authorization-server metadata read | [REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization) (OAuth context, response shape is source-owned) | Serve the fixed client metadata only on the selected public HTTPS origin. No issuer, owner identity, credentials or grant status. <!-- @impl: src/routes/mcp-oauth.ts::createMcpOAuthRoutes --> |
| GET | `/auth/mcp/connect/:name` | Browser owner | [REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization) | Standard portal OAuth/PKCE navigation for the exact configured resource; no compute/session dependency. <!-- @impl: src/routes/mcp-oauth.ts::createMcpOAuthRoutes --> |
| GET | `/auth/mcp/callback` | Same authenticated owner | [REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization), [REQ-AGENT-251](../../sdd/spec/mcp.md#req-agent-251-owner-bound-mcp-settings-return-and-status) AC4 | Server-side code exchange into encrypted owner-DO state; validates state/owner/instance/issuer/resource/configuration/expiry and atomically fences publication. Fixed `303` to clean `/app/?mcp=connected` or `mcp=reconnect` completion with no-store/no-referrer. Codes never reach Pi. <!-- @impl: src/routes/mcp-oauth.ts::createMcpOAuthRoutes --> |
| POST | `/api/mcp-portals/:name/recover` | Authenticated active owner, same-origin mutation | [REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization) | `{authorize:boolean}` reuses/refreshes an existing bound grant. Returns `state: ready`, `ineligible`, `unavailable`, or `authorization` with the existing PKCE browser URL; never tokens. `authorize:false` suppresses browser authorization. New, changed or disconnected grants cannot auto-connect; transient failures do not authorize. <!-- @impl: src/routes/mcp-oauth.ts::createMcpPortalApiRoutes --> |
| POST | `/api/mcp-portals/:name/disconnect` | Authenticated owner, existing CSRF gate and same-origin | [REQ-AGENT-226](../../sdd/spec/mcp.md#req-agent-226-worker-owned-mcp-portal-authorization) | Disconnect selected owner/portal locally, with supported best-effort provider revocation; never clears GitHub/Cloudflare credentials. <!-- @impl: src/routes/mcp-oauth.ts::createMcpPortalApiRoutes --> |
| POST | `/api/admin/configuration-previews` | Admin role | [REQ-SETUP-018](../../sdd/spec/setup.md#req-setup-018-stateless-environment-preview-and-bounded-execution) | Validate one closed Environment section and return a stateless task preview |
| GET | `/api/admin/configuration-runs` | Admin role | [REQ-SETUP-029](../../sdd/spec/setup.md#req-setup-029-retained-environment-run-history) | Cursor-paginated sanitized Activity runs |
| POST | `/api/admin/configuration-runs` | Admin role | [REQ-SETUP-018](../../sdd/spec/setup.md#req-setup-018-stateless-environment-preview-and-bounded-execution), [REQ-SETUP-024](../../sdd/spec/setup.md#req-setup-024-routine-oauth-identifier-persistence), [REQ-ENTERPRISE-069](../../sdd/spec/setup.md#req-enterprise-069-dynamic-route-profile-persistence-before-access) | Start one bounded run and stream NDJSON snapshots. An empty authoritative `aiRouting` diff returns JSON `409 configuration_no_changes` before creating a run or writing configuration. Explicitly blank OAuth client IDs remove saved IDs; blank replacement secrets preserve saved secrets. |
| GET | `/api/admin/configuration-runs/:runId` | Admin role | [REQ-SETUP-029](../../sdd/spec/setup.md#req-setup-029-retained-environment-run-history) | Reconnect to one persisted run |
| GET, POST | `/api/admin/reasoning/catalog` | Admin role | [REQ-ENTERPRISE-031](../../sdd/spec/models-and-routing.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-047](../../sdd/spec/models-and-routing.md#req-enterprise-047-native-ai-gateway-provider-discovery-and-selection), [REQ-ENTERPRISE-063](../../sdd/spec/setup.md#req-enterprise-063-ai-gateway-management-url-compatibility), [REQ-ENTERPRISE-099](../../sdd/spec/setup.md#req-enterprise-099-saved-connection-routing-reconciliation) AC1–2 | Return built-in and custom profiles, compatibility notices, assignment usage, Dynamic Route names, and sanitized gateway-scoped provider presence. Dynamic Route and provider discovery report independent readiness. POST supports read-only gateway overlays or revision-checked saved-inventory reconciliation. |
| POST | `/api/admin/reasoning/native/profile-discovery` | Admin role, rate limited | [REQ-ENTERPRISE-047](../../sdd/spec/models-and-routing.md#req-enterprise-047-native-ai-gateway-provider-discovery-and-selection), [REQ-ENTERPRISE-048](../../sdd/spec/models-and-routing.md#req-enterprise-048-native-provider-capability-catalog), [REQ-ENTERPRISE-054](../../sdd/spec/setup.md#req-enterprise-054-native-target-profile-and-lifecycle-administration) AC1 | Nonlegacy transports return a Provider-default template, `Compatible, unverified`, with zero model probes or model HTTP attempts, not zero management I/O. Bounded legacy discovery can return matches, a bounded unique draft, unsupported, or inconclusive. Discovery, paid verification or explicit confirmation, and Save are separate. |
| POST | `/api/admin/reasoning/native/discover` | Admin role, rate limited | [REQ-ENTERPRISE-052](../../sdd/spec/models-and-routing.md#req-enterprise-052-native-provider-verification-and-runtime-enforcement), [REQ-ENTERPRISE-053](../../sdd/spec/models-and-routing.md#req-enterprise-053-native-target-identity-and-document), [REQ-ENTERPRISE-054](../../sdd/spec/setup.md#req-enterprise-054-native-target-profile-and-lifecycle-administration) AC2–3, [REQ-ENTERPRISE-060](../../sdd/spec/models-and-routing.md#req-enterprise-060-native-target-input-validation), [REQ-ENTERPRISE-061](../../sdd/spec/setup.md#req-enterprise-061-native-target-administration-projection), [REQ-ENTERPRISE-075](../../sdd/spec/models-and-routing.md#req-enterprise-075-provider-native-bedrock-administration-authority) AC2–4 | Verify the exact target/profile via legacy compat or eligible provider-native Bedrock probes. Other nonlegacy profiles require explicit administrator confirmation. Success returns a temporary exact-identity Save receipt, not raw provider authority. |
| GET, POST | `/api/admin/reasoning/routes/:route/inventory` | Admin role | [REQ-ENTERPRISE-033](../../sdd/spec/models-and-routing.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence), [REQ-ENTERPRISE-063](../../sdd/spec/setup.md#req-enterprise-063-ai-gateway-management-url-compatibility) | Return the active route version, every reachable model leg and conditional/fallback path, sanitized evidence, common levels/mapping, `inventoryDigest`, matching saved `verification`, and warnings. POST accepts `gateway` and `backendDescriptions`. Missing route: `404`; malformed/unavailable inventory: `502`; unavailable gateway credentials: `503`. |
| POST | `/api/admin/reasoning/discover` | Admin role | [REQ-ENTERPRISE-033](../../sdd/spec/models-and-routing.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence), [REQ-ENTERPRISE-035](../../sdd/spec/models-and-routing.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-037](../../sdd/spec/models-and-routing.md#req-enterprise-037-enterprise-pi-custom-profile-generation), [REQ-ENTERPRISE-063](../../sdd/spec/setup.md#req-enterprise-063-ai-gateway-management-url-compatibility), [REQ-ENTERPRISE-038](../../sdd/spec/models-and-routing.md#req-enterprise-038-enterprise-pi-selected-profile-verification) AC1, [REQ-ENTERPRISE-043](../../sdd/spec/models-and-routing.md#req-enterprise-043-enterprise-pi-verified-route-activation) AC1–2/AC7 | Discover Pi compatibility for one route using saved credentials or a transient overlay. `profileRef` selects a saved revision or exact `profileDraft`; `administratorConfirmed: true` records confirmation without probes. Without `profileRef`, discovery returns named matches or a non-persisted custom draft from compatible modes. |
| GET | `/api/admin/usage` | Admin role | [REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-SUB-031](../../sdd/spec/subscription.md#req-sub-031-canonical-administration-usage-period-starts) | JSON summary for the selected UTC period plus bounded history ending at it; CSV user-row export for the selected UTC period. `start` uses `YYYY-MM-DD` for days and Monday-only weeks, `YYYY-MM` for months, or `YYYY` for years; invalid values return `400`. |
| GET | `/api/admin/usage/users/:userKey` | Admin role | [REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history) AC1/AC4–5, [REQ-SUB-031](../../sdd/spec/subscription.md#req-sub-031-canonical-administration-usage-period-starts) AC1–2 | Return one active or deleted user’s named aggregate for the selected UTC period (JSON only). |
| POST | `/api/admin/usage-report-tests` | Admin role | [REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports) AC5, [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods) AC2/AC5 | Queue a current-UTC-month test dispatch (`202` pending). Disabled settings return `409 reports_disabled`; repeated dispatch identity does not add duplicate rows. |
| GET | `/api/admin/usage-report-deliveries` | Admin role | [REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports) | Cursor-paginated scheduled and test provider-acceptance history |
| PUT | `/api/users/max-users` | Admin role | [REQ-ENTERPRISE-308](../../sdd/spec/security.md#req-enterprise-308-enterprise-administration-route-boundary) AC1 (Enterprise denial) | Set `{ maxUsers }` to a nonnegative integer (source only; no dedicated capacity-write AC). <!-- @impl: src/routes/users.ts::app.put --> |

Saved portal registrations apply on a subsequent Standard or Advanced Pi startup; the admin PUT does not reconfigure a running session. [REQ-AGENT-228](../../sdd/spec/mcp.md#req-agent-228-owner-pi-mcp-configuration-and-discovery) AC1/AC3; see [MCP configuration and migration](mcp.md#client-configuration-and-migration). <!-- @impl: entrypoint.sh::configure_pi_mcp_portals -->

The metadata route takes the configured custom-domain origin, falling back to the request origin if there is no valid configured domain. The selected origin must pass public HTTPS validation and match the incoming origin; a mismatch returns `404`. <!-- @impl: src/lib/kv-keys.ts::getBaseUrl --> <!-- @impl: src/routes/mcp-oauth.ts::createMcpOAuthRoutes --> Provider advertisement governs whether the OAuth client uses this metadata, not whether the route serves it. <!-- @impl: src/lib/mcp-portal-token.ts::beginMcpPortalConnect -->

Catalog POST accepts either a read-only transient `gateway` overlay or `{reconcileSaved:true,baseRevision}` for cleanup from complete current saved-Gateway inventories. The modes cannot be combined. The `reconciliation` object contains `status` (`unchanged` or `applied`), `removedDynamicRoutes`, `removedNativeTargetIds`, and the resulting `revision`; only persisted removals are reported as applied. GET and POST `{}` remain read-only. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @impl: src/routes/admin/configuration-runs.ts::reconcileSavedAiRoutingConfiguration -->

Discovery and verification do not activate configuration. POST variants accept transient `gateway: {gatewayUrl, gatewayId?, replacementToken?}` overlays and otherwise reuse saved encrypted credentials. `gatewayId` is required for account API URLs and unnecessary for legacy full gateway URLs. No saved token is returned. Selected discovery also accepts `profileDraft` and `backendDescriptions`; drafts must canonicalize to the exact selected reference before provider I/O. Confirmed aiRouting Save remains the sole activation path and preserves explicit warning codes and baseRevision concurrency protection. Legacy ID-only saves preserve unchanged exact assignments and custom revisions. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes -->

Discovery accepts `{ route, profileRef, profileDraft?, gateway?, backendDescriptions?, maxCompletionTokens, administratorConfirmed? }` for a selected profile. Optional `administratorConfirmed` accepts only `true` and requires an exact canonical selected profile; it returns `classification: "Administrator-confirmed"`, `checkId`, and `verification.method: "administrator"` without model probes or live-check results. Omitting `profileRef` tests the finite built-in protocol bank and compares its compatible modes with enabled built-in and saved custom revisions. The route-only `outcome` is `existing-profile`, `custom-profile`, `ambiguous`, `inconclusive`, or `unsupported`. Every complete existing match returns a `matchedProfiles` entry containing `name`, exact `profileRef`, and `supportedLevels`, with no duplicate `profileDraft`. Different passing mappings remain available for administrator selection. Saved custom profiles do not expand the paid probe bank. Unknown provider properties are not inferred. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes -->

When no existing profile fits, an unambiguous partial candidate may produce `profileDraft` containing only passed reasoning/tool/replay modes; failed modes, unproven off, and dangling aliases are removed. Complete existing matches take precedence over partial drafts. Only custom-draft construction requires a maximal mapping with identical shared mutations; divergent partial mappings remain ambiguous. Generated drafts retain `profileDraft.classification: "Compatible, unverified"`, `toolCompatibility: { status: "unverified", levels: [] }`, and `validatedTransports: []`; generated evidence remains advisory; activation requires either a successful selected live check or explicit administrator confirmation, followed by group assignment and confirmed configuration Save. ([REQ-ENTERPRISE-037](../../sdd/spec/models-and-routing.md#req-enterprise-037-enterprise-pi-custom-profile-generation))

`diagnostics` contains bounded levels, stage, failure code, and optional HTTP status/transport. `candidateResults` retains these diagnostics and `verifiedLevels` for each tested protocol. A `completion_limit` at tool generation or replay means incomplete verification, not unsupported behavior. `requestedCompletionCeiling` echoes the chosen per-request limit: 32–16,384, default 4,096. The API range is unchanged; the UI always sends 4,096, exposes no token control, and never automatically retries or escalates. Results remain sanitized and rate limited to 5/minute. A rejected candidate stops without retry; authentication, rate-limit, server, transport, and malformed-stream errors stop further scan requests. ([REQ-ENTERPRISE-035](../../sdd/spec/models-and-routing.md#req-enterprise-035-enterprise-pi-protocol-match-selection))

HTTP 429 preserves previously completed matches as selectable recommendations, but suppresses custom drafts. Other fatal errors suppress both recommendations and drafts. REST runs first; compat is permitted only after completely consuming a REST 404, removing only `store` and `prompt_cache_key`. ([REQ-ENTERPRISE-035](../../sdd/spec/models-and-routing.md#req-enterprise-035-enterprise-pi-protocol-match-selection)) <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility -->

Successful selected verification or administrator confirmation returns `checkId` and server-derived `verification`: schemaVersion, profileRef, routeVersion, inventoryDigest, connectionFingerprint, canaryVersion, supportedLevels, scope, checkedAt, and optional method. `method: "administrator"` identifies confirmation rather than a live check and produces the `administrator_confirmed` Save warning. Scope is `single-model` or `observed-path`; a live observed-path check produces the untested-backend warning. Missing custom-backend descriptions do not block live verification and limit its evidence to the observed path. `routeChecks` maps route names to receipt IDs or null (clear); omission preserves only unchanged current saved authority.

Dynamic and Native temporary Save receipts last 30 days, exceeding the one-hour minimum; saved authority does not expire with them. Save validates unchanged saved authority before temporary receipt lookup. A fresh valid receipt replaces observations; an unavailable or expired receipt may fall back only to that validated saved authority. Missing unsaved proof still rejects Save. Explicit null clears proof, and present mismatched receipts reject. Private replay retention is separate. <!-- @impl: src/lib/reasoning-verification.ts::issueRouteCheck --> <!-- @impl: src/lib/native-ai-targets.ts::issueNativeTargetCheck --> <!-- @impl: src/lib/admin-configuration.ts::validateConfigurationValues -->

For unavailable receipts, retry Save without rerunning the check. If recovery still fails, use Advanced to verify the selected profile or explicitly Mark as verified, then review and Save again. No check runs automatically. Live verification still requires complete supported-level tools/replay and applicable Off checks against unchanged inventory. Both authority methods retain exact identity validation and explicit warning acknowledgment at Save. <!-- @impl: src/lib/reasoning-verification.ts::readRouteCheck --> <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration -->

aiRouting accepts `fallbackRouting: {enabled:false}` or `{enabled:true,routes,defaultRoute,reasoning}` and persists it in reasoningConfiguration. Disabled or absent fallback denies unmatched users. A checked connection and complete disabled provider drafts can be saved without routes or group policies, while only live-verified or administrator-confirmed targets become eligible for access. ([REQ-ENTERPRISE-044](../../sdd/spec/setup.md#req-enterprise-044-enterprise-pi-minimum-save-and-access-policies), [REQ-ENTERPRISE-098](../../sdd/spec/setup.md#req-enterprise-098-enterprise-pi-access-policy-resolution), [REQ-ENTERPRISE-066](../../sdd/spec/setup.md#req-enterprise-066-native-provider-draft-persistence-before-access)) <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration -->

Without a global default, clients submit an empty route with `reasoning: "off"`; another reasoning value without a route returns a validation error. Empty configured sanctioned-route policies remain Gateway deny-only entries; first-match selection precedes eligibility filtering. Active dynamicRoutes are the group/fallback union. Client verification flags cannot authorize routes, and an empty sanctioned runtime catalog denies sanctioned inference before upstream I/O. The independent default-off personal Pi grant still requires bound-session/current Administration/generation authorization under [REQ-ENTERPRISE-088](../../sdd/spec/setup.md#req-enterprise-088-group-scoped-native-pi-providers). ([REQ-ENTERPRISE-039](../../sdd/spec/models-and-routing.md#req-enterprise-039-enterprise-pi-default-reasoning-controls), [REQ-ENTERPRISE-044](../../sdd/spec/setup.md#req-enterprise-044-enterprise-pi-minimum-save-and-access-policies), [REQ-ENTERPRISE-098](../../sdd/spec/setup.md#req-enterprise-098-enterprise-pi-access-policy-resolution)) <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->

## Billing

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/billing/checkout` | Session cookie | [REQ-SUB-004](../../sdd/spec/subscription.md#req-sub-004-paid-tiers-integrate-with-stripe-checkout) AC2, [REQ-SETUP-009](../../sdd/spec/setup.md#req-setup-009-subscribe-page-with-tier-selection) AC3 (challenge and exemption), [REQ-SUB-017](../../sdd/spec/subscription.md#req-sub-017-enterprise-tier-contact-flow) AC6 | Create a paid Stripe Checkout session (5/minute). Requires configured Turnstile keys and successful verification before checkout effects unless stored `billingStatus` is `active` or `trialing`. Custom is contact-only and returns `400 VALIDATION_ERROR` even with a configured price. <!-- @impl: src/routes/billing.ts::app.post('/checkout', --> |
| GET | `/api/billing/status` | Session cookie | [REQ-SUB-016](../../sdd/spec/subscription.md#req-sub-016-customer-portal-and-plan-switching) (status fallback constraint), [REQ-ENTERPRISE-307](../../sdd/spec/security.md#req-enterprise-307-enterprise-stripe-route-boundary) AC2 | Return live Stripe state when available, otherwise use persisted fields. Confirmed provider `404` triggers a cleanup attempt. Enterprise returns disabled state. <!-- @impl: src/routes/billing.ts::app.get('/status', --> |
| POST | `/api/billing/portal` | Session cookie | [REQ-SUB-016](../../sdd/spec/subscription.md#req-sub-016-customer-portal-and-plan-switching) | Create Stripe Customer Portal session (rate-limited 5/min) |
| POST | `/api/billing/switch` | Session cookie | [REQ-SUB-016](../../sdd/spec/subscription.md#req-sub-016-customer-portal-and-plan-switching) AC2–AC4, [REQ-SUB-017](../../sdd/spec/subscription.md#req-sub-017-enterprise-tier-contact-flow) AC6 | Deep-link portal for plan change confirmation (rate-limited 5/min). Custom is contact-only and returns `400 VALIDATION_ERROR` before provider I/O |
| POST | `/public/stripe/webhook` | Stripe HMAC outside Enterprise | [REQ-SUB-005](../../sdd/spec/subscription.md#req-sub-005-trial-is-compute-based-not-time-based), [REQ-SUB-015](../../sdd/spec/subscription.md#req-sub-015-stripe-webhook-signal-and-sync-pattern), [REQ-SUB-035](../../sdd/spec/subscription.md#req-sub-035-signed-billing-webhook-lifecycle), [REQ-ENTERPRISE-307](../../sdd/spec/security.md#req-enterprise-307-enterprise-stripe-route-boundary) AC3 | Outside Enterprise, verify Stripe HMAC and enforce the fail-closed 30/minute limit. Enterprise acknowledges without signature verification, limiter use, or billing mutation. Both remain subject to the outer 1 MiB body cap. |

The checkout challenge gates checkout effects, not identity resolution. Authentication runs first and can provision a first-time SaaS user independently; this route does not promise that a rejected checkout challenge leaves all account state untouched. <!-- @impl: src/middleware/auth.ts::requireIdentity --> [First-time SaaS identity](../../src/lib/access.ts#L793-L811).

The Turnstile exemption uses the stored status, not a live Stripe or subscription-ID check. [Checkout handler](../../src/routes/billing.ts#L60-L98).

Billing status does not persist a successful live snapshot. When Stripe returns `404`, it tries to clear the stored subscription fields and reset the tier to pending. A failed KV write falls back to old fields; even after a successful cleanup, that response can still carry the pre-cleanup `checkoutSessionId`. <!-- @impl: src/routes/billing.ts::app.get('/status', -->

## Deploy Keys

Direct deploy-credential management is **non-Enterprise only**. In Enterprise, authenticated GET, PUT and DELETE requests to `/api/deploy-keys` return `403 { "error": "Access denied", "code": "FORBIDDEN" }` for users and administrators alike, before route-specific limiters, JSON parsing, credential reads, provider validation or mutation. This includes malformed JSON, Cloudflare-only and mixed credential payloads; the response discloses no credential fields and stored managed connections remain unchanged ([REQ-ENTERPRISE-306](../../sdd/spec/security.md#req-enterprise-306-enterprise-direct-deploy-credential-boundary) AC1). <!-- @impl: src/routes/deploy-keys.ts::app -->

The following table describes non-Enterprise behavior. Managed GitHub App/OAuth App Connect, disconnect, refresh and administrator provider configuration remain unchanged; the direct-router denial does not revoke or migrate stored credentials.

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token) AC2/AC4 | Return masked deploy credentials, never full tokens; at-rest encryption is conditional on configured platform `ENCRYPTION_KEY` |
| PUT | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token) AC1/AC4–AC6 | Save/update deploy credentials (GitHub PAT, CF API token); shared PUT/DELETE authenticated-owner budget: 20/minute |
| DELETE | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token) AC3 | Erase all deploy credentials; shares the PUT/DELETE authenticated-owner 20/minute budget |

Outside Enterprise, deploy-key mutation exhaustion returns `429 RATE_LIMIT_ERROR` with `Retry-After` and rate-limit advisory headers, before credential/provider I/O. GET does not consume this budget. General resource-protection fallback and stress-bypass policy remain in [REQ-SEC-019](../../sdd/spec/security.md#req-sec-019-per-endpoint-rate-limit-policy). <!-- @impl: src/routes/deploy-keys.ts::mutationRateLimiter -->

At-rest deploy-credential encryption uses the configured platform key; absent `ENCRYPTION_KEY`, storage uses plaintext JSON. Non-Enterprise GET responses remain masked; Enterprise GET requests are denied as above. The deployment key is immutable: key rotation or key-change migration is unsupported; legacy plaintext encryption under the unchanged key is separate ([REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token) AC2/AC4; [REQ-SEC-004](../../sdd/spec/security.md#req-sec-004-credential-encryption-at-rest-cryptographic-contract)).

## GitHub Integration

The GitHub panel (Connect, repository list, clone) is mounted at `/api/github` ([router](../../src/routes/github.ts)); the OAuth callback is mounted separately under `/auth/github`. The repo-panel routes (`/status`, `/repos`, `/clone`) are available in every mode, and the dashboard renders the panel whenever GitHub integration is enabled; there is no advanced-session gate <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> ([REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise)).

**Connect/disconnect are decoupled from the panel** — `/connect` and `/disconnect` use `authMiddleware`; the separate callback reauthenticates the live user and shares a callback limiter with GitHub login. <!-- @impl: src/routes/github-auth.ts::callbackRateLimiter --> All remain available independently of the dashboard panel. Guided Setup retains its existing flow. Settings → Integrations contains Cloudflare only. <!-- @impl: web-ui/src/components/settings/DeployKeysSection.tsx::DeployKeysSection -->

The token is never returned to the browser; `/repos` proxies GitHub server-side, for repositories accessible to the connection ([REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing)). <!-- @impl: src/routes/github.ts::app -->

For OAuth Apps, Recommended and Advanced request `read:org`; Minimal does not. GitHub Apps use their fixed permissions ([REQ-GITHUB-317](../../sdd/spec/github.md#req-github-317-additive-github-connection-and-scope-contract) AC4). <!-- @impl: src/lib/oauth-scopes.ts::githubScopeForTier -->

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/github/status` | Session cookie | [REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing) | Connection state (`enabled`, `configured`, `connected`, `login`, `source`); never the token |
| GET | `/api/github/repos` | Session cookie | [REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing) | The user's accessible repos (owner + collaborator + org member), server-side proxy; `?page=<n>` paginates, 50/page (rate-limited 60/min); `401 NOT_CONNECTED` when no token |
| GET | `/api/github/connect` | Session cookie | [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) | Start the provider authorize flow (302 to GitHub); `?tier=minimal\|recommended\|advanced` maps to the OAuth-App scope; `503 GITHUB_NOT_CONFIGURED` when the provider or state-signing secret is unavailable (rate-limited 20/min) |
| POST | `/api/github/disconnect` | Session cookie | [REQ-GITHUB-005](../../sdd/spec/github.md#req-github-005-disconnect-and-offboarding-revocation) | Attempt GitHub revocation (App/OAuth), then clear the stored token even if revocation fails (rate-limited 20/min) |
| POST | `/api/github/clone` | Session cookie | [REQ-GITHUB-004](../../sdd/spec/github.md#req-github-004-clone-a-repository-into-a-session), [REQ-GITHUB-319](../../sdd/spec/github.md#req-github-319-repository-panel-clone-handoff) | Clone `{repo, ref?, sessionId}` into a running session. Outcomes include `200`, `404 SESSION_NOT_FOUND`, `409 CLONE_TARGET_EXISTS`, `502 CLONE_FAILED`, `503 NOT_RUNNING`, or `504`. `200` persists a validated, stably ordered restore inventory of at most 20; cloning itself is not capped. Separate rate limit: 20/min. |

The OAuth callback is mounted separately under `/auth/github` (`src/routes/github-auth.ts`, registered via `app.route('/auth/github', githubAuthRoutes)` in `src/index.ts`) — it is **not** an `/api/github` route:

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/auth/github/connect/callback` | Session cookie | [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) | Connect-GitHub callback (distinct from SaaS-login `/auth/github/callback`): re-derives identity from the live session, verifies the bucket-bound OAuth state, exchanges the code, persists the repo token to deploy-keys; never mints a session cookie. GitHub App/OAuth App registers this exact URL. |

The **new-session** clone path is not a GitHub route: `POST /api/sessions` accepts an optional `clone: { repo, ref? }` field ([REQ-GITHUB-004](../../sdd/spec/github.md#req-github-004-clone-a-repository-into-a-session)). Under [REQ-GITHUB-014](../../sdd/spec/github.md#req-github-014-clone-created-session-resume), the session retains that directive and sends it during Start configuration. A failed configuration request also blocks Start when the session has tracked targets but no original directive. Actual cloning is separate: terminal startup does not wait for missing targets before releasing the agent; VS Code keeps its prior order. Git failures are logged and remain nonfatal; existing targets are preserved. <!-- @impl: src/routes/container/lifecycle-init.ts::configureContainerDO -->

Under [REQ-GITHUB-015](../../sdd/spec/github.md#req-github-015-workspace-repository-tracking) the session also tracks the GitHub-hosted repositories present at the top of its workspace (up to 20, however they arrived). [REQ-GITHUB-016](../../sdd/spec/github.md#req-github-016-tracked-repository-restoration) attempts absent tracked repositories in order. Terminal release does not wait for these attempts. By default, no new attempt starts after the 180-second overall budget and each started attempt has a separate 120-second timeout. Both are configurable; a per-repository timeout of zero disables that timeout.

## Cloudflare Integration

Per-user "Connect to Cloudflare" OAuth is available in every deployment mode when the shared client is configured. Mounted at `/api/cloudflare` (`src/routes/cloudflare.ts`), whose routes use `authMiddleware` (`requireActiveUser`); pending/blocked users are rejected in app-owned OIDC modes. The callback is mounted separately under `/auth/cloudflare` (`src/routes/cloudflare-auth.ts`) and reauthenticates the live session. Guided Setup and Settings expose connection without an advanced-session entitlement.

When the client is unconfigured, `/api/cloudflare/connect` returns `503 CLOUDFLARE_NOT_CONFIGURED`, and a callback with no provider redirects to `?cloudflare=unavailable` (provider-denial callbacks retain `?cloudflare=denied`). Client configuration enables availability, not owner authorization: callback state remains bound to the initiating user, and status, account selection and disconnection use that owner’s grant. Enterprise Browser Run credentials remain separate. The token is never returned to the browser ([REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)).

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/cloudflare/status` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth), [REQ-AGENT-262](../../sdd/spec/agents.md#req-agent-262-cloudflare-oauth-account-selection-return) AC2 (UI retry context) | Connection state (`configured`, `connected`, `accountId`, `source`); when connected without a selected account, `accounts` is included if discovery succeeds; never the token. <!-- @impl: src/routes/cloudflare.ts::app.get('/status', --> |
| GET | `/api/cloudflare/connect` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) | Start the OAuth authorize flow (302 to `dash.cloudflare.com/oauth2/auth`); `?tier=minimal\|recommended\|advanced` maps to the OAuth scope (always incl. `offline_access`); `503 CLOUDFLARE_NOT_CONFIGURED` when no client configured (rate-limited 20/min) |
| POST | `/api/cloudflare/account` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) AC2/AC4 (token context) | Select the account `{accountId}` for a connected token; `400 ACCOUNT_INVALID` when the token cannot access it (rate-limited 20/min). <!-- @impl: src/routes/cloudflare.ts::app --> <!-- @impl: src/lib/cloudflare-token.ts::setCloudflareAccount --> |
| POST | `/api/cloudflare/disconnect` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) | For OAuth, revoke before clearing; unavailable provider or failed revocation retains local retry state. Non-OAuth/absent credentials can clear without a provider (rate-limited 20/min) |

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/auth/cloudflare/connect/callback` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) | Redirects to `/?error=session-expired` on failed live authentication; otherwise redirects with `?cloudflare=connected\|select-account\|no-accounts\|denied\|expired\|unavailable\|error`. |

The callback re-derives session identity and verifies bucket-bound, single-use OAuth state before exchanging the code. After resolving accessible accounts, it saves the new grant and keeps a valid prior selection or selects the sole accessible account ([REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)).

`select-account` means the new grant is saved but needs an account choice. `error` from a failed account lookup and `no-accounts` leave the saved connection intact. Dashboard returns show choices or retry guidance in Integrations; users still in Guided Setup see them on its Cloudflare card ([REQ-AGENT-262](../../sdd/spec/agents.md#req-agent-262-cloudflare-oauth-account-selection-return), [REQ-AGENT-239](../../sdd/spec/agents.md#req-agent-239-cloudflare-oauth-recovery-preserves-saved-authorization)). The callback never mints a session cookie. Register this exact callback URL.

## Public (Unauthenticated)

In SaaS mode, unauthenticated `GET /` serves prerendered landing assets through the Worker's `/landing/` rewrite. Default mode instead redirects `GET /` to `/app/` and never serves that landing. The canonical marketing URL remains `https://codeflare.ch/`, not `/landing/`; cross-document view transitions apply only to same-origin landing documents when both documents opt in. The SaaS `/login` SPA does not opt in; the onboarding landing-login document can participate. This source contract is not browser-acceptance evidence ([REQ-LANDING-017](../../sdd/spec/landing.md#req-landing-017-mode-aware-landing-dispatch), [REQ-LANDING-003](../../sdd/spec/landing.md#req-landing-003-landing-social-share-and-search-metadata), [REQ-LANDING-004](../../sdd/spec/landing.md#req-landing-004-first-paint-stability-and-immutable-asset-caching)).

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/public/auth/providers` | none | [REQ-AUTH-013](../../sdd/spec/authentication.md#req-auth-013-custom-branded-login-page) AC2–AC3 (login chooser), [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth) AC1 (GitHub login context) | Auth providers (outside CF Access gate) |
| GET | `/public/onboarding-config` | none | [REQ-SETUP-231](../../sdd/spec/setup.md#req-setup-231-deployment-mode-entry) AC1 (onboarding context; handler `src/routes/public/index.ts`) | Turnstile site key + onboarding status |
| GET | `/public/tiers` | none | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) AC3–AC4 (shared tier-config context, not full endpoint coverage) | Tier catalog, including contact-only Custom, with `sessionModes` and optional `advancedPriceMonthly` |
| POST | `/public/waitlist` | none | [REQ-SETUP-231](../../sdd/spec/setup.md#req-setup-231-deployment-mode-entry) AC1 (onboarding context); [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) (limiter infrastructure, not full endpoint coverage) | Waitlist signup with Turnstile (5 requests per 60 seconds by IP, or anonymous fallback; fail-closed limiter). Accepted non-SaaS stress mode bypasses the limiter; SaaS plus stress mode is rejected before routing |
| GET | `/public/contact-config` | none | [REQ-LANDING-002](../../sdd/spec/landing.md#req-landing-002-demo-request-contact-pipeline) | Turnstile site key for the landing contact form (SaaS or onboarding mode) |
| POST | `/public/contact` | none | [REQ-LANDING-002](../../sdd/spec/landing.md#req-landing-002-demo-request-contact-pipeline), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Demo-request submission: Turnstile-verified, relayed to admins as email, never persisted (rate-limited 5/min) |

The login surface calls auth-provider discovery before rendering its choices ([REQ-AUTH-013](../../sdd/spec/authentication.md#req-auth-013-custom-branded-login-page) AC3), making it the primary public discovery call. Check the canonical production deployment without a session:

```sh
curl -fsS https://codeflare.ch/public/auth/providers \
  | jq '{providers: [.providers[] | {id, type, name, loginUrl}]}'
```

The response is `{ "providers": [...] }`; an empty array is valid, including Enterprise mode. No traffic ranking is maintained here: “primary” identifies the login-discovery flow, not a measured most-used endpoint. <!-- @impl: src/index.ts::app -->

| Field | Type and meaning |
|---|---|
| `providers` | Array of available login-provider records |
| `providers[].id` | String provider identifier; direct GitHub mode uses `github` |
| `providers[].type` | String provider type from configured Access IdPs, not a closed enum here; direct GitHub uses `github` |
| `providers[].name` | String display name; direct GitHub uses `GitHub` |
| `providers[].loginUrl` | Optional string, present as `/auth/github/login` in direct GitHub mode |

The jq projection emits `null` for an absent `loginUrl`; that does not add a null-valued field to the raw response or establish a successful live call.

## Discoverability Documents

Served at the deployment root by the Worker (in `src/index.ts`, before the setup-completion gate so crawlers reach them on a fresh instance). The response depends on deployment mode; content is built by pure functions in `src/lib/seo.ts`, with the canonical origin hardcoded to `https://codeflare.ch` so integration/staging hosts never advertise themselves as canonical.

| Method | Path | Auth | Public mode (SaaS / onboarding) | Private mode (neither SaaS nor onboarding) | Implements |
|--------|------|------|----------|----------|------------|
| GET | `/robots.txt` | None | `200` — allows the marketing surface, uses `Disallow` prefixes `/app/`, `/api/`, `/auth/`, and `/setup`, points at `/sitemap.xml`; `/login` remains crawlable so its `noindex` response directive is observed | `200` — disallow-all | [REQ-LANDING-003](../../sdd/spec/landing.md#req-landing-003-landing-social-share-and-search-metadata), [REQ-LANDING-008](../../sdd/spec/landing.md#req-landing-008-login-crawler-exclusion-controls) |
| GET | `/sitemap.xml` | None | `200` — canonical marketing routes (login excluded, it is noindex) | `404` | [REQ-LANDING-003](../../sdd/spec/landing.md#req-landing-003-landing-social-share-and-search-metadata), [REQ-LANDING-008](../../sdd/spec/landing.md#req-landing-008-login-crawler-exclusion-controls) |
| GET | `/llms.txt` | None | `200` — llmstxt.org-convention product summary | `404` | [REQ-LANDING-003](../../sdd/spec/landing.md#req-landing-003-landing-social-share-and-search-metadata) |

Public mode is exactly SaaS **or** onboarding; Enterprise alone remains private, but Enterprise does not independently override combined public flags. Public documents advertise marketing only and exclude protected app routes; they do not expose user data.

The Worker adds `X-Robots-Tag: noindex, nofollow` to login documents served at `/login` or `/login/`; the sitemap omits the login route. The prerendered onboarding login also embeds `noindex, nofollow` in its HTML, including when served from `/landing/login/` ([REQ-LANDING-008](../../sdd/spec/landing.md#req-landing-008-login-crawler-exclusion-controls)).

## Setup

The setup wizard configures a fresh Codeflare deployment. It provisions Cloudflare resources (R2 credentials, DNS records, Access applications) and stores the resulting configuration in Workers KV so the application can serve requests.

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/setup/configure` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration), [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-013](../../sdd/spec/setup.md#req-setup-013-managed-environment-configuration) | Run the setup wizard (streams NDJSON progress) |
| GET | `/api/setup/status` | Public | [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration) | Whether setup is complete (always public) |
| GET | `/api/setup/detect-token` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-008](../../sdd/spec/setup.md#req-setup-008-setup-helper-endpoints-support-prefill-and-detection) | Detect and verify the Cloudflare API token |
| GET | `/api/setup/prefill` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-008](../../sdd/spec/setup.md#req-setup-008-setup-helper-endpoints-support-prefill-and-detection), [REQ-SETUP-013](../../sdd/spec/setup.md#req-setup-013-managed-environment-configuration), [REQ-ENTERPRISE-025](../../sdd/spec/setup.md#req-enterprise-025-active-coding-agents-configured-in-the-setup-wizard) | Prefill setup form without returning managed repository PAT or public-key bytes |

Before Setup completes, [AD10](../decisions/README.md#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation) defines an intentionally unauthenticated bootstrap with relaxed CSRF checks. Once complete, the protected Setup endpoints require an admin-role session; status stays public.

### When Setup Runs

| Scenario | Auth requirement | Entry point |
|---|---|---|
| **First-time setup** (`setup:complete` not set in KV) | Public -- no authentication required | `POST /api/setup/configure` |
| **Reconfigure** (`setup:complete` is `"true"`) | Admin auth via Cloudflare Access | `POST /api/setup/configure` |

The conditional auth middleware in `src/routes/setup/index.ts` checks `KV.get('setup:complete')` on every request. When the value is `"true"`, the request must pass through `authMiddleware` and `requireAdmin` before reaching the configure handler.

### Request Format

```
POST /api/setup/configure
Content-Type: application/json

{
  "customDomain":   "claude.example.com",
  "allowedUsers":   ["alice@example.com", "bob@example.com"],
  "adminUsers":     ["alice@example.com"],
  "allowedOrigins": [".example.com"],
  "managedEnvironment": {
    "enabled": true,
    "repository": "owner/private-curation",
    "personalAccessToken": "github_pat_...",
    "publicKey": "<64 lowercase hex characters>"
  }
}
```

Validation rules (enforced before streaming starts; field shapes use Zod):

- `customDomain` -- non-empty string matching a valid domain pattern.
- `allowedUsers` -- non-empty array of valid email addresses.
- `adminUsers` -- non-empty array of valid emails; every admin must also appear in `allowedUsers`.
- `allowedOrigins` -- optional array of domain suffix patterns (each must start with `.`).
- `managedEnvironment` -- optional strict object. Disabled form is `{ "enabled": false }`. Enabled form requires `owner/name`, a repository-scoped read PAT, and a raw lowercase 64-hex Ed25519 public key.
- `strictGatewayEgress` -- optional boolean. Enabling requires Enterprise and the `EGRESS` binding. Disabling while effective managed-resource policy remains protected returns HTTP 400 before streaming; the same request may transition that policy to mutable ([REQ-SETUP-016](../../sdd/spec/setup.md#req-setup-016-managed-resource-policy-safety)).

The PAT and public key are required on first configuration. Blank values preserve the selected encrypted boundary during reconfiguration. A replacement public key is selected only after the latest immutable release verifies with it without rolling back the active sequence. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment -->

The Cloudflare API token is read from the `CLOUDFLARE_API_TOKEN` environment binding, not from the request body.

### Configuration Steps

The configure endpoint runs steps sequentially, streaming progress over NDJSON.

**Step 1 -- `get_account`**

Source: `src/routes/setup/account.ts`

Calls `GET /accounts` on the Cloudflare API to retrieve the account ID associated with the API token. The first account in the response is used.

**Step 2 -- `derive_r2_credentials`**

Source: `src/routes/setup/credentials.ts`

Derives S3-compatible R2 credentials from the existing API token without needing extra permissions:

- **Access Key ID** = the token's own ID (from `GET /user/tokens/verify`).
- **Secret Access Key** = hex-encoded SHA-256 hash of the raw token value.

**Step 3 -- `set_secrets`**

Source: `src/routes/setup/secrets.ts`

Sets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Worker secrets via `PUT /accounts/{id}/workers/scripts/{name}/secrets`.

If the API returns error code `10215` (latest version not deployed -- common after `wrangler versions upload`), the handler deploys the latest Worker version at 100% traffic and retries the secret write.

Setup reconfiguration does not infer user offboarding from `allowedUsers`; destructive user cleanup is outside this endpoint.

**Optional managed environment step -- `configure_managed_environment`**

**Requirements:** [REQ-SETUP-013](../../sdd/spec/setup.md#req-setup-013-managed-environment-configuration), [REQ-SETUP-014](../../sdd/spec/setup.md#req-setup-014-managed-repository-credential-boundary), [REQ-AGENT-147](../../sdd/spec/agents.md#req-agent-147-signed-managed-agent-configuration-releases), [REQ-STOR-025](../../sdd/spec/storage.md#req-stor-025-managed-deployment-cache-migration), [REQ-STOR-026](../../sdd/spec/storage.md#req-stor-026-managed-deployment-cache-identity)

Creates the deterministic, Worker-identifiable deployment cache bucket with existing R2 credentials, resolves the numeric GitHub repository identity, verifies and caches the first immutable signed release, primes its configuration-fingerprint namespace, encrypts the PAT, and selects the configuration only after the trust boundary is usable. Replacement repository/key namespaces cannot move prior active state; same-trust PAT replacement does not advance an existing active pointer inside the Setup transaction. <!-- @impl: src/lib/remote-curation.ts::configureManagedEnvironment -->

Existing deployments rebuild a verified release in the recognizable bucket before recording a separate operational cache mapping; the selected repository and trust configuration is not rewritten. The exact legacy opaque bucket is emptied and deleted only after the mapping is active, with incomplete cleanup retained for a later resolver retry. Disabling retains cache and credential history for recovery and schedules normal baked reconciliation without offboarding. <!-- @impl: src/lib/remote-curation.ts::prepareManagedCacheMigration --> <!-- @impl: src/lib/remote-curation.ts::cleanupLegacyManagedCache -->

**Step 4 -- `configure_custom_domain`**

Source: `src/routes/setup/custom-domain.ts`

1. **Zone resolution** -- looks up the Cloudflare zone ID by trying progressively shorter domain suffixes (supports ccTLDs like `.co.uk`).
2. **DNS upsert** -- creates or updates a proxied CNAME record pointing the custom domain to `{workerName}.{accountSubdomain}.workers.dev`.
3. **Worker route** -- creates the route pattern `{customDomain}/*` mapped to the worker script. Handles "already exists" errors by updating the existing route.

The DNS record name is relative to the resolved zone (`@` when the hostname equals the zone, otherwise the hostname minus the zone suffix), so a subdomain zone such as `sub.example.com` yields `app` for `app.sub.example.com`.

**Step 5 -- `create_access_app`**

Source: `src/routes/setup/access.ts`

**When GitHub OIDC is NOT configured** (default, or a session-OIDC mode -- SaaS or onboarding -- without `OAUTH_CLIENT_ID`):
1. Upserts mode-appropriate Cloudflare Access groups scoped to the worker name:
   - `{workerName}-admins` -- contains admin emails.
   - `{workerName}-users` -- contains non-admin allowed emails (created only for non-SaaS deployments with non-admin users).
2. Prunes legacy Access apps that used older domain patterns.
3. Creates or updates a self-hosted Access application. Non-Enterprise protects `/app/*` (primary), `/app`, `/api/*`, `/setup`, and `/setup/*`; Enterprise uses a host-scoped application.
4. In non-SaaS mode, upserts an "Allow users" policy referencing the admin and any user group.
   - SaaS without GitHub OIDC instead uses `login_method` policy includes and skips the regular-user group; the Worker applies per-user tier authorization. The admin group is not a SaaS policy include.
5. Stores Access configuration in KV (audience tag, group IDs, auth domain).

**When GitHub OIDC IS configured** (session-OIDC mode -- `SAAS_MODE=active` OR `ONBOARDING_LANDING_PAGE=active` -- plus `OAUTH_CLIENT_ID`):
The `create_access_app` progress slot runs as a no-op and still emits `running` and `success`. <!-- @impl: src/routes/setup/index.ts::runSetupConfiguration --> Setup provisions no CF Access groups, app or policies for this step; GitHub OAuth session cookies handle authentication directly. Provisioning is the part that is skipped under [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence) AC6. The skip mirrors the `isSessionOidcMode` runtime guard, so an onboarding-mode deployment does not get a stray Access app whose edge 302 would break the credential-less vault service-worker registration. Admin users created via allowedUsers are assigned the Custom tier automatically.

**Step 6 -- `configure_turnstile` (conditional)**

Source: `src/routes/setup/turnstile.ts`

Runs only when the `ONBOARDING_LANDING_PAGE` env var is active OR SaaS mode is enabled. Creates or updates a Turnstile widget in `managed` mode for the custom domain (and the workers.dev hostname). Stores the site key and secret in KV.

**Enterprise steps (conditional, `ENTERPRISE_MODE` only)**

Source: `src/routes/setup/index.ts`

Each runs only when its field is present in the request body, so unrelated reconfigures stay quiet:

- `configure_access_groups` — persists the user/admin Access-group name lists (CSV-joined; an empty list clears the key). [REQ-ENTERPRISE-010](../../sdd/spec/authentication.md#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-312](../../sdd/spec/setup.md#req-enterprise-312-admin-access-group-configuration)
- `configure_model_routing` — persists the route catalog, defaults, per-route context and capability-profile assignments, and per-group routing. [REQ-ENTERPRISE-012](../../sdd/spec/setup.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-013](../../sdd/spec/models-and-routing.md#req-enterprise-013-per-group-dynamic-routing), [REQ-ENTERPRISE-022](../../sdd/spec/models-and-routing.md#req-enterprise-022-per-route-context-windows-for-dynamic-routes), [REQ-ENTERPRISE-031](../../sdd/spec/models-and-routing.md#req-enterprise-031-enterprise-pi-capability-profile-administration)

The Setup compatibility shape still reads historical `routeReasoningProfiles`. GLM and Kimi IDs propose `workers-ai-glm-thinking` and `workers-ai-kimi-k-thinking` assignments respectively; GPT-OSS remains unresolved and requires administrator reassignment. No proposal is persisted before Apply writes the complete `setup:reasoning_configuration` document, and every catalog route still requires a positive context window and executable assignment.

- `configure_ai_gateway` — persists the canonical AI Gateway URL and, for account API URLs, its gateway name (both plain), plus the token (encrypted at rest, no-clobber on blank). Legacy full gateway URLs remain supported. [REQ-ENTERPRISE-017](../../sdd/spec/setup.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)
- `configure_browser_rendering` — persists the admin Browser Rendering account id and token (encrypted when `ENCRYPTION_KEY` is configured, AD32 plaintext fallback otherwise; presence-only prefill and no-clobber on blank, with no masked-save sentinel). [REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)
- `configure_strict_egress` — writes `setup:strict_egress` as `'active'`/`'inactive'` after the pre-stream protected-policy check. [REQ-ENTERPRISE-310](../../sdd/spec/setup.md#req-enterprise-310-configure-strict-gateway-egress), [REQ-SETUP-016](../../sdd/spec/setup.md#req-setup-016-managed-resource-policy-safety)
- `configure_r2_sse` — writes `setup:r2_sse_disabled` as `'active'`/`'inactive'`. [REQ-ENTERPRISE-018](../../sdd/spec/storage.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface)
- `configure_downloads_disabled` — writes `setup:downloads_disabled` as `'active'`/`'inactive'`. [REQ-ENTERPRISE-309](../../sdd/spec/setup.md#req-enterprise-309-configure-view-only-storage)
- `configure_active_agents` — validates the selection against build-installed, gateway-capable coding agents (rejects empty, non-capable, or omitted CLIs) and writes `setup:active_agents` as a JSON array. [REQ-ENTERPRISE-025](../../sdd/spec/setup.md#req-enterprise-025-active-coding-agents-configured-in-the-setup-wizard), [REQ-AGENT-123](../../sdd/spec/agents.md#req-agent-123-installed-agent-runtime-availability)

**Step 7 -- `finalize`**

Writes final KV state and marks setup as complete.

These are canonical provisioning slots, not a promise that every mode emits seven placeholder rows. Conditional Turnstile, cleanup and enterprise extension steps appear when applicable. Attempted steps retain source order; `create_access_app` still emits progress in session OIDC without provisioning Access.

### NDJSON Stream Contract

The response uses content type `application/x-ndjson`. Each line is a self-contained JSON object terminated by `\n`.

**Progress messages**

```json
{"step":"get_account","status":"running"}
{"step":"get_account","status":"success"}
{"step":"derive_r2_credentials","status":"running"}
{"step":"derive_r2_credentials","status":"success"}
```

Status values for in-progress steps:

| Value | Meaning |
|---|---|
| `running` | Step has started |
| `success` | Step completed successfully |
| `error` | Step failed; includes an `error` field with the message |

**Completion message**

Every stream ends with exactly one completion object containing `done: true`.

**Success (example showing two of the returned steps):**

```json
{
  "done": true,
  "success": true,
  "steps": [
    {"step":"get_account","status":"success"},
    {"step":"derive_r2_credentials","status":"success"}
  ],
  "workersDevUrl": "https://codeflare.account.workers.dev",
  "customDomainUrl": "https://claude.example.com"
}
```

`workersDevUrl` is the legacy name for the HTTPS URL of the host that received the Setup request. In this initial Setup example, that host is the `workers.dev` entry URL. If the request is sent to `claude.example.com` during reconfiguration, `workersDevUrl` is `https://claude.example.com` instead. `customDomainUrl` is the domain configured by Setup and the link the wizard uses on success. Neither response field changes how Setup resolves the DNS target. [REQ-SETUP-011](../../sdd/spec/setup.md#req-setup-011-setup-stream-completion-payload-contract) <!-- @impl: src/routes/setup/index.ts::runSetupConfiguration --> <!-- @impl: web-ui/src/stores/setup.ts::setupStore -->

**Failure:**

```json
{
  "done": true,
  "success": false,
  "steps": [
    {"step":"get_account","status":"success"},
    {"step":"derive_r2_credentials","status":"error","error":"Failed to derive R2 credentials"}
  ],
  "error": "Failed to derive R2 credentials"
}
```

**Detecting completion**

Read lines from the stream until you parse an object where `done === true`. Then check `success` to determine the outcome. The `steps` array provides the cumulative status of every step attempted, including which step failed and the error message.

**Detecting lock contention**

If another configure run is already in progress, the stream immediately emits:

```json
{"done":true,"success":false,"error":"Setup configuration is already in progress. Please wait and try again."}
```

No step progress messages are sent in this case. An active Environment run likewise returns a terminal refusal without `steps` or provisioning, with the distinct error `An Environment settings change is already in progress. Please wait and try again.` The Setup coordinator `setup:configuration` owns Setup-versus-Setup exclusion and durable input-bound recovery. Setup checks for an active Environment run before provisioning; that check is separate from the Setup lock. See [REQ-SETUP-004](../../sdd/spec/setup.md#req-setup-004-setup-is-idempotent) and [REQ-SETUP-011](../../sdd/spec/setup.md#req-setup-011-setup-stream-completion-payload-contract) AC3. <!-- @impl: src/container/index.ts::configureDeployment --> <!-- @impl: src/routes/setup/index.ts::runSetupConfiguration --> Successful completion releases admission; a fresh definite terminal `ValidationError` or known pre-provisioning refusal because an Environment run is active also releases fresh admission after all started operations settle. Wait for the active run to finish before resubmitting.

Uncertain provider/transport outcomes or interruption retain the original configuration fingerprint: resubmit that same validated configuration through the authorized route until success. A later validation failure or pre-provisioning refusal does not release a previously uncertain task. Different input is refused with a terminal `success: false` recovery message. There is no TTL takeover or reset endpoint; the NDJSON envelope is unchanged.

### Error Recovery

On step failure, the handler sends terminal completion with `success: false`, the cumulative attempted-step list and error details, then closes the stream. Partial KV progress remains. Initial setup is not marked complete by a failed run; failed admin reconfiguration preserves an existing `setup:complete = "true"` and remains admin-gated rather than reopening bootstrap.

Operator retry and lock diagnosis belong in [Troubleshooting: setup configure fails or appears locked](troubleshooting.md#setup-configure-fails-or-appears-locked). The [NDJSON stream contract](#ndjson-stream-contract) above owns request completion/failure and lock-contention responses.

### KV State Management

The following KV keys are written during setup. All keys use the `setup:` prefix.

| KV Key | Written by | Value |
|---|---|---|
| `setup:complete` | finalize | `"true"` |
| `setup:account_id` | finalize | Cloudflare account ID |
| `setup:r2_endpoint` | finalize | `https://{accountId}.r2.cloudflarestorage.com` |
| `setup:completed_at` | finalize | ISO 8601 timestamp |
| `setup:custom_domain` | post-step-5 | Lowercased custom domain |
| `setup:allowed_origins` | post-step-5 | JSON array of origin suffix patterns |
| `setup:onboarding_landing_page` | post-step-5 | `"active"` or `"inactive"` |
| `setup:configuring` | configure task | Compatibility/status timestamp only; best-effort deletion on settlement, never admission authority |
| `setup:access_aud` | step 5 | Primary Access audience tag |
| `setup:access_aud_list` | step 5 | JSON array of audience tags |
| `setup:access_app_id` | step 5 | Access application ID |
| `setup:access_group_admin_id` | step 5 | Admin Access group ID |
| `setup:access_group_user_id` | step 5 | User Access group ID |
| `setup:access_group_admin_name` | step 5 | Admin group name (`{worker}-admins`) |
| `setup:access_group_user_name` | step 5 | User group name (`{worker}-users`) |
| `setup:auth_domain` | step 5 | Access organization auth domain |
| `setup:turnstile_site_key` | step 6 | Turnstile widget site key |
| `setup:turnstile_secret_key` | step 6 | Turnstile widget secret |
| `setup:idp_list` | step 5 | JSON array of IdP objects (id, type, name) |

User records are stored separately under `user:{email}`. Setup writes `addedBy`, `addedAt`, and persisted `role` (`"admin"` or `"user"`). Ordinary non-SaaS nonadmin records omit stored tier fields; reader defaults do not imply those fields were persisted. Non-SaaS admins also store `subscriptionTier: "unlimited"` and legacy `accessTier: "advanced"`; SaaS setup merges existing records and writes both tier fields as `"unlimited"`. Usage tracking data is stored at `timekeeper:{bucketName}`. Tier configuration is at `tiers:config`.

### Authentication

**First-time setup**

When `setup:complete` is not set in KV, all setup endpoints are publicly accessible. This is necessary for bootstrapping -- no Access application exists yet to authenticate against.

**Subsequent reconfiguration**

Once `setup:complete` is `"true"`, the conditional auth middleware requires:

1. Valid authentication (CF Access JWT or OIDC session cookie, verified by `authMiddleware`).
2. The authenticated user must have the `admin` role (enforced by `requireAdmin`).

This applies to `POST /api/setup/configure`, `GET /api/setup/detect-token`, and `GET /api/setup/prefill`. The `GET /api/setup/status` endpoint is always public.

### Helper Endpoints

**`GET /api/setup/status`**

Always public. Returns whether setup is complete, the custom domain when configured, and deploy-time SaaS, Enterprise, and Onboarding mode flags. <!-- @impl: src/routes/setup/handlers.ts::default -->

```json
{"configured": true, "customDomain": "claude.example.com", "saasMode": false, "enterpriseMode": false, "onboardingMode": true}
```

**`GET /api/setup/detect-token`**

Checks whether `CLOUDFLARE_API_TOKEN` is present in the environment, verifies it against the Cloudflare API, and returns account info.

```json
{"detected": true, "valid": true, "account": {"id": "abc123", "name": "My Account"}}
```

**`GET /api/setup/prefill`**

Provider prefill carries `githubProviderType`, `githubAppClientId`, `githubOauthClientId`, and Boolean `githubAppClientSecretSet` / `githubOauthClientSecretSet` flags, never either secret. The flags report stored presence, not a new credential-validation probe ([REQ-GITHUB-008](../../sdd/spec/github.md#req-github-008-enterprise-github-provider-configuration-via-setup)).

Best-effort prefill for the setup form. Reads existing admin and user lists from Cloudflare Access groups (scoped by worker name). Does not prefill the custom domain.

SaaS returns empty group arrays. Non-SaaS Access-group excerpt:

```json
{"adminUsers": ["alice@example.com"], "allowedUsers": ["bob@example.com"]}
```

Enterprise configure/prefill uses `dynamicRoutes` for the catalog; Configure rejects an absent or empty enterprise catalog with 400 before KV writes. Prefill is read-only: it initializes the route catalog to `[]` and the default route to `null`, reads the catalog first, and retains a successfully read catalog if the subsequent default-route read throws. This fallback handles read or parse failures; it does not validate a stored value that parses successfully into the wrong shape. <!-- @impl: src/routes/setup/handlers.ts::handlers.get('/prefill', --> Gateway prefill carries non-secret `aigGatewayUrl`, optional `aigGatewayId` and masked-presence `aigTokenSet`, never its token; absent storage reports unset/empty. These Gateway fields are omitted outside enterprise mode ([REQ-ENTERPRISE-012](../../sdd/spec/setup.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-017](../../sdd/spec/setup.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)).

`r2SseDisabled` and `downloadsDisabled` are enterprise-only Setup booleans round-tripped by prefill. Their `configure_r2_sse` / `configure_downloads_disabled` steps store `'active'`/`'inactive'`; non-enterprise configure never writes them, and prefill omits them. Download-disable prefill is true for active stored policy and false when absent ([REQ-ENTERPRISE-018](../../sdd/spec/storage.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface), [REQ-ENTERPRISE-309](../../sdd/spec/setup.md#req-enterprise-309-configure-view-only-storage)).

Under `ENTERPRISE_MODE` the response additionally carries the stored enterprise configuration for wizard round-trip: Access groups, route catalog, context windows, capability-profile assignments, masked token flags, and toggles. Legacy GLM/Kimi assignments are surfaced as unpersisted migration proposals; GPT-OSS is surfaced unresolved rather than silently activated. The response also includes `activeAgents` (the stored coding-agent selection intersected with installed CLIs, or every installed capable agent when absent/invalid) and `configurableAgents` (the build-installed subset of the governable `copilot`, `pi` universe); both agent fields are omitted outside enterprise mode ([REQ-ENTERPRISE-025](../../sdd/spec/setup.md#req-enterprise-025-active-coding-agents-configured-in-the-setup-wizard), [REQ-ENTERPRISE-031](../../sdd/spec/models-and-routing.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-AGENT-123](../../sdd/spec/agents.md#req-agent-123-installed-agent-runtime-availability)).

Enterprise prefill excerpt:

```json
{"adminUsers":["alice@example.com"],"allowedUsers":[],"dynamicRoutes":["development"],"routeContextWindows":{"development":262144},"routeReasoningProfiles":{},"reasoningMigration":{"persisted":false,"errors":[{"code":"legacy_profile_unresolved","route":"development","message":"GPT-OSS tool replay is unsupported; select another profile"}]},"activeAgents":["pi"],"configurableAgents":["copilot","pi"]}
```

### Rate Limiting

| Endpoint | Window | Max requests | Key prefix |
|---|---|---|---|
| `/api/setup/configure` | 60 s | 5 | `setup-configure` |
| `/api/setup/status` | 60 s | 30 | `setup-status` |
| `/api/setup/detect-token` | 60 s | 10 | `setup-detect-token` |
| `/api/setup/prefill` | 60 s | 10 | `setup-prefill` |

Note: `/api/setup/detect-token` and `/api/setup/prefill` are also subject to the shared `setupRateLimiter` (5/min, key prefix `setup-configure`) applied as middleware. The effective limit is 5/min for these endpoints during the setup flow.

## Storage (R2 File Browser)

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/storage/browse` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | Return one page of objects and directory prefixes. For a truncated result with `nextContinuationToken`, request the next page with the same `prefix` and that value as `continuationToken`. |
| POST | `/api/storage/upload` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) AC2 | Upload file |
| GET | `/api/storage/download` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser), [REQ-SEC-013](../../sdd/spec/security.md#req-sec-013-content-disposition-hardening-on-downloads), [REQ-ENTERPRISE-019](../../sdd/spec/storage.md#req-enterprise-019-view-only-storage-download-disable) | Download file as an attachment; with `?disposition=inline` serves it inline for in-browser viewing (XSS-safe content-type + nosniff). View-only storage on: attachment `403 DOWNLOADS_DISABLED`, non-viewable blob `403` even inline |
| POST | `/api/storage/delete` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | Delete keys and/or prefixes in one request. The response separates confirmed keys, completed prefixes with counts, and errors. A prefix error does not undo earlier deletions. |
| GET | `/api/storage/preview` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | Preview recognized text inline only for a successful GET of at most 1 MiB. Oversized or non-text objects return `type: "binary"` metadata without `content`. When an oversized stream has no reliable length, its reported size is a lower bound. |
| GET | `/api/storage/stats` | Session cookie | [REQ-STOR-006](../../sdd/spec/storage.md#req-stor-006-storage-quota-enforced-per-tier-at-session-start), [REQ-STOR-014](../../sdd/spec/storage.md#req-stor-014-r2-storage-stats-caching) | File/folder counts (60s KV cache, refreshes from R2 on miss/stale) |
| POST | `/api/storage/seed/getting-started` | Session cookie | [REQ-STOR-009](../../sdd/spec/storage.md#req-stor-009-getting-started-docs-auto-seeded-on-first-session), [REQ-AGENT-032](../../sdd/spec/agents.md#req-agent-032-starter-documentation-manually-recreatable-from-settings) | Seed tutorial docs; requested by Recreate starter documentation; [storage-seed rate limit](../../sdd/spec/security.md#req-sec-019-per-endpoint-rate-limit-policy) |
| POST | `/api/storage/seed/agent-configs` | Session cookie | [REQ-AGENT-011](../../sdd/spec/agents.md#req-agent-011-agent-skills--rules-manually-recreatable-from-settings) (explicit rescue); [REQ-STOR-024](../../sdd/spec/storage.md#req-stor-024-managed-release-application) (managed application) | Recreate AI agent skills & rules (overwrites every desired path and respects session mode); [storage-seed rate limit](../../sdd/spec/security.md#req-sec-019-per-endpoint-rate-limit-policy) |
| POST | `/api/storage/seed/agent-configs/upgrade` | Session cookie | [REQ-STOR-033](../../sdd/spec/storage.md#req-stor-033-managed-release-delta-planning-and-resume), [REQ-STOR-034](../../sdd/spec/storage.md#req-stor-034-observational-managed-reconciliation-progress-writes), [REQ-STOR-035](../../sdd/spec/storage.md#req-stor-035-managed-reconciliation-cleanup-and-finalization), [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release) | Dashboard-owned automatic reconcile; managed releases use a direct delta or marker-resumable full target and return matching completion progress when available, while baked upgrades keep their existing reconcile behavior |
| POST | `/api/storage/upload/initiate` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Initiate multipart upload |
| POST | `/api/storage/upload/part` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Upload a single part (`content` is base64 in a JSON body). The 100 MiB limit applies to the encoded request, not the decoded part. |
| POST | `/api/storage/upload/complete` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Complete the admitted upload. An unknown or stale ID returns `409 MULTIPART_RESTART_REQUIRED` without deleting parts. A lost or unverifiable provider result retains a pending-completion fence. |
| POST | `/api/storage/upload/abort` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Request abort by object key and upload ID. Only recovery matching the stored pending completion treats R2's definitive `404` as confirmed absence. |

Multipart schemas and part-size envelope are unchanged. Initiation records a bucket-owner/key/regime/generation-bound ID; platform phases serialize with migration at the existing bucket DO. Unknown, legacy or stale part/completion IDs return `409 MULTIPART_RESTART_REQUIRED` without deleting parts. Lost, malformed or unverifiable completion retains a durable pending fence and blocks migration. Explicit matching abort can recover that fence during migration; provider acceptance or definitive 404 absence confirms recovery. Ordinary abort still rejects non-2xx. Provider migration cleanup is capped at 100 uploads without continuation, fails closed on discovery/abort failure, and is not universal external-upload tracking. Direct R2 writers require maintenance quiescence; dual-regime reads remain independent safeguards.

## Preferences

| Method | Path | Auth | Implements | Description |
|--------|------|------|------------|-------------|
| GET | `/api/preferences` | Session cookie | [REQ-ENTERPRISE-001](../../sdd/spec/subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env) (storage context), [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) AC5/AC7, [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions) (creation context) | Return the authenticated user's stored preferences, with effective enterprise session mode applied and legacy preset state and the internal reconciliation journal omitted. <!-- @impl: src/routes/preferences.ts::app.get('/', --> |
| PATCH | `/api/preferences` | Session cookie | [REQ-MEM-011](../../sdd/spec/memory.md#req-mem-011-session-mode-storage-resolution-and-propagation), [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env), [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) AC4/AC7, [REQ-ENTERPRISE-001](../../sdd/spec/subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions), [REQ-AGENT-249](../../sdd/spec/agents.md#req-agent-249-session-mode-seed-reconciliation) | Strictly validate and merge supplied preference fields, persist them, reconcile agent configs after a mode change, and return the effective preferences. Limited to 20 requests/minute per rate-limit key. |

`UserPreferences` fields:

| Field | Contract |
|---|---|
| `lastAgentType` | Optional `AgentType`; last selected agent. |
| `workspaceSyncEnabled` | Boolean, default `false`; workspace sync toggle. |
| `fastStartEnabled` | Boolean, default `true`; maps to `FAST_CLI_START` in the container DO. See [Fast Start](container.md#fast-start). |
| `sessionMode` | Optional `SessionMode`; default or advanced. Changes trigger `reconcileAgentConfigs(overwrite: true, cleanup: true)`. Under `ENTERPRISE_MODE`, GET and PATCH responses report `'advanced'` regardless of the stored value (computed via `withEffectiveSessionMode`, not persisted); see [REQ-ENTERPRISE-001](../../sdd/spec/subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2. |
| `defaultWorkspace` | `terminal` or `vscode`; defaults to `terminal`. VS Code requires Advanced entitlement. Switching to Standard atomically stores `sessionMode: 'default'` and `defaultWorkspace: 'terminal'`; existing session snapshots are unchanged. See [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions). |
| `sleepAfter` | Optional `SleepAfterOption`; auto-sleep duration. See [Auto-sleep](container.md#auto-sleep-configurable-sleepafter). |
| `userTimezone` | Optional valid IANA timezone, max 64 chars; invalid zones return `ValidationError`. |
| `lastPreseedHash` | Optional SHA-256 prefix of preseed content at last successful reconcile; compared on dashboard load to detect release upgrades. |

`userTimezone` is validated by `Intl.DateTimeFormat` round-trip, persisted to DO storage, and forwarded to the container as `USER_TIMEZONE`; it takes effect on the next session start so memory-capture filenames reflect the user's local time. See [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env) and [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC4.

When `sessionMode` changes, `PATCH /api/preferences` seeds the correct preseed set for the new mode. Without a managed environment, reconciliation failure is nonfatal and does not block the preference save. Managed reconciliation failures propagate. On non-conflict failure, the Worker attempts to restore prior preferences without discarding the target journal; a rollback read or write failure is logged without replacing the original reconciliation error. Conflicts preserve newer preferences without publishing stale applied state. See [REQ-AGENT-249](../../sdd/spec/agents.md#req-agent-249-session-mode-seed-reconciliation) AC1/AC2/AC4/AC5. `lastPreseedHash` supports release-upgrade detection; see [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release).

Under enterprise mode, the response's `sessionMode` is always `'advanced'`. GET computes that value through `withEffectiveSessionMode` without persisting it.

`PATCH` also coerces a supplied `sessionMode` to stored `'advanced'`, so a stale client cannot persist a downgrade or reconcile a live bucket to default mode. Omitting `sessionMode` leaves the stored preference unchanged. This keeps advanced-gated Browser IDE and Vault controls visible for JIT-provisioned enterprise users. See [REQ-ENTERPRISE-001](../../sdd/spec/subscription.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2.

## LLM API Keys

| Method | Path | Auth | Implements | Description |
|--------|------|------|------------|-------------|
| GET | `/api/llm-keys` | Session cookie | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv), [REQ-AGENT-118](../../sdd/spec/agents.md#req-agent-118-enterprise-consult-llm-unavailability) | Return masked keys (`****` alone for keys of four characters or fewer; otherwise append the last four), never full keys; enterprise mode returns `403` before LLM-key KV access. |
| PUT | `/api/llm-keys` | Session cookie | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv), [REQ-AGENT-118](../../sdd/spec/agents.md#req-agent-118-enterprise-consult-llm-unavailability) | Set or clear `{ openaiApiKey?: string \| null, geminiApiKey?: string \| null }`; `null` deletes, omission preserves, strings validate and set, and the response masks stored keys. With `ENCRYPTION_KEY`, values use AES-256-GCM; enterprise mode returns `403` before LLM-key KV access. |
| DELETE | `/api/llm-keys` | Session cookie | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv) (storage context), [REQ-AGENT-118](../../sdd/spec/agents.md#req-agent-118-enterprise-consult-llm-unavailability) | Remove all LLM keys from KV and return `{ success: true }`; enterprise mode returns `403` before LLM-key KV access. <!-- @impl: src/routes/llm-keys.ts::app.delete --> <!-- @impl: src/routes/llm-keys.ts::app.use --> |

Enterprise deployments reject per-user LLM-key management under [REQ-AGENT-118](../../sdd/spec/agents.md#req-agent-118-enterprise-consult-llm-unavailability) AC2. <!-- @impl: src/routes/llm-keys.ts::app.use -->

Keys are stored in KV as `llm-keys:{bucketName}` and scoped per user (derived from auth). On container start, keys are read from KV and injected only as `CODEFLARE_OPENAI_API_KEY` / `CODEFLARE_GEMINI_API_KEY`; `entrypoint.sh` maps them back to bare provider env names only inside the scoped `consult-llm-mcp` server config for Claude (`~/.claude.json`) and Pi (`~/.pi/agent/mcp-adapter.json`). The LLM Keys accordion in Settings is only visible when the user can use advanced mode (`canUseAdvanced()`) AND has selected advanced session mode (`currentSessionMode() === 'advanced'`). Admins always qualify for advanced mode but must still select it.

## Public (Onboarding)

GET `/public/onboarding-config`, POST `/public/waitlist` (rate limited; onboarding mode only)

## Public (Landing)

The landing contact surface ([REQ-LANDING-002](../../sdd/spec/landing.md#req-landing-002-demo-request-contact-pipeline)). Both endpoints are gated on SaaS **or** onboarding mode and return `404` when neither is active. Enterprise alone is private, but combined Enterprise/public flags do not override this predicate.

### Contact relay acceptance

For REQ-LANDING-002 AC2/AC4/AC5/AC7, separately authorize contact submissions, provider calls and delivery to existing disposable admin inboxes. Check contact availability on approved SaaS/onboarding targets and 404 where neither public flag is active (including Enterprise-only); waitlist stays onboarding-only. Submit one non-sensitive valid inquiry through Turnstile. Inspect all configured admin deliveries: reply-to must be the submitter, and user markup must render escaped, never execute.

Trace the current contact handler and limiter/email calls to verify content is not stored and only limiter bookkeeping reaches KV. Include accepted-contact and verification-failure logging: application diagnostics contain no submission fields, including email (full or masked) and topic. The source-level logging regression checks this minimization; it does not establish deployed log settings, production-log contents or email delivery. Delivery alone cannot prove non-persistence. Pass only if every branch and storage sink preserves these privacy/abuse boundaries. Missing safe inboxes or mode targets remain unverified; never email real users, replay submissions or export secrets to complete this check.

### GET `/public/contact-config`

Exposes only the public Turnstile site key for the landing form widget.

```json
{ "turnstileSiteKey": "0x4AAA..." }
```

`turnstileSiteKey` is `null` when no site key is configured.

### POST `/public/contact`

Demo-request submission: Turnstile-verified, relayed to all admin users as email (reply-to set to the submitter), and **never persisted** — the only KV writes on this path are rate-limiter bookkeeping. Accepted-contact and verification-failure application logs omit submission fields, including email (full or masked) and topic. Rate-limited to **5 requests/minute per client IP** (`contact-submit` bucket).

Request body (JSON):

| Field | Type | Constraints |
|-------|------|-------------|
| `name` | string | required, 1–100 chars |
| `email` | string | required, valid email, ≤254 chars |
| `company` | string | optional, ≤200 chars (omitted from payload when blank) |
| `topic` | string | required, one of the shared `CONTACT_TOPICS` enum (`src/lib/contact-topics.ts`) |
| `message` | string | required, 10–4000 chars |
| `turnstileToken` | string | required (Turnstile widget token) |

Responses:

- `200` — `{ "success": true }` on accepted submission.
- `400` — `VALIDATION_ERROR`: malformed body, a field failing the constraints above, **or** an unsuccessful Turnstile verdict (`CAPTCHA verification failed`). A non-2xx Turnstile reply is also treated as an unsuccessful verdict.
- `429` — rate limit exceeded (5/min).
- `500` — a Turnstile transport or JSON-decoding error reaches the Worker error handler; no email is sent. This is not a CAPTCHA validation verdict.
- `502` — `CONTACT_EMAIL_FAILED`: the Resend outbound relay returned a non-2xx response (retryable).
- `503` — `CONTACT_NOT_CONFIGURED` / `CONTACT_NO_ADMIN_RECIPIENT`: Turnstile/Resend secrets absent or no admin recipient configured (same degradation contract as the waitlist).
- `404` — neither SaaS nor onboarding mode is active.

## Health

| Method | Path | Auth | Implements | Owner | Contract |
|---|---|---|---|---|---|
| GET | `/api/health` | Public | — | Worker | `{ "status": "ok", "timestamp": "..." }` <!-- @impl: src/index.ts::app --> |
| GET | `/api/container/health` | Session cookie | [REQ-SESSION-017](../../sdd/spec/session-lifecycle.md#req-session-017-container-health-and-startup-status-api) AC1 | Container status route | `{ success, containerId, container }`; `container` is the private host-health observation <!-- @impl: src/routes/container/status.ts::app --> |
| GET | private host `/health` | Anonymous minimal response; lifecycle Bearer for rich health | [REQ-SEC-022](../../sdd/spec/security.md#req-sec-022-container-proxy-bearer-validation) AC3 | Host runtime | Rich host readiness, sync, prewarm, and metric observations; not a public Worker route <!-- @impl: host/src/request-router.ts::createRequestHandler --> |

There is no public `/health` alias, and `/api/health` does not proxy the container. Use `/api/container/health` for an authenticated session-specific observation.

Anonymous GET `/health` returns only `{ "status": "healthy" }` before protected reads; an invalid supplied bearer is denied. `/activity` requires the lifecycle bearer before heartbeat mutation. Current metrics collection uses authenticated `/internal/runtime-observation`, not `/activity` or `/health`. The authenticated private host `/health` body contains:

| Field | Meaning |
|---|---|
| `status` | Host health state (`healthy` on a successful response) |
| `sessions` | Current host terminal-session count |
| `uptime` | Host process uptime in seconds |
| `syncStatus` / `syncError` / `userPath` | Current synchronization observation and local user path |
| `prewarmReady` | Whether agent prewarm reached readiness |
| `initFlagObserved` | Whether the container init-complete flag was observed |
| `terminalServiceReady` | Whether the terminal service is ready |
| `cpu` / `mem` / `hdd` | Host metric observations |
| `timestamp` | Response-generation time in ISO-8601 form |

`prewarmReady: false` together with `initFlagObserved: false` means the init-complete flag was never observed. See [Container Startup](container.md#startup-sequence) and [Troubleshooting](troubleshooting.md#container-stuck-at-waiting-for-services) for diagnosis.

---

<a id="specification-coverage"></a>
## Requirement and Source Map

Exhaustive requirement status remains in the active SDD domains. Endpoint rows carry clause-local `Implements` links; this map identifies each resource family's authoritative handler and contract owner without duplicating a selective coverage ledger.

| Resource family | Handler/source owner | Normative domains | Specialist documentation |
|---|---|---|---|
| Sessions and container lifecycle | `src/routes/session/`, `src/routes/container/` | Session Lifecycle, Operations | [Container](container.md), [Storage & Sync](storage-and-sync.md) |
| Terminal and Browser IDE | Worker proxy routes plus private host request router | Terminal, Browser IDE | [Container](container.md), [Terminal & IDE](terminal-and-ide.md) |
| Vault and storage | `src/routes/vault/`, `src/routes/storage/` | Vault, Storage, Security | [Vault](vault.md), [Storage & Sync](storage-and-sync.md) |
| Users, authentication, usage, and billing | auth/user/billing routes plus Timekeeper | Authentication, Subscription | [Identity & Access](authentication.md), [Billing](billing.md) |
| Provider integrations and credentials | GitHub/Cloudflare/deploy-key/LLM-key routes | GitHub, Agents, Security | [Security](security.md), [Configuration](configuration.md) |
| Setup and discovery | setup/public/discoverability routes | Setup, Landing, Operations | [Configuration](configuration.md), [Architecture](architecture.md) |

Grouped endpoint tables are valid contract records when their resource section declares the shared handler and the row provides method/path, authentication, requirement, and observable contract. Complex request/response/error schemas remain expanded directly below their route group.

---

## Related Documentation

- [Authentication](authentication.md#three-tier-auth-middleware) - Auth middleware details
- [Security](security.md#rate-limiting) - Rate limits per endpoint
- [Configuration](configuration.md#worker-environment) - Environment variables
