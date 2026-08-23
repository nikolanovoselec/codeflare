# Git Workflow

Commit `<type>: <description>` using `feat|fix|refactor|docs|test|chore|perf|ci`. No AI attribution, emoji, or co-author line.

<!-- git-workflow-ci-route -->

## Boundary stop

After `git push`, `gh pr create`, or accepting existing-head review leaves the checked-out branch at an unacknowledged exact PR head for `main`, `master`, or `develop`, end the turn and report only the result or PR URL. The plan arrives after idle; do not inspect, poll, edit, launch CI, or run another tool. A plan not yet visible is queued, not missing.

Unpublished commits are never review heads. Launch reviewers only from the emitted authoritative-head plan.

## One plan

Execute the emitted plan once: launch listed reviewers in parallel, launch its independent CI request last, then end the turn. Never poll or duplicate it. After reviewer results arrive, publish the required triage without file changes; apply accepted fixes only in the later FIX turn. Root alone changes repository state.

<!-- git-workflow-hard-obligations -->

Never mutate reviewed work between triage and FIX, recreate a plan, use a no-op PR edit, push before required review closes, or deploy before required CI is green.
