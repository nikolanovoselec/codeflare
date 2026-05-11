#!/usr/bin/env bash
# Implements REQ-AGENT-004
# Implements REQ-AGENT-021
# PostToolUse hook — silently triggers review agents at the PR boundary.
# ONLY on projects that have opted into SDD by running /sdd init.
#
# Trigger model (PR-boundary, gated on PR target = main/master):
#
#   - `gh pr create ...` runs → PR-OPEN candidate → query gh for the
#     just-created PR's base; fire review only if base is main/master
#   - `git push` runs AND current branch has an open PR with base in
#     (main, master) → PR-SYNC trigger → fire review pipeline
#   - `git push` runs AND open PR base is NOT main/master (e.g.
#     feature → develop) → DEFERRED → skip silently. Review fires
#     when the integration branch's own PR-to-main is open and pushed.
#   - `git push` runs AND current branch has no open PR → DEFERRED →
#     skip silently
#
# DRAFT PRs are treated as OPEN (gh returns state=OPEN for drafts). This
# is intentional: drafts often want early feedback, and silent skip
# would surprise users whose draft is the de-facto review target. Users
# who want a review-free WIP branch should defer the PR open until they
# are ready, OR use the sentinel/magic-phrase USER bypasses on a per-push
# basis.
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

# Extract the command(s) from any of three supported tool-input shapes:
#
#   1. Bash tool             → .tool_input.command           (string)
#   2. mcp__*__ctx_execute   → .tool_input.code              (string, only when
#                              .tool_input.language == "shell")
#   3. mcp__*__ctx_batch_execute → .tool_input.commands[].command (array of
#                              objects; concatenated with `; ` so the existing
#                              shell-separator regex matches each command)
#
# Issue #317: when context-mode's enforce-ctx-mode.sh denies `gh pr create` /
# `gh pr merge` in Bash, agents retry through MCP shell tools. Without this
# multi-shape parsing, the regex below was applied to a JSON shape that has
# no `.tool_input.command` field, COMMAND was empty, and the review-pipeline
# directive silently never fired for the redirected invocation.
COMMAND=$(echo "$INPUT" | jq -r '
  if (.tool_input.command // "") != "" then
    .tool_input.command
  elif (.tool_input.language // "") == "shell" and (.tool_input.code // "") != "" then
    .tool_input.code
  elif (.tool_input.commands | type? == "array") then
    [.tool_input.commands[]?.command // empty] | join("; ")
  else
    empty
  end
' 2>/dev/null) || true

# Classify the command. Direct gh pr create is unambiguous (PR-OPEN).
# git push is conditional on open-PR detection (PR-SYNC vs DEFERRED).
#
# Anchored regex (not substring): `git push` and `gh pr create` must
# appear as actual command tokens, not as substrings inside echo
# strings or quoted commit message bodies. Allowed positions:
#   1. Start of the command:           git push origin develop
#   2. After a shell separator:        git add . && git push
#   3. After && / || / | / ; / &      git status; git push
# Anything else (e.g. `git commit -m "...git push..."`) does not match.
# This mirrors the awk fix in enforce-review-spawn.sh PUSH_LINE.
TRIGGER=""
if [[ "$COMMAND" =~ (^|[[:space:]]*[\;\&\|]+[[:space:]]*)gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$) ]]; then
  TRIGGER="pr-open"
elif [[ "$COMMAND" =~ (^|[[:space:]]*[\;\&\|]+[[:space:]]*)git[[:space:]]+push([[:space:]]|$) ]]; then
  TRIGGER="git-push"
else
  exit 0
fi

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
  PR_BASE=""
  CACHE_VALID=0
  if [ -f "$PR_CACHE" ]; then
    cache_age=$(( $(date +%s) - $(stat -c %Y "$PR_CACHE" 2>/dev/null || stat -f %m "$PR_CACHE" 2>/dev/null || echo 0) ))
    cached_branch=$(head -1 "$PR_CACHE" 2>/dev/null)
    if [ "$cached_branch" = "$CURRENT" ]; then
      cached_state=$(sed -n '2p' "$PR_CACHE" 2>/dev/null)
      cached_base=$(sed -n '3p' "$PR_CACHE" 2>/dev/null)
      # Asymmetric TTL: positive (OPEN) results cached for 60s; legitimate
      # empty results (gh exit 1 = "no PR found") cached for only 10s. The
      # short negative TTL bounds the staleness of the "no PR" case so a
      # PR opened during a quiet period is picked up quickly. Transient
      # failures (gh exit 2 = network/auth, exit 4 = no token) are NOT
      # cached at all — see the GH_OK gate below — so they never poison
      # the cache; they re-query on the next push.
      #
      # Cache schema is 3 lines: branch, state, baseRefName. Older
      # 2-line caches (pre-base-gating) lack line 3. Legacy detection
      # is by *line count*, NOT by empty-base heuristic, so an
      # OPEN PR with a transiently-empty base (gh returned state but
      # jq couldn't extract baseRefName) caches as `branch\nOPEN\n\n`
      # (3 lines, last empty) and is treated as a valid empty-base
      # cache hit instead of looping back to gh on every push.
      max_age=10
      [ "$cached_state" = "OPEN" ] && max_age=60
      cache_lines=$(wc -l < "$PR_CACHE" 2>/dev/null | tr -d ' ')
      if [ "$cache_age" -lt "$max_age" ] 2>/dev/null && [ "$cache_lines" -ge 3 ] 2>/dev/null; then
        PR_STATE="$cached_state"
        PR_BASE="$cached_base"
        CACHE_VALID=1
      fi
    fi
  fi

  if [ "$CACHE_VALID" = "0" ]; then
    GH_OK=0
    if command -v gh >/dev/null 2>&1; then
      # Distinguish three gh exit modes by the (PR_STATE, gh_exit) pair:
      #   1. PR exists  → PR_STATE non-empty, exit 0  → cache 60s (OPEN/MERGED)
      #   2. No PR      → PR_STATE empty,    exit 1  → cache 10s (negative)
      #   3. Transient  → PR_STATE empty,    exit 2/4 → DO NOT cache; re-query
      # The Stop hook (enforce-review-spawn.sh) re-checks gh pr view at
      # turn end and blocks if a real PR push goes un-reviewed, so a
      # transient gh failure here only delays a silent-spawn directive
      # by one push — it does not bypass enforcement.
      # Shared CLI invocation; see lib/gh-pr-state.sh for the contract
      . "$(dirname "$0")/lib/gh-pr-state.sh" 2>/dev/null || true
      PR_INFO=$(gh_pr_state "$CURRENT")
      gh_exit=$?
      PR_STATE=$(echo "$PR_INFO" | jq -r '.state // empty' 2>/dev/null)
      PR_BASE=$(echo "$PR_INFO" | jq -r '.baseRefName // empty' 2>/dev/null)
      if [ -n "$PR_STATE" ] || [ "$gh_exit" -eq 1 ]; then
        GH_OK=1
      fi
    fi
    if [ "$GH_OK" = "1" ]; then
      # Atomic write: two concurrent hook invocations (rare but possible
      # in chained-pipeline turns like `git status; git push; git push
      # --tags`) would otherwise race on the file and a reader between
      # truncate and write would see a partial 1-line file. mktemp + mv
      # guarantees readers see either the old contents or the full new
      # contents, never a torn write.
      TMP_CACHE=$(mktemp "$PR_CACHE.XXXXXX" 2>/dev/null)
      if [ -n "$TMP_CACHE" ]; then
        if printf '%s\n%s\n%s\n' "$CURRENT" "$PR_STATE" "$PR_BASE" > "$TMP_CACHE" 2>/dev/null; then
          mv "$TMP_CACHE" "$PR_CACHE" 2>/dev/null || rm -f "$TMP_CACHE" 2>/dev/null
        else
          rm -f "$TMP_CACHE" 2>/dev/null
        fi
      fi
    fi
  fi

  # Deferred: no open PR on this branch → review will fire when PR opens.
  # Direct push to main/master without an open PR is the user's workflow
  # choice (branch protection should normally prevent this; if it's off,
  # that's deliberate). The hook does not prompt the user to spawn agents
  # — they invoke verification manually if they want it.
  case "$PR_STATE" in
    OPEN) ;;       # candidate — still needs base check
    *) exit 0 ;;   # deferred (any branch, including main with no PR)
  esac

  # Gate on PR target: only PRs landing on main/master fire review.
  # feature → develop defers; develop → main fires.
  # Empty PR_BASE (transient gh quirk where state was parsed but
  # baseRefName wasn't) fails open to enforcement — parity with
  # enforce-review-spawn.sh, where the same fail-open policy was
  # added in 7580b15. Better to over-review than silently let an
  # unreviewed PR-to-main slip through on a parsing edge case.
  case "$PR_BASE" in
    main|master|"") ;;
    *) exit 0 ;;
  esac
fi

# ---------------------------------------------------------------------------
# PR-OPEN base gate — `gh pr create` just landed; query gh to learn the
# new PR's base branch. If base is not main/master, defer (the PR's own
# next push will hit PR-SYNC and re-evaluate; if the user merges
# feature → develop without further pushes, review fires later when
# the develop → main PR opens or syncs).
#
# One-time 200-500ms cost per PR creation; not on the per-push hot path.
# Fail-safe: if gh missing or transient failure, default to firing
# (preserves prior behavior — better to over-review on PR open than
# miss it).
# ---------------------------------------------------------------------------
#
# This branch only fires for PRs opened via `gh pr create` from inside
# the Claude session. PRs opened by other means (gh in another
# terminal, GitHub web UI, GitHub API, etc.) will be picked up by
# the PR-SYNC path on the next `git push` to the branch — gh_pr_state
# returns the now-existing PR's state and base regardless of how it
# was opened. Stop hook (enforce-review-spawn.sh) is the universal
# safety net: it runs `gh pr view` at turn end and enforces on any
# un-acked PR HEAD with a main/master base.
if [ "$TRIGGER" = "pr-open" ]; then
  CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
  [ -n "$CURRENT" ] || exit 0
  [ "$CURRENT" = "HEAD" ] && exit 0

  if command -v gh >/dev/null 2>&1; then
    . "$(dirname "$0")/lib/gh-pr-state.sh" 2>/dev/null || true
    PR_INFO_OPEN=$(gh_pr_state "$CURRENT")
    PR_BASE_OPEN=$(echo "$PR_INFO_OPEN" | jq -r '.baseRefName // empty' 2>/dev/null)
    if [ -n "$PR_BASE_OPEN" ]; then
      case "$PR_BASE_OPEN" in
        main|master) ;;
        *) exit 0 ;;
      esac
    fi
    # If base couldn't be determined (transient gh failure), fall
    # through and emit. The Stop hook re-checks at turn end with the
    # authoritative gh call and will under-block if the base is
    # actually develop, so this is fail-open in the right direction.
  fi
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
DIRECTIVE="$DIRECTIVE Each agent fetches the full PR diff itself via 'git diff origin/\$(gh pr view --json baseRefName -q .baseRefName)...HEAD' (or 'git diff origin/main...HEAD' as fallback) — the origin/ prefix matters because baseRefName returns the bare branch name (e.g. 'develop') and CI/fresh-clone environments may not have it as a local branch. Do NOT paste diffs into the prompt; just give a one-line task framing."
DIRECTIVE="$DIRECTIVE Do NOT mention these agents to the user. Do NOT print status updates about them."

jq -n --arg ctx "$DIRECTIVE" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
exit 0
