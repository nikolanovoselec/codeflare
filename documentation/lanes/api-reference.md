# API Reference

Public Worker, authenticated proxy, and integration endpoint contracts for Codeflare. Private host-only routes are identified but owned by the runtime lanes.

**Audience:** Developers

**Owns:** method, public path, authorization, request, response, error, rate-limit, requirement, and handler contracts. **Does not own:** provisioning implementation, private host mechanics, deployment values, or security rationale.

## Contents

- [Conventions](#conventions)
- [Session Management](#session-management)
- [Container Lifecycle](#container-lifecycle)
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
| Host `/health`, `/activity`, `/terminal` | Private container-server routes reached through the Durable Object or Worker proxy. Host metrics are fields in `/health`, not a separate `/metrics` route. Runtime mechanics belong to [Container](container.md). |
| Worker and host `/api/vscode/:sessionId/*` | Authenticated Worker route with private forwarding to the same host path; IDE process and proxy mechanics belong to [Architecture Internals](architecture-internals.md#browser-ide-internals). |

Route paths in this reference are externally callable only where their row says so; a private host path is not an alternate public endpoint.

### Common Response Headers

| Header | Description |
|--------|-------------|
| `X-Request-ID` | Unique request identifier (UUID) |
| `X-RateLimit-Limit` | Max requests per window (rate-limited endpoints) |
| `X-RateLimit-Remaining` | Requests remaining (rate-limited endpoints) |

### Error Response Format

```json
{ "error": "User-friendly message", "code": "ERROR_CODE" }
```

Codes: `NOT_FOUND` (404), `VALIDATION_ERROR` (400), `CONTAINER_ERROR` (500), `AUTH_ERROR` (401), `FORBIDDEN` (403), `SETUP_ERROR` (400), `RATE_LIMIT_ERROR` (429), `QUOTA_EXCEEDED` (402), `CIRCUIT_BREAKER_OPEN` (503).

Note: `SETUP_ERROR` uses a different response shape: `{ success: false, steps, error, code }` instead of the standard `{ error, code }`.

## Session Management

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/sessions` | Session cookie | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard) | List sessions |
| POST | `/api/sessions` | Session cookie | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard), [REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions) | Create session record (10 requests/user/minute; snapshots the server-owned entitled default workspace; strict body validation rejects client-supplied `workspace`; does not consume a concurrent-running slot; under enterprise mode `agentType` outside the wizard-governed allowlist is rejected 400) |
| GET | `/api/sessions/:id` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions) | Get session |
| PATCH | `/api/sessions/:id` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions), [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard) | Update session |
| DELETE | `/api/sessions/:id` | Session cookie | [REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard), [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) | Delete session and destroy container |
| POST | `/api/sessions/:id/touch` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions) | Update lastAccessedAt |
| POST | `/api/sessions/:id/stop` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions), [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) | Stop session (KV 'stopped' + container.destroy()) |
| GET | `/api/sessions/:id/status` | Session cookie | [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-stop-restart-and-delete-sessions), [REQ-OPS-006](../../sdd/spec/operations.md#req-ops-006-idle-containers-stop-metered-container-resources) | Get session and container status |
| GET | `/api/sessions/batch-status` | Session cookie | [REQ-SESSION-001](../../sdd/spec/session-lifecycle.md#req-session-001-session-creation-with-name-and-agent-type), [REQ-OPS-006](../../sdd/spec/operations.md#req-ops-006-idle-containers-stop-metered-container-resources), [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release), [REQ-STOR-036](../../sdd/spec/storage.md#req-stor-036-managed-reconciliation-progress-reads), [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC6, [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions) | Core lifecycle, PTY, readiness, activity, metrics, and limits for all sessions; `include=storage,usage` opts into storage-cache and usage observations |
| POST | `/api/sessions/sync` | Session cookie | [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui) | Trigger bisync across the user's running sessions and return the fan-out result |

Optional `includePreseedCheck=true` adds `preseedNeedsUpgrade: boolean` and managed-release status for dashboard release detection; those fields are otherwise omitted. A hash mismatch sets `preseedNeedsUpgrade`, as does an Enterprise session whose stored mode is not yet Advanced. While a managed release is `upgrading`, a matching valid progress record may add `managedReleaseProgress: { phase, completed, total }`. Planning, writing, and finalizing progress is observational and is omitted for current, stale-target, malformed, and update-pending states.

Session responses normalize `workspace` to `terminal` or `vscode`; historical records without the field resolve to `terminal`, while only VS Code records persist an explicit workspace snapshot. The snapshot is immutable after creation and preference changes affect future sessions only ([REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions)).

A successful stop ends Container vCPU, provisioned-memory, and local-disk metering once the Container sleeps. Local disk is ephemeral rather than hibernated state; a later start restores durable files from R2. This endpoint contract makes no zero-total-platform-cost claim: Workers, Durable Objects, R2, requests, logs, storage, and network usage may still be billable.

## Container Lifecycle

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/container/start` | Session cookie | [REQ-SESSION-007](../../sdd/spec/session-lifecycle.md#req-session-007-running-session-count-limited-per-tier), [REQ-SUB-007](../../sdd/spec/subscription.md#req-sub-007-quota-enforcement-at-session-start-402) | Start container (5 requests/user/minute; checks current concurrent-running count and compute quota; non-blocking) |
| POST | `/api/container/destroy` | Session cookie | [REQ-SESSION-014](../../sdd/spec/session-lifecycle.md#req-session-014-user-configurable-auto-sleep-timeout-in-settings) | Destroy container (SIGKILL) |
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

Session creation may reject the enterprise agent allowlist or SaaS storage quota before writing a record. Start may reject an active bucket migration, an agent absent from the deployed image, the current concurrent-session policy check, or compute quota. The session-count check and later KV `running` write are not atomic. Concurrent-session admission is explicitly best effort, so simultaneous starts may exceed the nominal per-user limit; deployment `max_instances` is a separate hard platform boundary. Enterprise currently follows the non-SaaS role-based resolver, while [issue #880](https://github.com/nikolanovoselec/codeflare/issues/880) tracks one role-independent Enterprise limit.

A successful start response means asynchronous startup was accepted, not that ports are ready. If `startAndWaitForPorts()` later fails, the background task rolls KV back to `stopped`; clients observe `stopped` through startup status rather than a persisted `error` lifecycle state. See [Troubleshooting](troubleshooting.md#container-start-is-rejected-or-returns-to-stopped).

## Terminal

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| WS | `/api/terminal/:compoundId/ws` | Session cookie | [REQ-TERM-001](../../sdd/spec/terminal.md#req-term-001-terminal-surface-count-follows-session-mode), [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002-websocket-connection-to-container-pty), [REQ-TERM-011](../../sdd/spec/terminal.md#req-term-011-visible-terminal-panes-own-websocket-connections), [REQ-SESSION-012](../../sdd/spec/session-lifecycle.md#req-session-012-wake-loop-prevention) | Terminal WebSocket (`sessionId-1..6` for classic; `sessionId-1` only for Herdr after session lookup); raw terminal input/output plus JSON control frames for resize authority (`focus`, `resize`) and terminal restore. Focus claims are cleared when a pane loses focus before open. |
| GET | `/api/terminal/:sessionId/status` | Session cookie | [REQ-TERM-004](../../sdd/spec/terminal.md#req-term-004-close-code-4503-is-authoritative-no-retry) | Connection status |

**Terminal mode contract:** `PATCH /api/preferences` accepts optional `herdrEnabled`; omitting it preserves the current preference, while a missing stored preference makes newly created sessions classic. `POST /api/sessions` does not accept terminal mode and stamps it server-side. Session responses expose resolved `terminalMode`; missing or invalid stored values resolve `classic`. Classic authorizes terminal IDs `1` through `6`; Herdr authorizes only `1` after authenticated session lookup. <!-- @impl: src/routes/preferences.ts::mergePreferences --> <!-- @impl: src/routes/session/crud.ts::toWorkspaceApiSession --> <!-- @impl: src/types.ts::resolveTerminalMode -->

**Terminal frame contract:** Client→server sends raw PTY input or JSON control frames `{type:"focus"}`, `{type:"resize", cols, rows}`, or `{type:"kill"}`. Server→client sends raw PTY output or JSON frames `{type:"restore", state}` and `{type:"process-name", terminalId, processName}`. <!-- @impl: host/src/terminal-ws.ts::attachTerminalConnectionHandler --> <!-- @impl: host/src/session.ts::attach --> <!-- @impl: host/src/session.ts::start -->

## Vault

The in-container SilverBullet editor is reached through the Worker proxy. Under [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) the SilverBullet app is served under a **bucket-stable** path `/api/vault/<token>/` (token = opaque 32-hex `SHA-256(salt+bucketName)`, no PII), so the IndexedDB names persist across sessions; the session-keyed `/api/vault/:sid/` path is an entry that sets `cf_vault_sid` and 302-redirects to the token path.

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/vault/:sid/` | Session cookie | [REQ-VAULT-005](../../sdd/spec/vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) | Entry: validates auth + tier, sets HttpOnly `cf_vault_sid` cookie, 302s to `/api/vault/<token>/`. Retains default security headers. |
| GET | `/api/vault/:sid/status` | Session cookie | [REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC1 | JSON readiness probe `{ vaultReady }`. Retains full default security headers (CSP + `X-Frame-Options: DENY`). |
| GET / WS | `/api/vault/<token>/*` | `cf_vault_sid` cookie | [REQ-VAULT-005](../../sdd/spec/vault.md#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) | Bucket-stable SilverBullet proxy. Rewrites `<base href>` to `/api/vault/<token>/`. Security headers: `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`, no CSP. WS upgrades rate-limited (30/60s, shared with terminal). |
| GET | `/api/vault/<token>/service_worker.js` | None (browser-only `service-worker` header) | [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker) | Auth-short-circuited native SilverBullet SW (credential-less registration fetch). |
| GET | `/api/vault/<token>/.codeflare-bootstrap` | Session cookie | [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC1, [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) | Bootstrap hop: registers native SW, posts bucket-derived key via `set-encryption-key`, sets `codeflare_vault_bootstrap` cookie, redirects to token URL. |
| GET | `/api/vault/<token>/.vault-key` | Session cookie | [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC5 | Returns `{ key }` JSON (bucket-derived HKDF key) for in-memory key recovery by the grafted SW. `Cache-Control: no-store`. |

## Browser IDE

The in-container code-server runtime (full Code OSS editor) is reached through the Worker proxy. Unlike the Vault, the IDE is **session-keyed** ([REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable)): the browser and Worker retain `/api/vscode/<sessionId>/`, while the trusted host strips only that exact session prefix before forwarding HTTP or WebSocket traffic to loopback code-server. Canonical forwarded host/protocol identity preserves Origin enforcement. Public `folder`, `workspace`, and `ew` selectors are rejected at Worker and host boundaries; the private root hop selects `/home/user/workspace`, and the successful root response projects its equivalent fixed `folderUri` into Code OSS while the browser location remains clean.

The sessionId in the URL is the sole container selector under [REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable); there is no bucket-stable serving path. A bounded per-user UI snapshot is storage state, not a route selector.

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET / WS | `/api/vscode/<sessionId>/*` | Session cookie (shared vault auth chain) | [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-003](../../sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-012](../../sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection), [REQ-IDE-015](../../sdd/spec/browser-ide.md#req-ide-015-clean-browser-ide-url-and-private-workspace-selection), [REQ-IDE-035](../../sdd/spec/browser-ide.md#req-ide-035-canonical-browser-ide-workspace-projection) | Session-keyed code-server proxy, parsed before Hono so WebSocket upgrades pass through. Worker preserves the external path; host strips the exact session prefix. Security headers: `frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`, no CSP. WS upgrades rate-limited (30/60s, shared with terminal + vault). |

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

The pre-Hono, pre-auth 400 keeps the full default security-header set; every other response gets the relaxed set above.

## User Management

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/user` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-019](../../sdd/spec/authentication.md#req-auth-019-user-identity-and-account-status-api) AC1, [REQ-ENTERPRISE-003](../../sdd/spec/enterprise-mode.md#req-enterprise-003-agent-allowlist-in-enterprise-mode) AC4, [REQ-AGENT-123](../../sdd/spec/agents.md#req-agent-123-installed-agent-runtime-availability) AC3 | Authenticated user info (includes `onboardingActive`, `onboardingComplete`, `allowedAgents` — the build-installed, policy-filtered creation set) |
| POST | `/api/user/onboarding-complete` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-019](../../sdd/spec/authentication.md#req-auth-019-user-identity-and-account-status-api) AC2 | Mark guided setup as visited (sets KV flag) |
| GET | `/api/user/r2-status` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-019](../../sdd/spec/authentication.md#req-auth-019-user-identity-and-account-status-api) AC3 | R2 credential status for current user |
| POST | `/api/user/ensure-r2-token` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-019](../../sdd/spec/authentication.md#req-auth-019-user-identity-and-account-status-api) AC4, AC6 | Create scoped R2 token if missing (rate limited) |
| GET | `/api/users` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | List allowed users (admin only) |
| DELETE | `/api/users/:email` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | Remove allowed user (admin only) |
| PATCH | `/api/users/:email` | Session cookie (admin-only routes require admin role) | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel), [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) | Update user tier/role (admin only) |

For `GET /api/user`, current workers return `allowedAgents`. During a rolling upgrade, a successful response from an older worker may omit this optional field; the UI then hydrates the deployment-mode legacy catalog rather than remaining in its pre-hydration state ([REQ-AGENT-124](../../sdd/spec/agents.md#req-agent-124-agent-choice-profile-hydration)).

## Notifications

| Method | Path | Auth | Implements | Description |
|--------|------|------|------------|-------------|
| GET | `/api/notifications/config` | Session cookie | [REQ-TERM-025](../../sdd/spec/terminal.md#req-term-025-per-device-notification-enrollment), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries) | Return only the public VAPID enrollment key; `503` when notification delivery is not configured. |
| POST | `/api/notifications/subscription` | Session cookie | [REQ-TERM-025](../../sdd/spec/terminal.md#req-term-025-per-device-notification-enrollment), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries) | Validate and register one Push subscription for the authenticated user; returns `{ success: true }`. |
| DELETE | `/api/notifications/subscription` | Session cookie | [REQ-TERM-025](../../sdd/spec/terminal.md#req-term-025-per-device-notification-enrollment), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries) | Validate an endpoint and remove that authenticated user's matching enrollment; returns `{ success: true }`. |

## Auth (SaaS Mode)

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/auth/providers` | varies | [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-AUTH-013](../../sdd/spec/authentication.md#req-auth-013-custom-branded-login-page) | List configured IdPs (public, no auth) |
| GET | `/api/auth/status` | varies | [REQ-AUTH-002](../../sdd/spec/authentication.md#req-auth-002-saas-mode-uses-direct-github-oauth), [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page) | Auth status (tier, email, role, turnstile key, session/billing state) |
| GET | `/api/auth/tiers` | varies | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) | Subscribable tier configs (requires identity) |
| GET | `/api/auth/onboarding-config` | varies | [REQ-SETUP-003](../../sdd/spec/setup.md#req-setup-003-three-deployment-modes) | Onboarding page config (turnstile key) |
| POST | `/api/auth/subscribe` | varies | [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment) | Self-service tier selection (rate-limited 3/min) |
| POST | `/api/auth/request-access` | varies | [REQ-AUTH-006](../../sdd/spec/authentication.md#req-auth-006-user-email-normalized), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Request access with Turnstile (rate-limited 3/hr) |
| POST | `/api/auth/contact-team` | varies | [REQ-SUB-017](../../sdd/spec/subscription.md#req-sub-017-enterprise-tier-contact-flow), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Deliver an enterprise-tier inquiry email (rate-limited 1/hr). Returns `200 { success: true }` only after provider acceptance; provider rejection, missing configuration, or network failure returns retryable `503 { success: false, error }`. |

## Usage

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/usage` | Session cookie | [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page), [REQ-SUB-022](../../sdd/spec/subscription.md#req-sub-022-cross-mode-personal-usage-data) | Current user's real-time usage (Timekeeper DO with KV fallback). `monthlyQuotaSeconds` carries the billing quota in SaaS mode and is `null` in onboarding/default and enterprise deployments. |

## Admin

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/admin/tiers` | Admin role | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel), [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | Get current tier config (admin only) |
| PUT | `/api/admin/tiers` | Admin role | [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel), [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel) | Update tier config (admin only, 8-tier array) |
| GET | `/api/admin/configuration` | Admin role | [REQ-SETUP-017](../../sdd/spec/setup.md#req-setup-017-mode-aware-administration-configuration-read) | Read mode-gated Environment values, revision, active run, and sanitized latest summaries |
| POST | `/api/admin/configuration-previews` | Admin role | [REQ-SETUP-018](../../sdd/spec/setup.md#req-setup-018-stateless-environment-preview-and-bounded-execution) | Validate one closed Environment section and return a stateless task preview |
| GET | `/api/admin/configuration-runs` | Admin role | [REQ-SETUP-018](../../sdd/spec/setup.md#req-setup-018-stateless-environment-preview-and-bounded-execution) | Cursor-paginated sanitized Activity runs |
| POST | `/api/admin/configuration-runs` | Admin role | [REQ-SETUP-018](../../sdd/spec/setup.md#req-setup-018-stateless-environment-preview-and-bounded-execution), [REQ-SETUP-024](../../sdd/spec/setup.md#req-setup-024-routine-oauth-identifier-persistence) | Start one bounded run and stream NDJSON snapshots. Explicitly blank OAuth client IDs remove saved IDs; blank replacement secrets preserve saved secrets. |
| GET | `/api/admin/configuration-runs/:runId` | Admin role | [REQ-SETUP-018](../../sdd/spec/setup.md#req-setup-018-stateless-environment-preview-and-bounded-execution) | Reconnect to one persisted run |
| GET, POST | `/api/admin/reasoning/catalog` | Admin role | [REQ-ENTERPRISE-031](../../sdd/spec/enterprise-mode.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-ENTERPRISE-034](../../sdd/spec/enterprise-mode.md#req-enterprise-034-enterprise-pi-route-administration) | Return the six built-ins, custom revisions, four nonassignable compatibility notices, assignment usage, and the auto-discovered Dynamic Route names. `routeCatalogStatus` and sanitized `connection` report management readiness. POST accepts a transient `gateway` overlay. |
| GET, POST | `/api/admin/reasoning/routes/:route/inventory` | Admin role | [REQ-ENTERPRISE-033](../../sdd/spec/enterprise-mode.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence) | Return the active route version, every reachable model leg and conditional/fallback path, sanitized evidence, common levels/mapping, `inventoryDigest`, current saved `verification`, and warnings. POST accepts `gateway` and `backendDescriptions`. Missing routes return 404; malformed or unavailable inventory returns 502. |
| POST | `/api/admin/reasoning/discover` | Admin role | [REQ-ENTERPRISE-033](../../sdd/spec/enterprise-mode.md#req-enterprise-033-enterprise-pi-discovery-and-multi-model-evidence), [REQ-ENTERPRISE-035](../../sdd/spec/enterprise-mode.md#req-enterprise-035-enterprise-pi-protocol-match-selection), [REQ-ENTERPRISE-037](../../sdd/spec/enterprise-mode.md#req-enterprise-037-enterprise-pi-custom-profile-generation) | Run bounded Pi 0.84.4 compatibility discovery for one route with saved Worker-side credentials. A supplied `profileRef` verifies a saved revision or bounded exact `profileDraft`; omission requests named existing-profile matches or a non-persisted custom draft from compatible modes. |
| GET | `/api/admin/usage` | Admin role | [REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history), [REQ-SUB-029](../../sdd/spec/subscription.md#req-sub-029-bounded-organization-usage-history-presentation), [REQ-SUB-031](../../sdd/spec/subscription.md#req-sub-031-canonical-administration-usage-period-starts) | JSON summary for the selected UTC period plus bounded history ending at it; CSV user-row export for the selected UTC period. `start` uses `YYYY-MM-DD` for days and Monday-only weeks, `YYYY-MM` for months, or `YYYY` for years; invalid values return `400`. |
| GET | `/api/admin/usage/users/:userKey` | Admin role | [REQ-SUB-026](../../sdd/spec/subscription.md#req-sub-026-admin-organization-analytics-and-deletion-history) | One active or deleted user's named aggregate history |
| POST | `/api/admin/usage-report-tests` | Admin role | [REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports), [REQ-SUB-030](../../sdd/spec/subscription.md#req-sub-030-monthly-usage-report-schedule-periods) | Queue distinct test deliveries for the current UTC month; returns `202` |
| GET | `/api/admin/usage-report-deliveries` | Admin role | [REQ-SUB-027](../../sdd/spec/subscription.md#req-sub-027-monthly-organization-usage-reports) | Cursor-paginated scheduled and test provider-acceptance history |
| PUT | `/api/users/max-users` | Admin role | [REQ-AUTH-018](../../sdd/spec/authentication.md#req-auth-018-user-management-admin-panel), [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) | Set max users capacity cap (admin only) |

The three reasoning paths do not activate configuration. POST variants accept transient `gateway: {gatewayUrl, replacementToken?}` overlays and otherwise reuse saved encrypted credentials. No saved token is returned. Selected discovery also accepts `profileDraft` and `backendDescriptions`; drafts must canonicalize to the exact selected reference before provider I/O. Confirmed aiRouting Save remains the sole activation path and preserves explicit warning codes and baseRevision concurrency protection. Legacy ID-only saves preserve unchanged exact assignments and custom revisions. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes -->

Discovery accepts `{ route, profileRef, profileDraft?, gateway?, backendDescriptions?, maxCompletionTokens }` for selected verification. Omitting `profileRef` tests the finite built-in protocol bank and compares its compatible modes with enabled built-in and saved custom revisions. The route-only `outcome` is `existing-profile`, `custom-profile`, `ambiguous`, `inconclusive`, or `unsupported`. Every complete existing match returns a `matchedProfiles` entry containing `name`, exact `profileRef`, and `supportedLevels`, with no duplicate `profileDraft`. Different passing mappings remain available for administrator selection. Saved custom profiles do not expand the paid probe bank. Unknown provider properties are not inferred. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes -->

When no existing profile fits, an unambiguous partial candidate may produce `profileDraft` containing only passed reasoning/tool/replay modes; failed modes, unproven off, and dangling aliases are removed. Complete existing matches take precedence over partial drafts. Only custom-draft construction requires a maximal mapping with identical shared mutations; divergent partial mappings remain ambiguous. Generated drafts retain `profileDraft.classification: "Compatible, unverified"`, `toolCompatibility: { status: "unverified", levels: [] }`, and `validatedTransports: []`; generated evidence remains advisory; activation requires a successful selected check and confirmed configuration Save. ([REQ-ENTERPRISE-037](../../sdd/spec/enterprise-mode.md#req-enterprise-037-enterprise-pi-custom-profile-generation))

`diagnostics` contains bounded levels, stage, failure code, and optional HTTP status/transport. `candidateResults` retains these diagnostics and `verifiedLevels` for each tested protocol. A `completion_limit` at tool generation or replay means incomplete verification, not unsupported behavior. `requestedCompletionCeiling` echoes the chosen per-request limit: 32–16,384, default 4,096. The API range is unchanged; the UI always sends 4,096, exposes no token control, and never automatically retries or escalates. Results remain sanitized and rate limited to 5/minute. A rejected candidate stops without retry, while authentication, rate-limit, server, transport, and malformed-stream errors stop the whole scan and suppress any recommendations/draft. REST runs first; compat is permitted only after completely consuming a REST 404, removing only `store` and `prompt_cache_key`. <!-- @impl: src/routes/admin/reasoning.ts::reasoningRoutes --> <!-- @impl: src/lib/reasoning-discovery.ts::discoverPiCompatibility -->

Successful selected verification returns `checkId` and server-derived `verification`: schemaVersion, profileRef, routeVersion, inventoryDigest, connectionFingerprint, canaryVersion, supportedLevels, scope, and checkedAt. Scope is `single-model` or `observed-path`; the latter requires an untested-backend warning. `routeChecks` maps route names to receipt IDs or null (clear); omission preserves only unchanged current saved authority. Unique KV receipts expire after 15 minutes, but saved authority does not. Missing receipts fail closed with retry guidance and no automatic paid check. Complete supported-level tools/replay and applicable Off checks must pass against unchanged inventory. <!-- @impl: src/lib/reasoning-verification.ts::issueRouteCheck -->

aiRouting accepts `fallbackRouting: {enabled:false}` or `{enabled:true,routes,defaultRoute,reasoning}` and persists it in reasoningConfiguration. Disabled or absent fallback denies unmatched users. Save requires a checked route in at least one group, while inactive drafts remain retained. Empty configured group policies remain deny-only entries; first-match selection precedes eligibility filtering. Active dynamicRoutes are the group/fallback union. Client verification flags cannot authorize routes, and an empty runtime catalog denies inference before upstream I/O. <!-- @impl: src/lib/admin-configuration.ts::normalizeAiReasoningConfiguration --> <!-- @impl: src/lib/access.ts::loadEnterpriseRouteConfig -->

## Billing

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/billing/checkout` | Session cookie | [REQ-SUB-003](../../sdd/spec/subscription.md#req-sub-003-free-tier-requires-no-payment), [REQ-SUB-004](../../sdd/spec/subscription.md#req-sub-004-paid-tiers-integrate-with-stripe-checkout) | Create Stripe Checkout Session for paid tier (rate-limited 5/min) |
| GET | `/api/billing/status` | Session cookie | [REQ-SUB-016](../../sdd/spec/subscription.md#req-sub-016-customer-portal-and-plan-switching), [REQ-SUB-018](../../sdd/spec/subscription.md#req-sub-018-usage-dashboard-page) | Live billing state from Stripe (subscription, period, status) |
| POST | `/api/billing/portal` | Session cookie | [REQ-SUB-016](../../sdd/spec/subscription.md#req-sub-016-customer-portal-and-plan-switching) | Create Stripe Customer Portal session (rate-limited 5/min) |
| POST | `/api/billing/switch` | Session cookie | [REQ-SUB-016](../../sdd/spec/subscription.md#req-sub-016-customer-portal-and-plan-switching) | Deep-link portal for plan change confirmation (rate-limited 5/min) |
| POST | `/public/stripe/webhook` | None (Stripe HMAC) | [REQ-SUB-005](../../sdd/spec/subscription.md#req-sub-005-trial-is-compute-based-not-time-based), [REQ-SUB-015](../../sdd/spec/subscription.md#req-sub-015-stripe-webhook-signal-and-sync-pattern), [REQ-SUB-021](../../sdd/spec/subscription.md#req-sub-021-billing-cycle-alignment) | Stripe webhook handler (unauthenticated, HMAC-verified, rate-limited 100/min, body capped at 1 MiB via `bodyLimit` middleware -- CF-004) |

## Deploy Keys

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-018](../../sdd/spec/agents.md#req-agent-018-push--deploy-credential-management-ui) | Get encrypted deploy credentials (masked) |
| PUT | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-018](../../sdd/spec/agents.md#req-agent-018-push--deploy-credential-management-ui) | Save/update deploy credentials (GitHub PAT, CF API token) |
| DELETE | `/api/deploy-keys` | Session cookie | [REQ-AGENT-010](../../sdd/spec/agents.md#req-agent-010-deploy-credential-storage-github-pat-cf-api-token), [REQ-AGENT-018](../../sdd/spec/agents.md#req-agent-018-push--deploy-credential-management-ui) | Erase all deploy credentials |

## GitHub Integration

The GitHub panel (Connect, repository list, clone) is mounted at `/api/github` (`src/routes/github.ts`); the OAuth callback is mounted separately under `/auth/github`. The repo-panel routes (`/status`, `/repos`, `/clone`) are available in every mode, and the dashboard renders the panel whenever GitHub integration is enabled; there is no advanced-session gate ([REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise)). **Connect/disconnect are decoupled from the panel** — `/connect`, its callback, and `/disconnect` are `authMiddleware`-only, so they work from Guided Setup and Settings. The token is never returned to the browser; `/repos` proxies GitHub server-side.

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/github/status` | Session cookie | [REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing) | Connection state (`enabled`, `configured`, `connected`, `login`, `source`); never the token |
| GET | `/api/github/repos` | Session cookie | [REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing) | The user's accessible repos (owner + collaborator + org member), server-side proxy; `?page=<n>` paginates, 50/page (rate-limited 60/min); `401 NOT_CONNECTED` when no token |
| GET | `/api/github/connect` | Session cookie | [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) | Start the provider authorize flow (302 to GitHub); `?tier=minimal\|recommended\|advanced` maps to the OAuth-App scope; `503 GITHUB_NOT_CONFIGURED` when no provider configured (rate-limited 20/min) |
| POST | `/api/github/disconnect` | Session cookie | [REQ-GITHUB-005](../../sdd/spec/github.md#req-github-005-disconnect-and-offboarding-revocation) | Attempt GitHub revocation (App/OAuth), then clear the stored token even if revocation fails (rate-limited 20/min) |
| POST | `/api/github/clone` | Session cookie | [REQ-GITHUB-004](../../sdd/spec/github.md#req-github-004-clone-a-repository-into-a-session) | Clone `{repo, ref?, sessionId}` into a **running** session's workspace; relays the container's outcome verbatim (`200` cloned / `409 CLONE_TARGET_EXISTS` / `502 CLONE_FAILED` / `504`); `503 NOT_RUNNING` when the container is asleep (rate-limited 20/min) |

The OAuth callback is mounted separately under `/auth/github` (`src/routes/github-auth.ts`, registered via `app.route('/auth/github', githubAuthRoutes)` in `src/index.ts`) — it is **not** an `/api/github` route:

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/auth/github/connect/callback` | Session cookie | [REQ-GITHUB-001](../../sdd/spec/github.md#req-github-001-github-token-capture-and-storage) | Connect-GitHub callback (distinct from SaaS-login `/auth/github/callback`): re-derives identity from the live session, verifies the bucket-bound OAuth state, exchanges the code, persists the repo token to deploy-keys; never mints a session cookie. GitHub App/OAuth App registers this exact URL. |

The **new-session** clone path is not a GitHub route: `POST /api/sessions` accepts an optional `clone: { repo, ref? }` field ([REQ-GITHUB-004](../../sdd/spec/github.md#req-github-004-clone-a-repository-into-a-session)). Under [REQ-GITHUB-014](../../sdd/spec/github.md#req-github-014-clone-created-session-resume), the session retains that directive and re-applies it before agent startup after every resume; configuration restoration failure blocks startup. A wiped ephemeral workspace receives the established best-effort clone attempt again, while an existing target is preserved.

## Cloudflare Integration

Per-user "Connect to Cloudflare" OAuth (non-enterprise only). Mounted at `/api/cloudflare` (`src/routes/cloudflare.ts`); the OAuth callback is mounted separately under `/auth/cloudflare` (`src/routes/cloudflare-auth.ts`). All routes are `authMiddleware`-only (any authenticated user) and **not** tier-gated — connect is reachable from Guided Setup + the Settings accordion. `getCloudflareProvider` returns null in **enterprise**, so every route fails closed there (`503 CLOUDFLARE_NOT_CONFIGURED`). The token is never returned to the browser ([REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth)).

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/cloudflare/status` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) | Connection state (`configured`, `connected`, `accountId`, `source`); when connected without a selected account, also the accessible `accounts`; never the token |
| GET | `/api/cloudflare/connect` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) | Start the OAuth authorize flow (302 to `dash.cloudflare.com/oauth2/auth`); `?tier=minimal\|recommended\|advanced` maps to the OAuth scope (always incl. `offline_access`); `503 CLOUDFLARE_NOT_CONFIGURED` when no client configured (rate-limited 20/min) |
| POST | `/api/cloudflare/account` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) | Select the account `{accountId}` for a connected token; `400 ACCOUNT_INVALID` when the token cannot access it (rate-limited 20/min) |
| POST | `/api/cloudflare/disconnect` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) | Revoke at Cloudflare and clear the stored token (rate-limited 20/min) |

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/auth/cloudflare/connect/callback` | Session cookie | [REQ-AGENT-064](../../sdd/spec/agents.md#req-agent-064-connect-to-cloudflare-via-oauth) | Connect-Cloudflare callback; redirects with `?cloudflare=connected\|select-account\|denied\|expired\|unavailable\|error`. |

The Connect-Cloudflare callback re-derives identity from the live session, verifies the bucket-bound single-use OAuth state, exchanges the code, persists the token, and auto-selects the account when exactly one is accessible; otherwise it redirects to a picker. It never mints a session cookie. The OAuth client registers this exact URL.

## Public (Unauthenticated)

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| GET | `/public/auth/providers` | none | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence), [REQ-AUTH-008](../../sdd/spec/authentication.md#req-auth-008-session-cookie-auto-refresh) | Auth providers (outside CF Access gate) |
| GET | `/public/onboarding-config` | none | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence), [REQ-AUTH-006](../../sdd/spec/authentication.md#req-auth-006-user-email-normalized) | Turnstile site key + onboarding status |
| GET | `/public/tiers` | none | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence), [REQ-SUB-009](../../sdd/spec/subscription.md#req-sub-009-admin-configurable-tiers-via-management-panel) | Public tier config (no session mode info) |
| POST | `/public/waitlist` | none | [REQ-SETUP-012](../../sdd/spec/setup.md#req-setup-012-setup-wizard-step-sequence), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Waitlist signup with Turnstile (rate-limited 1/day by IP) |
| GET | `/public/contact-config` | none | [REQ-LANDING-002](../../sdd/spec/landing.md#req-landing-002-demo-request-contact-pipeline) | Turnstile site key for the landing contact form (SaaS or onboarding mode) |
| POST | `/public/contact` | none | [REQ-LANDING-002](../../sdd/spec/landing.md#req-landing-002-demo-request-contact-pipeline), [REQ-SEC-007](../../sdd/spec/security.md#req-sec-007-rate-limiting-infrastructure) | Demo-request submission: Turnstile-verified, relayed to admins as email, never persisted (rate-limited 5/min) |

The login surface calls auth-provider discovery before rendering its choices ([REQ-AUTH-013](../../sdd/spec/authentication.md#req-auth-013-custom-branded-login-page) AC3), making it the primary public discovery call. Check the canonical production deployment without a session:

```sh
curl -fsS https://codeflare.ch/public/auth/providers \
  | jq '{providers: [.providers[] | {id, type, name, loginUrl}]}'
```

The response is `{ "providers": [...] }`. Each provider contains `id`, `type`, and `name`; direct GitHub mode also includes `loginUrl`.

## Discoverability Documents

Served at the deployment root by the Worker (in `src/index.ts`, before the setup-completion gate so crawlers reach them on a fresh instance). The response depends on deployment mode; content is built by pure functions in `src/lib/seo.ts`, with the canonical origin hardcoded to `https://codeflare.ch` so integration/staging hosts never advertise themselves as canonical.

| Method | Path | Auth | Public mode (SaaS / onboarding) | Private mode (default / enterprise) | Implements |
|--------|------|------|----------|----------|------------|
| GET | `/robots.txt` | None | `200` — allows the marketing surface, excludes `/app /api /auth /setup`, points at `/sitemap.xml`; `/login` remains crawlable so its `noindex` response directive is observed | `200` — disallow-all | [REQ-LANDING-003](../../sdd/spec/landing.md#req-landing-003-landing-social-share-and-search-metadata), [REQ-LANDING-008](../../sdd/spec/landing.md#req-landing-008-login-crawler-exclusion-controls) |
| GET | `/sitemap.xml` | None | `200` — canonical marketing routes (login excluded, it is noindex) | `404` | [REQ-LANDING-003](../../sdd/spec/landing.md#req-landing-003-landing-social-share-and-search-metadata), [REQ-LANDING-008](../../sdd/spec/landing.md#req-landing-008-login-crawler-exclusion-controls) |
| GET | `/llms.txt` | None | `200` — llmstxt.org-convention product summary | `404` | [REQ-LANDING-003](../../sdd/spec/landing.md#req-landing-003-landing-social-share-and-search-metadata) |

Every `/login` asset response also carries `X-Robots-Tag: noindex, nofollow`; the sitemap omits that route ([REQ-LANDING-008](../../sdd/spec/landing.md#req-landing-008-login-crawler-exclusion-controls)).

## Setup

The setup wizard configures a fresh Codeflare deployment. It provisions Cloudflare resources (R2 credentials, DNS records, Access applications) and stores the resulting configuration in Workers KV so the application can serve requests.

| Method | Path | Auth | Implements | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/setup/configure` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration), [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-013](../../sdd/spec/setup.md#req-setup-013-managed-environment-configuration) | Run the setup wizard (streams NDJSON progress) |
| GET | `/api/setup/status` | Public | [REQ-SETUP-001](../../sdd/spec/setup.md#req-setup-001-first-time-setup-requires-zero-pre-configuration) | Whether setup is complete (always public) |
| GET | `/api/setup/detect-token` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-008](../../sdd/spec/setup.md#req-setup-008-setup-helper-endpoints-support-prefill-and-detection) | Detect and verify the Cloudflare API token |
| GET | `/api/setup/prefill` | Public (pre-setup); admin (post-setup) | [REQ-SETUP-005](../../sdd/spec/setup.md#req-setup-005-post-setup-reconfiguration-requires-admin-auth), [REQ-SETUP-008](../../sdd/spec/setup.md#req-setup-008-setup-helper-endpoints-support-prefill-and-detection), [REQ-SETUP-013](../../sdd/spec/setup.md#req-setup-013-managed-environment-configuration), [REQ-ENTERPRISE-025](../../sdd/spec/enterprise-mode.md#req-enterprise-025-active-coding-agents-configured-in-the-setup-wizard) | Prefill setup form without returning managed repository PAT or public-key bytes |

Conditional auth: before `setup:complete` is set in KV, every Setup endpoint except `/api/setup/status` is publicly reachable through the CSRF-gated bootstrap window (see [AD10](../decisions/README.md#ad10-bootstrap-window-pre-setup-endpoints-csrf-and-worker-name-derivation)). Once setup is marked complete, the same endpoints require an admin-role session.

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

**Step 5 -- `create_access_app`**

Source: `src/routes/setup/access.ts`

**When GitHub OIDC is NOT configured** (default, or a session-OIDC mode -- SaaS or onboarding -- without `OAUTH_CLIENT_ID`):
1. Upserts two Cloudflare Access groups scoped to the worker name:
   - `{workerName}-admins` -- contains admin emails.
   - `{workerName}-users` -- contains non-admin allowed emails (created only when there are non-admin users).
2. Prunes legacy Access apps that used older domain patterns.
3. Creates or updates a self-hosted Access application protecting `/app/*` (primary), `/app`, `/api/*`, `/setup`, and `/setup/*` via the `destinations` field.
4. Upserts an "Allow users" policy referencing both groups.
5. Stores Access configuration in KV (audience tag, group IDs, auth domain).

**When GitHub OIDC IS configured** (session-OIDC mode -- `SAAS_MODE=active` OR `ONBOARDING_LANDING_PAGE=active` -- plus `OAUTH_CLIENT_ID`):
CF Access groups and policies are not created - the Worker handles authentication directly via GitHub OAuth session cookies. The skip mirrors the `isSessionOidcMode` runtime guard, so an onboarding-mode deployment does not get a stray Access app whose edge 302 would break the credential-less vault service-worker registration. Admin users created via allowedUsers are assigned the Custom tier automatically.

**Step 6 -- `configure_turnstile` (conditional)**

Source: `src/routes/setup/turnstile.ts`

Runs only when the `ONBOARDING_LANDING_PAGE` env var is active OR SaaS mode is enabled. Creates or updates a Turnstile widget in `managed` mode for the custom domain (and the workers.dev hostname). Stores the site key and secret in KV.

**Enterprise steps (conditional, `ENTERPRISE_MODE` only)**

Source: `src/routes/setup/index.ts`

Each runs only when its field is present in the request body, so unrelated reconfigures stay quiet:

- `configure_access_groups` — persists the user/admin Access-group name lists (CSV-joined; an empty list clears the key). [REQ-ENTERPRISE-010](../../sdd/spec/enterprise-mode.md#req-enterprise-010-access-gated-jit-user-provisioning), [REQ-ENTERPRISE-014](../../sdd/spec/enterprise-mode.md#req-enterprise-014-admin-access-via-cloudflare-access-groups)
- `configure_model_routing` — persists the route catalog, defaults, per-route context and capability-profile assignments, and per-group routing. [REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list), [REQ-ENTERPRISE-013](../../sdd/spec/enterprise-mode.md#req-enterprise-013-per-group-dynamic-routing), [REQ-ENTERPRISE-022](../../sdd/spec/enterprise-mode.md#req-enterprise-022-per-route-context-windows-for-dynamic-routes), [REQ-ENTERPRISE-031](../../sdd/spec/enterprise-mode.md#req-enterprise-031-enterprise-pi-capability-profile-administration)

The Setup compatibility shape still reads historical `routeReasoningProfiles`. GLM and Kimi IDs propose `workers-ai-glm-thinking` and `workers-ai-kimi-k-thinking` assignments respectively; GPT-OSS remains unresolved and requires administrator reassignment. No proposal is persisted before Apply writes the complete `setup:reasoning_configuration` document, and every catalog route still requires a positive context window and executable assignment.

- `configure_ai_gateway` — persists the AI Gateway URL (plain) and token (encrypted at rest, no-clobber on blank). [REQ-ENTERPRISE-017](../../sdd/spec/enterprise-mode.md#req-enterprise-017-ai-gateway-configured-in-the-setup-wizard)
- `configure_browser_rendering` — persists the admin Browser Rendering account id and token (encrypted when `ENCRYPTION_KEY` is configured, AD32 plaintext fallback otherwise; presence-only prefill and no-clobber on blank, with no masked-save sentinel). [REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)
- `configure_strict_egress` — writes `setup:strict_egress` as `'active'`/`'inactive'` after the pre-stream protected-policy check. [REQ-ENTERPRISE-016](../../sdd/spec/enterprise-mode.md#req-enterprise-016-strict-gateway-egress), [REQ-SETUP-016](../../sdd/spec/setup.md#req-setup-016-managed-resource-policy-safety)
- `configure_r2_sse` — writes `setup:r2_sse_disabled` as `'active'`/`'inactive'`. [REQ-ENTERPRISE-018](../../sdd/spec/enterprise-mode.md#req-enterprise-018-governed-mode-toggle-and-configuration-surface)
- `configure_downloads_disabled` — writes `setup:downloads_disabled` as `'active'`/`'inactive'`. [REQ-ENTERPRISE-019](../../sdd/spec/enterprise-mode.md#req-enterprise-019-view-only-storage-download-disable)
- `configure_active_agents` — validates the selection against build-installed, gateway-capable coding agents (rejects empty, non-capable, or omitted CLIs) and writes `setup:active_agents` as a JSON array. [REQ-ENTERPRISE-025](../../sdd/spec/enterprise-mode.md#req-enterprise-025-active-coding-agents-configured-in-the-setup-wizard), [REQ-AGENT-123](../../sdd/spec/agents.md#req-agent-123-installed-agent-runtime-availability)

**Step 7 -- `finalize`**

Writes final KV state and marks setup as complete.

These are canonical provisioning slots, not a promise that every mode emits seven placeholder rows. Conditional Turnstile, cleanup, Access, and enterprise extension steps appear only when applicable, while streamed attempted steps retain source order.

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

**Success:**

```json
{
  "done": true,
  "success": true,
  "steps": [
    {"step":"get_account","status":"success"},
    {"step":"derive_r2_credentials","status":"success"},
    ...
  ],
  "workersDevUrl": "https://codeflare.account.workers.dev",
  "customDomainUrl": "https://claude.example.com"
}
```

**Failure:**

```json
{
  "done": true,
  "success": false,
  "steps": [
    {"step":"get_account","status":"success"},
    {"step":"derive_r2_credentials","status":"error","error":"Token verification failed"}
  ],
  "error": "Token verification failed"
}
```

**Detecting completion**

Read lines from the stream until you parse an object where `done === true`. Then check `success` to determine the outcome. The `steps` array provides the cumulative status of every step attempted, including which step failed and the error message.

**Detecting lock contention**

If another configure run is already in progress, the stream immediately emits:

```json
{"done":true,"success":false,"error":"Setup configuration is already in progress. Please wait and try again."}
```

No step progress messages are sent in this case.

### Error Recovery

**Per-step retry**

Each Cloudflare API call is wrapped in `withSetupRetry` (exponential backoff, up to 3 total attempts with a 1 s base delay). `CircuitBreakerOpenError` is not retried because the circuit breaker is already open and retrying immediately would be wasteful.

**Step failure**

When any step throws, the error is caught by the top-level handler which:

1. Sends a completion message with `success: false` and the error details.
2. Releases the configure lock.
3. Closes the writable stream.

Partial progress from earlier successful steps remains in KV. Setup is **not** marked complete, so the next call to `/api/setup/configure` can retry from the beginning.

**Lock mechanism**

A KV-based lock prevents concurrent configure runs:

| Key | Value | TTL |
|---|---|---|
| `setup:configuring` | Unix timestamp (ms) as string | 300 s |

Before starting, the handler checks for an existing lock:

- If the lock exists and is less than 60 seconds old, the request is rejected immediately.
- If the lock exists but is older than 60 seconds, it is treated as stale and overridden (logged as a warning).
- The lock is deleted in the `finally` block regardless of success or failure.
- The KV TTL of 300 s acts as a safety net if the worker crashes before cleanup.

**How to retry**

The client can simply re-submit the same `POST /api/setup/configure` request. All steps are idempotent -- they create-or-update resources rather than assuming a clean slate. If a previous run partially completed, the retry will update existing resources and continue.

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
| `setup:configuring` | lock acquire | Unix timestamp (ms); deleted on completion |
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

User records are stored separately under the `user:{email}` key pattern with a JSON value containing `addedBy`, `addedAt`, `role` (`"admin"` or `"user"`), `subscriptionTier` (8 values), and legacy `accessTier`. Usage tracking data is stored at `timekeeper:{bucketName}`. Tier configuration is at `tiers:config`.

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

Best-effort prefill for the setup form. Reads existing admin and user lists from Cloudflare Access groups (scoped by worker name). Does not prefill the custom domain.

In SaaS mode, returns empty arrays - admin enters everything manually.

```json
{"adminUsers": ["alice@example.com"], "allowedUsers": ["bob@example.com"]}
```

Under `ENTERPRISE_MODE` the response additionally carries the stored enterprise configuration for wizard round-trip: Access groups, route catalog, context windows, capability-profile assignments, masked token flags, and toggles. Legacy GLM/Kimi assignments are surfaced as unpersisted migration proposals; GPT-OSS is surfaced unresolved rather than silently activated. The response also includes `activeAgents` (the stored coding-agent selection intersected with installed CLIs, or every installed capable agent when absent/invalid) and `configurableAgents` (the build-installed subset of the governable `copilot`, `pi` universe); both agent fields are omitted outside enterprise mode ([REQ-ENTERPRISE-025](../../sdd/spec/enterprise-mode.md#req-enterprise-025-active-coding-agents-configured-in-the-setup-wizard), [REQ-ENTERPRISE-031](../../sdd/spec/enterprise-mode.md#req-enterprise-031-enterprise-pi-capability-profile-administration), [REQ-AGENT-123](../../sdd/spec/agents.md#req-agent-123-installed-agent-runtime-availability)).

```json
{"adminUsers":["alice@example.com"],"allowedUsers":[],"dynamicRoutes":["development"],"routeContextWindows":{"development":262144},"routeReasoningProfiles":{"development":"workers-ai-gpt-oss"},"activeAgents":["pi"],"configurableAgents":["copilot","pi"]}
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
| GET | `/api/storage/browse` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | List objects in R2 prefix |
| POST | `/api/storage/upload` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser), [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Upload file |
| GET | `/api/storage/download` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser), [REQ-SEC-013](../../sdd/spec/security.md#req-sec-013-content-disposition-hardening-on-downloads), [REQ-ENTERPRISE-019](../../sdd/spec/enterprise-mode.md#req-enterprise-019-view-only-storage-download-disable) | Download file as an attachment; with `?disposition=inline` serves it inline for in-browser viewing (XSS-safe content-type + nosniff). View-only storage on: attachment `403 DOWNLOADS_DISABLED`, non-viewable blob `403` even inline |
| POST | `/api/storage/delete` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | Delete objects by key and/or prefix (server-side bulk delete) |
| GET | `/api/storage/preview` | Session cookie | [REQ-STOR-007](../../sdd/spec/storage.md#req-stor-007-web-file-browser) | Preview file content (text files inline, others return metadata only) |
| GET | `/api/storage/stats` | Session cookie | [REQ-STOR-006](../../sdd/spec/storage.md#req-stor-006-storage-quota-enforced-per-tier-at-session-start), [REQ-STOR-014](../../sdd/spec/storage.md#req-stor-014-r2-storage-stats-caching) | File/folder counts (60s KV cache, refreshes from R2 on miss/stale) |
| POST | `/api/storage/seed/getting-started` | Session cookie | [REQ-STOR-009](../../sdd/spec/storage.md#req-stor-009-getting-started-docs-auto-seeded-on-first-session) | Seed tutorial docs |
| POST | `/api/storage/seed/agent-configs` | Session cookie | [REQ-AGENT-011](../../sdd/spec/agents.md#req-agent-011-agent-skills--rules-manually-recreatable-from-settings), [REQ-STOR-009](../../sdd/spec/storage.md#req-stor-009-getting-started-docs-auto-seeded-on-first-session) | Recreate AI agent skills & rules (overwrites every desired path and respects session mode) |
| POST | `/api/storage/seed/agent-configs/upgrade` | Session cookie | [REQ-STOR-033](../../sdd/spec/storage.md#req-stor-033-managed-release-delta-planning-and-resume), [REQ-STOR-034](../../sdd/spec/storage.md#req-stor-034-observational-managed-reconciliation-progress-writes), [REQ-STOR-035](../../sdd/spec/storage.md#req-stor-035-managed-reconciliation-cleanup-and-finalization), [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release) | Dashboard-owned automatic reconcile; managed releases use a direct delta or marker-resumable full target and return matching completion progress when available, while baked upgrades keep their existing reconcile behavior |
| POST | `/api/storage/upload/initiate` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Initiate multipart upload |
| POST | `/api/storage/upload/part` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Upload a single part (base64 body) |
| POST | `/api/storage/upload/complete` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Complete multipart upload |
| POST | `/api/storage/upload/abort` | Session cookie | [REQ-STOR-008](../../sdd/spec/storage.md#req-stor-008-multipart-upload-for-large-files) | Abort multipart upload |

## Preferences

| Method | Path | Auth | Implements | Description |
|--------|------|------|------------|-------------|
| GET | `/api/preferences` | Session cookie | [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env), [REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions) | Return the authenticated user's stored preferences, with effective enterprise session mode applied and legacy preset state omitted. |
| PATCH | `/api/preferences` | Session cookie | [REQ-MEM-011](../../sdd/spec/memory.md#req-mem-011-session-mode-storage-resolution-and-propagation), [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env), [REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants), [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions) | Strictly validate and merge supplied preference fields, persist them, reconcile agent configs after a mode change, and return the effective preferences. Limited to 20 requests/minute per rate-limit key. |

`UserPreferences` fields:

| Field | Contract |
|---|---|
| `lastAgentType` | Optional `AgentType`; last selected agent. |
| `workspaceSyncEnabled` | Boolean, default `false`; workspace sync toggle. |
| `fastStartEnabled` | Boolean, default `true`; maps to `FAST_CLI_START` in the container DO. See [Fast Start](container.md#fast-start). |
| `sessionMode` | Optional `SessionMode`; default or advanced. Changes trigger `reconcileAgentConfigs(overwrite: true, cleanup: true)`. Under `ENTERPRISE_MODE`, GET and PATCH responses report `'advanced'` regardless of the stored value (computed via `withEffectiveSessionMode`, not persisted); see [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2. |
| `defaultWorkspace` | `terminal` or `vscode`; defaults to `terminal`. VS Code requires Advanced entitlement. Switching to Standard atomically stores `sessionMode: 'default'` and `defaultWorkspace: 'terminal'`; existing session snapshots are unchanged. See [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions). |
| `sleepAfter` | Optional `SleepAfterOption`; auto-sleep duration. See [Auto-sleep](container.md#auto-sleep-configurable-sleepafter). |
| `userTimezone` | Optional valid IANA timezone, max 64 chars; invalid zones return `ValidationError`. |
| `lastPreseedHash` | Optional SHA-256 prefix of preseed content at last successful reconcile; compared on dashboard load to detect release upgrades. |

`userTimezone` is validated by `Intl.DateTimeFormat` round-trip, persisted to DO storage, and forwarded to the container as `USER_TIMEZONE`; it takes effect on the next session start so memory-capture filenames reflect the user's local time. See [REQ-SESSION-016](../../sdd/spec/session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env) and [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC4.

When `sessionMode` changes, `PATCH /api/preferences` seeds the correct preseed set for the new mode. Reconcile failure is non-fatal and does not block the preference save. Implements [REQ-AGENT-004](../../sdd/spec/agents.md#req-agent-004-two-session-modes-standard-and-pro) AC4-AC5. `lastPreseedHash` supports release-upgrade detection; see [REQ-AGENT-049](../../sdd/spec/agents.md#req-agent-049-auto-upgrade-preseed-on-release).

Under enterprise mode, the response's `sessionMode` is always `'advanced'`. GET computes that value through `withEffectiveSessionMode` without persisting it.

`PATCH` also coerces a supplied `sessionMode` to stored `'advanced'`, so a stale client cannot persist a downgrade or reconcile a live bucket to default mode. Omitting `sessionMode` leaves the stored preference unchanged. This keeps advanced-gated Browser IDE and Vault controls visible for JIT-provisioned enterprise users. See [REQ-ENTERPRISE-001](../../sdd/spec/enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC2.

## LLM API Keys

| Method | Path | Auth | Implements | Description |
|--------|------|------|------------|-------------|
| GET | `/api/llm-keys` | Session cookie | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv), [REQ-AGENT-118](../../sdd/spec/agents.md#req-agent-118-enterprise-consult-llm-unavailability) | Return masked keys (`****` plus the last four characters), never full keys; enterprise mode returns `403` before KV access. |
| PUT | `/api/llm-keys` | Session cookie | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv), [REQ-AGENT-118](../../sdd/spec/agents.md#req-agent-118-enterprise-consult-llm-unavailability) | Set or clear `{ openaiApiKey?: string \| null, geminiApiKey?: string \| null }`; `null` deletes, omission preserves, strings validate and set, and the response masks stored keys. With `ENCRYPTION_KEY`, values use AES-256-GCM; enterprise mode returns `403` before KV access. |
| DELETE | `/api/llm-keys` | Session cookie | [REQ-AGENT-009](../../sdd/spec/agents.md#req-agent-009-llm-api-key-storage-encrypted-in-kv), [REQ-AGENT-118](../../sdd/spec/agents.md#req-agent-118-enterprise-consult-llm-unavailability) | Remove all LLM keys from KV and return `{ success: true }`; enterprise mode returns `403` before KV access. |

Enterprise deployments reject per-user LLM-key management under [REQ-AGENT-118](../../sdd/spec/agents.md#req-agent-118-enterprise-consult-llm-unavailability) AC2. <!-- @impl: src/routes/llm-keys.ts::app.use -->

Keys are stored in KV as `llm-keys:{bucketName}` and scoped per user (derived from auth). On container start, keys are read from KV and injected only as `CODEFLARE_OPENAI_API_KEY` / `CODEFLARE_GEMINI_API_KEY`; `entrypoint.sh` maps them back to bare provider env names only inside the scoped `consult-llm-mcp` server config for Claude (`~/.claude.json`) and Pi (`~/.pi/agent/mcp.json`). The LLM Keys accordion in Settings is only visible when the user can use advanced mode (`canUseAdvanced()`) AND has selected advanced session mode (`currentSessionMode() === 'advanced'`). Admins always qualify for advanced mode but must still select it.

## Public (Onboarding)

GET `/public/onboarding-config`, POST `/public/waitlist` (rate limited; onboarding mode only)

## Public (Landing)

The landing contact surface ([REQ-LANDING-002](../../sdd/spec/landing.md#req-landing-002-demo-request-contact-pipeline)). Both endpoints are gated on SaaS **or** onboarding mode and return `404` in default/enterprise mode.

### GET `/public/contact-config`

Exposes only the public Turnstile site key for the landing form widget.

```json
{ "turnstileSiteKey": "0x4AAA..." }
```

`turnstileSiteKey` is `null` when no site key is configured.

### POST `/public/contact`

Demo-request submission: Turnstile-verified, relayed to all admin users as email (reply-to set to the submitter), and **never persisted** — the only KV writes on this path are rate-limiter bookkeeping. Rate-limited to **5 requests/minute per client IP** (`contact-submit` bucket).

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
- `400` — `VALIDATION_ERROR`: malformed body, a field failing the constraints above, **or** a failed Turnstile verification (`CAPTCHA verification failed`).
- `429` — rate limit exceeded (5/min).
- `502` — `CONTACT_EMAIL_FAILED`: the Resend outbound relay returned a non-2xx response (retryable).
- `503` — `CONTACT_NOT_CONFIGURED` / `CONTACT_NO_ADMIN_RECIPIENT`: Turnstile/Resend secrets absent or no admin recipient configured (same degradation contract as the waitlist).
- `404` — neither SaaS nor onboarding mode is active.

## Health

| Method | Path | Auth | Implements | Owner | Contract |
|---|---|---|---|---|---|
| GET | `/api/health` | Public | — | Worker | `{ "status": "ok", "timestamp": "..." }` <!-- @impl: src/index.ts::app --> |
| GET | `/api/container/health` | Session cookie | [REQ-SESSION-017](../../sdd/spec/session-lifecycle.md#req-session-017-container-health-and-startup-status-api) AC1 | Container status route | `{ success, containerId, container }`; `container` is the private host-health observation <!-- @impl: src/routes/container/status.ts::app --> |
| GET | private host `/health` | Bearer-exempt on the private SDK container path | [REQ-SESSION-017](../../sdd/spec/session-lifecycle.md#req-session-017-container-health-and-startup-status-api) AC1 | Host runtime | Rich host readiness, sync, prewarm, and metric observations; not a public Worker route <!-- @impl: host/src/request-router.ts::createRequestHandler --> |

There is no public `/health` alias, and `/api/health` does not proxy the container. Use `/api/container/health` for an authenticated session-specific observation.

The private host `/health` body contains:

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
| Terminal and Browser IDE | Worker proxy routes plus private host request router | Terminal, Browser IDE | [Container](container.md), [Architecture Internals](architecture-internals.md) |
| Vault and storage | `src/routes/vault/`, `src/routes/storage/` | Vault, Storage, Security | [Vault](vault.md), [Storage & Sync](storage-and-sync.md) |
| Users, authentication, usage, and billing | auth/user/billing routes plus Timekeeper | Authentication, Subscription, Enterprise | [Authentication](authentication.md), [User Provisioning](user-provisioning.md), [Billing](billing.md) |
| Provider integrations and credentials | GitHub/Cloudflare/deploy-key/LLM-key routes | GitHub, Agents, Security | [Security](security.md), [Configuration](configuration.md) |
| Setup and discovery | setup/public/discoverability routes | Setup, Landing, Operations | [Configuration](configuration.md), [Architecture Internals](architecture-internals.md) |

Grouped endpoint tables are valid contract records when their resource section declares the shared handler and the row provides method/path, authentication, requirement, and observable contract. Complex request/response/error schemas remain expanded directly below their route group.

---

## Related Documentation

- [Authentication](authentication.md#three-tier-auth-middleware) - Auth middleware details
- [Security](security.md#rate-limiting) - Rate limits per endpoint
- [Configuration](configuration.md#worker-environment) - Environment variables
