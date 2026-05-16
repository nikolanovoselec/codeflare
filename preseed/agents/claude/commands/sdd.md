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
                         imports a derived spec — clear-from-source becomes
                         official REQs, unclear items become triage entries
                         in sdd/init-triage.md with the agent's context +
                         recommendation. Re-running /sdd init while triage
                         items are open resumes the interactive triage. The
                         project is in SDD transition until the queue drains;
                         agentic development is unlocked when it does.
  edit <domain>          Add or modify requirements in an existing
                         domain. Always interactive.
  add <domain>           Create a new domain in an existing spec.
                         Always interactive.
  clean                  Refactor a rotted spec. Detects implementation
                         leakage, fake-Deprecated REQs, oversized REQs,
                         bloated changelogs. Mode-aware.
                         Flags:
                           --scope=all (default) | --scope=diff
                           --interactive | --auto | --unleashed
                             (override sdd/config.yml mode for one run)
  mode <name>            Set the autonomy mode. Name is one of:
                         interactive | auto | unleashed
                         (no arg prints current mode).

MODES  (how much the agent asks before changing your spec)
  interactive  (default)   Agent asks before every fix. Safe for new
                           users and high-stakes specs.
  auto                     Agent silently applies safe fixes. Risky
                           items logged to sdd/.review-needed.md.
                           Trivial cleanup deferred to /sdd clean.
  unleashed                Agent does everything without asking,
                           including trivial cleanup. Commits per
                           category so you can revert by SHA.
                           Refuses to run when enforce_tdd: false
                           (preserves per-project opt-out).

AUTO-RUN  (no /sdd invocation needed)
  Once sdd/ exists, the SDD workflow runs automatically at PR-boundary
  events for PRs targeting main/master: code-reviewer + spec-reviewer
  + doc-updater fire on PR open or on push to a branch with such a
  PR open. All honor sdd/config.yml mode. Vibe-code without sdd/
  works too — agents stay silent until you /sdd init.

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
  documentation/decisions/    ADRs (architectural decision records)

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

    touch /tmp/review-bypass        One-shot sentinel; auto-deleted
                                    on use. Per-session (not committed,
                                    does not survive container restart).
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
                                    (or resumes triage if mid-transition)
  /sdd edit authentication          Add or modify auth requirements
  /sdd add notifications            Create a new domain
  /sdd clean                        Rescue a rotted spec
  /sdd clean --unleashed            Force unleashed mode for one run
  /sdd mode auto                    Switch to auto mode
  /sdd mode unleashed               Switch to walk-away autopilot
  /sdd mode interactive             Back to interactive (default)
  /sdd mode                         Show current mode

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

1. **Check for existing sdd/**:
   - If `sdd/` does not exist → continue to step 2.
   - If `sdd/` exists AND `sdd/init-triage.md` exists AND it contains items with `**Status:** open` → enter **Resume Mode** (jump to "Resume Mode" section below). The user is mid-transition; pick up where the prior session left off.
   - If `sdd/` exists with no open triage items, abort with:
     ```
     Error: sdd/ already exists in this project.
     To rescue an existing rotted spec, use /sdd clean.
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
      /sdd mode auto                → auto (recommended for solo dev)
      /sdd mode unleashed           → walk-away mode (PR-based review)
    ```

17. **NEXT ACTION — MANDATORY**: enter Plan Mode. No code, tests, or config under `src/`, `lib/`, `app/`, `pkg/`, `tests/` before Plan Mode. Hard gate. "build now" / "go" / "execute" / "ship it" / "just do it" authorize starting, never skipping. See `Plan Mode integration` in the `spec-driven-development` skill.

### Import Mode (existing codebase)

When step 2 detected substantive existing code, the agent enters import mode. This is the path for **converting an existing project to SDD as a transition to agentic development**. The completed transition is the gate: once the project is fully on SDD, autonomous agentic coding is unlocked because the agent has a real contract to reason against.

**Two-output model.** Import Mode produces two outputs simultaneously:

1. **Official spec REQs** in `sdd/{domain}.md` — for anything clearly determinable from source, tests, comments, commits, PRs, or existing docs. Normal REQ shape, normal SDD discipline. No `(inferred)` marker, no review queue.
2. **Triage entries** in `sdd/init-triage.md` — for anything unclear or missing: magic numbers without rationale, retry policies without context, ambiguous contracts, orphan code, missing Intent. Each entry carries the agent's **Context** (concrete evidence — file:line, git author, commit refs, related tests/PRs) and **Recommendation** (best-guess answer with one-line rationale). The user reviews context + recommendation and decides — accept, correct, or mark `lost`. They don't perform archaeology from scratch.

**Transition state.** While `sdd/init-triage.md` contains any `open` items, the project is in SDD transition. `sdd/config.yml` carries `transition: true`. During transition:
- spec-reviewer suppresses the Implemented → Partial auto-demote rule (the imported spec is intentionally partial — that's what the triage queue means)
- `/sdd mode unleashed` is rejected (judgment is required for triage; cannot run blind)
- doc-updater and code-reviewer operate normally

When the queue drains to zero (every item is `resolved` or `lost`), `transition: true` clears automatically. Full SDD discipline applies on the next push and autonomous agentic development is unlocked. `sdd/init-triage.md` is preserved as the audit record (`lost` items remain visible as the documented gaps in the spec's heritage).

#### Workflow

1. **Confirm intent with the user**:
   > "Detected existing codebase: {N} source files, {framework} project. I'll derive a spec from the full project history (working tree, git log, pull requests, issues, releases). What I can read clearly becomes official spec. What I can't — magic numbers, retry policies, ambiguous contracts — becomes a triage queue with my best-guess answer attached, for you to confirm or correct at your own pace by re-running `/sdd init`. The project stays in SDD transition until the queue drains, then full autonomous agentic coding is unlocked. Continue, or treat this as a fresh start (ignore existing code)?"
   - If user picks "fresh start": jump to step 4 in the greenfield flow above
   - If user picks "derive from code" (default): continue

2. **Analyze the project** (evidence vacuum). Discovery is NOT limited to source code — intent often lives outside the working tree (in PRs, issues, release notes, code review comments). Pull every available source and weight them equally:
   - **Local working tree**: `README.md`, `package.json` (or equivalent), top-level configs; walk `src/`, `app/`, `lib/`, `pkg/` and identify domains from directory structure (`src/api/auth/` → Authentication, `src/billing/` → Billing; generic structures get 3-5 broad domains)
   - **Tests**: file names + describe/test blocks + assertion shapes (often the most honest record of intended behavior)
   - **Inline comments and docstrings** on entry-point files
   - **Git history**: commit messages on entry-point files via `git log --follow`; tags and their messages (`git tag -l --format='%(refname:short) %(contents:subject)'`)
   - **GitHub Pull Requests** (when a GitHub remote is detected AND `gh` is authenticated): list both open and merged PRs via `gh pr list --state all --limit 200 --json number,title,body,labels,mergedAt`; fetch each PR's review comments and inline review threads via `gh pr view {n} --comments` for the PRs that touch the file or symbol you're classifying. PR descriptions often state the *why* that source code does not.
   - **GitHub Issues** (open + closed): list via `gh issue list --state all --limit 200 --json number,title,body,labels,state,closedAt`; for issues referenced by a PR or commit message, fetch comments via `gh issue view {n} --comments`. Closed issues are especially valuable — they describe bugs that shaped current behavior and decisions that were made and superseded.
   - **GitHub Releases**: `gh release list --limit 50`; for each release, `gh release view {tag}` to read the release notes body. Release notes are a curated record of user-facing intent and explicitly call out behavior changes.
   - **ADR-shaped files** in the working tree: `docs/decisions/`, `ADR/`, `architecture/decisions/`, `documentation/decisions/`
   - **Wiki** (when present): `gh api repos/{owner}/{repo}/wikis` — many legacy projects keep design notes there rather than in the repo

   Cross-reference: when a PR description says "Closes #142", pull issue #142's body and comments too. When a release note says "fixes the bug from #87 and the discussion in PR #93", pull both. Intent typically traces backward through several artifacts; the agent follows the chain rather than stopping at the first hit.

   **Degradation when GitHub sources are unreachable.** The GitHub corpus is best-effort, not mandatory. Detect failure conditions up front (no GitHub remote — e.g. GitLab / Bitbucket / Forgejo / Gerrit; `gh auth status` fails; rate-limited; private repo with insufficient token scope; air-gapped network). If any condition holds, skip the GitHub sources entirely and proceed with working-tree + git-log evidence only. Print a one-line notice to the user before scaffolding: `Note: discovery used working tree + git log only ({reason} — GitHub sources unavailable). Triage entries reference local evidence only.` Append the same notice to `sdd/changes.md` import entry. Triage entry Context fields list whatever artifact refs are available (PR numbers if reachable, otherwise file:line + commit ref only); the audit trail honestly reflects what the agent saw.

3. **For every observable feature/route/page/job, classify into one of two buckets**:

   **CLEAR** (becomes a normal REQ in `sdd/{domain}.md`):
   - Route handler with a named schema + a test that names the expected behavior
   - Function whose docstring, README mention, or PR description states intent
   - Config field with a comment naming its purpose
   - Commit message that explicitly states the why ("add foo to support X requirement")
   - Existing ADR or architecture doc that describes the feature

   **UNCLEAR** (becomes a triage entry in `sdd/init-triage.md`):
   - Magic numbers / timeouts / batch sizes / retry counts with no comment / test / PR explaining the choice
   - Guards or branches that handle unnamed conditions (`if (user.id === 'legacy_42') skip()`)
   - Tests that document behavior but no source/commit/PR/doc explains why that behavior exists
   - Endpoints, jobs, or queue consumers that exist but are unreferenced (invisible-path vs dead code is a decision the user must make)
   - Vendor-specific workarounds where the underlying constraint isn't documented
   - Domain placement the agent had to guess
   - Whole REQs whose Intent the agent had to guess — file as triage, not as a REQ with `(inferred)`

4. **For each UNCLEAR item, build a triage entry with Context AND Recommendation populated**. The agent performs the archaeology and presents findings. The user decides on substance, not from scratch.

   - **Context fields**: file path + line range, git author of last meaningful change to that range, commit SHA + subject, adjacent comments, related test names, PR numbers that touch the file or symbol, similar patterns elsewhere in the codebase
   - **Recommendation**: a specific best-guess answer with a one-line rationale tying it to evidence in Context. Never `TBD`, never `(inferred)`. If the agent genuinely cannot make a recommendation, the entry is filed as `**Recommendation:** Cannot determine — likely lost ({why})` and the user can confirm `lost` directly

   Each triage entry shape:
   ```
   ## TRIAGE-{NNN}
   **Domain:** {domain — sorting | auth | billing | ...; the spec domain the answer will fold into}
   **Target REQ:** {REQ-X-NNN if updating an existing REQ, or `new-in-{domain}` if the resolution will create a new REQ}
   **Question:** {specific, decidable question — not "what's the intent?"}
   **Context:**
   - {file:line, git author, commit ref, related tests, related PR/issue/release numbers, adjacent code}
   **Recommendation:** {best-guess answer}
   **Rationale:** {one line tying recommendation to specific Context evidence}
   **Status:** open
   **Resolution:** {written by Resume Mode after accept/correct; blank while open}
   ```

   `Domain` and `Target REQ` are populated by Import Mode at entry creation, so Resume Mode's fold-in is deterministic (no re-inference at resolution time). `new-in-{domain}` items create a fresh REQ in `sdd/{domain}.md` on `accept`; existing-REQ items update Intent or ACs on the named REQ.

   A `**Reason:**` field is appended only when an item is marked `lost` (one-line explanation of why information is genuinely unrecoverable). Not part of the canonical shape for `open` or `resolved` entries.

5. **Derive CLEAR REQs** (the official spec):
   - **Intent**: lifted directly from the evidence (README sentence, PR description, commit message, docstring)
   - **Acceptance Criteria**: observable behavior at the user-facing level, derived from named test assertions or documented contracts
   - **Status**: `Implemented` if a test verifies the AC, `Partial` otherwise (one-time import baseline; future runs respect `enforce_tdd`)
   - **Priority**: P0 for core flows, P1 for supporting features, P2 for polish, P3 for stretch
   - **Dependencies**: cross-domain links from imports
   - **Verification**: `Automated test` if a test references the feature, `Manual check` otherwise

6. **Identify cross-cutting constraints** by reading config files and middleware (tech stack from manifests, security headers from middleware, performance budgets from CI config, compliance markers from privacy/legal files). Each becomes a `CON-*` entry. Constraints that the agent can't justify from evidence also go to triage.

7. **Write CLEAR REQs silently** to `sdd/{domain}.md` files. No user confirmation. The agent's confidence threshold (single matching domain + unambiguous behavior + clear evidence in code/PRs/tests) is the gate; anything not meeting it became a triage entry in step 4. Print triage queue size: "{T} items in triage queue at `sdd/init-triage.md`. Run `/sdd init` again to resume triage, one item at a time, at your own pace." Do NOT walk through every triage item now; that's what Resume Mode does on subsequent `/sdd init` runs. To correct any CLEAR REQ after import, the user runs `/sdd edit {domain}`.

8. **Optionally fill in vision and principles** (same as before: pre-fill from README, user confirms or rewrites).

9. **Write the scaffolding**:
   - `sdd/README.md` with derived domain index and Out of Scope section (empty)
   - One `sdd/{domain}.md` per derived domain with CLEAR REQs
   - `sdd/constraints.md` with derived CON-* entries
   - `sdd/glossary.md` with terms from code (vendor names, protocols, domain concepts)
   - `sdd/changes.md` with one entry: `## YYYY-MM-DD\n- Initial spec imported via /sdd init (N clear REQs across M domains, T triage items — see sdd/init-triage.md)`
   - `sdd/config.yml` with `mode: interactive`, `enforce_tdd: false`, and **`transition: true`** (cleared automatically when triage drains)
   - **`sdd/init-triage.md`** with all triage entries (each with Context + Recommendation populated)
   - `documentation/` scaffolding from templates, with backlinks to CLEAR REQs where applicable
   - Root `README.md` updated to reference `sdd/` and `documentation/` (preserve existing content — append the SDD section)

10. **Print next steps**:
    ```
    ✓ Spec imported from existing codebase
    ✓ {N} clear requirements across {M} domains
    ✓ {T} triage items in sdd/init-triage.md (each with context + recommendation)
    ✓ {Z} CON-* constraints derived
    ✓ sdd/config.yml created (mode: interactive, enforce_tdd: false, transition: true)
    ✓ Project is in SDD TRANSITION until the triage queue drains

    Resume triage at your own pace by running `/sdd init` again — it
    surfaces one open item at a time. Quit any time; progress is committed
    after each decision.

    While transition is active:
      - PR-boundary review pipeline is suspended (no spec-reviewer,
        code-reviewer, or doc-updater fires on push or PR events)
      - /sdd mode unleashed is rejected (triage requires judgment)

    When the queue drains to zero:
      - transition: true clears automatically
      - Full SDD discipline applies on the next push
      - Autonomous agentic development is unlocked

    Your code is unchanged. Only sdd/, documentation/, and root README were created.
    ```

#### Import mode safety rules

- **Never edit existing source code** during import — only read it
- **Never overwrite existing `README.md`** — append the SDD section, preserve existing content
- **Never overwrite existing `documentation/`** files — only create files that don't exist
- **Triage entry Context must be concrete** — file paths + line ranges + commit refs + author names + related PR numbers. Vague Context (no refs, no authors, no commits) is grounds for rerun. The user must be able to verify the recommendation against the cited evidence.
- **Triage entry Recommendation must be a specific answer with a Rationale**, never `(inferred)`, `TBD`, or `unknown`. If the agent genuinely cannot determine the answer, file as `**Recommendation:** Cannot determine — likely lost ({why})` so the user can confirm `lost` in one step.
- **CLEAR REQs are written without user confirmation** (the confidence threshold IS the gate). Only the triage queue surfaces unclear/ambiguous items for user judgment, one at a time, in Resume Mode.
- **Default `enforce_tdd: false` for imports** — the imported code predates the test-naming convention. User opts in after adding REQ-ID references to test names. Greenfield `/sdd init` still defaults to `enforce_tdd: true`.

### Resume Mode

Triggered when `/sdd init` is invoked on a project where `sdd/` already exists and `sdd/init-triage.md` has at least one `**Status:** open` item. The user is mid-transition; resume the interactive triage where the prior session left off.

**Resume Mode is always interactive**, regardless of `mode` in `sdd/config.yml`. If config says `mode: auto`, print a one-line notice before step 1: `Note: mode: auto is suspended for this run — Resume Mode is always interactive because each triage decision requires user judgment.` After the queue drains, the normal mode resumes for subsequent runs.

1. **Check working tree cleanliness**: if `git status --porcelain` is non-empty, refuse to start Resume Mode:
   ```
   Error: working tree has uncommitted changes. Resume Mode commits per
   decision, and your WIP would get pulled into a [sdd-init] resolve
   commit. Stash or commit first, then re-run /sdd init.
   ```
   Same rule as `/sdd clean`'s working-tree gate.

2. **Sanity-check transition state**: read `sdd/config.yml`. If the file is missing entirely, create it from the template with `mode: interactive`, `enforce_tdd: false`, `transition: true` and continue (recover quietly - the triage queue is the authoritative state, config.yml is regenerable). If the file exists but lacks `transition: true` while open items exist in `sdd/init-triage.md`, set it back to `true`. If `transition: true` is set but `sdd/init-triage.md` is missing or unreadable, abort with: `Error: sdd/config.yml has transition: true but sdd/init-triage.md is missing. Either restore the triage file from git history or remove transition: true manually before re-running /sdd init.`

3. **Read `sdd/init-triage.md`**, collect items with `**Status:** open` in file order. Report queue size: `{N} open items in triage queue. Press [q] at any prompt to quit; progress is committed after each decision.`

4. **For the next open item, REFRESH Context** before surfacing. The original Context was a snapshot from a prior session; the codebase may have evolved. Re-read the referenced file at the cited lines, re-check `git log` for new commits touching the range, re-scan adjacent tests, re-fetch related PRs / issues / releases via `gh` if available. Update the entry's Context block in place if it has shifted materially.

5. **Surface the item** with the refreshed Context and Recommendation. The agent shows the item's `**Domain:**` and `**Target REQ:**` so the user knows which REQ will receive the fold-in:

   ```
   ━━━ TRIAGE-007 ({position} of {total} open) ━━━

   Domain: {domain}
   Target REQ: {REQ-X-NNN or new-in-{domain}}

   Question: {question}

   Context:
     - {evidence lines}

   Recommendation: {best-guess answer}
   Rationale: {one line tying to Context evidence}

   Decision:
     [a] accept recommendation as-is
     [c] correct: describe what this is for and how it works (free-form prose)
     [l] lost: information genuinely unrecoverable (one-line Reason required)
     [s] skip for now (stays open)
     [q] quit (commit progress, exit)
   ```

6. **Apply the decision**. Only `accept` and `correct` promote anything into the official spec. `skip` and `lost` do not:
   - **accept**: write recommendation into `**Resolution:**`, set `**Status:** resolved`, **fold the answer into the named Target REQ**. If `**Target REQ:**` is `new-in-{domain}`, create a new REQ in `sdd/{domain}.md` with the resolution as its Intent and a test-derived AC. If it's `REQ-X-NNN`, update the named REQ's Intent or AC.
   - **correct**: open an editor / prompt for free-form prose. The user describes **what this is for** (purpose, which becomes the REQ's Intent) and **how it works** (observable behavior, which becomes the REQ's AC). The whole prose block is written into `**Resolution:**`. The agent folds purpose into Intent and behavior into AC bullets on the named Target REQ, set `**Status:** resolved`.
   - **lost**: prompt for a one-line `**Reason:**`, write it into the entry's `**Reason:**` field, set `**Status:** lost`. **No fold into spec.** The Target REQ (if it exists) gets a `Notes: intent lost during SDD transition — see TRIAGE-{NNN}` annotation; otherwise the item stays only in `sdd/init-triage.md` as the documented gap.
   - **skip**: leave `**Status:** open` unchanged. **The triage item stays in `sdd/init-triage.md` and nothing is written to the spec.** Advance to the next open item. Skipped items resurface on the next `/sdd init` Resume Mode run.
   - **quit**: stop, commit, exit. Open items (including any just skipped) remain in `sdd/init-triage.md` for the next session.

7. **Commit per decision**: each `accept`/`correct`/`lost` is its own commit with subject `[sdd-init] resolve TRIAGE-{NNN}` (or `mark lost`). Crash-safe; the `[sdd-init]` prefix is excluded from the spec-reviewer round-counter (per `spec-discipline.md`), so a long triage session does not trip the 2-round spiral guard.

8. **Transition-closure check** runs after every resolved/lost decision. When zero `**Status:** open` items remain:
   - Clear `transition: true` from `sdd/config.yml`
   - Append to `sdd/changes.md`: `## YYYY-MM-DD\n- SDD transition complete. {Total} triage items resolved ({R} accepted, {C} corrected, {L} lost). Full SDD discipline now applies; autonomous agentic development unlocked.`
   - Note: `enforce_tdd` is NOT auto-flipped. The user flips it manually when ready for TDD enforcement (typically after adding REQ-ID references to test names in the imported source). The import-time `enforce_tdd: false` stays in effect until the user changes it.
   - Print:
     ```
     ✓ Triage queue drained. SDD transition complete.
     ✓ Full SDD discipline applies on the next push.
     ✓ Autonomous agentic development is unlocked.

     sdd/init-triage.md preserved as audit record.

     NEXT STEP — enter Plan Mode to plan the first feature work on top of
     the freshly-completed spec. The same Plan-Mode gate that protects
     greenfield init applies here: no source/test/config edits before
     planning. "go" / "execute" / "ship it" / "build now" authorize
     starting the plan, never skipping it.
     ```
   - Enter Plan Mode (same gate as greenfield `/sdd init` step 17).

To re-open a previously resolved or lost item, the user edits `sdd/init-triage.md` directly: change `**Status:**` back to `open`. The next `/sdd init` Resume Mode run surfaces it again. Note: re-opening does NOT automatically un-fold the prior Resolution from the Target REQ — the user reverts that edit manually (the REQ history is in `git log sdd/{domain}.md`).

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
4. **Branch responsibility**: `auto` and `unleashed` modes push to whatever branch is currently checked out. The user is responsible for checking out the right branch before invoking - if commits land on `main`/`master`, that's a user-side branch choice, not an enforcement layer.
5. **Scan for findings** (across the resolved scope from step 2):
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
   - False-positive ADRs in `documentation/decisions/` per `documentation-discipline.md` "What is NOT an ADR" (MEDIUM, AUTO-RECLASSIFY in `auto`/`unleashed`): static-analyzer accommodations move to inline source comments + `documentation/troubleshooting.md` if recurring; naming/spelling-compat notes move to `documentation/configuration.md`; risk-acceptance with no alternative considered moves to `documentation/security.md`; implementation-notes-as-decisions are deleted or moved to `pending.md`. The original `### AD-N:` heading is preserved as a `Status: Reclassified on YYYY-MM-DD` stub so inbound `AD-N` references keep resolving. Findings on entries already carrying `Status: Reclassified` or `Status: Merged into` are suppressed.
6. **Apply per mode**:
   - **interactive**: report findings batch by batch, ask confirmation
   - **auto**: apply SAFE + RISKY silently, escalate JUDGMENT to `sdd/.review-needed.md`
   - **unleashed**: apply SAFE + RISKY + JUDGMENT (conservative defaults), commit per category, push directly to current branch
7. **All commits tagged `[sdd-clean]`** to bypass spec-reviewer's round-detection
8. **Backup before destructive ops**: archive `changes.md` to `changes-archive-YYYY-MM.md` before truncating
9. **Write `sdd/.last-clean-run.md`** with full audit log
10. **In unleashed mode**, each commit message includes its audit log excerpt so the user can review per-category when they return (also see `sdd/.last-clean-run.md`)

### Conservative JUDGMENT auto-resolution (unleashed only)

| JUDGMENT type | Action |
|---|---|
| Doc-vs-spec conflict | Mark REQ as `Partial`, add `Notes:`, log to `.review-needed.md`. Never overwrite intent. |
| Oversized REQ refactor | Extract implementation prose to `documentation/{relevant}.md`, leave Intent + AC verbatim in REQ. Never split. |
| Fake-Deprecated REQ | Move to `## Out of Scope` section in domain README. Never delete. |

---

## /sdd mode

Set or read the autonomy mode.

### Behavior

```
/sdd mode interactive   → write `mode: interactive` to sdd/config.yml
/sdd mode auto          → write `mode: auto` to sdd/config.yml
/sdd mode unleashed     → write `mode: unleashed` to sdd/config.yml
/sdd mode               → print current mode
```

If `sdd/config.yml` doesn't exist, create it from the template first. If `sdd/` doesn't exist, error out: "No SDD project here. Run `/sdd init` first."

**Transition gate.** Before writing `mode: unleashed`, read `sdd/config.yml` and check for `transition: true`. If set, refuse with:

```
Error: project is in SDD transition (sdd/init-triage.md has open items).
Unleashed mode applies fixes without confirmation, which is incompatible
with triage entries that require user judgment to resolve. Drain the
triage queue first (run `/sdd init` again to resume), then re-run
`/sdd mode unleashed`.
```

`/sdd mode auto` and `/sdd mode interactive` are both allowed during transition; they do not bypass user judgment on individual triage items.

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
- `/sdd mode auto` - switch to auto mode
- `/sdd mode unleashed` - switch to unleashed mode
- `/sdd mode` - show current mode

---

## Implementation note

The `/sdd` command itself does not contain the SDD logic. It dispatches to the workflow described in `~/.claude/skills/spec-driven-development/SKILL.md`, the rules in `~/.claude/rules/spec-discipline.md`, and the templates in `~/.claude/skills/spec-driven-development/references/templates/`.

When invoked, the agent should:
1. Parse `$ARGUMENTS` to identify the sub-command
2. Read the relevant sections of SKILL.md and the rules file
3. Execute the sub-command's behavior as documented above
4. Report results to the user
