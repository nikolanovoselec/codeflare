<a id="vault"></a>
# Vault & Memory

Persistent user notes, advanced-mode conversation memory, cumulative graph publication, and the SilverBullet editor. Conversation lifecycle remains specified in [Memory](../../sdd/spec/memory.md); path ownership, user-edit extraction, graph lifecycle, and editor behavior remain specified in [Vault](../../sdd/spec/vault.md).

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
  - [First-prompt and post-compaction retrieval](#first-prompt-and-post-compaction-retrieval)
- [Failure Diagnosis and Recovery](#failure-diagnosis-and-recovery)
- [Requirement and Source Map](#requirement-and-source-map)
- [Related Documentation](#related-documentation)

---

## Data Model and Boundaries

<a id="overview-req-vault-001"></a>
### Overview (REQ-VAULT-001)

The vault lives at `/home/user/Vault/` inside every advanced-mode session container. It is rclone-bisynced to R2 alongside the rest of `/home/user/`, so anything written here is available on the next session you start.

Three owners write to the vault:

- The **capture agent** appends a markdown file to `Raw/Sessions/` every 20 real user prompts and captures any durable uncaptured tail on the first prompt after resume.
- The **image-owned compactor** folds cold capture files into deterministic `Raw/Sessions/Archive.md`; it is not an agent ([REQ-MEM-023](../../sdd/spec/memory.md#req-mem-023-cold-session-captures-compact-without-losing-memory)). <!-- @impl: scripts/compact-session-captures.mjs::buildSessionArchive -->
- **The user** edits notes via SilverBullet or any tool that writes under `Notes/`, `References/`, `Inbox/`, or `Journal/`. Attachments land next to the referencing note; `Raw/Pasted/` remains an optional hand-organised archive.

Vault content hashes are checked on resumed-tail capture and at each crossed 20-real-user-prompt epoch. Changed content signals one bounded background extraction; unchanged content is a no-op, and no polling extraction daemon runs. The global contribution contains cumulative Vault knowledge plus at most one repository: the active checkout when that checkout has a graph. Runtime-native Graphify tools select their documented query scope; current source outranks stale graph evidence.

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
|   |   |-- Sessions/      <- AGENT-OWNED: one .md per 20-prompt or resumed-tail capture
|   |   |-- Pasted/        <- USER-OWNED: image/PDF drops from SilverBullet
|   |   `-- Graphs/        <- USER-EDITABLE: Vault Graph.md (seeded once, never overwritten); links to vault-graph.html (bounded best-effort render)
|   |-- Notes/             <- USER-OWNED: durable notes saved by note-capture flows
|   |-- References/        <- USER-OWNED: reference material and source notes
|   |-- Inbox/             <- USER-OWNED: SB "Quick Note" target
|   |-- Journal/           <- USER-OWNED: SB "Journal: Today" target
|   |-- graphify-out/      <- MACHINE-OWNED: cumulative graph + committed manifest; other output is derived
|   |-- Library/
|   |   `-- Codeflare/     <- CODEFLARE-MANAGED: preseeded SilverBullet plugs
|   `-- .silverbullet/     <- EDITOR CONFIG: SilverBullet config + plug cache
|-- Uploads/           <- persistent drop zone for files (always bisynced)
`-- Temporary/         <- persistent scratch space (always bisynced)
```

`Raw/`, `Notes/`, `References/`, and `graphify-out/` are where content lives. `Notes/` and `References/` are the user-facing priority areas promoted on the SilverBullet dashboard; `graphify-out/` is updated by the vault-extract agent after an eligible resumed-session or crossed 20-prompt hash check finds changed content. `.silverbullet/` is owned by the editor. `Library/Codeflare/` holds the plug files managed by Codeflare (pdf, treeview, github, graph) -- see [Preseed Integration](#preseed-integration-req-vault-007).

Two classes of path are hidden from the SilverBullet client listing/sync ([REQ-VAULT-015](../../sdd/spec/vault.md#req-vault-015-vault-idb-lifecycle-and-listing-filters) AC1). Generated `Raw/Graphs/*.html` visualisations stay fetchable by direct link but are removed from the listing so the object index does not try to treat multi-MB HTML graph artifacts as documents. Machine-owned session-capture memory under `Raw/Sessions/` (written by the capture pipeline every 20 real user prompts and on resumed tails) is likewise hidden so IndexedDB does not churn on logs the user never opens, and client mutations to those hidden paths are rejected so a transitioning client cannot delete the on-disk memory.

**Codeflare-authoritative vs user-editable.** Three root pages (`README.md`, `CONFIG.md`, `STYLES.md`) are codeflare-authoritative: `init_user_vault()` overwrites them on every boot from `/opt/silverbullet-preseed/`, gated so identical files are not rewritten. Hand-editing them inside SilverBullet is futile - changes are silently reverted on the next session start.

`Index.md` also ships from preseed but is seeded create-if-missing, not force-overwritten: the SilverBullet editor normalizes and autosaves the dashboard on open, so a boot-time revert fought the client save into a perpetual `Index.conflicted:*.md` sync conflict (see [Vault initialization tiers](#vault-initialization-tiers-req-vault-001-ac3--req-vault-010-ac1ac4ac5)); once seeded it is editor-owned. User content lives in `Notes/`, `References/`, `Inbox/`, `Journal/`, and `Raw/Pasted/`, which boot-time initialization never overwrites. `Raw/Sessions/` is machine-owned conversation memory: capture workers create individual notes and only the image-owned compactor may archive unchanged cold captures. SilverBullet hides that subtree and rejects client mutations to it.

**Hidden-root constraint (see [AD54](../decisions/README.md#ad54-vault-directory-must-use-a-non-hidden-basename)):** The vault directory must use a non-hidden basename. SilverBullet's disk walker (`server/disk_space_primitives.go` `FetchFileList`) aborts the directory walk when the root basename begins with `.`, returning an empty file listing even when notes are present on disk. This is why the path is `/home/user/Vault/`, not `/home/user/.user_vault/`.

## Capture and Edit Flows

<a id="capture-path-req-vault-002"></a>
### Capture Path (REQ-VAULT-002)

On Claude, the `memory-capture.sh` UserPromptSubmit hook fires every 20 real user messages and immediately on the first prompt with an uncaptured resumed-session tail. It writes a `.vars` carrier naming only the uncaptured window and capture file, then launches `run-memory-capture.sh` detached. The main session spends nothing: it does not dispatch a subagent, wait, or read the result. The runner prefilters the transcript slice, builds one self-contained request, and runs the capture as a headless `claude -p` bounded to six turns, with fidelity selected by `CODEFLARE_MEMORY_MODEL` (default `sonnet`) per [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) and [AD124](../decisions/README.md#ad124-bounded-re-delivery-replaces-the-memory-capture-hard-block). That capture runs `memory-agent-prompt.md` end to end:

1. Receives the marker-framed transcript inline in `CAPTURE_REQUEST`; no carrier, transcript path, or chunk directory must be opened. This avoids truncated persistent tool results and repeated input paging.
2. Processes that inline transcript once.
3. Identifies decisions, observations, references, and a short topic phrase.
4. Writes `/home/user/Vault/Raw/Sessions/{ISO_TS}-{SID_SHORT}.md` using the YAML-frontmatter template (session id, captured-at, captured-from-range, then Context / Decisions / Observations / References sections).
5. Invokes the deterministic memory-graph builder for that note. The runner's locked publisher merges the cumulative graph and publishes `user_vault`; capture coordinates advance and `.vars` retry state is removed only after artifact verification and required publication succeed.

The deterministic capture graph uses the shared Graphify schema. Concepts expressed as `[[wikilinks]]` receive canonical identities, while file paths, code symbols, and PR references remain prose. Graphify's external-label dedup unifies concept labels across the cumulative Vault contribution and the active repository. `publish-memory-capture.sh` requires the modern request's capture artifact, performs cumulative merge and `graphify global add ... --as user_vault` under one lock, and refuses to advance counters or remove the carrier when required publication fails. No separate LLM provider key or headless semantic-extraction CLI is needed; note synthesis is the inference step.

On Pi, the worker writes the session note and the deterministic graph builder derives its graph identity afterward. The document label comes from the note H1, its ID comes from the Vault-relative path, repeated concept labels share one canonical ID, and exact duplicate evidence edges collapse before cumulative merge ([REQ-MEM-017](../../sdd/spec/memory.md#req-mem-017-session-memory-graph-identity-is-deterministic)). <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph -->

#### Daily session capture compaction (REQ-MEM-023, REQ-VAULT-032)

After a successful natural bisync cycle, the image-owned compactor is eligible once per UTC day and approximates the latest-month hot set from each capture filename's leading calendar date. A failed attempt remains unstamped and retries after a later successful natural cycle. It leaves files on or after the same UTC calendar date in the prior month and any unrecognized filename as individual hot files, then renders older captures in stable capture-date/name order into `Raw/Sessions/Archive.md`. Repeating the same inputs produces the same archive without duplicate source records. <!-- @impl: entrypoint.sh::run_daily_vault_session_compaction --> <!-- @impl: scripts/compact-session-captures.mjs::selectColdCaptures --> <!-- @impl: scripts/compact-session-captures.mjs::buildSessionArchive -->

The archive is machine-owned and read-only to agents. Retrieval searches current individual files first and uses `Archive.md` only as fallback; capture workers never target it, and interactive agents never edit it or delete source captures. The compactor changes storage shape, not meaning: semantic summarization, relevance pruning, and graph evidence deletion remain out of scope.

Before exact unchanged source files are deleted locally, the shared merge helpers move matching node and edge `source_file` provenance to `Raw/Sessions/Archive.md` without changing node IDs, edge endpoints, relations, or evidence; archive locations keep evidence from different captures distinct. They publish the updated cumulative `vault-graph.json` as `user_vault`, then one bisync publishes the complete local result. <!-- @impl: entrypoint.sh::run_daily_vault_session_compaction --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::relocate_node_link_provenance --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::relocate_node_link_provenance -->

Linking convention enforced in the prompt: concepts go in `[[wikilinks]]` so graphify's external-label dedup unifies them across the vault and per-repo code graphs. File paths, code symbols, and PR references stay as prose -- they namespace per-project and would never auto-link meaningfully.

### User-edit Path (REQ-VAULT-003)

Implements [REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) (monotonic vault graph accumulation across extractions).

Vault extraction is prompt-cadenced rather than polled. Every resumed-tail capture performs a hash check, and regular checks occur at each crossed 20-real-user-prompt epoch. Change detection remains a **content-hash manifest**, not a file mtime ([AD94](../decisions/README.md#ad94-content-hash-manifest-for-vault-extract-change-detection-mtime-is-reset-by-the-r2-restore)): the boot R2 restore rewrites every vault file's mtime to download-time, so mtime detection would re-extract unchanged content. The state:

| File | Written by | Used by |
|---|---|---|
| `graphify-out/vault-extract-manifest.json` | Claude vault-extract agent or Pi root finalizer, ONLY on exact success | Durable `{path→sha256}` high-water mark (R2-synced, survives restart) |
| `vault-extract.last` | Claude agent or Pi root finalizer, ONLY on success | Ephemeral dedup timestamp (NOT detection) |
| `vault-extract.vars` | Claude memory hook, when an eligible hash check finds changes | Trigger for `vault-monitor-hook.sh` |

If extraction fails mid-flight on the Claude path, the manifest is not committed; bounded delivery or a later eligible prompt-cadenced hash check rediscovers the same files. Pi preserves the same success-only high-water invariant through staged root-owned promotion (see Pi transactional delivery below). `vault-monitor-hook.sh` retains its stale-marker and in-flight guards so an interrupted or overlapping prompt cannot dispatch duplicate work.

The in-flight sentinel's TTL is 30 minutes. While a fresh sentinel exists, another prompt does not dispatch overlapping work. A genuinely interrupted run becomes retryable at a later eligible prompt-cadenced check after the bound; failed work never advances committed high-water state.

The exclusion set — `Raw/Sessions/` (individual captures and machine-owned `Archive.md`), `Raw/Graphs/`, `graphify-out/`, `Library/Codeflare/`, `.silverbullet/` — lives in `vault-manifest.py` (a parallel Python copy of `VAULT_GENERATED_PREFIXES` + `VAULT_PRESEED_ROOT_FILES`, code-commented "MUST stay identical to memory-vault-helpers.ts") and Pi's `vault-manifest-fs.ts` (which imports the predicate from `memory-vault-helpers.ts` directly) — kept in parity by convention on the Python side, by direct import on the TypeScript side.

A mismatch re-triggers a spurious extraction cycle on the extractor's own output (observed live 2026-07-02 for `Raw/Graphs/vault-graph.html`). It also excludes the three always-managed root pages (`CONFIG.md`, `README.md`, `STYLES.md`) and the create-if-missing dashboard `Index.md`. `init_user_vault()` overwrites only the managed three; `Index.md` becomes editor-owned after first seed. The by-name exclusion keeps these product-supplied roots from counting as user-edit extraction input ([REQ-VAULT-010](../../sdd/spec/vault.md#req-vault-010-codeflare-authoritative-files-preseeded-into-the-vault-on-every-boot) AC1).

On the first durable initialization of a newly created vault, `init_user_vault()` baselines the manifest from current content, then writes `graphify-out/vault-extract-initialized`; the first prompt-cadenced check therefore finds nothing. An existing or restored vault without that marker is a migration, not a first initialization: init writes the marker but never baselines current content. If its manifest is absent, or later goes missing after initialization, all eligible files remain full-delta candidates. On ordinary later boots the manifest is restored from R2 and never re-baselined, so prior-session unextracted edits are still detected.

`vault-monitor-hook.sh` is the UserPromptSubmit hook for the user-edit path. It exits 0 immediately when `vault-extract.vars` is absent (~99% of prompts), keeping token cost at zero on idle. When the marker is present it emits `additionalContext` instructing the main agent to dispatch the **vault-extract** named subagent (Task tool with `subagent_type="vault-extract"`). The subagent's frontmatter (`preseed/agents/claude/agents/vault-extract.md`) pins `model: sonnet` per [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad); the hook directive instructs the main agent not to pass a model override.

The vault-extract agent's contract ([REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions)):

1. Delete `vault-extract.vars` (dedup gate).
2. Run `vault-manifest.py changed` — files whose sha256 differs from the manifest, excluding the agent-owned subtrees.
3. Acts as the LLM extractor for each changed file: reads the file, produces a chunk JSON (nodes / edges / hyperedges matching graphify's schema; `[[wikilinks]]` become concept nodes with `source_file: null` for cross-repo dedup).
4. Loads the persistent vault graph at `/home/user/Vault/graphify-out/vault-graph.json` and writes the updated cumulative graph back to `vault-graph.json`.
5. Run `flock -w 5 /run/codeflare/locks/graphify-global.lock graphify global add ... --as user_vault`.
6. Re-render the vault viz HTML into `Raw/Graphs/vault-graph.html` so the `Vault Graph.md` index page link resolves.

Step 4 starts from empty evidence when `vault-graph.json` is absent or unreadable. Malformed edge entries are ignored; valid edges are deduplicated by semantic evidence tuple before the cumulative graph is published. The global graph's `user_vault` tag therefore reflects cumulative vault content, not only the most recent extraction. <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::main --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::node_link_edges --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::dedupe_node_link_edges --> The published `user_vault` entry is cumulative; publishing only the newest extraction chunk would discard knowledge from prior passes and violate [REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions).

Step 6 runs `graphify cluster-only .` with cwd `/home/user/Vault` against the per-run `graph.json`, then copies `graph.html` to `Raw/Graphs/vault-graph.html`. Failure here does not set `EXTRACT_FAILED` because graph data is already persisted by steps 4-5. The only loss is a stale viz HTML, and the next successful extraction re-renders it.
7. Commit the content-hash manifest (advance the high-water mark) and refresh `vault-extract.last` -- FINAL step only.

**Pi transactional delivery ([REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)).** Pi implements change detection in `memory-vault.ts`, but it no longer privately spawns an agent or advances the manifest before extraction. The root writes the complete staged manifest and request-specific execution snapshot before atomically publishing a tiny active request-ID pointer. It emits one visible public background request with medium reasoning and seven turns. The detecting root session owns delivery, and another simultaneous root cannot launch the same container-global request. An unlaunched foreign claim becomes replaceable after the existing 30-minute running bound. The owner reconstructs attempts/results from root-session JSONL, sends the initial directive plus at most five reminders, and then reports GIVEUP. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::stageVaultRequest --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages -->

The next root turn clears an exhausted request without immediate replacement. Its unchanged manifest leaves the files eligible at the next resumed-session or 20-prompt hash check ([REQ-VAULT-031](../../sdd/spec/vault.md#req-vault-031-vault-hash-checks-follow-successful-prompt-cadence), [AD148](../decisions/README.md#ad148-memory-and-vault-capture-follow-successful-prompt-cadence)). <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::refreshPendingVaultRequest -->

Before the first exact public tool call, later edits coalesce under the same request ID. After launch, the execution snapshot and staged bytes remain frozen; edits made during extraction remain outside the promoted manifest and are discovered by the next eligible hash check ([REQ-VAULT-028](../../sdd/spec/vault.md#req-vault-028-vault-edits-remain-isolated-after-extraction-starts)). <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::refreshPendingVaultRequest -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess -->

A task does not qualify as exact success until its canonical request chunk exists after locked cumulative merge and global publication. Failed, timed-out, or incomplete work leaves the committed manifest byte-identical; successful promotion also requires the staged SHA to match. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess -->

A crash after rename but before cleanup is accepted idempotently from matching committed bytes. Missing or corrupt staged data creates a full-delta follow-up, while an older task result cannot promote or clear replacement work. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeVaultSuccess --> <!-- @impl: preseed/agents/pi/extensions/vault-manifest-fs.ts::promoteVaultManifest -->

The Pi subagent authors a request-specific canonical chunk, then holds one 300-second flock across `merge-vault-graph.py` and cumulative `graphify global add`. Required failure propagates to native task status; only visualization remains best effort. The root owns the execution snapshot, active pointer, committed/staged manifests, and marker throughout.

**PDFs are the exception:** the Pi Read tool cannot render PDF pages as images, so a PDF on the Pi path yields only a bare document node. The heading/title/entity extraction the Claude runtime performs (see [Attachment Cost Caveat](#attachment-cost-caveat-req-vault-011-ac1)) is Claude-only, and scanned/image-only PDFs are inherently out of reach on Pi. For markdown and plain-text files (`.md`/`.txt`/`.json`/`.yaml`/`.yml`), the text/structural output matches the Claude path. The canonical-schema and viz-publish contract these steps satisfy is [REQ-VAULT-016](../../sdd/spec/vault.md#req-vault-016-vault-graph-extraction-emits-the-canonical-shared-schema).

<a id="unified-global-graph-req-vault-004"></a>
## Graph Publication and Merge (REQ-VAULT-004)

`~/.graphify/global-graph.json` is the ephemeral hash-keyed merge of the cumulative Vault contribution and at most one active repository graph. `user_vault` is never removed by repository reconciliation. The Graphify MCP wrapper prefers the merged graph when present; Pi's native query tools resolve the cwd repository first, then the active-repository sentinel, then the global graph. A tool result's reported graph path and scope determine which evidence it contains.

Write sites that touch the global graph:

- `init_user_vault()` at boot, republishing the vault under `user_vault` from the cumulative `graphify-out/vault-graph.json`, never the derived `graph.json` beside it ([REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) AC5).
- The capture agent, after writing a vault file ([REQ-VAULT-002](../../sdd/spec/vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown)).
- The vault-extract agent, after user-edit extraction ([REQ-VAULT-003](../../sdd/spec/vault.md#req-vault-003-user-curated-edits-use-bounded-prompt-cadenced-ingestion)).
- `graphify-active-repo.sh` (Claude) and `codeflare-pi.ts::reconcileGlobalGraph` (Pi), whenever reconciliation finds the manifest's repo entries out of step with the active checkout (single-active-repo invariant; see below).
- The `/graphify` skill, on commit, after building a repo's graph.

A first boot has no cumulative graph yet, because no capture has run, so the boot step publishes nothing and reports no failure ([REQ-MEM-009](../../sdd/spec/memory.md#req-mem-009-vault-graph-accumulates-monotonically-across-extractions) AC6).

All five serialize on `/run/codeflare/locks/graphify-global.lock`. Claude, boot init, and active-repo maintenance retain the short five-second lock bound. Each Pi extraction uses one required 300-second critical section spanning both cumulative merge and global publication, then exposes its post-commit request chunk; a timeout or missing chunk leaves root-owned high-water state unchanged. <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence --> Pi visualization is separately capped at 15 seconds. <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::at most 15 seconds -->

### Single-active-repo invariant

`graphify-active-repo.sh` enforces a single-active-repo invariant for the per-repo side of the global graph: the manifest holds the vault entry plus the active checkout's entry when that checkout has a graph, and nothing else. Two sentinels back it. `~/.cache/codeflare-hooks/graphify-active-cwd` holds the active repo path, and its first line is a contract the MCP wrapper reads. `~/.cache/codeflare-hooks/graphify-active-state` holds a tab-separated `<branch>\t<graph|nograph>` snapshot of what the checkout looked like at the last reconciliation.

1. **Repo resolution ([REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC3)**: walk up from the candidate directory to the nearest checkout, identified by `.git` as a directory or as the file a worktree uses. Nothing else counts as a repo root.
2. **Vault skip ([REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC3)**: when the walk-up resolves to `$HOME/Vault`, the hook exits 0 without writing either sentinel or invoking graphify.
3. **Fast-path skip ([REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC4)**: when the repo path, the branch, the graph's presence, and the graph's mtime all match what the sentinels recorded, the hook returns immediately.
4. **Reconcile ([REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation) AC1/AC5)**: read the manifest's repo tags, remove every one that is neither `user_vault` nor the active checkout's tag, and add the active checkout's graph when its recorded `source_hash` differs or the tag is new.
5. **Sentinel advance ([REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation) AC1)**: both sentinels are rewritten and the path sentinel `touch`-bumped only after the whole reconciliation succeeded, so a failure leaves the prior state in place and the next tool call retries.

Step 4's removals and addition run inside one `flock -w 5 /run/codeflare/locks/graphify-global.lock` critical section, so a lock timeout or either graphify failure aborts the whole step. The fast path avoids spawning the graphify CLI, including hundreds of MB of Python imports, on every Bash/Edit/Write/ctx_execute tool call. Branch and graph presence sit in the comparison because mtime cannot see either: a checkout does not touch `graphify-out/`, and a deleted graph moves its mtime backwards to zero, which reads as "not rebuilt" and would leave a dead tag published indefinitely. This behavior implements [REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation).

In a worktree the branch is read through the `gitdir:` pointer in `.git`, since HEAD does not live under the checkout ([REQ-VAULT-004](../../sdd/spec/vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos) AC7).

The removal set is enumerated from the manifest rather than derived from the previous sentinel value. That is what lets the hook collect entries no transition diff can name: a tag a crashed run left behind, or a phantom tag minted back when a bare `graphify-out/` directory still resolved as a repo root. Drift self-heals on the next tool call. `user_vault` is excluded by name, since the vault is registered exclusively by entrypoint init and by the capture and extract pipelines, never as a repo.

The vault skip canonicalizes `$HOME` via `cd && pwd` to match `REPO` resolution and also matches basename `Vault`, guarding against symlink paths into the vault from outside `$HOME` and against a `git init` inside the vault.

Same-basename repo transitions issue no removal, because the active tag is excluded from the removal set and the add replaces the existing entry via graphify's `source_hash` dedup. The add pre-check truncates `sha256sum` to graphify's 16-hex format and skips publication only when the manifest records both that hash and a `source_path` equal to this checkout's graph.

The path half is load-bearing rather than belt-and-braces: tags are keyed by directory basename, so two checkouts sharing a basename can hold byte-identical graphs (a freshly scaffolded `graph.json` is the common case), and a hash-only skip would leave the tag resolving to the checkout the user just left. A recorded hash that is not 16 lowercase hex characters refuses the optimisation instead of silently degrading to "always skip".

Pi holds the same invariant through `codeflare-pi.ts::reconcileGlobalGraph`, called on `session_start` and after every repository transition. `planGlobalGraphReconcile` reads the same manifest and computes the same removal set, every tag but `user_vault` and the active checkout's, plus the add when that checkout has a graph; both run inside one `flock -w 5 /run/codeflare/locks/graphify-global.lock` invocation so a concurrent writer never sees a partial reconciliation ([REQ-VAULT-014](../../sdd/spec/vault.md#req-vault-014-graphify-active-repo-invariant-and-lock-serialisation) AC6). It applies the hook's dedup on the same terms, matching the recorded hash and the recorded `source_path` before skipping, so an unchanged graph costs no `global add` while another checkout's identically-hashed graph still forces one.

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

The first click enters the bootstrap hop. For the v3 clean cutover, that page enumerates same-origin service-worker registrations, unregisters every older same-origin worker whose scope path starts with `/api/vault/`, except the exact new canonical scope, re-enumerates to verify none remains, and only then registers the native worker at the canonical scope. Unrelated workers are untouched. Historical IndexedDB databases are not migrated or deleted; the new scope derives fresh current stores and R2 remains authoritative ([REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC1-AC3, AC7).

The button remains guarded until the mounted same-origin/current-attempt iframe bridge emits a content proof whose scope exactly matches that iframe document's canonical base: SilverBullet runtime ready, completed space sync, current object index with an empty queue, and a local `/.fs/` listing containing `CONFIG.md`, `Index.md`, and `STYLES.md`. The bridge holds this proof across `requiredReadyStreak` (2) consecutive polls before arming, and a single not-ready poll resets the streak. It does not use session-specific metadata embedded in the shell because SilverBullet precaches that shell and can serve it in later sessions ([REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC5-AC6).

Sync completion is accepted only from the currently controlling canonical worker. Other workers' broadcasts and SilverBullet's unscoped `fullSyncCompleted` flag cannot certify readiness. A controller change clears sync evidence and the two-poll streak; asynchronous proof reads begun under the previous controller cannot arm the control. See [`VAULT_PREWARM_BRIDGE_SOURCE`](../../src/lib/vault-browser-scripts.ts) and [REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC6.

Timeout/error states stay guarded and never retry in the background. The next user click starts the next bounded attempt. Every fresh dashboard load begins white/available and mounts no prewarm iframe automatically, even when the canonical worker and databases already exist. This preserves explicit user control and prevents a stale browser marker from bypassing full current content proof ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC2-AC3).

The button surfaces the flow as a breathing affordance (`VaultButton.tsx`, the same breathing the "Return to Dashboard" icon uses). Server-ready is `available`: white, clickable, no breathing. The first click breathes the codeflare accent while preparation runs. When the proof and key-recoverability check complete, the icon breathes green and shows a five-second ready tooltip; the second click opens instantly. `prefers-reduced-motion` keeps the state colours without animation.

Once ready in the current dashboard lifetime (`pw === 'ready'`), the button stays green across dashboard departure/return while the session remains running, and subsequent clicks open directly with no re-verification. A page reload deliberately resets it to white/available and requires the explicit first-click prepare again; SilverBullet can still reuse the permanent v3 scope and current local stores internally.

The open itself (`openVaultTab`) targets the bootstrap-hop `/api/vault/<sid>/.codeflare-bootstrap`, never the bare shell. The hop waits for the canonical worker's activation, exact control and native key-import acknowledgement before redirecting, rather than relying on `__cfRecover` to finish during editor boot ([REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC1-AC2).

After the open click, `openVaultTab` clears the per-session open-intent so the control falls back to that same steady green 'ready' state, still clickable to reopen, rather than any transient armed-intent. `prefers-reduced-motion` keeps the state colours without the breathing animation ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC3).

On the real top-level open, never the headless prewarm iframe, `rewriteVaultHtmlResponse` injects the authored one-time controlled-reload browser source through `injectVaultControlledReload` only when the request carries no prewarm id. A present valid prewarm ID positively identifies the hidden preparation path and remains inert; absence identifies the real top-level open. When an already-warmed vault is opened before its vault-scoped service worker controls the page (`navigator.serviceWorker.controller` null on first paint), SilverBullet would otherwise boot without the SW-backed local space and render an empty/partial editor until a manual reload (the old "reload one or two times to see your files").

The safety net reloads the page exactly once, gated by a `sessionStorage` one-shot (`cf-vault-sw-controlled-reload`) so it can never loop. It is inert in the prewarm iframe, on a genuine first boot with no vault SW yet, for a non-vault service-worker scope, and without service-worker support. It clears the one-shot once the worker already controls the page so a later in-tab navigation can self-heal again ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC4).

Codeflare also calls `navigator.storage.persisted()` / `persist()` / `estimate()` before prewarm as a best-effort mobile-hardening step. This reduces eviction risk on browsers that grant persistent storage, but it is not part of readiness and denial is not fatal. If a mobile browser clears origin storage under pressure, the next explicit prepare rebuilds the current browser cache from R2.

The landing page on every Vault button click is `Index.md` (the Codeflare dashboard), set by exporting `SB_INDEX_PAGE=Index` in the supervisor before launching the binary ([REQ-VAULT-012](../../sdd/spec/vault.md#req-vault-012-vault-button-render-and-dashboard-landing) AC3). The SilverBullet Go server hardcodes the default to lowercase `"index"` (`server/cmd/server.go` in SilverBullet's source) and ignores any `indexPage` key in `.silverbullet/config.yaml` -- the env var is the only override. The dashboard leads with `Notes/` and `References/` because those are the durable user-curated areas used by note-capture and reference workflows; broader recent-content widgets remain below. The README is one click away via a link at the top of the dashboard.

### Per-session `<base href>` rewrite (REQ-VAULT-013 AC1)

SilverBullet 2.x emits `<base href="/" />` in its index HTML, so under the `/api/vault/<token>/` subpath proxy every relative asset reference (e.g. `.client/client.js`) would otherwise resolve against the Worker root and 404 -- producing a white screen.

`handleVaultRequest` in `src/routes/vault/index.ts` is the proxy adapter. On every response with Content-Type `text/html`, it rewrites `<base href="/" />` to `<base href="/api/vault/<token>/" />`, where `<token>` is the bucket-stable token for this user. The token is identical on every request for a given user, which keeps the SilverBullet IndexedDB names and service-worker scope stable across sessions ([REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key)).

Shell rewriting injects no session-specific readiness metadata. The prewarm bridge derives the canonical scope from `document.baseURI`, so a shell served from SilverBullet's service-worker cache cannot freeze a former session id into the current readiness decision. The path rewrite is not root-gated because SilverBullet 2.x serves its SPA shell as a catch-all on every non-API URL; a deep-page reload must receive the same base-href adaptation.

Without the rewrite, every relative fetch from `client.js` resolves to the Worker root, the tab goes blank, and any in-flight PUT to `.fs/<page>.md` misses the `/api/vault/<token>` prefix entirely, silently losing the write. The text/html guard alone is sufficient because SilverBullet's API endpoints (`.fs/`, `index.json`, `.attachment/`) return non-HTML content types (text/markdown, application/json, image MIMEs) and never reach the rewriter.

When the body is rewritten, both `Content-Length` (body length changed) and `Content-Encoding` (Workers `Response.text()` auto-decompresses gzip/br upstream, so the body is now plain text) are dropped from the response headers. A `vault base-href rewrite no-op` warning is logged when the rewrite runs but matches nothing -- gated to status 200 on the shell paths (`/`, `/index.html`) so error pages and non-shell HTML do not generate false-positive warnings, so a future SilverBullet template change (single-quoted href, added attribute, etc.) still surfaces as a logged signal on the load-bearing paths.

Rewrite contract (regex, header hygiene, selectors): see `handleVaultRequest` in `src/routes/vault/index.ts`.

<a id="service-worker-registration-noop-bypass"></a>
### Native Service Worker registration

SilverBullet's client registers a Service Worker for offline caching. Browsers may omit credentials on `navigator.serviceWorker.register()` script fetches (Chrome 76+ per spec, Samsung Internet and other Chromium forks may not), so the cookie-auth chain at `/api/vault/<sid>/service_worker.js` would return 401 and registration would fail permanently.

`handleVaultRequest` short-circuits these requests and serves SilverBullet's native service worker with Codeflare's required runtime graft (`VAULT_NATIVE_SERVICE_WORKER_JS` in `src/routes/vault/native-sw.ts`) directly from the Worker. The SB 2.11.1 upstream bytes are separately retained as `VAULT_NATIVE_SW_VERBATIM` and SHA-256 drift-guarded. The selector requires three conditions: method `GET`, exact path `/service_worker.js`, and request header `Service-Worker: script` (a Fetch-spec forbidden header name - page JavaScript cannot set it via `fetch()`). Cookie presence is intentionally not checked because Samsung Internet and other Chromium forks may send cookies on SW registration fetches; serving the same native worker for both the cookied and cookieless cases is what keeps registration browser-agnostic.

Serving the native worker (not the former key-shim) is the AD69 fix for codeflare#445: the native worker carries SilverBullet's sync engine and its persistent `sb_files_*` local-sync store, so the editor indexes incrementally and keeps a resumable local copy instead of re-indexing the whole vault over HTTP on every cold load. The worker bytes are identical across sessions and contain zero user data (the bucket-stable vault encryption key is posted in via `postMessage` from the auth-gated bootstrap-hop page to the worker's native `set-encryption-key` handler, never baked into the JS source), so bypassing auth on this exact request is safe.

The native worker precaches the shell `/` plus its `/.client/*` static assets via `cache.addAll(...)` during `install`. That precache of `/` runs BEFORE the bootstrap-hop sets the `codeflare_vault_bootstrap` cookie, so the shell-path 302-to-hop would otherwise make `cache.addAll` reject atomically and hang the SW install. `handleVaultRequest` suppresses that redirect for Service-Worker-context fetches, identified by `isServiceWorkerContextFetch` (`Sec-Fetch-Mode` header present and != `navigate` - the browser only sets `navigate` on top-level document loads).

The same exact shell/client, cache-versioned, non-navigation signature skips per-asset session-activity refreshes, preventing the complete precache from becoming a same-key write burst while unrelated GETs still count as activity ([REQ-STOR-001](../../sdd/spec/storage.md#req-stor-001-dedicated-per-user-r2-bucket) AC4). Top-level navigations and clients with no `Sec-Fetch-Mode` still get the hop (fail-safe), so a real first navigation never boots without the encryption key wired.

The served worker is not the verbatim upstream bytes. `graftVaultKeyRecovery` (`src/routes/vault/native-sw.ts`) injects a `__cfRecover()` helper and calls it at the worker's two key-empty checkpoints to re-fetch the key from `/.vault-key` when its in-memory key is empty (see the encryption section below). This graft is mandatory, not optional: the upstream worker flushes its key 5s after the last client disconnects, so Codeflare's served graft neuters that proactive flush. The browser can still idle-terminate the worker at any time, which clears module memory and requires recovery.

Without recovery, the key is gone before the shell boots and SB bounces to `.auth`. The first integration deploy reproduced exactly that on cold boot, and a graft on `get-encryption-key` alone did not fix it because the actual trigger is the `config`-message auth-gate, which reads the key directly. The same graft also removes no-client info spam and demotes expected auth/sync startup retries while leaving client messages and unexpected proxy errors intact.

The verbatim upstream bytes are stored separately (`VAULT_NATIVE_SW_VERBATIM`) and SHA-256 drift-guarded. The SilverBullet shadow-pin job updates the server version, authoritative GitHub release-asset digest, and this worker atomically ([REQ-OPS-032](../../sdd/spec/operations.md#req-ops-032-silverbullet-coupled-release-automation)); graft-anchor and syntax tests fail closed when upstream minification or behavior moves. The upstream worker's `cache: "reload"` precache prevents a stale browser HTTP-cache entry from being installed into the service-worker cache and repeatedly triggering the client/server version-mismatch notification. AD69's historical `/.client/*` precache-auth observation gate is retained in the [immutable baseline](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/vault.md#service-worker-registration-noop-bypass); it does not authorize a broader current authentication exemption. [REQ-VAULT-017](../../sdd/spec/vault.md#req-vault-017-silverbullet-native-service-worker) remains the native-SW contract.

#### Not-ready sync guard ([REQ-VAULT-025](../../sdd/spec/vault.md#req-vault-025-silverbullet-native-service-worker-runtime-graft) AC2, [REQ-VAULT-023](../../sdd/spec/vault.md#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap) AC2)

`graftVaultKeyRecovery` also guards the sync engine against a not-yet-ready SilverBullet server. The sync engine treats the remote (`secondary` -- the in-container SB server) as authoritative for deletions: a file present in the persistent local `sb_files_*` store and the sync snapshot but absent from the remote `fetchFileList()` is deleted from the local store. The console line is `File deleted on secondary, deleting from primary`.

A warming server or unresolved session route can return an empty list or JSON error object instead of real metadata. Upstream rejects 5xx, authentication failures and JSON parse errors, but JSON 404/409 errors can reach the graft. Because [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key) makes the local store persistent, blindly reconciling an empty remote list could delete existing local files. Coercing an error object to `[]` could also falsely complete a fresh store's sync with no notes.

The graft wraps the remote `s=` initializer of the full-sync cycle. Non-arrays always throw, even with empty local store and snapshot. Valid empty arrays also throw before reconciliation when the local store (`a`) or snapshot (`t.files`) contains files. `syncSpace` reports the error and rethrows; `run()` warns and retries later, resuming when real metadata arrives. Only a valid empty array with empty local store and snapshot remains a safe no-op. See [`graftVaultKeyRecovery`](../../src/routes/vault/native-sw.ts).

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

SilverBullet supports client-side IDB encryption via `EncryptedKvPrimitives` (`client/data/encrypted_kv_primitives.ts`). Activation requires three independent conditions checked in `client/boot.ts`:

1. `localStorage["enableEncryption"]` is truthy - set by the bootstrap-hop page (below).
2. `bootConfig.enableClientEncryption === true` - set by the Worker's `injectVaultEncryptionConfig` (`src/routes/vault/index.ts`), which rewrites the upstream `/.config` JSON before it reaches the SB client.
3. A `CryptoKey` is held in the per-origin service worker's `encryptionKeyMemoryStore`, postMessage'd in via `{type: "set-encryption-key"}` - done by the bootstrap-hop page (below).

The `.config` rewrite also injects `bootConfig.vaultEncryptionKey`, the bucket-derived key from `getVaultEncryptionKey` described below. The key reaches the SB client through two independent channels: the bootstrap-hop's SW `postMessage` (condition 3, the runtime path SB actually uses) and the bootConfig JSON read at boot. Both must stay in sync. A key rotation that updates one channel without the other surfaces as "encryption flag set but SW has no key" and SB aborts the encrypted open.
The two injection points are distinct: `injectVaultEncryptionConfig` handles condition 2 (a JSON rewrite on the `/.config` proxy response), while the bootstrap-hop page handles conditions 1 and 3 (localStorage flag + SW key transport). Both must fire for SB to enable encryption.

With all three conditions satisfied, SB derives an AES-GCM key from the AES-CTR raw bytes via `deriveGCMKeyFromCTR` (`plug-api/lib/crypto.ts`) and wraps the `sb_data_<hash>` IDB through `EncryptedKvPrimitives`, so values are AES-GCM ciphertext at rest (random IV per write, AES-256). The Worker delivers the raw key material as AES-CTR base64; the wire/transport format is AES-CTR-shaped, the at-rest format is AES-GCM.

The Worker bridges Codeflare's auth model (no SB passphrase; a bucket-stable key derived Worker-side from the server master secret) and SB's runtime contract via a one-time bootstrap-hop page:

- `GET /api/vault/<token>/.codeflare-bootstrap` renders the auth-gated bootstrap page through `injectVaultBootstrapHopHtml` in `src/routes/vault/index.ts`.
- `GET /api/vault/<token>/.vault-key` is an auth-gated endpoint that returns `{key}` JSON via `getVaultEncryptionKey` with `Cache-Control: no-store`.
- The dashboard's pre-open recoverability check fetches the session-keyed `/api/vault/<sid>/.vault-key`, which 302-redirects here.
- The service worker is SilverBullet's native worker (`VAULT_NATIVE_SERVICE_WORKER_JS`) with the codeflare `graftVaultKeyRecovery` patch applied.

The bootstrap page first unregisters every stale same-origin Vault worker and verifies none remains, then registers SilverBullet's native worker at the exact canonical scope. During an update it awaits the installing/waiting replacement instead of arming the old active worker. Once that exact worker controls the page, the hop posts the bucket-derived AES-CTR key with a private MessagePort and awaits the native `encryption-key-set` acknowledgement. Only then does it persist `localStorage["enableEncryption"]`, set the bootstrap cookie and redirect. See [`injectVaultBootstrapHopHtml`](../../src/lib/vault-view.ts) and [REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC1-AC2.

If browser storage rejects the flag write, the page shows the bootstrap error and emits neither the completion cookie nor the redirect. The key comes from `getVaultEncryptionKey`: HKDF-SHA256 over `ENCRYPTION_KEY` + the bucket name, see [REQ-VAULT-021](../../sdd/spec/vault.md#req-vault-021-bucket-stable-vault-url-and-bucket-derived-key). The SB shell handler 302-redirects to this hop on any shell-path request without the bootstrap cookie, so first visits always traverse it. After the hop completes, the cookie suppresses redirects and the shell handler proxies the SB binary normally.

The hop fails visibly when `navigator.serviceWorker` is absent. Activation, exact controller acquisition and native key acknowledgement each use the existing 10-second bound (`VAULT_SW_ACTIVATION_TIMEOUT_MS`), rather than indefinite `.ready`. A redundant worker, missing acknowledgement or controller replacement before completion aborts with the existing retry guidance, leaving the completion cookie and encryption flag uncommitted.

The `.vault-key` endpoint is used by the grafted native worker to recover the encryption key whenever its in-memory key is gone ([REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC5). It uses the same auth chain as `.codeflare-bootstrap`.

The native worker is the full SB sync engine plus its native `set-encryption-key` / `get-encryption-key` message handlers. Upstream stores the posted key in a module-local variable, proactively flushes it 5s after the last client disconnects, and has no recovery after idle termination. Codeflare's served graft neuters the proactive flush and adds recovery when genuine worker termination clears module memory.

Two upstream paths read the key and fail hard when it is empty. The **`config`** message handler, gate `if(t.enableClientEncryption&&!y)`, posts an auth-error and the client navigates to `.auth`; before Codeflare neutered the proactive transition flush, this fired on cold boot when the client posted `config` after the bootstrap-hop -> shell transition. The `get-encryption-key` reply is the other path. The served graft now retains the key across that no-client gap and recovers it after genuine worker termination.

The graft injects a shared `__cfRecover()` helper. When the key is empty, it fetches `/api/vault/<token>/.vault-key` with `{credentials:'same-origin'}`, scope-relative to the bucket-stable SW, so the fetch carries the `cf_vault_sid` cookie. It decodes with SB's own decoder, sets the key, and calls the helper at both sites before either gives up. This is the same fallback the old key-shim had, and it keeps cold boot and idle-reopen from bouncing to `.auth`. The former key-shim (`VAULT_KEY_SHIM_SERVICE_WORKER_JS`) has been removed now that the native-worker path is verified on integration (AD69).

SilverBullet maintains two IndexedDB databases per (spaceFolderPath, baseURI, encryptionKeyPart) tuple: `sb_data_<hash>` (client-context, opened by `client/client.ts`) and `sb_files_<hash>` (SW-context, opened by `client/service_worker.ts`). With the native worker now served (AD69), BOTH are created: `sb_files_*` is the persistent local-sync store that makes indexing incremental and survives cold loads (the codeflare#445 fix). Both stores are encrypted through the same key. (Under the former key-shim only `sb_data_*` existed and `sb_files_*` was never created, which is why the editor re-indexed over the network on every cold load.)

The current token salt is deliberately versioned. The v3 cutover changes `baseURI` once, making SilverBullet derive a fresh encrypted `sb_data_*`/`sb_files_*` pair and one permanent canonical worker scope. On the first explicit prepare, the authored `VAULT_UNREGISTER_STALE_WORKERS_SOURCE` browser script removes every prior same-origin Vault registration, leaves unrelated workers alone, and fails closed if re-enumeration still finds a stale Vault scope. Historical IndexedDB databases are not migrated or deleted; they remain orphaned browser caches. Every future session and ordinary worker update reuses the stable v3 scope ([REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC1-AC3, AC7). [AD126](../decisions/README.md#ad126-vault-browser-realm-scripts-are-authored-source-never-serialized-worker-functions) makes the authored browser-source boundary permanent: injected Vault scripts cannot be serialized from Worker-bundled functions or depend on bundler-only helpers. <!-- @impl: src/lib/vault-bucket-token.ts::getVaultBucketToken --> <!-- @impl: src/lib/vault-browser-scripts.ts::VAULT_UNREGISTER_STALE_WORKERS_SOURCE -->

Cleanup runs at two surfaces (`web-ui/src/lib/vault-cache.ts`):

Reconciled by [REQ-VAULT-023](../../sdd/spec/vault.md#req-vault-023-bucket-stable-vault-store-persistence-and-content-bootstrap): ordinary per-session DELETE and orphan sweeping remain localStorage-marker bookkeeping only; they never enumerate or delete IndexedDB and never unregister workers. The explicit v3 bootstrap cutover is the sole worker-removal exception. It removes old registrations before installing the permanent scope but leaves every database untouched.

- `cleanupSessionVaultCache(sid)` -- called from `deleteSession()`. Removes the `vault-session-<sid>`, `vault-session-<sid>-idbs`, `vault-session-<sid>-scope`, and `vault-session-<sid>-prewarmed` localStorage keys. Does not touch IndexedDB or any service worker.
- `sweepOrphanVaultCaches(activeSessionIds)` -- called only after an authoritative `loadSessions()` fetch succeeds. Removes marker keys for sessions absent from `activeSessionIds`.

`sweepOrphanVaultCaches` iterates the plain, `-idbs`, `-scope`, and `-prewarmed` entries under `vault-session-*`. `listSessionMarkers` strips those suffixes so they map to the same sid. The sweep catches sessions deleted via API in another tab or after a browser crash. Dashboard mount does not sweep, because it can see the initial empty store before the session list is known.

All operations are fail-safe: a missing global (SSR, fresh tab) or malformed `-idbs` JSON value is swallowed silently because cleanup is best-effort and must never block the delete UI or a successful session-list refresh.

**Principled-rejection invariant (load-bearing):** the session cleanup helpers MUST NEVER enumerate IDBs via `indexedDB.databases()` and never derive names from the `sb_<type>_<hash>` formula. An earlier version parsed `parts[2]` of an IDB name as the sid and deleted every SB database on Dashboard mount, forcing a full resync on every reopen. The v3 cutover changes only the URL-derived database identity and intentionally leaves those older databases untouched.

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

  Vault layout, retrieval order, wikilink conventions, and prohibited operations live in the advanced-only Claude and Pi `vault-operations` skills at `preseed/agents/{claude,pi}/skills/vault-operations/SKILL.md`.
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

Critical subdirectories (`Raw/Sessions/`, `Raw/Pasted/`, `Raw/Graphs/`, `Notes/`, `References/`, `graphify-out/`, `.silverbullet/_plug/`) are always `mkdir -p`'d. `Raw/Graphs/Vault Graph.md` is seeded from preseed only when absent and is never overwritten. Legacy `Global Graph.md` pages from earlier installs are removed on boot when no matching product preseed exists because the unified global graph is too large for useful HTML rendering; query it through runtime-native Graphify tools instead. `graphify-out/graph.json` is seeded as an empty stub only when absent.

A returning session inherits R2-restored content for user-owned paths: `Notes/`, `References/`, `Inbox/`, `Journal/`, `Raw/Pasted/`, `Raw/Sessions/`, plus `Index.md` once seeded. The always-overwrite config pages are refreshed from preseed regardless, so any preseed update propagates without per-user migration.

`init_user_vault()` runs AFTER `establish_bisync_baseline()` so we never run the per-boot sync over a half-restored vault. If the baseline fails for any reason, the init function still runs (`(init_user_vault) || echo ...`) and the critical-dir + preseed-page tiers are created locally; the next successful bisync reconciles user content.

On first browser open after a fresh vault, SilverBullet must build this browser's IndexedDB stores, complete its service-worker space sync, and build the object index. Codeflare does that work on demand, on the user's first click: the Vault button stays guarded ('idle') until the server probe succeeds, then becomes clickable ('available'). The first click mounts the hidden same-origin prewarm iframe, and the button breathes 'preparing' until that iframe emits the current-device bridge ready signal ([REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC1-AC6).

That ready signal names the canonical same-origin Vault scope and requires a `space-sync-complete` signal from SilverBullet, SilverBullet's current object-index version complete with the index queue empty, and a local `/.fs/` listing containing the codeflare-authoritative files (`CONFIG.md`, `Index.md`, `STYLES.md`). The bootstrap has already removed stale workers and registered the canonical native worker; the arming poll verifies `/.vault-key` before the button breathes green ('armed'). It stays non-openable until content readiness and key recoverability both hold ([REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC3-AC4, AC7; [REQ-VAULT-018](../../sdd/spec/vault.md#req-vault-018-vault-control-gating-and-on-demand-prewarm-trigger) AC5-AC7).

The user-visible lifecycle is unchanged: white static means available but unprepared; the first click starts prewarm and breathes in the theme accent; completed proof breathes green; the second click opens synchronously inside the gesture with no per-open re-verification ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC1, [REQ-VAULT-029](../../sdd/spec/vault.md#req-vault-029-canonical-browser-state-cutover-and-future-worker-safety) AC6). The hidden prewarm shell is focus-inert, so the on-demand prewarm runs while the user types in the terminal without dismissing the mobile keyboard ([REQ-VAULT-020](../../sdd/spec/vault.md#req-vault-020-vault-prewarm-focus-safety)). Subsequent user clicks open a tab against the already-prepared current browser cache.

Visual confirmation that the preseed theme is wired correctly: the editor renders on a zinc-950 base (`#09090b`), wikilinks and modal selection use a blue-500 accent (`hsl(217, 91%, 60%)`), body type is Inter and code spans are JetBrains Mono. If the editor shows SilverBullet's default white/cream palette, `STYLES.md` is missing or targeting variables SB does not consume (the previous `--cf-*`-only regression).

A new untouched Vault does not trigger spurious extraction after first durable initialization: `init_user_vault()` baselines the content-hash manifest and writes `vault-extract-initialized`. Product-supplied root pages are excluded by name, so their preseed updates do not count as user edits. Existing or restored Vault migration records initialization without baselining; a missing manifest remains full-delta eligible. Prompt-cadenced hash checks, not a polling daemon, discover changes. An untouched new Vault and a returning Vault with its manifest restored remain idle until eligible content changes.

## Attachments and Ingestion

<a id="attachment-cost-caveat-req-vault-011-ac1"></a>
### Attachment Cost Caveat (REQ-VAULT-011 AC1)

SilverBullet writes pasted / drag-dropped attachments next to the note that referenced them (a Quick Note at `Inbox/2026-05-18/16-59-59.md` produces attachments at `Inbox/2026-05-18/*.pdf`, `.png`, etc.). On Claude, vault-extract reads PDFs through the native PDF-capable Read tool (rendering pages as images, capped at 20 pages per PDF), emits a `document` node plus visible title/heading/entity concepts, and can cite a sibling Markdown wikilink. Image-only PDFs and screenshots cost vision tokens per page on every Claude ingestion pass. Pi has no PDF page reader and emits only a metadata-derived bare document node; it does not claim content/citation parity. Move attachments to `Raw/Pasted/` manually if you want them grouped outside the date-folder rhythm.

<a id="pdf-ingestion-e2e-plan-req-vault-011"></a>
### PDF-Ingestion E2E Plan (REQ-VAULT-011)

Manual verification for runtime-specific PDF handling. Claude's content/vision/citation behavior is agent-prompt behavior driven by its `vault-extract-prompt.md`; Pi's prompt deliberately remains metadata-only. There is no synthetic PDF reader or shader-like internal test.

1. Claude AC1/AC2 - healthy PDF: drop a multi-page text PDF into `Raw/Pasted/`, trigger an eligible resumed-session or crossed 20-prompt hash check, then confirm content-derived graph nodes.
2. Claude AC3 - citation edge: add a sibling Markdown note that wikilinks the same PDF, trigger the next eligible hash check, and confirm the edge.
3. Pi AC4 - submit a PDF and confirm it produces only a metadata document node.
4. AC5 failure isolation - drop a corrupt or password-protected PDF alongside a healthy changed file and confirm one unreadable PDF does not block the batch or manifest advancement.

On Claude, the global graph should gain a `document` node plus concepts for visible titles, headings, and named entities; a sibling wikilink should receive a citation edge. On Pi, no visible PDF content or citation edge is inferred. A corrupt PDF emits only a bare document node while healthy sibling input still ingests.

## Memory Capture System

Cross-session memory in codeflare lives entirely in the vault. Graphify ingests every supported vault input into the unified global graph; agents query it via runtime-native Graphify tools. The former MCP `@modelcontextprotocol/server-memory` subsystem has been removed. Conversation context (decisions, debugging insights, observations) survives across sessions and devices only in Pro/advanced mode, where the capture machinery writes structured notes and bisync preserves the vault subtree. Default mode registers no memory-capture hook, counter, or persisted Vault write machinery.

Implements [REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume), [REQ-MEM-004](../../sdd/spec/memory.md#req-mem-004-vault-contents-synced-to-r2-across-sessions), [REQ-MEM-006](../../sdd/spec/memory.md#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-MEM-008](../../sdd/spec/memory.md#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline), [REQ-MEM-010](../../sdd/spec/memory.md#req-mem-010-memory-capture-hook-plumbing).

### First-prompt and post-compaction retrieval

`memory-inject.ts` is the Pi counterpart of the Claude `memory-context-inject.sh` hook: on the first real prompt it extracts keywords, scores unified graph nodes, and injects top matches as a turn message from `before_agent_start`. Ranking, node cap, rendered shape, and the atomic one-shot sentinel under `/tmp/.memory-counter/` match Claude. No match leaves the sentinel unspent. Pi skips child sessions and synthetic prompts. <!-- @impl: preseed/agents/pi/extensions/memory-inject.ts::registerMemoryInject -->

The unified graph is the injection source; a per-repository graph is not a substitute for cumulative conversation and user-note evidence. Whole-graph parsing is guarded by configurable `MEMORY_INJECT_MAX_GRAPH_BYTES`. <!-- @impl: preseed/agents/pi/extensions/memory-inject.ts::registerMemoryInject -->

`post-compaction-recall.ts` listens on `session_compact` and sends an undisplayed custom-message follow-up without triggering a turn, so recall persists in the session. It skips child sessions and preserves Claude's selection, bounds, and wording. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::registerPostCompactionRecall --> The whole handler is fail-silent: child-session checking, digest construction, or delivery failure must not throw into compaction. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::registerPostCompactionRecall -->

Claude registers `post-compaction-recall.sh` on SessionStart with matcher `compact`. It recalls Context and Decisions from the five most recent session extracts because compaction keeps the session ID and the first-prompt sentinel is already claimed. `PostCompact` cannot return the required `additionalContext` and is not used ([REQ-MEM-019](../../sdd/spec/memory.md#req-mem-019-post-compaction-recall-of-recent-session-extracts)).

Both runtimes rank capture recency by the instant encoded in `YYYY-MM-DDTHH-MM-SS±HHMM-<8-character-session-id>.md`, never restored mtime or lexical timestamp order. Equal instants sort by filename descending. Headings count only outside fenced blocks; fences match by backtick-run length. Per-extract truncation spends UTF-8 bytes, cuts at character boundaries, and charges its notice to the same cap, dropping the notice if it cannot fit. Each exact `Source:` path is reserved before title/body; an extract is omitted if required metadata cannot fit. Current individual captures are searched first, with machine-owned `Archive.md` as fallback. These bounds and evidence paths survive archive compaction unchanged.

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
   - **Existing counter:** a delta below 20 exits silently.
   - **`CURRENT_COUNT == 1`:** baseline at the transcript size, write the counter, emit the first-message graphify-query nudge, and exit without capture.
   - **`CURRENT_COUNT > 1`:** treat the restored transcript as a resumed session ([REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume) AC7). Capture only the uncaptured tail after the highest durable successful count when one exists, and re-emit the graphify-query directive.
   - **Why re-emit:** the recycled agent context no longer recalls prior decisions or graph-query guidance.
4. **Vars file** - writes transcript path, offsets, date, counts, and
   counter path to `/tmp/.memory-counter/{session_id}.vars` as JSON.
5. **Counter update** - leaves the counter unchanged while the capture request runs. Verified note and graph publication advance it to the captured prompt count and line offset; failed publication leaves the prior high-water state intact ([REQ-MEM-020](../../sdd/spec/memory.md#req-mem-020-capture-requests-are-re-delivered-under-a-bound) AC1-AC2, [REQ-MEM-021](../../sdd/spec/memory.md#req-mem-021-capture-publication-requires-its-artifact) AC1-AC2). <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CAPTURE_FILE --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh::COUNTER_FILE -->
6. **JSON output** - emits `{hookSpecificOutput:{...,additionalContext}}` with three launch constraints.
   - The hook launches the capture subprocess itself; nothing is asked of the main agent before other work.
   - There is no blocking hook. Before it latches, an armed request relaunches once per user prompt except while a capture is still running ([REQ-MEM-020](../../sdd/spec/memory.md#req-mem-020-capture-requests-are-re-delivered-under-a-bound) AC3-AC6).
   - Publication refuses unless the request's named capture file exists, and only then advances the counter and drains `.vars`, so a failed capture leaves its window uncommitted for a later request ([AD124](../decisions/README.md#ad124-bounded-re-delivery-replaces-the-memory-capture-hard-block)).
   - `run-memory-capture.sh` passes `--model sonnet --effort medium`, overridable with `CODEFLARE_MEMORY_MODEL` and `CODEFLARE_MEMORY_EFFORT`; the agent frontmatter is not read on this path ([AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)).

Capture relaunch attempts are counted. Six failed launches latch the request until twenty further prompts allow a replacement ([REQ-MEM-020](../../sdd/spec/memory.md#req-mem-020-capture-requests-are-re-delivered-under-a-bound) AC3-AC5, [AD148](../decisions/README.md#ad148-memory-and-vault-capture-follow-successful-prompt-cadence)). <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::MAX_ATTEMPTS --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::REARM_AFTER -->

`run-memory-capture.sh` owns the `.vars` retry carrier and prefilters the uncaptured transcript interval before starting inference. It assembles one `CAPTURE_REQUEST` containing the transcript inline under an unguessable per-run frame; captured conversation is data, never instructions. The default transcript byte limit is 400,000 (`CODEFLARE_MEMORY_MAX_PAYLOAD_BYTES`), with visible truncation in payload and diagnostics.

The detached headless process defaults to Sonnet, medium effort, six turns, and a 900-second supervisor deadline; validated overrides retain positive bounds. The model reads no carrier, transcript path, or chunk directory. It writes the note and invokes the deterministic graph builder; the runner invokes the fail-closed publisher even after a nonzero model exit, because artifact and publication evidence—not exit status alone—decide whether capture committed. [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) retains the fidelity rationale, not a requirement for model-owned transcript paging or scratchpad processing.

Every attempt appends its capture exit status,
the publisher's verdict, and — on failure — the stderr tail and the result
envelope's failure subtype (a byte count when unparseable, never the response
text) to
`<carrier>.attempts.log` beside the carrier, because a detached launch
discards the runner's own stderr and a window that burned its attempts
otherwise left nothing to diagnose; the six-attempt latch bounds the file. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/run-memory-capture.sh::ATTEMPT_LOG -->

When it arms a request, `memory-capture.sh` invokes
`assert-iso-ts.sh` before the detached runner's prefilter/inference step ( [REQ-MEM-010](../../sdd/spec/memory.md#req-mem-010-memory-capture-hook-plumbing) AC5/AC6/AC7).
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

Pi reads real-user messages from the durable root session and snapshots only prompts after the successful counter at the 20-prompt boundary or after the durable resumed-session high-water. Despite its historical name, `MEMORY_CAPTURE_MAX_TOTAL_CHARS` caps the rendered transcript at 200,000 UTF-8 bytes, charging role headings, separators and rescued citations. `MEMORY_CAPTURE_MAX_TURN_CHARS` first slices each oversized turn to 10,000 JavaScript string code units; bounded rescue can then append up to 50 lost citations (`MEMORY_CAPTURE_MAX_RESCUED_REFS`). <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::selectTurns --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::capTurn -->

Post-compaction recall uses separate UTF-8 byte budgets. Pi writes request-specific execution JSON before publishing `<sessionId>.vars` as the active request-ID pointer.

Under [REQ-MEM-016](../../sdd/spec/memory.md#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile), launches are medium-reasoning, seven-turn public background requests with inherited context disabled. Root JSONL determines missing/running/failed/success state and reminders zero through five. The worker exposes note/chunk only after graph publication; GIVEUP remains latched until twenty later real prompts produce a replacement request. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionDue -->

The memory agent writes the note and invokes `scripts/build-memory-graph.py` to derive a deterministic graph from the H1 title and canonical concept IDs. It performs the required locked merge/publication but never changes counters or delivery files. Claude's corresponding publication helper keeps merge, global publication, and success-only carrier removal inside one locked command.

The shared merge deduplicates only identical `(source, target, relation, source_file)` evidence, preserves distinct evidence between the same nodes across persisted/prior/new inputs, and keeps `vault-graph.json` and `graph.json` byte-identical. <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence -->

An exact successful native notification qualifies only after publication and while both the post-commit note and its matching graph chunk exist. The root then advances the counter to the greater of its current value and frozen request count and cleans only the matching pointer, snapshot, and graph-chunk artifacts. Failed, late, or superseded results cannot skip a capture window or delete replacement work. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess -->

### Public Pi delivery and publication

Pi extraction is driven by `prompts/memory-agent-prompt.md` and `prompts/vault-extract-prompt.md`. The root reads Pi's durable transcript, filters synthetic prompts, creates request-specific snapshots, and emits visible public background requests instead of using the private subagent service.

Each launch shows a job/delivery summary followed by pretty-printed `<extraction-items-json>` whose request items exactly match durable details metadata. Standard JSON `\n` escapes inside `prompt` decode to line breaks when the public call is submitted; terminal wrapping does not alter the value.

Generated agents and emitted requests use provider-neutral medium reasoning, Bash-only evidence, and seven turns ([AD102](../decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional), [AD103](../decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs)).

`memory-vault.ts` owns delivery and high-water state. `/tmp/.memory-counter/<sessionId>.vars` and `vault-extract.pi.vars` are active request-ID pointers for reload discovery.

Public prompts receive immutable home-backed cache snapshots named `memory-capture.<sessionId>.<requestId>.vars` or `vault-extract.pi.<requestId>.vars`. `memory-vault.ts` derives the request-specific home-backed path and can discover an active legacy pointer before retry; the [extraction data flow](architecture.md#pi-memory-and-vault-extraction-data-flow) shows the ownership boundary. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memoryExecutionVarsPath --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::readActiveMemoryRequest -->

Root-session JSONL determines exact public-call attempts, native completion, reminders `0..5`, and GIVEUP. An emitted request with no matching call remains one pending delivery, so repeated settlements and reloads emit neither duplicates nor GIVEUP. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts -->

Each failed exact call advances one reminder. Six failed calls emit a structured GIVEUP summary with unchanged committed state and job-specific re-arm conditions. Background agents never write counters, pointers, or manifests. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionDue -->

Memory capture triggers every 20 real prompts. On the first prompt after resume, it captures only the durable uncaptured tail when one exists. Claude keeps its session counter under `/tmp/.memory-counter/`; `MEMCAP_COUNTER_DIR` overrides that directory for hermetic tests. Request snapshots contain text turns inline in `VARS_FILE.transcript`, bounded by a fixed character budget and a per-turn cap; they never reference an `INPUT_FILE` or separate transcript path. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::MEMORY_EVERY_N_PROMPTS --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::MEMORY_CAPTURE_MAX_TOTAL_CHARS --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::MEMORY_CAPTURE_MAX_TURN_CHARS -->

The public request and generated agent repeat that input boundary. Exact success plus the post-commit note and request chunk lets the root advance the frozen counter and remove only matching state.

Vault indexing retains the shared content-hash format and exclusion set. It promotes a request-specific pending manifest only after exact success and hash validation; prelaunch edits coalesce, while during-run edits remain eligible for the next resumed-session or 20-prompt hash check ([REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume), [REQ-VAULT-026](../../sdd/spec/vault.md#req-vault-026-vault-extract-change-detection-survives-container-restart-content-hash-manifest), [REQ-VAULT-027](../../sdd/spec/vault.md#req-vault-027-pi-vault-extraction-delivery-is-visible-and-transactional)).

Both prompt contracts read immutable inputs once, write a request-specific work chunk, and require one 300-second lock spanning cumulative merge and global publication. Pi session capture derives that chunk with the advanced-only `scripts/build-memory-graph.py` asset rather than model-authored graph JSON, keeping semantic IDs deterministic. <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::flock --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::flock --> <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::main -->

Both runtimes' byte-identical merge script normalizes serialized edge tuples after Graphify conversion and writes the cumulative bytes to `vault-graph.json`, then copies them to the sibling `graph.json` that feeds the local visualization; only `vault-graph.json` is read back on the next merge and published as `user_vault`. <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::main --> <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::main --> Canonical chunks appear only after publication and qualify root finalization; required failure leaves high-water state unchanged. Visualization is best effort with a 15-second ceiling.

### Counter Storage

```
/tmp/.memory-counter/
+-- {session_id}         # Two lines: last_count, last_line_offset
+-- {session_id}.vars    # Variables JSON for current hook invocation
```

The counter directory lives under `/tmp` by design: Cloudflare Containers
guarantees that `/tmp` (and all non-R2-backed disk) is fresh on every
container start, which is what makes the counter's absence on the first
hook fire a reliable "fresh container" signal for [REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-20-user-messages-and-on-resume) AC7
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
| `curl http://127.0.0.1:3030/` returns nothing inside the container | SilverBullet supervisor not yet up | Wait 5s and retry; check `/run/codeflare/services/silverbullet.log` for the restart-loop output. |
| Graphify query returns no Vault nodes | Missing cumulative publication or repository-only query scope | Check the runtime-native tool's scope and the committed `user_vault` contribution. Inspect capture/extraction publication evidence; a per-repository graph is not cumulative Vault memory. |
| Edits do not appear in graph queries after an eligible prompt-cadenced check | Content is unchanged, excluded, extraction is running/failed, or query scope is repository-only | Inspect the changed-file hash result and exact visible extraction result; verify the query's graph scope. Resumed-tail and crossed 20-real-prompt checks—not a 60-second extraction timer—create work. Do not advance the manifest manually. |
| Stale Vault edits after stop | Final persistence drain failed or exhausted its budget | Correlate the final-sync audit and `shutdownElapsedMs`; use [Storage recovery](storage-and-sync.md#troubleshooting). The DO-owned 120-second drain, 125-second host cap, and 135-second teardown—not the signal-trap watchdog—govern durability. |
| `/api/vault/:sid/` returns 503 | SilverBullet supervisor not ready | Wait for the readiness probe to mark Vault available, then click the button to start prewarm. The button reports preparing, timeout, or error; timeout/error retries require another click. |
| Vault button is white/available after a page reload even though this browser used Vault before | Fresh dashboard loads never auto-prewarm or trust persistent readiness markers ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC2). | Expected: click once to run canonical-scope sync/index/content proof, wait for green, then click again to open. Existing v3 stores are reused internally. |
| Clicking "Quick Note" shows `You are not authenticated, going to reload...` alert, then reloads to a blank/white page | SilverBullet's client.js writes via PUT/DELETE/PATCH without `X-Requested-With`, which `authenticateRequest`'s CSRF guard required (fixed by the Origin-validated synthesis in `src/routes/vault/index.ts`) | Redeploy the container image to pick up the fix. As a temporary workaround, open the vault in a fresh browser tab (clears any stale ServiceWorker scope that may compound the loop). |
| Drag-dropping a PDF or image into SilverBullet returns 401; attachment never saves | Older image: `maybeSynthesizeCsrfHeader` skipped synthesis when `Origin` was absent (SilverBullet's same-origin fetch and SW-controlled paths omit it), so the PUT landed at `authenticateRequest` without `X-Requested-With` ([REQ-VAULT-009](../../sdd/spec/vault.md#req-vault-009-vault-writes-succeed-end-to-end-for-silverbullet-attachment-uploads)). | Redeploy. After the fix, a missing `Origin` header is treated as same-origin and synthesis proceeds. A present-but-disallowed `Origin` still returns 403. |
| SilverBullet opens lowercase "index" (empty editor) instead of the Codeflare dashboard | Supervisor not exporting `SB_INDEX_PAGE=Index` before launching the binary | Confirm the env var is set in `entrypoint.sh start_silverbullet_supervisor`. SB's Go server hardcodes the default to `"index"` (`server/cmd/server.go` in SilverBullet's source); the env var is the only override. |
| Vault button opens during boot or first sync/index | Readiness guard missing | Keep visible but guarded until all server, prewarm, sync, index, and file-list readiness proofs pass. |
| Dashboard widgets render as raw `${query[[...]]}` text or nothing | A disk `Library/Std/` shadows the binary's `base_fs` overlay | Inspect the disk tree and obtain explicit user authorization before removing any existing folder. Library/Std ships inside the SilverBullet binary; **never** seed it from disk. |
| No Vault nodes after several capture cycles | A historical image used external semantic extraction without a provider key, or current publication failed | Inspect the exact capture artifact and publication result. Current capture derives a deterministic graph from the note; user-edit extraction emits bounded evidence chunks. Neither uses an external headless semantic-extraction CLI for capture. Historical diagnosis: [baseline](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/vault.md#troubleshooting). |
| Browser console shows `Failed to register a ServiceWorker ... 401 ... fetching the script`; SilverBullet loads but appears unregistered as a PWA / offline mode never activates | Older image: SW registration GET at `/api/vault/<sid>/service_worker.js` ran the cookie-auth chain, but browsers may omit credentials on SW script fetches, so auth returned 401 and registration failed permanently | Redeploy. The Worker now short-circuits SW registration (selector: `service-worker: script` header) and returns SilverBullet's native SW (`VAULT_NATIVE_SERVICE_WORKER_JS`) the browser accepts. Distinct from the CSRF / Quick-Note row above; both can be present on a pre-fix image. |
| Bootstrap-hop page stuck on "Loading vault..." indefinitely | Samsung Internet and other Chromium forks may send cookies on SW registration fetches; the Worker's SW selector rejected cookied requests, so registration fell to SB's native SW whose `cache.addAll()` install failure left `navigator.serviceWorker.ready` permanently unresolved | Fixed: the Cookie gate was removed from `isServiceWorkerRegistration()`, and the hop page now uses a 10-second activation timeout (`VAULT_SW_ACTIVATION_TIMEOUT_MS`) instead of the indefinite `.ready`. On timeout or install failure ("redundant" state), the hop shows an explicit error message with retry guidance. |
| Editing a SilverBullet note shows `Could not save page, retrying again in 10 seconds` repeatedly; saves never succeed | Older image: PUT requests went through `maybeSynthesizeCsrfHeader` which clones the request to add `X-Requested-With`, consuming the original body; the proxy then forwarded the original (now disturbed) request to `container.fetch`, raising `TypeError: This ReadableStream is disturbed` and returning 500 | Redeploy. The proxy now forwards the auth-validated clone (which owns the body) instead of the original; pre-fix images log `Vault request error` with the disturbed-stream stack trace in Worker logs (`wrangler tail` or Cloudflare Observability). |
| Browser shows encryption enabled, then encrypted IDB open aborts | Key-rotation desync between config and SW key message | Hard-reload; if rotating, unregister the SW, drop the bootstrap cookie, and reload. |
| Vault shows `.auth` 403 on cold boot or idle reopen | Native SB worker lost its in-memory encryption key | Redeploy; pre-graft images can clear the bootstrap cookie and reload. |
| Second session opens empty or terminal loses focus | Older SW full-sync wiped local store during server warmup | Redeploy; the not-ready guard defers empty remote lists. |
| Second start never turns green and `Index.conflicted` files appear | Older image force-overwrote `Index.md` while the editor normalized it | Redeploy; `Index.md` is now create-if-missing. |
| Mobile vault button differs from desktop after return | Older settle-on-return state diverged across mobile reloads | Redeploy; green ready state now persists without localStorage settle. |
| Desktop: the FIRST vault open lands on `/.auth` "Authentication not enabled"; closing and reopening the tab works | Older image: opening the bare shell after prewarm raced the service worker's single-shot key recovery (`__cfRecover`) — the key had been flushed after prewarm, and SilverBullet's top-level navigation read it before recovery completed, bouncing to `/.auth`. | Redeploy. `openVaultTab` now opens via the bootstrap-hop `/api/vault/<sid>/.codeflare-bootstrap` ([REQ-VAULT-024](../../sdd/spec/vault.md#req-vault-024-vault-bootstrap-hop-key-arming-and-service-worker-retention) AC6), which awaits exact worker control and acknowledged key import before redirecting, instead of relying on recovery during editor boot. |
| Opening an already-warm vault shows an empty/partial editor until you manually reload once or twice | The tab loaded before the vault-scoped service worker controlled it (`navigator.serviceWorker.controller` null on first paint), so SilverBullet booted without the SW-backed local space. | Fixed: the one-time controlled reload ([REQ-VAULT-022](../../sdd/spec/vault.md#req-vault-022-vault-armed-state-open-flow-and-persistence) AC4) reloads the top-level tab exactly once (`sessionStorage` one-shot, never loops) when a vault SW is active but not yet controlling; the editor then boots against the local space. |
| Capture not firing | Counter file present at `/tmp/.memory-counter/{session_id}` and transcript has fewer than 20 new prompts since last capture | Send more prompts to reach the 20-message threshold; or verify the hook is registered (`cat ~/.claude/settings.json`) |
| Capture not firing after a resume | Counter file present despite the container appearing to be a fresh start (would indicate `/tmp` somehow survived recycle, which Cloudflare's ephemerality contract forbids) | Inspect `ls -la /tmp/.memory-counter/`; if the counter mtime predates the current container's start time, file an issue - the platform contract is being violated. Workaround: `rm /tmp/.memory-counter/{session_id}` |
| Pi capture launches but no vault file appears | Background task failed, timed out, or returned success without the deterministic note | Inspect the visible native task result. The root leaves the counter and request snapshot unchanged, emits the next bounded reminder, and eventually latches GIVEUP rather than skipping the window. |
| Capture transcript shows `ISO_TS_ASSERTION_FAILED` | Timestamp assertion rejected the capture ([REQ-MEM-010](../../sdd/spec/memory.md#req-mem-010-memory-capture-hook-plumbing) AC5) | Read the transcript failure; next 20-prompt window retries. |
| Same file appears in overlapping extraction requests | A change arrived before/while a public Pi launch was being recorded | Prelaunch edits coalesce; launched snapshots stay frozen, and during-run edits remain eligible for the next resumed-session or 20-prompt hash check. Graph writes serialize on `/run/codeflare/locks/graphify-global.lock`, with Pi holding one required lock across merge and global publication. |
| A one-file Pi extraction runs for minutes or consumes review-scale tokens | The live agent predates AD103 or inherited broad tools/reasoning and reread skills/input | Verify generated agent frontmatter has `tools: bash` and `thinking: medium`, the public request carries `max_turns: 7`, then remirror and `/reload`. A current worker reads each frozen input once; visualization cannot exceed 15 seconds. |

Vault readiness requires all proofs before click-through: the button stays visible but `aria-disabled`; `probeVaultReady()` must see `{ vaultReady: true }`; `startVaultPrewarm()` and the `codeflare-vault-prewarm` iframe must exchange a same-origin/current-attempt proof naming the canonical 32-hex Vault scope; `space-sync-complete` must fire; the current object-index queue must be empty; and `/.fs/` must list `CONFIG.md`, `Index.md`, and `STYLES.md`. If it opens early, recheck those paths and confirm the bootstrap removed stale Vault workers before registering the canonical one.

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
| Capture/edit/extraction | REQ-VAULT-002/003/026/027/028/032 | capture hooks, compactor, and `vault-extract` | Content-hash, transactional publication, archive-boundary, and isolation tests |
| Graph merge/publication | REQ-VAULT-004/014/016 and REQ-MEM-023 | Vault plugin, compactor, and Graphify scripts | Active-repo lock, provenance relocation, and canonical schema checks |
| SilverBullet proxy/runtime | REQ-VAULT-005/009/012/013/017/018/019/020/025 | Vault routes/view graft and UI | Proxy, upload, prewarm, service-worker tests |
| Encryption and IDB | REQ-VAULT-008/015/021/022/023/024 | Vault crypto/view/bootstrap | Key/open/store lifecycle tests |
| Attachments/PDF | REQ-VAULT-011 | extraction runtime | Capability-dependent ingestion evidence |

---

## Related Documentation

- [architecture.md](./architecture.md) -- Container layout, Worker proxy boundary.
- [deployment.md](./deployment.md) -- How Dockerfile + preseed land in a new session.
- [`sdd/spec/vault.md`](../../sdd/spec/vault.md) -- Spec / acceptance criteria.
