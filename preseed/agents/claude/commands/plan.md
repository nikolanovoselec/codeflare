# Plan

Design an implementation plan before writing any code. Use the architect agent for system design decisions and produce a phased plan for user approval.

## Instructions

**HARD GATE: No code until the user approves the plan.**

### Step 1: Understand Requirements

1. Restate what the user wants in your own words
2. Identify ambiguities — ask clarifying questions (one at a time, not a wall of questions)
3. List constraints: existing architecture, performance requirements, compatibility

### Step 2: Explore the Codebase

1. Find all files relevant to the change
2. Understand existing patterns and conventions
3. Identify integration points and dependencies
4. Note any existing tests that cover the area

### Step 3: Design

Spawn the **architect** agent for non-trivial decisions:
- Evaluate 2-3 approaches with trade-offs
- Consider impact on existing code
- Identify risks and edge cases

### Step 4: Present the Plan

```
## Plan: [title]

### Approach
[1-2 sentences on chosen approach and why]

### Changes
1. [file path] — [what changes and why]
2. [file path] — [what changes and why]
...

### Risks
- [risk and mitigation]

### Out of scope
- [what this does NOT change]
```

### Step 5: Wait for Approval

Present the plan and STOP. Do not write code until the user says to proceed.

If the user has feedback, revise the plan and present again.

## Arguments

$ARGUMENTS: description of what to plan (e.g., `/plan add rate limiting to the API`)
