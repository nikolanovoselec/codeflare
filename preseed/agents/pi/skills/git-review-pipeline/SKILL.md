---
name: git-review-pipeline
description: "Execute an automatic-delivery or user-selected SDD exact-head review round with parallel reviewers, exact-head CI when planned, canonical triage, and separate FIX."
version: 4.0.0
disable-model-invocation: true
---

# Git Review Pipeline in Pi

Use this skill for an extension-emitted automatic delivery plan or after the user selects `Launch review` from a non-delivery marker-miss dialog.

## Eligibility and consent

Advanced SDD projects are eligible when the active normal checkout exactly matches an open PR targeting `main`, `master`, or `develop`. Startup, resume, clone, switch, branch checkout, PR checkout, pull, checked-out-branch push, and checked-out-branch PR creation may expose that identity.

A valid user-scoped exact-head marker stays silent. Successful checked-out-branch push and PR creation automatically emit one review-and-CI plan. Other misses offer exactly `Mark review complete` and `Launch review`; never choose for the user. Cancellation writes nothing.

Fetch, inspection, local mutation, merge, detached or path checkout, tag, unrelated-ref push, failed commands, child sessions, GitHub lookup failure, and unsynchronized heads remain inert.

## Fresh plan

Each automatic or accepted launch starts from current facts. The newest retained marker for the same host, repository, PR, branch, and base sets the range only when its head is an ancestor of the live head. Otherwise review the full PR against the protected base. Do not reuse reviewer results, CI evidence, or a previous launch choice.

Call every listed reviewer together through public `subagent` with `run_in_background: true` and `inherit_context: false`. Preserve `scope=diff`, the exact `review_range` or protected-base scope, and each lane's exact `output_file=/tmp/...` value.

When the plan includes CI, submit its unchanged `ci-monitoring` request immediately after reviewer calls. Do not wait for reviewers first. End the turn after the final launch. Do not poll, resume an in-flight agent, or duplicate any call.

## Triage and FIX

Wait for every required reviewer and required exact-head CI result. CI success, failure, and timeout are terminal. Publish one canonical table after all terminal evidence:

| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |
|---|---|---|---|---|

A failed or timed-out CI result requires FINDING `Exact-head CI` and PROPOSED FIX `CI_RESULT failure` or `CI_RESULT timeout`. A clean successful round may keep the table empty. Judge finding validity separately from its proposed fix and reject oversized fixes with evidence.

Make no file or Git change in the triage turn. End the turn. Agent-end handling revalidates the identity, writes completion, signals sync, and emits a separate FIX reminder. Apply only accepted decisions in FIX. Root alone mutates, commits, and pushes.

Stopped or interrupted work stores no progress and emits no missing-work demand. After live siblings settle, the next delivery creates a fresh plan and the next non-delivery exposure asks again. Never read, write, migrate, or delete legacy `.git/sdd-review-*` state.

## CI relationship

CI remains independent. Push or PR-create context may add one exact-head monitor; other exposures do not invent CI. Reviewers never launch CI, and CI never launches reviewers.

## Branch protection

The expected route is `feature -> develop -> main`. Protect `main` with PR and required-CI rules. Changing branch protection requires user approval.
