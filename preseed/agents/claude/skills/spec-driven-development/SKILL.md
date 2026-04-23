---
name: spec-driven-development
description: Specification-driven development reference. Defines the structure and rules for product specifications, the three autonomy modes (interactive/auto/unleashed), and the workflow for greenfield projects, ongoing development, and rescuing rotted specs. Invoked via the /sdd command.
version: 4.0.0
---

# Spec-Driven Development

A product specification (`sdd/`) is the single source of truth for **what the product does and why**. It is not a record of what the code currently does. It is not a bug tracker. It is not a changelog of every commit.

The full enforcement layer lives in the `spec-discipline` rule which is loaded into every agent's instructions automatically (inlined into the always-loaded instructions file for non-Claude agents, or read directly from `~/.claude/rules/spec-discipline.md` for Claude). The rules are already in your context. This skill describes the workflow on top of those rules.

## How it works at a glance

The user runs `/sdd init` once to bootstrap. After that, they "vibe code" — write code, push, walk away. The `spec-reviewer` and `doc-updater` agents auto-detect the `sdd/` folder and enforce discipline on every push, in the mode set by `sdd/config.yml` (`interactive`, `auto`, or `unleashed`).

The user only invokes `/sdd` directly to:
- Bootstrap a new project (`/sdd init`)
- Manually add or modify requirements (`/sdd edit`, `/sdd add`)
- Rescue a rotted spec (`/sdd clean`)
- Switch autonomy mode (`/sdd autonomous`)

## Spec structure

```
sdd/
├── README.md            # Vision, principles, actors, domain index, "Out of Scope" section
├── glossary.md          # Canonical term definitions
├── constraints.md       # Technology stack, cross-cutting CON-* constraints
├── changes.md           # Semantic changelog (≤2 sentences per entry, user-facing only)
├── config.yml           # mode, enforce_tdd, test_globs, src_globs (optional), allowlists
├── .user-overrides.md   # Findings the user explicitly told the agent to skip (committed)
├── .review-needed.md    # Findings escalated for human review (committed, cleared on resolution)
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

```markdown
### REQ-{DOMAIN}-{NNN}: {Title}

**Intent:** {Why this exists — the problem, not the solution.}

**Applies To:** {Actor — User, Admin, etc. Not "System" — that's a qualifier.}

**Acceptance Criteria:**
1. {Testable, binary pass/fail}
2. {Another}

**Constraints:** CON-* references where applicable

**Priority:** P0 | P1 | P2 | P3
**Dependencies:** REQ-*-* | None
**Verification:** Automated test | Integration test | Manual check
**Status:** Proposed | Planned | Partial | Implemented | Deprecated
**Notes:** {Optional, only valid for Partial status, ≤3 sentences explaining what's missing}
**Replaced By:** REQ-*-* {Required for Deprecated status}
**Removed In:** YYYY-MM-DD {Alternative for Deprecated when no replacement REQ exists}
```

## Status semantics

| Status | Meaning |
|---|---|
| `Proposed` | Being drafted, not yet committed to spec |
| `Planned` | Committed to spec, not yet built |
| `Partial` | Built but some AC unmet OR no automated test verification found |
| `Implemented` | Built AND tests verify the acceptance criteria |
| `Deprecated` | Was implemented, then removed or replaced. Requires `Replaced By:` or `Removed In:` field. |

**One word, no prose.** The Status field cannot contain commit SHAs, file paths, or "Partial — missing X, Y, Z" notes. Use the optional `Notes:` field (≤3 sentences) for Partial status only. Use `pending.md` for implementation tracking.

**Never-built REQs** that the team decided to skip should NOT be marked Deprecated. Move them to the `## Out of Scope` section in the relevant domain file or `sdd/README.md`. This preserves the decision history without bloating the active spec.

## Three autonomy modes

| Behavior | interactive | auto | unleashed |
|---|---|---|---|
| Where work lands | Current branch | Current branch | Current branch |
| SAFE fixes (strip strikethrough, truncate prose Status, generate backlinks, move forbidden content) | Confirm → apply | Apply silently | Apply silently |
| RISKY fixes (truncate changes.md, mass moves, bulk operations) | Confirm + backup + apply | Backup + apply | Backup + apply |
| JUDGMENT calls (doc-vs-spec conflict, oversized REQ, fake-Deprecated) | Escalate to user, pause | Escalate to `sdd/.review-needed.md`, continue | **Auto-resolve conservatively** (rules below), continue |
| `enforce_tdd` default | per `sdd/config.yml` (default true) | per `sdd/config.yml` (default true) | **Forced true** |
| Output | Inline confirmations | Inline reports | Inline reports; per-category commits |

The fundamental difference: **how JUDGMENT is handled**, nothing else. All modes push to the current branch. No PR, no new branch, no artificial change limits.

### Conservative JUDGMENT auto-resolution (unleashed only)

When unleashed mode encounters a JUDGMENT call, it never picks a winner that overwrites intent:

| JUDGMENT type | Conservative resolution |
|---|---|
| Doc-vs-spec conflict | Mark BOTH the REQ and the related doc as `Status: Partial` with `Notes:` describing the conflict. Log to `sdd/.review-needed.md`. **Never overwrite either side.** |
| Oversized REQ refactor | Shrink in place — extract implementation prose to `documentation/{relevant-file}.md` and leave Intent + AC bullets verbatim in the REQ. **Never split into multiple REQs.** |
| Fake-Deprecated REQ (no Replaced By) | Move REQ definition to README's `## Out of Scope` section, remove from domain file. Content preserved. |
| Truly ambiguous content | Mark as `Partial` with `Notes:`, log to `sdd/.review-needed.md`. |

The user comes back to new commits on the current branch. They inspect the per-category commits and `sdd/.review-needed.md`, and can `git revert <sha>` per-category if any change is unwanted. No PR, no merge step — commits land directly where the user pushed from.

## Sub-commands

| Command | Purpose |
|---|---|
| `/sdd` | Help screen — overview, modes, sub-commands, autodetection behavior |
| `/sdd init [idea]` | Bootstrap a new project: `sdd/`, `documentation/`, root `README.md`, `tests/`, `sdd/config.yml` |
| `/sdd edit {domain}` | Add or modify requirements in an existing domain (interactive, always needs user input) |
| `/sdd add {domain}` | Create a new domain in an existing spec |
| `/sdd clean` | Refactor a rotted spec — applies SAFE/RISKY/JUDGMENT fixes per current mode |
| `/sdd autonomous {on\|off\|unleashed}` | Set the mode in `sdd/config.yml` |

The full command syntax is documented in the `/sdd` command file.

## Auto-detection — when SDD enforcement runs without /sdd

Once `sdd/` exists in a project, the workflow runs automatically without explicit `/sdd` invocation:

- After every git push, the `spec-reviewer` agent runs (sequentially, then `doc-updater`)
- Both agents detect `sdd/` exists → enter SDD-strict mode
- Both agents read `sdd/config.yml` → know whether to be interactive/auto/unleashed
- Findings are auto-fixed per the mode

If `sdd/` doesn't exist, `spec-reviewer` exits silently. `doc-updater` runs in `docs-only` mode (project-agnostic doc maintenance, no spec coordination).

## /sdd init — bootstrapping a project (greenfield OR existing codebase)

`/sdd init` handles two scenarios:

1. **Greenfield**: empty project, no existing code. Agent bootstraps from prose.
2. **Existing codebase**: project already has source code. Agent enters **import mode** — analyzes the existing code, derives a spec from observed behavior, presents it for user confirmation, and writes the scaffolding.

The agent detects the scenario automatically by counting source files in the project. >5 source files → existing codebase → import mode. ≤5 → greenfield.

In **import mode**, the agent:
- Reads README.md, package.json (or equivalent), top-level configs to understand intent
- Analyzes directory structure to identify domains
- Reads representative source files to derive REQs
- Tentatively marks all derived REQs as `Status: Implemented`
- Searches existing test files for feature/route names; demotes REQs without test coverage to `Partial` with `Notes:` explaining what's missing
- Presents derived spec for user confirmation, one domain at a time
- Writes scaffolding (sdd/, documentation/, root README) WITHOUT touching existing code, existing README, or existing documentation/ files

Import mode is **always interactive** even in `auto` or `unleashed` config — inferring intent from code is genuinely judgment-required and the user must validate the result.

In **greenfield mode**, the agent:

1. **Drafts the vision** from the user's prose, presents for confirmation
2. **Proposes actors** (typically User, Admin — never "System")
3. **Maps the user journey** by asking one question, then proposes domains
4. **Drafts requirements** for each domain (5-15 per domain), confirms one domain at a time
5. **Drafts constraints** with CON-* IDs
6. **Writes the spec scaffolding** by reading and instantiating templates from `references/templates/`:
   - `root-readme.md` → `README.md` (project root)
   - `sdd-readme.md` → `sdd/README.md`
   - `sdd-glossary.md` → `sdd/glossary.md`
   - `sdd-constraints.md` → `sdd/constraints.md`
   - `sdd-changes.md` → `sdd/changes.md`
   - `sdd-config.yml` → `sdd/config.yml` (mode: interactive by default)
   - `documentation-readme.md` → `documentation/README.md`
   - `documentation-architecture.md` → `documentation/architecture.md`
   - `documentation-api-reference.md` → `documentation/api-reference.md`
   - `documentation-configuration.md` → `documentation/configuration.md`
   - `documentation-deployment.md` → `documentation/deployment.md`
   - `documentation-decisions-readme.md` → `documentation/decisions/README.md`
7. **Creates `tests/` folder** (empty, ready for the user to populate with TDD)
8. **Substitutes placeholders** like `{PROJECT_NAME}`, `{ACTOR_1}`, `{INSTALL_COMMAND}` with values inferred from the user's idea
9. **Reports next steps** to the user

The agent does not need internet access — all templates are bundled in `references/templates/`.

If `sdd/` already exists, `/sdd init` aborts with an error. Use `--force` to overwrite (destructive — confirm with user first).

### Dependency version resolution

When `/sdd init` generates a package manifest (`package.json`, `Cargo.toml`, `requirements.txt`, `go.mod`, etc.), NEVER emit memorized version ranges. Resolve each top-level dependency to its current latest stable via the ecosystem's metadata query tool:

| Ecosystem | Version query | Lockfile generation (scaffold-only carveout) |
|---|---|---|
| npm | `npm view <pkg> version` + `npm view <pkg> peerDependencies` | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` |
| Cargo | `cargo search <crate> --limit 1` | `cargo generate-lockfile` |
| Python | `pip index versions <pkg>` | `uv lock` or `pip-compile` |
| Go | `go list -m -versions <module>` | `go mod tidy` |

For Cloudflare Workers projects, see `cloudflare-stack` SKILL → § Cloudflare cohort pinning — the 4-pack (wrangler + workers-types + vitest-pool-workers + vitest) must be resolved together before writing `package.json`.

Process (npm example):
1. For each proposed dependency, run `npm view <pkg> version` → capture latest
2. Run `npm view <pkg> peerDependencies` → capture peer constraints
3. Cross-check peer ranges: if two packages disagree, drop one to the highest co-compatible version rather than picking the latest of both
4. Emit specific caret ranges: `^5.14.0`, never `^5.0.0` from memory
5. Write `package.json`
6. Run the lockfile generator ONCE (scaffold-only carveout — see below)
7. Commit both manifest and lockfile

**Local CPU carveout (`/sdd init` scaffold only):** the `no-local-builds` rule forbids local installs/builds/tests on this 1-vCPU container. The lockfile generator is a one-time exception because (a) CI's `npm ci` requires a committed lockfile, (b) Dependabot baseline needs a deterministic starting point, and (c) the operation is resolution-only with `--ignore-scripts` (no `node_modules` population, no script execution, no build step; the npm cache may fetch tarballs for integrity hashing). This carveout applies ONLY during `/sdd init`. Every other local install/build/test remains forbidden.

**Forbidden at scaffold time:** `npm install` (full), `npm test`, `npm run build`, `tsc`, `cargo build`, `cargo test`, any test runner, any bundler.

## /sdd clean — rescuing a rotted spec

`/sdd clean` is the rescue command for projects whose spec has accumulated implementation leakage, fake deprecations, prose Status fields, oversized REQs, and bloated changelogs.

### What it does (per mode)

In **interactive** mode: reports findings batch-by-batch, asks for confirmation before applying.

In **auto** mode: applies SAFE and RISKY fixes silently on the current branch. JUDGMENT items go to `sdd/.review-needed.md`.

In **unleashed** mode: applies SAFE + RISKY + JUDGMENT fixes on the current branch (using conservative defaults for JUDGMENT), commits per category, pushes directly. No new branch, no PR. `enforce_tdd: true` is forced. The commits land where the user pushed from.

### Safety nets

In all modes:
- **Working tree must be clean** before running (refuses if `git status --porcelain` is non-empty)
- **Backup files** are created before any RISKY operation (e.g., `sdd/changes.md` → `sdd/changes-archive-YYYY-MM.md`)
- **Per-category commits** for selective revert
- **`[sdd-clean]` commit tag** that bypasses round-detection in spec-reviewer
- **Sequential execution** (spec-reviewer first, then doc-updater)

In `auto` mode specifically:
- Refuses to run on `main` or `master` without `--branch-confirmed`

In `unleashed` mode specifically:
- Pushes commits directly to the current branch (no new branch, no PR)
- Refuses to run on `main`/`master` without `--branch-confirmed`
- Each commit is per-category and tagged `[sdd-clean]` — `git revert <sha>` is the rollback surface
- Full audit log lives in `sdd/.last-clean-run.md` + the per-category commit messages

### What gets cleaned

- **Strikethrough text** in REQs → stripped (git history is the strikethrough)
- **Prose Status fields** (multi-line status notes) → truncated to one word, prose moved to `pending.md` or to `Notes:` field for `Partial` status
- **Implementation leakage** in REQs (hex codes, CSS classes, file paths, function names, env vars, etc.) → moved to appropriate `documentation/` files
- **Fake-Deprecated REQs** (Deprecated without `Replaced By:`) → moved to `## Out of Scope` section in domain README (interactive/auto/unleashed: see escalation rules)
- **Oversized REQs** (>50 lines) → flagged; in unleashed mode, implementation prose extracted to docs while Intent + AC stay verbatim
- **Bloated `changes.md`** (verification log entries, commit SHAs, multi-paragraph entries) → archived to `sdd/changes-archive-YYYY-MM.md`, new file written with user-facing entries only
- **Status: Implemented REQs without test coverage** → if `enforce_tdd: true`, demoted to `Partial` with `Notes:` explaining what's missing; if `enforce_tdd: false`, written to `sdd/.coverage-report.md` only
- **Status: Planned/Partial REQs with source code but no test** → if `enforce_tdd: true`, HIGH finding + auto-promote `Planned → Partial` with `Notes:` (requires the `Implements REQ-X-NNN` annotation convention in source files — see `spec-discipline.md` → Source code ↔ REQ annotations)
- **Test quality heuristics** → AC-count vs test-count check, tautology detection, skipped-test detection (all run when `enforce_tdd: true`)
- **Missing doc→spec backlinks** → generated automatically (links from `documentation/` files to relevant REQ IDs)

## /sdd edit — adding or modifying requirements

Always interactive. The agent:
1. Reads `sdd/README.md`, `sdd/constraints.md`, `sdd/glossary.md`, and the target domain file
2. Asks the user what they want to add or change
3. Drafts new/modified REQs in proper format
4. Validates against the discipline rules (forbidden content, length, AC quality)
5. Confirms with user
6. Writes the updated domain file
7. Updates glossary if new terms were introduced
8. Adds a changelog entry to `sdd/changes.md`

User-authored content gets one full pass before LOW-severity cleanup applies. The agent never blocks user input on style grounds.

## /sdd add — creating a new domain

Same as `/sdd edit` but creates a new domain file. The agent:
1. Asks the user what the domain covers
2. Proposes 5-15 initial requirements
3. Creates `sdd/{domain}.md`
4. Updates the domain index in `sdd/README.md`
5. Updates glossary and changelog

## /sdd autonomous — switching modes

```bash
/sdd autonomous on              # mode = auto (writes to sdd/config.yml)
/sdd autonomous unleashed on    # mode = unleashed
/sdd autonomous off             # mode = interactive
/sdd autonomous status          # show current mode + recent overrides
```

The setting is persistent (committed to git as `sdd/config.yml`) and travels with the project. Per-command overrides via `--interactive`, `--auto`, `--unleashed` flags on `/sdd clean`.

## Test discipline

Every REQ marked `Status: Implemented` should have at least one test file that references its REQ ID. Test discovery uses `test_globs` from `sdd/config.yml`. Detection is binary: the REQ ID literally appears in a test (in a test name, comment, or assertion message).

**Why REQ IDs in test files**: this lets `spec-reviewer` verify which Implemented REQs have automated coverage without ambiguous prose matching. Test naming convention example:

```typescript
test('REQ-AUTH-001: rejects expired JWT tokens', () => {
  // ...
});
```

When `enforce_tdd: true` (the default), REQs without test references get downgraded to `Partial` with a `Notes:` field, and REQs whose source code exists but lacks tests get flagged and auto-promoted `Planned → Partial`. Source code must annotate each REQ it implements with a comment like `Implements REQ-X-NNN` so spec-reviewer has something concrete to grep (see `spec-discipline.md` → Source code ↔ REQ annotations). Projects that genuinely cannot admit automated testing (pure visual design systems, for example) can opt out with `enforce_tdd: false`.

**Bug fix discipline**: when fixing a bug, write a failing test that reproduces it BEFORE writing the fix. The test proves the bug exists and proves the fix works. The `tdd-guide` agent enforces this proactively.

## TDD coverage targets

These are recommended defaults, configurable per project in `sdd/config.yml`:

| Layer | Target |
|---|---|
| Pure functions / utilities | 100% |
| API routes / handlers | 100% |
| Component rendering | 80% |
| Page-level integration | 80% |
| Default | 70% |

These are guidance, not enforcement. The auto-demote rule is the only hard enforcement (binary: test exists per REQ or it doesn't).

## Plan Mode integration

**Plan Mode is mandatory on every spec→code transition**: after `/sdd init`, `/sdd edit` (if new REQ is `Planned`/`Partial`), or `/sdd add`. Next action MUST be entering Plan Mode (Claude Code: `EnterPlanMode`; other agents: the equivalent planning primitive). Hard gate. "build now" / "go" / "execute" / "ship it" / "just do it" authorize *starting*, never skipping.

The plan must:
1. Read all of `sdd/`, enumerate REQs by Status
2. Filter to `Status: Planned` and `Status: Partial`
3. Topo-sort by `Dependencies:`
4. **Phase RED**: one failing test per AC via `tdd-guide`. Test name: `REQ-{DOMAIN}-{NNN}: {AC summary}`
5. **Phase GREEN**: minimal impl, one REQ at a time, in dependency order
6. **Phase VERIFY**: push, let `spec-reviewer` promote `Planned`→`Implemented` on next run
7. Name the test framework from the stack (vitest, jest, pytest, go test, rspec, xctest, etc.); add Phase 0 if none exists

**Informal proposal ≠ formal Plan Mode.** A detailed prose proposal + user "execute" / "go" / "fine" is *informal* approval. Still enter Plan Mode and re-present the same plan as a formal artifact. Treating "execute" as plan approval when no formal plan exists is the trap that breaks SDD.

**Legitimate skip**: only if the user, after seeing a plan proposal, explicitly says "skip plan mode" or "no plan". Record in a feedback memory. Mark affected REQs `Partial` (not `Implemented`) until tests exist. "build now" / "go" / "execute" never count.

## What is NOT a requirement

- **Bugs** → GitHub issues. The spec describes the target state; bugs are the delta.
- **TODOs / known gaps** → `pending.md` at repo root. Status field can say `Partial` to flag, but prose details go in `pending.md`.
- **Spec churn / "we tried X then Y"** → git history. Don't preserve via strikethrough or "Superseded:" annotations.
- **Build environment quirks** → `documentation/troubleshooting.md`. Operational notes, not requirements.
- **Out-of-scope ideas** → `## Out of Scope` section in the relevant README. Decisions, not requirements.

## Templates location

All scaffolding templates are in `references/templates/` within this skill. The agent reads them on demand during `/sdd init`. They are bundled with the skill — no external dependencies.

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

Placeholders use `{PLACEHOLDER_NAME}` format. The agent substitutes them based on the user's input and inferred context (project name, language, framework, etc.).
