---
name: pr-workflow
description: Pull request creation template. Steps for analyzing the full commit history, drafting summary/body, REQ backlinks (when sdd/ exists), and using -u for new branches. Invoked when the user asks the agent to open a PR.
version: 2.0.0
---

# Pull Request Workflow

Before creating or materially rewriting every pull request, on any source or base branch, read [`references/pull-request-authoring.md`](references/pull-request-authoring.md) and follow its canonical shape.

When creating PRs:

1. **Analyze full commit history** (not just latest commit). Use `git log --no-merges <base>..HEAD` to see every commit that will land.
2. **Use `git diff [base-branch]...HEAD`** to see all changes that will be merged.
3. **Collect traceability**: issues, incorporated PRs, requirements, decisions, exact commits, CI, releases, deployments, and deferred work that explain this change.
4. **Draft through the reference**: use its section order, explain every relationship, and scale detail to the PR.
5. **Mark verification truthfully**: distinguish pending checks, exact-head evidence, deployments, owner reports, and production state.
6. **Push with `-u` flag** if the branch is new (`git push -u origin HEAD`).

## Body contract

[`references/pull-request-authoring.md`](references/pull-request-authoring.md) is the canonical PR shape. Do not substitute a summary/test-plan stub, a raw requirement list, or a copied commit log.

## Title guidance

- Keep under 70 characters; details go in the body.
- Lead with the type (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`).
- Match the project's existing PR title convention (read `gh pr list --limit 10` to see recent titles).

## After the PR is open

- The PostToolUse hook fires the SDD review pipeline if the PR base is `main`/`master` and `sdd/` is bootstrapped. See `git-review-pipeline` skill for the execution order.
- Monitor CI per the `ci-monitoring` skill.
- `gh pr merge` is **user-only**. The assistant opens PRs and monitors CI but does not merge unless the user explicitly asks.

## Binding invocation rule

When the user asks the agent to create or materially rewrite a PR, invoke this skill as a first action regardless of either branch. The workflow steps are mechanical; the linked reference owns the canonical body shape.
