# Memory

Knowledge graph persistence, automatic capture, compaction, and session-mode gating.

**Domain owner:** MCP memory server, entrypoint.sh, memory-capture.sh, preseed pipeline

### Key Concepts

- **MCP Memory** -- The Model Context Protocol memory server (`server-memory`) that provides a knowledge graph API. Reads and writes `session-{SESSION_ID}.jsonl` files containing entities, observations, and relations.
- **Knowledge Graph** -- The in-memory graph structure (entities with observations, plus inter-entity relations) that persists as JSONL. Each entity has a name, type, and list of observations. Relations connect entities with labeled edges.
- **Capture** -- Phase 1 of the two-phase memory system. A lightweight haiku agent extracts 3-5 observations from the recent conversation transcript and appends them to `chat-{TODAY}` entities. Triggered every 30 user messages via a `UserPromptSubmit` hook.
- **Compaction** -- Phase 2 of the two-phase memory system. An opus agent restructures the knowledge graph when it exceeds 150 observations, distilling raw `chat-*` entities into semantic entities (`project-*`, `*-architecture`, `user-preferences`). Targets 50-80 observations per active project.
- **Session Mode** -- Controls whether memory features are active. Advanced (Pro) mode enables R2 sync of memory files, capture hooks, and compaction. Default (Standard) mode provides in-session-only memory with no persistence.

### Out of Scope

- Cross-user memory sharing (each user's knowledge graph is isolated to their R2 bucket)
- Memory search UI (memory is accessed exclusively through the MCP server API, not a web interface)
- Memory export (no bulk export or migration tools for knowledge graph data)

### Domain Dependencies

- **Storage** -- R2 sync of memory files (REQ-MEM-004) depends on rclone bisync infrastructure from the Storage domain
- **Agents** -- Preseed delivery (REQ-MEM-008) depends on the manifest pipeline and `reconcileAgentConfigs()` from the Agents domain
- **Subscription** -- Mode gating (REQ-MEM-006) depends on effective tier resolution and `sessionModes` from the Subscription domain

---

## REQ-MEM-001: Conversation context automatically captured to MCP memory

**Intent:** Important conversation context (decisions, debugging insights, solutions) must be automatically extracted and stored in the MCP knowledge graph without manual intervention.

**Acceptance Criteria:**
1. The `memory-capture.sh` script runs as a `UserPromptSubmit` hook, injecting a short instruction into the main agent's context via `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` + `exit 0`.
2. The hook counts user messages in the JSONL transcript via `jq -r '.type' "$TRANSCRIPT" | grep -c '^user$'`.
3. When triggered, the main agent spawns a background haiku agent that reads the recent transcript and extracts 3-5 observations.
4. Observations are saved to a `chat-{TODAY}` entity (daily raw capture bucket) in the MCP knowledge graph.
5. The hook handles tilde expansion in `transcript_path` (Claude Code may send tilde-prefixed paths).
6. All variables (transcript path, line offset, date, counts, counter file path) are written to a `.vars` JSON file to keep the context string short.
7. `additionalContext` only appears on the turn where the hook fired (no stale replays).

**Constraints:**
- The hook runs in approximately 150ms (lightweight shell script, no heavy processing).
- Memory capture requires advanced session mode (the hook, plugin, and memory rule are only preseeded in advanced mode).

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-MEM-006
**Verification:** Integration test (E2E verifies observations appear in knowledge graph after 30 messages)

**Status:** Implemented

---

## REQ-MEM-002: Capture triggers every 30 user messages

**Intent:** Memory capture must fire at a regular interval to balance context freshness against overhead.

**Acceptance Criteria:**
1. The hook reads the counter file at `~/.memory/counter/{session_id}` (line 1: last summarized count, line 2: last line offset).
2. If no counter file exists (first run after container recycle or `/resume`), the hook writes a baseline from the current transcript count and exits (establishing the baseline for subsequent delta calculations).
3. If the delta between the current user message count and the last summarized count is less than 30, the hook exits silently.
4. When the delta reaches 30, the hook writes the `.vars` file and emits the `additionalContext` instruction.
5. The counter is updated (current count + total lines) BEFORE emitting, preventing re-triggering on subsequent hook invocations within the same window.
6. The agent reads its line range from the vars file, not from the counter.

**Constraints:**
- Counter files are excluded from R2 sync (`--filter "- .memory/counter/**"`) since they are ephemeral per-session state.
- Each new session gets a new session ID, so old counter files are orphans.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-MEM-001
**Verification:** Automated test (unit test for counter delta logic in memory-capture.sh)

**Status:** Implemented

---

## REQ-MEM-003: Two-phase memory (fast capture + periodic compaction)

**Intent:** Memory management uses two phases optimized for their task: fast raw capture (haiku) and thorough graph restructuring (opus).

**Acceptance Criteria:**
1. **Phase 1 (Capture):** Haiku agent runs every 30 user messages, dumps 3-5 observations into `chat-{TODAY}` entities without worrying about graph structure. Serves as a "write-ahead log."
2. **Phase 2 (Compaction):** Opus agent is triggered when the capture agent detects the graph has grown past 150 total observations.
3. The capture agent writes a marker file (`{COUNTER_FILE}.compact`) when observations exceed 150.
4. The main agent detects the marker file and spawns a background opus agent.
5. The opus agent reads the full graph, distills `chat-*` entities older than 3 days into semantic entities (`project-*`, `*-architecture`, `*-session-archive`, `user-preferences`, `reference-*`).
6. Recent `chat-*` entities (last 3 days) are kept as raw buffer.
7. Compaction deduplicates, prunes stale data, and builds relations.
8. Target: 50-80 observations per active project after compaction.
9. The graph is designed to grow over time as projects accumulate; compaction is per-project, not global.
10. The opus agent removes the `.compact` marker file when done.

**Constraints:**
- Haiku is chosen for capture (speed priority). Opus is chosen for compaction (quality priority).
- Compaction marker is the sole coordination mechanism between phases.
- The main agent checks for the compaction marker only once per turn (no polling).

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-MEM-001, REQ-MEM-007
**Verification:** Integration test (verify graph restructuring after 150+ observations accumulate)

**Status:** Implemented

---

## REQ-MEM-004: Memory files synced to R2 across sessions

**Intent:** MCP memory JSONL files must persist across container lifecycles by syncing to the user's R2 bucket.

**Acceptance Criteria:**
1. In advanced mode, the `~/.memory/` directory is included in rclone bisync (periodic sync every 60s + shutdown sync).
2. On container boot, rclone pulls `~/.memory/session-*.jsonl` files from R2.
3. `entrypoint.sh` runs `merge_memory_files()` after R2 sync: consolidates all session files into `session-{SESSION_ID}.jsonl`, deduplicating entities (by name) and relations (by JSON equality).
4. The `server-memory` MCP server reads/writes `session-{SESSION_ID}.jsonl` during the session.
5. rclone bisync syncs changes back to R2 every 60s and on shutdown.
6. `cleanup_old_memory_files()` removes old session files (keeps 5 newest) after bisync baseline is established.

**Constraints:**
- Rclone config uses `disable_checksum = true` to skip `X-Amz-Meta-Md5chksum` metadata on multipart uploads.
- `--s3-upload-cutoff 0` forces all uploads through the multipart path to prevent `BadDigest` TOCTOU race errors.
- Counter files are excluded from sync; only JSONL memory files are synced.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-STOR-001, REQ-MEM-006
**Verification:** Integration test (E2E verifies memory persists across session restart)

**Status:** Implemented

---

## REQ-MEM-005: Per-session JSONL prevents write conflicts

**Intent:** Multiple concurrent sessions from the same user must not cause data loss through last-write-wins conflicts on shared memory files.

**Acceptance Criteria:**
1. Each session writes to its own file: `session-{SESSION_ID}.jsonl`.
2. Concurrent sessions from the same user (same R2 bucket) write to different files, eliminating write conflicts.
3. Merge-on-boot consolidates all session files into the current session's file, deduplicating entities (by name) and relations (by JSON equality).
4. Old session files are cleaned up locally (KEEP=5) after bisync baseline succeeds, and periodic bisync propagates the deletions to R2.
5. Direct R2 deletion of old files is not used because another session's bisync could propagate the deletion locally, destroying the active memory file.
6. The two-phase merge/cleanup ensures: merge runs after R2 sync but before bisync baseline; cleanup runs after bisync baseline succeeds.

**Constraints:**
- Session IDs are unique per session, so file names are inherently conflict-free.
- Local-only deletion + bisync propagation is the safe cleanup strategy for concurrent sessions.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-MEM-004
**Verification:** Integration test (verify concurrent sessions do not lose memory data)

**Status:** Implemented

---

## REQ-MEM-006: Memory available only in Pro (Advanced) mode

**Intent:** Memory persistence and automatic capture are gated behind the advanced session mode to control feature exposure and resource usage.

**Acceptance Criteria:**
1. In default mode, the entire `~/.memory/` directory is excluded from rclone sync.
2. In default mode, merge and cleanup are skipped.
3. In default mode, MCP memory still works in-session but does not survive container recreation.
4. The memory plugin, memory rule (`rules/memory.md`), and hook scripts are preseeded only in advanced mode.
5. Default mode seeds 25 files; advanced mode seeds 127 files. The memory-related files account for part of the difference.
6. `entrypoint.sh` merges hook registrations (PreToolUse and UserPromptSubmit) into `settings.json` only in advanced mode. Default mode gets only `skipDangerousModePermissionPrompt`.
7. `sessionMode` is stored as `'default' | 'advanced'` in `UserPreferences` (KV). Undefined defaults to `'default'` via `resolveSessionMode()`.
8. Mode changes take effect only on explicit "Recreate AI agent skills & rules" click or new bucket creation.
9. `reconcileAgentConfigs()` seeds mode-appropriate files and deletes preseed-managed files not in the current mode. It never touches user-created files.

**Constraints:**
- Plugin enablement in `.claude.json` is permanent (not mode-gated) because missing plugin files are silently skipped by Claude Code.
- Existing users are unaffected by mode changes until they explicitly recreate.
- `resolveSessionMode` result is clamped against the billing-resolved effective tier (a canceled user with stale `advanced` preference gets `default`).

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-014
**Verification:** Integration test (E2E verifies memory files absent in default mode, present in advanced)

**Status:** Implemented

---

## REQ-MEM-007: Compaction triggered at 150 observations

**Intent:** Graph compaction must be triggered automatically when the knowledge graph grows large enough to benefit from restructuring.

**Acceptance Criteria:**
1. After each capture run, the haiku agent counts total observations in the graph.
2. If the total exceeds 150, the agent writes a `.compact` marker file at `{COUNTER_FILE}.compact`.
3. The main agent detects the marker file and spawns a background opus agent (not haiku).
4. The opus agent reads `memory-compact-prompt.md` for instructions.
5. The prompt instructs the agent to: read the full graph, identify entity structure by domain, distill old `chat-*` entities into semantic entities, keep recent `chat-*` (last 3 days), deduplicate, prune stale data, build relations, target 50-80 observations per active project.
6. The opus agent removes the `.compact` marker file when compaction is complete.
7. The marker file is the gate: if it does not exist, no compaction runs.

**Constraints:**
- The 150-observation threshold balances graph quality against compaction frequency.
- Compaction is per-project, not global; the graph grows over time as projects accumulate.
- Counter storage: `~/.memory/counter/{session_id}` (counter), `{session_id}.vars` (hook variables), `{session_id}.compact` (compaction marker).

**Applies To:** User
**Priority:** P2
**Dependencies:** REQ-MEM-003
**Verification:** Integration test (verify marker file creation at 150+ observations and opus agent invocation)

**Status:** Implemented

---

## REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

**Intent:** Memory capture and compaction prompt files must be deployed alongside the rest of the preseed content through the standard manifest pipeline.

**Acceptance Criteria:**
1. Two prompt files live in `~/.claude/plugins/codeflare-memory/scripts/`: `memory-agent-prompt.md` (haiku capture) and `memory-compact-prompt.md` (opus compaction).
2. The codeflare-memory plugin includes 4 files in the manifest: `plugin.json`, `memory-capture.sh`, `memory-agent-prompt.md`, `memory-compact-prompt.md`.
3. All plugin files are marked as advanced-only in the manifest (`"modes": ["advanced"]`).
4. The hook script (`memory-capture.sh`) is delivered via the plugin but registered via `settings.json` merge (not the plugin system).
5. The manifest pipeline source files are in `preseed/agents/claude/plugins/`.
6. `scripts/generate-agent-seed.mjs` reads the manifest and generates `src/lib/agent-seed.generated.ts` with the files included in `AGENTS_SEEDED_CONFIGS`.
7. Memory-related files are excluded from non-CC agents (no Codex, Gemini, Copilot, or OpenCode equivalents) because they depend on CC-specific MCP and hook systems.

**Constraints:**
- Plugin files update when the pipeline is redeployed and users click "Recreate AI agent skills & rules."
- The generator is manifest-driven and ignores non-manifest files like `plugins/cache/`.

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-AGENT-003
**Verification:** Automated test (generate-agent-seed.mjs output includes memory plugin files)

**Status:** Implemented
