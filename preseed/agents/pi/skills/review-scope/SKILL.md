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

Use a context-processing tool when the JSON or patch is large. A direct packet call returns the complete lane-owned patch once, not only filenames or hunk headers that force a later diff dump. Derive this packet once; do not rebuild or repeatedly dump the same diff.

Prefer `ctx_execute` when it is active. The reviewer runtime guard deletes `intent` from every marked reviewer call before execution, so review evidence cannot switch to indexed retrieval; Bash executes the same derivation when context-mode is unavailable. The program may inspect the complete scoped input internally, but it emits only the packet patch needed for reasoning plus compact manifest counts, failures, and candidate snippets. If a native command overproduces and its output is redirected to a temporary log, rerun a derivation that prints the missing failure evidence; never read the raw log back into context.

## `scope=diff` execution

Use gather-then-reason evidence processing instead of alternating one read or search with one reasoning turn:

1. Build the lane packet exactly once. When context-mode is available, run the packet script through guarded `ctx_execute` so its complete lane patch enters reviewer context directly; otherwise run the same derivation with `bash`. Every canonical policy is already embedded, so no policy retrieval call is needed. Each packet section enters context once.
2. Derive the pending manifest and concrete direct-impact candidates from that result. Consolidate independent deterministic checks into one evidence wave. A `ctx_execute` program inspects the complete work set and prints compact counts and failures; without context-mode, one or more consolidated shell programs perform the equivalent reads, searches, and anchor checks. Context-mode changes transport only; the scoped checks, evidence, and dispositions are identical.
3. If the returned evidence exposes candidates that genuinely need more context, collect every unresolved candidate in one focused wave, batching independent lookups together. Never re-query policy text, packet sections, or evidence already retrieved. This cadence is not a turn limit: continue only when a named candidate still lacks concrete evidence, and state what evidence is missing before the next call.
4. Never use `ctx_batch_execute`, `ctx_search`, `query_scope=global`, or marker-only commands to store and retrieve reviewer evidence. They duplicate prior output and can return incomplete search windows instead of the exact packet.
5. Inspect the packet's lane-owned hunks first. Follow only direct invalidations: changed callers/importers, schemas or contracts, behavioral tests, REQ anchors, and owner documentation affected by a concrete candidate.
6. Read a whole file only after a hunk or direct invalidation identifies a candidate that cannot be verified from focused context. Treat generated seed files as derived output: review their canonical preseed source and use one deterministic source-to-seed identity check instead of searching generated lines repeatedly.
7. Finalize every manifest row and give each candidate one direct-impact disposition. Do not recursively explore unrelated callers or graph communities.
8. Stop when every lane-owned hunk, manifest row, and direct candidate has one disposition. Do not report unchanged baseline debt.

Code review does not re-review SDD or documentation prose. Spec and documentation reviewers may use `changedInputs` only to verify anchors or owned contract impact.

## `scope=all` execution

Walk every packet file in the requested corpus and execute every applicable enforcement row. A zero-finding result means the entire declared tree was inspected. Process each packet file once, never re-read completed evidence, and use direct execution to emit compact counts and failures rather than full-file output.

Scope controls breadth only. It does not change severity, evidence, truth, or report-only restrictions. Never impose token, turn, tool, or concurrency limits as a substitute for scope.
