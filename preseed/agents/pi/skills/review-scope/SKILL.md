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

Use gather-then-reason evidence waves instead of alternating one read or search with one reasoning turn:

1. In the first tool wave, build the lane packet through `ctx_batch_execute` while parallel `read` calls load the lane's complete enforcement spine plus every conditionally applicable subskill. The batch's `queries` surface the lane files/hunks and direct-impact leads; each policy file and packet section is loaded once.
2. Derive the pending manifest and concrete direct-impact candidates from that result. Then issue one `ctx_batch_execute` containing every deterministic check and focused evidence read needed for the packet. Put all retrieval questions in that call's `queries` array so the raw command output stays out of context.
3. If the returned evidence exposes candidates that genuinely need more context, collect every unresolved candidate into one additional batched evidence call. Never re-query policy text, packet sections, or evidence already retrieved.
4. The batches may contain as many commands and queries as the scoped work requires; batching never permits dropping a hunk, manifest row, anchor, or candidate.
5. Inspect the packet's lane-owned hunks first. Follow only direct invalidations: changed callers/importers, schemas or contracts, behavioral tests, REQ anchors, and owner documentation affected by a concrete candidate.
6. Read a whole file only after a hunk or direct invalidation identifies a candidate that cannot be verified from focused context.
7. Finalize every manifest row and give each candidate one direct-impact disposition. Do not recursively explore unrelated callers or graph communities.
8. Stop when every lane-owned hunk, manifest row, and direct candidate has one disposition. Do not report unchanged baseline debt.

Code review does not re-review SDD or documentation prose. Spec and documentation reviewers may use `changedInputs` only to verify anchors or owned contract impact.

## `scope=all` execution

Walk every packet file in the requested corpus and execute every applicable enforcement row. A zero-finding result means the entire declared tree was inspected. Partition large all-scope evidence by packet files, process each partition once, and never re-read completed partitions. Batch deterministic scans and emit compact counts/failures rather than full-file output.

Scope controls breadth only. It does not change severity, evidence, truth, or report-only restrictions. Never impose token, turn, tool, or concurrency limits as a substitute for scope.
