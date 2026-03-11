# Brainstorm

Explore a problem space before committing to a solution. Use when starting something new, facing a design decision, or when the right approach isn't obvious.

## Instructions

**HARD GATE: No implementation during brainstorming. This is a thinking exercise.**

### Step 1: Understand the Problem

1. What problem are we solving? (not what feature are we building)
2. Who is affected and how?
3. What does success look like?
4. What constraints exist? (technical, time, compatibility)

Ask clarifying questions ONE AT A TIME. Do not dump a list of 10 questions.

### Step 2: Explore Context

1. How does the codebase handle similar problems today?
2. Are there existing patterns we should follow or deliberately break from?
3. What prior art exists? (search the codebase, check dependencies)

### Step 3: Generate Options

Present 2-3 distinct approaches. For each:

```
### Option [N]: [name]

**How it works:** [2-3 sentences]
**Pros:** [bullet points]
**Cons:** [bullet points]
**Complexity:** [low/medium/high]
**Files touched:** [list key files]
```

Do NOT recommend one yet. Present them neutrally.

### Step 4: Trade-off Discussion

Ask the user which trade-offs matter most:
- Speed of implementation vs long-term maintainability?
- Minimal change vs proper solution?
- User-facing impact vs internal cleanliness?

### Step 5: Recommendation

After hearing the user's priorities, recommend ONE approach with reasoning.

If the user agrees → hand off to `/plan` for implementation planning.
If the user wants changes → revise and present again.

## Arguments

$ARGUMENTS: the problem or idea to brainstorm (e.g., `/brainstorm how should we handle session persistence`)
