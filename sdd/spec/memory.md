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

1. A UserPromptSubmit hook injects a short capture instruction into the active agent context on each trigger. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (on a trigger the hook emits additionalContext carrying the capture directive and writes the .vars carrier file) -->
2. Only real user messages are counted; tool results and synthetic agent-generated messages are excluded from the count. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (counts only real user prompts, excluding tool_results and command wrappers) -->
3. When triggered, a background sonnet subagent runs the three-stage capture pipeline (prefilter transcript noise, accumulate per-chunk observations, synthesise the final note) and writes the capture file into the vault's session-captures folder. <!-- @impl: preseed/agents/claude/agents/memory-capture.md --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/prefilter-transcript.sh --> <!-- @test: host/__tests__/memory-capture-pipeline.test.js (prefilter-transcript.sh strips tool_use/tool_result/synthetic markers, keeps real prompts + assistant text, and chunks the remainder) -->
4. Capture-file timestamps reflect the user's local timezone, resolved per [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC4. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (assert-iso-ts.sh resolves capture timezone from USER_TIMEZONE/TZ/etc and stamps the matching local offset) -->
5. The capture file uses a YAML frontmatter template with session, capture-time, and capture-range fields followed by Context / Decisions / Observations / References sections. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- coverage-gap: the capture-file YAML frontmatter + Context/Decisions/Observations/References template lives in the LLM capture prompt (memory-agent-prompt.md); the rendered shape is produced by the capture agent, not extractable code; the rendered template has no importable symbol or jsdom-observable side effect, and asserting the prompt strings would be banned text-matching -->
6. Graph nodes and edges are extracted from the rendered capture into a chunk, folded into the cumulative `vault-graph.json` via the shared `merge-vault-graph.py` (per [REQ-MEM-009](#req-mem-009-vault-graph-accumulates-monotonically-across-extractions)), and that cumulative graph is merged into the unified global graph under `user_vault`; the merge is serialised and atomic, so the new content is queryable on the same turn it is written. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- coverage-gap: the merge-vault-graph.py fold IS behaviorally tested under REQ-MEM-009 (host/__tests__/vault-extract-merge.test.js runs the real Python and asserts the cumulative graph, nx.compose dedup, and corrupt-file reset); only the prompt-driven same-turn flock-serialised `graphify global add --as user_vault` ordering is non-behaviorally-testable (it lives in the LLM prompt, with no importable symbol or jsdom-observable side effect in the test pool) -->
7. The capture sources the conversation from the durable on-disk session transcript that each runtime already persists for session resume, never from a volatile in-memory buffer. A capture triggered immediately after a reload or resume therefore sees the full conversation; if the resolved transcript is empty the capture is skipped rather than writing a placeholder "no substantive content" note. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::default --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi memory-vault reads the durable session file via getSessionFile/parseSessionMessages/readSessionMessages and skips capture when the resolved transcript is empty) -->

**Constraints:**

- The hook runs in approximately 150ms (lightweight shell script, no heavy processing).
- Memory capture requires advanced session mode (the hook, plugin, and memory rule are only preseeded in advanced mode).
- The capture agent is sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad), pinned at the subagent-definition level so the dispatching parent cannot silently downgrade the model.
- The capture agent itself is the LLM that produces the extracted graph (the upstream headless extract CLI is not invoked) to avoid duplicating inference cost.
- The capture subagent's pipeline must run whether or not a shell-routing gate (context-mode) is active: the subagent definition carries both the Bash tools and the context-mode execute tools and uses whichever the session permits, so a gated Bash call never silently aborts the capture.
- The durable transcript source is per-runtime: the Claude capture reads the transcript JSONL slice the hook passes by line range; the Pi capture reads its persisted session file via `getSessionFile()` and parses the message entries. Both skip the capture when the resolved transcript is empty.

**Priority:** P0

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** [Integration test](../../host/__tests__/memory-capture-hook.test.js), [Pi behavioral tests](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-MEM-002: Capture triggers every 15 user messages

**Intent:** Memory capture must fire at a regular interval to balance context freshness against overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tracks the number of user messages since the last capture using a per-session counter file. The counter directory defaults to `/tmp/.memory-counter/` and is overridable via the `MEMCAP_COUNTER_DIR` environment variable for hermetic tests. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (counter directory defaults to /tmp/.memory-counter and obsolete .memory/counter bisync filter + mkdir are absent) -->
2. On the first run for a session whose transcript contains exactly one real-user prompt (CURRENT_COUNT == 1), the hook treats this as a brand-new session: it initialises a baseline at the current transcript size, writes the counter, injects the first-message graph-query directive ([REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC3), and exits without triggering capture. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (first run on a brand-new single-prompt session baselines, writes the counter, and exits without capturing) -->
3. If the counter file exists and the delta since the last capture is less than 15 messages, the hook exits silently. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (does NOT trigger when only 14 new real prompts since last_count, delta < 15 boundary) -->
4. When the delta reaches 15, the capture subagent is triggered. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (triggers capture when 15+ new real prompts since last_count and the counter advances to start a fresh window) -->
5. Duplicate capture triggers are suppressed while a capture is pending. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::memoryVarsPending --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi shouldCapture / pending-marker logic suppresses a re-trigger while a capture is already pending) -->
6. Pi advances the prompt counter only after the capture note exists, so a stopped capture retries instead of marking the window complete. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::captureVars --> <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md::Advance the counter and clear the pending marker --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi counter-after-note contract: the prompt counter advances only once the capture note exists) -->
7. When the hook fires with no counter file and the transcript already contains more than one real-user prompt (CURRENT_COUNT > 1), it treats the session as resumed: it force-fires a capture covering the transcript from line 1 and re-emits the graph-query directive ([REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC3). <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (missing counter + transcript with >1 prompt force-fires capture from line 1; exactly-1-prompt stays brand-new with no capture) -->

**Constraints:**

- The counter file MUST live under an ephemeral path (default `/tmp/.memory-counter/`) so that its presence/absence reliably encodes "fresh container instance vs. mid-session continuation". Persisting the counter under `$HOME` or any R2-synced path would defeat resume detection.
- The two first-run sub-cases (brand-new vs. resumed) are distinguished entirely by `CURRENT_COUNT`: a value of 1 means the just-submitted prompt is the only one in the transcript (brand-new); a value greater than 1 means a prior session's prompts persisted in the transcript (resumed). No timestamps, mtimes, or external sentinels are involved.
- The in-session `/compact` case (same container, same PID, counter survives) is not detected by this hook; the 15-prompt cadence catches up within one window, and the compressed summary left by `/compact` keeps the agent oriented in the meantime. Documented as a known limitation; revisit if observed to bite in practice.
- On Pi, the `.vars` carrier file is the pending-capture lock and stale retry marker.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)

**Verification:** [Automated test](../../host/__tests__/memory-capture-hook.test.js)

**Status:** Implemented

---

### REQ-MEM-004: Vault contents synced to R2 across sessions

**Intent:** Vault content (agent captures + user notes) must persist across container lifecycles by syncing to the user's R2 bucket.

**Applies To:** User

**Acceptance Criteria:**

1. In advanced mode, the user's vault directory (including its own graph output) is included in R2 sync. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (slices the real VAULT_FILTER + RCLONE_FILTERS_COMMON out of entrypoint.sh, sources it under SESSION_MODE=advanced, runs the real `rclone lsf -R` against an on-disk fixture and asserts Vault/note.md AND Vault/graphify-out/vault-graph.json are INCLUDED) -->
2. On container boot, the vault is pulled from R2 before any initialization runs so returning sessions inherit their persisted content untouched. <!-- @impl: entrypoint.sh::establish_bisync_baseline --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (establish_bisync_baseline runs before init_user_vault at boot) -->
3. Vault directory initialization is idempotent; re-running on a populated vault creates nothing. <!-- @impl: entrypoint.sh::init_user_vault --> <!-- @test: host/__tests__/entrypoint-vault-boot.test.js (init_user_vault idempotent: re-run against a populated vault clobbers nothing) -->
4. Vault changes are pushed back to R2 on three triggers: the regular sync cadence ([REQ-STOR-003](storage.md#req-stor-003-bidirectional-sync-every-15-minutes-with-manual-triggers)), the Sync-now button ([REQ-STOR-015](storage.md#req-stor-015-explicit-sync-trigger-from-ui)), and the final shutdown bisync ([REQ-STOR-005](storage.md#req-stor-005-graceful-shutdown-performs-final-sync)). <!-- @impl: entrypoint.sh::bisync_with_r2 --> <!-- @test: host/__tests__/entrypoint-bisync-behavior.test.js (the bisync daemon runs within one cadence tick and a SIGUSR1 interrupts the cadence sleep to trigger bisync immediately) -->
5. The ephemeral unified-graph layer is rebuilt locally on every container boot and is not synced. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (runs the real filter array via rclone lsf and asserts the ephemeral .graphify/global-graph.json workspace is EXCLUDED (rebuilt on boot) and the per-run derived Vault/graphify-out/graph.json is EXCLUDED while the cumulative vault-graph.json is INCLUDED) -->
6. The shutdown handler watchdog allows the final bisync up to 120s to drain pending writes before forced termination. <!-- @impl: entrypoint.sh::shutdown_handler --> <!-- coverage-gap: no genuine behavioral test for the 120s (108s SIGTERM + 12s SIGKILL) shutdown-watchdog budget — exercising a real 120s timeout / forced-termination path is impractical as a node:test unit -->

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

1. In default mode, the vault directory is not preserved across container recreations: the R2 sync filters include the Vault tree only in advanced mode and explicitly exclude it in default mode, so cross-session persistence is limited to advanced-mode sessions. <!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON --> <!-- @test: host/__tests__/entrypoint-rclone-filters.test.js (sources the real filter resolution under SESSION_MODE=default and asserts the entire Vault tree (note + graph) is positively EXCLUDED, with a paired advanced-vs-default test asserting the mode gate flips ONLY the vault verdict while Uploads/Temporary stay INCLUDED in both) -->
2. In default mode, the capture hook still runs the in-session counter logic but vault writes are local-only. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (CF-064: default mode receives no vault or memory machinery, capture stays local-only) -->
3. The memory plugin, the memory rule (which carries the folded vault trigger/route content), the vault plugin, and the vault-note-capture rule are preseeded only in advanced mode. <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: src/__tests__/lib/pro-mode-gating.test.ts (rules/memory.md, vault-note-capture rule, and all codeflare-memory/codeflare-vault plugin files are tagged modes === ['advanced']) -->
4. Pro mode seeds a strict superset of Standard's preseed files; the memory and vault plugins/rules are part of the Pro-only delta. <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts ("advanced" is a superset of "default": the advanced seed contains every default file plus the memory/vault Pro-only delta) -->

**Constraints:**

- Plugin registration is not removed on mode downgrade; missing plugin files are silently skipped at runtime.

**Priority:** P1

**Dependencies:** [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** [Integration test](../../src/__tests__/lib/pro-mode-gating.test.ts)

**Status:** Implemented

---

### REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

**Intent:** Memory capture prompt files must be deployed alongside the rest of the preseed content through the standard manifest pipeline.

**Applies To:** User

**Acceptance Criteria:**

1. The capture prompt is preseeded into the session-installed memory plugin alongside its scripts. <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (codeflare-memory plugin files are advanced-only - memory plugin files present in generated seed) -->
2. The memory plugin's scripts (hook, prompt, prefilter) and the capture subagent definition (pinned to sonnet per [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)) are all delivered via the manifest pipeline that seeds named subagents like architect and code-reviewer ([REQ-AGENT-008](agents.md#req-agent-008-preseed-deployed-to-container-on-start)). <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (every entry has a valid key, contentType, content, and modes; all keys start with a valid agent prefix - memory plugin entries delivered through the manifest pipeline) -->
3. All memory-plugin entries are marked advanced-only in the manifest. <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (codeflare-memory plugin files are advanced-only) -->
4. The hook script is delivered via the plugin but registered via the session settings merge, not the plugin loader. <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (no standalone memory hook files remain in hooks/ directory - hook ships inside the plugin) --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (advanced mode SETTINGS_CONFIG registers memory-capture hook via jq settings merge, gated by SESSION_MODE) -->
5. Memory-plugin source lives in the single preseed source tree. <!-- @impl: preseed/agents/claude/manifest.json --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (all keys start with a valid agent prefix; no path traversal / leading-dot / backslash in relative key portion) -->
6. A build-time seed generator produces the runtime payload consumed by the Worker; memory-plugin files appear in that payload. <!-- @impl: scripts/generate-agent-seed.mjs --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (generated configs array is non-empty; codeflare-memory plugin files present in the generated payload) -->
7. Claude memory plugin files are not generically adapted for non-Claude agents because they depend on Claude-specific MCP and hook surfaces; Pi receives native memory/vault runtime adapters where equivalent Pi lifecycle primitives exist, including its capture-contract and vault-extract prompt files, which ship through the Pi manifest to `~/.pi/agent/prompts/` rather than being written inline at runtime (see [REQ-MEM-014](#req-mem-014-pi-capture-contract-transcript-prefilter-and-model-fidelity-lever)). <!-- @impl: preseed/agents/pi/manifest.json --> <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (codeflare-memory plugin is excluded from non-Claude agents; Pi native prompt assets are seeded under .pi/agent/prompts/) -->

**Constraints:**

- Plugin files are updated when the pipeline is redeployed and users explicitly recreate their preseed.
- Only files listed in the manifest are included in the generated payload.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented

---

### REQ-MEM-009: Vault graph accumulates monotonically across extractions

**Intent:** Every vault writer - the vault-extract and memory-capture pipelines, on both the Claude and Pi runtimes - must add new nodes to the unified global graph's vault contribution without destroying nodes from prior passes. All four converge on a single cumulative `vault-graph.json` maintained by the shared `merge-vault-graph.py`; `--as user_vault` replace-semantics means anything less than the cumulative graph fed to `graphify global add` wipes prior vault knowledge.

**Applies To:** User

**Acceptance Criteria:**

1. Every vault writer maintains a single persistent incremental vault graph (`vault-graph.json`) that survives across passes; both the vault-extract and memory-capture pipelines on both runtimes author a chunk and fold it in via the shared `merge-vault-graph.py` rather than editing `graph.json` in place. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py --> <!-- @test: host/__tests__/vault-extract-merge.test.js (script writes the cumulative vault graph back to vault_graph_path as the to_json path argument) --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi vault-extract + memory prompts build the cumulative vault graph via the Pi-local merge-vault-graph.py, preseeded into .pi/agent/scripts) -->
2. Each pass merges the new chunk's nodes/edges into the persistent graph using a hash-keyed union (existing IDs dedupe, new IDs append). <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py --> <!-- @test: host/__tests__/vault-extract-merge.test.js (script unions prior + new graphs via nx.compose hash-keyed dedup; normalises both operands to directed first) -->
3. The global graph's vault contribution always reflects the cumulative vault content (the persistent `vault-graph.json` is fed to `graphify global add --as user_vault`, never the per-run chunk or `graph.json`), not only the most recent pass. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md --> <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md --> <!-- @test: host/__tests__/vault-extract-merge.test.js (prompt step 5 feeds vault-graph.json to graphify global add --as user_vault) --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (Pi vault-extract + memory prompts publish the cumulative vault graph to the global graph) -->
4. If the persistent vault graph is missing or unreadable, the pass starts a fresh one rather than crashing and writes it at the end of the run. <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/merge-vault-graph.py --> <!-- @impl: preseed/agents/pi/scripts/merge-vault-graph.py --> <!-- @test: host/__tests__/vault-extract-merge.test.js (script wraps the vault-graph.json load in try/except so missing/corrupt files reset to a fresh DiGraph) -->
5. Vault graph merges are serialised with capture-pipeline writes and active-repo hooks; a short timeout prevents indefinite blocking if the lock holder crashes (matching [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) AC7). <!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md --> <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md --> <!-- @test: host/__tests__/vault-extract-merge.test.js (prompt wraps the merge invocation under flock /tmp/graphify-global.lock) -->

**Constraints:**

- No HTML visualization is generated for the unified global graph; structural queries are the interface. Only the curated vault subset receives a rendered visualization shipped to users.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) (capture pipeline contract), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown) (vault is always-on in the global graph)

**Verification:** [Automated test](../../host/__tests__/vault-extract-merge.test.js)

**Status:** Implemented

---

### REQ-MEM-010: Memory capture hook plumbing

**Intent:** Capture timestamps reflect the user's local timezone, the hook fires reliably regardless of path format or session state, and a fabrication-resistant timestamp assertion fails closed if the subagent guesses the timestamp instead of producing a real one.

**Applies To:** User

**Acceptance Criteria:**

1. The hook tolerates tilde-prefixed transcript paths. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (expands ~ in transcript_path to $HOME) -->
2. Variables shared between the hook and the capture subagent are passed via a small carrier file rather than inline context. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (triggers capture when 15+ NEW real prompts since last_count - carrier-file directive emitted) -->
3. On the first message of a session, the hook injects a graph-query directive instructing the agent to consult the unified graph before responding. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh --> <!-- @test: host/__tests__/memory-capture-hook.test.js (first run on a brand-new session baselines and emits memory-scan directive) -->
4. The hook resolves the capture timezone from the user preference ([REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)), falling back to the container default and finally to UTC. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (happy path UTC and Europe/Zurich real local-TZ offset accepted - resolved-timezone honored) -->
5. The capture timestamp is validated against the current wall clock and rejected if fabricated, missing a timezone offset, or mismatching the resolved timezone. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (happy paths UTC + Europe/Zurich exit 0; ISO_TS lacking [+-]NNNN offset suffix rejected) -->
6. A timestamp whose offset does not match the resolved timezone is rejected; this catches dropped-timezone-wrapper bugs without false-positiving legitimately-UTC hosts. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (Europe/Zurich + ISO_TS ending in +0000 rejected) -->
7. A timestamp more than 30 seconds away from the current wall clock is rejected. Any assertion failure halts the capture rather than writing a confabulated timestamp to the vault. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/assert-iso-ts.sh --> <!-- @test: host/__tests__/memory-prompt-iso-ts-assertions.test.js (year-old fabricated timestamp rejected for freshness drift) -->

**Constraints:**

- The carrier file acts as the dedup gate: the capture subagent must delete it as its first step; absence on subsequent hook fires short-circuits trigger emission.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** [Automated test](../../host/__tests__/memory-capture-hook.test.js)

**Status:** Implemented

---

### REQ-MEM-011: Session-mode storage, resolution, and propagation

**Intent:** The mechanics behind the user-observable behavior in [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode): how the mode value is stored, defaulted, clamped against the billing tier, propagated into `settings.json`, and reconciled into the preseed file set without trampling user content.

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, only baseline agent permissions are applied; capture hooks are not registered. <!-- @impl: entrypoint.sh::SETTINGS_CONFIG --> <!-- @test: host/__tests__/entrypoint-hooks-merge.test.js (SESSION_MODE gates hook registration; default mode emits only skipDangerousModePermissionPrompt, not hook registrations) -->
2. If no session mode has been explicitly set, the default mode applies. <!-- @impl: src/lib/session-mode.ts::resolveSessionMode --> <!-- @test: src/__tests__/lib/session-mode.test.ts (resolveSessionMode returns default when prefs unset) -->
3. Mode changes take effect only on explicit "Recreate AI agent skills & rules" click or new bucket creation. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/routes/container-r2-start.test.ts (reconcileAgentConfigs runs only on the new-bucket trigger, not unconditionally) -->
4. On a mode change, preseed files are reconciled to match the new mode: mode-appropriate files are written, preseed-managed files not in the new mode are removed, and user-created files are never modified. <!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs --> <!-- @test: src/__tests__/lib/r2-seed-mode.test.ts (reconcileAgentConfigs seeds and cleans up for default mode; skips cleanup when cleanup=false) -->

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

1. The block hook intercepts every tool call in advanced session mode only. When no deferred capture is pending for the current session (the common case), the hook exits silently and the tool call proceeds. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh --> <!-- @test: host/__tests__/memory-capture-block.test.js (common path - exits 0 when .vars does not exist, any tool allowed) -->
2. When the hook input is missing a session identifier (defensive guard for malformed envelopes), the hook exits silently rather than blocking. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh --> <!-- @test: host/__tests__/memory-capture-block.test.js (input gating - exits 0 when session_id is missing) -->
3. When a deferred capture is pending AND the tool call is anything other than the permitted memory-capture subagent invocation, the hook blocks the call; the block message instructs the agent to run the memory-capture subagent (pinned to sonnet so the agent cannot downgrade the model) and points at the persisted prompt and carrier files. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh --> <!-- @test: host/__tests__/memory-capture-block.test.js (hard block - exits 2 with stderr when .vars exists and tool is Bash/Read/Edit/Write/Grep/Glob/WebFetch; stderr carries spawn directive with PROMPT_FILE + VARS_FILE paths) -->
4. Only an invocation of the memory-capture subagent is permitted to proceed while a deferred capture is pending; any other subagent invocation is blocked under AC3. The block clears automatically the moment the subagent runs and removes the carrier file. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh --> <!-- @test: host/__tests__/memory-capture-block.test.js (subagent allowlist - exits 0 only for Task subagent_type=memory-capture, exits 2 for other/no subagent_type; block is unconditional with no bypass) -->

**Constraints:**

- The block applies only in advanced session mode because the entire memory-capture pipeline is advanced-mode-only (see [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)).
- If a carrier file is stale beyond recovery, the user clears it manually; there is no in-hook bypass surface.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)

**Verification:** [Automated test](../../host/__tests__/memory-capture-block.test.js)

**Status:** Implemented

---

### REQ-MEM-013: Proactive memory injection on first prompt

**Intent:** The agent receives relevant prior context (vault notes, code concepts, past decisions) automatically on the first user message of each session, without requiring an explicit tool call. Keywords are extracted from the user's prompt and matched against the unified graphify graph; matched nodes are injected as additionalContext in the hook response so the agent sees them before responding.

**Applies To:** Agent

**Acceptance Criteria:**

1. On the first user message of a session, the hook extracts keywords from the prompt and queries the unified graph for matching nodes. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh --> <!-- @test: host/__tests__/memory-context-inject.test.js (injects matched nodes from global graph on first prompt) -->
2. Matched nodes (up to 10, ~1000 tokens) are injected as additionalContext in the UserPromptSubmit hook response. <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh --> <!-- @test: host/__tests__/memory-context-inject.test.js (injects at most 10 nodes even when more match) -->
3. The hook fires at most once per session (gated by its own atomic mkdir sentinel, claimed only after a successful graph query; independent of the memory-capture counter). <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh --> <!-- @test: host/__tests__/memory-context-inject.test.js (fires at most once per session - sentinel directory prevents re-fire) -->
4. Prompts shorter than 20 characters are skipped (insufficient signal for keyword extraction). <!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh --> <!-- @test: host/__tests__/memory-context-inject.test.js (skips prompts shorter than 20 characters) -->

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

**Intent:** Pi's memory-capture and vault-extract subagents must follow the same full capture contract as the Claude memory plugin ([AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) parity) - chunk the transcript, accumulate per-chunk observations, synthesise a structured note, and cite REQ/ADR/SHA/PR identifiers verbatim - rather than the thin inline contract Pi previously carried. The transcript handed to the capture agent must be prefiltered to preserve the conversational arc, and the capture/extract agents must be able to run on a higher-fidelity model without a hardcoded model name.

**Applies To:** User

**Acceptance Criteria:**

1. Pi ships a full capture-contract prompt file and a vault-extract prompt file (chunk then per-chunk scratchpad then synthesise; frontmatter plus Context / Decisions / Observations / References template; verbatim REQ/ADR/SHA/PR citation discipline; wikilink shaping), replacing the prior thin inline contract that the extension wrote at runtime. <!-- @impl: preseed/agents/pi/prompts/memory-agent-prompt.md --> <!-- @impl: preseed/agents/pi/prompts/vault-extract-prompt.md --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (prompt files shipped advanced-only at deployed path, not inline) -->
2. The Pi extension points its prompt-file constants at the deployed prompt files under `~/.pi/agent/prompts/` and no longer writes the prompt contracts inline. <!-- @impl: preseed/agents/pi/extensions/memory-vault.ts::default --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (prompt files shipped advanced-only at deployed path, not inline) -->
3. The seed generator maps `prompts/` source files to the deployed `~/.pi/agent/prompts/` location, and both prompt files are delivered advanced-only via the Pi manifest. <!-- @impl: scripts/generate-agent-seed.mjs --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (prompt files shipped advanced-only at deployed path, not inline) -->
4. Before the transcript is handed to the capture agent, it is prefiltered to user and assistant text only - tool-use, tool-result, and thinking blocks are dropped - bounded to the last 200 turns at up to 8000 characters per turn, replacing the prior raw last-40-message JSON slice. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::compactMessages --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (compactMessages prefilter drops tool/thinking, keeps user+assistant, caps 200 turns / 8000 chars) -->
5. The capture/extract subagent spawn accepts an optional model argument sourced from `CODEFLARE_MEMORY_MODEL`; when unset, no model name is hardcoded. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildSpawnOptions --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (buildSpawnOptions applies model only when set; no hardcoded default when CODEFLARE_MEMORY_MODEL unset) -->
6. The Pi memory-capture agent runs in the background so main-session work cannot cancel it. <!-- @impl: preseed/agents/pi/extensions/memory-vault-helpers.ts::buildSpawnOptions --> <!-- @impl: scripts/generate-agent-seed.mjs --> <!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (buildSpawnOptions always carries inheritContext:false and background service options) -->

**Constraints:**

- The model-fidelity lever is the Pi-runtime expression of the [AD58](../../documentation/decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad) rationale (capture must cite identifiers verbatim, which benefits from a higher-fidelity model); Claude pins the model at the subagent-definition level per [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) while Pi reads it from the environment so no model name is committed.
- The prefilter mirrors the Claude prefilter rationale (drop tool/recency noise, preserve the conversational arc); it does not change the capture cadence or the dedup-gate carrier-file protocol.

**Priority:** P1

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-008](#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline)

**Verification:** [Automated test](../../src/__tests__/lib/agent-seed-manifest.test.ts)

**Status:** Implemented
