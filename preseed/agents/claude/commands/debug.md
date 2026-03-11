# Systematic Debugging

Enforce root cause investigation before any fix attempts. Use when encountering bugs, test failures, unexpected behavior, or when previous fixes have failed.

## Instructions

**HARD GATE: No fixes without completing Phase 1.**

### Phase 1: Root Cause Investigation

BEFORE proposing any fix:

1. **Read error messages completely** — stack traces, line numbers, error codes. Don't skip past them.
2. **Reproduce consistently** — exact steps, does it happen every time? If not reproducible, gather more data, don't guess.
3. **Check recent changes** — git diff, recent commits, new dependencies, config changes, environmental differences.
4. **Multi-component systems** — add diagnostic logging at EACH component boundary:
   - Log what enters each component
   - Log what exits each component
   - Verify environment/config propagation
   - Run ONCE to gather evidence showing WHERE it breaks
   - THEN analyze evidence to identify the failing component
5. **Trace data flow** — where does the bad value originate? Trace backward through the call stack to the source. Fix at source, not at symptom.

### Phase 2: Pattern Analysis

1. Find working examples of similar code in the same codebase
2. Compare working vs broken — list every difference
3. Read reference implementations COMPLETELY, don't skim
4. Understand all dependencies, config, and assumptions

### Phase 3: Hypothesis and Testing

1. Form a SINGLE hypothesis: "X is the root cause because Y"
2. Make the SMALLEST possible change to test it — one variable at a time
3. Did it work? → Phase 4. Didn't work? → new hypothesis. Don't stack fixes.

### Phase 4: Implementation

1. Write a failing test reproducing the bug
2. Implement a single fix addressing the root cause
3. Verify: test passes, no other tests broken

### The 3-Fix Rule

If 3 fix attempts have failed: **STOP.**

This is NOT a failed hypothesis — this is likely a wrong architecture. Each fix revealing new problems in different places = architectural issue. Question fundamentals:
- Is this pattern fundamentally sound?
- Are we sticking with it through inertia?
- Should we refactor the architecture instead of fixing symptoms?

Discuss with the user before attempting more fixes.

## Red Flags — STOP and return to Phase 1

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- Proposing solutions before tracing data flow
- "One more fix attempt" after 2+ failures
- Each fix reveals new problems in different places

## Output

After investigation, present:

```
ROOT CAUSE: [what and why]
EVIDENCE: [what you found during investigation]
FIX: [proposed change addressing root cause]
VERIFICATION: [how to confirm the fix works]
```
