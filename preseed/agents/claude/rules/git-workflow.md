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
- **SDD mode** (`sdd/` + `sdd/README.md`): review agents fire only on PR-boundary events targeting `main`/`master`. PRs into integration branches (`develop`, `staging`) defer until the integration→main PR opens.

## Hard obligations

- Do not auto-start CI monitoring after routine pushes. Invoke `ci-monitoring` only when the user explicitly asks, or when deploy/merge requires a fresh CI result.
- Never deploy to integration until every required CI run is green.
- If CI monitoring is required by an explicit user request or deploy/merge gate, skipping `ci-monitoring` is HIGH `ci-monitoring-skill-not-invoked`.
