#!/usr/bin/env bash
# UserPromptSubmit hook — triggers main agent to capture conversation into the vault.
# Injects additionalContext when 15+ new user messages since last capture.
# The main agent spawns a background Task agent to do the actual work.
set -e

USER_HOME="${HOME:-/home/user}"
# Counter lives under /tmp by codeflare convention: every session start or
# resume is a full container recycle (only R2-synced state survives), so
# /tmp is guaranteed-empty on resume. This is the same pattern other
# session-scoped hooks use. Side-effect: the counter file's absence on the
# first hook fire is the canonical "fresh container" signal - see below.
# MEMCAP_COUNTER_DIR override exists for hermetic tests; production never sets it.
COUNTER_DIR="${MEMCAP_COUNTER_DIR:-/tmp/.memory-counter}"
mkdir -p "$COUNTER_DIR"

INPUT=$(cat)

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null) || true
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true

# Sanitize session_id before it is used to build any path. The sibling
# memory-context-inject.sh has done this since it was written; these two never
# did, and both interpolate it straight into /tmp paths — SESSION_ID='../../x'
# escapes the counter directory. Same guard, verbatim, so the three hooks agree.
case "$SESSION_ID" in
  *..* | */* | *\\*) exit 0 ;;
esac
[[ "$SESSION_ID" =~ ^[a-zA-Z0-9_-]+$ ]] || exit 0

TRANSCRIPT="${TRANSCRIPT/#\~/$USER_HOME}"
[[ -z "$TRANSCRIPT" || -z "$SESSION_ID" || ! -f "$TRANSCRIPT" ]] && exit 0

# Count REAL user prompts only — messages a human actually typed.
#
# The Claude CLI writes many synthetic messages to the transcript with
# `role:"user"`, all of which the naive grep `'"type":"user"'` would
# match. Two over-counting layers to peel off:
#
#   Layer 1 — tool_result wrappers
#     `{"type":"user", message:{role:"user", content:[{type:"tool_result",...}]}}`
#     Created on every Bash, Read, Edit, etc. tool call return.
#     Distinguished by `content` being an array `[...]` instead of a string.
#     `'"role":"user","content":"'` (with trailing quote) excludes them.
#
#   Layer 2 — slash-command + task-notification wrappers
#     `{"type":"user", message:{role:"user", content:"<local-command-caveat>..."}}`
#     `{"type":"user", message:{role:"user", content:"<command-name>/foo</command-name>"}}`
#     `{"type":"user", message:{role:"user", content:"<command-message>...</command-message>"}}`
#     `{"type":"user", message:{role:"user", content:"<command-args>...</command-args>"}}`
#     `{"type":"user", message:{role:"user", content:"<local-command-stdout>..."}}`
#     `{"type":"user", message:{role:"user", content:"<task-notification>..."}}`
#     Plus any record with `isMeta: true`.
#     All of these have string content but start with a `<` tag.
#     `[^<]` after the opening quote excludes them.
#
# Empirical test (4124-line aa375f82 transcript):
#   old grep '"type":"user"'                       → 1451 (counts everything)
#   '"role":"user","content":"'                    →  241 (string-only, includes synthetic)
#   '"role":"user","content":"[^<]'                →   83 (real human prompts) ✓
#
# All observed `isMeta:true` records in the transcript also have content
# starting with `<` (they ARE the slash-command wrappers), so the Layer 1
# `[^<]` filter already excludes them. No second-pass isMeta subtraction
# needed; an earlier draft of this fix tried it with the wrong field
# order and produced 0 anyway.
# DO NOT drop the `|| CURRENT_COUNT=0` tail. `set -e` is active (line 5) and
# `grep -c` exits 1 when the pattern has zero matches (legitimate on a fresh
# transcript). Without the fallback the hook crashes silently inside Claude
# Code with no user-visible error.
CURRENT_COUNT=$(grep -c '"role":"user","content":"[^<]' "$TRANSCRIPT") || CURRENT_COUNT=0

COUNTER_FILE="$COUNTER_DIR/${SESSION_ID}"
VARS_FILE="$COUNTER_DIR/${SESSION_ID}.vars"
LATCH_FILE="$COUNTER_DIR/${SESSION_ID}.latched"
# Pi's extractionDue latch: deliver a request at most six times, then stop
# reminding and let a later arm replace it (memory-vault-helpers.ts::extractionDue,
# memory-vault.ts:630). Bounded re-delivery is what replaced the hard block —
# a directive the agent skips comes back next prompt instead of freezing the
# session, so an ignored capture can no longer vanish silently.
MAX_DELIVERIES=6
REARM_AFTER=15
MEMORY_SCAN=""
FORCE_RESUME=""

emit_context() {
    [[ -z "$1" ]] && exit 0
    jq -n --arg ctx "$1" '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$ctx}}'
    exit 0
}

capture_directive() {
    printf '%s' "MEMORY CAPTURE (background, non-blocking): a capture request is outstanding at ${1} (delivery ${2}/${MAX_DELIVERIES}). Spawn the memory-capture subagent with run_in_background=true and carry on with the user's work in the same turn; nothing is gated on it. Pass PROMPT_FILE=${USER_HOME}/.claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md and VARS_FILE=${1}. The request names the capture file to write, so write that exact path. If you do not spawn it, this reminder returns on the next prompt and is dropped after ${MAX_DELIVERIES} deliveries."
}
if [[ -f "$COUNTER_FILE" ]]; then
    # Mid-session: counter present, normal 15-prompt cadence.
    last_count=$(head -1 "$COUNTER_FILE" 2>/dev/null) || last_count=0
    last_line=$(tail -1 "$COUNTER_FILE" 2>/dev/null) || last_line=1
    [[ "$last_count" =~ ^[0-9]+$ ]] || last_count=0
    [[ "$last_line" =~ ^[0-9]+$ ]] || last_line=1
else
    # No counter file = fresh container instance. In codeflare, every
    # session start or resume is a complete container recycle (Cloudflare
    # Containers: "All disk is ephemeral. When a Container instance goes to
    # sleep, the next time it is started, it will have a fresh disk as
    # defined by its container image."), so /tmp is guaranteed empty.
    # The counter's absence is therefore the canonical "fresh container"
    # signal. Distinguish two sub-cases by transcript content:
    #
    #   (a) Brand-new session: the hook fires on the first user prompt and
    #       CURRENT_COUNT == 1 (just the one message in the transcript).
    #       Baseline and exit; the directive nudges the agent to query the
    #       unified graph for context.
    #
    #   (b) Resumed session: the container was recycled but the transcript
    #       persisted (claude --resume restores it), so CURRENT_COUNT > 1.
    #       Force-fire a capture from the start of the transcript to flush
    #       any tail from the prior session that never reached the 15-prompt
    #       boundary, AND re-emit the graph-query directive because the
    #       agent's in-context recall of prior decisions is gone.
    MEMORY_SCAN="BEFORE responding, query the unified graph for context. Use mcp__graphify__query_graph (or mcp__graphify__get_node for a known concept) with terms from the user's message to surface prior decisions, vault notes, and per-repo references."
    if [[ $CURRENT_COUNT -gt 1 ]]; then
        last_count=0
        last_line=1
        FORCE_RESUME=1
    else
        last_count=$CURRENT_COUNT
        last_line=$(wc -l < "$TRANSCRIPT")
        printf '%s\n%s\n' "$last_count" "$last_line" > "$COUNTER_FILE"
    fi
fi

# An outstanding request owns the session until it is published or latched.
# Pi returns { kind: "none" } for a request already delivered or still running
# rather than stacking a second one, so arming is skipped entirely below.
if [[ -f "$VARS_FILE" ]]; then
    if [[ -f "$LATCH_FILE" ]]; then
        latched_at=$(head -1 "$LATCH_FILE" 2>/dev/null) || latched_at=0
        [[ "$latched_at" =~ ^[0-9]+$ ]] || latched_at=0
        # A latched request is never retried; a later arm replaces it. This is
        # Pi's `facts.giveup && currentCount >= request.promptCount + 15`.
        if [[ $CURRENT_COUNT -lt $((latched_at + REARM_AFTER)) ]]; then
            emit_context "$MEMORY_SCAN"
        fi
        rm -f "$LATCH_FILE" "$VARS_FILE"
    else
        attempts=$(jq -r '.attempts // 0' "$VARS_FILE" 2>/dev/null) || attempts=0
        [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=0
        if [[ $attempts -ge $MAX_DELIVERIES ]]; then
            printf '%s\n' "$CURRENT_COUNT" > "$LATCH_FILE"
            emit_context "${MEMORY_SCAN}${MEMORY_SCAN:+ }Memory capture gave up after ${MAX_DELIVERIES} undelivered reminders. The committed counter was not advanced, so nothing was lost; a replacement request may arm after ${REARM_AFTER} further prompts. Do not spawn a capture now."
        fi
        attempts=$((attempts + 1))
        # jq cannot edit in place, and the request is the only copy of the
        # window being captured — write beside it and rename, so a crashed
        # write cannot truncate it.
        if tmp=$(mktemp "${VARS_FILE}.XXXXXX" 2>/dev/null) \
           && jq --argjson n "$attempts" '.attempts = $n' "$VARS_FILE" > "$tmp" 2>/dev/null; then
            mv -f "$tmp" "$VARS_FILE"
        else
            # A delivery that cannot be counted is a delivery that never stops:
            # every later prompt would re-read the same attempts value, re-emit,
            # and never reach the bound this whole design exists to enforce.
            # Latch instead, so the failure ends the loop rather than opening it.
            [[ -n "${tmp:-}" ]] && rm -f "$tmp"
            printf '%s\n' "$CURRENT_COUNT" > "$LATCH_FILE"
            echo "memory-capture: cannot record delivery count; latching request at $VARS_FILE" >&2
            emit_context "$MEMORY_SCAN"
        fi
        emit_context "${MEMORY_SCAN}${MEMORY_SCAN:+ }$(capture_directive "$VARS_FILE" "$attempts")"
    fi
fi

DELTA=$((CURRENT_COUNT - last_count))
if [[ $DELTA -lt 15 ]] && [[ -z "$FORCE_RESUME" ]]; then
    emit_context "$MEMORY_SCAN"
fi

TODAY=$(date +%Y-%m-%d)
TOTAL_LINES=$(wc -l < "$TRANSCRIPT")

# The capture filename is fixed HERE, at arm time, rather than invented by the
# subagent at run time. Pi does the same (createMemoryRequest computes
# captureTimestamp and captureFilename up front) and it buys two things: the
# session's graph identity is deterministic, and a filename the hook chose is a
# filename the hook can later look for — which is what lets success be read off
# an artifact instead of taken from the subagent's own word for it.
# assert-iso-ts.sh already owns timezone resolution (USER_TIMEZONE -> TZ ->
# /etc/timezone -> UTC) and the offset/drift assertions that REQ-MEM-010
# AC4-AC7 describe. Moving the timestamp here must not fork that chain: an
# inline `date` silently narrowed it to UTC whenever both env vars were unset,
# which is the #416 class of bug in a new place. Resolve the helper next to
# this script so it is found from preseed, from ~/.claude, and under test.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISO_LINE=$(bash "$HOOK_DIR/assert-iso-ts.sh" 2>/dev/null | grep '^ISO_TS=') || ISO_LINE=""
CAPTURE_TS="${ISO_LINE#ISO_TS=}"
# Fail closed: no trustworthy timestamp means no request. The window stays
# uncommitted and the next prompt arms again, which is the same outcome as any
# other failed capture.
[[ -n "$CAPTURE_TS" ]] || emit_context "$MEMORY_SCAN"
CAPTURE_FILE="${USER_HOME}/Vault/Raw/Sessions/${CAPTURE_TS}-${SESSION_ID:0:8}.md"

# A capture that published while latched removes the carrier but can leave the
# latch behind; a fresh request must not inherit it and be born given-up.
rm -f "$LATCH_FILE"

jq -n \
  --arg transcript "$TRANSCRIPT" \
  --arg last_line "$last_line" \
  --arg today "$TODAY" \
  --arg current_count "$CURRENT_COUNT" \
  --arg total_lines "$TOTAL_LINES" \
  --arg counter_file "$COUNTER_FILE" \
  --arg vars_file "$VARS_FILE" \
  --arg capture_file "$CAPTURE_FILE" \
  --arg capture_ts "$CAPTURE_TS" \
  '{transcript:$transcript,last_line:$last_line,today:$today,current_count:$current_count,total_lines:$total_lines,counter_file:$counter_file,vars_file:$vars_file,capture_file:$capture_file,capture_timestamp:$capture_ts,attempts:1}' \
  > "$VARS_FILE"

# The counter is deliberately NOT advanced here. It used to be, which made a
# failed capture indistinguishable from a successful one: the window it covered
# was skipped forever, because the next delta was measured from an arm that
# never produced a file. publish-memory-capture.sh advances it as the last act
# of a verified publication, which is where Pi advances it too
# (finalizeMemorySuccess, gated on memorySuccessQualifies).

emit_context "${MEMORY_SCAN}${MEMORY_SCAN:+ }$(capture_directive "$VARS_FILE" 1)"
