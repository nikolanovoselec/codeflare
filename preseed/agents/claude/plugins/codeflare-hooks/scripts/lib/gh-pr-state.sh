# Shared helper sourced by enforce-review-spawn.sh and
# git-push-review-reminder.sh. Single source of truth for the gh CLI
# invocation used to query a branch's PR state and HEAD SHA.
#
# Why a shared helper: keeps the CLI shape consistent across both
# hooks (test fixtures pin the same exact-match args), and makes
# future field additions a one-place change.
#
# This file is sourced, not executed — it defines a function and
# exits without side effects when imported.

# gh_pr_state <branch>
#   Stdout: JSON like {"number":42,"state":"OPEN","headRefOid":"abc...","baseRefName":"main"}
#           on success; empty when no PR exists for the branch.
#   Exit:   0 if a PR was found and JSON was emitted.
#           1 if no PR found (gh's standard "not found" exit).
#           2/4 on transient errors (network, auth) — caller should
#           treat these as "unknown, don't cache".
#
# baseRefName is the bare branch name the PR targets (e.g. "main",
# "develop"). Callers gate review-pipeline triggers on this so PRs
# into a non-main integration branch defer review until the
# integration branch's own PR-to-main opens.
#
# Caller is responsible for parsing the JSON (use jq) and for any
# caching strategy. Different hooks have different cache semantics
# (per-PR-HEAD checkpoint vs short-TTL trigger cache), so caching
# stays in the hooks.
gh_pr_state() {
  local branch="$1"
  gh pr view "$branch" --json number,state,headRefOid,baseRefName 2>/dev/null
}

# resolve_review_head <ghHead> -- the SHA the review RANGE should end at.
#
# GitHub's PR metadata lags its own ref update: a `gh pr view` issued
# milliseconds after a successful push can still report the PREVIOUS head, so a
# range built on it ends one commit before the push that triggered it.
#
# Prefer local HEAD only when it provably CONTAINS what gh reported
# (--is-ancestor is true for equal SHAs). Every other relationship keeps gh's
# value: a push of a non-current refspec, a rejected push, or a concurrent push
# from elsewhere must not be reviewed against a narrower range than the PR has.
#
# Both the PostToolUse nudge and the Stop gate classify through this, so the two
# consumers of lane-classifier.sh cannot feed it different right-hand SHAs and
# disagree about which lanes a range needs. Callers that ACK a head must still
# ack the gh head, never this one -- acking a local commit the PR does not yet
# carry would skip its review once it is pushed.
resolve_review_head() {
  local gh_head="$1" local_head
  local_head=$(git rev-parse HEAD 2>/dev/null)
  if [ -n "$local_head" ] \
     && { [ -z "$gh_head" ] \
          || git merge-base --is-ancestor "$gh_head" "$local_head" 2>/dev/null; }; then
    printf '%s\n' "$local_head"
    return
  fi
  printf '%s\n' "$gh_head"
}
