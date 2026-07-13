---
name: doc-enforce
description: Pi-native documentation enforcement spine with explicit diff and all scopes. Used by doc-updater and /sdd clean.
version: 3.0.0
---

# Pi Documentation Enforcement

This is the authoritative Pi documentation spine. It is independent of Claude's enforcement prompt.

## Inputs

- `purpose`: `review` | `clean`
- `scope`: `diff` | `all`
- exact range, mode, layout, config, and in-scope file set

`purpose=review` never edits documentation or audit files. `purpose=clean` applies mode-approved fixes after spec enforcement completes.

## Scope contract

Load `review-scope`; its resolved scope and range are binding. Build the `doc-updater` packet once. In `purpose=review`, do not reconstruct the diff after the packet exists.

### `scope=diff`

Inspect:

1. changed documentation and root README hunks;
2. docs whose `@impl` anchors directly target changed source symbols/files;
3. the owner lane for a changed public route, environment variable, deployment/rollback command, security boundary, or troubleshooting behavior;
4. README index entries for in-scope added/removed/renamed doc files;
5. REQ backlinks directly affected by changed REQs.

Read surrounding sections for consistency, but do not scan unrelated files or report baseline debt. Searching docs for anchors/backlinks to changed symbols/REQs is direct impact, not whole-tree review.

### `scope=all`

Walk every documentation file and root README. `/sdd clean --all` uses this mode.

No token, turn, or tool cap applies; scope is the work bound.

## Execution manifest

Create all 16 rows as `pending` and finalize each with counts or a specific inert reason.

| # | Pass | Diff action | All action |
|---|---|---|---|
| 1 | Per-element budgets | Changed sections | Every element |
| 2 | File-level budgets | Always inert; cap removed | Always inert |
| 3 | Implementation-prose detection | Invoke `doc-enforce-lanes` for in-scope files | Every doc |
| 4 | Lane violations | In-scope files | Every doc |
| 5 | Template field presence | Changed canonical sections | Every canonical lane |
| 6 | File shape consistency | In-scope canonical files | Every canonical lane |
| 7 | Endpoint rendering | Changed `api-reference*.md`/route docs | Every endpoint |
| 8 | Verification truth | Implemented-REQ docs directly affected | All Implemented-REQ docs |
| 9 | Implements-vs-AC cross-walk | Directly affected REQ docs | Entire cross-walk |
| 10 | Stale code blocks | Changed/invalidated blocks | Every block |
| 11 | Trim preservation | Removed doc hunks | All clean trims |
| 12 | Stranger cold-read | Changed operator tasks | Every configured task |
| 13 | Within-section consistency | Changed sections | Every section |
| 14 | Authoring quality | Changed prose hunks | Every canonical paragraph |
| 15 | Doc source-anchor truth | Changed docs and anchors targeting changed source | Every lane/ADR anchor |
| 16 | Doc index integrity | In-scope files/index rows | Full filesystem/index parity |

Pending or bare rows are HIGH findings.

## Orchestration

For `purpose=review`, the caller loads this spine and every triggered lane/shape/truth subskill once in its initial policy-and-packet tool wave. Policy text is never fetched again during the review.

1. Resolve layout from `documentation/README.md`, then derive changed hunks and direct-impact files from the packet.
2. Submit one `ctx_batch_execute` call containing deterministic commands for passes 1, 2, 13, 14, and 16 plus every focused evidence read needed by triggered lane/shape/truth passes. Put all retrieval questions in that call's `queries` array.
3. Execute `doc-enforce-lanes` for every in-scope doc file, or every file under `scope=all`, using the evidence from that batch.
4. Execute `doc-enforce-shape` when canonical/index/API shape is in scope, or `scope=all`, using the evidence from that batch.
5. Execute `doc-enforce-truth` when docs or source changes directly affect anchors/contracts, or `scope=all`, using the evidence from that batch. Pass 15 is never gated.
6. Aggregate evidence as counts and failures; keep full successful output out of context. If concrete findings still need direct evidence, collect all unresolved candidates in one additional batched call; never re-read policy, packet sections, or completed evidence.
7. For review, return report only. For clean, apply after spec fixes under mode policy and preserve removed content.
8. Finalize every row with compact counts or an inert reason.
9. Give each candidate one direct-impact verification pass. Stop after every packet hunk, owner-lane candidate, and manifest failure has one disposition.

## Core contracts

- Standard owner lanes are architecture, API reference, configuration, deployment, security, troubleshooting, and decisions. First-level project lanes explicitly linked by `documentation/README.md` are valid.
- Public route, environment, deployment, security, and rollback changes update their owner lane in the same change.
- Every doc claim is source-verifiable. ADRs explain why, not a second current-state implementation narrative.
- Every cited REQ is a markdown backlink. Every doc/source anchor resolves.
- Paragraphs state one idea; tables, lists, code blocks, and headings remain readable. There is no whole-file line cap.

## Severity and output

Security/user-facing contract lies, orphaned anchors, missing required owner docs, or broken canonical shape are HIGH. Lane, section, budget, and authoring defects are MEDIUM unless they hide a contract. LOW is reserved for non-blocking clarity.

Return each finding with doc location, conflicting source/spec evidence, severity, and smallest fix, plus one compact count/failure line for each of the 16 evidence rows. In clean mode, every fired MEDIUM/HIGH is fixed, escalated with blast radius, or deferred to user confirmation only in interactive mode.
