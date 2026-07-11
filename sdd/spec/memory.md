# Memory

Vault-based cross-session memory, automatic capture, hook delivery, and session-mode gating.

**Domain owner:** vault subsystem, entrypoint.sh, memory-capture.sh, preseed pipeline

### Key Concepts

- **Vault** -- The persistent per-user vault directory. Single source of truth for cross-session memory; holds agent-written session captures plus user-curated notes, inbox, and journal entries. Attachment uploads land next to the note that referenced them. Bisynced to R2 so the vault survives across sessions.
- **Unified Graph** -- The merged graph combining the vault's graph with every active repo's per-repo graph; merges are hash-keyed. Queryable through the graphify MCP surface so structural questions can span all sources in a single call.
- **Capture** -- A background subagent runs every fifteen real user messages, prefilters the transcript to strip tool I/O, chunks the remainder, accumulates per-chunk observations, synthesises a markdown capture file into the vault's raw-sessions subdirectory, and merges the resulting subgraph into the unified graph under a shared multi-writer lock so concurrent writers cannot corrupt it.
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

1. A UserPromptSubmit hook injects a short capture instruction into the active agent context on each trigger. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CONTEXT --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->
2. Only real user messages are counted; tool results and synthetic agent-generated messages are excluded from the count. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::COUNTER_DIR --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-MEM-001 AC2: real-user prompt counting matches Claude synthetic-wrapper filtering) -->
3. When triggered, a background sonnet subagent runs the three-stage capture pipeline (prefilter transcript noise, accumulate per-chunk observations, synthesise the final note) and writes the capture file into the vault's session-captures folder. <!-- @test: host/__tests__/memory-capture-pipeline.test.js (prefilter-transcript.sh (REQ-MEM-001 AC3) / REQ-VAULT-002 (conversation captures land in vault as markdown)) -->
4. Capture-file timestamps reflect the user's local timezone, resolved per [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC4.
5. The capture file uses a YAML frontmatter template with session, capture-time, and capture-range fields followed by Context / Decisions / Observations / References sections. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->
6. Extracted chunks merge serially and atomically into cumulative `vault-graph.json`, then into the global graph under `user_vault`, making new content queryable in the same turn. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The hook runs in approximately 150ms (lightweight shell script, no heavy processing).
- Memory capture requires advanced session mode (the hook, plugin, and memory rule are only preseeded in advanced mode).
- The capture agent is sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad), pinned at the subagent-definition level so the dispatching parent cannot silently downgrade the model.
- The capture agent itself is the LLM that produces the extracted graph (the upstream headless extract CLI is not invoked) to avoid duplicating inference cost.
- The capture subagent carries Bash and context-mode execution tools and uses whichever surface the session permits, so shell-routing gates cannot abort capture.
- Claude reads the hook-provided transcript JSONL range; Pi reads message entries from the persisted session returned by `getSessionFile()`.
- Both runtimes skip capture when the resolved transcript is empty.

**Priority:** P0

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-MEM-015: Pi Memory Capture Transcript Source and Child-Session Guard

**Intent:** Pi memory capture must read the durable session transcript and stay inert inside child subagent sessions so captures survive reloads without polluting monitor or capture transcripts.

**Applies To:** User

**Acceptance Criteria:**

1. Capture reads each runtime's durable resume transcript, never volatile memory, so reload and resume retain full history; an empty resolved transcript skips capture instead of writing a placeholder. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::default --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->
2. Pi capture triggers are inert inside subagent child sessions — sessions whose header carries a parent-session pointer (review monitors, CI monitors, capture/extract subagents themselves, which always load the parent's extensions) — so a background task's transcript never receives an injected capture follow-up as its visible output. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::isChildSession --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-MEM-001/REQ-VAULT-003: memory-vault handlers are inert inside subagent child sessions) -->

**Constraints:**

- Pi reads its persisted session file via `getSessionFile()` and skips capture when the resolved transcript is empty.
- Child-session detection is header-based and applies to review monitors, CI monitors, capture subagents, and extract subagents.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing)

**Verification:** [Pi behavioral tests](../../src/__tests__/lib/agent-seed-manifest.test.ts), [child-session guard tests](../../src/__tests__/lib/pi-child-session-guard.test.ts), and [session JSONL fuzz coverage](../../src/__tests__/fuzz/vault-migration.fuzz.test.ts).

**Status:** Implemented

---

### REQ-MEM-002: Capture triggers every 15 user messages

**Intent:** Memory capture must fire at a regular interval to balance context freshness against overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tracks the number of user messages since the last capture using a per-session counter file. The counter directory defaults to `/tmp/.memory-counter/` and is overridable via the `MEMCAP_COUNTER_DIR` environment variable for hermetic tests. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 15 user messages)) -->
2. A first run with exactly one user prompt initializes transcript baseline and counter, injects the first-message graph-query directive, and exits without capture. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CONTEXT --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)) -->
3. If the counter file exists and the delta since the last capture is less than 15 messages, the hook exits silently. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 15 user messages)) -->
4. When the delta reaches 15, the capture subagent is triggered. <!-- @test: host/__tests__/memory-capture-hook.test.js (counter advances on capture so the next run starts a fresh window) -->
5. Duplicate capture triggers are suppressed while a capture is pending. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memoryVarsPending --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. Pi advances the prompt counter only after the capture note exists, so a stopped capture retries instead of marking the window complete. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::captureVars --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-MEM-002 AC6: Pi capture counter advances only after a capture note exists) -->
7. When the hook fires with no counter file and the transcript already contains more than one real-user prompt (CURRENT_COUNT > 1), it treats the session as resumed: it force-fires a capture covering the transcript from line 1 and re-emits the graph-query directive ([REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC3). <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::CONTEXT --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The counter file MUST live under an ephemeral path (default `/tmp/.memory-counter/`).
- `CURRENT_COUNT` alone distinguishes first runs: 1 means a brand-new transcript containing only the submitted prompt; greater values mean prior prompts persisted from a resumed session.
- Detection uses no timestamps, mtimes, or external sentinels.
- The hook does not detect in-session `/compact`; its surviving counter catches up within the 15-prompt window while the compressed summary preserves orientation.
- This remains an accepted limitation pending observed harm.
- On Pi, the `.vars` carrier file is the pending-capture lock and stale retry marker.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)

**Verification:** Manual check

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

**Verification:** [Behavioral test](../../host/__tests__/entrypoint-rclone-filters.test.js)

**Status:** Implemented

---

### REQ-MEM-006: Memory available only in Pro (Advanced) mode

**Intent:** Vault persistence and automatic capture are user-facing features gated behind the advanced session mode. This REQ specifies the observable behavior (what works in each mode) and the preseed delta (which files differ between modes). The storage/resolution/propagation of the mode value lives in [REQ-MEM-011](#req-mem-011-session-mode-storage-resolution-and-propagation).

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, the vault directory is not preserved across container recreations: the R2 sync filters include the Vault tree only in advanced mode and explicitly exclude it in default mode, so cross-session persistence is limited to advanced-mode sessions. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (entrypoint.sh rclone filter behavior (real) / REQ-MEM-004 (vault in R2 sync) / REQ-MEM-006 (advanced-only) / REQ-VAULT-001 (vault filter order) / REQ-STOR-004 (static excludes)) -->
2. In default mode, the capture hook still runs the in-session counter logic but vault writes are local-only. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::COUNTER_DIR --> <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)) -->
3. The memory plugin, the memory rule (which carries the folded vault trigger/route content), the vault plugin, and the vault-note-capture rule are preseeded only in advanced mode. <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3: memory + vault rules and plugins are advanced-only / REQ-SUB-014 (session mode gating by tier: advanced-only preseed content delivered only to tiers permitting advanced mode)) -->
4. Pro mode seeds a strict superset of Standard's preseed files; the memory and vault plugins/rules are part of the Pro-only delta. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json / REQ-VAULT-007 (vault rules and plugin preseeded into every advanced session) / REQ-AGENT-006 (preseed generated from manifest.json + generate-agent-seed.mjs into agent-seed.generated.ts as single source of truth) / REQ-AGENT-014 (manifest declares modes per preseed key; default subset is strict subset of advanced)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Plugin registration is not removed on mode downgrade; missing plugin files are silently skipped at runtime.

**Priority:** P1

**Dependencies:** [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

**Intent:** Memory capture prompt files must be deployed alongside the rest of the preseed content through the standard manifest pipeline.

**Applies To:** User

**Acceptance Criteria:**

1. The capture prompt is preseeded into the session-installed memory plugin alongside its scripts. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The memory plugin's scripts (hook, prompt, prefilter) and the capture subagent definition (pinned to sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)) are all delivered via the manifest pipeline that seeds named subagents like architect and code-reviewer ([REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start)). <!-- @impl: preseed/agents/claude/manifest.json::modes --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. All memory-plugin entries are marked advanced-only in the manifest. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. The hook script is delivered via the plugin but registered via the session settings merge, not the plugin loader. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
5. Memory-plugin source lives in the single preseed source tree. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
6. A build-time seed generator produces the runtime payload consumed by the Worker; memory-plugin files appear in that payload. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
7. Claude memory plugin files are not generically adapted for non-Claude agents. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- Plugin files are updated when the pipeline is redeployed and users explicitly recreate their preseed.
- Only files listed in the manifest are included in the generated payload.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-MEM-009: Vault graph accumulates monotonically across extractions

**Intent:** Every vault writer - the vault-extract and memory-capture pipelines, on both the Claude and Pi runtimes - must add new nodes to the unified global graph's vault contribution without destroying nodes from prior passes. All four converge on a single cumulative `vault-graph.json` maintained by the shared `merge-vault-graph.py`; `--as user_vault` replace-semantics means anything less than the cumulative graph fed to `graphify global add` wipes prior vault knowledge.

**Applies To:** User

**Acceptance Criteria:**

1. Every vault writer maintains a single persistent incremental vault graph (`vault-graph.json`) that survives across passes; both the vault-extract and memory-capture pipelines on both runtimes author a chunk and fold it in via the shared `merge-vault-graph.py` rather than editing `graph.json` in place. <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC1: script writes the cumulative vault graph back to vault_graph_path as the to_json path argument) -->
2. Each pass merges the new chunk's nodes/edges into the persistent graph using a hash-keyed union (existing IDs dedupe, new IDs append). <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC2: script unions the prior + new graphs via nx.compose (hash-keyed dedup)) -->
3. The global graph's vault contribution always reflects the cumulative vault content (the persistent `vault-graph.json` is fed to `graphify global add --as user_vault`, never the per-run chunk or `graph.json`), not only the most recent pass. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (REQ-VAULT-016 / REQ-MEM-009: Pi vault-extract + memory prompts build the cumulative vault graph via the Pi-local merge-vault-graph.py) -->
4. If the persistent vault graph is missing or unreadable, the pass starts a fresh one rather than crashing and writes it at the end of the run. <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC1: script writes the cumulative vault graph back to vault_graph_path as the to_json path argument) -->
5. Vault graph merges are serialised with capture-pipeline writes and active-repo hooks; a short timeout prevents indefinite blocking if the lock holder crashes (matching [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) AC7). <!-- @test: host/__tests__/vault-extract-merge.test.js (REQ-MEM-009 AC1: script writes the cumulative vault graph back to vault_graph_path as the to_json path argument) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- No HTML visualization is generated for the unified global graph; structural queries are the interface; Only the curated vault subset receives a rendered visualization shipped to users.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) (capture pipeline contract), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown) (vault is always-on in the global graph)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-MEM-010: Memory capture hook plumbing

**Intent:** Capture timestamps reflect the user's local timezone, the hook fires reliably regardless of path format or session state, and a fabrication-resistant timestamp assertion fails closed if the subagent guesses the timestamp instead of producing a real one.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tolerates tilde-prefixed transcript paths. <!-- @test: host/__tests__/memory-capture-hook.test.js (expands ~ in transcript_path to $HOME) -->
2. Variables shared between the hook and the capture subagent are passed via a small carrier file rather than inline context. <!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture.sh - input gating / REQ-MEM-002 (capture triggers every 15 user messages)) -->
3. On the first message of a session, the hook injects a graph-query directive instructing the agent to consult the unified graph before responding. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh::DELTA --> <!-- @test: host/__tests__/memory-capture-hook.test.js (AC7 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)) -->
4. The hook resolves the capture timezone from the user preference ([REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)), falling back to the container default and finally to UTC. <!-- @test: src/__tests__/container/container-env.test.ts (buildEnvVars (REQ-SESSION-016 AC3) / REQ-MEM-010 AC4 (USER_TIMEZONE feeds capture pipeline) / REQ-AGENT-031 (LLM API keys + agent-specific keys propagated to container env)) -->
5. The capture timestamp is validated against the current wall clock and rejected if fabricated, missing a timezone offset, or mismatching the resolved timezone. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (assert-iso-ts.sh / REQ-MEM-010 AC5+AC6+AC7) -->
6. A timestamp whose offset does not match the resolved timezone is rejected; this catches dropped-timezone-wrapper bugs without false-positiving legitimately-UTC hosts. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (AC6 #416 regression: Europe/Zurich + ISO_TS ending in +0000 rejected) -->
7. A timestamp more than 30 seconds away from the current wall clock is rejected. Any assertion failure halts the capture rather than writing a confabulated timestamp to the vault. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh::RESOLVED --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (AC7 freshness drift: a year-old fabricated timestamp rejected) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The carrier file acts as the dedup gate: the capture subagent must delete it as its first step; absence on subsequent hook fires short-circuits trigger emission.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-MEM-011: Session-mode storage, resolution, and propagation

**Intent:** The mechanics behind the user-observable behavior in [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode): how the mode value is stored, defaulted, clamped against the billing tier, propagated into `settings.json`, and reconciled into the preseed file set without trampling user content.

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, only baseline agent permissions are applied; capture hooks are not registered. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration / REQ-AGENT-015 (/review command)) -->
2. If no session mode has been explicitly set, the default mode applies. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode / REQ-AGENT-004 (two session modes: default and advanced; default when prefs unset; honors persisted sessionMode)) -->
3. Mode changes take effect only on explicit "Recreate AI agent skills & rules" click or new bucket creation. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (REQ-MEM-011 AC3: reconcileAgentConfigs gated on the new-bucket trigger) -->
4. On a mode change, preseed files are reconciled to match the new mode: mode-appropriate files are written, preseed-managed files not in the new mode are removed, and user-created files are never modified. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/preferences.test.ts (sessionMode preference / REQ-MEM-011 (sessionMode preference persistence + preseed reconciliation)) -->

**Constraints:**

- Existing users are unaffected by mode changes until they explicitly recreate.
- A billing-canceled user's stored session mode is downgraded to default at resolution time.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** [Integration test](../../host/__tests__/entrypoint-hooks-merge.test.js)

**Status:** Implemented

---

### REQ-MEM-012: Hard-block tool calls while memory-capture is deferred

**Intent:** The capture directive emitted by [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)'s hook is advisory: an agent that ignores it leaves the dedup-gate undrained, and the 15-message threshold logic only fires fresh directives on threshold crossings, so a long session can silently pass with zero captures. A companion hard-block hook closes this gap: every tool call other than the memory-capture subagent itself is blocked while a deferred capture is pending, forcing the agent to drain the deferred work before doing anything else. The block has no bypass surface and clears naturally when the subagent runs.

**Applies To:** Agent

**Acceptance Criteria:**

1. The block hook intercepts every tool call in advanced session mode only. When no deferred capture is pending for the current session (the common case), the hook exits silently and the tool call proceeds. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-capture-block.test.js (memory-capture-block.sh - common path / REQ-MEM-012 AC1) -->
2. When the hook input is missing a session identifier (defensive guard for malformed envelopes), the hook exits silently rather than blocking. <!-- @test: host/__tests__/memory-capture-block.test.js (memory-capture-block.sh - input gating / REQ-MEM-012 AC2) -->
3. When a deferred capture is pending AND the tool call is anything other than the permitted memory-capture subagent invocation, the hook blocks the call; the block message instructs the agent to run the memory-capture subagent and points at the persisted prompt and carrier files. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-capture-block.test.js (block stderr contains spawn directive with PROMPT_FILE and VARS_FILE paths) -->
4. Only an invocation of the memory-capture subagent is permitted to proceed while a deferred capture is pending; any other subagent invocation is blocked under AC3. The block clears automatically the moment the subagent runs and removes the carrier file. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh::PROMPT_FILE --> <!-- @test: host/__tests__/memory-capture-block.test.js (memory-capture-block.sh - subagent allowlist / REQ-MEM-012 AC4) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The block applies only in advanced session mode.
- If a carrier file is stale beyond recovery, the user clears it manually; there is no in-hook bypass surface.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-MEM-013: Proactive memory injection on first prompt

**Intent:** The agent receives relevant prior context (vault notes, code concepts, past decisions) automatically on the first user message of each session, without requiring an explicit tool call. Keywords are extracted from the user's prompt and matched against the unified graphify graph; matched nodes are injected as additionalContext in the hook response so the agent sees them before responding.

**Applies To:** Agent

**Acceptance Criteria:**

1. On the first user message of a session, the hook extracts keywords from the prompt and queries the unified graph for matching nodes. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC1: injects matched nodes from global graph on first prompt) -->
2. Matched nodes (up to 10, ~1000 tokens) are injected as additionalContext in the UserPromptSubmit hook response. <!-- @test: host/__tests__/memory-context-inject.test.js (AC2: injects at most 10 nodes even when more match) -->
3. The hook fires at most once per session (gated by its own atomic mkdir sentinel, claimed only after a successful graph query; independent of the memory-capture counter). <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh::COUNTER_DIR --> <!-- @test: host/__tests__/memory-context-inject.test.js (AC3: fires at most once per session (sentinel directory prevents re-fire)) -->
4. Prompts shorter than 20 characters are skipped (insufficient signal for keyword extraction). <!-- @test: host/__tests__/memory-context-inject.test.js (AC4: skips prompts shorter than 20 characters) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The hook plugin is advanced-session-only by manifest declaration (`preseed/agents/claude/manifest.json`); standard sessions never receive the plugin.
- The hook reads the graph JSON directly (no MCP round-trip).
- The hook is fail-safe: any error exits silently with no output; A failed injection must never block the session.
- Keyword extraction strips all non-alphanumeric characters and filters to words of 4+ characters to avoid noise.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-004](vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** Manual check

**Status:** Implemented

---

### REQ-MEM-014: Pi capture contract, transcript prefilter, and model-fidelity lever

**Intent:** Pi's memory-capture and vault-extract subagents must follow the same full capture contract as the Claude memory plugin ([AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) parity) - chunk the transcript, accumulate per-chunk observations, synthesise a structured note, and cite REQ/ADR/SHA/PR identifiers verbatim - rather than the thin inline contract Pi previously carried. The transcript handed to the capture agent must be prefiltered to preserve the conversational arc, and the capture/extract agents must be able to run on a higher-fidelity model without a hardcoded model name.

**Applies To:** User

**Acceptance Criteria:**

1. Pi ships a full capture-contract prompt file and a vault-extract prompt file, replacing the prior thin inline contract that the extension wrote at runtime. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
2. The Pi extension points its prompt-file constants at the deployed prompt files under `~/.pi/agent/prompts/` and no longer writes the prompt contracts inline. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::default --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
3. The seed generator maps `prompts/` source files to the deployed `~/.pi/agent/prompts/` location, and both prompt files are delivered advanced-only via the Pi manifest. <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->
4. Before the transcript is handed to the capture agent, it is prefiltered to user and assistant text only - tool-use, tool-result, and thinking blocks are dropped - bounded to the last 200 turns at up to 8000 characters per turn, replacing the prior raw last-40-message JSON slice. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::compactMessages --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests (REQ-MEM-001/002/010, REQ-VAULT-003/004)) -->
5. The capture/extract subagent spawn accepts an optional model argument sourced from `CODEFLARE_MEMORY_MODEL`; when unset, no model name is hardcoded. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildSpawnOptions --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory model-fidelity lever / REQ-MEM-014 AC5/AC6 (buildSpawnOptions applies the model only when set; no hardcoded model)) -->
6. The Pi memory-capture agent runs in the background so main-session work cannot cancel it. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildSpawnOptions --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (multi-agent documents / REQ-MEM-008 (memory plugin: advanced-only, four files, CC-only) / REQ-AGENT-007 (multi-agent adaptation pipeline: per-agent generation, tool name remap, frontmatter rewrite, model field removal, path rewrites, extension changes, exclusion lists) / REQ-AGENT-030 (per-agent adaptation: skills/agent files generated into the right per-agent prefix with the right shape)) -->

**Notes:** Manual verification procedures are documented in the [architecture checklist](../../documentation/lanes/architecture.md#manual-verification-checklist).

**Constraints:**

- The model-fidelity lever is the Pi-runtime expression of the [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) rationale (capture must cite identifiers verbatim, which benefits from a higher-fidelity model); Claude pins the model at the subagent-definition level per [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) while Pi reads it from the environment so no model name is committed.
- The prefilter mirrors the Claude prefilter rationale (drop tool/recency noise, preserve the conversational arc); it does not change the capture cadence or the dedup-gate carrier-file protocol.

**Priority:** P1

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-008](#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline)

**Verification:** Manual check

**Status:** Implemented
