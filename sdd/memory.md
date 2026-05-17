# Memory

Vault-based cross-session memory, automatic capture, hook delivery, and session-mode gating.

**Domain owner:** vault subsystem, entrypoint.sh, memory-capture.sh, preseed pipeline

### Key Concepts

- **Vault** -- `/home/user/Vault/`. Single source of truth for cross-session memory. Holds agent-written session captures (`Raw/Sessions/`) and user-curated notes (`Notes/`, `Raw/Pasted/`). Rclone-bisynced to R2.
- **Unified Graph** -- `~/.graphify/global-graph.json`. Hash-keyed merge of the vault's graph and every active repo's per-repo graph. Queried via `mcp__graphify__*`.
- **Capture** -- A sonnet agent runs every 15 user messages, extracts decisions/observations/references from the recent transcript, and writes them as a markdown file in `Raw/Sessions/`, then merges into the unified graph under `flock /tmp/graphify-global.lock`.
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

## REQ-MEM-001: Conversation context automatically captured to vault

**Intent:** Important conversation context (decisions, debugging insights, observations) must be extracted from the transcript and persisted to the vault without manual intervention.

**Acceptance Criteria:**
1. The `memory-capture.sh` script runs as a `UserPromptSubmit` hook, injecting a short instruction into the main agent's context via `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` + `exit 0`.
2. The hook counts real user messages in the JSONL transcript using a two-layer grep filter that excludes tool-result wrappers (content is an array, not a string) and synthetic messages (slash commands, task notifications -- content starts with `<`).
3. When triggered, the main agent spawns a background sonnet agent that reads the recent transcript and writes a markdown capture file into `/home/user/Vault/Raw/Sessions/{ISO_TS}-{SID_SHORT}.md`.
4. The capture file uses a YAML frontmatter template with `session_id`, `captured_at`, and `captured_from_range` fields followed by Context / Decisions / Observations / References sections.
5. The capture agent runs `graphify extract --file <file>` and `graphify global add ... --as user_vault` under `flock /tmp/graphify-global.lock` so the new content is queryable on the same turn it is written.
6. The hook handles tilde expansion in `transcript_path` (Claude Code may send tilde-prefixed paths).
7. All variables (transcript path, line offset, date, counts, counter file path) are written to a `.vars` JSON file to keep the context string short.
8. On the first message of a session (no counter file exists), the hook injects a `mcp__graphify__query_graph` directive into `additionalContext` instructing the agent to query the unified graph before responding.

**Constraints:**
- The hook runs in approximately 150ms (lightweight shell script, no heavy processing).
- Memory capture requires advanced session mode (the hook, plugin, and memory rule are only preseeded in advanced mode).

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-MEM-006, REQ-VAULT-002
**Verification:** Integration test (E2E verifies a capture file appears under `Raw/Sessions/` after 15 messages and its nodes show up in `mcp__graphify__query_graph`).

**Status:** Implemented

---

## REQ-MEM-002: Capture triggers every 15 user messages

**Intent:** Memory capture must fire at a regular interval to balance context freshness against overhead.

**Acceptance Criteria:**
1. The hook reads the counter file at `~/.memory/counter/{session_id}` (line 1: last summarized count, line 2: last line offset).
2. If no counter file exists (first run after container start), the hook writes a baseline from the current transcript count and injects the graphify-query directive (REQ-MEM-001 AC8) before exiting.
3. If the delta between the current user message count and the last summarized count is less than 15, the hook exits silently.
4. When the delta reaches 15, the hook writes the `.vars` file and emits the `additionalContext` instruction.
5. The counter is updated (current count + total lines) BEFORE emitting, preventing re-triggering on subsequent hook invocations within the same window.
6. The capture agent reads its line range from the vars file, not from the counter.

**Constraints:**
- Counter files are excluded from R2 sync (`--filter "- .memory/counter/**"`) since they are ephemeral per-session state.
- Each new session gets a new session ID, so old counter files are orphans.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-MEM-001
**Verification:** Automated test (unit test for counter delta logic in memory-capture.sh).

**Status:** Implemented

---

## REQ-MEM-004: Vault contents synced to R2 across sessions

**Intent:** Vault content (agent captures + user notes) must persist across container lifecycles by syncing to the user's R2 bucket.

**Acceptance Criteria:**
1. In advanced mode, `/home/user/Vault/` is included in rclone bisync via a `+` filter that precedes the global `**/graphify-out/**` exclude so vault graphify output still rides along.
2. On container boot, rclone pulls the vault from R2 before the vault skeleton init runs, so returning sessions inherit their persisted content untouched.
3. The vault skeleton init (`init_user_vault`) is idempotent and only creates subdirectories / config files when absent.
4. rclone bisync syncs changes back to R2 every 60s and on shutdown.
5. The ephemeral global-graph layer (`~/.graphify/`) is explicitly excluded from sync (rebuilt locally on every container boot from per-source graphs).
6. The shutdown handler watchdog allows the final bisync up to 60s to drain pending writes before SIGKILL.

**Constraints:**
- Rclone config uses `disable_checksum = true` to skip `X-Amz-Meta-Md5chksum` metadata on multipart uploads.
- `--s3-upload-cutoff 0` forces all uploads through the multipart path to prevent `BadDigest` TOCTOU race errors.
- Counter files are excluded from sync; only vault and ordinary workspace content are synced.

**Applies To:** User
**Priority:** P0
**Dependencies:** REQ-STOR-001, REQ-MEM-006, REQ-VAULT-001
**Verification:** Integration test (E2E verifies vault content persists across session restart).

**Status:** Implemented

---

## REQ-MEM-006: Memory available only in Pro (Advanced) mode

**Intent:** Vault persistence and automatic capture are gated behind the advanced session mode to control feature exposure and resource usage.

**Acceptance Criteria:**
1. In default mode, the vault directory is not preserved across container recreations (sync filters limit cross-session persistence to advanced-mode sessions).
2. In default mode, the capture hook still runs the in-session counter logic but vault writes are local-only.
3. The memory plugin, memory rule (`rules/memory.md`), vault plugin, and vault rule (`rules/vault.md`) are preseeded only in advanced mode.
4. Pro mode seeds a strict superset of Standard's preseed files; the memory and vault plugins/rules are part of the Pro-only delta.
5. `entrypoint.sh` merges hook registrations (PreToolUse and UserPromptSubmit) into `settings.json` only in advanced mode. Default mode gets only `skipDangerousModePermissionPrompt`.
6. `sessionMode` is stored as `'default' | 'advanced'` in `UserPreferences` (KV). Undefined defaults to `'default'` via `resolveSessionMode()`.
7. Mode changes take effect only on explicit "Recreate AI agent skills & rules" click or new bucket creation.
8. `reconcileAgentConfigs()` seeds mode-appropriate files and deletes preseed-managed files not in the current mode. It never touches user-created files.

**Constraints:**
- Plugin enablement in `.claude.json` is permanent (not mode-gated) because missing plugin files are silently skipped by Claude Code.
- Existing users are unaffected by mode changes until they explicitly recreate.
- `resolveSessionMode` result is clamped against the billing-resolved effective tier (a canceled user with stale `advanced` preference gets `default`).

**Applies To:** User
**Priority:** P1
**Dependencies:** REQ-SUB-014
**Verification:** Integration test (E2E verifies the vault subtree is absent in default mode after recreate, present in advanced).

**Status:** Implemented

---

## REQ-MEM-008: Memory prompt files preseeded via manifest pipeline

**Intent:** Memory capture prompt files must be deployed alongside the rest of the preseed content through the standard manifest pipeline.

**Acceptance Criteria:**
1. The capture prompt lives in `~/.claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md` (sonnet capture).
2. The codeflare-memory plugin includes three files in the manifest: `plugin.json`, `memory-capture.sh`, `memory-agent-prompt.md`.
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
**Verification:** Automated test (`generate-agent-seed.mjs` output includes memory plugin files).

**Status:** Implemented
