---
name: git-review-pipeline
description: Execute a user-selected SDD exact-head review round with headless parallel reviewers, optional exact-head CI, canonical triage, and separate FIX.
version: 2.0.0
---

# SDD Review Pipeline

Use this skill only after the user selects `Launch review` from the marker-miss question.

## Eligibility and consent

Advanced SDD projects are eligible when the active normal checkout exactly matches an open PR targeting `main`, `master`, or `develop`. SessionStart, clone, switch, branch checkout, PR checkout, pull, checked-out-branch push, and checked-out-branch PR creation may expose that identity.

A valid user-scoped marker stays silent. A miss offers exactly `Mark review complete` and `Launch review`. Never choose for the user. Cancellation writes nothing. Push and PR creation do not auto-launch.

Fetch, inspection, local mutation, merge, detached or path checkout, tag, unrelated-ref push, failed commands, child sessions, GitHub failure, and unsynchronized heads remain inert.

## Fresh plan and headless transport

Every selected launch uses current GitHub and repository facts. A retained same-PR ancestor selects an incremental range; otherwise the planner uses the full protected-base diff. Prior lane output, CI evidence, and consent are discarded after interruption.

Run every emitted `run-review-lane.sh` Bash command unchanged and in the background. Issue all required lane calls together. Each command carries its validated `--range` or `--base`, PR number, and deterministic `/tmp/codeflare-pr-...` output. The runner trusts caller scope and never reads review state.

When the directive includes CI, launch its exact background `ci-monitor` Agent immediately after reviewer calls. Do not wait first. End the turn after the final launch. Never poll or duplicate in-flight work.

## Joint triage and FIX

Wait for every required headless lane and required exact-head CI result. Publish one tool-free canonical table after terminal evidence:

| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |
|---|---|---|---|---|

CI failure or timeout requires FINDING `Exact-head CI` and PROPOSED FIX `CI_RESULT failure` or `CI_RESULT timeout`. A clean successful round may keep the table empty. Judge findings independently from proposed fixes and reject unsupported or oversized changes.

Make no mutation in the triage turn. The Stop hook inspects only transcript bytes after the current SessionStart offset, revalidates the exact identity, writes completion, and emits the separate FIX reminder. Root applies accepted changes only in FIX.

Stopped or failed work advances the ephemeral offset and emits no missing-work directive. Reload clears active coordination. The next eligible exposure asks again and replans. Never read, write, migrate, or delete legacy `.git/sdd-review-*` state.

## Branch protection

The expected route is `feature -> develop -> main`. Protect `main` with PR and required-CI checks. Ask before changing repository protection.
