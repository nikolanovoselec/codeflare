# Spec-Driven Development

Turn rough product ideas into structured specifications. Keep the spec honest as the project grows. The spec is the single source of truth for **what the product does and why**.

The structure, format, modes, and workflow are documented in the `spec-driven-development` skill (`~/.claude/skills/spec-driven-development/SKILL.md` for Claude; the equivalent skills directory for Codex/Gemini/OpenCode; for Copilot the skill is invoked via the `skill` tool by name). This file handles command parsing and routing.

---

## When the user types `/sdd` with no arguments

Print this help screen and exit. Do not invoke any sub-command unless the user provides one.

```
sdd — spec-driven development for Claude Code projects

  Turn rough product ideas into structured specifications.
  Keep the spec honest as the project grows.

USAGE
  /sdd                              Show this help
  /sdd <subcommand> [arguments]     Run a subcommand

SUBCOMMANDS
  init [idea]            Bootstrap a new project (interactive). Creates
                         sdd/, documentation/, root README, tests/,
                         sdd/config.yml. Detects existing codebases and
                         imports a derived spec instead of greenfield.
  edit <domain>          Add or modify requirements in an existing
                         domain. Always interactive.
  add <domain>           Create a new domain in an existing spec.
                         Always interactive.
  clean                  Refactor a rotted spec. Detects implementation
                         leakage, fake-Deprecated REQs, oversized REQs,
                         bloated changelogs, Out-of-Scope/REQ
                         collisions, pending split proposals, orphan
                         hatch markers. Mode-aware. --scope=all (default)
                         scans the entire corpus; --scope=diff scans only
                         the open PR delta.
  autonomous <action>    Set autonomy mode. Actions: on | off |
                         unleashed | unleashed off | status
                         (off resets to interactive from any mode)

AUTONOMY MODES
  interactive  (default)   Confirm every change before applying. Safe
                           for new users and high-stakes specs.
  auto                     SAFE/RISKY fixes auto-applied on current
                           branch. JUDGMENT items logged to
                           sdd/.review-needed.md.
  unleashed                Walk-away autopilot. Applies SAFE/RISKY/
                           JUDGMENT with conservative defaults, commits
                           per category, pushes. enforce_tdd forced
                           true. Revert per-category SHA to undo.

AUTO-RUN  (no /sdd invocation needed)
  Once sdd/ exists, the SDD workflow runs automatically at PR-boundary
  events for PRs targeting main/master: code-reviewer + spec-reviewer
  + doc-updater fire on PR open or on push to a branch with such a
  PR open. Both honor sdd/config.yml mode and any ADRs in
  documentation/decisions/ that carry an Overrides: header (skip
  list — see "USER OVERRIDES" below). Vibe-code without sdd/ works
  too — agents stay silent until you /sdd init.

REQUIRED SDLC FOR AUTONOMOUS REVIEW
  The review pipeline only fires for PRs whose base is `main` or
  `master`. To get autonomous code review, your repo needs:

  1. A `main` (or `master`) branch as the eventual merge target.
  2. PRs opened with that base — either directly (feature → main)
     or transitively (feature → develop → main, where the
     develop → main PR is what triggers review).
  3. `gh` CLI installed and authenticated for the GitHub remote
     (the hooks call `gh pr view <branch> --json
     state,headRefOid,baseRefName`).
  4. Upstream tracking on the working branch (`git rev-parse @{u}`
     resolves). Vanilla `git clone <url>` sets this up. If you
     used `git checkout -B <branch>` without `--track`, repair
     once: `git branch --set-upstream-to=origin/<branch> <branch>`.
  5. Recommended: GitHub branch protection on main requiring PR
     before merge — the only structural defense against direct
     pushes that bypass review.

  PRs into intermediate branches (develop, staging, etc.) are
  silently deferred. The cumulative review at the develop → main
  PR covers everything that landed. If your project has no main/
  master branch — e.g., trunk-based with `trunk` as the default
  branch — review will silently never fire; either rename to main
  or open an issue (the hardcoded gate is a deliberate v1 trade-off).

CONFIG  (sdd/config.yml)
  mode                              interactive | auto | unleashed
  enforce_tdd                       true | false  (default: true)
  test_globs                        [...]         (test-file patterns)
  src_globs                         [...]         (optional override)
  forbidden_content_allowlist       {...}

FILES
  sdd/.review-needed.md       Findings escalated for human review
  sdd/.coverage-report.md     Output when enforce_tdd: false
  sdd/.last-clean-run.md      Audit log of the last /sdd clean
  documentation/decisions/    ADRs (any with `Overrides:` header act
                              as the agent skip list — see USER
                              OVERRIDES below)

USER OVERRIDES
  When an automated finding is wrong for a specific REQ ("this
  mechanism IS the contract"), the resolution is an architectural
  decision and is recorded as an ADR — not a one-line skip entry.
  Each ADR carries an `Overrides: {rule_id}:{REQ-ID}` header that
  spec-reviewer and doc-updater grep at the start of every run.
  See ~/.claude/rules/spec-discipline.md "User overrides via ADRs".

  Legacy sdd/.user-overrides.md is removed (issue codeflare#266).
  Existing entries auto-migrate to ADRs on the next /sdd clean.

DISCIPLINE TRIAD  (loaded into all agents)
  spec-discipline           What counts as a real requirement.
                            Enforced by spec-reviewer.
  documentation-discipline  What counts as real documentation
                            (line/word budgets, lane separation).
                            Enforced by doc-updater.
  tdd-discipline            What counts as a real test (no text-
                            matching theater, no tautology, no
                            mock-only). Enforced by code-reviewer.
                            Gated by enforce_tdd above.

BYPASSING REVIEW  (USER-only — agents must never use these)
  When the post-push review pipeline is genuinely blocking
  legitimate work (trivial doc edit, emergency hotfix, post-mortem
  push), three escape hatches preserve user agency:

    touch sdd/.skip-next-review     One-shot sentinel; auto-deleted
                                    on use.
    "skip review"                   Magic phrase in any USER message
    "skip verification"             after the candidate push line.
    3-strike circuit breaker        Built-in: after 3 blocks for the
                                    same un-acked PR HEAD SHA, the
                                    hook gives up automatically.

  These are USER-only. The assistant must never create the sentinel
  or write the magic phrase in its own output — that would defeat
  the entire enforcement layer. Hook misfires get fixed in code,
  not bypassed inline.

EXAMPLES
  /sdd init "vacation rental site for Pasman"
                                    Bootstrap a new project from idea
  /sdd init                         Bootstrap; agent prompts for idea
  /sdd edit authentication          Add or modify auth requirements
  /sdd add notifications            Create a new domain
  /sdd clean                        Rescue a rotted spec
  /sdd clean --unleashed            Force unleashed mode for one run
  /sdd autonomous on                Switch to auto mode
  /sdd autonomous unleashed on      Switch to walk-away autopilot
  /sdd autonomous status            Show current mode + overrides

LEARN MORE
  Skill         ~/.claude/skills/spec-driven-development/SKILL.md
  Rules         ~/.claude/rules/spec-discipline.md
                ~/.claude/rules/documentation-discipline.md
                ~/.claude/rules/tdd-discipline.md
  Templates     ~/.claude/skills/spec-driven-development/references/templates/
```

---

## /sdd init

Bootstrap a new project. Always interactive — you confirm the vision before any files are written.

### Behavior

1. **Check for existing sdd/**: if `sdd/` already exists, abort with:
   ```
   Error: sdd/ already exists in this project.
   To rescue an existing rotted spec, use /sdd clean.
   To overwrite (destructive), use /sdd init --force.
   ```
2. **Detect existing code**: check for substantive source code in the project
   - Look for `src/`, `lib/`, `app/`, `pkg/`, language-specific directories
   - Look for project files: `package.json`, `Cargo.toml`, `go.mod`, `requirements.txt`, `pyproject.toml`, `Gemfile`, `pom.xml`, etc.
   - Count source files (`.py`, `.ts`, `.tsx`, `.js`, `.go`, `.rs`, `.rb`, `.java`, etc.) — if >5 source files exist, treat as **existing codebase**
3. **Branch on detection**:
   - **Empty or near-empty project** → continue to step 4 (greenfield bootstrap)
   - **Existing codebase detected** → switch to **import mode** (jump to "Import Mode" section below)
4. **Read the user's input**: `$ARGUMENTS` may contain a one-sentence idea, a paragraph, or be empty
5. **If empty**, ask: "What are you building? Describe in plain language — a sentence is enough."
6. **Draft a vision** from the prose. Present for confirmation:
   > "Here's what I think you're describing: {vision}. Is that right, or should I adjust?"
7. **Propose actors**. Use User and Admin as defaults. "System" is a qualifier, not an actor. Present a table.
8. **Map the journey**. Ask one question:
   > "Walk me through what happens from the moment someone first opens this until they're using it daily."
   From the answer, extract domains. If the user is brief, propose a journey yourself.
9. **Propose 5-12 domains** with one-line descriptions and priorities. Present as a table.
10. **Propose 3-7 design principles** specific to this product (not generic).
11. **Draft requirements** for each domain (5-15 per domain). Present one domain at a time. Confirm before moving to the next.
12. **Draft constraints** with CON-* IDs. Propose technology stack based on what the user has implied.
13. **Read scaffolding templates** from `~/.claude/skills/spec-driven-development/references/templates/`:
    - `root-readme.md`
    - `sdd-readme.md`
    - `sdd-glossary.md`
    - `sdd-constraints.md`
    - `sdd-changes.md`
    - `sdd-config.yml`
    - `documentation-readme.md`
    - `documentation-architecture.md`
    - `documentation-api-reference.md`
    - `documentation-configuration.md`
    - `documentation-deployment.md`
    - `documentation-decisions-readme.md`
14. **Substitute placeholders** (`{PROJECT_NAME}`, `{ACTOR_1}`, `{INSTALL_COMMAND}`, etc.) with values from the user's input and inferred context
15. **Write the files**:
    - `sdd/README.md`, `sdd/glossary.md`, `sdd/constraints.md`, `sdd/changes.md`, `sdd/config.yml`
    - One file per domain in `sdd/{domain}.md` with the drafted REQs
    - `README.md` in repo root
    - `documentation/README.md`, `architecture.md`, `api-reference.md`, `configuration.md`, `deployment.md`
    - `documentation/decisions/README.md`
    - `tests/` (empty directory)
16. **Print next steps**:
    ```
    ✓ Spec created at sdd/
    ✓ Documentation scaffolding at documentation/
    ✓ Root README.md linking both
    ✓ Test scaffolding at tests/
    ✓ sdd/config.yml created (mode: interactive)

    What to do next:
      1. Review the spec at sdd/README.md
      2. I'll enter Plan Mode next to lay out a tests-first
         implementation plan from the Planned REQs. Approve or
         revise before any source file is written.
      3. tdd-guide authors the RED phase; spec-reviewer promotes
         Planned → Implemented on push.

    To switch modes:
      /sdd autonomous on            → auto (recommended for solo dev)
      /sdd autonomous unleashed on  → walk-away mode (PR-based review)
    ```

17. **NEXT ACTION — MANDATORY**: enter Plan Mode. No code, tests, or config under `src/`, `lib/`, `app/`, `pkg/`, `tests/` before Plan Mode. Hard gate. "build now" / "go" / "execute" / "ship it" / "just do it" authorize starting, never skipping. See `Plan Mode integration` in the `spec-driven-development` skill.

### Import Mode (existing codebase)

When step 2 detected substantive existing code, the agent enters import mode instead of greenfield bootstrap. This is the path for **converting an existing project to SDD**.

#### Workflow

1. **Confirm intent with the user**:
   > "Detected existing codebase: {N} source files in src/, package.json present, framework: {detected}. Should I derive a spec from the existing code (recommended for SDD migration), or treat this as a fresh start (will ignore existing code)?"
   - If user picks "fresh start": jump to step 4 in the greenfield flow above (ignore the existing code)
   - If user picks "derive from code" (default): continue
2. **Analyze the project**:
   - Read `README.md` to extract project intent and feature list
   - Read `package.json` (or equivalent) for name, description, dependencies, scripts
   - Read top-level config files (`tsconfig.json`, `wrangler.toml`, `Cargo.toml`, etc.) to understand the runtime
   - Walk the directory tree under `src/`, `app/`, `lib/`, `pkg/` (project-language-aware) to identify modules
3. **Identify domains from directory structure**. Heuristics:
   - `src/api/auth/` or `src/auth/` → "Authentication" domain
   - `src/api/billing/` or `src/billing/` → "Billing" or "Subscription" domain
   - `src/pages/` or `src/routes/` → "UI" or one domain per page section
   - `src/lib/` → utility libs, usually NOT a domain (referenced from other domains)
   - Top-level feature directories → one domain each
   - Generic structures (no clear domains): propose 3-5 broad domains and let the user refine
4. **Read representative files** in each identified domain. For each module:
   - Route handlers / endpoint definitions → API contracts
   - Schema files (`zod`, `prisma`, `pydantic`) → data shapes
   - Auth middleware → security constraints
   - Test files → coverage map (which features have tests)
5. **Derive REQs from observed behavior** (one per major feature/route/page). For each REQ:
   - **Intent**: inferred from naming, comments, README references. Mark with `(inferred)` if unclear so the user knows to validate.
   - **Acceptance Criteria**: describe **observable behavior** at the user-facing level. Strip implementation details (file paths, function names, hex codes go to documentation/, not the spec).
   - **Status**: tentatively `Implemented`. Will be auto-checked in step 7.
   - **Priority**: P0 for core flows (auth, primary user actions), P1 for supporting features, P2 for polish, P3 for stretch.
   - **Dependencies**: cross-domain REQ links discovered from imports.
   - **Verification**: `Automated test` if a test file references the feature, `Manual check` otherwise.
6. **Identify cross-cutting constraints** by reading config files and middleware:
   - Tech stack from `package.json` / `Cargo.toml` / etc.
   - Security headers from middleware
   - Performance budgets from CI config
   - Compliance markers from privacy/legal files
   - Each becomes a `CON-*` entry in `sdd/constraints.md`
7. **Run the import-time coverage baseline** (one-time pass during `/sdd init` only — future spec-reviewer runs respect the `enforce_tdd` config setting):
   - For each derived REQ marked `Status: Implemented`, search test files for the feature name or route path (NOT the REQ ID — the agent has not annotated tests yet, so this is a heuristic match for the import baseline only)
   - If found, keep `Implemented`. If not, demote to `Partial` with `Notes: No test coverage found during import analysis. Add REQ-{ID} to test names to restore Implemented status.`
   - Why this is a one-time pass: import-mode runs once on a fresh spec where no REQ IDs are in tests yet. After import, the user adds REQ IDs to tests over time, and the regular `enforce_tdd` setting takes over for steady-state runs.
8. **Present the derived spec for confirmation**, one domain at a time:
   - Show the proposed REQs in the domain
   - Ask: "Does this match what {domain} actually does? Add, remove, or modify any REQs?"
   - User edits inline; agent adjusts
9. **Optionally let the user fill in vision and principles**:
   - Vision: pre-fill from README. User confirms or rewrites.
   - Principles: ask "What design principles should guide future changes? I see {N} themes in the existing code: {list}." User confirms or replaces.
10. **Write the same scaffolding as greenfield init**, plus the derived REQs:
    - `sdd/README.md` with derived domain index and Out of Scope section (empty)
    - One `sdd/{domain}.md` per derived domain with the validated REQs
    - `sdd/constraints.md` with derived CON-* entries
    - `sdd/glossary.md` with terms inferred from code (vendor names, protocols, domain concepts)
    - `sdd/changes.md` with one entry: `## YYYY-MM-DD\n- Initial spec imported from existing codebase via /sdd init (N requirements across M domains)`
    - `sdd/config.yml` with `mode: interactive` and `enforce_tdd: false` (respect existing-project caution — the imported code predates the annotation convention; user opts in after adding annotations)
    - `documentation/` scaffolding from templates, with backlinks to derived REQs where applicable
    - Root `README.md` updated to reference `sdd/` and `documentation/` (preserve existing content if already present — append the SDD section)
11. **Print next steps for the imported project**:
    ```
    ✓ Spec imported from existing codebase
    ✓ {N} requirements across {M} domains
    ✓ {X} marked Implemented (tests found)
    ✓ {Y} marked Partial (no tests found — see Notes: field)
    ✓ {Z} CON-* constraints derived
    ✓ documentation/ scaffolding created (existing files preserved)
    ✓ sdd/config.yml created (mode: interactive, enforce_tdd: false)

    The spec describes what the code currently does. Review it and:
      1. Adjust requirements that don't match your intent
      2. Add REQ IDs to test names so spec-reviewer can verify Implemented status
         (e.g., test('REQ-AUTH-001: rejects expired tokens', () => {...}))
      3. Add `Implements REQ-X-NNN` comments to source files so spec-reviewer
         can detect code-without-tests
      4. Once annotations are in place, flip `enforce_tdd: true` in sdd/config.yml
      5. To convert Partial → Implemented as you add tests, just push — the
         spec-reviewer agent handles it on every push

    Your code is unchanged. Only sdd/, documentation/, and root README were created.
    ```

#### Import mode safety rules

- **Never edit existing source code** during import — only read it
- **Never overwrite existing `README.md`** — append the SDD section, preserve existing content
- **Never overwrite existing `documentation/`** files — only create files that don't exist
- **Always confirm derived REQs with the user** before writing — even in `auto` or `unleashed` mode (import mode is always interactive because inferring intent from code is genuinely judgment-required)
- **Mark inferred intent explicitly** with `(inferred)` so the user knows what to validate first
- **Default `enforce_tdd: false` for imports only** — never aggressively demote on a freshly imported spec; let the user add REQ-ID test names and `Implements REQ-X-NNN` source annotations first, then opt in. Greenfield `/sdd init` still defaults to `enforce_tdd: true`.

---

## /sdd edit {domain}

Modify requirements in an existing domain. Always interactive.

### Behavior

1. **Validate**: `sdd/{domain}.md` must exist. If not, suggest `/sdd add {domain}`.
2. **Read context**: `sdd/README.md`, `sdd/constraints.md`, `sdd/glossary.md`, `sdd/{domain}.md`
3. **Ask the user**: "What do you want to add or change in {domain}?"
4. **Draft the new or modified REQ** in the format defined by `~/.claude/skills/spec-driven-development/SKILL.md`
5. **Validate against discipline rules**:
   - Forbidden content (per `sdd/config.yml` allowlist)
   - REQ length warnings
   - Status field is one word
   - All required fields present
6. **Confirm with user**, then write the file
7. **Update glossary** if new terms were introduced
8. **Add a changelog entry** to `sdd/changes.md` (≤2 sentences, dated, user-facing)

User-authored content gets priority — never block the user on cleanup findings. Cleanup happens later via `/sdd clean`.

**NEXT ACTION — MANDATORY**: if any new/modified REQ is `Planned` or `Partial` and the user intends to implement it, enter Plan Mode. No source files until the plan is approved. See `Plan Mode integration` in the skill.

---

## /sdd add {domain}

Create a new domain. Always interactive.

### Behavior

1. **Validate**: `sdd/{domain}.md` must NOT exist
2. **Validate**: `sdd/` must exist (if not, suggest `/sdd init`)
3. **Ask the user**: "What does the {domain} domain cover?"
4. **Propose 5-15 initial REQs** based on the user's description
5. **Confirm** with the user
6. **Create `sdd/{domain}.md`**
7. **Update `sdd/README.md`** domain index
8. **Update `sdd/glossary.md`** with new terms
9. **Add changelog entry** to `sdd/changes.md`

**NEXT ACTION — MANDATORY**: after the new domain is written, enter Plan Mode. No source files until the plan is approved. See `Plan Mode integration` in the skill.

---

## /sdd clean

Refactor a rotted spec. Mode-aware.

### Behavior

1. **Read `sdd/config.yml`** to determine mode (`interactive`, `auto`, `unleashed`)
2. **Apply per-command flags**:
   - `--interactive`, `--auto`, `--unleashed` override the config setting for this run
   - `--scope=all` (default) scans the entire `sdd/` + `documentation/` corpus
   - `--scope=diff` limits the scan to files changed in `git diff origin/main...HEAD` (the open PR's delta). Use this when invoked from a PR context to keep the cleanup proportional to the review.
3. **Validate working tree**: refuse if `git status --porcelain` is non-empty
4. **In `auto` mode**: refuse if current branch is `main` or `master` without `--branch-confirmed`
5. **In `unleashed` mode**: push directly to the current branch (no new branch, no PR); refuse to run on `main`/`master` without `--branch-confirmed`
6. **Scan for findings** (across the resolved scope from step 2):
   - Strikethrough text in REQs (LOW)
   - Prose Status fields (LOW)
   - Implementation leakage in REQs per allowlist (LOW)
   - Oversized REQs >50 lines (MEDIUM/HIGH)
   - Fake-Deprecated REQs (no Replaced By) (MEDIUM, JUDGMENT)
   - Bloated `changes.md` >200 lines or >30 entries (RISKY, batched)
   - Status: Implemented REQs without test coverage (HIGH if `enforce_tdd: true`, otherwise report-only)
   - Status: Planned/Partial REQs with source code but no test (HIGH if `enforce_tdd: true`)
   - Test quality findings: tautologies, skipped tests, AC-count mismatch (HIGH/MEDIUM if `enforce_tdd: true`)
   - Doc-vs-spec conflicts (MEDIUM, JUDGMENT)
   - Legacy `sdd/.user-overrides.md` exists (HIGH, AUTO-MIGRATE — see step 6a)
   - **Approved split proposals**: scan `sdd/.split-proposals/*.md` for files whose top-of-file `**Status:** Approved` line is present. For each, execute the split: write the child REQs to their target domain files (verbatim AC text from the proposal), update the parent (Deprecated with `Replaced By:` listing children, OR move to "Out of Scope" if the parent name no longer makes sense), update any inbound REQ cross-references, then delete the consumed proposal file. Draft-status proposals are left untouched. (MEDIUM, JUDGMENT — user already authorized via Status: Approved, so /sdd clean proceeds without re-confirming.)
   - **Out-of-Scope collisions**: spec-reviewer's Phase 2 check #16 written to `.review-needed.md`. `/sdd clean` proposes resolution per finding: either remove the Out-of-Scope bullet (the feature shipped) or move the REQ to "Out of Scope" / mark Deprecated. (MEDIUM, JUDGMENT — confirm with user in interactive mode; in auto, surface a one-line proposal per collision and let user pick; in unleashed, default-keep the shipped REQ and remove the Out-of-Scope bullet.)
   - **Orphan / aged hatch markers**: `<!-- sdd-allow-large -->` and `<!-- doc-allow-large -->` markers flagged by spec-reviewer Phase 2 #18 and doc-updater Pass 6. Bare markers rewritten to `: TODO open ADR`; orphan ADR references prompt the user to file an ADR or remove the hatch; aged-Accepted reminders are surfaced for revisit. (LOW/MEDIUM/HIGH per the audit table.)
   - False-positive ADRs in `documentation/decisions/` per `documentation-discipline.md` "What is NOT an ADR" (MEDIUM, AUTO-RECLASSIFY in `auto`/`unleashed`): static-analyzer accommodations move to inline source comments + `documentation/troubleshooting.md` if recurring; naming/spelling-compat notes move to `documentation/configuration.md`; risk-acceptance with no alternative considered moves to `documentation/security.md`; implementation-notes-as-decisions are deleted or moved to `pending.md`. The original `### AD-N:` heading is preserved as a `Status: Reclassified on YYYY-MM-DD` stub so inbound `AD-N` references keep resolving. Findings on entries already carrying `Status: Reclassified` or `Status: Merged into` are suppressed.
6a. **Migrate legacy `sdd/.user-overrides.md` to ADRs** (one-time, runs before any other apply step):
    - For each entry block keyed by `## {rule_id}:{target_id}`, generate a new ADR file at `documentation/decisions/AD{N}-{slug-of-rule-id}-{lowercased-target-id}.md` where `{N}` is the next available AD number (read `documentation/decisions/README.md` for the highest existing AD ID and increment).
    - ADR template:
      ```markdown
      ### AD{N}: {Decision title derived from `{rule_id}` + `{target_id}`}

      **Status:** {Accepted (YYYY-MM-DD from the legacy `Date:` field). If the legacy entry has no parseable Date or the value is malformed, emit `Accepted (date unknown)` instead — never substitute today's date, as that would silently re-stamp the decision and lose the audit trail.}
      **Overrides:** {rule_id}:{target_id}

      **Context:** {Auto-filled placeholder explaining what `{rule_id}` flagged on `{target_id}`. Reference the rule by name from `~/.claude/rules/spec-discipline.md`.}

      **Decision:** {The legacy `User note:` field, verbatim.}

      **Rationale:** {Auto-filled placeholder asking the user to expand the legacy note into the original reasoning. Mark with `<!-- TODO: expand from legacy override note -->` so the user notices on first read of the new ADR.}

      **Consequences:** {Auto-filled placeholder asking the user to list downstream code/docs that must keep in lockstep.}

      **Related requirements:** {target_id if it parses as REQ-X-NNN, else leave blank}
      ```
    - Append a row to `documentation/decisions/README.md`'s decision index for each new ADR.
    - Delete `sdd/.user-overrides.md` in the same commit.
    - Tag the commit `[sdd-clean] migrate user-overrides to ADRs (issue codeflare#266)` so spec-reviewer's round-counter excludes it.
    - The TODO placeholders in the ADRs are intentional — the user fills them on first review. Until then, the `Overrides:` header is fully active and spec-reviewer/doc-updater respect it.
7. **Apply per mode**:
   - **interactive**: report findings batch by batch, ask confirmation
   - **auto**: apply SAFE + RISKY silently, escalate JUDGMENT to `sdd/.review-needed.md`
   - **unleashed**: apply SAFE + RISKY + JUDGMENT (conservative defaults), commit per category, push directly to current branch
8. **All commits tagged `[sdd-clean]`** to bypass spec-reviewer's round-detection
9. **Backup before destructive ops**: archive `changes.md` to `changes-archive-YYYY-MM.md` before truncating
10. **Write `sdd/.last-clean-run.md`** with full audit log
11. **In unleashed mode**, each commit message includes its audit log excerpt so the user can review per-category when they return (also see `sdd/.last-clean-run.md`)

### Conservative JUDGMENT auto-resolution (unleashed only)

| JUDGMENT type | Action |
|---|---|
| Doc-vs-spec conflict | Mark REQ as `Partial`, add `Notes:`, log to `.review-needed.md`. Never overwrite intent. |
| Oversized REQ refactor | Extract implementation prose to `documentation/{relevant}.md`, leave Intent + AC verbatim in REQ. Never split. |
| Fake-Deprecated REQ | Move to `## Out of Scope` section in domain README. Never delete. |

---

## /sdd autonomous

Set the autonomy mode.

### Behavior

```
/sdd autonomous on              → write `mode: auto` to sdd/config.yml
/sdd autonomous unleashed on    → write `mode: unleashed` to sdd/config.yml
/sdd autonomous off             → write `mode: interactive` (resets from auto OR unleashed)
/sdd autonomous unleashed off   → alias for `off` (same behavior)
/sdd autonomous status          → print current mode + last 5 ADRs in documentation/decisions/ that carry an `Overrides:` header
```

If `sdd/config.yml` doesn't exist, create it from the template first. If `sdd/` doesn't exist, error out: "No SDD project here. Run `/sdd init` first."

---

## Arguments

`$ARGUMENTS`: parsed as the sub-command and its arguments.

Examples:
- `/sdd` — print help screen
- `/sdd init "a marketplace for handmade crafts"` — bootstrap with idea
- `/sdd init` — bootstrap, ask for idea interactively
- `/sdd edit authentication` — modify auth domain
- `/sdd add notifications` — create new domain
- `/sdd clean` — rescue rotted spec (per current mode)
- `/sdd clean --unleashed` — force unleashed mode for this run
- `/sdd autonomous on` — switch to auto mode
- `/sdd autonomous unleashed on` — switch to unleashed mode
- `/sdd autonomous status` — show current mode

---

## Implementation note

The `/sdd` command itself does not contain the SDD logic. It dispatches to the workflow described in `~/.claude/skills/spec-driven-development/SKILL.md`, the rules in `~/.claude/rules/spec-discipline.md`, and the templates in `~/.claude/skills/spec-driven-development/references/templates/`.

When invoked, the agent should:
1. Parse `$ARGUMENTS` to identify the sub-command
2. Read the relevant sections of SKILL.md and the rules file
3. Execute the sub-command's behavior as documented above
4. Report results to the user
