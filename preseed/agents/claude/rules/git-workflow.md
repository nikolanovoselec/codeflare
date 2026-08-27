# Git Workflow

**Commit format:** `<type>: <description>` using `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, or `ci`. No AI attribution, emoji, or co-author line.

## Triggers and routes

| Event | Skill |
|---|---|
| User explicitly asks to monitor CI, or deploy/merge requires a fresh CI result | `ci-monitoring` for one exact repository, PR, and head |
| Automatic delivery plan or user-selected `Launch review` after a marker miss | `git-review-pipeline` |
| User asks to open a PR | `pr-workflow` |
| GitHub or Wrangler credentials are unclear | `deploy-credentials` |

## Review exposure

Advanced SDD projects evaluate startup, resume, clone, switch, branch checkout, PR checkout, pull, checked-out-branch push, checked-out-branch PR creation, and checked-out-branch PR reopen. A saved exact completion stays silent. Successful checked-out-branch push, PR creation, and PR reopen automatically emit one launch plan. Other misses use AskUserQuestion once with exactly `Mark review complete` and `Launch review`; never choose for the user. Cancellation writes nothing.

Fetch, status and inspection, local mutation, merge, detached or path checkout, tag, unrelated-ref push, failed commands, child sessions, and non-protected-base PRs are inert. GitHub lookup failure launches and writes nothing.

## Hard obligations

- Run a selected plan once. Start required reviewers together, then exact-head CI immediately when the plan includes it. End the turn after the final launch; never poll or duplicate in-flight work.
- Stopped or interrupted work has no durable progress. Emit no missing-work demand. The next delivery launches a fresh plan; the next non-delivery exposure asks again and replans.
- After all terminal evidence, publish canonical triage without mutation. Completion is written immediately before the separate FIX reminder. Apply accepted fixes only in FIX.
- Never read, write, migrate, or delete legacy `.git/sdd-review-*` state.
- Never deploy until required CI is green. Never merge automatically.
