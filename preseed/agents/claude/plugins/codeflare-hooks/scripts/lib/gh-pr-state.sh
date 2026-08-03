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

# Parse one synchronous `gh pr merge` command without executing input.
# Prints the selector or __IMPLICIT__. Auto-merge and cross-repository forms
# are intentionally inert because command completion does not prove that a
# merge happened in the current repository.
parse_gh_pr_merge_selector() {
  python3 - "$1" <<'PY'
import re, shlex, sys
try:
    lexer = shlex.shlex(sys.argv[1], posix=True, punctuation_chars=';&|')
    lexer.whitespace_split = True
    tokens = list(lexer)
except ValueError:
    raise SystemExit(1)
value_options = {'--author-email', '-A', '--body', '-b', '--body-file', '-F',
                 '--match-head-commit', '--subject', '-t'}
for start in range(max(0, len(tokens) - 2)):
    if tokens[start:start + 3] != ['gh', 'pr', 'merge']:
        continue
    command_start = start
    while command_start > 0 and tokens[command_start - 1] not in {';', '&&', '||', '|', '&'}:
        command_start -= 1
    while command_start < start and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', tokens[command_start]):
        command_start += 1
    if command_start != start:
        continue
    selector = None
    i = start + 3
    while i < len(tokens) and not all(ch in ';&|' for ch in tokens[i]):
        arg = tokens[i]
        if arg in {'--auto', '--disable-auto', '--repo', '-R'} \
                or arg.startswith('--repo=') or (arg.startswith('-R') and arg != '-R'):
            raise SystemExit(1)
        if arg in value_options:
            i += 1
            if i >= len(tokens) or all(ch in ';&|' for ch in tokens[i]):
                raise SystemExit(1)
        elif not arg.startswith('-'):
            if selector is not None:
                raise SystemExit(1)
            selector = arg
        i += 1
    print(selector or '__IMPLICIT__')
    raise SystemExit(0)
raise SystemExit(1)
PY
}

resolve_merge_command_repo() {
  local command="$1" hook_cwd="$2" cd_path candidate top
  cd_path=$(python3 - "$command" <<'PY'
import re, shlex, sys
try:
    lexer = shlex.shlex(sys.argv[1], posix=True, punctuation_chars=';&|')
    lexer.whitespace_split = True
    tokens = list(lexer)
except ValueError:
    raise SystemExit(1)
for i in range(max(0, len(tokens) - 2)):
    if tokens[i:i + 3] != ['gh', 'pr', 'merge']:
        continue
    start = i
    while start > 0 and tokens[start - 1] not in {';', '&&', '||', '|', '&'}:
        start -= 1
    command_start = start
    while command_start < i and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', tokens[command_start]):
        command_start += 1
    if command_start != i:
        continue
    if start >= 3 and tokens[start - 1] in {';', '&&'} and tokens[start - 3] == 'cd':
        print(tokens[start - 2])
    raise SystemExit(0)
raise SystemExit(1)
PY
) || return 1
  if [ -n "$cd_path" ]; then
    case "$cd_path" in /*) candidate="$cd_path" ;; *) candidate="$hook_cwd/$cd_path" ;; esac
    top=$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null)
    [ -n "$top" ] && { printf '%s\n' "$top"; return 0; }
    return 1
  fi
  git -C "$hook_cwd" rev-parse --show-toplevel 2>/dev/null
}

merge_boundary_state_file() {
  local common_dir="$1" key="$2" digest
  digest=$(printf '%s' "$key" | sha256sum 2>/dev/null | awk '{print $1}')
  [ -n "$digest" ] || return 1
  printf '%s/sdd-claude-merge-boundary-%s.json\n' "$common_dir" "$digest"
}

valid_merge_boundary_state() {
  jq -e '
    .version == 1 and
    (.status == "pending" or .status == "ready" or .status == "terminal") and
    ((.attempts | type) == "number" and (.attempts | floor) == .attempts and .attempts >= 0 and .attempts <= 3) and
    (.directiveEmitted | type == "boolean")
  ' >/dev/null 2>&1
}

write_merge_boundary_state() {
  local path="$1" json="$2" dir tmp
  dir=$(dirname "$path")
  [ -d "$dir" ] || return 1
  printf '%s' "$json" | valid_merge_boundary_state || return 1
  tmp=$(mktemp "$dir/.sdd-claude-merge-boundary.XXXXXX" 2>/dev/null) || return 1
  if ! printf '%s\n' "$json" > "$tmp" 2>/dev/null; then
    rm -f "$tmp" 2>/dev/null
    return 1
  fi
  chmod 0600 "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv "$tmp" "$path" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
}

terminal_merge_boundary() {
  local path="$1" state="$2" terminal
  terminal=$(printf '%s' "$state" | jq -c '.status = "terminal"') || return 12
  write_merge_boundary_state "$path" "$terminal" || return 12
  return 11
}

retry_merge_boundary() {
  local path="$1" state="$2" attempts pending
  attempts=$(printf '%s' "$state" | jq -r '.attempts + 1') || return 12
  pending=$(printf '%s' "$state" | jq -c --argjson attempts "$attempts" '.attempts = $attempts') || return 12
  if [ "$attempts" -ge 3 ] 2>/dev/null; then
    terminal_merge_boundary "$path" "$pending"
    return $?
  fi
  write_merge_boundary_state "$path" "$pending" || return 12
  return 10
}

# resolve_develop_merge_boundary <command> <git-common-dir> <tool-use-key>
# Exit 0: ready JSON; 10: retryable; 11: terminal/inert; 12: accounting failure.
_resolve_develop_merge_boundary() {
  local command="$1" common_dir="$2" key="$3" path state selector repo_info repo_name repo_owner
  local source_info source_state source_base source_pr merge_oid source_url selected_repo
  local promotions shape_count exact_count ready
  path=$(merge_boundary_state_file "$common_dir" "$key") || return 12
  if [ -e "$path" ]; then
    state=$(cat "$path" 2>/dev/null) || return 12
    printf '%s' "$state" | valid_merge_boundary_state || return 12
    case $(printf '%s' "$state" | jq -r '.status') in
      ready) printf '%s\n' "$state"; return 0 ;;
      terminal) return 11 ;;
    esac
  else
    state='{"version":1,"status":"pending","attempts":0,"directiveEmitted":false}'
    write_merge_boundary_state "$path" "$state" || return 12
  fi

  selector=$(parse_gh_pr_merge_selector "$command") || {
    terminal_merge_boundary "$path" "$state"; return $?
  }
  repo_info=$(gh repo view --json nameWithOwner 2>/dev/null) || {
    retry_merge_boundary "$path" "$state"; return $?
  }
  repo_name=$(printf '%s' "$repo_info" | jq -r '.nameWithOwner // empty' 2>/dev/null)
  case "$repo_name" in */*) ;; *) retry_merge_boundary "$path" "$state"; return $? ;; esac
  repo_owner=${repo_name%%/*}

  if [ "$selector" != "__IMPLICIT__" ]; then
    selected_repo=$(printf '%s' "$selector" | sed -nE 's#^https://github\.com/([^/]+/[^/]+)/pull/[0-9]+/?$#\1#p')
    if [ -n "$selected_repo" ] && [ "$selected_repo" != "$repo_name" ]; then
      terminal_merge_boundary "$path" "$state"; return $?
    fi
    source_info=$(gh pr view "$selector" --json number,state,baseRefName,headRefName,headRefOid,mergeCommit,url 2>/dev/null) || {
      retry_merge_boundary "$path" "$state"; return $?
    }
  else
    source_info=$(gh pr view --json number,state,baseRefName,headRefName,headRefOid,mergeCommit,url 2>/dev/null) || {
      retry_merge_boundary "$path" "$state"; return $?
    }
  fi
  source_state=$(printf '%s' "$source_info" | jq -r '.state // empty' 2>/dev/null)
  source_base=$(printf '%s' "$source_info" | jq -r '.baseRefName // empty' 2>/dev/null)
  source_pr=$(printf '%s' "$source_info" | jq -r '.number // empty' 2>/dev/null)
  merge_oid=$(printf '%s' "$source_info" | jq -r '.mergeCommit.oid // empty' 2>/dev/null)
  source_url=$(printf '%s' "$source_info" | jq -r '.url // empty' 2>/dev/null)
  case "$source_url" in "https://github.com/$repo_name/pull/"*) ;; *) terminal_merge_boundary "$path" "$state"; return $? ;; esac
  if [ "$source_state" = "OPEN" ] || { [ "$source_state" = "MERGED" ] && [ "$source_base" = "develop" ] && ! printf '%s' "$merge_oid" | grep -Eq '^[0-9a-f]{40}$'; }; then
    retry_merge_boundary "$path" "$state"; return $?
  fi
  if [ "$source_state" != "MERGED" ] || [ "$source_base" != "develop" ] \
     || ! printf '%s' "$source_pr" | grep -Eq '^[0-9]+$' \
     || ! printf '%s' "$merge_oid" | grep -Eq '^[0-9a-f]{40}$'; then
    terminal_merge_boundary "$path" "$state"; return $?
  fi

  promotions=$(gh pr list --state open --head develop --json number,state,baseRefName,headRefName,headRefOid,headRepositoryOwner 2>/dev/null) || {
    retry_merge_boundary "$path" "$state"; return $?
  }
  printf '%s' "$promotions" | jq -e 'type == "array"' >/dev/null 2>&1 || {
    retry_merge_boundary "$path" "$state"; return $?
  }
  shape_count=$(printf '%s' "$promotions" | jq --arg owner "$repo_owner" '[.[] | select(.state == "OPEN" and (.baseRefName == "main" or .baseRefName == "master") and .headRefName == "develop" and .headRepositoryOwner.login == $owner)] | length') || return 12
  exact_count=$(printf '%s' "$promotions" | jq --arg owner "$repo_owner" --arg oid "$merge_oid" '[.[] | select(.state == "OPEN" and (.baseRefName == "main" or .baseRefName == "master") and .headRefName == "develop" and .headRepositoryOwner.login == $owner and .headRefOid == $oid)] | length') || return 12
  if [ "$exact_count" -eq 1 ] 2>/dev/null; then
    ready=$(printf '%s' "$promotions" | jq -c --arg owner "$repo_owner" --arg oid "$merge_oid" --argjson source "$source_pr" '
      [.[] | select(.state == "OPEN" and (.baseRefName == "main" or .baseRefName == "master") and .headRefName == "develop" and .headRepositoryOwner.login == $owner and .headRefOid == $oid)][0]
      | {version: 1, status: "ready", attempts: 0, sourcePr: $source, mergeOid: $oid,
         downstreamPr: .number, downstreamBase: .baseRefName, downstreamHead: .headRefOid,
         directiveEmitted: false}') || return 12
    write_merge_boundary_state "$path" "$ready" || return 12
    printf '%s\n' "$ready"
    return 0
  fi
  if [ "$shape_count" -eq 1 ] 2>/dev/null || [ "$(printf '%s' "$promotions" | jq 'length')" -eq 0 ] 2>/dev/null; then
    retry_merge_boundary "$path" "$state"; return $?
  fi
  terminal_merge_boundary "$path" "$state"
}

resolve_develop_merge_boundary() {
  local command="$1" common_dir="$2" key="$3" path lock status
  path=$(merge_boundary_state_file "$common_dir" "$key") || return 12
  lock="$path.lock"
  mkdir "$lock" 2>/dev/null || return 12
  _resolve_develop_merge_boundary "$command" "$common_dir" "$key"
  status=$?
  rmdir "$lock" 2>/dev/null || true
  return "$status"
}

ensure_develop_merge_head() {
  local expected="$1" fetched
  printf '%s' "$expected" | grep -Eq '^[0-9a-f]{40}$' || return 1
  if git cat-file -e "$expected^{commit}" 2>/dev/null; then
    return 0
  fi
  git fetch --quiet origin develop 2>/dev/null || return 1
  fetched=$(git rev-parse refs/remotes/origin/develop 2>/dev/null)
  [ "$fetched" = "$expected" ] && git cat-file -e "$expected^{commit}" 2>/dev/null
}

merge_boundary_mark_directive() {
  local common_dir="$1" key="$2" path lock state updated status=0
  path=$(merge_boundary_state_file "$common_dir" "$key") || return 1
  lock="$path.lock"
  mkdir "$lock" 2>/dev/null || return 1
  state=$(cat "$path" 2>/dev/null) || status=1
  [ "$status" -eq 0 ] && printf '%s' "$state" | valid_merge_boundary_state || status=1
  [ "$status" -eq 0 ] && [ "$(printf '%s' "$state" | jq -r '.status')" = "ready" ] || status=1
  if [ "$status" -eq 0 ]; then
    updated=$(printf '%s' "$state" | jq -c '.directiveEmitted = true') || status=1
  fi
  if [ "$status" -eq 0 ]; then
    write_merge_boundary_state "$path" "$updated" || status=1
  fi
  rmdir "$lock" 2>/dev/null || true
  return "$status"
}
