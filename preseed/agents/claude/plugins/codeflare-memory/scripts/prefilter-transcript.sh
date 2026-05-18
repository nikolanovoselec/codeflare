#!/usr/bin/env bash
# Prefilter a Claude Code transcript slice and chunk it for memory capture.
#
# Why this exists: a raw transcript JSONL is dominated by tool_use blocks
# and tool_result wrappers - typically ~99% of the bytes are mechanical
# tool I/O. A capture agent given the raw stream blows its working memory
# on the noise and produces recency-biased summaries. We pre-strip
# everything except real user prompts and assistant text blocks, then
# chunk the result into small files the capture agent can process one
# at a time.
#
# Args:
#   $1 TRANSCRIPT  - path to the raw .jsonl transcript
#   $2 START_LINE  - first raw-transcript line to include (1-indexed, inclusive)
#   $3 END_LINE    - last raw-transcript line to include (1-indexed, inclusive)
#   $4 OUT_DIR     - directory for outputs (created if missing)
#   $5 CHUNK_SIZE  - entries per chunk (default 20)
#
# Outputs in OUT_DIR:
#   slice.jsonl          - raw transcript slice (for debugging only)
#   clean.ndjson         - filtered NDJSON: {role, text, ts} per line
#   chunk-aa, chunk-ab.. - clean.ndjson split CHUNK_SIZE entries per chunk
#   chunk-aa.md, ...     - human-readable Markdown rendering of each chunk
#   summary.txt          - line/byte stats printed by this script
#
# The filter keeps:
#   - real user prompts (string content not starting with `<`, `Stop hook`,
#     `This session is being continued`, or `[Request interrupted`)
#   - assistant text content blocks
#
# The filter drops:
#   - tool_use blocks (in assistant array content)
#   - tool_result wrappers (user records with array content)
#   - thinking blocks (encrypted/empty in this transcript format)
#   - slash-command wrappers, task-notifications, hook-feedback injections,
#     resume markers, isMeta records, and every non-user/non-assistant
#     record type (agent-name, ai-title, attachment, file-history-snapshot,
#     last-prompt, permission-mode, pr-link, queue-operation, system).

set -euo pipefail

TRANSCRIPT="${1:?transcript path required}"
START="${2:?start line required}"
END="${3:?end line required}"
OUT="${4:?out dir required}"
CHUNK_SIZE="${5:-20}"

# Fail-loud integer validation of START/END/CHUNK_SIZE. Empty captures
# (START=END=0) or non-numeric args previously silently slid through
# sed's ",p" handling and emitted a zero-byte slice, which the capture
# agent then "summarised" with hallucinated content from training data
# (code-reviewer 2nd report H3).
for var in START END CHUNK_SIZE; do
  val="${!var}"
  if ! [[ "$val" =~ ^[0-9]+$ ]]; then
    echo "$var must be a non-negative integer, got: $val" >&2
    exit 1
  fi
done
if [ "$START" -lt 1 ] || [ "$END" -lt "$START" ]; then
  echo "invalid line range: START=$START END=$END (need START>=1 and END>=START)" >&2
  exit 1
fi
if [ "$CHUNK_SIZE" -lt 1 ]; then
  echo "CHUNK_SIZE must be >= 1, got: $CHUNK_SIZE" >&2
  exit 1
fi

[ -f "$TRANSCRIPT" ] || { echo "transcript not found: $TRANSCRIPT" >&2; exit 1; }
mkdir -p "$OUT"

# 1. Slice the raw transcript to the requested line range.
sed -n "${START},${END}p" "$TRANSCRIPT" > "$OUT/slice.jsonl"

# 2. Prefilter to NDJSON of {role, text, ts}. Single-quoted to keep
#    jq variables ($c, $t) out of shell expansion.
jq -c '
def is_synthetic_marker(s):
  (s | startswith("<"))
  or (s | startswith("Stop hook"))
  or (s | startswith("This session is being continued"))
  or (s | startswith("[Request interrupted"));

select(.isMeta // false | not) |
select(.type == "user" or .type == "assistant") |
if .type == "user" and (.message.content | type) == "string" then
  .message.content as $c |
  if ($c | length) > 0 and (is_synthetic_marker($c) | not) then
    {role:"user", text:$c, ts:(.timestamp // null)}
  else empty end
elif .type == "assistant" and (.message.content | type) == "array" then
  ([.message.content[] | select(.type == "text") | .text]
   | map(select(length > 0)) | join("\n\n")) as $t |
  if ($t | length) > 0 then
    {role:"assistant", text:$t, ts:(.timestamp // null)}
  else empty end
else empty end
' < "$OUT/slice.jsonl" > "$OUT/clean.ndjson"

# 3. Chunk and render. split -a 2 gives chunk-aa, chunk-ab, ... chunk-zz
#    (676 chunks max - more than any sane 15-prompt window will produce).
( cd "$OUT" && rm -f chunk-* && split -l "$CHUNK_SIZE" -a 2 clean.ndjson chunk- )

# 4. Render each chunk to Markdown for the capture agent. ### headings
#    let the agent scan by role without re-parsing JSON.
for chunk in "$OUT"/chunk-??; do
  [ -f "$chunk" ] || continue
  jq -r '"### \(.role)\n\n\(.text)\n"' < "$chunk" > "${chunk}.md"
done

# 5. Stats. The capture agent reads this for sanity logging.
{
  echo "transcript    : $TRANSCRIPT"
  echo "raw range     : $START..$END"
  echo "slice lines   : $(wc -l < "$OUT/slice.jsonl")"
  echo "slice bytes   : $(wc -c < "$OUT/slice.jsonl")"
  echo "clean entries : $(wc -l < "$OUT/clean.ndjson")"
  echo "clean bytes   : $(wc -c < "$OUT/clean.ndjson")"
  echo "chunks        : $(ls "$OUT"/chunk-?? 2>/dev/null | wc -l)"
} > "$OUT/summary.txt"
cat "$OUT/summary.txt"
