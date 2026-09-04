# Git Workflow

Commit `<type>: <description>` using `feat|fix|refactor|docs|test|chore|perf|ci`. No AI attribution, emoji, or co-author line.

<!-- git-workflow-ci-route -->

## Review exposure

Boundary review applies only when repository contains `sdd/README.md` and checked-out branch has an open PR targeting `develop`, `main`, or `master`. Without that SDD file, continue normal work. Startup, resume, clone, switch, checkout, and pull can expose an eligible PR.

A push qualifies only when its branch heads such a PR. PR creation or reopen qualifies only when its base is protected. After any qualifying push, creation, or reopen, **end the turn immediately and invoke no more tools**. The boundary plan appears after the turn ends. Otherwise continue normal work.

An exact completion marker stays silent. Other qualifying misses offer `Mark review complete` or `Launch review`; never choose. Fetch, inspection, local mutation, detached/path checkout, tags, unrelated pushes, failed transitions, and merges without a checkout or full-`HEAD` transition are inert.

## One current round

Never launch reviewers manually unless the user explicitly requests reviewer launch. `Continue` and `proceed` do not qualify.

Only execute a boundary plan when it appears in a later turn. Start reviewers together, start included exact-head CI next, then end. Never poll or duplicate. Interrupted work starts a fresh round on later exposure.

After terminal review and CI results, publish mutation-free triage. Verify evidence and scope, judge findings separately, and choose the smallest correction. Record completion before FIX; root applies accepted fixes.

<!-- git-workflow-hard-obligations -->

Never mutate reviewed work between triage and FIX, recreate a plan, use legacy `.git/sdd-review-*` state, use a no-op PR edit, push before review closes, or deploy before required CI is green.
