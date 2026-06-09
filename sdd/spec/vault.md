# Vault

Persistent Obsidian-style note vault: agent-written session captures plus user-curated prose, indexed into the unified graphify graph for cross-session memory queries.

**Domain owner:** entrypoint.sh, codeflare-vault plugin, graphify, SilverBullet, Worker `/api/vault` route

### Key Concepts

- **Vault** -- The persistent per-user vault directory holding markdown notes, pasted assets, and derived graph output. Attachment uploads land next to the note that referenced them; the dedicated raw-pasted directory is reserved for user-owned drag-drop. The vault is bisynced to R2 so it survives across sessions and is always present in the unified global graph (tagged as the user-vault source; never pruned by the active-repo prune-on-switch logic).
- **Capture Agent** -- The background subagent spawned by the memory-capture hook. Writes one markdown file per batch into the vault's raw-sessions subdirectory and merges it into the unified global graph. Pinned to Sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) (citation accuracy).
- **Vault-monitor Daemon** -- A polling loop in the entrypoint that watches for user-curated edits anywhere under the vault except the agent-written capture directory, the derived graph-output directory, the editor's internal config directory, and the four codeflare-authoritative root pages. When changes are found, writes a trigger marker. Uses a three-marker pattern (heartbeat, high-water, trigger) to avoid the daemon-advances-mtime-before-extraction-reads-it race.
- **Vault-extract Agent** -- The background subagent spawned by the vault-monitor hook. Runs single-file graph extraction on the changed files, merges the resulting subgraph into the unified global graph, and advances the high-water marker as its final step. Pinned to Sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) (the agent emits citations into the cross-session graph and a confabulated ID is worse than a missing one).
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
- Lazy attachment loading for the raw-pasted directory. The editor pastes attachments alongside the note they were dropped into, not under a centralized raw-pasted tree, so the lazy-prefix optimization has no real workload to apply to.

### Domain Dependencies

- **Memory** -- Reuses the memory-capture UserPromptSubmit hook and its per-user counter state. The capture agent writes its synthesis output into the vault (the legacy MCP server-memory subsystem has been removed); the dedup-gate marker contract is unchanged.
- **Storage** -- Vault persistence is provided by the existing bisync to R2. The vault tree is added to the shared sync filter set, ordered before the global `graphify-out` exclude so first-match semantics keep vault content synced.
- **Session Lifecycle** -- The shutdown-bisync reliability work ([REQ-VAULT-006](#req-vault-006-shutdown-bisync-completes-vault-writes-before-sigkill)) coordinates the orchestrator destroy budget with the final-sync watchdog so vault edits made in the last seconds before shutdown reach R2 instead of being silently lost.
- **Subscription** -- Vault features (preseed entries, editor supervisor) are gated to Pro session mode via the manifest's mode filter.

---

### REQ-VAULT-001: Persistent vault directory survives across sessions

<!-- @impl: entrypoint.sh::init_user_vault -->
<!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (filter order + init function presence + Uploads/Temporary mkdir + supervisor uses $HOME/Vault → AC1-AC5) -->
<!-- @test: web-ui/src/__tests__/lib/special-folders.test.ts (special-folders registry describe → Workspace/Vault/Uploads/Temporary entries + tooltips → AC6) -->

**Intent:** A user opens a new session and finds their previous notes, captures, and pasted assets intact -- the same way the rest of `/home/user/` survives. This REQ covers the directory skeleton, rclone filter coverage, and storage-panel surfacing of the special folders; codeflare-authoritative file preseeding is in [REQ-VAULT-010](#req-vault-010-codeflare-authoritative-files-preseeded-into-the-vault-on-every-boot).

**Applies To:** User

**Acceptance Criteria:**

1. The vault directory tree is included in the rclone sync filter set with an explicit include rule ordered before the global `graphify-out` exclude so the vault's own `graphify-out/` subdirectory rides along.
2. The ephemeral global-graph workspace directory is excluded from sync so the merged graph is regenerated on boot from the per-source `graphify-out/` files rather than carrying stale state across sessions.
3. The vault initializer creates the standard vault subdirectories (raw-sessions, raw-pasted, notes, graphify-out, silverbullet config) on every boot so a user who deletes any of them cannot leave the agent hooks or the editor in a broken state on the next session start.
4. The vault initializer runs after the bisync baseline is established and before the daemon launch block so the empty skeleton never overwrites R2-restored content.
5. The vault initializer also creates the persistent Uploads and Temporary folders alongside the vault; both are covered by the same include-before-exclude rule order so files dropped into either survive session restart and appear in the storage panel.
6. The storage panel surfaces Workspace, Vault, Uploads, and Temporary as special folders at the bucket root: each appears unconditionally (Workspace gated by the workspace-sync preference) with an info-icon tooltip showing the folder's purpose and the in-container path it materializes at.

**Constraints:**

- The vault shares the user's existing R2 bucket; there is no separate vault bucket.
- Vault content is per-user (each user has their own R2 bucket).
- The vault directory must live at a non-hidden basename, because the editor's disk walker aborts traversal when the root basename starts with a dot, returning an empty file listing even when notes are on disk.

**Priority:** P0

**Dependencies:** [REQ-STOR-002](storage.md#req-stor-002-file-persistence-across-sessions) (file persistence across sessions), [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) (15-min bisync), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start) (initial sync restores files on container start)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-VAULT-010: Codeflare-authoritative files preseeded into the vault on every boot

<!-- @impl: entrypoint.sh::init_user_vault -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (per-boot preseed-page sync loop + graph.json recreate-if-missing guard + preseed-page existence on disk → AC1-AC5) -->

**Intent:** A defined set of vault files are codeflare-authoritative: SilverBullet widgets, wikilink handlers, theming, and the graph build all depend on their contents being current at boot. User edits to these files are intentionally not preserved, and stale build artefacts that mislead the user must be cleared on every boot.

**Applies To:** User

**Acceptance Criteria:**

1. The vault initializer copies the four codeflare-authoritative root pages (Index, CONFIG, README, STYLES) from the preseed source into the vault root on every boot, gated so identical files are not rewritten.
2. User content lives in dedicated user-owned subdirectories (notes, inbox, journal, raw-pasted, raw-sessions) and is never touched by the preseed sync; only the four codeflare-authoritative pages are overwritten.
3. The entrypoint must not write a partial copy of the editor's built-in plug library onto disk because the editor binary serves those files from its built-in overlay, and a partial on-disk copy would shadow the overlay with incomplete files and break widget rendering.
4. The vault graph file is seeded with an empty-graph stub only when absent; a populated graph from a prior session is never overwritten by the entrypoint.
5. The vault initializer removes stale globally-rendered graph artifacts on every boot when present (idempotent removal, guarded so it fires only when the preseed counterpart is also absent).

**Constraints:**

- The four authoritative pages are kept current because the editor's dashboard widgets, in-page wikilink handlers, and codeflare theming all depend on their contents being current; user edits to those four pages are intentionally not preserved across boots.
- The configuration page is a runtime contract, not user content; that is why it lives in the always-overwrite tier and not in the user-editable tier.
- The editor's binary hardcodes the lowercase index page name, so the supervisor must explicitly tell the editor to load the title-cased preseed index page at the root URL.
- The seed-only-if-absent rule for the vault graph file exists because the graph is build output regenerated by the extraction pipeline, not preseed content.
- The stale-graph-artifact removal exists because the unified global graph is too large for useful in-page HTML visualization; structural queries are the real interface and the vault visualization covers the user-curated slice. Vaults restored from R2 snapshots predating the removal are reconciled on the next boot.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-VAULT-002: Conversation captures land in the vault as markdown

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (vault-monitor and capture script structure → AC1-AC6) -->

**Intent:** The capture agent writes one markdown file per 15-prompt batch into `Raw/Sessions/`, replacing the previous MCP-memory write path. Captures appear in `mcp__graphify__*` queries the same turn they are written.

**Applies To:** User

**Acceptance Criteria:**

1. The capture agent writes one markdown file per batch into the vault's raw-sessions subdirectory using a dated filename and the YAML-frontmatter + Context/Decisions/Observations/References template.
2. Concept references use wikilink syntax; file paths, code symbols, and PR/issue references stay as prose.
3. The capture agent builds the vault graph inline: the agent emits chunk JSON matching the graph builder's schema, then a graph-build step materializes the per-extraction graph.
4. The agent merges the per-extraction graph into the unified global graph under the shared multi-writer lock and tags it as the vault source.
5. If extraction fails, the markdown file stays on disk; the vault-monitor daemon excludes `Raw/Sessions/`, so recovery is the next 15-message capture batch re-firing rather than a vault-monitor tick.
6. The historical MCP memory subsystem has been removed entirely; the capture agent does not invoke it, and no legacy JSONL graph is read.

**Constraints:**

- The dedup gate (the marker-file delete as the agent's first step) is unchanged from the pre-vault flow.
- Compaction is not automated; the user prunes captured sessions manually via the editor when the directory becomes unwieldy.
- The headless extraction CLI is intentionally bypassed per [REQ-MEM-001](memory.md#req-mem-001-conversation-context-automatically-captured-to-vault) AC6 - codeflare ships no LLM provider key for the CLI and the capture agent already IS the LLM, so re-invoking the CLI would duplicate inference cost with no benefit.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-VAULT-003: User-curated edits are detected and ingested within ~60s

<!-- @impl: entrypoint.sh::start_vault_monitor_daemon -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts -->
<!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (three-marker pattern presence → AC2/AC6) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault shares Claude vault-extract.last marker semantics and vault-monitor exclusions → AC1/AC4) -->

**Intent:** A user adds a note in SilverBullet (or any other editor) and within roughly one daemon tick the new content shows up in `mcp__graphify__*` query results.

**Applies To:** User

**Acceptance Criteria:**

1. The vault-monitor daemon polls the vault on a short fixed cadence, excluding the agent-written capture directory, the derived graph-output directory, the editor's internal config directory, and the four preseed-managed root pages. The four pages are codeflare-authoritative; the per-boot preseed copy must not count as a user edit, otherwise every preseed sync at boot would re-trigger extraction.
2. The daemon uses a three-marker pattern - a heartbeat marker, a high-water marker, and a trigger marker. The change-detection scan compares against the high-water marker (not the heartbeat) so a daemon that advances the wrong marker cannot lose work.
3. The hook handler exits immediately when the trigger marker is absent (zero-cost on idle prompts) or when an in-flight sentinel exists and is younger than 5 minutes. When neither exit condition applies, it creates the in-flight sentinel and emits an additional-context directive instructing the main agent to dispatch the vault-extract subagent.
4. The vault-extract subagent deletes the trigger marker as its first step (dedup gate), runs graph extraction per changed file, merges via the shared global-graph add command, touches the high-water marker, and removes the in-flight sentinel as its final step.
5. If any of the extract-merge-advance steps fail, the high-water marker is not advanced; the next daemon tick re-discovers the same files.
6. The vault initializer bumps the high-water marker after rewriting any preseed page so the first post-boot daemon tick does not interpret the preseed copy as a user change. This is belt-and-braces for any future preseed page that misses the daemon-exclusion list.

**Constraints:**

- The polling cadence is intentional; inotify was rejected as overkill for the expected edit rate.
- The in-flight sentinel (5-minute TTL) prevents the hook from re-spawning the agent on every prompt while extraction is already running. The sentinel is created by the hook on emission and removed by the agent as its final step.
- The vault-extract subagent is pinned to sonnet at the subagent-definition level (per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)) so the dispatching parent cannot silently downgrade the model.
- PDF-specific ingestion behavior is specified in [REQ-VAULT-011](#req-vault-011-vault-extract-ingests-pdf-files).

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-VAULT-011: Vault-extract ingests PDF files

<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md -->
<!-- @test: documentation/lanes/vault.md (PDF-ingestion E2E plan → drop .pdf into Raw/Pasted, daemon tick, document node in global graph + corrupt-PDF bare-node path → AC1-AC4) -->

**Intent:** PDFs dropped into the vault (typically under `Raw/Pasted/`) must be ingested into the global graph as first-class content, not skipped as binary. The agent reads each PDF, emits a `document` node plus extracted `concept` nodes, and links to sibling notes that wikilink the same file. Corrupt or unreadable PDFs must not block ingestion of healthy files.

**Applies To:** User

**Acceptance Criteria:**

1. PDF files in the changed-files list are ingested as content, not skipped as opaque binary.
2. The vault-extract agent reads each PDF (capped at a bounded page count for large files), emits a document-type node for the PDF itself plus concept-type nodes for visible title text, headings, named entities, and diagrams.
3. When a sibling markdown note wikilinks the same PDF, a citation edge connects the document node to the wikilink concept so the global graph unifies them.
4. Read failures on PDFs (corrupt, password-protected, unsupported encoding) emit the bare document node only; the high-water marker still advances so a single unreadable PDF does not block ingestion of other changed files.

**Constraints:**

- The page cap is a Read-tool limit; PDFs longer than the cap are partially ingested rather than rejected.
- AC4's corrupt/password-protected PDF read-failure path is verified by manual check (the REQ's Verification field), not an automated test: exercising it needs binary malformed-PDF fixtures that are impractical to ship in the Workers vitest pool, so it is validated against the PDF-ingestion E2E plan in `documentation/lanes/vault.md`.

**Priority:** P1

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-VAULT-004: Unified global graph merges vault and active repos

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py::_resolve_active -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (mcp-lazy resolution chain + active-repo hook structure + vault basename exclusion + fast-path skip → AC1-AC4) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-VAULT-004: Pi memory-vault.ts publishes the vault + active-repo graphs to the unified graph via flock-guarded `graphify global add --as <tag>` -> AC2/AC3) -->

**Intent:** A single `mcp__graphify__*` call returns nodes from the vault and from every per-repo graphify-out the session has touched, so cross-cutting questions ("did we ever discuss X with respect to Y") work without manually selecting a graph.

**Applies To:** Agent

**Acceptance Criteria:**

1. The MCP wrapper's active-graph resolver prefers the unified global graph when present, falling back to the sentinel-pinned per-repo graph and then to the freshest workspace-by-mtime graph.
2. The active-repo hook adds the resolved repo's graph to the unified graph (under the shared multi-writer lock) whenever the active repo has a graph and either the manifest does not yet record this repo's tag or the manifest's recorded source hash does not match the current graph hash.
3. The vault directory is explicitly excluded from active-repo candidate resolution; when the walk-up loop reaches that path, the hook exits without rewriting the sentinel or invoking the global add, so the vault is never re-tagged as a repo by a tool call that happens to touch a vault file.
4. A cheap fast-path skip avoids spawning the graph tool on every routine bash/edit/write call: when the resolved active-repo path equals the prior sentinel value and the per-repo graph file's mtime is not newer than the sentinel's mtime, the hook returns immediately. The sentinel is touched at the end of every non-fast-path fire so subsequent fires can short-circuit until the next graph rebuild.
5. Single-active-repo invariant and multi-writer lock serialization are specified in [REQ-VAULT-014](#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation).

**Constraints:**

- The global-graph add is hash-keyed and idempotent: re-running it with the same per-repo graph is a no-op.
- The per-source tag is what distinguishes vault nodes from per-repo nodes in the unified graph; each source carries one stable tag.
- Branch-level granularity is not represented in the global manifest. A repo's tag is its directory basename; branch switches within the same repo refresh the entry via the hash-diff path once the user has rebuilt the graph on the new branch. Until the rebuild runs, the global graph still shows the prior branch's nodes under the same tag - an acceptable staleness window because automatic rebuild on every checkout would be too expensive.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions), [REQ-VAULT-002](#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-VAULT-005: Worker proxy exposes the in-container vault editor

<!-- @impl: src/routes/vault.ts::handleVaultRequest -->
<!-- @impl: src/routes/vault-validation.ts::validateVaultRoute -->
<!-- @impl: entrypoint.sh::start_silverbullet_supervisor -->
<!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute boundary cases describe → AC3/AC5) -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (vault WS rate-limit key contract describe → AC4) -->

**Intent:** Clicking the Vault button in the codeflare UI opens SilverBullet in a new tab, behind the same auth + rate-limit boundary as every other tier-gated session feature. This REQ covers the in-container server, the auth/rate-limit proxy plumbing, and the host-side HTTP+WS branch; UX integration and SilverBullet subpath adaptation live in [REQ-VAULT-012](#req-vault-012-vault-button-render-and-readiness-gating).

**Applies To:** User

**Acceptance Criteria:**

1. The container image installs the SilverBullet server binary pinned by version and digest so the running editor is identical across deploys.
2. The container entrypoint supervises the editor on a localhost-only port with a short-interval restart loop so an editor crash never requires a container restart.
3. The vault-route handler applies the same auth chain as the terminal WebSocket upgrade: authentication, origin allowlist, effective-tier active-user check, session ownership, container health probe, then container fetch.
4. WebSocket upgrades for live-edit sync are rate-limited under the same per-user budget as terminal WebSockets so a separate budget cannot be discovered.
5. The in-container terminal server exposes an HTTP branch that strips the vault path prefix and forwards to the localhost editor, plus a WebSocket upgrade passthrough scoped to vault paths only.

**Constraints:**

- The editor binds to localhost only; the Worker proxy is the only externally reachable surface.
- The vault status endpoint runs through the normal application middleware; only the catch-all proxy is intercepted before the application router.
- For body-bearing methods, the forwarded request must be the header-rewritten clone produced by the CSRF-synthesis helper rather than the original incoming request; the helper consumes the input body when it constructs the clone, so forwarding the original would attempt to read an already-disturbed stream. The auth chain must read only headers so it cannot accidentally consume the body.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

### REQ-VAULT-012: Vault button render and readiness gating

<!-- @impl: web-ui/src/components/Header.tsx -->
<!-- @impl: web-ui/src/components/Layout.tsx -->
<!-- @impl: web-ui/src/lib/vault-readiness.ts::startVaultReadinessProbe -->
<!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header describe → Vault button gating + readiness probe state machine → AC1-AC5) -->
<!-- @test: web-ui/src/__tests__/components/Layout.test.tsx (Vault button gating (CF-075 / REQ-VAULT-012) describe → onVaultOpen wired only for advanced-mode active sessions → AC1) -->
<!-- @test: web-ui/src/__tests__/lib/vault-readiness.test.ts (startVaultReadinessProbe describe → no-give-up retry / first-success latch / SB-crash recovery / cancel / mid-probe cancel → AC5) -->

**Intent:** The Vault button only appears when usable and only enables after a per-session probe confirms the in-container editor is actually reachable, so users never land on `VAULT_UPSTREAM_UNREACHABLE`. SilverBullet's landing page is the codeflare dashboard. SilverBullet subpath asset adaptation lives in [REQ-VAULT-013](#req-vault-013-silverbullet-subpath-adapter).

**Applies To:** User

**Acceptance Criteria:**

1. The Vault control in the header renders only when an active session exists, the session is in advanced mode, and the parent surface has wired up the vault-open handler; the control is scoped to the terminal view alongside the related Bookmarks and Storage entrypoints. In default mode the handler is not wired up, so the control does not render.
2. The editor opens to the codeflare dashboard page on every Vault click; the supervisor explicitly pins the dashboard as the editor's index page before launching the binary.
3. The README page is reachable from the dashboard via a link at the top.
4. The Vault control is rendered disabled with an "initializing" tooltip until a per-session readiness probe against the vault proxy succeeds.
5. The probe retries on a short interval until the first success, then enables the control; readiness state is keyed per session so switching the active session resets it.

**Constraints:**

- The readiness probe guards two distinct races - the cold-boot race (the editor supervisor binds its localhost port later than terminal readiness flips) and the crashed-editor scenario (container up, editor process dead); without the probe both surface as an unreachable-upstream error to the user.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** [Automated test](../../web-ui/src/__tests__/lib/vault-readiness.test.ts)

**Status:** Implemented

---

### REQ-VAULT-013: SilverBullet subpath adapter

<!-- @impl: src/routes/vault.ts::handleVaultRequest -->
<!-- @impl: src/routes/vault-html.ts::rewriteVaultBaseHref -->
<!-- @impl: src/routes/vault-html.ts::rewriteVaultHtmlResponse -->
<!-- @test: src/__tests__/routes/vault.test.ts (rewriteVaultBaseHref / rewriteVaultHtmlResponse (REQ-VAULT-013 AC1-AC4) → AC1-AC4) -->

**Intent:** SilverBullet ships an SPA shell with `<base href="/" />` and assumes it owns its origin; under the `/api/vault/:sid/` per-session proxy, every relative asset request would otherwise resolve against the Worker root and 404. The Worker injects a per-session base href on every text/html response so the editor's relative asset references resolve back through the subpath proxy. The companion native-service-worker contract (registration short-circuit, key delivery, precache) is [REQ-VAULT-017](#req-vault-017-silverbullet-native-service-worker).

**Applies To:** User

**Acceptance Criteria:**

1. The vault proxy rewrites the bare HTML base-href to the per-session vault-proxy path on every HTML response (not gated to the root path), so the editor's relative asset references resolve back through the subpath proxy regardless of which page the user reloaded onto.
2. Non-HTML responses (JS bundles, images, manifests, markdown page bodies, JSON API replies, binary assets) pass through unchanged; the HTML-only guard is sufficient because the editor's API endpoints return non-HTML content types.
3. When the body is rewritten, both the content-length and content-encoding headers are dropped because the rewrite path auto-decompresses upstream compression, and the original headers would otherwise trigger a browser decoding failure.
4. When the rewrite runs but the body did not contain the expected base-href substring (no-op rewrite), a warning is logged so a future editor-template change surfaces as a logged signal instead of a silent white-screen regression.

**Constraints:**

- The editor honors a URL-prefix environment variable for rendering the base tag, but the prefix is per-session (the Worker knows the session ID, the container does not); baking it in at supervisor start is not viable, so the per-response Worker rewrite is the per-session adapter.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

<!-- @test: src/__tests__/routes/vault.test.ts (isServiceWorkerRegistration / REQ-VAULT-017 (native SW short-circuit selector) + VAULT_NATIVE_SERVICE_WORKER_JS / REQ-VAULT-017 AC1 (native SW served, AD69) + isServiceWorkerContextFetch / REQ-VAULT-017 AC4 (SW precache vs navigation) → AC1-AC4) -->
<!-- @test: src/__tests__/routes/vault-auth-chain.test.ts (native SW + shell-302 suppression (REQ-VAULT-017 AC1/AC4, AD69) → AC1/AC4) -->
<!-- @cites: REQ-VAULT-013 (split-prose: the native-service-worker contract foreshadowed in REQ-VAULT-013's Intent - registration short-circuit, key delivery, precache - is specified here) -->
### REQ-VAULT-017: SilverBullet native service worker

<!-- @impl: src/routes/vault.ts::handleVaultRequest -->
<!-- @impl: src/routes/vault-native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS -->
<!-- @impl: src/routes/vault-html.ts::isServiceWorkerContextFetch -->

**Intent:** SilverBullet's native service worker (not a stripped shim) is served for the editor's service-worker registration fetch so the editor keeps its persistent local file-sync store and indexes incrementally (AD69). The Worker short-circuits the auth chain for the registration GET (the browser sends no credentials on that fetch, so the cookie-gated path would 401), serves the version-locked native worker body, and suppresses the bootstrap-hop redirect for Service-Worker-context fetches so the worker's precache resolves. The per-session encryption key reaches the worker via postMessage from the bootstrap-hop page ([REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption) AC5).

**Applies To:** User

**Acceptance Criteria:**

1. Browser-initiated Service Worker registration GETs for the editor's service-worker script short-circuit the auth chain and receive SilverBullet's native service worker from the Worker (vendored verbatim, AD69), so the editor keeps its persistent local file-sync store and indexes incrementally. Cold-boot encryption rides the native worker's own `set-encryption-key`/`get-encryption-key` handlers, fed by the bootstrap-hop page (see [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption) AC5 for the key-delivery contract).
2. The short-circuit selector requires all of: GET method, exact path match for the service-worker script, and the browser-only Service-Worker request header (a Fetch-spec forbidden header name not settable from page JavaScript). Cookie presence is intentionally not checked because Samsung Internet and other Chromium forks may send cookies on SW registration fetches; rejecting those requests would force the registration through the cookie-gated proxy chain and 401.
3. The native service-worker script body is identical across sessions (version-locked to the SilverBullet binary, guarded by a recorded SHA-256 drift hash); the per-session vault encryption key is delivered to it via postMessage from the bootstrap-hop page ([REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption) AC5), never baked into the script.
4. The native worker precaches the shell `/` via `cache.addAll` during install, BEFORE the bootstrap-hop sets the bootstrap cookie. The shell-path redirect to the bootstrap-hop is suppressed for Service-Worker-context fetches (identified by a `Sec-Fetch-Mode` header present and not equal to `navigate`) so the precache resolves against the real shell instead of a 302 that would make `cache.addAll` reject and hang the SW install. Top-level navigations (`Sec-Fetch-Mode: navigate`) and clients with no `Sec-Fetch-Mode` header still receive the redirect (fail-safe), so a real first navigation never boots without the encryption key wired.

**Notes:** Documented in [AD69](../../documentation/decisions/README.md) and the [vault lane](../../documentation/lanes/vault.md#service-worker-registration-noop-bypass). Under enterprise Cloudflare Access the host-wide Access app would 302 this credential-less registration fetch to the IdP login before the Worker runs; the setup wizard auto-provisions a higher-precedence bypass app scoped to the SW path so the request reaches this short-circuit ([REQ-ENTERPRISE-006](enterprise-mode.md#req-enterprise-006-deploy-time-aig-secrets-and-enterprise_mode-var) AC6). The `/.client/*` precache-auth exemption was evaluated and left unimplemented (the integration deploy showed `cache.addAll` resolves because the precache fetches carry the session cookie); it is reserved only as a future fallback if a browser strips credentials on precache fetches.

**Constraints:**

- Browsers omit credentials on service-worker script fetches (Chrome 76+ per spec, Samsung Internet and other Chromium forks may not), so the normal cookie-auth path would return 401 and service-worker registration would fail permanently without this short-circuit. The selector is browser-agnostic: it works regardless of whether cookies are present.

**Priority:** P0

**Dependencies:** [REQ-VAULT-013](#req-vault-013-silverbullet-subpath-adapter), [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts), [Auth-chain test](../../src/__tests__/routes/vault-auth-chain.test.ts)

**Status:** Implemented

---

### REQ-VAULT-014: Graphify active-repo invariant and lock serialisation

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (single-active-repo invariant + lock serialisation across write sites → AC1-AC4) -->

**Intent:** Concurrent agent flows must not corrupt the global graph, and the global graph must never accumulate stale per-repo entries when the user switches between repos. This REQ specifies the single-active-repo invariant and the cross-writer lock serialisation that keep the global graph well-formed under contention.

**Applies To:** Agent

**Acceptance Criteria:**

1. When the resolved active repo's tag differs from the previously-recorded tag and the previous tag is still present in the global manifest, the hook removes the previous entry (under the shared multi-writer lock) before performing the add specified in [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC2.
2. End state after a repo switch: the global graph contains the vault entry plus exactly one per-repo entry (the user's currently active repo).
3. Same-tag transitions (two clones with identical directory basenames, or branch switches within the same repo) skip the explicit remove because the global add operation replaces the existing entry via its source-hash dedup.
4. All write sites (capture agent, vault-extract agent, active-repo hook, the graphify skill's commit step) serialize via the shared multi-writer lock to prevent corrupted writes when multiple workflows race; the lock-acquisition timeout ensures a crashed lock holder cannot wedge the queue indefinitely.

**Constraints:**

- The pre-spawn hash check in [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC2 uses a SHA-256 digest truncated to the graph builder's standard tag length with a length sanity-guard so a malformed digest cannot poison the comparison.
- The graphify skill's commit step is one of the write sites and must include a locked global-add call so a fresh build lands in the global graph.

**Priority:** P0

**Dependencies:** [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-VAULT-006: Shutdown bisync completes vault writes before SIGKILL

<!-- @impl: entrypoint.sh::shutdown_handler -->
<!-- @impl: src/container/container-lifecycle.ts::destroy -->
<!-- @test: src/__tests__/container/index.test.ts (135s SIGKILL fallback + shutdownElapsedMs telemetry describe → AC4/AC5) -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (120s watchdog + vault-monitor and SilverBullet PID kill in shutdown handler → AC1-AC3) -->

**Intent:** A user who stops a session and closes their browser within seconds finds their latest vault edits intact on the next session, instead of losing them to a mid-bisync SIGKILL.

**Applies To:** User

**Acceptance Criteria:**

1. The entrypoint shutdown handler wraps the final bisync in a background subshell with a watchdog that hard-kills on timeout, so the orchestrator's destroy budget always lands after bisync finishes or gives up cleanly.
2. The shutdown handler also terminates the vault-monitor daemon and the editor supervisor so neither lingers past container shutdown.
3. The shutdown elapsed time is logged so operators can tune the watchdog over time if user edit volumes grow large enough to need more headroom.
4. The Container DO's destroy budget is sized to cover the bisync watchdog plus enough additional time for clean process exit.
5. The container's stop handler logs the total shutdown elapsed time so operators have telemetry on whether the budget is right.

**Constraints:**

- The bisync-watchdog timeout and the orchestrator's destroy budget must stay coordinated so the destroy budget exceeds the watchdog plus the minimum time required for graceful process termination.

**Priority:** P0

**Dependencies:** [REQ-SESSION-009](session-lifecycle.md#req-session-009-container-destroy-wipes-session-state) (container destroy wipes session state), [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync) (graceful shutdown with final sync), [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync) (graceful shutdown performs final sync)

**Verification:** [Automated test](../../src/__tests__/container/index.test.ts)

**Status:** Implemented

---

### REQ-VAULT-007: Vault rules and plugin are preseeded into every advanced session

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (preseed manifest entries + file presence + Library/Codeflare plug copy → AC1-AC5) -->

**Intent:** A fresh advanced-mode session ships with the codeflare-vault plugin (hook + extraction prompt + plugin descriptor) and the memory rule (which carries the folded vault trigger/route content) already in place -- no per-session install step.

**Applies To:** Agent

**Acceptance Criteria:**

1. The Claude preseed manifest registers the vault plugin (plugin descriptor, vault-monitor hook script, vault-extract prompt), the vault-note-capture rule, and the vault-note-capture and vault-operations skills - all in advanced mode only. The vault trigger/route content is folded into the memory rule rather than living in a separate vault rule.
2. The container image stages the editor preseed assets under a build-time preseed root so the vault initializer can install editor config from there without baking it into every R2 sync.
3. A build-time generator (run as prebuild) embeds the manifest contents into the runtime agent-seed module, which is what the Worker ships to the container at boot.
4. The Claude memory rule is updated to document the vault-only capture path.
5. On every boot, the vault initializer copies the editor plugs from the build-time preseed root into the codeflare-managed plug subdirectory of the vault's plug library so the editor opens with the baseline productivity plug set available immediately, with no per-session install step. The copy is idempotent (overwrite when content differs) so a codeflare-side plug pin bump propagates on next boot; user-installed plugs land under other plug-library subdirectories and are untouched.

**Constraints:**

- Default-mode sessions do not receive the vault plugin; the editor is an advanced-tier feature.
- The vault skeleton is created at runtime, not baked into the image, so a returning session never overwrites restored content.
- The codeflare-managed plug subdirectory is reserved for codeflare-managed plugs; user-installed plugs live under sibling subdirectories so codeflare's overwrite-on-boot never clobbers user state.

**Priority:** P0

**Dependencies:** [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) (preseed configs from single source), [REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start) (preseed deployed to container on start), [REQ-AGENT-014](agents.md#req-agent-014-manifest-driven-preseed-pipeline) (manifest-driven preseed pipeline)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-VAULT-008: Zero-UI vault encryption

<!-- @impl: src/container/container-config.ts::ensureVaultKey -->
<!-- @impl: src/routes/vault-native-sw.ts::VAULT_NATIVE_SERVICE_WORKER_JS -->
<!-- @impl: src/routes/vault-native-sw.ts::graftVaultKeyRecovery -->
<!-- @impl: src/routes/vault-html.ts::injectVaultBootstrapHopHtml -->
<!-- @impl: src/routes/vault-html.ts::injectVaultIdbRecorder -->
<!-- @impl: src/routes/vault-html.ts::VAULT_BOOTSTRAP_COOKIE -->
<!-- @impl: src/routes/vault-html.ts::VAULT_SW_ACTIVATION_TIMEOUT_MS -->
<!-- @impl: src/routes/vault.ts::handleVaultRequest -->
<!-- @impl: web-ui/src/lib/vault-cache.ts::cleanupSessionVaultCache -->
<!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches -->
<!-- @test: src/__tests__/container/index.test.ts (ensureVaultKey persistence + idempotency describe → AC1/AC2) -->
<!-- @test: src/__tests__/routes/vault.test.ts (injectVaultEncryptionConfig + injectVaultBootScript + injectVaultBootstrapHopHtml + hasVaultBootstrapCookie describes → AC3/AC5/AC6; VAULT_NATIVE_SERVICE_WORKER_JS native-key-handler + recovery-graft tokens + graftVaultKeyRecovery drift-throw describe → AC5/AC7) -->
<!-- coverage-gap: AC4 (SilverBullet encrypted-KV wrapper usage) is a runtime/IDB behavioral property; no dedicated test describe block -->
<!-- coverage-gap: AC7 graft is unit-covered by token + drift-throw assertions (the served worker contains the .vault-key recovery branch); the live browser idle-termination + cold-boot recovery cycle against the real .vault-key endpoint is integration-verified (mobile, 2026-06-01), not unit-tested - which is what carries the REQ to Implemented. -->

**Intent:** SilverBullet's IndexedDB caches every vault file as raw bytes. This REQ covers encryption-at-rest with a per-session key generated and stored by the Container DO (no user passphrase prompt); IDB lifecycle cleanup on session DELETE and dashboard-mount sweeping lives in [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters). The threat model is BitLocker-grade: defeats offline disk attacks (profile theft, backup leak, ransomware scan), does NOT defeat anyone with an authenticated browser tab. The key dies with `container.destroy()` so deletion is forward-secret.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO generates a high-entropy random vault key on first start, persists it in its own storage, and returns the same key on every subsequent read.
2. The key is never rotated; it is wiped only when the container is destroyed (session delete).
3. The Worker's vault-config proxy fetches the vault key via DO RPC and merges it (plus the enable-encryption flag) into the editor's runtime boot config.
4. The editor uses the vault key to symmetrically encrypt its per-vault IndexedDB store via its built-in encrypted-KV wrapper.
5. The Worker delivers the key through a one-time bootstrap-hop page that registers SilverBullet's native service worker, posts the key to its native `set-encryption-key` handler, persists an enable-encryption flag, and sets a bootstrap-completed cookie before redirecting to the shell; the hop is issued only for GET requests, while HEAD and other methods fall through to the SB proxy so the readiness probe reports ready only when SB is serving. On failure it shows an error and aborts without setting the cookie or flag.
6. Subsequent shell-path requests bypass the bootstrap hop via the cookie, and no passphrase prompt is shown to the user.
7. The service worker recovers its encryption key from the Worker when its in-memory key is gone - whether the browser idle-terminated the SW, or the native worker flushed the key after the last client disconnected, or the key was simply never present yet at shell boot. A codeflare graft (`graftVaultKeyRecovery`) injects a `__cfRecover()` helper that re-fetches the key from the auth-gated `.vault-key` endpoint (a same-origin SW fetch carries the session cookie) and decodes it with the worker's own decoder, and calls it at BOTH of the worker's key-empty failure points before either gives up: the `config` message handler's `enableClientEncryption && !y` auth-gate (the path that actually fires - it posts an auth-error and the client navigates to `.auth` / "Authentication not enabled"), and the `get-encryption-key` reply. Without the graft the native worker bounces to `.auth` on cold boot, not just after idle, because the client posts `config` while the key is still absent from the bootstrap-hop -> shell transition flush.

**Constraints:**

- Encryption protects against offline attacks only. Anyone with an authenticated browser tab (or who can run JavaScript on the codeflare origin) can fetch the key from the config endpoint and decrypt. The threat-model trade-off is documented in [AD59](../../documentation/decisions/README.md#ad59-zero-ui-vault-encryption-with-per-session-do-storage-key) (`documentation/decisions/README.md`).
- The vault key must not be rotated mid-session. Rotation would orphan all existing IDB ciphertext on the browser and force a fresh re-sync on every container restart.
- The vault key must be wiped when the container is destroyed. Key persistence after deletion would let a recovered browser profile decrypt the orphaned IDB.
- The per-session identifier must remain in the proxy URL to preserve the parallel-session isolation property (each session has its own IDB; cross-session reads/writes never collide).
- The bootstrap-hop page guards against a missing `navigator.serviceWorker`, bounds SW activation with a 10-second timeout (`VAULT_SW_ACTIVATION_TIMEOUT_MS`, not the indefinite `navigator.serviceWorker.ready`), and treats the "redundant" SW lifecycle state as an explicit error.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor), [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions) (vault directory survives sessions), [REQ-MEM-006](memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode) (Pro mode gating)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

**Notes:** Encryption rides SilverBullet's native service worker (AD69): the bootstrap-hop posts the key to the native worker's `set-encryption-key` handler, and a codeflare graft (`graftVaultKeyRecovery`) adds `.vault-key` recovery at the worker's two key-empty checkpoints - the `config` auth-gate AND `get-encryption-key` (AC7). The first integration deploy (no graft) bounced to `.auth` on cold boot; a second (graft on `get-encryption-key` only) still bounced, which localized the real trigger to the `config` gate (it reads the key directly, never asking `get-encryption-key`); the graft now covers both. Verified on the integration deploy (mobile, 2026-06-01): cold boot reaches the editor with no `.auth` bounce, the console logs "Recovered encryption key from codeflare" (the graft fired because the hop's `set-encryption-key` had already been flushed), and the encrypted `sb_data_*` / `sb_files_*` stores open and decrypt.

---

### REQ-VAULT-015: Vault IDB lifecycle and listing filters

<!-- @impl: src/routes/vault-html.ts::filterVaultFsListing -->
<!-- @impl: src/routes/vault-html.ts::injectVaultIdbRecorder -->
<!-- @impl: src/routes/vault-html.ts::VAULT_IDB_RECORDER_MARKER -->
<!-- @impl: web-ui/src/lib/vault-cache.ts::cleanupSessionVaultCache -->
<!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches -->
<!-- @test: src/__tests__/routes/vault.test.ts (filterVaultFsListing + injectVaultIdbRecorder describes → AC1/AC3) -->
<!-- @test: web-ui/src/__tests__/lib/vault-cache.test.ts (cleanupSessionVaultCache + sweepOrphanVaultCaches real IDB deletion describe → AC3/AC4) -->
<!-- @test: host/__tests__/preseed-config-treeview.test.js (CONFIG.md treeview exclusions describe → AC2) -->

**Intent:** SilverBullet's IndexedDB caches and on-disk listings would otherwise persist across deletion and expose derived/internal directories to the user. This REQ covers cleanup on session DELETE, dashboard-mount sweeping for orphaned IDBs, and the listing filters that keep derived output and internal preseed pages out of the vault tree.

**Applies To:** User

**Acceptance Criteria:**

1. The vendored editor's filesystem-listing endpoint filters out the derived graph-output directory so build artifacts never reach the browser.
2. The preseed configuration page declares a treeview-exclusions block hiding the plug library, the library-manager mirror, the derived graph-output directory, and the four codeflare-authoritative root pages from the navigation tree.
3. The frontend runs a session-vault-cache cleanup on session delete (not on stop), which deletes every editor-owned IDB recorded for the session in browser storage (the recorder is populated at boot by a shim that wraps the IndexedDB open call), unregisters the vault service worker scoped to that session, and removes the session's persisted IDB-recorder entries.
4. On dashboard mount and on every session-list refresh, the frontend sweeps the persisted IDB-recorder entries and, for any session no longer in the user's active sessions list, deletes the recorded IDBs and drops the corresponding storage entries (covers the case where the session was deleted from another device).

**Constraints:**

- The library-manager mirror is the editor's own runtime-managed clone tree; the user does not curate it directly. The editor's internal config directory is dot-prefixed and hidden by the editor's default behavior; it requires no explicit rule.
- The IDB cleanup helpers must never enumerate via the browser's databases-listing API. They operate exclusively on the names recorded by the boot shim. Enumeration would re-introduce the regression where the live session's IDB was nuked on every dashboard mount, forcing a full editor resync on every reopen.

**Priority:** P0

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption), [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

### REQ-VAULT-009: Vault writes succeed end-to-end for SilverBullet attachment uploads

<!-- @impl: src/routes/vault-html.ts::maybeSynthesizeCsrfHeader -->
<!-- @impl: src/routes/vault-html.ts::inferOriginValidated -->
<!-- @impl: src/routes/vault-html.ts::maybeIssueCsrfCookie -->
<!-- @test: src/__tests__/routes/vault.test.ts (missing-Origin PUT path describe → AC1-AC4) -->

**Intent:** SilverBullet's drag-drop attachment upload (PUT `/api/vault/<sid>/Inbox/<file>`) must succeed when the user is authenticated, regardless of whether the browser's fetch implementation set the Origin header. The previous code path required Origin to be present and allowlisted before synthesising the CSRF guard header, so a service-worker-controlled fetch or a same-origin fetch that omitted Origin landed at the auth chain without X-Requested-With and was rejected. PDF uploads from the SB Inbox plug repeatedly surfaced this as a 401 to the user.

**Applies To:** User

**Acceptance Criteria:**

1. A state-changing request to a vault path with no Origin header is treated as same-origin and proceeds through CSRF synthesis. The synthesis adds the XHR-marker header so the downstream auth CSRF guard does not reject the write.
2. A state-changing request with an Origin header that fails the allowlist still returns a 403; the missing-Origin fallback does not widen the allowlist.
3. The forward chain preserves the request body bytes end-to-end (no double-read, no disturbed stream) on both the with-Origin and the no-Origin paths.
4. Existing read-only and preflight requests behave unchanged; only state-changing methods enter the fallback path.

**Constraints:**

- Modern browsers always set Origin on state-changing cross-origin requests; the fallback exists for the editor's same-origin path (where Origin is null or omitted) and for CLI-style clients. It does not bypass the allowlist when an Origin is present and disallowed.

**Priority:** P1

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Implemented

---

### REQ-VAULT-016: Vault graph extraction emits the canonical shared schema

<!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi vault-extract prompt emits the canonical file_type/source_file chunk schema + invokes the Pi-local merge-vault-graph.py → AC1; vault-extract prompt publishes viz to Raw/Graphs → AC2) -->
<!-- @cites: REQ-VAULT-003 (split-prose: the canonical-schema output contract foreshadowed in REQ-VAULT-003 AC4's extract-merge-advance step lands here) -->

**Intent:** The graph produced by vault extraction is structurally interchangeable with the repo and global graphs, and the re-rendered visualization is published where the vault index page can link to it. This is the output-shape contract; detection and dispatch latency are [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s).

**Applies To:** User

**Acceptance Criteria:**

1. The extracted graph uses the canonical graphify node/edge schema shared with the repo and global graphs: document and code nodes carry `file_type` and a truthy `source_file` so the global merge preserves their identity rather than label-merging them; concept nodes carry `file_type: "concept"` with `source_file: null` so the global merge dedupes them by label; edges carry a canonical `relation` plus `confidence`/`confidence_score`. The vault-extract subagent additionally emits a sub-section node for each markdown heading (level 2 and deeper) linked to its document by a `contains` edge. Both runtimes' vault-extract subagents emit this schema identically - the Pi subagent runs the same canonical chunk -> `merge-vault-graph.py` pipeline as Claude, with no separate in-process baseline; the legacy `type`/`path`/`mentions` shape is never written.
2. After merging, the extraction re-renders the vault viz HTML (`graphify cluster-only .` from the vault root) and copies `graph.html` to `Raw/Graphs/vault-graph.html` so the `Vault Graph.md` index-page link resolves through the SilverBullet `.fs/` route (`graphify-out/` is excluded from R2 bisync and the `.fs/` route). This publish step is non-fatal: a failure leaves a stale viz HTML but never blocks high-water-marker advancement, since the graph data is already persisted.

**Constraints:**

- The canonical-schema output (AC1) is verified by the Pi vault-extract prompt source assertions in `agent-seed-manifest.test.ts` (chunk schema + `merge-vault-graph.py` invocation); the viz publish (AC2) is verified by manual check (the cluster-only render + copy is prompt-driven prose, like [REQ-VAULT-011](#req-vault-011-vault-extract-ingests-pdf-files)), with the Pi prompt's publish step additionally source-asserted in `agent-seed-manifest.test.ts`.

**Priority:** P0

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---
