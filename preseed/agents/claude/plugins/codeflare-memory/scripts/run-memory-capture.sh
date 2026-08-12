#!/usr/bin/env bash
# Run one memory capture as a headless `claude -p` subprocess.
#
# The capture used to run as an in-session `Agent`, which is why it was slow and
# expensive: a subagent inherits the parent conversation, so every capture
# re-sent a context that has nothing to do with the extraction. Pi never pays
# that. Its runtime assembles the payload first and the capture only summarises
# what it was handed. This script is that arrangement for Claude, on the
# transport the review lanes already use (AD115): prefilter the transcript slice
# into the work directory the capture prompt already reads from, bound the run,
# then let publish-memory-capture.sh decide whether anything was produced.
#
# The main session spends nothing. It does not spawn this, wait for it, or read
# its output; the arming hook launches it detached and the publisher commits the
# counter against the artifact.
#
# Usage: run-memory-capture.sh --vars <VARS_FILE>
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || {
  echo "run-memory-capture: cannot resolve script directory" >&2
  exit 3
}

VARS_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vars) VARS_FILE="${2:-}"; shift 2 ;;
    *) echo "run-memory-capture: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$VARS_FILE" ] || { echo "run-memory-capture: --vars is required" >&2; exit 2; }
[ -r "$VARS_FILE" ] || { echo "run-memory-capture: carrier unreadable: $VARS_FILE" >&2; exit 2; }

for tool in claude timeout jq flock python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "run-memory-capture: $tool is required; refusing to launch" >&2
    exit 3
  }
done

# One capture per carrier. The arming hook fires on every prompt, and without
# this a slow capture would be relaunched underneath itself, racing two writers
# onto the same capture file and the same counter. Non-blocking on purpose: a
# second launch should evaporate, not queue.
exec 9>"${VARS_FILE}.lock"
flock -n 9 || { echo "run-memory-capture: a capture is already running for $VARS_FILE" >&2; exit 0; }

TRANSCRIPT=$(jq -r '.transcript // empty' "$VARS_FILE")
LAST_LINE=$(jq -r '.last_line // 0' "$VARS_FILE")
TOTAL_LINES=$(jq -r '.total_lines // 0' "$VARS_FILE")
CAPTURE_FILE=$(jq -r '.capture_file // empty' "$VARS_FILE")

[ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ] || {
  echo "run-memory-capture: transcript unreadable: ${TRANSCRIPT:-<unset>}" >&2
  exit 3
}
[ -n "$CAPTURE_FILE" ] || { echo "run-memory-capture: carrier names no capture file" >&2; exit 3; }

case "$LAST_LINE" in ''|*[!0-9]*) LAST_LINE=0 ;; esac
case "$TOTAL_LINES" in ''|*[!0-9]*) TOTAL_LINES=0 ;; esac
START_LINE=$((LAST_LINE + 1))
[ "$TOTAL_LINES" -ge "$START_LINE" ] || {
  echo "run-memory-capture: nothing new to capture (lines $START_LINE..$TOTAL_LINES)" >&2
  exit 0
}

PROMPT_FILE="$SCRIPT_DIR/memory-agent-prompt.md"
[ -r "$PROMPT_FILE" ] || { echo "run-memory-capture: missing $PROMPT_FILE" >&2; exit 3; }

# The prompt mandates this helper for the graph chunk, so it belongs in the
# same cheap gate as the tools above. Discovering it missing inside the
# four-turn budget costs the whole capture; discovering it here costs nothing.
GRAPH_BUILDER="$SCRIPT_DIR/build-memory-graph.py"
[ -r "$GRAPH_BUILDER" ] || { echo "run-memory-capture: missing $GRAPH_BUILDER" >&2; exit 3; }

# The payload directory is the one the prompt already names, derived the same
# way (`/tmp/memory-capture-{first 8 of SESSION_ID}`), so the capture reads its
# chunks from where it has always read them. It outlives this script on purpose:
# a capture that failed leaves its payload behind for inspection, and the next
# launch overwrites it.
COUNTER_FILE=$(jq -r '.counter_file // empty' "$VARS_FILE")
SESSION_ID="${COUNTER_FILE##*/}"
[ -n "$SESSION_ID" ] || { echo "run-memory-capture: carrier names no counter file" >&2; exit 3; }
PAYLOAD_DIR="/tmp/memory-capture-${SESSION_ID:0:8}"
CAPTURE_STDERR="$(mktemp -t memory-capture-stderr.XXXXXX)"
trap 'rm -f "$CAPTURE_STDERR" "${CAPTURE_STDOUT:-}"' EXIT
rm -rf "$PAYLOAD_DIR"
# Only THIS session's directory is reclaimed above, and each session has its
# own. Every container that runs more than one session therefore accumulates
# payload directories nobody will ever open again -- now carrying request.json
# and its embedded transcript on top of the chunks. That is the same slow disk
# fill the fixture-cleanup helper was just written to stop, arriving by another
# door. A day is well past useful for post-mortem inspection.
find /tmp -maxdepth 1 -name 'memory-capture-*' -type d -mmin +1440 \
  -exec rm -rf {} + 2>/dev/null || true
mkdir -p "$PAYLOAD_DIR" || { echo "run-memory-capture: cannot create $PAYLOAD_DIR" >&2; exit 3; }

# The payload is built here, not by the model. Prefiltering is mechanical --
# strip tool_use and tool_result noise, chunk what is left -- and a turn spent
# shelling out to do it is a turn not spent extracting, out of a budget of four.
if ! bash "$SCRIPT_DIR/prefilter-transcript.sh" \
      "$TRANSCRIPT" "$START_LINE" "$TOTAL_LINES" "$PAYLOAD_DIR" 20 >"$PAYLOAD_DIR/prefilter.log" 2>&1; then
  echo "run-memory-capture: prefilter failed; see $PAYLOAD_DIR/prefilter.log" >&2
  cat "$PAYLOAD_DIR/prefilter.log" >&2
  exit 4
fi

CHUNK_COUNT=$(find "$PAYLOAD_DIR" -maxdepth 1 -name 'chunk-*.md' | wc -l)
[ "$CHUNK_COUNT" -gt 0 ] || { echo "run-memory-capture: prefilter produced no chunks" >&2; exit 4; }

# One self-contained request, the way Pi hands one over: the conversation text
# lives IN it, so there is no path to derive, no directory to walk and nothing
# to reread. Chunk files stay on disk for inspection but the capture never sees
# them -- rereading them was worth a model round-trip each.
REQUEST="$PAYLOAD_DIR/request.json"
JOINED="$PAYLOAD_DIR/joined.md"

# The prompt tells the capture its transcript is "bounded by the launcher".
# It was not -- every chunk was inlined regardless of size -- so the one
# property the model is told to rely on was the one nobody enforced. Bound it
# here, where the claim is made.
MAX_PAYLOAD_BYTES="${CODEFLARE_MEMORY_MAX_PAYLOAD_BYTES:-400000}"
case "$MAX_PAYLOAD_BYTES" in ''|*[!0-9]*|0) MAX_PAYLOAD_BYTES=400000 ;; esac

# Joined to a file first, then bounded from that file. Piping straight into
# `head -c` closes the pipe under `set -o pipefail`, so an ordinary truncation
# would surface as "could not build the request payload".
if ! find "$PAYLOAD_DIR" -maxdepth 1 -name 'chunk-*.md' | sort | xargs cat > "$JOINED"; then
  echo "run-memory-capture: could not assemble the transcript" >&2
  exit 4
fi
# Truncation has to be visible, in the log and in the payload. Dropping the
# tail silently hands the model a conversation that stops mid-sentence, which
# reads exactly like a session that really was that short -- so it summarises a
# partial window as if it were the whole one and nothing anywhere says otherwise.
#
# An unreadable byte count bounds the payload anyway. Normalising it to 0 read
# as "nothing to bound" and skipped the branch, so a wc hiccup shipped the whole
# unbounded transcript -- the exact direction this bound exists to prevent.
JOINED_BYTES=$(wc -c < "$JOINED" 2>/dev/null || echo unknown)
case "$JOINED_BYTES" in ''|*[!0-9]*) JOINED_BYTES=unknown ;; esac
if [ "$JOINED_BYTES" = unknown ] || [ "$JOINED_BYTES" -gt "$MAX_PAYLOAD_BYTES" ]; then
  echo "run-memory-capture: transcript size $JOINED_BYTES, bounding to $MAX_PAYLOAD_BYTES bytes" >&2
  {
    head -c "$MAX_PAYLOAD_BYTES" "$JOINED"
    printf '\n\n[transcript truncated by the launcher at %s bytes; full size %s]\n' \
      "$MAX_PAYLOAD_BYTES" "$JOINED_BYTES"
  } > "$JOINED.bounded"
  mv -f "$JOINED.bounded" "$JOINED"
fi

if ! jq -Rs --arg sid "$SESSION_ID" --arg ts "$(jq -r '.capture_timestamp // empty' "$VARS_FILE")" \
          --arg cf "$CAPTURE_FILE" --arg cc "$(jq -r '.current_count // 0' "$VARS_FILE")" \
     '{session_id:$sid, current_count:($cc|tonumber? // 0), capture_timestamp:$ts,
       capture_file:$cf, transcript:.}' \
     < "$JOINED" > "$REQUEST"; then
  echo "run-memory-capture: could not build the request payload" >&2
  exit 4
fi

# The payload directory outlives this script so a failed capture can be
# inspected. The joined copy has no such use once the request exists, and
# leaving it there puts a second full transcript under /tmp on every capture --
# the same slow fill this round is already cleaning up after.
rm -f "$JOINED"

# Frontmatter would reach the model as instructions if the prompt ever grew any.
SYSTEM_PROMPT=$(awk 'BEGIN{fm=0} NR==1 && $0=="---"{fm=1; next} fm==1 && $0=="---"{fm=2; next} fm!=1' "$PROMPT_FILE")

TASK=$(printf 'VARS_FILE=%s\n' "$REQUEST")

# Four turns, because the contract is two Bash calls: read the request, then
# write the note and build the chunk. That is Pi's budget for Pi's shape, and
# the shape is now the same. The wall-clock bound is separate: an auth prompt or
# a rate-limit backoff hangs a detached process nobody is watching.
CAPTURE_TIMEOUT="${MEMORY_CAPTURE_TIMEOUT:-900}"
case "$CAPTURE_TIMEOUT" in ''|*[!0-9]*|0) CAPTURE_TIMEOUT=900 ;; esac

# Same guard as the timeout above, for the same reason: an override that is not
# a number reaches `claude` as an argv it rejects, and every capture then fails
# for a reason no log explains.
CAPTURE_TURNS="${CODEFLARE_MEMORY_MAX_TURNS:-4}"
case "$CAPTURE_TURNS" in ''|*[!0-9]*|0) CAPTURE_TURNS=4 ;; esac

# Sonnet at medium effort, and stated here rather than left to whatever the
# runner defaults to. Capture is a fidelity job, not a reasoning one: the file
# embeds verbatim REQ IDs, ADR numbers and commit SHAs that later sessions cite,
# and the smallest models confabulated adjacent IDs in benchmarking (AD58). It
# is also the most frequent agent in the system, so the tier above is not worth
# paying on every fifteenth prompt. Both stay overridable.
set -- \
  -p \
  --output-format json \
  --setting-sources "" \
  --strict-mcp-config \
  --system-prompt "$SYSTEM_PROMPT" \
  --tools Read,Write,Bash \
  --max-turns "$CAPTURE_TURNS" \
  --model "${CODEFLARE_MEMORY_MODEL:-sonnet}" \
  --effort "${CODEFLARE_MEMORY_EFFORT:-medium}" \
  --permission-mode bypassPermissions

# Keep stdout. `--output-format json` reports the failure there, not on stderr,
# so discarding it turned every failure into a bare "exited 1": the turn-budget
# exhaustion above took three attempts to find because of it.
CAPTURE_STDOUT="$(mktemp -t memory-capture-stdout.XXXXXX)"
printf '%s' "$TASK" | timeout -k 30 "$CAPTURE_TIMEOUT" claude "$@" >"$CAPTURE_STDOUT" 2>"$CAPTURE_STDERR"
STATUS=$?

# The diagnostics below are honest but, on a detached launch, they report into
# a discarded stream — five attempts on one window once left nothing to read.
# The journal keeps the same story next to the carrier, a few lines per
# attempt, and outlives the carrier's removal so a burned window still has a
# post-mortem. Growth is bounded by the six-attempt latch per window and the
# container-lifetime /tmp, so it needs no rotation.
ATTEMPT_LOG="${VARS_FILE%.vars}.attempts.log"
ATTEMPT_NO=$(jq -r '.attempts // 0' "$VARS_FILE" 2>/dev/null)
case "$ATTEMPT_NO" in ''|*[!0-9]*) ATTEMPT_NO='?' ;; esac
{
  printf '%s attempt=%s exit=%s\n' "$(date +%FT%T%z)" "$ATTEMPT_NO" "$STATUS"
  if [ "$STATUS" -ne 0 ]; then
    [ -s "$CAPTURE_STDERR" ] && tail -5 "$CAPTURE_STDERR"
    # The envelope's subtype (error_max_turns, ...) diagnoses the failure; the
    # response text lives in .result and must never land in this file.
    if [ -s "$CAPTURE_STDOUT" ]; then
      STDOUT_LINE=$(jq -r '"stdout: \(.subtype // .error // .type)"' "$CAPTURE_STDOUT" 2>/dev/null) \
        && printf '%s\n' "$STDOUT_LINE" \
        || printf 'stdout: unparseable (%s bytes)\n' "$(wc -c < "$CAPTURE_STDOUT")"
    fi
  fi
} >> "$ATTEMPT_LOG" 2>/dev/null || true

# The exit status is a diagnostic, never the verdict. Whether a capture happened
# is answered by the file the hook named at arm time, and that is the publisher's
# question -- which is why it runs even after a non-zero exit: a run reaped at
# its bound may still have written the file on an earlier turn.
if [ $STATUS -ne 0 ]; then
  echo "run-memory-capture: capture exited $STATUS" >&2
  [ "$STATUS" -eq 124 ] || [ "$STATUS" -eq 137 ] \
    && echo "run-memory-capture: exceeded its ${CAPTURE_TIMEOUT}s bound and was reaped" >&2
  [ -s "$CAPTURE_STDERR" ] && { echo "run-memory-capture: last stderr:" >&2; tail -20 "$CAPTURE_STDERR" >&2; }
  [ -s "$CAPTURE_STDOUT" ] && { echo "run-memory-capture: response:" >&2; head -c 800 "$CAPTURE_STDOUT" >&2; echo >&2; }
fi

bash "$SCRIPT_DIR/publish-memory-capture.sh" "$VARS_FILE"
PUBLISH_STATUS=$?
# The publisher's verdict is the real outcome (the exit status above is only a
# diagnostic), so the journal records both; the runner still reports the
# publisher's status, which is what the tests pin.
printf '%s attempt=%s publish=%s\n' "$(date +%FT%T%z)" "$ATTEMPT_NO" "$PUBLISH_STATUS" >> "$ATTEMPT_LOG" 2>/dev/null || true
exit "$PUBLISH_STATUS"
