---
name: git-review-pipeline
description: "SDD-mode PR-boundary review policy for Pi. Use to understand when review enforcement applies to PRs targeting main/master. Critical: this skill does not authorize manual Agent spawns; PR-boundary hooks/enforcement own reviewer spawning. The assistant launches review agents only when the user explicitly asks or an actual hook directive explicitly commands it."
version: 2.0.0
---

# Git Review Pipeline in Pi

This skill explains the SDD review policy. It is **not** a command to spawn reviewers.

## Non-negotiable guard

Do **not** call `Agent` for `code-reviewer`, `spec-reviewer`, or `doc-updater` merely because:

- a PR targets `main` or `master`,
- `sdd/` exists,
- this skill was loaded, or
- the PR-boundary table says review applies.

Reviewer spawning is owned by PR-boundary enforcement hooks. The assistant must not manually spawn review agents unless one of these is true:

1. The user explicitly says to run/spawn review agents.
2. A hook/enforcement message in the current turn explicitly instructs the assistant to launch specific review agents.

If neither is true: create/push/open the PR, report the URL, and stop.

## PR-boundary policy

SDD projects (`sdd/` + `sdd/README.md`) are reviewed only when work is headed to `main` or `master`.

| Event | Base | Enforcement behavior | Assistant action |
|---|---|---|---|
| `gh pr create --base main` | `main` | PR-boundary enforcement may require the review pipeline | Do not spawn agents unless a hook explicitly says so |
| `gh pr create --base master` | `master` | PR-boundary enforcement may require the review pipeline | Do not spawn agents unless a hook explicitly says so |
| PR into `develop` / `staging` | integration branch | Review is deferred until integration-to-main PR | Do not spawn agents |
| `git push` to branch with open PR to `main`/`master` | `main`/`master` | PR-sync enforcement may require review | Do not spawn agents unless a hook explicitly says so |
| `git push` to branch with no main-bound PR | none | No PR-boundary review yet | Do not spawn agents |

## Execution order reference

When enforcement actually launches or explicitly instructs a launch, the order is:

1. `code-reviewer` can run in parallel with the others.
2. `spec-reviewer` runs before `doc-updater`.
3. `doc-updater` runs after `spec-reviewer`.

This order is reference material only. It is not permission to launch agents proactively.

## What to do after opening a PR

1. Print the PR URL.
2. Mention that PR-boundary enforcement may run separately if required.
3. Do not start CI monitoring unless the user explicitly asks or a merge/deploy gate requires a fresh CI result.
4. Do not start review agents unless the user explicitly asks or a hook explicitly instructs it.

## Branch-protection note

The intended workflow is:

```text
feature branch -> develop -> PR to main
```

Branch protection on `main` should require PRs and CI, but setting branch protection is separate from opening a PR. Ask before changing branch protection.
