# Memory

MCP memory server, automatic memory capture, two-phase
capture/compact, and R2 sync of memory files. Agent-config preseed
content lives in [preseed.md](preseed.md).

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

Conversation context (decisions, debugging insights, solutions) is automatically summarized into MCP memory every 15 user messages. Zero manual intervention required. Implements [REQ-MEM-001](../sdd/memory.md#req-mem-001-conversation-context-automatically-captured-to-mcp-memory), [REQ-MEM-002](../sdd/memory.md#req-mem-002-capture-triggers-every-15-user-messages).

### Architecture -- Two-Phase Memory (Capture + Compact)

The memory system uses two phases with different models optimized for their task:

**Phase 1 -- Capture (sonnet, quality, every 15 messages):**
Meaningful observation capture into daily `chat-{TODAY}` entities. Sonnet extracts 3-5 quality observations per window -- decisions, insights, and context useful for future sessions. This is the "write-ahead log."

**Phase 2 -- Compact (opus, thorough, triggered at 5000 observations):**
When the capture agent detects the graph has grown past 5000 total observations, it writes a marker file (`{COUNTER_FILE}.compact`). The main agent detects this marker and spawns a background **opus** agent that restructures the entire graph: distilling raw `chat-*` entities into semantic entities (`project-*`, `*-architecture`, `*-session-archive`), building relations, deduplicating, and pruning stale data. Target: ~2000 total observations. Implements [REQ-MEM-003](../sdd/memory.md#req-mem-003-two-phase-memory-fast-capture--periodic-compaction), [REQ-MEM-007](../sdd/memory.md#req-mem-007-compaction-triggered-at-5000-observations).

```
UserPromptSubmit hook (~150ms)       Main agent                  Phase 1: sonnet capture    Phase 2: opus compact
    |                                    |                            |                          |
    +-- count user msgs                  |                            |                          |
    +-- delta < 15? -> exit              |                            |                          |
    +-- check lock -> exit               |                            |                          |
    +-- write .vars JSON                 |                            |                          |
    +-- output JSON + exit 0 -------> check .vars freshness           |                          |
                                    (skip if >60s stale)              |                          |
                                    create lock                       |                          |
                                    spawn sonnet agent -----------> read prompt + vars           |
                                         |                       read transcript                 |
                                    (continues normally)         save 3-5 obs to chat-{TODAY}    |
                                         |                       if obs >5000: write .compact    |
                                         |                       write counter, rm lock          |
                                    check .compact marker             |                          |
                                    if exists: spawn opus ----------------------------------> read full graph
                                                                                           distill chat-* -> semantic entities
                                                                                           build relations
                                                                                           deduplicate + prune
                                                                                           target ~2000 obs
                                                                                           rm .compact marker
```

### Hook Mechanics

The `memory-capture.sh` script runs as a **UserPromptSubmit hook** that uses the `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` + `exit 0` protocol to inject a short instruction into the main agent's context.

1. **Tilde expansion**: Expands `~` in `transcript_path` to `$HOME` (Claude Code may send tilde-prefixed paths).
2. **Message counting**: `grep -c '"role":"user","content":"[^<]' "$TRANSCRIPT"` counts real human prompts in the JSONL transcript. A plain `grep` is used instead of `jq` because `jq` silently fails on sidechain/agent JSONL entries (nested JSON). Two layers of synthetic messages are excluded: tool_result wrappers (content is an array, excluded by the trailing `"` requiring a string) and slash-command/task-notification wrappers (string content starting with `<`, excluded by `[^<]`). A second pass subtracts any remaining records with `isMeta:true`. The old pattern `'"type":"user"'` over-counted by ~17x on a live transcript (1451 vs 83 real prompts).
3. **Counter check**: Reads `~/.memory/counter/{session_id}` (line 1: last summarized count, line 2: last line offset). If no counter file exists (first run after container recycle or `/resume`), the hook baselines from the current transcript count and **writes the counter file immediately** -- this establishes the baseline so subsequent invocations can calculate the delta. If the delta is < 15, exits silently.
4. **Vars file**: Writes all variables (transcript path, line offset, date, counts, counter file path) to `~/.memory/counter/{session_id}.vars` as JSON -- keeps the context string short.
5. **Counter update**: Writes current count and total lines to the counter file before emitting. This prevents re-triggering: subsequent hook invocations see delta < 15 and exit silently. The agent reads its line range from the vars file, not from the counter.
6. **JSON output + exit 0**: Outputs `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` with a short instruction pointing to the prompt file and vars file. `additionalContext` only appears on the turn where the hook fired -- no stale replays. The main agent spawns the capture agent immediately with no additional checks.

### Prompt Files

Two prompt files live in `~/.claude/plugins/codeflare-memory/scripts/` (preseeded alongside the hook script):

**`memory-agent-prompt.md`** (sonnet capture):
- Reads transcript from line offset, extracts 3-5 observations
- Saves to `chat-{TODAY}` entity (daily raw capture bucket)
- Writes counter as first step (before reading transcript)
- Checks total observations -- if >5000, writes `.compact` marker file
- Does NOT attempt compaction itself

**`memory-compact-prompt.md`** (opus compaction):
- Reads full graph, identifies entity structure by domain
- Distills `chat-*` entities older than 3 days into semantic entities (`project-*`, `*-architecture`, `*-session-archive`, `user-preferences`, `reference-*`)
- Keeps recent `chat-*` (last 3 days) as raw buffer
- Deduplicates, prunes stale data, builds relations
- Target: ~2000 total observations
- Graph designed to grow over time as projects accumulate -- compaction targets ~2000 total observations across all entities

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

## Troubleshooting

- **Counter reset**: Delete `~/.memory/counter/{session_id}` to force
  re-summarization from the beginning of the transcript.
- **Capture agent not firing**: Check `~/.claude/settings.json` has a
  `UserPromptSubmit` hook entry pointing to `memory-capture.sh`.
  Verify the script exists at
  `~/.claude/plugins/codeflare-memory/scripts/memory-capture.sh`.
  Verify the transcript has 15+ user messages since last capture.
  Check `rules/memory.md` is loaded (advanced mode only).
- **Compaction not running**: Compaction triggers when the sonnet
  capture agent writes a `.compact` marker file (total observations
  >5000). The main agent detects this and spawns an opus agent.
  Check `~/.memory/counter/{session_id}.compact` exists. The opus
  agent reads `memory-compact-prompt.md` and removes the marker
  when done.

For hook registration, attribution-blocking, review-spawn
enforcement, or session-mode gating issues, see
[preseed.md](preseed.md#troubleshooting).

---

## Related Documentation

- [Preseed System](preseed.md) — session modes, manifest pipeline,
  multi-agent adaptation, hook registration
- [Container](container.md#claude-code-integration) — Claude Code
  configuration
- [Storage & Sync](storage-and-sync.md) — R2 sync of memory files
- [Architecture](architecture.md#system-components) — System overview
- [Decisions](decisions/README.md) — Architecture decisions
