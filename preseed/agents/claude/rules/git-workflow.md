# Git Workflow

**Commit format:** `<type>: <description>` (types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). AI attribution disabled — no `Co-Authored-By`, no emoji, no "Generated with Claude".

## Triggers and routes

| Event | Skill |
|---|---|
| After `git push` to a branch with CI | `ci-monitoring` (one background continuous tail-followed monitor until green; never repeated chat-visible polling or `gh run watch`) |
| PR-boundary event with `sdd/` present | `git-review-pipeline` (spec/doc/code review pipeline) |
| User asks to open a PR | `pr-workflow` (body template + REQ backlinks + test plan) |
| Need gh/wrangler access, creds unclear | `deploy-credentials` (env-var table + check-then-fallback) |

## SDD opt-in is binary

- **Vibe-coding** (no `sdd/`): `git push` + `gh pr create` proceed with NO review agents.
- **SDD mode** (`sdd/` + `sdd/README.md`): review agents fire only on PR-boundary events targeting `main`/`master`. PRs into integration branches (`develop`, `staging`) defer until the integration→main PR opens.

## Hard obligations

- After every push that triggers CI: invoke `ci-monitoring` once, run its continuous tail-followed monitor in a background task, and confirm every row `completed` + `success` before reporting green or deploying.
- Never deploy to integration until every CI run is green.
- Skipping `ci-monitoring` is HIGH `ci-monitoring-skill-not-invoked` (caught by the next downstream agent).
