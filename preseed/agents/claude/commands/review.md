# Comprehensive Multi-Perspective Codebase Review

Run a full codebase review from 6 specialized perspectives using parallel agents, cross-reference findings, filter against architecture decisions and prior triage history, optionally verify with external LLMs, then triage interactively with the user.

**Review mode:** static analysis only - no runtime, build, or test validation performed.

## When the user types `/review` with no scope flag

If $ARGUMENTS does NOT contain `--all` or `--diff`, print this help screen and exit. Do not invoke any phases. The scope flag is mandatory.

```
review — comprehensive multi-perspective codebase review

  Run a full codebase review from 6 specialized perspectives using parallel
  agents, cross-reference findings, filter against architecture decisions
  and prior triage history, optionally verify with external LLMs, then
  triage interactively with the user.

USAGE
  /review                                    Show this help
  /review --all  [flags] [scope]             Review the entire codebase
  /review --diff [flags] [scope]             Review the current diff vs base

FLAGS
  --all          Review the entire codebase. Phase 2 agents run with
                 scope=all; doc-enforce and tdd-enforce run their full
                 manifests against every file. Heavier but exhaustive.
  --diff         Review only changes against the PR base (resolved via
                 `gh pr view --json baseRefName`, falling back to
                 origin/main). Phase 2 agents run with scope=diff. Faster,
                 ideal during active feature work before opening a PR.
  --deep         Add Phase 3: behavioral verification of SDD requirements
                 against their implementation. Spawns ceil(N/15) parallel
                 deep-reviewer agents that read each REQ's ACs + impl +
                 tests and judge whether the code actually does what the
                 AC describes. Expensive — meant as a periodic audit, not
                 a per-PR pass. Skip unless you want spec-vs-impl truth-
                 check coverage this run.
  --verify-high  After the Reality Filter (Phase 6), send every surviving
                 HIGH and CRITICAL finding to external code LLMs (GPT +
                 Gemini) for verification and fix proposals. Adds Phase 7.
                 Cost-bounded at 2 LLM calls total.
  [scope]        Optional free-text scope hint passed to every review
                 agent. Narrows focus within the chosen --all/--diff mode
                 (e.g., "focus on src/routes/").

EXAMPLES
  /review --all                     Full whole-codebase structural review
  /review --diff                    Quick structural review of in-progress changes
  /review --all --verify-high       Full review with external LLM cross-check
  /review --diff --verify-high      Same, narrowed to the current diff
  /review --all --deep              Full review + behavioral verification of all REQs
  /review --diff --deep             Behavioral verification of REQs touched by the diff
  /review --all --deep --verify-high  Kitchen sink
  /review --diff src/routes/        Diff review narrowed to one directory

PHASES
  1   Argument parse + run directory
  2   Parallel agent dispatch (6 agents: security, architect, code-
      reviewer, refactor-cleaner, tdd-guide, doc-updater)
  3   REQ behavioral verification (only when --deep)
  4   Cross-reference + dedup
  5   AD filtering against documentation/decisions/README.md
  6   Reality Filter (Q1-Q6)
  7   LLM verification (only when --verify-high)
  8   Interactive triage (only phase in main session context)
  9   Save triage + append to sdd/.review-decisions.md
  10  Update ADs + create tech-debt GitHub issues
  11  Plan mode for Fix decisions

OUTPUT
  Each run writes to /home/user/Temporary/Review/<timestamp>/, with
  /home/user/Temporary/Review/latest symlinked to the most recent run.
  Phase outputs: 01-06 (Phase 2 agent reports), 07-req-verify-NN (one
  file per Phase 3 batch, only when --deep), 08 (cross-ref), 09 (active
  after AD filter), 10 (real findings after Reality Filter), 11 (LLM-
  verified, only when --verify-high), 12 (triage decisions).

CYCLE EXPECTATION
  On a stable codebase the count of active CRITICAL/HIGH/MEDIUM findings
  drops materially each cycle and is typically near-zero by the third
  successive run. Phase 5 surfaces Cycle Health in its header.

SIBLINGS
  /sdd clean             Rescue a rotted SDD spec
  /sdd clean --all       Same, full corpus
  /sdd clean --diff      Same, diff-scoped
```

## Context Preservation (load-bearing)

The main session agent is primarily an orchestrator. All source-code analysis and all reading of files `01-12` and `documentation/decisions/README.md` MUST be delegated to Task agents.

The main agent may read only:
- After Phase 5: the first ~20 lines of `09-active-findings.md`
- After Phase 6: the first ~30 lines of `10-real-findings.md`
- After Phase 7: the first ~30 lines of `11-llm-verified.md`
- Phase 8: the `## Real Findings` and `## Tech-Debt Surfaced` sections of `10-real-findings.md` (or `11-llm-verified.md` if Phase 7 ran) for triage
- Phase 11: the `## Fix` section of `12-triage-results.md` to enter plan mode

Never read source files, `01-08`, or `documentation/decisions/README.md` directly.

## Shell execution

In context-mode sessions, route shell snippets through `mcp__context-mode__ctx_execute` (or `ctx_batch_execute` for multi-step batches). Otherwise use the Bash tool directly. Both produce identical output.

## Phase 1: Parse Arguments + Create Run Directory (main agent)

Step 1a — parse `$ARGUMENTS` into four variables:

- `$SCOPE` = `all` (if `--all` present) or `diff` (if `--diff` present). If neither is present the help screen above already short-circuited; this step never executes without one of them set. If both `--all` and `--diff` are passed as standalone tokens, `--all` wins and a one-line warning is printed; word-boundary match (do not substring-match `--all` against `--all-the-things` or any unrelated free-text token).
- `$DEEP` = `true` (if `--deep` present as a standalone token) else `false`.
- `$VERIFY_HIGH` = `true` (if `--verify-high` present as a standalone token) else `false`.
- `$SCOPE_HINT` = remaining free text after stripping the four known flags. Empty string if nothing left.

Step 1b — resolve the project root and create the run directory:
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
`HAS_SDD=0` means later phases that read `sdd/*` files treat each as empty (no errors, no findings). `HAS_DOCS=0` means later phases that read `documentation/*` likewise treat as empty.

Step 1c — record the scope decision so Task agents can read it without re-parsing `$ARGUMENTS`:
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

> **Force-push caveat:** `git diff origin/$BASE_REF...HEAD` resolves against the current branch tip and does not consult the Stop hook's `.git/sdd-last-ack-pr-head` checkpoint. On force-pushed branches, the diff may include files whose history was rewritten rather than just the genuinely new changes. The noise is bounded (still scoped to the merge-base side of `...`) and only affects manually-invoked `/review` on force-pushed PRs. If you need a strict "since-last-review" diff on a force-pushed branch, pass `--scope=diff` with an explicit base or run `/review --scope=all`.

Step 1d — print the run summary so the user knows what's happening:
```
/review run: $REVIEW_DIR
  scope:        $SCOPE  (diff -> against origin/$BASE_REF)
  deep:         $DEEP
  verify-high:  $VERIFY_HIGH
  scope hint:   $SCOPE_HINT (or "(none)")
```

Use `$REVIEW_DIR` for ALL output files and `$REVIEW_DIR/.scope.txt` for scope plumbing in every subsequent phase.

Step 1e — refresh the graphify graph so every downstream phase queries current code. Per REQ-AGENT-023, graphify is ambient infrastructure in every codeflare container; per REQ-AGENT-025 the post-clone hook ensures a graph exists. Before Phase 2 spawns any agent:

```bash
if [ -f "$PROJECT_ROOT/graphify-out/graph.json" ]; then
  # AST-only refresh, free, ~5-15s on medium repos; ensures graph reflects current HEAD.
  # If the refresh fails, the on-disk graph may be stale relative to HEAD — Q6 graph-orphan
  # would then false-positive-DROP real findings. Set the no-graph marker on failure so
  # downstream phases use the safer grep-style fallback instead of trusting stale state.
  if ! (cd "$PROJECT_ROOT" && timeout 180 graphify update . 2>>"$REVIEW_DIR/.graphify-update.log"); then
    echo "Note: graphify update . failed or timed out at $(date -Iseconds). Graph at $PROJECT_ROOT/graphify-out/graph.json may be stale; treating as no-graph to avoid stale-orphan false positives. See .graphify-update.log for details." > "$REVIEW_DIR/.no-graph.notice"
  fi
else
  echo "Note: no graphify graph at $PROJECT_ROOT/graphify-out/graph.json - structural review checks will fall back to grep-style search. Run /graphify once to enable graph-aware review." > "$REVIEW_DIR/.no-graph.notice"
fi
```

The update runs at most once per `/review` invocation, with a 180s hard timeout to prevent indefinite hang. Failures (non-zero exit, timeout, missing CLI) are non-fatal and write `.no-graph.notice` — downstream phases fall back to grep-equivalent search instead of risking stale-graph false positives. Tool-agnostic: in context-mode environments the same step runs via `mcp__context-mode__ctx_execute` for the `graphify update` call; in plain Bash via the snippet above.

## Phase 2: Parallel Agent Dispatch (6 Task agents)

Launch **all 6 agents in parallel** using the Task tool. Each agent reviews per the parsed `$SCOPE` (`all` = entire codebase; `diff` = the diff against `origin/$BASE_REF`) plus the optional `$SCOPE_HINT`, then writes structured findings to its output file.

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
You are conducting a [SCOPE_DESCRIPTION] review of the project at [PROJECT_ROOT].

Scope mode: [SCOPE]    ([SCOPE_DESCRIPTION])
[If SCOPE = diff]: review only what appears in `git diff origin/[BASE_REF]...HEAD`.
                   Read $REVIEW_DIR/.scope.txt for BASE_REF + DIFF_CMD.
[If SCOPE = all]:  review the entire codebase.

[SCOPE_HINT if provided, e.g., "Within that scope, focus on src/routes/."]

[For SCOPE = diff: Use the DIFF_CMD output to identify changed files; Read each one fully and Read directly-related files for context. Do NOT review files outside the diff unless they are imported by changed files.]
[For SCOPE = all:  Use Glob and Grep to explore; Read to examine files.]

For structural lookups - "what calls X", "what depends on Y", "where is Z used", "is this dead code", "what does this symbol connect to" - PREFER the `mcp__graphify__*` MCP tools (`get_node`, `get_neighbors`, `query_graph`, `shortest_path`, `god_nodes`, `get_community`, `graph_stats`) over Grep / ctx_search. The graph at `[PROJECT_ROOT]/graphify-out/graph.json` was refreshed at the start of this `/review` run (Phase 1 Step 1e). Graphify MCP tools work identically under both Bash and context-mode environments. If the graph is unavailable or stale (`$REVIEW_DIR/.no-graph.notice` is present), fall back to Grep / ctx_search.

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
**Scope:** [SCOPE] ([all-codebase | diff vs origin/BASE_REF])
**Findings:** [total count]

Focus on: [AGENT-SPECIFIC FOCUS AREA]

Skill invocation override for /review mode (when applicable to your agent type):
- **doc-updater**: invoke `doc-enforce` skill with `scope=[SCOPE]` as your first action. The skill conditionally invokes doc-enforce-lanes / doc-enforce-shape / doc-enforce-truth as needed. If your repo has no `sdd/` or no `documentation/` (vibe-coding mode), write a one-line "no-op (vibe-coding mode: no sdd/ or no documentation/ — doc-enforce has no surface to check)" header to your output file and return — do not leave the file empty.
- **tdd-guide**: invoke `tdd-enforce` skill with `scope=[SCOPE]` against the [test files in the diff | every test file in the codebase] as your first action.
- **code-reviewer**: when your scope includes test files, invoke `tdd-enforce` with `scope=[SCOPE]`.

The `scope` parameter propagates from /review's mode flag into each skill invocation. `scope=all` lets the full manifest run against the whole codebase; `scope=diff` lets the spine's PR-base-aware diff resolution narrow it.

Do NOT run any builds, tests, or linters locally. Read and analyze the code only.
```

When dispatching, substitute the placeholders:
- `[SCOPE]` → `all` or `diff` (literal value from `$REVIEW_DIR/.scope.txt`)
- `[SCOPE_DESCRIPTION]` → `"comprehensive whole-codebase"` for `all`, or `"diff-scoped"` for `diff`
- `[BASE_REF]` → value from `.scope.txt`, only meaningful in diff mode
- `[SCOPE_HINT]` → the free-text remainder, or omitted if empty

Agent ID prefixes: SEC (security), ARCH (architecture), QUAL (code-quality), DEAD (dead-code), TEST (test-gaps), DOCS (documentation).

### CRITICAL: All 6 agents MUST be launched in a SINGLE message with 6 parallel Task tool calls.

Note: this is `/review`'s own orchestration. It is deliberately divergent from the PR-boundary protocol (code+spec parallel, then doc-updater sequentially) because `/review` Phase 2 agents write only to `$REVIEW_DIR/0N-*.md` report files - not to `sdd/` or `documentation/` - so the filesystem-race rationale for sequential spec→doc does not apply here.

If the environment does not support 6 parallel Task calls, launch in batches of 3. If any agent fails, retry once. If it still fails, continue with successful reports and note the missing report in the summary.

Wait for all 6 agents to complete. Then:
- If `$DEEP` is `true`: proceed to Phase 3.
- If `$DEEP` is `false`: skip Phase 3 entirely and proceed to Phase 4.

## Phase 3: REQ Behavioral Verification (parallel Task agents — only when --deep)

Skip this entire phase when `$DEEP` is `false`. The downstream pipeline (Phase 4 cross-reference) glob-discovers report files and runs correctly with zero Phase 3 outputs.

When `$DEEP` is `true`, this phase spawns ceil(N/15) parallel `deep-reviewer` agents that read every in-scope REQ + its impl + its tests and emit per-AC verdicts. Findings flow into the same canonical/triage pipeline as Phase 2 findings via Phase 4 cross-reference.

### Step 3a — Build the REQ batch list (main agent)

The main agent (NOT a Task agent — this is a cheap shell step) materialises the REQ list and partitions it into batches of 15.

```bash
# Discover Implemented REQs in scope
if [ "$SCOPE" = "diff" ]; then
  # Only REQs whose impl files appear in the diff
  CHANGED_FILES=$(git diff origin/${BASE_REF}...HEAD --name-only)
  # Grep sdd/ for REQ IDs whose Implements/Verification fields reference changed files
  # (heuristic: any REQ block in sdd/*.md that mentions any changed-file path)
  REQ_IDS=$(grep -lE "REQ-[A-Z]+-[0-9]+" sdd/*.md \
            | xargs awk '
              /^### REQ-[A-Z]+-[0-9]+/ { req=$2 }
              /Status:.*Implemented/ && req { print req; req="" }
            ')
  # Filter to REQs whose body references any changed file
  REQ_IDS=$(for r in $REQ_IDS; do
    if grep -qF -f <(echo "$CHANGED_FILES") <(awk "/$r/,/^### REQ-/" sdd/*.md); then
      echo "$r"
    fi
  done)
else
  # SCOPE=all — every Implemented REQ
  REQ_IDS=$(awk '
    /^### REQ-[A-Z]+-[0-9]+/ { req=$2 }
    /Status:.*Implemented/ && req { print req; req="" }
  ' sdd/*.md)
fi

# Apply SCOPE_HINT if provided (free-text grep narrow)
if [ -n "$SCOPE_HINT" ]; then
  REQ_IDS=$(echo "$REQ_IDS" | grep -F "$SCOPE_HINT" || echo "$REQ_IDS")
fi

# Group by impl-file (locality preserved across batches) then chunk by 15.
# The grouping algorithm:
#   1. Read each REQ's Implements field to extract the primary impl file path
#   2. Sort REQs by impl file path (lexical) — REQs sharing a file end up adjacent
#   3. Chunk the sorted list into groups of up to 15 REQs
# Each chunk becomes one Phase 3 batch. The Task agent reads the impl file once
# per batch even though up to 15 REQs reference it.

REQ_COUNT=$(echo "$REQ_IDS" | wc -l)
BATCH_COUNT=$(( (REQ_COUNT + 14) / 15 ))

# Write the batches to disk so each Task agent can find its own slice
mkdir -p "$REVIEW_DIR/.deep"
echo "$REQ_IDS" | split -l 15 - "$REVIEW_DIR/.deep/batch-"
ls "$REVIEW_DIR/.deep/" > "$REVIEW_DIR/.deep/index.txt"
```

If `REQ_COUNT` is 0, write `$REVIEW_DIR/07-req-verify-00.md` with a one-line `"# REQ Behavioral Verification - SKIPPED (no Implemented REQs in scope)"` header and proceed to Phase 4. Do not spawn Task agents.

### Step 3b — Print the dispatch plan

```
Phase 3 (deep): $REQ_COUNT Implemented REQs in scope, dispatching $BATCH_COUNT batches.
  Batch size: up to 15 REQs each.
  Locality: REQs grouped by primary impl file before chunking.
```

### Step 3c — Launch deep-reviewer agents in parallel

Launch `$BATCH_COUNT` Task agents in a SINGLE message with `subagent_type: deep-reviewer`. Each agent receives its batch identifier and the REQ list path.

If `$BATCH_COUNT > 5`, launch in waves of 5 (the Task API may rate-limit beyond that). The waves are sequential at the wave boundary; within each wave agents run in parallel.

Each agent's prompt:

```
You are deep-reviewer batch [BATCH_ID] of [BATCH_COUNT] for /review run [REVIEW_DIR].

Project root: [PROJECT_ROOT]
Output file:  [REVIEW_DIR]/07-req-verify-[BATCH_ID].md
Scope:        [SCOPE]   (diff -> base ref origin/[BASE_REF])
Scope hint:   [SCOPE_HINT or "(none)"]

REQ list for your batch: [REVIEW_DIR]/.deep/batch-[BATCH_ID]
Read it and verify every REQ ID it contains.

Follow your standard verification procedure (read REQ, identify impl, read impl,
read tests, judge per AC, suggest fix type for mismatches). Write findings to
your OUTPUT_FILE in the format defined in your agent definition.

For REQ-to-impl mapping and AC-to-symbol chain verification, PREFER the
`mcp__graphify__*` MCP tools (`get_node`, `get_neighbors`, `shortest_path`,
`query_graph`) over grep-style search. `shortest_path(REQ-X-NNN, <cited-symbol>)`
is the structural axis for behavioural-match verification: if the graph returns
a path, the impl chain exists; no path means the implementation is missing or
named differently. The graph at [PROJECT_ROOT]/graphify-out/graph.json was
refreshed in Phase 1 Step 1e. If [REVIEW_DIR]/.no-graph.notice exists, the
graph is unavailable or stale - fall back to grep / Read for impl identification
and record "graph unavailable" as evidence for any unclear verdict. Graphify
MCP tools work identically under both Bash and context-mode environments.

Severity rubric: CRITICAL for security/auth/billing/data-loss AC mismatches,
HIGH for behavioral mismatches in general, MEDIUM for unclear verdicts, LOW
reserved for cosmetic drift.

Hard rules: one finding per mismatch/unclear AC (not per REQ); every finding
carries a file:line evidence anchor; the "Verified Clean" section listing
fully-matching REQs is MANDATORY; never edit any file other than OUTPUT_FILE.
```

### Step 3d — Wait + verify outputs

After all agents return, verify each `$REVIEW_DIR/07-req-verify-[BATCH_ID].md` exists. If any batch produced no file or an empty file, log the failure to `$REVIEW_DIR/.deep/failures.txt` and continue — the downstream pipeline tolerates partial coverage and will note the gap.

Read NOTHING from the batch files in the main agent. Phase 4 (cross-reference) does the consolidated read.

Proceed to Phase 4.

## Phase 4: Cross-Reference (Task agent)

Launch a single Task agent (`code-reviewer` type). The agent:

1. Discovers available report files dynamically (some agents may have failed; Phase 3 may have been skipped if `--deep` was absent)
2. **Deduplicates**: when 2+ agents flag the same underlying issue, produces one canonical finding with merged title, union of source agent IDs, highest severity from any agent, and combined suggestions. Preserves original finding IDs as references. Phase 3 `DEEP-NN-NNN` findings dedup against Phase 2 findings the same way (e.g., a code-reviewer `QUAL-007` flagging a Sec-Fetch-Site gap and a deep-reviewer `DEEP-02-003` flagging the same gap on the same line merge into one canonical finding).
3. Identifies **cross-domain findings** - issues flagged by 2+ agents from different angles (elevate confidence)
4. Identifies **false positives** - findings that contradict each other or are explained by context in other reports
5. Identifies **emergent patterns** - systemic issues only visible when combining perspectives
6. Writes consolidated output to `$REVIEW_DIR/08-cross-reference.md`

Task agent prompt:

```
List the existing review files at [REVIEW_DIR]/0*.md (use Glob). Expected files:
- 01-security.md through 06-documentation.md (Phase 2 outputs)
- 07-req-verify-NN.md (one per Phase 3 batch; ABSENT if --deep was not passed)
Read ONLY the files that actually exist. Some review agents may have failed - do not attempt to read missing files.

Perform cross-referencing analysis:

1. DEDUPLICATION: When 2+ agents flag the same underlying issue, merge into one canonical finding:
   - Canonical ID: CF-NNN
   - Raw IDs: list all original IDs (e.g., SEC-003, QUAL-014, DEEP-02-003)
   - Severity: highest from any agent
   - Confidence: highest from any agent
   - Source agents: union of all agents that flagged it (deep-reviewer counts as a source agent the same as code-reviewer, security-reviewer, etc.)
   - Description: merged from all perspectives
   - Suggestion: combined recommendations
   - For DEEP-* raw IDs: ALSO preserve `req_id`, `ac_index`, `suggested_fix_type`, and `verdict` (mismatch/unclear) fields verbatim from the source file. Phase 8 triage uses `suggested_fix_type` to show the user which fix lane the finding implies.
   Deduplicate by location+category match or semantic similarity.

2. CROSS-DOMAIN FINDINGS: Among canonical findings, flag those confirmed by 2+ agents.
   These have higher confidence.

3. FALSE POSITIVES: Identify findings contradicted by context in other agent reports.
   Explain the reasoning for each removal.

4. EMERGENT PATTERNS: Identify systemic issues only visible when combining multiple review perspectives.
   Example: "all 3 API routes lack validation" or "test gaps align with the most complex modules."

Write output to [REVIEW_DIR]/08-cross-reference.md using this format:

# Cross-Reference Analysis

## Canonical Findings
[One entry per canonical finding with CF-NNN ID, raw IDs, merged details. DEEP-* raw IDs MUST carry their req_id, ac_index, suggested_fix_type, and verdict alongside the standard fields.]

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

## Phase 5: AD Filtering (Task agent)

Launch a single Task agent (`code-reviewer` type) to perform architecture decision filtering.

Task agent prompt:

```
You are filtering codebase review findings against documented architecture decisions.

1. Read [REVIEW_DIR]/08-cross-reference.md - canonical findings are the primary source of truth.
2. Search documentation/decisions/README.md in the project root for architecture decisions. If documentation/decisions/README.md does not exist or contains no architecture decision entries, write [REVIEW_DIR]/09-active-findings.md with ALL canonical findings marked active (zero AD-guarded) and stop.
3. You may read CLAUDE.md files for implementation context, but ONLY documentation/decisions/README.md has authority to justify AD-guarding. Do not AD-guard a finding based solely on CLAUDE.md.
4. For each canonical finding, check if an architecture decision in documentation/decisions/README.md explicitly justifies the flagged pattern.

AD-Guard Rules (strict):
A finding may ONLY be marked AD-GUARDED if ALL of these are true:
- The AD explicitly references the exact pattern or tradeoff
- The implementation materially matches the AD constraints
- The finding is about an intentional design tradeoff, not a correctness or safety defect
- The finding is NOT severity CRITICAL
- HIGH findings may only be AD-guarded if they are architectural tradeoffs, not bugs or security issues

Each AD-guarded finding must record:
- The exact AD title/heading from documentation/decisions/README.md
- The relevant quote from the AD

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

After the Task agent completes, read the first ~20 lines of `$REVIEW_DIR/09-active-findings.md` and print them to the user. Phase 6 still runs even if Active = 0 - the cycle counter and audit log are useful artifacts even on clean cycles.

## Phase 6: Reality Filter (Task agent)

The Reality Filter re-evaluates every Phase-5-active finding against six questions, using prior triage history (`sdd/.review-decisions.md`), ADR bodies, the unified global graph (cross-session feedback + user preferences + project conventions), recent git log, `sdd/changes.md`, and the project-local code-knowledge graph at `[PROJECT_ROOT]/graphify-out/graph.json`. It produces a SHORT list of real findings the user actually triages, an audit log of every drop, and a Tech-Debt-Surfaced section for findings that don't clear the user-impact bar. Q3 clustering, Q5 chain validation, and Q6 graph-orphan use the project-local graph; Q2 memory-says-no uses the unified graph.

Launch a single Task agent (`code-reviewer` type). The agent has access to the graphify MCP tools (`mcp__graphify__query_graph`, `mcp__graphify__get_node`, `mcp__graphify__get_neighbors`, `mcp__graphify__get_community`, `mcp__graphify__shortest_path`, `mcp__graphify__god_nodes`, `mcp__graphify__graph_stats`). If the project-local graph is missing (`$REVIEW_DIR/.no-graph.notice` exists), Q3 falls back to category-only grouping and Q6 is inert this cycle. If the unified graph is unreachable, Q2 produces no drops.

Task agent prompt:

```
You are the REALITY FILTER stage of a multi-cycle codebase review. Your job is to take
the AD-filtered list of N active findings and produce the SHORT list of REAL findings
worth surfacing to the user, plus an audit log of every drop. Filter ruthlessly against
questions Q1-Q6 below. Do NOT filter to hit a target count - if all N findings survive
the questions, surface all N.

## Inputs to read

1. Active findings: [REVIEW_DIR]/09-active-findings.md - read the `## Active Findings`
   section ONLY. Ignore the `## AD-Guarded Findings (removed from active list)`
   section above it: those findings are settled by ADR and must not re-enter the
   pipeline. Pulling them back in would re-surface findings the user already
   resolved via an architecture decision.
2. Persistent triage history: [PROJECT_ROOT]/sdd/.review-decisions.md
   - If `HAS_SDD=0` or the file does not exist, treat as empty (first run / non-SDD project). Q1 will produce no drops.
   - This file is the primary source of triage history. It is committed to git, so prior decisions follow the repo, not the developer's machine.
3. Full ADR bodies: [PROJECT_ROOT]/documentation/decisions/README.md
   - If `HAS_DOCS=0` or the file does not exist, treat as empty (no ADRs). Q1 sub-step checking for ADR-anchored decisions yields no matches.
4. Recent git activity: cd [PROJECT_ROOT] && git log --since="30 days ago" --oneline --no-merges
5. Spec changes: [PROJECT_ROOT]/sdd/changes.md and [PROJECT_ROOT]/sdd/README.md
   - If `HAS_SDD=0` or either file is missing, treat as empty.
6. Unified global graph (cross-session feedback + project conventions): call
   `mcp__graphify__query_graph` against the unified graph (vault + active repos,
   merged at `~/.graphify/global-graph.json`) with each of these queries:
     - "code review feedback"
     - "user preferences"
     - "<project name> conventions" (substitute the project's actual name)
   For findings whose category overlaps a returned node, drill into the node's
   neighbourhood via `mcp__graphify__get_node` and `mcp__graphify__get_neighbors`.
   If the unified graph is unreachable, skip this input — Q2 produces no drops
   this cycle.
7. (Optional) [PROJECT_ROOT]/pending.md if present - explains in-flight work that may
   make a "missing feature" finding actually a known gap.
8. Graphify code-knowledge graph at [PROJECT_ROOT]/graphify-out/graph.json — queried
   via mcp__graphify__get_community (Q3 cluster grouping), mcp__graphify__shortest_path
   (Q5 chain validation), mcp__graphify__get_node (Q6 graph-orphan check). If
   [REVIEW_DIR]/.no-graph.notice is present, the graph is unavailable or stale: Q3
   falls back to category-only grouping, Q5 skips the graph step and keeps original
   severity, Q6 is inert this cycle.

## The six questions, applied per finding (DROP, KEEP, DOWNGRADE, or DEMOTE-to-Tech-Debt)

### Q1: Repeat-offender drop

Match the finding's (location, category) tuple against entries in
sdd/.review-decisions.md. If a prior entry exists with decision Defer / Ignore /
Tech-Debt AND no commit has touched the file since that entry's date:
  -> DROP. Audit reason: "Q1: prior <decision> recorded <date>, no commits since."

If the file has been touched since the prior entry, the prior decision is invalidated
(the code may now have a real bug). Re-evaluate via Q2-Q6.

Use literal file path matching. Renames are rare; if a file was renamed, the prior
decision will simply not match and the finding gets surfaced fresh - the audit log
makes this visible and the user can re-defer if appropriate.

### Q2: Memory-says-no drop

If the finding contradicts a node in the unified global graph returned by Phase
6 input #6 (e.g. a feedback node says "prefer concrete duplication over premature
abstraction" and the finding says "extract this into a helper"):
  -> DROP. Audit reason: "Q2: contradicts graph node '<label>' (source: <src_file>): <one-line summary>."

If input #6 was skipped (unified graph unreachable), Q2 produces no drops.

### Q3: Cluster aggregation

Group surviving (post-Q1, post-Q2) findings by **(category, community)** where community is the graphify community membership of the finding's cited file/symbol. Call `mcp__graphify__get_community(<node>)` for each finding's location; group findings that share both category and community. If `[PROJECT_ROOT]/graphify-out/graph.json` is missing (`$REVIEW_DIR/.no-graph.notice` exists), fall back to category-only grouping.

If a group has 3 or more findings, AND none of them have a Q1 match in sdd/.review-decisions.md (i.e. this is the first cycle this rule is producing violations):
  -> COLLAPSE the group into ONE cluster finding listing all locations.
  -> Cluster finding ID: take the lowest CF-ID in the absorbed group and append
     "-cluster" (e.g., absorbing CF-005, CF-018, CF-031 -> CF-005-cluster). If
     that combined ID would collide with another cluster created in this same
     run, use the next-lowest absorbed CF-ID instead. Cluster IDs are within-run
     identifiers only - they are NOT stored in sdd/.review-decisions.md (Phase 8
     expands clusters to per-location entries keyed by (file:line, category)),
     so cross-cycle stability is not required.
  -> Severity = max severity in the group.
  -> Description: "<rule short name>: <count> instances in <community-label>. <one-line shared description>"
  -> Suggestion: "Sweep PR across the <community-label> cluster. Or AD-justify the pattern."
  -> Audit reason per absorbed finding: "Q3: clustered into CF-NNN-cluster (community: <community-label>)."

The user triages the cluster ONCE. The triage decision (Phase 8) writes ONE
.review-decisions entry PER LOCATION in the cluster, so Q1's per-location lookup
works in cycle N+1.

Threshold rationale: 3 is the smallest "this is a pattern, not individual issues"
count. 1 or 2 instances are individual problems; 3+ deserves a sweep decision. Community-aware grouping prevents two unrelated 3-instance patterns from collapsing into one false cluster just because they share a category label.

### Q4: User-impact bar (DEMOTE to Tech-Debt-Surfaced)

Re-evaluate severity against user-visible impact, not the producing agent's internal
scale. Findings that do not clear the bar move to the Tech-Debt-Surfaced section
(NOT dropped from output - Tech-Debt is still surfaced for triage):

CRITICAL must be:
  - Data loss / corruption risk
  - Money / billing risk
  - Access control bypass
  - Production crash / availability loss
  - Security mistake (exploitable)

HIGH must be:
  - Real bug that produces wrong observable behavior
  - Spec-vs-shipped contradiction in load-bearing area
  - CI / deploy gate that breaks
  - Significant doc-vs-code drift in user-facing API or auth

MEDIUM must be:
  - Real bug class with low blast radius
  - User-facing API doc lie
  - Test gap on a real bug class

Below MEDIUM bar: move to "## Tech-Debt Surfaced" section. Audit reason per moved
finding: "Q4: <agent severity> -> Tech-Debt; reason: <which bar failed>."

Anything that even after re-evaluation clears the bar: KEEP at the (possibly
adjusted) severity in "## Real Findings".

### Q5: Spec-vs-shipped truth-test

For doc-vs-code drift findings (DOCS-* raw IDs, or any finding whose category
mentions "documentation" or "doc drift"): Read the cited source file and verify
that the claimed mismatch actually exists.

If source contradicts finding's premise:
  -> DROP. Audit reason: "Q5: source verification failed. Cited <file:line>; actual code <quote>."

If source confirms finding:
  -> KEEP at the original severity (often HIGH or CRITICAL for doc drift on
     security or billing). Add evidence: "Verified at <file:line>: <quote>."

When the finding claims a spec-to-implementation chain ("REQ-X-NNN says the auth endpoint validates X but `routes/auth.ts:42` does not"), additionally call `mcp__graphify__shortest_path(<REQ-or-AC-node>, <cited-symbol>)` to confirm the structural chain exists. If `$REVIEW_DIR/.no-graph.notice` exists, skip this graph-aware step and keep the finding at its original severity (the source-read check above is sufficient). If the graph is present and `shortest_path` returns no path, the cited mapping may be stale (the symbol was renamed or moved). In that case, downgrade to MEDIUM with audit reason "Q5: graph chain not found; cited symbol may be stale." If the graph returns a path: keep at original severity and record the path as evidence.

Q5 downgrades to MEDIUM (from a no-path shortest_path result) appear in the "Real Findings" section at the downgraded severity AND in the audit log under "Q5 downgrades" — they are NOT silent. See output schema below.

### Q6: Graph-orphan check (graphify-aware)

For any finding citing a specific code symbol or file (not "repository-wide", not "multiple files"), confirm the cited node exists in the graphify graph via `mcp__graphify__get_node(<symbol-or-file>)`.

If the node is missing AND `[PROJECT_ROOT]/graphify-out/graph.json` exists (i.e. graph is current, not stale): the cited location has been removed or renamed since the finding was generated. Audit reason: "Q6: graph-orphan; cited <symbol-or-file> not present in current graph."
  -> DROP.

If the graph is missing (`$REVIEW_DIR/.no-graph.notice` exists): Q6 is inert this cycle.

This catches the class of findings produced by agents who looked at a stale checkout, an older commit, or a deleted-since-but-still-named-in-memory symbol.

## Hard rules

- Be ruthless, not aggressive. The point is to drop findings that ARE noise. Erring
  on the side of dropping is correct because anything mistakenly dropped resurfaces
  next cycle if it's real.
- Every KEEP must cite at least one piece of concrete evidence: file:line, commit
  SHA, AD ref, `.review-decisions` entry, unified-graph node label, or
  `sdd/changes.md` date.
- Every DROP and DEMOTE must have a one-line reason in the audit log keyed by which
  question dropped it.
- Read actual source for any finding you keep with severity HIGH or CRITICAL.
- Do not retry graphify calls if they fail; skip the affected input and continue.

## Output: ONE file at [REVIEW_DIR]/10-real-findings.md

Format:

# Real Findings (Reality-Filtered)
**Source:** [REVIEW_DIR]
**Cycle:** N+1 (read `Last cycle: N` from sdd/.review-decisions.md if it exists - this run is cycle N+1; if file is missing, this is cycle 1)
**Active findings (Phase 5 input):** X
**Real findings (after Q1-Q6):** Y
**Tech-Debt surfaced:** W
**Auto-filtered (dropped):** X - Y - W

## Cycle Health

Active CRITICAL/HIGH/MEDIUM going into this cycle: A
Surviving CRITICAL/HIGH/MEDIUM after Reality Filter: B

(Surfaced for visibility. The expectation, on a stable codebase, is that B trends
toward zero by the third successive run. Cycle 3 with B>0 may indicate filter
calibration to revisit, or genuinely new bugs introduced between cycles.)

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
will treat these as Tech-Debt by default unless the user upgrades them.]

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
- CF-NNN at <location>: original severity HIGH/CRITICAL; mcp__graphify__shortest_path found no chain to <cited-symbol>; cited mapping may be stale.

### Q6: Graph-orphan drops (X)
- CF-NNN at <location>: cited symbol/file not present in current graphify graph; likely removed or renamed.

## Memory mode

Cost contract: this whole phase MUST be ONE Task agent. Do not spawn additional
sub-agents. Read files directly via Read; query the unified graph directly via the
granted graphify tools. The Auto-Filtered audit section is mandatory output - if it
is missing or empty when DROP/DEMOTE counts are non-zero, the phase failed.
```

After the Task agent completes, read the first ~30 lines of `$REVIEW_DIR/10-real-findings.md` and print them to the user.

**Orchestrator check:** Parse the "Real findings (after Q1-Q6)" count and the "Tech-Debt surfaced" count from the header. If both are 0, output "Clean review - no actionable findings after Reality Filter" and STOP. Do not proceed to Phase 7 or beyond.

If `--verify-high` is NOT in $ARGUMENTS, skip Phase 7 and proceed to Phase 8.

## Phase 7: LLM Verification (Task agent - only when --verify-high is present)

Launch a single Task agent (`code-reviewer` type) to verify ALL HIGH and CRITICAL findings with external LLMs in **2 batched calls total** (one per LLM, ALL findings in a single prompt). Never one-call-per-finding - the cost scales linearly with finding count and burns the orchestrator's context with N×2 LLM responses when one batched response per LLM carries the same information.

Task agent prompt:

```
You are verifying HIGH and CRITICAL real findings using external LLMs.
Your goal: 2 consult_llm calls TOTAL (one to GPT, one to Gemini), each containing
ALL findings batched into a single prompt with all relevant source files attached
via the `files` parameter. Do NOT call consult_llm once per finding.

1. Read [REVIEW_DIR]/10-real-findings.md - extract ALL HIGH and CRITICAL findings
   from the "## Real Findings" section (NOT Tech-Debt-Surfaced; those are deliberately
   demoted). EXCLUDE findings whose raw IDs are ALL DEEP-* (i.e. deep-reviewer-only
   findings, no other agent flagged the same issue). Rationale: verifying a DEEP-*
   finding requires sending the relevant `sdd/{domain}.md` REQ body alongside the
   impl source so the LLM can judge AC-vs-impl match. That context inflates the
   prompt by ~10-20K tokens per affected domain and costs more than the second
   opinion is worth — deep-reviewer is already an opus-class LLM with a tight
   verification prompt, and its findings carry structured `AC text` / `Impl behavior`
   / `Evidence` / `Confidence` fields that let the user spot hallucination during
   Phase 8 triage. Cross-agent DEEP findings (e.g., deep-reviewer + code-reviewer
   flagged the same line) ARE included — the non-DEEP agent's finding carries the
   batch through Phase 7 as it would in any cross-domain case.

   If the extracted set is empty (zero HIGH/CRITICAL findings or every HIGH/CRITICAL
   is DEEP-only):
     a. Copy [REVIEW_DIR]/10-real-findings.md verbatim to [REVIEW_DIR]/11-llm-verified.md
        so MEDIUM Real Findings, Tech-Debt-Surfaced, and DEEP-only HIGH/CRITICAL
        findings all survive into Phase 8.
     b. Append a "## LLM Verification" section at the end with the line:
        "Skipped - no non-DEEP HIGH/CRITICAL findings to verify."
     c. EXIT. Do NOT call consult_llm.
   The Phase 6 orchestrator gate already short-circuits the total-zero case, but a
   Reality-Filtered list of MEDIUM+Tech-Debt only, or one consisting solely of
   DEEP-only findings, would still reach this phase and would otherwise burn 2 LLM
   calls on a list that needs no external verification. The verbatim copy preserves
   the Phase 8 single-input contract: Phase 8 reads 11-llm-verified.md unconditionally
   when Phase 7 ran, and finds the same Real Findings + Tech-Debt-Surfaced sections
   it expects.

2. Build the unique source-file set:
   - Walk every finding's `location` field, collect distinct file paths
   - For cluster findings, take ALL locations in the cluster
   - These will be passed as the `files` parameter to consult_llm so the LLM has
     the actual source - do NOT inline code in the prompt body, only cite
     file:line references.

3. Build a single batched prompt at [REVIEW_DIR]/.llm-verify-prompt.md with:
   ```
   # Verify N HIGH/CRITICAL code review findings

   For each finding below, return one of three verdicts:
     - CONFIRMED: agree the finding is real; provide a concrete code-level fix
     - REFUTED: explain why this is a false positive (cite specific code or context)
     - UNCERTAIN: state what additional context you'd need

   Output as a JSON array, one object per finding:
     [{"id": "<canonical-id>", "verdict": "CONFIRMED|REFUTED|UNCERTAIN",
       "reason": "<≤3 sentences>", "fix": "<diff or null if refuted>"}]

   ## Findings

   ### <canonical-id-1>: <one-line title>
   - Severity: HIGH|CRITICAL
   - Location: path/to/file.ts:123
   - Description: <2-4 sentences from 10-real-findings.md>

   ### <canonical-id-2>: ...
   ...
   ```

4. Write that prompt to disk. Then call consult_llm TWICE - once per provider family - passing:
   - `prompt`: a short directive only, e.g. "Read .llm-verify-prompt.md (the
     first file in the files array) and verify each listed finding against the
     source files that follow. Return the JSON array specified in the prompt
     file." The consult_llm schema explicitly forbids pasting file contents
     into the prompt field - file content goes via the `files` parameter and is
     loaded server-side. Inlining the prompt-file body here would duplicate
     content the server will already attach.
   - `files`: [REVIEW_DIR]/.llm-verify-prompt.md FIRST, then the deduplicated
     source-file paths from step 2.
   - `task_mode`: "review"
   - Model selector - use **family names**, never pin specific versions:
     - Call 1: `model: "openai"` (resolves server-side to the latest GPT)
     - Call 2: `model: "gemini"` (resolves server-side to the latest Gemini)
     Pinning concrete model IDs (e.g. `gpt-5.4`, `gemini-3.1-pro-preview`) is
     wrong - they go stale within weeks of release. The `consult_llm` server
     already maintains the "latest per family" mapping; let it do its job.
   Run the two calls concurrently if the environment permits.

5. Parse each LLM's JSON response. For each finding, combine the two verdicts:
   - BOTH refute -> LLM-REFUTED; remove from the verified list
   - BOTH confirm -> enrich finding with the better of the two fix proposals
   - DISAGREE -> keep finding active, note both verdicts
   - One call fails -> LLM-PARTIAL on all findings, keep active. **Do NOT retry the
     failed call.** The 2-call budget is a hard cap that includes failures; a
     retry would re-introduce the N×2 cost regression this phase exists to prevent.
   - Both calls fail -> LLM-UNAVAILABLE on all findings, keep active. **Do NOT retry.**

6. Write [REVIEW_DIR]/11-llm-verified.md (its OWN file - do NOT rewrite 10-real-findings.md):
   - Copy 10-real-findings.md's header verbatim, plus the Tech-Debt-Surfaced section verbatim (Tech-Debt is not LLM-verified)
   - Replace the "## Real Findings" section with the LLM-verified list. Findings that were excluded from verification (DEEP-only HIGH/CRITICAL) carry through unchanged with a one-line marker "LLM verification: skipped (DEEP-only; behavioral verification by Phase 3 deep-reviewer is the verification record)."
   - Drop LLM-REFUTED findings entirely
   - Add LLM verdicts and fix proposals to surviving non-DEEP-only findings
   - Append a "## LLM-Refuted Findings (removed)" section listing removed
     findings with the refutation reasoning from each LLM

7. Delete [REVIEW_DIR]/.llm-verify-prompt.md (it was scratch).

Cost contract: this whole phase MUST be exactly 2 consult_llm calls regardless of
how many findings there are. If you find yourself about to call consult_llm a 3rd
time, stop and re-batch.
```

After the Task agent completes, read the first ~30 lines of `$REVIEW_DIR/11-llm-verified.md` and print them to the user.

**Orchestrator check:** If the surviving Real Findings count is 0 AND Tech-Debt-Surfaced is 0, output "Clean review - no actionable findings after LLM verification" and STOP.

## Phase 8: Interactive Triage (main agent)

This is the ONLY phase that runs in the main session context.

Read the appropriate input file:
- If Phase 7 ran: `$REVIEW_DIR/11-llm-verified.md`
- Otherwise: `$REVIEW_DIR/10-real-findings.md`

Specifically the `## Real Findings` and `## Tech-Debt Surfaced` sections.

For findings whose raw IDs include a DEEP-* entry, the `suggested_fix_type` field (`spec`, `code`, `test`, or `unclear`) is shown alongside the canonical ID in the triage UI so the user sees at a glance which lane the finding implies. The triage decision lanes (Fix / Record as AD / Tech Debt / Defer / Ignore) are unchanged — `suggested_fix_type` is informational, not prescriptive.

### Pre-Triage Summary

Before asking per-finding questions, present a triage summary showing:
- Counts by severity (Real Findings + Tech-Debt-Surfaced)
- Top modules/directories affected
- Top repeated categories
- Cycle Health line (cycle N, surviving CRITICAL/HIGH/MEDIUM count)

Then ask one setup question via `AskUserQuestion`:
- **Triage all severities** - walk through every finding interactively
- **CRITICAL/HIGH only** - triage CRITICAL and HIGH interactively; auto-defer MEDIUM and LOW
- **CRITICAL/HIGH interactive, batch MEDIUM/LOW by module** - triage top severities individually, group lower severities by module

### Triage Options

For each finding or batch of related findings, use `AskUserQuestion` with these options:

**For CRITICAL findings and security/correctness defects:**
- **Fix** - include in the implementation plan (Phase 11)
- **Technical debt** - add to the GitHub issue with `technical-debt` label for future resolution
- **Defer** - needs more investigation before deciding; carry forward to next review
- **Ignore** - requires explicit reason

**For all other findings (including Tech-Debt-Surfaced):**
- **Fix** - include in the implementation plan (Phase 11)
- **Record as AD** - record as an architecture decision in documentation/decisions/README.md that justifies this pattern going forward (only valid for intentional tradeoffs, not bugs or security issues)
- **Technical debt** - add to the GitHub issue with `technical-debt` label for future resolution
- **Defer** - needs more investigation before deciding; carry forward to next review
- **Ignore** - dismiss as false positive or acceptable

**For cluster findings (CF-NNN-cluster):**
The default options are presented for the cluster as a whole. The user's decision applies to ALL locations in the cluster. A "Split" option breaks the cluster into individual findings if the user wants per-location decisions.

### Batching Rules

- **CRITICAL**: ask individually unless exact duplicates
- **HIGH**: batch by root cause or module
- **MEDIUM/LOW**: batch aggressively by module or remediation pattern
- Cluster findings (Q3 output): ask once per cluster
- Never ask one question per LOW finding unless it is uniquely important
- Example: "5 dead-code findings in src/lib/legacy/" -> single question
- For batched questions, include a **Split** option so the user can break the batch and decide per-finding
- Show: canonical ID, severity, location, description, suggestion, suggested_fix_type (if a DEEP-* raw ID is present), and LLM verdict (if Phase 7 ran)

### Question Format
```
[SEVERITY] CF-NNN: Finding Title
Location: path/to/file.ts:123
Category: Missing input validation
Confidence: high
Description: The route handler accepts user input without sanitization...
Suggestion: Add zod schema validation at the route boundary
Suggested fix type: code   [only when raw IDs include a DEEP-* entry]
[LLM Verdict: Confirmed by GPT and Gemini - both suggest zod schema]
```

After all triage questions are answered, collect the decisions into a strict JSON mapping and proceed to Phase 9:
```json
{"CF-001": "fix", "CF-002": "ad", "CF-003": "debt", "CF-004": "defer", "CF-005": "ignore"}
```

For cluster findings whose decision is NOT Split, the cluster ID maps to a single decision; Phase 9 expands it to one entry per location when writing `sdd/.review-decisions.md`.

Pass this EXACT JSON string as the decisions mapping to the Phase 9 Task agent.

## Phase 9: Save Triage Results + Append to .review-decisions (Task agent)

Launch a single Task agent (`code-reviewer` type) to write the consolidated triage results AND append per-finding triage history to `sdd/.review-decisions.md`.

Pass the triage decisions JSON mapping and `$REVIEW_DIR` path in the prompt.

Task agent prompt:

```
You are saving triage results from a codebase review AND updating the persistent
triage history file used by future Reality Filter runs.

Triage decisions (JSON): [DECISIONS_JSON]

## Step 1: Write the cycle's triage report

Read [REVIEW_DIR]/11-llm-verified.md if it exists, else [REVIEW_DIR]/10-real-findings.md,
to get full finding details.

Write [REVIEW_DIR]/12-triage-results.md with findings sorted into sections by
triage decision. For cluster findings, expand to per-location triage entries.

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
- **LLM verdict:** [if Phase 7 ran]
- **Suggested fix type:** [only when raw IDs include a DEEP-* entry: spec | code | test | unclear]

[...repeat for each Fix finding]

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

[...repeat for each AD finding]

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

[...repeat for each Tech Debt finding]

## Deferred (X findings)

### CF-NNN: [SEVERITY] Finding Title - DEFERRED
- **Location:** path/to/file.ts:345
- **Reason:** Needs further investigation

[...repeat for each Deferred finding]

## Ignored (X findings)

### CF-NNN: [SEVERITY] Finding Title - IGNORED
- **Location:** path/to/file.ts:012
- **Reason:** [reason provided by user]

[...repeat for each Ignored finding]

## Step 2: Append to sdd/.review-decisions.md

Read [PROJECT_ROOT]/sdd/.review-decisions.md if it exists. If it does not exist,
create it with this header:

# Review Decisions

Cumulative per-finding triage history. Each entry records a Defer/Ignore/Tech-Debt
decision from a `/review` cycle. Used by `/review` Phase 6 Reality Filter Q1
(repeat-offender check) on subsequent runs.

This file is NOT a substitute for ADRs. ADRs document permanent design choices
(`documentation/decisions/README.md`); entries here document per-cycle triage
calls that may evolve. When an entry's reasoning proves durable across multiple
cycles, the user may promote it to an ADR manually.

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

For Fix and AD decisions: do NOT write entries here. Fix decisions are resolved
when the implementation lands; AD decisions are recorded in
documentation/decisions/README.md by Phase 10.

If the same (file:line, Category) tuple already has an entry from a prior cycle,
APPEND a new entry rather than overwriting - the file is a log, not a snapshot.
Future Q1 lookups read the most recent matching entry.

## Step 3: Update the cycle counter

Update the file's "Last cycle: N" line near the top of the file to the cycle
number used in this run's 10-real-findings.md (and 11-llm-verified.md if Phase 7
ran) header - i.e. one greater than the value the file showed before this run.
Append the run date as "Last cycle: M (YYYY-MM-DD)". The next `/review` invocation
will read this M, treat its run as M+1, and the cycle counter advances
monotonically across cycles.
```

## Phase 10: Update Architecture Decisions + Create Tech Debt Issues (Task agent)

Launch a single Task agent (`code-reviewer` type) to update documentation/decisions/README.md with AD entries and create GitHub issues for tech debt.

Task agent prompt:

```
You are updating architecture decisions and creating GitHub issues from a codebase review.

1. Read [REVIEW_DIR]/12-triage-results.md - specifically the "Record as AD" and "Technical Debt" sections.
   If both sections are empty (0 findings each), write "No updates needed" and stop.

2. For each "Record as AD" entry:
   - Read documentation/decisions/README.md
   - Search existing Architecture Decisions for an equivalent entry by title or pattern
   - If found, update the existing entry using the Edit tool
   - If not found, append a new AD subsection at the end of the Decisions section with the next available AD number

3. For each "Technical Debt" entry:
   - Create a GitHub issue using: `gh issue create --label "technical-debt" --title "TD: [title]" --body "[description + remediation]"`
   - Do NOT write tech debt to any documentation file

IMPORTANT: Read documentation/decisions/README.md fully before editing. Use the Edit tool for AD insertions.
```

## Phase 11: Enter Plan Mode (main agent)

After Phase 10 Task agent completes:

1. Read ONLY the `## Fix` section from `$REVIEW_DIR/12-triage-results.md`
2. If there are zero Fix findings, report "No fixes requested - review complete" and stop
3. Enter plan mode with `EnterPlanMode`
4. Create an implementation plan organized by:
   - **Priority**: Security fixes first, then architecture, then code quality, then others
   - **Dependency order**: Fixes that enable other fixes come first
   - Each fix as a concrete task with:
     - Canonical ID and raw IDs
     - File paths and line numbers
     - Proposed changes (from agent suggestions and LLM proposals if available)
     - Severity and category
     - For findings with a DEEP-* raw ID: the suggested_fix_type (spec/code/test) routes the task to the correct lane — spec-fix tasks edit `sdd/`, code-fix tasks edit source, test-fix tasks edit `tests/`
5. Note: AD entries were written to documentation/decisions/README.md, Tech Debt items were created as GitHub issues, and Defer/Ignore/Tech-Debt decisions were appended to sdd/.review-decisions.md by Phase 9.

## Important Notes

- **NEVER run builds, tests, or linters locally** - the container has 1 vCPU
- All 6 Phase 2 agents MUST launch in a single message (parallel Task calls)
- Phase 3 deep-reviewer agents (when --deep is set) also launch in parallel — up to 5 per wave; sequential at wave boundaries when ceil(N/15) > 5
- Phases 4, 5, 6, 7, 9, 10 each run as a single Task agent - main agent waits for completion before proceeding
- Phase 8 is the ONLY phase that runs in the main session context (requires AskUserQuestion)
- Phase 3 is opt-in via `--deep` flag
- Phase 7 is opt-in via `--verify-high` flag
- After Phase 6: check if Real Findings + Tech-Debt-Surfaced totals are 0 - if so, STOP and report clean review. After Phase 7: re-check the LLM-verified totals.
- Each phase MUST complete fully before proceeding to the next - no phase is optional except Phase 3 and Phase 7
- Findings directory persists at `$REVIEW_DIR` for later reference; `/home/user/Temporary/Review/latest` always points to the most recent run
