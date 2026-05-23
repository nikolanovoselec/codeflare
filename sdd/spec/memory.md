# Memory

Vault-based cross-session memory, automatic capture, hook delivery, and session-mode gating.

**Domain owner:** vault subsystem, entrypoint.sh, memory-capture.sh, preseed pipeline

### Key Concepts

- **Vault** -- `/home/user/Vault/`. Single source of truth for cross-session memory. Holds agent-written session captures (`Raw/Sessions/`) and user-curated content under `Notes/`, `Inbox/`, `Journal/`. SilverBullet writes attachments next to the note that referenced them. Rclone-bisynced to R2.
- **Unified Graph** -- `~/.graphify/global-graph.json`. Hash-keyed merge of the vault's graph and every active repo's per-repo graph. Queried via `mcp__graphify__*`.
- **Capture** -- A background agent (sonnet) runs every 15 real user messages, prefilters the transcript to strip tool I/O, chunks the remainder, accumulates per-chunk observations into a scratchpad, synthesises a markdown capture file in `Raw/Sessions/`, and merges it into the unified graph under `flock -w 5 /tmp/graphify-global.lock`.
- **Session Mode** -- Advanced (Pro) mode enables R2 sync of the vault and capture hooks. Default (Standard) mode runs the in-session capture flow but the vault is not preserved across container recreations.

### Out of Scope

- Cross-user memory sharing (each user's vault is isolated to their R2 bucket).
- Automated graph compaction (the user prunes `Raw/Sessions/` manually via SilverBullet when needed).
- Legacy MCP `@modelcontextprotocol/server-memory` migration (removed; no historical JSONL graph is read or written).
- Bulk memory export (vault files are plain markdown and can be copied with rclone or git).

### Domain Dependencies

- **Vault** -- Capture writes (REQ-MEM-001) and global-graph merges depend on the vault skeleton and graphify infrastructure from the Vault domain.
- **Storage** -- R2 sync of the vault (REQ-MEM-004) depends on rclone bisync infrastructure from the Storage domain.
- **Agents** -- Preseed delivery (REQ-MEM-008) depends on the manifest pipeline and `reconcileAgentConfigs()` from the Agents domain.
- **Subscription** -- Mode gating (REQ-MEM-006) depends on effective tier resolution and `sessionModes` from the Subscription domain.

---

### REQ-MEM-001: Conversation context automatically captured to vault

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md -->
<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/prefilter-transcript.sh -->

**Intent:** Important conversation context (decisions, debugging insights, observations) must be extracted from the transcript and persisted to the vault without manual intervention. This REQ covers the hook trigger, message-counting filter, and the capture pipeline. Hook plumbing (tilde expansion, vars file shape, first-message graphify hint, timezone resolution) is split into [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing).

**Applies To:** User

**Acceptance Criteria:**

1. The memory-capture hook script runs as a `UserPromptSubmit` hook, injecting a short instruction into the main agent's context via `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` + `exit 0`.
2. The hook counts real user messages in the JSONL transcript using a two-layer grep filter that excludes tool-result wrappers (content is an array, not a string) and synthetic messages (slash commands, task notifications -- content starts with `<`).
3. When triggered, a background sonnet agent runs the three-stage capture pipeline (prefilter transcript noise, chunk and accumulate per-chunk observations into a scratchpad, synthesise the final note) and writes the capture file to `/home/user/Vault/Raw/Sessions/{ISO_TS}-{SID_SHORT}.md`.
4. Capture-file timestamps reflect the user's local timezone, resolved per [REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC4.
5. The capture file uses a YAML frontmatter template with `session_id`, `captured_at`, and `captured_from_range` fields followed by Context / Decisions / Observations / References sections.
6. The capture agent extracts chunk nodes/edges from the rendered markdown via inline graph construction: sonnet emits chunk JSON matching graphify's schema, and a short Python step calls `graphify.build` / `graphify.cluster` / `graphify.export.to_json` to materialise the per-extraction graph.
7. The agent runs `graphify global add ... --as user_vault` under `flock -w 5 /tmp/graphify-global.lock` so the new content is queryable on the same turn it is written.

**Constraints:**

- The hook runs in approximately 150ms (lightweight shell script, no heavy processing).
- Memory capture requires advanced session mode (the hook, plugin, and memory rule are only preseeded in advanced mode).
- The capture agent is sonnet per AD58, pinned at the subagent-definition level so the dispatching parent cannot silently downgrade the model.
- The headless `graphify extract` CLI is intentionally bypassed in AC6: codeflare ships no LLM provider key for graphify, and the capture agent IS the LLM, so re-invoking the CLI would duplicate inference cost with no benefit.

**Priority:** P0

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-MEM-010: Memory capture hook plumbing

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh -->
<!-- @test: host/__tests__/memory-capture-hook.test.js (memory-capture-hook describe → tilde expansion + .vars schema + first-message graphify directive + timezone fallback chain → AC1-AC4) -->

**Intent:** Operational glue around the capture hook: tilde expansion in transcript paths, the shared `.vars` carrier file that keeps `additionalContext` strings short, a first-message graphify-query directive that primes the agent with prior-session knowledge, and a timezone resolution chain so captured timestamps reflect the user's local clock instead of UTC.

**Applies To:** User

**Acceptance Criteria:**

1. The hook handles tilde expansion in `transcript_path` (Claude Code may send tilde-prefixed paths).
2. All variables (transcript path, line offset, date, counts, counter file path) are written to a `.vars` JSON file to keep the context string short.
3. On the first message of a session (no counter file exists), the hook injects a `mcp__graphify__query_graph` directive into `additionalContext` instructing the agent to query the unified graph before responding.
4. The hook resolves the capture timestamp from `$USER_TIMEZONE`, falling back to `$TZ`, then `/etc/timezone`, then UTC. The endpoint and persistence contract that puts a value into `$USER_TIMEZONE` are specified by REQ-SESSION-016.

**Constraints:**

- The `.vars` file is the dedup gate: the capture subagent must delete it as its first step; absence on subsequent hook fires short-circuits trigger emission.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-SESSION-016](session-lifecycle.md#req-session-016-user-timezone-propagated-from-preferences-to-container-env)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-MEM-002: Capture triggers every 15 user messages

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh -->
<!-- @test: host/__tests__/memory-capture-pipeline.test.js (memory-capture-pipeline describe → counter delta 15-msg threshold + .vars writeback + baseline init → AC1-AC6) -->

**Intent:** Memory capture must fire at a regular interval to balance context freshness against overhead.

**Applies To:** User

**Acceptance Criteria:**

1. The hook reads the counter file at `~/.memory/counter/{session_id}` (line 1: last summarized count, line 2: last line offset).
2. If no counter file exists (first run after container start), the hook writes a baseline from the current transcript count and injects the graphify-query directive ([REQ-MEM-010](#req-mem-010-memory-capture-hook-plumbing) AC3) before exiting.
3. If the delta between the current user message count and the last summarized count is less than 15, the hook exits silently.
4. When the delta reaches 15, the hook writes the `.vars` file and emits the `additionalContext` instruction.
5. The counter is updated (current count + total lines) BEFORE emitting, preventing re-triggering on subsequent hook invocations within the same window.
6. The capture agent reads its line range from the vars file, not from the counter.

**Constraints:**

- Counter files are excluded from R2 sync (`--filter "- .memory/counter/**"`) since they are ephemeral per-session state.
- Each new session gets a new session ID, so old counter files are orphans.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-MEM-004: Vault contents synced to R2 across sessions

<!-- @impl: entrypoint.sh::RCLONE_FILTERS_COMMON -->
<!-- @impl: entrypoint.sh::init_user_vault -->
<!-- @impl: entrypoint.sh::bisync_with_r2 -->

**Intent:** Vault content (agent captures + user notes) must persist across container lifecycles by syncing to the user's R2 bucket.

**Applies To:** User

**Acceptance Criteria:**

1. In advanced mode, `/home/user/Vault/` is included in rclone bisync via a `+` filter that precedes the global `**/graphify-out/**` exclude so vault graphify output still rides along.
2. On container boot, rclone pulls the vault from R2 before the vault skeleton init runs, so returning sessions inherit their persisted content untouched.
3. The vault skeleton init (`init_user_vault`) is idempotent and only creates subdirectories / config files when absent.
4. rclone bisync syncs changes back to R2 on three triggers: the 15-minute cadence, manual SIGUSR1 from the Sync-now button (REQ-STOR-015), and the final shutdown bisync (REQ-STOR-005).
5. The ephemeral global-graph layer (`~/.graphify/`) is explicitly excluded from sync (rebuilt locally on every container boot from per-source graphs).
6. The shutdown handler watchdog allows the final bisync up to 120s to drain pending writes before SIGKILL.

**Constraints:**

- Rclone config uses `disable_checksum = true` to skip `X-Amz-Meta-Md5chksum` metadata on multipart uploads.
- `--s3-upload-cutoff 0` forces all uploads through the multipart path to prevent `BadDigest` TOCTOU race errors.
- Counter files are excluded from sync; only vault and ordinary workspace content are synced.

**Priority:** P0

**Dependencies:** [REQ-STOR-001](storage.md#req-stor-001-dedicated-per-user-r2-bucket), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-VAULT-001](vault.md#req-vault-001-persistent-vault-directory-survives-across-sessions)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-MEM-006: Memory available only in Pro (Advanced) mode

<!-- @impl: preseed/agents/claude/manifest.json -->

**Intent:** Vault persistence and automatic capture are user-facing features gated behind the advanced session mode. This REQ specifies the observable behavior (what works in each mode) and the preseed delta (which files differ between modes). The storage/resolution/propagation of the mode value lives in [REQ-MEM-011](#req-mem-011-session-mode-storage-resolution-and-propagation).

**Applies To:** User

**Acceptance Criteria:**

1. In default mode, the vault directory is not preserved across container recreations (sync filters limit cross-session persistence to advanced-mode sessions).
2. In default mode, the capture hook still runs the in-session counter logic but vault writes are local-only.
3. The memory plugin, memory rule (`rules/memory.md`, which carries the folded vault trigger/route content), vault plugin, and `rules/vault-note-capture.md` are preseeded only in advanced mode.
4. Pro mode seeds a strict superset of Standard's preseed files; the memory and vault plugins/rules are part of the Pro-only delta.

**Constraints:**

- Plugin enablement in `.claude.json` is permanent (not mode-gated) because missing plugin files are silently skipped by Claude Code.

**Priority:** P1

**Dependencies:** [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-MEM-011: Session-mode storage, resolution, and propagation

<!-- @impl: src/lib/session-mode.ts::resolveSessionMode -->
<!-- @impl: src/lib/r2-seed.ts::reconcileAgentConfigs -->
<!-- @impl: entrypoint.sh -->

**Intent:** The mechanics behind the user-observable behavior in REQ-MEM-006: how the mode value is stored, defaulted, clamped against the billing tier, propagated into `settings.json`, and reconciled into the preseed file set without trampling user content.

**Applies To:** User

**Acceptance Criteria:**

1. The container entrypoint merges hook registrations (PreToolUse and UserPromptSubmit) into `settings.json` only in advanced mode. Default mode gets only `skipDangerousModePermissionPrompt`.
2. `sessionMode` is stored as `'default' | 'advanced'` in `UserPreferences` (KV). Undefined defaults to `'default'` via `resolveSessionMode()`.
3. Mode changes take effect only on explicit "Recreate AI agent skills & rules" click or new bucket creation.
4. `reconcileAgentConfigs()` seeds mode-appropriate files and deletes preseed-managed files not in the current mode. It never touches user-created files.

**Constraints:**

- Existing users are unaffected by mode changes until they explicitly recreate.
- `resolveSessionMode` result is clamped against the billing-resolved effective tier (a canceled user with stale `advanced` preference gets `default`).

**Priority:** P1

**Dependencies:** [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode), [REQ-SUB-014](subscription.md#req-sub-014-session-mode-gating-by-tier)

**Verification:** Integration test

**Status:** Implemented

---

### REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

<!-- @impl: preseed/agents/claude/manifest.json -->
<!-- @impl: scripts/generate-agent-seed.mjs -->
<!-- @test: src/__tests__/lib/agent-seed-manifest.test.ts (agent-seed manifest.json describe → memory plugin files in AGENTS_SEEDED_CONFIGS → AC1-AC7) -->

**Intent:** Memory capture prompt files must be deployed alongside the rest of the preseed content through the standard manifest pipeline.

**Applies To:** User

**Acceptance Criteria:**

1. The capture prompt lives in `~/.claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md`.
2. The codeflare-memory plugin includes four files in the manifest: `plugin.json`, `memory-capture.sh`, `memory-agent-prompt.md`, `prefilter-transcript.sh`. The capture **subagent definition** (`preseed/agents/claude/agents/memory-capture.md` -- frontmatter pins `model: sonnet` per AD58) is registered under the manifest's top-level `agents/` section, not inside the plugin; it is seeded by the same reconcileAgentConfigs pipeline (REQ-AGENT-008) that delivers the other named subagents (architect, code-reviewer, ...).
3. All plugin files are marked as advanced-only in the manifest (`"modes": ["advanced"]`).
4. The hook script (`memory-capture.sh`) is delivered via the plugin but registered via `settings.json` merge (not the plugin system).
5. The manifest pipeline source files are in `preseed/agents/claude/plugins/`.
6. A build-time seed generator reads the manifest and emits the runtime `AGENTS_SEEDED_CONFIGS` module that the Worker consumes; memory plugin files appear in that output.
7. Memory-related files are excluded from non-CC agents (no Codex, Gemini, Copilot, or OpenCode equivalents) because they depend on CC-specific MCP and hook systems.

**Constraints:**

- Plugin files update when the pipeline is redeployed and users click "Recreate AI agent skills & rules."
- The generator is manifest-driven and ignores non-manifest files like `plugins/cache/`.

**Priority:** P1

**Dependencies:** [REQ-AGENT-003](agents.md#req-agent-003-agent-cli-auto-started-in-tab-1)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-MEM-009: Vault graph accumulates monotonically across extractions

<!-- @impl: preseed/agents/claude/plugins/codeflare-vault/scripts/vault-extract-prompt.md -->
<!-- @test: host/__tests__/vault-extract-merge.test.js (vault-extract-merge describe → load + merge + persist + flock pattern in prompt → AC1-AC5) -->

**Intent:** Each vault-monitor extraction must add new nodes to the `user_vault` subgraph in the unified global graph without destroying nodes from prior extractions. Previously the agent called `graphify global add ... --as user_vault` after building a chunk graph from only the newly-changed files; `--as <tag>` replaces the entire repo-tag contribution, so every vault edit wiped all prior vault knowledge from the global graph (observed: 17 nodes -> 2 nodes after the agent ran on 2 newly-created stub `.md` files).

**Applies To:** User

**Acceptance Criteria:**

1. The vault-extract agent maintains a persistent vault graph at `/home/user/Vault/graphify-out/vault-graph.json`, loaded at the start of each pass and re-written at the end.
2. Each extraction merges the new chunk's nodes/edges into the persistent graph using a hash-keyed union (existing IDs dedupe, new IDs append).
3. The persistent vault graph is what `graphify global add ... --as user_vault` consumes, so the global graph's `user_vault` repo tag always reflects the cumulative vault content rather than only the most recent extraction.
4. If the persistent vault graph file is missing or unreadable, the pass starts a fresh one (rather than crashing) and writes it at the end of the run.
5. The merge step runs under `flock -w 5 /tmp/graphify-global.lock` so it serialises with capture-pipeline writes and active-repo hooks; the 5s timeout prevents indefinite block if the lock holder crashes, matching REQ-MEM-001 AC7.

**Constraints:**

- Global-graph HTML visualization is intentionally absent: the unified graph is a 10k+ node corpus that renders as an unusable force-directed hairball. Structural queries via `mcp__graphify__*` are the real interface. The vault viz (`Raw/Graphs/vault-graph.html`) is the only graphify-rendered HTML shipped to users and covers the curated subset they actually edit.

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault) (capture pipeline contract), [REQ-VAULT-002](vault.md#req-vault-002-conversation-captures-land-in-the-vault-as-markdown) (vault is always-on in the global graph)

**Verification:** Automated test

**Status:** Implemented

---

### REQ-MEM-012: Hard-block tool calls while memory-capture is deferred

<!-- @impl: preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh -->
<!-- @impl: entrypoint.sh -->
<!-- @test: host/__tests__/memory-capture-block.test.js (memory-capture-block.sh describe blocks → AC1-AC5) -->

**Intent:** The UserPromptSubmit hook in REQ-MEM-001 emits an `additionalContext` directive instructing the agent to spawn the memory-capture subagent, but `additionalContext` is advisory: an agent that ignores it leaves the `.vars` dedup-gate file undrained, and because the 15-message delta logic in REQ-MEM-002 only fires fresh directives on threshold crossings, an entire long-running session can silently pass with zero captures. A companion PreToolUse hook closes this gap by hard-blocking every tool call except the memory-capture subagent itself while `.vars` exists, forcing the agent to drain the deferred work before doing anything else.

**Applies To:** Agent

**Acceptance Criteria:**

1. The hook is registered as PreToolUse with matcher `""` (matches every tool call) in advanced session mode only. When no `.vars` file exists for the current session (the common case), the hook exits 0 and the tool call proceeds without delay or instrumentation.
2. When the `session_id` field is missing from the hook input (defensive guard for malformed envelopes), the hook exits 0 silently rather than blocking.
3. When `.vars` exists at the session-scoped path AND the tool call is anything other than the allowed surface in AC4, the hook exits 2 with a stderr message that contains the literal string `HARD BLOCK`, the path to the persisted prompt file, the path to the `.vars` file, the directive `subagent_type: "memory-capture"`, `run_in_background: true`, and the literal `sonnet` (so the agent cannot downgrade the model). Exit 2 prevents the tool call from being delivered to its handler.
4. When `.vars` exists AND the tool call is `Task` with `tool_input.subagent_type == "memory-capture"`, the hook exits 0 and the call is delivered. Any other `subagent_type` (including absent) is blocked under AC3.
5. A one-shot bypass surface at `/tmp/memory-capture-bypass` lets a user manually unblock when `.vars` is stale beyond recovery (e.g., transcript path moved). When the file exists, the hook deletes it and exits 0; the next call without the bypass re-blocks if `.vars` is still present.

**Constraints:**

- The bypass is user-only (the assistant must never create `/tmp/memory-capture-bypass` itself); it exists for genuine recovery cases where the deferred capture cannot complete (e.g., the referenced transcript file was moved or deleted between fires).
- The block applies in advanced session mode only because the entire memory-capture pipeline is gated to advanced (see REQ-MEM-006).

**Priority:** P0

**Dependencies:** [REQ-MEM-001](#req-mem-001-conversation-context-automatically-captured-to-vault), [REQ-MEM-002](#req-mem-002-capture-triggers-every-15-user-messages), [REQ-MEM-006](#req-mem-006-memory-available-only-in-pro-advanced-mode)

**Verification:** Automated test

**Status:** Implemented
