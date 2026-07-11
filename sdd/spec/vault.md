# Vault

Persistent Obsidian-style note vault: agent-written session captures plus user-curated prose, indexed into the unified graphify graph for cross-session memory queries.

**Domain owner:** entrypoint.sh, codeflare-vault plugin, graphify, SilverBullet, Worker `/api/vault` route

### Key Concepts

- **Vault** -- The persistent per-user vault directory holding markdown notes, pasted assets, and derived graph output. Attachment uploads land next to the note that referenced them; the dedicated raw-pasted directory is reserved for user-owned drag-drop. The vault is bisynced to R2 so it survives across sessions and is always present in the unified global graph (tagged as the user-vault source; never pruned by the active-repo prune-on-switch logic).
- **Capture Agent** -- The background subagent spawned by the memory-capture hook. Writes one markdown file per batch into the vault's raw-sessions subdirectory and merges it into the unified global graph. Pinned to Sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) (citation accuracy).
- **Vault-monitor Daemon** -- A polling loop in the entrypoint that watches for user-curated edits anywhere under the vault except the agent-written capture directory, the derived graph-output directory, the editor's internal config directory, and the four codeflare-authoritative root pages. When changes are found, writes a trigger marker. Detects changes by comparing each file's content hash against a durable manifest (REQ-VAULT-026), not its mtime, so the R2 restore's mtime reset cannot misfire a full re-extraction.
- **Vault-extract Agent** -- The background subagent spawned by the vault-monitor hook. Runs single-file graph extraction on the changed files, merges the resulting subgraph into the unified global graph, and commits the content-hash manifest (the durable high-water mark) as its final step. Pinned to Sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) (the agent emits citations into the cross-session graph and a confabulated ID is worse than a missing one).
- **Unified Global Graph** -- The merged graph that combines every per-repo graph with the vault's own graph; merges are hash-keyed and serialized under a shared multi-writer lock. The graphify MCP wrapper prefers this graph when present so structural queries return a unified view across all sources.
- **SilverBullet** -- The markdown editor running inside the container, bound to localhost only and reachable from the codeflare UI through the Worker proxy. The auth boundary lives at the Worker.

### Out of Scope

- Custom MCP server for the vault (graphify's existing tools cover read access)
- Multi-graph state inside `graphify.serve` (one MCP wrapper, one global graph)
- Per-tool `graph_path` argument on `mcp__graphify__*` (a single unified graph removes the need)
- FTS5 full-text search (graphify's external-label dedup already collapses concepts; queries route through the graph)
- Backlink parser, SessionStart vault hook, inotify watcher (60s mtime poll is enough)
- Two-bucket model for vault vs. workspace (vault sits inside the existing R2 bucket, with explicit filter includes)
- Desktop Obsidian or web-VNC clients (SilverBullet covers the editing surface)
- Standalone vault-only container (vault lives inside the session container)
- Migration of legacy `~/.memory/session-*.jsonl` into the vault (MCP server-memory subsystem is removed; no historical graph is preserved)
- Per-session sync-concurrency tuning for SilverBullet. The default is hardcoded in the editor's sync engine and is not configurable through its boot config. The cold-start latency delta between the default and a tuned value is small at typical vault sizes and not worth maintaining a fork.
- Priority/lazy object indexing for visible SilverBullet folders. Stock SilverBullet queues every visible `/.fs` entry into the browser object index, so keeping folders visible while indexing only `Notes/` and `References/` first would require a maintained client patch and is deferred until full-index prewarm proves insufficient.
- Lazy attachment loading for the raw-pasted directory. The editor pastes attachments alongside the note they were dropped into, not under a centralized raw-pasted tree, so the lazy-prefix optimization has no real workload to apply to.

### Domain Dependencies

- **Memory** -- Reuses the memory-capture UserPromptSubmit hook and its per-user counter state. The capture agent writes its synthesis output into the vault (the legacy MCP server-memory subsystem has been removed); the dedup-gate marker contract is unchanged.
- **Storage** -- Vault persistence is provided by the existing bisync to R2. The vault tree is added to the shared sync filter set, ordered before the global `graphify-out` exclude so first-match semantics keep vault content synced.
- **Session Lifecycle** -- The shutdown-bisync reliability work ([REQ-VAULT-006](#req-vault-006-shutdown-bisync-completes-vault-writes-before-sigkill)) coordinates the orchestrator destroy budget with the final-sync watchdog so vault edits made in the last seconds before shutdown reach R2 instead of being silently lost.
- **Subscription** -- Vault features (preseed entries, editor supervisor) are gated to Pro session mode via the manifest's mode filter.

---

### REQ-VAULT-001: Persistent vault directory survives across sessions


**Intent:** A user opens a new session and finds their previous notes, captures, and pasted assets intact -- the same way the rest of `/home/user/` survives. This REQ covers the directory skeleton, rclone filter coverage, and storage-panel surfacing of the special folders; codeflare-authoritative file preseeding is in [REQ-VAULT-010](#req-vault-010-codeflare-authoritative-files-preseeded-into-the-vault-on-every-boot).

**Applies To:** User

**Acceptance Criteria:**

1. The vault directory tree is included in the rclone filter set, while only the cumulative graph and extraction manifest are re-included from `Vault/graphify-out/`; derived `graph.json` and `graph.html` remain excluded. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (advanced mode: includes the vault tree AND its vault-graph.json despite the global graphify-out exclude (REQ-MEM-004 AC1 / REQ-VAULT-001 AC1)) -->
2. The ephemeral global-graph workspace directory is excluded from sync so the merged graph is regenerated on boot from the per-source `graphify-out/` files rather than carrying stale state across sessions. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (entrypoint.sh rclone filter behavior (real) / REQ-MEM-004 (vault in R2 sync) / REQ-MEM-006 (advanced-only) / REQ-VAULT-001 (vault filter order) / REQ-STOR-004 (static excludes)) -->
3. The vault initializer creates raw-sessions, raw-pasted, notes, references, graphify-out, and SilverBullet config subdirectories on every boot. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: the init_user_vault skeleton (raw-sessions/raw-pasted/notes/references/graphify-out/SilverBullet-config subdirs created on every boot) is genuinely covered by host/__tests__/entrypoint-vault-boot.test.js, which runs the real function body and asserts existsSync for Raw/Sessions, Notes, References, graphify-out, .silverbullet/_plug; not re-written here to avoid duplicate coverage -->
4. The vault initializer runs after the bisync baseline is established and before the daemon launch block so the empty skeleton never overwrites R2-restored content. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: the boot-ordering (vault initializer runs after the bisync baseline, before daemon launch) is genuinely covered by host/__tests__/entrypoint-vault-boot.test.js ('runs establish_bisync_baseline BEFORE init_user_vault at boot'), which extracts the real boot block, stubs deps to log, and asserts BASELINE is logged before VAULT_INIT -->
5. The vault initializer creates persistent Uploads and Temporary folders alongside the vault; both are R2-synced and visible in the storage panel. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: web-ui/src/__tests__/lib/special-folders.test.ts (SPECIAL_FOLDERS registry / REQ-VAULT-001 AC6 (R2 panel surfaces special folders)) --> <!-- coverage-gap: the Uploads/Temporary R2-sync half is genuinely covered by host/__tests__/entrypoint-rclone-filters.test.js (advanced-vs-default asserts Uploads/a.txt + Temporary/b.txt INCLUDED in both modes via real rclone); the mkdir half is the init_user_vault skeleton already exercised by host/__tests__/entrypoint-vault-boot.test.js; the 'visible in storage panel' half is a UI-rendering assertion out of this entrypoint-shell scope -->
6. The storage panel surfaces Workspace, Vault, Uploads, and Temporary as special folders with path-and-purpose tooltips. <!-- @impl: web-ui/src/lib/special-folders.ts::SPECIAL_FOLDERS --> <!-- @test: web-ui/src/__tests__/lib/special-folders.test.ts (SPECIAL_FOLDERS registry / REQ-VAULT-001 AC6 (R2 panel surfaces special folders)) -->

**Constraints:**

- The vault shares the user's existing R2 bucket; there is no separate vault bucket.
- Vault content is per-user (each user has their own R2 bucket).
- The vault directory must live at a non-hidden basename, because the editor's disk walker aborts traversal when the root basename starts with a dot, returning an empty file listing even when notes are on disk.

**Priority:** P0

**Dependencies:** [REQ-STOR-002](storage.md#req-stor-002-file-persistence-across-sessions) (file persistence across sessions), [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) (15-min bisync), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start) (initial sync restores files on container start)

**Verification:** [Behavioral test](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-VAULT-002: Conversation captures land in the vault as markdown


**Intent:** The capture agent writes one markdown file per 15-prompt batch into `Raw/Sessions/`, replacing the previous MCP-memory write path. Captures appear in `mcp__graphify__*` queries the same turn they are written.

**Applies To:** User

**Acceptance Criteria:**

1. The capture agent writes one markdown file per batch into the vault's raw-sessions subdirectory using a dated filename and the YAML-frontmatter + Context/Decisions/Observations/References template. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (prefilter-transcript.sh (REQ-MEM-001 AC3) / REQ-VAULT-002 (conversation captures land in vault as markdown)) --> <!-- coverage-gap: no genuine behavioral test — "The capture agent writes one markdown file per batch into the vault's raw-sessions subdire..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
2. Concept references use wikilink syntax; file paths, code symbols, and PR/issue references stay as prose. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- coverage-gap: wikilink-vs-prose distinction is capture-prompt prose; no automated test asserts wikilink syntax for concepts vs. plain-text file paths/symbols -->
3. The capture agent builds the vault graph inline: the agent emits chunk JSON matching the graph builder's schema, then a graph-build step materializes the per-extraction graph. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (prefilter-transcript.sh (REQ-MEM-001 AC3) / REQ-VAULT-002 (conversation captures land in vault as markdown)) --> <!-- coverage-gap: inline chunk-JSON build is capture-prompt prose (agent IS the LLM); no automated test asserts the inline materialize step -->
4. The agent merges the per-extraction graph into the unified global graph under the shared multi-writer lock and tags it as the vault source. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- coverage-gap: no genuine behavioral test — "The agent merges the per-extraction graph into the unified global graph under the shared m..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
5. If extraction fails, the markdown file stays on disk; the vault-monitor daemon excludes `Raw/Sessions/`, so recovery is the next 15-message capture batch re-firing rather than a vault-monitor tick. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- coverage-gap: no genuine behavioral test — "If extraction fails, the markdown file stays on disk; the vault-monitor daemon excludes `R..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
6. The historical MCP memory subsystem has been removed entirely; the capture agent does not invoke it, and no legacy JSONL graph is read. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- coverage-gap: removal/negative property (no MCP server-memory invocation, no legacy JSONL read) is capture-prompt prose; no automated test asserts the absence -->

**Constraints:**

- The dedup gate (the marker-file delete as the agent's first step) is unchanged from the pre-vault flow.
- Compaction is not automated; the user prunes captured sessions manually via the editor when the directory becomes unwieldy.
- The headless extraction CLI is intentionally bypassed per [REQ-MEM-001](memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC6 - codeflare ships no LLM provider key for the CLI and the capture agent already IS the LLM, so re-invoking the CLI would duplicate inference cost with no benefit.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-VAULT-003: User-curated edits are detected and ingested within ~60s

**Intent:** A user adds a note in SilverBullet (or any other editor) and within roughly one daemon tick the new content shows up in `mcp__graphify__*` query results.

**Applies To:** User

**Acceptance Criteria:**

1. The vault-monitor daemon polls the vault on a short fixed cadence, excluding the agent-written capture directory, the served graph-viz copy directory, the derived graph-output directory, the vendored editor plug-bundle directory, the editor's internal config directory, and the four preseed-managed root pages. <!-- @impl: entrypoint.sh::start_vault_monitor_daemon --> <!-- @test: src/__tests__/lib/vault-exclusion.test.ts (isVaultExcludedPath) -->
2. Change detection compares each vault file's content hash against a durable manifest (REQ-VAULT-026), not a file mtime, so a container restart that resets every file's mtime does not misreport the vault as changed. <!-- @impl: entrypoint.sh::start_vault_monitor_daemon --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (THE ORACLE: an R2-style restore (rewrite every file, fresh mtime, identical bytes) yields ZERO changes) -->
3. The hook handler exits immediately when the trigger marker is absent (zero-cost on idle prompts) or when an in-flight sentinel exists and is younger than 30 minutes. When neither exit condition applies, it creates the in-flight sentinel and emits an additional-context directive instructing the main agent to dispatch the vault-extract subagent. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh::PROMPT_FILE --> <!-- @test: host/__tests__/vault-monitor-hook-behavior.test.js (vault-monitor-hook.sh behavior (real) / REQ-VAULT-003 AC3 (hook fast-exit + 30-min in-flight sentinel TTL)) -->
4. The vault-extract subagent deletes the trigger marker as its first step (dedup gate), runs graph extraction per changed file, merges via the shared global-graph add command, commits the content-hash manifest and refreshes the ephemeral dedup timestamp, and removes the in-flight sentinel as its final step. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->
5. If any of the extract-merge-advance steps fail, the manifest is not committed; the next daemon tick re-discovers the same files. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- coverage-gap: fail -> manifest-not-committed is vault-extract-prompt prose; no automated test exercises the failure path -->
6. Preseed-page rewrites never register as vault changes: the four pages are excluded from the manifest (AC1) and unchanged bytes never register under content-hash detection (REQ-VAULT-026), which replaces the old high-water-marker bump-after-preseed-write mechanism. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) --> <!-- coverage-gap: boot baseline is shell boot-behavior; content-hash mtime-immunity is covered by AC2's oracle (vault-manifest-detection.test.ts) -->
7. Pi vault-extract triggers are inert inside subagent child sessions — sessions whose header carries a parent-session pointer, which always load the parent's extensions — so background monitor transcripts (review monitors, CI monitors) never receive an injected vault-extract follow-up as their visible output. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::isChildSession --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-MEM-001/REQ-VAULT-003: memory-vault handlers are inert inside subagent child sessions) -->

**Constraints:**

- The polling cadence is intentional; inotify was rejected as overkill for the expected edit rate.
- The exclusion list is identical across runtimes (Claude's `vault-manifest.py` and Pi's `vault-manifest-fs.ts` share the generated-prefix + preseed-root-page set); the four preseed-managed root pages are codeflare-authoritative, so a per-boot preseed copy must not count as a user edit. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi vault indexing shares Claude content-hash detection + exclusions) -->
- The in-flight sentinel (30-minute TTL) prevents the hook from re-spawning the agent on every prompt while extraction is already running; the TTL must exceed real extraction durations (measured ~18 min on 30+ changed files — a shorter TTL dispatched a second concurrent agent mid-run). The sentinel is created by the hook on emission and removed by the agent as its final step.
- The vault-extract subagent is pinned to sonnet at the subagent-definition level (per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)) so the dispatching parent cannot silently downgrade the model.
- PDF-specific ingestion behavior is specified in [REQ-VAULT-011](#req-vault-011-vault-extract-ingests-pdf-files).

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** [Behavioral test](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-VAULT-004: Unified global graph merges vault and active repos


**Intent:** A single `mcp__graphify__*` call returns nodes from the vault and from every per-repo graphify-out the session has touched, so cross-cutting questions ("did we ever discuss X with respect to Y") work without manually selecting a graph.

**Applies To:** Agent

**Acceptance Criteria:**

1. The MCP wrapper's active-graph resolver prefers the unified global graph when present, falling back to the sentinel-pinned per-repo graph and then to the freshest workspace-by-mtime graph. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py::_resolve_active --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh / REQ-VAULT-004 (unified global graph merges vault + active repos)) --> <!-- coverage-gap: no genuine behavioral test — "The MCP wrapper's active-graph resolver prefers the unified global graph when present, fal..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
2. The active-repo hook adds the resolved repo's graph to the unified graph (under the shared multi-writer lock) whenever the active repo has a graph and either the manifest does not yet record this repo's tag or the manifest's recorded source hash does not match the current graph hash. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::REPO --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-VAULT-004: memory-vault.ts publishes the cumulative vault graph to the global graph via flock-guarded graphify global add) -->
3. The vault directory is explicitly excluded from active-repo candidate resolution; when the walk-up loop reaches that path, the hook exits without rewriting the sentinel or invoking the global add, so the vault is never re-tagged as a repo by a tool call that happens to touch a vault file. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::CANDIDATE --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh / REQ-VAULT-004 (unified global graph merges vault + active repos)) --> <!-- coverage-gap: no genuine behavioral test — "The vault directory is explicitly excluded from active-repo candidate resolution; when the..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
4. A cheap fast-path skip avoids spawning the graph tool on every routine bash/edit/write call: when the resolved active-repo path equals the prior sentinel value and the per-repo graph file's mtime is not newer than the sentinel's mtime, the hook returns immediately. The sentinel is touched at the end of every non-fast-path fire so subsequent fires can short-circuit until the next graph rebuild. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::GRAPH_MTIME --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh / REQ-VAULT-004 (unified global graph merges vault + active repos)) --> <!-- coverage-gap: no genuine behavioral test — "A cheap fast-path skip avoids spawning the graph tool on every routine bash/edit/write cal..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
5. Single-active-repo invariant and multi-writer lock serialization are specified in [REQ-VAULT-014](#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation). <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh --> <!-- coverage-gap: forward-reference AC; the invariant + lock serialisation it points to are tested under REQ-VAULT-014 (active-repo invariant + flock serialisation audit) -->

**Constraints:**

- The global-graph add is hash-keyed and idempotent: re-running it with the same per-repo graph is a no-op.
- The per-source tag is what distinguishes vault nodes from per-repo nodes in the unified graph; each source carries one stable tag.
- Branch-level granularity is not represented in the global manifest. A repo's tag is its directory basename; branch switches within the same repo refresh the entry via the hash-diff path once the user has rebuilt the graph on the new branch. Until the rebuild runs, the global graph still shows the prior branch's nodes under the same tag - an acceptable staleness window because automatic rebuild on every checkout would be too expensive.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions), [REQ-VAULT-002](#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** [Behavioral test](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-VAULT-005: Worker proxy exposes the in-container vault editor


**Intent:** Clicking the Vault button in the codeflare UI opens SilverBullet in a new tab, behind the same auth + rate-limit boundary as every other tier-gated session feature. This REQ covers the in-container server, the auth/rate-limit proxy plumbing, and the host-side HTTP+WS branch; UX integration lives in [REQ-VAULT-012](#req-vault-012-vault-button-render-and-dashboard-landing), and browser readiness gating lives in [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger).

**Applies To:** User

**Acceptance Criteria:**

1. The container image installs the SilverBullet server binary pinned by version and digest so the running editor is identical across deploys. <!-- @impl: Dockerfile --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) --> <!-- coverage-gap: no genuine behavioral test — "The container image installs the SilverBullet server binary pinned by version and digest s..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
2. The container entrypoint supervises the editor on a localhost-only port with a short-interval restart loop so an editor crash never requires a container restart. <!-- @impl: entrypoint.sh::start_silverbullet_supervisor --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) --> <!-- coverage-gap: no genuine behavioral test — "The container entrypoint supervises the editor on a localhost-only port with a short-inter..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
3. The vault-route handler applies the same auth chain as the terminal WebSocket upgrade: authentication, origin allowlist, effective-tier active-user check, session ownership, container health probe, then container fetch. <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
4. WebSocket upgrades for live-edit sync are rate-limited under the same per-user budget as terminal WebSockets so a separate budget cannot be discovered. <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) --> <!-- coverage-gap: no genuine behavioral test — the vault WS rate-limit (the `ws-connect:<email>` budget shared with terminal WebSockets, guarded by the isWebSocket branch) is integration-level: it needs live WebSocket connection state plus the rate-limit KV store, and no Workers-vitest stub exercises the shared-budget enforcement path -->
5. The in-container terminal server exposes an HTTP branch that strips the vault path prefix and forwards to the localhost editor, plus a WebSocket upgrade passthrough scoped to vault paths only. <!-- @impl: host/src/server.ts::handleVaultUpgrade --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->

**Constraints:**

- The editor binds to localhost only; the Worker proxy is the only externally reachable surface.
- The vault status endpoint runs through the normal application middleware; only the catch-all proxy is intercepted before the application router.
- For body-bearing methods, the forwarded request must be the header-rewritten clone produced by the CSRF-synthesis helper rather than the original incoming request; the helper consumes the input body when it constructs the clone, so forwarding the original would attempt to read an already-disturbed stream. The auth chain must read only headers so it cannot accidentally consume the body.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

### REQ-VAULT-006: Shutdown bisync completes vault writes before SIGKILL


**Intent:** A user who stops a session and closes their browser within seconds finds their latest vault edits intact on the next session, instead of losing them to a mid-bisync SIGKILL.

**Applies To:** User

**Acceptance Criteria:**

1. The entrypoint shutdown handler wraps the final bisync in a background subshell with a watchdog that hard-kills on timeout, so the orchestrator's destroy budget always lands after bisync finishes or gives up cleanly. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) --> <!-- coverage-gap: no genuine behavioral test — "The entrypoint shutdown handler wraps the final bisync in a background subshell with a wat..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
2. The shutdown handler also terminates the vault-monitor daemon and the editor supervisor so neither lingers past container shutdown. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) --> <!-- coverage-gap: no genuine behavioral test — "The shutdown handler also terminates the vault-monitor daemon and the editor supervisor so..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
3. The shutdown elapsed time is logged so operators can tune the watchdog over time if user edit volumes grow large enough to need more headroom. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- coverage-gap: no genuine behavioral test — "The shutdown elapsed time is logged so operators can tune the watchdog over time if user e..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
4. The Container DO's destroy budget is sized to cover the bisync watchdog plus enough additional time for clean process exit. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
5. The container's stop handler logs the total shutdown elapsed time so operators have telemetry on whether the budget is right. <!-- @impl: src/container/container-lifecycle.ts::onStop --> <!-- @impl: src/container/index.ts::onStop --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:**

- The bisync-watchdog timeout and the orchestrator's destroy budget must stay coordinated so the destroy budget exceeds the watchdog plus the minimum time required for graceful process termination.

**Priority:** P0

**Dependencies:** [REQ-SESSION-009](session-lifecycle.md#req-session-009-container-destroy-wipes-session-state) (container destroy wipes session state), [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync) (graceful shutdown with final sync), [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync) (graceful shutdown performs final sync)

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-VAULT-007: Vault rules and plugin are preseeded into every advanced session


**Intent:** A fresh advanced-mode session ships with the codeflare-vault plugin (hook + extraction prompt + plugin descriptor) and the memory rule (which carries the folded vault trigger/route content) already in place -- no per-session install step.

**Applies To:** Agent

**Acceptance Criteria:**

1. The Claude preseed manifest registers the vault plugin (plugin descriptor, vault-monitor hook script, vault-extract prompt), the vault-note-capture rule, and the vault-note-capture and vault-operations skills - all in advanced mode only. The vault trigger/route content is folded into the memory rule rather than living in a separate vault rule. <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The container image stages the editor preseed assets under a build-time preseed root so the vault initializer can install editor config from there without baking it into every R2 sync. <!-- @impl: Dockerfile --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: no genuine behavioral test — "The container image stages the editor preseed assets under a build-time preseed root so th..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
3. A build-time generator (run as prebuild) embeds the manifest contents into the runtime agent-seed module, which is what the Worker ships to the container at boot. <!-- @impl: scripts/generate-agent-seed.mjs --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. The Claude memory rule is updated to document the vault-only capture path. <!-- @impl: preseed/agents/claude/rules/memory.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) --> <!-- coverage-gap: the memory rule documenting the vault-only capture path is preseed rule prose; no automated test asserts the rule wording -->
5. On every boot, the vault initializer copies the editor plugs from the build-time preseed root into the codeflare-managed plug subdirectory of the vault's plug library so the editor opens with the baseline productivity plug set available immediately, with no per-session install step. The copy is idempotent (overwrite when content differs) so a codeflare-side plug pin bump propagates on next boot; user-installed plugs land under other plug-library subdirectories and are untouched. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->

**Constraints:**

- Default-mode sessions do not receive the vault plugin; the editor is an advanced-tier feature.
- The vault skeleton is created at runtime, not baked into the image, so a returning session never overwrites restored content.
- The codeflare-managed plug subdirectory is reserved for codeflare-managed plugs; user-installed plugs live under sibling subdirectories so codeflare's overwrite-on-boot never clobbers user state.

**Priority:** P0

**Dependencies:** [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) (preseed configs from single source), [REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start) (preseed deployed to container on start), [REQ-AGENT-014](agents.md#req-agent-014-manifest-driven-preseed-pipeline) (manifest-driven preseed pipeline)

**Verification:** [Behavioral test](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-VAULT-008: Zero-UI vault encryption

**Intent:** SilverBullet's IndexedDB caches every vault file as raw bytes. This REQ covers encryption-at-rest with a per-session key generated and stored by the Container DO (no user passphrase prompt); IDB lifecycle cleanup on session DELETE and dashboard-mount sweeping lives in [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters). Delivering that key to the browser and keeping it available in the service worker is [REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention). The threat model is BitLocker-grade: defeats offline disk attacks (profile theft, backup leak, ransomware scan), does NOT defeat anyone with an authenticated browser tab. The key dies with `container.destroy()` so deletion is forward-secret.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO generates a high-entropy random vault key on first start, persists it in its own storage, and returns the same key on every subsequent read. <!-- @impl: src/container/container-config.ts::ensureVaultKey --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
2. The key is never rotated; it is wiped only when the container is destroyed (session delete). <!-- @impl: src/container/container-config.ts::ensureVaultKey --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->
3. The Worker's vault-config proxy fetches the vault key via DO RPC and merges it (plus the enable-encryption flag) into the editor's runtime boot config. <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
4. The editor uses the vault key to symmetrically encrypt its per-vault IndexedDB store via its built-in encrypted-KV wrapper. <!-- @impl: src/routes/vault-native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS --> <!-- coverage-gap: SilverBullet encrypted-KV wrapper usage is a runtime/IndexedDB behavioral property performed by the SilverBullet binary's built-in KV layer on read/write, with no importable symbol or jsdom-observable side effect in the test pool -->

**Constraints:**

- Encryption defeats offline attacks only, not an authenticated browser tab or on-origin JavaScript; trade-off documented in [AD59](../../documentation/decisions/README.md#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key).
- The vault key must not be rotated mid-session; rotation would orphan existing IDB ciphertext and force a fresh re-sync on the next container restart.
- The vault key is wiped only when the container is destroyed; persistence after deletion would let a recovered browser profile decrypt the orphaned IDB.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor), [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions) (vault directory survives sessions), [REQ-MEM-006](memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode) (Pro mode gating)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

### REQ-VAULT-009: Vault writes succeed end-to-end for SilverBullet attachment uploads


**Intent:** SilverBullet's drag-drop attachment upload (PUT `/api/vault/<sid>/Inbox/<file>`) must succeed when the user is authenticated, regardless of whether the browser's fetch implementation set the Origin header. The previous code path required Origin to be present and allowlisted before synthesising the CSRF guard header, so a service-worker-controlled fetch or a same-origin fetch that omitted Origin landed at the auth chain without X-Requested-With and was rejected. PDF uploads from the SB Inbox plug repeatedly surfaced this as a 401 to the user.

**Applies To:** User

**Acceptance Criteria:**

1. A state-changing request to a vault path with no Origin header is treated as same-origin and proceeds through CSRF synthesis. The synthesis adds the XHR-marker header so the downstream auth CSRF guard does not reject the write. <!-- @impl: src/routes/vault-html.ts::maybeSynthesizeCsrfHeader --> <!-- @impl: src/routes/vault-html.ts::maybeIssueCsrfCookie --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
2. A state-changing request with an Origin header that fails the allowlist still returns a 403; the missing-Origin fallback does not widen the allowlist. <!-- @impl: src/routes/vault-html.ts::inferOriginValidated --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
3. The forward chain preserves the request body bytes end-to-end (no double-read, no disturbed stream) on both the with-Origin and the no-Origin paths. <!-- @impl: src/routes/vault-html.ts::maybeSynthesizeCsrfHeader --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
4. Existing read-only and preflight requests behave unchanged; only state-changing methods enter the fallback path. <!-- @impl: src/routes/vault-html.ts::inferOriginValidated --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->

**Constraints:**

- Modern browsers always set Origin on state-changing cross-origin requests; the fallback exists for the editor's same-origin path (where Origin is null or omitted) and for CLI-style clients. It does not bypass the allowlist when an Origin is present and disallowed.

**Priority:** P1

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

### REQ-VAULT-010: Codeflare-authoritative files preseeded into the vault on every boot


**Intent:** A defined set of vault files are codeflare-authoritative: SilverBullet widgets, wikilink handlers, theming, and the graph build all depend on their contents being current at boot. User edits to these files are intentionally not preserved, and stale build artefacts that mislead the user must be cleared on every boot.

**Applies To:** User

**Acceptance Criteria:**

1. The vault initializer copies the three codeflare-authoritative config root pages (CONFIG, README, STYLES) from the preseed source into the vault root on every boot, gated so identical files are not rewritten; `Index.md` is seeded create-if-missing rather than force-overwritten (see [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC5) because the editor normalizes and autosaves it. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
2. User content lives in dedicated user-owned subdirectories (notes, references, inbox, journal, raw-pasted, raw-sessions) and is never touched by the preseed sync; only the three codeflare-authoritative config pages are force-overwritten (`Index.md` is create-if-missing, so its edits persist). <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: no genuine behavioral test — "User content lives in dedicated user-owned subdirectories (notes, references, inbox, journ..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
3. The entrypoint must not write a partial copy of the editor's built-in plug library onto disk because the editor binary serves those files from its built-in overlay, and a partial on-disk copy would shadow the overlay with incomplete files and break widget rendering. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: no genuine behavioral test — "The entrypoint must not write a partial copy of the editor's built-in plug library onto di..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
4. The vault graph file is seeded with an empty-graph stub only when absent; a populated graph from a prior session is never overwritten by the entrypoint. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: no genuine behavioral test — "The vault graph file is seeded with an empty-graph stub only when absent; a populated grap..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
5. The vault initializer removes stale globally-rendered graph artifacts on every boot when present (idempotent removal, guarded so it fires only when the preseed counterpart is also absent). <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: no genuine behavioral test — "The vault initializer removes stale globally-rendered graph artifacts on every boot when p..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->

**Constraints:**

- The three authoritative config pages (CONFIG, README, STYLES) are kept current because the editor's dashboard widgets, in-page wikilink handlers, and codeflare theming all depend on their contents being current; user edits to those three pages are intentionally not preserved across boots. `Index.md` is the exception: it is seeded create-if-missing and editor-owned (the editor normalizes/autosaves it), so force-overwriting it produced a perpetual 2nd-start sync conflict — its edits now persist (see [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC5).
- The configuration page is a runtime contract, not user content; that is why it lives in the always-overwrite tier and not in the user-editable tier.
- The editor's binary hardcodes the lowercase index page name, so the supervisor must explicitly tell the editor to load the title-cased preseed index page at the root URL.
- The seed-only-if-absent rule for the vault graph file exists because the graph is build output regenerated by the extraction pipeline, not preseed content.
- The stale-graph-artifact removal exists because the unified global graph is too large for useful in-page HTML visualization; structural queries are the real interface and the vault visualization covers the user-curated slice. Vaults restored from R2 snapshots predating the removal are reconciled on the next boot.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** [Behavioral test](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-VAULT-011: Vault-extract ingests PDF files

**Intent:** PDFs dropped into the vault (typically under `Raw/Pasted/`) must be ingested into the global graph as first-class content, not skipped as binary. The agent reads each PDF, emits a `document` node plus extracted `concept` nodes, and links to sibling notes that wikilink the same file. Corrupt or unreadable PDFs must not block ingestion of healthy files.

**Applies To:** User

**Acceptance Criteria:**

1. PDF files in the changed-files list are ingested as content, not skipped as opaque binary. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- coverage-gap: PDF ingestion is prompt-driven (REQ Verification = Manual check); E2E validated via documentation/lanes/vault.md PDF-ingestion plan, no Workers-vitest automated test (binary malformed-PDF fixtures impractical) -->
2. The vault-extract agent reads each PDF (capped at a bounded page count for large files), emits a document-type node for the PDF itself plus concept-type nodes for visible title text, headings, named entities, and diagrams. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- coverage-gap: PDF ingestion is prompt-driven (REQ Verification = Manual check); E2E validated via documentation/lanes/vault.md PDF-ingestion plan, no Workers-vitest automated test (binary malformed-PDF fixtures impractical) -->
3. When a sibling markdown note wikilinks the same PDF, a citation edge connects the document node to the wikilink concept so the global graph unifies them. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- coverage-gap: PDF ingestion is prompt-driven (REQ Verification = Manual check); E2E validated via documentation/lanes/vault.md PDF-ingestion plan, no Workers-vitest automated test (binary malformed-PDF fixtures impractical) -->
4. Read failures on PDFs (corrupt, password-protected, unsupported encoding) emit the bare document node only; the manifest still commits so a single unreadable PDF does not block ingestion of other changed files. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- coverage-gap: PDF ingestion is prompt-driven (REQ Verification = Manual check); E2E validated via documentation/lanes/vault.md PDF-ingestion plan, no Workers-vitest automated test (binary malformed-PDF fixtures impractical) -->

**Constraints:**

- The page cap is a Read-tool limit; PDFs longer than the cap are partially ingested rather than rejected.
- AC4's corrupt/password-protected PDF read-failure path is verified by manual check (the REQ's Verification field), not an automated test: exercising it needs binary malformed-PDF fixtures that are impractical to ship in the Workers vitest pool, so it is validated against the PDF-ingestion E2E plan in `documentation/lanes/vault.md`.

**Priority:** P1

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-VAULT-012: Vault button render and dashboard landing


**Intent:** The Vault button appears only for active advanced sessions, and each click opens SilverBullet on the codeflare dashboard. The dashboard leads users toward durable notes and references before broader recent-content widgets.

**Applies To:** User

**Acceptance Criteria:**

1. The app shell passes a Vault opener to the header only for active advanced-mode sessions. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)) -->
2. Clicking the Vault control opens the current session's proxied editor. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header Component / REQ-VAULT-012 (vault button render and readiness gating) / REQ-AUTH-016 (header user dropdown)) -->
3. The editor opens on the codeflare dashboard page. <!-- @impl: entrypoint.sh::start_silverbullet_supervisor --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: no genuine behavioral test — "The editor opens on the codeflare dashboard page" is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
4. The dashboard links to the README near the top. <!-- @impl: preseed/silverbullet/Index.md --> <!-- coverage-gap: dashboard Index.md layout (README link, Notes/References ordering) is codeflare-authoritative preseed prose; no automated test -->
5. The dashboard surfaces `Notes/` and `References/` before generic recent-content widgets. <!-- @impl: preseed/silverbullet/Index.md --> <!-- coverage-gap: dashboard Index.md layout (README link, Notes/References ordering) is codeflare-authoritative preseed prose; no automated test -->

**Constraints:**

- The dashboard is codeflare-authoritative preseed content.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** [Layout gating test](../../web-ui/src/__tests__/components/Layout.test.tsx), [Header behavior test](../../web-ui/src/__tests__/components/Header.test.tsx)

**Status:** Implemented

---

### REQ-VAULT-013: SilverBullet subpath adapter


**Intent:** SilverBullet ships an SPA shell with `<base href="/" />` and assumes it owns its origin; under the `/api/vault/:sid/` per-session proxy, every relative asset request would otherwise resolve against the Worker root and 404. The Worker injects a per-session base href on every text/html response so the editor's relative asset references resolve back through the subpath proxy. The companion native-service-worker contract (registration short-circuit, key delivery, precache) is [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker).

**Applies To:** User

**Acceptance Criteria:**

1. The vault proxy rewrites the bare HTML base-href to the per-session vault-proxy path on every HTML response (not gated to the root path), so the editor's relative asset references resolve back through the subpath proxy regardless of which page the user reloaded onto. <!-- @impl: src/routes/vault-html.ts::rewriteVaultBaseHref --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
2. Non-HTML responses (JS bundles, images, manifests, markdown page bodies, JSON API replies, binary assets) pass through unchanged; the HTML-only guard is sufficient because the editor's API endpoints return non-HTML content types. <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
3. When the body is rewritten, both the content-length and content-encoding headers are dropped because the rewrite path auto-decompresses upstream compression, and the original headers would otherwise trigger a browser decoding failure. <!-- @impl: src/routes/vault-html.ts::rewriteVaultHtmlResponse --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
4. When the rewrite runs but the body did not contain the expected base-href substring (no-op rewrite), a warning is logged so a future editor-template change surfaces as a logged signal instead of a silent white-screen regression. <!-- @impl: src/routes/vault-html.ts::rewriteVaultHtmlResponse --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->

**Constraints:**

- The editor honors a URL-prefix environment variable for rendering the base tag, but the prefix is per-session (the Worker knows the session ID, the container does not); baking it in at supervisor start is not viable, so the per-response Worker rewrite is the per-session adapter.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

### REQ-VAULT-014: Graphify active-repo invariant and lock serialisation


**Intent:** Concurrent agent flows must not corrupt the global graph, and the global graph must never accumulate stale per-repo entries when the user switches between repos. This REQ specifies the single-active-repo invariant and the cross-writer lock serialisation that keep the global graph well-formed under contention.

**Applies To:** Agent

**Acceptance Criteria:**

1. When the resolved active repo's tag differs from the previously-recorded tag and the previous tag is still present in the global manifest, the hook removes the previous entry (under the shared multi-writer lock) before performing the add specified in [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC2. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::HOME_RESOLVED --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh single-active-repo maintenance / REQ-VAULT-014 (graphify active-repo invariant + lock serialisation)) --> <!-- coverage-gap: no genuine behavioral test — "When the resolved active repo's tag differs from the previously-recorded tag and the previ..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
2. End state after a repo switch: the global graph contains the vault entry plus exactly one per-repo entry (the user's currently active repo). <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh single-active-repo maintenance / REQ-VAULT-014 (graphify active-repo invariant + lock serialisation)) --> <!-- coverage-gap: no genuine behavioral test — "End state after a repo switch: the global graph contains the vault entry plus exactly one ..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
3. Same-tag transitions (two clones with identical directory basenames, or branch switches within the same repo) skip the explicit remove because the global add operation replaces the existing entry via its source-hash dedup. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::CANDIDATE --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh single-active-repo maintenance / REQ-VAULT-014 (graphify active-repo invariant + lock serialisation)) --> <!-- coverage-gap: no genuine behavioral test — "Same-tag transitions (two clones with identical directory basenames, or branch switches wi..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->
4. All write sites (capture agent, vault-extract agent, active-repo hook, the graphify skill's commit step) serialize via the shared multi-writer lock to prevent corrupted writes when multiple workflows race; the lock-acquisition timeout ensures a crashed lock holder cannot wedge the queue indefinitely. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh single-active-repo maintenance / REQ-VAULT-014 (graphify active-repo invariant + lock serialisation)) --> <!-- coverage-gap: no genuine behavioral test — "All write sites (capture agent, vault-extract agent, active-repo hook, the graphify skill'..." is shell/process/build boot behavior with no isolatable runnable unit in the node:test pool -->

**Constraints:**

- The pre-spawn hash check in [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC2 uses a SHA-256 digest truncated to the graph builder's standard tag length with a length sanity-guard so a malformed digest cannot poison the comparison.
- The graphify skill's commit step is one of the write sites and must include a locked global-add call so a fresh build lands in the global graph.

**Priority:** P0

**Dependencies:** [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-VAULT-015: Vault IDB lifecycle and listing filters


**Intent:** SilverBullet's on-disk listings would otherwise expose derived/internal directories to the user, and stale per-session bookkeeping would otherwise accumulate in browser storage. This REQ covers per-session localStorage-marker cleanup on session DELETE, authoritative session-list sweeping of orphaned markers, and the listing filters that keep derived output and internal preseed pages out of the vault tree. As reconciled by [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap), the SilverBullet IndexedDB stores and the vault service worker are bucket-stable (one per user, persisting across sessions) and are therefore NOT torn down by this cleanup.

**Applies To:** User

**Acceptance Criteria:**

1. The editor's filesystem-listing endpoint hides the derived graph-output directory, generated `Raw/Graphs/*.html`, and machine-owned session-capture memory (`Raw/Sessions/`) from the browser listing and SilverBullet client sync/index; client mutations to those hidden paths are rejected so a transitioning client cannot delete the on-disk memory. <!-- @impl: src/routes/vault-html.ts::filterVaultFsListing --> <!-- @impl: src/routes/vault-html.ts::isFilteredVaultMutation --> <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (CF-045: vault-html direct unit tests) -->
2. The preseed configuration page declares a treeview-exclusions block hiding the plug library, the library-manager mirror, the derived graph-output directory, and the four codeflare-authoritative root pages from the navigation tree. <!-- @impl: preseed/silverbullet/CONFIG.md --> <!-- @test: host/__tests__/preseed-config-treeview.test.js (treeview rules hide every entry that should be hidden (REQ-VAULT-015 AC2)) -->
3. The frontend runs a session-vault-cache cleanup on session delete (not on stop), which removes the session's persisted localStorage markers (the IDB-recorder entry, the session marker, and the full-prewarm marker). Per [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) the SilverBullet IndexedDB stores and the vault service worker are bucket-stable (shared across all of a user's sessions) and are therefore NOT deleted/unregistered on per-session delete — doing so would erase the next session's vault and force a full re-index. The boot recorder (populated by a shim that wraps page-context IndexedDB opens and by native-worker IDB-open messages, keyed by the real session id) still records the IDB names for readiness checks. <!-- @impl: web-ui/src/lib/vault-cache.ts::cleanupSessionVaultCache --> <!-- @impl: src/routes/vault-html.ts::injectVaultIdbRecorder --> <!-- @impl: src/routes/vault-html.ts::VAULT_IDB_RECORDER_MARKER --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
4. After an authoritative session-list fetch succeeds, the frontend sweeps persisted localStorage markers and, for any session no longer in the user's active sessions list, drops the corresponding marker entries (covers the case where the session was deleted from another device). Per [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) the sweep does NOT delete the bucket-stable IndexedDB stores or unregister the vault service worker. Dashboard mount alone must not trigger a sweep because the initial store may be empty before the fetch resolves. <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (Session Store) -->

**Constraints:**

- The library-manager mirror is the editor's own runtime-managed clone tree; the user does not curate it directly. The editor's internal config directory is dot-prefixed and hidden by the editor's default behavior; it requires no explicit rule.
- The cleanup/sweep helpers operate exclusively on localStorage markers and never call the browser's databases-listing API or `deleteDatabase`. After the [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) reconciliation they do not touch IndexedDB at all, which makes the historical "live session's IDB nuked on every dashboard mount" regression structurally impossible.

**Priority:** P0

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption), [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** [Route test](../../src/__tests__/routes/vault.test.ts), [cache helper test](../../web-ui/src/__tests__/lib/vault-cache.test.ts), [session store test](../../web-ui/src/__tests__/stores/session.test.ts), [dashboard mount test](../../web-ui/src/__tests__/components/Dashboard.test.tsx)

**Status:** Implemented

---

### REQ-VAULT-016: Vault graph extraction emits the canonical shared schema

<!-- @cites: REQ-VAULT-003 (split-prose: the canonical-schema output contract foreshadowed in REQ-VAULT-003 AC4's extract-merge-advance step lands here) -->

**Intent:** The graph produced by vault extraction is structurally interchangeable with the repo and global graphs, and the re-rendered visualization is published where the vault index page can link to it. This is the output-shape contract; detection and dispatch latency are [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s).

**Applies To:** User

**Acceptance Criteria:**

1. The extracted graph uses the canonical graphify node/edge schema shared with the repo and global graphs: document and code nodes carry `file_type` and a truthy `source_file` so the global merge preserves their identity rather than label-merging them; concept nodes carry `file_type: "concept"` with `source_file: null` so the global merge dedupes them by label; edges carry a canonical `relation` plus `confidence`/`confidence_score`. The vault-extract subagent additionally emits a sub-section node for each markdown heading (level 2 and deeper) linked to its document by a `contains` edge. Both runtimes' vault-extract subagents emit this schema identically - the Pi subagent runs the same canonical chunk -> `merge-vault-graph.py` pipeline as Claude, with no separate in-process baseline; the legacy `type`/`path`/`mentions` shape is never written. <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. After merging, the extraction re-renders the vault viz HTML (`graphify cluster-only .` from the vault root) and copies `graph.html` to `Raw/Graphs/vault-graph.html` so the `Vault Graph.md` index-page link resolves through the SilverBullet `.fs/` route (`graphify-out/` is excluded from R2 bisync and the `.fs/` route). This publish step is non-fatal: a failure leaves a stale viz HTML but never blocks high-water-marker advancement, since the graph data is already persisted. <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->

**Constraints:**

- The canonical-schema output (AC1) is verified by the Pi vault-extract prompt source assertions in `agent-seed-manifest.test.ts` (chunk schema + `merge-vault-graph.py` invocation); the viz publish (AC2) is verified by manual check (the cluster-only render + copy is prompt-driven prose, like [REQ-VAULT-011](#req-vault-011-vault-extract-ingests-pdf-files)), with the Pi prompt's publish step additionally source-asserted in `agent-seed-manifest.test.ts`.

**Priority:** P0

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-VAULT-017: SilverBullet native service worker

<!-- @cites: REQ-VAULT-013 (split-prose: the native-service-worker contract foreshadowed in REQ-VAULT-013's Intent - registration short-circuit, key delivery, precache - is specified here) -->

**Intent:** SilverBullet's native service worker (not a stripped shim) is served for the editor's service-worker registration fetch so the editor keeps its persistent local file-sync store and indexes incrementally (AD69). The Worker short-circuits the auth chain for the registration GET (the browser sends no credentials on that fetch, so the cookie-gated path would 401), serves the SilverBullet 2.9.0 native worker body locked to the Dockerfile-pinned binary, and suppresses the bootstrap-hop redirect for Service-Worker-context fetches so the worker's precache resolves. The per-session encryption key reaches the worker via postMessage from the bootstrap-hop page ([REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC1). The served worker's runtime behavior (log suppression, destructive-sync guard, key-flush neutering) is [REQ-VAULT-025](#req-vault-025-silverbullet-native-service-worker-runtime-graft).

**Applies To:** User

**Acceptance Criteria:**

1. Browser-initiated Service Worker registration GETs for the editor's service-worker script short-circuit the auth chain and receive SilverBullet's native service worker from the Worker (vendored verbatim, AD69). Cold-boot encryption rides the native worker's own `set-encryption-key`/`get-encryption-key` handlers, fed by the bootstrap-hop page ([REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC1). <!-- @impl: src/routes/vault-native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS --> <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (VAULT_NATIVE_SERVICE_WORKER_JS / REQ-VAULT-017 AC1 (native SW served, AD69)) -->
2. The short-circuit selector requires GET method, exact path match for the service-worker script, and the browser-only `Service-Worker` request header (a Fetch-spec forbidden header not settable from page JavaScript); cookie presence is not checked and does not affect the match. <!-- @impl: src/routes/vault-html.ts::isServiceWorkerRegistration --> <!-- @test: src/__tests__/routes/vault.test.ts (isServiceWorkerRegistration / REQ-VAULT-017 (native SW short-circuit selector)) -->
3. The native service-worker script body is identical across sessions (version-locked to the Dockerfile-pinned SilverBullet 2.9.0 binary, guarded by a recorded SHA-256 drift hash); the per-session vault encryption key is delivered to it via postMessage from the bootstrap-hop page ([REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC1), never baked into the script. <!-- @impl: src/routes/vault-native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (CF-045: vault-native-sw direct unit tests) -->
4. The native worker precaches the shell `/` via `cache.addAll` during install, before the bootstrap-hop sets the bootstrap cookie. The shell-path redirect is suppressed for Service-Worker-context fetches (`Sec-Fetch-Mode` present and not `navigate`), so the precache resolves against the real shell instead of a 302. <!-- @impl: src/routes/vault-html.ts::isServiceWorkerContextFetch --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (native SW + shell-302 suppression (REQ-VAULT-017 AC1/AC4/AC5, AD69)) -->
5. Top-level navigations (`Sec-Fetch-Mode: navigate`) and clients with no `Sec-Fetch-Mode` header still receive the bootstrap-hop redirect (fail-safe), so a real first navigation never boots without the encryption key wired. <!-- @impl: src/routes/vault-html.ts::isServiceWorkerContextFetch --> <!-- @test: src/__tests__/routes/vault.test.ts (isServiceWorkerContextFetch / REQ-VAULT-017 AC4/AC5 (SW precache vs navigation)) -->

**Notes:** Documented in [AD69](../../documentation/decisions/README.md) and the [vault lane](../../documentation/lanes/vault.md#service-worker-registration-noop-bypass). Under enterprise Cloudflare Access the host-wide Access app would 302 this credential-less registration fetch to the IdP login before the Worker runs; the setup wizard auto-provisions a higher-precedence bypass app scoped to the SW path so the request reaches this short-circuit ([REQ-ENTERPRISE-006](enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC6).

**Constraints:**

- Browsers omit credentials on service-worker script fetches (Chrome 76+ per spec; Samsung Internet and other Chromium forks may not); the selector is browser-agnostic and matches regardless of cookie presence.

**Priority:** P0

**Dependencies:** [REQ-VAULT-013](#req-vault-013-silverbullet-subpath-adapter), [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts), [Auth-chain test](../../src/__tests__/routes/vault-auth-chain.test.ts), [Direct worker graft test](../../src/__tests__/routes/vault-native-sw-direct.test.ts)

**Status:** Implemented

---

### REQ-VAULT-025: SilverBullet native service worker runtime graft

**Intent:** The served native SilverBullet service worker ([REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker)) runs with codeflare's `graftVaultKeyRecovery` runtime patch applied: it suppresses expected startup-only log noise, guards the sync engine against a not-yet-ready or unreachable in-container SilverBullet server, and neuters the worker's proactive key flush so the encryption key survives idle/backgrounding (AD69). The graft is a deterministic string transform over the vendored bytes; the verbatim upstream body and its SHA-256 drift guard are unchanged.

**Applies To:** User

**Acceptance Criteria:**

1. The served worker suppresses or downgrades expected startup-only log noise (no controlled clients, auth-gated service-proxy reset, and sync retry errors) without changing the message flow to clients or the version-drift guard. <!-- @impl: src/routes/vault-native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-025: served worker drops no-client info spam and downgrades expected auth/sync startup noise) -->
2. The served worker guards against destructive sync: a cycle whose remote list is empty or non-array while the local store or snapshot is non-empty aborts before deleting and retries later. An empty vault or a real list proceed normally. <!-- @impl: src/routes/vault-native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (aborts the sync cycle (no deletion) when the remote list is empty while the local store is populated) -->
3. The graft's transform MUST NOT introduce a duplicate lexical binding into the served worker's declarator list: a duplicate declarator breaks the worker's JavaScript parse, so the browser never registers the SW and the vault never becomes ready. The served worker stays syntactically valid JavaScript. <!-- @impl: src/routes/vault-native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (the served worker is syntactically valid JavaScript (graft introduces no parse error)) -->
4. The served worker neuters the upstream's proactive key flush (wiping the key 5s after the last client disconnects, racing the bootstrap-hop-to-editor transition and bouncing cold opens to `.auth`): the graft retains the key for the worker's lifetime; cold-restart recovery rides `__cfRecover` ([REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC5). <!-- @impl: src/routes/vault-native-sw.ts::graftVaultKeyRecovery --> <!-- @impl: src/routes/vault-native-sw.ts::ANCHOR_PROACTIVE_FLUSH --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (CF-045: vault-native-sw direct unit tests) -->

**Constraints:**

- The grafts (log suppression, sync guard, flush neutering) are string transforms over the served output only; `VAULT_NATIVE_SW_VERBATIM` and its SHA-256 drift guard are unchanged, and a SilverBullet version bump that moves a graft anchor throws rather than silently shipping a regressed worker.

**Priority:** P0

**Dependencies:** [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker)

**Verification:** [Direct worker graft test](../../src/__tests__/routes/vault-native-sw-direct.test.ts)

**Status:** Implemented

---

### REQ-VAULT-018: Vault control gating and on-demand prewarm trigger


**Intent:** The Vault control stays guarded until the server confirms SilverBullet is actually serving, and browser prewarm starts strictly on demand — never automatically — so a user is never dropped onto an unreachable editor or a headless indexing run they didn't ask for. The user's first click on a server-ready control starts the prewarm (the button breathes the codeflare accent and warns that terminal focus may briefly drop); leaving mid-prewarm clears the stale state so a return re-requires a click. The prewarm bridge that reports progress back to the dashboard validates message origin and attempt, and stays inert — emitting ready only once SilverBullet's runtime, service worker, space sync, and object index all agree the vault is actually usable.

**Applies To:** User

**Acceptance Criteria:**

1. The Vault control remains guarded until the per-session vault proxy probe succeeds, stays visible, and exposes click/tap feedback while unavailable. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-018: stays available (no auto-prewarm) until click 1, then breathes preparing -> armed) -->
2. The server probe — `probeVaultReady`, a `GET /api/vault/:sid/status` check that reports ready only when SilverBullet is serving and emits no 502/timeout console noise — retries until first success, is keyed per session, and clears readiness after a later steady-probe failure. <!-- @impl: web-ui/src/lib/vault-readiness.ts::startVaultReadinessProbe --> <!-- @impl: web-ui/src/lib/vault-readiness.ts::probeVaultReady --> <!-- @test: web-ui/src/__tests__/lib/vault-readiness.test.ts (hits the per-session status endpoint with no-store and reports ready only when vaultReady is true) -->
3. Browser prewarm starts ON DEMAND — never automatically — only after the user clicks the server-ready ('available') control; it requests best-effort persistent browser storage on that first click, and timeout/error attempts retry while the control breathes 'preparing'. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/lib/browser-storage-persistence.ts::requestBrowserStoragePersistence --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)) -->
4. Leaving a session during in-flight prewarm clears the stale pending state AND the open-intent, so returning shows the control 'available' again and re-requires a click to restart the prewarm. <!-- @impl: web-ui/src/components/Layout.tsx::clearPrewarmingVaultStatus --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (clears the open-intent and re-requires a click when the user returns after leaving mid-prewarm) -->
5. Prewarm messages are accepted only from the same origin and current attempt, and ready messages must include current-browser local readiness proof plus content readiness proof. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol) -->
6. The bridge is inert without valid prewarm parameters and emits ready only after the SilverBullet runtime is ready, the current browser has recorded `sb_data_*`, recorded `sb_files_*`, and an active per-session service worker, SilverBullet's service worker has completed a full space sync, the current object index version is complete with an empty index queue, and the local `/.fs/` listing contains the codeflare-authoritative vault files — and that full readiness proof has held across `requiredReadyStreak` (2) consecutive poll cycles, where a single not-ready poll resets the streak, so a momentary index-queue-empty mid-sync cannot arm the control prematurely. <!-- @impl: src/routes/vault-html.ts::injectVaultPrewarmBridge --> <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (CF-045: vault-html direct unit tests) -->

**Constraints:**

- Raw session captures and other folders remain visible during prewarm; priority indexing is out of scope.
- The generic shell bridge stays inert unless the prewarm query and identifier are valid.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-VAULT-012](#req-vault-012-vault-button-render-and-dashboard-landing)

**Verification:** [Header wiring test](../../web-ui/src/__tests__/components/Header.test.tsx), [Automated test](../../web-ui/src/__tests__/lib/vault-readiness.test.ts), [prewarm protocol test](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts), [browser storage persistence test](../../web-ui/src/__tests__/lib/browser-storage-persistence.test.ts), [local readiness test](../../web-ui/src/__tests__/lib/vault-local-readiness.test.ts), [layout wiring test](../../web-ui/src/__tests__/components/Layout.test.tsx), [vault shell helper test](../../src/__tests__/routes/vault-html-direct.test.ts)

**Status:** Implemented

---

### REQ-VAULT-022: Vault armed-state open flow and persistence


**Intent:** Once the Vault is proven ready, opening and re-opening it must be instant and must never re-litigate that proof. A green ('armed') control opens the editor directly with no per-open re-verification; a full prewarm proof persists a per-browser marker so a later page load skips the bootstrap iframe entirely and arms the control without a click; the control surfaces the 2-click on-demand flow as a breathing affordance so the user always knows what state it's in; and a one-time controlled reload self-heals an already-warmed vault that boots before its service worker takes control. Once armed, the control stays green for the rest of the session.

**Applies To:** User

**Acceptance Criteria:**

1. A green ('armed') control opens the vault directly via the bootstrap-hop, synchronously inside the click gesture, with no per-open re-verification of local readiness or key recoverability. <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-022 AC1: a green click opens directly even when local readiness reports not-ready (no re-index)) -->
2. A full prewarm proof records a persistent per-browser marker; on a later load, if the marker is set and live local readiness still holds, the bootstrap iframe is skipped and the control arms (green) directly with no click. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/lib/vault-local-readiness.ts::markVaultFullyPrewarmed --> <!-- @impl: web-ui/src/lib/vault-local-readiness.ts::hasVaultFullyPrewarmed --> <!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 (session expiry handling on 401)) -->
3. If the readiness probe does not settle or the marker is absent, the reload-skip is ineligible and the control stays 'available' for an on-demand click rather than auto-mounting onto an unbuilt index. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-022 AC3: a reload with local DBs/SW but no full prewarm proof stays available until click) -->
4. The control breathes through the on-demand flow: 'available' before prewarm; the first click breathes accent-colour with a focus-loss warning; completion breathes green with a confirmation auto-hiding after 5s; the second click opens instantly. Reduced-motion keeps the colours without the animation. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Layout Component / REQ-AUTH-014 (session expiry handling on 401)) -->
5. On a top-level vault open, when a vault SW is active but `serviceWorker.controller` is null on first paint, the page reloads once via a loop-safe `sessionStorage` one-shot; inert in the prewarm iframe, on first boot, for non-vault scopes, without SW support, or a prewarm id. <!-- @impl: src/routes/vault-html.ts::installVaultControlledReload --> <!-- @impl: src/routes/vault-html.ts::injectVaultControlledReload --> <!-- @impl: src/routes/vault-html.ts::rewriteVaultHtmlResponse --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (injectVaultControlledReload (REQ-VAULT-018 open-path safety net)) -->
6. Once armed, the control stays green for the rest of the session, gated solely on the prewarm readiness proof (`pw === 'ready'`, [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC6) rather than an open/settle latch, identically on mobile, tablet, and desktop, including under a sticky touch-device `:hover`. <!-- @impl: web-ui/src/components/Layout.tsx::vaultButtonStatus --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-022 AC6: stays green (armed) after the open click and on subsequent opens — ready means green, always) -->
7. The ready tooltip auto-surfaces only on the genuine preparing->armed transition, never on a fresh already-armed mount, so a warm reload or return from the vault tab does not re-pop it. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/VaultButton.test.tsx (a fresh already-armed mount (warm reload / return from the vault tab) does NOT re-pop the ready tooltip) -->

**Constraints:**

- The AC1 direct-open skip and AC2 reload-skip marker are keyed by session id, not bucket, so a returning session whose routing cookie was cleared does not auto-arm and needs one click; durable fix deferred ([AD84](../../documentation/decisions/README.md#ad84-retain-the-vault-sw-encryption-key-in-memory-neuter-the-proactive-flush-and-open-a-green-vault-button-directly)).

**Priority:** P0

**Dependencies:** [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger), [REQ-VAULT-019](#req-vault-019-vault-key-recoverable-open-gate), [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption)

**Verification:** [layout wiring test](../../web-ui/src/__tests__/components/Layout.test.tsx), [vault button states test](../../web-ui/src/__tests__/components/VaultButton.test.tsx), [cache helper test](../../web-ui/src/__tests__/lib/vault-cache.test.ts), [vault shell helper test](../../src/__tests__/routes/vault-html-direct.test.ts)

**Status:** Implemented

---

### REQ-VAULT-019: Vault key-recoverable open gate

**Intent:** The Vault button greens only when the encryption key can serve the editor — verified at the cold-path arming poll, before the control turns green — so a green button then opens directly without re-verifying on the click.

**Applies To:** User

**Acceptance Criteria:**

1. The encryption key's recoverability is verified at the cold-path arming poll (before the control greens), via the auth-gated `/.vault-key` endpoint; a green control therefore opens without re-verifying the key on the click. <!-- @impl: web-ui/src/lib/vault-local-readiness.ts::checkVaultKeyRecoverable --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-022 AC1: a reload-armed (green) click opens directly — no readiness/key re-verify) -->
2. If the key is not recoverable, the control enters a non-openable preparing state. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)) -->
3. When the prewarm proof and key recoverability both hold, the cold-path arming poll marks the control armed (green) and the next click opens it synchronously inside the click gesture. <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)) -->
4. Open intent clears when the tab opens or the session stops being the active running session. <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-019 AC4 (vault open-intent clearing)) -->

**Constraints:**

- The key check runs after browser prewarm.

**Priority:** P0

**Dependencies:** [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger)

**Verification:** [Layout wiring test](../../web-ui/src/__tests__/components/Layout.test.tsx), [key recoverability test](../../web-ui/src/__tests__/lib/vault-local-readiness.test.ts), [vault button states test](../../web-ui/src/__tests__/components/VaultButton.test.tsx)

**Status:** Implemented

---

### REQ-VAULT-020: Vault prewarm focus safety

**Intent:** On-demand Vault prewarm must not steal focus from the terminal or dismiss the mobile keyboard.

**Applies To:** User

**Acceptance Criteria:**

1. The on-demand prewarm started by the user's click does not steal focus from the terminal or dismiss the mobile keyboard, even when terminal input is focused or the keyboard is open. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-020: click 1 starts the prewarm even when terminal input is focused) -->
2. The prewarm shell installs a valid-token-only focus/select/window-focus guard before SilverBullet app scripts run. <!-- @impl: src/routes/vault-html.ts::injectVaultPrewarmFocusGuard --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (makes the prewarm shell unable to take script focus while SilverBullet boots) -->
3. The parent hidden iframe returns focus to the previously focused terminal/input whenever the iframe holds parent focus, including a same-origin steal that produces no window `blur` or document `focusin` event. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol) -->
4. The focus reclaim stops once prewarm tears down. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (stops focusout + poll focus reclaim after teardown) -->
5. When detaching the prewarm iframe orphans the top-level document, window focus and the terminal input are re-asserted after the iframe is removed; the reassert is inert when the window kept focus. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (re-asserts window focus and re-focuses the terminal AFTER detaching when removal orphaned the document (REQ-VAULT-020 AC5)) -->

**Constraints:**

- The focus guard stays inert unless the prewarm query and identifier are valid.
- Removing the prewarm iframe orphans the top-level document (`document.hasFocus()` false) even when the terminal already holds the active element, killing terminal input until a reload; the orphan is caused by the removal so it can only be repaired afterward — by re-asserting `window.focus()` and re-focusing the live terminal target (else `.xterm-helper-textarea`), gated on the window actually lacking focus.

**Priority:** P0

**Dependencies:** [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger), [REQ-MOB-014](mobile.md#req-mob-014-mobile-background-surface-focus-isolation)

**Verification:** [Layout wiring test](../../web-ui/src/__tests__/components/Layout.test.tsx), [prewarm protocol test](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts), [vault shell helper test](../../src/__tests__/routes/vault-html-direct.test.ts)

**Status:** Implemented

### REQ-VAULT-021: Bucket-stable vault URL and bucket-derived key

**Intent:** SilverBullet is served under a bucket-stable URL and its local cache is encrypted with a bucket-derived key, so the client `sb_data_*` (index) and SW `sb_files_*` DB names are identical across sessions for one user — the mechanism that makes cross-session vault persistence possible in the first place.

**Applies To:** User

**Acceptance Criteria:**

1. The SilverBullet app is served under a bucket-stable URL `/api/vault/<token>/`, where the token is a deterministic, opaque hash of the user's R2 bucket name (no session id, no PII), so the served `location.href` — and thus the SB IndexedDB names — are identical across sessions. <!-- @impl: src/lib/vault-bucket-token.ts::getVaultBucketToken --> <!-- @test: src/__tests__/lib/vault-bucket-token.test.ts (getVaultBucketToken (REQ-VAULT-021)) -->
2. The session-keyed path `/api/vault/<sid>/` is an entry that sets a routing cookie and 302-redirects to the bucket-stable URL; the session id for bucket-stable requests is read from that cookie, never the URL. <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (the session-keyed entry path sets cf_vault_sid and 302s to the bucket-stable URL) -->
3. Route dispatch distinguishes the 32-hex bucket token from an 8-24-char session id unambiguously (length-disjoint patterns). <!-- @impl: src/routes/vault-validation.ts::validateVaultRoute --> <!-- @test: src/__tests__/routes/vault-bucket-routing.test.ts (parses a 32-hex first segment as the bucket token serving path) -->
4. A bucket-stable request whose token is not the authenticated user's bucket is rejected (403 VAULT_BUCKET_MISMATCH); one with no routing cookie is rejected (409 VAULT_NO_SESSION). <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (rejects a bucket-stable request whose token is not the authed bucket (403)) -->
5. The vault encryption key is derived deterministically per bucket via HKDF-SHA256 over the server master secret (`ENCRYPTION_KEY`) and the bucket name, so it recurs across sessions and the persisted encrypted local cache decrypts. <!-- @impl: src/routes/vault-crypto.ts::getVaultEncryptionKey --> <!-- @test: src/__tests__/routes/vault-crypto.test.ts (getVaultEncryptionKey (REQ-VAULT-021 bucket-derived key)) -->
6. The shell's injected boot script carries the real session id, keying the IDB-recorder and prewarm bridge's `vault-session-<sid>-*` localStorage markers to the value the dashboard reads, while base-href and the CSRF cookie use the bucket token. <!-- @impl: src/routes/vault.ts::handleVaultRequest --> <!-- @impl: src/routes/vault-html.ts::rewriteVaultHtmlResponse --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
7. Because the SilverBullet service worker registers under the bucket-stable `/api/vault/<token>/` scope, which the dashboard cannot name by session id, the in-shell prewarm bridge and the dashboard readiness check match any `/api/vault/` registration (exactly one per user). <!-- @impl: web-ui/src/lib/vault-local-readiness.ts::checkVaultLocalReadiness --> <!-- @test: web-ui/src/__tests__/lib/vault-local-readiness.test.ts (finds the vault service worker even when its scope segment is the bucket token, not the session id) -->

**Constraints:**

- The bucket-derived key protects only the browser-local IndexedDB cache (SilverBullet's "primary" space); the "secondary" store (container FS → R2) is not encrypted with it and is unaffected at rest.
- The bucket-stable key relaxes per-session forward secrecy of the local cache (a later session can decrypt a prior session's leftover cache) — accepted tradeoff, supersedes [AD83](../../documentation/decisions/README.md#ad83-vault-indexeddb-cannot-be-persisted-across-sessions-by-keying-the-encryption-key-to-the-r2-bucket).
- The bucket token carries no PII: it is a hash of the bucket name, never the bucket name or email itself.
- The serving URL and routing cookie are identical for every session of one user, so a second session in another tab overwrites the cookie and takes over serving (same bucket, no cross-tenant leak).

**Priority:** P1

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption), [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker), [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger)

**Verification:** [bucket token test](../../src/__tests__/lib/vault-bucket-token.test.ts), [bucket-derived key test](../../src/__tests__/routes/vault-crypto.test.ts), [route dispatch test](../../src/__tests__/routes/vault-bucket-routing.test.ts), [auth-chain serving test](../../src/__tests__/routes/vault-auth-chain.test.ts), [HTML-rewrite split test](../../src/__tests__/routes/vault.test.ts), [readiness SW-scope test](../../web-ui/src/__tests__/lib/vault-local-readiness.test.ts)

**Status:** Implemented

---

### REQ-VAULT-023: Bucket-stable vault store persistence and content bootstrap

**Intent:** Once the vault's IndexedDB stores and service worker are bucket-stable, they must actually behave like durable per-user resources rather than per-session scratch: session cleanup and the orphan sweep must never delete them, and the sync engine must not mistake a still-warming in-container SilverBullet server for an empty vault and wipe the local store. The vault initializer also keeps the codeflare-authoritative config pages' metadata stable across boots and seeds the landing pages a fresh or upgrading vault needs, so the persisted store never gets stuck fighting a spurious "changed on secondary" conflict.

**Applies To:** User

**Acceptance Criteria:**

1. The bucket-stable IndexedDB stores and service worker are durable per-user resources: per-session DELETE and the authoritative orphan sweep remove only the localStorage markers and never delete the IndexedDB stores or unregister the service worker, so the persisted vault survives across session lifecycle events. <!-- @impl: web-ui/src/lib/vault-cache.ts::cleanupSessionVaultCache --> <!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches --> <!-- @test: web-ui/src/__tests__/lib/vault-cache.test.ts (cleanupSessionVaultCache (REQ-VAULT-015 AC3 / REQ-VAULT-023)) -->
2. The bucket-stable local store is never blind-deleted while SilverBullet is warming up or transiently unreachable: a sync cycle observing an empty or unreadable remote list while the local store is non-empty aborts before deleting and defers to a later cycle (guard in [REQ-VAULT-025](#req-vault-025-silverbullet-native-service-worker-runtime-graft) AC2). <!-- @impl: src/routes/vault-native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (CF-045: vault-native-sw direct unit tests) -->
3. On every boot the vault initializer stamps CONFIG, README, and STYLES with the preseed source's mtime (`touch -r`) — even when a content-equality skip leaves bytes untouched — so SilverBullet reports an identical `lastModified` across sessions; `Index.md` is exempt (create-if-missing, AC5). <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (stamps codeflare-authoritative config pages with the deterministic preseed mtime even when cmp-skip leaves content untouched) -->
4. The vault initializer seeds `Notes.md` and `References.md` landing pages create-if-missing so the dashboard's bare `[[Notes]]` / `[[References]]` wikilinks resolve to real pages instead of 404ing as broken/aspiring pages; the seed never overwrites a user edit. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
5. The vault initializer seeds `Index.md` create-if-missing rather than force-overwriting it, so the editor's normalized re-serialization persists via R2 to a stable no-conflict fixed point; the seed never overwrites an existing `Index.md` that differs from preseed. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (seeds Index.md create-if-missing but NEVER force-overwrites an existing differing Index.md (prevents the 2nd-start sync conflict)) -->

**Constraints:**

- The deterministic preseed-mtime stamp (AC3) only equalizes the SECONDARY-side mtime for CONFIG/README/STYLES; it cannot fix a PRIMARY-side (client save) conflict, which is why `Index.md` moved to create-if-missing (AC5) instead of being covered by the stamp.

**Priority:** P1

**Dependencies:** [REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key), [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters), [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker), [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger)

**Verification:** [cache reconciliation test](../../web-ui/src/__tests__/lib/vault-cache.test.ts), [not-ready sync guard test](../../src/__tests__/routes/vault-native-sw-direct.test.ts), [boot mtime + landing-page test](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-VAULT-024: Vault bootstrap-hop key arming and service-worker retention

**Intent:** The vault key minted by [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption) still has to reach the browser and stay usable there with no passphrase prompt: a one-time bootstrap-hop page arms the service worker with the key, the worker holds onto that key for its natural lifetime instead of the upstream proactive flush, and a genuinely lost key is recovered rather than bouncing the user to `.auth`. The Vault open click always routes through the hop so the key is armed before the editor boots.

**Applies To:** User

**Acceptance Criteria:**

1. The Worker delivers the key through a one-time, GET-only bootstrap-hop page (other methods fall through) that registers the native service worker, posts the key to its `set-encryption-key` handler, persists an enable-encryption flag, and sets a bootstrap-completed cookie before redirecting to the shell. <!-- @impl: src/routes/vault-html.ts::injectVaultBootstrapHopHtml --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
2. On failure, the bootstrap-hop page shows an error and aborts without setting the bootstrap-completed cookie or persisting the enable-encryption flag. <!-- @impl: src/routes/vault-html.ts::injectVaultBootstrapHopHtml --> <!-- @impl: src/routes/vault-html.ts::VAULT_SW_ACTIVATION_TIMEOUT_MS --> <!-- @test: src/__tests__/routes/vault.test.ts (injectVaultBootstrapHopHtml (REQ-VAULT-024 AC1/AC2)) -->
3. Subsequent shell-path requests bypass the bootstrap hop via the cookie, and no passphrase prompt is shown to the user. <!-- @impl: src/routes/vault-html.ts::VAULT_BOOTSTRAP_COOKIE --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
4. The service worker retains its in-memory encryption key for its natural lifetime; the codeflare graft neuters the upstream proactive flush that wiped the key 5s after the last client disconnected. The key stays re-derivable from `.vault-key`, so retention is not a meaningful forward-secrecy regression. <!-- @impl: src/routes/vault-native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (the flush-neuter is load-bearing: the verbatim (pre-graft) worker DOES wipe the key on no clients) -->
5. The service worker recovers its key from the Worker only when genuinely gone (idle-terminated): the graft injects a `__cfRecover()` helper that re-fetches the key from the auth-gated `.vault-key` endpoint at both of the worker's key-empty failure points. <!-- @impl: src/routes/vault-native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
6. The Vault open click navigates the new tab to the bootstrap-hop URL (`/api/vault/<sid>/.codeflare-bootstrap`) rather than the bare shell, so the first open arms the per-session key via the hop's `set-encryption-key` post and SW-activation wait before redirecting to the editor. <!-- @impl: web-ui/src/components/Layout.tsx::openVaultTab --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-024 AC6: the open click navigates the new tab to the bootstrap-hop URL, not the bare shell) -->

**Notes:** Encryption rides SilverBullet's native service worker with the codeflare `graftVaultKeyRecovery` patch (`.vault-key` recovery plus proactive-flush neutering); see [AD69](../../documentation/decisions/README.md#ad69-silverbullet-vault-runs-its-native-service-worker-for-persistent-encrypted-client-indexing) for the native-worker adoption and integration verification, and [AD84](../../documentation/decisions/README.md#ad84-retain-the-vault-sw-encryption-key-in-memory-neuter-the-proactive-flush-and-open-a-green-vault-button-directly) for the later flush-neutering fix. The SB store now persists across sessions via a bucket-stable vault URL and bucket-derived key ([REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)), which supersedes [AD83](../../documentation/decisions/README.md#ad83-vault-indexeddb-cannot-be-persisted-across-sessions-by-keying-the-encryption-key-to-the-r2-bucket).

**Constraints:**

- The per-session identifier must be resolvable for every proxied request, carried via a routing cookie on the bucket-stable path or the URL on the session-keyed path ([REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)).
- The bootstrap-hop page guards against a missing `navigator.serviceWorker`, bounds SW activation with a 10-second timeout (`VAULT_SW_ACTIVATION_TIMEOUT_MS`, not the indefinite `navigator.serviceWorker.ready`), and treats the "redundant" SW lifecycle state as an explicit error.

**Priority:** P0

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption) (vault key generation and lifecycle), [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor), [REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) (bucket-stable URL and session routing)

**Verification:** [Bootstrap-hop test](../../src/__tests__/routes/vault.test.ts), [Service-worker retention test](../../src/__tests__/routes/vault-native-sw-direct.test.ts), [Open-flow test](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-VAULT-026: Vault-extract change detection survives container restart (content-hash manifest)


**Intent:** A returning session does not re-extract the whole vault. Change detection compares file content (sha256), not mtimes, so the R2 restore that rewrites every vault file's mtime to download-time cannot trigger a full re-extraction (previously ~200k tokens / ~20 min per session).

**Applies To:** System

**Acceptance Criteria:**

1. Change detection reports a vault file changed exactly when its sha256 differs from, or is absent in, the persisted manifest; a file's mtime is never consulted, so rewriting every file with identical bytes (what an R2 restore does) yields zero changes. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::_excluded --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (THE ORACLE: an R2-style restore (rewrite every file, fresh mtime, identical bytes) yields ZERO changes) -->
2. The manifest persists at `graphify-out/vault-extract-manifest.json`, allow-listed through the graphify-out bisync exclusion, so it round-trips to R2 and survives container restart — the property that makes "changed since last extraction" true across boots. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (advanced mode: includes the vault tree AND its vault-graph.json despite the global graphify-out exclude (REQ-MEM-004 AC1 / REQ-VAULT-001 AC1)) -->
3. The manifest is baselined from current content only when no manifest exists yet (the first session for a vault). <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) --> <!-- coverage-gap: first-boot baseline is shell/extension boot-behavior; the mtime-immunity it enables is covered by AC1's oracle -->
4. On every later boot the manifest is restored from R2 and never re-baselined, so a prior session's file that was edited but not yet extracted is still detected. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: src/__tests__/lib/vault-exclusion.test.ts (treats an unextracted file from a prior session as changed (no data loss)) -->
5. Claude (entrypoint daemon + vault-extract contract) and Pi (memory-vault extension) share one manifest format and one exclusion set, so a session that switches runtime reads the same high-water mark. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::_rel --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-VAULT-003 / REQ-VAULT-026: Pi vault indexing shares Claude content-hash detection + exclusions) -->

**Constraints:**

- The manifest's own mtime is irrelevant — only its JSON contents are read — so the R2 restore resetting the manifest file's mtime (like every other file's) is harmless.
- `vault-extract.last` remains as an ephemeral within-session dedup timestamp for the hook's vars-staleness guard only; it is no longer the change-detection source of truth.
- The manifest is stdlib-computed (sha256 of bytes) so the 60s daemon spawn stays cheap; no graphify/networkx dependency.

**Priority:** P0

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s) (edit detection loop), [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions) (vault + graphify-out ride the R2 sync)

**Verification:** [Content-hash oracle](../../src/__tests__/lib/vault-manifest-detection.test.ts), [rclone persistence test](../../host/__tests__/entrypoint-rclone-filters.test.js)

**Status:** Implemented
