# Vault

Persistent user-note vault, automatic conversation capture, unified graphify graph, and SilverBullet editor proxy. The vault is the agent's cross-session memory and the user's own note store, in the same directory.

**Audience:** Developers

---

## Contents

- [Overview](#overview-req-vault-001)
  - [Uploads and Temporary folders](#uploads-and-temporary-folders)
  - [Storage panel special folders](#storage-panel-special-folders-req-vault-001)
- [Directory Layout](#directory-layout)
- [Capture Path](#capture-path-req-vault-002)
- [User-edit Path](#user-edit-path-req-vault-003)
- [Unified Global Graph](#unified-global-graph-req-vault-004)
- [SilverBullet Editor](#silverbullet-editor-req-vault-005)
- [Vault Encryption and Per-session IDB Lifecycle](#vault-encryption-and-per-session-idb-lifecycle-req-vault-008-req-vault-015)
- [Shutdown Bisync Reliability](#shutdown-bisync-reliability-req-vault-006)
- [Preseed Integration](#preseed-integration-req-vault-007)
  - [Vault initialization tiers](#vault-initialization-tiers-req-vault-001-ac3-req-vault-010-ac1ac4ac5)
  - [CONFIG.md and Library/Std (base_fs)](#configmd-and-librarystd-base_fs)
  - [STYLES.md and codeflare theming](#stylesmd-and-codeflare-theming-req-vault-007)
  - [SilverBullet plug preinstall](#silverbullet-plug-preinstall-req-vault-007)
- [First-session Expectations](#first-session-expectations)
- [Attachment Cost Caveat](#attachment-cost-caveat-req-vault-011-ac1)
- [Troubleshooting](#troubleshooting)

---

## Overview (REQ-VAULT-001)

The vault lives at `/home/user/Vault/` inside every advanced-mode session container. It is rclone-bisynced to R2 alongside the rest of `/home/user/`, so anything written here is on the next session you start.

Two parties write to the vault:

- The **capture agent** (sonnet) appends a markdown file to `Raw/Sessions/` every 15 user prompts (replaces the old MCP-memory write path).
- **The user** edits notes via SilverBullet (or any other tool that touches files under `Notes/`, `Inbox/`, or `Journal/`). Attachments dropped onto a note are written by SilverBullet next to the referencing note (so a Quick Note in `Inbox/2026-05-18/` collects PDFs and images in the same date folder); `Raw/Pasted/` remains as an optional hand-organised archive but SilverBullet never auto-routes there.

A single 60s daemon polls for user edits and signals a background sonnet agent to ingest them into the unified graphify graph. Future agents query that graph via `mcp__graphify__*` and see captures + user notes + every active repo's code, merged.

### Uploads and Temporary folders

Two persistent sibling directories are created alongside the vault on every boot by `init_user_vault()`:

- **`/home/user/Uploads/`** -- drop zone for files that need to survive session restart and be visible from every device. Files placed here are included in `RCLONE_FILTERS_COMMON` (`+ Uploads/**`, ordered before the global `graphify-out` exclude) and appear in the R2 storage panel.
- **`/home/user/Temporary/`** -- persistent scratch space with the same bisync and panel treatment.

### Storage panel special folders (REQ-VAULT-001)

The R2 storage browser surfaces four directories as "special folders" at the bucket root. Vault, Uploads, and Temporary appear unconditionally; Workspace appears only when the workspace-sync preference is enabled. Each entry shows an info icon that reveals a tooltip:

| Folder | Container path | Gated? |
|---|---|---|
| Workspace | `/home/user/Workspace` | Only when workspace-sync preference is enabled |
| Vault | `/home/user/Vault` | Always shown |
| Uploads | `/home/user/Uploads` | Always shown |
| Temporary | `/home/user/Temporary` | Always shown |

The tooltip shows the folder's purpose and its in-container path so users know where to look inside a session.

## Directory Layout

Inside the container, three sibling directories live under `/home/user/` alongside the workspace:

```
/home/user/
|-- Workspace/         <- active project (workspace-sync gated)
|-- Vault/             <- vault (always bisynced in advanced mode)
|   |-- Index.md           <- PRESEED-MANAGED: Codeflare dashboard (overwritten each boot)
|   |-- README.md          <- PRESEED-MANAGED: vault user guide (overwritten each boot)
|   |-- CONFIG.md          <- PRESEED-MANAGED: SilverBullet #meta config page (overwritten each boot)
|   |-- STYLES.md          <- PRESEED-MANAGED: Codeflare editor theme (overwritten each boot)
|   |-- Raw/
|   |   |-- Sessions/      <- AGENT-OWNED: one .md per 15-prompt capture
|   |   |-- Pasted/        <- USER-OWNED: image/PDF drops from SilverBullet
|   |   `-- Graphs/        <- USER-EDITABLE: Vault Graph.md (seeded once, never overwritten); links to vault-graph.html re-rendered on each vault-extract pass
|   |-- Notes/             <- USER-OWNED: curated prose, concept notes
|   |-- Inbox/             <- USER-OWNED: SB "Quick Note" target
|   |-- Journal/           <- USER-OWNED: SB "Journal: Today" target
|   |-- graphify-out/      <- DERIVED: graphify extract output (do not edit)
|   |-- Library/
|   |   `-- Codeflare/     <- CODEFLARE-MANAGED: preseeded SilverBullet plugs
|   `-- .silverbullet/     <- EDITOR CONFIG: SilverBullet config + plug cache
|-- Uploads/           <- persistent drop zone for files (always bisynced)
`-- Temporary/         <- persistent scratch space (always bisynced)
```

`Raw/`, `Notes/`, and `graphify-out/` are where content lives. `graphify-out/` is updated by the vault-extract agent via a chunk-JSON merge on every user-edit tick (not a full re-extract). `.silverbullet/` is owned by the editor. `Library/Codeflare/` holds the plug files managed by Codeflare (pdf, treeview, github, graph) -- see [Preseed Integration](#preseed-integration-req-vault-007).

**Codeflare-authoritative vs user-editable.** The four root pages (`Index.md`, `README.md`, `CONFIG.md`, `STYLES.md`) are codeflare-authoritative: `init_user_vault()` overwrites them on every boot from `/opt/silverbullet-preseed/`, gated so identical files are not rewritten. Hand-editing them inside SilverBullet is futile - changes are silently reverted on the next session start. User content lives in `Notes/`, `Inbox/`, `Journal/`, `Raw/Pasted/`, and `Raw/Sessions/`, which the boot-time sync never touches.

**Hidden-root constraint (see [AD54](../decisions/README.md#ad54-vault-directory-must-use-a-non-hidden-basename)):** The vault directory must use a non-hidden basename. SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the directory walk when the root basename begins with `.`, returning an empty file listing even when notes are present on disk. This is why the path is `/home/user/Vault/`, not `/home/user/.user_vault/`.

## Capture Path (REQ-VAULT-002)

The `memory-capture.sh` UserPromptSubmit hook fires every 15 user messages, writes a `.vars` marker, and emits `additionalContext` instructing the main agent to dispatch the **memory-capture** named subagent (Task tool with `subagent_type="memory-capture"`). The subagent's frontmatter (`preseed/agents/claude/agents/memory-capture.md`) pins `model: sonnet` per AD58; the hook directive instructs the main agent not to pass a model override so the pin cannot be silently downgraded. The subagent runs `memory-agent-prompt.md` end to end:

1. Deletes the `.vars` marker (dedup gate so a concurrent prompt cannot spawn a duplicate).
2. Reads the new transcript range.
3. Identifies decisions, observations, references, and a short topic phrase.
4. Writes `/home/user/Vault/Raw/Sessions/{ISO_TS}-{SID_SHORT}.md` using the YAML-frontmatter template (session id, captured-at, captured-from-range, then Context / Decisions / Observations / References sections).
5. Acts as the LLM extractor: reads the file it just wrote, emits a chunk JSON matching graphify's extraction schema (nodes / edges / hyperedges, with `[[wikilinks]]` as `file_type:concept` nodes carrying `source_file: null` so graphify's `external_labels` dedup in `global_add` unifies them across the vault and per-repo graphs by label), calls `graphify.build.build_from_json` + `graphify.cluster.cluster` + `graphify.export.to_json` from the Python API to produce a `graph.json`, then runs `flock -w 5 /tmp/graphify-global.lock graphify global add ... --as user_vault` to merge it. No LLM provider key is needed; codeflare deliberately ships none, and the agent itself is the extractor (same pattern as the `/graphify` skill's parallel-subagent dispatch).

Compaction is manual: the vault grows append-only and no automated compactor ships. When `Raw/Sessions/` becomes unwieldy, prune or summarise files directly via SilverBullet.

Linking convention enforced in the prompt: concepts go in `[[wikilinks]]` so graphify's external-label dedup unifies them across the vault and per-repo code graphs. File paths, code symbols, and PR references stay as prose -- they namespace per-project and would never auto-link meaningfully.

## User-edit Path (REQ-VAULT-003)

Implements [REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) (monotonic vault graph accumulation across extractions).

A second daemon, `start_vault_monitor_daemon` in entrypoint.sh, polls the vault every 60s. It uses a three-marker pattern to avoid the daemon-advances-mtime-before-extraction-reads-it race:

| Marker | Touched by | Used by |
|---|---|---|
| `vault-monitor.tick` | Daemon, every tick | Diagnostics (heartbeat) |
| `vault-extract.last` | Vault-extract agent, ONLY on success | Daemon's `find -newer` reference |
| `vault-extract.vars` | Daemon, when find returns non-empty | Trigger for `vault-monitor-hook.sh` |

If extraction fails mid-flight, `vault-extract.last` is NOT advanced, the next tick re-discovers the same files, and the system converges. Eventual consistency, no work lost.

A complementary guard in `vault-monitor-hook.sh` covers the daemon-vs-extract overlap case: the daemon ticks every 60s and an extraction run typically takes ~90s on sonnet (was 30-60s on haiku before AD58), so the daemon may re-write `vault-extract.vars` after the agent's step-1 delete. When the agent finishes and advances `vault-extract.last`, that re-written `.vars` is left behind, older than `.last`. The hook detects this on the next prompt (`! "$VARS_FILE" -nt "$LAST_MARKER"`), silently deletes the stale marker, and exits 0 instead of triggering a redundant agent spawn.

The daemon excludes `Raw/Sessions/`, `graphify-out/`, and `.silverbullet/` from the find (agent-owned, derived, editor-config). It also excludes the four preseed-managed root pages (`Index.md`, `CONFIG.md`, `README.md`, `STYLES.md`): `init_user_vault()` overwrites these on every boot when content drifts, so their mtimes reflect a codeflare action rather than a user edit, and including them produced perpetual extract-agent spawns after the always-overwrite tier (REQ-VAULT-010 AC1) landed.

On boots where at least one preseed page was rewritten, `init_user_vault()` also touches `vault-extract.last` before the daemon starts. This advances the high-water mark past the preseed-page mtimes so the very first daemon tick finds nothing and no spurious extraction is triggered. The two guards are layered for defence-in-depth: the AC1 exclusion handles the four pages by name, and the AC6 marker-bump covers any future preseed page added without an exclusion-list update.

`vault-monitor-hook.sh` is the UserPromptSubmit hook for the user-edit path. It exits 0 immediately when `vault-extract.vars` is absent (~99% of prompts), keeping token cost at zero on idle. When the marker is present it emits `additionalContext` instructing the main agent to dispatch the **vault-extract** named subagent (Task tool with `subagent_type="vault-extract"`). The subagent's frontmatter (`preseed/agents/claude/agents/vault-extract.md`) pins `model: sonnet` per AD58; the hook directive instructs the main agent not to pass a model override.

The vault-extract agent's contract (REQ-MEM-009):

1. Delete `vault-extract.vars` (dedup gate).
2. `find` files newer than `vault-extract.last`, excluding the agent-owned subtrees.
3. Acts as the LLM extractor for each changed file: reads the file, produces a chunk JSON (nodes / edges / hyperedges matching graphify's schema; `[[wikilinks]]` become concept nodes with `source_file: null` for cross-repo dedup).
4. Loads the persistent vault graph at `/home/user/Vault/graphify-out/vault-graph.json` (starting from an empty graph if absent), merges the new chunk's nodes/edges using a hash-keyed union (existing IDs dedupe, new IDs append), and writes the updated cumulative graph back to `vault-graph.json`. This is what `graphify global add ... --as user_vault` consumes, so the global graph's `user_vault` tag always reflects cumulative vault content rather than only the most recent extraction. Prior to REQ-MEM-009, each pass replaced the entire `user_vault` entry with the chunk graph, causing vault knowledge to shrink on every extraction (observed: 17 nodes -> 2 nodes after two stub files were extracted).
5. Run `flock -w 5 /tmp/graphify-global.lock graphify global add ... --as user_vault`.
6. Re-render the vault viz HTML: run `graphify cluster-only .` (cwd `/home/user/Vault`) against the per-run `graph.json` and copy `graph.html` into `Raw/Graphs/vault-graph.html` so the `Vault Graph.md` index page link resolves. Non-fatal: failure here does not set `EXTRACT_FAILED` because graph data is already persisted by steps 4-5; the only loss is a stale viz HTML and the next successful extraction re-renders.
7. Touch `vault-extract.last` -- FINAL step only.

## Unified Global Graph (REQ-VAULT-004)

`~/.graphify/global-graph.json` is the hash-keyed merge of every per-source graph plus the vault's own graph. The graphify MCP wrapper prefers this graph when present, so `mcp__graphify__*` tool calls return a unified view across vault + active repos.

Write sites that touch the global graph:

- The capture agent, after writing a vault file (REQ-VAULT-002).
- The vault-extract agent, after user-edit extraction (REQ-VAULT-003).
- `graphify-active-repo.sh`, on every active-repo transition where a per-repo graph exists or its `source_hash` differs from the manifest (single-active-repo invariant; see below).
- The `/graphify` skill, on commit, after building a repo's graph.

All four serialise via `flock -w 5 /tmp/graphify-global.lock`. The locking is necessary because `graphify global add` rewrites the manifest + merged graph file in place; the `-w 5` bound prevents a stuck holder from hanging Bash/Edit/Write/ctx_execute tool calls indefinitely.

### Single-active-repo invariant

`graphify-active-repo.sh` enforces a single-active-repo invariant for the per-repo side of the global graph: at any time the manifest holds the vault entry plus exactly one per-repo entry (the user's currently active repo). The hook is structured around a sentinel at `~/.cache/codeflare-hooks/graphify-active-cwd`:

1. **Fast-path skip**: if the resolved active-repo path equals the prior sentinel value AND `graphify-out/graph.json`'s mtime is not newer than the sentinel's mtime, the hook returns immediately. This avoids spawning the graphify CLI (hundreds of MB of Python imports) on every Bash/Edit/Write/ctx_execute tool call.
2. **Vault skip (REQ-VAULT-004 AC3)**: when the walk-up loop resolves to `$HOME/Vault`, the hook exits 0 without writing the sentinel or invoking `graphify global add`. Comparison canonicalizes `$HOME` via `cd && pwd` (matching how `REPO` is resolved) and also matches on basename `Vault` as a belt-and-suspenders guard against symlink paths into the vault from outside `$HOME`. The vault is registered exclusively by entrypoint init under the tag `user_vault`; this skip prevents a tool call that touches a vault file from re-tagging it as `Vault` (basename) and exposing it to the prune-on-switch logic in step 3.
3. **Repo switch (REQ-VAULT-014 AC1)** (OLD path differs from NEW path with a different basename, and OLD is still in the manifest): `flock -w 5 ... graphify global remove <OLD-basename>` prunes the prior repo's nodes. Same-basename transitions (two clones with identical directory names, or branch switches within the same repo) skip the explicit remove because the add below replaces the existing entry via graphify's source_hash dedup.
4. **Add/refresh**: pre-checks the manifest's recorded `source_hash` against `sha256sum` of the current `graph.json` (truncated to graphify's 16-hex format, with a length sanity-guard so a future format change does not silently degrade to "always re-add"). If the hash differs or the tag is new, `flock -w 5 ... graphify global add --as <basename>` adds or replaces the entry.
5. **Sentinel mtime bump**: `touch`-bumps the sentinel after every non-fast-path fire so subsequent fires can short-circuit until the next graph rebuild.

Branch granularity is intentionally not represented in the manifest -- a repo's tag is its directory basename. Branch switches within the same repo refresh the entry via the hash-diff path once the user has rebuilt the graph on the new branch (`graphify update` or `/graphify`). Until the rebuild runs, the global graph still shows the prior branch's nodes under the same tag, an acceptable staleness window since auto-rebuild on every checkout would be too expensive.

## SilverBullet Editor (REQ-VAULT-005)

The Dockerfile installs the `silverbullet-server-linux-x86_64` binary at `/usr/local/bin/silverbullet`, pinned by version + SHA256. `start_silverbullet_supervisor` in entrypoint.sh runs the server on `127.0.0.1:3030` against the vault, supervised with a 5s restart loop so an editor crash never requires a container restart.

The editor is reached from the codeflare UI through the Worker proxy at `/api/vault/:sid/`. Auth, tier check, and rate-limiting are enforced at the Worker -- see [security.md](./security.md). The in-container HTTP server (`host/src/server.ts`) has a `/vault/*` HTTP branch and a WS upgrade passthrough that proxies to `127.0.0.1:3030`.

The Vault button in `Header.tsx` (`mdiChartGantt` icon, between Bookmarks and Storage) opens the editor in a new tab via `window.open`. It only renders when an active session exists and the layout passes `onVaultOpen` -- terminal view only. The button is rendered `disabled` with a "Vault initializing…" tooltip until `Layout.tsx` confirms vault readiness via a client-side probe: `Layout.tsx` issues `HEAD /api/vault/:sid/` and flips a per-session `vaultReady` flag on the first 200 response, retrying every 3s otherwise (REQ-VAULT-012 AC4). The probe tests the actual vault proxy path, so it also catches SB-crashed scenarios that a startup-stage flag check would miss. This prevents the user from hitting the proxy before SilverBullet has bound 3030 (which would surface `VAULT_UPSTREAM_UNREACHABLE`).

The landing page on every Vault button click is `Index.md` (the Codeflare dashboard), set by exporting `SB_INDEX_PAGE=Index` in the supervisor before launching the binary (REQ-VAULT-012 AC2). The SilverBullet Go server hardcodes the default to lowercase `"index"` (`server/cmd/server.go:29`) and ignores any `indexPage` key in `.silverbullet/config.yaml` -- the env var is the only override. The README is one click away via a link at the top of the dashboard.

### Per-session `<base href>` rewrite (REQ-VAULT-013 AC1)

SilverBullet 2.8.0 emits `<base href="/" />` in its index HTML, so under the `/api/vault/:sid/` subpath proxy every relative asset reference (e.g. `.client/client.js`) would otherwise resolve against the Worker root and 404 -- producing a white screen.

SilverBullet honours `SB_URL_PREFIX` to render the base tag with a prefix, but the prefix is per-session (the Worker knows `:sid`, the container does not), so baking it in at supervisor start is not viable. `handleVaultRequest` in `src/routes/vault.ts` is the per-session adapter: on every response with Content-Type `text/html`, it rewrites `<base href="/" />` to `<base href="/api/vault/<sid>/" />`. The path is not gated -- SilverBullet 2.8 serves its SPA shell as a catch-all on every non-API URL, so a `location.reload()` from a deep page (`/Notes/Today`) lands on that same path and the shell HTML returned there must also be rewritten, otherwise every relative fetch from `client.js` resolves to the Worker root, the tab goes blank, and any in-flight PUT to `.fs/<page>.md` misses the `/api/vault/<sid>` prefix entirely (silently losing the write). The text/html guard alone is sufficient because SilverBullet's API endpoints (`.fs/`, `index.json`, `.attachment/`) return non-HTML content types (text/markdown, application/json, image MIMEs) and never reach the rewriter.

When the body is rewritten, both `Content-Length` (body length changed) and `Content-Encoding` (Workers `Response.text()` auto-decompresses gzip/br upstream, so the body is now plain text) are dropped from the response headers. A `vault base-href rewrite no-op` warning is logged when the rewrite runs but matches nothing -- gated to status 200 on the shell paths (`/`, `/index.html`) so error pages and non-shell HTML do not generate false-positive warnings, so a future SilverBullet template change (single-quoted href, added attribute, etc.) still surfaces as a logged signal on the load-bearing paths.

Rewrite contract (regex, header hygiene, selectors): see `handleVaultRequest` in `src/routes/vault.ts`.

### Service Worker registration noop bypass

SilverBullet's client registers a Service Worker for offline caching. Chrome 76+ omits credentials on `navigator.serviceWorker.register()` script fetches even for same-origin same-site URLs, so the cookie-auth chain at `/api/vault/<sid>/service_worker.js` always returned 401 and registration failed permanently with `Failed to register a ServiceWorker for scope (...) ... A bad HTTP response code (401) was received when fetching the script`.

`handleVaultRequest` short-circuits these requests and serves `VAULT_KEY_SHIM_SERVICE_WORKER_JS` (a minimal `install` + `skipWaiting` + `activate` + `clients.claim` handler set, plus `set-encryption-key` / `get-encryption-key` message handlers for the SB encryption bridge — see the next section) directly from the Worker. The selector requires all four conditions: method `GET`, exact path `/service_worker.js`, request header `Service-Worker: script` (a Fetch-spec forbidden header name -- page JavaScript cannot set it via `fetch()`), and no `Cookie` header. The cookie-absent gate is defence-in-depth: if a future browser path delivers an authenticated SW fetch, the normal auth chain handles it (returning the real upstream SW or 401) instead of the shim shortcut.

The shim SW JS is identical across sessions and contains zero user data (the encryption key is posted in via `postMessage` from the auth-gated bootstrap-hop page, never baked into the JS source), so bypassing auth on this exact request is safe. SilverBullet loses its sync-engine offline-cache feature, which falls back to network through the auth-gated Worker proxy on every read. All other vault operations continue to run from page context where cookies are sent normally; only the SW registration handshake takes this path.

If a real SW ever becomes load-bearing in a future SilverBullet version, the mitigation is to inline its source into `VAULT_KEY_SHIM_SERVICE_WORKER_JS` -- the cookie-absence constraint blocks any path that would otherwise reach the container.

### PUT body forwarding contract (REQ-VAULT-009)

`maybeSynthesizeCsrfHeader` adds `X-Requested-With: XMLHttpRequest` to state-changing requests (PUT/POST/PATCH/DELETE) so `authenticateRequest`'s CSRF guard does not reject vault writes. When a request carries no `Origin` header (SilverBullet's same-origin fetch path, service-worker-controlled fetches, and CLI-style clients), the synthesis now treats the request as same-origin and proceeds rather than skipping it. A request with an Origin header that fails the allowlist still returns 403; the no-Origin fallback does not widen the allowlist. SilverBullet drag-drop attachment uploads (`PUT /api/vault/<sid>/Inbox/<file>`) were the primary trigger: the SB Inbox plug's fetch path omitted Origin, causing the prior code to skip synthesis, reach `authenticateRequest` without `X-Requested-With`, and return 401 to the user.

`container.fetch` must be called with the Request returned by `maybeSynthesizeCsrfHeader`, not the original incoming `request`. The helper consumes the input body when it constructs the header-rewritten clone (Workers Fetch semantics for `new Request(input, { headers })`); forwarding the original raises `TypeError: This ReadableStream is disturbed (has already been read from)`. `handleVaultRequest` hoists `requestForAuth` to outer scope for exactly this reason, and `authenticateRequest` must read only headers (cookies, JWT assertion) -- a future body read inside the auth chain would re-introduce the same bug.

## Vault encryption and per-session IDB lifecycle (REQ-VAULT-008, REQ-VAULT-015)

SilverBullet 2.8 ships full client-side IDB encryption via `EncryptedKvPrimitives` (`client/data/encrypted_kv_primitives.ts`). Activation requires three independent conditions checked in `client/boot.ts:96-143`:

1. `localStorage["enableEncryption"]` is truthy — set by the bootstrap-hop page (below).
2. `bootConfig.enableClientEncryption === true` — set by the Worker's `injectVaultEncryptionConfig` (`src/routes/vault.ts:191`), which rewrites the upstream `/.config` JSON before it reaches the SB client. The same rewrite also injects `bootConfig.vaultEncryptionKey` (the raw AES-CTR base64 from the DO), so the key reaches the SB client through two independent channels: the bootstrap-hop's SW `postMessage` (condition 3, the runtime path SB actually uses) and the bootConfig JSON read at boot. Both must stay in sync — a key rotation that updates one channel without the other will surface as "encryption flag set but SW has no key" and SB will abort the encrypted open.
3. A `CryptoKey` is held in the per-origin service worker's `encryptionKeyMemoryStore`, postMessage'd in via `{type: "set-encryption-key"}` — done by the bootstrap-hop page (below).

The two injection points are distinct: `injectVaultEncryptionConfig` handles condition 2 (a JSON rewrite on the `/.config` proxy response), while the bootstrap-hop page handles conditions 1 and 3 (localStorage flag + SW key transport). Both must fire for SB to enable encryption.

With all three conditions satisfied, SB derives an AES-GCM key from the AES-CTR raw bytes via `deriveGCMKeyFromCTR` (`plug-api/lib/crypto.ts`) and wraps the `sb_data_<hash>` IDB through `EncryptedKvPrimitives`, so values are AES-GCM ciphertext at rest (random IV per write, AES-256). The Worker delivers the raw key material as AES-CTR base64; the wire/transport format is AES-CTR-shaped, the at-rest format is AES-GCM.

The Worker bridges the gap between codeflare's auth model (no SB passphrase, key lives in the Container DO) and SB's runtime contract via a one-time bootstrap-hop page:

- `GET /api/vault/<sid>/.codeflare-bootstrap` renders an auth-gated HTML page (`injectVaultBootstrapHopHtml` in `src/routes/vault.ts`) that registers a key-shim service worker, posts the per-session AES-CTR key (from the DO's `ensureVaultKey()` RPC) via `set-encryption-key`, sets `localStorage["enableEncryption"]`, sets the `codeflare_vault_bootstrap` cookie, then `location.replace`s the user to `/api/vault/<sid>/`. The SB shell handler 302-redirects to this hop on any shell-path request without the bootstrap cookie, so first visits always traverse it. After the hop completes, the cookie suppresses redirects and the shell handler proxies the SB binary normally.
- The service worker (`VAULT_KEY_SHIM_SERVICE_WORKER_JS`) is a minimal handler that responds to `set-encryption-key` / `get-encryption-key` messages. It is NOT the full SilverBullet sync engine; the real SB SW cannot be loaded because Chrome strips cookies on the SW registration GET (chromium.org's SW spec compliance), so the auth-gated upstream path returns 401. The shim holds the key in module memory only — it is gone the moment the browser tears the SW down.

SilverBullet maintains two IndexedDB databases per (spaceFolderPath, baseURI, encryptionKeyPart) tuple: `sb_data_<hash>` (client-context, opened by `client/client.ts:167-178`) and `sb_files_<hash>` (SW-context, opened by `client/service_worker.ts:191-211`). With the shim SW in place the `sb_files_*` IDB is never created — file fetches fall back to network through the auth-gated Worker proxy. Only `sb_data_*` exists, and that is what gets encrypted.

Cleanup runs at two surfaces (`web-ui/src/lib/vault-cache.ts`):

- `cleanupSessionVaultCache(sid)` -- called from `deleteSession()`. Reads `localStorage["vault-session-<sid>-idbs"]` (a JSON array populated at boot by `injectVaultIdbRecorder`, which wraps `indexedDB.open` and records every `sb_*` name SB opens), calls `indexedDB.deleteDatabase(name)` per entry, then drops both `vault-session-<sid>` and `vault-session-<sid>-idbs` localStorage keys and unregisters the service worker scoped to `/api/vault/<sid>/`.
- `sweepOrphanVaultCaches(activeSessionIds)` -- called on Dashboard mount. Iterates every `vault-session-*` and `vault-session-*-idbs` entry in localStorage; for any sid not in `activeSessionIds`, runs the same deletion path. Catches sessions deleted via API in another tab or after a browser crash.

All operations are fail-safe: a missing global (SSR, fresh tab) or malformed `-idbs` JSON value is swallowed silently because cleanup is best-effort and must never block the delete UI or dashboard mount.

**Principled-rejection invariant (load-bearing):** the cleanup helpers MUST NEVER enumerate IDBs via `indexedDB.databases()` and never derive names from the `sb_<type>_<hash>` formula. They work exclusively from the recorded localStorage list. An earlier version parsed `parts[2]` of the IDB name as the sid and nuked every SB IDB on every Dashboard mount, forcing a full SB resync on every reopen. The new design avoids the bug entirely by recording observed names at boot rather than re-deriving them.

## Shutdown Bisync Reliability (REQ-VAULT-006)

The vault's persistence guarantee depends on the final bisync running to completion on session shutdown. Pre-vault, this was a known weak point: the shutdown handler had no timeout on the bisync call, and the DO destroy() SIGKILLed at 25s. A vault edit made in the last seconds before shutdown would be silently truncated if the bisync ran long, leaving R2 in a partial state. The next session loaded that partial state and looked stale, forcing a manual session delete.

Two paired fixes bundled with the vault PR:

- `shutdown_handler` in entrypoint.sh wraps the final `bisync_with_r2` call in a background subshell with a watchdog that hard-kills at 120s (raised from 60s in AD57 because the 15-minute cadence from AD56 lets a single bisync accumulate up to 15 minutes of writes). Vault-monitor and SilverBullet supervisor PIDs are also terminated.
- `Container.destroy()` in `src/container/index.ts` uses `timeoutMs = 135_000` (120s for bisync + 15s buffer). `onStop()` logs `shutdownElapsedMs` and a `logger.warn` fires at 110 s elapsed so any session approaching the budget surfaces in logs and the budget can be tuned again if needed.

If the bisync exceeds 120s, the log records `TIMED OUT after 120s` -- a recognisable string for operators triaging stale-session reports.

## Preseed Integration (REQ-VAULT-007)

The vault plugin and supporting rule ship as preseed entries that land in every advanced-mode session at container boot:

- `preseed/agents/claude/plugins/codeflare-vault/` -- plugin descriptor, `vault-monitor-hook.sh` UserPromptSubmit hook, `vault-extract-prompt.md` (the 5-step contract for the vault-extract subagent), and `merge-vault-graph.py` (Step 4 load+compose+cluster+persist helper invoked under flock; REQ-MEM-009). Registered in `preseed/agents/claude/manifest.json`.
- `preseed/agents/claude/agents/vault-extract.md` -- named subagent definition; frontmatter pins `model: sonnet` per AD58 so the model cannot be silently downgraded via a Task tool override. Registered in the manifest's top-level `agents/` section and delivered via `reconcileAgentConfigs()` (same pipeline as architect, code-reviewer, etc.).
- Vault trigger/route content lives in `preseed/agents/claude/rules/memory.md` under the "Vault operations" and "Vault-edit hook" subsections (folded in rather than carried as a separate `rules/vault.md`). Vault layout, wikilink conventions, and the NEVER list live in `preseed/agents/claude/skills/vault-operations/SKILL.md` (advanced-mode only).
- `preseed/agents/claude/rules/vault-note-capture.md` + `preseed/agents/claude/skills/vault-note-capture/SKILL.md` -- minimal trigger rule + on-demand skill that captures "take a note" / "note this down" requests into `Notes/<Category>/`. Advanced-mode only. The rule stays small to keep always-in-context bloat minimal; the skill loads on demand with category inference, filename format, body template, and wikilink convention.
- `preseed/silverbullet/` -- optional `atlas.plug.js`, the four preseeded plug files (`pdf`, `treeview`, `github`, `graph` -- see `preseed/silverbullet/plugs/MANIFEST.md`), and the four preseed-managed pages (`Index.md`, `README.md`, `CONFIG.md`, `STYLES.md`). The Dockerfile copies this directory to `/opt/silverbullet-preseed/`; `init_user_vault()` syncs from there on every boot. (`config.yaml` was removed -- SilverBullet 2.x ignores `.silverbullet/config.yaml` entirely; runtime config goes through `CONFIG.md` and env vars only.)

`scripts/generate-agent-seed.mjs` reads the manifest and emits `src/lib/agent-seed.generated.ts`, the typed payload that the container fetches and writes during preseed. The vault plugin appears in default mode's manifest only as the rule's exclusion entry; runtime files are advanced-mode gated.

### Vault initialization tiers (REQ-VAULT-001 AC3 + REQ-VAULT-010 AC1/AC4/AC5)

`init_user_vault()` is split into three tiers by what the user can durably change:

| Tier | Path | Behaviour on every boot |
|------|------|------------------------|
| Always-mkdir (critical dirs) | `Raw/Sessions/`, `Raw/Pasted/`, `Raw/Graphs/`, `Notes/`, `graphify-out/`, `.silverbullet/_plug/` | `mkdir -p`; existing contents untouched. User-deleted directories are recreated empty so agent hooks and SilverBullet cannot land in a broken state. |
| Always-overwrite (Codeflare-authoritative pages) | `Index.md`, `README.md`, `CONFIG.md`, `STYLES.md` | Copied from `/opt/silverbullet-preseed/`, gated so identical files are not rewritten. User edits are silently reverted on next boot; these files are Codeflare-owned because they encode dashboard contract, SB `#meta` config, theme, and user guide. |
| Create-if-missing (user-editable index page) | `Raw/Graphs/Vault Graph.md` | Copied from `/opt/silverbullet-preseed/Raw/Graphs/` only when absent. Never overwritten on subsequent boots -- user edits and deletions are preserved. Seeded so the treeview shows a `Raw/Graphs/` folder on a fresh vault (treeview is page-driven; an empty directory is invisible). |
| One-time cleanup (legacy pages) | `Raw/Graphs/Global Graph.md`, `Raw/Graphs/global-graph.html` | Removed on every boot if present (idempotent `rm -f`). The unified global graph is a 10k+ node corpus that renders as an unusable force-directed hairball; structural queries via `mcp__graphify__*` are the real interface. Vaults restored from R2 snapshots predating the drop are reconciled to current state on the next boot. |
| Recreate-if-missing (build-output stub) | `graphify-out/graph.json` | Seeded with the empty-graph JSON only when absent; the populated graph from a prior session is never overwritten. The graph is build output regenerated by `graphify extract` / `graphify global add`. |
| Cleanup of dead config | `.silverbullet/config.yaml` | Removed on every boot. SilverBullet 2.x does not read this file; leaving it on disk only misleads future readers. |
| Idempotent plug sync | `Library/Codeflare/*.plug.js` | Each file copied from `/opt/silverbullet-preseed/plugs/` only when content differs. User plugs in other `Library/` subdirectories are untouched. **Never** copy a partial `Library/Std/` onto disk -- SilverBullet's binary ships compiled `Library/Std/Plugs/*.plug.js` via `client_bundle/base_fs` overlay; a disk shadow with only source markdown breaks widget rendering. |

The contract closes failure modes that surfaced in earlier releases:
- Deleting any preseed page silently broke the SilverBullet dashboard or theme.
- An R2-restored vault that pre-dated a preseed update would carry stale pages forever, because the prior `init_user_vault()` only ran content sync inside the first-init gate.
- A `.silverbullet/config.yaml` file from older releases gave a false sense that SB was reading bootstrap settings from it; in SB 2.x the file is dead and only env vars + `CONFIG.md` actually configure the server.

### CONFIG.md and Library/Std (base_fs)

`CONFIG.md` is a SilverBullet 2.x `#meta` page with an optional `space-lua` config block (built-in keys defined in `Library/Std/Config.md`; see [SilverBullet docs](https://silverbullet.md/Configuration)). Earlier releases used a yaml block with `libraries:` and `pageBlackList:` -- both keys are unrecognized by SB 2.x and were always no-ops.

The preseed `CONFIG.md` includes a `space-lua` block that configures treeview navigation exclusions (REQ-VAULT-015 AC2). The upstream silverbullet-treeview plug v2 schema requires the top-level key `treeview` (not `plug.treeview`) and the field `exclusions` (not `exclude`), where each entry is `{ type = "regex", rule = "<regex>" }`. Bare-string glob patterns are silently dropped by the plug. The block hides `Library/`, `Repositories/`, `graphify-out/`, and the four top-level preseed pages (`CONFIG`, `Index`, `README`, `STYLES`). `Repositories/` is SilverBullet's own library-manager mirror created at runtime by the Library Manager plug; users do not curate it. `.silverbullet/` is dot-prefixed and hidden by SilverBullet's default behaviour without an explicit rule. This exclusion list is the UI-side complement to the server-side `/.fs` filter (REQ-VAULT-015 AC1) that strips `graphify-out/**` from raw listings.

`Library/Std` (and its compiled `Plugs/*.plug.js`) is served by the SilverBullet binary from its built-in `client_bundle/base_fs` overlay. There is nothing to federate at runtime and nothing to preseed onto disk. The dashboard's `widgets.commandButton`, `templates.fullPageItem`, `templates.pageItem`, `templates.taskItem`, `index.contentPages()`, and `tags.page` all resolve through that overlay automatically. The first-load delay (~30 s on a fresh browser) is the SilverBullet client building its IndexedDB index of Library/Std files; subsequent loads are instant from cache.

### STYLES.md and codeflare theming (REQ-VAULT-007)

`STYLES.md` applies the codeflare visual theme inside SilverBullet via the `#meta/styles` tag (SilverBullet's convention for theme pages). It targets SilverBullet 2.x's CSS variable namespace under `html[data-theme="dark"]` (`--root-*`, `--ui-accent-*`, `--top-*`, `--button-*`, `--editor-*`, `--modal-*`, `--panel-*`, `--editor-wiki-link-*`), verified against `client/styles/theme.scss` in the 2.8.0 source. The codeflare palette tokens (`--cf-*`, zinc dark base + blue accent matching `web-ui/src/styles/design-tokens.css`) are defined locally in `:root` and consumed by the SB variables. Earlier versions of this file only defined `--cf-*` variables, which SilverBullet does not read, so the theme had no visual effect until the variable mapping was corrected. See [AD55](../decisions/README.md#ad55-codeflare-brands-the-vault-editor-via-preseed-managed-stylesmd). It is always-overwritten on boot and cannot be customised in-place; theme changes must go through `preseed/silverbullet/STYLES.md` in the repo.

### SilverBullet plug preinstall (REQ-VAULT-007)

On every boot, `init_user_vault()` copies the plug files from `/opt/silverbullet-preseed/plugs/` into `~/Vault/Library/Codeflare/`. The copy is idempotent: each file is only overwritten when its content differs from the installed copy (using `cmp`), so a pin bump in the Dockerfile propagates on the next boot without touching user-written notes.

| Plug | Provides |
|---|---|
| `pdf` | Inline PDF rendering inside notes |
| `treeview` | File tree sidebar |
| `github` | GitHub issue/PR embedding |
| `graph` | Local graph visualisation of `[[wikilinks]]` |

`Library/Codeflare/` is reserved for codeflare-managed plugs. User-installed plugs go under other `Library/` subdirectories (e.g. `Library/Personal/`); the boot-time overwrite never touches those paths.

## First-session Expectations

A brand-new session boots with a pre-populated vault: `Index.md`, `README.md`, `CONFIG.md`, and `STYLES.md` are always written from preseed on every boot. Critical subdirectories (`Raw/Sessions/`, `Raw/Pasted/`, `Raw/Graphs/`, `Notes/`, `graphify-out/`, `.silverbullet/_plug/`) are always `mkdir -p`'d. `Raw/Graphs/Vault Graph.md` is seeded from preseed only when absent (never overwritten). Legacy `Global Graph.md` pages from earlier installs are removed on every boot (the unified global graph is too large for useful HTML rendering; use `mcp__graphify__*` instead). `graphify-out/graph.json` is seeded as an empty stub only when absent. A returning session inherits R2-restored content for user-owned paths (`Notes/`, `Inbox/`, `Journal/`, `Raw/Pasted/`, `Raw/Sessions/`); the always-overwrite pages are refreshed from preseed regardless, so any preseed update propagates without per-user migration.

`init_user_vault()` runs AFTER `establish_bisync_baseline()` so we never run the per-boot sync over a half-restored vault. If the baseline fails for any reason, the init function still runs (`(init_user_vault) || echo ...`) and the critical-dir + preseed-page tiers are created locally; the next successful bisync reconciles user content.

On first browser open after a fresh vault, the dashboard widgets ("Quick Note" button, "Journal: Today" button, "Recently modified pages") take ~30 seconds to populate while the SilverBullet client builds its IndexedDB index of `Library/Std` (served from the binary's base_fs overlay). The Vault button in the header is rendered `disabled` with a "Vault initializing…" tooltip until `Layout.tsx` receives a 200 from `HEAD /api/vault/:sid/` (the `vaultReady` probe; REQ-VAULT-012 AC4), so the user cannot hit the proxy before SilverBullet has bound 3030. Subsequent loads in the same browser are instant from cache.

Visual confirmation that the preseed theme is wired correctly: the editor renders on a zinc-950 base (`#09090b`), wikilinks and modal selection use a blue-500 accent (`hsl(217, 91%, 60%)`), body type is Inter and code spans are JetBrains Mono. If the editor shows SilverBullet's default white/cream palette, `STYLES.md` is missing or targeting variables SB does not consume (the previous `--cf-*`-only regression).

The vault-monitor daemon does not fire a spurious extraction on first boot or after a preseed update: `init_user_vault()` bumps `vault-extract.last` past the preseed-page mtimes whenever it rewrites a page, and the daemon's find excludes the four preseed-managed pages by name. A fresh session sends 5 prompts in a row with no user vault edits and the vault-extract hook fires zero times.

## Attachment Cost Caveat (REQ-VAULT-011 AC1)

SilverBullet writes pasted / drag-dropped attachments next to the note that referenced them (a Quick Note at `Inbox/2026-05-18/16-59-59.md` produces attachments at `Inbox/2026-05-18/*.pdf`, `.png`, etc.). The vault-extract agent reads PDFs via the Read tool (rendering pages as images, capped at 20 pages per PDF) and emits a `document` node plus `concept` nodes for whatever titles / headings / entities are visible. Image-only PDFs and screenshots cost vision tokens per page on every ingestion pass; be aware when pasting many images into notes you expect to query frequently. Move attachments to `Raw/Pasted/` manually if you want them grouped outside the date-folder rhythm.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Vault button missing from header | Not in terminal view, or no active session | Open a session terminal; the button renders only when both are true. |
| `curl http://127.0.0.1:3030/` returns nothing inside the container | SilverBullet supervisor not yet up | Wait 5s and retry; check `/tmp/silverbullet.log` for the restart-loop output. |
| `mcp__graphify__query_graph` returns no vault nodes | Global graph not built yet, or wrapper still pointing at per-repo graph | Check `~/.graphify/global-graph.json` exists; if it does, restart the MCP wrapper (it polls on a 2s loop). |
| Edits don't appear in graph queries within 60s | Vault-extract marker stale | Look at `~/.cache/codeflare-hooks/vault-extract.last` mtime; force a new tick by touching a file under `Notes/`. |
| Stale session state on reopen after stop | Shutdown bisync was killed mid-write | Look for `TIMED OUT after 120s` (or the `logger.warn` at 110 s elapsed) in Durable Object logs (`wrangler tail <SCRIPT_NAME>`); raise the watchdog budget in `shutdown_handler` if it fires routinely. |
| `/api/vault/:sid/` returns 503 | SilverBullet supervisor not ready | The Vault button is disabled until `Layout.tsx` receives a 200 from `HEAD /api/vault/:sid/` (the `vaultReady` probe). Wait 3-5 s and retry; the probe re-enables the button automatically once SilverBullet binds port 3030. |
| Clicking "Quick Note" shows `You are not authenticated, going to reload...` alert, then reloads to a blank/white page | SilverBullet's client.js writes via PUT/DELETE/PATCH without `X-Requested-With`, which `authenticateRequest`'s CSRF guard required (fixed by the Origin-validated synthesis in `src/routes/vault.ts`) | Redeploy the container image to pick up the fix. As a temporary workaround, open the vault in a fresh browser tab (clears any stale ServiceWorker scope that may compound the loop). |
| Drag-dropping a PDF or image into SilverBullet returns 401; attachment never saves | Older image: `maybeSynthesizeCsrfHeader` skipped synthesis when `Origin` was absent (SilverBullet's same-origin fetch and SW-controlled paths omit it), so the PUT landed at `authenticateRequest` without `X-Requested-With` (REQ-VAULT-009). | Redeploy. After the fix, a missing `Origin` header is treated as same-origin and synthesis proceeds. A present-but-disallowed `Origin` still returns 403. |
| SilverBullet opens lowercase "index" (empty editor) instead of the Codeflare dashboard | Supervisor not exporting `SB_INDEX_PAGE=Index` before launching the binary | Confirm the env var is set in `entrypoint.sh start_silverbullet_supervisor`. SB's Go server hardcodes the default to `"index"` (`server/cmd/server.go:29`); the env var is the only override. |
| Vault button clickable during boot returns `VAULT_UPSTREAM_UNREACHABLE` | UI is not gating on vault readiness | The button should be disabled until `Layout.tsx` receives a 200 from `HEAD /api/vault/:sid/`. If you see it clickable too early, the `vaultReady` probe loop in `Layout.tsx` has regressed -- check that the `HEAD` fetch is running and the 3s retry is wired correctly. |
| Dashboard widgets render as raw `${query[[...]]}` text or nothing | Someone copied a partial `Library/Std/` onto disk, shadowing the binary's `base_fs` overlay | `rm -rf ~/Vault/Library/Std` and restart SB. Library/Std is shipped inside the SilverBullet binary; **never** seed it from disk. |
| `mcp__graphify__query_graph` returns no vault nodes even after several capture cycles | Older image: capture agent called `graphify extract --file` (requires an LLM provider key, codeflare ships none), so every run produced 0 nodes | Redeploy. After the fix, agents self-extract via their own conversation and emit chunk JSON that `graphify global add` ingests. |
| Browser console shows `Failed to register a ServiceWorker ... 401 ... fetching the script`; SilverBullet loads but appears unregistered as a PWA / offline mode never activates | Older image: SW registration GET at `/api/vault/<sid>/service_worker.js` ran the cookie-auth chain, but Chrome 76+ omits credentials on SW script fetches (no `Cookie` header sent), so auth returned 401 and registration failed permanently | Redeploy. The Worker now short-circuits SW registration via `VAULT_KEY_SHIM_SERVICE_WORKER_JS` (selector: `service-worker: script` header + no `Cookie`) and returns a key-shim SW the browser accepts. Distinct from the CSRF / Quick-Note row above; both can be present on a pre-fix image. |
| Editing a SilverBullet note shows `Could not save page, retrying again in 10 seconds` repeatedly; saves never succeed | Older image: PUT requests went through `maybeSynthesizeCsrfHeader` which clones the request to add `X-Requested-With`, consuming the original body; the proxy then forwarded the original (now disturbed) request to `container.fetch`, raising `TypeError: This ReadableStream is disturbed` and returning 500 | Redeploy. The proxy now forwards the auth-validated clone (which owns the body) instead of the original; pre-fix images log `Vault request error` with the disturbed-stream stack trace in Worker logs (`wrangler tail` or Cloudflare Observability). |
| Browser console shows `Enabled client-side encryption for synced files` but SB then aborts the encrypted IDB open / shows "encryption flag set but SW has no key" | Key-rotation desync between the two channels: `injectVaultEncryptionConfig` rewrote `/.config` with a fresh `vaultEncryptionKey` + `enableClientEncryption=true`, but the bootstrap-hop `postMessage({type:"set-encryption-key"})` was not re-run, so the SW shim still holds the previous key (or none). Causes: the user kept an old vault tab open across a key rotation, or a partial deploy updated `injectVaultEncryptionConfig` without restarting the SW. | Reload the vault tab end-to-end (Cmd-Shift-R / Ctrl-Shift-R) so the bootstrap-hop runs fresh and posts the current key into the SW. If a rotation is in progress, force-unregister the SW from DevTools - Application - Service Workers, drop the `codeflare_vault_bootstrap` cookie, then reload; the shell-path handler will redirect through the hop again. The key-shim SW holds the key in module memory only - tearing it down is always safe. |

## Specification Coverage

- [REQ-VAULT-001](../../sdd/spec/vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions) - Persistent vault directory survives across sessions
- [REQ-VAULT-002](../../sdd/spec/vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown) - Conversation captures land in the vault as markdown
- [REQ-VAULT-003](../../sdd/spec/vault.md#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s) - User-curated edits are detected and ingested within ~60s
- [REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) - Unified global graph merges vault and active repos
- [REQ-VAULT-006](../../sdd/spec/vault.md#req-vault-006-shutdown-bisync-completes-vault-writes-before-sigkill) - Shutdown bisync completes vault writes before SIGKILL
- [REQ-VAULT-008](../../sdd/spec/vault.md#req-vault-008-zero-ui-vault-encryption) - Zero-UI vault encryption
- [REQ-VAULT-009](../../sdd/spec/vault.md#req-vault-009-vault-writes-succeed-end-to-end-for-silverbullet-attachment-uploads) - Vault writes succeed end-to-end for SilverBullet attachment uploads
- [REQ-VAULT-010](../../sdd/spec/vault.md#req-vault-010-codeflare-authoritative-files-preseeded-into-the-vault-on-every-boot) - Codeflare-authoritative files preseeded into the vault on every boot
- [REQ-VAULT-011](../../sdd/spec/vault.md#req-vault-011-vault-extract-ingests-pdf-files) - Vault-extract ingests PDF files
- [REQ-VAULT-013](../../sdd/spec/vault.md#req-vault-013-silverbullet-subpath-adapter) - SilverBullet subpath adapter
- [REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation) - Graphify active-repo invariant and lock serialisation
- [REQ-VAULT-015](../../sdd/spec/vault.md#req-vault-015-vault-idb-lifecycle-and-listing-filters) - Vault IDB lifecycle and listing filters

---

## Related Documentation

- [memory.md](./memory.md) -- The capture-hook plumbing that the vault reuses.
- [architecture.md](./architecture.md) -- Container layout, Worker proxy boundary.
- [deployment.md](./deployment.md) -- How Dockerfile + preseed land in a new session.
- [`sdd/vault.md`](../../sdd/spec/vault.md) -- Spec / acceptance criteria.
