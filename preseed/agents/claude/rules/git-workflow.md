# Git Workflow (Core)

Identity + obligations for the commit -> push -> CI -> PR chain. Detailed mechanics live in branched skills (`ci-monitoring`, `git-review-pipeline`, `pr-workflow`, `deploy-credentials`).

## Commit message format

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Note: AI attribution disabled globally via `~/.claude/settings.json`. No `Co-Authored-By`, no emoji, no "Generated with Claude" lines.

## SDD opt-in matrix

**SDD opt-in is binary.** Two modes:

- **Vibe-coding mode** (no `sdd/` folder in the project): `git push` and `gh pr create` proceed with **no review agents**. Nothing fires. No code-reviewer, no spec-reviewer, no doc-updater, no auto-generated documentation. Pure friction-free workflow. Intentional: projects that haven't run `/sdd init` are telling you they don't want the workflow.
- **SDD mode** (`sdd/` + `sdd/README.md` exist): review agents fire on PR-boundary events only, not on every push. PRs targeting `main`/`master` are the trigger; PRs into integration branches (`develop`, `staging`) are deferred until the integration branch's own PR-to-main opens.

Full PR-boundary trigger table + execution order + branch-protection setup live in the `git-review-pipeline` skill (invoked at PR-boundary events when SDD is bootstrapped).

## Post-push obligation: monitor CI

After every `git push` that targets a branch with CI workflows, monitor CI until every run on the pushed commit completes successfully. Invoke the `ci-monitoring` skill as a first action; it carries the single-bounded-iteration polling pattern, per-iteration decision matrix, stale-run cancellation, and tool-surface selection (ctx_execute for context-mode, Bash for vibe-coding).

Never report CI as passing without confirming every row is `completed` + `success` in the same iteration. Never deploy to integration until every run is green. Never use `gh run watch` (hangs).

## PR creation

When the user asks the agent to open a PR, invoke the `pr-workflow` skill. It carries the body template, REQ backlink rule, test-plan checklist, and the user-only `gh pr merge` boundary.

## Credentials

GitHub and Cloudflare credentials (`GH_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are optional environment variables. When you need gh/wrangler access, check `echo "${GH_TOKEN:+set}"` first; if unset, offer the user the Settings/CLI-auth/export options. The `deploy-credentials` skill carries the full env-var table, what each token enables, the check-then-fallback protocol, and secret-handling rules.

## Skill family

| Skill | Mode | When invoked |
|---|---|---|
| `ci-monitoring` | default + advanced | After every `git push` to a branch with CI workflows |
| `git-review-pipeline` | advanced | At PR-boundary events when `sdd/` is bootstrapped; when configuring branch protection |
| `pr-workflow` | default + advanced | When the user asks the agent to open a PR |
| `deploy-credentials` | default + advanced | When a turn needs gh/wrangler access and the env-var state is unclear, or for the full operations reference |

Skipping `ci-monitoring` invocation after a push that triggered CI is itself a HIGH lapse caught by the next agent that depends on CI state (deploy gate, PR-merge gate, etc.).
