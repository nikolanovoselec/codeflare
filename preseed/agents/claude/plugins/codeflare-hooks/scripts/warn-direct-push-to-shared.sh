#!/usr/bin/env bash
# PostToolUse hook — emits a non-blocking warning when the user pushes
# directly to a shared/protected branch (default: main, master).
#
# Why this exists: the SDD review pipeline (code-reviewer, spec-reviewer,
# doc-updater) is gated on PR-boundary triggers — a `gh pr create` runs
# in the session, OR the current branch already has an open PR. Direct
# pushes to a protected branch never cross a PR boundary, so the review
# agents never auto-fire. This hook nudges the user to either:
#   1. Push to a feature branch and open a PR (recommended), OR
#   2. Manually spawn the review agents after the push if they really
#      meant to land directly on main.
#
# Direct pushes to develop are NOT warned about. The expected workflow
# is feature → PR → develop → PR → main. Pushes to develop get caught
# by the develop→main PR later, so they don't escape review entirely.
# Only direct pushes to a true protected branch (main/master) bypass.
#
# Non-blocking: emits additionalContext only. No decision:block. The
# user's push has already succeeded; we're just informing.
#
# Fail-safe: any unexpected error → exit 0.

set +e

INPUT=$(cat 2>/dev/null) || exit 0

# ---------------------------------------------------------------------------
# Cheap pre-filter — skip if raw input doesn't mention git push at all
# ---------------------------------------------------------------------------
case "$INPUT" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
case "$COMMAND" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

# ---------------------------------------------------------------------------
# Vibe-coding gate
# ---------------------------------------------------------------------------
if [ ! -d "sdd" ] || [ ! -f "sdd/README.md" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Read protected_branches and warn_on_direct_push from sdd/config.yml
# ---------------------------------------------------------------------------
CONFIG="sdd/config.yml"
PROTECTED_BRANCHES="main master"
WARN_ENABLED="true"

if [ -f "$CONFIG" ]; then
  # Cheap awk parse — pull the sdd_review block. No yq dependency.
  IN_BLOCK=0
  while IFS= read -r line; do
    case "$line" in
      "sdd_review:"*) IN_BLOCK=1; continue ;;
      [a-zA-Z]*:*) IN_BLOCK=0 ;;
    esac
    [ "$IN_BLOCK" = "1" ] || continue

    case "$line" in
      *"warn_on_direct_push:"*)
        val=$(echo "$line" | sed -E 's/.*warn_on_direct_push:[[:space:]]*//; s/[[:space:]#].*$//')
        [ -n "$val" ] && WARN_ENABLED="$val"
        ;;
      *"protected_branches:"*"["*)
        # inline list form: protected_branches: [main, master]
        list=$(echo "$line" | sed -E 's/.*\[//; s/\].*//; s/[",]/ /g')
        [ -n "$list" ] && PROTECTED_BRANCHES="$list"
        ;;
    esac
  done < "$CONFIG"
fi

[ "$WARN_ENABLED" = "true" ] || exit 0

# ---------------------------------------------------------------------------
# Resolve current branch — must be in protected_branches list
# ---------------------------------------------------------------------------
CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
[ -n "$CURRENT" ] || exit 0
[ "$CURRENT" = "HEAD" ] && exit 0  # detached HEAD — skip

IS_PROTECTED=0
for branch in $PROTECTED_BRANCHES; do
  if [ "$CURRENT" = "$branch" ]; then
    IS_PROTECTED=1
    break
  fi
done

[ "$IS_PROTECTED" = "1" ] || exit 0

# ---------------------------------------------------------------------------
# Confirm there's no open PR for current branch (very unlikely on a
# protected branch but keep the check for completeness)
# ---------------------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  PR_STATE=$(gh pr view "$CURRENT" --json state -q .state 2>/dev/null) || PR_STATE=""
  case "$PR_STATE" in
    OPEN) exit 0 ;;  # branch has an open PR — review pipeline will fire
  esac
fi

# ---------------------------------------------------------------------------
# Emit non-blocking informational directive
# ---------------------------------------------------------------------------
DIRECTIVE="[silent] Direct push to protected branch '$CURRENT' detected."
DIRECTIVE="$DIRECTIVE The SDD review pipeline (code-reviewer, spec-reviewer, doc-updater)"
DIRECTIVE="$DIRECTIVE is gated on PR-boundary triggers — direct pushes to '$CURRENT' bypass it."
DIRECTIVE="$DIRECTIVE Recommended workflow: feature branch → PR → develop → PR → main."
DIRECTIVE="$DIRECTIVE If the push was deliberate, you can manually spawn the three review agents now."
DIRECTIVE="$DIRECTIVE To silence this warning, set sdd_review.warn_on_direct_push to false in sdd/config.yml."

jq -n --arg ctx "$DIRECTIVE" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}' 2>/dev/null
exit 0
