# Git Workflow

**Commit format:** `<type>: <description>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). AI attribution disabled - no `Co-Authored-By`, no emoji, no "Generated with Claude".

## Triggers and routes

| Event | Skill |
|---|---|
| User explicitly asks to monitor CI, or deploy/merge requires a fresh CI result | `ci-monitoring` (one background continuous tail-followed monitor until green; never repeated chat-visible polling or `gh run watch`) |
| PR-boundary event with `sdd/` present | `git-review-pipeline` (spec/doc/code review pipeline) |
| User asks to open a PR | `pr-workflow` (body template + REQ backlinks + test plan) |
| Need gh/wrangler access, creds unclear | `deploy-credentials` (env-var table + check-then-fallback) |

## SDD opt-in is binary

- **Vibe-coding** (no `sdd/`): `git push` + `gh pr create` proceed with NO review agents.
- **SDD mode** (`sdd/` + `sdd/README.md`): review agents fire only on PR-boundary events targeting `main`/`master`/`develop`. PRs into other integration branches such as `staging` defer until their PR to a protected base opens.

## Hard obligations

- Do not auto-start CI monitoring after non-boundary routine pushes. Invoke `ci-monitoring` for an eligible PR-boundary plan, when the user explicitly asks, or when deploy/merge requires a fresh CI result.
- A successful `git push` or `gh pr create` on an eligible protected-base PR is a delivery boundary: launch review and CI automatically without asking for renewed consent. A later command also auto-recovers a synchronized same-PR descendant of its acknowledged review head; consent applies to other Git/GitHub activity, and acknowledgement must be offered neutrally rather than recommended from agent self-verification.
- After acknowledged triage, apply accepted fixes, commit, and push the checked-out PR branch without asking; never stop after the commit. If this head's terminal CI result is not in yet, wait for it; a failing result is a finding to fix in the same commit, and a head whose CI failure is unaddressed is never pushed. End after the push so the next exact incremental review and CI round can start. Never merge automatically, relaunch an in-flight lane, or create a no-op fix commit.
- Never deploy to integration until every required CI run is green.
- If CI monitoring is required by an explicit user request or deploy/merge gate, skipping `ci-monitoring` is HIGH `ci-monitoring-skill-not-invoked`.
