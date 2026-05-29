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

- **Vault** -- Capture writes (REQ-MEM-001) and global-graph merges depend on the vault skeleton and graph infrastructure from the Vault domain.
- **Storage** -- R2 sync of the vault (REQ-MEM-004) depends on the bisync infrastructure from the Storage domain.
- **Agents** -- Preseed delivery (REQ-MEM-008) depends on the preseed pipeline from the Agents domain.
- **Subscription** -- Mode gating (REQ-MEM-006) depends on effective tier resolution and tier-allowed-session-modes from the Subscription domain.

---

### REQ-MEM-001: Conversation context automatically captured to vault

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/prefilter-transcript.sh -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts -->
<!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md -->
<!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture.sh - user-message counting describe -> counts only real user prompts excluding tool_results and command wrappers -> AC2) -->
<!-- @test: host/__tests__/memory-capture-pipeline.test.js (prefilter-transcript.sh describe -> AC3 strips tool I/O and chunks remainder -> AC3) -->
<!-- @test: host/__audits__/memory-capture-prompt.audit.js (memory-agent-prompt.md contract describe -> inline graph construction Python step -> AC6) -->
<!-- @test: host/__audits__/memory-capture-prompt.audit.js (memory-agent-prompt.md contract describe -> flock + graphify global add merge step -> AC7) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault behavioral tests -> REQ-MEM-001 captureTimestamp AC4, compactMessages AC3, flock global merge AC7) -->

**Intent:** Important conversation context (decisions, debugging insights, observations) must be extracted from the transcript and persisted to the vault without manual intervention. This REQ covers the hook trigger, message-counting filter, and the capture pipeline. Hook plumbing (tilde expansion, vars file shape, first-message graphify hint, timezone resolution) is split into [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing).

**Applies To:** User

**Acceptance Criteria:**

1. A UserPromptSubmit hook injects a short capture instruction into the active agent context on each trigger.
2. Only real user messages are counted; tool results and synthetic agent-generated messages are excluded from the count.
3. When triggered, a background sonnet subagent runs the three-stage capture pipeline (prefilter transcript noise, accumulate per-chunk observations, synthesise the final note) and writes the capture file into the vault's session-captures folder.
4. Capture-file timestamps reflect the user's local timezone, resolved per [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC4.
5. The capture file uses a YAML frontmatter template with session, capture-time, and capture-range fields followed by Context / Decisions / Observations / References sections.
6. Graph nodes and edges are extracted from the rendered capture and merged into the unified global graph.
7. The merge into the unified global graph is serialised and atomic, so the new content is queryable on the same turn it is written.

**Constraints:**

- The hook runs in approximately 150ms (lightweight shell script, no heavy processing).
- Memory capture requires advanced session mode (the hook, plugin, and memory rule are only preseeded in advanced mode).
- The capture agent is sonnet per AD58, pinned at the subagent-definition level so the dispatching parent cannot silently downgrade the model.
- The capture agent itself is the LLM that produces the extracted graph (the upstream headless extract CLI is not invoked) to avoid duplicating inference cost.

**Priority:** P0

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** [Integration test](../../host/__tests__/memory-capture-hook.test.js)

**Status:** Implemented

---

### REQ-MEM-010: Memory capture hook plumbing

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts -->
<!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture-hook describe → tilde expansion + .vars schema + first-message graphify directive + timezone fallback chain → AC1-AC4) -->
<!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (assert-iso-ts.sh describe → happy paths UTC + Europe/Zurich + offset-shape rejection → AC5) -->
<!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (assert-iso-ts.sh describe → Europe/Zurich + ISO_TS ending in +0000 rejected → AC6) -->
<!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (assert-iso-ts.sh describe → year-old fabricated timestamp rejected for >30s drift → AC7) -->

**Intent:** Capture timestamps reflect the user's local timezone, the hook fires reliably regardless of path format or session state, and a fabrication-resistant timestamp assertion fails closed if the subagent guesses the timestamp instead of producing a real one.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tolerates tilde-prefixed transcript paths.
2. Variables shared between the hook and the capture subagent are passed via a small carrier file rather than inline context.
3. On the first message of a session, the hook injects a graph-query directive instructing the agent to consult the unified graph before responding.
4. The hook resolves the capture timezone from the user preference (REQ-SESSION-016), falling back to the container default and finally to UTC.
5. The capture timestamp is validated against the current wall clock and rejected if fabricated, missing a timezone offset, or mismatching the resolved timezone.
6. A timestamp whose offset does not match the resolved timezone is rejected; this catches dropped-timezone-wrapper bugs without false-positiving legitimately-UTC hosts.
7. A timestamp more than 30 seconds away from the current wall clock is rejected. Any assertion failure halts the capture rather than writing a confabulated timestamp to the vault.

**Constraints:**

- The carrier file acts as the dedup gate: the capture subagent must delete it as its first step; absence on subsequent hook fires short-circuits trigger emission.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** [Automated test](../../host/__tests__/memory-capture-hook.test.js)

**Status:** Implemented

---

### REQ-MEM-002: Capture triggers every 15 user messages

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts -->
<!-- @test: host/__tests__/memory-capture-hook.test.js (input gating + first-run baseline + AC6 resume detection + 15-msg threshold + counter advance + tilde expansion + output protocol → AC1-AC6; AC6 covered by `AC6 - missing counter + transcript with >1 prompt force-fires capture from line 1` and `AC6 boundary - missing counter + transcript with exactly 1 prompt is brand-new (no capture)`) -->
<!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (describe `memory-capture counter location (REQ-MEM-002 AC6)` → asserts obsolete .memory/counter bisync filter absent, obsolete mkdir absent, MEMCAP_COUNTER_DIR default = /tmp/.memory-counter) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (isFirstMessage AC2 brand-new session + isResumedSession AC6 resume detection + shouldCapture 15-msg cadence -> AC2/AC5/AC6 Pi behavioral coverage) -->

**Intent:** Memory capture must fire at a regular interval to balance context freshness against overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tracks the number of user messages since the last capture using a per-session counter file. The counter directory defaults to `/tmp/.memory-counter/` and is overridable via the `MEMCAP_COUNTER_DIR` environment variable for hermetic tests.
2. On the first run for a session whose transcript contains exactly one real-user prompt (CURRENT_COUNT == 1), the hook treats this as a brand-new session: it initialises a baseline at the current transcript size, writes the counter, injects the first-message graph-query directive ([REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC3), and exits without triggering capture.
3. If the counter file exists and the delta since the last capture is less than 15 messages, the hook exits silently.
4. When the delta reaches 15, the capture subagent is triggered.
5. The counter is advanced before the trigger emits, preventing re-triggering on subsequent hook invocations within the same window.
6. **Resume detection via ephemeral counter:** the counter file is stored under `/tmp`, which by Cloudflare Containers contract ("All disk is ephemeral. When a Container instance goes to sleep, the next time it is started, it will have a fresh disk as defined by its container image.") is guaranteed empty on every container start. In codeflare every session start or resume is a complete container recycle, so the counter file's absence on the first hook fire is the canonical "fresh container" signal. When the hook fires with no counter file AND the transcript already contains more than one real-user prompt (CURRENT_COUNT > 1), the hook treats the session as resumed: it force-fires a capture covering the transcript from line 1 (so any tail from the prior session that never reached the 15-prompt boundary is flushed into the vault graph) and re-emits the graph-query directive from [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC3, because the agent's in-context recall of prior decisions is gone after the recycle.

**Constraints:**

- The counter file MUST live under an ephemeral path (default `/tmp/.memory-counter/`) so that its presence/absence reliably encodes "fresh container instance vs. mid-session continuation". Persisting the counter under `$HOME` or any R2-synced path would defeat resume detection.
- The two first-run sub-cases (brand-new vs. resumed) are distinguished entirely by `CURRENT_COUNT`: a value of 1 means the just-submitted prompt is the only one in the transcript (brand-new); a value greater than 1 means a prior session's prompts persisted in the transcript (resumed). No timestamps, mtimes, or external sentinels are involved.
- The in-session `/compact` case (same container, same PID, counter survives) is not detected by this hook; the 15-prompt cadence catches up within one window, and the compressed summary left by `/compact` keeps the agent oriented in the meantime. Documented as a known limitation; revisit if observed to bite in practice.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)

**Verification:** [Automated test](../../host/__tests__/memory-capture-hook.test.js)

**Status:** Implemented

---

### REQ-MEM-004: Vault contents synced to R2 across sessions

<!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON -->
<!-- @impl: entrypoint.sh::init_user_vault -->
<!-- @impl: entrypoint.sh::bisync_with_r2 -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (vault bisync filter describe -> explicitly includes Vault before graphify-out exclude -> AC1) -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (vault boot ordering describe -> establish_bisync_baseline precedes init_user_vault call -> AC2) -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (vault boot ordering describe -> init_user_vault guards file creation with existence checks -> AC3) -->
<!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (bisync daemon behavior describe -> cadence trigger + SIGUSR1 trigger -> AC4) -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (vault bisync filter describe -> excludes .graphify from bisync -> AC5) -->
<!-- @test: host/__audits__/entrypoint-vault.audit.js (shutdown bisync reliability describe -> 120s watchdog 108s SIGTERM + 12s SIGKILL -> AC6) -->

**Intent:** Vault content (agent captures + user notes) must persist across container lifecycles by syncing to the user's R2 bucket.

**Applies To:** User

**Acceptance Criteria:**

1. In advanced mode, the user's vault directory (including its own graph output) is included in R2 sync.
2. On container boot, the vault is pulled from R2 before any initialization runs so returning sessions inherit their persisted content untouched.
3. Vault directory initialization is idempotent; re-running on a populated vault creates nothing.
4. Vault changes are pushed back to R2 on three triggers: the regular sync cadence ([REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), the Sync-now button ([REQ-STOR-015](storage.md#req-stor-015-explicit-sync-trigger-from-ui)), and the final shutdown bisync ([REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync)).
5. The ephemeral unified-graph layer is rebuilt locally on every container boot and is not synced.
6. The shutdown handler watchdog allows the final bisync up to 120s to drain pending writes before forced termination.

**Constraints:**

- Vault and ordinary workspace content are synced; transient memory-counter files are not.
- R2 sync must be reliable under multipart-upload conditions without checksum metadata.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-001](vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** [Structural audit](../../host/__audits__/entrypoint-vault.audit.js)

**Status:** Implemented

---

### REQ-MEM-006: Memory available only in Pro (Advanced) mode

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (REQ-MEM-006 AC3 describe -> memory + vault rules and plugins are advanced-only -> AC3) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json describe -> "advanced" is a superset of "default" -> AC4) -->

**Intent:** Vault persistence and automatic capture are user-facing features gated behind the advanced session mode. This REQ specifies the observable behavior (what works in each mode) and the preseed delta (which files differ between modes). The storage/resolution/propagation of the mode value lives in [REQ-MEM-011](#req-mem-011-session-mode-storage-resolution-and-propagation).

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, the vault directory is not preserved across container recreations (sync filters limit cross-session persistence to advanced-mode sessions).
2. In default mode, the capture hook still runs the in-session counter logic but vault writes are local-only.
3. The memory plugin, the memory rule (which carries the folded vault trigger/route content), the vault plugin, and the vault-note-capture rule are preseeded only in advanced mode.
4. Pro mode seeds a strict superset of Standard's preseed files; the memory and vault plugins/rules are part of the Pro-only delta.

**Constraints:**

- Plugin registration is not removed on mode downgrade; missing plugin files are silently skipped at runtime.

**Priority:** P1

**Dependencies:** [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** [Integration test](../../src/__tests__/lib/pro-mode-gating.test.ts)

**Status:** Implemented

---

### REQ-MEM-011: Session-mode storage, resolution, and propagation

<!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->
<!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
<!-- @impl: entrypoint.sh -->
<!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (settings.json configuration describe -> SESSION_MODE gates hook registration + default mode emits only skipDangerousModePermissionPrompt -> AC1) -->
<!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode describe -> returns "default" when prefs unset -> AC2) -->
<!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (reconcileAgentConfigs / REQ-MEM-011 AC4 describe -> seeds and cleans up for default mode + skips cleanup when cleanup=false -> AC4) -->

**Intent:** The mechanics behind the user-observable behavior in REQ-MEM-006: how the mode value is stored, defaulted, clamped against the billing tier, propagated into `settings.json`, and reconciled into the preseed file set without trampling user content.

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, only baseline agent permissions are applied; capture hooks are not registered.
2. If no session mode has been explicitly set, the default mode applies.
3. Mode changes take effect only on explicit "Recreate AI agent skills & rules" click or new bucket creation.
4. On a mode change, preseed files are reconciled to match the new mode: mode-appropriate files are written, preseed-managed files not in the new mode are removed, and user-created files are never modified.

**Constraints:**

- Existing users are unaffected by mode changes until they explicitly recreate.
- A billing-canceled user's stored session mode is downgraded to default at resolution time.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** [Integration test](../../host/__tests__/entrypoint-hooks-merge.test.js)

**Status:** Implemented

---

### REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: preseed/agents/pi/manifest.json -->
<!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md -->
<!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md -->
<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json describe → memory plugin files in AGENTS_SEEDED_CONFIGS → AC1-AC7) -->

**Intent:** Memory capture prompt files must be deployed alongside the rest of the preseed content through the standard manifest pipeline.

**Applies To:** User

**Acceptance Criteria:**

1. The capture prompt is preseeded into the session-installed memory plugin alongside its scripts.
2. The memory plugin's scripts (hook, prompt, prefilter) and the capture subagent definition (pinned to sonnet per AD58) are all delivered via the manifest pipeline that seeds named subagents like architect and code-reviewer ([REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start)).
3. All memory-plugin entries are marked advanced-only in the manifest.
4. The hook script is delivered via the plugin but registered via the session settings merge, not the plugin loader.
5. Memory-plugin source lives in the single preseed source tree.
6. A build-time seed generator produces the runtime payload consumed by the Worker; memory-plugin files appear in that payload.
7. Claude memory plugin files are not generically adapted for non-Claude agents because they depend on Claude-specific MCP and hook surfaces; Pi receives native memory/vault runtime adapters where equivalent Pi lifecycle primitives exist, including its capture-contract and vault-extract prompt files, which ship through the Pi manifest to `~/.pi/agent/prompts/` rather than being written inline at runtime (see [REQ-MEM-014](#req-mem-014-pi-capture-contract-transcript-prefilter-and-model-fidelity-lever)).

**Constraints:**

- Plugin files are updated when the pipeline is redeployed and users explicitly recreate their preseed.
- Only files listed in the manifest are included in the generated payload.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-MEM-009: Vault graph accumulates monotonically across extractions

<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py -->
<!-- @test: host/__tests__/vault-extract-merge.test.js (merge-vault-graph.py AST checks → to_json(vault_graph_path) + nx.compose + try/except guard → AC1+AC2+AC4) -->
<!-- @test: host/__tests__/vault-extract-merge.test.js (vault-extract-prompt.md structural checks → graphify global add --as user_vault + flock /tmp/graphify-global.lock → AC3+AC5) -->

**Intent:** Each vault-monitor extraction must add new nodes to the unified global graph's vault contribution without destroying nodes from prior extractions.

**Applies To:** User

**Acceptance Criteria:**

1. The vault-extract agent maintains a persistent incremental vault graph that survives across extraction passes.
2. Each extraction merges the new chunk's nodes/edges into the persistent graph using a hash-keyed union (existing IDs dedupe, new IDs append).
3. The global graph's vault contribution always reflects the cumulative vault content, not only the most recent extraction.
4. If the persistent vault graph is missing or unreadable, the pass starts a fresh one rather than crashing and writes it at the end of the run.
5. Vault graph merges are serialised with capture-pipeline writes and active-repo hooks; a short timeout prevents indefinite blocking if the lock holder crashes (matching REQ-MEM-001 AC7).

**Constraints:**

- No HTML visualization is generated for the unified global graph; structural queries are the interface. Only the curated vault subset receives a rendered visualization shipped to users.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) (capture pipeline contract), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown) (vault is always-on in the global graph)

**Verification:** [Automated test](../../host/__tests__/vault-extract-merge.test.js)

**Status:** Implemented

---

### REQ-MEM-012: Hard-block tool calls while memory-capture is deferred

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh -->
<!-- @impl: entrypoint.sh -->
<!-- @test: host/__tests__/memory-capture-block.test.js (memory-capture-block.sh describe blocks → AC1-AC4) -->

**Intent:** The capture directive emitted by REQ-MEM-001's hook is advisory: an agent that ignores it leaves the dedup-gate undrained, and the 15-message threshold logic only fires fresh directives on threshold crossings, so a long session can silently pass with zero captures. A companion hard-block hook closes this gap: every tool call other than the memory-capture subagent itself is blocked while a deferred capture is pending, forcing the agent to drain the deferred work before doing anything else. The block has no bypass surface and clears naturally when the subagent runs.

**Applies To:** Agent

**Acceptance Criteria:**

1. The block hook intercepts every tool call in advanced session mode only. When no deferred capture is pending for the current session (the common case), the hook exits silently and the tool call proceeds.
2. When the hook input is missing a session identifier (defensive guard for malformed envelopes), the hook exits silently rather than blocking.
3. When a deferred capture is pending AND the tool call is anything other than the permitted memory-capture subagent invocation, the hook blocks the call; the block message instructs the agent to run the memory-capture subagent (pinned to sonnet so the agent cannot downgrade the model) and points at the persisted prompt and carrier files.
4. Only an invocation of the memory-capture subagent is permitted to proceed while a deferred capture is pending; any other subagent invocation is blocked under AC3. The block clears automatically the moment the subagent runs and removes the carrier file.

**Constraints:**

- The block applies only in advanced session mode because the entire memory-capture pipeline is advanced-mode-only (see [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)).
- If a carrier file is stale beyond recovery, the user clears it manually; there is no in-hook bypass surface.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)

**Verification:** [Automated test](../../host/__tests__/memory-capture-block.test.js)

**Status:** Implemented

---

### REQ-MEM-013: Proactive memory injection on first prompt

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh -->
<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: entrypoint.sh::SETTINGS_CONFIG (UserPromptSubmit memory-context-inject hook registration) -->
<!-- @test: host/__tests__/memory-context-inject.test.js (memory-context-inject.sh describe -> AC1 keyword match injection, AC2 budget cap, AC3 sentinel once-only, AC4 short prompt skip) -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (codeflare-memory plugin files are advanced-only -> Constraints mode-gate) -->

**Intent:** The agent receives relevant prior context (vault notes, code concepts, past decisions) automatically on the first user message of each session, without requiring an explicit tool call. Keywords are extracted from the user's prompt and matched against the unified graphify graph; matched nodes are injected as additionalContext in the hook response so the agent sees them before responding.

**Applies To:** Agent

**Acceptance Criteria:**

1. On the first user message of a session, the hook extracts keywords from the prompt and queries the unified graph for matching nodes.
2. Matched nodes (up to 10, ~1000 tokens) are injected as additionalContext in the UserPromptSubmit hook response.
3. The hook fires at most once per session (gated by its own atomic mkdir sentinel, claimed only after a successful graph query; independent of the memory-capture counter).
4. Prompts shorter than 20 characters are skipped (insufficient signal for keyword extraction).

**Constraints:**

- The hook plugin is advanced-session-only by manifest declaration (`preseed/agents/claude/manifest.json`); standard sessions never receive the plugin.
- The hook reads the graph JSON directly (no MCP round-trip) because the MCP server may not be ready on the first prompt.
- The hook is fail-safe: any error exits silently with no output. A failed injection must never block the session.
- Keyword extraction strips all non-alphanumeric characters and filters to words of 4+ characters to avoid noise.

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-004](vault.md#req-vault-004-unified-global-graph-merges-vault-and-active-repos)

**Verification:** [Automated test](../../host/__tests__/memory-context-inject.test.js)

**Status:** Implemented

---

### REQ-MEM-014: Pi capture contract, transcript prefilter, and model-fidelity lever

<!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md -->
<!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault.ts -->
<!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts -->
<!-- @impl: scripts/generate-agent-seed.mjs -->

**Intent:** Pi's memory-capture and vault-extract subagents must follow the same full capture contract as the Claude memory plugin (AD58 parity) - chunk the transcript, accumulate per-chunk observations, synthesise a structured note, and cite REQ/ADR/SHA/PR identifiers verbatim - rather than the thin inline contract Pi previously carried. The transcript handed to the capture agent must be prefiltered to preserve the conversational arc, and the capture/extract agents must be able to run on a higher-fidelity model without a hardcoded model name.

**Applies To:** User

**Acceptance Criteria:**

1. Pi ships a full capture-contract prompt file and a vault-extract prompt file (chunk then per-chunk scratchpad then synthesise; frontmatter plus Context / Decisions / Observations / References template; verbatim REQ/ADR/SHA/PR citation discipline; wikilink shaping), replacing the prior thin inline contract that the extension wrote at runtime.
2. The Pi extension points its prompt-file constants at the deployed prompt files under `~/.pi/agent/prompts/` and no longer writes the prompt contracts inline.
3. The seed generator maps `prompts/` source files to the deployed `~/.pi/agent/prompts/` location, and both prompt files are delivered advanced-only via the Pi manifest.
4. Before the transcript is handed to the capture agent, it is prefiltered to user and assistant text only - tool-use, tool-result, and thinking blocks are dropped - bounded to the last 200 turns at up to 8000 characters per turn, replacing the prior raw last-40-message JSON slice.
5. The capture/extract subagent spawn accepts an optional model argument sourced from the `CODEFLARE_MEMORY_MODEL` container environment variable; when unset, the runtime default model is used and no model name is hardcoded.

**Constraints:**

- The model-fidelity lever is the Pi-runtime expression of the AD58 rationale (capture must cite identifiers verbatim, which benefits from a higher-fidelity model); Claude pins the model at the subagent-definition level per [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) while Pi reads it from the environment so no model name is committed.
- The prefilter mirrors the Claude prefilter rationale (drop tool/recency noise, preserve the conversational arc); it does not change the capture cadence or the dedup-gate carrier-file protocol.

**Priority:** P1

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-008](#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Partial

<!-- coverage-gap: the compactMessages prefilter (AC4) and the prompts/ manifest-mapping to ~/.pi/agent/prompts/ (AC2/AC3) are exercised by the Pi behavioral tests in agent-seed-manifest.test.ts. The CODEFLARE_MEMORY_MODEL spawn lever (AC5) is runtime spawn behavior with no dedicated automated test. -->


