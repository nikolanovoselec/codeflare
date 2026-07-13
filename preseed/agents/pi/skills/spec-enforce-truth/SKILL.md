---
name: spec-enforce-truth
description: Pi-native source and behavioral-test anchor verification for scoped SDD enforcement.
version: 3.0.0
---

# Pi Spec Truth Enforcement

Truth checks never rely on self-attestation.

## Scope

- `scope=diff`: verify changed Implemented/Partial REQs plus any unchanged REQ whose `@impl` or `@test` anchor directly targets a changed/renamed source symbol, source file, test file, or named block. Do not judge unrelated REQs.
- `scope=all`: verify every eligible REQ and anchor.

`purpose=review` reports only. `purpose=clean` may retrofit an unambiguous anchor but never silently rewrite a truth mismatch.

## Source anchors (always enabled)

Canonical form:

```text
<!-- @impl: path/to/file::symbol -->
<!-- @impl: path/to/file::symbol = literal-contract-value -->
```

For every in-scope anchor:

1. file exists;
2. symbol resolves, using `graphify_explain`/`graphify_query` first when the current graph is available and focused search otherwise;
3. optional literal contract value exists in the symbol body;
4. AC behavior overlaps the implementation rather than merely sharing a name.

Missing symbol or value drift is HIGH. Behavior mismatch is MEDIUM or HIGH when it makes `Implemented` false. Observable ACs without source anchors are MEDIUM unless manual verification is explicitly justified.

## Test anchors (when `enforce_tdd: true`)

Canonical parser:

```regex
<!--\s*@test:\s*(\S+?)\s*\((.+)\)\s*-->
```

The title capture is greedy. Therefore an AC carries **at most one** `@test` comment. Multiple test anchors on one AC are HIGH `spec-test-anchor-multiple`; split the behaviors into separate ACs or point to one encompassing named test block.

For each in-scope test anchor:

1. path exists and matches configured test globs;
2. title appears in a real `describe`/`test`/`it`/`context` block name, not a comment or fixture;
3. the block exercises the AC behavior and would fail if implementation were removed;
4. the test is not skipped, tautological, copy/prose matching, call-count-only, empty, or mock-only.

Missing or false anchors are HIGH `spec-test-anchor-orphaned`. An observable AC without a test anchor is MEDIUM `ac-missing-test-anchor`. An Implemented REQ without behavioral coverage becomes `Partial` in clean mode unless its Verification is an explicit manual check with a real runbook pointer.

When `enforce_tdd: false`, source truth remains blocking; test gaps are informational and do not change status.

## Additional truth passes

- CQ-1: a test file mentioning a REQ ID counts only when a named test block exercises AC behavior.
- CQ-2: vendor/protocol/interface claims in an Implemented REQ must still exist at the external boundary.
- CQ-3: trimming/splitting cannot lose a contractual clause; relocate it or reject the edit.
- `/sdd init` evidence uses the deterministic Phase 7a anchor and Phase 7b enumeration outputs. Missing evidence is CRITICAL.

## Output

Return manifest evidence for CQ-TEST, CQ-SOURCE, and CQ-1/2/3 with verified, orphaned, drifted, and unanchored counts. Every finding names REQ, AC, anchor, searched evidence, severity, and correction. Truth mismatches are escalated, never guessed away.
