---
name: pr-workflow
description: "Pull request creation workflow for Pi. Use when the user asks to open/create a PR. Covers commit/diff review, title/body drafting, REQ backlinks, push/upstream handling, CI monitoring, and PR-boundary review-monitor verification. Critical: opening a PR is not permission to spawn reviewer agents; hooks/enforcement own reviewer lanes, while CI monitoring and review-monitor handoff still belong to the main session."
version: 2.0.0
---

# Pull Request Workflow in Pi

Use this when the user asks to open a PR.

## Critical boundary

Opening a PR is **not** permission to spawn review agents.

After `gh pr create`, do **not** call `Agent` for `code-reviewer`, `spec-reviewer`, `doc-updater`, `security-reviewer`, or any review agent unless:

1. the user explicitly asks for review agents, or
2. an actual hook/enforcement message in the current turn explicitly instructs the assistant to launch specific agents.

If SDD review enforcement is required, the hook/enforcement system owns reviewer lane spawning. Do not confuse that with the background **review-monitor**: once a review job exists, the main session must verify or start the monitor for the exact head.

After creating any PR that can produce CI, start CI monitoring unless the user explicitly says to skip it. For SDD PRs targeting `main`/`master`, obey any `codeflare-visible-monitor-handoff` follow-up immediately: spawn the visible CI monitor and visible `review-monitor` for the exact head, then report both agent IDs. If no handoff appears but `.git/codeflare-review-jobs/<head>/` exists, verify `monitor.json` is live or start `review-monitor` immediately. If either monitor task stops, errors, or completes without its contract line (`CI_RESULT` or `REVIEW_RESULT`), restart it for the same exact head instead of waiting for the full TTL.

## Steps

1. Inspect the full commit history that will land:

   ```bash
   git log --no-merges <base>..HEAD
   ```

2. Inspect the full PR diff:

   ```bash
   git diff <base>...HEAD
   ```

3. If `sdd/` exists, include relevant `REQ-*` backlinks in the PR body.
4. Draft a concise title under 70 characters, using the repo's convention when visible.
5. Draft a body with summary and test plan.
6. Push with upstream if needed:

   ```bash
   git push -u origin HEAD
   ```

7. Create the PR.
8. Report the PR URL.
9. If a `codeflare-visible-monitor-handoff` follow-up appears, spawn the requested visible CI monitor and visible `review-monitor` for the exact head, then report both agent IDs.
10. If no handoff appears and the PR can produce CI, start one background CI monitor for the exact head unless the user explicitly skipped CI monitoring.
11. If this is an SDD `main`/`master` PR and `.git/codeflare-review-jobs/<head>/job.json` exists, verify or start `review-monitor` for the exact head. Do not stop while `monitor.json` is missing, stale, or tied to a stopped/no-output monitor.

## Body template

Use a heredoc so markdown is preserved:

```bash
gh pr create --base <base> --head <branch> --title "<title>" --body "$(cat <<'EOF'
## Summary
- <1-3 bullets describing what changed and why>
- <REQ-* backlink bullet if sdd/ exists>

## Test plan
- [ ] CI green on this PR
- [ ] <feature-specific smoke check>
EOF
)"
```

## After the PR is open

Allowed and required without asking:

- print the PR URL
- print the branch/base
- summarize what changed
- start background CI monitoring for CI-producing PRs unless explicitly skipped
- obey `codeflare-visible-monitor-handoff` follow-ups by spawning visible CI/review monitors for the exact head
- verify/start or restart `review-monitor` when a PR-boundary review job exists for the exact head

Not allowed unless explicitly requested:

- spawning reviewer lane agents (`code-reviewer`, `spec-reviewer`, `doc-updater`, security reviewers)
- merging the PR
- changing branch protection
