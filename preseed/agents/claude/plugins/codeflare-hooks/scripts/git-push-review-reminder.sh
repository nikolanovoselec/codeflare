#!/usr/bin/env bash
# PostToolUse hook — silently triggers review agents at the PR boundary.
# ONLY on projects that have opted into SDD by running /sdd init.
#
# Trigger model (PR-boundary, not per-push):
#
#   - `gh pr create ...` runs → PR-OPEN trigger → fire review pipeline
#   - `git push` runs AND current branch already has an open PR → PR-SYNC
#     trigger → fire review pipeline
#   - `git push` runs AND current branch has no open PR → DEFERRED →
#     skip silently (review will fire when the PR opens later)
#
# This switches the cost model from per-push (every commit + push pair
# burned a full review) to per-PR (one review at PR-open + one per push
# while the PR is open). Across a typical session: ~1264 review spawns
# became ~50–100 — the same coverage with ~10× fewer tokens.
#
# `gh pr view` calls are cached at .git/sdd-pr-cache with 60s TTL so
# rapid-fire pushes don't hammer the GitHub API.
#
# PostToolUse (not PreToolUse) so the directive arrives in the SAME
# turn as the push/create result. The assistant acts on it immediately
# without needing to announce it to the user.
#
# Vibe-coding mode: if sdd/ does not exist, emits nothing. Zero friction.
#
# Fail-safe: any unexpected error → exit 0 (never lock users out).
set +e

INPUT=$(cat 2>/dev/null) || exit 0

# ---------------------------------------------------------------------------
# Cheap pre-filter — skip if raw input doesn't even mention the trigger
# substrings. PostToolUse fires on every Bash call, so avoiding the
# jq cold-start (~30-80ms on a 1-vCPU container) here saves seconds of
# cumulative blocking time over a long session.
# ---------------------------------------------------------------------------
case "$INPUT" in
  *"git push"*|*"gh pr create"*) ;; # candidate — fall through
  *) exit 0 ;;
esac

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true

# Classify the command. Direct gh pr create is unambiguous (PR-OPEN).
# git push is conditional on open-PR detection (PR-SYNC vs DEFERRED).
TRIGGER=""
case "$COMMAND" in
  *"gh pr create"*) TRIGGER="pr-open" ;;
  *"git push"*)     TRIGGER="git-push" ;;
  *)                exit 0 ;;
esac

# ---------------------------------------------------------------------------
# Vibe-coding gate
# ---------------------------------------------------------------------------
if [ ! -d "sdd" ] || [ ! -f "sdd/README.md" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# PR-SYNC path — git push only fires review if the current branch has an
# open PR. Cached at .git/sdd-pr-cache (60s TTL) to avoid hammering gh.
# ---------------------------------------------------------------------------
if [ "$TRIGGER" = "git-push" ]; then
  CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
  [ -n "$CURRENT" ] || exit 0
  [ "$CURRENT" = "HEAD" ] && exit 0  # detached HEAD — skip

  GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
  PR_CACHE="$GIT_COMMON_DIR/sdd-pr-cache"

  PR_STATE=""
  CACHE_VALID=0
  if [ -f "$PR_CACHE" ]; then
    cache_age=$(( $(date +%s) - $(stat -c %Y "$PR_CACHE" 2>/dev/null || stat -f %m "$PR_CACHE" 2>/dev/null || echo 0) ))
    if [ "$cache_age" -lt 60 ] 2>/dev/null; then
      cached_branch=$(head -1 "$PR_CACHE" 2>/dev/null)
      if [ "$cached_branch" = "$CURRENT" ]; then
        PR_STATE=$(sed -n '2p' "$PR_CACHE" 2>/dev/null)
        CACHE_VALID=1
      fi
    fi
  fi

  if [ "$CACHE_VALID" = "0" ]; then
    GH_OK=0
    if command -v gh >/dev/null 2>&1; then
      # Capture both exit status and output. gh exits non-zero when no
      # PR exists for the branch — we treat that as a successful
      # "definitely no PR" answer (cache it). Only failures from
      # auth/network/rate-limit (no usable response) are treated as
      # transient and skipped from the cache.
      PR_STATE=$(gh pr view "$CURRENT" --json state -q .state 2>/dev/null)
      gh_exit=$?
      # Either non-empty state, OR exit 1 with empty output ("no PR
      # for branch" signal) → result is trustworthy; cache it.
      if [ -n "$PR_STATE" ] || [ "$gh_exit" -eq 1 ]; then
        GH_OK=1
      fi
    fi
    if [ "$GH_OK" = "1" ]; then
      printf '%s\n%s\n' "$CURRENT" "$PR_STATE" > "$PR_CACHE" 2>/dev/null || true
    fi
    # Transient failure (gh missing, auth lapse, network blip): leave
    # the previous cache entry intact OR fall through to deferred —
    # erring toward fewer spurious review spawns is OK because the
    # Stop hook (enforce-review-spawn.sh) re-checks gh pr view at
    # turn end and blocks if the user actually pushed to a PR-tracked
    # branch.
  fi

  # Deferred: no open PR on this branch → review will fire when PR opens
  case "$PR_STATE" in
    OPEN) ;;       # PR-SYNC trigger — fall through
    *) exit 0 ;;   # deferred
  esac
fi

# ---------------------------------------------------------------------------
# Emit silent directive — assistant must act WITHOUT user-facing output.
# ---------------------------------------------------------------------------
case "$TRIGGER" in
  pr-open)  CONTEXT="PR open" ;;
  git-push) CONTEXT="push to PR-tracked branch (PR-sync)" ;;
esac

DIRECTIVE="[silent] SDD $CONTEXT detected. Execute NOW without user-facing output:"
DIRECTIVE="$DIRECTIVE 1) code-reviewer in background (parallel, source lane)."
DIRECTIVE="$DIRECTIVE 2) spec-reviewer in background FIRST (sdd/ lane)."
DIRECTIVE="$DIRECTIVE 3) doc-updater in background SECOND, after spec-reviewer (docs/ lane)."
DIRECTIVE="$DIRECTIVE Each agent fetches the full PR diff itself via 'git diff \$(gh pr view --json baseRefName -q .baseRefName)...HEAD' (or 'git diff origin/main...HEAD' as fallback) — do NOT paste diffs into the prompt; just give a one-line task framing."
DIRECTIVE="$DIRECTIVE Do NOT mention these agents to the user. Do NOT print status updates about them."

jq -n --arg ctx "$DIRECTIVE" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
exit 0
