# Comprehensive Multi-Perspective Codebase Review

Run a full codebase review from 6 specialized perspectives using parallel agents, cross-reference findings, filter against architecture decisions, optionally verify with external LLMs, then triage interactively with the user.

**Review mode:** static analysis only — no runtime, build, or test validation performed.

## Context Preservation

**CRITICAL:** The main session agent is primarily an orchestrator. All source-code analysis and all reading of files `01-07` and `TECHNICAL.md` MUST be delegated to Task agents.

The main agent may read only:
- After Phase 4: summary via `head -n 20` (Bash tool)
- After Phase 5: summary via `head -n 20` (Bash tool)
- Phase 6: the `## Active Findings` section of `08-active-findings.md` for triage
- Phase 9: the `## Fix` section of `09-triage-results.md` to enter plan mode

The main agent must never read source files, `01-07`, or `TECHNICAL.md` directly.

## Arguments

$ARGUMENTS can include:
- `--verify-high` — after AD filtering, send HIGH and CRITICAL findings to external code LLMs for verification and fix proposals
- Any other text is passed as additional context/scope to all review agents (e.g., "focus on src/routes/" or "review the auth system")

## Phase 1: Create Run Directory (main agent)

Create a timestamped output directory to avoid overwriting previous runs:
```bash
REVIEW_DIR=~/workspace/tmp/review/$(date +%Y%m%d-%H%M%S)
mkdir -p "$REVIEW_DIR"
ln -sfn "$REVIEW_DIR" ~/workspace/tmp/review/latest
```

Use `$REVIEW_DIR` for ALL output files in every subsequent phase. Print the path so the user can reference it.

## Phase 2: Parallel Agent Dispatch (6 Task agents)

Launch **all 6 agents in parallel** using the Task tool. Each agent reviews the codebase (or scoped area if $ARGUMENTS specifies) and writes structured findings to its output file.

| # | Agent subagent_type | Output File | Focus |
|---|---------------------|-------------|-------|
| 1 | `security-reviewer` | `$REVIEW_DIR/01-security.md` | Secrets, injection, auth, OWASP top 10, dependency vulns |
| 2 | `architect` | `$REVIEW_DIR/02-architecture.md` | System design, modularity, coupling, scalability, patterns |
| 3 | `code-reviewer` | `$REVIEW_DIR/03-code-quality.md` | Code quality, naming, error handling, readability, complexity |
| 4 | `refactor-cleaner` | `$REVIEW_DIR/04-dead-code.md` | Dead code, unused exports, duplication, consolidation opportunities |
| 5 | `tdd-guide` | `$REVIEW_DIR/05-test-gaps.md` | Test coverage gaps, untested critical paths, test quality |
| 6 | `doc-updater` | `$REVIEW_DIR/06-documentation.md` | Missing/outdated docs, stale comments, README gaps, API doc coverage |

### Agent Prompt Template

Each agent prompt MUST include:

1. The project root path
2. The exact `$REVIEW_DIR` path for output
3. Any additional context from $ARGUMENTS (excluding `--verify-high`)
4. The severity rating schema
5. The output format specification
6. Instruction to write output to its designated file using the Write tool

Use this prompt structure for each agent (adjust focus area per agent type):

```
You are conducting a comprehensive codebase review of the project at [PROJECT_ROOT].

[ADDITIONAL_CONTEXT if provided]

Review the codebase thoroughly. Use Glob and Grep to explore, Read to examine files.

Rate each finding with one of these severities:
- CRITICAL: Security vulnerabilities, data loss risks, production-breaking issues
- HIGH: Significant bugs, major design flaws, serious maintainability issues
- MEDIUM: Code smells, minor design issues, moderate improvements needed
- LOW: Style issues, minor suggestions, nice-to-haves

Write your findings to [OUTPUT_FILE] using the Write tool. Use this format for each finding:

## [SEVERITY] Short descriptive title

- **ID:** [AGENT_PREFIX]-[NNN] (e.g., SEC-001, ARCH-001, QUAL-001, DEAD-001, TEST-001, DOCS-001)
- **Location:** path/to/file.ts:123 (or path/to/dir/, "multiple files", or "repository-wide")
- **Category:** e.g., "Missing input validation"
- **Confidence:** high | medium | low
- **Description:** What the issue is and why it matters
- **Suggestion:** How to fix it

At the top of the file, include:
# [REVIEW_TYPE] Review
**Scope:** [full codebase or scoped area]
**Findings:** [total count]

Focus on: [AGENT-SPECIFIC FOCUS AREA]

Do NOT run any builds, tests, or linters locally. Read and analyze the code only.
```

Agent ID prefixes: SEC (security), ARCH (architecture), QUAL (code-quality), DEAD (dead-code), TEST (test-gaps), DOCS (documentation).

### CRITICAL: All 6 agents MUST be launched in a SINGLE message with 6 parallel Task tool calls.

If the environment does not support 6 parallel Task calls, launch in batches of 3. If any agent fails, retry once. If it still fails, continue with successful reports and note the missing report in the summary.

Wait for all 6 agents to complete before proceeding to Phase 3.

## Phase 3: Cross-Reference (Task agent)

Launch a single Task agent (`code-reviewer` type). The agent:

1. Discovers available report files dynamically (some agents may have failed)
2. **Deduplicates**: when 2+ agents flag the same underlying issue, produces one canonical finding with merged title, union of source agent IDs, highest severity from any agent, and combined suggestions. Preserves original finding IDs as references.
3. Identifies **cross-domain findings** — issues flagged by 2+ agents from different angles (elevate confidence)
4. Identifies **false positives** — findings that contradict each other or are explained by context in other reports
5. Identifies **emergent patterns** — systemic issues only visible when combining perspectives
6. Writes consolidated output to `$REVIEW_DIR/07-cross-reference.md`

Task agent prompt:

```
Use Bash to run: ls [REVIEW_DIR]/0*.md
Read ONLY the files that actually exist. Some review agents may have failed — do not attempt to read missing files.

Perform cross-referencing analysis:

1. DEDUPLICATION: When 2+ agents flag the same underlying issue, merge into one canonical finding:
   - Canonical ID: CF-NNN
   - Raw IDs: list all original IDs (e.g., SEC-003, QUAL-014)
   - Severity: highest from any agent
   - Confidence: highest from any agent
   - Source agents: union of all agents that flagged it
   - Description: merged from all perspectives
   - Suggestion: combined recommendations
   Deduplicate by location+category match or semantic similarity.

2. CROSS-DOMAIN FINDINGS: Among canonical findings, flag those confirmed by 2+ agents.
   These have higher confidence.

3. FALSE POSITIVES: Identify findings contradicted by context in other agent reports.
   Explain the reasoning for each removal.

4. EMERGENT PATTERNS: Identify systemic issues only visible when combining multiple review perspectives.
   Example: "all 3 API routes lack validation" or "test gaps align with the most complex modules."

Write output to [REVIEW_DIR]/07-cross-reference.md using this format:

# Cross-Reference Analysis

## Canonical Findings
[One entry per canonical finding with CF-NNN ID, raw IDs, merged details]

## Cross-Domain Findings (elevated confidence)
[List CF-NNN IDs confirmed by 2+ agents]

## False Positives Removed
[Findings contradicted by other perspectives, with reasoning]

## Emergent Patterns
[Systemic issues visible only across multiple review perspectives]

## Statistics
- Reports analyzed: X of 6
- Total raw findings across all agents: X
- Canonical findings after dedup: X
- Cross-domain (elevated): X
- False positives removed: X
- Emergent patterns identified: X
```

## Phase 4: AD Filtering (Task agent)

Launch a single Task agent (`code-reviewer` type) to perform architecture decision filtering.

Task agent prompt:

```
You are filtering codebase review findings against documented architecture decisions.

1. Read [REVIEW_DIR]/07-cross-reference.md — canonical findings are the primary source of truth.
2. Search TECHNICAL.md in the project root for architecture decisions. If TECHNICAL.md does not exist or contains no architecture decision entries, write [REVIEW_DIR]/08-active-findings.md with ALL canonical findings marked active (zero AD-guarded) and stop.
3. You may read CLAUDE.md files for implementation context, but ONLY TECHNICAL.md has authority to justify AD-guarding. Do not AD-guard a finding based solely on CLAUDE.md.
4. For each canonical finding, check if an architecture decision in TECHNICAL.md explicitly justifies the flagged pattern.

AD-Guard Rules (strict):
A finding may ONLY be marked AD-GUARDED if ALL of these are true:
- The AD explicitly references the exact pattern or tradeoff
- The implementation materially matches the AD constraints
- The finding is about an intentional design tradeoff, not a correctness or safety defect
- The finding is NOT severity CRITICAL
- HIGH findings may only be AD-guarded if they are architectural tradeoffs, not bugs or security issues

Each AD-guarded finding must record:
- The exact AD title/heading from TECHNICAL.md
- The relevant quote from the AD

5. Write the filtered active findings list to [REVIEW_DIR]/08-active-findings.md.

Format for 08-active-findings.md:

# Active Findings
**Source:** [REVIEW_DIR]
**Total canonical findings:** X
**AD-guarded (removed):** X
**Active:** X

## Summary

                 Raw    Canonical    AD-Guarded    Active
CRITICAL:         X          X            X          X
HIGH:             X          X            X          X
MEDIUM:           X          X            X          X
LOW:              X          X            X          X

Agents: security, architecture, code-quality, dead-code, test-gaps, documentation
Cross-reference: X canonical, X cross-domain, X false-positives removed, X emergent patterns
AD refs checked: TECHNICAL.md (X decisions)
Review mode: static analysis only

## AD-Guarded Findings (removed from active list)
### CF-NNN: Title — AD-GUARDED
- **AD ref:** "AD title" from TECHNICAL.md
- **Quote:** "relevant AD text"

## Active Findings
### CF-NNN: Title
- **Severity:** HIGH
- **Confidence:** high
- **Raw IDs:** SEC-003, QUAL-014
- **Location:** path/to/file.ts:123
- **Category:** Missing input validation
- **Source agents:** security-reviewer, code-reviewer
- **Description:** ...
- **Suggestion:** ...
```

After the Task agent completes, use Bash to run `head -n 20 "$REVIEW_DIR/08-active-findings.md"` and print the output to the user.

**Orchestrator check:** If the Active column totals are all 0, output "Clean review - no actionable findings" and STOP. Do not proceed to Phase 5 or beyond.

If `--verify-high` is NOT in $ARGUMENTS, skip Phase 5 and proceed to Phase 6.

## Phase 5: LLM Verification (Task agent — only when --verify-high is present)

Launch a single Task agent (`code-reviewer` type) to verify HIGH and CRITICAL findings with external LLMs.

Task agent prompt:

```
You are verifying HIGH and CRITICAL review findings using external LLMs.

1. Read [REVIEW_DIR]/08-active-findings.md — the Active Findings section.
2. For each HIGH and CRITICAL finding:
   a. Read the relevant source file and extract the minimal relevant code section.
   b. Call consult_llm MCP tool for both models. Execute concurrently if the environment permits, otherwise sequentially:
      - Model 1: gpt-5.4 with task_mode: "review"
      - Model 2: gemini-3.1-pro-preview with task_mode: "review"
   c. Include in each prompt: the finding details (canonical ID, severity, location, description) and the relevant source code.
   d. Ask each LLM to: confirm or refute the finding, provide a concrete fix if confirmed, explain why it's a false positive if refuted.

3. Process results for each finding:
   - If BOTH LLMs refute → mark as LLM-REFUTED and remove from active list
   - If BOTH confirm → enrich finding with their fix proposals
   - If they disagree → keep the finding, note the disagreement
   - If one LLM call fails → mark as LLM-PARTIAL, keep the finding active
   - If both LLM calls fail → mark as LLM-UNAVAILABLE, keep the finding active

4. Rewrite [REVIEW_DIR]/08-active-findings.md with updated findings:
   - Remove LLM-REFUTED findings from the Active Findings section
   - Add LLM verdicts and fix proposals to confirmed findings
   - Update the Summary table — add a Verified column
   - Add a new section: "## LLM-Refuted Findings (removed)" listing removed findings with refutation reasoning
```

After the Task agent completes, use Bash to run `head -n 20 "$REVIEW_DIR/08-active-findings.md"` and print the output to the user.

**Orchestrator check:** If the Active column totals are all 0, output "Clean review - no actionable findings after LLM verification" and STOP.

## Phase 6: Interactive Triage (main agent)

This is the ONLY phase that runs in the main session context.

Read `$REVIEW_DIR/08-active-findings.md` — specifically the `## Active Findings` section.

### Pre-Triage Summary

Before asking per-finding questions, present a triage summary showing:
- Counts by severity
- Top modules/directories affected
- Top repeated categories

Then ask one setup question via `AskUserQuestion`:
- **Triage all severities** — walk through every finding interactively
- **CRITICAL/HIGH only** — triage CRITICAL and HIGH interactively; auto-defer MEDIUM and LOW
- **CRITICAL/HIGH interactive, batch MEDIUM/LOW by module** — triage top severities individually, group lower severities by module

### Triage Options

For each finding or batch of related findings, use `AskUserQuestion` with these options:

**For CRITICAL findings and security/correctness defects:**
- **Fix** — include in the implementation plan (Phase 9)
- **Technical debt** — add to the Technical Debt section of TECHNICAL.md for future resolution
- **Defer** — needs more investigation before deciding; carry forward to next review
- **Ignore** — requires explicit reason

**For all other findings:**
- **Fix** — include in the implementation plan (Phase 9)
- **Record as AD** — record as an architecture decision in TECHNICAL.md that justifies this pattern going forward (only valid for intentional tradeoffs, not bugs or security issues)
- **Technical debt** — add to the Technical Debt section of TECHNICAL.md for future resolution
- **Defer** — needs more investigation before deciding; carry forward to next review
- **Ignore** — dismiss as false positive or acceptable

### Batching Rules

- **CRITICAL**: ask individually unless exact duplicates
- **HIGH**: batch by root cause or module
- **MEDIUM/LOW**: batch aggressively by module or remediation pattern
- Never ask one question per LOW finding unless it is uniquely important
- Example: "5 dead-code findings in src/lib/legacy/" → single question
- For batched questions, include a **Split** option so the user can break the batch and decide per-finding
- Show: canonical ID, severity, location, description, suggestion (and LLM verdict if Phase 5 ran)

### Question Format
```
[SEVERITY] CF-NNN: Finding Title
Location: path/to/file.ts:123
Category: Missing input validation
Confidence: high
Description: The route handler accepts user input without sanitization...
Suggestion: Add zod schema validation at the route boundary
[LLM Verdict: Confirmed by GPT-5.4 and Gemini — both suggest zod schema]
```

After all triage questions are answered, collect the decisions into a strict JSON mapping and proceed to Phase 7:
```json
{"CF-001": "fix", "CF-002": "ad", "CF-003": "debt", "CF-004": "defer", "CF-005": "ignore"}
```

Pass this EXACT JSON string as the decisions mapping to the Phase 7 Task agent.

## Phase 7: Save Triage Results (Task agent)

Launch a single Task agent (`code-reviewer` type) to write the consolidated triage results.

Pass the triage decisions JSON mapping and `$REVIEW_DIR` path in the prompt.

Task agent prompt:

```
You are saving triage results from a codebase review.

Triage decisions (JSON): [DECISIONS_JSON]

1. Read [REVIEW_DIR]/08-active-findings.md to get full finding details.
2. Write [REVIEW_DIR]/09-triage-results.md with findings sorted into sections by triage decision.

Format:

# Triage Results
**Run:** [REVIEW_DIR]
**Review mode:** static analysis only

## Fix (X findings)

### CF-NNN: [SEVERITY] Finding Title
- **Raw IDs:** SEC-003, QUAL-014
- **Location:** path/to/file.ts:123
- **Category:** Missing input validation
- **Confidence:** high
- **Description:** What the issue is
- **Suggestion:** How to fix it
- **Source agents:** security-reviewer, code-reviewer
- **LLM verdict:** [if Phase 5 ran]

[...repeat for each Fix finding]

## Record as AD (X findings)

### CF-NNN: [SEVERITY] Finding Title — AD
- **Location:** path/to/file.ts:456
- **Pattern:** The pattern being justified
- **Rationale:** Why this is an intentional architecture decision
- **AD entry:**
  #### AD: [Title]
  - **Status:** Accepted
  - **Context:** [why this decision was made]
  - **Decision:** [what was decided]
  - **Consequences:** [tradeoffs accepted]

[...repeat for each AD finding]

## Technical Debt (X findings)

### CF-NNN: [SEVERITY] Finding Title — TECH DEBT
- **Location:** path/to/file.ts:789
- **Category:** e.g., "Dead code"
- **Description:** What the issue is
- **Suggestion:** How to fix it
- **Debt entry:**
  #### TD: [Title]
  - **Severity:** [severity]
  - **Area:** [module/component]
  - **Why deferred:** [reason]
  - **Suggested remediation:** [approach]

[...repeat for each Tech Debt finding]

## Deferred (X findings)

### CF-NNN: [SEVERITY] Finding Title — DEFERRED
- **Location:** path/to/file.ts:345
- **Reason:** Needs further investigation

[...repeat for each Deferred finding]

## Ignored (X findings)

### CF-NNN: [SEVERITY] Finding Title — IGNORED
- **Location:** path/to/file.ts:012
- **Reason:** [reason provided by user]

[...repeat for each Ignored finding]
```

## Phase 8: Update TECHNICAL.md (Task agent)

Launch a single Task agent (`code-reviewer` type) to update TECHNICAL.md with AD and Tech Debt entries.

Task agent prompt:

```
You are updating TECHNICAL.md with architecture decisions and technical debt entries from a codebase review.

1. Read [REVIEW_DIR]/09-triage-results.md — specifically the "Record as AD" and "Technical Debt" sections.
   If both sections are empty (0 findings each), write "No TECHNICAL.md updates needed" and stop.

2. Read TECHNICAL.md in the project root. If it does not exist, create it using the Write tool with this template:
   # Technical Documentation
   ## Architecture Decisions
   ## Technical Debt

3. For each "Record as AD" entry:
   - Search existing Architecture Decisions for an equivalent entry by title or pattern
   - If found, update the existing entry using the Edit tool
   - If not found, insert the new AD entry under the ## Architecture Decisions heading using the Edit tool

4. For each "Technical Debt" entry:
   - Search existing Technical Debt for an equivalent entry by title or area
   - If found, update the existing entry using the Edit tool
   - If not found, insert the new TD entry under the ## Technical Debt heading using the Edit tool

IMPORTANT: Read the full file first to locate exact heading positions. Use the Edit tool to insert content under the correct headings. Do NOT simply append to the end of the file.
```

## Phase 9: Enter Plan Mode (main agent)

After Phase 8 Task agent completes:

1. Read ONLY the `## Fix` section from `$REVIEW_DIR/09-triage-results.md`
2. If there are zero Fix findings, report "No fixes requested — review complete" and stop
3. Enter plan mode with `EnterPlanMode`
4. Create an implementation plan organized by:
   - **Priority**: Security fixes first, then architecture, then code quality, then others
   - **Dependency order**: Fixes that enable other fixes come first
   - Each fix as a concrete task with:
     - Canonical ID and raw IDs
     - File paths and line numbers
     - Proposed changes (from agent suggestions and LLM proposals if available)
     - Severity and category
5. Note: AD and Tech Debt entries were already written to TECHNICAL.md in Phase 8

## Important Notes

- **NEVER run builds, tests, or linters locally** — the container has 1 vCPU
- All 6 Phase 2 agents MUST launch in a single message (parallel Task calls)
- Phases 3, 4, 5, 7, 8 each run as a single Task agent — main agent waits for completion before proceeding
- Phase 6 is the ONLY phase that runs in the main session context (requires AskUserQuestion)
- Phase 5 is opt-in via `--verify-high` flag
- After Phase 4 and Phase 5: check if Active totals are 0 — if so, STOP and report clean review
- Each phase MUST complete fully before proceeding to the next — no phase is optional except Phase 5
- Findings directory persists at `$REVIEW_DIR` for later reference; `~/workspace/tmp/review/latest` always points to the most recent run
