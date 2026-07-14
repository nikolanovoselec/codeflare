---
name: spec-enforce-ac
description: Pi-native acceptance-criteria quality and split enforcement with scope-aware execution.
version: 3.0.0
---

# Pi AC Enforcement

Invoked by `spec-enforce` with its already-resolved in-scope REQ set.

## Scope

- `scope=diff`: inspect only changed AC/Constraint hunks and the complete parent REQ needed to judge coherence, cap, and numbering. Follow references only when a proposed split/renumber would invalidate them.
- `scope=all`: inspect every AC and Constraint.

Consume the parent packet's in-scope REQ set without reconstructing the diff. Return compact counts and failures for manifest rows 5-11. In review purpose, report only. In clean purpose, apply only mechanical edits allowed by mode.

## AC contract

Each AC is one binary observable behavior for the declared actor.

Fire MEDIUM `ac-multi-behaviour` when any of these holds:

- distinct subjects or code paths can produce two test names;
- three contractual sentences;
- multiple independent verb/object pairs joined by `and`, `then`, `before`, or `regardless`;
- transform plus a separate downstream effect;
- a semicolon appends another rule;
- sub-bullets carry independent behavior.

Rationale introduced by `because` or `so that` may remain only when it shares the subject and adds no contract. Prose over 45 words is MEDIUM `ac-verbose`; move rationale to Intent, changelog, or an ADR. More than 150 words or three semicolons is `ac-run-on`.

Constraints are terse boundaries. A bullet over 45 words, two sentences, or a why-narrative is MEDIUM `constraint-bloat`; a bullet over 80 words or section over 150 words is HIGH `constraint-section-bloat`.

## Coherence and caps

- 3-5 ACs is typical; 6-7 is allowed.
- 8-10 ACs is MEDIUM `ac-count-over-cap`; merge only truly identical behavior, otherwise split by sub-feature.
- More than 10 is HIGH `ac-count-binding-cap-exceeded` and must split.
- A different actor is MEDIUM for one AC and HIGH for two or more; split by actor.
- Cross-cutting policy (auth, CSRF, rate limiting, audit, cache, retry) belongs in a policy REQ, with feature REQs linking it.
- Two operationally distinct clusters with at least two ACs each require a concern split even below the numeric cap.
- ACs state outcomes, not internal symbols, header names, middleware names, crypto algorithms, or implementation sequences.

## Safe split procedure

Before merge, renumber, or split, search `sdd/`, `documentation/`, ADRs, inline anchors, and named tests for `REQ-X-NNN ACn` references. Preserve every clause and anchor. The dominant coherent cluster keeps the original ID; sibling REQs receive the next free IDs and no more than seven ACs. Record an old-to-new AC map and update every direct cross-reference in the same clean operation.

If an AC must be rewritten semantically, the boundary is judgment: report/escalate rather than auto-fix. A mechanical split never renames tests merely to make anchors appear valid.

## Output

Return one entry per finding with REQ, AC, trigger, severity, cross-reference blast radius, and proposed smallest action. Inspect each parent REQ once and stop after every changed AC has a disposition. Evidence rows:

- AC granularity + accretion
- AC verbosity + Constraints
- actor coherence
- sub-bullets
- cross-cutting split
- concern-boundary split
- mechanism leakage
