# Troubleshooting

Diagnostic commands, common failure modes, and resolution steps.

**Audience:** Operators

## Contents

- [Common Issues](#common-issues)
- [Common Failure Modes](#common-failure-modes)
- [Diagnostic Commands](#diagnostic-commands)

---

## Common Issues

Frequently encountered problems grouped by symptom, with causes and resolution steps.

### `/api/*` Returns HTML (SPA Swallow)

API endpoints return HTML instead of JSON. Fix: ensure `run_worker_first = ["/", "/auth/*", "/api/*", "/public/*", "/health"]` in `[assets]` section of `wrangler.toml`.

### `/setup` Shows "Access Denied"

Check `GET /api/setup/status` returns JSON. Verify `setup:complete` in KV is absent/false for first-time setup.

### Auth Error After Successful Access Login

Stale `setup:auth_domain` (JWT mismatch), stale `setup:access_aud`, or email casing mismatch. Re-run setup configure. Confirm user keys are lowercase.

### "Unable to find your Access application!"

Browser retained stale Access session. Test in incognito. Clear CF Access cookies. Confirm one managed app with correct destinations.

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
| Zombie restarts | Stale DO state | Self-terminates via missing-identifiers guard |
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
| `mcp__graphify__*` tools not visible in Claude Code ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | Plugin manifest absent or `~/.claude.json` malformed | Check `~/.claude/plugins/graphify/.claude-plugin/plugin.json` exists (preseed delivers it on container start). Then `jq '.mcpServers.graphify' ~/.claude.json` - expect `{command:"/root/.local/share/uv/tools/graphifyy/bin/python",args:["<plugin-dir>/graphify/scripts/graphify-mcp-lazy.py"]}`. If null or pointing at `python3 -m graphify.serve`, re-run `entrypoint.sh` (the older invocation cannot import the uv-isolated graphifyy package). |
| `mcp__graphify__*` tools return empty results on a fresh session ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | No `graphify-out/graph.json` exists in any cloned repo yet - the wrapper started in empty-graph mode | Expected behaviour, not a bug. Run `graphify update .` from the repo root to build the AST graph (free, no LLM cost). The wrapper hot-reloads within `GRAPHIFY_POLL_SECONDS` (default 2s) of the file appearing. |
| `mcp__graphify__*` returns answers from the wrong repo ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | Sentinel file at `~/.cache/codeflare-hooks/graphify-active-cwd` is absent, stale, or points at a repo without a `graphify-out/`; wrapper fell back to the freshest-mtime heuristic and picked the wrong repo | `cat ~/.cache/codeflare-hooks/graphify-active-cwd` should contain the current repo root. If missing, the active-repo hook has not fired yet - trigger a Bash `cd` to the repo, or Edit any file in it. Advanced session mode only: confirm `graphify-active-repo.sh` is registered under `~/.claude/settings.json` `hooks.PostToolUse`. Default mode has no sentinel by design (fallback only). |
| Graph stale after recent code edits ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | AST portion of the graph was not refreshed since the edits | Run `graphify update .` from the project root. It re-extracts only changed files via tree-sitter (free, no LLM cost). Skip if the change was test-only or doc-only - the graph de-emphasises tests by design. |

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

---

## Specification Coverage

- [REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify) - Knowledge-Graph Capability (Graphify)
- [REQ-OPS-017](../../sdd/spec/operations.md#req-ops-017-sleepafter-fail-safe-invariants) - sleepAfter fail-safe invariants
- [REQ-SESSION-015](../../sdd/spec/session-lifecycle.md#req-session-015-container-port-readiness-gating-with-pre-warm-pre-condition) - Container Port-Readiness Gating with Pre-Warm Pre-Condition
- [REQ-SESSION-018](../../sdd/spec/session-lifecycle.md#req-session-018-persisted-status-is-authoritative-on-container-exit) - Persisted status is authoritative on container exit
