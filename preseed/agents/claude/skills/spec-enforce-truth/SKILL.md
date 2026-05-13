---
name: spec-enforce-truth
description: SDD spec content-quality / source-of-truth checks. Runs CQ-1 (REQ-test truth-check), CQ-2 (vendor / external-interface drift), CQ-3 (content-preservation on shrink), plus test coverage and enforce_tdd interaction. Invoked conditionally by spec-enforce when Implemented REQs are touched OR scope=all.
version: 1.0.0
---

# Spec Enforcement — content quality and source-of-truth

This skill checks that the spec says what it claims by cross-referencing tests and source. Invoked by `spec-enforce` (the spine) when an Implemented REQ is in the diff or when scope=all.

## Inputs

- `diff`: git diff against base
- `scope`: `all` | `diff`
- `mode`: `interactive` | `auto` | `unleashed`
- `enforce_tdd`: bool from `sdd/config.yml`
- `test_globs`: from `sdd/config.yml` (defaults cover vitest/jest, pytest, go test, rspec, cypress, playwright)
- `src_globs`: from `sdd/config.yml` (defaults `src/** lib/** app/** pkg/** cmd/** internal/**` minus test/build dirs)

## Output

Returns findings array + auto-fix actions. Writes evidence-count rows back to the spine's manifest:
- `Test coverage and enforce_tdd`: `ran (N REQs, M findings)` or `inert (enforce_tdd: false)`
- `CQ-1 — REQ-test truth-check`: `ran (N REQs, K files, A auto-fixed, B escalated)`
- `CQ-2 — Vendor / external-interface drift`: `ran (N REQs, T tokens, M findings)`
- `CQ-3 — Content-preservation on shrink`: `ran (K shrink ops, M findings)` or `inert (no shrink ops)`

## CQ-1 — REQ-test truth-check

**Skip clause:** Does not fire on REQs whose `Verification:` field is `Manual check`. The REQ should carry a `Notes:` doc-pointer to where the manual checklist or runbook lives.

For every other `Implemented` REQ, walk every test file (per `test_globs`) containing the REQ ID literally. REQ-ID mention must satisfy both:

1. It appears in the name of a `describe`/`test`/`it` block; not just a code comment, not just a fixture filename.
2. At least one assertion references content that the REQ's ACs describe; by symbol, user-observable string, or named behaviour.

When neither holds, the finding splits:

**Subclass A — name-only-match (MEDIUM `req-test-name-only-match-fixable`).** Test file contains the REQ ID literally and has real assertions on AC content but no block name carries the REQ ID. Auto-fix in `auto`/`unleashed`: rename the most-relevant existing describe by appending ` / REQ-X-NNN (one-line concern)` to its title. Pick the describe whose nested `it()` blocks have strongest AC-content overlap; first-in-document-order wins on ties. No test logic changes.

**Subclass B — no-coverage (MEDIUM `req-test-name-only-match`).** No test file mentions the REQ ID at all, OR mentions are only in comments / fixture paths, OR every named block asserts unrelated behaviour. Real coverage absence. No auto-fix; escalate to `.review-needed.md`.

Classification mechanics:
1. For each Implemented REQ (excluding Manual check): grep `test_globs` for the REQ ID.
2. Zero matches: Subclass B.
3. Matches exist; walk matched files: any block name contains the REQ ID? Yes: CQ-1 passes. No: block has assertions on AC-content tokens? Yes: Subclass A. No: Subclass B.

## CQ-2 — Vendor / external-interface drift

For every allowlisted vendor/protocol token in an `Implemented` REQ's ACs, find at least one mention in source (case-insensitive, allowing variants; `cf_access` counts for `Cloudflare Access`). No source mention: MEDIUM `vendor-reference-orphaned-in-spec`.

This catches "AC mentions Stripe Checkout but the codebase removed Stripe six months ago." No auto-fix.

## CQ-3 — Content-preservation on shrink

The shrink-in-place rule and run-on AC split rule both delete content. Before committing either edit, tokenise removed clauses; for each, check whether its specific subject appears in candidate kept locations (kept REQ body, surrounding ACs, REQ Intent, target doc file).

Three outcomes:
- All removed clauses match elsewhere: commit.
- Context-loss with relocation target: promote with `Trimmed from REQ-X-NNN on YYYY-MM-DD:` marker, then commit.
- Context-loss with no target: REVERT, emit MEDIUM `shrink-would-lose-load-bearing-content`. Cap violation persists; content preserved.

## Test coverage and enforce_tdd

Every `Implemented` REQ must have at least one test file referencing its REQ ID. Both rules enforced when `enforce_tdd: true` (default).

**Test discovery** uses `test_globs` from `sdd/config.yml`. Defaults cover vitest/jest, pytest, go test, rspec, cypress, playwright.

**Source discovery** uses `src_globs` defaulting to `src/** lib/** app/** pkg/** cmd/** internal/**` minus test/build dirs.

**Detection is binary**: REQ ID literally in source/test file, or not. Plain substring; no parsing.

When `enforce_tdd: true`:

1. **Auto-demote**: `Implemented` REQ with no test reference: `Partial` with Notes. Changelog entry. Skip clause: `Verification: Manual check` REQs are exempt; verify Notes carries a doc-pointer to manual checklist; if missing: LOW `manual-check-missing-pointer`.
2. **Source-vs-test coverage**: `Planned`/`Partial` REQ with source but no test: HIGH; auto-promote `Planned` to `Partial` with explanatory Notes.
3. **Test quality heuristics**: AC count vs test count, tautology / empty-body / skip patterns. Quality findings produce no changelog entry.

When `enforce_tdd: false`, write `sdd/.coverage-report.md` without modifying spec.

## Auto-demote suppression during SDD transition

When `transition: true` in `sdd/config.yml` (see `spec-enforce` spine SDD transition section), the auto-demote rule above is SUPPRESSED. CQ-1 still runs but writes findings to `sdd/.coverage-report.md` rather than mutating Status. The imported spec is intentionally partial; that's what the triage queue means.

## Severity application

CRITICAL: never emitted by this skill.
HIGH: source-vs-test coverage gap on Implemented REQ when not in transition.
MEDIUM: CQ-1 Subclass A/B, CQ-2 vendor drift, CQ-3 content-loss revert.
LOW: `manual-check-missing-pointer`.

Mode-dependent action:
- `interactive`: confirm before applying any fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM, defer LOW
- `unleashed`: auto-fix everything including LOW
