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

**When your prompt already carries a `<packet>` block, it is built — reason from it and do not run the CLI.** Rebuilding spends a turn to obtain what you were handed. Everything below applies when no such block is present (a very large diff, or a direct invocation).

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

**Two waves, then report.** A review turn re-sends the entire prompt, so cost grows with the square of the turn count: the difference between three turns and sixteen is not 5x the tokens, it is 25x. Structure the work into waves rather than alternating one lookup with one thought.

**Wave 1 — everything derivable, in one call.** Parse the inlined packet (or build it once when no `<packet>` block is present). Derive the pending manifest and every direct-impact candidate. Read, in this same call, any conditional sub-policy the manifest triggers — a policy read that rides along in a call you were already making costs nothing, while a policy read on its own turn costs the whole prompt again. Emit compact counts, failures, and snippets for every lane hunk and only anchor targets intersecting `changedInputs[].hunks`; never raw packet JSON.

**Wave 2 — every unresolved candidate at once, in one call.** Enter it only when a *named* candidate still lacks concrete evidence, and say what evidence is missing before you make the call. Then collect all of it together: one compound command answering every open question, not one command per question. Never re-query policy text, packet sections, or evidence already returned.

**Then report.** Stop when every packet hunk, every manifest row, and every directly invalidated anchor has exactly one disposition.

**This is a completeness rule, not a budget.** A required check is *batched*, never skipped to save a call, and a third wave is correct when a real question is genuinely still open — say why. What is forbidden is the drip: a call that answers one question when it could have answered eight, or that re-fetches something already in your context. If you find yourself on turn six, the cause is almost always that waves 1 and 2 each asked for less than they could have.

Within a wave: inspect lane-owned hunks first, and follow a changed caller, contract, test, REQ anchor, or owner document only when its resolved symbol or block overlaps a changed-input hunk. File-path equality alone is not direct invalidation. Bound every searching command — `grep`/`rg` carries `-c`, `| wc -l`, or `| head -N`, so what returns is counts and named candidates rather than whatever the pattern happened to match; an unbounded scan puts raw output in context for every remaining turn and defeats the packet. Read a whole file only when a NAMED candidate genuinely cannot be verified from focused context, batched into a wave you were already taking. Treat generated seed files as derived output: review the canonical preseed source and run one deterministic source-to-seed identity check rather than searching generated lines. Do not recursively explore unrelated callers or graph communities, and do not report unchanged baseline debt.

Code review does not re-review SDD or documentation prose. Spec and documentation reviewers may use `changedInputs` only to verify anchors or owned contract impact.

## `scope=all` execution

Walk every packet file in the requested corpus and execute every applicable enforcement row. A zero-finding result means the entire declared tree was inspected. Process each packet file once, never re-read completed evidence, and emit compact counts and failures rather than full-file output.

Scope controls breadth only. It does not change severity, evidence, truth, or report-only restrictions. Never impose token, turn, tool, or concurrency limits as a substitute for scope.

Broad discovery is forbidden at every wave: no repository survey, no indexed search, no re-reading evidence already returned, and no re-deriving what an inlined `<triage>`, `<packet>` or `<evidence>` block already resolved. Being handed an answer is not permission to skip the check — it *is* the check, already performed, and reproducing it costs a turn that re-sends the whole prompt.
