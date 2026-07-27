#!/usr/bin/env bash
# Shared lane-classifier for the SDD review pipeline.
#
# Single source of truth for which review lanes a diff between two
# git SHAs requires. Sourced by both:
#
#   - enforce-review-spawn.sh (Stop hook): blocks turn-end when the
#     required lanes have not been spawned-after-push.
#   - git-push-review-reminder.sh (PostToolUse hook): emits the
#     in-turn directive listing exactly the agents to spawn, no
#     more. Without a shared classifier the two hooks could disagree
#     and the PostToolUse nudge would tell the agent to fire lanes
#     the Stop hook then silently excludes - wasted tokens.
#
# Contract (compute_required_lanes):
#
#   compute_required_lanes <last_ack_sha> <current_sha>
#
#   - last_ack_sha empty       -> "code-reviewer spec-reviewer doc-updater"
#   - last_ack_sha == current  -> "" (caller treats as no-op advance)
#   - merge-base != last_ack   -> "code-reviewer spec-reviewer doc-updater"
#                                 (force-push / rebase / hard-reset safety)
#   - empty diff               -> "code-reviewer spec-reviewer doc-updater"
#                                 (conservative fall-through)
#   - any behavioral file      -> "code-reviewer", plus spec-reviewer and/or
#     (anything outside sdd/ +    doc-updater ONLY where that surface actually
#      the doc-surface allowlist) has work: its own tree changed in this diff,
#                                 or one of its `@impl` anchors cites a changed
#                                 file and may now be stale. A source-only push
#                                 that no anchor cites therefore requires the
#                                 code lane alone. REQ-AGENT-040
#   - behavioral files whose delta is provably comments/whitespace only
#                              -> "code-reviewer" (plus any sdd//docs lanes the
#                                 same diff independently earns). Proven by
#                                 skills/review-scope/scripts/inert-source-delta.mjs,
#                                 the same prover Pi runs; unprovable for ANY
#                                 reason keeps the all-three posture. The code
#                                 lane is never dropped. REQ-AGENT-040 AC5
#   - sdd/** only              -> "spec-reviewer doc-updater"
#   - documentation/** etc.    -> "doc-updater"
#   - sdd + docs (no source)   -> "spec-reviewer doc-updater"
#   - graphify-out/** only     -> "" (generated, machine-authored knowledge graph;
#                                 no reviewable behavior, caller auto-acks. REQ-AGENT-040 AC1)
#
# Classification details, NUL-byte hazards, and rename safety are
# documented at each branch below; keep this file and the callers
# in lock-step. Tests live at host/__tests__/lane-classifier.test.js
# (direct unit tests of every branch) plus integration coverage of
# the emission shape in host/__tests__/git-push-review-reminder.test.js
# (lane-aware directive) and host/__tests__/enforce-review-spawn.test.js
# (gate-level lane gating).

# Does any `@impl` anchor inside $1 cite one of the changed files $2..? That is
# the only way a source-only change can invalidate something in a spec or doc
# tree, and it is exactly the check those lanes perform first. Answering it here
# with grep costs nothing; answering it by spawning an agent costs a startup.
#
# Absent tree -> the lane owns no files at all, so "no work" is the true answer.
# A path is matched literally (-F) because anchors carry repo-relative paths that
# routinely contain regex metacharacters such as `.` and `+`.
anchor_cites_changed() {
  local tree="$1"
  shift
  [ -d "$tree" ] || return 1
  [ "$#" -gt 0 ] || return 1
  local file
  for file in "$@"; do
    [ -z "$file" ] && continue
    if grep -rqlF -- "@impl: $file" "$tree" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

compute_required_lanes() {
  local last_ack="$1" current="$2"

  # Initial baseline (no prior ack at all): require everything.
  if [ -z "$last_ack" ]; then
    echo "code-reviewer spec-reviewer doc-updater"
    return
  fi

  # Same SHA already acked: nothing required. Caller treats this as a
  # short-circuit advance.
  if [ "$last_ack" = "$current" ]; then
    return
  fi

  # Force-push / rebase safety: only trust the diff when last_ack is
  # actually an ancestor of current. If history was rewritten (force-
  # push, rebase, hard reset) such that last_ack is no longer reachable
  # OR sits on a divergent branch, `git diff last_ack current` can still
  # produce a file list across unrelated trees that mis-classifies the
  # push. merge-base failing OR not equalling last_ack -> fall back to
  # the conservative all-three-lanes posture.
  local mb
  mb=$(git merge-base "$last_ack" "$current" 2>/dev/null)
  if [ -z "$mb" ] || [ "$mb" != "$last_ack" ]; then
    echo "code-reviewer spec-reviewer doc-updater"
    return
  fi

  # Get the changed file list between the last acked SHA and the
  # current PR HEAD. Fail-safe: an empty result OR a git error means
  # we cannot prove the diff is benign, so we conservatively require
  # all three lanes.
  #
  # --no-renames is REQUIRED for adversarial safety. With default rename
  # detection (modern git's default), a rename from src/foo.ts ->
  # documentation/foo.md emits ONLY the new path, classifying the change
  # as docs-only and skipping code-reviewer + spec-reviewer entirely.
  # --no-renames forces both old and new paths into the list, so the
  # source path triggers the behavioral fall-through.
  #
  # -z emits NUL-terminated filenames so paths containing literal
  # newlines (legal in POSIX) are not split across iterations and
  # mis-classified.
  #
  # CRITICAL: feed the git output to the read loop via process
  # substitution (`< <(...)`), NOT via command substitution
  # (`changed=$(git diff -z ...)` + `<<< "$changed"`). Bash strips NUL
  # bytes from `$(...)` captures (emitting the warning "ignored null
  # byte in input") -- which destroys the delimiter the read loop
  # waits for, so `read -d ''` blocks until EOF, returns failure, and
  # the loop body NEVER executes. has_behavioral / touches_sdd /
  # touches_docs all stay 0 -> compute_required_lanes returns empty
  # string -> the caller's "no lanes required" branch silently acks
  # the checkpoint for an unreviewed behavioral push. Process
  # substitution streams the bytes through a pipe with NULs intact.
  #
  # Defense in depth: if the diff was non-empty (we saw files) but
  # classification produced no signal, force all three lanes. This
  # guards against any future NUL-handling regression or unexpected
  # git output.
  local has_behavioral=0 touches_sdd=0 touches_docs=0 file_count=0 generated_count=0
  local behavioral_files=()
  while IFS= read -r -d '' file; do
    [ -z "$file" ] && continue
    file_count=$((file_count + 1))
    case "$file" in
      graphify-out/*)
        # Generated, machine-authored artifact (the checked-in graphify knowledge
        # graph). Contributes no review lane (REQ-AGENT-040 AC1). Counted so a
        # generated-ONLY diff is distinguishable from an empty/errored diff below;
        # a diff mixing it with real source/sdd/docs is still classified by those.
        generated_count=$((generated_count + 1))
        ;;
      sdd/*)
        touches_sdd=1
        ;;
      documentation/*|README.md|CHANGELOG.md|CONTRIBUTING.md|SECURITY.md|LICENSE)
        touches_docs=1
        ;;
      *)
        # Any file outside sdd/ and the doc-surface set counts as
        # behavioural and forces all three lanes. This catches source
        # code, tests (which can shift code semantics via fixture
        # changes), scripts, configs, schemas, sub-package READMEs,
        # CI workflows, and the preseed tree.
        has_behavioral=1
        behavioral_files+=("$file")
        ;;
    esac
  done < <(git diff -z --name-only --no-renames "$last_ack" "$current" 2>/dev/null)

  # Empty diff -> caller saw no file changes between ACK and HEAD.
  # Conservative: require all three lanes rather than silently ack.
  if [ "$file_count" = "0" ]; then
    echo "code-reviewer spec-reviewer doc-updater"
    return
  fi

  # Generated-only diff (REQ-AGENT-040 AC1): every changed file is a machine-authored
  # graphify-out/ artifact, so there is no reviewable behavior. Require no lanes; the
  # caller auto-acks the head (same empty-string contract as an already-acked same-SHA
  # advance). This is the only path that returns empty for a non-empty diff.
  if [ "$((file_count - generated_count))" = "0" ]; then
    return
  fi

  # Content-aware reduction (REQ-AGENT-040 AC5). A source file whose delta is
  # provably comments and whitespace changes no behaviour, so neither the spec
  # surface nor the documentation surface can have drifted and those two lanes
  # have nothing to check. The code lane is NEVER dropped: the changed text is
  # still reviewable prose ("is this comment still true?"), and keeping that
  # lane is what bounds the damage if the prover is ever wrong about a file --
  # a directive comment such as @ts-expect-error or eslint-disable is exactly
  # the case where a comment DOES change behaviour, and it still lands in front
  # of a reviewer. The prover proves; on ANY doubt -- no node, a non-zero exit,
  # an unsupported extension, an added/deleted/renamed file, a binary blob, an
  # unparseable construct -- the behavioural posture stands unchanged.
  local inert_source=0
  if [ "$has_behavioral" = "1" ] \
     && [ "${#behavioral_files[@]}" -gt 0 ] \
     && command -v node >/dev/null 2>&1; then
    # The prover must SAY it proved something. A zero exit alone once meant
    # inert, so any run that ended without deciding read as a proof.
    local proof
    proof=$(printf '%s\0' "${behavioral_files[@]}" \
       | node "$(dirname "${BASH_SOURCE[0]}")/../../../../skills/review-scope/scripts/inert-source-delta.mjs" \
              "$last_ack" "$current" 2>/dev/null)
    if [ "$proof" = "INERT" ]; then
      has_behavioral=0
      inert_source=1
    fi
  fi

  if [ "$has_behavioral" = "1" ]; then
    # A behavioural change always owes the code lane. It owes the spec and doc
    # lanes only where those trees actually have something to check: their own
    # surface changed, or one of their `@impl` anchors cites a file in this
    # diff and may now be stale. Demanding all three unconditionally is what
    # made a source-only push pay for two lanes that opened, found no
    # lane-owned file, and exited -- each still costing a full agent startup.
    # The reviewers' own review-scope policy already exits early in exactly
    # that case; this makes the classifier agree with them before the spawn,
    # where the decision is free. Fail-closed: if the repository root cannot
    # be resolved the anchor test is unavailable, so keep the old posture.
    local repo_root
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null)
    if [ -z "$repo_root" ]; then
      echo "code-reviewer spec-reviewer doc-updater"
      return
    fi

    local lanes="code-reviewer" wants_docs="$touches_docs"
    if [ "$touches_sdd" = "1" ] \
       || anchor_cites_changed "$repo_root/sdd" "${behavioral_files[@]}"; then
      lanes="$lanes spec-reviewer"
      # Same coupling the non-behavioural path uses: a spec change drags the
      # doc lane along for backlinks and table-of-contents drift.
      [ "$touches_sdd" = "1" ] && wants_docs=1
    fi
    if [ "$wants_docs" = "1" ] \
       || anchor_cites_changed "$repo_root/documentation" "${behavioral_files[@]}"; then
      lanes="$lanes doc-updater"
    fi
    echo "$lanes"
    return
  fi

  # Non-behavioural path: only the lanes whose surface the diff actually
  # touched. A pure documentation push runs only doc-updater. A pure
  # spec push runs spec-reviewer + doc-updater (the doc-updater follow
  # picks up missing REQ backlinks, table-of-contents drift, etc.).
  # A proven-inert source delta contributes the code lane alone.
  local lanes=""
  [ "$inert_source" = "1" ] && lanes="code-reviewer"
  if [ "$touches_sdd" = "1" ]; then
    lanes="${lanes:+$lanes }spec-reviewer doc-updater"
  fi
  if [ "$touches_docs" = "1" ]; then
    case " $lanes " in
      *" doc-updater "*) ;;
      *) lanes="${lanes:+$lanes }doc-updater" ;;
    esac
  fi
  # Trim leading/trailing whitespace. Empty lanes here is structurally
  # impossible (file_count > 0 AND no classification matched would only
  # happen if a file was simultaneously NOT in sdd/, NOT in the doc-surface
  # set, and NOT behavioral, which the catch-all `*` arm forbids).
  echo "$lanes" | awk '{$1=$1; print}'
}
