# Vault

Persistent Obsidian-style note vault: agent-written session captures plus user-curated prose, indexed into the unified graphify graph for cross-session memory queries.

**Domain owner:** entrypoint.sh, codeflare-vault plugin, graphify, SilverBullet, Worker `/api/vault` route

### Key Concepts

- **Vault** -- The persistent directory at `/home/user/Vault/` holding markdown notes, pasted assets, and derived graphify output. Bisynced to R2 to survive across sessions. Always-on in the unified global graph: tagged `user_vault` from entrypoint init, never pruned by the active-repo prune-on-switch logic.
- **Capture Sonnet** -- The background sonnet agent spawned by the memory-capture UserPromptSubmit hook. Writes one markdown file per 15-prompt batch into `raw/sessions/` and merges it into the unified global graph.
- **Vault-monitor Daemon** -- A 60s polling loop in entrypoint.sh that watches for user-curated edits (under `notes/`, `raw/pasted/`) and writes a trigger marker (`vault-extract.vars`) when changes are found. Uses the three-marker pattern (tick / high-water / trigger) to avoid the daemon-advances-mtime-before-extraction-reads-it race.
- **Vault-extract Sonnet** -- The background sonnet spawned by `vault-monitor-hook.sh`. Runs graphify single-file extraction on the changed files, merges the resulting subgraph into the unified global graph, and advances the high-water marker as its final step.
- **Unified Global Graph** -- `~/.graphify/global-graph.json`. Hash-keyed merge of every per-repo graphify-out plus the vault's own graph, kept in sync by `graphify global add` calls under `flock /tmp/graphify-global.lock`. The graphify MCP wrapper prefers this graph when present so `mcp__graphify__*` tool calls return a unified view.
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

- **Memory** -- Reuses the `memory-capture.sh` UserPromptSubmit hook and `~/.memory/counter/` state. The capture sonnet writes Step 4's output into the vault (MCP server-memory has been removed from the stack); the dedup gate (`.vars` marker) is unchanged.
- **Storage** -- Vault persistence is provided by the existing rclone bisync to R2. One new include filter (`+ Vault/**`) is added to `RCLONE_FILTERS_COMMON`, ordered BEFORE the existing `**/graphify-out/**` exclude so first-match semantics keep vault content sync'd.
- **Session Lifecycle** -- The bundled shutdown bisync reliability fix raises the DO `destroy()` SIGTERM-to-SIGKILL budget from 25s to 75s, so the entrypoint's 60s final bisync can complete cleanly. Without this, vault edits made in the last seconds before shutdown were silently lost to R2.
- **Subscription** -- Vault features (preseed entries, SilverBullet supervisor) are gated to advanced session mode via the existing manifest mode filter (`"modes": ["advanced"]` on every new preseed entry).

---

## REQ-VAULT-001: Persistent vault directory survives across sessions

**Intent:** A user opens a new session and finds their previous notes, captures, and pasted assets intact -- the same way the rest of `/home/user/` survives.

**Applies To:** User

**Acceptance Criteria:**
1. `/home/user/Vault/` is included in `RCLONE_FILTERS_COMMON` with `+ Vault/**`, placed BEFORE the existing `- **/graphify-out/**` exclude so the vault's own `graphify-out/` subdirectory rides along.
2. The `.graphify/` directory (ephemeral global-graph workspace) is excluded with `- .graphify/**` so the merged graph is regenerated on boot from the per-source `graphify-out/` files rather than carrying stale state across sessions.
3. The skeleton (subdirectories + README + empty `graph.json` + SilverBullet config + best-effort Atlas plug) is created by `init_user_vault()` in entrypoint.sh, idempotent so a returning session does not overwrite restored content.
4. `init_user_vault()` runs AFTER `establish_bisync_baseline()` and BEFORE the daemon launch block, so we never write the empty skeleton over R2-restored content.
5. `init_user_vault()` also `mkdir -p`s `/home/user/Uploads` and `/home/user/Temporary` alongside the vault. Both folders are persistent (`RCLONE_FILTERS_COMMON` includes `+ Uploads/**` and `+ Temporary/**`, placed BEFORE the global graphify-out exclude) so a file dropped into either survives session restart and is visible in the storage panel and from every device.
6. The R2 storage panel surfaces Workspace, Vault, Uploads, and Temporary as "special folders" at the bucket root: each appears unconditionally (Workspace gated by the workspace-sync preference), each renders an info icon that toggles a tooltip showing the folder's purpose and the in-container path it materialises at (`/home/user/Workspace`, `/home/user/Vault`, `/home/user/Uploads`, `/home/user/Temporary`).

**Constraints:**
- The vault is committed to the same R2 bucket as `/home/user/workspace` -- no two-bucket separation.
- Vault content is per-user (each user has their own R2 bucket).
- The vault directory MUST live at a non-hidden basename (`Vault`, not `.user_vault` or any other dot-prefixed path). SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the walk when the root basename starts with `.`, returning an empty file listing even when notes are on disk.

**Priority:** P0
**Dependencies:** REQ-STOR-002 (file persistence across sessions), REQ-STOR-003 (60s bisync), REQ-STOR-004 (initial sync restores files on container start)
**Verification:** Structural audit (`host/__audits__/entrypoint-vault.audit.js` AC: filter order, init function presence, Uploads/Temporary mkdir, supervisor uses `$HOME/Vault`); special-folder registry unit test (`web-ui/src/__tests__/lib/special-folders.test.ts`); E2E (fresh session, `ls /home/user/{Vault,Uploads,Temporary}`, storage panel shows the four special folders with tooltips containing their container paths)
**Status:** Implemented

---

## REQ-VAULT-002: Conversation captures land in the vault as markdown

**Intent:** The capture sonnet writes one markdown file per 15-prompt batch into `raw/sessions/`, replacing the previous MCP-memory write path. Captures appear in `mcp__graphify__*` queries the same turn they are written.

**Applies To:** User

**Acceptance Criteria:**
1. `memory-agent-prompt.md` Step 4 writes the capture file at `/home/user/Vault/raw/sessions/{ISO_TS}-{SID_SHORT}.md` using the YAML-frontmatter + Context/Decisions/Observations/References template.
2. Concept references use `[[wikilinks]]`; file paths, code symbols, and PR/issue references stay as prose.
3. Step 5 runs `flock /tmp/graphify-global.lock graphify extract --file ... && flock /tmp/graphify-global.lock graphify global add ... --as user_vault` so the new capture is merged into the unified graph atomically.
4. If extraction fails, the markdown file stays on disk and the next vault-monitor tick will re-discover it via the high-water marker comparison.
5. The MCP `server-memory` subsystem (`mcp__memory__*`) has been removed entirely; the capture sonnet does not invoke it, and no historical JSONL graph is read.

**Constraints:**
- The dedup gate (`.vars` marker delete as the agent's first step) is unchanged from the pre-vault flow.
- Compaction is not automated; the user prunes `raw/sessions/` manually via SilverBullet when the directory becomes unwieldy.

**Priority:** P0
**Dependencies:** REQ-VAULT-001
**Verification:** Structural audit (`host/__audits__/entrypoint-vault.audit.js` AC: vault-monitor and capture script structure); E2E (drive 15+ prompts and grep `raw/sessions/`)
**Status:** Implemented

---

## REQ-VAULT-003: User-curated edits are detected and ingested within ~60s

**Intent:** A user adds a note in SilverBullet (or any other editor) and within roughly one daemon tick the new content shows up in `mcp__graphify__*` query results.

**Applies To:** User

**Acceptance Criteria:**
1. `start_vault_monitor_daemon` in entrypoint.sh polls the vault every 60s, excluding `raw/sessions/`, `graphify-out/`, and `.silverbullet/` from the find.
2. The daemon uses a three-marker pattern: `vault-monitor.tick` (heartbeat), `vault-extract.last` (high-water mark), `vault-extract.vars` (trigger). The find compares against `vault-extract.last`, NOT the tick, so a daemon that advances the wrong marker cannot lose work.
3. `vault-monitor-hook.sh` (UserPromptSubmit) exits 0 immediately when `vault-extract.vars` is absent (zero-cost on idle prompts) and emits `additionalContext` pointing at `vault-extract-prompt.md` when present.
4. The vault-extract sonnet deletes `vault-extract.vars` as its first step (dedup gate), runs graphify extraction per changed file, merges via `graphify global add`, and touches `vault-extract.last` as its final step.
5. If steps 2-4 fail, the high-water marker is NOT advanced; the next daemon tick (within 60s) re-discovers the same files.

**Constraints:**
- The 60s poll is intentional -- inotify was rejected as overkill for the expected edit rate.
- The dedup gate prevents the hook from re-spawning the sonnet on every prompt while extraction is in flight.

**Priority:** P0
**Dependencies:** REQ-VAULT-001
**Verification:** Structural audit (`host/__audits__/entrypoint-vault.audit.js` AC: three-marker pattern presence); E2E (edit `notes/foo.md`, wait 60s, send prompt, confirm extraction)
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
7. All write sites (capture sonnet, vault-extract sonnet, active-repo hook, /graphify skill) serialise via `flock /tmp/graphify-global.lock` to prevent corrupted writes when multiple workflows race.

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
1. `shutdown_handler()` in entrypoint.sh wraps the final `bisync_with_r2` call in a background subshell with a watchdog that hard-kills at 60s, so the DO's destroy() budget always lands AFTER bisync finishes or gives up cleanly.
2. The shutdown handler also terminates the vault-monitor daemon and SilverBullet supervisor PIDs (`/tmp/vault-monitor.pid`, `/tmp/silverbullet.pid`).
3. The shutdown elapsed time is logged so operators can tune the 60s budget over time if user edits get large enough to need more headroom.
4. `Container.destroy()` in `src/container/index.ts` uses `timeoutMs = 75_000` (was 25_000): 60s for the entrypoint bisync plus 15s for clean process exit.
5. `Container.onStop()` logs `shutdownElapsedMs` (delta from `_shutdownStartedAt`), giving us telemetry on whether the budget is right.

**Constraints:**
- Bundled with the vault PR because vault edits in the last 60s before shutdown are silently lost in the same way session state is today -- the vault depends on bisync reliability.
- A 60s bisync timeout vs. a 75s DO destroy budget gives a 15s buffer; this is the minimum that allows graceful process termination after bisync completes.

**Priority:** P0
**Dependencies:** REQ-SESSION-009 (container destroy wipes session state), REQ-SESSION-011 (graceful shutdown with final sync), REQ-STOR-005 (graceful shutdown performs final sync)
**Verification:** Automated test (`src/__tests__/container/index.test.ts` AC: 75s SIGKILL fallback + shutdownElapsedMs telemetry); structural audit (`host/__audits__/entrypoint-vault.audit.js`); E2E (edit vault, click Stop, close tab, reopen, confirm edit persisted)
**Status:** Implemented

---

## REQ-VAULT-007: Vault rules and plugin are preseeded into every advanced session

**Intent:** A fresh advanced-mode session ships with the codeflare-vault plugin (hook + extraction prompt + plugin descriptor), the new vault rule, and the updated memory rule already in place -- no per-session install step.

**Applies To:** Agent

**Acceptance Criteria:**
1. `preseed/agents/claude/manifest.json` registers `plugins/codeflare-vault/.claude-plugin/plugin.json`, `plugins/codeflare-vault/scripts/vault-monitor-hook.sh`, `plugins/codeflare-vault/scripts/vault-extract-prompt.md`, and `rules/vault.md` -- all in advanced mode only.
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
