---
name: sdd-init
description: "Workflow for /sdd init bootstrap. Covers greenfield (lean two-confirm flow), Import Mode (two-output: REQs + triage), Resume Mode (drain triage queue), Phase 4 behavioral enumeration (deterministic source-surface walk that drives Phase 5d), Phase 5 enrichment pass (graphify-backed cross-link / ADR-seed / glossary-seed), Phase 7a source-anchor verification, Phase 7b enumeration-coverage verification, and dependency version resolution. Invoked when /sdd init runs. Requires the spec-driven-development skill for REQ format, Status semantics, and templates."
version: 1.1.0
---

# /sdd init — bootstrapping a project

Three scenarios, auto-detected:

1. **Greenfield**: empty project, no existing code. Bootstrap from prose.
2. **Import**: project already has source, no `sdd/` yet. Enter **Import Mode** — derive a spec where behavior is clear from source/tests/comments/commits, file the unclear parts to `sdd/.init-triage.md` with concrete Context + Recommendation, write the scaffolding.
3. **Resume**: `sdd/` exists and `sdd/.init-triage.md` has `**Status:** open` items. Enter **Resume Mode** — surface one triage item at a time with refreshed Context.

Detect via source-file count (greenfield-vs-import) and presence of open triage items (resume).

## Greenfield — lean two-confirm flow

Compresses the old 10-15-turn back-and-forth into two decisions.

1. **Ask for vision** (one free-form question if `$ARGUMENTS` is empty). Confirm what you heard in one sentence. **Then ask for spec flavour** with one question:

   ```
   What kind of spec is this?

   1. Technical — REQs may name protocols (OAuth, JWT), vendors (Cloudflare,
      Stripe), HTTP status codes, performance targets, and user-facing strings.
      Default for engineering teams shipping software.

   2. Business / behavioural — REQs describe observable behaviour only. No
      protocols, no vendor names, no status codes inside REQs; technical
      detail lives in documentation/. Pick this when stakeholders read REQs.

   3. Custom — set each of the five forbidden-content allowlist flags
      individually.
   ```

   The choice writes `forbidden_content_allowlist:` in `sdd/spec/config.yml` at step 5:

   | Flag | Technical | Business | Custom |
   |---|---|---|---|
   | `protocols` | true | false | prompt |
   | `vendors` | true | false | prompt |
   | `http_codes_in_api_reqs` | true | false | prompt |
   | `performance_numbers` | true | false | prompt |
   | `user_facing_strings` | true | true | prompt |

   `user_facing_strings` stays `true` on Business by default — quoted UI strings ARE the AC's assertion target, banning them leaves no concrete trigger to assert against. Custom can override.

   This choice is binding: Business-flavour specs that later contain protocol/vendor/status-code references generate HIGH `forbidden-content-in-req` findings during enforcement, and the agent moves the content to `documentation/` rather than allowing it through.

2. **Draft the entire spec in memory** without further questions. In Import Mode, drafting MUST iterate over the Phase 4 behavioral-enumeration table (see § "Behavioral enumeration (Phase 4)" below): every enumerated item MUST resolve to exactly one of (a) a drafted AC carrying an `@impl` anchor, (b) a triage entry in `.init-triage.md` with Context + Recommendation, or (c) an explicit one-line entry in the domain README's "Out of Scope" section. In greenfield this constraint is trivially satisfied because the drafted REQs ARE the enumeration; see Phase 4 for the greenfield carve-out. Items silently dropped from the draft on Import Mode are detected by the Phase 7b verifier (step 8) and block commit. Derive:
   - Actors (typically 2-3; User, Admin defaults; never "System")
   - Design principles (3-7 specific to this product, not generic)
   - Domains (5-12 with one-line summary + priority)
   - REQs per domain (5-15 each; canonical format from `spec-driven-development` skill; every field populated; `Constraints: None.` / `Dependencies: None.` explicit when empty)
   - CON-* constraints (tech stack, performance, security, observability)
   - Founding ADRs (3-8 seeded from vision + inferred stack)
   - Glossary terms (every product noun, vendor name, protocol mentioned in any REQ)
3. **Present the full draft as a single review surface**: tree of domain index + per-domain summary + ADR list + glossary. Ask one question: "Accept as-is, edit a section (name it), or restart?" On `edit <section>`: re-draft only that section, re-present, ask again. On `restart`: discard, return to step 1. Loop until accepted. Phase 5 enrichment runs once, only after final acceptance.
4. **Run Phase 5 enrichment in memory** (see Enrichment pass below).
5. **Write the spec files** from `references/templates/` in the `spec-driven-development` skill, substituting placeholders inline from the vision + inferred stack. Emit each template VERBATIM with section headings, tables, and prose intact — do not collapse or abbreviate. Output uses the nested layout (`sdd/spec/`):
   - `root-readme.md` → `README.md`
   - `sdd-readme.md` → `sdd/README.md` — the single comprehensive index (Vision, Actors, Design Principles, Domains table linking to `spec/{file}.md`, Out of Scope, plus one-line links to constraints/glossary/documentation/changelog)
   - `sdd-glossary.md` → `sdd/spec/glossary.md`
   - `sdd-constraints.md` → `sdd/spec/constraints.md`
   - `sdd-changes.md` → `sdd/spec/changes.md`
   - `sdd-config.yml` → `sdd/spec/config.yml` (mode: interactive; `enforce_tdd: true` for greenfield)
   - One `sdd/spec/{domain}.md` per drafted domain (each AC carries `<!-- @impl: <path>::<symbol> -->` anchors per Phase 5's source-evidence pass)
   - Empty `sdd/spec/.review-queue.md` with `_Awaiting first finding._` placeholder
   - Empty `tests/` directory

   **REQ rendering — MUST READ before writing any `sdd/spec/{domain}.md` file.** The canonical shape lives at `references/templates/req-shape-example.md` (single source of truth). Open that file and copy the SHAPE of REQ-EXAMPLE-001 for every REQ you emit. The hard rules below are scannable mid-write; the full exemplar with two worked cases (populated + `None.`-rendered) lives in the template file.

   **Hard rules (every REQ in every emitted file):**
   - Heading is `### REQ-{DOMAIN}-{NNN}: {Title}` (H3, not H2).
   - Field order is locked: **Intent → Applies To → Acceptance Criteria → Notes (optional) → Constraints → Priority → Dependencies → Verification → Status**. Status is the LAST field, never the first.
   - One blank line between every labeled field. Stacking two `**Field:**` lines on consecutive lines collapses them on GitHub and is MEDIUM `trailing-fields-collapsed`.
   - ACs are NUMBERED (`1. 2. 3.`), never bulleted (`-`). Bulleted ACs are MEDIUM `ac-bullets-not-numbered`. **Maximum 7 ACs per REQ** — past 7 splits along a concern boundary into a sibling REQ.
   - `Constraints:` and `Dependencies:` ALWAYS present. Render `None.` (literal) when empty. CON-* and REQ-* IDs MUST render as markdown anchor links, not plain text.
   - Every AC describing observable behaviour ends with `<!-- @impl: <path>::<symbol> -->`. ACs asserting a concrete value use `<!-- @impl: <path>::<symbol> = <value-pattern> -->`.
   - `**Applies To:**`, `**Priority:**`, `**Verification:**` are REQUIRED — no REQ is allowed to omit them.
   - **Notes is OPTIONAL** with two sanctioned shapes only: (a) Partial-explanation (`Status: Partial` only, ≤3 sentences explaining what's unmet — no mechanism tokens like file paths, function names, env vars, or commit SHAs; those go in `pending.md` or `documentation/`) OR (b) Doc-pointer (any status, ≤2 sentences, MUST contain a markdown link to `documentation/**` or `sdd/**`). Sibling-REQ cross-refs go in `Dependencies:`, not Notes.
   - **Banned inside a REQ body** (Intent or any AC): sub-headings (`####`/`#####`), nested lists, code blocks (` ``` `), tables, strikethrough, block quotes, "Current behaviour:" / "Previously:" branches. These belong in `documentation/`, not in the spec.
   - Each REQ ends with `---` on its own line, blank lines either side.

   Deviation from this shape is a MEDIUM finding caught by `spec-enforce` row 3 (REQ rendering template) on the next PR-boundary review. **The shape is non-negotiable** — do not invent a tighter form because writing 15-45 REQs in a row is tedious. Re-open `req-shape-example.md` between domains if drift creeps in.

   **Emit only files in the canonical layout** (defined in `spec-driven-development` § "Spec structure"). Anything outside that layout — including `sdd/spec/README.md` or `documentation/lanes/README.md` — is a HIGH `layout-violation` caught by `doc-enforce-lanes` § Layout conformance on the next review. The single comprehensive index lives in `sdd/README.md` (Domains table linking to `spec/{file}.md`) and `documentation/README.md` (Jump-TOC linking to lanes + decisions).
6. **Run Phase 6 — documentation lane emission and audit.** Conditional per-lane emission driven by source evidence (see § Phase 6 below). Emit each template VERBATIM — the `documentation-readme.md` template includes Jump-TOC, Lane ownership table, REQ backlinks section, Synonym glossary, Reading order, and Related links; abbreviated emission that strips any of those sections is a HIGH `scaffold-template-stripped` finding caught by step 9's iterate-to-clean (the audit verifies all template section headings are present in the emitted output). Outputs:
   - `documentation-readme.md` → `documentation/README.md` (full template, all sections intact)
   - `documentation-architecture.md` → `documentation/lanes/architecture.md` (universal)
   - `documentation-api-reference.md` → `documentation/lanes/api-reference.md` (only when source has HTTP routes)
   - `documentation-configuration.md` → `documentation/lanes/configuration.md` (only when source has env vars / config)
   - `documentation-deployment.md` → `documentation/lanes/deployment.md` (only when project is deployable)
   - Lane files for `security.md`, `observability.md`, `troubleshooting.md`, `api-reference-admin.md` rendered when source supports them
   - `documentation-decisions-readme.md` → `documentation/decisions/README.md` (founding ADRs from Phase 5c, each `Context:` carries `<!-- @impl: ... -->` anchor)
7. **Phase 7a — Programmatic source-anchor verification (CRITICAL, evidence-gated, non-skippable).**

   This step is the load-bearing Truth gate. It runs BEFORE the Phase 7b enumeration gate (step 8) and the broader iterate-to-clean enforcement (step 9). Failures here BLOCK the commit. The agent does NOT "check by reading"; the agent RUNS the verifier and copies its output verbatim into the commit body.

   **Invocation:**

   ```bash
   python3 ~/.claude/skills/sdd-init/references/verify-source-anchors.py \
       --root . \
       --json-out .verify-anchors.json
   echo "exit=$?"
   ```

   The verifier walks every `<!-- @impl: <path>::<symbol>[ = <value-pattern>] -->` anchor across `sdd/**/*.md` + `documentation/**/*.md`, programmatically checks: (a) `<path>` exists on disk, (b) `<symbol>` greps in that file, (c) when a `= <value>` tail is present, the literal pattern matches the source body. It emits machine-readable JSON: `{ parsed, resolved, orphaned, drifted, malformed, unreadable, failures: [...], malformed_entries: [...], unreadable_entries: [...], exit_code }`. **Exit code is the authoritative signal — 0 = clean, 1 = at least one anchor failed.**

   **Anti-substitution clauses (CRITICAL severity — these are the failure modes that cause the spec to lie):**
   - Agent self-attestation ("I checked the anchors manually, all good") without the verifier output in the commit body is itself **CRITICAL `phase-7a-self-attestation`**, caught by the next PR-boundary review and blocking the merge.
   - Sampling ("I verified the load-bearing anchors") is not Phase 7a. The verifier walks 100% of anchors deterministically; partial reads are not equivalent. A sampled audit is **CRITICAL `phase-7a-incomplete-coverage`**.
   - "spec-enforce ran its own CQ-SOURCE pass, that covers it" is wrong: spec-enforce-truth row 16 trusts Phase 7a's output during `/sdd init`. Running spec-enforce first without Phase 7a leaves the broader enforcement skill consuming an unverified anchor set — **CRITICAL `phase-7a-pipeline-inversion`**.
   - "The verifier path didn't exist on disk, so I skipped it" is **CRITICAL `phase-7a-tooling-bypass`**. The verifier ships inside this skill (`references/verify-source-anchors.py`); if the install path doesn't resolve, install or copy it before proceeding.

   **On `exit_code = 1`:**
   - For each entry in `failures[]`, append an entry to the layout-appropriate triage file (nested: `sdd/spec/.review-queue.md` greenfield or `sdd/spec/.init-triage.md` Import Mode; flat-layout legacy: `sdd/.review-needed.md` greenfield or `sdd/.init-triage.md` Import Mode) with Context = `failures[i].file:line :: failures[i].path::failures[i].symbol — failures[i].reason` and Recommendation = best-guess corrected anchor OR "abandon claim and re-derive from source".
   - **BLOCK COMMIT** until every failure is either fixed (anchor edited or source corrected) OR escalated to triage with concrete Context + Recommendation.
   - Re-run the verifier after every fix. Commit proceeds only when `exit_code = 0` OR every remaining failure has a triage entry.

   **Commit body inclusion (BINDING).** The step-10 commit body MUST contain a verbatim line:

   ```
   Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1
   ```

   The line is the cheap-to-verify proof Phase 7a ran. Absence is **CRITICAL `phase-7a-evidence-missing`** caught by the next PR-boundary review and by `spec-enforce` row 16 reading the most recent `[sdd-init]` commit body.

8. **Phase 7b — Programmatic enumeration-coverage verification (CRITICAL, evidence-gated, non-skippable).**

   This is the symmetric counterpart to Phase 7a. Phase 7a verifies that every claim the agent wrote is anchored; Phase 7b verifies that the agent did not silently drop entire source files from the enumeration. **Validation-Equals-Generation failure mode:** the cheap path is to use anchorability as the *generation* predicate — draft ACs only around symbols that grep cleanly, never produce the broader claim set Phase 5d expects as input, end up with a clean Phase 7a + an empty triage queue + a spec that elides every ambiguity. Phase 7b is the gate that detects this. Both gates must pass.

   **Invocation:**

   ```bash
   python3 ~/.claude/skills/sdd-init/references/verify-enumeration-coverage.py \
       --root . \
       --json-out .phase-7b.json 2>&1
   echo "exit=$?"
   ```

   The `2>&1` is load-bearing: the verifier prints the JSON report to stdout and the one-line summary (`Phase 7b enum verifier: enumerated=N ...`) to stderr; the agent MUST capture both so the summary line is visible to copy verbatim into the commit body.

   The verifier walks the working tree, identifies "load-bearing source files" (under `services/`, `handlers/`, `controllers/`, `providers/`, `models/`, `domain/`, `core/`, `commands/`, `usecases/`, `workers/` — OR source-line-count ≥ 100), and checks each file's repo-relative path against (a) the `<path>` portion of every `<!-- @impl: <path>::<symbol> -->` anchor in `sdd/**/*.md` + `documentation/**/*.md`, AND (b) literal mentions in the triage queue (nested: `sdd/spec/.init-triage.md` + `sdd/spec/.review-queue.md`; flat-layout legacy: `sdd/.init-triage.md` + `sdd/.review-needed.md`). Output JSON: `{ enumerated, accounted, unaccounted, coverage_pct, accounted_via, unaccounted_entries, exit_code }`. **Exit code is the authoritative signal — 0 = clean, 1 = elision detected.**

   **Per-project waiver mechanism.** `sdd/spec/.phase-7b-waiver.txt` (one repo-relative path per line, `#` comment lines allowed) excludes specific files from the coverage check. Intended for genuinely-no-behavioral-contract framework boilerplate (a `main.dart` that only wires the runtime; a `service_locator.dart` whose role is described entirely by other anchors that point AT it). Default: empty. Adding entries requires a one-line justification next to each path.

   **Anti-substitution clauses (CRITICAL severity, symmetric with Phase 7a):**
   - Agent self-attestation ("I covered the important files") without the verifier output in the commit body is itself **CRITICAL `phase-7b-self-attestation`**, caught by the next PR-boundary review.
   - "spec-enforce / CQ-SOURCE will catch this" is wrong — spec-enforce reads what was written, not what wasn't. Phase 7b is the only mechanism that detects silently-dropped source files. Running spec-enforce first without Phase 7b is **CRITICAL `phase-7b-pipeline-inversion`**.
   - Sampling ("I spot-checked the services") is not Phase 7b. The verifier walks 100% of qualifying files. **CRITICAL `phase-7b-incomplete-coverage`**.
   - "Empty triage queue is the right outcome" is permitted ONLY when the verifier reports `coverage_pct = 100` AND the agent justifies the absence of ambiguity verbatim in `sdd/spec/changes.md`. Without both, empty triage on Import Mode is **CRITICAL `import-mode-narrowed-scope`** — the agent drafted from the cleanly-anchorable subset rather than enumerating exhaustively, producing a sanitized spec that hides every uncertainty from the user. See also the complementary § Phase 4 finding `import-mode-empty-triage-implausible`, which fires at enumeration-review time (item-count threshold) where this one fires at commit-gate time (coverage-percentage threshold); the two trigger conditions are intentionally different so both states are caught.
   - "Phase 4 enumeration was skipped because Drafted-In-Memory" — drafting in memory does NOT exempt Phase 4. The enumeration table is the input to drafting, not a side artifact. Skipping is **CRITICAL `phase-4-enumeration-skipped`**.

   **On `exit_code = 1`:**
   - For each entry in `unaccounted_entries[]`, append an entry to the layout-appropriate triage file (nested: `sdd/spec/.init-triage.md`; flat-layout legacy: `sdd/.init-triage.md`) with Context = `entry.path (reason=entry.reason, line_count=entry.line_count) — never appeared in any drafted AC or ADR` and Recommendation = best-guess role / "drop as dead code if confirmed by user" / "fold into REQ-X-NNN if the file implements that AC".
   - **BLOCK COMMIT** until every unaccounted file is either (i) drafted into an AC by re-running Phase 5d on the file, (ii) escalated to triage with concrete Context + Recommendation, or (iii) added to `sdd/spec/.phase-7b-waiver.txt` with a one-line justification.
   - Re-run the verifier after every fix. Commit proceeds only when `exit_code = 0`.

   **Commit body inclusion (BINDING).** The step-10 commit body MUST contain a verbatim line, paired with Phase 7a's:

   ```
   Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1
   ```

   Absence is **CRITICAL `phase-7b-evidence-missing`** caught by the next PR-boundary review and by `spec-enforce` row 16 reading the most recent `[sdd-init]` commit body alongside the Phase 7a line.

   **Phase 7b is advisory for greenfield.** A greenfield project has no source files to enumerate; `enumerated=0` and `coverage_pct=100.0` is the expected outcome. The verifier still runs (the commit body line is still required) so the audit-trail format stays uniform across modes.

9. **Iterate-to-clean (BINDING — non-skippable).** Broader validation against the freshly-written content, downstream of the Phase 7a anchor gate AND the Phase 7b enumeration gate. Skipping is itself a HIGH `enforcement-skill-not-invoked` finding caught by the next PR-boundary review.

   **Anti-substitution rule.** A structural sanity check (file existence + REQ-ID uniqueness + template-field presence) is NOT iterate-to-clean. It is necessary but not sufficient. The "Execute Full Plan" user-memory directive is about not pausing between phases for confirmation — it is NOT authority to skip protocol-required enforcement passes. Conflating the two is itself a HIGH finding.

   **Required invocations (every /sdd init run, every mode):**
   1. **Invoke `spec-enforce` skill with `scope=all`.** Run the full 20-row execution manifest against `sdd/spec/`. CQ-SOURCE (row 16) consumes the Phase 7a verifier JSON output (`.verify-anchors.json`) rather than re-running anchor resolution; CQ-1/2/3 (row 17) runs independently. CQ-SOURCE is ALWAYS RUN — never gated by `enforce_tdd` or by transition state.
   2. **Invoke `doc-enforce` skill with `scope=all`.** Run the full 15-row execution manifest against `documentation/`. Pass 15 (doc source-anchor truth-check) ALSO consumes the Phase 7a verifier JSON (the verifier walks `documentation/**/*.md` too) rather than re-deriving; Pass 8/9/10/11 run independently. Pass 15 is ALWAYS RUN — never gated.
   3. **Template-verbatim + layout audit (step-9 owned).** Walk each `references/templates/*.md` that was emitted; for each, extract the level-2 (`##`) section headings and verify every one appears in the emitted file. Missing heading = HIGH `scaffold-template-stripped` listing the template, the emitted path, and the missing section. Layout conformance (any file outside `spec-driven-development` § "Spec structure") is caught by `doc-enforce-lanes` § Layout conformance — no separate check needed here. Finally verify `sdd/README.md`'s Domains table lists every domain file actually present under `sdd/spec/*.md` (excluding glossary, constraints, changes, .review-queue, .init-triage, config); missing rows = HIGH `scaffold-domain-table-incomplete`.

   **Mode-dependent action on findings:**
   - Mechanical findings (template field missing, lane violation pattern, REQ-backlink missing, shape inconsistency): auto-fix in `auto`/`unleashed`, prompt in `interactive`.
   - Truth-check findings (CQ-SOURCE, Pass 15) — these are Phase 7a `failures[]` entries surfaced upstream; NEVER silently rewrite. Escalation to `sdd/spec/.review-queue.md` (or `.init-triage.md` during Import Mode) already happened in Phase 7a; step 9 verifies the triage entries are well-formed.
   - Block-emit at /sdd init time: HIGH non-Truth findings block the file write. Source-scan for plausible anchors, regenerate the section, attempt emit again. On second-pass failure, the section becomes a triage entry rather than committed prose. (Same rule as `doc-enforce-truth` § Block-emit at /sdd init time.)

   **Exit criteria:** zero CRITICAL/HIGH findings remain (either fixed or escalated to triage with concrete Context + Recommendation). Re-run both skills until findings stabilize (typically 1-2 cycles).

   **Commit gate:** step 10 is FORBIDDEN until ALL of (a) Phase 7a `exit_code = 0` OR every failure escalated to triage, (b) Phase 7b `exit_code = 0` OR every unaccounted file escalated to triage / waivered, AND (c) step 9 enforcement skills have actually been invoked (not substituted with a structural check). The commit body MUST include:
   - the Phase 7a verifier line (mandatory, see step 7 above)
   - the Phase 7b verifier line (mandatory, see step 8 above)
   - `spec-enforce: ran (N REQs, M anchors verified, V drift, O orphaned) — auto-fixed F, escalated E`
   - the equivalent for `doc-enforce`
10. **Commit the scaffold** as one commit with subject `[sdd-init] initial spec scaffold`. The `[sdd-init]` prefix is excluded from the spec-reviewer round counter. Commit body MUST include the Phase 7a verifier line, the Phase 7b verifier line, AND the step-9 audit log per skill (see Commit gate above); absence is itself a HIGH `enforcement-skill-not-invoked` finding on the next PR-boundary review.
11. **Report next steps** to the user.

All templates live in the `spec-driven-development` skill's `references/templates/`, bundled with the agent seed and resolved locally.

## Import Mode — two-output model

The migration path from legacy manual coding to autonomous agentic coding. Two simultaneous outputs:

- **Official spec REQs** in `sdd/spec/{domain}.md` — for behavior clearly determinable from the full discovery surface. Normal REQ shape (each AC carrying `<!-- @impl: ... -->` per Phase 5d), normal SDD discipline.
- **Triage entries** in `sdd/spec/.init-triage.md` — for unclear items (magic numbers without rationale, retry policies without context, ambiguous contracts, orphan code, missing Intent, claims with no source anchor from Phase 5d). Each entry carries the agent's **Context** (file:line, git author, commit refs, related tests, PRs, issues, releases) and **Recommendation** (best-guess with one-line Rationale). The user reviews and decides; they don't archaeology from scratch.

**Discovery surface is the full project history**, not just source. Intent in legacy systems lives in PR descriptions, issue threads, code-review comments, release notes. Pull from: working tree (README, configs, source, tests, inline comments, ADRs), git history (commits, tags), and the GitHub corpus when a remote exists (PRs via `gh pr view --comments`, issues via `gh issue view --comments`, releases via `gh release view`, wiki via API). When a PR references an issue ("Closes #142"), Context follows the chain backward.

**Degradation when GitHub sources are unreachable.** Detect failure conditions up front (non-GitHub remote — GitLab / Bitbucket / Forgejo / Gerrit; `gh auth status` fails; rate-limited; private repo with insufficient token scope). On failure, skip the GitHub sources and proceed with working-tree + git-log evidence only. Print a one-line notice (`Note: discovery used working tree + git log only ({reason} - GitHub sources unavailable).`) and append the same to the `sdd/spec/changes.md` import entry.

While `sdd/spec/.init-triage.md` contains `**Status:** open` items, the project is in **SDD transition**. Import Mode writes `sdd/spec/config.yml` with `transition: true` and `enforce_tdd: false` at scaffold time (the two Import-Mode-specific config defaults; greenfield uses `transition: false` and `enforce_tdd: true`). During transition, the PR-boundary review pipeline is **entirely suspended**: code-reviewer, spec-reviewer, doc-updater do not fire. Mode-selector behavior during transition (specifically the `/sdd mode unleashed` rejection) is owned by the `spec-driven-development` skill's `/sdd mode` section — single source of truth, see there for the full rule.

Note: the `enforce_tdd: false` default gates only the test-anchor check (whether tests reference REQ IDs). The CQ-SOURCE source-anchor truth-check still runs during transition — fabrication is never optional. See `spec-enforce-truth` for the split.

When the queue drains to zero, `transition: true` clears automatically. Full SDD discipline applies on the next push. `enforce_tdd` is NOT auto-flipped — user sets it manually when ready (typically after adding REQ-ID test names). `sdd/spec/.init-triage.md` is preserved as the audit record.

Import Mode follows the **same lean two-confirm shape as greenfield**. Single user-facing question at step 1: "Derive from existing code, or treat as fresh start?". At step 3 user reviews the full inferred spec (vision pre-filled from README, derived domains, CLEAR REQs, triage queue summary, founding ADRs) and accepts or asks for edits.

**Status default for imported REQs:**
- `enforce_tdd: true` — Status defaults `Implemented` if a test mentions the REQ ID, `Partial` otherwise. CQ-SOURCE (source-anchor truth-check) ALWAYS runs and is not gated by this flag.
- `enforce_tdd: false` (Import Mode default) — Status defaults `Implemented` unconditionally when source exists AND the AC's `<!-- @impl: ... -->` anchor resolves. The project has opted out of test-based verification at import time; demoting every imported REQ to Partial would falsely brand the spec 65%+ incomplete. Each `sdd/spec/{domain}.md` file (per domain, not the top-level `sdd/README.md`) receives a single footnote `_Verification: code-only (no automated coverage)._` at the bottom. Per-REQ `Notes:` are not used for this signal. CQ-SOURCE still runs and flags claims whose anchors don't resolve — those become triage entries.

This rule applies during Import Mode and Resume Mode while `transition: true`. After transition closes, the normal `enforce_tdd` interaction in `spec-enforce-truth` governs Status assignment.

CLEAR REQs land in `sdd/spec/{domain}.md` after the user accepts the draft. The confidence threshold (single matching domain, unambiguous behavior, clear evidence WITH source-anchor) is the gate; anything below became a triage entry. To correct any CLEAR REQ post-import, run `/sdd edit {domain}`.

Phase 5 enrichment runs in Import Mode too, after the draft is accepted and before files are written.

## Resume Mode — picking up where you left off

Re-invoking `/sdd init` on a project with open triage items enters Resume Mode.

1. **Working tree must be clean** (`git status --porcelain` empty). Refuse if not — Resume Mode commits per decision and would mix WIP edits with triage commits.
2. **Sanity-check transition state.** If `transition: true` is missing from `sdd/spec/config.yml` but open items exist, restore quietly. If `transition: true` is set but `sdd/spec/.init-triage.md` is unreadable, abort with a recovery hint.
3. **Print a mode-auto notice** when `sdd/spec/config.yml` says `mode: auto`: Resume Mode is always interactive; auto suspends for this run and resumes after the queue drains.
4. **Surface one item at a time** with **refreshed** Context (re-read source, re-check git log, re-fetch related PRs — the codebase may have evolved). User picks one of:
   - `accept` the recommendation → fold into the relevant REQ
   - `correct` it → free-form prose; agent folds purpose into REQ Intent and behavior into AC bullets named in the entry's `**Target REQ:**` field (no re-inference)
   - `lost` → one-line Reason required; the related REQ (if any) gets `Notes: intent lost during SDD transition - see TRIAGE-{NNN}`
   - `skip` → stays open, advance to next
   - `quit` → exit; prior decisions are already committed per-item

Only `accept` and `correct` promote anything to the official spec. Each decision is its own commit.

**Transition-closure step** after every resolved/lost decision. When zero `**Status:** open` remain:
- `transition: true` is cleared from `sdd/spec/config.yml`
- A closure entry appends to `sdd/spec/changes.md` (e.g., `SDD transition complete. {Total} triage items resolved ({R} accepted, {C} corrected, {L} lost).`)
- `enforce_tdd` is NOT changed (user flips manually when ready)
- Agent enters Plan Mode for the first feature work on top of the now-real spec

## Tool surface compatibility (binding for every `/sdd` sub-command)

Use the native tools available in the current runtime. Every phase below MUST work when context-mode is absent.

- **Behavioural contract is tool-agnostic.** Skill describes WHAT, not WHICH shell wrapper.
- **Discovery commands** (e.g. `gh pr list --state all --limit 200`, `git log --follow`, full-tree scans, `npm view <pkg> peerDependencies`) run through Bash/Grep/Glob/Read in runtimes without context-mode. Extra output-management tools are optional helpers, never required.
- **File writes always use Write/Edit.** Never construct durable file contents inside shell heredocs unless explicitly writing a throwaway intermediate.
- **Scaffold-only lockfile carveout** (`npm install --package-lock-only --ignore-scripts --no-audit --no-fund` and equivalents) is permitted as a resolution-only call at scaffold time by the `no-local-builds` rule.

## Behavioral enumeration (Phase 4)

> Section name uses "Phase 4" parenthetically rather than as a heading prefix so it does not collide with the numbered step "4" in the greenfield flow above (which runs Phase 5 enrichment). Phase numbers and step numbers are independent: the greenfield flow has 11 numbered steps; Phase numbers (4, 5, 6, 7a, 7b) name conceptual stages that may span multiple steps.

**Binding for Import Mode, advisory for greenfield.**


**The Validation-Equals-Generation failure mode.** The downstream source-evidence pass (Phase 5d) triages claims that cannot be anchored. The cheap path: the agent uses anchorability as the *generation* predicate — drafts ACs only around symbols it can grep cleanly, never produces the broader claim set Phase 5d expects as input, and ends up with an empty triage queue + a spec that looks clean but elides every ambiguity. The triage queue is supposed to be the *visible* surface of the agent's uncertainty; an empty queue on Import Mode is the surface lying. Phase 4 + Phase 7b together make this failure mode mechanically detectable.

Phase 4 is the explicit enumeration step. The agent walks a deterministic source surface and produces the list of behaviors that MUST be accounted for. Drafting in step 2 then iterates over this list; Phase 5d resolves each item; Phase 7b verifies that every enumerated item was either drafted, triaged, or waivered.

**Inputs (Import Mode — binding):**

1. `mcp__graphify__god_nodes(top_n=50)` — top-N most-connected nodes (typically class / service / function names).
2. Filesystem walk: every file under `(lib|src|app)/(services|providers|handlers|controllers|models|domain|core|commands|usecases|workers)/` matching the project's source extensions.
3. Filesystem walk: every source file with ≥ 100 source lines (comments + blanks excluded), outside test / build / generated directories.
4. `git log --grep='fix:\|incident\|bug:\|TODO' --pretty=%s` for the last 6 months — issues and bug fixes likely to encode load-bearing behavior.
5. `grep -rE 'TODO|FIXME|HACK|XXX' lib src app` — inline known-unknowns the original author flagged but did not resolve.
6. `gh pr list --state closed --limit 50` + `gh issue list --state all --limit 50` (when a GitHub remote is reachable) — closed PR / issue threads often encode the intent behind a decision the code itself does not record.

**Output:** an in-memory enumeration table that the agent walks during step 2 drafting. Each entry has:

- `source`: the file or thread the behavior originates from (e.g. `lib/services/foo_service.dart`, `PR #142`).
- `brief`: a one-sentence behavioral statement.
- `candidate_status`: one of `ac` (drafted into a REQ AC with `@impl` anchor), `triage` (filed in `.init-triage.md` with Context + Recommendation), `oos` (added to `sdd/README.md` § Out of Scope with a one-line justification).

The agent persists the table to `.phase-4-enumeration.json` (working-tree intermediate, gitignored) so Phase 7b can cross-reference if needed; the source of truth for coverage remains the verifier's filesystem walk in step 8.

**Candidate-status assignment rule:**

- `ac`: the behavior has a clear behavioral predicate AND a plausible source anchor — will become a drafted AC.
- `triage`: the behavior exists but has ambiguity (orphan code, undocumented magic number, missing intent, retry policy without rationale, two-of-something files with overlapping purpose, closed-but-not-merged PRs that hint at intent) — will become a triage entry. **The default for any item without a clear behavioral predicate is `triage`, not `oos`.**
- `oos`: the behavior is genuinely out of scope — vestigial file the user later confirms is dead, an experimental branch left in source, a third-party adapter included for future use. Use sparingly; `oos` requires the agent to be confident it will not surprise the user.

**Triage-queue plausibility (Import Mode only):** an empty `.init-triage.md` on a codebase with ≥ 10 enumerated items and no explicit `oos` waivers is **CRITICAL `import-mode-empty-triage-implausible`** (this fires at enumeration-review time, based on item count). The complementary Phase 7b clause `import-mode-narrowed-scope` (see step 8) fires independently at commit-gate time, based on coverage percentage rather than item count, so an empty triage on a codebase with 9 enumerated items still trips Phase 7b even when this clause does not. The Import Mode contract assumes ambiguity in legacy code; zero ambiguity is almost always evidence that the agent narrowed scope rather than enumerated exhaustively. Either every enumerated item has a clear behavioral predicate AND a verifiable source anchor (and the agent justifies this verbatim in the `sdd/spec/changes.md` import entry), or some items are in `triage`. The agent is allowed to surface "this codebase has no ambiguity worth triaging" only when it explicitly says so in changes.md.

**Phase 4 is advisory for greenfield.** A greenfield project has no source to enumerate against; the drafted REQs ARE the enumeration. Greenfield skips the `.phase-4-enumeration.json` artifact emission. The Phase 7b verifier still runs (and trivially passes with `enumerated=0`, `coverage_pct=100.0`) so the audit-trail format stays uniform across modes.

## Enrichment pass (Phase 5 — binding for greenfield and Import Mode)

**Pre-condition: a graphify graph at `graphify-out/graph.json` is the load-bearing source of truth for this phase.** Per REQ-AGENT-025, the post-clone PostToolUse hook prompts the user to build one immediately after `git clone`. If missing at `/sdd init` time, prompt the user ONCE: "No graphify graph found. Build one now via `/graphify cluster-only` (AST-only, free, ~30s)? Or proceed with in-memory enrichment (less reliable cross-link density)?". On accept: dispatch `/graphify cluster-only` and wait. On decline: fallback (below).

After the draft exists in memory, run four passes in one cycle before writing files:

**a. Cross-link pass.** For every drafted REQ, call `mcp__graphify__get_neighbors(<concept-or-symbol>)` against every named concept, vendor, protocol, file, or symbol in its Intent or AC bullets. Returned neighbors that are other drafted REQs → lift into `Dependencies:` as `[REQ-X-NNN](#req-x-nnn-title-slug)`. Returned CON-* nodes → lift into `Constraints:` as `[CON-X-NNN](constraints.md#con-x-nnn-title-slug)`. Use `mcp__graphify__shortest_path` to validate non-obvious dependency edges before lifting.

**b. ADR-seed pass.** Call `mcp__graphify__god_nodes(top_n=20)`. Filter to nodes representing technology / framework / external service / pattern choices (drop pure files, drop generic primitives). Each survivor becomes a founding ADR candidate. Draft 3-8 ADRs covering tech stack, framework, deployment target, auth pattern, data store, key middleware, observability. Drop candidates that fail the "What is NOT an ADR" test from `documentation-decisions-readme.md` (no real alternative considered → not an ADR). Each ADR carries Status, Context, Decision, Alternatives, Rationale, Consequences, Related requirements. The ADR `Context:` block carries `<!-- @impl: <path>::<symbol> -->` naming the implementation site of the chosen path; no implementation site → ADR becomes a triage entry, never a fabricated ADR.

**c. Glossary-seed pass.** Query the graph for concept-tagged nodes (`mcp__graphify__query_graph` with concept filter; graphify emits these with `source_file: null` when they represent vocabulary). Each becomes a one-line glossary entry in `sdd/spec/glossary.md`. For nodes appearing under multiple labels in the graph (clustering identifies synonyms), record both in the synonym glossary slot of `documentation/README.md`.

**d. Source-evidence pass (binding for Truth guarantee).** Iterate over the Phase 4 behavioral-enumeration table (Import Mode) or the drafted-AC set (greenfield). Drafting in step 2 was supposed to fold every Phase 4 item into one of {AC, triage, oos}; this pass is the per-item resolution. For every item in `candidate_status=ac` AND every founding ADR `Context:` block:

1. Identify the implementing symbol via the community/path map built during step 2 (or `mcp__graphify__query_graph` against the AC's named verb-phrase).
2. Call `mcp__graphify__get_node(<symbol>)` to obtain the symbol's source file and node body. Fall back to `Grep` against the inferred path when graphify cannot resolve.
3. For AC bullets asserting a concrete value (numbers, thresholds, retry counts, storage targets): grep the symbol body for the literal value pattern. On match: emit the AC with `<!-- @impl: <relative-path>::<symbol> = <value-pattern> -->`. On miss: the AC content becomes a triage entry rather than emitted as AC.
4. For AC bullets asserting behaviour without a specific value: emit `<!-- @impl: <relative-path>::<symbol> -->`. The validator later confirms ≥3 AC-token overlap with the symbol body; the agent does its own overlap check now to avoid emitting an AC whose symbol body doesn't match.
5. For ADR `Context:` blocks: emit `<!-- @impl: <relative-path>::<symbol> -->` naming the chosen-path implementation site. No site → ADR becomes triage entry.
6. **Never fabricate, never silently narrow.** When source evidence cannot be established for a claim, the claim becomes a triage entry (`sdd/spec/.review-queue.md` for greenfield, `sdd/spec/.init-triage.md` for Import Mode). The triage entry carries the agent's Context (what was searched, where, what was expected) and Recommendation (best guess, marked as such). The user resolves via interactive Q&A in Resume Mode. Dropping a Phase 4 enumeration item from the draft without producing either a triage entry or an explicit Out-of-Scope line is the Validation-Equals-Generation failure mode (detected by Phase 7b — see step 8).

The four passes run in one in-memory cycle. The user already accepted the full draft in step 3; enrichment does not re-prompt.

**Fallback: in-memory heuristic.** Fire fallback when ANY of:
1. `graphify-out/graph.json` is absent AND the user declined to build a graph.
2. `god_nodes(top_n=20)` returns zero nodes (graph exists but empty — fresh repo, build truncated). Same trigger if `query_graph` returns no concept nodes during glossary-seed.
3. Any `mcp__graphify__*` call errors (MCP server down, graph corrupt, permission denied).

Fallback behaviour: walk every drafted REQ; for every other REQ whose Intent or ACs reference the same concept by literal string, propose a `Dependencies:` entry. Same for CON-*. ADR-seed + glossary-seed derived by re-reading the draft, extracting nouns/vendors/protocols. The source-evidence pass (5d) still runs but loses graphify's symbol resolution; it falls back to `Grep` against inferred paths. Print: `Note: enrichment used in-memory heuristic ({reason}). Cross-link density may be lower than a graphify-backed run.` Append same notice to `sdd/spec/changes.md`.

Graph tools are independent of the shell surface — no shell wrapper is required for graph queries. The fallback uses no shell tool at all.

## Phase 6 — Documentation lane emission and audit (binding)

Phase 6 generates `documentation/` from the source evidence accumulated in Phase 5 plus targeted per-lane probes. Lane files are organised by **natural axis** (security: per-control, observability: per-signal, architecture: per-component category) — never per-domain. Domain coverage is verified via the post-emit backlink audit below, not via per-domain sections.

### Conditional lane emission

Each lane emits ONLY when source evidence justifies it. Empty lane → file not emitted, no triage entry needed (an empty `security.md` on a project with zero auth code would just be filler).

| Lane | Emit condition (probe) |
|---|---|
| `documentation/lanes/architecture.md` | **Universal** — always emit. Phase 5a god_nodes + community map drives the Source Module Map, Component table, and Request Lifecycles. |
| `documentation/lanes/api-reference.md` | `mcp__graphify__query_graph("HTTP handler\|route\|endpoint")` returns ≥1 node, OR source has framework-specific route files (`pages/api/`, `routes/`, `handlers/`, `cmd/server/`, etc.) |
| `documentation/lanes/api-reference-admin.md` | Admin endpoints exist (route prefix detection: `/admin/`, `/api/admin/`, etc.) AND admin-route count ≥ 3 |
| `documentation/lanes/configuration.md` | Env var consumers exist (grep `env\.\|process\.env\|os\.environ\|std::env`), OR config files exist (`wrangler.toml`, `.env.example`, `config.yml` not under sdd/) |
| `documentation/lanes/deployment.md` | Project is deployable (presence of `wrangler.toml`, `Dockerfile`, `.github/workflows/deploy*.yml`, `fly.toml`, `app.yaml`, etc.) |
| `documentation/lanes/security.md` | `mcp__graphify__query_graph("auth\|csrf\|csp\|jwt\|session")` returns ≥1 node, OR auth-related source files exist |
| `documentation/lanes/observability.md` | Structured logging exists (`console.log` with JSON, `log(` calls, `slog`, `tracing`, `metrics.`, OpenTelemetry imports) |
| `documentation/lanes/troubleshooting.md` | Commit messages reference incidents (`grep -iE 'fix:\|incident\|outage\|bug:'` against `git log --pretty=%s --since='3 months ago'` returns ≥3 matches), OR `RUNBOOK.md` / `INCIDENTS.md` exist at repo root |
| `documentation/decisions/README.md` | **Always emit** — minimum 3 founding ADRs from Phase 5c |

### Per-lane content generation

Within each emitted lane, generate sections by natural axis from the source evidence. Every load-bearing fact in every lane file carries an inline `<!-- @impl: <path>::<symbol> -->` anchor; `Implements:` fields link to the relevant REQs in `sdd/spec/{domain}.md`. Same triage rule as Phase 5: claim without source evidence → triage entry, never fabricated content.

- **architecture.md** sections: Overview (1 paragraph from vision + tech-stack), Components (table from god_nodes filtered to long-lived orchestrators), Repository Layout (tree from top-level directories), Source Module Map (exhaustive table per directory of source files, role + Implements REQ backlinks), Request Lifecycles (per top-level entry point: cron, queue consumer, HTTP handler — flow diagram traced via `shortest_path`), Data Flow, Cross-cutting Concerns, Build and Deploy.
- **api-reference.md** sections: Conventions (auth vocab, origin-check vocab, error envelope), per-endpoint sections following the `doc-enforce-shape` Pass 7 binding template.
- **configuration.md** sections: per env var, per build-time constant, per signing config artifact — each with the `doc-enforce-shape` Pass 5 required field set.
- **deployment.md** sections: per deployable artifact, runbook walkthrough (commands sourced from real deploy scripts via grep).
- **security.md** sections: per security control discovered in source — Threat / Mitigation / Verification / Implements field block per control.
- **observability.md** sections: event enum table (from structured-log emitter), per-signal sections with field tables.
- **troubleshooting.md** sections: per recipe — Symptom / Cause / Fix block, sourced from commit-message incident references and any existing `INCIDENTS.md`.

### Post-emit backlink-coverage audit

After lane files are written, verify each spec domain's REQs appear via `Implements:` backlinks in the lanes where they belong:

| Domain hint | Expected lanes |
|---|---|
| `auth*`, `session*`, `oauth*`, `csrf*` | security.md, observability.md, api-reference.md |
| `upload*`, `download*`, `file*` | api-reference.md, architecture.md |
| `email*`, `notification*`, `dispatch*` | architecture.md, configuration.md, observability.md |
| `*log*`, `*activity*`, `*metric*`, `*trace*` | observability.md, architecture.md |
| `share*`, `intent*`, `deep-link*` | architecture.md (mobile-shape projects: api-reference.md too) |
| `theme*`, `ui*`, `pwa*`, `design*` | architecture.md (web/mobile), configuration.md (when build-time toggle) |
| `connectivity*`, `network*` | architecture.md, observability.md |
| `deploy*`, `build*`, `config*` | configuration.md, deployment.md |

Domain with zero backlinks in any expected lane → emit MEDIUM finding to `sdd/spec/.review-queue.md` with the domain name and the missing lane(s). The user resolves via Resume Mode (either extend the relevant lane to backlink the domain's REQs, or correct the domain hint mapping for the project).

### Phase 7a + Iterate-to-clean against enforcement skills (binding)

This section is the operational detail of greenfield-flow steps 7 (Phase 7a verifier), 8 (Phase 7b enumeration-coverage verifier), and 9 (iterate-to-clean). It is BINDING — every `/sdd init` run, every mode, every project. Skipping any of them is itself a finding: skipping Phase 7a = CRITICAL `phase-7a-*` (see step 7); skipping Phase 7b = CRITICAL `phase-7b-*` (see step 8); skipping step 9 = HIGH `enforcement-skill-not-invoked`.

**Anti-substitution rule (repeated for emphasis).** A structural sanity check (file existence + REQ-ID uniqueness + template-field presence) is necessary but NOT sufficient. The actual truth-check is the programmatic Phase 7a verifier — `references/verify-source-anchors.py` walks every `<!-- @impl: path::symbol -->` anchor and produces a machine-readable JSON report with `parsed`, `resolved`, `orphaned`, `drifted` counts. **The agent does not "verify by reading" or "spot-check the load-bearing anchors" — the agent runs the verifier and copies its output into the commit body.** Substituting a structural check or an agent self-attestation for the verifier output is itself a CRITICAL finding (`phase-7a-self-attestation` / `phase-7a-incomplete-coverage` / `phase-7a-pipeline-inversion` / `phase-7a-tooling-bypass` — see step 7 catalogue). The "Execute Full Plan" user-memory directive is about not pausing between phases for confirmation — it is NOT authority to drop the verifier or substitute it with reading.

**Phase 7a (CRITICAL gate, BEFORE the two enforcement skills).** Run `python3 ~/.claude/skills/sdd-init/references/verify-source-anchors.py --root . --json-out .verify-anchors.json`. Block commit on `exit_code != 0` until every failure is fixed or escalated to triage. Copy the verifier summary line into the commit body verbatim. See step 7 of the greenfield flow for the full catalogue of CRITICAL findings (`phase-7a-self-attestation`, `phase-7a-incomplete-coverage`, `phase-7a-pipeline-inversion`, `phase-7a-tooling-bypass`, `phase-7a-evidence-missing`).

**Spec side (downstream of Phase 7a).** Invoke `spec-enforce` with `scope=all`. Always-runs rows (the 20-row manifest):
- CQ-SOURCE — Source-anchor truth-check (row 16): consumes the Phase 7a verifier JSON (`.verify-anchors.json`). HIGH `cq-source-anchor-orphaned` and `cq-source-value-drift` findings are surfaced from `failures[]` already, so this row is mechanically aggregating Phase 7a output rather than re-deriving. NEVER gated by `enforce_tdd` or transition state.
- CQ-1, CQ-2, CQ-3 (row 17): REQ-test truth-check, vendor drift, content-preservation.
- Per-REQ structural rows 1-14: forbidden content, status drift, AC granularity, etc.
- Backlog re-triage (row 18): walk existing triage entries; reclassify against current rules.

**Doc side (downstream of Phase 7a).** Invoke `doc-enforce` with `scope=all`. Always-runs rows (the 15-row manifest):
- Pass 15 — Doc source-anchor truth-check: consumes the same Phase 7a verifier JSON (the verifier walks both `sdd/**/*.md` and `documentation/**/*.md` in one pass). Always runs, never gated.
- Pass 8 — Verification truth-check, Pass 9 — Implements-vs-AC cross-walk, Pass 10 — Stale code-block detection, Pass 11 — Content-preservation on trim.
- Pass 1, 13, 14 — per-element budgets, within-section semantic consistency, authoring quality.
- Pass 12 — Stranger cold-read (caches on commit SHA — first /sdd init run is uncached).

**Mode-dependent action on findings:**
- Mechanical findings (template field missing, lane violation pattern, REQ-backlink missing, shape inconsistency): auto-fix in `auto`/`unleashed`, prompt in `interactive`.
- Truth-check findings (CQ-SOURCE, Pass 8/9/10, Pass 15): NEVER silently rewrite. Escalate to `sdd/spec/.review-queue.md` with concrete Context (file:line, symbol attempted, why it didn't resolve) and Recommendation (best-guess corrected anchor, or "abandon claim").
- Stranger cold-read findings (Pass 12): escalate to `sdd/spec/.review-queue.md`.

**Block-emit at /sdd init time.** HIGH Truth findings BLOCK the file write. Source-scan for plausible anchors, regenerate the section, attempt emit again. On second-pass failure, the section content becomes a triage entry rather than committed prose. The block-emit gate is `/sdd init`-specific — steady-state doc-updater on existing files cannot rewrite history; it flags and escalates.

**Exit criteria.** Zero CRITICAL/HIGH findings remain (every truth-check anchor either resolves OR escalates to triage with concrete Context + Recommendation). Re-run both skills until findings stabilize (typically 1-2 cycles).

**Visible audit trail (binding).** The step-10 commit body MUST include four lines (in order):
- `Phase 7a verifier: parsed=N resolved=N orphaned=N drifted=N malformed=N unreadable=N exit_code=0|1` (CRITICAL — see step 7)
- `Phase 7b enum verifier: enumerated=N accounted=N unaccounted=N coverage_pct=P exit_code=0|1` (CRITICAL — see step 8)
- `spec-enforce: ran (N REQs, M anchors verified, V drift, O orphaned) — auto-fixed F, escalated E`
- `doc-enforce: ran (D docs, A anchors verified, V drift, O orphaned, U unanchored) — auto-fixed F, escalated E`

Absence of any line is itself a finding on the next PR-boundary review (CRITICAL for the Phase 7a / Phase 7b lines, HIGH `enforcement-skill-not-invoked` for the other two). The lines are the cheap-to-verify proof that steps 7, 8, and 9 actually ran rather than being substituted with reading or a structural check.

The iterate-to-clean loop is the depth-floor mechanism: every mandatory field that doc-enforce-shape Pass 5/6/7 demands either has a source-anchored value (real content) or becomes a triage entry (visible to the user as a question). The output cannot be vacuously thin AND structurally complete.

## Dependency version resolution

When `/sdd init` generates a package manifest (`package.json`, `Cargo.toml`, `requirements.txt`, `go.mod`, etc.), NEVER emit memorized version ranges. Resolve each top-level dependency to current latest stable via the ecosystem's metadata tool:

| Ecosystem | Version query | Lockfile generation (scaffold-only carveout) |
|---|---|---|
| npm | `npm view <pkg> version` + `npm view <pkg> peerDependencies` | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` |
| Cargo | `cargo search <crate> --limit 1` | `cargo generate-lockfile` |
| Python | `pip index versions <pkg>` | `uv lock` or `pip-compile` |
| Go | `go list -m -versions <module>` | `go mod tidy` |

For Cloudflare Workers projects, see `cloudflare-stack` § Cloudflare cohort pinning — the 4-pack (wrangler + workers-types + vitest-pool-workers + vitest) must be resolved together before writing `package.json`.

Process (npm example):
1. For each proposed dependency, run `npm view <pkg> version` → capture latest.
2. Run `npm view <pkg> peerDependencies` → capture peer constraints.
3. Cross-check peer ranges: if two packages disagree, drop one to the highest co-compatible version rather than picking the latest of both.
4. Emit specific caret ranges: `^5.14.0`, never `^5.0.0` from memory.
5. Write `package.json`.
6. Run the lockfile generator ONCE (scaffold-only carveout).
7. Commit both manifest and lockfile.

**Local CPU carveout (`/sdd init` only):** the `no-local-builds` rule forbids local installs/builds/tests on the 1-vCPU container. The lockfile generator is a one-time exception because (a) CI's `npm ci` requires a committed lockfile, (b) Dependabot baseline needs a deterministic starting point, (c) the operation is resolution-only with `--ignore-scripts` (no `node_modules` populate, no script execution, no build). Applies ONLY during `/sdd init`. Every other local install/build/test remains forbidden.

**Forbidden at scaffold time:** `npm install` (full), `npm test`, `npm run build`, `tsc`, `cargo build`, `cargo test`, any test runner, any bundler.

## Aborts

- `sdd/` already exists with no open triage items → abort, point user at `/sdd clean`.
- `sdd/` exists with open triage items → enter Resume Mode.

## Post-init hard gate: Plan Mode

After `/sdd init` (greenfield OR transition closure on the last triage item), the next action MUST be entering Plan Mode (Claude Code: `EnterPlanMode`). Hard gate. "build now" / "go" / "execute" never authorize skipping. See the `spec-driven-development` skill § Plan Mode integration for the plan structure (RED → GREEN → VERIFY).
