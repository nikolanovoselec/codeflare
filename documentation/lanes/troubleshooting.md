# Troubleshooting

Diagnostic commands, common failure modes, and resolution steps.

**Audience:** Operators

## Contents

- [Common Issues](#common-issues)
- [Common Failure Modes](#common-failure-modes)
- [GitHub Integration](#github-integration)
- [Browser Run](#browser-run)
- [Diagnostic Commands](#diagnostic-commands)

---

## Common Issues

Frequently encountered problems grouped by symptom, with causes and resolution steps.

### Enterprise Containers Won't Start / Crash-Loop (Terminal Reconnect Storm)

**Symptom:** In Enterprise Mode, sessions never reach a usable terminal. Worker logs (`codeflare-enterprise-<env>`) show a rapid terminal-WebSocket reconnect storm (~10+ per minute), `Error proxying request to container`, and teardown `Final sync did NOT complete on teardown … The container is not running` — i.e. the container's PID 1 keeps exiting. Plain (non-enterprise) sessions on the same image are unaffected.

**Cause:** A failing command in the `ENTERPRISE_MODE=active` block of `entrypoint.sh`, which runs under `set -euo pipefail`, aborts the script and kills PID 1. The block is full of unguarded `jq` command-substitutions; any one of them failing crashes the container. The first instance of this was a `jq --arg def …`/`$def` — `def` is a reserved jq keyword (function definition), a hard compile error on the bookworm base image's jq 1.6 — which crashed every enterprise container until fixed (see [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) AC4).

**Diagnose:** Container stdout/stderr is not shipped to Workers logs, so reproduce the enterprise block locally with the same env the Worker fans (`ENTERPRISE_ROUTE_CATALOG`, `ENTERPRISE_DEFAULT_ROUTE`, `ENTERPRISE_DEFAULT_REASONING`) under `set -euo pipefail` and watch for the first non-zero exit. The configured route catalog/default live in the env KV under `setup:dynamic_routes` / `setup:default_route`.

**Fix:** Correct the failing entrypoint command and redeploy the enterprise image. Keep enterprise-block `jq` calls either guarded (`if jq …; then … else warn; fi`) or free of reserved-keyword `--arg` names; `entrypoint-enterprise-pi-models.test.js` now runs the real models.json build and forbids reserved-keyword jq args.

### New User Has Preseed Configs but No "Docs & Examples"

**Symptom:** A newly provisioned user's R2 bucket contains the agent-config preseed files, but the getting-started Docs & Examples are missing. Clicking **Recreate Docs & Examples** in Settings creates them.

**Cause:** Getting-started docs were seeded only by the one-shot bucket-creation gate, and a freshly created bucket is not always immediately writable on the R2 data plane. That single attempt could fail and be swallowed, and because the create-only gate never re-fired, the docs stayed missing. Agent configs survived because they have other reseed paths (the Recreate button, mode-change reconcile, and the preseed-hash upgrade) that getting-started docs lacked.

**Fix (REQ-STOR-009 AC6):** The seed now self-heals on every session start until a `gettingStartedSeeded` user-preference marker is set, so simply starting (or restarting) a session re-seeds the docs without the manual button.

**Verify** in Workers logs by querying the worker for:

- `Seeded getting-started docs` — the self-heal succeeded.
- `Failed to seed getting-started docs; will retry next session` — a transient failure that will retry on the next session start.

### `/api/*` Returns HTML (SPA Swallow)

API endpoints return HTML instead of JSON. Fix: ensure `run_worker_first = ["/", "/login", "/login/", "/auth/*", "/api/*", "/public/*", "/health", "/landing/*"]` in the `[assets]` section of `wrangler.toml` (any control-plane path missing from this list is served as a static SPA asset at the edge without the Worker running; `/login` missing breaks the onboarding login rewrite, `/api/*` missing breaks setup/auth).

### `/setup` Shows "Access Denied"

Check `GET /api/setup/status` returns JSON. Verify `setup:complete` in KV is absent/false for first-time setup.

### Auth Error After Successful Access Login

Stale `setup:auth_domain` (JWT mismatch), stale `setup:access_aud`, or email casing mismatch. Re-run setup configure. Confirm user keys are lowercase.

### "Unable to find your Access application!"

Browser retained stale Access session. Test in incognito. Clear CF Access cookies. Confirm one managed app with correct destinations.

### Onboarding GitHub Sign-in Bounces to the Landing / `/app` Shows "Authentication required"

**Symptom:** In onboarding mode (`ONBOARDING_LANDING_PAGE=active`, `SAAS_MODE=inactive`), clicking "Continue with GitHub" lands the user back on the marketing landing, and visiting `/app` shows "Authentication Error: Authentication required. Please refresh the page." `/auth/github/login` itself 302s to GitHub correctly.

**Cause (two independent failure modes):**
1. **App-owned session not trusted in onboarding (code).** The onboarding GitHub callback issues a `codeflare_session` cookie, but the access layer (`getUserFromRequest` / `validateSessionOidc`), the session-refresh in `index.ts`, and the `requireActiveUser` tier gate only honour that cookie in an *app-owned OIDC mode* (`isSessionOidcMode` = `SAAS_MODE` active OR `ONBOARDING_LANDING_PAGE` active; [REQ-AUTH-020](../../sdd/spec/authentication.md#req-auth-020-onboarding-mode-landing-integrated-login-and-access-request-flow) AC5). If a deployment somehow runs the callback without onboarding/SaaS being active at the access layer, `/app` rejects the session and the SPA bounces to the landing.
2. **GitHub OAuth App callback domain mismatch (config).** The OAuth App's authorization callback URL must equal `https://<this-domain>/auth/github/callback`. If it points at a different domain (e.g. the production `codeflare.ch` app reused on the integration `codeflare.novoselec.ch` domain), GitHub bounces sign-in back to the *registered* domain. A classic OAuth App allows one callback URL, so each deployment domain needs its own App (see `OAUTH_CLIENT_ID` in [configuration.md](./configuration.md)).

**Fix:** (1) is fixed in code (onboarding is included in `isSessionOidcMode`). For (2), point the deployment's `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` at an OAuth App whose callback is this domain. Quick check: `curl -sI https://<domain>/auth/github/login` should 302 to `github.com/login/oauth/authorize` with `redirect_uri=https://<domain>/auth/github/callback`; that `redirect_uri` host must match the OAuth App's registered callback.

### Container Stuck at "Waiting for Services"

The loading screen waits for both R2 sync and PTY pre-warm to complete before signalling ready. Check `GET /api/container/startup-status?sessionId=xxx` and inspect the `details.syncError` field.

**Port-wait timeout (container killed before reaching the loading screen):** Cloudflare kills a container that does not bind port 8080 within ~10-15s. Since PR #364 the terminal server binds port 8080 at the very start of `entrypoint.sh` - before R2 sync - so this should no longer occur. If it does, check that `node dist/server.js` in `/app/host` exits cleanly: `cat /tmp/terminal.pid` then `kill -0 $(cat /tmp/terminal.pid)`.

**Loading screen hangs after port binds:** PTY pre-warm is gated on `/tmp/codeflare-init-complete`. If sync never finishes, the flag is never written and pre-warm waits up to 130s (`PREWARM_INIT_WAIT_MS`) before proceeding anyway. Common causes: missing R2 credentials, bucket does not exist, network timeout. Check `/tmp/sync.log` for errors.

### R2 Sync Issues

See [Storage & Sync - Troubleshooting](storage-and-sync.md#troubleshooting).

### Zombie Container

Zombie alarm loops are now prevented by two mechanisms: (1) `onStop()` calls `deleteSchedules('collectMetrics')` to immediately kill the alarm loop when a container stops, and (2) `onActivityExpired()` calls `this.stop('SIGTERM')` on unreachable activity endpoints instead of renewing the timeout, which triggers `onStop()` and its schedule cleanup. As a defense-in-depth fallback, `collectMetrics` itself still has three self-termination guards: container-not-running check, missing-identifiers guard, and re-arm guard. These cover edge cases where `onStop()` might not fire (e.g., after `destroy()`).

### Secrets Lost After Worker Deletion

`wrangler delete` nukes all secrets. Re-set with `wrangler secret put`.

### R2 Bucket Cleanup on User Deletion

`DELETE /api/users/:email` and `POST /configure` (stale user removal during reconfiguration) both call `cleanupUserData()` in `src/lib/user-cleanup.ts`, which: destroys all active containers, deletes the user KV entry and bucket-keyed KV entries (`storage-stats:`, `presets:`, `user-prefs:`), reads the scoped R2 token via `getAndDecrypt()` (required because `r2token:{email}` values are encrypted when `ENCRYPTION_KEY` is set - raw `KV.get('json')` throws `SyntaxError` on the `v1:...` ciphertext prefix), deletes the scoped R2 token, empties the R2 bucket via S3 `ListObjectsV2` + `DeleteObjects` loop (using worker-level R2 credentials via `createR2Client` + `emptyR2Bucket`), and deletes the empty bucket via Cloudflare API with retry logic (up to 3 attempts with exponential backoff for R2 eventual consistency when objects were deleted).

If worker-level R2 credentials are not configured (e.g., setup was interrupted), the emptying step is skipped and bucket deletion may fail with `BucketNotEmpty`. This logs `logger.warn` server-side but does not block the overall cleanup. During reconfiguration, stale user cleanup is wrapped in a `runStep('cleanup_stale_users')` call for NDJSON progress visibility in the setup wizard frontend. **SaaS mode:** only admin-role users removed from the admin list are cleaned up - JIT-provisioned regular users are preserved. Each user's KV entry is checked for `role: 'admin'` before qualifying for removal.

### Chrome in CI (Ubuntu 22.04)

`apt install chromium-browser` on Ubuntu 22.04 installs a snap wrapper, NOT real Chromium. Without snapd (which GitHub Actions runners don't have), it installs with exit 0 but provides nothing usable.

**Solution:** Install Chrome via Puppeteer, then install shared libraries individually:
```bash
npx puppeteer browsers install chrome
sudo apt-get install -yqq --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
  libxfixes3 libx11-xcb1 libxext6 libxi6 libxtst6 libxcursor1 \
  fonts-liberation
```

**Note:** Package names differ between Ubuntu versions - 22.04 uses `libatk1.0-0`, 24.04 uses `libatk1.0-0t64`.

### Pi Extension Packages Missing After Restart

**Symptom:** A Pi package installed during a session is missing after container restart.

**Cause:** `PI_OFFLINE=1` (set when Fast Start is ON, the default) prevents `pi update` from running, so packages not in the image cache are absent until Fast Start is disabled.

**Fix:** Disable Fast Start in Settings, restart the session so `pi update` runs, then re-enable Fast Start.

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container won't start | Missing R2 credentials | `wrangler secret list` then `wrangler secret put` |
| `403 Forbidden` on R2 | Expired credentials | Regenerate in CF dashboard |
| Container killed before loading screen | Port 8080 did not bind in time | Check `/tmp/terminal.pid`; verify `node dist/server.js` started |
| Loading screen hangs indefinitely | `/tmp/codeflare-init-complete` never written (sync stalled or pre-flag entrypoint step crashed) | Check `/tmp/sync.log`; verify R2 credentials; check container logs for `[entrypoint] WARNING:` lines. See [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition). |
| WebSocket fails with close code 4503 (`container-stopped`) | Container hibernated or stopped | Reconnects while container is stopped use close code 4503 and do NOT count against the WS rate-limit budget (see [WebSocket Rate Limit](security.md#websocket-rate-limit-req-sec-007)). Wait for the container to restart; the budget is preserved. |
| WebSocket fails with close code 1013 (`container-warming-up`) | Container started but not yet ready - port 8080 bound before R2 sync and `.bashrc` autostart completed | Normal during the ~10s cold-start window. The client's retry backoff will reconnect automatically once `terminalServiceReady` flips to `true`. If 1013 persists beyond 30s: (1) check `/tmp/sync.log` for a stalled R2 sync (same causes as "Loading screen hangs indefinitely" above); (2) if sync looks healthy, check whether a pre-flag entrypoint step crashed under `set -euo pipefail` before `/tmp/codeflare-init-complete` was written - look for `[entrypoint] WARNING:` lines in container logs (e.g. `warm_pi_npm_dependencies` or `update_pi_when_fast_start_disabled` failure); PID 1 dying before the flag write causes an identical symptom. Fixed by PR #440 per [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition). These reconnects do NOT count against the WS rate-limit budget. |
| Session shows `stopped` on the dashboard but container is actually running | `onError` fired on a transient platform event (deploy-roll, monitor blip) and a prior clobber-race guard prevented `collectMetrics` from correcting the status | Self-heals within one `collectMetrics` tick (~60 s) via AC4: when the `/health` probe confirms the container is running but KV reads `stopped` and the persisted deliberate-stop marker (`shutdownRequested` DO storage key) is absent, `collectMetrics` re-asserts `running`. If the dashboard still shows stopped after ~2 min, check `wrangler tail` for `collectMetrics: container running but KV stopped, re-asserting running`; absence of that log line with presence of `collectMetrics: session stopped with shutdown in flight, leaving stopped` means `destroy()` ran a deliberate stop whose marker survived (expected — not a false-stopped case). Absence of both lines means the container genuinely stopped. See [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-persisted-status-is-authoritative-on-container-exit) AC4. |
| Zombie restarts | Stale DO state | Self-terminates via missing-identifiers guard |
| Stop/delete loses the session's recent edits — the next session restores stale or empty state (transcripts, credentials, config missing) | The DO-side final-sync drain was rejected by the in-container auth gate (HTTP 401) before the bisync ever triggered: the drains' raw `port.fetch` bypasses the DO's auth-injecting public fetch override, and on delete `destroy()` wiped `containerAuthToken` before the drain fired. Every teardown sync 401'd for ≥30 days with zero successes; the storage-panel "Sync R2" button worked the whole time because it routes through the worker's authenticated container fetch. | Fixed 2026-06-10 ([REQ-SESSION-011](../../sdd/spec/session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync) AC8): both drains send `Authorization: Bearer` with the token captured before the storage clear. If it recurs, query Workers logs for `Final sync did NOT complete on teardown` — `httpStatus:401` means the auth regression is back; `504`/timeout means the budget path; then check the in-container daemon (`/tmp/sync-daemon.pid`, `/tmp/sync.log`). A healthy delete logs `Final sync audit (teardown)` at info with `outcome:completed`. |
| Deleted session reappears | `onStop()` resurrects KV entry | Verify `destroy()` clears `SESSION_ID_KEY` before `super.destroy()` |
| Container dies during active use | Auth issue on internal paths | Verify `/activity` in `authExemptPaths` in `host/src/server.ts` |
| Container sleeps before configured timeout | Stale `idleTimeoutPref` cache in DO | Each 60s tick re-reads `sleepAfter` from DO storage ([REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants) AC2); if storage holds a corrupt value it is ignored and the previous cached value applies. Check DO storage via `wrangler tail` for `collectMetrics: storage holds invalid sleepAfter value`. |
| Container sleeps later than expected (up to 2h) | `parseSleepAfterMs` fail-safe | When the stored `sleepAfter` is missing or unrecognized, the system defaults to 2h max to avoid losing user work ([REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants) AC1). Correct via Settings panel - the new value writes to storage and takes effect on the next 60s tick. |
| Claude Code reports "Settings Error: matcher Expected string, but received null" | `settings.json` hook entry has `matcher: null` (written by Claude Code's own self-install for `context-mode-cache-heal`); old entrypoint versions passed it through unchanged | Fixed automatically by entrypoint.sh since PR #299. Redeploy (re-run `entrypoint.sh`) to pick up the fix. |
| Claude Code reports "SessionStart:resume hook error" with "Permission denied" in container logs | `~/.claude/hooks/context-mode-cache-heal.mjs` installed by the CLI at 0644; bash refuses to exec a non-executable file via shebang | Fixed automatically by entrypoint.sh since PR #302. Redeploy (re-run `entrypoint.sh`) to pick up the fix. |
| Container start rejects with 500: sleepAfter required | `buildSetBucketNameBody` missing value | The `/start` route failed to resolve the user's effective `sleepAfter` before calling the internal setup helper. Check that the user's preferences are readable and `effectiveTier` resolves correctly ([REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants) AC3). |
| Phantom container on session switch | Reconnect scope issue | Ensure `activeSessionId` filter passed to `reconnectDisconnectedTerminals()` |
| Character doubling in terminal | Handler not disposed on reconnect | Dispose `inputDisposable` before creating new handler in `connect()` |
| Container returns 503 on all authenticated endpoints | `CONTAINER_AUTH_TOKEN` not set | Security default-deny. Token is set automatically by the DO via `crypto.randomUUID()` on lifecycle start. If missing, verify DO `updateEnvVars()` runs before `startAndWaitForPorts()` |
| `graphify: command not found` in terminal ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | System-PATH symlink absent in the image, or entrypoint self-heal did not run | Run `which graphify`; the canonical answer is `/usr/local/bin/graphify` (symlink to `/root/.local/share/uv/tools/graphifyy/bin/graphify`). The Dockerfile creates it; if missing, the image predates `283fc8e` and needs a redeploy. The entrypoint self-heal recreates the symlink on every boot if the source binary exists, so a clean redeploy is sufficient. The system PATH is the canonical resolution path because hook subshells (graphify-active-repo.sh, capture agent, vault-extract agent) cannot see `/root/.local/bin/`. |
| Enterprise Mode: LLM calls fail with TLS certificate errors | Cloudflare containers CA not found or not trusted | Check container logs for `[entrypoint] WARNING: /etc/cloudflare/certs/cloudflare-containers-ca.crt not found` or `WARNING: could not install Cloudflare containers CA`. The CA is mounted by the platform at container start; its absence indicates a platform configuration issue, not an application bug. Verify that `ENTERPRISE_MODE=active` is set and that the container image is current (predates CA-trust block if missing). |
| Enterprise Mode: agent fails with opaque "Connection error" but `curl https://api.openai.com` from the same container succeeds | The Node/Python CA-trust exports are missing from the agent's shell: `entrypoint.sh` writes `NODE_EXTRA_CA_CERTS` / `REQUESTS_CA_BUNDLE` into `.bashrc`, but the block was skipped (CA file absent when the `[ -f "$CF_CA_SRC" ]` guard ran) or never sourced. `curl` keeps working because it reads the system store, which masks the cause; the agent's runtime uses its own bundled CA list and rejects the intercepted cert before the request reaches the interceptor (no `LlmInterceptor.fetch` log line). | In the agent's tab run `grep -A3 'enterprise-ca-trust' ~/.bashrc` — the three `export` lines should be present and `echo $NODE_EXTRA_CA_CERTS` should print the CA path. If absent: confirm `ENTERPRISE_MODE=active`, that the CA file existed at boot (`[entrypoint] Enterprise Mode: ... CA installed` log line, no `$CF_CA_SRC not found` WARNING), and the image is current; then restart the container to regenerate `.bashrc`. If the marker is present but the path is stale, delete the `# enterprise-ca-trust` block and restart. |
| Enterprise Mode: LLM calls return 401 / authentication errors | Interceptor not wired, or `AIG_GATEWAY_URL` / `AIG_TOKEN` missing or incorrect | (1) Verify `wrangler secret list` shows both `AIG_GATEWAY_URL` and `AIG_TOKEN`. (2) Check `wrangler tail` for `[LlmInterceptor]` log lines; absence means `interceptOutboundHttps` was never called (check `ENTERPRISE_MODE` deploy var is `active`). (3) Verify the AI Gateway URL ends with a trailing slash and includes the correct account/gateway path. |
| Enterprise Mode: agent hits a non-OpenAI provider error (e.g. Pi → AWS Bedrock `UnrecognizedClientException`), uses the wrong model, or **no request reaches the AI Gateway** (empty gateway logs) | Pi was not pinned to the gateway provider and auto-bound a built-in (amazon-bedrock, falsely "authenticated" by the container's R2 keys exported as `AWS_*`), so it signed a SigV4 call to AWS that never hit `api.openai.com`; or the dynamic-route catalog/default is unconfigured in Setup | When `ENTERPRISE_MODE=active`, entrypoint.sh registers each agent against the `codeflare-gateway` provider with the fixed slash-free handle `codeflare` and pins Pi via `~/.pi/agent/settings.json` (`defaultProvider`/`defaultModel`). If Pi shows the wrong provider: check `~/.pi/agent/models.json` has a `codeflare-gateway` entry **and** `settings.json` has the default pin. Do not configure a slash-bearing model id in the container — Pi parses `a/b` as `provider/model` and misroutes. The real route is mapped by the `LlmInterceptor` from the agent's slash-free handle to `dynamic/<route>` using the Setup-configured catalog ([REQ-ENTERPRISE-012](../../sdd/spec/enterprise-mode.md#req-enterprise-012-setup-configured-dynamic-route-catalog-and-access-group-list)) — verify the catalog/default are configured in the setup wizard and that the resolved route is an OpenAI-wire model that supports streaming + tool-calling. (Claude Code is not in the enterprise agent set; only Copilot, Pi, and Bash run under `ENTERPRISE_MODE=active`.) |
| Enterprise Mode: agent retries every streamed reply and token usage multiplies (Pi logs `Stream ended without finish_reason`) | The AI Gateway dynamic route ends streaming responses with `finish_reason: null` then `[DONE]`, omitting the terminal `stop`/`tool_calls` chunk that OpenAI-wire agents require; the agent treats the stream as truncated and retries (≈3×), multiplying token cost | Handled in-product by the `LlmInterceptor` streaming-terminator shim ([REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) AC3), which synthesizes the missing terminator on streaming `/chat/completions`. If the loop persists: confirm the deploy includes the shim (`[LlmInterceptor]` present in `wrangler tail`); confirm the response is actually `text/event-stream` on `/chat/completions` (the shim is bypassed for non-streaming and `/responses`); and confirm the resolved dynamic route is an OpenAI-wire model — a non-conformant backend can emit a stream the shim cannot repair. Note the gateway's stored response log is normalized and shows `finish_reason: stop` even when the live wire omits it; trust `wrangler tail`, not the stored log. |
| Enterprise Mode: the Vault editor never loads / SilverBullet service worker fails to register (browser console shows a redirect on `service_worker.js`, 302 to `*.cloudflareaccess.com`) | The host-wide Cloudflare Access app 302s the credential-less `service_worker.js` registration fetch to the IdP login before the Worker's [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker) short-circuit can run | The setup wizard auto-provisions a higher-precedence Access **bypass** app (`decision: bypass`, include everyone) scoped to `/api/vault/*/service_worker.js` ([REQ-ENTERPRISE-006](../../sdd/spec/enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC6). If the SW still 302s: confirm setup completed under `ENTERPRISE_MODE=active`, check an Access app `codeflare-vault-sw-bypass` exists with a bypass policy at higher precedence than the host-wide app, and re-run setup to re-provision (provisioning is best-effort and emits a `logger.warn` if it failed). |
| `mcp__graphify__*` tools not visible in Claude Code ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | Plugin manifest absent or `~/.claude.json` malformed | Check `~/.claude/plugins/graphify/.claude-plugin/plugin.json` exists (preseed delivers it on container start). Then `jq '.mcpServers.graphify' ~/.claude.json` - expect `{command:"/root/.local/share/uv/tools/graphifyy/bin/python",args:["<plugin-dir>/graphify/scripts/graphify-mcp-lazy.py"]}`. If null or pointing at `python3 -m graphify.serve`, re-run `entrypoint.sh` (the older invocation cannot import the uv-isolated graphifyy package). |
| `mcp__graphify__*` tools return empty results on a fresh session ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | No `graphify-out/graph.json` exists in any cloned repo yet - the wrapper started in empty-graph mode | Expected behaviour, not a bug. Run `graphify update .` from the repo root to build the AST graph (free, no LLM cost). The wrapper hot-reloads within `GRAPHIFY_POLL_SECONDS` (default 2s) of the file appearing. |
| `mcp__graphify__*` returns answers from the wrong repo ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | Sentinel file at `~/.cache/codeflare-hooks/graphify-active-cwd` is absent, stale, or points at a repo without a `graphify-out/`; wrapper fell back to the freshest-mtime heuristic and picked the wrong repo | `cat ~/.cache/codeflare-hooks/graphify-active-cwd` should contain the current repo root. If missing, the active-repo hook has not fired yet - trigger a Bash `cd` to the repo, or Edit any file in it. Advanced session mode only: confirm `graphify-active-repo.sh` is registered under `~/.claude/settings.json` `hooks.PostToolUse`. Default mode has no sentinel by design (fallback only). Note: this sentinel governs only graphify graph resolution — Pi's review-repo resolution (footer, reaper, finalizer) no longer reads it as of [REQ-AGENT-061](../../sdd/spec/agents.md#req-agent-061-pi-idle-durable-review-reaper) AC5; for a missing review footer see the row below. |
| Pi review footer row missing / merged summary never emits / autofix never starts in a nested or concurrent-agent repo ([REQ-AGENT-061](../../sdd/spec/agents.md#req-agent-061-pi-idle-durable-review-reaper) AC5) | Pi's review-repo resolution read the shared `graphify-active-cwd` sentinel, which both Claude's `graphify-active-repo.sh` hook and Pi's `codeflare-pi.ts` write on every tool execution. Under concurrent agents in different repos (e.g. Claude in the outer codeflare repo, Pi reviewing a nested clone) it flapped to whichever acted last, so Pi read the wrong `.git`, found no pending review there, and neither painted the footer nor finalized the summary. | Update the preseed (re-run `entrypoint.sh` or trigger an R2 sync to pull the fixed `local-statusline.ts`, `review-enforcement.ts`, `review-job-helpers.ts`, `review-command.ts`); resolution now derives from the boundary-command cwd / Pi session cwd, not the sentinel. Confirm with `grep resolveReviewRepo ~/.pi/agent/extensions/review-job-helpers.ts`. |
| Pi autofix never starts: `autofix.json` is `failed` with `attempts:0` and no delivery error, on a repo where the review completed more than 30 min before the fix session opened ([REQ-AGENT-062](../../sdd/spec/agents.md#req-agent-062-pi-pr-boundary-review-result-delivery) AC3/AC6) | The delivery age backstop was kind-blind and aged the autofix announcement to `failed` once older than its window, even though no delivery had ever been attempted — killing the fix/commit/push turn before it could fire. | Update the preseed (re-run `entrypoint.sh` or trigger an R2 sync) so the age backstop is summary-only; confirm with `grep -a 'kind === "summary"' ~/.pi/agent/extensions/review-job-helpers.ts`. Until the fixed preseed is deployed, the workaround is `/review-results` (displays the summary), then ask the agent to fix the findings. |
| Graph stale after recent code edits ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | AST portion of the graph was not refreshed since the edits | Run `graphify update .` from the project root. It re-extracts only changed files via tree-sitter (free, no LLM cost). Skip if the change was test-only or doc-only - the graph de-emphasises tests by design. |

## GitHub Integration

| Symptom | Cause | Fix |
|---------|-------|-----|
| GitHub panel not visible / `GET /api/github/status` returns `{ enabled: false }` (other `/api/github/*` routes return `403 GITHUB_DISABLED`) | The integration is enterprise-only right now: `githubFeatureEnabled` = `isEnterpriseMode` | Expected outside enterprise mode — the panel only appears in enterprise mode. Broadening the gate to SaaS-advanced plus a per-user toggle is Planned ([REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise)). |
| `GET /api/github/connect` returns `503 GITHUB_NOT_CONFIGURED` | No provider configured — neither a GitHub App (`GITHUB_APP_CLIENT_ID` + `GITHUB_APP_CLIENT_SECRET`) nor the OAuth App (`OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET`) is set | Set the GitHub App secrets (enterprise/EMU) or the OAuth App secrets (SaaS). A configured GitHub App takes precedence over the OAuth App. |
| `/api/github/repos` returns `401 NOT_CONNECTED`, or the agent's git/`gh` calls fail with auth errors in enterprise | No valid token for the session — never connected, or an expired GitHub App token that could not be refreshed. The system fails closed and never falls back to a stale token. | Click **Connect GitHub** again to re-authorize. |
| Clone fails with "already exists" / `409 CLONE_TARGET_EXISTS` | `$USER_WORKSPACE/<repo-name>` already exists; clone refuses to overwrite it | Remove or rename the existing folder, or clone into a new session. |
| Clone returns `503 NOT_RUNNING` | The target session's container is asleep, so `POST /api/github/clone` (running-session path) cannot reach it | Start/wake the session first, or use the new-session clone (`POST /api/sessions` with a `clone` field), which clones before the agent starts ([REQ-GITHUB-004](../../sdd/spec/github.md#req-github-004-clone-a-repository-into-a-session)). |
| `429` from connect / repos / clone | Per-user rate limits: connect/disconnect 20/min, repos 60/min, clone 20/min | Wait for the window — the `Retry-After` and `X-RateLimit-*` response headers give the retry delay and the ceiling/remaining count — then retry. |
| In enterprise, the in-session `GH_TOKEN` env shows `codeflare-enterprise` instead of a real token | By design — the container holds only a non-secret placeholder; the real token is injected at the egress boundary ([REQ-GITHUB-003](../../sdd/spec/github.md#req-github-003-enterprise-egress-injected-github-credentials)) | Not a bug. git/`gh`/API calls to github.com still authenticate because injection happens at egress. If they fail, the token isn't connected — see the `401 NOT_CONNECTED` row above. |

## Browser Run

| Symptom | Cause | Fix |
|---------|-------|-----|
| In an advanced session the browser tools (`browser_markdown` / `chrome-devtools`) are missing and the `browser-run` / `browser-e2e` skills are absent | No Cloudflare Browser Rendering token is configured, so the whole browser-run surface is withheld — the MCP servers and the Pi extension self-gate, and the skills are stripped ([REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token)) | Enterprise: an admin sets the Browser Rendering token (+ account id) in the Setup wizard. Other modes: paste a Cloudflare token carrying `Browser Rendering - Edit` in Push & Deploy settings. Takes effect on the next session start. |
| Browser tools missing in a Standard (default) session | Browser Run is advanced-mode only | Switch the session to advanced/Pro mode (enterprise sessions are always advanced). |

## Diagnostic Commands

**Check container status:**
```bash
curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
  https://codeflare.example.com/api/container/startup-status?sessionId=abc12345
```

**Verify secrets:**
```bash
wrangler secret list
# Expected: CLOUDFLARE_API_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
```

**Monitor logs:**
```bash
wrangler tail codeflare
wrangler tail codeflare --status error
```

---

## Related Documentation
- [Architecture](architecture.md#system-components) - System component overview
- [Configuration](configuration.md#secrets) - Secret management
- [Container](container.md#container-startup) - Container startup sequence
- [Storage & Sync](storage-and-sync.md) - Sync mechanics
- [Authentication](security.md#authentication-gate) - Auth flow
- [Security - GitHub Token Handling](security.md#github-token-handling) - Egress-injection model, placeholder token, non-enterprise behaviour
- [Configuration - GitHub Integration](configuration.md#github-integration) - GitHub App vs OAuth provider, env var reference

---

## Specification Coverage

- [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) - Knowledge-Graph Capability (Graphify)
- [REQ-AGENT-061](../../sdd/spec/agents.md#req-agent-061-pi-idle-durable-review-reaper) - Pi Idle Durable Review Reaper (review-repo resolution; graphify sentinel scope)
- [REQ-BROWSER-007](../../sdd/spec/browser-run.md#req-browser-007-enterprise-admin-configured-browser-rendering-token) - Enterprise admin-configured Browser Rendering token
- [REQ-ENTERPRISE-004](../../sdd/spec/enterprise-mode.md#req-enterprise-004-outbound-interception-llm-routing-to-customer-ai-gateway) - Outbound-interception LLM routing (enterprise CA trust, interceptor wiring)
- [REQ-ENTERPRISE-005](../../sdd/spec/enterprise-mode.md#req-enterprise-005-container-side-enterprise-routing-ca-trust--constant-base-urls) - Container-side enterprise routing (CA trust + agent base-URLs)
- [REQ-GITHUB-003](../../sdd/spec/github.md#req-github-003-enterprise-egress-injected-github-credentials) - Enterprise egress-injected GitHub credentials
- [REQ-GITHUB-004](../../sdd/spec/github.md#req-github-004-clone-a-repository-into-a-session) - Clone a repository into a session
- [REQ-GITHUB-007](../../sdd/spec/github.md#req-github-007-broaden-the-panel-gate-beyond-enterprise) - Broaden the panel gate beyond enterprise
- [REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants) - sleepAfter fail-safe invariants
- [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition) - Container Port-Readiness Gating with Pre-Warm Pre-Condition
- [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-persisted-status-is-authoritative-on-container-exit) - Persisted status is authoritative on container exit
