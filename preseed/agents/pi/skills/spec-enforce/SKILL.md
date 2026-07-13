---
name: spec-enforce
description: Pi-native SDD enforcement spine with explicit diff and all scopes. Used by spec-reviewer and /sdd clean.
version: 3.0.0
---

# Pi Spec Enforcement

This is the authoritative Pi spine. It is independent of Claude's enforcement prompt.

## Inputs

- `purpose`: `review` | `clean`
- `scope`: `diff` | `all`
- `range`: exact `<base>..<head>` or protected-base PR diff when `scope=diff`
- `mode`: `interactive` | `auto` | `unleashed`
- layout-resolved config, spec root, and triage path

`purpose=review` is report-only: never edit the spec or queue. `purpose=clean` applies fixes under the mode rules and records them in the `/sdd clean` audit.

## Scope contract

Load `review-scope`, resolve scope, and build the `spec-reviewer` packet once before creating the manifest. In `purpose=review`, do not reconstruct the diff after the packet exists.

### `scope=diff`

Build the in-scope set from:

1. changed REQ/Constraints/Status/field hunks;
2. REQs whose inline `@impl` anchors target changed source symbols or files;
3. REQs whose inline `@test` anchors target changed or renamed test files/blocks;
4. dependencies, index entries, and `sdd/changes.md` entries directly changed or required by those REQs;
5. changed queue lines and commits in the supplied range.

Every manifest row executes against that set. Rows with no relevant input report `inert (reason)`. Do not scan unrelated REQs, backlog entries, or baseline prose. Searching all spec files for anchors that cite a changed path is allowed because it traces direct invalidation; judging unrelated content is not.

### `scope=all`

Walk every active REQ and support file. Every applicable row is exhaustive. `/sdd clean --all` uses this mode.

Scope never lowers severity or truth requirements. There are no token, turn, or tool budgets.

## Execution manifest

Create all 23 rows as `pending`, then finalize each with evidence counts. Pending or bare rows are HIGH findings.

| # | Row | Diff action | All action |
|---|---|---|---|
| 1 | Forbidden content | In-scope Intent/ACs | Every active REQ |
| 2 | Status semantics + Deprecated cleanup | Changed/in-scope REQs | Every REQ |
| 3 | Binding REQ render | In-scope REQs/files | Every REQ |
| 4 | REQ length guidance | In-scope REQs | Every active REQ |
| 5 | AC granularity + accretion | Invoke `spec-enforce-ac` for changed ACs | Invoke for all REQs |
| 6 | AC verbosity + Constraints | Invoke for changed AC/Constraint hunks | Invoke for all REQs |
| 7 | Actor coherence | In-scope REQs | Every REQ |
| 8 | AC sub-bullets | In-scope REQs | Every REQ |
| 9 | Cross-cutting concern split | In-scope REQs | Every REQ |
| 10 | Concern-boundary split | In-scope REQs | Every REQ |
| 11 | Mechanism leakage | In-scope ACs | Every AC |
| 12 | Changelog drift | Entries for in-scope semantic changes | Entire current changelog contract |
| 13 | Meta leakage: extraction stub | In-scope REQs | Every REQ |
| 14 | Meta leakage: Notes shape | In-scope Notes | Every Notes field |
| 15 | Meta leakage: preamble history | Changed preambles | Every domain preamble |
| 16 | CQ-TEST | In-scope Implemented REQs and directly invalidated test anchors | Every eligible REQ |
| 17 | CQ-SOURCE | In-scope REQs and anchors targeting changed source | Every Implemented/Partial REQ |
| 18 | CQ-1/2/3 truth passes | In-scope truth surfaces | Entire corpus |
| 19 | Index integrity | Added/removed/renamed in-scope spec files and changed index rows | Full index/filesystem parity |
| 20 | Dependency acyclicity | Changed dependency edges plus paths reachable from them | Full dependency graph |
| 21 | Queue hygiene | Changed queue entries | Entire live queue |
| 22 | Backlog re-triage | In-scope/open items directly tied to changed REQs | Every open item |
| 23 | Commit prefix + round limit | Commits in the exact range | Last six relevant commits |

Evidence format is `ran (N items, M findings)` or a row-specific count. `inert` must name the absent trigger. Run deterministic rows in one batch and keep raw successful output out of context; the returned manifest contains counts and failures only.

## Orchestration

For `purpose=review`, the caller loads this spine and every triggered AC/truth subskill once in its initial policy-and-packet tool wave. Policy text is never fetched again during the review.

1. Parse the packet's exact range and build the in-scope set from its SDD hunks and direct anchor invalidations.
2. Submit one `ctx_batch_execute` call containing the deterministic commands for inline rows 1-4, 12-15, and 19-23 plus every focused evidence read needed by triggered AC/truth rows. Put all retrieval questions in that call's `queries` array.
3. Execute `spec-enforce-ac` when an in-scope AC or Constraint changed, or when `scope=all`, using the evidence from that batch.
4. Execute `spec-enforce-truth` when an in-scope Implemented/Partial REQ changed, a source/test change directly invalidates an anchor, or `scope=all`, using the evidence from that batch.
5. Merge subskill evidence into the manifest. If concrete findings still need direct evidence, collect all unresolved candidates in one additional batched call; never re-read policy, packet sections, or completed evidence.
6. For `review`, return findings and evidence only. For `clean`, apply mode policy:
   - `interactive`: ask before edits;
   - `auto`: apply mechanical CRITICAL/HIGH/MEDIUM fixes; escalate judgment;
   - `unleashed`: also apply LOW mechanical fixes; escalate truth/judgment.
7. Finalize every row with compact counts/failures.
8. Give each finding candidate one direct-impact verification pass. Stop after every packet hunk, invalidated anchor, and manifest failure has one disposition; do not reopen unrelated graph or source neighborhoods.

## Binding rules

- Canonical statuses: `Proposed`, `Planned`, `Partial`, `Implemented`. `Implemented` means all ACs are shipped and behaviorally verified. `Partial` means any AC or automated verification is incomplete.
- REQ fields remain Intent, Applies To, Acceptance Criteria, Constraints, Priority, Dependencies, Verification, Status; links use markdown anchors.
- Intent and ACs state observable behavior, not internal mechanisms, histories, prompts, vendor marketing, file layouts, or test plans.
- Changed public behavior requires a semantic `sdd/changes.md` entry. Formatting-only changes do not.
- Deprecated REQs are deleted after preserving still-live behavior and references; `Deprecated` is not a status.
- Notes, when present, are temporary exception/transition context or a concise operational pointer, not a second history log.
- The queue is live work, not an archive. Resolved entries are removed.

## Finding disposition

Each fired MEDIUM/HIGH occurrence is either `auto-fixed`, `escalated` with reason and blast radius, or (interactive only) `deferred to user confirmation`. Never downgrade a fired rule to avoid action.

Return findings with REQ/AC, location, severity, evidence, and smallest correction. A zero-finding result is honest only when every applicable row completed over the declared scope.
