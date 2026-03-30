# Memory & Preseed

Memory persistence system, automatic memory capture, session modes, and preseed deployment.

**Audience:** Developers

---

## Memory Persistence

Agent memory (knowledge graph via `@modelcontextprotocol/server-memory`) persists across sessions using per-session JSONL files synced to R2. **Memory persistence is gated on `SESSION_MODE=advanced`** -- in default mode, the entire `.memory/` directory is excluded from rclone sync and merge/cleanup are skipped (MCP memory still works in-session but doesn't survive container recreate).

**Lifecycle** (advanced mode only):
1. Container boots, rclone pulls `~/.memory/session-*.jsonl` files from R2
2. `entrypoint.sh` runs `merge_memory_files()`: consolidates all session files into `session-{SESSION_ID}.jsonl`, deduplicating entities (by name) and relations (by JSON equality)
3. `server-memory` MCP server reads/writes `session-{SESSION_ID}.jsonl` during the session
4. rclone bisync syncs changes back to R2 every 60s and on shutdown
5. `cleanup_old_memory_files()` removes old session files (keeps 5 newest) after bisync baseline is established

**Why per-session JSONL:** Multiple concurrent sessions from the same user write to the same R2 bucket. A shared file would cause last-write-wins data loss. Per-session JSONL files eliminate write conflicts -- each session owns its own file, and merge-on-boot consolidates them.

**Two-phase merge/cleanup:** The merge runs after R2 sync but before bisync baseline establishment. Old files are kept so `--resync` doesn't resurrect them. Cleanup (local-only deletion, KEEP=5) runs after bisync baseline succeeds, so periodic bisync propagates the deletions to R2. Direct R2 deletion is unsafe for concurrent sessions -- another session's bisync would propagate the deletion locally, destroying the active memory file. The rclone config uses `disable_checksum = true` to skip `X-Amz-Meta-Md5chksum` metadata on multipart uploads, and `--s3-upload-cutoff 0` forces all uploads through the multipart path to prevent `BadDigest` errors -- single-part PutObject pre-computes `Content-MD5` in a separate read pass, so files modified between hash and upload (TOCTOU race) cause R2 to reject with HTTP 400.

## Automatic Memory Capture

Conversation context (decisions, debugging insights, solutions) is automatically summarized into MCP memory every 30 user messages. Zero manual intervention required.

### Architecture -- Two-Phase Memory (Capture + Compact)

The memory system uses two phases with different models optimized for their task:

**Phase 1 -- Capture (haiku, fast, every 30 messages):**
Raw observation capture into daily `chat-{TODAY}` entities. Haiku's job is speed -- dump 3-5 observations per window without worrying about graph structure. This is the "write-ahead log."

**Phase 2 -- Compact (opus, thorough, triggered at 150 observations):**
When the capture agent detects the graph has grown past 150 total observations, it writes a marker file (`{COUNTER_FILE}.compact`). The main agent detects this marker and spawns a background **opus** agent that restructures the entire graph: distilling raw `chat-*` entities into semantic entities (`project-*`, `*-architecture`, `*-session-archive`), building relations, deduplicating, and pruning stale data. Target: 50-80 quality observations per active project.

```
UserPromptSubmit hook (~150ms)       Main agent                  Phase 1: haiku capture     Phase 2: opus compact
    |                                    |                            |                          |
    +-- count user msgs                  |                            |                          |
    +-- delta < 30? -> exit              |                            |                          |
    +-- check lock -> exit               |                            |                          |
    +-- write .vars JSON                 |                            |                          |
    +-- output JSON + exit 0 -------> check .vars freshness           |                          |
                                    (skip if >60s stale)              |                          |
                                    create lock                       |                          |
                                    spawn haiku agent -----------> read prompt + vars            |
                                         |                       read transcript                 |
                                    (continues normally)         save 3-5 obs to chat-{TODAY}    |
                                         |                       if obs >150: write .compact     |
                                         |                       write counter, rm lock          |
                                    check .compact marker             |                          |
                                    if exists: spawn opus ----------------------------------> read full graph
                                                                                           distill chat-* -> semantic entities
                                                                                           build relations
                                                                                           deduplicate + prune
                                                                                           target 50-80 obs
                                                                                           rm .compact marker
```

### Hook Mechanics

The `memory-capture.sh` script runs as a **UserPromptSubmit hook** that uses the `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` + `exit 0` protocol to inject a short instruction into the main agent's context.

1. **Tilde expansion**: Expands `~` in `transcript_path` to `$HOME` (Claude Code may send tilde-prefixed paths).
2. **Message counting**: `jq -r '.type' "$TRANSCRIPT" | grep -c '^user$'` counts user messages in the JSONL transcript.
3. **Counter check**: Reads `~/.memory/counter/{session_id}` (line 1: last summarized count, line 2: last line offset). If no counter file exists (first run after container recycle or `/resume`), the hook baselines from the current transcript count and **writes the counter file immediately** -- this establishes the baseline so subsequent invocations can calculate the delta. If the delta is < 30, exits silently.
4. **Vars file**: Writes all variables (transcript path, line offset, date, counts, counter file path) to `~/.memory/counter/{session_id}.vars` as JSON -- keeps the context string short.
5. **Counter update**: Writes current count and total lines to the counter file before emitting. This prevents re-triggering: subsequent hook invocations see delta < 30 and exit silently. The agent reads its line range from the vars file, not from the counter.
6. **JSON output + exit 0**: Outputs `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` with a short instruction pointing to the prompt file and vars file. `additionalContext` only appears on the turn where the hook fired -- no stale replays. The main agent spawns the capture agent immediately with no additional checks.

### Prompt Files

Two prompt files live in `~/.claude/plugins/codeflare-memory/scripts/` (preseeded alongside the hook script):

**`memory-agent-prompt.md`** (haiku capture):
- Reads transcript from line offset, extracts 3-5 observations
- Saves to `chat-{TODAY}` entity (daily raw capture bucket)
- Writes counter as first step (before reading transcript)
- Checks total observations -- if >150, writes `.compact` marker file
- Does NOT attempt compaction itself

**`memory-compact-prompt.md`** (opus compaction):
- Reads full graph, identifies entity structure by domain
- Distills `chat-*` entities older than 3 days into semantic entities (`project-*`, `*-architecture`, `*-session-archive`, `user-preferences`, `reference-*`)
- Keeps recent `chat-*` (last 3 days) as raw buffer
- Deduplicates, prunes stale data, builds relations
- Target: 50-80 observations per active project
- Graph designed to grow over time as projects accumulate -- compaction is per-project, not global

### Counter Storage

```
~/.memory/counter/
+-- {session_id}         # Two lines: last_count, last_line_offset
+-- {session_id}.vars    # Variables JSON for current hook invocation
+-- {session_id}.compact # Marker file signaling compaction needed (created by capture agent)
```

- All counter files are **excluded from sync** via `--filter "- .memory/counter/**"` -- they are ephemeral per-session state (each session gets a new sessionID, old counters are orphans).
- In **advanced mode**, the `.memory/` directory itself IS synced (it contains the MCP memory JSONL files used across sessions).
- In **default mode**, the entire `.memory/**` directory is excluded from sync via a conditional `SESSION_MODE` check.

## Session Modes

Users can choose between **Default** and **Advanced** session modes via Settings > Session Defaults. The mode controls which preseed files are deployed on Recreate or new bucket creation.

| Content | Default | Advanced |
|---------|---------|----------|
| Memory plugin & rule | No | Yes |
| CI monitoring, environment, no-local-builds, deploy-credentials rules | Yes | Yes |
| Cloudflare stack, ship, ship references skills | Yes | Yes |
| `consult-llm` skill (CC only) | No | Yes |
| `block-attributed-commits` hook (CC only) | No | Yes |
| Language rules (23 files: common, TS, Python, Go, Swift) | No | Yes |
| Agent definitions (7: architect, code-reviewer, etc.) | No | Yes |
| Commands (5: /brainstorm, /debug, /deploy, /plan, /review) | No | Yes |
| Cherry-picked skills (8: api-design, backend-patterns, etc.) | No | Yes |
| Known marketplaces plugin config | Yes | Yes |

**Storage**: `sessionMode?: 'default' | 'advanced'` in `UserPreferences` (KV). Undefined = `'default'`.

**Resolver**: `resolveSessionMode(prefs)` in `src/lib/session-mode.ts` -- single source of truth for the `?? 'default'` fallback.

**When mode takes effect**: Only on explicit "Recreate AI agent skills & rules" click or new bucket creation. Existing users keep all their current R2 files until they Recreate.

**Cleanup on Recreate**: `reconcileAgentConfigs()` seeds mode-appropriate files then deletes preseed-managed files not in the current mode. Strictly scoped to keys from `AGENTS_SEEDED_CONFIGS` -- no bucket listing, no prefix scans, never touches user-created files. `getPreseedKeysNotInMode()` excludes variant-per-mode keys (instruction files that exist in both modes with different content) to avoid deleting a file that was just seeded. Partial delete failures return `warnings` without failing the overall operation. `getConfigsForMode()` validates no duplicate keys within a single mode.

**No migration**: Existing users are unaffected. Changes only happen on explicit action.

## Preseed System

### Preseed Components

ECC-derived rules, agents, commands, and skills are preseeded directly to the agent config filesystem. No external plugins are installed.

**Agents (7)**: `architect`, `build-error-resolver`, `code-reviewer`, `doc-updater`, `refactor-cleaner`, `security-reviewer`, `tdd-guide`. Preseeded to `~/.claude/agents/*.md` (and adapted equivalents for other agents) via the manifest pipeline with `"modes": ["advanced"]`. Each agent definition has YAML frontmatter with `name`, `description`, `tools` (emitted as a record `{read: true, write: true}` for OpenCode, instead of array format), and `model` (CC only).

**Commands (5)**: `brainstorm`, `debug`, `deploy`, `plan`, `review`. Preseeded to `~/.claude/commands/*.md` (CC only -- other agents don't support slash commands).

**Skills (13 files, 11 unique skills)**: `cloudflare-stack`, `ship` (+ 2 reference files), `consult-llm`, `api-design`, `backend-patterns`, `content-hash-cache-pattern`, `database-migrations`, `deployment-patterns`, `frontend-patterns`, `iterative-retrieval`, `search-first`. Preseeded to `~/.claude/skills/<name>/SKILL.md` (and adapted equivalents for agents that support skills). `consult-llm` is CC-only (depends on MCP tool).

**Rules (28 files, 4 in both modes + 24 advanced-only)**: Core environment rules (`ci-monitoring`, `cloudflare-environment`, `no-local-builds`, `deploy-credentials`) in both modes. `memory` rule is advanced-only (depends on MCP memory server). ECC-derived language rules in `{common,typescript,python,golang,swift}/` subdirs (3 + 5*4 = 23 files, advanced only). Common rules cover security, coding style, and git workflow. Language-specific rules provide conventions for TypeScript, Python, Go, and Swift.

**Known marketplaces**: `plugins/known_marketplaces.json` preseeds the official Anthropic plugin marketplace URL for user discovery.

**Updates**: Preseed files update when the pipeline is redeployed and users click "Recreate AI agent skills & rules".

### Preseed Deployment

All preseed content is deployed via the manifest pipeline:

1. Source files in `preseed/agents/claude/` organized by type: `rules/`, `agents/`, `commands/`, `skills/`, `plugins/`
2. `preseed/agents/claude/manifest.json` maps each file to modes (`default`, `advanced`, or both)
3. `scripts/generate-agent-seed.mjs` reads manifest + files (manifest-driven, ignores non-manifest files like `plugins/cache/`), generates `src/lib/agent-seed.generated.ts` with `AGENTS_SEEDED_CONFIGS` array (121 documents across all agents)
4. On first bucket creation: `reconcileAgentConfigs(mode, { overwrite: false, cleanup: false })` writes mode-appropriate files to R2
5. On "Recreate skills & rules" button: `reconcileAgentConfigs(mode, { overwrite: true, cleanup: true })` overwrites in R2 and deletes files not in current mode
6. Bisync pulls from R2 to container config directories (`~/.claude/`, `~/.codex/`, `~/.gemini/`, `~/.copilot/`, `~/.config/opencode/`)

**Manifest structure (56 total entries)**:
- `rules/` (24): core (4 default+advanced: ci-monitoring, cloudflare-environment, no-local-builds, deploy-credentials; + 1 advanced-only: memory), common (3), typescript (4), python (4), golang (4), swift (4)
- `agents/` (7): architect, build-error-resolver, code-reviewer, doc-updater, refactor-cleaner, security-reviewer, tdd-guide (advanced only)
- `commands/` (5): brainstorm, debug, deploy, plan, review (advanced only)
- `skills/` (13): cloudflare-stack, ship (+2 refs), consult-llm, api-design, backend-patterns, content-hash-cache-pattern, database-migrations, deployment-patterns, frontend-patterns, iterative-retrieval, search-first
- `plugins/` (7): known_marketplaces.json (default+advanced), codeflare-memory plugin (4 files, advanced only: plugin.json, memory-capture.sh, memory-agent-prompt.md, memory-compact-prompt.md), codeflare-hooks plugin (2 files, advanced only: plugin.json, block-attributed-commits.sh)

### Multi-Agent Preseed

The generator produces adapted config files for all supported agents from CC's preseed as single source of truth. No duplicate preseed files exist on disk.

**Supported agents and their config locations:**

| Agent | Global Instructions | Skills | Custom Agents |
|-------|-------------------|--------|---------------|
| CC | `~/.claude/rules/*.md` (individual) | `~/.claude/skills/<name>/SKILL.md` | `~/.claude/agents/*.md` |
| Codex | `~/.codex/AGENTS.md` (single file) | `~/.codex/skills/<name>/SKILL.md` | N/A |
| Gemini | `~/.gemini/GEMINI.md` (single file) | `~/.gemini/skills/<name>/SKILL.md` | `~/.gemini/agents/*.md` |
| Copilot | `~/.copilot/copilot-instructions.md` (single file) | N/A | `~/.copilot/agents/<name>.agent.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` (single file) | `~/.config/opencode/skills/<name>/SKILL.md` | `~/.config/opencode/agents/*.md` |

**Tool name mapping** (adapted in agent definition frontmatter):

| CC | Codex | Gemini | Copilot | OpenCode |
|--------|-------|--------|---------|----------|
| Read | read | read_file | read | read |
| Write | write | write_file | editFiles | write |
| Edit | edit | replace | editFiles | edit |
| Bash | shell | run_shell_command | execute | bash |
| Grep | grep | search_file_content | search | search |
| Glob | glob | glob | search | glob |

**What each agent gets:**

| Agent | Instructions | Skills | Agents | Total |
|-------|-------------|--------|--------|-------|
| CC | 0 (individual rules) | 13 | 7 | 59 (all categories) |
| Codex | 2 (default+advanced) | 12 | 0 | 14 |
| Gemini | 2 | 12 | 7 | 21 |
| Copilot | 2 | 0 | 7 | 9 |
| OpenCode | 2 | 12 | 7 | 21 |
| **Total** | | | | **121** |

**Excluded from non-CC agents**: hooks (CC hook system), commands (CC slash commands), plugins (CC plugin system, including codeflare-memory), `rules/memory.md` (depends on MCP memory server), `consult-llm` skill (depends on CC-specific MCP tool).

**Adaptation pipeline**: For each non-CC agent, the generator: (1) concatenates applicable rules into a single instructions file, (2) remaps tool names in agent definition frontmatter, (3) removes `model` field from frontmatter, (4) replaces `~/.claude/` path references with agent-specific config paths, (5) uses correct file extensions (e.g., `.agent.md` for Copilot agents).

**Per-mode counts**: Default mode seeds 25 files, advanced mode seeds 117 files. Total array size is 121 (includes variant-per-mode duplicates for instructions files).

**Variant-per-mode keys**: Instructions files appear twice in the generated array -- once for default mode (3 rules) and once for advanced mode (all rules including memory, ECC), with the same R2 key but different content. `getPreseedKeysNotInMode()` handles this correctly by excluding keys that have a variant in the target mode.

### Settings.json Merge

`entrypoint.sh` merges settings into `~/.claude/settings.json` using `jq '. * $cfg'` recursive merge. In advanced mode, this includes `skipDangerousModePermissionPrompt` plus hook registrations (PreToolUse and UserPromptSubmit). In default mode, only `skipDangerousModePermissionPrompt` is merged (no hooks). Handles three cases:

- **File doesn't exist**: Creates with settings config
- **File exists**: Recursive merge preserving user's existing settings (statusLine, permissions, etc.)
- **File malformed**: Skips with warning, does not overwrite

### Plugin Enablement

`entrypoint.sh` merges `enabledPlugins` into `~/.claude/.claude.json` to enable both the `codeflare-memory` and `codeflare-hooks` plugins. This is permanent (not mode-gated) because missing plugins are silently skipped by Claude Code -- when the plugin files are absent in default mode, the plugins simply don't load. Plugins are used for file organization and delivery via R2 sync only -- hook registration is done via `settings.json` (see above).

- **codeflare-memory**: Scripts for memory capture (hook registered in settings.json, scripts delivered via plugin)
- **codeflare-hooks**: Scripts for commit attribution blocking (hook registered in settings.json, scripts delivered via plugin)

## Troubleshooting

- **Counter reset**: Delete `~/.memory/counter/{session_id}` to force re-summarization from the beginning of the transcript.
- **Agent not firing**: Check `~/.claude/settings.json` has `UserPromptSubmit` hook entry pointing to `memory-capture.sh`. Verify the script exists at `~/.claude/plugins/codeflare-memory/scripts/memory-capture.sh`. Verify the transcript has 30+ user messages since last capture. Check `rules/memory.md` is loaded (advanced mode only).
- **Compaction not running**: Compaction triggers when haiku writes a `.compact` marker file (total observations >150). The main agent detects this and spawns an opus agent. Check `~/.memory/counter/{session_id}.compact` exists. The opus agent reads `memory-compact-prompt.md` and removes the marker when done.
- **Attribution blocking not working**: Check `~/.claude/settings.json` has `PreToolUse` hook entry pointing to `block-attributed-commits.sh`. Verify the script exists at `~/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh`.
- **Default mode has hooks**: If `settings.json` has hook entries in default mode, the entrypoint SESSION_MODE gating may have failed. Remove them: `jq 'del(.hooks)' ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json`.

---

## Related Documentation
- [Container](container.md#claude-code-integration) - Claude Code configuration
- [Storage & Sync](storage-and-sync.md) - R2 sync of memory files
- [Architecture](architecture.md#system-components) - System overview
- [Decisions](decisions/README.md) - Architecture decisions
