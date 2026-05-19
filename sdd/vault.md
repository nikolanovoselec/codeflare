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

### Domain Dependencies

- **Memory** -- Reuses the `memory-capture.sh` UserPromptSubmit hook and `~/.memory/counter/` state. The capture agent writes Step 4's output into the vault (MCP server-memory has been removed from the stack); the dedup gate (`.vars` marker) is unchanged.
- **Storage** -- Vault persistence is provided by the existing rclone bisync to R2. One new include filter (`+ Vault/**`) is added to `RCLONE_FILTERS_COMMON`, ordered BEFORE the existing `**/graphify-out/**` exclude so first-match semantics keep vault content sync'd.
- **Session Lifecycle** -- The bundled shutdown bisync reliability fix raises the DO `destroy()` SIGTERM-to-SIGKILL budget to 135s, so the entrypoint's final bisync (120s watchdog) can complete cleanly. Without this, vault edits made in the last seconds before shutdown were silently lost to R2.
- **Subscription** -- Vault features (preseed entries, SilverBullet supervisor) are gated to advanced session mode via the existing manifest mode filter (`"modes": ["advanced"]` on every new preseed entry).

---

## REQ-VAULT-001: Persistent vault directory survives across sessions

**Intent:** A user opens a new session and finds their previous notes, captures, and pasted assets intact -- the same way the rest of `/home/user/` survives.

**Applies To:** User

**Acceptance Criteria:**
1. `/home/user/Vault/` is included in `RCLONE_FILTERS_COMMON` with `+ Vault/**`, placed BEFORE the existing `- **/graphify-out/**` exclude so the vault's own `graphify-out/` subdirectory rides along.
2. The `.graphify/` directory (ephemeral global-graph workspace) is excluded with `- .graphify/**` so the merged graph is regenerated on boot from the per-source `graphify-out/` files rather than carrying stale state across sessions.
3. `init_user_vault()` creates the vault subdirectories (`Raw/Sessions`, `Raw/Pasted`, `Notes`, `graphify-out`, `.silverbullet/_plug`) via `mkdir -p` on every boot so a user who deletes any of them cannot leave the agent hooks or SilverBullet in a broken state on the next session start.
4. `init_user_vault()` runs AFTER `establish_bisync_baseline()` and BEFORE the daemon launch block, so we never write the empty skeleton over R2-restored content.
5. `init_user_vault()` also `mkdir -p`s `/home/user/Uploads` and `/home/user/Temporary` alongside the vault. Both folders are persistent (`RCLONE_FILTERS_COMMON` includes `+ Uploads/**` and `+ Temporary/**`, placed BEFORE the global graphify-out exclude) so a file dropped into either survives session restart and is visible in the storage panel and from every device.
6. The R2 storage panel surfaces Workspace, Vault, Uploads, and Temporary as "special folders" at the bucket root: each appears unconditionally (Workspace gated by the workspace-sync preference), each renders an info icon that toggles a tooltip showing the folder's purpose and the in-container path it materialises at (`/home/user/Workspace`, `/home/user/Vault`, `/home/user/Uploads`, `/home/user/Temporary`).
7. `init_user_vault()` copies `Index.md`, `CONFIG.md`, `README.md`, and `STYLES.md` from `/opt/silverbullet-preseed/` into the vault root on every boot, gated so identical files are not rewritten. These four pages are codeflare-authoritative: user edits to them are intentionally not preserved across boots, because SilverBullet's dashboard widgets, in-page wikilink handlers, and codeflare theming all depend on their contents being current. User content lives in `Notes/`, `Inbox/`, `Journal/`, `Raw/Pasted/`, and `Raw/Sessions/` (never touched). `Library/Std` and its compiled `*.plug.js` are served from the SilverBullet binary's built-in `base_fs` overlay; the entrypoint MUST NOT copy a partial `Library/Std/` onto disk, which would shadow `base_fs` with incomplete files and brick widget rendering.
8. `~/Vault/graphify-out/graph.json` is seeded with the empty-graph JSON stub only when absent; the populated graph from a prior session is never overwritten by the entrypoint (the graph is build output regenerated by `graphify extract` / `graphify global add`, not preseed content).
9. `init_user_vault()` removes `Raw/Graphs/Global Graph.md` and `Raw/Graphs/global-graph.html` on every boot when present (idempotent `rm -f`, guarded so it fires only when the preseed counterpart is also absent). The unified global graph is too large for useful HTML visualisation (10k+ nodes); structural queries via `mcp__graphify__*` are the real interface and the vault viz already covers the user-curated slice. Vaults restored from R2 snapshots predating the drop are reconciled on the next boot.

**Constraints:**
- The vault is committed to the same R2 bucket as `/home/user/workspace` -- no two-bucket separation.
- Vault content is per-user (each user has their own R2 bucket).
- The vault directory MUST live at a non-hidden basename (`Vault`, not `.user_vault` or any other dot-prefixed path). SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the walk when the root basename starts with `.`, returning an empty file listing even when notes are on disk.
- `CONFIG.md` is a runtime contract, not user content. SilverBullet 2.x reads it as a `#meta` page with an optional `space-lua` config block (yaml blocks and the `pageBlackList`/`libraries` keys claimed by earlier releases are unrecognized by SB 2.x and were always no-ops). This is why CONFIG.md lives in the always-overwrite tier (AC7) and not in the user-editable tier.
- The SilverBullet Go server hardcodes `IndexPage` to lowercase `"index"` (`server/cmd/server.go:29`). The supervisor MUST export `SB_INDEX_PAGE=Index` before launching the binary so the TitleCase `Index.md` preseed page is what loads at `/`. `.silverbullet/config.yaml` is NOT read for this setting — it was a dead file in prior releases and is removed from preseed.

**Priority:** P0
**Dependencies:** REQ-STOR-002 (file persistence across sessions), REQ-STOR-003 (15-min bisync), REQ-STOR-004 (initial sync restores files on container start)
**Verification:** Structural audit (`host/__audits__/entrypoint-vault.audit.js` AC: filter order, init function presence, Uploads/Temporary mkdir, supervisor uses `$HOME/Vault`, per-boot preseed-page sync loop, graph.json recreate-if-missing guard, preseed-page existence on disk); special-folder registry unit test (`web-ui/src/__tests__/lib/special-folders.test.ts`); E2E (fresh session, `ls /home/user/{Vault,Uploads,Temporary}`, storage panel shows the four special folders with tooltips containing their container paths, delete each preseed page individually and confirm recreation on next session boot, populate `graphify-out/graph.json` and confirm not overwritten)
**Status:** Implemented

---

## REQ-VAULT-002: Conversation captures land in the vault as markdown

**Intent:** The capture agent writes one markdown file per 15-prompt batch into `Raw/Sessions/`, replacing the previous MCP-memory write path. Captures appear in `mcp__graphify__*` queries the same turn they are written.

**Applies To:** User

**Acceptance Criteria:**
1. `memory-agent-prompt.md` Step 4 writes the capture file at `/home/user/Vault/Raw/Sessions/{ISO_TS}-{SID_SHORT}.md` using the YAML-frontmatter + Context/Decisions/Observations/References template.
2. Concept references use `[[wikilinks]]`; file paths, code symbols, and PR/issue references stay as prose.
3. The capture agent builds the vault graph inline (sonnet emits chunk JSON matching graphify's schema, then a `flock -w 5 /tmp/graphify-global.lock` Python step calls `graphify.build` / `graphify.cluster` / `graphify.export.to_json` to materialise it), then merges it into the unified graph via `flock -w 5 /tmp/graphify-global.lock graphify global add ... --as user_vault`. The headless `graphify extract` CLI is intentionally bypassed per REQ-MEM-001 AC5: codeflare ships no LLM provider key for graphify and the capture agent IS the LLM, so re-invoking the CLI would duplicate inference cost with no benefit.
4. If extraction fails, the markdown file stays on disk and the next vault-monitor tick will re-discover it via the high-water marker comparison.
5. The MCP `server-memory` subsystem (`mcp__memory__*`) has been removed entirely; the capture agent does not invoke it, and no historical JSONL graph is read.

**Constraints:**
- The dedup gate (`.vars` marker delete as the agent's first step) is unchanged from the pre-vault flow.
- Compaction is not automated; the user prunes `Raw/Sessions/` manually via SilverBullet when the directory becomes unwieldy.

**Priority:** P0
**Dependencies:** REQ-VAULT-001
**Verification:** Structural audit (`host/__audits__/entrypoint-vault.audit.js` AC: vault-monitor and capture script structure); E2E (drive 15+ prompts and grep `Raw/Sessions/`)
**Status:** Implemented

---

## REQ-VAULT-003: User-curated edits are detected and ingested within ~60s

**Intent:** A user adds a note in SilverBullet (or any other editor) and within roughly one daemon tick the new content shows up in `mcp__graphify__*` query results.

**Applies To:** User

**Acceptance Criteria:**
1. `start_vault_monitor_daemon` in entrypoint.sh polls the vault every 60s, excluding `Raw/Sessions/`, `graphify-out/`, `.silverbullet/`, and the four preseed-managed root pages (`Index.md`, `CONFIG.md`, `README.md`, `STYLES.md`) from the find. The four pages are codeflare-authoritative (see REQ-VAULT-001 AC7); agent-side `cp` from preseed must not count as a user edit, otherwise every preseed sync at boot re-triggers extraction.
2. The daemon uses a three-marker pattern: `vault-monitor.tick` (heartbeat), `vault-extract.last` (high-water mark), `vault-extract.vars` (trigger). The find compares against `vault-extract.last`, NOT the tick, so a daemon that advances the wrong marker cannot lose work.
3. `vault-monitor-hook.sh` (UserPromptSubmit) exits 0 immediately when `vault-extract.vars` is absent (zero-cost on idle prompts) and emits `additionalContext` instructing the main agent to dispatch the vault-extract named subagent when present. The subagent runs as sonnet per AD58 (pinned at the subagent-definition level so the dispatching parent cannot silently downgrade the model).
4. The vault-extract subagent deletes `vault-extract.vars` as its first step (dedup gate), runs graphify extraction per changed file, merges via `graphify global add`, and touches `vault-extract.last` as its final step.
5. If steps 2-4 fail, the high-water marker is NOT advanced; the next daemon tick (within 60s) re-discovers the same files.
6. `init_user_vault()` bumps `vault-extract.last` after rewriting any preseed page, so the first post-boot daemon tick does not pick up the `cp` as a user change. Belt-and-braces for any future preseed page that misses the AC1 daemon-exclusion list.
7. PDF files in the changed-files list are ingested, not skipped as binary. The vault-extract agent reads each PDF (capped at 20 pages for large files), emits a `document` node for the PDF plus `concept` nodes for visible title text, headings, named entities, and diagrams. When a sibling `.md` note wikilinks the same PDF, a `cites` edge connects the document node to the wikilink concept so the global graph unifies them.
8. Read-tool failures on PDFs (corrupt, password-protected, unsupported encoding) emit the bare document node only; the high-water marker still advances so a single unreadable PDF does not block ingestion of other changed files.

**Constraints:**
- The 60s poll is intentional -- inotify was rejected as overkill for the expected edit rate.
- The dedup gate prevents the hook from re-spawning the agent on every prompt while extraction is in flight.

**Priority:** P0
**Dependencies:** REQ-VAULT-001
**Verification:** Structural audit (`host/__audits__/entrypoint-vault.audit.js` AC: three-marker pattern presence); E2E (edit `Notes/foo.md`, wait 60s, send prompt, confirm extraction); PDF-ingestion E2E (drop a `.pdf` into `Raw/Pasted/`, wait for the next daemon tick, confirm a `document` node for the PDF appears in the global graph and a corrupt PDF emits a bare document node without blocking the high-water marker)
**Status:** Implemented

---

## REQ-VAULT-004: Unified global graph merges vault + active repos

**Intent:** A single `mcp__graphify__*` call returns nodes from the vault and from every per-repo graphify-out the session has touched, so cross-cutting questions ("did we ever discuss X with respect to Y") work without manually selecting a graph.

**Applies To:** Agent

**Acceptance Criteria:**
1. `graphify-mcp-lazy.py:_resolve_active()` prefers `~/.graphify/global-graph.json` when present, falling back to the sentinel-pinned per-repo graph and then to the freshest workspace-mtime graph.
2. `graphify-active-repo.sh` runs `flock -w 5 /tmp/graphify-global.lock graphify global add <repo>/graphify-out/graph.json --as <basename>` whenever the resolved active repo has a graph and either (a) the manifest does not yet record this `<basename>` or (b) the manifest's recorded `source_hash` for this `<basename>` does not match the current graph.json hash. Pre-spawn hash check uses `sha256sum` truncated to graphify's 16-hex format with a length sanity-guard. The `flock -w 5` timeout bounds tool-call latency against a stuck lock holder.
3. `graphify-active-repo.sh` enforces a single-active-repo invariant: when the resolved active repo's basename differs from the previously-recorded active repo's basename AND the previous basename is still present in `~/.graphify/global-manifest.json`, the hook runs `flock -w 5 /tmp/graphify-global.lock graphify global remove <previous-basename>` before performing the add in AC2. End state: the global graph contains the vault entry plus exactly one per-repo entry (the user's currently active repo). Same-basename transitions (two clones with identical directory names, or branch switches within the same repo) skip the explicit remove because `graphify global add --as <tag>` replaces the existing entry via graphify's source_hash dedup.
4. The vault directory at `$HOME/Vault` is explicitly excluded from active-repo candidate resolution in `graphify-active-repo.sh`: when the walk-up loop reaches that path, the hook exits 0 without rewriting the sentinel or invoking `graphify global add`. The vault is registered exclusively by entrypoint init under the tag `user_vault`, so it is never re-tagged as `Vault` (basename) by a tool call that happens to touch a vault file, and the prune-on-switch logic in AC3 cannot remove it.
5. A cheap fast-path skip avoids spawning graphify on every Bash/Edit/Write/ctx_execute call: when the resolved active-repo path equals the prior sentinel value AND `graphify-out/graph.json`'s mtime is not newer than the sentinel's mtime, the hook returns immediately. The sentinel is `touch`-bumped at the end of every non-fast-path fire so subsequent fires can short-circuit until the next graph rebuild.
6. The `/graphify` skill's commit step includes a `flock graphify global add` call so a fresh `graphify build` lands in the global graph.
7. All write sites (capture agent, vault-extract agent, active-repo hook, /graphify skill) serialise via `flock -w 5 /tmp/graphify-global.lock` to prevent corrupted writes when multiple workflows race; the 5s timeout ensures a crashed lock holder cannot wedge the queue indefinitely.

**Constraints:**
- `graphify global add` is hash-keyed and idempotent; re-running with the same `graph.json` is a no-op.
- The `--as <tag>` argument is the per-source label used by `graphify global` to distinguish vault nodes from per-repo nodes.
- Branch-level granularity is not represented in the global manifest. A repo's tag is its directory basename; branch switches within the same repo refresh the entry via the AC2 hash-diff path once the user has rebuilt the graph on the new branch (`graphify update` or `/graphify`). Until the rebuild runs, the global graph still shows the prior branch's nodes under the same tag - an acceptable staleness window since automatic rebuild on every checkout would be too expensive.

**Priority:** P0
**Dependencies:** REQ-VAULT-001, REQ-VAULT-002, REQ-VAULT-003
**Verification:** Structural audit (`host/__audits__/entrypoint-vault.audit.js` AC: mcp-lazy resolution chain, active-repo hook structure); E2E (clone two repos, query, confirm cross-source results)
**Status:** Implemented

---

## REQ-VAULT-005: Worker proxy exposes the in-container vault editor

**Intent:** Clicking the Vault button in the codeflare UI opens SilverBullet in a new tab, behind the same auth + rate-limit boundary as every other tier-gated session feature.

**Applies To:** User

**Acceptance Criteria:**
1. The Dockerfile installs the `silverbullet-server-linux-x86_64` binary at `/usr/local/bin/silverbullet`, pinned by version + SHA256.
2. `start_silverbullet_supervisor` in entrypoint.sh runs the server on `127.0.0.1:3030` with a 5s restart loop so an editor crash never requires a container restart.
3. `src/routes/vault.ts`'s `validateVaultRoute` + `handleVaultRequest` apply the same auth chain as `handleWebSocketUpgrade` in `src/routes/terminal.ts`: `authenticateRequest`, origin allowlist, `getEffectiveTier` + `isActiveUser`, session ownership, container health probe, container fetch.
4. WebSocket upgrades for live-edit sync are rate-limited under the same per-user `ws-connect:<email>` key as terminal WebSockets so a separate budget cannot be discovered.
5. `host/src/server.ts` exposes a `/vault/*` HTTP branch (strip prefix + `http.request` to `127.0.0.1:3030`) and a WS upgrade passthrough via a `noServer: true` WebSocketServer that handles only `/vault/*` paths.
6. The Vault button in `Header.tsx` renders only when an active session exists and the parent passes `onVaultOpen` (gated to terminal view, between Bookmarks and Storage).
7. `handleVaultRequest` rewrites `<base href="/" />` to `<base href="/api/vault/<sid>/" />` on every `text/html` response (not gated to `/` or `/index.html`), so SilverBullet's relative asset references (e.g. `.client/client.js`, `.fs/<page>.md` writes) resolve back through the subpath proxy regardless of which page the user reloaded onto. Non-HTML responses (JS bundles, PNG icons, manifest JSON, `text/markdown` page bodies, `application/json` API replies, binary assets) pass through unchanged. The text/html guard alone is sufficient because SilverBullet's API endpoints (`.fs/`, `index.json`, `.attachment/`) return non-HTML content types — the rewriter never sees an API payload. When the body is rewritten, both `content-length` and `content-encoding` headers are dropped (`response.text()` auto-decompresses gzip/br upstream, so the original encoding header would otherwise trigger a browser decoding failure). A warning is logged when the rewrite runs but the body did not contain the bare `<base href="/" />` (no-op rewrite), so a future SilverBullet template change surfaces as a logged signal instead of a silent white-screen regression.
8. Browser-initiated Service Worker registration GETs at `/api/vault/<sid>/service_worker.js` short-circuit the auth chain and receive a static no-op SW from the Worker. Selector requires all of: method `GET`, exact path `/service_worker.js`, request header `Service-Worker: script` (a Fetch-spec forbidden header name, not settable from page JavaScript), and no `Cookie` header. Chrome 76+ omits credentials on `navigator.serviceWorker.register()` script fetches even for same-origin same-site URLs, so the normal cookie-auth path returned 401 and registration failed permanently. The static SW JS contains zero user data and is identical across sessions; the cookie-absent gate is defence-in-depth so that any future browser path that carries credentials falls through to the normal auth chain (returning the real upstream SW or 401) instead of the static-noop shortcut.
9. SilverBullet opens to the `Index` page (the codeflare dashboard) on every Vault button click, via `SB_INDEX_PAGE=Index` exported in the supervisor before launching the binary (`server/cmd/server.go:56`). The README page is reachable from the dashboard via a link at the top.
10. The Vault button is rendered disabled with tooltip "Vault initializing…" until a per-session ground-truth probe against the vault proxy responds 200. The probe retries on a short interval until the first success, then enables the button; the readiness state is keyed per session so switching active sessions resets it. This guards both the cold-boot race (the editor supervisor binds its localhost port later than terminal readiness flips) and the crashed-editor scenario (container up, editor process dead); both would otherwise surface `VAULT_UPSTREAM_UNREACHABLE` to the user.

**Constraints:**
- SilverBullet is bound to localhost only -- the Worker proxy is the only externally reachable surface.
- The `/api/vault/:sid/status` Hono endpoint runs through the normal middleware chain; only the catch-all proxy is intercepted before Hono.
- SilverBullet 2.8.0 honours `SB_URL_PREFIX` to render the base tag with a prefix, but the prefix is per-session (the worker knows `:sid`, the container does not); baking it in at supervisor start is not viable. The per-response Worker rewrite is the per-session adapter.
- For body-bearing methods (PUT/POST/PATCH), `container.fetch` must be called with the Request returned by `maybeSynthesizeCsrfHeader`, not the original incoming `request`. The helper consumes the input body when it constructs the header-rewritten clone, so forwarding the original raises a Workers `TypeError: This ReadableStream is disturbed`. AC3's auth chain must read only headers (cookies, JWT assertion); body consumption inside `authenticateRequest` would also break this invariant.

**Priority:** P0
**Dependencies:** REQ-VAULT-001
**Verification:** Automated test (`src/__tests__/routes/vault.test.ts` AC: validateVaultRoute boundary cases); E2E (open Vault button, edit, confirm sync over WS)
**Status:** Implemented

---

## REQ-VAULT-006: Shutdown bisync completes vault writes before SIGKILL

**Intent:** A user who stops a session and closes their browser within seconds finds their latest vault edits intact on the next session, instead of losing them to a mid-bisync SIGKILL.

**Applies To:** User

**Acceptance Criteria:**
1. `shutdown_handler()` in entrypoint.sh wraps the final `bisync_with_r2` call in a background subshell with a watchdog that hard-kills at 120s, so the DO's destroy() budget always lands AFTER bisync finishes or gives up cleanly.
2. The shutdown handler also terminates the vault-monitor daemon and SilverBullet supervisor PIDs (`/tmp/vault-monitor.pid`, `/tmp/silverbullet.pid`).
3. The shutdown elapsed time is logged so operators can tune the 120s budget over time if user edits get large enough to need more headroom.
4. `Container.destroy()` in `src/container/index.ts` uses `timeoutMs = 135_000` (was 25_000): 120s for the entrypoint bisync plus 15s for clean process exit.
5. `Container.onStop()` logs `shutdownElapsedMs` (delta from `_shutdownStartedAt`), giving us telemetry on whether the budget is right.

**Constraints:**
- Bundled with the vault PR because vault edits not yet synced when the final bisync watchdog expires are silently lost in the same way session state is today -- the vault depends on bisync reliability.
- A 120s bisync watchdog vs. a 135s DO destroy budget gives a 15s buffer; this is the minimum that allows graceful process termination after bisync completes.

**Priority:** P0
**Dependencies:** REQ-SESSION-009 (container destroy wipes session state), REQ-SESSION-011 (graceful shutdown with final sync), REQ-STOR-005 (graceful shutdown performs final sync)
**Verification:** Automated test (`src/__tests__/container/index.test.ts` AC: 135s SIGKILL fallback + shutdownElapsedMs telemetry); structural audit (`host/__audits__/entrypoint-vault.audit.js`); E2E (edit vault, click Stop, close tab, reopen, confirm edit persisted)
**Status:** Implemented

---

## REQ-VAULT-007: Vault rules and plugin are preseeded into every advanced session

**Intent:** A fresh advanced-mode session ships with the codeflare-vault plugin (hook + extraction prompt + plugin descriptor) and the memory rule (which carries the folded vault trigger/route content) already in place -- no per-session install step.

**Applies To:** Agent

**Acceptance Criteria:**
1. `preseed/agents/claude/manifest.json` registers `plugins/codeflare-vault/.claude-plugin/plugin.json`, `plugins/codeflare-vault/scripts/vault-monitor-hook.sh`, `plugins/codeflare-vault/scripts/vault-extract-prompt.md`, `rules/vault-note-capture.md`, `skills/vault-note-capture/SKILL.md`, and `skills/vault-operations/SKILL.md` -- all in advanced mode only. The vault trigger/route content is folded into `rules/memory.md` rather than living in a separate `rules/vault.md`.
2. The Dockerfile copies `preseed/silverbullet/` to `/opt/silverbullet-preseed/` so `init_user_vault()` can install the editor config without baking it into every R2 sync.
3. `scripts/generate-agent-seed.mjs` (run as `prebuild`) embeds the manifest contents into `src/lib/agent-seed.generated.ts`, which is what the Worker ships to the container at boot.
4. `preseed/agents/claude/rules/memory.md` is updated to document the vault-only capture path.
5. On every boot, `init_user_vault()` copies the SilverBullet plugs preseeded under `/opt/silverbullet-preseed/plugs/` into `~/Vault/Library/Codeflare/` so the editor opens with the baseline productivity plugs listed in `preseed/silverbullet/plugs/MANIFEST.md` (pdf, treeview, github, graph) available immediately, with no per-session install step. The copy is idempotent (overwrite-on-content-diff) so a codeflare-side plug pin bump propagates on next boot; user-installed plugs land under other `Library/` subdirectories and are untouched.

**Constraints:**
- Default-mode sessions do NOT get the vault plugin; the editor is an advanced-tier feature.
- The vault skeleton is created at runtime, not baked into the image, so a returning session never overwrites restored content.
- `Library/Codeflare/` is reserved for codeflare-managed plugs; the user keeps their own plugs in other `Library/` subdirectories so codeflare's overwrite-on-boot never clobbers user state.

**Priority:** P0
**Dependencies:** REQ-AGENT-006 (preseed configs from single source), REQ-AGENT-008 (preseed deployed to container on start), REQ-AGENT-014 (manifest-driven preseed pipeline)
**Verification:** Structural audit (`host/__audits__/entrypoint-vault.audit.js` AC: preseed manifest entries + file presence); plug manifest presence (`preseed/silverbullet/plugs/MANIFEST.md` lists the shipped plugs); E2E (fresh session, confirm `~/.claude/plugins/codeflare-vault/` exists and `~/Vault/Library/Codeflare/*.plug.js` populates)
**Status:** Implemented

---

## REQ-VAULT-008: Zero-UI vault encryption + cold-start payload reduction + per-session IDB lifecycle

**Intent:** SilverBullet's IndexedDB caches every vault file as raw bytes. Three coupled improvements ship as one requirement: (a) the IDB cache is encrypted at rest with a per-session key generated and stored by the Container DO (no user passphrase prompt), (b) the cold-start payload is reduced (concurrency bumped, lazy attachments, server-side filter for derived output, treeview nav filtered), and (c) deleted sessions have their IDB cleaned up rather than lingering across browser sessions. The threat model is BitLocker-grade: defeats offline disk attacks (profile theft, backup leak, ransomware scan), does NOT defeat anyone with an authenticated browser tab. The key dies with `container.destroy()` so deletion is forward-secret.

**Applies To:** User

**Acceptance Criteria:**
1. Container DO generates a 32-byte random `vaultKey` on first start, persists in `ctx.storage` under key `vaultKey`, and returns the same key on every subsequent read. The key is never rotated; it is wiped only when `container.destroy()` runs (session DELETE).
2. The Worker `/api/vault/:sid/.config` proxy fetches the vault key via DO RPC and merges `{ vaultEncryptionKey: "<base64>", enableClientEncryption: true }` into the BootConfig JSON returned to SilverBullet.
3. SilverBullet consumes the vault key delivered via boot config, uses it to derive the IndexedDB database name and as the encryption key for IndexedDB contents. No passphrase prompt is shown to the user.
4. The vendored SilverBullet bundle is configured with elevated sync concurrency so that the unavoidable first-sync of a fresh session completes in under 5 seconds on a typical vault (measured against the cold-start smoke target in the Verification field).
5. Files matching `Raw/Pasted/**` are not eagerly synced into IndexedDB on the bulk-sync path; SilverBullet falls through to the standard `readFile` path on user open, fetching attachments on demand.
6. The vendored SilverBullet Go server filters `/.fs` listings to exclude `graphify-out/**` so derived output never reaches the browser.
7. The preseed `CONFIG.md` declares a `treeview.exclusions` block (upstream v2 schema) hiding `Library/`, `Repositories/`, `graphify-out/`, and the four top-level preseed pages (`CONFIG`, `Index`, `README`, `STYLES`) from the navigation tree. `Repositories/` is SilverBullet's own library-manager mirror (created at runtime by the Library Manager plug); the user does not curate it directly. `.silverbullet/` is dot-prefixed and hidden by SilverBullet's default behaviour; it requires no explicit rule.
8. The frontend invokes `cleanupSessionVaultCache(sessionId)` on session DELETE (not stop) -- deletes both `sb_files_<hash>` and `sb_data_<hash>` databases, unregisters the SilverBullet service worker registered at `/api/vault/<sid>/`, and removes the `localStorage["vault-session-<sid>"]` marker.
9. On dashboard mount and on every session-list refresh, the frontend sweeps `localStorage["vault-session-<sid>"]` markers and nukes the IDB + marker for any session NOT present in the user's active sessions list (covers the case where the session was deleted from another device).

**Constraints:**
- Encryption protects against offline attacks ONLY. Anyone with an authenticated browser tab (or who can run JavaScript in the codeflare origin) can fetch the key from `/.config` and decrypt. The threat-model trade-off is documented in `documentation/decisions/README.md` AD59.
- The vault key MUST NOT be rotated mid-session. Rotation would orphan all existing IDB ciphertext on the browser and force a fresh re-sync on every container restart, defeating the cold-start optimisation.
- The vault key MUST be wiped on `container.destroy()`. Persistence of the key after deletion would let a recovered browser profile decrypt the orphaned IDB.
- Per-session `:sid` MUST remain in the proxy URL to preserve the parallel-session isolation property (each session has its own IDB; cross-session reads/writes never collide).

**Priority:** P0
**Dependencies:** REQ-VAULT-005 (Worker proxy exposes vault editor), REQ-VAULT-001 (vault directory survives sessions), REQ-MEM-006 (Pro mode gating)
**Verification:** Unit tests (DO `ensureVaultKey()` persistence + idempotency in `src/__tests__/container/index.test.ts`; Worker `/.config` merge + boot-script injection + `/.fs` filter in `src/__tests__/routes/vault.test.ts`; `cleanupSessionVaultCache` + `sweepOrphanVaultCaches` in `web-ui/src/__tests__/lib/vault-cache.test.ts`; CONFIG.md treeview exclude in `host/__tests__/preseed-config-treeview.test.js`); manual smoke (cold-start time under 5s on second session; IDB bytes are AES ciphertext; deleted-session IDB is gone).
**Status:** Partial

---

## REQ-VAULT-009: Vault writes succeed end-to-end for SilverBullet attachment uploads

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
**Dependencies:** REQ-VAULT-005 (Worker proxy exposes vault editor)
**Verification:** Unit (`src/__tests__/routes/vault.test.ts` regression for missing-Origin PUT path).
**Status:** Implemented

---
