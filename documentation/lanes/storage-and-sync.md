# Storage & Sync

R2 persistent storage, rclone bisync synchronization, sync modes, storage quotas, and conflict resolution.

**Audience:** Operators, Developers

**Owns:** R2/local authority, sync scope, cadence, conflict handling, recovery order, final persistence drain, and encryption-regime reconciliation. **Does not own:** endpoint envelopes, quota pricing, deployment procedure, or UI implementation.

---

## Contents

- [Data Model and Boundaries](#data-model-and-boundaries)
- [Synchronization Lifecycle](#synchronization-lifecycle)
- [Conflict Resolution](#conflict-resolution)
- [Failure Diagnosis and Recovery](#failure-diagnosis-and-recovery)
- [File Browser](#file-browser-req-stor-016)
- [Requirement and Source Map](#requirement-and-source-map)
- [Managed-Resource Sync Policy](#managed-resource-sync-policy-req-stor-031)
- [Performance Characteristics](#performance-characteristics)
- [Encryption-Regime Alias](#encryption-regime-alias)
- [Related Documentation](#related-documentation)

## Data Model and Boundaries

<a id="storage-quota-req-stor-006-req-stor-014"></a>
### Storage Quota (REQ-STOR-006, REQ-STOR-014)

Per-user bucket identities are serialized by a bucket-keyed Durable Object rather than inferred solely from a lossy email slug. The Durable Object is the sole ownership authority; authenticated requests do not project ownership to a same-key KV record. Unambiguous legacy buckets remain stable, later collisions receive deterministic digest-suffixed names, and ambiguous legacy collisions are blocked pending operator resolution ([REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) AC1/AC4). <!-- @impl: src/lib/access.ts::resolveBucketName -->

Per-user R2 storage is capped by `maxStorageBytes` in `SubscriptionTierConfig`. R2 has no native per-bucket quota - enforcement is in application code.

**Tier defaults:** Configurable per tier in admin Subscription Management panel (Storage Quota field, in MB). Custom tier defaults to unlimited.

**Enforcement:** Session creation (`POST /api/sessions` in `crud.ts`) checks `storage-stats:{bucketName}` KV cache against the user's tier quota. If `totalSizeBytes > maxStorageBytes`, the request is rejected with a clear error message. Users must delete files from their storage browser to free space before starting new sessions.

**Stats endpoint:** `GET /api/storage/stats` returns `maxStorageBytes` alongside usage stats. The quota is cached in KV alongside the stats (`storage-stats:{bucketName}`) so cache hits don't need tier config resolution - tier config is only read on cache miss (every 60s). Frontend displays "X / Y" in the storage card. Subscribe page plan cards show storage quota in the specs line. Admin Subscription Management has an editable "Storage Quota (MB)" field per tier.

**What is NOT enforced:** Individual file uploads, rclone sync writes, and preseed writes are not blocked by quota. The quota is checked only at session start. Users can temporarily exceed their quota during an active session via rclone sync or file uploads. The overage is caught on the next session start attempt.

**Tier config merge:** `getTierConfig()` merges stored KV tiers with hardcoded defaults via `{ ...default, ...stored }`. New fields (like `maxStorageBytes`) backfill from defaults even when KV was saved before the field existed. Admin-saved values always take priority. The admin `PUT /api/admin/tiers` Zod schema includes `maxStorageBytes` so it persists on save.

### Managed release cache and user reconciliation

Under [REQ-STOR-025](../../sdd/spec/storage.md#req-stor-025-managed-deployment-cache-migration) and [REQ-STOR-026](../../sdd/spec/storage.md#req-stor-026-managed-deployment-cache-identity), managed curation uses one deterministic deployment-level R2 bucket, separate from every user bucket. Its bounded `<sanitized-worker-name>-managed-<account-and-worker-hash>` name makes the owning deployment recognizable without giving up collision isolation. A deployment still selecting the former opaque `codeflare-managed-<hash>` name rebuilds and verifies the active release in the recognizable bucket during normal resolution, records a separate operational mapping without rewriting the trust selection, and only then empties and deletes that exact legacy bucket; a failed cleanup remains recorded for retry. <!-- @impl: src/lib/remote-curation.ts::prepareManagedCacheMigration --> <!-- @impl: src/lib/remote-curation.ts::cleanupLegacyManagedCache --> <!-- @test: src/__tests__/lib/remote-curation.test.ts -->

Signed immutable assets are content-addressed under `releases/<bundle-sha256>/`. Repository-and-key trust boundaries select them through `configs/<configuration-fingerprint>/active.json` with conditional create/update semantics. <!-- @impl: src/lib/remote-curation-cache.ts::createR2ManagedReleaseCache -->

Under [REQ-STOR-024 AC5-AC7](../../sdd/spec/storage.md#req-stor-024-managed-release-application), user reconciliation reads only the current verified release from the disposable cache and never GitHub. Applying it without the previous bundle deletes exact-prior-digest paths that the current release excludes from the resolved mode; current signed retirements cover globally removed paths. Arbitrary prior paths absent from both sets cannot be discovered. A cacheless disable therefore fails before bucket mutation and retains applied state. <!-- @impl: src/routes/storage/seed.ts::default --> <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->

A user's applied release digest, exact managed-extension-manifest digest, sequence, and mode live in preferences. The existing dashboard check reports upgrading or update pending.

The existing agent-config route writes mode documents and `.codeflare/managed-extensions.json` with bounded R2 concurrency, deletes prior-owned obsolete paths only when provenance still matches, and reconciles image-owned context-mode separately. Signed retirements are marker-gated in Mutable mode and exact-path deletions in protected modes. The route stamps applied state last. The company manifest remains separate from personal `ide-extensions.json`; normal user extension changes cannot alter its hash. No user bucket is mutated while any session for that user runs. Company VSIX bytes are downloaded only inside the session and never stored in R2. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @impl: src/routes/storage/seed.ts::default -->

### Managed-resource persistence modes

A managed path is an exact object key owned by the verified release inventory, a signed retirement tombstone, or one of Codeflare's synthetic policy files. Ordinary personal files do not become managed because they happen to sit in the same bucket. That distinction is what keeps a release update from turning into a bucket-wide cleanup.

**Mutable** is the default when managed resources are enabled but both persistence controls are off. The release provisions its current files, while rclone may persist user edits and new files normally. A later release overwrites content at paths it still manages. If a user rewrites a managed object, the rclone upload drops its Codeflare provenance marker and transfers ownership to the user. A later retirement preserves that replacement. Mutable mode has no managed-path policy, generated exclusion filter, or Worker denial.

**Immutable** applies when **Immutable Resources** is enabled and **Disable User Created Resources** is disabled. Current managed paths and signed retirement tombstones are exact protected paths. Personal files elsewhere continue to persist. Container filters keep routine bisync away from protected paths; if those filters are bypassed or damaged, the Worker rejects the protected R2 mutation with S3 `403`. A file at a path introduced by a later release is replaced by managed content and protected from then on.

**Exclusive** applies when **Disable User Created Resources** is enabled. It retains Immutable's exact-path protection and adds governed resource roots such as agent `skills/`, `rules/`, and `plugins/` trees. Reconciliation removes personal objects inside those roots after bounded prevalidation, and later mutations there receive `403`. Files outside governed roots remain personal. Enabling this mode is intentionally destructive within those roots, which is why reconciliation waits until the user's sessions have stopped.

#### Release changes and retirement

Each user carries their own applied release digest. Reconciliation loads that retained release as the previous inventory and compares it with the currently active verified release, so a user may skip several releases without losing the deletion boundary. Only keys present in the user's previous inventory and absent from the current inventory become ordinary retirement candidates. The Worker deletes one only when its R2 provenance marker still matches the previous release digest. Unrelated custom keys never enter that candidate set.

Routine retirement therefore needs no hand-maintained list: remove the file from the curation manifest and publish a new release. `preseed/retired-keys.json` serves a narrower purpose. It is the cumulative backlog of proven product-created objects that predate provenance markers, plus exceptional product-generated orphans that no release comparison can own safely. The shared compiler validates that list, rejects paths that are still live, and publishes it as sorted `retiredPaths` in `seed-v1`.

Protected reconciliation deletes those signed retired paths by exact name, then keeps them in `.codeflare/managed-paths.json` as tombstones. Their filter entries do not claim the files still exist. They stop an old local copy, a damaged filter, or a direct R2 request from resurrecting retired managed behavior. Mutable reconciliation deletes a retired path only while Codeflare provenance remains, preserving a user-owned replacement.

Reconciliation writes current managed content, performs scoped cleanup, writes and reads back the canonical protected policy when required, then records the applied release and policy identity. Local rclone filters prevent expected writes; the Worker interceptor remains the authority when traffic reaches R2. Operator rollout, destructive-mode acceptance, and recovery belong to the private [Managed Environment runbook](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/operations/managed-environment.md). <!-- @impl: src/lib/r2-seed.ts::deletePriorManagedConfigs --> <!-- @impl: src/lib/r2-seed.ts::deleteRetiredManagedConfigs --> <!-- @impl: src/lib/managed-r2-policy.ts::buildManagedR2Policy --> <!-- @impl: entrypoint.sh::prepare_managed_resource_filter -->

### Why rclone bisync (Not s3fs)

s3fs FUSE: every file op = network call (~340ms PUT, ~50ms HEAD), fragile on network hiccups, "Socket not connected" errors.

rclone bisync: all file ops on local disk (<1ms), background daemon every 15 minutes (`sleep 900`, SIGUSR1-interruptible for manual triggers from the storage panel), final bisync on shutdown via the DO-side synchronous drain (`POST /internal/final-sync`, 120s budget) before stop. See [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers) for the cadence rationale and [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync) for the shutdown budget.

## Synchronization Lifecycle

### Initial Sync on Startup

[REQ-STOR-004](../../sdd/spec/storage.md#req-stor-004-initial-sync-restores-files-on-container-start) and [REQ-STOR-031](../../sdd/spec/storage.md#req-stor-031-managed-resource-container-sync) govern this startup order. <!-- @impl: entrypoint.sh::complete_managed_curation_startup --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->

1. One-way `rclone sync` from R2 to local (restore data) - blocking, container waits for completion (120s timeout)
2. Managed configuration and tab autostart finish—including generated `.claude.json` and `.codex/version.json`—then `relay_managed_pi_extensions()` completes Pi extension ownership. <!-- @impl: entrypoint.sh::complete_managed_curation_startup --> <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->

    Baked mode restores image bytes and removes retired managed files; remote curation preserves release-owned bytes while restoring the image-owned context-mode runtime they import. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->
3. `rclone bisync --resync --ignore-checksum --max-delete 100 --check-sync=false --retries 3 --retries-sleep 10s` to establish baseline (non-blocking - runs in background), then start the 15-minute daemon (SIGUSR1-interruptible)

The generated writes in step 2 settle before the baseline so they do not create immediate post-baseline hash/mtime mismatches.

All bisync commands use `--ignore-checksum` to skip post-transfer MD5 verification. rclone v1.73+ treats hash mismatches as fatal ("corrupted on transfer"), which aborts bisync when files change during transfer (e.g., coding agents modifying workspace files). Change detection still uses modtime + size; files that change mid-transfer are caught in the next 15-minute cycle (or sooner via a manual Sync-now trigger).

`--min-size 1B` on all rclone commands (sync, bisync baseline, bisync daemon) excludes 0-byte files from transfer. R2 SSE-C fails on empty objects - the HeadObject call returns 400 when SSE-C headers are sent for a 0-byte object, which causes rclone to abort with "encryption parameters are not applicable". Empty files (`.lock`, `__init__.py`, etc.) carry no data and are excluded entirely.

`--max-delete 100` allows bisync to propagate bulk deletions (e.g., deleting entire workspace folders). The rclone default of 50% aborts bisync when more than half the files are deleted in one cycle - in a config-heavy sync with few files, even a single folder deletion can exceed this threshold.

### What's Synced vs Excluded (REQ-STOR-011)

| Path | Synced | Reason |
|------|--------|--------|
| `~/.claude/` | Yes | Claude credentials, config, projects for terminal sessions |
| `/run/codeflare/openvscode/sidebar/**` | **NO** | Browser IDE container-lifetime runtime and Claude configuration state. This path is outside the synced home tree and is removed with the container. |
| `/run/codeflare/openvscode/data/**` | **NO** | Live session-isolated editor databases, user extension package directories, workspace/global extension state, SecretStorage, authentication, chat history, logs, WAL, and SHM stay temporary and outside sync. |
| `~/.codeflare/ide-ui-state.json` | Yes | Bounded Browser IDE continuity for theme, keyboard layout, Explorer, and open files ([REQ-IDE-002](../../sdd/spec/browser-ide.md#req-ide-002-session-isolated-ide-not-bucket-stable), [REQ-IDE-016](../../sdd/spec/browser-ide.md#req-ide-016-bounded-ide-state-capture-and-restore-ordering)). <!-- @impl: scripts/browser-ide-ui-state.py::capture --> |
| `~/.codeflare/ide-extensions.json` | Yes | Maximum-64-KiB Browser IDE intent manifest containing at most 50 extension identities plus bounded contributed global settings; no VSIX or extracted package bytes ([REQ-IDE-036](../../sdd/spec/browser-ide.md#req-ide-036-persistent-user-managed-extensions)). <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::capture --> |
| `~/.codeflare/herdr/sessions/*/session.json` | Yes | Herdr snapshots restore topology, cwd, focus, and native agent references. Restored Pi waits for lifecycle authority, with metadata fallback when signaling is unavailable. Pane history, sockets, logs, and process state remain excluded ([REQ-TERM-033](../../sdd/spec/terminal.md#req-term-033-durable-herdr-structural-session-recovery)). <!-- @impl: image/herdr/codeflare-herdr-terminal::prepare_runtime --> <!-- @impl: image/herdr/codeflare-herdr-terminal::wait_for_restored_agent --> <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> |
| `~/.codeflare/review-state/v1/**` | Yes | Immutable exact-head review completion markers follow the user across clones, worktrees, sessions, replacement containers, and devices sharing the bucket. Ten markers per repository and branch remain for 30 days ([REQ-STOR-027](../../sdd/spec/storage.md#req-stor-027-review-completion-marker-sync)). <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> |
| `~/.gitconfig` | Yes | Git configuration |
| `~/workspace/` | Depends on `SYNC_MODE` | Excluded by default (`none`). Synced when `full` or partially with `metadata`. |
| `~/.npm/`, `~/.bun/`, `~/.cache/**` | **NO** | Package manager caches, regenerated |
| `~/.wrangler/`, `~/.config/**` | **NO** | Wrangler state (root location) + all XDG tool configs (configstore, fish, opencode, uv, rclone, wrangler-XDG) - all regenerable on first use. No codeflare-managed state lives under `~/.config/`. |
| `~/.local/share/claude/**` | **NO** | Native installer version binaries (leftover data, removed from build) |
| `~/.local/share/uv/**`, `~/.local/bin/uv`, `~/.local/bin/uvx` | **NO** | uv tool venvs and binaries (graphifyy venv ~275MB lives at `/root/.local/share/uv` baked into the image; the user-side mirror is duplicate cruft, regenerable). |
| `~/.claude/context-mode/**` | **NO** | context-mode plugin FTS5 store and per-session SQLite DBs (~255MB on an active session, pure cache, regenerable by re-indexing). |
| `~/.copilot/logs/**`, `~/.copilot/pkg/**`, `~/.copilot/*.db-{wal,shm}` | **NO** | Copilot logs, auto-update binary, and ephemeral SQLite companions |
| `~/.codex/sessions/**`, `~/.codex/plugins/cache/**`, `~/.codex/cache/**`, `~/.codex/logs*.sqlite*`, `~/.codex/log/**`, `~/.codex/tmp/**`, etc. | **NO** | Codex session data, regenerated plugin/app caches, and log databases |
| `~/.codex/skills/.system/**` | **NO** | Codex's bundled system skills (imagegen, plugin-creator, skill-installer) ship inside the codex binary and are re-extracted on launch (`.codex-system-skills.marker` gate). Not codeflare-managed, not user content - same locally-regenerated rationale as `.agents/`. |
| `~/.claude/cache/**`, `~/.claude/debug/**`, `~/.claude/file-history/**`, etc. | **NO** | Claude Code session-specific ephemeral data |
| `~/.claude/projects/**/*.jsonl` | Yes (partial) | Up to ten candidate JSONL files sync for resume under [REQ-STOR-012](../../sdd/spec/storage.md#req-stor-012-main-session-transcript-cleanup); nested `subagents/`, `tool-results/`, and `workflows/` remain excluded. <!-- @impl: transcript-retention.mjs::discoverTranscripts --> |
| `~/.claude/projects/**/subagents/**`, `tool-results/**`, `workflows/**` | **NO** | Native subagent transcripts, tool artifacts, and per-session workflow state are not required to resume the main session. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> |
| `~/.claude/usage-data/**`, `~/.claude/backups/**`, `~/.claude/tasks/**` | **NO** | Insights reports, settings backups, task state (all regenerated) |
| `~/.claude/sessions/**`, `~/.claude/history.jsonl` | **NO** | Session metadata, command history (ephemeral) |
| `~/.pi/agent/sessions/**/*.jsonl` | Yes (partial) | Up to ten candidate JSONL files sync for `--resume` under [REQ-STOR-012](../../sdd/spec/storage.md#req-stor-012-main-session-transcript-cleanup). Task subdirs (`**/tasks/**`) and the context-mode FTS5 store (`~/.pi/context-mode/**`) remain excluded. `~/.pi/agent/npm/node_modules/` is an image-seeded cache; see [container.md](container.md#pi-extension-npm-cache). <!-- @impl: transcript-retention.mjs::discoverTranscripts --> <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> |
| `~/.cpan/**` | **NO** | Perl CPAN package manager cache, regenerated |
| `~/.gemini/tmp/**` | **NO** | Legacy no-op filter retained in entrypoint (Gemini CLI agent removed; filter is harmless) |
| `~/.local/share/opencode/log/**`, `opencode.db-shm`, `opencode.db-wal` | **NO** | OpenCode session logs and SQLite temp files |
| `.claude/mcp-*.json` | **NO** | MCP auth cache; created and deleted within milliseconds, listing-then-missing causes bisync fatal errors. Regenerated on every connect. |
| `~/.graphify/**` | **NO** | Per-machine global graph store (absolute paths, machine-specific). Each container builds its own from the per-repo `graphify-out/` artefacts. |
| `**/graphify-out/**` ([REQ-AGENT-023](../../sdd/spec/agents.md#req-agent-023-knowledge-graph-capability-graphify)) | **NO** | Knowledge-graph artifacts live in the repo, not in R2: owners commit `graphify-out/` to git and clones receive it. Repos without push permission keep the graph local-only and ephemeral. R2 bisync is not in the graphify persistence path. |
| `Vault/graphify-out/vault-graph.json`, `Vault/graphify-out/vault-extract-manifest.json` (advanced mode) | Yes | Cumulative graph source and committed extraction high-water mark persist despite the blanket graphify exclude. |
| `Vault/graphify-out/vault-extract-manifest.*.pending.json`, `.graphify_chunk_*.json` | **NO** | Pi request-specific staging/chunks are ephemeral; only hash-validated success promotes the canonical manifest. |
| `Vault/graphify-out/graph.html` | **NO** | Derived visualization; the served durable copy is `Vault/Raw/Graphs/vault-graph.html`. |

Both Browser IDE manifests are atomic mode-`0600` regular files. The 1 MiB UI snapshot contains only allowlisted theme values, string-valued `keyboard.layout`, and key-specific canonical Explorer/open-file resources captured after code-server is reaped. The separate 64 KiB extension manifest contains lowercase IDs, exact versions, optional audit metadata, a warning acknowledgement, and bounded contributed global settings. <!-- @impl: scripts/browser-ide-ui-state.py::capture --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @impl: scripts/browser-ide-extensions.py::capture -->

Managed/UI-continuity keys are excluded; failed gallery restores remain as intent, and only `.obsolete` proves uninstall. First-match filters admit those bounded manifests, structural Herdr `session.json` files, the managed extension manifest, and `review-state/v1/**`, then exclude every other `~/.codeflare/**` path. Changed extension intent and newly written review completion each signal the existing bisync daemon; periodic cadence, Sync-now, coalescing, newest-wins convergence, and final drain remain unchanged. <!-- @impl: entrypoint.sh::_openvscode_supervise_loop --> <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON -->

`vault-graph.json` is the [REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) source of truth; the global graph is rebuilt from it at boot. The extraction manifest prevents a restored vault from being reprocessed wholesale.

The two durable `VAULT_FILTER` allow-rules precede `+ Vault/**` because rclone uses first-match semantics. `- Vault/graphify-out/**` drops derived output: `graph.json`, `graph.html`, chunks, `.graphify_labels.json`, `GRAPH_REPORT.md`, cache, and Graphify's own manifest. The published visualization remains under `Vault/Raw/Graphs/`.

### rclone Sync Modes (REQ-STOR-003)

| Mode | Workspace Sync | Use Case |
|------|---------------|----------|
| `none` | Excluded entirely | Default. Settings and config only. |
| `full` | Entire `workspace/` (minus `node_modules/`) | Persistent storage across stop/resume |
| `metadata` | Only agent config files (`.claude/` and `CLAUDE.md`) per repo | Lightweight project context sync |

All modes always exclude these groups:

- Shell/runtime caches: `.bashrc`, `.bash_profile`, `.npm/**`, `.bun/**`, `.cache/**`, `.wrangler/**`, `.config/**`, `.local/state/**`, `.cpan/**`.
- Dependency and graph caches: `**/node_modules/**`, `**/graphify-out/**`, `.graphify/**`, `.claude/context-mode/**`, `.pi/context-mode/**`.
- Local tool stores: `.local/share/claude/**`, `.local/share/uv/**`, `.local/bin/uv`, `.local/bin/uvx`, `.claude/mcp-*.json`.
- Copilot/OpenCode/Gemini state: `.copilot/logs/**`, `.copilot/pkg/**`, `.copilot/session-state/**`, `.copilot/*.db-wal`, `.copilot/*.db-shm`, `.gemini/tmp/**`, `.local/share/opencode/log/**`, `.local/share/opencode/opencode.db-shm`, `.local/share/opencode/opencode.db-wal`.
- Codex volatile state: `.codex/sessions/**`, `.codex/plugins/cache/**`, `.codex/cache/**`, `.codex/logs*.sqlite*`, `.codex/state*.sqlite-shm`, `.codex/state*.sqlite-wal`, `.codex/.tmp/**`, `.codex/log/**`, `.codex/models_cache.json`, `.codex/.personality_migration`, `.codex/shell-snapshots/**`, `.codex/tmp/**`, `.codex/version.json`, `.codex/skills/.system/**`.
- Claude volatile state: `.claude/cache/**`, `.claude/debug/**`, `.claude/file-history/**`, `.claude/plugins/marketplaces/**`, `.claude/projects/**/subagents/**`, `.claude/projects/**/tool-results/**`, `.claude/projects/**/workflows/**`, `.claude/session-env/**`.
- More Claude volatile state: `.claude/shell-snapshots/**`, `.claude/stats-cache.json`, `.claude.json.backup.*`, `.claude/usage-data/**`, `.claude/backups/**`, `.claude/tasks/**`, `.claude/sessions/**`, `.claude/history.jsonl`, `.claude/daemon/**`, `.claude/daemon.*`, `.claude/paste-cache/**`, `.claude/jobs/**`, `.claude/*.bak.*`, `.claude/settings.json.bak*`, `.claude/skills.bak.*/**`.
- Pi task transcripts: `.pi/agent/sessions/**/tasks/**`.

In advanced mode the `VAULT_FILTER` re-includes `Vault/graphify-out/vault-graph.json` and the canonical `Vault/graphify-out/vault-extract-manifest.json` ahead of `+ Vault/**`; `- Vault/graphify-out/**` excludes derived HTML, request-specific pending manifests/chunks, and other generated output. Pi promotes staged bytes to the canonical manifest only after exact native success, so a crash or R2 sync cannot persist uncommitted high-water state. Edits made during an active extraction remain outside the promoted manifest and become eligible at the next resumed-session or 100-prompt hash check ([REQ-VAULT-026](../../sdd/spec/vault.md#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest), [REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)).

The broad `.config/**` exclude subsumes older specific `.config/rclone/**` and `.config/.wrangler/**` entries. All rclone commands use `--filter` flags, not `--include`/`--exclude`.

Memory-capture counter files used to live at `~/.memory/counter/**` and required an explicit exclude. They now live at `/tmp/.memory-counter/`, which is not synced because Cloudflare Containers use ephemeral disk; see [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages) AC6.

**Note:** The `metadata` mode is defined in `entrypoint.sh` but the Container DO currently only maps `workspaceSyncEnabled` to `full` or `none`. The `metadata` mode can be used by setting `SYNC_MODE` directly in the container environment (see [configuration.md](configuration.md#container-environment) for the env var reference).

**Why `none` is the default.** Workspace directories can be large (gigabytes for compiled projects). Bisyncing the full workspace on every session start adds significant latency and R2 egress cost for content that git already tracks. The recommended pattern for workspace persistence is `git push` before stopping a session and `git clone` on the next. Enable `full` mode only for files that are genuinely hard to reproduce from source: local build artifacts, large datasets, or binary assets not committed to git. See [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers) for the cost-vs-staleness rationale behind the 15-minute cadence.

<a id="manual-sync-triggers-req-stor-015"></a>
### Manual and Final Sync Triggers (REQ-STOR-015)

The periodic cadence is supplemented by one user-driven freshness trigger and one lifecycle-owned durability trigger:

1. **Sync-now button**

     (storage panel toolbar, cloud-download icon). Calls `POST /api/sessions/sync`, which enumerates the authenticated user's running sessions and fans out a per-session bisync trigger with a concurrency cap of 8. Per-session failures are isolated; the response carries `{ sessions: [{ sessionId, status: 'triggered' | 'not-running' | 'failed', error? }], count }` so the UI can show honest aggregate feedback ("Synced N sessions" / "Sync errors" / "No running sessions to sync"). Rate-limited to 6 requests per minute per user. See [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui).
2. **Final sync at shutdown**

     (durability, not user-driven). Before signalling stop, the Container DO's `destroy()` runs a synchronous drain (`drainFinalSync` → `POST /internal/final-sync`, which triggers the daemon via SIGUSR1) and blocks until that bisync reaches a terminal status, while the container is still fully alive. The DO aborts the drain at its 120-second budget (`FINAL_SYNC_BUDGET_MS`); the host endpoint's own poll cap is held strictly ABOVE that (125s) so the DO's abort — not the host loop — is the authoritative ceiling. An inverted host cap (below the budget) was the bisync-on-delete data-loss root cause and is now guarded against. The DO's teardown hard-cap is 135 seconds (120s drain + 15s clean-exit buffer).

     The legacy SIGTERM-trap watchdog is no longer the durability mechanism — the platform killed the container within ~3s of stop, never honoring the grace. See [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync) and [REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync).

R2 uploads do not auto-fan-out to running containers. The user clicks Sync-now to propagate a freshly uploaded file immediately, or waits for the next 15-minute cycle. The upload-side fire-and-forget trigger was removed: bursting many files at once (e.g., 20-file drag-drop) otherwise enumerated KV and fan-out RPC per file, blowing Worker subrequest budget for a feature that the manual button + cadence already cover.

**Daemon-side mechanism.** Triggers reach the daemon as SIGUSR1, sent by the host's `/internal/bisync-trigger` endpoint (which the Worker hits transparently through the Container DO's existing fetch-forward path). A SIGUSR1 trap inside the daemon subshell toggles two coalescing flags: `BISYNC_REQUESTED=1` (interrupt the current `sleep 900`) or `BISYNC_RERUN_REQUESTED=1` (queue exactly one rerun after the current cycle, if a bisync is mid-flight). N signals during one cycle coalesce to exactly one rerun. See [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui) AC5.

**Fan-out concurrency.** R2 provides atomic per-object writes, and bisync resolves ordered conflicts with `--conflict-resolve newer`, but Codeflare does not serialize different running containers that edit the same path. Equal or racing mtimes can temporarily diverge or select one writer; later cadence or resync converges only where timestamps establish an order. Manual fan-out uses the same bounded concurrent mode as the periodic daemon and therefore shares, rather than eliminates, that race. Git remains the preferred source-code authority. See [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers).

**Hibernation note.** Triggers are best-effort. A SIGUSR1 sent while the container is sleeping never reaches the daemon (the daemon process is dead); the next container wake runs a forced baseline bisync per [REQ-STOR-004](../../sdd/spec/storage.md#req-stor-004-initial-sync-restores-files-on-container-start) AC4, which absorbs any pending trigger. The Sync-now button surfaces hibernated sessions as `'not-running'` in the per-session result so the user gets honest feedback rather than a hang.

<a id="session-transcript-cleanup"></a>
### Session Transcript Cleanup ([REQ-STOR-012](../../sdd/spec/storage.md#req-stor-012-main-session-transcript-cleanup))

Claude Code and Pi each keep at most ten candidate JSONL files. Cleanup flattens nested project/session directories into one quota per agent and considers every regular `.jsonl` file below `~/.claude/projects/` or `~/.pi/agent/sessions/`. Claude `subagents/`, `tool-results/`, and `workflows/` remain excluded; Pi `tasks/` remains excluded. Cleanup deletes selected candidate JSONL files only and leaves every directory and excluded child artifact alone. <!-- @impl: transcript-retention.mjs::discoverTranscripts --> <!-- @impl: transcript-retention.mjs::retainLatest -->

A valid UUID filename and native schema allow the adapter to rank a candidate by transcript activity. Claude validates its session identity and supported 2.1 version; Pi validates its version-3 `session` header. Unsupported filenames or schemas remain deletion candidates but switch the whole agent to mtime fallback. The adapters scan bounded head and tail windows, so large transcripts are not loaded into memory. <!-- @impl: transcript-retention.mjs::parseClaudeTimestamp --> <!-- @impl: transcript-retention.mjs::parsePiTimestamp --> <!-- @impl: transcript-retention.mjs::readLatestTimestamp -->

Malformed interior or trailing records are harmless when the header and latest timestamp remain recoverable. If one main candidate has an unknown shape or no recoverable timestamp, the whole agent falls back to deterministic `(mtime_ns, path)` ordering for that pass. Mixing native and restored filesystem chronology would be worse than either policy, so it is deliberately forbidden. <!-- @impl: transcript-retention.mjs::parseClaudeTimestamp --> <!-- @impl: transcript-retention.mjs::parsePiTimestamp --> <!-- @impl: transcript-retention.mjs::readLatestTimestamp -->

Cleanup runs once after the initial R2 restore, before agent PTYs are released, and again inside every regular or final `bisync_with_r2()` call. Deletions therefore reach R2 in the following sync. Each call remains isolated with `|| true`, so cleanup cannot kill startup or the sync daemon. Existing R2 exclusions for Claude subagents and Pi tasks are unchanged. Codex is unchanged too: its session recordings stay excluded and its SQLite-backed transcript state has no smart-retention adapter. <!-- @impl: entrypoint.sh::release_agent_pty_after_cleanup --> <!-- @impl: entrypoint.sh::cleanup_main_transcripts --> <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON -->

## Conflict Resolution

Newest file wins (`--conflict-resolve newer`). `--resilient` + `--recover` handle transient bisync failures (e.g., interrupted transfers, listing mismatches) without losing deletion tracking. The sync daemon retries on the next 15-minute cycle after a failure (or sooner if SIGUSR1-triggered via the storage panel). `--max-delete 100` on ALL bisync commands (`establish_bisync_baseline` and `bisync_with_r2`) allows bulk workspace deletions to propagate. Final bisync at shutdown runs via the DO-side synchronous drain (`POST /internal/final-sync`, 120s budget) before stop — not the legacy SIGTERM-trap watchdog (see [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync)). All bisync commands use `--ignore-checksum` to prevent false hash-mismatch aborts - rclone v1.73 introduced stricter post-transfer MD5 verification that fails when files change during sync.

`--check-sync=false` disables rclone's post-sync listing validation on both `establish_bisync_baseline` and `bisync_with_r2`. The validation compares local/remote file listings after sync - if files change on R2 during the sync (e.g., another active session writing), the listings diverge and rclone exits with code 7 (critical abort). This was the most common trigger. With `--check-sync=false`, drift is caught by the next 15-minute cycle (or sooner via Sync-now).

`--retries 3 --retries-sleep 10s` (rclone v1.66+) on both functions adds bisync-level retries for transient R2 API failures. Each bisync invocation retries up to 3 times with 10s sleep between attempts, before the daemon-level retry logic even kicks in.

**Consecutive failure recovery:** The daemon tracks consecutive bisync failures. After 3 consecutive failed cycles, after each invocation's bounded internal retries are exhausted, the daemon falls back to `establish_bisync_baseline` (which uses `--resync`) to re-establish clean bisync state. `--resync` merges both sides (files present on only one side get copied to the other), so this is a last resort. The counter resets to 0 on any success or after the resync fallback. Resync failures are logged with full command output for diagnostic visibility. The baseline establishment timeout is 600s (10 minutes) to accommodate large initial syncs.

**After consecutive failure recovery:** Transient file errors (encryption mismatch, size mismatch, hash mismatch) are handled by `--resilient` + `--recover` flags and the resync fallback in the daemon. Vanishing-file errors are handled by the per-session recovery filter (see below). A planned `nuke_corrupted_r2_files` function that would scan all R2 objects and delete unrecoverable ones was considered but not implemented; encryption-mismatch orphans from older sessions remain in R2 until manually deleted.

**Bisync exit code handling:** `bisync_with_r2()` uses a temp file approach instead of `| tee` to capture both output and exit code. Piping through `tee` swallows the rclone exit code (the pipe's exit code is `tee`'s, not rclone's), masking bisync failures and breaking error detection in the daemon loop. Both functions redirect with `> "$FILE" 2>&1` (not `2>&1 > "$FILE"`). The old order sent stderr to the parent process's stdout (lost) and only captured stdout in the file. rclone outputs errors and verbose info to stderr, so all diagnostic output was invisible in `/run/codeflare/sync/sync.log`.

**Bisync-initialized flag on timeout:** The bisync-initialized flag (`/run/codeflare/sync/bisync-initialized`) is now touched on the sync timeout path as well. Previously, if initial sync timed out, the flag was never set, causing the final shutdown sync to be skipped - losing any files created during the session. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @impl: entrypoint.sh::shutdown_handler -->

### Vanishing-file recovery

When bisync/resync fails because a transient file was listed but deleted before rclone could copy it (error: `failed to open source object: lstat ... no such file or directory`), the system automatically:
1. Parses the rclone error output for the failing file path
2. Adds it to a session-scoped recovery filter at `/run/codeflare/sync/recovery-filters.txt`
3. Clears stale bisync locks
4. Retries the same operation (up to 3 recovery attempts)

Only non-workspace files are auto-excluded. If the vanishing file is under `workspace/` (user code), the system retries without excluding - the file likely reappeared after a save operation completed. Known ephemeral files (`.claude/mcp-*.json` - MCP auth cache that exists for milliseconds) are statically excluded to prevent the race condition entirely.

The recovery filter file starts empty on every container start and is never synced to R2. All rclone bisync/resync invocations include `--filter-from /run/codeflare/sync/recovery-filters.txt` in addition to the static filters.

**Daemon always starts:** The bisync daemon starts unconditionally after the baseline attempt - even if all baseline recovery attempts fail. A dead daemon means zero sync for the entire session. The daemon has its own recovery loop (vanishing-file recovery on each cycle + consecutive failure → resync fallback after 3 failures). This ensures sync can recover mid-session even if startup sync was disrupted.

---

<a id="troubleshooting"></a>
## Failure Diagnosis and Recovery

- **Storage panel doesn't show a file I just created in the terminal**

    The periodic bisync runs every 15 minutes (see [AD56](../decisions/README.md#ad56-15-minute-bisync-cadence-with-manual-triggers)). Click the **Sync-now** button (cloud-sync icon in the storage panel toolbar) to trigger an immediate bisync across all your running sessions. Status surfaces in the button tooltip ("Synced N sessions" / "No running sessions to sync" / "Sync errors"). If a session shows as `'not-running'`, its container is hibernated; the next time you open that tab the container's wake-time baseline bisync will pull fresh state from R2.
### Bisync empty listing

Initial `establish_bisync_baseline()` uses `--resync`. During steady state, exit code 7 without a prior listing triggers immediate baseline re-establishment because an ordinary retry cannot use absent state.

When listing state exists, resilient/recover handling and vanished-file repair run first. The daemon uses resync only after three consecutive unrecoverable failures. See [REQ-STOR-003](../../sdd/spec/storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) AC6 and [AD125](../decisions/README.md#ad125-bounded-automatic-resync-after-exhausted-recovery).

- **`lstat: no such file or directory` bisync failure**

    A transient file was listed by rclone then deleted before the copy completed. Automatically recovered: the system parses the error, adds the file to `/run/codeflare/sync/recovery-filters.txt`, clears bisync locks, and retries (max 3 attempts). Check `/run/codeflare/sync/sync.log` for `[sync-recovery] Excluded vanished file:` entries. If the failure persists beyond 3 attempts, it escalates to the normal consecutive-failure path. See [Vanishing-file recovery](#vanishing-file-recovery) and [AD43](../decisions/README.md#ad43-parse-and-exclude-vanishing-files-before-escalating-to-nuke).
- **Transfers 0 files**: Filter order indeterminacy from mixed `--include`/`--exclude`. Use `--filter` flags instead.
- **Slow sync**: Switch to `SYNC_MODE=metadata` or manually clean large repos from R2.
- **Missing secrets**: Check `startup-status` response `details.syncError` for the missing variable.
- **Session-delete spinner takes ~2 minutes**

    The Container DO `destroy()` budget is 135 seconds (120s DO-side final-bisync drain budget + 15s clean-exit buffer) — the DO drains the bisync synchronously (`POST /internal/final-sync`) before signalling stop, so unsaved local changes propagate to R2 before SIGKILL. Routine on sessions with large pending writes. See [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync).
- **Search button is missing from the storage panel**

    Removed 2026-05-18 (sync-v2). The toolbar slot is now the Sync-now button. The underlying search-by-name filter (`storageStore.searchFiles`) is still in the codebase and can be restored by re-adding `<SearchInput />` in the toolbar - see comments in `web-ui/src/components/storage/StorageToolbar.tsx` and `web-ui/src/components/StorageBrowser.tsx`.

---

## File Browser (REQ-STOR-016)

The storage browser reads directly from R2 via the Worker API (not the container
filesystem) and renders as a side drawer on desktop, a bottom-sheet on mobile.

**Folder paths.** Because rclone bisyncs the whole `/home/user` home directory to the bucket root, every folder maps to a real in-container directory. Each folder row shows that path in `~/<prefix>` form (`web-ui/src/components/storage/FileList.tsx::folderShortPath`) so operators can see where a prefix lands in the container — at any depth (`Documentation/guides/` → `~/Documentation/guides`) and for dotfolders (`.claude/` → `~/.claude`). Special folders (Vault, Uploads, Temporary, Workspace) instead show their canonical `containerPath` mapping, whose casing can differ from the R2 prefix (`workspace/` → `~/Workspace`).

Within a row the path is pinned to the right edge for every folder so all paths align identically; the special-folder container icon (a tooltip toggle) sits immediately after the folder name rather than trailing the row (`web-ui/src/components/storage/FileList.tsx`, `web-ui/src/styles/storage-browser.css`).

Clicking a file opens it inline in a new browser tab (served with an XSS-safe
Content-Type + `nosniff`) rather than downloading it.

### Append-only pagination ([REQ-STOR-018](../../sdd/spec/storage.md#req-stor-018-file-browser-pagination-is-append-only-and-recoverable))

The Worker returns R2's continuation token and defaults each browser request to a 200-object page. While a page is truncated, the list keeps a visible continuation action available even when its content is too short to scroll; reaching the real `.storage-drop-zone` bottom invokes the same action automatically. The store requests one continuation at a time and appends only unseen object keys/prefixes in response order. A browse generation and prefix snapshot reject late success/failure from older navigation; continuation failure leaves existing rows and the token intact for explicit retry. <!-- @impl: web-ui/src/stores/storage.ts::loadMore --> <!-- @impl: web-ui/src/components/storage/FileList.tsx::FileList -->

The first continuation attempt sets a sticky `paginationStarted` flag for that page-one generation, including on failure. The 30-second timer then stops replacing the accumulated listing but continues refreshing quota/statistics; explicit navigation/manual refresh starts a new generation and resets pagination state. The footer reuses the existing spinner and shows a local retry action without hiding loaded rows. <!-- @impl: web-ui/src/components/StorageBrowser.tsx::StorageBrowser -->

**Traversal safety.** The browse endpoint (`src/routes/storage/validation.ts::validateKey`)
validates every requested prefix and rejects parent-directory (`../`) references, so a
probe cannot escape the user's bucket root — a rejected prefix causes the endpoint to
return an error response (4xx) rather than any listing.

---

<a id="specification-coverage"></a>
## Requirement and Source Map

| Storage concern | Requirements | Source owner | Evidence |
|---|---|---|---|
| Persistent workspace and restore | REQ-STOR-002/004/011 | entrypoint sync functions and storage mode resolver | Startup/baseline and scope tests |
| Final persistence drain | [REQ-STOR-005](../../sdd/spec/storage.md#req-stor-005-graceful-shutdown-performs-final-sync) | `Container.destroy()` → `drainFinalSync`; entrypoint is backstop | Final-sync endpoint/result and lifecycle tests |
| Seed/transcript policy | REQ-STOR-010/012 | seed generator and cleanup scripts | Generated inventory and cleanup behavior |
| Explicit sync | [REQ-STOR-015](../../sdd/spec/storage.md#req-stor-015-explicit-sync-trigger-from-ui) | storage route, host endpoint, sync daemon | Trigger/result contract tests |
| File browser | REQ-STOR-016/018 | storage routes and UI browser state | Traversal, pagination, and recovery tests |
| Encryption regime | Enterprise/Vault SDD | governed migration engine and R2 configuration | Mode/status evidence; private rollout values stay private |

---

## Managed-Resource Sync Policy ([REQ-STOR-031](../../sdd/spec/storage.md#req-stor-031-managed-resource-container-sync))

Protected managed environments restore one canonical `.codeflare/managed-paths.json` before baseline. The entrypoint verifies its exact digest, release, mode, schema, and canonical bytes, then excludes managed exact paths from every bisync. Exclusive mode also excludes each governed resource root. Mutable transition removes stale local policy/filter state before baseline. These filters keep normal bisync convergent; Worker-side mutation denial remains authoritative if root tampers with them. Exclusive enablement is destructive for personal objects inside governed roots and must reconcile only while the user's sessions are stopped.

<a id="startup--steady-state-sync-performance"></a>
## Performance Characteristics

Six startup costs and stale-state risks are controlled (REQ-STOR-017):

- **Bisync compares via server-modtime (AD88, all modes).**

    Both `rclone bisync` invocations in `entrypoint.sh` (the retrying `--resync` baseline and steady-state cycle) pass `--use-server-modtime` and `--checkers 64`. `--use-server-modtime` compares the `LastModified` already returned by the bulk `--fast-list` instead of issuing one mtime HEAD per object, eliminating the per-cycle HEAD storm (the dominant steady-state cost). This is sound under codeflare's newest-wins bisync because the bucket is the per-user source of truth and absolute upload order is the conflict key.
- **Governed Mode delta initial sync (AD90, Governed Mode only).**

    The blocking `initial_sync_from_r2` normally re-downloads the whole agent seed (~627 files, ~9 MB) every boot because the container filesystem is ephemeral. In [Governed Mode](#governed-mode-r2-sse-c-disabled) the entrypoint lays the image-baked seed (see [Preseed](preseed.md)) into the user home first, then runs the initial sync with `--checksum` (usable MD5 ETags, available only when SSE-C is off), so the unchanged seed files are skipped and only user deltas transfer. Under SSE-C (the default) the path is unchanged: `--size-only`, no lay-down.
- **Managed Pi extension relay (mode-specific ownership).**

    Without remote curation, `entrypoint.sh` calls `relay_managed_pi_extensions()` before the bisync `--resync` baseline to re-lay image-baked managed Pi extension bytes over the post-sync `~/.pi/agent/extensions/` tree. This keeps the on-disk bytes equal to the build — the content precondition for the path-sensitive jiti prewarm cache (see [Container lane](container.md#pi-extension-jiti-transpile-cache-warm-up-ad79)) to hit at runtime. Only managed Codeflare filenames are overwritten; user-added extensions are preserved. With remote curation, the relay preserves release-owned extension bytes and restores only the image-owned `context-mode-runtime.ts` companion required by the managed `/ctx` command. <!-- @impl: entrypoint.sh::relay_managed_pi_extensions -->
- **Retired review paths are excluded from R2 (all modes).**

    The common rclone filter excludes the exact managed paths `.pi/agent/extensions/review-job-helpers.ts`, `review-jobs.ts`, and `review-lane-guards.ts`. Initial restore, the retrying baseline, and steady-state bisync all consume the common filter, so stale bucket objects cannot restore retired review machinery.
- **Retired local copies are pruned before Pi loads (without remote curation).**

    In the baked relay path, `relay_managed_pi_extensions()` removes those same three exact local files before laying down current managed bytes. The pruning list is exact: unrelated user-added extensions remain untouched.
- **Background init deprioritization (all modes).**

    The background subshell running the bisync `--resync` baseline, vault seed, and sync/vault daemons runs at `nice 19` / `ionice -c 3` (idle I/O class), yielding the single vCPU and disk to the concurrent pi PTY pre-warm — whose latency was dominated by contention with the baseline, not by the baseline's own work.

<a id="governed-mode-r2-sse-c-disabled"></a>
## Encryption-Regime Alias

When an enterprise admin enables [Governed Mode](configuration.md#governed-mode-r2-sse-c-disable), R2 SSE-C is disabled deployment-wide so the corporate bucket is readable/scannable. Each bucket's actual encryption regime + any in-flight migration is tracked by a per-bucket **state object** (`r2-regime:<bucket>` — `{status: ready|migrating|mixed-recovery, regime, from?, to?, generation, cursor?, phase?, drained?, leaseExpiresAt?, keyMd5?, stuckCount?, lastFailedKey?}`; it replaced the old boolean `UserPreferences.r2SseRegime` marker, a boolean being unable to describe a partially in-place-migrated bucket). Flipping the policy losslessly re-encrypts the bucket in place — a same-key server-side `CopyObject` with `MetadataDirective=REPLACE` (never a nuke) — driven in resumable chunks by the dashboard `batch-status` poll, with the regime committed only after a full verification HEAD-scan.

While a bucket migrates, running containers are drained (best-effort — a drain failure leaves a brief stray-write window, caught by the verification rescan + read self-heal), every R2 writer is gated `409 BUCKET_MIGRATING`, and reads use a dual-regime fallback (a stray cross-regime object self-heals via a `mixed-recovery` scan). Session start never migrates, so session creation is never blocked. Sync behaviour follows the committed regime: rclone drops the SSE-C block from `rclone.conf` and compares by checksum once the bucket is plain. See [AD91](../decisions/README.md#ad91-governed-mode-migration-is-a-verified-gated-chunked-state-machine-replace-copy-not-a-boolean-marker-lazy-reconcile) (migration mechanics; supersedes [AD89](../decisions/README.md#ad89-governed-mode-deployment-wide-r2-sse-c-disable-via-a-kv-toggle-with-lossless-in-place-re-encrypt-migration)) and the [Deployment lane](deployment.md#governed-mode-migration-batch-status-driven).

---

## Related Documentation
- [Architecture](architecture.md#container-do-container) - Container DO lifecycle
- [Container](container.md#container-startup) - Startup sync sequence
- [Memory](vault.md#memory-capture-system) - Memory file sync and cleanup
- [Configuration](configuration.md#container-environment) - Sync environment variables
- [Troubleshooting](troubleshooting.md#r2-sync-issues) - Sync troubleshooting
