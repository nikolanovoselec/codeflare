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
#   Stdout: JSON like {"state":"OPEN","headRefOid":"abc...","baseRefName":"main"}
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
  gh pr view "$branch" --json state,headRefOid,baseRefName 2>/dev/null
}
