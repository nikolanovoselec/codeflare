# Git Workflow

Commit `<type>: <description>` using `feat|fix|refactor|docs|test|chore|perf|ci`. No AI attribution, emoji, or co-author line.

<!-- git-workflow-ci-route -->

## Review exposure

Startup, resume, clone, switch, checkout, pull, checked-out-branch push, PR creation, and PR reopen may expose an open protected-base PR head. Exact completion stays silent. Successful checked-out-branch push, PR creation, and PR reopen emit one launch plan. Other misses wait for neutral `Mark review complete` or `Launch review`; never choose.

Fetch, inspection, local mutation, merges without a successful active-checkout or full-`HEAD` transition, detached or path checkout, tags, unrelated-ref pushes, and unpublished or unsynchronized heads are inert. A successful PR merge that changes the active checkout or full `HEAD` uses marker-or-dialog consent for the resulting open protected-base PR.

## One current round

Execute an emitted plan once: start listed reviewers together, start independent CI next when present, then end the turn. Never poll or duplicate it. Interrupted work stores no progress; the next delivery starts fresh and the next non-delivery exposure asks again.

After all required reviewers and terminal exact-head CI, publish canonical triage without mutations. Verify evidence and scope, judge findings separately from fixes, reject unsupported or overengineered proposals, and choose the smallest correction reusing existing machinery. Completion is written immediately before the separate FIX reminder. Apply only accepted fixes in that later turn. Root alone mutates.

<!-- git-workflow-hard-obligations -->

Never mutate reviewed work between triage and FIX, recreate a plan, use legacy `.git/sdd-review-*` state, use a no-op PR edit, push before review closes, or deploy before required CI is green.
