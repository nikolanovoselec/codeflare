---
name: review
description: Pi-native Codeflare /review workflow. Run a full multi-perspective codebase review from 6 specialized subagents, cross-reference findings, filter against architecture decisions and prior triage, optionally verify externally, then triage interactively with the user. Static analysis only - no runtime, build, or test execution.
---

# Pi Review Workflow

This skill is the Pi-native implementation of Codeflare `/review`. The `/review` command injects this skill and appends one line:

```
User command: /review --all|--diff [--deep] [--verify-high] [scope-hint]
```

Parse scope and flags from that line, then run the phases below. This is the user-invoked review workflow, NOT PR-boundary enforcement. Do not run the git-review-pipeline. Review the requested scope and report findings.

**Review mode:** static analysis only. Never run builds, tests, or linters - the container is resource-constrained. Read and analyze code only.

## Pi tool mapping (load-bearing)

- **Subagents:** spawn via Pi's `Agent` tool with `subagent_type` set to the agent name (`security-reviewer`, `architect`, `code-reviewer`, `refactor-cleaner`, `tdd-guide`, `doc-updater`, `deep-reviewer`). There is no "Task tool" on Pi.
- **Graph queries:** use Pi-native `graphify_query`, `graphify_path`, `graphify_explain`. Never use `mcp__graphify__*` names. When a native tool resolves the wrong root (e.g. it looks at `/home/user/workspace/graphify-out/graph.json` while the active repo is a child), fall back to the CLI with `--graph <repo>/graphify-out/graph.json`:
  ```bash
  graphify query "<question>" --graph <repo>/graphify-out/graph.json
  graphify path "A" "B" --graph <repo>/graphify-out/graph.json
  graphify explain "X" --graph <repo>/graphify-out/graph.json
  ```
- **Plan entry:** Pi has no EnterPlanMode primitive. Invoke the `Plan` agent OR produce an explicit written plan and wait for explicit user approval before any source/test/config edit.
- **User prompts (Phase 8 only):** ask the user directly in the main session and wait for their answer. Phase 8 is the ONLY phase that runs in the main session; every other phase uses the `Agent` tool.
- **Shell:** in context-mode sessions route shell through `ctx_execute` / `ctx_batch_execute`; otherwise use Bash directly. Both produce identical output.

## Context preservation

The main session is primarily an orchestrator. Delegate all source-code analysis and all reading of files `01-12` and `documentation/decisions/README.md` to `Agent` subagents.

The main session may read only:
- After Phase 5: the first ~20 lines of `09-active-findings.md`
- After Phase 6: the first ~30 lines of `10-real-findings.md`
- After Phase 7: the first ~30 lines of `11-llm-verified.md`
- Phase 8: the `## Real Findings` and `## Tech-Debt Surfaced` sections of `10-real-findings.md` (or `11-llm-verified.md` if Phase 7 ran)
- Phase 11: the `## Fix` section of `12-triage-results.md`

Never read source files, `01-08`, or `documentation/decisions/README.md` directly in the main session.

## No-scope help

If the injected command line contains neither `--all` nor `--diff`, print the help below and exit. Run no phases - the scope flag is mandatory.

```
review - comprehensive multi-perspective codebase review

USAGE
  /review                                    Show this help
  /review --all  [flags] [scope]             Review the entire codebase
  /review --diff [flags] [scope]             Review the current diff vs base

FLAGS
  --all          Review the entire codebase. Phase 2 subagents run with
                 scope=all; doc-enforce and tdd-enforce run their full
                 manifests against every file. Heavier but exhaustive.
  --diff         Review only changes against the PR base (resolved via
                 gh pr view --json baseRefName, falling back to origin/main).
                 Phase 2 subagents run with scope=diff. Faster, ideal during
                 active feature work before opening a PR.
  --deep         Add Phase 3: behavioral verification of SDD requirements
                 against their implementation. Spawns ceil(N/15) parallel
                 deep-reviewer subagents that read each REQ's ACs + impl +
                 tests and judge whether the code actually does what the AC
                 describes. Expensive - a periodic audit, not a per-PR pass.
  --verify-high  After the Reality Filter (Phase 6), send every surviving
                 HIGH and CRITICAL finding to external code LLMs for
                 verification, when an external-consult tool surface is
                 available. Adds Phase 7. Cost-bounded at 2 calls total.
                 Degrades gracefully (skips) when no such surface exists.
  [scope]        Optional free-text scope hint passed to every review
                 subagent. Narrows focus within the chosen --all/--diff mode
                 (e.g., "focus on src/routes/").

EXAMPLES
  /review --all                       Full whole-codebase structural review
  /review --diff                      Quick structural review of in-progress changes
  /review --all --verify-high         Full review with external verification (if available)
  /review --diff --verify-high        Same, narrowed to the current diff
  /review --all --deep                Full review + behavioral verification of all REQs
  /review --diff --deep               Behavioral verification of REQs touched by the diff
  /review --all --deep --verify-high  Kitchen sink
  /review --diff src/routes/          Diff review narrowed to one directory

PHASES
  1   Argument parse + run directory
  2   Parallel subagent dispatch (security, architect, code-reviewer,
      refactor-cleaner, tdd-guide, doc-updater)
  3   REQ behavioral verification (only when --deep)
  4   Cross-reference + dedup
  5   AD filtering against documentation/decisions/README.md
  6   Reality Filter (Q1-Q6)
  7   External LLM verification (only when --verify-high AND a surface exists)
  8   Interactive triage (only phase in the main session)
  9   Save triage + append to sdd/.review-decisions.md
  10  Update ADs + create tech-debt GitHub issues
  11  Plan entry for Fix decisions

OUTPUT
  Each run writes to /home/user/Temporary/Review/<timestamp>/, with
  /home/user/Temporary/Review/latest symlinked to the most recent run.

SIBLINGS
  /sdd clean            Rescue a rotted SDD spec
  /sdd clean --all      Same, full corpus
  /sdd clean --diff     Same, diff-scoped
```

## Phase 1: Parse arguments + create run directory (main session)

Step 1a - parse the injected command line into four variables. Use word-boundary matching only; never substring-match `--all` against `--all-the-things` or any free-text token.

- `$SCOPE` = `all` if `--all` is present as a standalone token, else `diff` if `--diff` is. If both are present, `--all` wins and you print a one-line warning. If neither is present, the help screen above already short-circuited.
- `$DEEP` = `true` if `--deep` is a standalone token, else `false`.
- `$VERIFY_HIGH` = `true` if `--verify-high` is a standalone token, else `false`.
- `$SCOPE_HINT` = the free text remaining after stripping the four known flags (`--all`, `--diff`, `--deep`, `--verify-high`). Empty string if nothing is left. This is passed to every Phase 2 subagent.

Step 1b - resolve the project root and create the run directory:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$PROJECT_ROOT" ]; then
  echo "ERROR: /review must be invoked from inside a git repository." >&2
  exit 1
fi
HAS_SDD=0
[ -d "$PROJECT_ROOT/sdd" ] && HAS_SDD=1
HAS_DOCS=0
[ -d "$PROJECT_ROOT/documentation" ] && HAS_DOCS=1
REVIEW_DIR=/home/user/Temporary/Review/$(date +%Y%m%d-%H%M%S)
mkdir -p "$REVIEW_DIR"
ln -sfn "$REVIEW_DIR" /home/user/Temporary/Review/latest
```

`HAS_SDD=0` means later phases that read `sdd/*` treat each as empty (no errors, no findings). `HAS_DOCS=0` means later phases that read `documentation/*` likewise treat as empty.

Step 1c - record the scope decision so subagents can read it without re-parsing the command line:

```bash
{
  echo "SCOPE=$SCOPE"
  echo "DEEP=$DEEP"
  echo "VERIFY_HIGH=$VERIFY_HIGH"
  echo "SCOPE_HINT=$SCOPE_HINT"
  if [ "$SCOPE" = "diff" ]; then
    BASE_REF=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null || echo "main")
    echo "BASE_REF=$BASE_REF"
    echo "DIFF_CMD=git diff origin/${BASE_REF}...HEAD"
  fi
} > "$REVIEW_DIR/.scope.txt"
```

> **Force-push caveat:** `git diff origin/$BASE_REF...HEAD` resolves against the current branch tip. On force-pushed branches the diff may include files whose history was rewritten rather than only the genuinely new changes. The noise is bounded (still scoped to the merge-base side of `...`). For a strict since-last-review diff on a force-pushed branch, check out the merge-base first, or use `/review --all` to bypass diff resolution.

Step 1d - print the run summary:

```
/review run: $REVIEW_DIR
  scope:        $SCOPE  (diff -> against origin/$BASE_REF)
  deep:         $DEEP
  verify-high:  $VERIFY_HIGH
  scope hint:   $SCOPE_HINT (or "(none)")
```

Use `$REVIEW_DIR` for ALL output files and `$REVIEW_DIR/.scope.txt` for scope plumbing in every subsequent phase.

Step 1e - refresh the graphify graph so every downstream phase queries current code. graphify is ambient in every codeflare container. Before Phase 2 spawns any subagent:

```bash
if [ -f "$PROJECT_ROOT/graphify-out/graph.json" ]; then
  # AST-only refresh, free, ~5-15s on medium repos; ensures the graph reflects current HEAD.
  # If the refresh fails, the on-disk graph may be stale relative to HEAD - Q6 graph-orphan
  # would then false-positive-DROP real findings. Set the no-graph marker on failure so
  # downstream phases use the safer grep-style fallback instead of trusting stale state.
  if ! (cd "$PROJECT_ROOT" && timeout 180 bash /home/user/.pi/agent/scripts/safe-graphify-update.sh . 2>>"$REVIEW_DIR/.graphify-update.log"); then
    echo "Note: graphify update failed or timed out at $(date -Iseconds). Graph at $PROJECT_ROOT/graphify-out/graph.json may be stale; treating as no-graph to avoid stale-orphan false positives. See .graphify-update.log." > "$REVIEW_DIR/.no-graph.notice"
  fi
else
  echo "Note: no graphify graph at $PROJECT_ROOT/graphify-out/graph.json - structural review checks fall back to grep-style search. Run /graphify once to enable graph-aware review." > "$REVIEW_DIR/.no-graph.notice"
fi
```

The update runs at most once per `/review` invocation, with a 180s hard timeout. Failures (non-zero exit, timeout, missing CLI) are non-fatal and write `.no-graph.notice`; downstream phases fall back to grep-equivalent search instead of risking stale-graph false positives. When `.no-graph.notice` is present this run: Reality Filter Q3 falls back to category-only grouping, Q5 skips its graph step, and Q6 is inert. The safe wrapper is the Pi-allowlisted path `/home/user/.pi/agent/scripts/safe-graphify-update.sh`; review uses it only to refresh graph structure, not to produce final labeled HTML artifacts.

## Phase 2: Parallel subagent dispatch (6 `Agent` calls)

Launch **all 6 subagents in parallel in a SINGLE message of 6 `Agent` calls**, each with the matching `subagent_type`. Each reviews per the parsed `$SCOPE` (`all` = entire codebase; `diff` = the diff against `origin/$BASE_REF`) plus the optional `$SCOPE_HINT`, then writes structured findings to its own file. The subagents write ONLY to `$REVIEW_DIR/0N-*.md` - they touch no shared `sdd/` or `documentation/` state, so there is no filesystem race and parallel dispatch is safe.

| # | subagent_type | Output file | Focus |
|---|---------------|-------------|-------|
| 1 | `security-reviewer` | `$REVIEW_DIR/01-security.md` | Secrets, injection, auth, OWASP top 10, dependency vulns |
| 2 | `architect` | `$REVIEW_DIR/02-architecture.md` | System design, modularity, coupling, scalability, patterns |
| 3 | `code-reviewer` | `$REVIEW_DIR/03-code-quality.md` | Code quality, naming, error handling, readability, complexity |
| 4 | `refactor-cleaner` | `$REVIEW_DIR/04-dead-code.md` | Dead code, unused exports, duplication, consolidation |
| 5 | `tdd-guide` | `$REVIEW_DIR/05-test-gaps.md` | Test coverage gaps, untested critical paths, test quality |
| 6 | `doc-updater` | `$REVIEW_DIR/06-documentation.md` | Missing/outdated docs, stale comments, README gaps, API doc coverage |

If the runtime limits parallel `Agent` calls, batch them in 3s. If any subagent fails, retry once; if it still fails, continue with the successful reports and note the missing report in the summary.

### Subagent prompt template

Each prompt MUST include: the project root path, the exact `$REVIEW_DIR` output path, scope context, the severity schema, the output format, and the instruction to Write to its designated file. Adjust the focus area per subagent type:

```
You are conducting a [SCOPE_DESCRIPTION] review of the project at [PROJECT_ROOT].

Scope mode: [SCOPE]    ([SCOPE_DESCRIPTION])
[If SCOPE = diff]: review only what appears in `git diff origin/[BASE_REF]...HEAD`.
                   Read $REVIEW_DIR/.scope.txt for BASE_REF + DIFF_CMD.
                   Use the DIFF_CMD output to identify changed files; Read each
                   fully and Read directly-related files for context. Do NOT
                   review files outside the diff unless imported by changed files.
[If SCOPE = all]:  review the entire codebase. Use search + Read to explore.

[SCOPE_HINT if provided, e.g., "Within that scope, focus on src/routes/."]

For structural lookups - "what calls X", "what depends on Y", "where is Z used",
"is this dead code", "what does this symbol connect to" - PREFER the Pi-native
graph tools graphify_query, graphify_path, graphify_explain over grep-style
search. The graph at [PROJECT_ROOT]/graphify-out/graph.json was refreshed at the
start of this /review run (Phase 1 Step 1e). If a native tool reports the wrong
root, use the CLI fallback: graphify query "..." --graph
[PROJECT_ROOT]/graphify-out/graph.json. If [REVIEW_DIR]/.no-graph.notice exists,
the graph is unavailable or stale - fall back to grep-style search.

Rate each finding with one of these severities:
- CRITICAL: Security vulnerabilities, data loss risks, production-breaking issues
- HIGH: Significant bugs, major design flaws, serious maintainability issues
- MEDIUM: Code smells, minor design issues, moderate improvements needed
- LOW: Style issues, minor suggestions, nice-to-haves

Write your findings to [OUTPUT_FILE] using the Write tool. Use this format per finding:

## [SEVERITY] Short descriptive title

- **ID:** [AGENT_PREFIX]-[NNN] (e.g., SEC-001, ARCH-001, QUAL-001, DEAD-001, TEST-001, DOCS-001)
- **Location:** path/to/file.ts:123 (or path/to/dir/, "multiple files", or "repository-wide")
- **Category:** e.g., "Missing input validation"
- **Confidence:** high | medium | low
- **Description:** What the issue is and why it matters
- **Suggestion:** How to fix it

At the top of the file include:
# [REVIEW_TYPE] Review
**Scope:** [SCOPE] ([all-codebase | diff vs origin/BASE_REF])
**Findings:** [total count]

Focus on: [AGENT-SPECIFIC FOCUS AREA]

Skill invocation override for /review mode (when applicable to your type):
- doc-updater: invoke the doc-enforce skill with scope=[SCOPE] as your first
  action. If the repo has no sdd/ or no documentation/ (vibe-coding mode), write
  a one-line "no-op (vibe-coding mode: no sdd/ or no documentation/)" header to
  your output file and return - do not leave the file empty.
- tdd-guide: invoke the tdd-enforce skill with scope=[SCOPE] against
  [the test files in the diff | every test file in the codebase] as your first action.
- code-reviewer: when your scope includes test files, invoke tdd-enforce with scope=[SCOPE].

Do NOT run any builds, tests, or linters locally. Read and analyze the code only.
```

When dispatching, substitute:
- `[SCOPE]` -> `all` or `diff` (literal value from `$REVIEW_DIR/.scope.txt`)
- `[SCOPE_DESCRIPTION]` -> `"comprehensive whole-codebase"` for `all`, or `"diff-scoped"` for `diff`
- `[BASE_REF]` -> value from `.scope.txt` (only meaningful in diff mode)
- `[SCOPE_HINT]` -> the free-text remainder, or omitted if empty

Agent ID prefixes: SEC (security), ARCH (architecture), QUAL (code-quality), DEAD (dead-code), TEST (test-gaps), DOCS (documentation).

Wait for all 6 subagents to complete. Then:
- If `$DEEP` is `true`: proceed to Phase 3.
- If `$DEEP` is `false`: skip Phase 3 entirely and proceed to Phase 4.

## Phase 3: REQ behavioral verification (parallel `Agent` calls - only when --deep)

Skip this entire phase when `$DEEP` is `false`. Phase 4 glob-discovers report files and runs correctly with zero Phase 3 outputs.

When `$DEEP` is `true`, this phase spawns ceil(N/15) parallel `deep-reviewer` subagents that read every in-scope REQ + its impl + its tests and emit per-AC verdicts. Findings flow into the same canonical/triage pipeline as Phase 2 findings via Phase 4.

### Step 3a - build the REQ batch list (main session)

The main session (this is a cheap shell step, not a subagent) materialises the REQ list and partitions it into batches of 15:

```bash
if [ "$SCOPE" = "diff" ]; then
  CHANGED_FILES=$(git diff origin/${BASE_REF}...HEAD --name-only)
  REQ_IDS=$(grep -lE "REQ-[A-Z]+-[0-9]+" sdd/*.md \
            | xargs awk '
              /^### REQ-[A-Z]+-[0-9]+/ { req=$2 }
              /Status:.*Implemented/ && req { print req; req="" }
            ')
  REQ_IDS=$(for r in $REQ_IDS; do
    if grep -qF -f <(echo "$CHANGED_FILES") <(awk "/$r/,/^### REQ-/" sdd/*.md); then
      echo "$r"
    fi
  done)
else
  REQ_IDS=$(awk '
    /^### REQ-[A-Z]+-[0-9]+/ { req=$2 }
    /Status:.*Implemented/ && req { print req; req="" }
  ' sdd/*.md)
fi

if [ -n "$SCOPE_HINT" ]; then
  REQ_IDS=$(echo "$REQ_IDS" | grep -F "$SCOPE_HINT" || echo "$REQ_IDS")
fi

# Group by impl-file (locality preserved across batches) then chunk by 15:
#   1. Read each REQ's Implements field to extract the primary impl file path
#   2. Sort REQs by impl file path (lexical) - REQs sharing a file end up adjacent
#   3. Chunk the sorted list into groups of up to 15 REQs
# Each chunk becomes one Phase 3 batch; the subagent reads the impl file once per batch.

REQ_COUNT=$(echo "$REQ_IDS" | wc -l)
BATCH_COUNT=$(( (REQ_COUNT + 14) / 15 ))

mkdir -p "$REVIEW_DIR/.deep"
echo "$REQ_IDS" | split -l 15 - "$REVIEW_DIR/.deep/batch-"
ls "$REVIEW_DIR/.deep/" > "$REVIEW_DIR/.deep/index.txt"
```

If `REQ_COUNT` is 0, write `$REVIEW_DIR/07-req-verify-00.md` with a one-line `# REQ Behavioral Verification - SKIPPED (no Implemented REQs in scope)` header and proceed to Phase 4. Spawn no subagents.

### Step 3b - print the dispatch plan

```
Phase 3 (deep): $REQ_COUNT Implemented REQs in scope, dispatching $BATCH_COUNT batches.
  Batch size: up to 15 REQs each.
  Locality: REQs grouped by primary impl file before chunking.
```

### Step 3c - launch deep-reviewer subagents

Launch `$BATCH_COUNT` `Agent` calls with `subagent_type: deep-reviewer`. Run them in waves of 5: parallel within a wave (one message), sequential between waves (the runtime may rate-limit beyond 5 parallel). Each subagent gets its batch identifier and the REQ-list path.

Each prompt:

```
You are deep-reviewer batch [BATCH_ID] of [BATCH_COUNT] for /review run [REVIEW_DIR].

Project root: [PROJECT_ROOT]
Output file:  [REVIEW_DIR]/07-req-verify-[BATCH_ID].md
Scope:        [SCOPE]   (diff -> base ref origin/[BASE_REF])
Scope hint:   [SCOPE_HINT or "(none)"]

REQ list for your batch: [REVIEW_DIR]/.deep/batch-[BATCH_ID]
Read it and verify every REQ ID it contains.

Follow your standard verification procedure (read REQ, identify impl, read impl,
read tests, judge per AC, suggest fix type for mismatches). Write findings to your
OUTPUT_FILE in the format defined in your agent definition.

For REQ-to-impl mapping and AC-to-symbol chain verification, PREFER the Pi-native
graph tools graphify_path / graphify_query over grep-style search.
graphify_path for (REQ-X-NNN -> cited-symbol) is the structural axis for
behavioral-match verification: a returned path means the impl chain exists; no
path means the implementation is missing or named differently. The graph at
[PROJECT_ROOT]/graphify-out/graph.json was refreshed in Phase 1 Step 1e. If a
native tool reports the wrong root, use the CLI fallback: graphify path "A" "B"
--graph [PROJECT_ROOT]/graphify-out/graph.json. If [REVIEW_DIR]/.no-graph.notice
exists, the graph is unavailable or stale - fall back to grep / Read for impl
identification and record "graph unavailable" as evidence for any unclear verdict.

Severity rubric: CRITICAL for security/auth/billing/data-loss AC mismatches,
HIGH for behavioral mismatches in general, MEDIUM for unclear verdicts, LOW
reserved for cosmetic drift.

Hard rules: one finding per mismatch/unclear AC (not per REQ); every finding
carries a file:line evidence anchor; the "Verified Clean" section listing
fully-matching REQs is MANDATORY; never edit any file other than OUTPUT_FILE.
```

### Step 3d - wait + verify outputs

After all subagents return, verify each `$REVIEW_DIR/07-req-verify-[BATCH_ID].md` exists. If any batch produced no file or an empty file, log it to `$REVIEW_DIR/.deep/failures.txt` and continue - the downstream pipeline tolerates partial coverage and notes the gap.

Read NOTHING from the batch files in the main session. Phase 4 does the consolidated read. Proceed to Phase 4.

## Phase 4: Cross-reference (single `code-reviewer` `Agent` call)

Launch one `Agent` call with `subagent_type: code-reviewer`. The subagent discovers report files dynamically (some agents may have failed; Phase 3 may have been skipped), deduplicates, identifies cross-domain findings, false positives, and emergent patterns, then writes `$REVIEW_DIR/08-cross-reference.md`.

Prompt:

```
List the existing review files at [REVIEW_DIR]/0*.md (glob). Expected files:
- 01-security.md through 06-documentation.md (Phase 2 outputs)
- 07-req-verify-NN.md (one per Phase 3 batch; ABSENT if --deep was not passed)
Read ONLY the files that actually exist. Some subagents may have failed - do not
attempt to read missing files.

Perform cross-referencing analysis:

1. DEDUPLICATION: When 2+ agents flag the same underlying issue, merge into one
   canonical finding:
   - Canonical ID: CF-NNN
   - Raw IDs: list all original IDs (e.g., SEC-003, QUAL-014, DEEP-02-003)
   - Severity: highest from any agent
   - Confidence: highest from any agent
   - Source agents: union of all agents that flagged it (deep-reviewer counts as a
     source agent the same as code-reviewer, security-reviewer, etc.)
   - Description: merged from all perspectives
   - Suggestion: combined recommendations
   - For DEEP-* raw IDs: ALSO preserve req_id, ac_index, suggested_fix_type, and
     verdict (mismatch/unclear) verbatim from the source file. Phase 8 uses
     suggested_fix_type to show the user which fix lane the finding implies.
   Deduplicate by location+category match or semantic similarity.

2. CROSS-DOMAIN FINDINGS: Among canonical findings, flag those confirmed by 2+
   agents. These have higher confidence.

3. FALSE POSITIVES: Identify findings contradicted by context in other agent
   reports. Explain the reasoning for each removal.

4. EMERGENT PATTERNS: Identify systemic issues only visible when combining
   perspectives (e.g., "all 3 API routes lack validation").

Write output to [REVIEW_DIR]/08-cross-reference.md using this format:

# Cross-Reference Analysis

## Canonical Findings
[One entry per canonical finding with CF-NNN ID, raw IDs, merged details. DEEP-*
raw IDs MUST carry their req_id, ac_index, suggested_fix_type, and verdict.]

## Cross-Domain Findings (elevated confidence)
[List CF-NNN IDs confirmed by 2+ agents]

## False Positives Removed
[Findings contradicted by other perspectives, with reasoning]

## Emergent Patterns
[Systemic issues visible only across multiple review perspectives]

## Statistics
- Reports analyzed: X of (6 + N deep-reviewer batches)
- Phase 3 deep verification: enabled | skipped
- Total raw findings across all agents: X
- Canonical findings after dedup: X
- Cross-domain (elevated): X
- False positives removed: X
- Emergent patterns identified: X
```

## Phase 5: AD filtering (single `code-reviewer` `Agent` call)

Launch one `Agent` call with `subagent_type: code-reviewer` to filter findings against documented architecture decisions.

Prompt:

```
You are filtering codebase review findings against documented architecture decisions.

1. Read [REVIEW_DIR]/08-cross-reference.md - canonical findings are the primary
   source of truth.
2. Search documentation/decisions/README.md in the project root for architecture
   decisions. If that file does not exist or has no AD entries, write
   [REVIEW_DIR]/09-active-findings.md with ALL canonical findings marked active
   (zero AD-guarded) and stop.
3. You may read CLAUDE.md / AGENTS.md files for implementation context, but ONLY
   documentation/decisions/README.md has authority to justify AD-guarding. Do not
   AD-guard a finding based solely on a CLAUDE.md / AGENTS.md note.
4. For each canonical finding, check if an AD in documentation/decisions/README.md
   explicitly justifies the flagged pattern.

AD-Guard Rules (strict). A finding may ONLY be marked AD-GUARDED if ALL are true:
- The AD explicitly references the exact pattern or tradeoff
- The implementation materially matches the AD constraints
- The finding is about an intentional design tradeoff, not a correctness or safety defect
- The finding is NOT severity CRITICAL
- HIGH findings may only be AD-guarded if they are architectural tradeoffs, not bugs or security issues

Each AD-guarded finding must record the exact AD title/heading and the relevant quote.

5. Write the filtered active findings list to [REVIEW_DIR]/09-active-findings.md.

Format for 09-active-findings.md:

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
AD refs checked: documentation/decisions/README.md (X decisions)
Review mode: static analysis only

## AD-Guarded Findings (removed from active list)
### CF-NNN: Title - AD-GUARDED
- **AD ref:** "AD title" from documentation/decisions/README.md
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

After the subagent completes, read the first ~20 lines of `$REVIEW_DIR/09-active-findings.md` and print them. Phase 6 still runs even if Active = 0 - the cycle counter and audit log are useful artifacts even on clean cycles.

## Phase 6: Reality Filter (single `code-reviewer` `Agent` call)

The Reality Filter re-evaluates every Phase-5-active finding against six questions, using prior triage history (`sdd/.review-decisions.md`), ADR bodies, the unified global graph (cross-session feedback + user preferences + project conventions), recent git log, `sdd/changes.md`, and the project-local code-knowledge graph at `[PROJECT_ROOT]/graphify-out/graph.json`. It produces a SHORT list of real findings, an audit log of every drop, and a Tech-Debt-Surfaced section. Q3 clustering, Q5 chain validation, and Q6 graph-orphan use the project-local graph; Q2 memory-says-no uses the unified graph.

Launch one `Agent` call with `subagent_type: code-reviewer`. The subagent uses the Pi-native graph tools (`graphify_query`, `graphify_path`, `graphify_explain`) against both the project-local graph and the unified global graph, with the CLI fallback when a native tool resolves the wrong root. If the project-local graph is missing (`$REVIEW_DIR/.no-graph.notice` exists), Q3 falls back to category-only grouping and Q6 is inert this cycle. If the unified graph is unreachable, Q2 produces no drops.

Prompt:

```
You are the REALITY FILTER stage of a multi-cycle codebase review. Take the
AD-filtered list of N active findings and produce the SHORT list of REAL findings
worth surfacing, plus an audit log of every drop. Filter ruthlessly against
questions Q1-Q6. Do NOT filter to hit a target count - if all N survive, surface all N.

## Inputs to read

1. Active findings: [REVIEW_DIR]/09-active-findings.md - read the `## Active
   Findings` section ONLY. Ignore the `## AD-Guarded Findings` section above it:
   those are settled by ADR and must not re-enter the pipeline.
2. Persistent triage history: [PROJECT_ROOT]/sdd/.review-decisions.md
   - If HAS_SDD=0 or the file does not exist, treat as empty (first run / non-SDD
     project). Q1 produces no drops. This file is committed to git, so prior
     decisions follow the repo, not the machine.
3. Full ADR bodies: [PROJECT_ROOT]/documentation/decisions/README.md
   - If HAS_DOCS=0 or the file does not exist, treat as empty.
4. Recent git activity: cd [PROJECT_ROOT] && git log --since="30 days ago" --oneline --no-merges
5. Spec changes: [PROJECT_ROOT]/sdd/changes.md and [PROJECT_ROOT]/sdd/README.md
   - If HAS_SDD=0 or either file is missing, treat as empty.
6. Unified global graph (cross-session feedback + project conventions): query the
   unified graph (vault + active repos, merged at
   ~/.graphify/global-graph.json) via graphify_query with each of these questions:
     - "code review feedback"
     - "user preferences"
     - "<project name> conventions" (substitute the project's actual name)
   For findings whose category overlaps a returned node, drill into the
   neighbourhood via graphify_explain. If a native tool resolves the wrong root,
   use the CLI fallback: graphify query "..." --graph ~/.graphify/global-graph.json.
   If the unified graph is unreachable, skip this input - Q2 produces no drops.
7. (Optional) [PROJECT_ROOT]/pending.md if present - explains in-flight work that
   may make a "missing feature" finding a known gap.
8. Project-local code-knowledge graph at [PROJECT_ROOT]/graphify-out/graph.json,
   queried via graphify_explain (Q3 cluster grouping + Q6 graph-orphan check) and
   graphify_path (Q5 chain validation). If [REVIEW_DIR]/.no-graph.notice exists,
   the graph is unavailable or stale: Q3 falls back to category-only grouping, Q5
   skips its graph step and keeps original severity, Q6 is inert this cycle.

## The six questions, applied per finding (DROP, KEEP, DOWNGRADE, or DEMOTE-to-Tech-Debt)

### Q1: Repeat-offender drop
Match the finding's (location, category) tuple against entries in
sdd/.review-decisions.md. If a prior entry exists with decision Defer / Ignore /
Tech-Debt AND no commit has touched the file since that entry's date:
  -> DROP. Audit reason: "Q1: prior <decision> recorded <date>, no commits since."
If the file has been touched since the prior entry, the prior decision is
invalidated; re-evaluate via Q2-Q6. Use literal file path matching; if a file was
renamed the prior decision simply will not match and the finding gets surfaced fresh.

### Q2: Memory-says-no drop
If the finding contradicts a node in the unified global graph from input #6 (e.g.
a feedback node says "prefer concrete duplication over premature abstraction" and
the finding says "extract this into a helper"):
  -> DROP. Audit reason: "Q2: contradicts graph node '<label>' (source: <src_file>): <one-line summary>."
If input #6 was skipped (unified graph unreachable), Q2 produces no drops.

### Q3: Cluster aggregation
Group surviving (post-Q1, post-Q2) findings by (category, community) where
community is the graphify community membership of the finding's cited file/symbol
(obtain it via graphify_explain on the location). Group findings that share both
category and community. If [PROJECT_ROOT]/graphify-out/graph.json is missing
(`$REVIEW_DIR/.no-graph.notice` exists), fall back to category-only grouping.
If a group has 3 or more findings AND none have a Q1 match in
sdd/.review-decisions.md (first cycle this rule produces violations):
  -> COLLAPSE the group into ONE cluster finding listing all locations.
  -> Cluster finding ID: take the lowest CF-ID in the absorbed group and append
     "-cluster" (e.g., CF-005, CF-018, CF-031 -> CF-005-cluster). If that combined
     ID collides with another cluster in this run, use the next-lowest absorbed
     CF-ID. Cluster IDs are within-run identifiers only - NOT stored in
     sdd/.review-decisions.md (Phase 8 expands clusters to per-location entries
     keyed by (file:line, category)), so cross-cycle stability is not required.
  -> Severity = max severity in the group.
  -> Description: "<rule short name>: <count> instances in <community-label>. <one-line shared description>"
  -> Suggestion: "Sweep PR across the <community-label> cluster. Or AD-justify the pattern."
  -> Audit reason per absorbed finding: "Q3: clustered into CF-NNN-cluster (community: <community-label>)."
The user triages the cluster ONCE. Phase 8 writes ONE .review-decisions entry PER
LOCATION, so Q1's per-location lookup works in cycle N+1.
Threshold rationale: 3 is the smallest "this is a pattern" count. Community-aware
grouping prevents two unrelated 3-instance patterns from collapsing into one false
cluster just because they share a category label.

### Q4: User-impact bar (DEMOTE to Tech-Debt-Surfaced)
Re-evaluate severity against user-visible impact, not the producing agent's
internal scale. Findings that do not clear the bar move to Tech-Debt-Surfaced
(NOT dropped - Tech-Debt is still surfaced for triage):
CRITICAL must be: data loss/corruption, money/billing risk, access-control bypass,
  production crash/availability loss, or an exploitable security mistake.
HIGH must be: a real bug producing wrong observable behavior, a spec-vs-shipped
  contradiction in a load-bearing area, a CI/deploy gate that breaks, or
  significant doc-vs-code drift in a user-facing API or auth.
MEDIUM must be: a real bug class with low blast radius, a user-facing API doc lie,
  or a test gap on a real bug class.
Below the MEDIUM bar: move to "## Tech-Debt Surfaced". Audit reason:
  "Q4: <agent severity> -> Tech-Debt; reason: <which bar failed>."
Anything that clears the bar after re-evaluation: KEEP at the (possibly adjusted)
severity in "## Real Findings".

### Q5: Spec-vs-shipped truth-test
For doc-vs-code drift findings (DOCS-* raw IDs, or any category mentioning
"documentation" / "doc drift"): Read the cited source file and verify the claimed
mismatch actually exists.
If source contradicts the finding's premise:
  -> DROP. Audit reason: "Q5: source verification failed. Cited <file:line>; actual code <quote>."
If source confirms the finding:
  -> KEEP at original severity. Add evidence: "Verified at <file:line>: <quote>."
When the finding claims a spec-to-implementation chain ("REQ-X-NNN says the auth
endpoint validates X but routes/auth.ts:42 does not"), additionally call
graphify_path for (REQ-or-AC-node -> cited-symbol) to confirm the structural chain
exists. If [REVIEW_DIR]/.no-graph.notice exists, skip this graph step and keep the
finding at original severity (the source read above is sufficient). If the graph is
present and graphify_path returns no path, the cited mapping may be stale (symbol
renamed or moved): downgrade to MEDIUM with audit reason "Q5: graph chain not
found; cited symbol may be stale." If the graph returns a path: keep at original
severity and record the path as evidence.
Q5 downgrades to MEDIUM appear in "Real Findings" at the downgraded severity AND in
the audit log under "Q5 downgrades" - they are NOT silent.

### Q6: Graph-orphan check (graphify-aware)
For any finding citing a specific code symbol or file (not "repository-wide", not
"multiple files"), confirm the cited node exists in the project-local graph via
graphify_explain on the symbol-or-file.
If the node is missing AND [PROJECT_ROOT]/graphify-out/graph.json exists (graph is
current, not stale): the cited location was removed or renamed since the finding
was generated.
  -> DROP. Audit reason: "Q6: graph-orphan; cited <symbol-or-file> not present in current graph."
If the graph is missing (`$REVIEW_DIR/.no-graph.notice` exists): Q6 is inert this
cycle. This catches findings produced from a stale checkout, an older commit, or a
deleted-since-but-still-named symbol.

## Hard rules
- Be ruthless, not aggressive. Drop findings that ARE noise. Erring toward dropping
  is correct because anything mistakenly dropped resurfaces next cycle if it's real.
- Every KEEP must cite at least one piece of concrete evidence: file:line, commit
  SHA, AD ref, .review-decisions entry, unified-graph node label, or sdd/changes.md date.
- Every DROP and DEMOTE must have a one-line reason in the audit log keyed by which question dropped it.
- Read actual source for any finding you keep with severity HIGH or CRITICAL.
- Do not retry graphify calls if they fail; skip the affected input and continue.

## Output: ONE file at [REVIEW_DIR]/10-real-findings.md

Format:

# Real Findings (Reality-Filtered)
**Source:** [REVIEW_DIR]
**Cycle:** N+1 (read `Last cycle: N` from sdd/.review-decisions.md if it exists -
this run is cycle N+1; if the file is missing, this is cycle 1)
**Active findings (Phase 5 input):** X
**Real findings (after Q1-Q6):** Y
**Tech-Debt surfaced:** W
**Auto-filtered (dropped):** X - Y - W

## Cycle Health
Active CRITICAL/HIGH/MEDIUM going into this cycle: A
Surviving CRITICAL/HIGH/MEDIUM after Reality Filter: B
(Surfaced for visibility. On a stable codebase B trends toward zero by the third
successive run. Cycle 3 with B>0 may indicate filter calibration to revisit, or
genuinely new bugs introduced between cycles.)

## Real Findings
### CF-NNN: Title
- **Severity:** HIGH
- **Why this is real:** <one or two sentences citing concrete evidence>
- **Location:** path/to/file.ts:123
- **Category:** ...
- **Description:** ...
- **Suggestion:** ...

[For cluster findings:]
### CF-NNN-cluster: <rule short name> - 15 instances
- **Severity:** MEDIUM (max from group)
- **Why this is real:** First cycle of <rule>; 15 violations call for a sweep PR.
- **Locations:** [bulleted list of all 15 file:line]
- **Description:** ...
- **Suggestion:** Sweep PR, or AD-justify the pattern.

## Tech-Debt Surfaced
[Findings demoted by Q4. Same format as Real Findings, but appear here. Triage
treats these as Tech-Debt by default unless the user upgrades them.]

## Auto-Filtered (audit log)

### Q1: Repeat-offender drops (X)
- CF-NNN at <location> (<category>): prior <Defer|Ignore|Tech-Debt> recorded <date>, no commits since.

### Q2: Memory-says-no drops (X)
- CF-NNN at <location> (<category>): contradicts graph node "<label>".

### Q3: Cluster collapses (X absorbed into Y clusters)
- CF-NNN-cluster covers: CF-A, CF-B, CF-C, ... at <locations>.

### Q4: Severity downgraded to Tech-Debt (X) [also listed in Tech-Debt Surfaced above]
- CF-NNN at <location>: <original severity> -> Tech-Debt. Reason: <which bar failed>.

### Q5: Spec-vs-shipped truth-test failures (X)
- CF-NNN at <location>: cited <file:line>; actual code <quote>; finding's premise contradicted.

### Q5: Downgrades to MEDIUM (X) [also listed in Real Findings at downgraded severity]
- CF-NNN at <location>: original severity HIGH/CRITICAL; graphify_path found no chain to <cited-symbol>; cited mapping may be stale.

### Q6: Graph-orphan drops (X)
- CF-NNN at <location>: cited symbol/file not present in current graphify graph; likely removed or renamed.

## Memory mode
Cost contract: this whole phase MUST be ONE subagent. Do not spawn additional
subagents. Read files directly via Read; query the graphs directly via the
graphify tools. The Auto-Filtered audit section is mandatory output - if it is
missing or empty when DROP/DEMOTE counts are non-zero, the phase failed.
```

After the subagent completes, read the first ~30 lines of `$REVIEW_DIR/10-real-findings.md` and print them.

**Orchestrator check:** Parse the "Real findings (after Q1-Q6)" count and the "Tech-Debt surfaced" count from the header. If both are 0, output "Clean review - no actionable findings after Reality Filter" and STOP. Do not proceed to Phase 7 or beyond.

If `$VERIFY_HIGH` is `false`, skip Phase 7 and proceed to Phase 8.

## Phase 7: External LLM verification (single `code-reviewer` `Agent` call - only when --verify-high)

This phase degrades gracefully. The Claude-only `consult_llm` tool is NOT available on Pi by default.

**Availability gate (check before launching the subagent):** if an external-consult tool surface is available in this Pi session, run the verification below. If no such surface exists, SKIP Phase 7: print a one-line note "Phase 7 skipped - no external-consult tool surface available; carrying all HIGH/CRITICAL findings through unchanged", carry every surviving HIGH/CRITICAL Real Finding (and all MEDIUM + Tech-Debt-Surfaced) forward to Phase 8 unchanged from `10-real-findings.md`, and proceed. Never hard-fail on the tool's absence.

When a surface IS available, launch one `Agent` call with `subagent_type: code-reviewer` to verify ALL HIGH and CRITICAL findings in **2 batched calls total** (one per provider family, ALL findings in a single prompt). Never one call per finding - cost scales linearly and burns context with N x 2 responses when one batched response per family carries the same information.

Prompt:

```
You are verifying HIGH and CRITICAL real findings using an external-consult tool
surface. Your goal: 2 external calls TOTAL (one per provider family), each
containing ALL findings batched into a single prompt with all relevant source
files attached via the tool's file/attachment parameter. Do NOT call once per finding.

1. Read [REVIEW_DIR]/10-real-findings.md - extract ALL HIGH and CRITICAL findings
   from the "## Real Findings" section (NOT Tech-Debt-Surfaced; those are
   deliberately demoted). EXCLUDE findings whose raw IDs are ALL DEEP-*
   (deep-reviewer-only, no other agent flagged the same issue). Rationale:
   verifying a DEEP-* finding requires sending the relevant sdd/{domain}.md REQ
   body alongside the impl source; that context inflates the prompt and costs more
   than the second opinion is worth - the deep-reviewer agent is already a strong
   model with a tight verification prompt, and its findings carry structured
   AC text / Impl behavior / Evidence / Confidence fields that let the user spot
   hallucination during Phase 8. Cross-agent DEEP findings (deep-reviewer +
   code-reviewer on the same line) ARE included - the non-DEEP agent's finding
   carries the batch through Phase 7.

   If the extracted set is empty (zero HIGH/CRITICAL, or every HIGH/CRITICAL is
   DEEP-only):
     a. Copy [REVIEW_DIR]/10-real-findings.md verbatim to
        [REVIEW_DIR]/11-llm-verified.md so MEDIUM Real Findings, Tech-Debt-Surfaced,
        and DEEP-only HIGH/CRITICAL findings all survive into Phase 8.
     b. Append a "## LLM Verification" section with the line:
        "Skipped - no non-DEEP HIGH/CRITICAL findings to verify."
     c. EXIT. Do NOT make any external call.

2. Build the unique source-file set: walk every finding's location field, collect
   distinct file paths; for cluster findings take ALL locations. These are attached
   to the external call so the model has the actual source - do NOT inline code in
   the prompt body, only cite file:line references.

3. Build a single batched prompt at [REVIEW_DIR]/.llm-verify-prompt.md with:
   # Verify N HIGH/CRITICAL code review findings
   For each finding return one of three verdicts:
     - CONFIRMED: agree the finding is real; provide a concrete code-level fix
     - REFUTED: explain why this is a false positive (cite specific code or context)
     - UNCERTAIN: state what additional context you'd need
   Output as a JSON array, one object per finding:
     [{"id": "<canonical-id>", "verdict": "CONFIRMED|REFUTED|UNCERTAIN",
       "reason": "<3 sentences max>", "fix": "<diff or null if refuted>"}]
   ## Findings
   ### <canonical-id-1>: <one-line title>
   - Severity: HIGH|CRITICAL
   - Location: path/to/file.ts:123
   - Description: <2-4 sentences from 10-real-findings.md>
   ### <canonical-id-2>: ...

4. Write that prompt to disk. Make the external call TWICE - once per provider
   family - attaching [REVIEW_DIR]/.llm-verify-prompt.md FIRST then the deduplicated
   source-file paths. The prompt/instruction field carries only a short directive
   ("Read .llm-verify-prompt.md, the first attached file, and verify each listed
   finding against the source files that follow. Return the JSON array specified in
   the prompt file."); file content goes via the attachment parameter, not pasted
   into the prompt body.
   Model selector - use FAMILY NAMES ONLY, never pin a specific version:
     - Call 1: provider family "openai" (resolves to the latest GPT server-side)
     - Call 2: provider family "gemini" (resolves to the latest Gemini server-side)
   Pinning concrete model IDs is wrong - they go stale within weeks. Let the surface
   maintain the latest-per-family mapping. Run the two calls concurrently if permitted.

5. Parse each response's JSON. For each finding, combine the two verdicts:
   - BOTH refute -> LLM-REFUTED; remove from the verified list
   - BOTH confirm -> enrich with the better of the two fix proposals
   - DISAGREE -> keep active, note both verdicts
   - One call fails -> LLM-PARTIAL on all findings, keep active. Do NOT retry the
     failed call. The 2-call budget is a hard cap that includes failures.
   - Both calls fail -> LLM-UNAVAILABLE on all findings, keep active. Do NOT retry.

6. Write [REVIEW_DIR]/11-llm-verified.md (its OWN file - do NOT rewrite
   10-real-findings.md):
   - Copy 10-real-findings.md's header verbatim, plus the Tech-Debt-Surfaced
     section verbatim (Tech-Debt is not externally verified)
   - Replace the "## Real Findings" section with the verified list. Findings
     excluded from verification (DEEP-only HIGH/CRITICAL) carry through unchanged
     with a one-line marker "External verification: skipped (DEEP-only; behavioral
     verification by Phase 3 deep-reviewer is the verification record)."
   - Drop LLM-REFUTED findings entirely
   - Add verdicts and fix proposals to surviving non-DEEP-only findings
   - Append a "## LLM-Refuted Findings (removed)" section listing removed findings
     with each provider's refutation reasoning

7. Delete [REVIEW_DIR]/.llm-verify-prompt.md (it was scratch).

Cost contract: this whole phase MUST be exactly 2 external calls regardless of how
many findings there are. No retries. If you are about to make a 3rd call, stop and re-batch.
```

After the subagent completes, read the first ~30 lines of `$REVIEW_DIR/11-llm-verified.md` and print them.

**Orchestrator check:** If the surviving Real Findings count is 0 AND Tech-Debt-Surfaced is 0, output "Clean review - no actionable findings after external verification" and STOP.

## Phase 8: Interactive triage (main session - the ONLY in-session phase)

This is the ONLY phase that runs in the main session, because it needs user interaction. Read the appropriate input file:
- If Phase 7 ran (and was not skipped): `$REVIEW_DIR/11-llm-verified.md`
- Otherwise: `$REVIEW_DIR/10-real-findings.md`

Read specifically the `## Real Findings` and `## Tech-Debt Surfaced` sections.

For findings whose raw IDs include a DEEP-* entry, show the `suggested_fix_type` field (`spec`, `code`, `test`, or `unclear`) alongside the canonical ID so the user sees which lane the finding implies. The triage lanes (Fix / Record as AD / Tech Debt / Defer / Ignore) are unchanged - `suggested_fix_type` is informational, not prescriptive.

### Pre-triage summary

Before per-finding questions, present a triage summary: counts by severity (Real Findings + Tech-Debt-Surfaced), top modules/directories affected, top repeated categories, and the Cycle Health line (cycle N, surviving CRITICAL/HIGH/MEDIUM count).

Then ask one setup question (present these as the choices and wait):
- **Triage all severities** - walk through every finding interactively
- **CRITICAL/HIGH only** - triage CRITICAL and HIGH interactively; auto-defer MEDIUM and LOW
- **CRITICAL/HIGH interactive, batch MEDIUM/LOW by module** - triage top severities individually, group lower severities by module

### Triage options

For each finding or batch, present these options and wait for the user's choice:

**For CRITICAL findings and security/correctness defects:**
- **Fix** - include in the implementation plan (Phase 11)
- **Technical debt** - add to the GitHub issue with the `technical-debt` label
- **Defer** - needs more investigation; carry forward to next review
- **Ignore** - requires an explicit reason

**For all other findings (including Tech-Debt-Surfaced):**
- **Fix** - include in the implementation plan (Phase 11)
- **Record as AD** - record as an architecture decision in documentation/decisions/README.md that justifies this pattern going forward (only valid for intentional tradeoffs, not bugs or security issues)
- **Technical debt** - add to the GitHub issue with the `technical-debt` label
- **Defer** - needs more investigation; carry forward to next review
- **Ignore** - dismiss as false positive or acceptable

**For cluster findings (CF-NNN-cluster):** the default options are presented for the cluster as a whole; the decision applies to ALL locations. Add a **Split** option that breaks the cluster into individual findings for per-location decisions.

### Batching rules

- **CRITICAL**: ask individually unless exact duplicates
- **HIGH**: batch by root cause or module
- **MEDIUM/LOW**: batch aggressively by module or remediation pattern
- Cluster findings (Q3 output): ask once per cluster
- Never ask one question per LOW finding unless it is uniquely important
- Example: "5 dead-code findings in src/lib/legacy/" -> a single question
- For batched questions, include a **Split** option so the user can break the batch and decide per-finding
- Show: canonical ID, severity, location, description, suggestion, suggested_fix_type (if a DEEP-* raw ID is present), and the external verdict (if Phase 7 ran)

### Question format

```
[SEVERITY] CF-NNN: Finding Title
Location: path/to/file.ts:123
Category: Missing input validation
Confidence: high
Description: The route handler accepts user input without sanitization...
Suggestion: Add zod schema validation at the route boundary
Suggested fix type: code   [only when raw IDs include a DEEP-* entry]
[External verdict: Confirmed by openai and gemini - both suggest zod schema]  [only when Phase 7 ran]
```

After all triage questions are answered, collect the decisions into a strict JSON mapping and proceed to Phase 9:

```json
{"CF-001": "fix", "CF-002": "ad", "CF-003": "debt", "CF-004": "defer", "CF-005": "ignore"}
```

For cluster findings whose decision is NOT Split, the cluster ID maps to a single decision; Phase 9 expands it to one entry per location when writing `sdd/.review-decisions.md`. Pass this EXACT JSON string as the decisions mapping to the Phase 9 subagent.

## Phase 9: Save triage results + append to .review-decisions (single `code-reviewer` `Agent` call)

Launch one `Agent` call with `subagent_type: code-reviewer` to write the consolidated triage results AND append per-finding triage history. Pass the decisions JSON mapping and `$REVIEW_DIR` in the prompt.

Prompt:

```
You are saving triage results from a codebase review AND updating the persistent
triage history file used by future Reality Filter runs.

Triage decisions (JSON): [DECISIONS_JSON]

## Step 1: Write the cycle's triage report
Read [REVIEW_DIR]/11-llm-verified.md if it exists, else [REVIEW_DIR]/10-real-findings.md,
to get full finding details.
Write [REVIEW_DIR]/12-triage-results.md with findings sorted into sections by triage
decision. For cluster findings, expand to per-location triage entries.

Format:

# Triage Results
**Run:** [REVIEW_DIR]
**Cycle:** N
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
- **External verdict:** [if Phase 7 ran]
- **Suggested fix type:** [only when raw IDs include a DEEP-* entry: spec | code | test | unclear]

## Record as AD (X findings)
### CF-NNN: [SEVERITY] Finding Title - AD
- **Location:** path/to/file.ts:456
- **Pattern:** The pattern being justified
- **Rationale:** Why this is an intentional architecture decision
- **AD entry:**
  #### AD: [Title]
  - **Status:** Accepted
  - **Context:** [why this decision was made]
  - **Decision:** [what was decided]
  - **Consequences:** [tradeoffs accepted]

## Technical Debt (X findings)
### CF-NNN: [SEVERITY] Finding Title - TECH DEBT
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

## Deferred (X findings)
### CF-NNN: [SEVERITY] Finding Title - DEFERRED
- **Location:** path/to/file.ts:345
- **Reason:** Needs further investigation

## Ignored (X findings)
### CF-NNN: [SEVERITY] Finding Title - IGNORED
- **Location:** path/to/file.ts:012
- **Reason:** [reason provided by user]

## Step 2: Append to sdd/.review-decisions.md
Read [PROJECT_ROOT]/sdd/.review-decisions.md if it exists. If it does not exist,
create it with this header:

# Review Decisions

Cumulative per-finding triage history. Each entry records a Defer/Ignore/Tech-Debt
decision from a /review cycle. Used by /review Phase 6 Reality Filter Q1
(repeat-offender check) on subsequent runs.

This file is NOT a substitute for ADRs. ADRs document permanent design choices
(documentation/decisions/README.md); entries here document per-cycle triage calls
that may evolve. When an entry's reasoning proves durable across multiple cycles,
the user may promote it to an ADR manually.

Last cycle: 0 (initial)

---

For each Defer / Ignore / Tech-Debt decision in the triage JSON (NOT Fix or AD),
append a section like:

## Cycle N - YYYY-MM-DD

### CF-NNN at path/to/file.ts:123 (Category)
- **Decision:** Defer
- **Reason:** <user-provided reason from triage>
- **Suggested action:** <suggestion from finding>
- **Sunset hint:** If 3 cycles in a row see this same decision, consider promoting to ADR.

For cluster findings (CF-NNN-cluster) whose decision was NOT Split: expand to one
entry per location in the cluster. Each entry shares the same Reason. This makes
Q1's per-location lookup trivial in cycle N+1.

For Fix and AD decisions: do NOT write entries here. Fix decisions are resolved when
the implementation lands; AD decisions are recorded in
documentation/decisions/README.md by Phase 10.

If the same (file:line, Category) tuple already has an entry from a prior cycle,
APPEND a new entry rather than overwriting - the file is a log, not a snapshot.
Future Q1 lookups read the most recent matching entry.

## Step 3: Update the cycle counter
Update the file's "Last cycle: N" line near the top to the cycle number used in this
run's 10-real-findings.md (and 11-llm-verified.md if Phase 7 ran) header - i.e. one
greater than the value the file showed before this run. Append the run date as
"Last cycle: M (YYYY-MM-DD)". The next /review invocation reads this M, treats its
run as M+1, and the cycle counter advances monotonically.
```

## Phase 10: Update architecture decisions + create tech-debt issues (single `code-reviewer` `Agent` call)

Launch one `Agent` call with `subagent_type: code-reviewer` to update documentation/decisions/README.md with AD entries and create GitHub issues for tech debt.

Prompt:

```
You are updating architecture decisions and creating GitHub issues from a codebase review.

1. Read [REVIEW_DIR]/12-triage-results.md - specifically the "Record as AD" and
   "Technical Debt" sections. If both are empty (0 findings each), write
   "No updates needed" and stop.

2. For each "Record as AD" entry:
   - Read documentation/decisions/README.md
   - Search existing Architecture Decisions for an equivalent entry by title or pattern
   - If found, update the existing entry using the Edit tool
   - If not found, append a new AD subsection at the end of the Decisions section
     with the next available AD number

3. For each "Technical Debt" entry:
   - Create a GitHub issue using:
     gh issue create --label "technical-debt" --title "TD: [title]" --body "[description + remediation]"
   - Do NOT write tech debt to any documentation file

IMPORTANT: Read documentation/decisions/README.md fully before editing. Use the Edit
tool for AD insertions.
```

## Phase 11: Enter plan mode (main session)

After the Phase 10 subagent completes:

1. Read ONLY the `## Fix` section from `$REVIEW_DIR/12-triage-results.md`.
2. If there are zero Fix findings, report "No fixes requested - review complete" and stop.
3. Enter plan mode: invoke the `Plan` agent, OR produce an explicit written plan and wait for explicit user approval. Pi has no EnterPlanMode primitive - do NOT edit any source, test, or config file before the user approves the plan.
4. The plan organizes the Fix findings by:
   - **Priority**: security fixes first, then architecture, then code quality, then others
   - **Dependency order**: fixes that enable other fixes come first
   - Each fix as a concrete task with: canonical ID and raw IDs; file paths and line numbers; proposed changes (from agent suggestions and external fix proposals if available); severity and category
   - For findings with a DEEP-* raw ID: the suggested_fix_type (spec/code/test) routes the task to the correct lane - spec-fix tasks edit `sdd/`, code-fix tasks edit source, test-fix tasks edit `tests/`
5. Note: AD entries were written to documentation/decisions/README.md, Tech-Debt items were created as GitHub issues, and Defer/Ignore/Tech-Debt decisions were appended to sdd/.review-decisions.md by Phase 9.

## Hard rules (recap)

- NEVER run builds, tests, or linters locally - the container is resource-constrained.
- All 6 Phase 2 subagents launch via the `Agent` tool in a single message (parallel `Agent` calls); batch in 3s only if the runtime limits parallelism.
- Phase 3 deep-reviewer subagents (when --deep) launch in waves of 5: parallel within a wave, sequential at wave boundaries.
- Phases 4, 5, 6, 9, 10 each run as a single `code-reviewer` `Agent` call; the main session waits for completion before proceeding.
- Phase 7 (when --verify-high) runs as a single `code-reviewer` `Agent` call ONLY when an external-consult surface exists; otherwise it is skipped with a one-line note and all surviving findings carry through unchanged. Never hard-fail on the tool's absence.
- Phase 8 is the ONLY phase that runs in the main session (it needs user interaction).
- After Phase 6: if Real Findings + Tech-Debt-Surfaced totals are 0, STOP and report a clean review. After Phase 7: re-check the verified totals.
- Each phase completes fully before the next; only Phase 3 and Phase 7 are optional.
- The findings directory persists at `$REVIEW_DIR`; `/home/user/Temporary/Review/latest` always points to the most recent run.
- Use Pi-native graph tools (`graphify_query`, `graphify_path`, `graphify_explain`), never `mcp__graphify__*`. CLI fallback `graphify <cmd> --graph <repo>/graphify-out/graph.json` when a native tool resolves the wrong root.
