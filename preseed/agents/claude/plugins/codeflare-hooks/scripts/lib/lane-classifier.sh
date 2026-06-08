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
#   - any behavioral file      -> "code-reviewer spec-reviewer doc-updater"
#     (anything outside sdd/ + the doc-surface allowlist)
#   - sdd/** only              -> "spec-reviewer doc-updater"
#   - documentation/** etc.    -> "doc-updater"
#   - sdd + docs (no source)   -> "spec-reviewer doc-updater"
#   - graphify-out/** only     -> "" (generated, machine-authored knowledge graph;
#                                 no reviewable behavior, caller auto-acks. REQ-AGENT-040 AC8)
#
# Classification details, NUL-byte hazards, and rename safety are
# documented at each branch below; keep this file and the callers
# in lock-step. Tests live at host/__tests__/lane-classifier.test.js
# (direct unit tests of every branch) plus integration coverage of
# the emission shape in host/__tests__/git-push-review-reminder.test.js
# (lane-aware directive) and host/__tests__/enforce-review-spawn.test.js
# (gate-level lane gating).

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
  while IFS= read -r -d '' file; do
    [ -z "$file" ] && continue
    file_count=$((file_count + 1))
    case "$file" in
      graphify-out/*)
        # Generated, machine-authored artifact (the checked-in graphify knowledge
        # graph). Contributes no review lane (REQ-AGENT-040 AC8). Counted so a
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
        ;;
    esac
  done < <(git diff -z --name-only --no-renames "$last_ack" "$current" 2>/dev/null)

  # Empty diff -> caller saw no file changes between ACK and HEAD.
  # Conservative: require all three lanes rather than silently ack.
  if [ "$file_count" = "0" ]; then
    echo "code-reviewer spec-reviewer doc-updater"
    return
  fi

  # Generated-only diff (REQ-AGENT-040 AC8): every changed file is a machine-authored
  # graphify-out/ artifact, so there is no reviewable behavior. Require no lanes; the
  # caller auto-acks the head (same empty-string contract as an already-acked same-SHA
  # advance). This is the only path that returns empty for a non-empty diff.
  if [ "$((file_count - generated_count))" = "0" ]; then
    return
  fi

  if [ "$has_behavioral" = "1" ]; then
    echo "code-reviewer spec-reviewer doc-updater"
    return
  fi

  # Non-behavioural path: only the lanes whose surface the diff actually
  # touched. A pure documentation push runs only doc-updater. A pure
  # spec push runs spec-reviewer + doc-updater (the doc-updater follow
  # picks up missing REQ backlinks, table-of-contents drift, etc.).
  local lanes=""
  if [ "$touches_sdd" = "1" ]; then
    lanes="spec-reviewer doc-updater"
  fi
  if [ "$touches_docs" = "1" ]; then
    case " $lanes " in
      *" doc-updater "*) ;;
      *) lanes="$lanes doc-updater" ;;
    esac
  fi
  # Trim leading/trailing whitespace. Empty lanes here is structurally
  # impossible (file_count > 0 AND no classification matched would only
  # happen if a file was simultaneously NOT in sdd/, NOT in the doc-surface
  # set, and NOT behavioral, which the catch-all `*` arm forbids).
  echo "$lanes" | awk '{$1=$1; print}'
}
