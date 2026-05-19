---
name: spec-driven-development
description: Specification-driven development index. Defines spec structure, REQ format, Status semantics, three autonomy modes, and routes to sub-command skills (sdd-init for bootstrap, sdd-clean for rescue). Holds the small sub-commands (edit, add, mode), Plan Mode integration, test discipline, templates. Invoked via /sdd.
version: 5.0.0
---

# Spec-Driven Development

A product specification (`sdd/`) is the single source of truth for **what the product does and why**. It is not a record of what the code currently does. It is not a bug tracker. It is not a changelog of every commit.

The full enforcement layer lives in the `spec-discipline` rule (loaded automatically). This skill describes the workflow on top of those rules.

## How it works at a glance

The user runs `/sdd init` once to bootstrap. After that, they "vibe code" — write code, push, walk away. The `spec-reviewer` and `doc-updater` agents auto-detect the `sdd/` folder and enforce discipline on every PR-boundary event, in the mode set by `sdd/config.yml` (`interactive`, `auto`, or `unleashed`).

The user only invokes `/sdd` directly to:
- Bootstrap a new project (`/sdd init` → invokes the `sdd-init` skill)
- Manually add or modify requirements (`/sdd edit`, `/sdd add` — body below)
- Rescue a rotted spec (`/sdd clean` → invokes the `sdd-clean` skill)
- Switch autonomy mode (`/sdd mode` — body below)

## Sub-commands

| Command | Skill / body |
|---|---|
| `/sdd` | Help screen (the `/sdd` command file) |
| `/sdd init [idea]` | Invoke the `sdd-init` skill (greenfield, import, resume) |
| `/sdd edit {domain}` | This skill, § /sdd edit |
| `/sdd add {domain}` | This skill, § /sdd add |
| `/sdd clean` | Invoke the `sdd-clean` skill (mode-aware spec rescue) |
| `/sdd mode {interactive\|auto\|unleashed}` | This skill, § /sdd mode |

## Spec structure

```
sdd/
├── README.md            # Vision, principles, actors, domain index, "Out of Scope" section
├── glossary.md          # Canonical term definitions
├── constraints.md       # Technology stack, cross-cutting CON-* constraints
├── changes.md           # Semantic changelog (≤2 sentences per entry, user-facing only)
├── config.yml           # mode, enforce_tdd, test_globs, src_globs (optional), allowlists
├── .review-needed.md    # Findings escalated for human review (committed, cleared on resolution)
├── .review-decisions.md # Cumulative per-finding triage history from /review (committed, append-only)
├── .coverage-report.md  # Output of enforce_tdd: false runs (committed)
├── .last-clean-run.md   # Audit log of the most recent /sdd clean run (committed)
└── {domain}.md          # Requirements per feature area
```

Project root also has:
```
README.md          # Links to sdd/ and documentation/
documentation/     # Implementation docs (architecture, API, config, deployment, decisions)
tests/             # Tests (each test references a REQ ID for spec-reviewer to verify)
pending.md         # In-flight work and known gaps (NOT requirements)
```

## REQ format

Every Active REQ in `sdd/{domain}.md` MUST render in this exact shape. Deviations are MEDIUM, auto-fixed by re-rendering (mechanics in `spec-enforce` § REQ rendering template).

```markdown
### REQ-{DOMAIN}-{NNN}: {Title}

**Intent:** {one paragraph, 1-4 sentences. No bullets, no headings, no code blocks.}

**Applies To:** {single actor name — User, Admin, etc. Never "System".}

**Acceptance Criteria:**

1. {first AC, single behavioural statement, <=150 words}
2. {second AC}
3. {...up to 7 maximum}

**Constraints:** [CON-X-NNN](constraints.md#con-x-nnn-title-slug), [CON-Y-NNN](constraints.md#con-y-nnn-title-slug)

**Priority:** P0 | P1 | P2 | P3

**Dependencies:** [REQ-X-NNN](#req-x-nnn-title-slug), [REQ-Y-NNN](other-domain.md#req-y-nnn-title-slug)

**Verification:** Automated test | Integration test | Manual check

**Status:** Proposed | Planned | Partial | Implemented

---
```

**Required fields, always present:**
- **Intent**, **Applies To**, **Acceptance Criteria**, **Priority**, **Verification**, **Status** — always populated.
- **Constraints**, **Dependencies** — always present. Render `None.` (literal) when empty. A REQ missing these fields entirely is MEDIUM `req-missing-required-field`.

**ACs are numbered** (`1.`, `2.`, `3.`), never bulleted. Bulleted ACs are MEDIUM `ac-bullets-not-numbered`, auto-fixed.

**Each labeled field is on its own line**, separated by a single blank line. Stacking Priority/Dependencies/Verification/Status on consecutive lines without blank-line separation collapses them into one rendered paragraph on GitHub — MEDIUM `trailing-fields-collapsed`.

**Cross-references render as markdown anchor links**, not plain text. Plain-text REQ-* or CON-* IDs inside `**Constraints:**` or `**Dependencies:**` are MEDIUM `cross-reference-not-linked`, auto-fixed.

**Notes** is OPTIONAL — only two shapes (see `spec-enforce` § Rule B): Partial-explanation (`Status: Partial` only, ≤3 sentences) or Doc-pointer (any status, ≤2 sentences, MUST contain a markdown link to `documentation/**` or `sdd/**`). Sibling-REQ cross-references go in `Dependencies:`.

**Deprecated REQs are deleted, not tombstoned.** No `Replaced By:` field, no `Removed In:` field. Out-of-scope ideas go to `## Out of Scope` in the domain README.

## Status semantics

| Status | Meaning |
|---|---|
| `Proposed` | Being drafted, not yet committed to spec |
| `Planned` | Committed to spec, not yet built |
| `Partial` | Built but some AC unmet OR no automated test verification found |
| `Implemented` | Built AND tests verify the acceptance criteria |

**One word, no prose.** No commit SHAs, no file paths, no "Partial — missing X, Y, Z". Use the optional `Notes:` field (≤3 sentences) for Partial only. Use `pending.md` for implementation tracking.

**Default Status when source exists but no test references the REQ ID:**
- `enforce_tdd: true` → `Partial`.
- `enforce_tdd: false` → `Implemented` (opted out of test-based verification; demoting every REQ would falsely brand the spec incomplete). Each `sdd/{domain}.md` file (per domain, not `sdd/README.md`) appends `_Verification: code-only (no automated coverage)._` at the bottom when this branch fires.

**Removed and never-built REQs.** When a REQ stops being the contract — feature removed, replaced, scope dropped — delete it from `sdd/{domain}.md`. Do not tombstone with `Status: Deprecated`. Never-built ideas go to `## Out of Scope`.

## Three autonomy modes

| Behavior | interactive | auto | unleashed |
|---|---|---|---|
| Where work lands | Current branch | Current branch | Current branch |
| SAFE fixes (strip strikethrough, truncate prose Status, generate backlinks, move forbidden content) | Confirm → apply | Apply silently | Apply silently |
| RISKY fixes (truncate changes.md, mass moves, bulk operations) | Confirm + backup + apply | Backup + apply | Backup + apply |
| JUDGMENT calls (doc-vs-spec conflict, oversized REQ, fake-Deprecated) | Escalate to user, pause | Escalate to `sdd/.review-needed.md`, continue | Auto-resolve conservatively, continue |
| `enforce_tdd` default | per `sdd/config.yml` (default true) | per `sdd/config.yml` (default true) | **Forced true** |
| Output | Inline confirmations | Inline reports | Inline reports; per-category commits |

The fundamental difference is **how JUDGMENT is handled**. All modes push to the current branch. No PR, no new branch, no artificial change limits.

Conservative JUDGMENT auto-resolution rules live in the `sdd-clean` skill (that's where they apply).

## Auto-detection — when SDD enforcement runs without /sdd

Once `sdd/` exists, the workflow runs automatically:

- At PR-boundary events for PRs targeting `main` or `master` (PR open OR push to a branch with such a PR open): `code-reviewer` runs in parallel; `spec-reviewer` runs first, then `doc-updater` (sequential, never parallel).
- Both `sdd/`-lane agents detect `sdd/` exists → SDD-strict mode.
- Both agents read `sdd/config.yml` → know whether to be interactive/auto/unleashed.
- Findings are auto-fixed per mode.

If `sdd/` doesn't exist, `spec-reviewer` exits silently. `doc-updater` runs in `docs-only` mode.

**SDLC requirements for autonomous review:** the pipeline gates on PR base = `main` or `master`. PRs into intermediate integration branches (`develop`, `staging`) are deferred until the integration branch's PR-to-`main` opens or syncs. Trunk-based projects using a different default branch name get no review (v1 hardcoded gate). `gh` CLI must be installed + authenticated. Upstream tracking on the working branch must resolve (`git rev-parse @{u}`). Strongly recommended: GitHub branch protection on `main` requiring PR before merge.

The hooks fail-safe in the right direction: if `gh` is missing or transiently fails, the Stop hook errs toward enforcement; the PostToolUse directive errs toward emission. Either way, the user can invoke review agents manually via the Task tool.

## /sdd edit — adding or modifying requirements

Always interactive. The agent:
1. Reads `sdd/README.md`, `sdd/constraints.md`, `sdd/glossary.md`, and the target domain file.
2. Asks the user what they want to add or change.
3. Drafts new/modified REQs in proper format.
4. Validates against discipline rules (forbidden content, length, AC quality).
5. Confirms with user.
6. Writes the updated domain file.
7. Updates glossary if new terms were introduced.
8. Adds a changelog entry to `sdd/changes.md`.

User-authored content gets one full pass before LOW-severity cleanup applies. Agent never blocks user input on style grounds.

**Post-edit hard gate:** if the new/modified REQ is `Planned` or `Partial`, next action MUST be entering Plan Mode (see § Plan Mode integration).

## /sdd add — creating a new domain

Same as `/sdd edit` but creates a new domain file:
1. Asks the user what the domain covers.
2. Proposes 5-15 initial requirements.
3. Creates `sdd/{domain}.md`.
4. Updates the domain index in `sdd/README.md`.
5. Updates glossary and changelog.

**Post-add hard gate:** enter Plan Mode before any source/test/config edits.

## /sdd mode — switching autonomy

```bash
/sdd mode interactive   # default; agent asks before every fix
/sdd mode auto          # agent silently applies safe fixes
/sdd mode unleashed     # agent does everything without asking
/sdd mode               # show current mode
```

The setting is persistent in `sdd/config.yml` and travels with the project. Per-command overrides via `--interactive`, `--auto`, `--unleashed` flags on `/sdd clean`.

**Transition gate on `unleashed`:** `/sdd mode unleashed` is rejected while `sdd/config.yml` carries `transition: true` (open triage items). Unleashed runs blind and auto-resolves JUDGMENT; triage items need user judgment by construction. Drain the queue via Resume Mode first. `auto` and `interactive` are both allowed during transition.

## Test discipline

Every REQ marked `Status: Implemented` should have at least one test file that references its REQ ID. Test discovery uses `test_globs` from `sdd/config.yml`. Detection is binary: the REQ ID literally appears in a test (in a test name, comment, or assertion message).

**Why REQ IDs in test files:** lets `spec-reviewer` verify which Implemented REQs have automated coverage without ambiguous prose matching.

```typescript
test('REQ-AUTH-001: rejects expired JWT tokens', () => {
  // ...
});
```

When `enforce_tdd: true` (default), REQs without test references get downgraded to `Partial` with `Notes:`, and REQs whose source exists but lacks tests get flagged + auto-promoted `Planned → Partial`. Projects that genuinely cannot admit automated testing (pure visual design systems) opt out with `enforce_tdd: false`.

**Bug fix discipline:** write a failing test that reproduces the bug BEFORE writing the fix. The `tdd-guide` agent enforces this.

## TDD coverage targets

Recommended defaults, configurable per project:

| Layer | Target |
|---|---|
| Pure functions / utilities | 100% |
| API routes / handlers | 100% |
| Component rendering | 80% |
| Page-level integration | 80% |
| Default | 70% |

Guidance, not enforcement. The auto-demote rule is the only hard enforcement (binary: test exists per REQ or it doesn't).

## Plan Mode integration

**Plan Mode is mandatory on every spec→code transition:** after `/sdd init`, `/sdd edit` (if new REQ is `Planned`/`Partial`), or `/sdd add`. Next action MUST be `EnterPlanMode`. Hard gate. "build now" / "go" / "execute" / "ship it" authorize *starting*, never skipping.

The plan must:
1. Read all of `sdd/`, enumerate REQs by Status.
2. Filter to `Status: Planned` and `Status: Partial`.
3. Topo-sort by `Dependencies:`.
4. **Phase RED**: one failing test per AC via `tdd-guide`. Test name: `REQ-{DOMAIN}-{NNN}: {AC summary}`.
5. **Phase GREEN**: minimal impl, one REQ at a time, in dependency order.
6. **Phase VERIFY**: push, let `spec-reviewer` promote `Planned`→`Implemented` on next run.
7. Name the test framework from the stack (vitest, jest, pytest, go test, rspec, xctest, etc.); add Phase 0 if none exists.

**Informal proposal ≠ formal Plan Mode.** A detailed prose proposal + user "execute" / "go" / "fine" is *informal* approval. Still enter Plan Mode and re-present the same plan as a formal artifact.

**Legitimate skip:** only if the user, after seeing a plan proposal, explicitly says "skip plan mode" or "no plan". Record in feedback memory. Mark affected REQs `Partial` until tests exist.

## What is NOT a requirement

- **Bugs** → GitHub issues. The spec describes target state; bugs are the delta.
- **TODOs / known gaps** → `pending.md`. Status: Partial flags incompleteness; prose detail there.
- **Spec churn / "we tried X then Y"** → git history. No strikethrough or "Superseded:" annotations.
- **Build environment quirks** → `documentation/troubleshooting.md`.
- **Out-of-scope ideas** → `## Out of Scope` section in the relevant README.

## Templates location

All scaffolding templates live in `references/templates/` within this skill. The `sdd-init` skill reads them on demand. Bundled with the skill — no external dependencies.

| Template | Used by |
|---|---|
| `root-readme.md` | `/sdd init` → `README.md` |
| `sdd-readme.md` | `/sdd init` → `sdd/README.md` |
| `sdd-glossary.md` | `/sdd init` → `sdd/glossary.md` |
| `sdd-constraints.md` | `/sdd init` → `sdd/constraints.md` |
| `sdd-changes.md` | `/sdd init` → `sdd/changes.md` |
| `sdd-config.yml` | `/sdd init` → `sdd/config.yml` |
| `documentation-readme.md` | `/sdd init` → `documentation/README.md` |
| `documentation-architecture.md` | `/sdd init` → `documentation/architecture.md` |
| `documentation-api-reference.md` | `/sdd init` → `documentation/api-reference.md` |
| `documentation-configuration.md` | `/sdd init` → `documentation/configuration.md` |
| `documentation-deployment.md` | `/sdd init` → `documentation/deployment.md` |
| `documentation-decisions-readme.md` | `/sdd init` → `documentation/decisions/README.md` |

Placeholders use `{PLACEHOLDER_NAME}` format. The agent substitutes them based on the user's input and inferred context.

## Template conventions

Templates follow `documentation-discipline.md` from the first commit. Conventions baked in:

- **One-line table cells.** Every cell stays on a single line; the 50-word per-cell budget enforced by `doc-updater` Pass 1 begins at scaffolding. If a row needs more than ~50 words, write the long form as a body paragraph below the table and replace the cell with a one-line summary + link.
- **Embedded doc-discipline directive comments.** Each template starts with `<!-- doc-discipline: <budget> lines, one-line table cells, no implementation prose -->`.
- **Per-file budgets** match `documentation-discipline.md`: architecture.md ≤350 lines, api-reference.md ≤600, configuration.md ≤200, deployment.md ≤200.
- **REQ backlinks pre-wired** in `Implements` columns: scaffolded with the exact `[REQ-X-N](../sdd/{domain}.md#req-x-n)` form.
- **Lane-correct content placeholders.** `architecture.md` template never has an "API endpoints" section (that's `api-reference.md`'s lane).
- **ADR template carries the "What is NOT an ADR" guardrail.** `documentation-decisions-readme.md` opens with the four-shape table (SAST false positive / naming-compat / risk acceptance with no alternative / implementation note framed as a decision). The AD1 example includes `Alternatives considered:` and `Consequences:` — both load-bearing.
