---
name: review-scope
description: Canonical executable Pi scope resolver shared by PR-boundary review, /review, and /sdd clean.
version: 2.0.0
---

# Pi Review Scope

Resolve one scope before any reviewer or enforcement pass starts. Return the scope, work set, and exact Git range in the first line of the report.

<!-- review-scope-contract -->
| Input | Resolved scope | Work set |
|---|---|---|
| PR plan with `review_range=<base>..<head>` | `diff` | Changed hunks plus direct invalidations in the exact two-dot range |
| PR plan for full protected-base PR | `diff` | Changed hunks plus direct invalidations from merge base through PR head |
| `/review --diff` | `diff` | Changed hunks plus direct invalidations in the command's PR-base diff |
| `/review --all` | `all` | Whole requested repository |
| `/sdd clean --diff` or `--scope=diff` | `diff` | Changed hunks plus direct invalidations in the command's diff |
| `/sdd clean --all` or `--scope=all` | `all` | Whole SDD and documentation corpus |

The extension-level contract is `{ mode, workSet }`, where `workSet` is `changed-hunks-and-direct-invalidations` for `diff` and `whole-requested-tree` for `all`.

## Build the lane packet once

For `diff`, validate the range and obtain the lane-owned file list and hunks in one call:

```bash
node ~/.pi/agent/skills/review-scope/scripts/build-review-packet.mjs \
  --repo <absolute-root> --scope diff --range <base>..<head> --lane <code-reviewer|spec-reviewer|doc-updater>
```

For `all`, omit `--range` and pass `--scope all`. The packet contains:

- `files`: lane-owned changed files (`diff`) or tracked lane files (`all`);
- `patch`: lane-owned changed hunks for `diff`, empty for `all`;
- `changedInputs`: changed files owned by other lanes, available only as direct-impact leads;
- the normalized scope, work set, lane, and ancestry-validated range.

Use a context-processing tool when the JSON or patch is large. Derive this packet once; do not rebuild or repeatedly dump the same diff.

## `scope=diff` execution

1. Inspect the packet's lane-owned hunks first.
2. Follow only direct invalidations: changed callers/importers, schemas or contracts, behavioral tests, REQ anchors, and owner documentation affected by a concrete candidate.
3. Read a whole file only after a hunk or direct invalidation identifies a candidate that cannot be verified from focused context.
4. Run deterministic manifest/enforcement checks in one batched command and return only counts plus failures. Never print full source files or full successful manifests.
5. Verify each candidate through one direct-impact pass, then report or dismiss it. Do not recursively explore unrelated callers or graph communities.
6. Stop when every lane-owned hunk and direct candidate has one disposition. Do not report unchanged baseline debt.

Code review does not re-review SDD or documentation prose. Spec and documentation reviewers may use `changedInputs` only to verify anchors or owned contract impact.

## `scope=all` execution

Walk every packet file in the requested corpus and execute every applicable enforcement row. A zero-finding result means the entire declared tree was inspected. Batch deterministic scans and emit compact counts/failures rather than full-file output.

Scope controls breadth only. It does not change severity, evidence, truth, or report-only restrictions. Never impose token, turn, tool, or concurrency limits as a substitute for scope.
