# Troubleshooting

Diagnostic commands, common failure modes, and resolution steps.

**Audience:** Operators

---

### `/api/*` Returns HTML (SPA Swallow)

API endpoints return HTML instead of JSON. Fix: ensure `run_worker_first = ["/", "/auth/*", "/api/*", "/public/*", "/health"]` in `[assets]` section of `wrangler.toml`.

### `/setup` Shows "Access Denied"

Check `GET /api/setup/status` returns JSON. Verify `setup:complete` in KV is absent/false for first-time setup.

### Auth Error After Successful Access Login

Stale `setup:auth_domain` (JWT mismatch), stale `setup:access_aud`, or email casing mismatch. Re-run setup configure. Confirm user keys are lowercase.

### "Unable to find your Access application!"

Browser retained stale Access session. Test in incognito. Clear CF Access cookies. Confirm one managed app with correct destinations.

### Container Stuck at "Waiting for Services"

Terminal server not starting (sync blocking). Check: `GET /api/container/startup-status?sessionId=xxx` (inspect `details.syncError` field). Common causes: missing R2 credentials, bucket doesn't exist, network timeout.

### R2 Sync Issues

- **Bisync empty listing**: Initial `establish_bisync_baseline()` uses `--resync` to create the baseline, handles this case. The periodic daemon never uses `--resync` (see [AD14](decisions/README.md#ad14-never-auto---resync-on-bisync-failure)).
- **`lstat: no such file or directory` bisync failure**: A transient file was listed by rclone then deleted before the copy completed. Automatically recovered: the system parses the error, adds the file to `/tmp/rclone-recovery-filters.txt`, clears bisync locks, and retries (max 3 attempts). Check `/tmp/sync.log` for `[sync-recovery] Excluded vanished file:` entries. If the failure persists beyond 3 attempts, it escalates to the normal consecutive-failure path. See [Vanishing-file recovery](storage-and-sync.md#vanishing-file-recovery) and [AD43](decisions/README.md#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke).
- **Transfers 0 files**: Filter order indeterminacy from mixed `--include`/`--exclude`. Use `--filter` flags instead.
- **Slow sync**: Switch to `SYNC_MODE=metadata` or manually clean large repos from R2.
- **Missing secrets**: Check `startup-status` response `details.syncError` for the missing variable.

### Zombie Container

Zombie alarm loops are now prevented by two mechanisms: (1) `onStop()` calls `deleteSchedules('collectMetrics')` to immediately kill the alarm loop when a container stops, and (2) `onActivityExpired()` calls `this.stop('SIGTERM')` on unreachable activity endpoints instead of renewing the timeout, which triggers `onStop()` and its schedule cleanup. As a defense-in-depth fallback, `collectMetrics` itself still has three self-termination guards: container-not-running check, missing-identifiers guard, and re-arm guard. These cover edge cases where `onStop()` might not fire (e.g., after `destroy()`).

### Secrets Lost After Worker Deletion

`wrangler delete` nukes all secrets. Re-set with `wrangler secret put`.

### R2 Bucket Cleanup on User Deletion

`DELETE /api/users/:email` and `POST /configure` (stale user removal during reconfiguration) both call `cleanupUserData()` in `src/lib/user-cleanup.ts`, which: destroys all active containers, deletes the user KV entry and bucket-keyed KV entries (`storage-stats:`, `presets:`, `user-prefs:`), reads the scoped R2 token via `getAndDecrypt()` (required because `r2token:{email}` values are encrypted when `ENCRYPTION_KEY` is set — raw `KV.get('json')` throws `SyntaxError` on the `v1:...` ciphertext prefix), deletes the scoped R2 token, empties the R2 bucket via S3 `ListObjectsV2` + `DeleteObjects` loop (using worker-level R2 credentials via `createR2Client` + `emptyR2Bucket`), and deletes the empty bucket via Cloudflare API with retry logic (up to 3 attempts with exponential backoff for R2 eventual consistency when objects were deleted).

If worker-level R2 credentials are not configured (e.g., setup was interrupted), the emptying step is skipped and bucket deletion may fail with `BucketNotEmpty`. This logs `logger.warn` server-side but does not block the overall cleanup. During reconfiguration, stale user cleanup is wrapped in a `runStep('cleanup_stale_users')` call for NDJSON progress visibility in the setup wizard frontend. **SaaS mode:** only admin-role users removed from the admin list are cleaned up — JIT-provisioned regular users are preserved. Each user's KV entry is checked for `role: 'admin'` before qualifying for removal.

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

### Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container won't start | Missing R2 credentials | `wrangler secret list` then `wrangler secret put` |
| `403 Forbidden` on R2 | Expired credentials | Regenerate in CF dashboard |
| Container stuck "starting" | Port 8080 not responding | Check sync log |
| WebSocket fails | Container not running | Verify startup-status |
| Zombie restarts | Stale DO state | Self-terminates via missing-identifiers guard |
| Deleted session reappears | `onStop()` resurrects KV entry | Verify `destroy()` clears `SESSION_ID_KEY` before `super.destroy()` |
| Container dies during active use | Auth issue on internal paths | Verify `/activity` in `authExemptPaths` in `host/src/server.ts` |
| Container sleeps before configured timeout | Stale `idleTimeoutPref` cache in DO | Each 60s tick re-reads `sleepAfter` from DO storage (REQ-OPS-006 AC9); if storage holds a corrupt value it is ignored and the previous cached value applies. Check DO storage via `wrangler tail` for `collectMetrics: storage holds invalid sleepAfter value`. |
| Container sleeps later than expected (up to 2h) | `parseSleepAfterMs` fail-safe | When the stored `sleepAfter` is missing or unrecognized, the system defaults to 2h max to avoid losing user work (REQ-OPS-006 AC8). Correct via Settings panel — the new value writes to storage and takes effect on the next 60s tick. |
| Container start rejects with 500: sleepAfter required | `buildSetBucketNameBody` missing value | The `/start` route failed to resolve the user's effective `sleepAfter` before calling the internal setup helper. Check that the user's preferences are readable and `effectiveTier` resolves correctly (REQ-OPS-006 AC10). |
| Phantom container on session switch | Reconnect scope issue | Ensure `activeSessionId` filter passed to `reconnectDisconnectedTerminals()` |
| Character doubling in terminal | Handler not disposed on reconnect | Dispose `inputDisposable` before creating new handler in `connect()` |
| Container returns 503 on all authenticated endpoints | `CONTAINER_AUTH_TOKEN` not set | Security default-deny. Token is set automatically by the DO via `crypto.randomUUID()` on lifecycle start. If missing, verify DO `updateEnvVars()` runs before `startAndWaitForPorts()` |

### Diagnostic Commands

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
- [Storage & Sync](storage-and-sync.md#r2-sync-issues) - Sync troubleshooting detail
- [Authentication](security.md#authentication-gate) - Auth flow
