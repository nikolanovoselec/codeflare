# Git Workflow

Commit `<type>: <description>` using `feat|fix|refactor|docs|test|chore|perf|ci`. No AI attribution, emoji, or co-author line.

<!-- git-workflow-ci-route -->

## Review exposure

Startup, resume, clone, switch, checkout, pull, checked-out-branch push, PR creation, and PR reopen may expose an open protected-base PR. An exact marker stays silent. Successful push, PR creation, and PR reopen emit one plan; other misses show `Mark review complete` or `Launch review`. Never choose.

Fetch, inspection, local mutation, detached/path checkout, tags, unrelated-ref pushes, unsynchronized heads, and merges without a checkout or full-`HEAD` transition are inert. A successful transition uses consent for the resulting open protected-base PR.

## One current round

Execute each plan once: start reviewers together, start independent CI next, then end. Never poll or duplicate. Interrupted work stores no progress; later exposure starts fresh.

After all reviewers and terminal exact-head CI, publish triage without mutations. Verify evidence and scope, judge findings separately from fixes, reject unsupported or oversized proposals, and choose the smallest correction using existing machinery. Completion precedes the separate FIX reminder. Apply only accepted fixes then. Root alone mutates.

<!-- git-workflow-hard-obligations -->

Never mutate reviewed work between triage and FIX, recreate a plan, use legacy `.git/sdd-review-*` state, use a no-op PR edit, push before review closes, or deploy before required CI is green.
