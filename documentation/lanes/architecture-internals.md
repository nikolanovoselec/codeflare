# Architecture Internals

Source composition, runtime and client implementation, cache inventory, backend libraries, and refactoring index for Codeflare.

**Audience:** Developers

**Owns:** source composition, implementation-only control flow, process/client internals, caches, and the historical CF-NNN index. **Does not own:** public contracts, operator procedures, or authoritative state decisions.

See [Architecture](architecture.md) for the system map, component and state ownership, cross-component flows, recovery boundaries, and operator signals.

## Contents

- [Source Module Registry](#source-module-registry)
- [Source Composition](#source-composition)
- [Cross-Process Runtime Composition](#cross-process-runtime-composition)
- [Module-Level Caches](#module-level-caches)
- [Compatibility and Stable Internal Aliases](#compatibility-and-stable-internal-aliases)
- [SaaS and Frontend Composition](#saas-and-frontend-composition)
- [Related Documentation](#related-documentation)
- [Requirement and Source Map](#requirement-and-source-map)

---

<a id="backend-libraries"></a>
## Source Module Registry

| File | Purpose |
|------|---------|
| `src/middleware/auth.ts` | Shared authentication middleware. Delegates to `authenticateRequest()` which throws `AuthError`/`ForbiddenError` on failure. Sets `c.get('user')` and `c.get('bucketName')` for downstream handlers. |
| `src/lib/container-helpers.ts` | Consolidated container initialization: `getSessionIdFromQuery()` (from query param), `getContainerId()` (with validation, never fallbacks), `getContainerContext()` (full context for route handlers). |
| `src/lib/error-types.ts` | `AppError` base class with `code`, `statusCode`, `message`, `userMessage`. Specialized: `NotFoundError` (404), `ValidationError` (400), `ContainerError` (500), `AuthError` (401), `ForbiddenError` (403), `SetupError` (400), `RateLimitError` (429), `QuotaExceededError` (402), `CircuitBreakerOpenError` (503). Utilities: `toError(unknown)`, `toErrorMessage(unknown)`. |
| `src/lib/type-guards.ts` | Runtime type validation replacing unsafe type casts (e.g., `isBucketNameResponse()`). |
| `src/lib/constants.ts` | Single source of truth for shared constants: ports (`TERMINAL_SERVER_PORT = 8080`), session ID validation, CORS defaults, rate limit keys/windows, container fetch timeouts, max tabs, protected paths, request ID config, session limits (`getMaxSessions()`). |
| `src/lib/circuit-breaker.ts` | Prevents cascading failures. States: CLOSED (normal), OPEN (fail fast), HALF_OPEN (testing recovery). Wraps `container.fetch()` calls. |
| `src/middleware/rate-limit.ts` | Per-user rate limiting (bucketName from auth, IP fallback). Stores counts in KV. Adds `X-RateLimit-*` headers. |
| `src/lib/logger.ts` | JSON logging with `createLogger(module)`, child loggers with request context. |
| `src/lib/jwt.ts` | RS256 verification against CF Access JWKS (`https://{authDomain}/cdn-cgi/access/certs`). Per-isolate JWKS cache with `resetJWKSCache()`. |
| `src/lib/cache-reset.ts` | Centralized invalidation of CORS + auth config + JWKS caches. Called by setup wizard after configuration changes. |
| `src/lib/cf-api.ts` | Cloudflare API client. `parseCfResponse` checks the `Content-Type` header before JSON parsing; non-`application/json` bodies get a lenient `JSON.parse` fallback, and only a failed parse throws a structured `AppError` carrying the first 200 chars of the body. |
| `src/lib/request-helpers.ts` | Shared request handling: `parseJsonBody(c)` (JSON parse with ValidationError on malformed input), `firstZodError(error)` (first Zod issue message with fallback), `validateSessionId(id)` (throws on invalid format), `maskSecret(value)` (shows last 4 chars). |
| `src/lib/kv-keys.ts` | KV key utilities: session/user key helpers, `SETUP_KEYS` const for the complete typed `setup:*` configuration-key catalogue, `getBaseUrl(kv, requestUrl)`, `listAllKvKeys()`. |
| `src/routes/notifications.ts` | Authenticated per-user Web Push registration and public-key configuration routes with bounded provider/key validation. |
| `src/lib/push-sender.ts` | Trusted Session enrichment, bounded subscription fan-out, fixed payload construction, provider retry classification, and expired-registration cleanup. |
| `host/src/agent-events.ts` | Stream-safe exact OSC frame parser plus the bounded, terminal-one event queue and client-disposition state machine. |
| `src/lib/currency.ts` | Maps a two-letter ISO country code to a supported regional currency. Implements [REQ-SUB-020](../../sdd/spec/subscription.md#req-sub-020-multi-currency-pricing). |
| `src/types.ts` | `BillingStatus` union type with `BILLING_STATUS` const and `isBillingStatus()` guard. `ContainerConfigPayload` groups 16 container initialization params into logical sub-objects (R2 creds, LlmKeys, DeployKeys, preferences). |

`getCurrencyForCountry(country)` maps CH and LI to CHF; GB plus GI, GG, JE, and IM to GBP; Eurozone, other EU, and non-EU European countries to EUR; and all other country codes to USD. <!-- @impl: src/lib/currency.ts::getCurrencyForCountry -->

### Setup Wizard Resilience

**Directory:** `src/routes/setup/`

All Cloudflare API calls in the setup wizard are wrapped in `withSetupRetry()` (defined in `shared.ts`) for transient failure resilience. The wrapper retries up to 2 times (3 total attempts) with exponential backoff (1s, 2s), skipping retry for `CircuitBreakerOpenError`.

**Cross-environment safety:** `resolveManagedAccessApp()` in `access.ts` uses a 4-tier fallback to find existing Access apps: (1) exact domain match, (2) stored app ID from KV, (3) name match + domain validation, (4) `/app/*` suffix + domain validation. Tiers 3 and 4 validate domain to prevent cross-environment collision when multiple environments share a CF account.

**Error propagation:** `listAccessApps()` and `listAccessGroups()` propagate errors through `withSetupRetry` rather than silently returning `[]`. Errors surface as `SetupError` with step details. The frontend `ApiError` carries a `steps` array from `SetupError` JSON responses.

**Reconfiguration boundary:** `POST /configure` updates deployment configuration and Access policy but never invokes `cleanupUserData()` or infers user offboarding from the submitted `allowedUsers` list. Destructive cleanup belongs to an explicit user-removal workflow. **Self-removal prevention:** the backend rejects the request if the current authenticated user is not in the submitted admin list. The Zod schema enforces at least one admin user. <!-- @impl: src/routes/setup/index.ts::ConfigureBodySchema --> <!-- @impl: src/routes/setup/index.ts::app -->

---

<a id="code-structure-pre-launch-refactoring"></a>
## Source Composition

| Area | Responsibility |
|---|---|
| `src/` | Worker routes, policy, Durable Objects, and backend libraries |
| `host/` | Private container HTTP/WebSocket, PTY, activity, and runtime services |
| `web-ui/` | SolidJS application and client state |
| `landing/` | Prerendered landing/login/privacy package |
| `openvscode/` | Browser IDE package composition |
| `stress/` | k6 suite implementations |
| `scripts/` | Build, generation, validation, and CI helpers |
| `sdd/` | Active requirements, acceptance criteria, and decisions |
| `wrangler.toml` | Cloudflare Workers, Durable Objects, Containers, bindings, and default runtime configuration |
| `vitest.config.ts` | Backend Vitest configuration |

The similar Zod schemas in `src/lib/schemas.ts` and `web-ui/src/lib/schemas.ts` intentionally live in separate build targets. The frontend Vite bundle cannot import the Workers backend module; both copies validate the same API contract at their own boundary.

For a live repository tree, run `tree -L 2 -I node_modules` rather than relying on a copied inventory.

**Container DO extraction:** `src/container/index.ts` split into focused modules:
- `container-env.ts`: env var construction, bucket name application, credential injection, prefs-on-restart
- `container-metrics.ts`: collectMetrics, idle detection, Timekeeper ping, KV status updates (immutable spread, not mutation)
- `container-config.ts`: setBucketName, getBucketName, updateEnvVars, ensureVaultKey (superseded for vault encryption by `getVaultEncryptionKey` - see REQ-VAULT-021) - container state/config mutations
- `container-router.ts`: typed `/_internal/*` dispatch (the `INTERNAL_ROUTES` discriminated-union table + `dispatchInternalRoute`), replacing the prior stringly-typed `${method}:${pathname}` Map
- `container-lifecycle.ts`: onStart/onStop/alarm lifecycle hooks extracted from the DO class
- `index.ts`: thin facade owning the DO class shell (constructor, fetch) and delegating config, internal routing, lifecycle hooks, and metrics to the modules above. Sub-modules receive state via explicit interface parameters, not class inheritance.

**Vault route extraction:** the vault domain is the `src/routes/vault/` directory (barrel convention matching `admin/`, `session/`, `setup/`; `index.ts` re-exports the extracted members so existing `routes/vault` importers resolve unchanged), with the view layer promoted out of the routing tier:
- `validation.ts`: `validateVaultRoute` route boundary parsing
- `auth.ts`: `checkVaultOrigin` (origin/CSRF defense, applied before auth), `authenticateVaultRequest`, `assertActiveTier`
- `access.ts`: `assertSessionOwnership` ownership gate
- `crypto.ts`: `getVaultEncryptionKey` key resolution
- `native-sw.ts`: vendored native service worker source + graft transform (AD69)
- `src/lib/vault-view.ts`: HTML rewriting, injection wrappers, and bootstrap orchestration (`rewriteVaultBaseHref`, `injectVaultBootstrapHopHtml`, `injectVaultPrewarmBridge`, `filterVaultFsListing`) — the vault view/templating layer, housed in `lib/` so route/auth churn and template churn stay separate
- `src/lib/vault-browser-scripts.ts`: reusable authored browser-realm callable bodies for worker cutover, prewarm, focus, reload, and bootstrap completion; kept separate from bundled Worker functions so injected pages cannot inherit bundler-only helpers ([AD126](../decisions/README.md#ad126-vault-browser-realm-scripts-are-authored-source-never-serialized-worker-functions))
- `index.ts`: `handleVaultRequest` orchestration wiring the chain origin -> authenticate -> tier -> ownership

**Container lifecycle route extraction:** `src/routes/container/lifecycle.ts` split into focused modules (`lifecycle.ts` re-exports the helpers for existing importers):
- `lifecycle-validation.ts`: `validateSessionAndCheckLimits`, `resolveEffectiveSleepAfter`
- `lifecycle-init.ts`: `setupR2Credentials`, `ensureBucketAndSeed`, `configureContainerDO`
- `lifecycle.ts`: `startOrRestartContainer` orchestration + the `/start` and `/destroy` route handlers

**Session store extraction (CF-013):** `web-ui/src/stores/session.ts` split into focused modules:
- `session-polling.ts`: refreshSessionStatuses, miss counters, start/stop polling. Uses dependency injection via `registerPollingDeps()`.
- `session-usage.ts`: UsageState, warning levels, localStorage cache, `getDismissedQuotaLevel`/`setDismissedQuotaLevel` for per-UTC-month banner dismissal. Self-contained, no circular deps.
- `session.ts`: facade re-exports the consumer-facing members; `setUsageState` is
  consumed directly from `session-usage.ts` by its sole caller (`session-polling.ts`),
  and the `UsageWarningLevel`/`UsageState` types have no consumers outside
  `session-usage.ts` itself. Neither is re-exported (knip 6.29 dead-export removal).

**Type safety fixes (CF-007):** `countPaidSlots` typed (no more `any[]`). Admin PATCH user uses `updateUserRecord` (not raw `KV.put`). `maxUsers` added to frontend `GetUsersResponseSchema` (no more double cast).

**Validation consolidation (CF-009):** 4 inline `SESSION_ID_PATTERN.test()` in `crud.ts` replaced with `validateSessionId()` from `request-helpers.ts`. Errors flow through global handler with consistent JSON shape.

**Shared config schema (CF-006):** `SetBucketNameBodySchema` in `container-config-schema.ts` - Zod schema for setBucketName payload with `.passthrough()` for flexibility. Deploy credential fields use conditional spread (not explicit `null`).

**ScrambleText consolidation (CF-016):** `ScrambleText.tsx` rewritten as a thin wrapper around `useScrambleText` hook (canonical `requestAnimationFrame` implementation). Single source of truth for scramble animation. Hook accepts `animateOnMount` option to trigger scramble on first render.

---

<a id="runtime-and-client-internals"></a>
## Cross-Process Runtime Composition

The [Architecture](architecture.md) lane owns component boundaries and cross-component flow. This section owns the source composition and implementation mechanisms behind those boundaries.

### Worker routing internals

`src/index.ts` is the Hono entry point and asset gateway. WebSocket route validation runs before Hono dispatch because the Workers runtime upgrade path cannot be treated as an ordinary routed response. Authentication middleware and `requireAdmin` establish identity before protected route modules execute. <!-- @impl: src/middleware/auth.ts::requireAdmin -->

The route catalogue and HTTP outcomes live in [API Reference](api-reference.md). CORS sources and `run_worker_first` asset paths live in [Configuration](configuration.md); failures where an API route or fingerprinted asset falls through to SPA HTML live in [Troubleshooting](troubleshooting.md).

### Container and interception composition

`src/container/index.ts` is a thin Durable Object facade over configuration, lifecycle, routing, metrics, and environment modules. `src/container/container-interception.ts` builds one ordered registry before container start:

1. Host-specific LLM interception owns OpenAI-wire traffic in enterprise mode.
2. Host-specific GitHub interception owns GitHub web, API, and Copilot MCP hosts in enterprise mode.
3. Cloudflare Browser interception owns account API and CDP traffic when its user or enterprise token boundary applies.
4. The optional strict-egress catch-all receives otherwise-unclaimed direct-internet traffic.

The platform resolves denied hosts, host-specific registrations, and the catch-all in that order. A mandatory LLM registration failure aborts enterprise startup; independently optional transports remain bounded by their own contract.

`LlmInterceptor` buffers model-routable requests so a complete REST 404 can be replayed through the compatibility transport before any stream starts. It strips container placeholder authorization, selects `dynamic/<route>` through the shared route-catalogue resolver, keeps REST/OpenAI request fields on the REST leg, removes incompatible fields only for the compatibility replay, and normalizes streamed Chat Completions that reach `[DONE]` without a terminal `finish_reason`. The same ordered configured user-group list controls first-match route restrictions and the bounded metadata tags. Credential containment and exact configuration remain in [Security](security.md) and [Configuration](configuration.md).

`EgressController` preserves end-to-end caller authorization for transparent traffic and strips only hop-by-hop headers. It routes direct-internet requests through `env.EGRESS`, rejects literal-IP targets before sending, and fails closed when strict mode lacks the binding. Account-scoped Cloudflare API/Browser Rendering destinations and the session's exact own-account R2 bucket bypass that hop. R2 is re-signed with the DO-held bucket-scoped key while preserving streaming and SSE-C headers; another bucket fails before any send. WebSocket upgrades are bridged through a fresh pair rather than returned as an upstream socket. The Container DO resolves strict mode once at start so catch-all wiring and placeholder R2 credentials cannot disagree. <!-- @impl: src/egress-controller.ts::EgressController -->

A validated credential rotation replaces the strict catch-all before later traffic. See [REQ-ENTERPRISE-026](../../sdd/spec/enterprise-mode.md#req-enterprise-026-strict-r2-interception-preserves-user-bucket-authority). <!-- @impl: src/container/container-interception.ts::refreshStrictEgressInterception -->

`CloudflareBrowserInterceptor` uses the wiring-time bucket identity rather than a caller header. It refreshes non-enterprise OAuth tokens for Cloudflare API and AI Gateway requests, injects enterprise Browser Rendering tokens where configured, handles REST and CDP WebSockets through the same relay/bridge boundary, and returns 401 without upstream traffic when no valid token is available.

### GitHub integration internals

The integration spans `src/routes/github.ts`, `src/routes/github-auth.ts`, `src/lib/github-token.ts`, `src/github-interceptor.ts`, `host/src/git-clone.ts`, `host/src/request-router.ts`, and `web-ui/src/components/github/`.

The token provider uses the existing encrypted `DeployKeys.githubToken` record. Enterprise containers hold only a placeholder: `GitHubInterceptor` resolves the real token from the session-bound bucket and stamps host-appropriate Basic or Bearer authorization. Other modes retain the existing `GH_TOKEN` container transport. AI interception and GitHub interception remain separate Worker entry points even though both use the Containers host-interception layer.

New-session cloning is an entrypoint directive that runs before the selected agent starts. Running-session cloning uses the authenticated private host endpoint. Both validate `owner/name`, optional ref, and destination absence. [API Reference](api-reference.md#github-integration) owns public outcomes.

The browser panel shares a column with Storage. Desktop/tablet use a measured top/bottom split: GitHub anchors at the top, Storage at the bottom, and the larger face absorbs spare height until both meet at equal allocation. Narrow or short layouts expose one face with a flip control. GitHub is the default enabled face; Storage is sole only when GitHub is disabled. Search is disclosed by a focus-preserving toggle on every breakpoint, and mobile keyboard handling scrolls the revealed field into view. These behaviors implement [REQ-GITHUB-009](../../sdd/spec/github.md#req-github-009-github-repository-list-viewport-and-empty-states), [REQ-GITHUB-010](../../sdd/spec/github.md#req-github-010-mobile-github-and-storage-face-switching), [REQ-GITHUB-011](../../sdd/spec/github.md#req-github-011-mobile-search-disclosure-with-autofocus), and [REQ-GITHUB-012](../../sdd/spec/github.md#req-github-012-responsive-github-and-storage-panel-allocation) without creating backend session state.

### Browser IDE internals

The Browser IDE runs pinned code-server inside the selected session container and reaches it only through the authenticated session proxy. The Worker and host reject public workspace selectors independently. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> <!-- @impl: host/src/request-router.ts::createRequestHandler --> Under [REQ-IDE-035](../../sdd/spec/browser-ide.md#req-ide-035-canonical-browser-ide-workspace-projection), the host injects the fixed canonical `/home/user/workspace` projection only into the private root workbench response and fails closed when the pinned workbench shape cannot be verified. Pinned code-server's HTML carries a deliberate `remote` placeholder while its browser bootstrap replaces `remoteAuthority` with `location.host`; the host therefore gives the projected `folderUri` its already-canonicalized public `Host` authority. Otherwise the renderer session uses `vscode-remote://remote/...` while remote-extension-host edits transform to `vscode-remote://<public-host>/...`, which the Inline controller correctly treats as two documents. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace --> <!-- @impl: host/src/request-router.ts::createRequestHandler -->

Every inventory manages `workbench.startupEditor` to `none` before the Codeflare-owned welcome extension opens, so a fresh browser receives only the owned welcome rather than code-server's default Welcome editor. The extension contributes no agent, provider, or external-content surface ([REQ-IDE-024](../../sdd/spec/browser-ide.md#req-ide-024-codeflare-browser-ide-welcome)). Pi receives the owned native participant and compatibility providers; Claude receives the exact checksum-pinned official package; unsupported agents receive an empty base inventory. code-server's bundled Copilot extension is removed from the image so the account-backed setup does not compete with Codeflare. <!-- @impl: openvscode/agent-sidebar/src/welcome-extension.ts::activate --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildBaseOpenVscodeSettings --> <!-- @impl: Dockerfile::rm -rf /opt/code-server/lib/vscode/extensions/copilot -->

At launch, the selected immutable base inventory is symlinked into a fresh writable `/run/codeflare/openvscode/data/extensions` layer. The always-present welcome extension then validates `~/.codeflare/ide-extensions.json` after `onStartupFinished`, requires the durable warning acknowledgement before restored code can execute, restores missing exact Open VSX versions with two workers and one structured not-found fallback, applies contributed settings after extension registration, and captures registry-truth versions plus bounded settings. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence -->

Extension-host, registry, and contributed-setting changes share one debounce; welcome deactivation flushes pending settings, and the post-reap Python capture closes uninstall races without touching live-captured settings. Fixed identities are excluded, `.obsolete` alone proves uninstall, and changed atomic writes wake only the existing bisync daemon. No VSIX, extracted package, extension storage, SecretStorage, Accounts, enablement, keybinding, snippet, or secondary-download state enters the manifest. <!-- @impl: entrypoint.sh::_openvscode_seed_extension_layer --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::activateExtensionPersistence --> <!-- @impl: scripts/browser-ide-extensions.py::capture -->

Panel and editor turns share one IDE-owned Pi RPC process and in-memory conversation, separate from terminal Pi. `NativePiRuntime` reserves both FIFO because stream events carry no prompt ID. Panel turns retain unrestricted tools and stored context. An editor turn temporarily exposes one terminating result tool, gives the provider only its current-turn suffix, dispatches through Pi's `ExtensionAPI.sendUserMessage`, then restores the exact prior tools.

On structurally recognized OpenAI Chat Completions and Responses payloads, the extension removes every other tool, selects the result function exactly, and disables parallel calls. The backend binds the result to its active generation and editor turn; for edit outcomes, the VS Code adapter validates the captured document version and bounded ranges before emitting native text edits. Normal completion retains the backend; cancellation, malformed results, command-attributed or nested `<runtime>` dispatch errors, and transport failures retire it before replacement. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::NativePiRuntime --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::constrainInlineOpenAiPayload --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::parseInlineEditResult -->

For panel turns, the backend keeps answer and provider reasoning deltas separate. The participant forwards reasoning to Code OSS's native thinking presentation and coalesces tool starts into bounded, argument-free activity categories, so repeated reads and commands do not create an unbounded progress list. Sidebar OpenAI Responses requests replace automatic summary selection with provider-authored detailed summaries; payloads without that Responses reasoning shape, including the existing Qwen route, remain byte-identical. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::requestSidebarReasoningSummary -->

Editor turns suppress unstructured final-answer markdown and treat the invoking prompt as a requested document change. Edit results retain their bounded explanation and count in result details; only already-satisfied requests or those with no valid safe edit render a no-change explanation without opening an editor transaction. Schema-invalid raw result starts may be corrected within three attempts; invalid-only settlement reports a bounded category. <!-- @impl: preseed/agents/pi/extensions/inline-edit.ts::registerInlineEditMode --> <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-027: a native Pi panel turn streams reasoning, bounds tool progress, and settles with its answer) --> <!-- @test: openvscode/agent-sidebar/test/backend-generation.test.ts (REQ-IDE-030: inline Pi accepts a valid retry after one invalid raw result) -->

Under [REQ-IDE-033](../../sdd/spec/browser-ide.md#req-ide-033-controller-owned-inline-review-lifecycle), the pinned request's editor location supplies the sole document, selection, version, and edit URI even if focus changes. Codeflare emits a host-ingested empty start marker, one non-empty text-edit batch, and a completion marker for that URI. The managed Pi profile pins the configuration-gated chat-edited-file opener off; the pinned controller's different-URI side-group path is unconditional. `InlineChatController` owns Keep/Close, settlement, disposal, and navigation; Codeflare emits no confirmation, notification action, Chat Editing command, or document reopen. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::parseInlineEditorLocation --> <!-- @impl: openvscode/agent-sidebar/src/extension.ts::activate --> <!-- @impl: openvscode/agent-sidebar/src/pi/vscode-native-chat.ts::collectNativePiPromptInput --> <!-- @impl: openvscode/claude/managed-settings.mjs::buildPiOpenVscodeSettings --> <!-- @test: openvscode/claude/test/managed-settings.test.mjs (REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1 + REQ-IDE-033: Pi settings keep Inline edits in the invoking editor) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-033: missing or malformed host editor location fails before Pi or edit emission) -->

[REQ-IDE-034](../../sdd/spec/browser-ide.md#req-ide-034-bounded-inline-lifecycle-diagnostics) adds no lifecycle behavior. Under [AD131](../decisions/README.md#ad131-inline-diagnostics-retain-only-sanitized-resource-identity), one bounded editor-request window records a revision marker, effective settings, sanitized request and stream identities, and capped tab events plus snapshots in the local **Codeflare Inline Chat** Output channel. Resource identity retains only scheme, authority without userinfo, basename, and stable input type; it excludes full paths, query, fragment, tab labels, document content, and panel turns, then disposes listeners and timers with the extension. <!-- @impl: openvscode/agent-sidebar/src/extension.ts::createInlineDiagnostics --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-005 AC5 + REQ-IDE-013 AC1 + REQ-IDE-019 AC2+AC5 + REQ-IDE-034: native Pi registers account-free panel and editor Chat) --> <!-- @test: openvscode/agent-sidebar/test/activation.test.ts (REQ-IDE-020 + REQ-IDE-026 + REQ-IDE-029 + REQ-IDE-033 + REQ-IDE-034: inline edits stay bound to the invoking host document) -->

Under [REQ-IDE-043](../../sdd/spec/browser-ide.md#req-ide-043-native-pi-provider-history-isolation), cold panel creation or replacement receives bounded visible history from the requesting surface; warm panel turns omit replay, and Inline turns retain only their current-turn suffix. <!-- @impl: openvscode/agent-sidebar/src/pi/native-chat.ts::buildNativePiPrompt --> `PiRpcBackend` owns strict JSONL process transport, streaming events, blocking UI requests, turn settlement, abort, and process stop. Spawn/protocol/input failure or unexpected exit makes that backend non-reusable. <!-- @impl: openvscode/agent-sidebar/src/pi/node-rpc-backend.ts::PiRpcBackend -->

Pi receives bounded active-document content, selection, open workspace files, diagnostics, and explicit references. Canonical path checks reject external and symbolic-link escapes. `select` and `input` blocking requests are bounded and cancellable; malformed or unsupported requests fail closed. Pi remains otherwise unrestricted, so direct effects are not transactional editor text edits.

Claude uses an isolated allowlisted temporary configuration projection, unrestricted permission mode, and Anthropic's authenticated loopback IDE MCP. Codeflare does not patch the official package or bridge generic VS Code Authentication. The package and local MCP boundaries are accepted under [AD114](../decisions/README.md#ad114-native-pi-chat-and-the-official-claude-extension-own-editor-integration).

Live code-server databases, extension package bytes, extension storage, SecretStorage, authentication, chat, logs, and unmanaged settings remain ephemeral. After a generation is fully reaped, the UI exporter persists only allowlisted theme, string-valued keyboard layout, Explorer expansion, and canonical in-workspace open-file state. The extension manifest separately persists at most 50 lowercase identities and 32 KiB of contributed User settings inside 64 KiB. Managed and UI-continuity settings remain authoritative; the one-time warning records that ordinary user extensions execute with code-server's root-capable, proposed-API posture.

Launch generations carry PID, process group, start time, and a random token; native Pi adds a narrower process token and official Claude descendants inherit the launch token. Cleanup scans and reaps the applicable generation before replacement or session shutdown. Active requirement status and outstanding evidence remain authoritative in `sdd/spec/browser-ide.md`; this implementation account does not promote Partial requirements.

### Terminal and frontend internals

The host uses one shared activity tracker. Classified terminal input and every client-to-server Browser IDE frame advance `lastInputAt`; terminal output, server-to-client IDE traffic, protocol chatter, Vault activity, and autonomous-agent output do not. `collectMetrics()` owns the resulting idle decision.

A PTY may have several clients, but one foreground owner applies resize. The first client owns by default, a focused pane claims authority before resizing, and detach transfers authority to a remaining client. Stale hidden clients therefore cannot overwrite the visible pane's dimensions. <!-- @impl: host/src/session.ts::resize --> <!-- @impl: host/src/session.ts::detach --> <!-- @impl: web-ui/src/stores/terminal.ts::clearPendingResizeAuthority -->

`terminal-workspace.ts` separates running, visible, connected, and focused state. Dashboard has no terminal panes; a real session has its visible active/tiled panes; MultiView has one pane per selected member. Hidden running sessions mount no xterm instance or WebSocket and cannot own resize, input, or URL detection.

MultiView is a browser-local virtual workspace. It validates members against live sessions, allows two to four desktop members and exactly two tablet members, remains hidden on mobile, and is never sent to lifecycle, quota, storage, metrics, or terminal-route APIs. Focused-pane ownership prevents cleanup from an old pane clearing the current pane's detected URL.

On dashboard navigation, Layout starts a 60-second disconnect grace. Returning before expiry cancels it and reconnects only exact visible terminal keys. When a backgrounded tab becomes visible, Layout also refreshes session status and Storage silently so aborted requests do not leave stale UI. Connection generations prevent stale cleanup from closing newer sockets. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/stores/terminal.ts::reconnectDisconnectedTerminals -->

Session cards combine authoritative KV status with visible connection state: running and connected is green, running and disconnected is yellow, stopped is gray. A server-authoritative stopped close ends retries; transient transport closes remain retryable until persisted status converges.

The terminal host strips emulator replies before writing browser input to the PTY, classifies actual input separately for idle tracking, forwards synchronized-output frames atomically to xterm, and keeps protocol control frames distinct from raw terminal bytes. Terminal-one output also passes through `OscAgentEventParser`, which recognizes only the fixed reviewed Pi and Claude frames while leaving the PTY byte stream untouched.

`AgentEventQueue` snapshots the attached terminal-one clients for each event. One suppress response cancels delivery globally, while an all-away snapshot grants local display to one client and waits for confirmation. The granted browser rechecks the same five presence factors before display and confirmation. A new attachment receives unresolved events and can suppress them through the same event-specific protocol; attachment alone preserves fallback, while classified input cancels host-owned residue ([REQ-TERM-023](../../sdd/spec/terminal.md#req-term-023-away-only-agent-notification-delivery), [REQ-TERM-028](../../sdd/spec/terminal.md#req-term-028-notification-reconnect-reconciliation-and-cancellation), [REQ-SEC-024](../../sdd/spec/security.md#req-sec-024-agent-notification-delivery-trust-boundaries)).

Zero-client events, disposition timeouts, and unconfirmed local grants remain in the host queue for the authenticated private drain. `collectMetrics()` uses the DO lifecycle Bearer, validates the exact four-field response against the host clock, and enriches it only from the DO's session ID plus the KV Session record. `sendAgentEventPushes()` builds fixed payloads and fans out through `edgepush` under its own bounded AbortSignal deadline; a stalled provider cannot hold metrics or alarm re-arming ([REQ-TERM-023](../../sdd/spec/terminal.md#req-term-023-away-only-agent-notification-delivery), [REQ-SEC-024](../../sdd/spec/security.md#req-sec-024-agent-notification-delivery-trust-boundaries)).

Running drain, push, and ACK operations are independently bounded, while final delivery also shares the remaining shutdown budget across its phases. Successful or terminal provider outcomes are ACKed back to the host, while transient or timed-out outcomes remain eligible until the host age bound. The DO's pending-ACK set is instance-local. It is deliberately not a second queue. A provider-accepted push may still arrive after a later attach or input because Web Push has no recall operation ([REQ-TERM-023](../../sdd/spec/terminal.md#req-term-023-away-only-agent-notification-delivery), [REQ-SEC-024](../../sdd/spec/security.md#req-sec-024-agent-notification-delivery-trust-boundaries)).

The notification path does not call `recordInput()`, change `lastInputAt`, add a service-worker fetch/sync handler, or contact a stopped container. Final idle, quota, Stop, and Delete drains run before final R2 sync; terminal-convergence recovery skips them because its host transport is already unavailable. Canonical clicks stay on `/app/session/:sessionId`; the SPA selects only an ID found in the authenticated Session store and does not start a stopped session. Terminal tab-one startup, tiling, write batching, and process-name control remain governed by [REQ-TERM-005](../../sdd/spec/terminal.md#req-term-005-tab-1-auto-starts-the-configured-agent), [REQ-TERM-007](../../sdd/spec/terminal.md#req-term-007-tiling-layouts-2-split-3-split-4-grid), [REQ-TERM-008](../../sdd/spec/terminal.md#req-term-008-write-batching-at-30fps), and [REQ-TERM-009](../../sdd/spec/terminal.md#req-term-009-process-name-detection-via-control-messages). Requirement status and remaining deployed evidence stay authoritative in [REQ-TERM-023](../../sdd/spec/terminal.md#req-term-023-away-only-agent-notification-delivery), [REQ-TERM-025](../../sdd/spec/terminal.md#req-term-025-per-device-notification-enrollment), [REQ-TERM-027](../../sdd/spec/terminal.md#req-term-027-service-worker-notification-display-and-navigation), [REQ-SEC-023](../../sdd/spec/security.md#req-sec-023-agent-notification-capability-boundaries), and [REQ-SEC-024](../../sdd/spec/security.md#req-sec-024-agent-notification-delivery-trust-boundaries).

### Landing implementation

The Landing package is a static Astro build rooted at `/landing` and emitted into the main web asset tree. `tokens.css` owns fonts, colors, type/space scales, easing, and layout constants; `global.css` consumes those tokens for page and component styling. Typed copy, links, proof identifiers, and navigation live in `site.ts`; components render that data without private copies.

`BaseLayout.astro` server-renders the dark first-paint contract and `html.flare-on` on the marketing page. `splash.ts` mounts the WebGL canvas when supported and retires it to the CSS fallback on reduced motion, coarse-pointer backgrounding, unavailable WebGL, or context loss. Login and privacy omit the marketing motion/proof system. The server output is complete without JavaScript; scripts enhance rather than reveal required content.

The Hero family includes the primary product hero and the optional Inference Mesh band. The mesh reuses shared terminal/transcript chrome and presents company-owned idle compute as an additional inference source, not the only or default route ([REQ-LANDING-005](../../sdd/spec/landing.md#req-landing-005-inference-mesh-family-hero)). The fixed in-flow sign-in CTA preserves navigation geometry while its hover shell changes ([REQ-LANDING-006](../../sdd/spec/landing.md#req-landing-006-enter-the-matrix-sign-in-cta)).

The Execution overview renders software-delivery and infrastructure runs from the typed `EXECUTION` model ([REQ-LANDING-010](../../sdd/spec/landing.md#req-landing-010-execution-overview-reel)). The software sequence follows Codeflare Inference Mesh PR #1 from clone and planning through SDD/TDD, review, integration verification, merge, and branch realignment; its approved merged-PR link remains part of the terminal evidence ([REQ-LANDING-015](../../sdd/spec/landing.md#req-landing-015-execution-reel-merged-pr-link)). The infrastructure sequence follows CVE-2024-6387 discovery, canary-first approval, bounded fleet remediation, rescan, and evidence publication. <!-- @impl: landing/src/content/site.ts::EXECUTION --> <!-- @impl: landing/src/components/Transcript.astro::transcript-feed --> <!-- @impl: landing/src/styles/global.css::terminal-inline-link -->

Progressive motion restores a fitted context prefix, stages one pending row, types that same row first, then appends authored events in order while preserving frame geometry ([REQ-LANDING-011](../../sdd/spec/landing.md#req-landing-011-execution-reel-progressive-motion)). Reduced motion shows complete resolved viewports. Capture readiness uses the stable execution marker. REQ-LANDING-012, REQ-LANDING-013, and REQ-LANDING-014 remain Partial pending their separate deployed/manual checks.

The Browser IDE band renders a workbench-shaped proof with activity rail, explorer, editor, integrated terminal, tab, and status bar ([REQ-LANDING-007](../../sdd/spec/landing.md#req-landing-007-browser-ide-continuity-band)). Narrow viewports fold away rail/explorer. The same terminal reel and single coral accent connect it to the rest of the landing without claiming a second runtime.

`proof.ts`, `type-on-view.ts`, `feature-terminals.ts`, `hero-kicker.ts`, `scramble.ts`, `reveal.ts`, `agentfoot.ts`, `orch.ts`, and `splash.ts` own separate enhancement responsibilities. `proof.ts` reveals resolved rows once; `type-on-view.ts` handles the marked final-line cursor sequence; `feature-terminals.ts` loops authored command beats; `hero-kicker.ts` measures and advances the capability ticker; `scramble.ts` churns within a reserved footprint; `reveal.ts` arms below-fold entrances; `agentfoot.ts` animates calm status detail; `orch.ts` advances the authored orchestration feed.

Shared composition is:

| Concern | Responsibility | Source |
|---|---|---|
| Page composition | Orders the narrative and subordinate bands | `landing/src/pages/index.astro` |
| Content model | Centralizes copy, links, proof IDs, and navigation | `landing/src/content/site.ts` |
| Shared sections | Renders peer sections and substations | `landing/src/components/Section.astro`, `SectionHead.astro` |
| Shared terminals | Renders terminal frames, transcript hooks, and resting state | `landing/src/components/Terminal.astro`, `Transcript.astro` |
| Proof animation | Reveals resolved rows after visibility | `landing/src/scripts/proof.ts` |
| Feature reels | Types, holds, deletes, and advances authored beats | `landing/src/scripts/feature-terminals.ts` |
| Reveal motion | Arms one-shot below-fold entrances | `landing/src/scripts/reveal.ts` |
| Scramble motion | Churns glyphs without reflow | `landing/src/scripts/scramble.ts` |
| Orchestration proof | Advances authored agent rows and counters | `landing/src/scripts/orch.ts` |
| Design tokens | Defines shared visual constants; global styles consume them | `landing/src/styles/tokens.css`, `landing/src/styles/global.css` |
| Navigation and trust | Renders typed pillars, sign-in, proof, FAQ, and footer controls | `landing/src/components/Header.astro`, `landing/src/pages/index.astro` |

The Worker serves fingerprinted assets with immutable caching while HTML revalidates. SaaS and onboarding may rewrite unauthenticated entry to the landing; default and enterprise remain private. Discoverability documents are mode-aware: public modes publish robots, sitemap, and product summary; private modes disallow indexing and omit public discovery surfaces.

---

## Module-Level Caches

Workers isolates do not share memory. Each cache is an optimization with an explicit consistency window; KV or the owning external system remains authoritative.

| Module | Cache | Lifetime / TTL | Reset |
|---|---|---|---|
| `src/lib/access.ts` | Auth domain and audience | 5 minutes when configured; 30 seconds for null/pre-setup state | `resetAuthConfigCache()` |
| `src/lib/subscription.ts` | Tier configuration | 60 seconds | `resetTierConfigCache()` |
| `src/lib/cors-cache.ts` | Dynamic origins | 5 minutes | `resetCorsOriginsCache()` |
| `src/lib/jwt.ts` | Access JWKS | 1 hour; a key-ID miss may refresh after 30 seconds | `resetJWKSCache()` |
| `src/lib/stripe.ts` | Price and currency options by price ID | 1 hour per ID; no map-wide size bound or pruning | Requested stale ID refreshes; new isolate clears all |
| `src/lib/kv-crypto.ts` | Imported AES key | Isolate lifetime | New isolate or changed secret |
| `src/lib/rate-limit-core.ts` | Per-key fallback rate-limit windows during KV failure | Caller window; expired cleanup every 100 inserts; 10,000-entry FIFO cap | Window cleanup, oldest-entry eviction, or new isolate |
| `src/lib/circuit-breakers.ts` | Per-container breaker state | 5 idle minutes; 10,000-entry LRU cap per map | `resetContainerBreakersForReset()` during setup reset |
| `src/lib/session-jwt.ts` | Imported HMAC key | Isolate lifetime | Re-import when secret changes |
| `src/timekeeper/index.ts` | User records used for quota decisions | 60 seconds; 100 entries | `resetUserRecordCache()` |

After an admin changes configuration, different isolates may enforce old and new values within the listed window. This is the accepted KV-read trade-off; it is not strong-consistency state.

The original 1,500-user sizing model estimated that approximately 195-byte session-list metadata reduced KV reads from roughly 901,000 to about 300 per second, while the Timekeeper cache reduced 1,500 user-record reads per minute to about 25. Those figures are historical sizing evidence, not a current service-level guarantee. Current contracts are:

- Batch status performs zero per-session `KV.get` calls for metadata-bearing records ([REQ-SESSION-010](../../sdd/spec/session-lifecycle.md#req-session-010-session-status-observable-from-dashboard)).
- Session-list metadata uses compact field names to reduce its serialized size against Cloudflare KV's metadata limit. <!-- @impl: src/lib/kv-keys.ts::SessionListMetadata -->
- The Timekeeper user-record cache retains its 60-second TTL and 100-entry bound. <!-- @impl: src/timekeeper/index.ts::USER_RECORD_CACHE_TTL_MS --> <!-- @impl: src/timekeeper/index.ts::USER_RECORD_CACHE_MAX -->

---

<a id="appendix-cf-nnn-code-index"></a>
## Compatibility and Stable Internal Aliases

| Code | Description | Source Location |
|------|-------------|-----------------|
| CF-001 | Turnstile token enforcement; rate-limit bypass prevention | src/routes/auth.ts, src/routes/stripe-webhook.ts, src/index.ts |
| CF-002 | Promise dedup for concurrent cold-start KV reads | src/lib/access.ts |
| CF-003 | Deny requests when KV unavailable (security-critical) | src/middleware/rate-limit.ts, src/lib/rate-limit-core.ts |
| CF-004 | Reset tiers to free on subscription.deleted | src/routes/stripe-webhook.ts, src/routes/usage.ts |
| CF-005 | Default undefined tiers to pending (block access) | src/lib/access.ts, src/lib/subscription.ts |
| CF-006 | Explicit null check; use getEffectiveTier | src/routes/billing.ts, src/routes/terminal.ts |
| CF-007 | Fetch tiers before priceId lookup; staleness window | src/routes/billing.ts, src/lib/subscription.ts, src/timekeeper/index.ts |
| CF-008 | Atomic read-merge-write for user KV records | src/lib/user-record.ts |
| CF-009 | Default both undefined tiers to pending | src/lib/subscription.ts |
| CF-010 | Rate-limit webhook; parseUserRecord validation | src/routes/stripe-webhook.ts, src/lib/access.ts |
| CF-011 | Prefer metadata.email over customer_email; typed user records | src/routes/stripe-webhook.ts, src/lib/user-record.ts |
| CF-012 | Decode URI-encoded sequences before path-traversal check | src/routes/storage/validation.ts |
| CF-013 | Session store extraction (facade pattern) | web-ui/src/stores/session.ts, session-polling.ts, session-usage.ts |
| CF-014 | Module-level cache inventory | See [Module-Level Caches](#module-level-caches) |
| CF-015 | Catch missed subscription.deleted via billing period expiry | src/lib/subscription.ts |
| CF-016 | ScrambleText consolidation to hook-based pattern | web-ui/src/lib/use-scramble-text.ts, web-ui/src/components/ScrambleText.tsx |
| CF-017 | Warn on plaintext credential storage when ENCRYPTION_KEY absent | src/index.ts, src/lib/kv-crypto.ts, src/lib/access.ts |
| CF-018 | billingPeriodEnd enforcement; unlimited tier exemption | src/lib/subscription.ts |
| CF-020 | Timekeeper delta clamping / alarm retry; admin inquiry email; mobile input dispatch | src/lib/email.ts, web-ui/src/lib/terminal-mobile-input.ts |
| CF-021 | Trial always in usage hours (trialDays fallback removed) | web-ui/src/components/SubscribePage.tsx |
| CF-022 | KV rollback on container start failure; separate try/catch for KV reads | src/lib/cors-cache.ts, src/routes/container/lifecycle.ts |
| CF-023 | Check existing subscription before overwriting | src/routes/stripe-webhook.ts |
| CF-024 | Missing webhook handler coverage | src/routes/billing.ts |
| CF-027 | Prices from Stripe via admin-configured stripePriceId | src/lib/subscription.ts |
| CF-029 | Cache invalidation for storage deletes | src/routes/storage/ |
| CF-030 | Idempotency key to prevent duplicate checkout sessions | src/lib/stripe.ts |
| CF-032 | Log warning on unresolved customer (was silently dropped) | src/routes/stripe-webhook.ts |

---

<a id="saas-ui-components"></a>
## SaaS and Frontend Composition

SolidJS components for the SaaS auth and subscription flow (`web-ui/src/`). These components handle login, tier selection, onboarding, and admin user management.

### LoginPage (`web-ui/src/components/LoginPage.tsx`)

Shown at `/` when `SAAS_MODE=active`. Detects current auth state:
- Active tier -> redirect to `/app/`; pending -> redirect to `/app/subscribe`; blocked -> show blocked message
- If unauthenticated, fetches providers from `/public/auth/providers` and renders GitHub login button

### SubscribePage (`web-ui/src/components/SubscribePage.tsx`)

Shown at `/app/subscribe`. Two-phase layout:

**Phase 1 (home view):** Logo, feature highlights, status area (varies by user state).

**Phase 2 (plan view):** Mode card (Standard/Pro toggle), lifeline rail (5 plan stops: free -> standard -> advanced -> max -> unlimited), detail panel (price, hours, sessions, CTA button). Tier name and price use `useScrambleText` for decrypt animation on selection change.

**Status text by user state:**
| State | Text | Color |
|-------|------|-------|
| Pending | "Not Subscribed" | Orange |
| Active | "Subscribed" | Green + "Continue" link |
| Blocked | "Blocked" | Red |

### RootPage (`web-ui/src/App.tsx`)

Determines deployment mode from backend:
1. Calls `/public/auth/providers` - if providers returned, show LoginPage (SaaS mode)
2. Calls `/public/onboarding-config` - if active, show OnboardingLanding
3. Otherwise, redirect to `/app/` (default mode with CF Access)

### Admin User Management

Admin users always have `unlimited` tier and advanced session mode access (`canUseAdvanced()` returns `true` for admins). Backend rejects tier changes and deletions for admin-role users. `SettingsPanel` re-fetches `/api/user` each time it opens for live tier refresh.

---

## Related Documentation

- [Architecture](architecture.md) - System map, component boundaries, authoritative state, and data flow
- [API Reference](api-reference.md) - All API endpoints
- [Authentication](authentication.md) - Authentication modes and SaaS billing

---

<a id="specification-coverage"></a>
## Requirement and Source Map

Exhaustive status belongs to the active SDD. This implementation map identifies composition owners and representative contracts.

| Composition concern | Requirements | Source owner |
|---|---|---|
| Worker/container modules | Session Lifecycle, Storage, Vault, Operations | `src/container/`, `src/routes/`, `src/lib/` |
| Cross-process IDE/terminal runtime | Browser IDE, Terminal, Mobile, Agents | `host/src/`, `openvscode/agent-sidebar/`, `web-ui/src/` |
| Authentication/subscription UI | [REQ-AUTH-013](../../sdd/spec/authentication.md#req-auth-013-custom-branded-login-page), [REQ-SUB-017](../../sdd/spec/subscription.md#req-sub-017-enterprise-tier-contact-flow), [REQ-SUB-020](../../sdd/spec/subscription.md#req-sub-020-multi-currency-pricing) | `web-ui/src/`, `landing/` |
| Stable internal aliases | CF-NNN index and source comments/tests | Named modules in this document |
