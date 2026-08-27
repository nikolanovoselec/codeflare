# Git Workflow

Commit `<type>: <description>` using `feat|fix|refactor|docs|test|chore|perf|ci`. No AI attribution, emoji, or co-author line.

<!-- git-workflow-ci-route -->

## Review exposure

Startup, resume, clone, switch, branch checkout, PR checkout, pull, checked-out-branch push, and checked-out-branch PR creation may expose an open protected-base PR head. A saved exact completion stays silent. Without one, wait for the neutral `Mark review complete` or `Launch review` choice. Never choose for the user. Push and PR creation do not auto-launch.

Fetch, inspection, local mutation, merge, detached or path checkout, tag, and unrelated-ref push are inert. Unpublished or unsynchronized heads never authorize review.

## One current round

Execute an emitted launch plan once: start listed reviewers together, start its independent CI request immediately afterward when present, then end the turn. Never poll or duplicate it. Interrupted or stopped work has no recoverable progress; after siblings settle, wait for the next exposure and fresh user choice.

After terminal evidence arrives, publish canonical triage without file changes. Completion is written immediately before the separate FIX reminder. Apply only accepted fixes in that later turn. Root alone changes repository state.

<!-- git-workflow-hard-obligations -->

Never mutate reviewed work between triage and FIX, recreate a plan, write or consult legacy `.git/sdd-review-*` state, use a no-op PR edit, push before required review closes, or deploy before required CI is green.
