# Memory

Vault-based cross-session memory, automatic capture, hook delivery, and session-mode gating.

**Domain owner:** vault subsystem, entrypoint.sh, memory-capture.sh, preseed pipeline

### Key Concepts

- **Vault** -- The persistent per-user vault directory. Single source of truth for cross-session memory; holds agent-written session captures plus user-curated notes, inbox, and journal entries. Attachment uploads land next to the note that referenced them. Bisynced to R2 so the vault survives across sessions.
- **Unified Graph** -- The merged graph combining the vault's graph with every active repo's per-repo graph; merges are hash-keyed. Queryable through the graphify MCP surface so structural questions can span all sources in a single call.
- **Capture** -- A background subagent runs every fifty real user messages and immediately on the first prompt after a resumed session has an uncaptured tail, strips tool I/O, synthesises a markdown capture into the vault's raw-sessions subdirectory, and merges its subgraph under a shared multi-writer lock. Claude retains its chunked scratchpad; Pi processes only the bounded uncaptured interval in one pass.
- **Session Mode** -- Pro mode enables R2 sync of the vault and capture hooks. Standard mode runs the in-session capture flow but the vault is not preserved across container recreations.

### Out of Scope

- Cross-user memory sharing (each user's vault is isolated to their R2 bucket).
- Automated graph compaction (the user prunes captured sessions manually via the editor when needed).
- Legacy MCP server-memory migration (the subsystem has been removed; no historical graph is read or written).
- Bulk memory export (vault files are plain markdown and can be copied with rclone or git).

### Domain Dependencies

- **Vault** -- Capture writes ([REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)) and global-graph merges depend on the vault skeleton and graph infrastructure from the Vault domain.
- **Storage** -- R2 sync of the vault ([REQ-MEM-004](#req-mem-004-vault-contents-synced-to-r2-across-sessions)) depends on the bisync infrastructure from the Storage domain.
- **Agents** -- Preseed delivery ([REQ-MEM-008](#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline)) depends on the preseed pipeline from the Agents domain.
- **Subscription** -- Mode gating ([REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)) depends on effective tier resolution and tier-allowed-session-modes from the Subscription domain.

---

### REQ-MEM-001: Conversation context automatically captured to vault

**Intent:** Important conversation context (decisions, debugging insights, observations) must be extracted from the transcript and persisted to the vault without manual intervention. This REQ covers the hook trigger, message-counting filter, and the capture pipeline. Hook plumbing (tilde expansion, vars file shape, first-message graphify hint, timezone resolution) is split into [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing).

**Applies To:** User

**Acceptance Criteria:**

1. A UserPromptSubmit hook injects a short capture instruction into the active agent context on each trigger. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::emit_context --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->
2. Pi excludes tool results and known synthetic agent envelopes from its real-user count while preserving genuine code-like prompts. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::isSyntheticPrompt --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-001 AC2: Pi excludes synthetic envelopes and preserves genuine code-like prompts) -->
3. Each triggered Claude capture receives bounded uncaptured user/assistant content from the durable transcript. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/prefilter-transcript.sh::is_synthetic_marker --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (prefilter-transcript.sh (REQ-MEM-001 AC3) / REQ-VAULT-002 (conversation captures land in vault as markdown)) -->
4. Capture-file timestamps use the configured user timezone, then the process timezone, then UTC, per [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC4. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::captureTimestamp --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (assert-iso-ts.sh / REQ-MEM-010 AC5+AC6+AC7) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (prefers USER_TIMEZONE over TZ when both are present) -->
5. The capture file uses a YAML frontmatter template with session, capture-time, and capture-range fields followed by Context / Decisions / Observations / References sections. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md::captured_at --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->
6. A capture is complete only after its required publication outputs are durably accepted; any failure remains incomplete and retryable without advancing the captured message range. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh::VARS_FILE --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memorySuccessQualifies --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (publish-memory-capture.sh (REQ-MEM-001 AC6)) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (requires the post-commit note and chunk before exact success advances the frozen counter) -->
7. Pi builds each capture request from only the root-bounded uncaptured interval after the last successful counter. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::compactMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (captures only prompts after the root-owned successful counter) -->

**Notes:** Pi's root-owned extraction lifecycle is documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional); its bounded execution profile is [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).

**Constraints:**

- The hook runs in approximately 150ms.
- Memory capture requires advanced mode; only that mode receives the hook, plugin, and rule.
- Claude uses Sonnet with medium reasoning per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad).
- Pi uses its provider-neutral model lever with medium reasoning per [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).
- Capture agents produce graph output directly; the headless extraction CLI is not invoked.
- Claude keeps its scratchpad and retry carrier until cumulative merge and global publication succeed.
- Pi requires an exact successful call plus post-commit note and graph-chunk artifacts before advancing its root-owned counter.
- Claude reads hook-provided transcript JSONL; Pi reads persisted session messages.
- Both skip capture for an empty transcript.

**Priority:** P0

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** Automated test ([Pi extraction lifecycle tests](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [Claude capture pipeline tests](../../host/__tests__/memory-capture-pipeline.test.js))

**Status:** Implemented

---

### REQ-MEM-015: Pi Extraction Transcript Visibility and Child-Session Guard

**Intent:** Pi extraction must read durable root-session input, expose launch requests to the model, and stay inert inside child subagent sessions so work survives reloads without polluting child transcripts.

**Applies To:** User

**Acceptance Criteria:**

1. Capture reads each runtime's durable resume transcript, never volatile memory, so reload and resume retain full history; an empty resolved transcript skips capture instead of writing a placeholder. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (creates work on the fiftieth real prompt and emits a visible reminder without private spawn) -->
2. Pi capture triggers are inert inside subagent child sessions — sessions whose header carries a parent-session pointer (review monitors, CI monitors, capture/extract subagents themselves) — so a background task's transcript never receives an injected capture follow-up as its visible output. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::isChildSession --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (keeps all handlers inert in child sessions) -->
3. After root-session reload or resume, Pi reconstructs each active capture's launch, reminder, running, failure, and success state from durable session JSONL; a bounded turn-limit completion qualifies only with the job's post-commit artifacts, and unrelated or superseded results never count. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (correlates exact public calls and reconstructs running, failed, and successful state) -->
4. Every capture/extract launch shows a job/delivery summary and pretty-printed JSON whose bounded request items exactly match durable delivery metadata. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC4: exposes identical extraction items to the model and durable metadata) -->
5. An emitted request remains pending without duplicate reminders until an exact public call occurs. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionDue --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC5: keeps an emitted request pending until an exact public call) -->
6. Each failed exact call advances at most one of six delivery attempts. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionTranscriptFacts --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::extractionDue --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC6: advances one delivery attempt after each failed exact call) -->
7. Six failed exact calls emit one structured terminal notice that identifies each failed job and its next automatic opportunity. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-015 AC7: identifies the failed job and next automatic opportunity) -->

**Notes:** Reload-safe transcript correlation is documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional).

**Constraints:**

- Pi reads its persisted session file via `getSessionFile()` and skips capture when the resolved transcript is empty.
- Child-session detection is header-based and applies to review monitors, CI monitors, capture subagents, and extract subagents.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing)

**Verification:** Automated test ([Pi extraction lifecycle tests](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [child-session guard tests](../../src/__tests__/lib/pi-child-session-guard.test.ts), [session JSONL fuzz coverage](../../src/__tests__/fuzz/vault-migration.fuzz.test.ts))

**Status:** Implemented

---

<a id="req-mem-002-capture-triggers-every-15-user-messages"></a>
### REQ-MEM-002: Capture triggers every 50 user messages and on resume

**Intent:** Memory capture must fire at a regular interval to balance context freshness against overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tracks the number of user messages since the last capture using a per-session counter file. The counter directory defaults to `/tmp/.memory-counter/` and is overridable via the `MEMCAP_COUNTER_DIR` environment variable for hermetic tests. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 50 user messages)) -->
2. A first run with exactly one user prompt initializes transcript baseline and counter, injects the first-message graph-query directive, and exits without capture. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::MEMORY_SCAN --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)) -->
3. If the counter file exists and the delta since the last capture is less than 50 messages, the hook exits without memory capture. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 50 user messages)) -->
4. When the delta reaches 50, the capture subagent is triggered. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::DELTA --> <!-- @test: host/__tests__/memory-capture-hook.test.js (triggers capture when 50+ NEW real prompts since last_count) -->
5. After a Pi memory request reaches GIVEUP, fifty later real-user prompts re-arm capture without allowing generated extraction follow-ups to advance the cadence. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::registerMemoryVault --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::isSyntheticPrompt --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-002 AC5: re-arms only after fifty later real prompts) -->
6. Only the Pi root advances the prompt counter, after an exact correlated successful result and post-commit capture note/chunk; failed, late, incomplete, or superseded results cannot advance the counter or clear replacement work. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memorySuccessQualifies --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::finalizeMemorySuccess --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (requires the post-commit note and chunk before exact success advances the frozen counter) -->
7. A missing counter with multiple real-user prompts triggers resumed-session capture immediately on the first new prompt, starting after the highest durable successful capture count when one exists. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::FORCE_RESUME --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::latestCapturedPromptCount --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (captures only the uncaptured tail and hash-checks Vault on the first resumed prompt) -->

**Notes:** Pi delivery ownership and retry rationale are documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional); request bounds and uncaptured-window compaction are in [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).

**Constraints:**

- The counter file MUST live under an ephemeral path (default `/tmp/.memory-counter/`).
- `CURRENT_COUNT` alone distinguishes first runs: 1 means a brand-new transcript containing only the submitted prompt; greater values mean prior prompts persisted from a resumed session.
- Detection uses no timestamps, mtimes, or external sentinels.
- The hook does not detect in-session `/compact`; its surviving counter catches up within the 50-prompt window while the compressed summary preserves orientation.
- This remains an accepted limitation pending observed harm.
- On Pi, one ephemeral active request pointer enables reload discovery while a request-specific execution snapshot in the shared home-backed cache remains immutable after the first exact public call.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)

**Verification:** Automated test ([Pi extraction lifecycle tests](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [Claude hook cadence tests](../../host/__tests__/memory-capture-hook.test.js))

**Status:** Implemented

---

### REQ-MEM-004: Vault contents synced to R2 across sessions

**Intent:** Vault content (agent captures + user notes) must persist across container lifecycles by syncing to the user's R2 bucket.

**Applies To:** User

**Acceptance Criteria:**

1. In advanced mode, the user's vault directory and cumulative `vault-graph.json` source of truth are included in R2 sync. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (advanced mode: includes the vault tree AND its vault-graph.json despite the global graphify-out exclude (REQ-MEM-004 AC1 / REQ-VAULT-001 AC1)) -->
2. On container boot, the vault is pulled from R2 before any initialization runs so returning sessions inherit their persisted content untouched. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (entrypoint.sh vault boot behavior (real) / REQ-MEM-004 (vault R2 sync + idempotent init) / REQ-VAULT-007 (preseeded plugs)) -->
3. Vault directory initialization is idempotent; re-running on a populated vault creates nothing. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (init_user_vault does not clobber existing user vault content on re-run (REQ-MEM-004 AC3)) -->
4. Vault changes are pushed back to R2 on three triggers: the regular sync cadence ([REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), the Sync-now button ([REQ-STOR-015](storage.md#req-stor-015-explicit-sync-trigger-from-ui)), and the final shutdown bisync ([REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync)). <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)) -->
5. The ephemeral unified-graph layer and derived Vault `graph.json`/`graph.html` outputs are rebuilt locally and not synced; the served visualization persists at `Vault/Raw/Graphs/vault-graph.html`. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (advanced mode: excludes the per-run derived vault graph.json but keeps the cumulative one (REQ-MEM-004 AC5: derived layer not synced)) -->
6. The shutdown handler watchdog allows the final bisync up to 120s to drain pending writes before forced termination. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- @test: host/__tests__/entrypoint-shutdown.test.js (REQ-OPS-010: Graceful container shutdown preserves data) -->

**Constraints:**

- Vault and ordinary workspace content are synced; transient memory-counter files are not.
- R2 sync must be reliable under multipart-upload conditions without checksum metadata.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-001](vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Automated test ([Behavioral test](../../host/__tests__/entrypoint-rclone-filters.test.js))

**Status:** Implemented

---

### REQ-MEM-006: Memory available only in Pro (Advanced) mode

**Intent:** Vault persistence and automatic capture are user-facing features gated behind the advanced session mode. This REQ specifies the observable behavior (what works in each mode) and the preseed delta (which files differ between modes). The storage/resolution/propagation of the mode value lives in [REQ-MEM-011](#req-mem-011-session-mode-storage-resolution-and-propagation).

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, the vault directory is not preserved across container recreations: the R2 sync filters include the Vault tree only in advanced mode and explicitly exclude it in default mode, so cross-session persistence is limited to advanced-mode sessions. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (entrypoint.sh rclone filter behavior (real) / REQ-MEM-004 (vault in R2 sync) / REQ-MEM-006 (advanced-only) / REQ-VAULT-001 (vault filter order) / REQ-STOR-004 (static excludes)) -->
2. In default mode, no memory-capture hook, capture counter, or persisted Vault write machinery is registered. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)) -->
3. The memory plugin, the memory rule (which carries the folded vault trigger/route content), the vault plugin, and the vault-note-capture rule are preseeded only in advanced mode. <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)) --> <!-- @manual -->
4. Pro mode seeds a strict superset of Standard's preseed files; the memory and vault plugins/rules are part of the Pro-only delta. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) --> <!-- @manual -->

**Constraints:**

- Plugin registration is not removed on mode downgrade; missing plugin files are silently skipped at runtime.

**Priority:** P1

**Dependencies:** [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

**Intent:** Memory capture prompt files must be deployed alongside the rest of the preseed content through the standard manifest pipeline.

**Applies To:** User

**Acceptance Criteria:**

1. The capture prompt is preseeded into the session-installed memory plugin alongside its scripts. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
2. The memory plugin's scripts (hook, prompt, prefilter) and the capture subagent definition (pinned to sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)) are all delivered via the manifest pipeline that seeds named subagents like architect and code-reviewer ([REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start)). <!-- @impl: preseed/agents/claude/manifest.json::modes --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. All memory-plugin entries are marked advanced-only in the manifest. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
4. The hook script is delivered via the plugin but registered via the session settings merge, not the plugin loader. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
5. Memory-plugin source lives in the single preseed source tree. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
6. A build-time seed generator produces the runtime payload consumed by the Worker; memory-plugin files appear in that payload. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->
7. Claude memory plugin files are not generically adapted for non-Claude agents. <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) --> <!-- @manual -->

**Constraints:**

- Plugin files are updated when the pipeline is redeployed and users explicitly recreate their preseed.
- Only files listed in the manifest are included in the generated payload.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** Automated test ([agent-seed-multi-agent](../../src/__tests__/lib/agent-seed-multi-agent.test.ts))

**Status:** Implemented

---

### REQ-MEM-009: Vault graph accumulates monotonically across extractions

**Intent:** Every vault writer, across extraction and capture in both agent runtimes, must add new nodes to one cumulative vault contribution without destroying knowledge from prior passes.

**Applies To:** System

**Acceptance Criteria:**

1. Successive vault graph merges preserve nodes from prior passes. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC1/AC2: successive merges preserve prior nodes and deduplicate IDs) -->
2. Each pass emits at most one graph node for each node ID. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC1/AC2: successive merges preserve prior nodes and deduplicate IDs) -->
3. Edge evidence is keyed by `(source, target, relation, source_file)`, preserving distinct tuples across persisted, prior, and new graph data while collapsing identical tuples. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::merge_node_link_evidence --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC3: edge evidence is keyed by semantic tuple) -->
4. Structurally malformed edge entries are ignored without aborting the merge. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py::node_link_edges --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py::node_link_edges --> <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC4: malformed edge entries are ignored without crashing) -->
5. The boot seed publishes the cumulative vault graph under the `user_vault` tag, never the derived sibling graph that is empty until the first extraction. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (publishes vault-graph.json under the user_vault tag, never the empty scaffold (REQ-MEM-009)) -->
6. A first boot with no captures yet, and therefore no cumulative vault graph on disk, publishes nothing to the global graph and reports no failure. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (publishes nothing when no cumulative vault graph exists yet (REQ-MEM-009)) -->

**Constraints:**

- Vault-extract and memory-capture writers on both runtimes author request chunks and fold them through the shared merge path.
- Vault graph merges share the capture-pipeline/global-graph lock; its short timeout prevents a crashed holder from blocking extraction indefinitely (matching [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) AC7).
- Missing or unreadable graph files retain the established fresh-graph recovery path.
- Each merge copies the cumulative `vault-graph.json` to the sibling `graph.json`; only `vault-graph.json` is read back and published, and an empty `graph.json` at boot is not evidence there is nothing to publish.
- No HTML visualization is generated for the unified global graph; structural queries are the interface; only the curated vault subset receives a rendered visualization shipped to users.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) (capture pipeline contract), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown) (vault is always-on in the global graph)

**Verification:** Automated test ([vault-extract-merge](../../host/__tests__/vault-extract-merge.test.js))

**Status:** Implemented

---

### REQ-MEM-010: Memory capture hook plumbing

**Intent:** Capture timestamps reflect the user's local timezone, the hook fires reliably regardless of path format or session state, and a fabrication-resistant timestamp assertion fails closed if the subagent guesses the timestamp instead of producing a real one.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tolerates tilde-prefixed transcript paths. <!-- @test: host/__tests__/memory-capture-hook.test.js (expands ~ in transcript_path to $HOME) --> <!-- @manual -->
2. Variables shared between the hook and the capture subagent are passed via a small carrier file rather than inline context. <!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 15 user messages)) --> <!-- @manual -->
3. On the first message of a new container session, the hook injects graph-query guidance before the agent responds. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::MEMORY_SCAN --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)) -->
4. The hook resolves the capture timezone from the user preference ([REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)), falling back to the container default and finally to UTC. <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) --> <!-- @manual -->
5. The capture timestamp is validated against the current wall clock and rejected if fabricated, missing a timezone offset, or mismatching the resolved timezone. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (assert-iso-ts.sh / REQ-MEM-010 AC5+AC6+AC7) -->
6. A timestamp whose offset does not match the resolved timezone is rejected; this catches dropped-timezone-wrapper bugs without false-positiving legitimately-UTC hosts. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (AC6 #416 regression: Europe/Zurich + ISO_TS ending in +0000 rejected) -->
7. A timestamp more than 30 seconds away from the current wall clock is rejected. Any assertion failure halts the capture rather than writing a confabulated timestamp to the vault. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (AC7 freshness drift: a year-old fabricated timestamp rejected) -->

**Constraints:**

- Claude: the carrier file is retry state and remains until the locked merge/publication command removes it after success.
- Pi: the separate root-owned delivery contract is specified by [REQ-MEM-002](#req-mem-002-capture-triggers-every-15-user-messages) AC5–AC6.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-MEM-022: Resumed sessions re-emit memory graph guidance

**Intent:** A resumed conversation must consult durable graph context after its in-memory orientation was lost with the previous container.

**Applies To:** User

**Acceptance Criteria:**

1. On the first message of a resumed container session, the hook injects graph-query guidance before the agent responds. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::MEMORY_SCAN --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 - missing counter + transcript with >1 prompt force-fires capture from line 1) -->

**Constraints:**

- Guidance reuses the existing first-message hook output; no separate retrieval service or launch is added.

**Priority:** P0

**Dependencies:** [REQ-MEM-002](#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing)

**Verification:** Automated test ([Claude memory hook tests](../../host/__tests__/memory-capture-hook.test.js))

**Status:** Implemented

---

### REQ-MEM-011: Session-mode storage, resolution, and propagation

**Intent:** The session mode behind [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode) must be stored, defaulted, clamped against billing entitlement, and reconciled into agent configuration without trampling user content.

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, only baseline agent permissions are applied; capture hooks are not registered. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
2. If no session mode has been explicitly set, the default mode applies. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-AGENT-004 (two session modes: default and advanced; default when prefs unset; honors persisted sessionMode)) -->
3. Agent configuration reconciles on initial bucket creation, explicit "Recreate AI agent skills & rules", a persisted session-mode preference change, subscription-driven mode change, and the one-time enterprise Pro upgrade at session start ([REQ-ENTERPRISE-001](enterprise-mode.md#req-enterprise-001-enterprise_mode-forces-unlimited-tier-and-pro-mode) AC6). <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @impl: src/routes/preferences.ts::app --> <!-- @impl: src/routes/stripe-webhook.ts::syncSubscriptionState --> <!-- @impl: src/routes/container/lifecycle-init.ts::ensureBucketAndSeed --> <!-- @test: src/__tests__/routes/preferences.test.ts (sessionMode preference / REQ-MEM-011 (sessionMode preference persistence + preseed reconciliation)) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-MEM-011 AC3: reconcileAgentConfigs gated on the new-bucket trigger) --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-ENTERPRISE-001 AC6: enterprise upgrade reconcile for pre-existing users) -->
4. On a mode change, preseed files are reconciled to match the new mode: mode-appropriate files are written, preseed-managed files not in the new mode are removed, and user-created files are never modified. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/preferences.test.ts (sessionMode preference / REQ-MEM-011 (sessionMode preference persistence + preseed reconciliation)) -->

**Constraints:**

- Existing buckets reconcile automatically when persisted preference or subscription mode changes; explicit recreation remains the manual repair/refresh path.
- A billing-canceled user's stored session mode is downgraded to default at resolution time.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** Automated test ([Integration test](../../host/__tests__/entrypoint-hooks-merge.test.js))

**Status:** Implemented

---

<a id="req-mem-012-hard-block-tool-calls-while-memory-capture-is-deferred"></a>
### REQ-MEM-020: Capture requests are re-delivered under a bound

**Intent:** A capture directive that the agent does not act on must come back rather than disappear without making one hook able to wedge the session.

**Applies To:** Agent

**Acceptance Criteria:**

1. Arming a capture writes a durable request carrying the absolute capture path and timestamp the subagent must use verbatim, so success is decided by an artifact rather than by self-report. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CAPTURE_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (arms a request carrying the capture path the publisher will verify) -->
2. Arming does not advance the committed counter, so a capture that fails leaves its window uncommitted for a later request to cover. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CAPTURE_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (does not advance the counter when arming, so a failed capture is retried not lost) -->
3. While a request is outstanding the hook relaunches it once per user prompt and counts each launch, instead of arming a second request. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::MAX_ATTEMPTS --> <!-- @test: host/__tests__/memory-capture-hook.test.js (re-delivers an outstanding request on the next prompt instead of dropping it) --> <!-- @test: host/__tests__/memory-capture-hook.test.js (an armed request suppresses a second arm without closing the window) -->
4. After six launches the request latches, consumes no further launch, and the hook falls silent until a replacement may arm. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::LATCH_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (latches after the sixth delivery and stops reminding) -->
5. A prompt arriving while a capture is still running spends no launch, and leaves an outstanding request intact. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::capture_running --> <!-- @test: host/__tests__/memory-capture-hook.test.js (spends no attempt on a prompt that arrives while a capture is running) -->
6. No hook blocks tool calls on behalf of memory capture. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (advanced mode registers each managed hook on its own event type) -->

**Constraints:**

- The capture agent carries no `model:` pin; fidelity is selected by `CODEFLARE_MEMORY_MODEL`.
- The capture contract is bounded to six agent turns (`CODEFLARE_MEMORY_MAX_TURNS`, default 6).

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](#req-mem-002-capture-triggers-every-15-user-messages)

**Verification:** Automated test ([memory-capture-hook](../../host/__tests__/memory-capture-hook.test.js), [entrypoint hook merge](../../host/__tests__/entrypoint-hooks-merge.test.js))

**Status:** Implemented

---

### REQ-MEM-021: Capture publication requires its artifact

**Intent:** A capture that never produced its requested file must not be recorded as committed.

**Applies To:** Agent

**Acceptance Criteria:**

1. Publication refuses and retains the carrier when the request's capture file is absent. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh::CAPTURE_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (refuses to publish and keeps the carrier when the capture file is absent) -->
2. Publication commits the counter and drains the carrier once the capture file exists, and never moves the counter backwards. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh::COUNTER_FILE --> <!-- @test: host/__tests__/memory-capture-hook.test.js (commits the counter and drains the carrier once the artifact exists) --> <!-- @test: host/__tests__/memory-capture-hook.test.js (never drags the committed counter backwards) -->

**Constraints:**

- The capture agent carries no `model:` pin; fidelity is selected by `CODEFLARE_MEMORY_MODEL`.
- The capture contract is bounded to six agent turns (`CODEFLARE_MEMORY_MAX_TURNS`, default 6).

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-020](#req-mem-020-capture-requests-are-re-delivered-under-a-bound)

**Verification:** Automated test ([memory-capture-hook](../../host/__tests__/memory-capture-hook.test.js))

**Status:** Implemented

---

### REQ-MEM-013: Proactive memory injection on first prompt

**Intent:** The agent receives relevant prior context (vault notes, code concepts, past decisions) automatically on the first user message of each session, without requiring an explicit tool call. Keywords are extracted from the user's prompt and matched against the unified graphify graph; matched nodes are injected as additionalContext in the hook response so the agent sees them before responding.

**Applies To:** Agent

**Acceptance Criteria:**

1. On the first user message of a session, the hook extracts keywords from the prompt and queries the unified graph for matching nodes. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC1: injects matched nodes from global graph on first prompt) -->
2. Matched nodes (up to 10) are injected as additionalContext in the UserPromptSubmit hook response, with labels, source paths, descriptions, framing, and truncation markers charged against one 4096-byte rendered UTF-8 budget. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::MAX_RENDERED_BYTES --> <!-- @impl: preseed/agents/pi/extensions/memory-inject-helpers.ts::MEMORY_INJECT_MAX_RENDERED_BYTES --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC2: bounds the complete rendered context in UTF-8 bytes) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (bounds complete Pi injection and recall output with multibyte metadata) -->
3. The hook fires at most once per session (gated by its own atomic mkdir sentinel, claimed only after a successful graph query; independent of the memory-capture counter). <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC3: fires at most once per session (sentinel directory prevents re-fire)) -->
4. Prompts shorter than 20 characters are skipped (insufficient signal for keyword extraction). <!-- @test: host/__tests__/memory-context-inject.test.js (AC4: skips prompts shorter than 20 characters) --> <!-- @manual -->
5. The unified graph is the only source queried; no per-repo graph is accepted as a substitute for it. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::GLOBAL_GRAPH --> <!-- @impl: preseed/agents/pi/extensions/memory-inject.ts::resolveGraphPath --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC5: reads the unified graph only, and only within the ceiling) --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC5: substitutes no repo graph even when one sits in the working directory) -->
6. The Pi runtime performs the same query on the first real prompt of a session, with the same keyword rule, ranking, node cap and one-shot sentinel, injecting the result into that turn. <!-- @impl: preseed/agents/pi/extensions/memory-inject.ts::registerMemoryInject --> <!-- @impl: preseed/agents/pi/extensions/memory-inject-helpers.ts::selectNodes --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC1: injects matched nodes into the turn as a message) --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC3: fires at most once per session) --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC2: at most ten nodes are carried) -->
7. A graph beyond the configured size ceiling is skipped without claiming the session sentinel, so injection resumes on a later prompt once the graph is readable again. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::MAX_GRAPH_BYTES --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC7: skips a graph past the ceiling without spending the session sentinel) -->

**Constraints:**

- The size ceiling is a memory guard, not a latency one, and is overridable, so a graph that outgrows the default cannot silently disable injection.
- An implausible override falls back to the default, so the guard cannot be present and inert. <!-- @test: host/__tests__/memory-context-inject.test.js (AC7: an out-of-range numeric ceiling falls back instead of voiding the guard) --> <!-- @test: src/__tests__/lib/pi-memory-inject.test.ts (AC5: an injected ceiling is not outranked by the ambient environment) -->
- The hook plugin is advanced-session-only by manifest declaration (`preseed/agents/claude/manifest.json`); standard sessions never receive the plugin.
- The hook reads graph JSON directly.
- Claude and Pi carry separate implementations for differing injection surfaces, while the keyword rule, ranking weights, node cap, rendered shape and sentinel semantics are the same in both.
- The Pi side skips synthetic prompts, which the hook runtime never delivers.
- The hook is fail-safe: any error exits silently with no output; A failed injection must never block the session.
- Keyword extraction strips all non-alphanumeric characters and filters to words of 4+ characters to avoid noise.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-004](vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** Automated test ([memory-context-inject](../../host/__tests__/memory-context-inject.test.js))

**Status:** Implemented

---

### REQ-MEM-019: Post-compaction recall of recent session extracts

**Intent:** Compaction replaces the conversation with a summary while keeping the same session, so the first-prompt injection has already fired and never runs again. The agent then resumes from a summary of a summary, having lost the concrete decisions, corrections and identifiers of prior work — restating plans that were settled and to-do items that were finished. Recent session extracts are injected when a session resumes from compaction, so what was actually decided survives the boundary.

**Applies To:** Agent

**Acceptance Criteria:**

1. When a session resumes from compaction, the most recent session extracts are injected as additionalContext, newest first, bounded by a configurable count. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::EXTRACT_COUNT --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC1: injects the N most recent extracts newest-first as SessionStart context) -->
2. Recency is decided by the capture instant carried in the extract name rather than by modification time or by that name's text, so neither a file sync that rewrites timestamps nor a change of UTC offset can reorder or starve the selection. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::sort_key --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC2: orders by filename even when mtime disagrees) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC2: orders by captured instant across a UTC-offset change) -->
3. No context is injected for a session that did not resume from compaction, so sessions that never lost context pay nothing. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::SOURCE --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC3: stays silent unless the session started from compaction) -->
4. Each extract's complete rendered contribution—title, source path, section bodies, and any truncation marker—fits one UTF-8 byte budget. Both runtimes reserve the exact Source path before title/body bytes and omit a block when even minimal source metadata cannot fit. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::PER_FILE_BYTES --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall-helpers.ts::recallBlock --> <!-- @test: host/__tests__/memory-context-inject.test.js (REQ-MEM-019 AC4: charges title, multibyte source path, body, and marker to one extract budget) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (bounds complete Pi injection and recall output with multibyte metadata) -->
5. Content dropped by that bound is marked as truncated, with the exact multibyte source path retained so the remainder stays reachable. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh::PER_FILE_BYTES --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall-helpers.ts::recallBlock --> <!-- @test: host/__tests__/memory-context-inject.test.js (REQ-MEM-019 AC4: charges title, multibyte source path, body, and marker to one extract budget) --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (bounds complete Pi injection and recall output with multibyte metadata) -->
6. The Pi runtime covers the same boundary at its own compaction event, selecting and bounding the same extracts and delivering them as a message persisted in the session, and never inside a child session. <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::registerPostCompactionRecall --> <!-- @impl: preseed/agents/pi/extensions/post-compaction-recall.ts::buildRecall --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::captureFilenameAt --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (delivers the recall on compaction as a persisted follow-up) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (stays out of a child session) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC1: builds the digest newest-first, bounded by the extract count) --> <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC6: selects a filename produced by Pi capture alongside Claude extracts) -->

**Constraints:**

- Only the narrative and decision sections are injected; the rest is reachable through the emitted source path.
- Injected text is a record, not instructions.
- The hook plugin is advanced-session-only by manifest declaration; standard sessions never receive it.
- A heading inside a fenced block is content, not a section heading.
- The per-extract bound is a byte bound and is never exceeded; the truncation notice is spent from it and dropped when it cannot fit. <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC4: holds the bound even when the cap cannot fit the marker) --> <!-- @test: host/__tests__/post-compaction-recall.test.js (AC4: a nonsensical cap carries nothing rather than everything) -->
- Two extracts sharing a capture instant are ordered by name descending, so the two runtimes agree on a tie. <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (AC2: breaks a shared instant on the name, descending) -->
- Both runtimes are fail-safe: an error anywhere — including inside Pi's compaction dispatch — is swallowed with no output and never blocks the session. <!-- @test: src/__tests__/lib/pi-post-compaction-recall.test.ts (swallows a delivery failure instead of throwing into the compaction dispatch) -->
- Claude and Pi carry separate implementations for differing injection surfaces; the selection, bounds and injected wording are identical.

**Priority:** P1

**Dependencies:** [REQ-MEM-013](#req-mem-013-proactive-memory-injection-on-first-prompt)

**Verification:** Automated tests ([post-compaction-recall](../../host/__tests__/post-compaction-recall.test.js), [pi-post-compaction-recall](../../src/__tests__/lib/pi-post-compaction-recall.test.ts))

**Status:** Implemented

---

### REQ-MEM-014: Pi capture contract, transcript prefilter, and model-fidelity lever

**Intent:** Pi's memory-capture and vault-extract subagents must preserve the citation fidelity and prefiltered conversational arc established by the Claude memory plugin ([AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) parity) without inheriting Claude's multi-pass scratchpad cost. Pi extraction must cite REQ/ADR/SHA/PR identifiers verbatim and use a provider-neutral fidelity lever.

**Applies To:** User

**Acceptance Criteria:**

1. Pi ships a full capture-contract prompt file and a vault-extract prompt file, replacing the prior thin inline contract that the extension wrote at runtime. <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::pi-memory-capture-contract --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md::pi-vault-extraction-contract --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The Pi extension points its prompt-file constants at the deployed prompt files under `~/.pi/agent/prompts/` and no longer writes the prompt contracts inline. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::defaultDependencies --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. The seed generator maps `prompts/` source files to the deployed `~/.pi/agent/prompts/` location, and both prompt files are delivered advanced-only via the Pi manifest. <!-- @impl: scripts/agent-seed-core.mjs::piNativeKey --> <!-- @impl: preseed/agents/pi/manifest.json::prompts/memory-agent-prompt.md --> <!-- @test: src/__tests__/lib/agent-seed-multi-agent.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Capture input contains only uncaptured user/assistant text. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::compactMessages --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-001: compactMessages prefilter (AD58)) -->
5. Capture input is bounded by a fixed character budget, spent newest-first on user prompts before assistant turns, with each turn individually capped and its citation rescue bounded to a fixed reference count. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::selectTurns --> <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::capTurn --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-001: compactMessages prefilter (AD58)) -->
6. Each Pi capture/extract request includes the optional model from `CODEFLARE_MEMORY_MODEL` only when non-empty; when unset, no model name is hardcoded. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (builds one bounded medium-reasoning public background request) -->
7. Each Pi memory launch makes its immutable execution snapshot readable to the background child before exposing the public `subagent` request. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memoryExecutionVarsPath --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::sendDueExtractionMessages --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (creates work on the fiftieth real prompt and emits a visible reminder without private spawn) -->

**Notes:** Public delivery is documented in [AD102](../../documentation/decisions/README.md#ad102-pi-extraction-delivery-is-root-owned-visible-and-transactional). The execution profile is owned by [REQ-MEM-016](#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile) and [REQ-MEM-018](#req-mem-018-pi-extraction-agent-definitions-have-a-bounded-profile), and documented in [AD103](../../documentation/decisions/README.md#ad103-pi-extraction-agents-use-bounded-medium-reasoning-and-one-pass-inputs).

**Constraints:**

- The model-fidelity lever is the Pi-runtime expression of the [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) rationale; Claude pins the model at the subagent-definition level per [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) while Pi reads it from the environment so no model name is committed.
- The prefilter removes tool-use, tool-result, thinking, and synthetic directive content before capture.
- The successful prompt counter defines the start of the uncaptured interval.
- Pi delivery state is root-owned and transcript-derived, while Claude retains its hook carrier-file protocol.
- Memory execution snapshots use the shared home-backed cache.
- Active legacy temp snapshots migrate to the shared cache before retry.

**Priority:** P1

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-008](#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline)

**Verification:** Automated test ([Public request lifecycle tests](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts), [generated agent contract tests](../../src/__tests__/lib/agent-seed-multi-agent.test.ts))

**Status:** Implemented

---

<a id="req-mem-016-vault-extraction-runs-on-bounded-one-pass-inputs"></a>
### REQ-MEM-016: Pi extraction requests have a bounded execution profile

**Intent:** Pi memory and Vault extraction requests must finish as bounded background jobs without inheriting an open-ended foreground execution profile.

**Applies To:** Agent

**Acceptance Criteria:**

1. Every emitted Pi capture/extract request disables inherited context. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-016: builds one bounded medium-reasoning public background request) -->
2. Every emitted Pi capture/extract request uses provider-neutral medium reasoning. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-016: builds one bounded medium-reasoning public background request) -->
3. Every emitted Pi capture/extract request stops after seven agent turns, bounding retries while leaving room to page larger 50-prompt and Vault inputs under tool-output limits. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildPublicExtractionRequest --> <!-- @test: src/__tests__/lib/pi-memory-vault-delivery.test.ts (REQ-MEM-016: builds one bounded medium-reasoning public background request) -->

**Constraints:**

- Memory capture treats the immutable snapshot's `transcript` field as its sole conversation input and does not discover an `INPUT_FILE` or separate transcript path.
- Vault extraction reads only its request snapshot and frozen input files.
- Model identity remains independently configurable through `CODEFLARE_MEMORY_MODEL`.

**Priority:** P1

**Dependencies:** [REQ-MEM-014](#req-mem-014-pi-capture-contract-transcript-prefilter-and-model-fidelity-lever)

**Verification:** Automated test ([Generated agent contract tests](../../src/__tests__/lib/agent-seed-pi-memory.test.ts), [public request lifecycle tests](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts))

**Status:** Implemented

---

<a id="req-mem-018-background-extraction-agents-are-bounded-and-visible"></a>
### REQ-MEM-018: Pi extraction agent definitions have a bounded profile

**Intent:** Generated Pi memory and Vault extraction agent definitions expose only the tools and reasoning profile required by their bounded background work.

**Applies To:** Agent

**Acceptance Criteria:**

1. Generated Pi memory-capture and vault-extract agent definitions expose only Bash. <!-- @impl: scripts/agent-seed-core.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-018: Pi extraction agents expose bounded frontmatter (native + transformed)) -->
2. Generated Pi memory-capture and vault-extract agent definitions use provider-neutral medium reasoning. <!-- @impl: scripts/agent-seed-core.mjs::adaptAgentFrontmatter --> <!-- @test: src/__tests__/lib/agent-seed-pi-memory.test.ts (REQ-MEM-018: Pi extraction agents expose bounded frontmatter (native + transformed)) -->

**Constraints:**

- Memory capture treats the immutable snapshot's `transcript` field as its sole conversation input and does not discover an `INPUT_FILE` or separate transcript path.
- Vault extraction reads only its request snapshot and frozen input files.
- Model identity remains independently configurable through `CODEFLARE_MEMORY_MODEL`.

**Priority:** P1

**Dependencies:** [REQ-MEM-016](#req-mem-016-pi-extraction-requests-have-a-bounded-execution-profile)

**Verification:** Automated test ([Generated agent contract tests](../../src/__tests__/lib/agent-seed-pi-memory.test.ts), [public request lifecycle tests](../../src/__tests__/lib/pi-memory-vault-delivery.test.ts))

**Status:** Implemented

---

### REQ-MEM-017: Session memory graph identity is deterministic

**Intent:** Repeated Pi session capture must produce stable graph identities and evidence for the same note content.

**Applies To:** System

**Acceptance Criteria:**

1. A session document node uses the note H1 as its label. <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph --> <!-- @test: host/__tests__/pi-memory-graph-builder.test.js (REQ-MEM-017: session graph uses its title, canonical concepts, and unique edges) -->
2. A session document node uses a stable identifier derived from its Vault-relative path. <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph --> <!-- @test: host/__tests__/pi-memory-graph-builder.test.js (REQ-MEM-017: session graph uses its title, canonical concepts, and unique edges) -->
3. Repeated references to the same concept label produce one canonical concept identifier. <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph --> <!-- @test: host/__tests__/pi-memory-graph-builder.test.js (REQ-MEM-017: session graph uses its title, canonical concepts, and unique edges) -->
4. Exact duplicate source/target/relation/source-file edges collapse to one edge. <!-- @impl: preseed/agents/pi/scripts/build-memory-graph.py::build_graph --> <!-- @test: host/__tests__/pi-memory-graph-builder.test.js (REQ-MEM-017: session graph uses its title, canonical concepts, and unique edges) -->

**Constraints:**

- The generated advanced Pi seed carries the same graph-builder source as the canonical preseed.
- Graph output remains compatible with the cumulative Vault merge path.

**Priority:** P1

**Dependencies:** [REQ-MEM-009](#req-mem-009-vault-graph-accumulates-monotonically-across-extractions)

**Verification:** Automated test ([Session graph behavior and generated-seed parity](../../host/__tests__/pi-memory-graph-builder.test.js))

**Status:** Implemented

---
