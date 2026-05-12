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
- Switch autonomy mode (`/sdd mode`)

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
| `/sdd mode {interactive\|auto\|unleashed}` | Set the mode in `sdd/config.yml` |

The full command syntax is documented in the `/sdd` command file.

## Auto-detection — when SDD enforcement runs without /sdd

Once `sdd/` exists in a project, the workflow runs automatically without explicit `/sdd` invocation:

- At PR-boundary events for PRs targeting `main` or `master` (PR open or push to a branch with such a PR open), `code-reviewer` runs in parallel; `spec-reviewer` runs first then `doc-updater` runs second (sequential, never parallel)
- Both `sdd/`-lane agents detect `sdd/` exists → enter SDD-strict mode
- Both agents read `sdd/config.yml` → know whether to be interactive/auto/unleashed
- Findings are auto-fixed per the mode

If `sdd/` doesn't exist, `spec-reviewer` exits silently. `doc-updater` runs in `docs-only` mode (project-agnostic doc maintenance, no spec coordination).

### SDLC requirements for autonomous review

The review pipeline is gated on **PR base = `main` or `master`**. PRs into intermediate integration branches (`develop`, `staging`, etc.) are deferred until the integration branch's own PR-to-`main` opens or syncs, where a single cumulative review covers everything that landed.

To get autonomous review on a project, ensure:

1. The repo has a `main` (or `master`) branch as the eventual merge target. Trunk-based projects using a different default branch name (e.g., `trunk`) get **no review**: the hardcoded gate is a v1 trade-off, configurable later if real demand surfaces.
2. PRs are opened against `main`/`master`, either directly (`feature → main`) or transitively (`feature → develop → main`, where the `develop → main` PR is what triggers review).
3. `gh` CLI is installed and authenticated for the GitHub remote (the hooks call `gh pr view <branch> --json state,headRefOid,baseRefName`).
4. Upstream tracking is set on the working branch — `git rev-parse @{u}` must resolve. Vanilla `git clone <url>` sets this up automatically. Manual `git checkout -B <branch>` without `--track` does not; repair once with `git branch --set-upstream-to=origin/<branch> <branch>`.
5. Strongly recommended: GitHub branch protection on `main` requiring PR before merge. Direct pushes to `main` are silently outside the trigger model — the platform layer is the only structural defense.

The hooks fail-safe in the right direction: if `gh` is missing or transiently fails, the Stop hook errs toward enforcement (better to over-block on uncertain truth than miss an unreviewed PR-to-main); the PostToolUse directive errs toward emission. Either way, the user can always invoke review agents manually via the `Task` tool.

## /sdd init — bootstrapping a project (greenfield, import, or resume)

`/sdd init` handles three scenarios:

1. **Greenfield**: empty project, no existing code. Agent bootstraps from prose.
2. **Import**: project already has source code, no `sdd/` yet. Agent enters **Import Mode** — derives a spec where behavior is clear from source/tests/comments/commits, files the unclear parts to `sdd/init-triage.md` with concrete Context + Recommendation, and writes the scaffolding.
3. **Resume**: `sdd/` already exists and `sdd/init-triage.md` has `**Status:** open` items. Agent enters **Resume Mode** — surfaces one open triage item at a time with refreshed Context + Recommendation, the user accepts/corrects/marks-lost, the answer folds into the relevant REQ.

The agent detects the scenario automatically — source-file count for greenfield-vs-import, presence of open triage items for resume.

### Import Mode — two-output model

Import Mode is the migration path from legacy manual coding to autonomous agentic coding. It produces two outputs simultaneously:

- **Official spec REQs** in `sdd/{domain}.md` — for behavior that is clearly determinable from the full discovery surface. Normal REQ shape, normal SDD discipline.
- **Triage entries** in `sdd/init-triage.md` — for anything unclear (magic numbers without rationale, retry policies without context, ambiguous contracts, orphan code, missing Intent). Each entry carries the agent's **Context** (file:line, git author, commit refs, related tests, PRs, issues, releases, comments) and **Recommendation** (best-guess answer with one-line Rationale). The user reviews and decides; they don't perform archaeology from scratch.

**Discovery surface is the full project history, not just source code.** Intent in legacy systems often lives outside the working tree - in PR descriptions, issue threads (open and closed), code-review comments, and release notes. Import Mode pulls every available source: working tree (README, configs, source, tests, inline comments, ADRs), git history (commits, tags), and the GitHub corpus when a remote is present (PRs with review comments via `gh pr view --comments`, issues with comments via `gh issue view --comments`, releases via `gh release view`, wiki via the API). When a PR references an issue ("Closes #142"), Context follows the chain backward through every linked artifact rather than stopping at the first hit.

**Degradation when GitHub sources are unreachable.** The GitHub corpus is best-effort, not mandatory. Detect failure conditions up front (non-GitHub remote - GitLab / Bitbucket / Forgejo / Gerrit; `gh auth status` fails; rate-limited; private repo with insufficient token scope; air-gapped network). If any condition holds, skip the GitHub sources entirely and proceed with working-tree + git-log evidence only. Print a one-line notice to the user before scaffolding (`Note: discovery used working tree + git log only ({reason} - GitHub sources unavailable).`) and append the same notice to the `sdd/changes.md` import entry. Triage Context fields reference whatever artifact refs are reachable; the audit trail honestly reflects what the agent saw.

While `sdd/init-triage.md` contains any `**Status:** open` items, the project is in **SDD transition**. `sdd/config.yml` carries `transition: true`. During transition, the PR-boundary review pipeline is **entirely suspended**: code-reviewer, spec-reviewer, and doc-updater do not fire on any push or PR event. PostToolUse + Stop hooks short-circuit. `/sdd mode unleashed` is rejected.

When the queue drains to zero (every item `resolved` or `lost`), `transition: true` clears automatically. Full SDD discipline applies on the next push and autonomous agentic development is unlocked. `enforce_tdd` is NOT auto-flipped - the user sets it manually when ready (typically after adding REQ-ID references to test names in the imported source). `sdd/init-triage.md` is preserved as the audit record.

Import Mode writes CLEAR REQs to `sdd/{domain}.md` files automatically, without user confirmation. The agent's confidence threshold (single matching domain, unambiguous behavior, clear evidence in code/PRs/tests) is the gate; anything below it becomes a triage entry. Only the triage queue surfaces unclear/ambiguous items for user judgment, one at a time in Resume Mode. To correct any CLEAR REQ after import, the user runs `/sdd edit {domain}`.

### Resume Mode — picking up where you left off

When `/sdd init` is re-invoked on a project where `sdd/init-triage.md` has open items, the agent enters Resume Mode. The agent:

1. **Checks the working tree is clean** (`git status --porcelain` empty). Refuses to start if uncommitted changes are present - Resume Mode commits per decision and would otherwise mix WIP edits with triage commits. Same gate as `/sdd clean`.
2. **Sanity-checks transition state**. If `transition: true` is missing from `sdd/config.yml` but open items exist, restores it quietly. If `transition: true` is set but `sdd/init-triage.md` is unreadable, aborts with a recovery hint (restore from git history or remove the flag manually).
3. **Prints a mode-auto notice** when `sdd/config.yml` says `mode: auto`: Resume Mode is always interactive, the auto setting is suspended for this run and resumes after the queue drains.
4. **Surfaces one item at a time** with **refreshed** Context (re-read source, re-check git log, re-fetch related PRs - the codebase may have evolved since the prior session). The user picks one of: **accept** the recommendation, **correct** it, mark it **lost** (one-line Reason required), **skip** for now, or **quit**.

Only `accept` and `correct` promote the answer into the official spec REQs. `correct` opens an editor for free-form prose where the user describes **what the thing is for** (purpose → REQ Intent) and **how it works** (observable behavior → REQ ACs); the agent folds the prose into the relevant REQ's fields named in the triage entry's `**Target REQ:**` field (no re-inference at resolution time). `skip` leaves the triage item open in `sdd/init-triage.md` and writes nothing to the spec - skipped items resurface on the next Resume Mode run. `lost` records the gap but does not fabricate an Intent. Each decision is its own commit.

**Transition-closure step** runs after every resolved/lost decision. When zero `**Status:** open` items remain:

- `transition: true` is cleared from `sdd/config.yml`
- A closure entry is appended to `sdd/changes.md` (e.g., `SDD transition complete. {Total} triage items resolved ({R} accepted, {C} corrected, {L} lost).`)
- `enforce_tdd` is NOT changed - the user flips it to `true` manually when ready for TDD enforcement (typically after adding REQ-ID test names)
- The agent enters Plan Mode (same hard gate as greenfield `/sdd init` step 17) so the first feature work on top of the now-real spec is plan-gated

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

If `sdd/` already exists with no open triage items, `/sdd init` aborts with an error pointing the user at `/sdd clean` for spec rescue. If open triage items exist, `/sdd init` enters Resume Mode.

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

In **unleashed** mode: applies SAFE + RISKY + JUDGMENT fixes on the current branch (using conservative defaults for JUDGMENT), commits per category, pushes directly. No new branch, no PR. If `enforce_tdd: false`, unleashed refuses to run and emits a finding asking the user to either flip the value or use `auto` instead - the per-project opt-out is preserved. Commits land where the user pushed from.

### Safety nets

In all modes:
- **Working tree must be clean** before running (refuses if `git status --porcelain` is non-empty)
- **Backup files** are created before any RISKY operation (e.g., `sdd/changes.md` → `sdd/changes-archive-YYYY-MM.md`)
- **Per-category commits** for selective revert
- **`[sdd-clean]` commit tag** that bypasses round-detection in spec-reviewer
- **Sequential execution** (spec-reviewer first, then doc-updater)

In `unleashed` mode specifically:
- Pushes commits directly to the current branch (no new branch, no PR)
- Each commit is per-category and tagged `[sdd-clean]` - `git revert <sha>` is the rollback surface
- Full audit log lives in `sdd/.last-clean-run.md` + the per-category commit messages

Both `auto` and `unleashed` push to the currently checked-out branch. The user is responsible for checking out a feature/dev branch before invoking if they don't want commits landing on the current branch.

### What gets cleaned

- **Strikethrough text** in REQs → stripped (git history is the strikethrough)
- **Prose Status fields** (multi-line status notes) → truncated to one word, prose moved to `pending.md` or to `Notes:` field for `Partial` status
- **Implementation leakage** in REQs (hex codes, CSS classes, file paths, function names, env vars, etc.) → moved to appropriate `documentation/` files
- **Fake-Deprecated REQs** (Deprecated without `Replaced By:`) → moved to `## Out of Scope` section in domain README (interactive/auto/unleashed: see escalation rules)
- **Oversized REQs** (>50 lines) → flagged; in unleashed mode, implementation prose extracted to docs while Intent + AC stay verbatim
- **Bloated `changes.md`** (verification log entries, commit SHAs, multi-paragraph entries) → archived to `sdd/changes-archive-YYYY-MM.md`, new file written with user-facing entries only
- **Status: Implemented REQs without test coverage** → if `enforce_tdd: true`, demoted to `Partial` with `Notes:` explaining what's missing; if `enforce_tdd: false`, written to `sdd/.coverage-report.md` only
- **Status: Planned/Partial REQs with source code but no test** → if `enforce_tdd: true`, HIGH finding + auto-promote `Planned → Partial` with `Notes:`
- **Test quality heuristics** → AC-count vs test-count check, tautology detection, skipped-test detection (all run when `enforce_tdd: true`)
- **Missing doc→spec backlinks** → generated automatically (links from `documentation/` files to relevant REQ IDs)
- **False-positive ADRs** in `documentation/decisions/` (static-analyzer accommodations, naming-compat notes, risk acceptance with no alternative considered, implementation notes framed as decisions) → reclassified to their canonical home (inline source comment, `troubleshooting.md`, `configuration.md`, or `security.md`). The original `### AD-N:` heading is preserved as a `Status: Reclassified` stub so inbound `AD-N` references keep resolving. See `documentation-discipline.md` "What is NOT an ADR" — applied by `/sdd clean` (the PR-boundary doc-updater passes only flag, never reclassify, to avoid surprising the user mid-PR).

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

**NEXT ACTION - MANDATORY: enter Plan Mode** before any source/test/config edits. Same gate as `/sdd init` and `/sdd edit` (see "Plan Mode integration" below).

## /sdd mode — switching autonomy

```bash
/sdd mode interactive   # agent asks before every fix (default)
/sdd mode auto          # agent silently applies safe fixes
/sdd mode unleashed     # agent does everything without asking
/sdd mode               # show current mode
```

The setting is persistent (committed to git as `sdd/config.yml`) and travels with the project. Per-command overrides via `--interactive`, `--auto`, `--unleashed` flags on `/sdd clean`.

**Transition gate on `unleashed`**: `/sdd mode unleashed` is rejected while `sdd/config.yml` carries `transition: true` (the import triage queue still has open items). Unleashed mode runs blind and auto-resolves JUDGMENT; triage items require user judgment by construction. The user must drain the triage queue via Resume Mode first. `/sdd mode auto` and `/sdd mode interactive` are both allowed during transition; they do not bypass user judgment on individual triage items.

## Test discipline

Every REQ marked `Status: Implemented` should have at least one test file that references its REQ ID. Test discovery uses `test_globs` from `sdd/config.yml`. Detection is binary: the REQ ID literally appears in a test (in a test name, comment, or assertion message).

**Why REQ IDs in test files**: this lets `spec-reviewer` verify which Implemented REQs have automated coverage without ambiguous prose matching. Test naming convention example:

```typescript
test('REQ-AUTH-001: rejects expired JWT tokens', () => {
  // ...
});
```

When `enforce_tdd: true` (the default), REQs without test references get downgraded to `Partial` with a `Notes:` field, and REQs whose source code exists but lacks tests get flagged and auto-promoted `Planned → Partial`. spec-reviewer matches by REQ-ID substring in test files (see test naming example above). Projects that genuinely cannot admit automated testing (pure visual design systems, for example) can opt out with `enforce_tdd: false`.

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

## Template conventions (issue #253)

Templates follow `documentation-discipline.md` from the first commit. Conventions baked into every `documentation-*.md` template:

- **One-line table cells**: every cell stays on a single line. The 50-word per-cell budget enforced by `doc-updater` Pass 1 begins at scaffolding. If a row needs more than ~50 words, write the long form as a body paragraph below the table and replace the cell with a one-line summary plus a link.
- **Embedded doc-discipline directive comments**: each template starts with an HTML comment `<!-- doc-discipline: <budget> lines, one-line table cells, no implementation prose -->` so the user editing the file sees the budget and the cell convention before they expand sections beyond the soft cap.
- **Per-file budgets** match `documentation-discipline.md`: architecture.md template targets ≤350 lines, api-reference.md ≤600 lines, configuration.md ≤200 lines, deployment.md ≤200 lines.
- **REQ backlinks pre-wired**: the `Implements` column in `Source Modules` table and equivalents elsewhere are scaffolded with the exact `[REQ-X-N](../sdd/{domain}.md#req-x-n)` form so doc-updater finds them on the first PR.
- **Lane-correct content placeholders**: `architecture.md` template never has an "API endpoints" section (that's `api-reference.md`'s lane). Templates enforce lane separation by example.
- **ADR template carries the "What is NOT an ADR" guardrail**: `documentation-decisions-readme.md` opens with the four-shape table (SAST false positive / naming-compat / risk acceptance with no alternative / implementation note framed as a decision) so the first ADR a user writes already conforms to the rule (`/sdd clean` reclassifies anything that doesn't). The AD1 example includes `Alternatives considered:` and `Consequences:` fields — both load-bearing for the "real alternatives" test.

These conventions are why the architecture.md template is the shortest template by line count — it should stay that way.

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
