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
#           1 ONLY for gh's authoritative "no pull requests found" answer.
#           3 for a generic gh exit 1 that is not the not-found answer:
#             gh uses 1 for API and network errors too, and the two are
#             distinguishable only by stderr text, so this function does
#             the reading and callers keep a numeric contract. When stderr
#             capture is unavailable (mktemp failed), not-found is
#             indistinguishable from a flake and is likewise reported as 3.
#           2/4 native transient errors (network, auth) — treat like 3:
#             "unknown, don't cache".
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
  local branch="$1" out rc err
  err=$(mktemp "${TMPDIR:-/tmp}/gh-pr-state-err.XXXXXX" 2>/dev/null) || {
    # No stderr capture means the not-found phrase is unreadable, so exit 1
    # cannot be verified as authoritative; report the transient class instead.
    # The safe directions differ: a false "no PR" strands a live round, while
    # a false "transient" at worst bridges a warm cache that the head-equality
    # and plan-file gates already bound.
    gh pr view "$branch" --json number,state,headRefOid,baseRefName 2>/dev/null
    rc=$?
    [ "$rc" -ne 1 ] || rc=3
    return "$rc"
  }
  out=$(gh pr view "$branch" --json number,state,headRefOid,baseRefName 2>"$err")
  rc=$?
  # gh answers "no PR" and "the API hiccuped" with the same exit 1; only the
  # stderr text tells them apart, and callers must never conflate them — a
  # not-found bridged from cache resurrects a deleted PR, while a flake read
  # as not-found strands a live round. Do the reading here so callers keep a
  # purely numeric contract. The match tolerates gh's known phrasings; the
  # fixture in enforce-review-spawn.test.js speaks the current one.
  if [ "$rc" -eq 1 ] && ! grep -qiE 'no( open)? pull requests? found' "$err" 2>/dev/null; then
    rc=3
  fi
  # Cleanup is normal-path only, on purpose. A RETURN trap fires no earlier
  # than this line does (there are no early returns above), and covering
  # signals or timeouts would take EXIT/INT/TERM traps, which are process
  # global — a sourced library must not own its caller's signal handlers. A
  # killed hook can strand one tiny capture file in the container-lifetime
  # TMPDIR; accepted.
  rm -f "$err" 2>/dev/null
  [ -n "$out" ] && printf '%s\n' "$out"
  return "$rc"
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
