# Vault

Persistent Obsidian-style note vault: agent-written session captures plus user-curated prose, indexed into the unified graphify graph for cross-session memory queries.

**Domain owner:** entrypoint.sh, codeflare-vault plugin, graphify, SilverBullet, Worker `/api/vault` route

### Key Concepts

- **Vault** -- The persistent directory at `/home/user/Vault/` holding markdown notes, pasted assets, and derived graphify output. SilverBullet writes attachment uploads next to the note that referenced them, not into `Raw/Pasted/` (`Raw/Pasted/` is user-owned drag-drop only). Bisynced to R2 to survive across sessions. Always-on in the unified global graph: tagged `user_vault` from entrypoint init, never pruned by the active-repo prune-on-switch logic.
- **Capture Agent** -- The background sonnet agent spawned by the memory-capture UserPromptSubmit hook. Writes one markdown file per 15-prompt batch into `Raw/Sessions/` and merges it into the unified global graph. Sonnet (not haiku) per AD58.
- **Vault-monitor Daemon** -- A 60s polling loop in entrypoint.sh that watches for user-curated edits anywhere under `/home/user/Vault/` except the exclusion list (`Raw/Sessions/`, `graphify-out/`, `.silverbullet/`, and the four codeflare-authoritative root pages). Writes a trigger marker (`vault-extract.vars`) when changes are found. Uses the three-marker pattern (tick / high-water / trigger) to avoid the daemon-advances-mtime-before-extraction-reads-it race.
- **Vault-extract Agent** -- The background sonnet agent spawned by `vault-monitor-hook.sh`. Runs graphify single-file extraction on the changed files, merges the resulting subgraph into the unified global graph, and advances the high-water marker as its final step. Sonnet (not haiku) per AD58: vault-extract emits citations into the cross-session graph and a confabulated ID is worse than a missing one.
- **Unified Global Graph** -- `~/.graphify/global-graph.json`. Hash-keyed merge of every per-repo graphify-out plus the vault's own graph, kept in sync by `graphify global add` calls under `flock -w 5 /tmp/graphify-global.lock`. The graphify MCP wrapper prefers this graph when present so `mcp__graphify__*` tool calls return a unified view.
- **SilverBullet** -- The Deno-compiled markdown editor (`silverbullet-server-linux-x86_64`) bound to `127.0.0.1:3030` inside the container. Reachable from the codeflare UI through the Worker proxy at `/api/vault/:sid/`. Auth boundary lives at the Worker.

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
- Per-session `syncConcurrency` tuning for SilverBullet's sync engine. The value is a hardcoded module-level constant in SB 2.8 (`client/spaces/sync.ts:9`, value=3) and is not configurable via BootConfig. The cold-start latency delta between the SB default and a forked 15 is small at typical vault sizes (<1k files) and not worth maintaining a fork.
- Lazy attachment loading for paths under `Raw/Pasted/**`. SB pastes attachments alongside the note they were dropped into, not under a centralised `Raw/Pasted/` tree, so the lazy-prefix optimisation has no real workload to apply to.

### Domain Dependencies

- **Memory** -- Reuses the `memory-capture.sh` UserPromptSubmit hook and `~/.memory/counter/` state. The capture agent writes Step 4's output into the vault (MCP server-memory has been removed from the stack); the dedup gate (`.vars` marker) is unchanged.
- **Storage** -- Vault persistence is provided by the existing rclone bisync to R2. One new include filter (`+ Vault/**`) is added to `RCLONE_FILTERS_COMMON`, ordered BEFORE the existing `**/graphify-out/**` exclude so first-match semantics keep vault content sync'd.
- **Session Lifecycle** -- The bundled shutdown bisync reliability fix raises the DO `destroy()` SIGTERM-to-SIGKILL budget to 135s, so the entrypoint's final bisync (120s watchdog) can complete cleanly. Without this, vault edits made in the last seconds before shutdown were silently lost to R2.
- **Subscription** -- Vault features (preseed entries, SilverBullet supervisor) are gated to advanced session mode via the existing manifest mode filter (`"modes": ["advanced"]` on every new preseed entry).

---

### REQ-VAULT-001: Persistent vault directory survives across sessions

<!-- @impl: entrypoint.sh::init_user_vault -->
<!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (filter order + init function presence + Uploads/Temporary mkdir + supervisor uses $HOME/Vault → AC1-AC5) -->
<!-- @test: web-ui/src/__tests__/lib/special-folders.test.ts (special-folders registry describe → Workspace/Vault/Uploads/Temporary entries + tooltips → AC6) -->

**Intent:** A user opens a new session and finds their previous notes, captures, and pasted assets intact -- the same way the rest of `/home/user/` survives. This REQ covers the directory skeleton, rclone filter coverage, and storage-panel surfacing of the special folders; codeflare-authoritative file preseeding is in [REQ-VAULT-010](#req-vault-010-codeflare-authoritative-files-preseeded-into-the-vault-on-every-boot).

**Applies To:** User

**Acceptance Criteria:**

1. `/home/user/Vault/` is included in `RCLONE_FILTERS_COMMON` with `+ Vault/**`, placed BEFORE the existing `- **/graphify-out/**` exclude so the vault's own `graphify-out/` subdirectory rides along.
2. The `.graphify/` directory (ephemeral global-graph workspace) is excluded with `- .graphify/**` so the merged graph is regenerated on boot from the per-source `graphify-out/` files rather than carrying stale state across sessions.
3. `init_user_vault()` creates the vault subdirectories (`Raw/Sessions`, `Raw/Pasted`, `Notes`, `graphify-out`, `.silverbullet/_plug`) via `mkdir -p` on every boot so a user who deletes any of them cannot leave the agent hooks or SilverBullet in a broken state on the next session start.
4. `init_user_vault()` runs AFTER `establish_bisync_baseline()` and BEFORE the daemon launch block, so we never write the empty skeleton over R2-restored content.
5. `init_user_vault()` also `mkdir -p`s `/home/user/Uploads` and `/home/user/Temporary` alongside the vault. Both folders are persistent (`RCLONE_FILTERS_COMMON` includes `+ Uploads/**` and `+ Temporary/**`, placed BEFORE the global graphify-out exclude) so a file dropped into either survives session restart and is visible in the storage panel and from every device.
6. The R2 storage panel surfaces Workspace, Vault, Uploads, and Temporary as "special folders" at the bucket root: each appears unconditionally (Workspace gated by the workspace-sync preference), each renders an info icon that toggles a tooltip showing the folder's purpose and the in-container path it materialises at (`/home/user/Workspace`, `/home/user/Vault`, `/home/user/Uploads`, `/home/user/Temporary`).

**Constraints:**

- The vault is committed to the same R2 bucket as `/home/user/workspace` -- no two-bucket separation.
- Vault content is per-user (each user has their own R2 bucket).
- The vault directory MUST live at a non-hidden basename (`Vault`, not `.user_vault` or any other dot-prefixed path). SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the walk when the root basename starts with `.`, returning an empty file listing even when notes are on disk.

**Priority:** P0

**Dependencies:** [REQ-STOR-002](storage.md#req-stor-002-file-persistence-across-sessions) (file persistence across sessions), [REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers) (15-min bisync), [REQ-STOR-004](storage.md#req-stor-004-initial-sync-restores-files-on-container-start) (initial sync restores files on container start)

**Verification:** Structural audit

**Status:** Implemented

---

### REQ-VAULT-010: Codeflare-authoritative files preseeded into the vault on every boot

<!-- @impl: entrypoint.sh::init_user_vault -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (per-boot preseed-page sync loop + graph.json recreate-if-missing guard + preseed-page existence on disk → AC1-AC5) -->

**Intent:** A defined set of vault files are codeflare-authoritative: SilverBullet widgets, wikilink handlers, theming, and the graph build all depend on their contents being current at boot. User edits to these files are intentionally not preserved, and stale build artefacts that mislead the user must be cleared on every boot.

**Applies To:** User

**Acceptance Criteria:**

1. `init_user_vault()` copies `Index.md`, `CONFIG.md`, `README.md`, and `STYLES.md` from `/opt/silverbullet-preseed/` into the vault root on every boot, gated so identical files are not rewritten.
2. User content lives in `Notes/`, `Inbox/`, `Journal/`, `Raw/Pasted/`, and `Raw/Sessions/` and is never touched by the preseed sync; only the four codeflare-authoritative pages are overwritten.
3. The entrypoint MUST NOT copy a partial `Library/Std/` onto disk because `Library/Std` and its compiled `*.plug.js` are served from the SilverBullet binary's built-in `base_fs` overlay, and a partial on-disk copy would shadow `base_fs` with incomplete files and brick widget rendering.
4. `~/Vault/graphify-out/graph.json` is seeded with the empty-graph JSON stub only when absent; the populated graph from a prior session is never overwritten by the entrypoint.
5. `init_user_vault()` removes `Raw/Graphs/Global Graph.md` and `Raw/Graphs/global-graph.html` on every boot when present (idempotent `rm -f`, guarded so it fires only when the preseed counterpart is also absent).

**Constraints:**

- The four authoritative pages are kept current because SilverBullet's dashboard widgets, in-page wikilink handlers, and codeflare theming depend on their contents being current; user edits to them are intentionally not preserved across boots.
- `CONFIG.md` is a runtime contract, not user content. SilverBullet 2.x reads it as a `#meta` page with an optional `space-lua` config block (yaml blocks and the `pageBlackList`/`libraries` keys claimed by earlier releases are unrecognized by SB 2.x and were always no-ops). This is why CONFIG.md lives in the always-overwrite tier (AC1) and not in the user-editable tier.
- The SilverBullet Go server hardcodes `IndexPage` to lowercase `"index"` (`server/cmd/server.go:29`). The supervisor MUST export `SB_INDEX_PAGE=Index` before launching the binary so the TitleCase `Index.md` preseed page is what loads at `/`. `.silverbullet/config.yaml` is NOT read for this setting - it was a dead file in prior releases and is removed from preseed.
- The graph.json seed-only-if-absent rule (AC4) exists because the graph is build output regenerated by `graphify extract` / `graphify global add`, not preseed content.
- The `Global Graph.md` / `global-graph.html` removal (AC5) exists because the unified global graph is too large for useful HTML visualisation (10k+ nodes); structural queries via `mcp__graphify__*` are the real interface and the vault viz covers the user-curated slice. Vaults restored from R2 snapshots predating the removal are reconciled on the next boot.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Structural audit

**Status:** Implemented

---

### REQ-VAULT-002: Conversation captures land in the vault as markdown

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (vault-monitor and capture script structure → AC1-AC6) -->

**Intent:** The capture agent writes one markdown file per 15-prompt batch into `Raw/Sessions/`, replacing the previous MCP-memory write path. Captures appear in `mcp__graphify__*` queries the same turn they are written.

**Applies To:** User

**Acceptance Criteria:**

1. `memory-agent-prompt.md` Step 4 writes the capture file at `/home/user/Vault/Raw/Sessions/{ISO_TS}-{SID_SHORT}.md` using the YAML-frontmatter + Context/Decisions/Observations/References template.
2. Concept references use `[[wikilinks]]`; file paths, code symbols, and PR/issue references stay as prose.
3. The capture agent builds the vault graph inline: sonnet emits chunk JSON matching graphify's schema, then a Python step calls `graphify.build` / `graphify.cluster` / `graphify.export.to_json` to materialise the per-extraction graph.
4. The agent merges the per-extraction graph into the unified graph via `flock -w 5 /tmp/graphify-global.lock graphify global add ... --as user_vault`.
5. If extraction fails, the markdown file stays on disk and the next vault-monitor tick will re-discover it via the high-water marker comparison.
6. The MCP `server-memory` subsystem (`mcp__memory__*`) has been removed entirely; the capture agent does not invoke it, and no historical JSONL graph is read.

**Constraints:**

- The dedup gate (`.vars` marker delete as the agent's first step) is unchanged from the pre-vault flow.
- Compaction is not automated; the user prunes `Raw/Sessions/` manually via SilverBullet when the directory becomes unwieldy.
- The headless `graphify extract` CLI is intentionally bypassed per [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) AC6: codeflare ships no LLM provider key for graphify and the capture agent IS the LLM, so re-invoking the CLI would duplicate inference cost with no benefit.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Structural audit

**Status:** Implemented

---

### REQ-VAULT-003: User-curated edits are detected and ingested within ~60s

<!-- @impl: entrypoint.sh::start_vault_monitor_daemon -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (three-marker pattern presence → AC2/AC6) -->

**Intent:** A user adds a note in SilverBullet (or any other editor) and within roughly one daemon tick the new content shows up in `mcp__graphify__*` query results.

**Applies To:** User

**Acceptance Criteria:**

1. The vault-monitor daemon polls the vault every 60s, excluding `Raw/Sessions/`, `graphify-out/`, `.silverbullet/`, and the four preseed-managed root pages (`Index.md`, `CONFIG.md`, `README.md`, `STYLES.md`) from the find. The four pages are codeflare-authoritative (see REQ-VAULT-010 AC1); agent-side `cp` from preseed must not count as a user edit, otherwise every preseed sync at boot re-triggers extraction.
2. The daemon uses a three-marker pattern: `vault-monitor.tick` (heartbeat), `vault-extract.last` (high-water mark), `vault-extract.vars` (trigger). The find compares against `vault-extract.last`, NOT the tick, so a daemon that advances the wrong marker cannot lose work.
3. The vault-monitor UserPromptSubmit hook exits 0 immediately when `vault-extract.vars` is absent (zero-cost on idle prompts) and emits `additionalContext` instructing the main agent to dispatch the vault-extract named subagent when present. The subagent runs as sonnet per AD58 (pinned at the subagent-definition level so the dispatching parent cannot silently downgrade the model).
4. The vault-extract subagent deletes `vault-extract.vars` as its first step (dedup gate), runs graphify extraction per changed file, merges via `graphify global add`, and touches `vault-extract.last` as its final step.
5. If steps 2-4 fail, the high-water marker is NOT advanced; the next daemon tick (within 60s) re-discovers the same files.
6. `init_user_vault()` bumps `vault-extract.last` after rewriting any preseed page, so the first post-boot daemon tick does not pick up the `cp` as a user change. Belt-and-braces for any future preseed page that misses the AC1 daemon-exclusion list.

**Constraints:**

- The 60s poll is intentional -- inotify was rejected as overkill for the expected edit rate.
- The dedup gate prevents the hook from re-spawning the agent on every prompt while extraction is in flight.
- PDF ingestion specifics are split into [REQ-VAULT-011](#req-vault-011-vault-extract-ingests-pdf-files).

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Structural audit

**Status:** Implemented

---

### REQ-VAULT-011: Vault-extract ingests PDF files

<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md -->
<!-- @test: documentation/lanes/vault.md (PDF-ingestion E2E plan → drop .pdf into Raw/Pasted, daemon tick, document node in global graph + corrupt-PDF bare-node path → AC1-AC4) -->

**Intent:** PDFs dropped into the vault (typically under `Raw/Pasted/`) must be ingested into the global graph as first-class content, not skipped as binary. The agent reads each PDF, emits a `document` node plus extracted `concept` nodes, and links to sibling notes that wikilink the same file. Corrupt or unreadable PDFs must not block ingestion of healthy files.

**Applies To:** User

**Acceptance Criteria:**

1. PDF files in the changed-files list are ingested, not skipped as binary.
2. The vault-extract agent reads each PDF (capped at 20 pages for large files), emits a `document` node for the PDF plus `concept` nodes for visible title text, headings, named entities, and diagrams.
3. When a sibling `.md` note wikilinks the same PDF, a `cites` edge connects the document node to the wikilink concept so the global graph unifies them.
4. Read-tool failures on PDFs (corrupt, password-protected, unsupported encoding) emit the bare document node only; the high-water marker still advances so a single unreadable PDF does not block ingestion of other changed files.

**Constraints:**

- The 20-page cap is a Read-tool limit; PDFs longer than 20 pages are partially ingested rather than rejected.

**Priority:** P1

**Dependencies:** [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-VAULT-004: Unified global graph merges vault + active repos

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-mcp-lazy.py::_resolve_active -->
<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (mcp-lazy resolution chain + active-repo hook structure + vault basename exclusion + fast-path skip → AC1-AC4) -->

**Intent:** A single `mcp__graphify__*` call returns nodes from the vault and from every per-repo graphify-out the session has touched, so cross-cutting questions ("did we ever discuss X with respect to Y") work without manually selecting a graph.

**Applies To:** Agent

**Acceptance Criteria:**

1. `graphify-mcp-lazy.py:_resolve_active()` prefers `~/.graphify/global-graph.json` when present, falling back to the sentinel-pinned per-repo graph and then to the freshest workspace-mtime graph.
2. The active-repo hook runs `flock -w 5 /tmp/graphify-global.lock graphify global add <repo>/graphify-out/graph.json --as <basename>` whenever the resolved active repo has a graph and either (a) the manifest does not yet record this `<basename>` or (b) the manifest's recorded `source_hash` for this `<basename>` does not match the current graph.json hash.
3. The vault directory at `$HOME/Vault` is explicitly excluded from active-repo candidate resolution: when the walk-up loop reaches that path, the hook exits 0 without rewriting the sentinel or invoking `graphify global add`, so the vault is never re-tagged as `Vault` (basename) by a tool call that happens to touch a vault file.
4. A cheap fast-path skip avoids spawning graphify on every Bash/Edit/Write/ctx_execute call: when the resolved active-repo path equals the prior sentinel value AND `graphify-out/graph.json`'s mtime is not newer than the sentinel's mtime, the hook returns immediately, and the sentinel is `touch`-bumped at the end of every non-fast-path fire so subsequent fires can short-circuit until the next graph rebuild.
5. Single-active-repo invariant and multi-writer lock serialisation are specified in [REQ-VAULT-014](#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation).

**Constraints:**

- `graphify global add` is hash-keyed and idempotent; re-running with the same `graph.json` is a no-op.
- The `--as <tag>` argument is the per-source label used by `graphify global` to distinguish vault nodes from per-repo nodes.
- Branch-level granularity is not represented in the global manifest. A repo's tag is its directory basename; branch switches within the same repo refresh the entry via the AC2 hash-diff path once the user has rebuilt the graph on the new branch (`graphify update` or `/graphify`). Until the rebuild runs, the global graph still shows the prior branch's nodes under the same tag - an acceptable staleness window since automatic rebuild on every checkout would be too expensive.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions), [REQ-VAULT-002](#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-VAULT-003](#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)

**Verification:** Structural audit

**Status:** Implemented

---

### REQ-VAULT-005: Worker proxy exposes the in-container vault editor

<!-- @impl: src/routes/vault.ts::handleVaultRequest -->
<!-- @impl: src/routes/vault.ts::validateVaultRoute -->
<!-- @impl: entrypoint.sh::start_silverbullet_supervisor -->
<!-- @test: src/__tests__/routes/vault.test.ts (validateVaultRoute boundary cases describe → AC3/AC5) -->

**Intent:** Clicking the Vault button in the codeflare UI opens SilverBullet in a new tab, behind the same auth + rate-limit boundary as every other tier-gated session feature. This REQ covers the in-container server, the auth/rate-limit proxy plumbing, and the host-side HTTP+WS branch; UX integration and SilverBullet subpath adaptation live in [REQ-VAULT-012](#req-vault-012-vault-editor-ux-integration-and-subpath-adapter).

**Applies To:** User

**Acceptance Criteria:**

1. The Dockerfile installs the `silverbullet-server-linux-x86_64` binary at `/usr/local/bin/silverbullet`, pinned by version + SHA256.
2. The container entrypoint supervises the SilverBullet server on `127.0.0.1:3030` with a 5s restart loop so an editor crash never requires a container restart.
3. The vault-route handler applies the same auth chain as the terminal WebSocket upgrade: `authenticateRequest`, origin allowlist, `getEffectiveTier` + `isActiveUser`, session ownership, container health probe, container fetch.
4. WebSocket upgrades for live-edit sync are rate-limited under the same per-user `ws-connect:<email>` key as terminal WebSockets so a separate budget cannot be discovered.
5. The host terminal server exposes a `/vault/*` HTTP branch (strip prefix + `http.request` to `127.0.0.1:3030`) and a WS upgrade passthrough via a `noServer: true` WebSocketServer that handles only `/vault/*` paths.

**Constraints:**

- SilverBullet is bound to localhost only -- the Worker proxy is the only externally reachable surface.
- The `/api/vault/:sid/status` Hono endpoint runs through the normal middleware chain; only the catch-all proxy is intercepted before Hono.
- For body-bearing methods (PUT/POST/PATCH), `container.fetch` must be called with the Request returned by `maybeSynthesizeCsrfHeader`, not the original incoming `request`. The helper consumes the input body when it constructs the header-rewritten clone, so forwarding the original raises a Workers `TypeError: This ReadableStream is disturbed`. AC3's auth chain must read only headers (cookies, JWT assertion); body consumption inside `authenticateRequest` would also break this invariant.

**Priority:** P0

**Dependencies:** [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-VAULT-012: Vault button render and readiness gating

<!-- @impl: web-ui/src/components/Header.tsx -->
<!-- @test: web-ui/src/__tests__/components/Header.test.tsx (Header describe → Vault button gating + readiness probe state machine → AC1-AC5) -->

**Intent:** The Vault button only appears when usable and only enables after a per-session probe confirms the in-container editor is actually reachable, so users never land on `VAULT_UPSTREAM_UNREACHABLE`. SilverBullet's landing page is the codeflare dashboard. SilverBullet subpath asset adaptation lives in [REQ-VAULT-013](#req-vault-013-silverbullet-subpath-adapter).

**Applies To:** User

**Acceptance Criteria:**

1. The Vault button in `Header.tsx` renders only when an active session exists and the parent passes `onVaultOpen` (gated to terminal view, between Bookmarks and Storage).
2. SilverBullet opens to the `Index` page (the codeflare dashboard) on every Vault button click, via `SB_INDEX_PAGE=Index` exported in the supervisor before launching the binary.
3. The README page is reachable from the dashboard via a link at the top.
4. The Vault button is rendered disabled with tooltip "Vault initializing..." until a per-session ground-truth probe against the vault proxy responds 200.
5. The probe retries on a short interval until the first success, then enables the button; the readiness state is keyed per session so switching active sessions resets it.

**Constraints:**

- The readiness probe guards both the cold-boot race (the editor supervisor binds its localhost port later than terminal readiness flips) and the crashed-editor scenario (container up, editor process dead); both would otherwise surface `VAULT_UPSTREAM_UNREACHABLE` to the user.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-VAULT-013: SilverBullet subpath adapter

<!-- @impl: src/routes/vault.ts::handleVaultRequest -->
<!-- @test: src/__tests__/routes/vault.test.ts (base-href rewrite + service-worker shortcut describe → AC1-AC7) -->

**Intent:** SilverBullet ships an SPA shell with `<base href="/" />` and assumes it owns its origin; under the `/api/vault/:sid/` per-session proxy, every relative asset request would otherwise resolve against the Worker root and 404. The Worker injects a per-session base href on every text/html response and short-circuits Service Worker registration so Chrome's credentialless SW fetch does not return 401.

**Applies To:** User

**Acceptance Criteria:**

1. `handleVaultRequest` rewrites `<base href="/" />` to `<base href="/api/vault/<sid>/" />` on every `text/html` response (not gated to `/` or `/index.html`), so SilverBullet's relative asset references resolve back through the subpath proxy regardless of which page the user reloaded onto.
2. Non-HTML responses (JS bundles, PNG icons, manifest JSON, `text/markdown` page bodies, `application/json` API replies, binary assets) pass through unchanged; the text/html guard alone is sufficient because SilverBullet's API endpoints return non-HTML content types.
3. When the body is rewritten, both `content-length` and `content-encoding` headers are dropped because `response.text()` auto-decompresses gzip/br upstream and the original headers would otherwise trigger a browser decoding failure.
4. When the rewrite runs but the body did not contain the bare `<base href="/" />` (no-op rewrite), a warning is logged so a future SilverBullet template change surfaces as a logged signal instead of a silent white-screen regression.
5. Browser-initiated Service Worker registration GETs at `/api/vault/<sid>/service_worker.js` short-circuit the auth chain and receive a static no-op SW from the Worker.
6. The short-circuit selector requires all of: method `GET`, exact path `/service_worker.js`, request header `Service-Worker: script` (a Fetch-spec forbidden header name, not settable from page JavaScript), and no `Cookie` header.
7. The static SW JS contains zero user data and is identical across sessions; the cookie-absent gate is defence-in-depth so that any future browser path that carries credentials falls through to the normal auth chain instead of the static-noop shortcut.

**Constraints:**

- SilverBullet 2.8.0 honours `SB_URL_PREFIX` to render the base tag with a prefix, but the prefix is per-session (the worker knows `:sid`, the container does not); baking it in at supervisor start is not viable, so the per-response Worker rewrite is the per-session adapter.
- Chrome 76+ omits credentials on `navigator.serviceWorker.register()` script fetches even for same-origin same-site URLs, so the normal cookie-auth path would return 401 and SW registration would fail permanently without this short-circuit.

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-VAULT-014: Graphify active-repo invariant and lock serialisation

<!-- @impl: preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (single-active-repo invariant + lock serialisation across write sites → AC1-AC4) -->

**Intent:** Concurrent agent flows must not corrupt the global graph, and the global graph must never accumulate stale per-repo entries when the user switches between repos. This REQ specifies the single-active-repo invariant and the cross-writer lock serialisation that keep the global graph well-formed under contention.

**Applies To:** Agent

**Acceptance Criteria:**

1. When the resolved active repo's basename differs from the previously-recorded basename and the previous basename is still present in `~/.graphify/global-manifest.json`, the hook runs `flock -w 5 /tmp/graphify-global.lock graphify global remove <previous-basename>` before performing the add specified in [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault--active-repos) AC2.
2. End state after a switch: the global graph contains the vault entry plus exactly one per-repo entry (the user's currently active repo).
3. Same-basename transitions (two clones with identical directory names, or branch switches within the same repo) skip the explicit remove because `graphify global add --as <tag>` replaces the existing entry via graphify's source_hash dedup.
4. All write sites (capture agent, vault-extract agent, active-repo hook, `/graphify` skill) serialise via `flock -w 5 /tmp/graphify-global.lock` to prevent corrupted writes when multiple workflows race; the 5s timeout ensures a crashed lock holder cannot wedge the queue indefinitely.

**Constraints:**

- The pre-spawn hash check in REQ-VAULT-004 AC2 uses `sha256sum` truncated to graphify's 16-hex format with a length sanity-guard.
- The `/graphify` skill's commit step is one of the write sites and must include a `flock graphify global add` call so a fresh `graphify build` lands in the global graph.

**Priority:** P0

**Dependencies:** [REQ-VAULT-004](#req-vault-004-unified-global-graph-merges-vault--active-repos)

**Verification:** Structural audit

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

1. The entrypoint shutdown handler wraps the final `bisync_with_r2` call in a background subshell with a watchdog that hard-kills at 120s, so the DO's destroy() budget always lands AFTER bisync finishes or gives up cleanly.
2. The shutdown handler also terminates the vault-monitor daemon and SilverBullet supervisor PIDs (`/tmp/vault-monitor.pid`, `/tmp/silverbullet.pid`).
3. The shutdown elapsed time is logged so operators can tune the 120s budget over time if user edits get large enough to need more headroom.
4. `Container.destroy()` uses `timeoutMs = 135_000` (was 25_000): 120s for the entrypoint bisync plus 15s for clean process exit.
5. `Container.onStop()` logs `shutdownElapsedMs` (delta from `_shutdownStartedAt`), giving us telemetry on whether the budget is right.

**Constraints:**

- Bundled with the vault PR because vault edits not yet synced when the final bisync watchdog expires are silently lost in the same way session state is today -- the vault depends on bisync reliability.
- A 120s bisync watchdog vs. a 135s DO destroy budget gives a 15s buffer; this is the minimum that allows graceful process termination after bisync completes.

**Priority:** P0

**Dependencies:** [REQ-SESSION-009](session-lifecycle.md#req-session-009-container-destroy-wipes-session-state) (container destroy wipes session state), [REQ-SESSION-011](session-lifecycle.md#req-session-011-graceful-shutdown-with-final-sync) (graceful shutdown with final sync), [REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync) (graceful shutdown performs final sync)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-VAULT-007: Vault rules and plugin are preseeded into every advanced session

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (preseed manifest entries + file presence + Library/Codeflare plug copy → AC1-AC5) -->

**Intent:** A fresh advanced-mode session ships with the codeflare-vault plugin (hook + extraction prompt + plugin descriptor) and the memory rule (which carries the folded vault trigger/route content) already in place -- no per-session install step.

**Applies To:** Agent

**Acceptance Criteria:**

1. `preseed/agents/claude/manifest.json` registers `plugins/codeflare-vault/.claude-plugin/plugin.json`, `plugins/codeflare-vault/scripts/vault-monitor-hook.sh`, `plugins/codeflare-vault/scripts/vault-extract-prompt.md`, `rules/vault-note-capture.md`, `skills/vault-note-capture/SKILL.md`, and `skills/vault-operations/SKILL.md` -- all in advanced mode only. The vault trigger/route content is folded into `rules/memory.md` rather than living in a separate `rules/vault.md`.
2. The Dockerfile copies `preseed/silverbullet/` to `/opt/silverbullet-preseed/` so `init_user_vault()` can install the editor config without baking it into every R2 sync.
3. A build-time generator (run as `prebuild`) embeds the manifest contents into the runtime agent-seed module, which is what the Worker ships to the container at boot.
4. `preseed/agents/claude/rules/memory.md` is updated to document the vault-only capture path.
5. On every boot, `init_user_vault()` copies the SilverBullet plugs preseeded under `/opt/silverbullet-preseed/plugs/` into `~/Vault/Library/Codeflare/` so the editor opens with the baseline productivity plugs listed in `preseed/silverbullet/plugs/MANIFEST.md` (pdf, treeview, github, graph) available immediately, with no per-session install step. The copy is idempotent (overwrite-on-content-diff) so a codeflare-side plug pin bump propagates on next boot; user-installed plugs land under other `Library/` subdirectories and are untouched.

**Constraints:**

- Default-mode sessions do NOT get the vault plugin; the editor is an advanced-tier feature.
- The vault skeleton is created at runtime, not baked into the image, so a returning session never overwrites restored content.
- `Library/Codeflare/` is reserved for codeflare-managed plugs; the user keeps their own plugs in other `Library/` subdirectories so codeflare's overwrite-on-boot never clobbers user state.

**Priority:** P0

**Dependencies:** [REQ-AGENT-006](agents.md#req-agent-006-preseed-configs-generated-from-single-source-of-truth) (preseed configs from single source), [REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start) (preseed deployed to container on start), [REQ-AGENT-014](agents.md#req-agent-014-manifest-driven-preseed-pipeline) (manifest-driven preseed pipeline)

**Verification:** Structural audit

**Status:** Implemented

---

### REQ-VAULT-008: Zero-UI vault encryption

<!-- @impl: src/container/index.ts::ensureVaultKey -->
<!-- @impl: src/routes/vault.ts::injectVaultBootstrapHopHtml -->
<!-- @impl: src/routes/vault.ts::injectVaultIdbRecorder -->
<!-- @impl: web-ui/src/lib/vault-cache.ts::cleanupSessionVaultCache -->
<!-- @impl: web-ui/src/lib/vault-cache.ts::sweepOrphanVaultCaches -->
<!-- @test: src/__tests__/container/index.test.ts (ensureVaultKey persistence + idempotency describe → AC1/AC2) -->
<!-- @test: src/__tests__/routes/vault.test.ts (/.config merge + bootstrap-hop HTML render + SW shim message handlers describe → AC3/AC4/AC5/AC6) -->

**Intent:** SilverBullet's IndexedDB caches every vault file as raw bytes. This REQ covers encryption-at-rest with a per-session key generated and stored by the Container DO (no user passphrase prompt); IDB lifecycle cleanup on session DELETE and dashboard-mount sweeping lives in [REQ-VAULT-015](#req-vault-015-vault-idb-lifecycle-and-listing-filters). The threat model is BitLocker-grade: defeats offline disk attacks (profile theft, backup leak, ransomware scan), does NOT defeat anyone with an authenticated browser tab. The key dies with `container.destroy()` so deletion is forward-secret.

**Applies To:** User

**Acceptance Criteria:**

1. Container DO generates a 32-byte random `vaultKey` on first start, persists in `ctx.storage` under key `vaultKey`, and returns the same key on every subsequent read.
2. The key is never rotated; it is wiped only when `container.destroy()` runs (session DELETE).
3. The Worker `/api/vault/:sid/.config` proxy fetches the vault key via DO RPC and merges `{ vaultEncryptionKey: "<base64>", enableClientEncryption: true }` into the BootConfig JSON returned to SilverBullet.
4. SilverBullet uses the vault key as the AES-CTR key for the `sb_data_<hash>` IndexedDB via its built-in `EncryptedKvPrimitives` wrapper.
5. The Worker delivers the key through a one-time bootstrap-hop page at `/api/vault/<sid>/.codeflare-bootstrap` that registers a key-shim service worker, posts the key via `{type: "set-encryption-key"}`, sets `localStorage["enableEncryption"]`, and sets a `codeflare_vault_bootstrap` cookie before redirecting back to the shell.
6. Subsequent shell-path requests bypass the bootstrap hop via the cookie, and no passphrase prompt is shown to the user.

**Constraints:**

- Encryption protects against offline attacks ONLY. Anyone with an authenticated browser tab (or who can run JavaScript in the codeflare origin) can fetch the key from `/.config` and decrypt. The threat-model trade-off is documented in `documentation/decisions/README.md` AD59.
- The vault key MUST NOT be rotated mid-session. Rotation would orphan all existing IDB ciphertext on the browser and force a fresh re-sync on every container restart.
- The vault key MUST be wiped on `container.destroy()`. Persistence of the key after deletion would let a recovered browser profile decrypt the orphaned IDB.
- Per-session `:sid` MUST remain in the proxy URL to preserve the parallel-session isolation property (each session has its own IDB; cross-session reads/writes never collide).

**Priority:** P0

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor), [REQ-VAULT-001](#req-vault-001-persistent-vault-directory-survives-across-sessions) (vault directory survives sessions), [REQ-MEM-006](memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode) (Pro mode gating)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-VAULT-015: Vault IDB lifecycle and listing filters

<!-- @impl: src/routes/vault.ts -->
<!-- @impl: web-ui/src/lib/vault-cache.ts -->
<!-- @test: src/__tests__/routes/vault.test.ts (/.fs filter + IDB-recorder injection describe → AC1/AC3) -->
<!-- @test: web-ui/src/__tests__/lib/vault-cache.test.ts (cleanupSessionVaultCache + sweepOrphanVaultCaches real IDB deletion describe → AC3/AC4) -->
<!-- @test: host/__tests__/preseed-config-treeview.test.js (CONFIG.md treeview exclusions describe → AC2) -->

**Intent:** SilverBullet's IndexedDB caches and on-disk listings would otherwise persist across deletion and expose derived/internal directories to the user. This REQ covers cleanup on session DELETE, dashboard-mount sweeping for orphaned IDBs, and the listing filters that keep derived output and internal preseed pages out of the vault tree.

**Applies To:** User

**Acceptance Criteria:**

1. The vendored SilverBullet Go server filters `/.fs` listings to exclude `graphify-out/**` so derived output never reaches the browser.
2. The preseed `CONFIG.md` declares a `treeview.exclusions` block (upstream v2 schema) hiding `Library/`, `Repositories/`, `graphify-out/`, and the four top-level preseed pages (`CONFIG`, `Index`, `README`, `STYLES`) from the navigation tree.
3. The frontend invokes `cleanupSessionVaultCache(sessionId)` on session DELETE (not stop), which deletes every `sb_*` database recorded for the session in `localStorage["vault-session-<sid>-idbs"]` (populated at boot by the `injectVaultIdbRecorder` shim that wraps `indexedDB.open`), unregisters the SilverBullet service worker registered at `/api/vault/<sid>/`, and removes both `localStorage["vault-session-<sid>"]` and `localStorage["vault-session-<sid>-idbs"]`.
4. On dashboard mount and on every session-list refresh, the frontend sweeps every `localStorage["vault-session-<sid>-idbs"]` and `localStorage["vault-session-<sid>"]` entry and, for any sid NOT in the user's active sessions list, deletes the recorded IDBs and drops both localStorage entries (covers the case where the session was deleted from another device).

**Constraints:**

- `Repositories/` is SilverBullet's own library-manager mirror (created at runtime by the Library Manager plug); the user does not curate it directly. `.silverbullet/` is dot-prefixed and hidden by SilverBullet's default behaviour; it requires no explicit rule.
- The IDB cleanup helpers MUST NEVER enumerate via `indexedDB.databases()`. They operate exclusively on the names recorded by the boot shim. Enumeration would re-introduce the regression where the live session's IDB was nuked on every Dashboard mount, forcing a full SB resync on every reopen.

**Priority:** P0

**Dependencies:** [REQ-VAULT-008](#req-vault-008-zero-ui-vault-encryption--per-session-idb-lifecycle), [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-VAULT-009: Vault writes succeed end-to-end for SilverBullet attachment uploads

<!-- @impl: src/routes/vault.ts::maybeSynthesizeCsrfHeader -->
<!-- @impl: src/routes/vault.ts::inferOriginValidated -->
<!-- @test: src/__tests__/routes/vault.test.ts (missing-Origin PUT path describe → AC1-AC4) -->

**Intent:** SilverBullet's drag-drop attachment upload (PUT `/api/vault/<sid>/Inbox/<file>`) must succeed when the user is authenticated, regardless of whether the browser's fetch implementation set the Origin header. The previous code path required Origin to be present and allowlisted before synthesising the CSRF guard header, so a service-worker-controlled fetch or a same-origin fetch that omitted Origin landed at the auth chain without X-Requested-With and was rejected. PDF uploads from the SB Inbox plug repeatedly surfaced this as a 401 to the user.

**Applies To:** User

**Acceptance Criteria:**

1. A state-changing PUT/POST/PATCH/DELETE request to `/api/vault/<sid>/...` with no Origin header is treated as same-origin and proceeds through CSRF synthesis. The synthesis adds `X-Requested-With: XMLHttpRequest` so the downstream `authenticateRequest` CSRF guard does not reject the write.
2. A state-changing request with an Origin header that fails the allowlist still returns 403; the missing-Origin fallback does NOT widen the allowlist.
3. The forward chain preserves the request body bytes end-to-end (no double-read, no disturbed stream) on both the with-Origin and the no-Origin paths.
4. Existing GET / HEAD / OPTIONS requests behave unchanged; only state-changing methods enter the fallback path.

**Constraints:**

- Browsers since 2020 always set Origin on state-changing cross-origin requests; the fallback is for SB's same-origin path (where Origin is "null" or omitted) and CLI-style clients. It does NOT bypass the allowlist when an Origin IS present and disallowed.

**Priority:** P1

**Dependencies:** [REQ-VAULT-005](#req-vault-005-worker-proxy-exposes-the-in-container-vault-editor) (Worker proxy exposes vault editor)

**Verification:** Automated test

**Status:** Implemented

---
