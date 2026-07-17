---
name: doc-enforce-truth
description: Pi-native documentation source, REQ, code-block, and cold-read truth enforcement.
version: 3.0.0
---

# Pi Documentation Truth Enforcement

Operate on the direct-impact set from `doc-enforce`; `scope=all` supplies the full corpus. Consume the parent packet without reconstructing the diff or printing whole files. Pass 15 always runs whenever an in-scope doc or changed source can affect an anchor.

## Pass 8: verification truth

For every in-scope claim of implemented behavior, resolve the linked REQ, implementation, and behavioral test/manual runbook. A doc cannot claim a stronger state than its REQ or source.

## Pass 9: Implements versus AC

Cross-walk each in-scope `Implements REQ-X-NNN` claim to the cited ACs. The doc must explain the operational contract it owns without inventing behavior or omitting a changed public boundary.

## Pass 10: stale code blocks

Check changed or directly invalidated commands, paths, variables, payloads, and code snippets against source. Examples must be safe to copy, or clearly labeled pseudocode.

## Pass 11: trim preservation

Before shortening/moving content in clean mode, identify every removed contractual or operational clause. Preserve it in the correct owner lane, REQ, or ADR. Reject a trim that loses load-bearing content.

## Pass 12: stranger cold-read

For each in-scope operator task, verify a reader can identify prerequisites, action, expected result, failure signal, and rollback/next step without private project knowledge. Under `scope=diff`, test only tasks changed or invalidated by the diff. Under `scope=all`, run every configured task.

## Pass 15: source anchors

Canonical forms:

```text
<!-- @impl: path/to/file::symbol -->
<!-- @impl: path/to/file::symbol = literal-contract-value -->
```

For every in-scope anchor verify file, symbol, optional literal, and behavior overlap. Use Pi-native Graphify for focused symbol resolution when current, then direct read/search. Missing symbol/value is HIGH. Observable source-backed claims without an anchor are MEDIUM when the lane convention requires one.

Accepted ADR Context sections carry a truthful source anchor when the decision describes current implementation. Superseded ADR history is not rewritten to current mechanics; its status and superseding link make history clear.

## Authoring truth

Flag weasel words, unverifiable superlatives, unsupported performance/security claims, and current-tense descriptions of retired systems. Every rationale says why the decision matters; every operational claim says how to verify it.

## Output

Return compact counts and failures for Passes 8-12 and 15: docs inspected, anchors verified, drift, orphaned, unanchored, tasks cold-read, and findings. Each finding cites doc location and contradicting source/REQ evidence. Give each candidate one direct verification pass. Review purpose reports only; clean purpose may fix unambiguous drift but escalates uncertain truth.
