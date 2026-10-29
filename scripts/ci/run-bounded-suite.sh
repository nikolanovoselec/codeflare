#!/usr/bin/env bash
# Bound the complete suite and its log pipeline, not just npm's parent process.
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo 'Usage: run-bounded-suite.sh <duration> <log> <console-output> <command> [args...]' >&2
  exit 2
fi

duration=$1
log=$2
console_output=$3
shift 3

# Zero disables GNU timeout; longer budgets violate this CI boundary.
if [[ ! "$duration" =~ ^[1-9][0-9]{0,2}s$ ]] || (( ${duration%s} > 150 )); then
  echo 'Suite duration must be an integer from 1s through 150s' >&2
  exit 2
fi

# GNU timeout owns a separate process group. KILL avoids npm exiting on TERM
# while a resistant descendant keeps tee's pipe open beyond the deadline.
# The caller must treat 137 as failure even if a report was already written.
exec timeout --signal=KILL "$duration" bash --noprofile --norc -o pipefail -c '
  log=$1
  console_output=$2
  shift 2
  "$@" 2>&1 | tee "$log" > "$console_output"
  statuses=("${PIPESTATUS[@]}")
  if [ "${statuses[1]}" -ne 0 ]; then exit "${statuses[1]}"; fi
  exit "${statuses[0]}"
' bounded-suite "$log" "$console_output" "$@"
