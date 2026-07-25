---
name: review-scope
description: Canonical scope resolver and lane evidence packet for review workflows.
version: 1.0.0
disable-model-invocation: true
---

# Review Scope

Resolve one scope before any reviewer or enforcement pass starts. Return the scope, work set, and exact Git range in the first line of the report.

<!-- review-scope-contract -->
| Input | Resolved scope | Work set |
|---|---|---|
| PR-boundary directive with `git diff <base> <head>` | `diff` | Changed hunks plus direct invalidations in the exact two-dot range |
| PR-boundary directive with no prior reviewed head | `diff` | Changed hunks plus direct invalidations from merge base through PR head |
| `/review --diff` | `diff` | Changed hunks plus direct invalidations in the command's PR-base diff |
| `/review --all` | `all` | Whole requested repository |
| `/sdd clean --diff` or `--scope=diff` | `diff` | Changed hunks plus direct invalidations in the command's diff |
| `/sdd clean --all` or `--scope=all` | `all` | Whole SDD and documentation corpus |

## Build the lane packet once

For `diff`, validate the range and obtain the lane-owned file list and hunks in one call:

```bash
node ~/.claude/skills/review-scope/scripts/build-review-packet.mjs \
  --repo <absolute-root> --scope diff --range <base>..<head> --lane <code-reviewer|spec-reviewer|doc-updater>
```

For `all`, omit `--range` and pass `--scope all`. The packet contains:

- `files`: lane-owned changed files (`diff`) or tracked lane files (`all`);
- `patch`: lane-owned changed hunks for `diff`, empty for `all`;
- `changedInputs`: cross-lane inputs as `{ path, hunks }`, where each hunk carries exact old/new line ranges;
- the normalized scope, work set, lane, and ancestry-validated range.

Build and consume the packet in the same Bash call: pipe the CLI's stdout into the processing program and parse it in memory. Never persist the packet, return a packet path, echo raw packet JSON, or rebuild it in a later call. The packet is the evidence transport — it exists so that scoped evidence reaches you without raw scan output entering the conversation.

A changed input path alone does not invalidate every anchor in that file. Resolve the anchored implementation symbol or named test block and pass its old/new line range to the packet module's exported `changedInputIntersects(input, range)` predicate; follow it only when that predicate returns true. Added or removed files use their non-zero side. Commands inspect the complete scoped packet internally and emit compact manifest failures and candidate snippets, not successful manifests or raw packet JSON.

## `scope=diff` execution

Use gather-then-reason evidence processing instead of alternating one read or search with one reasoning turn:

1. Build and parse the lane packet exactly once inside the first Bash call. Every canonical policy arrives through the enforcement skill, so no policy retrieval call is needed.
2. Derive the pending manifest and direct-impact candidates in that same evidence wave. Emit compact counts, failures, and snippets for every lane hunk and only anchor targets intersecting `changedInputs[].hunks`; do not emit raw packet JSON.
3. If the returned evidence exposes candidates that genuinely need more context, collect every unresolved candidate in one focused wave, batching independent lookups together. Never re-query policy text, packet sections, or evidence already retrieved. This cadence is not a turn limit: continue only when a named candidate still lacks concrete evidence, and state what evidence is missing before the next call.
4. Bound every shell command that searches. `grep`/`rg` must carry `-c`, `| wc -l`, or `| head -N` so the transcript receives counts and named candidates rather than whatever the pattern happened to match. An unbounded scan defeats the packet.
5. Inspect lane-owned hunks first. Follow a changed caller, contract, test, REQ anchor, or owner document only when its resolved symbol/block overlaps a changed-input hunk or a concrete lane candidate identifies the dependency. File-path equality alone is not direct invalidation.
6. Read a whole file only after a hunk or direct invalidation identifies a candidate that cannot be verified from focused context. Treat generated seed files as derived output: review their canonical preseed source and use one deterministic source-to-seed identity check instead of searching generated lines repeatedly.
7. Finalize every manifest row and give each candidate one direct-impact disposition. Do not recursively explore unrelated callers or graph communities.
8. Stop when every lane-owned hunk, manifest row, and direct candidate has one disposition. Do not report unchanged baseline debt.

Code review does not re-review SDD or documentation prose. Spec and documentation reviewers may use `changedInputs` only to verify anchors or owned contract impact.

## `scope=all` execution

Walk every packet file in the requested corpus and execute every applicable enforcement row. A zero-finding result means the entire declared tree was inspected. Process each packet file once, never re-read completed evidence, and emit compact counts and failures rather than full-file output.

Scope controls breadth only. It does not change severity, evidence, truth, or report-only restrictions. Never impose token, turn, tool, or concurrency limits as a substitute for scope.
