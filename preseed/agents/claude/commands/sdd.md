# Spec-Driven Development

Turn rough product ideas into structured specifications. Keep the spec honest as the project grows. The spec is the single source of truth for **what the product does and why**.

The structure, format, modes, and workflow are documented in the `spec-driven-development` skill (`~/.claude/skills/spec-driven-development/SKILL.md` for Claude; the equivalent skills directory for Codex/Gemini/OpenCode; for Copilot the skill is invoked via the `skill` tool by name). This file handles command parsing and routing.

---

## When the user types `/sdd` with no arguments

Print this help screen and exit. Do not invoke any sub-command unless the user provides one.

```
# Spec-Driven Development

SDD turns rough product ideas into structured specifications, then keeps them
honest as the project grows. The spec (sdd/ folder) is the single source of
truth for what the product does and why.

## Sub-commands

  /sdd init [idea]      Bootstrap a new project from a product idea.
                        Creates sdd/, documentation/, root README, tests/,
                        and sdd/config.yml. Always interactive (you confirm
                        the vision and domains).

  /sdd edit {domain}    Add or modify requirements in an existing domain.
                        Always interactive — adding requirements requires
                        user input, even in auto/unleashed mode.

  /sdd add {domain}     Create a new domain in an existing spec.
                        Always interactive.

  /sdd clean            Refactor a rotted spec. Detects implementation
                        leakage, fake-Deprecated REQs, prose Status fields,
                        oversized REQs, bloated changelogs. Mode-aware.

  /sdd autonomous       Set the autonomy mode in sdd/config.yml.
                        Subcommands: on | off | unleashed | status

  /sdd                  This help screen.

## Three autonomy modes

  interactive  (default)
    Confirm every change before applying. Safe for new SDD users and
    high-stakes specs. /sdd clean reports findings and asks per-batch.

  auto
    SAFE and RISKY fixes auto-applied silently on the current branch.
    JUDGMENT items escalate to sdd/.review-needed.md for later review.
    Recommended for solo developers in steady-state.

  unleashed
    Walk-away mode. /sdd clean creates a new branch, applies SAFE +
    RISKY + JUDGMENT fixes (using conservative defaults that preserve
    information without overwriting intent), commits per category,
    opens a PR. You walk away. You come back to a PR — review and
    merge or close.

  /sdd autonomous on            → set mode = auto
  /sdd autonomous unleashed on  → set mode = unleashed
  /sdd autonomous off           → set mode = interactive
  /sdd autonomous status        → show current mode + recent overrides

## Auto-detection (no /sdd invocation needed)

Once a project has an sdd/ folder, the workflow runs automatically.
After every git push:
  • spec-reviewer agent updates sdd/ to match the code
  • doc-updater agent updates documentation/ to match the code
  • Both agents read sdd/config.yml to know the autonomy level
  • Both agents respect sdd/.user-overrides.md to skip findings you
    explicitly told them to ignore

If sdd/ doesn't exist, spec-reviewer exits silently and doc-updater
runs in docs-only mode (project-agnostic doc maintenance).

## Quick start

  New project from an idea     /sdd init "vacation rental site for Pasman"
  Existing rotted spec         /sdd clean
  Vibe code on a project       (just write code — agents handle SDD)
  Switch off interactive mode  /sdd autonomous on
  Walk-away cleanup            /sdd autonomous unleashed on; /sdd clean

## Where settings live

  sdd/config.yml         mode: interactive | auto | unleashed
                         auto_demote: true | false
                         test_globs: [...]
                         forbidden_content_allowlist: {...}

  sdd/.user-overrides.md Findings you told the agent to skip (committed)
  sdd/.review-needed.md  Findings escalated for human review (committed)
  sdd/.coverage-report.md Output of auto_demote: false runs (committed)
  sdd/.last-clean-run.md Audit log of the most recent /sdd clean run

## Reference

  Skill:    ~/.claude/skills/spec-driven-development/SKILL.md
  Rules:    ~/.claude/rules/spec-discipline.md (loaded into all agents)
  Templates: ~/.claude/skills/spec-driven-development/references/templates/
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
      2. Run /plan to generate an implementation plan from Status: Planned REQs
      3. Use TDD: write tests first (with REQ IDs in the test names),
         then implement
      4. Push your code — spec-reviewer and doc-updater agents handle SDD

    To switch modes:
      /sdd autonomous on            → auto (recommended for solo dev)
      /sdd autonomous unleashed on  → walk-away mode (PR-based review)
    ```

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
7. **Run the import-time coverage baseline** (this is a one-time pass during `/sdd init` only — future spec-reviewer runs respect the `auto_demote` config setting):
   - For each derived REQ marked `Status: Implemented`, search test files for the feature name or route path (NOT the REQ ID — the agent has not annotated tests yet, so this is a heuristic match for the import baseline only)
   - If found, keep `Implemented`. If not, demote to `Partial` with `Notes: No test coverage found during import analysis. Add REQ-{ID} to test names to restore Implemented status.`
   - Why this is a one-time pass and not the same as the auto-demote rule: import-mode runs once on a fresh spec where no REQ IDs are in tests yet. After import, the user adds REQ IDs to tests over time, and the regular `auto_demote` setting (default `false`) takes over for steady-state runs.
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
    - `sdd/config.yml` with `mode: interactive` and `auto_demote: false` (respect existing-project caution)
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
    ✓ sdd/config.yml created (mode: interactive, auto_demote: false)

    The spec describes what the code currently does. Review it and:
      1. Adjust requirements that don't match your intent
      2. Add REQ IDs to test names so spec-reviewer can verify Implemented status
         (e.g., test('REQ-AUTH-001: rejects expired tokens', () => {...}))
      3. Run /sdd check anytime to see what's still Partial
      4. Once test annotations are in place, switch on auto_demote in sdd/config.yml
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
- **Default `auto_demote: false`** — never aggressively demote on a freshly imported spec; let the user add test annotations first

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

---

## /sdd clean

Refactor a rotted spec. Mode-aware.

### Behavior

1. **Read `sdd/config.yml`** to determine mode (`interactive`, `auto`, `unleashed`)
2. **Apply per-command flags**: `--interactive`, `--auto`, `--unleashed` override the config setting for this run
3. **Validate working tree**: refuse if `git status --porcelain` is non-empty
4. **In `auto` mode**: refuse if current branch is `main` or `master` without `--branch-confirmed`
5. **In `unleashed` mode**: create a new branch `sdd-cleanup-{YYYY-MM-DD}-{shortsha}` regardless of current branch
6. **Scan `sdd/` for findings**:
   - Strikethrough text in REQs (LOW)
   - Prose Status fields (LOW)
   - Implementation leakage in REQs per allowlist (LOW)
   - Oversized REQs >50 lines (MEDIUM/HIGH)
   - Fake-Deprecated REQs (no Replaced By) (MEDIUM, JUDGMENT)
   - Bloated `changes.md` >200 lines or >30 entries (RISKY, batched)
   - Status: Implemented REQs without test coverage (HIGH if `auto_demote: true`, otherwise report-only)
   - Doc-vs-spec conflicts (MEDIUM, JUDGMENT)
7. **Apply per mode**:
   - **interactive**: report findings batch by batch, ask confirmation
   - **auto**: apply SAFE + RISKY silently, escalate JUDGMENT to `sdd/.review-needed.md`
   - **unleashed**: apply SAFE + RISKY + JUDGMENT (conservative defaults), commit per category, push branch, open PR
8. **All commits tagged `[sdd-clean]`** to bypass spec-reviewer's round-detection
9. **Backup before destructive ops**: archive `changes.md` to `changes-archive-YYYY-MM.md` before truncating
10. **Write `sdd/.last-clean-run.md`** with full audit log
11. **In unleashed mode**, the PR description includes the full audit log so the user can review when they return

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
/sdd autonomous off             → write `mode: interactive` to sdd/config.yml
/sdd autonomous status          → print current mode + last 5 overrides from .user-overrides.md
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
