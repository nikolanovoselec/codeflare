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
- [Shutdown Bisync Reliability](#shutdown-bisync-reliability-req-vault-006)
- [Preseed Integration](#preseed-integration-req-vault-007)
  - [SilverBullet plug preinstall](#silverbullet-plug-preinstall-req-vault-007)
- [First-session Expectations](#first-session-expectations)
- [Image-pasting Cost Caveat](#image-pasting-cost-caveat)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

---

## Overview (REQ-VAULT-001)

The vault lives at `/home/user/Vault/` inside every advanced-mode session container. It is rclone-bisynced to R2 alongside the rest of `/home/user/`, so anything written here is on the next session you start.

Two parties write to the vault:

- The **capture sonnet** appends a markdown file to `raw/sessions/` every 15 user prompts (replaces the old MCP-memory write path).
- **The user** edits notes via SilverBullet (or any other tool that touches files under `notes/` or `raw/pasted/`).

A single 60s daemon polls for user edits and signals a background sonnet to ingest them into the unified graphify graph. Future agents query that graph via `mcp__graphify__*` and see captures + user notes + every active repo's code, merged.

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
|   |-- raw/
|   |   |-- sessions/      <- AGENT-OWNED: one .md per 15-prompt capture
|   |   `-- pasted/        <- USER-OWNED: image/PDF drops from SilverBullet
|   |-- notes/             <- USER-OWNED: curated prose, concept notes
|   |-- graphify-out/      <- DERIVED: graphify extract output (do not edit)
|   |-- Library/
|   |   `-- Codeflare/     <- CODEFLARE-MANAGED: preseeded SilverBullet plugs
|   `-- .silverbullet/     <- EDITOR CONFIG: SilverBullet config + plug cache
|-- Uploads/           <- persistent drop zone for files (always bisynced)
`-- Temporary/         <- persistent scratch space (always bisynced)
```

`raw/`, `notes/`, and `graphify-out/` are where content lives. `graphify-out/` is updated by the vault-extract sonnet via a chunk-JSON merge on every user-edit tick (not a full re-extract). `.silverbullet/` is owned by the editor. `Library/Codeflare/` holds the plug files managed by codeflare (pdf, treeview, github, graph) -- see [Preseed Integration](#preseed-integration-req-vault-007).

**Hidden-root constraint (see [AD54](#ad54-vault-directory-must-use-a-non-hidden-basename)):** The vault directory must use a non-hidden basename. SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the directory walk when the root basename begins with `.`, returning an empty file listing even when notes are present on disk. This is why the path is `/home/user/Vault/`, not `/home/user/.user_vault/`.

## Capture Path (REQ-VAULT-002)

The `memory-capture.sh` UserPromptSubmit hook fires every 15 user messages, writes a `.vars` marker, and emits `additionalContext` instructing the main agent to spawn a background sonnet. The sonnet runs `memory-agent-prompt.md` end to end:

1. Deletes the `.vars` marker (dedup gate so a concurrent prompt cannot spawn a duplicate).
2. Reads the new transcript range.
3. Identifies decisions, observations, references, and a short topic phrase.
4. Writes `/home/user/Vault/raw/sessions/{ISO_TS}-{SID_SHORT}.md` using the YAML-frontmatter template (session id, captured-at, captured-from-range, then Context / Decisions / Observations / References sections).
5. Acts as the LLM extractor: reads the file it just wrote, emits a chunk JSON matching graphify's extraction schema (nodes / edges / hyperedges, with `[[wikilinks]]` as `file_type:concept` nodes carrying `source_file: null` so graphify's `external_labels` dedup in `global_add` unifies them across the vault and per-repo graphs by label), calls `graphify.build.build_from_json` + `graphify.cluster.cluster` + `graphify.export.to_json` from the Python API to produce a `graph.json`, then runs `flock /tmp/graphify-global.lock graphify global add ... --as user_vault` to merge it. No LLM provider key is needed; codeflare deliberately ships none, and the sonnet itself is the extractor (same pattern as the `/graphify` skill's parallel-subagent dispatch).

Compaction is manual: the vault grows append-only and no automated compactor ships. When `raw/sessions/` becomes unwieldy, prune or summarise files directly via SilverBullet.

Linking convention enforced in the prompt: concepts go in `[[wikilinks]]` so graphify's external-label dedup unifies them across the vault and per-repo code graphs. File paths, code symbols, and PR references stay as prose -- they namespace per-project and would never auto-link meaningfully.

## User-edit Path (REQ-VAULT-003)

A second daemon, `start_vault_monitor_daemon` in entrypoint.sh, polls the vault every 60s. It uses a three-marker pattern to avoid the daemon-advances-mtime-before-extraction-reads-it race:

| Marker | Touched by | Used by |
|---|---|---|
| `vault-monitor.tick` | Daemon, every tick | Diagnostics (heartbeat) |
| `vault-extract.last` | Vault-extract sonnet, ONLY on success | Daemon's `find -newer` reference |
| `vault-extract.vars` | Daemon, when find returns non-empty | Trigger for `vault-monitor-hook.sh` |

If extraction fails mid-flight, `vault-extract.last` is NOT advanced, the next tick re-discovers the same files, and the system converges. Eventual consistency, no work lost.

A complementary guard in `vault-monitor-hook.sh` covers the daemon-vs-sonnet overlap case: the daemon ticks every 60s and a sonnet run takes around 90s, so the daemon may re-write `vault-extract.vars` after the sonnet's step-1 delete. When the sonnet finishes and advances `vault-extract.last`, that re-written `.vars` is left behind, older than `.last`. The hook detects this on the next prompt (`! "$VARS_FILE" -nt "$LAST_MARKER"`), silently deletes the stale marker, and exits 0 instead of triggering a redundant sonnet spawn.

The daemon excludes `raw/sessions/`, `graphify-out/`, and `.silverbullet/` from the find. Those are agent-owned, derived, or editor-config respectively.

`vault-monitor-hook.sh` is the UserPromptSubmit hook for the user-edit path. It exits 0 immediately when `vault-extract.vars` is absent (~99% of prompts), keeping token cost at zero on idle. When the marker is present it emits `additionalContext` pointing the main agent at `vault-extract-prompt.md`.

The vault-extract sonnet's contract:

1. Delete `vault-extract.vars` (dedup gate).
2. `find` files newer than `vault-extract.last`, excluding the agent-owned subtrees.
3. Acts as the LLM extractor for each changed file: reads the file, produces a chunk JSON (nodes / edges / hyperedges matching graphify's schema; `[[wikilinks]]` become concept nodes with `source_file: null` for cross-repo dedup), then calls graphify's Python API to build and cluster a `graph.json`.
4. Run `flock /tmp/graphify-global.lock graphify global add ... --as user_vault`.
5. Touch `vault-extract.last` -- FINAL step only.

## Unified Global Graph (REQ-VAULT-004)

`~/.graphify/global-graph.json` is the hash-keyed merge of every per-source graph plus the vault's own graph. The graphify MCP wrapper prefers this graph when present, so `mcp__graphify__*` tool calls return a unified view across vault + active repos.

Write sites that touch the global graph:

- The capture sonnet, after writing a vault file (REQ-VAULT-002).
- The vault-extract sonnet, after user-edit extraction (REQ-VAULT-003).
- `graphify-active-repo.sh`, on every active-repo transition where a per-repo graph exists or its `source_hash` differs from the manifest (single-active-repo invariant; see below).
- The `/graphify` skill, on commit, after building a repo's graph.

All four serialise via `flock -w 5 /tmp/graphify-global.lock`. The locking is necessary because `graphify global add` rewrites the manifest + merged graph file in place; the `-w 5` bound prevents a stuck holder from hanging Bash/Edit/Write/ctx_execute tool calls indefinitely.

### Single-active-repo invariant

`graphify-active-repo.sh` enforces a single-active-repo invariant for the per-repo side of the global graph: at any time the manifest holds the vault entry plus exactly one per-repo entry (the user's currently active repo). The hook is structured around a sentinel at `~/.cache/codeflare-hooks/graphify-active-cwd`:

1. **Fast-path skip**: if the resolved active-repo path equals the prior sentinel value AND `graphify-out/graph.json`'s mtime is not newer than the sentinel's mtime, the hook returns immediately. This avoids spawning the graphify CLI (hundreds of MB of Python imports) on every Bash/Edit/Write/ctx_execute tool call.
2. **Vault skip (REQ-VAULT-004 AC4)**: when the walk-up loop resolves to `$HOME/Vault`, the hook exits 0 without writing the sentinel or invoking `graphify global add`. Comparison canonicalizes `$HOME` via `cd && pwd` (matching how `REPO` is resolved) and also matches on basename `Vault` as a belt-and-suspenders guard against symlink paths into the vault from outside `$HOME`. The vault is registered exclusively by entrypoint init under the tag `user_vault`; this skip prevents a tool call that touches a vault file from re-tagging it as `Vault` (basename) and exposing it to the prune-on-switch logic in step 3.
3. **Repo switch** (OLD path differs from NEW path with a different basename, and OLD is still in the manifest): `flock -w 5 ... graphify global remove <OLD-basename>` prunes the prior repo's nodes. Same-basename transitions (two clones with identical directory names, or branch switches within the same repo) skip the explicit remove because the add below replaces the existing entry via graphify's source_hash dedup.
4. **Add/refresh**: pre-checks the manifest's recorded `source_hash` against `sha256sum` of the current `graph.json` (truncated to graphify's 16-hex format, with a length sanity-guard so a future format change does not silently degrade to "always re-add"). If the hash differs or the tag is new, `flock -w 5 ... graphify global add --as <basename>` adds or replaces the entry.
5. **Sentinel mtime bump**: `touch`-bumps the sentinel after every non-fast-path fire so subsequent fires can short-circuit until the next graph rebuild.

Branch granularity is intentionally not represented in the manifest -- a repo's tag is its directory basename. Branch switches within the same repo refresh the entry via the hash-diff path once the user has rebuilt the graph on the new branch (`graphify update` or `/graphify`). Until the rebuild runs, the global graph still shows the prior branch's nodes under the same tag, an acceptable staleness window since auto-rebuild on every checkout would be too expensive.

## SilverBullet Editor (REQ-VAULT-005)

The Dockerfile installs the `silverbullet-server-linux-x86_64` binary at `/usr/local/bin/silverbullet`, pinned by version + SHA256. `start_silverbullet_supervisor` in entrypoint.sh runs the server on `127.0.0.1:3030` against the vault, supervised with a 5s restart loop so an editor crash never requires a container restart.

The editor is reached from the codeflare UI through the Worker proxy at `/api/vault/:sid/`. Auth, tier check, and rate-limiting are enforced at the Worker -- see [security.md](./security.md). The in-container HTTP server (`host/src/server.ts`) has a `/vault/*` HTTP branch and a WS upgrade passthrough that proxies to `127.0.0.1:3030`.

The Vault button in `Header.tsx` (`mdiChartGantt` icon, between Bookmarks and Storage) opens the editor in a new tab via `window.open`. It only renders when an active session exists and the layout passes `onVaultOpen` -- terminal view only.

### Per-session `<base href>` rewrite (REQ-VAULT-005 AC7)

SilverBullet 2.8.0 emits `<base href="/" />` in its index HTML, so under the `/api/vault/:sid/` subpath proxy every relative asset reference (e.g. `.client/client.js`) would otherwise resolve against the Worker root and 404 -- producing a white screen.

SilverBullet honours `SB_URL_PREFIX` to render the base tag with a prefix, but the prefix is per-session (the Worker knows `:sid`, the container does not), so baking it in at supervisor start is not viable. `handleVaultRequest` in `src/routes/vault.ts` is the per-session adapter: on every response with Content-Type `text/html`, it rewrites `<base href="/" />` to `<base href="/api/vault/<sid>/" />`. The path is not gated -- SilverBullet 2.8 serves its SPA shell as a catch-all on every non-API URL, so a `location.reload()` from a deep page (`/Notes/Today`) lands on that same path and the shell HTML returned there must also be rewritten, otherwise every relative fetch from `client.js` resolves to the Worker root, the tab goes blank, and any in-flight PUT to `.fs/<page>.md` misses the `/api/vault/<sid>` prefix entirely (silently losing the write). The text/html guard alone is sufficient because SilverBullet's API endpoints (`.fs/`, `index.json`, `.attachment/`) return non-HTML content types (text/markdown, application/json, image MIMEs) and never reach the rewriter.

When the body is rewritten, both `Content-Length` (body length changed) and `Content-Encoding` (Workers `Response.text()` auto-decompresses gzip/br upstream, so the body is now plain text) are dropped from the response headers. A `vault base-href rewrite no-op` warning is logged when the rewrite runs but matches nothing -- gated to status 200 on the shell paths (`/`, `/index.html`) so error pages and non-shell HTML do not generate false-positive warnings, so a future SilverBullet template change (single-quoted href, added attribute, etc.) still surfaces as a logged signal on the load-bearing paths.

Rewrite contract (regex, header hygiene, selectors): see `handleVaultRequest` in `src/routes/vault.ts`.

### Service Worker registration noop bypass

SilverBullet's client registers a Service Worker for offline caching. Chrome 76+ omits credentials on `navigator.serviceWorker.register()` script fetches even for same-origin same-site URLs, so the cookie-auth chain at `/api/vault/<sid>/service_worker.js` always returned 401 and registration failed permanently with `Failed to register a ServiceWorker for scope (...) ... A bad HTTP response code (401) was received when fetching the script`.

`handleVaultRequest` short-circuits these requests and serves `VAULT_NOOP_SERVICE_WORKER_JS` (a minimal `install` + `skipWaiting` + `activate` + `clients.claim` handler set) directly from the Worker. The selector requires all four conditions: method `GET`, exact path `/service_worker.js`, request header `Service-Worker: script` (a Fetch-spec forbidden header name -- page JavaScript cannot set it via `fetch()`), and no `Cookie` header. The cookie-absent gate is defence-in-depth: if a future browser path delivers an authenticated SW fetch, the normal auth chain handles it (returning the real upstream SW or 401) instead of the static-noop shortcut.

The static SW JS is identical across sessions and contains zero user data, so bypassing auth on this exact request is safe. SilverBullet loses its offline-cache feature, which is non-essential for online use. All other vault operations continue to run from page context where cookies are sent normally; only the SW registration handshake takes this path.

If a real SW ever becomes load-bearing in a future SilverBullet version, the mitigation is to inline its source into `VAULT_NOOP_SERVICE_WORKER_JS` -- the cookie-absence constraint blocks any path that would otherwise reach the container.

### PUT body forwarding contract

For body-bearing methods (PUT/POST/PATCH), `container.fetch` must be called with the Request returned by `maybeSynthesizeCsrfHeader`, not the original incoming `request`. The helper consumes the input body when it constructs the header-rewritten clone (Workers Fetch semantics for `new Request(input, { headers })`); forwarding the original raises `TypeError: This ReadableStream is disturbed (has already been read from)`. `handleVaultRequest` hoists `requestForAuth` to outer scope for exactly this reason, and `authenticateRequest` must read only headers (cookies, JWT assertion) -- a future body read inside the auth chain would re-introduce the same bug.

## Shutdown Bisync Reliability (REQ-VAULT-006)

The vault's persistence guarantee depends on the final bisync running to completion on session shutdown. Pre-vault, this was a known weak point: the shutdown handler had no timeout on the bisync call, and the DO destroy() SIGKILLed at 25s. A vault edit made in the last seconds before shutdown would be silently truncated if the bisync ran long, leaving R2 in a partial state. The next session loaded that partial state and looked stale, forcing a manual session delete.

Two paired fixes bundled with the vault PR:

- `shutdown_handler` in entrypoint.sh wraps the final `bisync_with_r2` call in a background subshell with a watchdog that hard-kills at 60s. Vault-monitor and SilverBullet supervisor PIDs are also terminated.
- `Container.destroy()` in `src/container/index.ts` uses `timeoutMs = 75_000` (60s for bisync + 15s buffer). `onStop()` logs `shutdownElapsedMs` so the budget can be tuned over time.

If the bisync exceeds 60s, the log records `TIMED OUT after 60s` -- a recognisable string for operators triaging stale-session reports.

## Preseed Integration (REQ-VAULT-007)

The vault plugin and supporting rule ship as preseed entries that land in every advanced-mode session at container boot:

- `preseed/agents/claude/plugins/codeflare-vault/` -- plugin descriptor, `vault-monitor-hook.sh` UserPromptSubmit hook, `vault-extract-prompt.md` for the spawned sonnet. Registered in `preseed/agents/claude/manifest.json`.
- `preseed/agents/claude/rules/vault.md` -- concept rule, advanced-mode only (see `ADVANCED_ONLY_CODEFLARE_RULES` in the ECC rules test).
- `preseed/silverbullet/` -- baseline `config.yaml`, optional `atlas.plug.js`, and the four preseeded plug files (`pdf`, `treeview`, `github`, `graph` -- see `preseed/silverbullet/plugs/MANIFEST.md`). The Dockerfile copies this directory to `/opt/silverbullet-preseed/`, then `init_user_vault()` materialises it on first boot.

`scripts/generate-agent-seed.mjs` reads the manifest and emits `src/lib/agent-seed.generated.ts`, the typed payload that the container fetches and writes during preseed. The vault plugin appears in default mode's manifest only as the rule's exclusion entry; runtime files are advanced-mode gated.

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

A brand-new session boots with an empty vault. The skeleton (subdirectories, README, empty `graph.json`, SilverBullet config) is created by `init_user_vault()` in entrypoint.sh on every boot, but the function is idempotent -- a returning session inherits the R2-restored content untouched.

`init_user_vault()` runs AFTER `establish_bisync_baseline()` so we never write an empty skeleton over restored data. If the baseline fails for any reason, the init function still runs (`(init_user_vault) || echo ...`) and a fresh skeleton is created locally; the next successful bisync will reconcile it.

## Image-pasting Cost Caveat

SilverBullet supports pasting images directly into notes (they land in `raw/pasted/`). The vault-extract sonnet processes them through graphify, which sees them as binary nodes and skips semantic extraction. Future agents that retrieve those nodes via `mcp__graphify__get_node` will see a path reference, not the image -- viewing the image still costs vision tokens. Be aware when pasting screenshots into notes you expect to query frequently.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Vault button missing from header | Not in terminal view, or no active session | Open a session terminal; the button renders only when both are true. |
| `curl http://127.0.0.1:3030/` returns nothing inside the container | SilverBullet supervisor not yet up | Wait 5s and retry; check `/tmp/silverbullet.log` for the restart-loop output. |
| `mcp__graphify__query_graph` returns no vault nodes | Global graph not built yet, or wrapper still pointing at per-repo graph | Check `~/.graphify/global-graph.json` exists; if it does, restart the MCP wrapper (it polls on a 2s loop). |
| Edits don't appear in graph queries within 60s | Vault-extract marker stale | Look at `~/.cache/codeflare-hooks/vault-extract.last` mtime; force a new tick by touching a file under `notes/`. |
| Stale session state on reopen after stop | Shutdown bisync was killed mid-write | Look for `TIMED OUT after 60s` in Durable Object logs (`wrangler tail <SCRIPT_NAME>`); raise the watchdog budget in `shutdown_handler` if frequent. |
| `/api/vault/:sid/` returns 503 | SilverBullet supervisor not ready | The `/api/vault/:sid/status` endpoint reports `vaultReady`; poll it and re-open when true. |
| Clicking "Quick Note" shows `You are not authenticated, going to reload...` alert, then reloads to a blank/white page | SilverBullet's client.js writes via PUT/DELETE/PATCH without `X-Requested-With`, which `authenticateRequest`'s CSRF guard required (fixed by the Origin-validated synthesis in `src/routes/vault.ts`) | Redeploy the container image to pick up the fix. As a temporary workaround, open the vault in a fresh browser tab (clears any stale ServiceWorker scope that may compound the loop). |
| SilverBullet opens with wrong index page or default editor mode | Existing vault round-tripped through R2 bisync before the idempotent config sync landed in `init_user_vault` | Redeploy. The boot-time `cmp`-gated sync propagates the preseed `config.yaml` on the next start. |
| `mcp__graphify__query_graph` returns no vault nodes even after several capture cycles | Older image: capture sonnet called `graphify extract --file` (requires an LLM provider key, codeflare ships none), so every run produced 0 nodes | Redeploy. After the fix, sonnets self-extract via their own conversation and emit chunk JSON that `graphify global add` ingests. |
| Browser console shows `Failed to register a ServiceWorker ... 401 ... fetching the script`; SilverBullet loads but appears unregistered as a PWA / offline mode never activates | Older image: SW registration GET at `/api/vault/<sid>/service_worker.js` ran the cookie-auth chain, but Chrome 76+ omits credentials on SW script fetches (no `Cookie` header sent), so auth returned 401 and registration failed permanently | Redeploy. The Worker now short-circuits SW registration via `VAULT_NOOP_SERVICE_WORKER_JS` (selector: `service-worker: script` header + no `Cookie`) and returns a static no-op SW the browser accepts. Distinct from the CSRF / Quick-Note row above; both can be present on a pre-fix image. |
| Editing a SilverBullet note shows `Could not save page, retrying again in 10 seconds` repeatedly; saves never succeed | Older image: PUT requests went through `maybeSynthesizeCsrfHeader` which clones the request to add `X-Requested-With`, consuming the original body; the proxy then forwarded the original (now disturbed) request to `container.fetch`, raising `TypeError: This ReadableStream is disturbed` and returning 500 | Redeploy. The proxy now forwards the auth-validated clone (which owns the body) instead of the original; pre-fix images log `Vault request error` with the disturbed-stream stack trace in Worker logs (`wrangler tail` or Cloudflare Observability). |

## Related Documentation

- [memory.md](./memory.md) -- The capture-hook plumbing that the vault reuses.
- [architecture.md](./architecture.md) -- Container layout, Worker proxy boundary.
- [deployment.md](./deployment.md) -- How Dockerfile + preseed land in a new session.
- [`sdd/vault.md`](../sdd/vault.md) -- Spec / acceptance criteria.
