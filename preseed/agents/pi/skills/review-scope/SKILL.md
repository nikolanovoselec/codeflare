---
name: review-scope
description: Canonical Pi scope resolver shared by PR-boundary review, /review, and /sdd clean.
version: 1.0.0
---

# Pi Review Scope

Resolve one scope before any reviewer or enforcement pass starts. Return the scope and exact Git range in the first line of the report.

<!-- review-scope-contract -->
| Input | Resolved scope | Work set |
|---|---|---|
| PR reminder with `review_range=<base>..<head>` | `diff` | Exact two-dot range |
| PR reminder for full protected-base PR | `diff` | Merge-base/protected-base through PR head |
| `/review --diff` | `diff` | Command's resolved PR-base diff |
| `/review --all` | `all` | Whole requested repository |
| `/sdd clean --diff` | `diff` | Command's resolved diff |
| `/sdd clean --all` | `all` | Whole SDD and documentation corpus |

## `scope=diff`

Inspect changed hunks and only direct invalidations:

- callers and schemas reached from changed public symbols;
- behavioral tests for changed behavior;
- REQ `@impl`/`@test` anchors targeting changed symbols, paths, or named blocks;
- owner documentation for changed public API, configuration, deployment, security, or troubleshooting contracts;
- indexes, dependencies, and changelog rows required by in-scope additions/removals.

Reading surrounding context is allowed. Executing an unrelated whole-tree manifest, exploring unrelated graph communities, or reporting unchanged baseline debt is not.

## `scope=all`

Walk every file in the requested corpus and execute every applicable enforcement row. A zero-finding result means the entire declared tree was inspected.

Scope controls breadth only. It does not change severity, evidence, truth, or report-only restrictions. Never impose token, turn, tool, or concurrency limits as a substitute for scope.
