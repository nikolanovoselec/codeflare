#!/usr/bin/env bash
# assert-iso-ts.sh - derive ISO_TS from environment, assert validity, print to stdout.
#
# Called by the memory-capture agent (Step 1.5 in memory-agent-prompt.md) to
# get a fabrication-resistant capture timestamp. Fails closed: any assertion
# failure exits 1 with ISO_TS_ASSERTION_FAILED on stderr, halting the capture
# rather than writing a wrong timestamp to the vault.
#
# Resolves $USER_TIMEZONE -> $TZ -> /etc/timezone -> UTC. Runs three assertions:
#   1. ISO_TS ends with a four-digit [+-]NNNN offset.
#   2. The offset matches what TZ="$RESOLVED" date '+%z' produces (catches
#      dropped-TZ-wrapper bugs like issue #416 on non-UTC hosts).
#   3. The reconstructed epoch is within 30s of the wall clock (catches
#      LLM fabrication, which typically drifts hours).
#
# On success: prints "ISO_TS=<value>" and "RESOLVED_TZ=<zone>" to stdout, exits 0.
#
# Test-only env: ASSERT_ISO_TS_OVERRIDE substitutes a synthetic ISO_TS before
# the assertions run, so the test suite can exercise each rejection path
# without race-prone time manipulation. Production callers never set it.

set -u

RESOLVED=""
if [ -n "${USER_TIMEZONE:-}" ]; then
  RESOLVED="$USER_TIMEZONE"
elif [ -n "${TZ:-}" ]; then
  RESOLVED="$TZ"
elif [ -r /etc/timezone ]; then
  RESOLVED="$(cat /etc/timezone)"
else
  RESOLVED="UTC"
fi

ISO_TS="$(TZ="$RESOLVED" date '+%Y-%m-%dT%H-%M-%S%z')"
EXPECTED_OFFSET="$(TZ="$RESOLVED" date '+%z')"

if [ -n "${ASSERT_ISO_TS_OVERRIDE:-}" ]; then
  ISO_TS="$ASSERT_ISO_TS_OVERRIDE"
fi

case "$ISO_TS" in
  *[+-][0-9][0-9][0-9][0-9]) ;;
  *)
    echo "ISO_TS_ASSERTION_FAILED: missing TZ offset in $ISO_TS" >&2
    exit 1
    ;;
esac

ACTUAL_OFFSET="${ISO_TS: -5}"
if [ "$ACTUAL_OFFSET" != "$EXPECTED_OFFSET" ]; then
  echo "ISO_TS_ASSERTION_FAILED: offset $ACTUAL_OFFSET does not match TZ=$RESOLVED expected $EXPECTED_OFFSET" >&2
  exit 1
fi

DATE_PART="${ISO_TS%T*}"
REST="${ISO_TS#*T}"
TIME_PART="${REST%[+-]*}"
TZ_PART="${REST#$TIME_PART}"
TIME_COLONS="${TIME_PART//-/:}"
ISO_TS_PARSEABLE="${DATE_PART}T${TIME_COLONS}${TZ_PART}"
EPOCH_NOW=$(date +%s)
ISO_TS_EPOCH=$(date -d "$ISO_TS_PARSEABLE" +%s 2>/dev/null || echo 0)
DRIFT=$(( EPOCH_NOW - ISO_TS_EPOCH ))
ABS_DRIFT=${DRIFT#-}
if [ "$ISO_TS_EPOCH" -eq 0 ] || [ "$ABS_DRIFT" -gt 30 ]; then
  echo "ISO_TS_ASSERTION_FAILED: $ISO_TS drifts ${DRIFT}s from current clock; agent likely fabricated" >&2
  exit 1
fi

echo "ISO_TS=$ISO_TS"
echo "RESOLVED_TZ=$RESOLVED"
