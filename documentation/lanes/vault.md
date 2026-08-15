# Vault

Persistent user-note vault, automatic conversation capture, unified graphify graph, and SilverBullet editor proxy. The vault is the agent's cross-session memory and the user's own note store, in the same directory.

**Audience:** Developers

**Owns:** Vault path ownership, capture and user-edit extraction, cumulative graph publication, SilverBullet user/runtime behavior, and initialization tiers. **Does not own:** HTTP envelopes, authentication controls, bisync algorithms, or agent-manifest delivery.

---

## Contents

- [Data Model and Boundaries](#data-model-and-boundaries)
- [Capture and Edit Flows](#capture-and-edit-flows)
- [Graph Publication and Merge](#graph-publication-and-merge-req-vault-004)
- [Editor and Proxy Contract](#editor-and-proxy-contract-req-vault-005)
- [Encryption and IDB Lifecycle](#encryption-and-idb-lifecycle-req-vault-008-req-vault-024-req-vault-015-req-vault-021-req-vault-023)
- [Persistence and Finalization](#persistence-and-finalization-req-vault-006)
- [Bootstrap and Seed Integration](#bootstrap-and-seed-integration-req-vault-007)
- [Attachments and Ingestion](#attachments-and-ingestion)
- [Memory Capture System](#memory-capture-system)
- [Failure Diagnosis and Recovery](#failure-diagnosis-and-recovery)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

---

## Data Model and Boundaries

<a id="overview-req-vault-001"></a>
### Overview (REQ-VAULT-001)

The vault lives at `/home/user/Vault/` inside every advanced-mode session container. It is rclone-bisynced to R2 alongside the rest of `/home/user/`, so anything written here is available on the next session you start.

Two parties write to the vault:

- The **capture agent** (sonnet) appends a markdown file to `Raw/Sessions/` every 15 user prompts (replaces the old MCP-memory write path).
- **The user** edits notes via SilverBullet or any tool that writes under `Notes/`, `References/`, `Inbox/`, or `Journal/`. Attachments land next to the referencing note; `Raw/Pasted/` remains an optional hand-organised archive.

A single 60s daemon polls for user edits and signals a background sonnet agent to ingest them into the unified graphify graph. Future agents query that graph via `mcp__graphify__*` and see captures + user notes + every active repo's code, merged.

### Uploads and Temporary folders

Two persistent sibling directories are created alongside the vault on every boot by `init_user_vault()`:

- **`/home/user/Uploads/`** -- drop zone for files that need to survive session restart and be visible from every device.
- **`/home/user/Temporary/`** -- persistent scratch space with the same bisync and panel treatment.

Files placed in Uploads are included in `RCLONE_FILTERS_COMMON` (`+ Uploads/**`, ordered before the global `graphify-out` exclude) and appear in the R2 storage panel.

### Storage panel special folders (REQ-VAULT-001)

The R2 storage browser surfaces four directories as "special folders" at the bucket root. Vault, Uploads, and Temporary appear unconditionally; Workspace appears only when the workspace-sync preference is enabled. Each entry shows an info icon that reveals a tooltip:

| Folder | Container path | Gated? |
|---|---|---|
| Workspace | `/home/user/Workspace` | Only when workspace-sync preference is enabled |
| Vault | `/home/user/Vault` | Always shown |
| Uploads | `/home/user/Uploads` | Always shown |
| Temporary | `/home/user/Temporary` | Always shown |

The tooltip shows the folder's purpose and its in-container path so users know where to look inside a session.

### Directory Layout

Inside the container, three sibling directories live under `/home/user/` alongside the workspace:

<!-- doc-allow-element: AD54 vault tree needs the full directory map -->
```
/home/user/
|-- Workspace/         <- active project (workspace-sync gated)
|-- Vault/             <- vault (always bisynced in advanced mode)
|   |-- Index.md           <- SEED-IF-MISSING: Codeflare dashboard (seeded once; editor normalizes + owns it)
|   |-- README.md          <- PRESEED-MANAGED: vault user guide (overwritten each boot)
|   |-- CONFIG.md          <- PRESEED-MANAGED: SilverBullet #meta config page (overwritten each boot)
|   |-- STYLES.md          <- PRESEED-MANAGED: Codeflare editor theme (overwritten each boot)
|   |-- Raw/
|   |   |-- Sessions/      <- AGENT-OWNED: one .md per 15-prompt capture
|   |   |-- Pasted/        <- USER-OWNED: image/PDF drops from SilverBullet
|   |   `-- Graphs/        <- USER-EDITABLE: Vault Graph.md (seeded once, never overwritten); links to vault-graph.html (bounded best-effort render)
|   |-- Notes/             <- USER-OWNED: durable notes saved by note-capture flows
|   |-- References/        <- USER-OWNED: reference material and source notes
|   |-- Inbox/             <- USER-OWNED: SB "Quick Note" target
|   |-- Journal/           <- USER-OWNED: SB "Journal: Today" target
|   |-- graphify-out/      <- DERIVED: graphify extract output (do not edit)
|   |-- Library/
|   |   `-- Codeflare/     <- CODEFLARE-MANAGED: preseeded SilverBullet plugs
|   `-- .silverbullet/     <- EDITOR CONFIG: SilverBullet config + plug cache
|-- Uploads/           <- persistent drop zone for files (always bisynced)
`-- Temporary/         <- persistent scratch space (always bisynced)
```

`Raw/`, `Notes/`, `References/`, and `graphify-out/` are where content lives. `Notes/` and `References/` are the user-facing priority areas promoted on the SilverBullet dashboard; `graphify-out/` is updated by the vault-extract agent via a chunk-JSON merge on every user-edit tick (not a full re-extract). `.silverbullet/` is owned by the editor. `Library/Codeflare/` holds the plug files managed by Codeflare (pdf, treeview, github, graph) -- see [Preseed Integration](#preseed-integration-req-vault-007).

Two classes of path are hidden from the SilverBullet client listing/sync ([REQ-VAULT-015](../../sdd/spec/vault.md#req-vault-015-vault-idb-lifecycle-and-listing-filters) AC1). Generated `Raw/Graphs/*.html` visualisations stay fetchable by direct link but are removed from the listing so the object index does not try to treat multi-MB HTML graph artifacts as documents. Machine-owned session-capture memory under `Raw/Sessions/` (rewritten by the capture pipeline every ~15 prompts) is likewise hidden so IndexedDB does not churn on logs the user never opens, and client mutations to those hidden paths are rejected so a transitioning client cannot delete the on-disk memory.

**Codeflare-authoritative vs user-editable.** Three root pages (`README.md`, `CONFIG.md`, `STYLES.md`) are codeflare-authoritative: `init_user_vault()` overwrites them on every boot from `/opt/silverbullet-preseed/`, gated so identical files are not rewritten. Hand-editing them inside SilverBullet is futile - changes are silently reverted on the next session start.

`Index.md` also ships from preseed but is seeded create-if-missing, not force-overwritten: the SilverBullet editor normalizes and autosaves the dashboard on open, so a boot-time revert fought the client save into a perpetual `Index.conflicted:*.md` sync conflict (see [Vault initialization tiers](#vault-initialization-tiers-req-vault-001-ac3--req-vault-010-ac1ac4ac5)); once seeded it is editor-owned. User content lives in `Notes/`, `References/`, `Inbox/`, `Journal/`, `Raw/Pasted/`, and `Raw/Sessions/`, which the boot-time sync never touches.

**Hidden-root constraint (see [AD54](../decisions/README.md#ad54-vault-directory-must-use-a-non-hidden-basename)):** The vault directory must use a non-hidden basename. SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the directory walk when the root basename begins with `.`, returning an empty file listing even when notes are present on disk. This is why the path is `/home/user/Vault/`, not `/home/user/.user_vault/`.

## Capture and Edit Flows

<a id="capture-path-req-vault-002"></a>
### Capture Path (REQ-VAULT-002)

On Claude, the `memory-capture.sh` UserPromptSubmit hook fires every 15 user messages, writes a `.vars` carrier naming the window and the capture file, and launches `run-memory-capture.sh` detached. The main session spends nothing: it does not dispatch a subagent, wait, or read the result. The runner prefilters the transcript slice, builds one self-contained request, and runs the capture as a headless `claude -p` bounded to six turns, with fidelity selected by `CODEFLARE_MEMORY_MODEL` (default `sonnet`) per [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) and [AD124](../decisions/README.md#ad124-bounded-re-delivery-replaces-the-memory-capture-hard-block). That capture runs `memory-agent-prompt.md` end to end:

1. Receives the transcript inline in its prompt (`CAPTURE_REQUEST`), framed by a per-run marker; there is no carrier, transcript path, or chunk directory for it to open. Handing it a path instead put an 83KB retrieval on the tool-result channel, which truncates and persists, and the capture spent its whole budget paging its own input back in.
2. Processes that inline transcript once.
3. Identifies decisions, observations, references, and a short topic phrase.
4. Writes `/home/user/Vault/Raw/Sessions/{ISO_TS}-{SID_SHORT}.md` using the YAML-frontmatter template (session id, captured-at, captured-from-range, then Context / Decisions / Observations / References sections).
5. Acts as the LLM extractor for the captured file, then invokes one locked helper that merges the cumulative graph, publishes `user_vault`, and removes `.vars` only after both succeed.

The extraction emits chunk JSON matching graphify's schema: nodes, edges, hyperedges, and `[[wikilinks]]` as `file_type:concept` nodes with `source_file: null`. Graphify's `external_labels` dedup in `global_add` then unifies those concepts across vault and per-repo graphs by label. `publish-memory-capture.sh` runs the canonical cumulative merge and `graphify global add ... --as user_vault` under one lock; merge or publication failure exits before carrier removal. No LLM provider key is needed; codeflare ships none, and the agent itself is the extractor, matching the `/graphify` skill's parallel-subagent pattern.

On Pi, the worker writes the session note and the deterministic graph builder derives its graph identity afterward. The document label comes from the note H1, its ID comes from the Vault-relative path, repeated concept labels share one canonical ID, and exact duplicate evidence edges collapse before cumulative merge ([REQ-MEM-017](../../sdd/spec/memory.md#req-mem-017-session-memory-graph-identity-is-deterministic)). <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph -->

Compaction is manual: the vault grows append-only and no automated compactor ships. When `Raw/Sessions/` becomes unwieldy, prune or summarise files directly via SilverBullet.

Linking convention enforced in the prompt: concepts go in `[[wikilinks]]` so graphify's external-label dedup unifies them across the vault and per-repo code graphs. File paths, code symbols, and PR references stay as prose -- they namespace per-project and would never auto-link meaningfully.

### User-edit Path (REQ-VAULT-003)

Implements [REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) (monotonic vault graph accumulation across extractions).

A second daemon, `start_vault_monitor_daemon` in entrypoint.sh, polls the vault every 60s. Change detection is a **content-hash manifest**, not a file mtime ([AD94](../decisions/README.md#ad94-content-hash-manifest-for-vault-extract-change-detection-mtime-is-reset-by-the-r2-restore)): the boot R2 restore rewrites every vault file's mtime to download-time, so the old `find -newer` marker matched the whole vault and re-extracted it (~200k tokens) every session. The state:

| File | Written by | Used by |
|---|---|---|
| `graphify-out/vault-extract-manifest.json` | Claude vault-extract agent or Pi root finalizer, ONLY on exact success | Durable `{path→sha256}` high-water mark (R2-synced, survives restart) |
| `vault-monitor.tick` | Daemon, every tick | Diagnostics (heartbeat) |
| `vault-extract.last` | Claude agent or Pi root finalizer, ONLY on success | Ephemeral dedup timestamp (NOT detection) |
| `vault-extract.vars` | Daemon, when a change is detected | Trigger for `vault-monitor-hook.sh` |

If extraction fails mid-flight on the Claude path, the manifest is not committed, the next tick re-discovers the same files, and the system converges. Pi now preserves the same success-only high-water invariant through staged root-owned promotion (see Pi transactional delivery below).

A complementary guard in `vault-monitor-hook.sh` covers the daemon-vs-extract overlap case. The daemon ticks every 60s and an extraction run typically takes ~90s on sonnet (was 30-60s on haiku before [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)), so the daemon may re-write `vault-extract.vars` after the agent's step-1 delete.

When the agent finishes and advances `vault-extract.last`, that re-written `.vars` is left behind, older than `.last`. The hook detects this on the next prompt (`! "$VARS_FILE" -nt "$LAST_MARKER"`), silently deletes the stale marker, and exits 0 instead of triggering a redundant agent spawn.

The in-flight sentinel's TTL is 30 minutes. It was raised from 5 minutes in 2026-07 because real extraction runs on large change sets measured ~18 min, and the old TTL treated a still-running extraction as crashed and dispatched a second concurrent agent that raced the first on the shared chunk file. A genuinely crashed run now delays re-extraction by up to 30 min, which the daemon's high-water-mark re-detection makes eventual, never lost.

The exclusion set — `Raw/Sessions/`, `Raw/Graphs/`, `graphify-out/`, `Library/Codeflare/`, `.silverbullet/` (agent-owned; the served graph-viz copy the extractor's own final step re-renders; derived; vendored SilverBullet plug bundles; editor-config) — lives in `vault-manifest.py` (a parallel Python copy of `VAULT_GENERATED_PREFIXES` + `VAULT_PRESEED_ROOT_FILES`, code-commented "MUST stay identical to memory-vault-helpers.ts") and Pi's `vault-manifest-fs.ts` (which imports the predicate from `memory-vault-helpers.ts` directly) — kept in parity by convention on the Python side, by direct import on the TypeScript side.

A mismatch re-triggers a spurious extraction cycle on the extractor's own output (observed live 2026-07-02 for `Raw/Graphs/vault-graph.html`). It also excludes the three always-managed root pages (`CONFIG.md`, `README.md`, `STYLES.md`) and the create-if-missing dashboard `Index.md`. `init_user_vault()` overwrites only the managed three; `Index.md` becomes editor-owned after first seed. The by-name exclusion keeps these product-supplied roots from counting as user-edit extraction input ([REQ-VAULT-010](../../sdd/spec/vault.md#req-vault-010-codeflare-authoritative-files-preseeded-into-the-vault-on-every-boot) AC1).

On the first durable initialization of a newly created vault, `init_user_vault()` baselines the manifest from current content before the daemon starts, then writes `graphify-out/vault-extract-initialized`; the first tick therefore finds nothing. An existing or restored vault without that marker is a migration, not a first initialization: init writes the marker but never baselines current content. If its manifest is absent, or later goes missing after initialization, all eligible files remain full-delta candidates. On ordinary later boots the manifest is restored from R2 and never re-baselined, so prior-session unextracted edits are still detected.

`vault-monitor-hook.sh` is the UserPromptSubmit hook for the user-edit path. It exits 0 immediately when `vault-extract.vars` is absent (~99% of prompts), keeping token cost at zero on idle. When the marker is present it emits `additionalContext` instructing the main agent to dispatch the **vault-extract** named subagent (Task tool with `subagent_type="vault-extract"`). The subagent's frontmatter (`preseed/agents/claude/agents/vault-extract.md`) pins `model: sonnet` per [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad); the hook directive instructs the main agent not to pass a model override.

The vault-extract agent's contract ([REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions)):

1. Delete `vault-extract.vars` (dedup gate).
2. Run `vault-manifest.py changed` — files whose sha256 differs from the manifest, excluding the agent-owned subtrees.
3. Acts as the LLM extractor for each changed file: reads the file, produces a chunk JSON (nodes / edges / hyperedges matching graphify's schema; `[[wikilinks]]` become concept nodes with `source_file: null` for cross-repo dedup).
4. Loads the persistent vault graph at `/home/user/Vault/graphify-out/vault-graph.json` and writes the updated cumulative graph back to `vault-graph.json`.
5. Run `flock -w 5 /tmp/graphify-global.lock graphify global add ... --as user_vault`.
6. Re-render the vault viz HTML into `Raw/Graphs/vault-graph.html` so the `Vault Graph.md` index page link resolves.

Step 4 starts from empty evidence when `vault-graph.json` is absent or unreadable. Malformed edge entries are ignored; valid edges are deduplicated by semantic evidence tuple before the cumulative graph is published. The global graph's `user_vault` tag therefore reflects cumulative vault content, not only the most recent extraction. <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::main --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::node_link_edges --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::dedupe_node_link_edges --> Prior to [REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions), each pass replaced the entire `user_vault` entry with the chunk graph, causing vault knowledge to shrink on every extraction (observed: 17 nodes -> 2 nodes after two stub files were extracted).

Step 6 runs `graphify cluster-only .` with cwd `/home/user/Vault` against the per-run `graph.json`, then copies `graph.html` to `Raw/Graphs/vault-graph.html`. Failure here does not set `EXTRACT_FAILED` because graph data is already persisted by steps 4-5. The only loss is a stale viz HTML, and the next successful extraction re-renders it.
7. Commit the content-hash manifest (advance the high-water mark) and refresh `vault-extract.last` -- FINAL step only.

**Pi transactional delivery ([REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)).** Pi implements change detection in `memory-vault.ts`, but it no longer privately spawns an agent or advances the manifest before extraction. The root writes the complete staged manifest and request-specific execution snapshot before atomically publishing a tiny active request-ID pointer. It emits one visible public background request with medium reasoning and four turns; the same bounded request items appear in model-facing content and durable details metadata. It reconstructs attempts/results from root-session JSONL, sends the initial directive plus at most five reminders, and then latches GIVEUP ([AD103](../decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs)). <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::stageVaultRequest --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages -->

Before the first exact public tool call, later edits coalesce under the same request ID. After launch, the execution snapshot and staged bytes remain frozen; edits made during extraction become one follow-up request after success ([REQ-VAULT-028](../../sdd/spec/vault.md#req-vault-028-vault-edits-remain-isolated-after-extraction-starts)). <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::refreshPendingVaultRequest -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess -->

A task does not qualify as exact success until its canonical request chunk exists after locked cumulative merge and global publication. Failed, timed-out, or incomplete work leaves the committed manifest byte-identical; successful promotion also requires the staged SHA to match. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess -->

A crash after rename but before cleanup is accepted idempotently from matching committed bytes. Missing or corrupt staged data creates a full-delta follow-up, while an older task result cannot promote or clear replacement work. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess --> <!-- @impl: preseed/agents/pi/extensions/vault-manifest-fs.ts::promoteVaultManifest -->

The Pi subagent authors a request-specific canonical chunk, then holds one 300-second flock across `merge-vault-graph.py` and cumulative `graphify global add`. Required failure propagates to native task status; only visualization remains best effort. The root owns the execution snapshot, active pointer, committed/staged manifests, and marker throughout.

**PDFs are the exception:** the Pi Read tool cannot render PDF pages as images, so a PDF on the Pi path yields only a bare document node. The heading/title/entity extraction the Claude runtime performs (see [Attachment Cost Caveat](#attachment-cost-caveat-req-vault-011-ac1)) is Claude-only, and scanned/image-only PDFs are inherently out of reach on Pi. For markdown and plain-text files (`.md`/`.txt`/`.json`/`.yaml`/`.yml`), the text/structural output matches the Claude path. The canonical-schema and viz-publish contract these steps satisfy is [REQ-VAULT-016](../../sdd/spec/vault.md#req-vault-016-vault-graph-extraction-emits-the-canonical-shared-schema).

<a id="unified-global-graph-req-vault-004"></a>
## Graph Publication and Merge (REQ-VAULT-004)

`~/.graphify/global-graph.json` is the hash-keyed merge of every per-source graph plus the vault's own graph. The graphify MCP wrapper prefers this graph when present, so `mcp__graphify__*` tool calls return a unified view across vault + active repos.

Write sites that touch the global graph:

- `init_user_vault()` at boot, republishing the vault under `user_vault` from the cumulative `graphify-out/vault-graph.json`, never the derived `graph.json` beside it ([REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) AC5).
- The capture agent, after writing a vault file ([REQ-VAULT-002](../../sdd/spec/vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown)).
- The vault-extract agent, after user-edit extraction ([REQ-VAULT-003](../../sdd/spec/vault.md#req-vault-003-user-curated-edits-are-detected-and-ingested-within-60s)).
- `graphify-active-repo.sh` (Claude) and `codeflare-pi.ts::reconcileGlobalGraph` (Pi), whenever reconciliation finds the manifest's repo entries out of step with the active checkout (single-active-repo invariant; see below).
- The `/graphify` skill, on commit, after building a repo's graph.

A first boot has no cumulative graph yet, because no capture has run, so the boot step publishes nothing and reports no failure ([REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) AC6).

All five serialize on `/tmp/graphify-global.lock`. Claude, boot init, and active-repo maintenance retain the short five-second lock bound. Each Pi extraction uses one required 300-second critical section spanning both cumulative merge and global publication, then exposes its post-commit request chunk; a timeout or missing chunk leaves root-owned high-water state unchanged. <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence --> Pi visualization is separately capped at 15 seconds. <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::at most 15 seconds -->

### Single-active-repo invariant

`graphify-active-repo.sh` enforces a single-active-repo invariant for the per-repo side of the global graph: the manifest holds the vault entry plus the active checkout's entry when that checkout has a graph, and nothing else. Two sentinels back it. `~/.cache/codeflare-hooks/graphify-active-cwd` holds the active repo path, and its first line is a contract the MCP wrapper reads. `~/.cache/codeflare-hooks/graphify-active-state` holds a tab-separated `<branch>\t<graph|nograph>` snapshot of what the checkout looked like at the last reconciliation.

1. **Repo resolution ([REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC3)**: walk up from the candidate directory to the nearest checkout, identified by `.git` as a directory or as the file a worktree uses. Nothing else counts as a repo root.
2. **Vault skip ([REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC3)**: when the walk-up resolves to `$HOME/Vault`, the hook exits 0 without writing either sentinel or invoking graphify.
3. **Fast-path skip ([REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC4)**: when the repo path, the branch, the graph's presence, and the graph's mtime all match what the sentinels recorded, the hook returns immediately.
4. **Reconcile ([REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation) AC1/AC5)**: read the manifest's repo tags, remove every one that is neither `user_vault` nor the active checkout's tag, and add the active checkout's graph when its recorded `source_hash` differs or the tag is new.
5. **Sentinel advance ([REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation) AC1)**: both sentinels are rewritten and the path sentinel `touch`-bumped only after the whole reconciliation succeeded, so a failure leaves the prior state in place and the next tool call retries.

Step 4's removals and addition run inside one `flock -w 5 /tmp/graphify-global.lock` critical section, so a lock timeout or either graphify failure aborts the whole step. The fast path avoids spawning the graphify CLI, including hundreds of MB of Python imports, on every Bash/Edit/Write/ctx_execute tool call. Branch and graph presence sit in the comparison because mtime cannot see either: a checkout does not touch `graphify-out/`, and a deleted graph moves its mtime backwards to zero, which reads as "not rebuilt" and would leave a dead tag published indefinitely. This behavior implements [REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation).

In a worktree the branch is read through the `gitdir:` pointer in `.git`, since HEAD does not live under the checkout ([REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC7).

The removal set is enumerated from the manifest rather than derived from the previous sentinel value. That is what lets the hook collect entries no transition diff can name: a tag a crashed run left behind, or a phantom tag minted back when a bare `graphify-out/` directory still resolved as a repo root. Drift self-heals on the next tool call. `user_vault` is excluded by name, since the vault is registered exclusively by entrypoint init and by the capture and extract pipelines, never as a repo.

The vault skip canonicalizes `$HOME` via `cd && pwd` to match `REPO` resolution and also matches basename `Vault`, guarding against symlink paths into the vault from outside `$HOME` and against a `git init` inside the vault.

Same-basename repo transitions issue no removal, because the active tag is excluded from the removal set and the add replaces the existing entry via graphify's `source_hash` dedup. The add pre-check truncates `sha256sum` to graphify's 16-hex format and skips publication only when the manifest records both that hash and a `source_path` equal to this checkout's graph.

The path half is load-bearing rather than belt-and-braces: tags are keyed by directory basename, so two checkouts sharing a basename can hold byte-identical graphs (a freshly scaffolded `graph.json` is the common case), and a hash-only skip would leave the tag resolving to the checkout the user just left. A recorded hash that is not 16 lowercase hex characters refuses the optimisation instead of silently degrading to "always skip".

Pi holds the same invariant through `codeflare-pi.ts::reconcileGlobalGraph`, called on `session_start` and after every repository transition. `planGlobalGraphReconcile` reads the same manifest and computes the same removal set, every tag but `user_vault` and the active checkout's, plus the add when that checkout has a graph; both run inside one `flock -w 5 /tmp/graphify-global.lock` invocation so a concurrent writer never sees a partial reconciliation ([REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation) AC6). It applies the hook's dedup on the same terms, matching the recorded hash and the recorded `source_path` before skipping, so an unchanged graph costs no `global add` while another checkout's identically-hashed graph still forces one.

Pi has no fast-path comparison and does not need one: it reconciles on session start and transitions rather than on every tool call, and reading a manifest is not what the fast path exists to avoid. It also has no sentinel to withhold on failure, so a genuine failure notifies at session start instead of leaving a retry marker. A missing CLI is not a failure: that is the supported disabled-plugin configuration, and it stays silent.

The two binaries report their absence differently, because `flock` is the process Pi spawns while `graphify` runs inside the locked script. An absent `flock` therefore arrives as `ENOENT`, an absent `graphify` as the script's own exit 127, and Pi tolerates both while still surfacing every other non-zero exit.

Branch granularity is intentionally not represented in the manifest -- a repo's tag is its directory basename. A branch switch triggers reconciliation, not a rebuild: the hook re-evaluates which tags belong in the global graph, so a branch where the graph is absent stops publishing, but the graph's contents are refreshed only when the user rebuilds (`graphify update` or `/graphify`). Until that rebuild runs, the global graph still shows the prior branch's nodes under the same tag, an acceptable staleness window since auto-rebuild on every checkout would be too expensive.

<a id="silverbullet-editor-req-vault-005"></a>
## Editor and Proxy Contract (REQ-VAULT-005)

The Dockerfile installs the `silverbullet-server-linux-x86_64` binary at `/usr/local/bin/silverbullet`, pinned by version + SHA256. `start_silverbullet_supervisor` in entrypoint.sh runs the server on `127.0.0.1:3030` against the vault, supervised with a 5s restart loop so an editor crash never requires a container restart.

The editor is reached from the codeflare UI through the Worker proxy. The SilverBullet app is served under a **bucket-stable URL** `/api/vault/<token>/`, where `<token>` is a deterministic, opaque 32-hex SHA-256 of the user's R2 bucket name (no session id, no PII). The session-keyed path `/api/vault/<sid>/` is an entry only: it sets the HttpOnly `cf_vault_sid` cookie so the Worker resolves the session on bucket-stable requests, then 302-redirects to the token URL.

Because the served `location.href` is identical across sessions, the SilverBullet IndexedDB stores (`sb_data_*` for the index, `sb_files_*` for the SW sync store) and the service-worker scope are bucket-scoped and persist across sessions. A returning user opens against the same IndexedDB and does not re-index from scratch ([REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)). Auth, tier check, and rate-limiting are enforced at the Worker -- see [security.md](./security.md). The in-container HTTP server (`host/src/server.ts`) has a `/vault/*` HTTP branch and a WS upgrade passthrough that proxies to `127.0.0.1:3030`.

The Vault button in `Header.tsx` (`VaultButton`, left of the Storage button) opens the editor in a new tab via `window.open`. It only renders when an active session exists **and the session mode is `advanced`**. Default-mode sessions never see the button ([REQ-VAULT-012](../../sdd/spec/vault.md#req-vault-012-vault-button-render-and-dashboard-landing) AC1, CF-060/CF-075).

Readiness has two layers. First, `Layout.tsx` calls `probeVaultReady()`, which issues `GET /api/vault/:sid/status`; the Worker runs the SilverBullet-reachability check server-side and returns `{ vaultReady: true }` only when SB is actually serving — the same ground-truth signal the old `HEAD /api/vault/:sid/` proxy probe carried, but without the 502/timeout-abort console noise it produced during warm-up. The per-session server latch flips on the first ready response, retrying every 5s until success and then steady-probing every 60s ([REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC1-AC2). That tests the real vault path and catches SB-crashed scenarios a startup-stage flag would miss.

Second, on the user's FIRST click of the server-ready ('available') control, `startVaultPrewarm()` mounts a hidden same-origin iframe at `/api/vault/:sid/.codeflare-bootstrap?codeflarePrewarm=1&prewarmId=...`. Prewarm is on demand — codeflare never mounts it automatically, because that left the user staring at an empty editor for up to two minutes with a manual reload to recover. The bootstrap hop registers/configures the native service worker, explicitly asks the browser to update that registration, and preserves the prewarm query through the redirect.

`injectVaultPrewarmFocusGuard()` runs before SilverBullet app scripts in that hidden prewarm document. With a valid prewarm token it no-ops script focus/select/window-focus calls and blurs any focus target, while the generic shell stays normal when opened without prewarm parameters. The parent iframe is also inert and reclaims focus to the previously focused terminal/input whenever the iframe holds parent focus.

The reclaim is driven by `focusout`, the guaranteed signal, plus a lifetime poll; the window-`blur` listener remains as a secondary catch. That split is necessary because a focus move into a same-origin child iframe fires no `focusin` on any outer element, and window `blur` varies by browser/platform. All reclaim paths, including listeners, the poll, and one-shot timers, are cancelled in teardown cleanup, so reclaiming stops the moment prewarm finishes or errors.

Removing the prewarm iframe orphans the top-level document: `document.hasFocus()` goes false and keyboard input dies until a reload, even when the terminal textarea is still active and no focus moved into the iframe. No click recovers it because xterm preventDefaults its mousedown. The orphan is caused by removal itself, so it cannot be prevented, only repaired. After `iframe.remove()`, prewarm re-asserts `window.focus()` and re-focuses the live terminal target, else `.xterm-helper-textarea`, retried across a few frames and gated on the window actually lacking focus so a still-focused terminal is never disturbed.

The on-demand prewarm therefore does not steal focus while the user types or has the mobile keyboard open; it is not paused on focus. `injectVaultPrewarmBridge()` marks the runtime as headless without using SilverBullet's upstream `?headless` URL flag because that flag disables service worker registration. The bridge is injected into the generic shell because the service worker may serve the precached shell instead of a fresh Worker response.

The button remains guarded until a same-origin/current-attempt bridge ready signal also proves current-device local readiness: recorded `sb_data_*`, recorded `sb_files_*`, and the active worker at the recorded current scope. The bridge holds this proof across `requiredReadyStreak` (2) consecutive polls before it arms the control, and a single not-ready poll resets the streak. That prevents either an orphaned worker or a momentary index-queue-empty mid-sync from arming the control prematurely ([REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC6, [REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC4).

Timeout/error states stay guarded and retry in the background; the button stays visible and click/tap feedback explains that this browser is preparing or retrying the Vault cache. A valid reload-skip proof arms the control directly; the green click opens without re-verification ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC1/AC2). Missing or superseded scope proof stays available until the user starts the normal on-demand prepare. On the cold path, the arming poll has already verified the prewarm proof and key before the control went green, so that click opens synchronously.

On a successful full prewarm the bridge's complete ready proof (runtime ready + space sync + object index complete + `/.fs/` file listing) records a persistent per-browser marker, `vault-session-<sid>-prewarmed`, in `localStorage`. On a later page load, where the in-memory prewarm status has reset, `Layout.tsx` skips re-mounting the bootstrap iframe and marks the control armed (green) directly with no click.

That reload-skip happens only when the marker is present and live local readiness still holds. `checkVaultLocalReadiness` verifies recorded `sb_data_*`/`sb_files_*` plus an active service worker, not evicted, with the liveness probe bounded by a short timeout. If the probe does not settle, or the marker is absent, the control stays 'available' for an on-demand click and is never auto-mounted.

This stops a reload of an already-initialized device from re-running service-worker registration, space sync, and indexing, and from contending with the terminal for keyboard focus during that re-init. An interrupted first-init (stores + SW present but no recorded full proof) deliberately stays 'available' until the user clicks, rather than opening onto an unbuilt index. The marker shares the `vault-session-*` cache namespace, so `sweepOrphanVaultCaches`/`cleanupSessionVaultCache` preserve it for an active session and remove it on session delete/orphan (see Cache cleanup below). ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC2)

The button surfaces this on-demand flow as a breathing affordance (`VaultButton.tsx`, the same breathing the "Return to Dashboard" icon uses). Server-ready is `available`: clickable, no breathing. The first click breathes the codeflare accent and auto-surfaces a focus-loss warning tooltip while indexing runs (`preparing`). When indexing completes, the icon breathes green and auto-surfaces a "ready" tooltip that hides after 5s, and the second click opens the vault instantly (`armed`).

Once the vault is ready (`pw === 'ready'` in `Layout.tsx`'s `vaultButtonStatus`) the button is green and stays green for the rest of the session. A warm session therefore shows green immediately and opens on a single click, identical on mobile, tablet, and desktop because green carries no reload-dependent settle state ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC5). A reload of an already-warm device shows `armed` immediately (one click to open). Known residual: the readiness marker is keyed by the precache-frozen session id, so a NEW session on a warm device needs one on-demand click before it greens (see [troubleshooting](troubleshooting.md#vault-button-re-indexes-on-every-click-after-the-first-then-returns-gr)).

The "ready" tooltip auto-shows only on the genuine `preparing` -> `armed` transition, tracked via `prevStatus` in `VaultButton.tsx`. It never fires on a fresh already-armed mount, warm reload, or return from the vault tab, so it no longer re-pops on every mobile standalone-PWA reload.

The open itself (`openVaultTab`) targets the bootstrap-hop `/api/vault/<sid>/.codeflare-bootstrap`, never the bare shell. The hop posts the AES key to the service worker and waits for SW activation before redirecting to the editor, so the first open never races the worker's single-shot `__cfRecover` into SilverBullet's top-level `/.auth` navigation (the old "first open shows /.auth 'Authentication not enabled'; close-and-reopen works" symptom). After the open click, `openVaultTab` clears the per-session open-intent so the control falls back to that same steady green 'ready' state, still clickable to reopen, rather than any transient armed-intent. `prefers-reduced-motion` keeps the state colours without the breathing animation ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC3).

On the real top-level open, never the headless prewarm iframe, `rewriteVaultHtmlResponse` injects a one-time controlled reload (`injectVaultControlledReload` wrapping the exported `installVaultControlledReload`) only when the request carries no prewarm id. A present valid prewarm ID positively identifies the hidden preparation path and remains inert; absence identifies the real top-level open. When an already-warmed vault is opened before its vault-scoped service worker controls the page (`navigator.serviceWorker.controller` null on first paint), SilverBullet would otherwise boot without the SW-backed local space and render an empty/partial editor until a manual reload (the old "reload one or two times to see your files").

The safety net reloads the page exactly once, gated by a `sessionStorage` one-shot (`cf-vault-sw-controlled-reload`) so it can never loop. It is inert in the prewarm iframe, on a genuine first boot with no vault SW yet, for a non-vault service-worker scope, and without service-worker support. It clears the one-shot once the worker already controls the page so a later in-tab navigation can self-heal again ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC4).

Codeflare also calls `navigator.storage.persisted()` / `persist()` / `estimate()` before prewarm as a best-effort mobile-hardening step. This reduces eviction risk on browsers that grant persistent storage, but it is not part of readiness and denial is not fatal. If a mobile browser clears origin storage under pressure, the next click-time local-readiness recheck detects the missing IndexedDB evidence and prepares the current browser cache again.

The landing page on every Vault button click is `Index.md` (the Codeflare dashboard), set by exporting `SB_INDEX_PAGE=Index` in the supervisor before launching the binary ([REQ-VAULT-012](../../sdd/spec/vault.md#req-vault-012-vault-button-render-and-dashboard-landing) AC3). The SilverBullet Go server hardcodes the default to lowercase `"index"` (`server/cmd/server.go` in SilverBullet's source) and ignores any `indexPage` key in `.silverbullet/config.yaml` -- the env var is the only override. The dashboard leads with `Notes/` and `References/` because those are the durable user-curated areas used by note-capture and reference workflows; broader recent-content widgets remain below. The README is one click away via a link at the top of the dashboard.

### Per-session `<base href>` rewrite (REQ-VAULT-013 AC1)

SilverBullet 2.x emits `<base href="/" />` in its index HTML, so under the `/api/vault/<token>/` subpath proxy every relative asset reference (e.g. `.client/client.js`) would otherwise resolve against the Worker root and 404 -- producing a white screen.

`handleVaultRequest` in `src/routes/vault/index.ts` is the proxy adapter. On every response with Content-Type `text/html`, it rewrites `<base href="/" />` to `<base href="/api/vault/<token>/" />`, where `<token>` is the bucket-stable token for this user. The token is identical on every request for a given user, which keeps the SilverBullet IndexedDB names and service-worker scope stable across sessions ([REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)).

The injected boot recorder/prewarm bridge are keyed separately by the real session id, passed to `rewriteVaultHtmlResponse` as `bootSessionId`, so their `vault-session-<sid>-*` localStorage markers match what the dashboard reads. The path is not gated because SilverBullet 2.x serves its SPA shell as a catch-all on every non-API URL. A `location.reload()` from a deep page (`/Notes/Today`) lands on that same path and the shell HTML returned there must also be rewritten.

Without the rewrite, every relative fetch from `client.js` resolves to the Worker root, the tab goes blank, and any in-flight PUT to `.fs/<page>.md` misses the `/api/vault/<token>` prefix entirely, silently losing the write. The text/html guard alone is sufficient because SilverBullet's API endpoints (`.fs/`, `index.json`, `.attachment/`) return non-HTML content types (text/markdown, application/json, image MIMEs) and never reach the rewriter.

When the body is rewritten, both `Content-Length` (body length changed) and `Content-Encoding` (Workers `Response.text()` auto-decompresses gzip/br upstream, so the body is now plain text) are dropped from the response headers. A `vault base-href rewrite no-op` warning is logged when the rewrite runs but matches nothing -- gated to status 200 on the shell paths (`/`, `/index.html`) so error pages and non-shell HTML do not generate false-positive warnings, so a future SilverBullet template change (single-quoted href, added attribute, etc.) still surfaces as a logged signal on the load-bearing paths.

Rewrite contract (regex, header hygiene, selectors): see `handleVaultRequest` in `src/routes/vault/index.ts`.

### Service Worker registration noop bypass

SilverBullet's client registers a Service Worker for offline caching. Browsers may omit credentials on `navigator.serviceWorker.register()` script fetches (Chrome 76+ per spec, Samsung Internet and other Chromium forks may not), so the cookie-auth chain at `/api/vault/<sid>/service_worker.js` would return 401 and registration would fail permanently.

`handleVaultRequest` short-circuits these requests and serves SilverBullet's native service worker (`VAULT_NATIVE_SERVICE_WORKER_JS`, the SB 2.10.0 binary worker vendored verbatim in `src/routes/vault/native-sw.ts`, SHA-256 drift-guarded) directly from the Worker. The selector requires three conditions: method `GET`, exact path `/service_worker.js`, and request header `Service-Worker: script` (a Fetch-spec forbidden header name - page JavaScript cannot set it via `fetch()`). Cookie presence is intentionally not checked because Samsung Internet and other Chromium forks may send cookies on SW registration fetches; serving the same native worker for both the cookied and cookieless cases is what keeps registration browser-agnostic.

Serving the native worker (not the former key-shim) is the AD69 fix for codeflare#445: the native worker carries SilverBullet's sync engine and its persistent `sb_files_*` local-sync store, so the editor indexes incrementally and keeps a resumable local copy instead of re-indexing the whole vault over HTTP on every cold load. The worker bytes are identical across sessions and contain zero user data (the bucket-stable vault encryption key is posted in via `postMessage` from the auth-gated bootstrap-hop page to the worker's native `set-encryption-key` handler, never baked into the JS source), so bypassing auth on this exact request is safe.

The native worker precaches the shell `/` plus its `/.client/*` static assets via `cache.addAll(...)` during `install`. That precache of `/` runs BEFORE the bootstrap-hop sets the `codeflare_vault_bootstrap` cookie, so the shell-path 302-to-hop would otherwise make `cache.addAll` reject atomically and hang the SW install. `handleVaultRequest` suppresses that redirect for Service-Worker-context fetches, identified by `isServiceWorkerContextFetch` (`Sec-Fetch-Mode` header present and != `navigate` - the browser only sets `navigate` on top-level document loads). The same exact shell/client, cache-versioned, non-navigation signature skips per-asset session-activity refreshes, preventing the complete precache from becoming a same-key write burst while unrelated GETs still count as activity ([REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC7). Top-level navigations and clients with no `Sec-Fetch-Mode` still get the hop (fail-safe), so a real first navigation never boots without the encryption key wired.

The served worker is not the verbatim upstream bytes. `graftVaultKeyRecovery` (`src/routes/vault/native-sw.ts`) injects a `__cfRecover()` helper and calls it at the worker's two key-empty checkpoints to re-fetch the key from `/.vault-key` when its in-memory key is empty (see the encryption section below). This graft is mandatory, not optional: the upstream worker flushes its key 5s after the last client disconnects, so Codeflare's served graft neuters that proactive flush. The browser can still idle-terminate the worker at any time, which clears module memory and requires recovery.

Without recovery, the key is gone before the shell boots and SB bounces to `.auth`. The first integration deploy reproduced exactly that on cold boot, and a graft on `get-encryption-key` alone did not fix it because the actual trigger is the `config`-message auth-gate, which reads the key directly. The same graft also removes no-client info spam and demotes expected auth/sync startup retries while leaving client messages and unexpected proxy errors intact.

The verbatim upstream bytes are stored separately (`VAULT_NATIVE_SW_VERBATIM`) and SHA-256 drift-guarded. The SilverBullet shadow-pin job updates the server version, authoritative GitHub release-asset digest, and this worker atomically ([REQ-OPS-032](../../sdd/spec/operations.md#req-ops-032-silverbullet-coupled-release-automation)); graft-anchor and syntax tests fail closed when upstream minification or behavior moves. SilverBullet 2.10.0's worker precaches with `cache: "reload"`, preventing a stale browser HTTP-cache entry from being installed into the service-worker cache and repeatedly triggering the client/server version-mismatch notification. The only AD69 item still gated on integration observation is the `/.client/*` precache-auth exemption, reserved on [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker), the native-SW contract. It is needed only if those precache fetches return 401.

#### Not-ready sync guard ([REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft) AC2, [REQ-VAULT-023](../../sdd/spec/vault.md#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC2)

`graftVaultKeyRecovery` also guards the sync engine against a not-yet-ready SilverBullet server. The sync engine treats the remote (`secondary` -- the in-container SB server) as authoritative for deletions: a file present in the persistent local `sb_files_*` store and the sync snapshot but absent from the remote `fetchFileList()` is deleted from the local store. The console line is `File deleted on secondary, deleting from primary`.

The in-container SB server takes ~1-2 min to become ready after a fresh session starts. During that window `fetchFileList()` returns an empty list or a non-array body, such as a 5xx or stray CF Access 302 HTML body, not the real list. Because [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) makes the local store bucket-stable and persistent, a 2nd session that reconciled against that not-ready response would see every local file as deleted on secondary, wipe the entire vault on open, and churn the editor so the terminal never regains focus.

The graft wraps the `o=` initializer of the full-sync cycle: it normalizes a non-array to `[]`, then throws to abort the cycle before any deletion when the remote list is empty while the local store (`s`) or snapshot (`t.files`) is non-empty. `syncSpace` rethrows; the sync `run()` loop logs a downgraded warn and retries on its ~20s interval, deferring reconciliation until the server is actually serving the real list. A genuinely empty vault (empty primary and empty snapshot) stays a safe no-op, and a real non-empty list reconciles normally. The SW therefore deletes only once it has reached SilverBullet and SilverBullet has confirmed the file list.

#### Deterministic preseed mtime stops the 2nd-session 'preparing' loop

Distinct from the not-ready *deletion* guard above, this addresses a spurious *change* loop ([REQ-VAULT-023](../../sdd/spec/vault.md#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC3). REQ-VAULT-021's persistent client sync snapshot records each force-overwritten config page's `lastModified` from the session that built it, but bisync/cp give a byte-identical `CONFIG.md` a fresh mtime on every container boot. On a 2nd session that fresh mtime diverges from the snapshot, so SilverBullet's sync engine reports the page "changed on secondary" on every ~3s editor watch-poll, copies it, reloads, and re-enqueues one index op per cycle.

The prewarm readiness gate (`injectVaultPrewarmBridge`: index queue empty for `requiredReadyStreak` consecutive polls, [REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC6) therefore never settles and the Vault button breathes 'preparing' indefinitely; a cold start is unaffected because its snapshot is built fresh in-session.

`init_user_vault()` fixes this for the force-overwritten config pages by stamping `CONFIG.md`, `README.md`, and `STYLES.md` (the `PRESEED_PAGES` set) with the immutable preseed source mtime (`touch -r "$PRESEED_DIR/$PAGE" "$VAULT/$PAGE"`) on every boot, even when the `cmp`-based content skip leaves the page untouched. The image's preseed mtime is constant for a release, so the in-container SB server reports an identical `lastModified` for these pages every session. The snapshot agrees, and "changed on secondary" never fires.

**`Index.md` is exempt** — it is no longer in `PRESEED_PAGES` and is not stamped. The deterministic mtime equalizes only the secondary-side mtime, and `Index.md`'s 2nd-start conflict was primary-side: the SilverBullet editor normalizes/re-serializes the dashboard on open and autosaves it. Force-overwriting `Index.md` from preseed at boot fought that client save, producing a "changed on BOTH ends" conflict (`Index.conflicted:*.md`) that no secondary-side mtime stamp could stop. That conflict kept the prewarm index queue from ever draining, so the Vault button never went green on a 2nd start.

The actual 2nd-start fix is moving `Index.md` into the create-if-missing tier (below): once seeded, the client's normalized copy persists via R2 to a no-conflict fixed point. `syncIgnore`-ing the config pages was rejected because it trips the worker's "shouldn't sync" branch that `deleteFile()`s them from local IDB and drops them from the `.fs/` readiness listing, breaking both cold and warm start.

### PUT body forwarding contract (REQ-VAULT-009)

`maybeSynthesizeCsrfHeader` adds `X-Requested-With: XMLHttpRequest` to state-changing requests (PUT/POST/PATCH/DELETE) so `authenticateRequest`'s CSRF guard does not reject vault writes. When a request carries no `Origin` header (SilverBullet's same-origin fetch path, service-worker-controlled fetches, and CLI-style clients), the synthesis now treats the request as same-origin and proceeds rather than skipping it. A request with an Origin header that fails the allowlist still returns 403; the no-Origin fallback does not widen the allowlist. SilverBullet drag-drop attachment uploads (`PUT /api/vault/<sid>/Inbox/<file>`) were the primary trigger: the SB Inbox plug's fetch path omitted Origin, causing the prior code to skip synthesis, reach `authenticateRequest` without `X-Requested-With`, and return 401 to the user.

`container.fetch` must be called with the Request returned by `maybeSynthesizeCsrfHeader`, not the original incoming `request`. The helper consumes the input body when it constructs the header-rewritten clone (Workers Fetch semantics for `new Request(input, { headers })`); forwarding the original raises `TypeError: This ReadableStream is disturbed (has already been read from)`. `handleVaultRequest` hoists `requestForAuth` to outer scope for exactly this reason, and `authenticateRequest` must read only headers (cookies, JWT assertion) -- a future body read inside the auth chain would re-introduce the same bug.

<a id="vault-encryption-and-idb-lifecycle-req-vault-008-req-vault-024-req-vault-015-req-vault-021-req-vault-023"></a>
## Encryption and IDB Lifecycle (REQ-VAULT-008, REQ-VAULT-024, REQ-VAULT-015, REQ-VAULT-021, REQ-VAULT-023)

SilverBullet 2.10.0 ships full client-side IDB encryption via `EncryptedKvPrimitives` (`client/data/encrypted_kv_primitives.ts`). Activation requires three independent conditions checked in `client/boot.ts`:

1. `localStorage["enableEncryption"]` is truthy - set by the bootstrap-hop page (below).
2. `bootConfig.enableClientEncryption === true` - set by the Worker's `injectVaultEncryptionConfig` (`src/routes/vault/index.ts`), which rewrites the upstream `/.config` JSON before it reaches the SB client.
3. A `CryptoKey` is held in the per-origin service worker's `encryptionKeyMemoryStore`, postMessage'd in via `{type: "set-encryption-key"}` - done by the bootstrap-hop page (below).

The `.config` rewrite also injects `bootConfig.vaultEncryptionKey`, the bucket-derived key from `getVaultEncryptionKey` described below. The key reaches the SB client through two independent channels: the bootstrap-hop's SW `postMessage` (condition 3, the runtime path SB actually uses) and the bootConfig JSON read at boot. Both must stay in sync. A key rotation that updates one channel without the other surfaces as "encryption flag set but SW has no key" and SB aborts the encrypted open.
The two injection points are distinct: `injectVaultEncryptionConfig` handles condition 2 (a JSON rewrite on the `/.config` proxy response), while the bootstrap-hop page handles conditions 1 and 3 (localStorage flag + SW key transport). Both must fire for SB to enable encryption.

With all three conditions satisfied, SB derives an AES-GCM key from the AES-CTR raw bytes via `deriveGCMKeyFromCTR` (`plug-api/lib/crypto.ts`) and wraps the `sb_data_<hash>` IDB through `EncryptedKvPrimitives`, so values are AES-GCM ciphertext at rest (random IV per write, AES-256). The Worker delivers the raw key material as AES-CTR base64; the wire/transport format is AES-CTR-shaped, the at-rest format is AES-GCM.

The Worker bridges the gap between codeflare's auth model (no SB passphrase, key lives in the Container DO) and SB's runtime contract via a one-time bootstrap-hop page:

- `GET /api/vault/<token>/.codeflare-bootstrap` renders the auth-gated bootstrap page through `injectVaultBootstrapHopHtml` in `src/routes/vault/index.ts`.
- `GET /api/vault/<token>/.vault-key` is an auth-gated endpoint that returns `{key}` JSON via `getVaultEncryptionKey` with `Cache-Control: no-store`.
- The dashboard's pre-open recoverability check fetches the session-keyed `/api/vault/<sid>/.vault-key`, which 302-redirects here.
- The service worker is SilverBullet's native worker (`VAULT_NATIVE_SERVICE_WORKER_JS`) with the codeflare `graftVaultKeyRecovery` patch applied.

The bootstrap page registers SilverBullet's native service worker, posts the bucket-derived AES-CTR key to its native `set-encryption-key` handler, and persists `localStorage["enableEncryption"]` before setting the `codeflare_vault_bootstrap` cookie and redirecting to `/api/vault/<token>/`. If browser storage rejects the flag write, the page shows the bootstrap error and emits neither the completion cookie nor the redirect. The key comes from `getVaultEncryptionKey`: HKDF-SHA256 over `ENCRYPTION_KEY` + the bucket name, see [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key). The SB shell handler 302-redirects to this hop on any shell-path request without the bootstrap cookie, so first visits always traverse it. After the hop completes, the cookie suppresses redirects and the shell handler proxies the SB binary normally.

The hop page guards against missing `navigator.serviceWorker`, failing loud if the API is absent. It uses a 10-second activation timeout (`VAULT_SW_ACTIVATION_TIMEOUT_MS`) instead of the indefinite `navigator.serviceWorker.ready`, and detects the "redundant" SW state (install failure) as an explicit error. On any failure the hop shows a user-visible error and aborts without setting the cookie or flag.

The `.vault-key` endpoint is used by the grafted native worker to recover the encryption key whenever its in-memory key is gone ([REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC5). It uses the same auth chain as `.codeflare-bootstrap`.

The native worker is the full SB sync engine plus its native `set-encryption-key` / `get-encryption-key` message handlers. Upstream stores the posted key in a module-local variable, proactively flushes it 5s after the last client disconnects, and has no recovery after idle termination. Codeflare's served graft neuters the proactive flush and adds recovery when genuine worker termination clears module memory.

Two upstream paths read the key and fail hard when it is empty. The **`config`** message handler, gate `if(t.enableClientEncryption&&!y)`, posts an auth-error and the client navigates to `.auth`; before Codeflare neutered the proactive transition flush, this fired on cold boot when the client posted `config` after the bootstrap-hop -> shell transition. The `get-encryption-key` reply is the other path. The served graft now retains the key across that no-client gap and recovers it after genuine worker termination.

The graft injects a shared `__cfRecover()` helper. When the key is empty, it fetches `/api/vault/<token>/.vault-key` with `{credentials:'same-origin'}`, scope-relative to the bucket-stable SW, so the fetch carries the `cf_vault_sid` cookie. It decodes with SB's own decoder, sets the key, and calls the helper at both sites before either gives up. This is the same fallback the old key-shim had, and it keeps cold boot and idle-reopen from bouncing to `.auth`. The former key-shim (`VAULT_KEY_SHIM_SERVICE_WORKER_JS`) has been removed now that the native-worker path is verified on integration (AD69).

SilverBullet maintains two IndexedDB databases per (spaceFolderPath, baseURI, encryptionKeyPart) tuple: `sb_data_<hash>` (client-context, opened by `client/client.ts`) and `sb_files_<hash>` (SW-context, opened by `client/service_worker.ts`). With the native worker now served (AD69), BOTH are created: `sb_files_*` is the persistent local-sync store that makes indexing incremental and survives cold loads (the codeflare#445 fix). Both stores are encrypted through the same key. (Under the former key-shim only `sb_data_*` existed and `sb_files_*` was never created, which is why the editor re-indexed over the network on every cold load.)

The current token salt is deliberately versioned. The v2 cutover changes `baseURI` once, which makes SilverBullet derive a fresh encrypted `sb_data_*`/`sb_files_*` pair and installs one new canonical worker scope. Historical registrations and databases are not enumerated, migrated, unregistered, or deleted; they remain visible as orphaned browser state. Every future session and ordinary worker update reuses the stable v2 scope, so current registrations no longer accumulate ([REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC1-AC3). <!-- @impl: src/lib/vault-bucket-token.ts::getVaultBucketToken -->

Cleanup runs at two surfaces (`web-ui/src/lib/vault-cache.ts`):

Reconciled by [REQ-VAULT-023](../../sdd/spec/vault.md#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap): the current `sb_data_*`/`sb_files_*` IndexedDB stores and vault service worker are **bucket-stable** — one current set per user, shared across future sessions — while historical sets remain untouched orphans. Cleanup deletes NEITHER IndexedDB databases NOR service workers. Deleting them on a per-session DELETE, orphan sweep, or release cutover could erase another session's vault state. Cleanup is therefore localStorage-marker bookkeeping only. The boot recorder records the exact current worker scope beside the IDB names; a changed or absent scope clears only stale readiness markers and forces the normal on-demand prewarm lifecycle.

- `cleanupSessionVaultCache(sid)` -- called from `deleteSession()`. Removes the `vault-session-<sid>`, `vault-session-<sid>-idbs`, `vault-session-<sid>-scope`, and `vault-session-<sid>-prewarmed` localStorage keys. Does not touch IndexedDB or any service worker.
- `sweepOrphanVaultCaches(activeSessionIds)` -- called only after an authoritative `loadSessions()` fetch succeeds. Removes marker keys for sessions absent from `activeSessionIds`.

`sweepOrphanVaultCaches` iterates the plain, `-idbs`, `-scope`, and `-prewarmed` entries under `vault-session-*`. `listSessionMarkers` strips those suffixes so they map to the same sid. The sweep catches sessions deleted via API in another tab or after a browser crash. Dashboard mount does not sweep, because it can see the initial empty store before the session list is known.

All operations are fail-safe: a missing global (SSR, fresh tab) or malformed `-idbs` JSON value is swallowed silently because cleanup is best-effort and must never block the delete UI or a successful session-list refresh.

**Principled-rejection invariant (load-bearing):** the cleanup helpers MUST NEVER enumerate IDBs via `indexedDB.databases()` and never derive names from the `sb_<type>_<hash>` formula. They work exclusively from the recorded localStorage list. An earlier version parsed `parts[2]` of the IDB name as the sid and nuked every SB IDB on every Dashboard mount, forcing a full SB resync on every reopen. The new design avoids the bug entirely by recording observed names at boot rather than re-deriving them.

<a id="shutdown-bisync-reliability-req-vault-006"></a>
## Persistence and Finalization (REQ-VAULT-006)

Vault durability depends on the lifecycle-owned final persistence drain documented in [Storage & Sync](storage-and-sync.md#manual-sync-triggers-req-stor-015). `Container.destroy()` is the authority: it requests the audited host drain with a 120-second sync budget, permits the host a 125-second internal boundary, and keeps teardown within the 135-second ceiling from [AD57](../decisions/README.md#ad57-135-second-shutdown-budget-for-final-bisync). The `entrypoint.sh` signal trap is only a best-effort backstop, not the primary shutdown path. <!-- @impl: src/container/container-lifecycle.ts::destroy --> <!-- @impl: src/container/container-metrics.ts::FINAL_SYNC_BUDGET_MS -->

A failed or timed-out drain leaves recent Vault edits at risk because local disk is ephemeral. Operators should correlate the final-sync audit result and `shutdownElapsedMs`, then use [Storage & Sync failure recovery](storage-and-sync.md#troubleshooting) rather than treating SilverBullet readiness as persistence evidence.

<a id="preseed-integration-req-vault-007"></a>
## Bootstrap and Seed Integration (REQ-VAULT-007)

The vault plugin and supporting rule ship as preseed entries that land in every advanced-mode session at container boot:

- `preseed/agents/claude/plugins/codeflare-vault/` -- plugin descriptor, prompt-submit hook, extraction contract, and graph merge helper ([REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions)).

  `merge-vault-graph.py` performs the locked load, compose, cluster, and persist step. The plugin is registered in `preseed/agents/claude/manifest.json`.
- `preseed/agents/claude/agents/vault-extract.md` -- named subagent definition; frontmatter pins `model: sonnet` per [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad). Registered in the manifest's top-level `agents/` section and delivered via `reconcileAgentConfigs()`.

The model pin prevents silent downgrade via a Task tool override. Delivery uses the same pipeline as architect, code-reviewer, and other agents.
- Vault trigger and route rules live in the "Vault operations" and "Vault-edit hook" sections of `preseed/agents/claude/rules/memory.md`.

  Vault layout, wikilink conventions, and prohibited operations live in `preseed/agents/claude/skills/vault-operations/SKILL.md`, which is advanced-mode only.
- `preseed/agents/claude/rules/vault-note-capture.md` + `preseed/agents/claude/skills/vault-note-capture/SKILL.md` -- minimal trigger rule plus on-demand skill for "take a note" / "note this down" requests into `Notes/<Category>/`. Advanced-mode only.
- `preseed/silverbullet/` -- optional `atlas.plug.js`, the four preseeded plug files (`pdf`, `treeview`, `github`, `graph` -- see `preseed/silverbullet/plugs/MANIFEST.md`), three always-managed root pages, and the create-if-missing `Index.md` dashboard.

The note-capture rule stays small to keep always-in-context bloat minimal; the skill loads on demand with category inference, filename format, body template, and wikilink convention. The always-managed pages are `README.md`, `CONFIG.md`, and `STYLES.md`; `Index.md` is copied only when missing and is then editor-owned. The Dockerfile copies `preseed/silverbullet/` to `/opt/silverbullet-preseed/`, and `init_user_vault()` applies the matching ownership tier on every boot. `config.yaml` was removed because SilverBullet 2.x ignores `.silverbullet/config.yaml` entirely; runtime config goes through `CONFIG.md` and env vars only.

`scripts/generate-agent-seed.mjs` reads the manifest and emits `src/lib/agent-seed.generated.ts`, the typed payload that the container fetches and writes during preseed. The vault plugin appears in default mode's manifest only as the rule's exclusion entry; runtime files are advanced-mode gated.

### Vault initialization tiers (REQ-VAULT-001 AC3 + REQ-VAULT-010 AC1/AC4/AC5)

`init_user_vault()` is split into three tiers by what the user can durably change:

| Tier | Path |
|------|------|
| Always-mkdir (critical dirs) | `Raw/Sessions/`, `Raw/Pasted/`, `Raw/Graphs/`, `Notes/`, `References/`, `graphify-out/`, `.silverbullet/_plug/` |
| Always-overwrite (Codeflare-authoritative config pages) | `CONFIG.md`, `README.md`, `STYLES.md` (`PRESEED_PAGES`) |
| Create-if-missing (user-editable pages) | `Index.md`, `Notes.md`, `References.md`, `Raw/Graphs/Vault Graph.md` |
| One-time cleanup (legacy pages) | `Raw/Graphs/Global Graph.md`, `Raw/Graphs/global-graph.html` |
| Recreate-if-missing (build-output stub) | `graphify-out/graph.json` |
| Cleanup of dead config | `.silverbullet/config.yaml` |
| Idempotent plug sync | `Library/Codeflare/*.plug.js` |

**Always-mkdir:** runs `mkdir -p`; existing contents are untouched. User-deleted directories are recreated empty so agent hooks and SilverBullet cannot land in a broken state.

**Always-overwrite:** copies from `/opt/silverbullet-preseed/`, gated so identical files are not rewritten. On every boot each page is additionally stamped with the immutable preseed source's mtime (`touch -r`), even when the content-equality skip left it untouched. The in-container SB server therefore reports a stable `lastModified` across sessions and the persistent client sync snapshot never sees a spurious "changed on secondary" ([REQ-VAULT-023](../../sdd/spec/vault.md#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC3 -- see [Deterministic preseed mtime](#deterministic-preseed-mtime-stops-the-2nd-session-preparing-loop)). User edits are silently reverted on next boot; these files are Codeflare-owned because they encode SB `#meta` config, theme, and user guide.

**Create-if-missing:** copies from `/opt/silverbullet-preseed/` only when absent, including the `for LANDING in Index.md Notes.md References.md` loop and the separate `Vault Graph.md` seed. The pages are never overwritten on subsequent boots, so user edits and deletions are preserved. `Index.md` is create-if-missing because the SilverBullet editor normalizes and autosaves the dashboard on open. A boot-time revert fought that client save into a perpetual `Index.conflicted:*.md` sync conflict that kept the prewarm index queue from draining, so the Vault button never went green on a 2nd start; see [Deterministic preseed mtime](#deterministic-preseed-mtime-stops-the-2nd-session-preparing-loop).

`Vault Graph.md` seeds the `Raw/Graphs/` treeview folder on a fresh vault, because treeview is page-driven and an empty directory is invisible. `Notes.md`/`References.md` resolve `Index.md`'s bare `[[Notes]]`/`[[References]]` wikilinks to real pages instead of broken/aspiring 404s ([REQ-VAULT-023](../../sdd/spec/vault.md#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC4).

**One-time cleanup:** removes the legacy graph page and HTML on every boot if present, using idempotent `rm -f`. The unified global graph is a 10k+ node corpus that renders as an unusable force-directed hairball; structural queries via `mcp__graphify__*` are the real interface. Vaults restored from R2 snapshots predating the drop are reconciled to current state on the next boot.

**Recreate-if-missing:** seeds `graphify-out/graph.json` with the empty-graph JSON only when absent. The populated graph from a prior session is never overwritten. The graph is build output regenerated by `graphify extract` / `graphify global add`.

**Cleanup of dead config:** removes `.silverbullet/config.yaml` on every boot. SilverBullet 2.x does not read this file; leaving it on disk only misleads future readers.

**Idempotent plug sync:** copies each `Library/Codeflare/*.plug.js` file from `/opt/silverbullet-preseed/plugs/` only when content differs. User plugs in other `Library/` subdirectories are untouched. Never copy a partial `Library/Std/` onto disk: SilverBullet's binary ships compiled `Library/Std/Plugs/*.plug.js` via the `client_bundle/base_fs` overlay, and a disk shadow with only source markdown breaks widget rendering.

The contract closes failure modes that surfaced in earlier releases:
- Deleting any preseed page silently broke the SilverBullet dashboard or theme.
- An R2-restored vault that pre-dated a preseed update would carry stale pages forever, because the prior `init_user_vault()` only ran content sync inside the first-init gate.
- A `.silverbullet/config.yaml` file from older releases gave a false sense that SB was reading bootstrap settings from it; in SB 2.x the file is dead and only env vars + `CONFIG.md` actually configure the server.

### CONFIG.md and Library/Std (base_fs)

`CONFIG.md` is a SilverBullet 2.x `#meta` page with an optional `space-lua` config block (built-in keys defined in `Library/Std/Config.md`; see [SilverBullet docs](https://silverbullet.md/Configuration)). Earlier releases used a yaml block with `libraries:` and `pageBlackList:` -- both keys are unrecognized by SB 2.x and were always no-ops.

The preseed `CONFIG.md` includes a `space-lua` block that configures treeview navigation exclusions ([REQ-VAULT-015](../../sdd/spec/vault.md#req-vault-015-vault-idb-lifecycle-and-listing-filters) AC2). The upstream silverbullet-treeview plug v2 schema requires the top-level key `treeview` (not `plug.treeview`) and the field `exclusions` (not `exclude`), where each entry is `{ type = "regex", rule = "<regex>" }`. Bare-string glob patterns are silently dropped by the plug.

The block hides `Library/`, `Repositories/`, `graphify-out/`, and the four top-level preseed pages (`CONFIG`, `Index`, `README`, `STYLES`). `Repositories/` is SilverBullet's own library-manager mirror created at runtime by the Library Manager plug; users do not curate it. `.silverbullet/` is dot-prefixed and hidden by SilverBullet's default behaviour without an explicit rule. This exclusion list is the UI-side complement to the server-side `/.fs` filter ([REQ-VAULT-015](../../sdd/spec/vault.md#req-vault-015-vault-idb-lifecycle-and-listing-filters) AC1) that strips `graphify-out/**` and generated `Raw/Graphs/*.html` files from raw listings.

`Library/Std` (and its compiled `Plugs/*.plug.js`) is served by the SilverBullet binary from its built-in `client_bundle/base_fs` overlay. There is nothing to federate at runtime and nothing to preseed onto disk. The dashboard's `widgets.commandButton`, `templates.fullPageItem`, `templates.pageItem`, `templates.taskItem`, `index.contentPages()`, and `tags.page` all resolve through that overlay automatically. The first-load delay (~30 s on a fresh browser) is the SilverBullet client building its IndexedDB index of Library/Std files; subsequent loads are instant from cache.

### STYLES.md and codeflare theming (REQ-VAULT-007)

`STYLES.md` applies the codeflare visual theme inside SilverBullet via the `#meta/styles` tag (SilverBullet's convention for theme pages). It targets SilverBullet 2.x's CSS variable namespace under `html[data-theme="dark"]`: `--root-*`, `--ui-accent-*`, `--top-*`, `--button-*`, `--editor-*`, `--modal-*`, `--panel-*`, and `--editor-wiki-link-*`. This was verified against the 2.9.0 `client/styles/theme.scss` source.

The codeflare palette tokens (`--cf-*`, zinc dark base + blue accent matching `web-ui/src/styles/design-tokens.css`) are defined locally in `:root` and consumed by the SB variables. Earlier versions of this file only defined `--cf-*` variables, which SilverBullet does not read, so the theme had no visual effect until the variable mapping was corrected. See [AD55](../decisions/README.md#ad55-codeflare-brands-the-vault-editor-via-preseed-managed-stylesmd). It is always-overwritten on boot and cannot be customised in-place; theme changes must go through `preseed/silverbullet/STYLES.md` in the repo.

### SilverBullet plug preinstall (REQ-VAULT-007)

On every boot, `init_user_vault()` copies the plug files from `/opt/silverbullet-preseed/plugs/` into `~/Vault/Library/Codeflare/`. The copy is idempotent: each file is only overwritten when its content differs from the installed copy (using `cmp`), so a pin bump in the Dockerfile propagates on the next boot without touching user-written notes.

| Plug | Provides |
|---|---|
| `pdf` | Inline PDF rendering inside notes |
| `treeview` | File tree sidebar |
| `github` | GitHub issue/PR embedding |
| `graph` | Local graph visualisation of `[[wikilinks]]` |

`Library/Codeflare/` is reserved for codeflare-managed plugs. User-installed plugs go under other `Library/` subdirectories (e.g. `Library/Personal/`); the boot-time overwrite never touches those paths.

### First-session Expectations

A brand-new session boots with a pre-populated vault. `README.md`, `CONFIG.md`, and `STYLES.md` are always written from preseed on every boot. `Index.md`, `Notes.md`, and `References.md` are seeded from preseed only when absent (create-if-missing). `Index.md` is no longer force-overwritten because the editor normalizes and autosaves the dashboard, so a boot-time revert produced a perpetual `Index.conflicted:*.md` sync conflict; see [Vault initialization tiers](#vault-initialization-tiers-req-vault-001-ac3--req-vault-010-ac1ac4ac5).

Critical subdirectories (`Raw/Sessions/`, `Raw/Pasted/`, `Raw/Graphs/`, `Notes/`, `References/`, `graphify-out/`, `.silverbullet/_plug/`) are always `mkdir -p`'d. `Raw/Graphs/Vault Graph.md` is seeded from preseed only when absent and is never overwritten. Legacy `Global Graph.md` pages from earlier installs are removed on every boot because the unified global graph is too large for useful HTML rendering; use `mcp__graphify__*` instead. `graphify-out/graph.json` is seeded as an empty stub only when absent.

A returning session inherits R2-restored content for user-owned paths: `Notes/`, `References/`, `Inbox/`, `Journal/`, `Raw/Pasted/`, `Raw/Sessions/`, plus `Index.md` once seeded. The always-overwrite config pages are refreshed from preseed regardless, so any preseed update propagates without per-user migration.

`init_user_vault()` runs AFTER `establish_bisync_baseline()` so we never run the per-boot sync over a half-restored vault. If the baseline fails for any reason, the init function still runs (`(init_user_vault) || echo ...`) and the critical-dir + preseed-page tiers are created locally; the next successful bisync reconciles user content.

On first browser open after a fresh vault, SilverBullet must build this browser's IndexedDB stores, complete its service-worker space sync, and build the object index. Codeflare does that work on demand, on the user's first click: the Vault button stays guarded ('idle') until the server probe succeeds, then becomes clickable ('available'). The first click mounts the hidden same-origin prewarm iframe, and the button breathes 'preparing' until that iframe emits the current-device bridge ready signal ([REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC1-AC6).

That ready signal requires local `sb_data_*`/`sb_files_*` proof recorded for the exact current worker scope, an active registration at that scope, a `space-sync-complete` signal from SilverBullet, SilverBullet's current object-index version complete with the index queue empty, and a local `/.fs/` listing containing the codeflare-authoritative files (`CONFIG.md`, `Index.md`, `STYLES.md`). Orphaned registrations and databases cannot satisfy readiness ([REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC4). The arming poll verifies `/.vault-key` before the button breathes green ('armed'): it stays in the non-openable preparing state until local readiness and key recoverability both hold.

The user-visible lifecycle is unchanged: white static means available but unprepared; the first click starts prewarm and breathes in the theme accent; completed proof breathes green; the second click opens synchronously inside the gesture with no per-open re-verification ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC1, [REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC6). The hidden prewarm shell is focus-inert, so the on-demand prewarm runs while the user types in the terminal without dismissing the mobile keyboard ([REQ-VAULT-020](../../sdd/spec/vault.md#req-vault-020-vault-prewarm-focus-safety)). Subsequent user clicks open a tab against the already-prepared current browser cache.

Visual confirmation that the preseed theme is wired correctly: the editor renders on a zinc-950 base (`#09090b`), wikilinks and modal selection use a blue-500 accent (`hsl(217, 91%, 60%)`), body type is Inter and code spans are JetBrains Mono. If the editor shows SilverBullet's default white/cream palette, `STYLES.md` is missing or targeting variables SB does not consume (the previous `--cf-*`-only regression).

The vault-monitor daemon does not fire a spurious extraction when a newly created vault completes its first durable initialization: `init_user_vault()` baselines the content-hash manifest, then writes `vault-extract-initialized`. A preseed update alone also does not fire it because the four managed pages are excluded by name. Existing or restored vault migration is deliberately different: init records the durable marker without baselining, and a missing manifest remains full-delta eligible. The five-prompt, zero-hook expectation applies to a new untouched vault and to a returning vault whose manifest was restored, not to a vault whose durable high-water state is missing.

## Attachments and Ingestion

<a id="attachment-cost-caveat-req-vault-011-ac1"></a>
### Attachment Cost Caveat (REQ-VAULT-011 AC1)

SilverBullet writes pasted / drag-dropped attachments next to the note that referenced them (a Quick Note at `Inbox/2026-05-18/16-59-59.md` produces attachments at `Inbox/2026-05-18/*.pdf`, `.png`, etc.). On Claude, vault-extract reads PDFs through the native PDF-capable Read tool (rendering pages as images, capped at 20 pages per PDF), emits a `document` node plus visible title/heading/entity concepts, and can cite a sibling Markdown wikilink. Image-only PDFs and screenshots cost vision tokens per page on every Claude ingestion pass. Pi has no PDF page reader and emits only a metadata-derived bare document node; it does not claim content/citation parity. Move attachments to `Raw/Pasted/` manually if you want them grouped outside the date-folder rhythm.

<a id="pdf-ingestion-e2e-plan-req-vault-011"></a>
### PDF-Ingestion E2E Plan (REQ-VAULT-011)

Manual verification for runtime-specific PDF handling. Claude's content/vision/citation behavior is agent-prompt behavior driven by its `vault-extract-prompt.md`; Pi's prompt deliberately remains metadata-only. There is no synthetic PDF reader or shader-like internal test.

1. Claude AC1/AC2 - healthy PDF: drop a multi-page text PDF into `Raw/Pasted/`, wait one 60s daemon tick, then confirm content-derived graph nodes.
2. Claude AC3 - citation edge: add a sibling Markdown note that wikilinks the same PDF, tick again, and confirm the edge.
3. Pi AC4 - submit a PDF and confirm it produces only a metadata document node.
4. AC5 failure isolation - drop a corrupt or password-protected PDF alongside a healthy changed file and confirm one unreadable PDF does not block the batch or manifest advancement.

On Claude, the global graph should gain a `document` node plus concepts for visible titles, headings, and named entities; a sibling wikilink should receive a citation edge. On Pi, no visible PDF content or citation edge is inferred. A corrupt PDF emits only a bare document node while healthy sibling input still ingests.

## Memory Capture System

Cross-session memory in codeflare lives entirely in the vault. Graphify ingests every supported vault input into the unified global graph; agents query it via runtime-native Graphify tools. The former MCP `@modelcontextprotocol/server-memory` subsystem has been removed. Conversation context (decisions, debugging insights, observations) survives across sessions and devices only in Pro/advanced mode, where the capture machinery writes structured notes and bisync preserves the vault subtree. Default mode registers no memory-capture hook, counter, or persisted Vault write machinery.

Implements [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-004](../../sdd/spec/memory.md#req-mem-004-vault-contents-synced-to-r2-across-sessions), [REQ-MEM-006](../../sdd/spec/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-MEM-008](../../sdd/spec/memory.md#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline), [REQ-MEM-010](../../sdd/spec/memory.md#req-mem-010-memory-capture-hook-plumbing).

### Hook Mechanics

The `memory-capture.sh` script runs as a **UserPromptSubmit hook**.

1. **Tilde expansion** - expands `~` in `transcript_path` to `$HOME`.
2. **Message counting** - `grep -c '"role":"user","content":"[^<]' "$TRANSCRIPT"`
   counts real human prompts. Two layers of synthetic messages are
   excluded: tool_result wrappers (array content, excluded by the
   trailing `"`) and slash-command/task-notification wrappers (string
   content starting with `<`, excluded by `[^<]`).
3. **Counter check** - reads the last count from line 1 and last offset from line 2 of `/tmp/.memory-counter/{session_id}`; `CURRENT_COUNT` counts real-user prompts.
   - **Lifetime:** `/tmp` is fresh after container recycle, so counter presence distinguishes a continuing session from a fresh container.
   - **Override:** `MEMCAP_COUNTER_DIR` changes the location for hermetic tests; production leaves it unset.
   - **Existing counter:** a delta below 15 exits silently.
   - **`CURRENT_COUNT == 1`:** baseline at the transcript size, write the counter, emit the first-message graphify-query nudge, and exit without capture.
   - **`CURRENT_COUNT > 1`:** treat the restored transcript as a resumed session ([REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages) AC6). Capture from line 1 to flush the prior-session tail and re-emit the graphify-query directive.
   - **Why re-emit:** the recycled agent context no longer recalls prior decisions or graph-query guidance.
4. **Vars file** - writes transcript path, offsets, date, counts, and
   counter path to `/tmp/.memory-counter/{session_id}.vars` as JSON.
5. **Counter update** - writes current count + total lines back to the
   counter before emitting so subsequent invocations see delta `< 15`.
6. **JSON output** - emits `{hookSpecificOutput:{...,additionalContext}}` with three launch constraints.
   - The hook launches the capture subprocess itself; nothing is asked of the main agent before other work.
   - There is no blocking hook. An armed request relaunches once per user prompt and is counted, except while a capture is still running. Six failed launches latch it until fifteen further prompts allow a replacement.
   - Publication refuses unless the request's named capture file exists, and only then advances the counter and drains `.vars`, so a failed capture leaves its window uncommitted for a later request ([AD124](../decisions/README.md#ad124-bounded-re-delivery-replaces-the-memory-capture-hard-block)).
   - `run-memory-capture.sh` passes `--model sonnet --effort medium`, overridable with `CODEFLARE_MEMORY_MODEL` and `CODEFLARE_MEMORY_EFFORT`; the agent frontmatter is not read on this path ([AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)).

`run-memory-capture.sh` retains the `.vars` retry carrier, runs
`prefilter-transcript.sh` before the capture subprocess starts (jq filter that strips tool I/O, slash-command
wrappers, and meta records - 76x size reduction on a typical transcript),
splits the clean NDJSON into chunks, processes each chunk into a scratchpad,
then synthesises the final vault note. One locked fail-closed command merges
the cumulative graph, publishes `user_vault`, and only then removes the
carrier. Merge or publication failure leaves it retryable. See [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)
for the rationale (recency bias + haiku confabulation that motivated the
switch from haiku to sonnet).

Every attempt appends its capture exit status,
the publisher's verdict, and — on failure — the stderr tail and the result
envelope's failure subtype (a byte count when unparseable, never the response
text) to
`<carrier>.attempts.log` beside the carrier, because a detached launch
discards the runner's own stderr and a window that burned its attempts
otherwise left nothing to diagnose; the six-attempt latch bounds the file. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/run-memory-capture.sh::ATTEMPT_LOG -->

Between the dedup-gate step and the prefilter step, the agent invokes
`assert-iso-ts.sh` (called by `memory-capture.sh` when it arms a request; [REQ-MEM-010](../../sdd/spec/memory.md#req-mem-010-memory-capture-hook-plumbing) AC5/AC6/AC7).
The script resolves the user's timezone and runs `date` to produce a
stamp like `2026-05-23T22-11-09+0200`.

It then runs three assertions and exits non-zero if any fail: (a) the
stamp must end with a four-digit `[+-]NNNN` offset; (b) that offset must
equal what `TZ="$RESOLVED" date '+%z'` produces, catching dropped-TZ-wrapper
bugs like issue #416 without false-positiving legitimately-UTC hosts; (c)
the reconstructed epoch must be within 30 seconds of the wall clock,
catching LLM fabrications that typically drift hours. Assertion failure
**halts the capture**: no vault file is written, no graph merge runs. The
captured ISO_TS string is the single source of truth for the filename and
`captured_at` frontmatter field; both must contain identical bytes.

### Pi root-owned capture delivery

Pi reads real-user messages from the durable root session and snapshots only prompts after the successful counter at the 15-prompt boundary, bounded to 40 text turns of 4000 characters. It writes request-specific execution JSON before publishing `<sessionId>.vars` as the active request-ID pointer.

Under [REQ-MEM-016](../../sdd/spec/memory.md#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile), launches are medium-reasoning, four-turn public background requests with inherited context disabled. Root JSONL determines missing/running/failed/success state and reminders zero through five. The worker exposes note/chunk only after graph publication; GIVEUP remains latched until fifteen later real prompts produce a replacement request. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionDue -->

The memory agent writes the note and invokes `scripts/build-memory-graph.py` to derive a deterministic graph from the H1 title and canonical concept IDs. It performs the required locked merge/publication but never changes counters or delivery files. Claude's corresponding publication helper keeps merge, global publication, and success-only carrier removal inside one locked command.

The shared merge deduplicates only identical `(source, target, relation, source_file)` evidence, preserves distinct evidence between the same nodes across persisted/prior/new inputs, and keeps `vault-graph.json` and `graph.json` byte-identical. <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence -->

An exact successful native notification qualifies only after publication and while both the post-commit note and its matching graph chunk exist. The root then advances the counter to the greater of its current value and frozen request count and cleans only the matching pointer, snapshot, and graph-chunk artifacts. Failed, late, or superseded results cannot skip a capture window or delete replacement work. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess -->

### Counter Storage

```
/tmp/.memory-counter/
+-- {session_id}         # Two lines: last_count, last_line_offset
+-- {session_id}.vars    # Variables JSON for current hook invocation
```

The counter directory lives under `/tmp` by design: Cloudflare Containers
guarantees that `/tmp` (and all non-R2-backed disk) is fresh on every
container start, which is what makes the counter's absence on the first
hook fire a reliable "fresh container" signal for [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages) AC6
resume detection. No bisync filter is required because `/tmp` is not
synced in the first place. The `MEMCAP_COUNTER_DIR` env var overrides
the default for hermetic tests; production never sets it.

On Pi, `/tmp/.memory-counter` keeps `<sessionId>.count` for the high-water count and `<sessionId>.vars` for the active request pointer. Post-compaction recall in both runtimes reserves each exact `Source:` path before spending its per-extract UTF-8 budget on title or body; a block is omitted if that metadata cannot fit.

The immutable execution snapshot is home-backed at `~/.cache/codeflare-hooks/memory-capture.<sessionId>.<requestId>.vars`; the [extraction data flow](architecture.md#pi-memory-and-vault-extraction-data-flow) owns child visibility and legacy migration. The pointer exists only for reload discovery and is never passed to the background agent.

Cross-reference: the verified Cloudflare-Containers ephemerality contract
this design relies on is captured at `~/Vault/References/Cloudflare-Containers-Ephemerality.md`
in the user's vault.

<a id="specification-coverage-memory"></a>
### Memory Requirement Cross-links

- [REQ-MEM-020](../../sdd/spec/memory.md#req-mem-020-capture-requests-are-re-delivered-under-a-bound) - Capture requests are re-delivered under a bound.
- [REQ-MEM-021](../../sdd/spec/memory.md#req-mem-021-capture-publication-requires-its-artifact) - Capture publication requires its artifact.
- [REQ-MEM-013](../../sdd/spec/memory.md#req-mem-013-proactive-memory-injection-on-first-prompt) - Proactive memory injection on first prompt

<a id="troubleshooting"></a>
## Failure Diagnosis and Recovery

| Symptom | Likely cause | Fix |
|---|---|---|
| Vault button missing from header | Not in terminal view, no active session, or the selected session mode is not advanced | Open an advanced-mode session terminal; all three conditions are required. |
| `curl http://127.0.0.1:3030/` returns nothing inside the container | SilverBullet supervisor not yet up | Wait 5s and retry; check `/tmp/silverbullet.log` for the restart-loop output. |
| `mcp__graphify__query_graph` returns no vault nodes | Global graph not built yet, or wrapper still pointing at per-repo graph | Check `~/.graphify/global-graph.json` exists; if it does, restart the MCP wrapper (it polls on a 2s loop). |
| Edits don't appear in graph queries within 60s | Vault-extract manifest already covers the file (content unchanged) | Run `python3 ~/.claude/plugins/codeflare-vault/scripts/vault-manifest.py changed /home/user/Vault /home/user/Vault/graphify-out/vault-extract-manifest.json`; a genuine content edit under `Notes/` should appear. |
| Stale session state on reopen after stop | Shutdown bisync was killed mid-write | Look for `TIMED OUT after 120s` (or the `logger.warn` at 110 s elapsed) in Durable Object logs (`wrangler tail <SCRIPT_NAME>`); raise the watchdog budget in `shutdown_handler` if it fires routinely. |
| `/api/vault/:sid/` returns 503 | SilverBullet supervisor not ready | Wait for the readiness probe to mark Vault available, then click the button to start prewarm. The button reports preparing and retrying states. |
| Vault button shows armed (green, one-click-to-open) immediately after a page reload, with no prewarm iframe visible | This device completed a full prewarm earlier, so the persistent `vault-session-<sid>-prewarmed` marker plus a live exact-scope readiness check let `Layout.tsx` skip re-mounting the iframe ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC2). | Expected, not stale: the skip requires the recorded current scope, its active worker, and its recorded `sb_data_*`/`sb_files_*`. Missing or superseded scope proof leaves the button white/available until the user starts the normal prewarm. |
| Clicking "Quick Note" shows `You are not authenticated, going to reload...` alert, then reloads to a blank/white page | SilverBullet's client.js writes via PUT/DELETE/PATCH without `X-Requested-With`, which `authenticateRequest`'s CSRF guard required (fixed by the Origin-validated synthesis in `src/routes/vault/index.ts`) | Redeploy the container image to pick up the fix. As a temporary workaround, open the vault in a fresh browser tab (clears any stale ServiceWorker scope that may compound the loop). |
| Drag-dropping a PDF or image into SilverBullet returns 401; attachment never saves | Older image: `maybeSynthesizeCsrfHeader` skipped synthesis when `Origin` was absent (SilverBullet's same-origin fetch and SW-controlled paths omit it), so the PUT landed at `authenticateRequest` without `X-Requested-With` ([REQ-VAULT-009](../../sdd/spec/vault.md#req-vault-009-vault-writes-succeed-end-to-end-for-silverbullet-attachment-uploads)). | Redeploy. After the fix, a missing `Origin` header is treated as same-origin and synthesis proceeds. A present-but-disallowed `Origin` still returns 403. |
| SilverBullet opens lowercase "index" (empty editor) instead of the Codeflare dashboard | Supervisor not exporting `SB_INDEX_PAGE=Index` before launching the binary | Confirm the env var is set in `entrypoint.sh start_silverbullet_supervisor`. SB's Go server hardcodes the default to `"index"` (`server/cmd/server.go` in SilverBullet's source); the env var is the only override. |
| Vault button opens during boot or first sync/index | Readiness guard missing | Keep visible but guarded until all server, prewarm, sync, index, and file-list readiness proofs pass. |
| Dashboard widgets render as raw `${query[[...]]}` text or nothing | Someone copied a partial `Library/Std/` onto disk, shadowing the binary's `base_fs` overlay | `rm -rf ~/Vault/Library/Std` and restart SB. Library/Std is shipped inside the SilverBullet binary; **never** seed it from disk. |
| `mcp__graphify__query_graph` returns no vault nodes even after several capture cycles | Older image: capture agent called `graphify extract --file` (requires an LLM provider key, codeflare ships none), so every run produced 0 nodes | Redeploy. After the fix, agents self-extract via their own conversation and emit chunk JSON that `graphify global add` ingests. |
| Browser console shows `Failed to register a ServiceWorker ... 401 ... fetching the script`; SilverBullet loads but appears unregistered as a PWA / offline mode never activates | Older image: SW registration GET at `/api/vault/<sid>/service_worker.js` ran the cookie-auth chain, but browsers may omit credentials on SW script fetches, so auth returned 401 and registration failed permanently | Redeploy. The Worker now short-circuits SW registration (selector: `service-worker: script` header) and returns SilverBullet's native SW (`VAULT_NATIVE_SERVICE_WORKER_JS`) the browser accepts. Distinct from the CSRF / Quick-Note row above; both can be present on a pre-fix image. |
| Bootstrap-hop page stuck on "Loading vault..." indefinitely | Samsung Internet and other Chromium forks may send cookies on SW registration fetches; the Worker's SW selector rejected cookied requests, so registration fell to SB's native SW whose `cache.addAll()` install failure left `navigator.serviceWorker.ready` permanently unresolved | Fixed: the Cookie gate was removed from `isServiceWorkerRegistration()`, and the hop page now uses a 10-second activation timeout (`VAULT_SW_ACTIVATION_TIMEOUT_MS`) instead of the indefinite `.ready`. On timeout or install failure ("redundant" state), the hop shows an explicit error message with retry guidance. |
| Editing a SilverBullet note shows `Could not save page, retrying again in 10 seconds` repeatedly; saves never succeed | Older image: PUT requests went through `maybeSynthesizeCsrfHeader` which clones the request to add `X-Requested-With`, consuming the original body; the proxy then forwarded the original (now disturbed) request to `container.fetch`, raising `TypeError: This ReadableStream is disturbed` and returning 500 | Redeploy. The proxy now forwards the auth-validated clone (which owns the body) instead of the original; pre-fix images log `Vault request error` with the disturbed-stream stack trace in Worker logs (`wrangler tail` or Cloudflare Observability). |
| Browser shows encryption enabled, then encrypted IDB open aborts | Key-rotation desync between config and SW key message | Hard-reload; if rotating, unregister the SW, drop the bootstrap cookie, and reload. |
| Vault shows `.auth` 403 on cold boot or idle reopen | Native SB worker lost its in-memory encryption key | Redeploy; pre-graft images can clear the bootstrap cookie and reload. |
| Second session opens empty or terminal loses focus | Older SW full-sync wiped local store during server warmup | Redeploy; the not-ready guard defers empty remote lists. |
| Second start never turns green and `Index.conflicted` files appear | Older image force-overwrote `Index.md` while the editor normalized it | Redeploy; `Index.md` is now create-if-missing. |
| Mobile vault button differs from desktop after return | Older settle-on-return state diverged across mobile reloads | Redeploy; green ready state now persists without localStorage settle. |
| Desktop: the FIRST vault open lands on `/.auth` "Authentication not enabled"; closing and reopening the tab works | Older image: opening the bare shell after prewarm raced the service worker's single-shot key recovery (`__cfRecover`) — the key had been flushed after prewarm, and SilverBullet's top-level navigation read it before recovery completed, bouncing to `/.auth`. | Redeploy. `openVaultTab` now opens via the bootstrap-hop `/api/vault/<sid>/.codeflare-bootstrap` ([REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC6), which re-arms the SW key and waits for SW activation before redirecting to the editor, so the first open no longer races recovery. |
| Opening an already-warm vault shows an empty/partial editor until you manually reload once or twice | The tab loaded before the vault-scoped service worker controlled it (`navigator.serviceWorker.controller` null on first paint), so SilverBullet booted without the SW-backed local space. | Fixed: the one-time controlled reload ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC4) reloads the top-level tab exactly once (`sessionStorage` one-shot, never loops) when a vault SW is active but not yet controlling; the editor then boots against the local space. |
| Capture not firing | Counter file present at `/tmp/.memory-counter/{session_id}` and transcript has `<15` new prompts since last capture | Send more prompts to reach the 15-message threshold; or verify the hook is registered (`cat ~/.claude/settings.json`) |
| Capture not firing after a resume | Counter file present despite the container appearing to be a fresh start (would indicate `/tmp` somehow survived recycle, which Cloudflare's ephemerality contract forbids) | Inspect `ls -la /tmp/.memory-counter/`; if the counter mtime predates the current container's start time, file an issue - the platform contract is being violated. Workaround: `rm /tmp/.memory-counter/{session_id}` |
| Pi capture launches but no vault file appears | Background task failed, timed out, or returned success without the deterministic note | Inspect the visible native task result. The root leaves the counter and request snapshot unchanged, emits the next bounded reminder, and eventually latches GIVEUP rather than skipping the window. |
| Capture transcript shows `ISO_TS_ASSERTION_FAILED` | Timestamp assertion rejected the capture ([REQ-MEM-010](../../sdd/spec/memory.md#req-mem-010-memory-capture-hook-plumbing) AC5) | Read the transcript failure; next 15-prompt window retries. |
| Same file appears in overlapping extraction requests | A change arrived before/while a public Pi launch was being recorded | Prelaunch edits coalesce; launched snapshots stay frozen and during-run edits become one follow-up. Graph writes serialize on `/tmp/graphify-global.lock`, with Pi holding one required lock across merge and global publication. |
| A one-file Pi extraction runs for minutes or consumes review-scale tokens | The live agent predates AD103 or inherited broad tools/reasoning and reread skills/input | Verify generated agent frontmatter has `tools: bash` and `thinking: medium`, the public request carries `max_turns: 4`, then remirror and `/reload`. A current worker reads each frozen input once; visualization cannot exceed 15 seconds. |

Vault readiness requires all proofs before click-through: the button stays visible but `aria-disabled`; `probeVaultReady()` must see `{ vaultReady: true }`; `startVaultPrewarm()` and the `codeflare-vault-prewarm` iframe must receive the same-origin ready message; local `sb_data_*`/`sb_files_*` and service-worker proof must exist; `space-sync-complete` must fire; the current object-index queue must be empty; and `/.fs/` must list `CONFIG.md`, `Index.md`, and `STYLES.md`. If it opens early, recheck those paths.

For encryption desync, `injectVaultEncryptionConfig` may rewrite `/.config` with a fresh `vaultEncryptionKey` while the bootstrap-hop key message is stale. Causes include an old tab kept across rotation, or a partial deploy that rewrote config without restarting the SW. Reload end-to-end (`Cmd-Shift-R` / `Ctrl-Shift-R`); if rotation is in progress, force-unregister from DevTools, drop the bootstrap cookie, and reload. The native SilverBullet worker holds the posted key in module memory and carries the Codeflare recovery graft, so tearing it down and re-running the bootstrap hop is safe.

For `.auth` 403s, the failure window is between bootstrap-hop posting the key and shell booting, or after genuine worker termination clears module memory. AD69 grafts key recovery into the served worker: `get-encryption-key` re-fetches from auth-gated `GET /.vault-key` when the in-memory key is empty, then replies. Pre-graft images can clear the bootstrap cookie in DevTools and reload so the hop re-posts the key.

For empty second sessions, older images reconciled full sync while the in-container SilverBullet server was still warming. The console showed `[sync] File deleted on secondary, deleting from primary` right after `Performing a full sync cycle...`; empty/non-array `fetchFileList()` made every local file look deleted. The editor then churned re-syncing and never handed focus back. The not-ready guard now aborts that sync cycle until the real list is served, so the second session no longer wipes the vault.

For `Index.conflicted` files, the old boot-time force overwrite fought the editor's normalized autosave into a changed-on-both-ends PRIMARY-side client-save conflict. That kept the prewarm index queue from ever draining, so readiness never settled. `Index.md` is now seeded only if missing, so the queue drains normally; deterministic mtimes still cover force-overwritten config pages.

For mobile return behavior, the old settle-on-return icon state was persisted in `localStorage` as a neutral post-open state; mobile standalone reloads made it diverge between platforms, over-corrected the control, and re-fired the tooltip on every remount. The control now remains green once armed, and the tooltip fires only on the real `preparing` -> `armed` transition.

`ISO_TS_ASSERTION_FAILED` reasons are: `missing TZ offset`, `offset X does not match TZ=Y`, or `drifts Ns from current clock`. Fail-closed is intentional: capture halts rather than writing a wrong timestamp to the vault.

For hook registration, attribution-blocking, review-spawn enforcement,
or session-mode gating issues, see [Troubleshooting in preseed.md](preseed.md#troubleshooting).

<a id="specification-coverage"></a>
## Requirement and Source Map

Exhaustive Vault status remains in `sdd/spec/vault.md`; section-local links provide clause detail.

| Vault concern | Requirements | Source owner | Evidence |
|---|---|---|---|
| Path/bootstrap/persistence | REQ-VAULT-001/006/007/010 | entrypoint, seed, storage finalization | Initialization tiers and final-drain tests |
| Capture/edit/extraction | REQ-VAULT-002/003/026/027/028 | capture hooks and `vault-extract` | Content-hash, transactional publication, isolation tests |
| Graph merge/publication | REQ-VAULT-004/014/016 | Vault plugin and Graphify scripts | Active-repo lock and canonical schema checks |
| SilverBullet proxy/runtime | REQ-VAULT-005/009/012/013/017/018/019/020/025 | Vault routes/view graft and UI | Proxy, upload, prewarm, service-worker tests |
| Encryption and IDB | REQ-VAULT-008/015/021/022/023/024 | Vault crypto/view/bootstrap | Key/open/store lifecycle tests |
| Attachments/PDF | REQ-VAULT-011 | extraction runtime | Capability-dependent ingestion evidence |

---

## Related Documentation

- [architecture.md](./architecture.md) -- Container layout, Worker proxy boundary.
- [deployment.md](./deployment.md) -- How Dockerfile + preseed land in a new session.
- [`sdd/spec/vault.md`](../../sdd/spec/vault.md) -- Spec / acceptance criteria.
