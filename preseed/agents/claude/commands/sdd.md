# Spec-Driven Development

Turn rough product ideas into structured specifications. Keep the spec honest as the project grows. The spec is the single source of truth for **what the product does and why**.

**Read `~/.claude/skills/spec-driven-development/SKILL.md` first.** It documents the structure, format, modes, and workflow. This file handles command parsing and routing.

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
2. **Read the user's input**: `$ARGUMENTS` may contain a one-sentence idea, a paragraph, or be empty
3. **If empty**, ask: "What are you building? Describe in plain language — a sentence is enough."
4. **Draft a vision** from the prose. Present for confirmation:
   > "Here's what I think you're describing: {vision}. Is that right, or should I adjust?"
5. **Propose actors**. Use User and Admin as defaults. "System" is a qualifier, not an actor. Present a table.
6. **Map the journey**. Ask one question:
   > "Walk me through what happens from the moment someone first opens this until they're using it daily."
   From the answer, extract domains. If the user is brief, propose a journey yourself.
7. **Propose 5-12 domains** with one-line descriptions and priorities. Present as a table.
8. **Propose 3-7 design principles** specific to this product (not generic).
9. **Draft requirements** for each domain (5-15 per domain). Present one domain at a time. Confirm before moving to the next.
10. **Draft constraints** with CON-* IDs. Propose technology stack based on what the user has implied.
11. **Read scaffolding templates** from `~/.claude/skills/spec-driven-development/references/templates/`:
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
12. **Substitute placeholders** (`{PROJECT_NAME}`, `{ACTOR_1}`, `{INSTALL_COMMAND}`, etc.) with values from the user's input and inferred context
13. **Write the files**:
    - `sdd/README.md`, `sdd/glossary.md`, `sdd/constraints.md`, `sdd/changes.md`, `sdd/config.yml`
    - One file per domain in `sdd/{domain}.md` with the drafted REQs
    - `README.md` in repo root
    - `documentation/README.md`, `architecture.md`, `api-reference.md`, `configuration.md`, `deployment.md`
    - `documentation/decisions/README.md`
    - `tests/` (empty directory)
14. **Print next steps**:
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
