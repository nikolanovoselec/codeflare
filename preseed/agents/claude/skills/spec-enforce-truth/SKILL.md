---
name: spec-enforce-truth
description: SDD spec content-quality / source-of-truth checks — the canonical cross-agent contract. Runs CQ-1 (REQ-test truth-check), CQ-2 (vendor / external-interface drift), CQ-3 (content-preservation on shrink), CQ-TEST (test-anchor coverage — REQ-level coverage AND per-AC @test anchor verification at parity with @impl, gated by enforce_tdd), and CQ-SOURCE (source-anchor @impl truth-check, ALWAYS runs). Per-AC manual verification uses inline <!-- @manual --> markers. Invoked conditionally by spec-enforce when Implemented or Partial REQs are touched OR scope=all.
version: 4.1.0
---

# Spec Enforcement — content quality and source-of-truth

This skill checks that the spec says what it claims by cross-referencing tests and source. Invoked by `spec-enforce` (the spine) when an Implemented or Partial REQ is in the diff or when scope=all. Truth checks never rely on self-attestation.

## Inputs

- `purpose`: `review` | `clean` (inherited from parent). `review` reports only. `clean` may retrofit an unambiguous anchor but never silently rewrites a truth mismatch.
- `diff`: git diff against base
- `scope`: `all` | `diff`
- `mode`: `interactive` | `auto` | `unleashed`
- `enforce_tdd`: bool from `sdd/config.yml`
- `test_globs`: from `sdd/config.yml` (defaults cover vitest/jest, pytest, go test, rspec, cypress, playwright)
- `src_globs`: from `sdd/config.yml` (defaults `src/** lib/** app/** pkg/** cmd/** internal/**` minus test/build dirs)

**Scope contract.** Consume the parent packet and in-scope anchor list; do not rescan or print whole source/test files. Under `scope=diff`, verify changed Implemented/Partial REQs plus any unchanged REQ whose `@impl` or `@test` anchor directly targets a changed/renamed source symbol, source file, test file, or named block — do not judge unrelated REQs. Under `scope=all`, verify every eligible REQ and anchor.

## Output

Returns findings array + auto-fix actions. Every finding names REQ, AC, anchor, searched evidence, severity, and smallest correction. Give each anchor one direct verification pass; truth mismatches are escalated, never guessed away. Writes evidence-count rows back to the spine's manifest:
- `CQ-TEST — Test-anchor coverage`: `ran (N REQs, M findings)` or `inert (enforce_tdd: false)`
- `CQ-SOURCE — Source-anchor truth-check`: `ran (N REQs, A anchors verified, V drift, O orphaned, U unanchored)` — ALWAYS runs, never inert
- `CQ-1 — REQ-test truth-check`: `ran (N REQs, K files, A auto-fixed, B escalated)`
- `CQ-2 — Vendor / external-interface drift`: `ran (N REQs, T tokens, M findings)`
- `CQ-3 — Content-preservation on shrink`: `ran (K shrink ops, M findings)` or `inert (no shrink ops)`

**Layout-awareness.** Spec file discovery uses `sdd/spec/**/*.md` when the nested layout exists (`test -d sdd/spec`); falls back to `sdd/*.md` (excluding `README.md`) on flat layout.

## Per-AC manual-verification markers (`@manual`)

An AC legitimately verified manually carries an inline marker at the end of the bullet, in the same comment-grammar family as the anchors:

```
<!--\s*@manual(?::\s*(.+?))?\s*-->
```

Capture group: optional `<procedure>` — dedicated manual-verification guidance for that AC. A bare `<!-- @manual -->` declares the manual method, not completed execution; its Verification field names the concrete procedure. Do not pad the marker with filler prose. The complete set of manual REQ+AC combinations in a project is exactly `grep -rn '@manual' sdd/`.

Legitimate manual verification is sufficient for implemented behaviour; all-manual and mixed REQs may be `Implemented`. Do not demote a REQ merely for manual coverage or missing automation on manual ACs. Missing/broken guidance is a verification finding, not proof of missing implementation; never invent passing evidence.

Marker semantics (per-AC — there is NO REQ-level exemption):

- An AC carrying `@manual` is exempt from the `@impl` and `@test` anchor **requirements** (`ac-missing-source-anchor`, `ac-missing-test-anchor` do not fire on it).
- Anchors PRESENT on a `@manual` AC are still validated as supplemental evidence — a broken anchor is still `spec-anchor-orphaned`/`spec-test-anchor-orphaned`. `@manual` lifts the requirement, never the truth of what is written.
- **Verification-field coherence:** enforce `spec-enforce` § REQ rendering template's strict linked-method grammar, not arbitrary prose or merely a category word. Non-manual ACs require Automated (or the linked Code-only method when `enforce_tdd: false`); manual ACs require Manual; mixed REQs list their non-manual method first, then Manual. All-manual REQs use Manual even when supplemental test anchors exist. Resolve every automated target to real eligible covering tests and every manual target to a named procedure with concrete actions/pass-fail outcomes. Method/marker disagreement is MEDIUM `verification-field-marker-drift`; malformed fields are MEDIUM `verification-field-format`; missing/non-covering targets are HIGH `verification-target-invalid`. Auto-fix only from independently established methods/targets, preserving every genuine acceptance obligation in its owner; never fabricate links, turn gaps into manual exemptions or promote Status from field formatting. Dependencies use only exact prerequisite REQ/CON links or `None.` under the same canonical field contract.
- Replace a manual method only when equivalent automated behavioural coverage is independently established; automation is not required to retain `Implemented`. Adding `@manual` merely to dodge a failing anchor check is a truth violation — `finding-downgraded-to-skip` HIGH.

## CQ-1 — REQ-test truth-check

Walks every `Implemented` REQ that has at least one AC without `@manual`. REQs where every AC carries `@manual` are exempt (there is no automated behaviour to cross-check). CQ-1 is satisfied by EITHER:

- **(a) verified REQ reference**: an eligible test file contains the literal REQ ID in a block name or an immediately preceding traceability comment, AND the identified block actually exercises the relevant production behavior and asserts its observable outcome. The ID, filename, vocabulary or assertion count alone proves nothing; OR
- **(b) anchor parity**: every non-`@manual` AC carries AT LEAST ONE resolving `@test` anchor, and every declared anchor resolves (per CQ-TEST's per-anchor validation). Anchor-level proof is finer-grained than the ID grep and satisfies the same truth claim.

When neither holds, the finding splits:

**Subclass A — traceability repair (MEDIUM `req-test-name-only-match-fixable`).** Existing actual behavior coverage is established but its REQ association is absent or ambiguous. In clean mode, add a precise REQ-ID comment and/or correct spec-side anchors to the existing blocks. Preserve test filenames, titles and logic; never rename a block just to satisfy discovery.

**Subclass B — unestablished coverage (MEDIUM `req-test-name-only-match`).** No independently verified covering block or complete anchor parity exists. Record the searched owner/tests and missing outcome; escalate without inventing tests, a manual exemption or a coverage claim. Missing traceability alone is not evidence of missing behavior.

Classification mechanics:
1. Validate every declared anchor's eligibility, resolution and behavioral quality. Complete non-manual parity satisfies CQ-1 only after those checks, not merely title matching.
2. Otherwise inspect blocks identified by REQ references and the existing source-to-test bridge; real outcomes decide coverage, never ID/token presence alone.
3. Repair traceability only for independently established coverage; otherwise report the exact unresolved scope. In review mode return proposals only.

## CQ-2 — Vendor / external-interface drift

For every allowlisted vendor/protocol token in an `Implemented` REQ's ACs, find at least one mention in source (case-insensitive, allowing variants; `cf_access` counts for `Cloudflare Access`). No source mention: MEDIUM `vendor-reference-orphaned-in-spec`.

This catches "AC mentions Stripe Checkout but the codebase removed Stripe six months ago." No auto-fix.

## CQ-3 — Content-preservation on shrink

The shrink-in-place rule and run-on AC split rule both delete content. Before committing either edit, tokenise removed clauses; for each, check whether its specific subject appears in candidate kept locations (kept REQ body, surrounding ACs, REQ Intent, target doc file).

Three outcomes:
- Every clause retains its full predicate elsewhere: permit the edit.
- Relocation is necessary: place the complete clause naturally in its normative owner or appropriate documentation; record old-to-new mapping in the commit body, not a dated trim marker.
- No safe destination or equivalence is established: withdraw only the proposed shrink and emit MEDIUM `shrink-would-lose-load-bearing-content`. Preserve content and the cap finding.

Token/subject matches locate evidence; they cannot establish preservation. Compare actor, scope, conditions, quantifiers, exclusions, permissions, identity, ordering, bounds/defaults, retention, failure and recovery behavior. Never trade a guarantee or user choice for shorter text or implementation agreement. A contract change requires applicable explicit authority, not cleanup mode.

## CQ-TEST — Test-anchor coverage (gated by `enforce_tdd`)

An `Implemented` REQ with non-manual ACs must have the required automated coverage; all-manual REQs use legitimate manual verification without a test-file requirement. **This pass is gated by `enforce_tdd: true`** (default). When `enforce_tdd: false`, the pass writes informational entries to `sdd/spec/.review-queue.md` (nested) or `sdd/.review-needed.md` (flat-legacy) under a `## Coverage gaps` section but never mutates Status.

**Test discovery** uses `test_globs` from `sdd/spec/config.yml` (or `sdd/config.yml` flat). Defaults cover vitest/jest, pytest, go test, rspec, cypress, playwright.

REQ-ID lookup is binary discovery, not a coverage verdict. CQ-1's actual block/outcome checks and the per-AC quality gate establish coverage; comments may provide traceability but never substitute for behavior.

When `enforce_tdd: true`:

1. **Auto-demote**: `Implemented` REQ with no test reference: `Partial` with Notes. Changelog entry. Exemptions: REQs where every AC carries `@manual` (nothing automated to verify), and REQs satisfying CQ-1's anchor-parity path (resolving per-AC `@test` anchors are stronger evidence than the ID grep).
2. **Source-vs-test coverage**: `Planned`/`Partial` REQ with source but no required automated coverage for its non-manual ACs: HIGH; auto-promote `Planned` to `Partial` with explanatory Notes.
3. **Test quality heuristics**: AC count vs test count, tautology / empty-body / skip patterns. Quality findings produce no changelog entry.

When `enforce_tdd: false`:

1. **Status assignment for newly-drafted REQs (Import Mode + `/sdd edit` / `/sdd add` while `enforce_tdd: false`)**: default `Implemented` when source code implements the AC AND the AC's `<!-- @impl: ... -->` anchor resolves via CQ-SOURCE. The project has opted out of test-based verification; demoting every REQ to `Partial` because tests don't reference REQ IDs would falsely brand the spec 65%+ incomplete. Each `sdd/spec/{domain}.md` file (per domain, not the top-level `sdd/README.md`) receives one footnote `_Verification: code-only (no automated coverage)._` at the bottom; per-REQ `Notes:` are NOT used for this signal.
2. **No auto-demote on existing REQs**: do not move `Implemented` → `Partial` based on test absence alone. Test-coverage findings still emit, but as informational entries in `sdd/spec/.review-queue.md` under `## Coverage gaps`, never as Status mutations.
3. **CQ-1, CQ-2, CQ-3, CQ-SOURCE still run normally** (see below); CQ-SOURCE specifically is NEVER gated by `enforce_tdd`.

### Per-AC test-anchor coverage (anchor-level — the test parallel of CQ-SOURCE)

Beyond the binary REQ-level check above, when `enforce_tdd: true` CQ-TEST verifies each AC's inline `@test` anchor, giving AC-by-AC coverage parity with `@impl`. When `enforce_tdd: false` every finding here is informational only — written to the `## Coverage gaps` section of the layout-resolved triage file, never a Status mutation, never blocking.

**Anchor parsing.** For every `Implemented` or `Partial` REQ, scan each AC bullet for every inline test-anchor comment using `references/parse-test-anchors.mjs` (or its exact global matcher):

```
<!--\s*@test:\s*(\S+?)\s*\((.*?)\)\s*-->
```

Capture groups: `<path>`, `<block-title>`. Apply the pattern globally. The comment-bounded non-greedy title preserves nested parentheses while parsing adjacent anchors independently. Every non-`@manual` AC carries **at least one** `@test` anchor; multiple anchors are valid when verification spans blocks or files.

**Per-anchor validation.** For each captured `@test` anchor (including anchors on `@manual` ACs — supplemental evidence is still validated):

1. **Resolve the file.** `<path>` must match a `test_globs` entry AND exist on disk. Not found → HIGH `spec-test-anchor-orphaned` listing REQ-ID, AC-N, the searched `<path>`. No auto-fix; escalate to the triage file.
2. **Resolve the block.** Grep `<path>` for `<block-title>` as a substring of a `describe`/`test`/`it`/`context` block-name line (not a code comment, not a fixture path). Not found → HIGH `spec-test-anchor-orphaned` listing REQ-ID, AC-N, `<path> (<block-title>)`. No auto-fix; escalate. (Mirrors CQ-1's "REQ-ID must be in a block name, not a comment" rule.)
3. **Quality gate.** Read the actual relevant assertions and production boundary once, reusing that evidence for other references. The block must exercise the AC behavior and fail if it breaks; skipped, tautological, copy/prose-matching, call-count-only, empty or mock-only blocks do not count. Controlled collaborators are valid when the real owning path produces asserted observable outcomes; their presence alone is not a reason to demand hosted infrastructure. Report partial scope honestly.

**Unanchored AC detection.** For every AC bullet describing observable behaviour without a `@test` anchor:

- Skip clause: ACs carrying `<!-- @manual -->` are exempt.
- MEDIUM `ac-missing-test-anchor` (the test parallel of `ac-missing-source-anchor`) listing REQ-ID, AC-N. Auto-fix in `auto`/`unleashed`: best-effort retrofit — for the AC's resolved `@impl` symbols, find `test_globs` blocks whose bodies exercise those symbols (import + call) or whose names overlap the AC ≥3 tokens. If one or more independently verified blocks resolve, write one deduplicated `@test` anchor per block in stable path/title order; ambiguous candidates escalate. (Same retrofit shape as CQ-SOURCE's unanchored-AC auto-fix, and the same engine `/sdd clean` pass 5 uses.)

**This pass is the only place `@test` parity is enforced**: the always-on `@impl` truth-check is CQ-SOURCE; the per-AC `@test` check lives here under `enforce_tdd` because tests are opt-out-able while source truth is not.

**Anchor-level output** folds into the CQ-TEST manifest row: `ran (N REQs, M REQ-level findings, T test-anchors verified, O orphaned, U unanchored)`.

## CQ-SOURCE — Source-anchor truth-check (ALWAYS runs, never gated)

CQ-SOURCE is the framework's Truth guarantee. It verifies every spec claim against its source anchor. **This pass runs unconditionally**: both `enforce_tdd: true` and `enforce_tdd: false`; both Greenfield, Import Mode, and Resume Mode; both inside and outside SDD transition; both via `/sdd clean` and on every PR-boundary trigger. Fabrication is never permitted.

### Anchor parsing

For every `Implemented` or `Partial` REQ in `sdd/spec/**/*.md` (or `sdd/*.md` flat), scan every AC bullet for the inline source-anchor comment:

```
<!--\s*@impl:\s*([^:]+)::([^\s=]+)(?:\s*=\s*(.+?))?\s*-->
```

Capture groups: `<path>`, `<symbol>`, optional `<value-pattern>`.

Same regex applies to ADR `Context:` blocks in `documentation/decisions/README.md` (one anchor per ADR Context, immediately at end of the Context paragraph).

### Per-anchor validation — Phase 7a is the canonical implementation

During `/sdd init`, anchor validation is performed by the Phase 7a verifier (`~/.claude/skills/sdd-init/references/verify-source-anchors.py`), and this skill's row 17 (CQ-SOURCE) consumes the resulting JSON (`.verify-anchors.json`) rather than re-deriving — see `sdd-init/SKILL.md` step 7. The agent never claims "I checked the anchors" without the verifier output line in the commit body; that self-attestation is **CRITICAL `phase-7a-self-attestation`**.

Outside `/sdd init` (steady-state PR-boundary review on an existing project), this skill performs the same checks inline using the same algorithm. Anchors on `@manual` ACs are included — supplemental evidence is still validated.

For each captured anchor:

1. **Resolve symbol.** Call `mcp__graphify__get_node(<symbol>)` against the unified graph when a current graph is available. If graphify cannot resolve (graph absent, stale, or symbol not indexed), fall back to one focused `Grep` against `<path>`. Symbol not resolved by either path → HIGH `spec-anchor-orphaned` listing REQ-ID, AC-N, the searched `<path>::<symbol>`. No auto-fix; escalate to `sdd/spec/.review-queue.md`.
2. **Verify value (when `<value-pattern>` present).** Read the symbol's source body (graphify `source_location` or direct file read on the path slice). Grep for the literal `<value-pattern>`. Not found → HIGH `spec-value-drift` listing REQ-ID, AC-N, expected vs anything-found-in-symbol. No auto-fix; escalate.
3. **Verify behaviour overlap (when `<value-pattern>` absent).** Compute token overlap between the AC text (content words ≥4 chars, stopwords excluded) and the symbol body. Overlap <3 tokens → MEDIUM `spec-behavior-orphaned`. Auto-fix in `auto`/`unleashed`: attempt to find a sibling symbol with stronger overlap via `mcp__graphify__get_neighbors`; on success, rewrite the anchor; otherwise escalate.
4. **Verify the claim, not the vocabulary.** Overlap answers "is this the right symbol". It never answers "is the criterion true", and passing it discharges nothing. Read the resolved body and ask what the AC actually asserts: does anything there CONTRADICT it — a bound, a cap, an early return, a swallowed error, a default, a branch the claim does not admit? A contradiction on an `Implemented` REQ is HIGH `spec-claim-contradicted`, listing REQ-ID, AC-N, the asserted claim and the line that defeats it. No auto-fix — the correction is a behaviour change or a restatement, and which one is a judgment: escalate to `sdd/spec/.review-queue.md`.

   An AC asserting "every X" against a body that caps X is the canonical instance, and it is invisible to step 3 by construction: the vocabulary overlaps *perfectly* — the cap is named in the same words as the claim it breaks — so the token check returns its strongest possible pass on the clearest possible falsehood. That case shipped: an AC reading "every unresolved reference is listed rather than a capped sample" sat `Implemented` above a `MAX_UNRESOLVED` slice, through four rounds of review, because both texts say "unresolved" and nothing was reading for meaning. The runtime that caught it had no rule to cite and named the finding itself.

The Phase 7a verifier is the deterministic checker. Steady-state review uses graphify+grep because (a) the graph is the right hammer for symbol-vs-source questions on a mature codebase, (b) the diff scope keeps it cheap. Both paths produce findings of the same shape and follow the same escalation rule (NEVER silently rewrite; route to `.review-queue.md` with concrete Context + Recommendation).

### Unanchored AC detection

For every AC bullet without `<!-- @impl: ... -->`:

- Skip clause: ACs carrying `<!-- @manual -->` are exempt — their behaviour cannot be source-anchored by construction, and the marker (not a REQ-level field) is the sanctioned record of that.
- For other ACs: MEDIUM `ac-missing-source-anchor` listing REQ-ID, AC-N. Auto-fix in `auto`/`unleashed`: best-effort retrofit — extract symbol candidate by AC verb-phrase + Phase 5a community map; if a plausible symbol resolves AND overlap ≥3 tokens, write the anchor inline via Edit. Otherwise escalate to `sdd/spec/.review-queue.md` with the missing-anchor recommendation.

### ADR Context anchors

ADR `Context:` blocks (in `documentation/decisions/README.md`) use the same convention. Validation identical: symbol must resolve, optional value-pattern must match. Anchor missing on an ADR with status `Accepted` → MEDIUM `adr-context-missing-source-anchor` (auto-fix similar to AC retrofit).

### `/sdd init` evidence (Phase 7a / 7b)

`/sdd init` evidence uses the deterministic Phase 7a anchor and Phase 7b enumeration verifier outputs. Missing evidence is CRITICAL (`phase-7a-evidence-missing` / `phase-7b-evidence-missing`); self-attestation without verifier output is CRITICAL (`phase-7a-self-attestation` / `phase-7b-self-attestation`).

### CQ-SOURCE during SDD transition

Unlike CQ-TEST, CQ-SOURCE runs during `transition: true`. The Truth guarantee is the entire point of the source-evidence pass in Phase 5d; suppressing CQ-SOURCE during transition would allow fabricated Import-Mode REQs to ship unchecked. Findings during transition go to `sdd/spec/.init-triage.md` (not `.review-queue.md`) so they fold into the Resume Mode queue.

### CQ-SOURCE output

Manifest row evidence count: `ran (N REQs, A anchors verified, V drift findings, C contradicted, O orphaned, U unanchored)`. Never `inert`. Layout-aware (nested or flat). `A anchors verified` counts anchors that RESOLVED; it is not a truth count, and reporting it as though it were is how a contradicted claim passes as a clean pass.

## Auto-demote suppression during SDD transition

When `transition: true` in `sdd/spec/config.yml`, spec-reviewer exits no-op entirely (Phase 0b.5 in the spec-reviewer agent definition); this skill is therefore never invoked on PR-boundary triggers during transition. The suppression rule documented here describes the correct behaviour for the rare path that DOES reach this skill while transition is active — e.g. a manual `/sdd clean` invocation against the transition branch.

In that path: **CQ-TEST auto-demote is SUPPRESSED**, identical to `enforce_tdd: false` semantics. Findings write to `sdd/spec/.review-queue.md` rather than mutating Status. Imported REQs default `Implemented` when source code implements the AC AND CQ-SOURCE confirms the anchor. **CQ-SOURCE itself is NOT suppressed** — it runs during transition exactly as outside transition. Genuinely unmet behaviour goes to `sdd/spec/.init-triage.md`, not to a Partial Status that's actually false.

## Severity application

CRITICAL: `phase-7a-self-attestation`, `phase-7b-self-attestation`, `phase-7a-evidence-missing`, `phase-7b-evidence-missing` (fabricated or missing `/sdd init` verification evidence).

HIGH:
- CQ-TEST `source-vs-test coverage gap` on Implemented REQ when not in transition (only when `enforce_tdd: true`).
- CQ-TEST `spec-test-anchor-orphaned` (file or block not resolved).
- CQ-SOURCE `spec-anchor-orphaned` (symbol not resolved).
- CQ-SOURCE `spec-value-drift` (value-pattern not found in symbol body).
- CQ-SOURCE `spec-claim-contradicted` (the resolved body contradicts what the AC asserts, on an `Implemented` REQ).

MEDIUM:
- CQ-1 Subclass A/B.
- CQ-2 vendor drift.
- CQ-3 content-loss revert.
- CQ-SOURCE `spec-behavior-orphaned` (token overlap <3).
- `ac-missing-source-anchor` / `ac-missing-test-anchor` (AC without anchor and without `@manual`).
- `adr-context-missing-source-anchor`.
- `verification-field-marker-drift` (Verification field disagrees with the per-AC `@manual` markers).

LOW: none emitted by this skill.

Mode-dependent action:
- `interactive`: confirm before applying any fix
- `auto`: auto-fix CRITICAL + HIGH + MEDIUM where mechanical (CQ-SOURCE/CQ-TEST HIGH is NOT auto-fixable — an orphaned anchor or value drift requires JUDGMENT; escalate)
- `unleashed`: auto-fix everything including LOW; Truth HIGHs still escalate to triage (Truth findings never silently rewrite)
