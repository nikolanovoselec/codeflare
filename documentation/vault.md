# Vault

Persistent obsidian-style note vault, automatic conversation capture, unified graphify graph, and SilverBullet editor proxy. The vault is the agent's cross-session memory and the user's own note store, in the same directory.

**Audience:** Developers

---

## Contents

- [Overview](#overview-req-vault-001)
- [Directory Layout](#directory-layout)
- [Capture Path](#capture-path-req-vault-002)
- [User-edit Path](#user-edit-path-req-vault-003)
- [Unified Global Graph](#unified-global-graph-req-vault-004)
- [SilverBullet Editor](#silverbullet-editor-req-vault-005)
- [Shutdown Bisync Reliability](#shutdown-bisync-reliability-req-vault-006)
- [Preseed Integration](#preseed-integration-req-vault-007)
- [First-session Expectations](#first-session-expectations)
- [Image-pasting Cost Caveat](#image-pasting-cost-caveat)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

---

## Overview (REQ-VAULT-001)

The vault lives at `/home/user/.obsidian_vault/` inside every advanced-mode session container. It is rclone-bisynced to R2 alongside the rest of `/home/user/`, so anything written here is on the next session you start.

Two parties write to the vault:

- The **capture sonnet** appends a markdown file to `raw/sessions/` every 15 user prompts (replaces the old MCP-memory write path).
- **The user** edits notes via SilverBullet (or any other tool that touches files under `notes/` or `raw/pasted/`).

A single 60s daemon polls for user edits and signals a background sonnet to ingest them into the unified graphify graph. Future agents query that graph via `mcp__graphify__*` and see captures + user notes + every active repo's code, merged.

## Directory Layout

```
.obsidian_vault/
|-- raw/
|   |-- sessions/      <- AGENT-OWNED: one .md per 15-prompt capture
|   `-- pasted/        <- USER-OWNED: image/PDF drops from SilverBullet
|-- notes/             <- USER-OWNED: curated prose, concept notes
|-- graphify-out/      <- DERIVED: graphify extract output (do not edit)
`-- .silverbullet/     <- EDITOR CONFIG: SilverBullet's config + plug cache
```

The first three are where content lives. `graphify-out/` is rebuilt by the extraction sonnet on every change. `.silverbullet/` is owned by the editor.

## Capture Path (REQ-VAULT-002)

Same trigger as the pre-vault flow: the `memory-capture.sh` UserPromptSubmit hook fires every 15 user messages, writes a `.vars` marker, and emits `additionalContext` instructing the main agent to spawn a background sonnet.

Step 4 of `memory-agent-prompt.md` is the only thing that changed. The sonnet now:

1. Reads the new transcript range.
2. Identifies decisions, observations, references, and a short topic phrase.
3. Writes `/home/user/.obsidian_vault/raw/sessions/{ISO_TS}-{SID_SHORT}.md` using the YAML-frontmatter template (session id, captured-at, captured-from-range, then Context / Decisions / Observations / References sections).
4. Runs `flock /tmp/graphify-global.lock graphify extract --file <file>` then `flock /tmp/graphify-global.lock graphify global add ... --as vault`, so the capture lands in the unified global graph the same turn it is written.
5. Touches `{COUNTER_FILE}.compact` if `raw/sessions/` exceeds 200 files (signals the existing opus-compact path).

The dedup gate (delete the `.vars` file as the first step) is unchanged.

Linking convention enforced in the prompt: concepts go in `[[wikilinks]]` so graphify's external-label dedup unifies them across the vault and per-repo code graphs. File paths, code symbols, and PR references stay as prose -- they namespace per-project and would never auto-link meaningfully.

## User-edit Path (REQ-VAULT-003)

A second daemon, `start_vault_monitor_daemon` in entrypoint.sh, polls the vault every 60s. It uses a three-marker pattern to avoid the daemon-advances-mtime-before-extraction-reads-it race:

| Marker | Touched by | Used by |
|---|---|---|
| `vault-monitor.tick` | Daemon, every tick | Diagnostics (heartbeat) |
| `vault-extract.last` | Vault-extract sonnet, ONLY on success | Daemon's `find -newer` reference |
| `vault-extract.vars` | Daemon, when find returns non-empty | Trigger for `vault-monitor-hook.sh` |

If extraction fails mid-flight, `vault-extract.last` is NOT advanced, the next tick re-discovers the same files, and the system converges. Eventual consistency, no work lost.

The daemon excludes `raw/sessions/`, `graphify-out/`, and `.silverbullet/` from the find. Those are agent-owned, derived, or editor-config respectively.

`vault-monitor-hook.sh` is the UserPromptSubmit hook for the user-edit path. It exits 0 immediately when `vault-extract.vars` is absent (~99% of prompts), keeping token cost at zero on idle. When the marker is present it emits `additionalContext` pointing the main agent at `vault-extract-prompt.md`.

The vault-extract sonnet's contract:

1. Delete `vault-extract.vars` (dedup gate).
2. `find` files newer than `vault-extract.last`, excluding the agent-owned subtrees.
3. Run `flock /tmp/graphify-global.lock graphify extract --file ...` per file.
4. Run `flock /tmp/graphify-global.lock graphify global add ... --as vault`.
5. Touch `vault-extract.last` -- FINAL step only.

## Unified Global Graph (REQ-VAULT-004)

`~/.graphify/global-graph.json` is the hash-keyed merge of every per-source graph plus the vault's own graph. The graphify MCP wrapper prefers this graph when present, so `mcp__graphify__*` tool calls return a unified view across vault + active repos.

Write sites that touch the global graph:

- The capture sonnet, after writing a vault file (REQ-VAULT-002).
- The vault-extract sonnet, after user-edit extraction (REQ-VAULT-003).
- `graphify-active-repo.sh`, the first time a cloned repo with `graphify-out/` is seen.
- The `/graphify` skill, on commit, after building a repo's graph.

All four serialise via `flock /tmp/graphify-global.lock`. The locking is necessary because `graphify global add` rewrites the manifest + merged graph file in place.

## SilverBullet Editor (REQ-VAULT-005)

The Dockerfile installs the `silverbullet-server-linux-x86_64` binary at `/usr/local/bin/silverbullet`, pinned by version + SHA256. `start_silverbullet_supervisor` in entrypoint.sh runs the server on `127.0.0.1:3030` against the vault, supervised with a 5s restart loop so an editor crash never requires a container restart.

The editor is reached from the codeflare UI through the Worker proxy at `/api/vault/:sid/`. Auth, tier check, and rate-limiting are enforced at the Worker -- see [security.md](./security.md). The in-container HTTP server (`host/src/server.ts`) has a `/vault/*` HTTP branch and a WS upgrade passthrough that proxies to `127.0.0.1:3030`.

The Vault button in `Header.tsx` (`mdiChartGantt` icon, between Bookmarks and Storage) opens the editor in a new tab via `window.open`. It only renders when an active session exists and the layout passes `onVaultOpen` -- terminal view only.

### Per-session `<base href>` rewrite

SilverBullet 2.8.0 emits `<base href="/" />` in its index HTML, so under the `/api/vault/:sid/` subpath proxy every relative asset reference (e.g. `.client/client.js`) would otherwise resolve against the Worker root and 404 -- producing a white screen.

SilverBullet honours `SB_URL_PREFIX` to render the base tag with a prefix, but the prefix is per-session (the Worker knows `:sid`, the container does not), so baking it in at supervisor start is not viable. `handleVaultRequest` in `src/routes/vault.ts` is the per-session adapter: when the requested path is `/` or `/index.html` and the response Content-Type is `text/html`, it rewrites `<base href="/" />` to `<base href="/api/vault/<sid>/" />`. Non-HTML responses (JS bundles, PNG icons, manifest JSON) and HTML responses on non-shell paths pass through unchanged so the rewrite cost is bounded.

When the body is rewritten, both `Content-Length` (body length changed) and `Content-Encoding` (Workers `Response.text()` auto-decompresses gzip/br upstream, so the body is now plain text) are dropped from the response headers. A `vault base-href rewrite no-op` warning is logged when the rewrite runs but matches nothing, so a future SilverBullet template change (single-quoted href, added attribute, etc.) surfaces as a logged signal instead of a silent white-screen regression.

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
- `preseed/silverbullet/` -- baseline `config.yaml` (and optional `atlas.plug.js`) copied into `/opt/silverbullet-preseed/` by the Dockerfile, then materialised into `.obsidian_vault/.silverbullet/` by `init_obsidian_vault()` on first boot.

`scripts/generate-agent-seed.mjs` reads the manifest and emits `src/lib/agent-seed.generated.ts`, the typed payload that the container fetches and writes during preseed. The vault plugin appears in default mode's manifest only as the rule's exclusion entry; runtime files are advanced-mode gated.

## First-session Expectations

A brand-new session boots with an empty vault. The skeleton (subdirectories, README, empty `graph.json`, SilverBullet config) is created by `init_obsidian_vault()` in entrypoint.sh on every boot, but the function is idempotent -- a returning session inherits the R2-restored content untouched.

`init_obsidian_vault()` runs AFTER `establish_bisync_baseline()` so we never write an empty skeleton over restored data. If the baseline fails for any reason, the init function still runs (`(init_obsidian_vault) || echo ...`) and a fresh skeleton is created locally; the next successful bisync will reconcile it.

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

## Related Documentation

- [memory.md](./memory.md) -- The capture-hook plumbing that the vault reuses.
- [architecture.md](./architecture.md) -- Container layout, Worker proxy boundary.
- [deployment.md](./deployment.md) -- How Dockerfile + preseed land in a new session.
- [`sdd/vault.md`](../sdd/vault.md) -- Spec / acceptance criteria.
