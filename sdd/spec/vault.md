# Vault

Persistent Obsidian-style note vault: agent-written session captures plus user-curated prose, indexed into the unified graphify graph for cross-session memory queries.

File ownership, synchronization artifacts and editor bootstrap mechanisms are documented in the [Vault implementation owner](../../documentation/lanes/vault.md).

**Domain owner:** entrypoint.sh, codeflare-vault plugin, graphify, SilverBullet, Worker `/api/vault` route

### Key Concepts

- **Vault** -- The persistent per-user vault directory holding markdown notes, pasted assets, and derived graph output. Attachment uploads land next to the note that referenced them; the dedicated raw-pasted directory is reserved for user-owned drag-drop. The vault is bisynced to R2 so it survives across sessions and is always present in the unified global graph (tagged as the user-vault source; never pruned by the active-repo prune-on-switch logic).
- **Capture Agent** -- The background worker that writes one markdown file and graph chunk per batch into the vault; the launcher owns locked merging, global publication and success-only cleanup. Claude is pinned to Sonnet per AD58; Pi uses the optional provider-neutral model lever with medium reasoning and bounded one-pass input per AD103. The image-owned compactor alone may fold cold captures into `Raw/Sessions/Archive.md`.
- **Vault-monitor Daemon** -- A polling loop in the entrypoint that watches for user-curated edits anywhere under the vault except the agent-written capture directory, the derived graph-output directory, the editor's internal config directory, and the four codeflare-authoritative root pages. When changes are found, writes a trigger marker. Detects changes by comparing each file's content hash against a durable manifest (REQ-VAULT-026), not its mtime, so the R2 restore's mtime reset cannot misfire a full re-extraction.
- **Vault-extract Agent** -- The background worker that reads only detected changed files and merges their subgraph into the unified graph. Claude is pinned to Sonnet and commits its manifest; Pi uses medium reasoning/seven turns and the root promotes staged manifest bytes only after a post-commit request chunk.
- **Unified Global Graph** -- The merged graph that combines `user_vault` with the current active repository's graph when present; merges are hash-keyed and serialized under a shared multi-writer lock. The graphify MCP wrapper prefers this graph when present so structural queries return a unified view across all sources.
- **SilverBullet** -- The markdown editor running inside the container, bound to localhost only and reachable from the codeflare UI through the Worker proxy. The auth boundary lives at the Worker.

### Out of Scope

- Custom MCP server for the vault (graphify's existing tools cover read access)
- Multi-graph state inside `graphify.serve` (one MCP wrapper, one global graph)
- Per-tool `graph_path` argument on `mcp__graphify__*` (a single unified graph removes the need)
- FTS5 full-text search (graphify's external-label dedup already collapses concepts; queries route through the graph)
- Backlink parser, SessionStart vault hook, inotify watcher (the existing 60s content-hash poll is sufficient)
- Two-bucket model for vault vs. workspace (vault sits inside the existing R2 bucket, with explicit filter includes)
- Desktop Obsidian or web-VNC clients (SilverBullet covers the editing surface)
- Standalone vault-only container (vault lives inside the session container)
- Migration of legacy `~/.memory/session-*.jsonl` into the vault (MCP server-memory subsystem is removed; no historical graph is preserved)
- Per-session sync-concurrency tuning for SilverBullet. The default is hardcoded in the editor's sync engine and is not configurable through its boot config. The cold-start latency delta between the default and a tuned value is small at typical vault sizes and not worth maintaining a fork.
- Priority/lazy object indexing for visible SilverBullet folders. Stock SilverBullet queues every visible `/.fs` entry into the browser object index, so keeping folders visible while indexing only `Notes/` and `References/` first would require a maintained client patch and is deferred until full-index prewarm proves insufficient.
- Lazy attachment loading for the raw-pasted directory. The editor pastes attachments alongside the note they were dropped into, not under a centralized raw-pasted tree, so the lazy-prefix optimization has no real workload to apply to.

### Domain Dependencies

- **Memory** -- Reuses the memory-capture UserPromptSubmit hook and its per-user counter state. The capture agent writes its synthesis output into the vault (the legacy MCP server-memory subsystem has been removed); the dedup-gate marker contract is unchanged.
- **Storage** -- Vault persistence is provided by the existing bisync to R2. The vault tree is included in the shared sync filter set, ordered before the global `graphify-out` exclude so first-match semantics keep vault content synced.
- **Session Lifecycle** -- The shutdown-bisync reliability work ([REQ-VAULT-006](#req-vault-006-shutdown-bisync-completes-vault-writes-before-sigkill)) coordinates the orchestrator destroy budget with the final-sync watchdog so vault edits made in the last seconds before shutdown reach R2 instead of being silently lost.
- **Subscription** -- Vault features (preseed entries, editor supervisor) are gated to Pro session mode via the manifest's mode filter.

---

### REQ-VAULT-001: Persistent vault directory survives across sessions

**Intent:** A user opens a new session and finds their previous notes, captures, and pasted assets intact -- the same way the rest of the user home directory survives. This REQ covers the directory skeleton, rclone filter coverage, and storage-panel surfacing of the special folders; codeflare-authoritative file preseeding is in [REQ-VAULT-010](#req-vault-010-codeflare-authoritative-files-preseeded-into-the-vault-on-every-boot).

**Applies To:** User

**Acceptance Criteria:**

1. Vault sync preserves the eligible tree, including the cumulative graph, extraction manifest and durable `vault-extract-initialized` record, but excludes regenerable graph-data and visualization intermediates. The initialization record preserves the first-initialization boundary required by [REQ-VAULT-026](#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest). <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-VAULT-026 AC2: durable extraction manifest bytes survive local baseline and ordinary bisync restore) --> <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (advanced mode: includes the vault tree AND its vault-graph.json despite the global graphify-out exclude (REQ-MEM-004 AC1 / REQ-VAULT-001 AC1)) -->
2. The ephemeral global-graph workspace directory is excluded from sync so the merged graph is regenerated on boot from per-source graph artifacts rather than carrying stale state across sessions. <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-001 AC2: boot reconstructs the merged graph from restored source artifacts, excluding stale merged input) --> <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (entrypoint.sh rclone filter behavior (real) / REQ-MEM-004 (vault in R2 sync) / REQ-MEM-006 (advanced-only) / REQ-VAULT-001 (vault filter order) / REQ-STOR-004 (static excludes)) -->
3. The vault initializer creates raw-sessions, raw-pasted, notes, references, graphify-out, and SilverBullet config subdirectories on every boot. <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-001 AC3: creates missing Raw/Pasted on first initialization and restores it on reinitialization) --> <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
4. Vault initialization follows the sync baseline and precedes the periodic sync service, without overwriting restored content with the empty skeleton. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
5. The vault initializer creates Uploads and Temporary alongside the vault. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-001 AC5: initializer creates missing Uploads and Temporary and preserves user content on re-run) -->
6. The storage panel surfaces Workspace, Vault, Uploads, and Temporary as special folders with path-and-purpose tooltips. <!-- @test: web-ui/src/__tests__/components/StorageBrowser.test.tsx (REQ-VAULT-001 AC6: $folder tooltip renders its container path and purpose) --> <!-- @impl: web-ui/src/lib/special-folders.ts::SPECIAL_FOLDERS --> <!-- @test: web-ui/src/__tests__/lib/special-folders.test.ts (SPECIAL_FOLDERS registry / REQ-VAULT-001 AC6 (R2 panel surfaces special folders)) -->

**Constraints:**

- The vault shares the user's existing R2 bucket; there is no separate vault bucket.
- Vault content is per-user (each user has their own R2 bucket).
- Uploads and Temporary sync eligibility follows [REQ-STOR-011](storage.md#req-stor-011-sync-mode-controls-workspace-scope) AC4; Storage visibility follows AC6.
- The vault directory must live at a non-hidden basename,.

**Priority:** P0

**Dependencies:** [REQ-STOR-002](storage.md#req-stor-002-file-persistence-across-sessions), [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start)

**Verification:** Automated: [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js), [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js), [special-folders.test.ts](../../web-ui/src/__tests__/lib/special-folders.test.ts), [StorageBrowser.test.tsx](../../web-ui/src/__tests__/components/StorageBrowser.test.tsx)

**Status:** Implemented

---

### REQ-VAULT-002: Conversation captures land in the vault as markdown

**Intent:** The capture agent writes one markdown file per 20-prompt batch, plus an immediate uncaptured-tail capture on session resume, into the session capture directory; each capture becomes graph-queryable in the same turn.

**Applies To:** User

**Acceptance Criteria:**

1. The capture agent writes one markdown file per batch into the vault's raw-sessions subdirectory using a dated filename and the YAML-frontmatter + Context/Decisions/Observations/References template. <!-- @manual -->
2. Concept references use wikilink syntax; file paths, code symbols, and PR/issue references stay as prose. <!-- @manual -->
3. The capture worker emits chunk JSON matching the graph builder's schema inline; graph materialization and publication belong to the launcher publisher, without another inference call. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/build-memory-graph.py::build_graph --> <!-- @manual -->
4. After worker exit, under the shared multi-writer lock, the launcher merges into cumulative Vault and publishes `user_vault` to the unified global graph. Only successful publication advances capture state and removes the request carrier; failure retains delivery state for owner-lifecycle retry. <!-- @manual -->
5. If extraction fails, the markdown file stays on disk for bounded memory-delivery recovery. <!-- @manual -->
6. The historical MCP memory subsystem has been removed entirely; the capture agent does not invoke it, and no legacy JSONL graph is read. <!-- @manual -->

**Notes:** Codeflare ships no LLM provider key for the CLI and the capture agent already IS the LLM, so re-invoking the CLI would duplicate inference cost with no benefit; the capture pipeline is documented in [Vault](../../documentation/lanes/vault.md#capture-path-req-vault-002).

**Constraints:**

- The launcher owns the request carrier and dedup lifecycle; workers neither delete the trigger at startup nor advance capture state.
- Publication failure retains the carrier for bounded delivery recovery; [REQ-VAULT-032](#req-vault-032-session-archive-ownership-and-extraction-boundary) AC3 excludes session captures from unrelated Vault extraction.
- After successful natural sync, the image-owned compactor runs deterministic cold-capture compaction daily in UTC; mark the day complete only after success or no cold sources.
- Prepare the archive, relocate and publish graph provenance under the shared lock, delete only verified unchanged manifest sources, then bisync.
- Agents cannot edit the archive or delete captures; [REQ-MEM-023](memory.md#req-mem-023-cold-session-captures-compact-without-losing-memory) owns machine-only archives and sync.
- The headless extraction CLI is bypassed, with no extra inference, per [REQ-MEM-001](memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC6.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Manual: [REQ-VAULT-002 procedure](../../documentation/lanes/vault.md#req-vault-002-manual-qualification)

**Status:** Implemented

---

### REQ-VAULT-003: User-curated edits use bounded prompt-cadenced ingestion

**Intent:** User-created Vault content is eventually ingested without a polling extractor repeatedly launching across synchronized sessions.

**Applies To:** User

**Acceptance Criteria:**

1. Generated, vendored, internal, captured, and preseed-managed content is excluded from Vault change detection. Both runtimes also prune the root `Memory/` tree before hashing, leaving its files intact and similarly named paths elsewhere eligible. <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (REQ-VAULT-003 AC1: Pi and Claude prune root Memory without hiding nearby notes) --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::_excluded --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::VAULT_GENERATED_PREFIXES --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::VAULT_PRESEED_ROOT_FILES --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (REQ-VAULT-032 AC3: excludes individual captures and Archive.md from semantic extraction) --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (excludes the four codeflare-authoritative root pages from the manifest) --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (REQ-VAULT-026 AC5: Claude and Pi commit equivalent manifest content) -->
2. Change detection compares each vault file's content hash against a durable manifest (REQ-VAULT-026), not a file mtime, so a container restart that resets every file's mtime does not misreport the vault as changed. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::collect --> <!-- @impl: preseed/agents/pi/extensions/vault-manifest-fs.ts::collectVaultFileHashes --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (THE ORACLE: an R2-style restore (rewrite every file, fresh mtime, identical bytes) yields ZERO changes) -->
3. Claude immediately skips dispatch when no extraction is pending or when an existing extraction has been in flight for less than 30 minutes. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh::PROMPT_FILE --> <!-- @test: host/__tests__/vault-monitor-hook-behavior.test.js (vault-monitor-hook.sh behavior (real) / REQ-VAULT-003 AC3 (hook fast-exit + 30-min in-flight sentinel TTL)) -->
4. Claude consumes the pending request before extracting each changed file, merges and publishes the cumulative graph, commits the content-hash manifest before refreshing dedup state, and clears the in-flight guard last. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::LAST_MARKER --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::cmd_commit --> <!-- @manual: Follow the Claude extraction failure-preservation method in the Vault lane. -->
5. If any extract-merge-advance step fails, the committed manifest remains unchanged. Failed listing or file extraction, including all-files-failed, is not empty success; a successful empty scan is cleanup-only. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::EXTRACT_FAILED --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::cmd_commit --> <!-- @manual: Follow the Claude extraction failure-preservation method in the Vault lane. -->
6. Claude and Pi skip file and directory symlinks in Vault change detection, including contained, outside and dangling links. No outside target is attributed through a link. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::collect --> <!-- @impl: preseed/agents/pi/extensions/vault-manifest-fs.ts::collectVaultFileHashes --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (REQ-VAULT-026 AC5: Claude and Pi commit equivalent manifest content) -->
7. Pi vault extraction is inert in child sessions, so background monitor transcripts never receive extraction follow-ups. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::isChildSession --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (keeps all handlers inert in child sessions) -->

**Constraints:**

- Claude and Pi use the same exclusion list; boot copies of Codeflare-authoritative root pages never count as user edits.
- A 30-minute in-flight sentinel prevents repeated Claude dispatch during extraction; prompt cadence, not a polling daemon, creates trigger markers.
- The hook creates the sentinel on emission; the agent removes it as its final step.
- Claude: the vault-extract subagent is pinned to sonnet at the definition level per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad), with reasoning effort pinned at medium.
- Pi: the provider-neutral model lever is optional; [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs) fixes reasoning effort at medium.
- PDF-specific ingestion behavior is specified in [REQ-VAULT-011](#req-vault-011-vault-extract-handles-pdfs-by-runtime-capability).
- AC3–AC5 describe the Claude hook/agent delivery path; Pi's root-owned transactional delivery and high-water promotion are specified separately in [REQ-VAULT-027](#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional).

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Automated: [vault-monitor-hook-behavior.test.js](../../host/__tests__/vault-monitor-hook-behavior.test.js), [agent-seed-pi-memory.test.ts](../../src/__tests__/lib/agent-seed-pi-memory.test.ts), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [vault-manifest-detection.test.ts](../../src/__tests__/lib/vault-manifest-detection.test.ts); Manual: [Claude extraction failure preservation](../../documentation/lanes/vault.md#claude-extraction-failure-preservation)

**Status:** Implemented

---

### REQ-VAULT-031: Vault hash checks follow successful prompt cadence

**Intent:** Vault change detection must run at bounded user-prompt boundaries without consuming an eligible check when scanning fails.

**Applies To:** System

**Acceptance Criteria:**

1. The first real-user prompt of a resumed session with an uncaptured memory tail performs one Vault content-hash check. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::RESUME_VAULT_CHECK --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: host/__tests__/memory-capture-hook.test.js (resume hash-checks Vault and arms extraction only when content changed) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (captures only the uncaptured tail and hash-checks Vault on the first resumed prompt) -->
2. Claude checks each crossed twenty-prompt epoch; Pi reuses the memory-counter trigger, including resume and transcript rebase. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::VAULT_EVERY --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: host/__tests__/memory-capture-hook.test.js (hash-checks Vault at prompt 20 without starting memory capture early) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (hash-checks after twenty new memory prompts and launches only when Vault content changed) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-031 AC2: shared memory cadence checks companions while capture remains pending) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-002 AC4: baselines the first prompt and arms all three jobs only after twenty new prompts) -->
3. Claude advances the cadence counter after a successful scan, including when nothing changed. It also advances when the check skips scanning because the scanner or Vault is missing, or an extraction marker is pending. <!-- @test: host/__tests__/memory-capture-hook.test.js (REQ-VAULT-031 AC3: advances the Vault cadence when ${reason}) --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::arm_vault_check --> <!-- @test: host/__tests__/memory-capture-hook.test.js (advances the Vault check counter when a successful scan finds no changes) -->
4. A failed manifest scan does not block the active user prompt. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::arm_vault_check --> <!-- @test: host/__tests__/memory-capture-hook.test.js (retries the Vault hash check on the next prompt after a partial file-read failure) -->
5. A failed manifest scan leaves the successful-check counter unchanged. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::arm_vault_check --> <!-- @test: host/__tests__/memory-capture-hook.test.js (retries the Vault hash check on the next prompt after a partial file-read failure) -->
6. A failed manifest scan retries on the next real-user prompt. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::arm_vault_check --> <!-- @test: host/__tests__/memory-capture-hook.test.js (retries the Vault hash check on the next prompt after a partial file-read failure) -->
7. After Pi extraction exhausts delivery, uncommitted edits become discoverable only at the next eligible shared memory-cadence hash check: resume, transcript rebase, or a 20-prompt window. No additional edit is required. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::refreshPendingVaultRequest --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::detectNewVaultRequestWhenNoneExists --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (rediscovers exhausted Vault work only at the next eligible cadence) -->

**Constraints:**

- Generated and internal content exclusions remain governed by [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion).
- A skipped scan does not establish that the Vault was checked or contains no changes.
- No polling extraction daemon runs.

**Priority:** P0

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion), [REQ-MEM-002](memory.md#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume)

**Verification:** Automated: [memory-capture-hook.test.js](../../host/__tests__/memory-capture-hook.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

<a id="req-vault-004-unified-global-knowledge-graph"></a>
### REQ-VAULT-004: Unified global graph merges vault and active repos

**Intent:** A single `mcp__graphify__*` call returns nodes from `user_vault` plus the current active repository when it has a graph, not every historically touched repository, so cross-cutting questions ("did we ever discuss X with respect to Y") work without manually selecting a graph.

**Applies To:** Agent

**Acceptance Criteria:**

1. The MCP wrapper's active-graph resolver prefers the unified global graph when present, falling back to the sentinel-pinned per-repo graph and then to the freshest workspace-by-mtime graph. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py::_resolve_active --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh / REQ-VAULT-004 (unified global graph merges vault + active repos)) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (IG0630: actual Python MCP resolver chooses global, pinned, then freshest workspace graph) -->
2. Active repositories with graphs join the unified graph unless the manifest already matches their tag, graph hash, and checkout path. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::REPO --> <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::stored_path --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::planGlobalGraphReconcile --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-004 / REQ-OPS-049 AC3: memory-vault.ts publishes through the protected global graph lock) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (skips republishing a graph the manifest already records (REQ-VAULT-014 AC5)) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (republishes when another checkout of the same basename holds the tag (REQ-VAULT-014 AC5)) --> <!-- @test: src/__tests__/lib/pi-global-graph-reconcile.test.ts (still adds when another checkout of the same basename published an identical graph) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (IG0318/IG0631/IG0632: sequential switch persists source path/hash and exact global contents, then vault only) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (RQ0841: identical graphs rebind checkout provenance without rewriting global graph bytes) --> <!-- @test: src/__tests__/lib/pi-global-graph-reconcile.test.ts (RQ0841: matching graph bytes update only checkout provenance under the writer lock) -->
3. Active-repo resolution walks up to the nearest git checkout, identified by a `.git` directory or a worktree `.git` file, and treats neither the vault nor a graph-output-only directory as a repository, leaving the sentinel and global graph untouched on reaching either. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::REPO --> <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::CANDIDATE --> <!-- @impl: preseed/agents/pi/extensions/graphify-native.ts::repoRootFromPath --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh / REQ-VAULT-004 (unified global graph merges vault + active repos)) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (a bare graphify-out/ directory is NOT a repo root) --> <!-- @test: src/__tests__/lib/pi-vault-repository.test.ts (REQ-VAULT-004 AC3: a Git-initialized Vault never becomes the active repository) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-004 AC3: startup ignores a stale Vault repo sentinel while preserving canonical Vault publication) -->
4. Routine bash, edit, and write calls leave the active graph unchanged without starting another graph merge when the repository path, checked-out branch, graph presence, and graph modification time are all unchanged since the last reconciliation. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::GRAPH_MTIME --> <!-- @test: host/__tests__/graphify-active-repo.test.js (fast-path: same repo + graph mtime <= sentinel mtime -> exit 0, sentinel mtime unchanged) -->
5. Single-active-repo invariant and multi-writer lock serialization are specified in [REQ-VAULT-014](#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation). <!-- @manual -->
6. When the active checkout has no graph, the global graph holds the vault entry alone: every repository entry is removed and none is added. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::keep_tag --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::planGlobalGraphReconcile --> <!-- @test: host/__tests__/graphify-active-repo.test.js (a checkout without a graph leaves the vault alone in the global graph (REQ-VAULT-004 AC6)) --> <!-- @test: src/__tests__/lib/pi-global-graph-reconcile.test.ts (a checkout without a graph removes every repo tag and adds nothing) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (IG0318/IG0631/IG0632: sequential switch persists source path/hash and exact global contents, then vault only) -->
7. A change of checked-out branch, or a graph that disappeared at an unchanged repository path, re-runs reconciliation against the current state rather than being treated as unchanged; this holds for git worktrees as well as plain clones. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::GRAPH_STATE --> <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::GIT_DIR --> <!-- @test: host/__tests__/graphify-active-repo.test.js (a branch switch triggers reconciliation even when the graph file is untouched) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (a branch switch in a worktree triggers reconciliation too, not just in a plain clone) -->

**Constraints:**

- The global-graph add is hash-keyed and idempotent.
- After CLI success, equal-hash checkout changes atomically rebind only manifest `source_path` under the same lock, retaining other fields and global graph bytes without a rebuild.
- The per-source tag is what distinguishes vault nodes from per-repo nodes in the unified graph; each source carries one stable tag.
- The global manifest uses each repository's directory basename without branch granularity.
- A branch change is a reconciliation trigger, not a rebuild trigger: it re-evaluates which tags belong in the global graph, and rebuilding a graph's contents stays an explicit action.
- After checkout, rebuilding the graph refreshes that tag through hash comparison; until then it retains prior-branch nodes.
- This staleness window avoids automatic rebuilds on every checkout.
- Branch and graph presence are recorded in a sentinel separate from the active-repo path sentinel, whose first-line-is-the-repo-path format the MCP wrapper depends on.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions), [REQ-VAULT-002](#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion)

**Verification:** Automated: [graphify-active-repo.test.js](../../host/__tests__/graphify-active-repo.test.js), [pi-global-graph-reconcile.test.ts](../../src/__tests__/lib/pi-global-graph-reconcile.test.ts), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts); Manual: [REQ-VAULT-004 procedure](../../documentation/lanes/vault.md#req-vault-004-manual-qualification)

**Status:** Implemented

---

### REQ-VAULT-005: Worker proxy exposes the in-container vault editor

**Intent:** Clicking the Vault button in the codeflare UI opens SilverBullet in a new tab, behind the same auth + rate-limit boundary as every other tier-gated session feature. This REQ covers the in-container server, the auth/rate-limit proxy plumbing, and the host-side HTTP+WS branch; Dashboard integration lives in [REQ-VAULT-012](#req-vault-012-vault-button-render-and-dashboard-landing), and control availability/opening lives in [REQ-VAULT-033](#req-vault-033-vault-button-availability-and-opening), and browser readiness gating lives in [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger).

**Applies To:** User

**Acceptance Criteria:**

1. The container image installs the SilverBullet server binary pinned by version and digest so the running editor is identical across deploys. <!-- @impl: Dockerfile::SILVERBULLET_VERSION --> <!-- @manual: Verify the pinned archive checksum in the successful image build and the selected deployment's matching image identity. -->
2. The editor listens on localhost by default; a deployment may configure a nondefault bind address. <!-- @impl: entrypoint.sh::start_silverbullet_supervisor --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-005 AC2/AC6: launches on loopback and restarts a crashed editor without restarting its host) -->
3. A vault request reaches the session container only after authentication, origin allowlisting, active-tier user checks, session ownership, and container health all succeed. <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (handleVaultRequest auth chain (CF-002)) -->
4. WebSocket upgrades for live-edit sync are rate-limited under the same per-user budget as terminal WebSockets so a separate budget cannot be discovered. <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @manual: Exercise terminal and Vault upgrades for the same user across the shared threshold; route parsing alone is not this evidence. -->
5. Prefixed Vault HTTP requests reach the localhost editor without the prefix. <!-- @impl: host/src/request-router.ts::createRequestHandler --> <!-- @impl: host/src/vault-proxy.ts::stripVaultPrefix --> <!-- @test: host/__tests__/vault-proxy.test.js (stripVaultPrefix / REQ-VAULT-005 AC5 (/vault prefix-strip before forwarding to SilverBullet)) -->
6. The editor recovers promptly after a crash without restarting the container. <!-- @impl: entrypoint.sh::start_silverbullet_supervisor --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-005 AC2/AC6: launches on loopback and restarts a crashed editor without restarting its host) -->
7. Editor WebSocket forwarding applies only to Vault paths. <!-- @impl: host/src/upgrade-dispatcher.ts::createUpgradeDispatcher --> <!-- @test: host/__tests__/vault-proxy.test.js (REQ-VAULT-005 AC7: forwards only /vault and /vault/... upgrades, never adjacent paths) -->

**Constraints:**

- The default listener is localhost. A nondefault deployment bind is not proof of proxy-only reachability; public proxy requests still require the authentication and ownership checks in AC3.
- The vault status endpoint runs through the normal application middleware; only the catch-all proxy is intercepted before the application router.
- For body-bearing methods, the forwarded request must be the header-rewritten clone produced by the CSRF-synthesis helper.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Automated: [vault.test.ts](../../src/__tests__/routes/vault.test.ts), [vault-proxy.test.js](../../host/__tests__/vault-proxy.test.js), [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js); Manual: [SilverBullet binary identity](../../documentation/lanes/vault.md#req-vault-005-manual-qualification), [Shared WebSocket budget procedure](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Status:** Implemented

---

### REQ-VAULT-006: Shutdown bisync completes vault writes before SIGKILL

**Intent:** Stopping a session drains final Vault writes before signalling stop to reduce loss from a mid-bisync SIGKILL. Failed or timed-out sync can still leave the latest edits unpersisted; this is not a no-data-loss guarantee.

**Applies To:** User

**Acceptance Criteria:**

1. Before SIGTERM, attempt the authoritative drain for up to 120 seconds within the shared 135-second teardown deadline. Audit failures and timeouts without blocking stop; the watchdog-bounded final bisync trap is best-effort, not a separate guaranteed window. <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-011 AC5: an awaited %s stall cannot extend the shared 135-second teardown deadline) --> <!-- @test: src/__tests__/container/index.test.ts (REQ-SESSION-011 AC5: rejects at the entry-to-exit deadline and observes a later forced-destroy rejection) --> <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
2. The shutdown handler also terminates the vault-monitor daemon and the editor supervisor so neither lingers past container shutdown. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->
3. The Container DO shares one 135-second teardown deadline across the pre-SIGTERM drain, audit and stop; the drain receives at most 120 seconds and at most the remaining teardown time, leaving only the remaining deadline for process exit. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @test: src/__tests__/container/index.test.ts (container DO class / REQ-SESSION-002 (one container per session)) -->

**Constraints:**

- Drain and stop share the 135-second deadline; the post-SIGTERM trap has no separate 120-second budget.
- Failed, timed-out or abruptly interrupted sync can lose unpersisted writes.
- [REQ-SESSION-025](session-lifecycle.md#req-session-025-lifecycle-recovery-is-observably-correlated) AC6–7 own elapsed shutdown logging.

**Priority:** P0

**Dependencies:** [REQ-SESSION-009](session-lifecycle.md#req-session-009-container-destroy-wipes-session-state), [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync), [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync)

**Verification:** Automated: [entrypoint-shutdown.test.js](../../host/__tests__/entrypoint-shutdown.test.js), [index.test.ts](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-VAULT-007: Vault rules and plugin are preseeded into every advanced session

**Intent:** A fresh advanced-mode session ships with the codeflare-vault plugin (hook + extraction prompt + plugin descriptor) and the memory rule (which carries the folded vault trigger/route content) already in place -- no per-session install step.

**Applies To:** Agent

**Acceptance Criteria:**

1. Advanced Claude preseed registers the Vault plugin, extraction prompt, capture rule, and capture and operations skills; default mode registers none. <!-- @manual -->
2. The image supplies editor preseed assets for local initialization without adding those assets to every R2 sync. <!-- @manual -->
3. The Worker delivers the candidate release's manifest-derived Vault seed to the container at startup. <!-- @manual -->
4. The Claude memory rule is updated to document the vault-only capture path. <!-- @manual -->
5. Each boot restores baseline editor plugs from image preseed into the Codeflare-managed Vault plug directory. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->

**Constraints:**

- Default-mode sessions do not receive the vault plugin; the editor is an advanced-tier feature.
- Create the Vault skeleton at runtime, not in the image, without overwriting restored content on return.
- Reserve the managed plug directory for Codeflare plugs; sibling user plug directories are never overwritten at boot.

**Priority:** P0

**Dependencies:** [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth), [REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start), [REQ-AGENT-014](agents.md#req-agent-014-manifest-driven-preseed-pipeline)

**Verification:** Automated: [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js); Manual: [REQ-VAULT-007 procedure](../../documentation/lanes/vault.md#req-vault-007-manual-qualification)

**Status:** Implemented

---

### REQ-VAULT-008: Zero-UI vault encryption

**Intent:** SilverBullet's IndexedDB caches every vault file as raw bytes. This REQ covers encryption-at-rest with a deterministic, bucket-stable key derived by the Worker (no user passphrase prompt). The key's derivation and its role in persisting the IndexedDB index across sessions is [REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key); Legacy session-marker cleanup on session DELETE and successful authoritative session-list sweeping lives in [REQ-VAULT-034](#req-vault-034-legacy-session-vault-marker-cleanup); delivering the key to the browser and keeping it available in the service worker is [REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention). The threat model is BitLocker-grade: it defeats offline disk attacks (profile theft, backup leak, ransomware scan) and does NOT defeat anyone with an authenticated browser tab. Because the key is bucket-stable (not per-session), it deliberately relinquishes per-session forward secrecy in exchange for cross-session IndexedDB persistence (see Constraints).

**Applies To:** User

**Acceptance Criteria:**

1. The Worker derives the vault key deterministically from the server master secret and the user's bucket name, with no user passphrase, returning the same key for a given bucket on every call. <!-- @impl: src/routes/vault/crypto.ts::getVaultEncryptionKey --> <!-- @test: src/__tests__/routes/vault-crypto.test.ts (getVaultEncryptionKey (REQ-VAULT-021 bucket-derived key)) -->
2. The key is stable across sessions for a given bucket — enabling the IndexedDB cache to persist and decrypt on subsequent container boots (per [REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)) — and is never rotated. <!-- @impl: src/routes/vault/crypto.ts::getVaultEncryptionKey --> <!-- @test: src/__tests__/routes/vault-crypto.test.ts (getVaultEncryptionKey (REQ-VAULT-021 bucket-derived key)) -->
3. The Worker's vault-config proxy derives the key in-Worker (no Durable-Object round-trip) and merges it, plus the enable-encryption flag, into the editor's runtime boot config. <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
4. The editor symmetrically encrypts each Vault's IndexedDB payloads with its Vault key. <!-- @impl: src/routes/vault/native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS --> <!-- @manual -->
5. Vault bootstrap and subsequent opens show no passphrase prompt. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_COMPLETE_BOOTSTRAP_SOURCE --> <!-- @manual -->

**Constraints:**

- Encryption defeats offline attacks only, not an authenticated browser tab or on-origin JavaScript; trade-off documented in [AD59](../../documentation/decisions/README.md#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key).
- The bucket-stable key permits later sessions to decrypt leftover local cache but never touches the browser profile ([REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)).
- The vault key must not be rotated; rotation would orphan existing IDB ciphertext and force a fresh re-sync on the next container boot.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions), [REQ-MEM-006](memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode)

**Verification:** Automated: [vault-crypto.test.ts](../../src/__tests__/routes/vault-crypto.test.ts), [vault.test.ts](../../src/__tests__/routes/vault.test.ts); Manual: [REQ-VAULT-008 procedure](../../documentation/lanes/vault.md#req-vault-008-manual-qualification)

**Status:** Implemented

---

### REQ-VAULT-009: Vault writes succeed end-to-end for SilverBullet attachment uploads

**Intent:** SilverBullet drag-and-drop uploads must succeed for an authenticated user even when a same-origin or service-worker-controlled request omits the Origin header.

**Applies To:** User

**Acceptance Criteria:**

1. A state-changing Vault request without an Origin header is treated as same-origin for the downstream CSRF check; authentication and the remaining request guards still apply. <!-- @impl: src/lib/vault-view.ts::maybeSynthesizeCsrfHeader --> <!-- @impl: src/lib/vault-view.ts::maybeIssueCsrfCookie --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (REQ-VAULT-009: forwards a no-Origin upload with intact bytes and synthesized CSRF headers) -->
2. A state-changing request with an Origin header that fails the allowlist still returns a 403; the missing-Origin fallback does not widen the allowlist. <!-- @impl: src/lib/vault-view.ts::inferOriginValidated --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
3. Forwarding preserves request body bytes end-to-end both with and without an Origin header. <!-- @impl: src/lib/vault-view.ts::maybeSynthesizeCsrfHeader --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (REQ-VAULT-009: forwards a no-Origin upload with intact bytes and synthesized CSRF headers) -->
4. Existing read-only and preflight requests behave unchanged; only state-changing methods enter the fallback path. <!-- @impl: src/lib/vault-view.ts::inferOriginValidated --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->

**Constraints:**

- Modern browsers always set Origin on state-changing cross-origin requests; the fallback exists for the editor's same-origin path (where Origin is null or omitted) and for CLI-style clients; It does not bypass the allowlist when an Origin is present and disallowed.

**Priority:** P1

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** Automated: [vault.test.ts](../../src/__tests__/routes/vault.test.ts), [vault-auth-chain.test.ts](../../src/__tests__/routes/vault-auth-chain.test.ts)

**Status:** Implemented

---

<a id="req-vault-010-preseed-migration"></a>
### REQ-VAULT-010: Codeflare-authoritative files preseeded into the vault on every boot

**Intent:** A defined set of vault files are codeflare-authoritative: SilverBullet widgets, wikilink handlers, theming, and the graph build all depend on their contents being current at boot. User edits to these files are intentionally not preserved, and stale build artefacts that mislead the user must be cleared on every boot.

**Applies To:** User

**Acceptance Criteria:**

1. Each boot updates changed authoritative CONFIG, README, and STYLES pages. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
2. User content lives in dedicated user-owned subdirectories (notes, references, inbox, journal, raw-pasted, raw-sessions) and is never touched by the preseed sync; only the three codeflare-authoritative config pages are force-overwritten ([REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC3 retains create-if-missing for the autosaved, editor-normalized dashboard). <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-010 AC2: authoritative page refresh preserves bytes and mtimes in every user-owned content directory) --> <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
3. Entrypoint never writes a partial built-in plug library that would shadow the editor's complete overlay. <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-010 AC3: initializer never writes a partial built-in library (${restored ? 'restored user overlay' : 'fresh Vault'})) --> <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
4. The vault graph file is seeded with an empty-graph stub only when absent; a populated graph from a prior session is never overwritten by the entrypoint. <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-010 AC4: seeds a valid empty graph only when absent and preserves populated graph bytes on rerun) --> <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
5. When the preseed Global Graph Markdown page is absent, each boot independently removes the existing legacy Global Graph Markdown and HTML artifacts. Either artifact may already be absent; the preseed Markdown check is their shared guard. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (removes orphaned legacy graph markdown and HTML independently (REQ-VAULT-010 AC5)) -->

**Constraints:**

- The three authoritative config pages (CONFIG, README, STYLES) are kept current.
- The runtime configuration page is Codeflare-owned and always overwritten, not user-editable content.
- The supervisor explicitly selects the title-cased preseed index page.
- The seed-only-if-absent rule for the vault graph file exists.
- The stale-graph-artifact removal exists.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Automated: [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-VAULT-011: Vault-extract handles PDFs by runtime capability

**Intent:** PDF extraction remains truthful to each runtime's available reader. Claude can render bounded PDF pages and derive content/citations; Pi has no PDF page reader and emits metadata-only document evidence. Neither path may claim parity or let a PDF render error block healthy files once the content-hash scan succeeds.

**Applies To:** User

**Acceptance Criteria:**

1. On Claude, a changed PDF is read as rendered content with a bounded page cap rather than skipped as opaque binary. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::claude-vault-pdf-handling --> <!-- @manual: Run the Claude PDF-ingestion checklist in the Vault lane. -->
2. Claude emits a document node plus concept nodes for visible title text, headings, named entities, and diagrams. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::claude-vault-pdf-handling --> <!-- @manual: Confirm content-derived nodes from a healthy text or scanned PDF on Claude. -->
3. On Claude, when a sibling Markdown note wikilinks the same PDF, a `cites` edge connects the PDF document node to the wikilink concept. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::claude-vault-pdf-handling --> <!-- @manual: Confirm the citation edge in the Claude output graph. -->
4. On Pi, PDF/binary input is metadata-only and produces a bare document node because Pi has no bounded PDF page reader. <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::pi-vault-extraction-contract --> <!-- @manual: Confirm a Pi PDF produces only path/type document metadata. -->
5. If a successfully scanned PDF cannot be rendered, extract its metadata and continue with healthy changed files; a successful batch still advances the manifest. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::claude-vault-pdf-handling --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::pi-vault-extraction-contract --> <!-- @manual: Drop a corrupt or password-protected PDF alongside a healthy changed file and confirm one unreadable PDF does not block the batch or manifest advancement. -->
6. An unreadable PDF produces a bare document node rather than content-derived evidence. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::claude-vault-pdf-handling --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::pi-vault-extraction-contract --> <!-- @manual: Confirm a corrupt or password-protected PDF produces a bare document node without content-derived concepts. -->

**Constraints:**

- Claude partially ingests PDFs beyond the Read-tool page cap.
- Supported metadata fallback counts as a valid PDF result under AC6, not a failed extract.
- A failed content-hash scan or other unsupported extraction failure preserves the prior manifest under [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion) AC5.
- Pi does not gain a prompt-only PDF reader, content-derived PDF concepts, shader-like internal test, or cross-runtime parity claim.

**Priority:** P1

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion)

**Verification:** Manual: [REQ-VAULT-011 procedure](../../documentation/lanes/vault.md#pdf-ingestion-e2e-plan-req-vault-011)

**Status:** Implemented

---

### REQ-VAULT-012: Vault button render and dashboard landing

**Intent:** The editor opens on the codeflare dashboard, which leads users toward durable notes and references before broader recent-content widgets.

**Applies To:** User

**Acceptance Criteria:**

1. The editor opens on the codeflare dashboard page. <!-- @impl: entrypoint.sh::start_silverbullet_supervisor --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
2. The dashboard links to the README near the top. <!-- @manual -->
3. The dashboard surfaces `Notes/` and `References/` before generic recent-content widgets. <!-- @manual -->

**Constraints:**

- Codeflare owns the initial dashboard seed, created only when `Index.md` is absent; an existing differing dashboard is preserved rather than overwritten, including user edits and editor normalization. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (seeds Index.md create-if-missing but NEVER force-overwrites an existing differing Index.md (prevents the 2nd-start sync conflict)) -->

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** Automated: [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js); Manual: [REQ-VAULT-012 procedure](../../documentation/lanes/vault.md#req-vault-012-manual-qualification)

**Status:** Implemented

---

### REQ-VAULT-033: Vault button availability and opening

**Intent:** The Vault button is available only for active advanced sessions. A cold available control prepares the current session’s proxied editor before opening; an already armed/ready control opens on the first click.

**Applies To:** User

**Acceptance Criteria:**

1. The workspace header or its Profile overflow shows the Vault control only with a selected session and an advanced effective mode preference. The readiness probe additionally requires the selected session to be running. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/components/Layout.tsx::activeRunningSid --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)) --> <!-- @test: web-ui/src/__tests__/components/preferences-hydration.test.tsx (REQ-SESSION-014 / REQ-VAULT-033 / REQ-IDE-003: HTTP preference hydration) -->
2. On a cold available control, the first click prepares the current session's proxied editor and arms the control; the second click opens it. An already armed/ready control opens on the first click. <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)) -->
3. The eligible Vault control remains accessible in the toolbar or Profile overflow while its server probe is unavailable and shows click or tap feedback without opening the editor. <!-- @impl: web-ui/src/components/Header.tsx::Header --> <!-- @test: web-ui/src/__tests__/components/Header.test.tsx (moves VS Code, Operators, then Vault into Profile and restores them in reverse order) --> <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/VaultButton.test.tsx (REQ-VAULT-033 AC3: unavailable $status control stays visible and explains the wait without opening) -->
4. The first preparation click requests best-effort persistent browser storage. Denial does not block preparation. <!-- @impl: web-ui/src/lib/browser-storage-persistence.ts::requestBrowserStoragePersistence --> <!-- @test: web-ui/src/__tests__/lib/browser-storage-persistence.test.ts (requests persistence when not already persisted) --> <!-- @test: web-ui/src/__tests__/lib/browser-storage-persistence.test.ts (does not treat a denied persistence request as fatal) -->

**Constraints:**

- Codeflare owns the initial dashboard seed, created only when `Index.md` is absent; an existing differing dashboard is preserved rather than overwritten, including user edits and editor normalization.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-VAULT-012](#req-vault-012-vault-button-render-and-dashboard-landing)

**Verification:** Automated: [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [VaultButton.test.tsx](../../web-ui/src/__tests__/components/VaultButton.test.tsx), [preferences-hydration.test.tsx](../../web-ui/src/__tests__/components/preferences-hydration.test.tsx), [browser-storage-persistence.test.ts](../../web-ui/src/__tests__/lib/browser-storage-persistence.test.ts)

**Status:** Implemented

---

<a id="req-vault-013-html-base-path-rewriting"></a>
### REQ-VAULT-013: SilverBullet subpath adapter

**Intent:** SilverBullet served under the per-session vault proxy must resolve every relative asset through that proxy rather than the Worker root. The companion native-service-worker contract is [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker).

**Applies To:** User

**Acceptance Criteria:**

1. Every Vault HTML response rewrites its base href to the session proxy path so relative assets survive deep-page reloads. <!-- @impl: src/lib/vault-view.ts::rewriteVaultBaseHref --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
2. Except for the required Vault configuration and filesystem-listing transformations, non-HTML responses (JS bundles, images, manifests, markdown page bodies, JSON API replies, binary assets) pass through unchanged; HTML rewriting applies only to HTML responses. <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (REQ-VAULT-013: dispatch preserves %s response bytes and upstream headers) -->
3. Rewriting the response body drops both original Content-Length and Content-Encoding headers. <!-- @impl: src/lib/vault-view.ts::rewriteVaultHtmlResponse --> <!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute / REQ-VAULT-005 (Worker proxy exposes in-container vault editor)) -->
4. A successful HTML response lacking the expected base href logs a warning on root and deep routes. <!-- @impl: src/lib/vault-view.ts::rewriteVaultHtmlResponse --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (warns when a successful deep SPA HTML response has no rewritable base href (REQ-VAULT-013 AC4)) -->

**Constraints:**

- The Worker rewrites each HTML response's base tag to the session prefix; the editor also supports a base-tag prefix environment variable.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** Automated: [vault-html-direct.test.ts](../../src/__tests__/routes/vault-html-direct.test.ts), [vault.test.ts](../../src/__tests__/routes/vault.test.ts), [vault-auth-chain.test.ts](../../src/__tests__/routes/vault-auth-chain.test.ts)

**Status:** Implemented

---

<a id="req-vault-014-global-graph-repository-set-matches-the-active-vault-repository"></a>
### REQ-VAULT-014: Graphify active-repo invariant and lock serialisation

**Intent:** Concurrent agent flows must not corrupt the global graph, and the global graph must never accumulate stale per-repo entries when the user switches between repos. This REQ specifies the single-active-repo invariant and the cross-writer lock serialisation that keep the global graph well-formed under contention.

**Applies To:** Agent

**Acceptance Criteria:**

1. Manifest/hash reads, stale-removal decisions and the current entry's addition run inside one shared-lock transaction; any failure prevents sentinel advancement and remains retryable. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::RECONCILED --> <!-- @test: host/__tests__/graphify-active-repo.test.js (REQ-VAULT-014 AC1/AC2 / REQ-OPS-049 AC2: reconciles a repo switch under one protected lock) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (IG0318: real bounded lock contention preserves manifest/graph bytes and prior sentinel, then retries) -->
2. A successful switch retains the Vault entry and exactly one repository entry if the active checkout has a graph, otherwise none under [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC6. A failed switch retains the prior sentinel and never adds the new entry. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::RECONCILED --> <!-- @test: host/__tests__/graphify-active-repo.test.js (keeps a failed locked switch retryable and never adds the new repo (REQ-VAULT-014 AC1/AC2)) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (IG0318/IG0631/IG0632: sequential switch persists source path/hash and exact global contents, then vault only) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (IG0318: real bounded lock contention preserves manifest/graph bytes and prior sentinel, then retries) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (RQ0081: overlapping Vault-only plans settle to one active repository under the real writer lock) -->
3. Same-tag transitions (two clones with identical directory basenames, or branch switches within the same repo) issue no removal, because the active checkout's tag is excluded from the removal set and the global add replaces the existing entry in place. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::REPO_BASENAME --> <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh single-active-repo maintenance / REQ-VAULT-014 (graphify active-repo invariant + lock serialisation)) -->
4. Every Vault and graph writer uses the shared bounded multi-writer lock, preventing concurrent corruption and permanent queue blockage. <!-- @test: host/__tests__/graphify-active-repo.test.js (graphify-active-repo.sh single-active-repo maintenance / REQ-VAULT-014 (graphify active-repo invariant + lock serialisation)) --> <!-- @manual --> <!-- @test: host/__tests__/graphify-active-repo.test.js (IG0318: real bounded lock contention preserves manifest/graph bytes and prior sentinel, then retries) -->
5. Removals are enumerated from the global manifest rather than derived from the previously-recorded repository, so entries a crashed reconciliation or a formerly-misresolved directory left behind are removed too; the always-on `user_vault` entry is never a removal candidate. <!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh::STALE_TAGS --> <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::planGlobalGraphReconcile --> <!-- @test: host/__tests__/graphify-active-repo.test.js (sweeps stale tags no sentinel diff could name, and never removes user_vault (REQ-VAULT-014 AC5)) --> <!-- @test: src/__tests__/lib/pi-global-graph-reconcile.test.ts (sweeps tags no previous-repo comparison could name, such as a crashed run leftover) --> <!-- @test: host/__tests__/graphify-active-repo.test.js (IG0318/IG0631/IG0632: sequential switch persists source path/hash and exact global contents, then vault only) -->
6. Both agent runtimes hold this invariant: the Pi extension reconciles the same manifest under the same lock on session start and after a repository transition, rather than only adding the active repository. <!-- @impl: preseed/agents/pi/extensions/codeflare-pi.ts::reconcileGlobalGraph --> <!-- @test: src/__tests__/lib/pi-global-graph-reconcile.test.ts (removes every repo tag that is not the active checkout, and adds the active one) --> <!-- @test: src/__tests__/lib/pi-global-graph-reconcile.test.ts (IG0318: real lock contention reports failure without running graphify, then permits retry) --> <!-- @test: src/__tests__/lib/pi-global-graph-reconcile.test.ts (RQ0081: a writer that commits while Pi waits is included in the locked removal decision) -->

**Constraints:**

- Under the writer lock, match a validated hexadecimal graph hash with its source path; malformed hashes and basename-only matches never qualify ([REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos)).
- The Graphify skill's commit step publishes a fresh build to the global graph through a locked global-add call.
- Reconcile the global-graph invariant on the next eligible reconciliation, not merely a recorded transition. The unchanged-state fast path does not inspect manifest-only drift.

**Priority:** P0

**Dependencies:** [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** Automated: [graphify-active-repo.test.js](../../host/__tests__/graphify-active-repo.test.js), [pi-global-graph-reconcile.test.ts](../../src/__tests__/lib/pi-global-graph-reconcile.test.ts); Manual: [REQ-VAULT-014 procedure](../../documentation/lanes/vault.md#req-vault-014-manual-qualification)

**Status:** Implemented

---

### REQ-VAULT-015: Vault IDB lifecycle and listing filters

**Intent:** SilverBullet listings and navigation hide derived output and internal preseed pages. Client mutation protection keeps hidden machine-owned content intact.

**Applies To:** User

**Acceptance Criteria:**

1. The editor's filesystem listing hides the derived graph-output directory, generated graph HTML visualizations and machine-owned session-capture memory from browser listing and SilverBullet client sync/index. <!-- @impl: src/lib/vault-view.ts::filterVaultFsListing --> <!-- @test: src/__tests__/routes/vault-html-direct.test.ts (CF-045: vault-html direct unit tests) -->
2. The preseed configuration page declares a treeview-exclusions block hiding the plug library, the library-manager mirror, the derived graph-output directory, and the four codeflare-authoritative root pages from the navigation tree. <!-- @test: host/__tests__/preseed-config-treeview.test.js (treeview rules hide every entry that should be hidden (REQ-VAULT-015 AC2)) --> <!-- @manual -->
3. Client mutations to the derived graph-output directory, generated graph HTML visualizations and machine-owned session-capture memory are rejected. <!-- @impl: src/lib/vault-view.ts::isFilteredVaultMutation --> <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (REQ-VAULT-015: rejects hidden mutations before upstream access but permits an adjacent human note) -->

**Constraints:**

- The library-manager mirror is the editor's own runtime-managed clone tree; the user does not curate it directly; The editor's internal config directory is dot-prefixed and hidden by the editor's default behavior; it requires no explicit rule.
- Cleanup and sweep use only localStorage markers and never enumerate or delete browser databases; after [REQ-VAULT-035](#req-vault-035-bucket-stable-vault-runtime-preservation) reconciliation they do not touch IndexedDB.

**Priority:** P0

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption), [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** Automated: [preseed-config-treeview.test.js](../../host/__tests__/preseed-config-treeview.test.js), [vault-html-direct.test.ts](../../src/__tests__/routes/vault-html-direct.test.ts), [vault-auth-chain.test.ts](../../src/__tests__/routes/vault-auth-chain.test.ts); Manual: [REQ-VAULT-015 procedure](../../documentation/lanes/vault.md#req-vault-015-manual-qualification)

**Status:** Implemented

---

### REQ-VAULT-034: Legacy session vault marker cleanup

**Intent:** Session deletion and successful authoritative session-list fetches clean up only legacy session-scoped localStorage markers. Bucket-stable IndexedDB stores and the vault service worker remain durable per-user resources and are not torn down by this cleanup.

**Applies To:** User

**Acceptance Criteria:**

1. The frontend runs session-vault-cache cleanup on session delete (not on stop), removing only legacy session-scoped localStorage markers. SilverBullet IndexedDB stores remain bucket-stable and are not deleted on per-session delete. <!-- @impl: web-ui/src/lib/vault-cache.ts::cleanupSessionVaultCache --> <!-- @impl: web-ui/src/stores/session.ts::deleteSession --> <!-- @test: web-ui/src/__tests__/lib/vault-cache.test.ts (cleanupSessionVaultCache (REQ-VAULT-015 AC3 / REQ-VAULT-023)) -->
2. After an authoritative session-list fetch succeeds, the frontend sweeps persisted localStorage markers and, for any session no longer in the user's active sessions list, drops the corresponding marker entries. <!-- @test: web-ui/src/__tests__/lib/vault-cache.test.ts (removes vault-session-<sid> readiness markers for orphan sessions, preserving active) --> <!-- @impl: web-ui/src/stores/session.ts::loadSessions --> <!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches --> <!-- @test: web-ui/src/__tests__/stores/session.test.ts (Session Store) -->

**Constraints:**

- The library-manager mirror is the editor's own runtime-managed clone tree; the user does not curate it directly; The editor's internal config directory is dot-prefixed and hidden by the editor's default behavior; it requires no explicit rule.
- Cleanup and sweep use only localStorage markers and never enumerate or delete browser databases; after [REQ-VAULT-035](#req-vault-035-bucket-stable-vault-runtime-preservation) reconciliation they do not touch IndexedDB.

**Priority:** P0

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption), [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters)

**Verification:** Automated: [vault-cache.test.ts](../../web-ui/src/__tests__/lib/vault-cache.test.ts), [session.test.ts](../../web-ui/src/__tests__/stores/session.test.ts)

**Status:** Implemented

---

### REQ-VAULT-016: Vault graph extraction emits the canonical shared schema

<!-- @cites: REQ-VAULT-003 (split-prose: the canonical-schema output contract foreshadowed in REQ-VAULT-003 AC4's extract-merge-advance step lands here) -->

**Intent:** Vault extraction produces a graph compatible with repository and global graphs and attempts to refresh the linked visualization. Detection and dispatch latency belong to [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion).

**Applies To:** User

**Acceptance Criteria:**

1. The extracted graph uses the canonical graphify node/edge schema shared with the repo and global graphs: document and code nodes carry `file_type` and a truthy `source_file` so the global merge preserves their identity. <!-- @manual -->
2. After merging, extraction attempts to refresh the HTML served by the Vault graph index link. A failed render or copy may leave the visualization stale without invalidating successful graph publication. <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::Visualization is noncritical --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::viz re-render skipped --> <!-- @manual -->

**Constraints:**

- Pi prompt assertions verify canonical chunk output, graph merging, and the publish step; cluster-only rendering and copy remain manual checks like [REQ-VAULT-011](#req-vault-011-vault-extract-handles-pdfs-by-runtime-capability).

**Priority:** P0

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion)

**Verification:** Manual: [REQ-VAULT-016 procedure](../../documentation/lanes/vault.md#req-vault-016-manual-qualification)

**Status:** Implemented

---

### REQ-VAULT-017: SilverBullet native service worker

<!-- @cites: REQ-VAULT-013 (split-prose: the native-service-worker contract foreshadowed in REQ-VAULT-013's Intent - registration short-circuit, key delivery, precache - is specified here) -->

**Intent:** SilverBullet's native service worker (not a stripped shim) is served for the editor's service-worker registration fetch so the editor keeps its persistent local file-sync store and indexes incrementally (AD69). The Worker short-circuits the auth chain for the registration GET (the browser sends no credentials on that fetch, so the cookie-gated path would 401), serves the native worker body locked to the Dockerfile-pinned SilverBullet binary, and suppresses the bootstrap-hop redirect for Service-Worker-context fetches so the worker's precache resolves without reusing stale browser HTTP-cache entries. The bucket-stable vault encryption key reaches the worker via postMessage from the bootstrap-hop page ([REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC1). The served worker's runtime behavior (log suppression, destructive-sync guard, key-flush neutering) is [REQ-VAULT-025](#req-vault-025-silverbullet-native-service-worker-runtime-graft).

**Applies To:** User

**Acceptance Criteria:**

1. Service-worker registration bypasses authentication and receives the native editor worker. <!-- @impl: src/routes/vault/native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS --> <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (VAULT_NATIVE_SERVICE_WORKER_JS / REQ-VAULT-017 AC1 (native SW served, AD69)) -->
2. The short-circuit selector requires GET method, exact path match for the service-worker script, and the browser-only `Service-Worker` request header (a Fetch-spec forbidden header not settable from page JavaScript); cookie presence is not checked and does not affect the match. <!-- @impl: src/lib/vault-view.ts::isServiceWorkerRegistration --> <!-- @test: src/__tests__/routes/vault.test.ts (isServiceWorkerRegistration / REQ-VAULT-017 (native SW short-circuit selector)) -->
3. The native service worker's verbatim upstream bytes are guarded by a pinned integrity digest. <!-- @impl: src/routes/vault/native-sw.ts::VAULT_NATIVE_SW_SHA256 --> <!-- @impl: src/routes/vault/native-sw.ts::VAULT_NATIVE_SW_VERBATIM --> <!-- @test: src/__tests__/routes/vault.test.ts (T9: the drift guard hashes the VERBATIM upstream worker) -->
4. The native worker's install precache bypasses stale browser HTTP-cache entries so stale assets cannot satisfy installation. <!-- @impl: src/routes/vault/native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-017 AC4: install precaching bypasses stale browser cache entries) -->
5. The bootstrap hop supplies the bucket-stable vault encryption key to the native worker by postMessage, including on cold boot, without putting the key in the worker script body ([REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention)). <!-- @impl: src/routes/vault/crypto.ts::getVaultEncryptionKey --> <!-- @impl: src/lib/vault-view.ts::injectVaultBootstrapHopHtml --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (removes stale workers, registers the canonical worker, persists encryption, and redirects) -->
6. The native worker precaches `/` during installation. Before the bootstrap cookie exists, a shell GET with non-`navigate` `Sec-Fetch-Mode` reaches the shell rather than receiving the bootstrap redirect. <!-- @impl: src/routes/vault/native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS --> <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @impl: src/lib/vault-view.ts::isServiceWorkerContextFetch --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-017 AC4: install precaching bypasses stale browser cache entries) --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (T5: shell `/` navigation redirects to the hop, but the SW precache fetch passes through) -->
7. Without the bootstrap cookie, shell GET navigation (`Sec-Fetch-Mode: navigate`) and shell GETs without that header still redirect to the key-arming hop rather than serving the shell. <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @impl: src/lib/vault-view.ts::isServiceWorkerContextFetch --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (T5: shell `/` navigation redirects to the hop, but the SW precache fetch passes through) -->

**Notes:** The native registration boundary and enterprise Access prerequisite are documented in the [Vault lane](../../documentation/lanes/vault.md#service-worker-registration-noop-bypass) and [AD69](../../documentation/decisions/README.md#ad69-silverbullet-vault-runs-its-native-service-worker-for-persistent-encrypted-client-indexing).

**Constraints:**

- Browsers omit credentials on service-worker script fetches (Chrome 76+ per spec; Samsung Internet and other Chromium forks may not); the selector is browser-agnostic and matches regardless of cookie presence.

**Priority:** P0

**Dependencies:** [REQ-VAULT-013](#req-vault-013-silverbullet-subpath-adapter), [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption)

**Verification:** Automated: [vault-browser-bundle.test.ts](../../src/__tests__/lib/vault-browser-bundle.test.ts), [vault-auth-chain.test.ts](../../src/__tests__/routes/vault-auth-chain.test.ts), [vault-native-sw-direct.test.ts](../../src/__tests__/routes/vault-native-sw-direct.test.ts), [vault.test.ts](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

### REQ-VAULT-025: SilverBullet native service worker runtime graft

**Intent:** The served native SilverBullet service worker ([REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker)) must suppress expected startup noise, tolerate an unavailable in-container server, and retain its encryption key through idle or backgrounding without altering unrelated upstream behavior.

**Applies To:** User

**Acceptance Criteria:**

1. The served worker suppresses or downgrades expected startup-only log noise (no controlled clients, auth-gated service-proxy reset, and sync retry errors) without changing the message flow to clients or the version-drift guard. <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-025: served worker drops no-client info spam and downgrades expected auth/sync startup noise) -->
2. Valid empty remote lists abort before deletion when the local store or snapshot contains files. <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-023: AC2 %s rejects deletion after a real encrypted sync) -->
3. The worker graft introduces no duplicate lexical binding and always produces syntactically valid JavaScript. <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (the served worker is syntactically valid JavaScript (graft introduces no parse error)) -->
4. The served worker neuters the upstream's proactive key flush (wiping the key 5s after the last client disconnects): the graft retains the key for the worker's lifetime; cold-restart recovery is handled by the key-recovery helper ([REQ-VAULT-024](#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC5). <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @impl: src/routes/vault/native-sw.ts::ANCHOR_PROACTIVE_FLUSH --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (CF-045: vault-native-sw direct unit tests) -->
5. Non-array remote lists abort synchronization even with an empty local store and snapshot. <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-025: JSON %s on a fresh native store fails sync and a later valid listing restores note visibility) -->
6. Rejected cycles retry later and resume normal reconciliation when a valid non-empty remote list becomes available. <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-025: JSON %s on a fresh native store fails sync and a later valid listing restores note visibility) -->
7. A valid empty remote list synchronizes successfully when both the local store and snapshot are empty. <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-025: a genuinely empty native store and valid empty remote array publish successful empty sync) -->

**Constraints:**

- Grafting leaves `VAULT_NATIVE_SW_VERBATIM` and its SHA-256 drift guard unchanged.
- Coupled SilverBullet release updates deliberately advance both upstream bytes and digest.
- Incompatible graft anchors fail closed.

**Priority:** P0

**Dependencies:** [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker)

**Verification:** Automated: [vault-native-sw-direct.test.ts](../../src/__tests__/routes/vault-native-sw-direct.test.ts)

**Status:** Implemented

---

### REQ-VAULT-018: Vault control gating and on-demand prewarm trigger

**Intent:** The Vault control stays guarded until the server confirms SilverBullet is actually serving, and browser prewarm starts strictly on demand — never automatically — so a user is never dropped onto an unreachable editor or a headless indexing run they didn't ask for. The user's first click on a server-ready control starts the prewarm (the button breathes the codeflare accent and warns that terminal focus may briefly drop); leaving the view cancels the mounted prewarm iframe, while returning to the still-running session resumes the preserved preparation intent. The prewarm bridge that reports progress back to the dashboard validates message origin and attempt, and stays inert — emitting ready only once SilverBullet's runtime, service worker, space sync, and object index all agree the vault is actually usable.

**Applies To:** User

**Acceptance Criteria:**

1. The Vault control remains guarded until the per-session vault proxy probe succeeds. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-018: stays available (no auto-prewarm) until click 1, then breathes preparing -> armed) -->
2. The per-session probe reports ready only when SilverBullet serves; it retries until first success and clears readiness after a later steady-probe failure. <!-- @impl: src/routes/vault/index.ts::/:sessionId/status --> <!-- @test: web-ui/src/__tests__/lib/vault-readiness.test.ts (latches ready on first probe success and switches to steady cadence) --> <!-- @test: web-ui/src/__tests__/lib/vault-readiness.test.ts (clears latch and falls back to warmup when a steady probe fails (SB crash recovery)) --> <!-- @impl: web-ui/src/lib/vault-readiness.ts::startVaultReadinessProbe --> <!-- @impl: web-ui/src/lib/vault-readiness.ts::probeVaultReady --> <!-- @test: web-ui/src/__tests__/lib/vault-readiness.test.ts (hits the per-session status endpoint with no-store and reports ready only when vaultReady is true) -->
3. The first browser prewarm for a session in a fresh Dashboard view requires a click on the available Vault control. Remounts with an existing request follow AC4 and [REQ-VAULT-022](#req-vault-022-vault-armed-state-open-flow-and-persistence) AC3. <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-018: stays available (no auto-prewarm) until click 1, then breathes preparing -> armed) -->
4. Leaving the active view during preparation pauses it while preserving intent; returning to the still-running session resumes preparation. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/components/Layout.tsx::clearPrewarmingVaultStatus --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-018 AC4: dashboard departure cancels the in-flight iframe and return resumes preparation) -->
5. Prewarm messages are accepted only from the mounted iframe, same origin, and current attempt. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol) -->
6. The control arms only after two consecutive complete readiness checks for the current canonical controller and the separate key-recoverability check. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_PREWARM_BRIDGE_SOURCE --> <!-- @impl: src/lib/vault-view.ts::injectVaultPrewarmBridge --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (posts ready only after two complete bundled bridge polls) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-019 AC2: completed prewarm cannot arm or open a Vault without a recoverable key) -->
7. A ready proof is accepted only when its canonical 32-hex Vault scope exactly matches the mounted iframe document; a same-origin proof for another token is rejected. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (rejects a same-origin ready proof for a different Vault token) --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (marks the prewarm ready and removes the iframe after a valid ready message) -->

**Constraints:**

- Machine-owned `Raw/Sessions/` captures remain hidden from SilverBullet listing and client sync/index during prewarm as at all other times, per [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters); protected client-mutation boundaries remain unchanged.
- Priority indexing is out of scope.
- Expected warmup or timeout must not produce 502/timeout console noise. <!-- @impl: web-ui/src/lib/vault-readiness.ts::probeVaultReady -->
- The generic shell bridge stays inert unless the prewarm query and identifier are valid.
- Sync-complete evidence must come from the current canonical controller, not another worker or the client's unscoped completion flag.
- Controller replacement resets sync evidence and the readiness streak.
- In-flight reads from the previous controller cannot publish readiness.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-VAULT-012](#req-vault-012-vault-button-render-and-dashboard-landing), [REQ-VAULT-033](#req-vault-033-vault-button-availability-and-opening)

**Verification:** Automated: [vault-browser-bundle.test.ts](../../src/__tests__/lib/vault-browser-bundle.test.ts), [vault-html-direct.test.ts](../../src/__tests__/routes/vault-html-direct.test.ts), [Header.test.tsx](../../web-ui/src/__tests__/components/Header.test.tsx), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [vault-prewarm.test.ts](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts), [vault-readiness.test.ts](../../web-ui/src/__tests__/lib/vault-readiness.test.ts)

**Status:** Implemented

---

### REQ-VAULT-022: Vault armed-state open flow and persistence

**Intent:** Once the Vault is proven ready in the current dashboard lifetime, opening and re-opening it must be instant and must never re-litigate that proof. Every fresh page load starts with an unprepared control and requires the explicit two-click on-demand flow, even though SilverBullet reuses the canonical worker and databases internally. This prevents stale browser markers or a service-worker-cached shell from silently arming the button. A one-time controlled reload still self-heals an editor tab that boots before its service worker takes control.

**Applies To:** User

**Acceptance Criteria:**

1. An admitted click on the green ('armed') control opens the Vault synchronously through the bootstrap hop without re-verifying local readiness or key recoverability. <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-019 AC1 + REQ-VAULT-022 AC1: a cold-path armed click opens without re-verification) -->
2. Fresh dashboards start available without a prewarm iframe; legacy readiness markers cannot auto-arm, while explicit preparation may reuse canonical browser stores. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-018: stays available (no auto-prewarm) until click 1, then breathes preparing -> armed) -->
3. Timeout and error do not retry or arm while the active view is unchanged. A click retries. Returning to a running session can also retry if the earlier preparation intent and server-ready latch remain. <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (retries a timed-out prewarm only after another user click) -->
4. The control uses the neutral secondary text color when available at rest, accent during preparation, then green when ready. Reduced motion keeps colors without animation. <!-- @impl: web-ui/src/components/Layout.tsx::vaultButtonStatus --> <!-- @impl: web-ui/src/styles/header.css::.header-vault-button--armed --> <!-- @manual: documentation/lanes/vault.md#vault-control-presentation -->
5. A top-level Vault reloads once only when its canonical worker is active but missed first-paint control and the one-shot marker can be read, written and read back successfully. Inaccessible, missing or failed session storage prevents automatic reload; all other states remain stable. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_CONTROLLED_RELOAD_SOURCE --> <!-- @impl: src/lib/vault-view.ts::injectVaultControlledReload --> <!-- @impl: src/lib/vault-view.ts::rewriteVaultHtmlResponse --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (performs the exact-scope one-shot reload from bundled injected bytes) --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (keeps bundled controlled reload inert for prewarm, first boot, orphaned scope, and a spent one-shot) --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (REQ-VAULT-022 AC5: %s storage failure stays stable across uncontrolled navigations) -->
6. Once armed, the control remains green across dashboard departure/return and the mobile visibility-return dashboard bounce while authoritative session status remains running. <!-- @impl: web-ui/src/components/Layout.tsx::vaultButtonStatus --> <!-- @impl: web-ui/src/components/Layout.tsx::pruneNonRunningSessionState --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-022 AC6: preserves a running session readiness latch across dashboard departure and return) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-022 AC6: preserves armed state through the mobile visibility-return dashboard bounce) -->
7. The open-session tooltip’s ready confirmation appears only on a genuine preparing-to-armed transition and hides after five seconds; an already-armed remount does not show it. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/VaultButton.test.tsx (armed auto-surfaces the ready region on the genuine preparing->armed transition, then auto-hides after 5s while the breathing class stays) --> <!-- @test: web-ui/src/__tests__/components/VaultButton.test.tsx (a fresh already-armed remount does not re-pop the ready tooltip) -->

**Notes:** Rendered armed color under sticky touch hover remains a protected-browser observation separate from component and bundle tests; [Vault](../../documentation/lanes/vault.md) owns that behavior.

**Constraints:**

- Dashboard card admission and tooltip suppression are governed by [REQ-VAULT-037](#req-vault-037-vault-on-vs-code-dashboard-cards).
- No persistent readiness marker or automatic prewarm may bypass the explicit first click after a page load.

**Priority:** P0

**Dependencies:** [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger), [REQ-VAULT-019](#req-vault-019-vault-key-recoverable-open-gate), [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption)

**Verification:** Automated: [layout wiring test](../../web-ui/src/__tests__/components/Layout.test.tsx), [vault button states test](../../web-ui/src/__tests__/components/VaultButton.test.tsx), [vault shell helper test](../../src/__tests__/routes/vault-html-direct.test.ts), [bundled browser behavior](../../src/__tests__/lib/vault-browser-bundle.test.ts); Manual: [Vault control presentation](../../documentation/lanes/vault.md#vault-control-presentation)

**Status:** Implemented

---

### REQ-VAULT-037: Vault on VS Code Dashboard cards

**Intent:** Open a session’s Vault from the Dashboard without opening its editor.

**Applies To:** User

**Acceptance Criteria:**

1. In Advanced mode, only VS Code session cards show the Vault control. <!-- @impl: web-ui/src/components/Layout.tsx::renderDashboardVault --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (prepares and opens only the selected card’s Vault (REQ-VAULT-018/019/022/036)) -->
2. Clicking an available card control requests preparation for its own running session. <!-- @impl: web-ui/src/components/Layout.tsx::renderDashboardVault --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (prepares and opens only the selected card’s Vault (REQ-VAULT-018/019/022/036)) -->
3. A key-recovery timeout releases the preparation slot. Explicit retry starts a fresh attempt. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (prepares and opens only the selected card’s Vault (REQ-VAULT-018/019/022/036)) -->
4. Dashboard Vault controls retain accessible state labels and the same colors and motion without tooltips. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (prepares and opens only the selected card’s Vault (REQ-VAULT-018/019/022/036)) --> <!-- @manual: documentation/lanes/vault.md#vault-control-presentation -->
5. An admitted armed click opens that card’s Vault in a new tab without selecting the card. If another Vault owns preparation, opening requires a fresh click after the preparation slot is free. <!-- @impl: web-ui/src/components/Layout.tsx::renderDashboardVault --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (prepares and opens only the selected card’s Vault (REQ-VAULT-018/019/022/036)) --> <!-- @manual: documentation/lanes/vault.md#vault-control-presentation -->

**Constraints:** Reuse the header’s on-demand flow; never use another session’s readiness.

**Priority:** P1

**Dependencies:** [REQ-VAULT-022](#req-vault-022-vault-armed-state-open-flow-and-persistence)

**Verification:** Automated: [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx); Manual: [Vault control presentation](../../documentation/lanes/vault.md#vault-control-presentation)

**Status:** Planned

---

### REQ-VAULT-019: Vault key-recoverable open gate

**Intent:** The Vault button greens only when the encryption key can serve the editor — verified at the cold-path arming poll, before the control turns green — so a green button then opens directly without re-verifying on the click.

**Applies To:** User

**Acceptance Criteria:**

1. Auth-gated encryption-key recoverability is verified at the cold-path arming poll before the control greens, so an admitted open does not re-verify the key. <!-- @impl: web-ui/src/lib/vault-local-readiness.ts::checkVaultKeyRecoverable --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-019 AC1 + REQ-VAULT-022 AC1: a cold-path armed click opens without re-verification) -->
2. If the key is not recoverable, the control enters a non-openable preparing state. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-019 AC2: completed prewarm cannot arm or open a Vault without a recoverable key) -->
3. When the prewarm proof and key recoverability both hold, the cold-path poll marks the control armed. Admitted opens follow [REQ-VAULT-022 AC1](#req-vault-022-vault-armed-state-open-flow-and-persistence). <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012 / REQ-VAULT-018 / REQ-VAULT-019 / REQ-VAULT-020)) -->

**Constraints:**

- Run the key check after browser prewarm.
- Preserve [REQ-VAULT-036](#req-vault-036-vault-open-intent-lifecycle) during session and visibility changes.

**Priority:** P0

**Dependencies:** [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger)

**Verification:** Automated: [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [vault-local-readiness.test.ts](../../web-ui/src/__tests__/lib/vault-local-readiness.test.ts), [VaultButton.test.tsx](../../web-ui/src/__tests__/components/VaultButton.test.tsx)

**Status:** Implemented

---

### REQ-VAULT-036: Vault open intent lifecycle

**Intent:** Preserve a user's in-progress Vault preparation through a temporary mobile visibility change, but clear it after opening or authoritative stop.

**Applies To:** User

**Acceptance Criteria:**

1. Open intent clears when the tab opens or authoritative session status is no longer running. <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-036 AC1: opening the Vault tab clears intent before a later readiness loss) --> <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @impl: web-ui/src/components/Layout.tsx::pruneNonRunningSessionState --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-019 AC4 (vault open-intent clearing)) -->
2. Temporary mobile visibility-return deactivation does not clear preparation intent while authoritative session status remains running. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-019 AC5: temporary mobile deactivation preserves intent and remounts preparation) -->

**Constraints:** Retained intent does not bypass the key proof required by [REQ-VAULT-019](#req-vault-019-vault-key-recoverable-open-gate).

**Priority:** P0

**Dependencies:** [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger)

**Verification:** Automated: [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

### REQ-VAULT-020: Vault prewarm focus safety

**Intent:** On-demand Vault prewarm must not steal focus from the terminal or dismiss the mobile keyboard.

**Applies To:** User

**Acceptance Criteria:**

1. The on-demand prewarm started by the user's click does not steal focus from the terminal or dismiss the mobile keyboard, even when terminal input is focused or the keyboard is open. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-020: click 1 starts the prewarm even when terminal input is focused) -->
2. Only a valid-token prewarm suppresses script-driven element focus, input selection and window focus before SilverBullet scripts run. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_PREWARM_FOCUS_GUARD_SOURCE --> <!-- @impl: src/lib/vault-view.ts::injectVaultPrewarmFocusGuard --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (installs the focus guard from the bundled injected bytes) -->
3. The parent hidden iframe returns focus to the previously focused terminal/input whenever the iframe holds parent focus, including a same-origin steal that produces no window `blur` or document `focusin` event. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol) -->
4. The focus reclaim stops once prewarm tears down. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (stops focusout + poll focus reclaim after teardown) -->
5. When detaching the prewarm iframe orphans the top-level document, window focus and the terminal input are re-asserted after the iframe is removed; the reassert is inert when the window kept focus. <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (re-asserts window focus and re-focuses the terminal AFTER detaching when removal orphaned the document (REQ-VAULT-020 AC5)) -->
6. The open-session control automatically shows a tooltip warning that terminal input may pause briefly during Vault preparation. <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/VaultButton.test.tsx (preparing auto-surfaces the status region without a click and wires aria-describedby) -->

**Constraints:**

- The focus guard stays inert unless the prewarm query and identifier are valid.
- Repair a detach-induced top-level focus orphan only after iframe removal, even if the terminal input is already the active element.

**Priority:** P0

**Dependencies:** [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger), [REQ-MOB-014](terminal.md#req-mob-014-mobile-background-surface-focus-isolation)

**Verification:** Automated: [vault-browser-bundle.test.ts](../../src/__tests__/lib/vault-browser-bundle.test.ts), [vault-html-direct.test.ts](../../src/__tests__/routes/vault-html-direct.test.ts), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [vault-prewarm.test.ts](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts), [VaultButton.test.tsx](../../web-ui/src/__tests__/components/VaultButton.test.tsx)

**Status:** Implemented

---

### REQ-VAULT-021: Bucket-stable vault URL and bucket-derived key

**Intent:** SilverBullet is served under a bucket-stable URL and its local cache is encrypted with a bucket-derived key, so the client `sb_data_*` (index) and SW `sb_files_*` DB names are identical across sessions for one user — the mechanism that makes cross-session vault persistence possible in the first place.

**Applies To:** User

**Acceptance Criteria:**

1. SilverBullet is served at a bucket-stable URL whose token is a deterministic opaque hash of the user's R2 bucket name, so its served location and IndexedDB names remain identical across sessions. <!-- @impl: src/lib/vault-bucket-token.ts::getVaultBucketToken --> <!-- @test: src/__tests__/lib/vault-bucket-token.test.ts (getVaultBucketToken (REQ-VAULT-021)) -->
2. The session-keyed entry sets a routing cookie and 302-redirects to the bucket-stable URL; session identity for bucket-stable requests comes from that cookie, never the URL. <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (the session-keyed entry path sets cf_vault_sid and 302s to the bucket-stable URL) -->
3. Route dispatch distinguishes the 32-hex bucket token from an 8-24-char session id unambiguously (length-disjoint patterns). <!-- @impl: src/routes/vault/validation.ts::validateVaultRoute --> <!-- @test: src/__tests__/routes/vault-bucket-routing.test.ts (parses a 32-hex first segment as the bucket token serving path) -->
4. A bucket-stable request whose token is not the authenticated user's bucket is rejected (403 VAULT_BUCKET_MISMATCH); one with no routing cookie is rejected (409 VAULT_NO_SESSION). <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (rejects a bucket-stable request whose token is not the authed bucket (403)) --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (rejects a bucket-stable request with no cf_vault_sid routing cookie (409)) -->
5. The vault encryption key is derived deterministically per bucket from the server master secret and bucket name, so it recurs across sessions and the persisted encrypted local cache decrypts. <!-- @impl: src/routes/vault/crypto.ts::getVaultEncryptionKey --> <!-- @test: src/__tests__/routes/vault-crypto.test.ts (getVaultEncryptionKey (REQ-VAULT-021 bucket-derived key)) -->
6. Cached shell rewriting carries no session-specific readiness metadata; bucket routing and authenticated routing retain separate stable identities. <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @impl: src/lib/vault-view.ts::rewriteVaultHtmlResponse --> <!-- @test: src/__tests__/routes/vault.test.ts (REQ-VAULT-021: rewrites every shell to the permanent bucket-token scope without session metadata) -->
7. A prewarm-ready proof names and validates the canonical same-origin 32-hex Vault scope before the dashboard can arm. <!-- @impl: src/lib/vault-view.ts::injectVaultPrewarmBridge --> <!-- @impl: web-ui/src/lib/vault-prewarm.ts::startVaultPrewarm --> <!-- @test: web-ui/src/__tests__/lib/vault-prewarm.test.ts (REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol) -->

**Constraints:**

- The bucket-derived key protects only the browser-local IndexedDB cache (SilverBullet's "primary" space); the "secondary" store (container FS → R2) is not encrypted with it and is unaffected at rest.
- The bucket-stable key relaxes per-session forward secrecy of the local cache (a later session can decrypt a prior session's leftover cache) — accepted tradeoff, supersedes [AD83](../../documentation/decisions/README.md#ad83-vault-indexeddb-cannot-be-persisted-across-sessions-by-keying-the-encryption-key-to-the-r2-bucket).
- The bucket token carries no PII: it is a hash of the bucket name, never the bucket name or email itself.
- One user's sessions share the serving URL and routing cookie; a second tab's session replaces the cookie and takes over serving within the same bucket, never across tenants.

**Priority:** P1

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption), [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker), [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger)

**Verification:** Automated: [vault-bucket-token.test.ts](../../src/__tests__/lib/vault-bucket-token.test.ts), [vault-auth-chain.test.ts](../../src/__tests__/routes/vault-auth-chain.test.ts), [vault-bucket-routing.test.ts](../../src/__tests__/routes/vault-bucket-routing.test.ts), [vault-crypto.test.ts](../../src/__tests__/routes/vault-crypto.test.ts), [vault.test.ts](../../src/__tests__/routes/vault.test.ts), [vault-prewarm.test.ts](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts)

**Status:** Implemented

---

### REQ-VAULT-023: Bucket-stable vault store persistence and content bootstrap

**Intent:** The vault initializer keeps codeflare-authoritative config pages’ metadata stable across boots and seeds missing landing pages without overwriting user edits, preventing spurious secondary-change conflicts while preserving editor-normalized dashboard content through R2.

**Applies To:** User

**Acceptance Criteria:**

1. Each boot stamps CONFIG, README and STYLES with preseed-source modification times, even when content equality skips rewriting, so the editor reports identical times across sessions; the create-if-missing dashboard is exempt. <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (REQ-VAULT-023 AC1: ${page} ${state} bytes receive the preseed mtime on each boot) --> <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (stamps codeflare-authoritative config pages with the deterministic preseed mtime even when cmp-skip leaves content untouched) -->
2. Notes and References landing pages are created only if missing so the dashboard's bare `[[Notes]]` / `[[References]]` wikilinks resolve to real pages; user edits are never overwritten. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
3. The dashboard is seeded only if missing, rather than force-overwritten; editor-normalized content persists through R2 to a stable no-conflict fixed point, and an existing dashboard differing from preseed is never overwritten. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (seeds Index.md create-if-missing but NEVER force-overwrites an existing differing Index.md (prevents the 2nd-start sync conflict)) -->

**Constraints:**

- AC1 stamps only secondary mtimes for CONFIG, README, and STYLES; it cannot resolve primary-side client-save conflicts.
- `Index.md` remains create-if-missing under AC3, without the stamp.

**Priority:** P1

**Dependencies:** [REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key), [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters), [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker), [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger)

**Verification:** Automated: [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js)

**Status:** Implemented

---

### REQ-VAULT-035: Bucket-stable vault runtime preservation

**Intent:** Bucket-stable IndexedDB stores and canonical workers remain durable per-user resources. Ordinary cleanup preserves them, and sync aborts and retries instead of deleting a non-empty local store when the remote list is empty or unreadable.

**Applies To:** User

**Acceptance Criteria:**

1. Ordinary session cleanup preserves bucket-stable databases and canonical workers; only the versioned cutover may unregister them ([REQ-VAULT-029](#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety)). <!-- @impl: web-ui/src/lib/vault-cache.ts::cleanupSessionVaultCache --> <!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches --> <!-- @test: web-ui/src/__tests__/lib/vault-cache.test.ts (cleanupSessionVaultCache (REQ-VAULT-015 AC3 / REQ-VAULT-023)) -->
2. Sync never deletes a non-empty local store while the remote list is empty or unreadable; it aborts and retries later ([REQ-VAULT-025](#req-vault-025-silverbullet-native-service-worker-runtime-graft)). <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (CF-045: vault-native-sw direct unit tests) -->

**Constraints:**

- [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC1 and AC3 own the limits of mtime stamping and dashboard preservation.

**Priority:** P1

**Dependencies:** [REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key), [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters), [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker), [REQ-VAULT-018](#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger), [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap), [REQ-VAULT-034](#req-vault-034-legacy-session-vault-marker-cleanup)

**Verification:** Automated: [vault-native-sw-direct.test.ts](../../src/__tests__/routes/vault-native-sw-direct.test.ts), [vault-cache.test.ts](../../web-ui/src/__tests__/lib/vault-cache.test.ts)

**Status:** Implemented

---

### REQ-VAULT-029: Canonical browser-state cutover and future worker safety

**Intent:** The next Vault release performs a clean browser-service-worker cutover to one fresh permanent SilverBullet scope. On the first explicit prepare, Codeflare unregisters every older same-origin Vault worker, verifies none remains, and installs only the new canonical native worker. Historical IndexedDB databases are not migrated or deleted; they remain harmless orphan caches while R2 stays authoritative. Future sessions reuse the same canonical scope through the explicit two-click readiness experience.

**Applies To:** User

**Acceptance Criteria:**

1. The release changes the deterministic Vault token to v3 once, then reuses that token across future sessions and worker updates. <!-- @impl: src/lib/vault-bucket-token.ts::getVaultBucketToken --> <!-- @test: src/__tests__/lib/vault-bucket-token.test.ts (cuts over from the legacy and v2 scopes while remaining deterministic for v3) -->
2. The new permanent scope gives SilverBullet fresh current database identities without migrating or deleting historical IndexedDB databases. <!-- @impl: src/lib/vault-bucket-token.ts::getVaultBucketToken --> <!-- @test: src/__tests__/lib/vault-bucket-token.test.ts (cuts over from the legacy and v2 scopes while remaining deterministic for v3) -->
3. Before registering the canonical worker, the user-initiated bootstrap enumerates same-origin registrations and unregisters every Vault scope except the exact canonical scope; unrelated service workers are untouched. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_UNREGISTER_STALE_WORKERS_SOURCE --> <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_REGISTER_CANONICAL_WORKER_SOURCE --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (removes stale workers, registers the canonical worker, persists encryption, and redirects) -->
4. The ready bridge reports the canonical scope together with completed runtime, sync, index, required-file, and file-list evidence. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_PREWARM_BRIDGE_SOURCE --> <!-- @impl: src/lib/vault-view.ts::injectVaultPrewarmBridge --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (posts ready only after two complete bundled bridge polls) --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (withholds bundled ready proof when any acceptance-critical gate is incomplete) -->
5. Missing, superseded, or orphaned worker-scope evidence cannot trigger the controlled-reload path. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_CONTROLLED_RELOAD_SOURCE --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (keeps bundled controlled reload inert for prewarm, first boot, orphaned scope, and a spent one-shot) -->
6. Scope cutover preserves the Vault control lifecycle in [REQ-VAULT-022 AC1, AC2 and AC4](#req-vault-022-vault-armed-state-open-flow-and-persistence), with Dashboard admission governed by [REQ-VAULT-037](#req-vault-037-vault-on-vs-code-dashboard-cards). <!-- @impl: web-ui/src/components/Layout.tsx::handleVaultOpen --> <!-- @impl: web-ui/src/components/VaultButton.tsx::VaultButton --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-018: stays available (no auto-prewarm) until click 1, then breathes preparing -> armed) --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-019 AC1 + REQ-VAULT-022 AC1: a cold-path armed click opens without re-verification) --> <!-- @manual: documentation/lanes/troubleshooting.md#vault-button-re-indexes-on-every-click-after-the-first-then-returns-gr -->
7. After stale-worker removal, the bootstrap re-enumerates registrations and fails closed if any stale same-origin Vault worker remains. <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_UNREGISTER_STALE_WORKERS_SOURCE --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (fails closed before registration when a stale Vault worker remains) -->

**Constraints:**

- User-initiated cutover removes only same-origin `/api/vault/` workers; it never migrates or deletes IndexedDB, adds compatibility/background retry, or widens client-asset authentication.
- Worker-to-browser Vault scripts remain explicit self-contained source under [AD126](../../documentation/decisions/README.md#ad126-vault-browser-realm-scripts-are-authored-source-never-serialized-worker-functions), never serialized from Worker callables or coupled to bundle-only helpers.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker), [REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key), [REQ-VAULT-022](#req-vault-022-vault-armed-state-open-flow-and-persistence), [REQ-VAULT-023](#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap), [REQ-VAULT-035](#req-vault-035-bucket-stable-vault-runtime-preservation)

**Verification:** Automated: [vault-browser-bundle.test.ts](../../src/__tests__/lib/vault-browser-bundle.test.ts), [vault-bucket-token.test.ts](../../src/__tests__/lib/vault-bucket-token.test.ts), [vault-html-direct.test.ts](../../src/__tests__/routes/vault-html-direct.test.ts), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx), [vault-prewarm.test.ts](../../web-ui/src/__tests__/lib/vault-prewarm.test.ts); Manual: [Stale-worker recovery](../../documentation/lanes/troubleshooting.md#vault-button-re-indexes-on-every-click-after-the-first-then-returns-gr)

**Status:** Implemented

---

### REQ-VAULT-024: Vault bootstrap-hop key arming and service-worker retention

**Intent:** The vault key minted by [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption) still has to reach the browser and stay usable there with no passphrase prompt: a one-time bootstrap-hop page arms the service worker with the key, the worker holds onto that key for its natural lifetime instead of the upstream proactive flush, and a genuinely lost key is recovered rather than sending the user back to authentication. The Vault open click always routes through the hop so the key is armed before the editor boots.

**Applies To:** User

**Acceptance Criteria:**

1. Successful bootstrap arms the current canonical controller and awaits its native encryption-key acknowledgement before persisting browser encryption completion and redirecting to the editor. <!-- @impl: src/lib/vault-view.ts::injectVaultBootstrapHopHtml --> <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_COMPLETE_BOOTSTRAP_SOURCE --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (removes stale workers, registers the canonical worker, persists encryption, and redirects) -->
2. On failure, including browser-storage rejection, the bootstrap-hop page shows an error and aborts without setting the bootstrap-completed cookie or redirecting to the shell. <!-- @impl: src/lib/vault-view.ts::injectVaultBootstrapHopHtml --> <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_COMPLETE_BOOTSTRAP_SOURCE --> <!-- @test: src/__tests__/lib/vault-browser-bundle.test.ts (does not complete bootstrap when encryption enablement cannot persist) -->
3. Subsequent shell-path requests bypass the bootstrap hop via the cookie. <!-- @impl: src/routes/vault/index.ts::handleVaultRequest --> <!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (REQ-VAULT-024 AC3: shell navigation with the completion cookie bypasses the bootstrap hop) -->
4. The service worker retains its encryption key for its lifetime, including when the last client has been disconnected for more than five seconds. <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-024 AC4 / REQ-VAULT-025 AC4: the served worker retains real AES across the registered zero-client interval) -->
5. After idle termination, the restarted worker attempts authenticated key retrieval only when the key is genuinely missing and before either key-empty path fails. <!-- @impl: src/routes/vault/native-sw.ts::graftVaultKeyRecovery --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-024 AC5: an encryption-key query recovers and returns the server AES key through the registered handler) --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-024 AC5: config recovers AES and configures encrypted storage through the registered handler) --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-024 AC5: real logout preparation and cancellation suppress pending recovery without inventing logout state) --> <!-- @test: src/__tests__/routes/vault-native-sw-direct.test.ts (REQ-VAULT-024 AC5: real logout generation transition during pending %s recovery fences publication and configuration) -->
6. Every Vault open enters the encryption bootstrap flow rather than navigating directly to the editor shell. <!-- @impl: web-ui/src/components/Layout.tsx::openVaultTab --> <!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (REQ-VAULT-024 AC6: the open click navigates the new tab to the bootstrap-hop URL, not the bare shell) -->
7. Non-GET requests cannot enter bootstrap completion. <!-- @impl: src/routes/vault/index.ts::isBootstrapHopRequest --> <!-- @test: src/__tests__/routes/vault.test.ts (REQ-VAULT-024 AC7: only GET enters bootstrap completion) -->

**Notes:** Native-worker key recovery, retention and bucket-stable store persistence are documented in the [Vault lane](../../documentation/lanes/vault.md#service-worker-registration-noop-bypass), with their decision history in [AD69](../../documentation/decisions/README.md#ad69-silverbullet-vault-runs-its-native-service-worker-for-persistent-encrypted-client-indexing) and [AD84](../../documentation/decisions/README.md#ad84-retain-the-vault-sw-encryption-key-in-memory-neuter-the-proactive-flush-and-open-a-green-vault-button-directly).

**Constraints:**

- Bootstrap fails closed when session routing, worker support, or bounded activation cannot establish an encryption-capable editor.
- During updates, bootstrap awaits the installing/waiting replacement rather than arming the retiring worker.
- Activation, exact controller acquisition and native MessagePort key acknowledgement have bounded waits.
- Controller replacement before completion aborts without committing the encryption marker, completion cookie or redirect.

**Priority:** P0

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption), [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor), [REQ-VAULT-021](#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key), [REQ-VAULT-029](#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety)

**Verification:** Automated: [vault-browser-bundle.test.ts](../../src/__tests__/lib/vault-browser-bundle.test.ts), [vault-native-sw-direct.test.ts](../../src/__tests__/routes/vault-native-sw-direct.test.ts), [vault.test.ts](../../src/__tests__/routes/vault.test.ts), [vault-auth-chain.test.ts](../../src/__tests__/routes/vault-auth-chain.test.ts), [Layout.test.tsx](../../web-ui/src/__tests__/components/Layout.test.tsx)

**Status:** Implemented

---

<a id="req-vault-026-vault-extraction-delta-survives-container-replacement"></a>
### REQ-VAULT-026: Vault-extract change detection survives container restart (content-hash manifest)

**Intent:** A returning session extracts only vault files whose content changed, regardless of modification times rewritten during R2 restore.

**Applies To:** System

**Acceptance Criteria:**

1. Change detection reports a vault file changed exactly when its sha256 differs from, or is absent in, the persisted manifest; a file's mtime is never consulted, so rewriting every file with identical bytes (what an R2 restore does) yields zero changes. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::cmd_changed --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (THE ORACLE: an R2-style restore (rewrite every file, fresh mtime, identical bytes) yields ZERO changes) -->
2. The extraction manifest round-trips to R2 and survives container restart despite the derived-output exclusion, preserving changed-since-last-extraction state across boots. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (advanced mode: includes the vault tree AND its vault-graph.json despite the global graphify-out exclude (REQ-MEM-004 AC1 / REQ-VAULT-001 AC1)) --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (REQ-VAULT-026 AC2: durable extraction manifest bytes survive local baseline and ordinary bisync restore) -->
3. For a vault that did not exist at boot, the manifest is baselined before the R2-persisted durable initialization record is written. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (baselines only the first durable Vault initialization and leaves a later missing manifest full-delta eligible (REQ-VAULT-026 AC3/AC4/AC7)) -->
4. On every later boot the manifest is restored from R2 and never re-baselined; a missing or corrupt restored manifest therefore behaves as an empty high-water mark so every user file remains extraction-eligible. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (treats a later missing or corrupt restored manifest as a full delta instead of rebaselining current Vault bytes) -->
5. Claude and Pi commit equivalent manifest content and the same exclusion set for the same Vault contents. [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion) AC6 governs symlink exclusion. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::cmd_commit --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildVaultManifest --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (REQ-VAULT-026 AC5: Claude and Pi commit equivalent manifest content) --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (REQ-VAULT-026 AC5: a failed eligible-file read (%s) rejects the complete scan without replacing durable manifests) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-026 AC5: retries a failed scan without blocking memory even when warning fails=%s) -->
6. Incomplete or failed Pi extraction leaves the committed manifest bytes unchanged, so the same edits remain eligible after retry, runtime switch, or restart. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (keeps the committed manifest byte-identical on failure and emits the next reminder) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-027 AC4: %s postcommit provenance cannot promote a multi-file Vault request) -->
7. An existing marker-less vault receives the durable initialization record without baselining, so its files remain extraction-eligible. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (baselines only the first durable Vault initialization and leaves a later missing manifest full-delta eligible (REQ-VAULT-026 AC3/AC4/AC7)) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (keeps an existing marker-less Vault full-delta eligible during Pi fallback initialization (REQ-VAULT-026 AC7)) -->

**Notes:** Pi staged promotion and recovery are documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional).

**Constraints:**

- Read only the manifest's JSON contents; ignore its mtime, including after R2 restore.
- `vault-extract.last` remains as an ephemeral within-session dedup timestamp for the hook's vars-staleness guard only; it is no longer the change-detection source of truth.
- Compute SHA-256 over file bytes with the standard library, without Graphify or NetworkX.

**Priority:** P0

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion), [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Automated: [entrypoint-rclone-filters.test.js](../../host/__tests__/entrypoint-rclone-filters.test.js), [entrypoint-vault-boot.test.js](../../host/__tests__/entrypoint-vault-boot.test.js), [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [vault-manifest-detection.test.ts](../../src/__tests__/lib/vault-manifest-detection.test.ts)

**Status:** Implemented

---

<a id="req-vault-027-pi-vault-extraction-has-a-bounded-lifecycle"></a>
### REQ-VAULT-027: Pi vault extraction delivery is visible and transactional

**Intent:** Pi must deliver user-curated Vault changes through reload-safe background work that remains visible to the model and durable in the transcript, without advancing the committed extraction high-water mark until the exact request succeeds.

**Applies To:** System

**Acceptance Criteria:**

1. The Pi root exposes each Vault extraction as one public background `subagent` request with inherited context disabled, and never invokes a private spawn service. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (coalesces edits before launch and freezes the request after its first exact call) -->
2. After reload, the Pi root reconstructs the Vault request's exact failed-call count from its durable session history and resumes at the next delivery attempt. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-027 AC2: reconstructs Vault retry state from root JSONL after reload) -->
3. Vault edits detected before the first exact public call coalesce into the pending request, even if the launch message has already been emitted. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::refreshPendingVaultRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (coalesces edits before launch and freezes the request after its first exact call) -->
4. For nonempty changed-file work, the committed manifest advances only when the matching request-specific post-commit chunk parses and validates against the canonical Graphify extraction schema and the staged bytes validate; empty, malformed, schema-invalid, or uncorrelated chunks leave it unchanged. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::isGraphifyExtractionChunk --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::vaultSuccessQualifies --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (rejects an empty, malformed, or schema-invalid correlated chunk before manifest promotion) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-027 AC4: rejects a canonical chunk with a malformed hyperedge (%s)) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-VAULT-027 AC4: accepts a canonical singleton hyperedge (%s, %s, score %s)) -->
5. A crash after manifest promotion but before cleanup is recovered idempotently. <!-- @impl: preseed/agents/pi/extensions/vault-manifest-fs.ts::promoteVaultManifest --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (REQ-VAULT-027: recovers rename-before-cleanup only when committed bytes match) -->
6. If the stage is missing or corrupt and promotion cannot be confirmed, Pi rescans against the committed manifest and creates a new full-delta request if changes remain. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (recovers a missing or corrupt successful stage with a new full-delta request) -->
7. An older completion notification cannot suppress the full-delta follow-up from AC6. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (recovers a missing or corrupt successful stage with a new full-delta request) -->

**Notes:** Delivery ownership and transaction rationale are documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional). Bounded agent execution is documented in [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).

**Constraints:**

- Runtime coordination uses only the existing active request pointer and request-specific execution snapshot; no queue, scheduler, service, endpoint, or distributed coordinator is introduced.
- The already-required request chunk becomes visible at its canonical path only after graph commit and is root-cleaned after promotion.
- An empty changed-file snapshot is an explicit no-op without graph commands; it is not failed nonempty work.
- Claude extraction behavior and acceptance criteria remain unchanged.

**Priority:** P0

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion), [REQ-VAULT-026](#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest), [REQ-MEM-015](memory.md#req-mem-015-pi-extraction-transcript-visibility-and-child-session-guard), [REQ-MEM-016](memory.md#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile)

**Verification:** Automated: [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [vault-manifest-detection.test.ts](../../src/__tests__/lib/vault-manifest-detection.test.ts)

**Status:** Implemented

---

### REQ-VAULT-030: Pi Vault request delivery has one root owner

**Intent:** Simultaneous Pi root sessions must not duplicate one container-global Vault extraction request, while abandoned ownership remains recoverable.

**Applies To:** System

**Acceptance Criteria:**

1. A staged Vault request is delivered only by the root session that detected it; another root cannot launch the same request. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (keeps a staged Vault request owned by the root session that detected it) -->
2. A foreign owner becomes replaceable after the existing 30-minute running bound. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::detectNewVaultRequestWhenNoneExists --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (replaces a stale Vault request owned by another root session) -->

**Constraints:**

- Owner and creation metadata remain inside the existing request-specific execution snapshot.
- Recovery adds no queue, scheduler, service, endpoint, or distributed coordinator.

**Priority:** P0

**Dependencies:** [REQ-VAULT-027](#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)

**Verification:** Automated: [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

### REQ-VAULT-028: Vault edits remain isolated after extraction starts

**Intent:** Vault changes that arrive during active extraction must be delivered without mutating the launched request.

**Applies To:** System

**Acceptance Criteria:**

1. Vault edits detected after the first exact launch do not alter that request's frozen input. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::refreshPendingVaultRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (coalesces edits before launch and freezes the request after its first exact call) -->
2. Successful completion promotes only the launched request's staged hashes. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (promotes matching staged bytes and defers during-run edits until the next Vault cadence) -->
3. During-run edits remain outside the committed manifest and are discovered by the next eligible Vault hash check. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (promotes matching staged bytes and defers during-run edits until the next Vault cadence) -->

**Constraints:**

- The launched request remains immutable.
- Multiple during-run edits coalesce naturally in the next eligible content-hash delta.

**Priority:** P0

**Dependencies:** [REQ-VAULT-027](#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)

**Verification:** Automated: [pi-memory-vault-delivery.test.ts](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts)

**Status:** Implemented

---

### REQ-VAULT-032: Session archive ownership and extraction boundary

**Intent:** The deterministic session archive must not become a second editable capture source or feed its already-extracted text back through semantic extraction.

**Applies To:** Agent

**Acceptance Criteria:**

1. Memory-capture workers write only the request-owned individual capture and reject the machine archive as a capture target. <!-- @impl: preseed/agents/claude/agents/memory-capture.md::capture_file --> <!-- @impl: preseed/agents/pi/agents/memory-capture.md::captureFilename --> <!-- @manual -->
2. Vault operation guidance tells Claude and Pi to search hot captures before archived history. <!-- @impl: preseed/agents/claude/skills/vault-operations/SKILL.md::Reading --> <!-- @impl: preseed/agents/pi/skills/vault-operations/SKILL.md::Reading --> <!-- @manual -->
3. Both runtime paths exclude the complete machine session-history subtree from semantic change detection. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-manifest.py::PRUNE_PREFIXES --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::VAULT_GENERATED_PREFIXES --> <!-- @test: src/__tests__/lib/vault-manifest-detection.test.ts (REQ-VAULT-032 AC3: excludes individual captures and Archive.md from semantic extraction) -->
4. Both Vault-extract contracts treat the archive as provenance-only machine output and never author a semantic chunk from it. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md::List files changed since last successful extraction --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::First Bash call: read each frozen file once --> <!-- @manual -->
5. Vault operation guidance forbids Claude and Pi from editing the machine archive or deleting captures. <!-- @impl: preseed/agents/claude/skills/vault-operations/SKILL.md::Hard rules (NEVER) --> <!-- @impl: preseed/agents/pi/skills/vault-operations/SKILL.md::Hard rules (NEVER) --> <!-- @manual -->

**Constraints:**

- The archive remains R2-synced as ordinary Vault content and readable as a fallback source.
- Excluding the archive from extraction does not remove or regenerate graph evidence; [REQ-MEM-023](memory.md#req-mem-023-cold-session-captures-compact-without-losing-memory) relocates existing provenance.

**Priority:** P1

**Dependencies:** [REQ-VAULT-002](#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-MEM-023](memory.md#req-mem-023-cold-session-captures-compact-without-losing-memory)

**Verification:** Automated: [vault-manifest-detection.test.ts](../../src/__tests__/lib/vault-manifest-detection.test.ts); Manual: [REQ-VAULT-032 procedure](../../documentation/lanes/vault.md#req-vault-032-manual-qualification)

**Status:** Implemented

---
