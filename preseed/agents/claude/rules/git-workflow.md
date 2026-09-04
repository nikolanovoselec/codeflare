# Git Workflow

Commit `<type>: <description>` using `feat|fix|refactor|docs|test|chore|perf|ci`. No AI attribution, emoji, or co-author line.

## Triggers and routes

- Explicit CI monitoring or a fresh merge/deploy result: `ci-monitoring`.
- Boundary plan or selected `Launch review`: `git-review-pipeline`.
- User-requested PR: `pr-workflow`.
- Unclear GitHub or Wrangler credentials: `deploy-credentials`.

## Review exposure

Boundary review applies only when repository contains `sdd/README.md` and checked-out branch has an open PR targeting `develop`, `main`, or `master`. Without that SDD file, continue normal work. Startup, resume, clone, switch, checkout, and pull can expose an eligible PR.

A push qualifies only when its branch heads such a PR. PR creation or reopen qualifies only when its base is protected. After any qualifying push, creation, or reopen, **end the turn immediately and invoke no more tools**. The boundary plan appears after the turn ends. Otherwise continue normal work.

An exact completion marker stays silent. Other qualifying misses ask once with exactly `Mark review complete` and `Launch review`; never choose. Cancellation writes nothing. Fetch, inspection, local mutation, detached/path checkout, tags, unrelated pushes, failed transitions, child sessions, non-qualifying PRs, and merges without a checkout or full-`HEAD` transition are inert. A merge that changes the checkout or full `HEAD` uses consent for any resulting qualifying PR. GitHub lookup failure launches and writes nothing.

## Hard obligations

Never launch reviewers manually unless the user explicitly requests reviewer launch. `Continue` and `proceed` do not qualify.

Only execute a boundary plan when it appears in a later turn. Start reviewers together, start included exact-head CI next, then end. Never poll or duplicate. Interrupted work starts a fresh round on later exposure.

After terminal review and CI results, publish mutation-free canonical triage. Verify evidence and scope, judge findings separately, and choose the smallest correction. Record completion before FIX regardless of CI result; root applies accepted fixes.

Never read, write, migrate, or delete legacy `.git/sdd-review-*` state. Never merge automatically.
