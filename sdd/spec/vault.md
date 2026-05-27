# Vault

Persistent Obsidian-style note vault: agent-written session captures plus user-curated prose, indexed into the unified graphify graph for cross-session memory queries.

**Domain owner:** entrypoint.sh, codeflare-vault plugin, graphify, SilverBullet, Worker `/api/vault` route

### Key Concepts

- **Vault** -- The persistent per-user vault directory holding markdown notes, pasted assets, and derived graph output. Attachment uploads land next to the note that referenced them; the dedicated raw-pasted directory is reserved for user-owned drag-drop. The vault is bisynced to R2 so it survives across sessions and is always present in the unified global graph (tagged as the user-vault source; never pruned by the active-repo prune-on-switch logic).
- **Capture Agent** -- The background subagent spawned by the memory-capture hook. Writes one markdown file per batch into the vault's raw-sessions subdirectory and merges it into the unified global graph. Pinned to Sonnet per AD58 (citation accuracy).
- **Vault-monitor Daemon** -- A polling loop in the entrypoint that watches for user-curated edits anywhere under the vault except the agent-written capture directory, the derived graph-output directory, the editor's internal config directory, and the four codeflare-authoritative root pages. When changes are found, writes a trigger marker. Uses a three-marker pattern (heartbeat, high-water, trigger) to avoid the daemon-advances-mtime-before-extraction-reads-it race.
- **Vault-extract Agent** -- The background subagent spawned by the vault-monitor hook. Runs single-file graph extraction on the changed files, merges the resulting subgraph into the unified global graph, and advances the high-water marker as its final step. Pinned to Sonnet per AD58 (the agent emits citations into the cross-session graph and a confabulated ID is worse than a missing one).
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
- **Session Lifecycle** -- The shutdown-bisync reliability work (REQ-VAULT-006) coordinates the orchestrator destroy budget with the final-sync watchdog so vault edits made in the last seconds before shutdown reach R2 instead of being silently lost.
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
5. If extraction fails, the markdown file stays on disk; the next vault-monitor tick re-discovers it via the high-water marker comparison.
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
<!-- @test: host/__audits__/entrypoint-vault.audit.js (three-marker pattern presence → AC2/AC6) -->

**Intent:** A user adds a note in SilverBullet (or any other editor) and within roughly one daemon tick the new content shows up in `mcp__graphify__*` query results.

**Applies To:** User

**Acceptance Criteria:**

1. The vault-monitor daemon polls the vault on a short fixed cadence, excluding the agent-written capture directory, the derived graph-output directory, the editor's internal config directory, and the four preseed-managed root pages. The four pages are codeflare-authoritative; the per-boot preseed copy must not count as a user edit, otherwise every preseed sync at boot would re-trigger extraction.
2. The daemon uses a three-marker pattern - a heartbeat marker, a high-water marker, and a trigger marker. The change-detection scan compares against the high-water marker (not the heartbeat) so a daemon that advances the wrong marker cannot lose work.
3. The hook handler exits immediately when the trigger marker is absent (zero-cost on idle prompts) or when an in-flight sentinel exists and is younger than 5 minutes (prevents duplicate agent spawns while extraction is running). When neither exit condition applies, it creates the in-flight sentinel and emits an additional-context directive instructing the main agent to dispatch the vault-extract subagent. The subagent runs at sonnet per AD58 (pinned at the subagent-definition level so the dispatching parent cannot silently downgrade the model).
4. The vault-extract subagent deletes the trigger marker as its first step (dedup gate), runs graph extraction per changed file, merges via the shared global-graph add command, touches the high-water marker, and removes the in-flight sentinel as its final step.
5. If any of the extract-merge-advance steps fail, the high-water marker is not advanced; the next daemon tick re-discovers the same files.
6. The vault initializer bumps the high-water marker after rewriting any preseed page so the first post-boot daemon tick does not interpret the preseed copy as a user change. This is belt-and-braces for any future preseed page that misses the daemon-exclusion list.

**Constraints:**

- The polling cadence is intentional; inotify was rejected as overkill for the expected edit rate.
- The in-flight sentinel (5-minute TTL) prevents the hook from re-spawning the agent on every prompt while extraction is already running. The sentinel is created by the hook on emission and removed by the agent as its final step.
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

**Priority:** P1

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** Manual check

**Status:** Partial

<!-- coverage-gap: PDF error-path ingestion (AC4 - corrupt/password-protected/unsupported-encoding read failures emitting bare node + high-water marker advance) has no dedicated automated test -->

---

### REQ-VAULT-004: Unified global graph merges vault and active repos

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py::_resolve_active -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (mcp-lazy resolution chain + active-repo hook structure + vault basename exclusion + fast-path skip → AC1-AC4) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-VAULT-004: titleFor heading extraction + wikilink concept nodes + PDF document nodes + flock global merge -> AC2/AC3 Pi vault graph content) -->

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
<!-- @impl: src/routes/vault.ts::validateVaultRoute -->
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
<!-- @test: web-ui/src/__tests__/lib/vault-readiness.test.ts (startVaultReadinessProbe describe → no-give-up retry / first-success latch / SB-crash recovery / cancel / mid-probe cancel → AC5) -->

**Intent:** The Vault button only appears when usable and only enables after a per-session probe confirms the in-container editor is actually reachable, so users never land on `VAULT_UPSTREAM_UNREACHABLE`. SilverBullet's landing page is the codeflare dashboard. SilverBullet subpath asset adaptation lives in [REQ-VAULT-013](#req-vault-013-silverbullet-subpath-adapter).

**Applies To:** User

**Acceptance Criteria:**

1. The Vault control in the header renders only when an active session exists and the parent surface has wired up the vault-open handler; the control is scoped to the terminal view alongside the related Bookmarks and Storage entrypoints.
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
<!-- @impl: src/routes/vault.ts::rewriteVaultBaseHref -->
<!-- @impl: src/routes/vault.ts::rewriteVaultHtmlResponse -->
<!-- @test: src/__tests__/routes/vault.test.ts (rewriteVaultBaseHref / rewriteVaultHtmlResponse (REQ-VAULT-013 AC1-AC4) + isServiceWorkerRegistration / REQ-VAULT-013 (SilverBullet subpath adapter) → AC1-AC7) -->

**Intent:** SilverBullet ships an SPA shell with `<base href="/" />` and assumes it owns its origin; under the `/api/vault/:sid/` per-session proxy, every relative asset request would otherwise resolve against the Worker root and 404. The Worker injects a per-session base href on every text/html response and short-circuits Service Worker registration so the browser's SW fetch does not return 401.

**Applies To:** User

**Acceptance Criteria:**

1. The vault proxy rewrites the bare HTML base-href to the per-session vault-proxy path on every HTML response (not gated to the root path), so the editor's relative asset references resolve back through the subpath proxy regardless of which page the user reloaded onto.
2. Non-HTML responses (JS bundles, images, manifests, markdown page bodies, JSON API replies, binary assets) pass through unchanged; the HTML-only guard is sufficient because the editor's API endpoints return non-HTML content types.
3. When the body is rewritten, both the content-length and content-encoding headers are dropped because the rewrite path auto-decompresses upstream compression, and the original headers would otherwise trigger a browser decoding failure.
4. When the rewrite runs but the body did not contain the expected base-href substring (no-op rewrite), a warning is logged so a future editor-template change surfaces as a logged signal instead of a silent white-screen regression.
5. Browser-initiated Service Worker registration GETs for the editor's service-worker script short-circuit the auth chain and receive a key-shim service worker from the Worker (see [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption) AC5 for the key-delivery contract).
6. The short-circuit selector requires all of: GET method, exact path match for the service-worker script, and the browser-only Service-Worker request header (a Fetch-spec forbidden header name not settable from page JavaScript). Cookie presence is intentionally not checked because Samsung Internet and other Chromium forks may send cookies on SW registration fetches; rejecting those requests would serve the editor's real SW whose cache.addAll() install fails and hangs the bootstrap page.
7. The key-shim service-worker script body is identical across sessions; the per-session vault encryption key is delivered to the shim via postMessage from the bootstrap-hop page (REQ-VAULT-008 AC5), not baked into the script.

**Constraints:**

- The editor honors a URL-prefix environment variable for rendering the base tag, but the prefix is per-session (the Worker knows the session ID, the container does not); baking it in at supervisor start is not viable, so the per-response Worker rewrite is the per-session adapter.
- Browsers omit credentials on service-worker script fetches (Chrome 76+ per spec, Samsung Internet and other Chromium forks may not), so the normal cookie-auth path would return 401 and service-worker registration would fail permanently without this short-circuit. The selector is browser-agnostic: it works regardless of whether cookies are present.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

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

- The pre-spawn hash check in REQ-VAULT-004 AC2 uses a SHA-256 digest truncated to the graph builder's standard tag length with a length sanity-guard so a malformed digest cannot poison the comparison.
- The graphify skill's commit step is one of the write sites and must include a locked global-add call so a fresh build lands in the global graph.

**Priority:** P0

**Dependencies:** [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-VAULT-006: Shutdown bisync completes vault writes before SIGKILL

<!-- @impl: entrypoint.sh::shutdown_handler -->
<!-- @impl: src/container/index.ts::destroy -->
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

- Bundled with the vault PR because vault edits that have not yet synced when the final bisync watchdog expires are silently lost the same way session state would be; the vault depends on bisync reliability.
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

<!-- @impl: src/container/index.ts::ensureVaultKey -->
<!-- @impl: src/routes/vault.ts::VAULT_KEY_SHIM_SERVICE_WORKER_JS -->
<!-- @impl: src/routes/vault.ts::injectVaultBootstrapHopHtml -->
<!-- @impl: src/routes/vault.ts::injectVaultIdbRecorder -->
<!-- @impl: src/routes/vault.ts::VAULT_BOOTSTRAP_COOKIE -->
<!-- @impl: src/routes/vault.ts::VAULT_SW_ACTIVATION_TIMEOUT_MS -->
<!-- @impl: src/routes/vault.ts::handleVaultRequest (.vault-key sub-path) -->
<!-- @impl: web-ui/src/lib/vault-cache.ts::cleanupSessionVaultCache -->
<!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches -->
<!-- @test: src/__tests__/container/index.test.ts (ensureVaultKey persistence + idempotency describe → AC1/AC2) -->
<!-- @test: src/__tests__/routes/vault.test.ts (injectVaultEncryptionConfig + injectVaultBootScript + injectVaultBootstrapHopHtml + hasVaultBootstrapCookie describes → AC3/AC5/AC6; VAULT_KEY_SHIM_SERVICE_WORKER_JS SW lifecycle describe → AC7 activate/recoverKey path) -->
<!-- coverage-gap: AC4 (SilverBullet encrypted-KV wrapper usage) is a runtime/IDB behavioral property; no dedicated test describe block -->
<!-- coverage-gap: AC7 fetch-on-activate exercised in Node.js SW shim (ok:false mock); real browser idle-termination cycle with live .vault-key endpoint not covered by automated tests -->

**Intent:** SilverBullet's IndexedDB caches every vault file as raw bytes. This REQ covers encryption-at-rest with a per-session key generated and stored by the Container DO (no user passphrase prompt); IDB lifecycle cleanup on session DELETE and dashboard-mount sweeping lives in [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters). The threat model is BitLocker-grade: defeats offline disk attacks (profile theft, backup leak, ransomware scan), does NOT defeat anyone with an authenticated browser tab. The key dies with `container.destroy()` so deletion is forward-secret.

**Applies To:** User

**Acceptance Criteria:**

1. The Container DO generates a high-entropy random vault key on first start, persists it in its own storage, and returns the same key on every subsequent read.
2. The key is never rotated; it is wiped only when the container is destroyed (session delete).
3. The Worker's vault-config proxy fetches the vault key via DO RPC and merges it (plus the enable-encryption flag) into the editor's runtime boot config.
4. The editor uses the vault key to symmetrically encrypt its per-vault IndexedDB store via its built-in encrypted-KV wrapper.
5. The Worker delivers the key through a one-time bootstrap-hop page that registers a key-shim service worker, posts the key to it, persists an enable-encryption flag in the browser, and sets a bootstrap-completed cookie before redirecting back to the shell. The bootstrap-hop redirect is issued only for GET requests; HEAD and other methods fall through to the SB proxy so the readiness probe returns 200 only when SB is genuinely serving. The hop page guards against missing `navigator.serviceWorker`, uses a 10-second timeout on SW activation (instead of the indefinite `navigator.serviceWorker.ready`), and detects the "redundant" SW state as an explicit error. On any failure the hop shows a user-visible error message and aborts without setting the cookie or flag.
6. Subsequent shell-path requests bypass the bootstrap hop via the cookie, and no passphrase prompt is shown to the user.
7. The key-shim service worker recovers its encryption key from the Worker when the browser terminates and re-activates the SW after idle. The Worker exposes an auth-gated endpoint that returns the key; the SW fetches it on activate and as a fallback when a get-encryption-key message arrives with no key in memory.

**Constraints:**

- Encryption protects against offline attacks only. Anyone with an authenticated browser tab (or who can run JavaScript on the codeflare origin) can fetch the key from the config endpoint and decrypt. The threat-model trade-off is documented in AD59 (`documentation/decisions/README.md`).
- The vault key must not be rotated mid-session. Rotation would orphan all existing IDB ciphertext on the browser and force a fresh re-sync on every container restart.
- The vault key must be wiped when the container is destroyed. Key persistence after deletion would let a recovered browser profile decrypt the orphaned IDB.
- The per-session identifier must remain in the proxy URL to preserve the parallel-session isolation property (each session has its own IDB; cross-session reads/writes never collide).

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor), [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions) (vault directory survives sessions), [REQ-MEM-006](memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode) (Pro mode gating)

**Verification:** [Automated test](../../src/__tests__/routes/vault.test.ts)

**Status:** Partial

---

### REQ-VAULT-015: Vault IDB lifecycle and listing filters

<!-- @impl: src/routes/vault.ts::filterVaultFsListing -->
<!-- @impl: src/routes/vault.ts::injectVaultIdbRecorder -->
<!-- @impl: src/routes/vault.ts::VAULT_IDB_RECORDER_MARKER -->
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

<!-- @impl: src/routes/vault.ts::maybeSynthesizeCsrfHeader -->
<!-- @impl: src/routes/vault.ts::inferOriginValidated -->
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
