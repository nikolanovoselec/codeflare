# Memory

Cross-session memory in codeflare lives entirely in the **vault** at
`/home/user/Vault/`. Graphify ingests every vault file into
the unified global graph; agents query it via `mcp__graphify__*`. The
former MCP `@modelcontextprotocol/server-memory` subsystem has been
removed.

**Audience:** Developers

---

## Contents

- [Memory Persistence](#memory-persistence)
- [Automatic Memory Capture](#automatic-memory-capture)
- [Hook Mechanics](#hook-mechanics)
- [Counter Storage](#counter-storage)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

---

## Memory Persistence

The vault (`/home/user/Vault/`) is rclone-bisynced to R2 as
part of `/home/user/`. Both agent-written session captures
(`Raw/Sessions/`) and user-curated content under `Notes/`, `Inbox/`,
`Journal/` (plus any attachments SilverBullet writes next to those
notes) survive container recycles. Memory persistence runs in advanced
mode only; default-mode sessions still execute the capture hook for
in-session context but the vault subtree never reaches R2.

The unified graph at `~/.graphify/global-graph.json` is the index layer:
the capture agent, the vault-monitor agent, and `graphify-active-repo.sh`
all merge their respective per-source graphs into it under a `flock` on
`/tmp/graphify-global.lock`. See [vault.md](./vault.md) for vault
layout, capture paths, and the unified graph contract.

## Automatic Memory Capture

Conversation context (decisions, debugging insights, observations) is
automatically captured into the vault every 15 user messages. Implements
[REQ-MEM-001](../../sdd/spec/memory.md#req-mem-001-conversation-context-automatically-captured-to-vault),
[REQ-MEM-002](../../sdd/spec/memory.md#req-mem-002-capture-triggers-every-15-user-messages),
[REQ-MEM-008](../../sdd/spec/memory.md#req-mem-008-memory-prompt-files-preseeded-via-manifest-pipeline),
[REQ-MEM-010](../../sdd/spec/memory.md#req-mem-010-memory-capture-hook-plumbing).

The capture agent writes a markdown file to
`Raw/Sessions/{ISO_TS}-{SID_SHORT}.md` (YAML frontmatter + Context /
Decisions / Observations / References sections), then runs graphify
extraction + `graphify global add --as user_vault` under the global lock so
the new content is queryable on the same turn it is written.

There is no automated compactor; `Raw/Sessions/` is append-only
and the user prunes it via SilverBullet when needed.

## Hook Mechanics

The `memory-capture.sh` script runs as a **UserPromptSubmit hook**.

1. **Tilde expansion** -- expands `~` in `transcript_path` to `$HOME`.
2. **Message counting** -- `grep -c '"role":"user","content":"[^<]' "$TRANSCRIPT"`
   counts real human prompts. Two layers of synthetic messages are
   excluded: tool_result wrappers (array content, excluded by the
   trailing `"`) and slash-command/task-notification wrappers (string
   content starting with `<`, excluded by `[^<]`).
3. **Counter check** -- reads `~/.memory/counter/{session_id}` (line 1:
   last count, line 2: last line offset). First run after container
   recycle or `/resume` baselines from the current transcript and writes
   the counter immediately. If the delta is `< 15`, exits silently
   (optionally emitting a graphify-query nudge on the first message).
4. **Vars file** -- writes transcript path, offsets, date, counts, and
   counter path to `~/.memory/counter/{session_id}.vars` as JSON.
5. **Counter update** -- writes current count + total lines back to the
   counter before emitting so subsequent invocations see delta `< 15`.
6. **JSON output** -- emits `{hookSpecificOutput:{...,additionalContext}}`
   with a mandatory directive: the main agent MUST spawn the **memory-capture**
   subagent (Task tool, `subagent_type="memory-capture"`, `run_in_background=true`)
   before any other work. The companion `memory-capture-block.sh` PreToolUse hook
   hard-blocks all tool calls until the subagent is spawned. The subagent's
   frontmatter pins `model: sonnet` (AD58); the main agent must not pass a model
   override.

The capture agent deletes the `.vars` file as its first step (dedup
gate), runs `prefilter-transcript.sh` (jq filter that strips tool I/O,
slash-command wrappers, and meta records -- 76x size reduction on a
typical transcript), splits the clean NDJSON into chunks, processes each
chunk into a scratchpad, then synthesises the final vault note and merges
into the global graph. See [AD58](../decisions/README.md#ad58-sonnet-for-memory-capture-with-prefilter-and-scratchpad)
for the rationale (recency bias + haiku confabulation that motivated the
switch from haiku to sonnet).

Between the dedup-gate step and the prefilter step, the agent must
execute the prompt's mandatory Step 1.5 Bash block to derive `ISO_TS`
(REQ-MEM-010 AC5). The block resolves the user's timezone, runs `date`
to produce a stamp like `2026-05-23T22-11-09+0200`, then runs three
assertions and exits non-zero if any fail: (a) the stamp must end with a
four-digit `[+-]NNNN` offset; (b) that offset must equal what
`TZ="$RESOLVED" date '+%z'` produces (catches dropped-TZ-wrapper bugs
like issue #416 without false-positiving legitimately-UTC hosts); (c)
the reconstructed epoch must be within 30 seconds of the wall clock
(catches LLM fabrications that typically drift hours). Assertion failure
**halts the capture** -- no vault file is written, no graph merge runs.
The captured ISO_TS string is the single source of truth for the
filename and the `captured_at` frontmatter field; both must contain
identical bytes.

## Counter Storage

```
~/.memory/counter/
+-- {session_id}         # Two lines: last_count, last_line_offset
+-- {session_id}.vars    # Variables JSON for current hook invocation
```

Counter files are excluded from sync via
`--filter "- .memory/counter/**"` (ephemeral per-session state -- each
session gets a new sessionID, old counters are orphans). The rest of
`.memory/` survives because the directory persists across the MCP
removal as the hook gate; no JSONL graph files are written there
anymore.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Capture not firing | Counter not yet baselined, or transcript has `<15` new prompts | Check `~/.memory/counter/{session_id}` mtime; send a few more prompts and watch |
| Capture spawns but no vault file | Capture agent failed mid-write | Check the agent's transcript for errors; the `.vars` file is gone but the counter has advanced -- next 15-prompt window will try again |
| Capture spawns, no vault file, agent transcript shows `ISO_TS_ASSERTION_FAILED:` | Step 1.5 Bash block rejected the timestamp (REQ-MEM-010 AC5) | Read the agent transcript for the exact failure: `missing TZ offset` (Assertion 1 - bad stamp shape), `offset X does not match TZ=Y` (Assertion 2 - dropped TZ wrapper, the #416 symptom), or `drifts Ns from current clock` (Assertion 3 - agent fabricated the timestamp instead of running `date`). Fail-closed is intentional: the capture halts rather than write a wrong timestamp to the vault. Next 15-prompt window retries |
| `mcp__graphify__query_graph` returns nothing | Global graph not built or wrapper still on per-repo | Verify `~/.graphify/global-graph.json` exists; restart MCP wrapper (it polls on a 2s loop) |
| Same file extracted twice | Concurrent capture + vault-monitor tick | Both serialise via `flock -w 5 /tmp/graphify-global.lock`; safe, but the last writer wins for that specific file's nodes |

For hook registration, attribution-blocking, review-spawn enforcement,
or session-mode gating issues, see [preseed.md](preseed.md#troubleshooting).

---

## Related Documentation

- [Vault](vault.md) -- vault layout, capture/edit paths, unified graph contract
- [Preseed System](preseed.md) -- session modes, manifest pipeline, hook registration
- [Storage & Sync](storage-and-sync.md) -- R2 bisync mechanics
- [Architecture](architecture.md#system-components) -- System overview
- [Decisions](../decisions/README.md) -- Architecture decisions
