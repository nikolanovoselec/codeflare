# Spec-Driven Development

Create a product specification from scratch through structured discovery. The output is a `spec/` folder that serves as the single source of truth for all future development.

## Instructions

**HARD GATE: No implementation during spec creation. This is a requirements exercise.**

### Step 1: Product Vision

Ask the user to describe their product idea in plain language. Use AskUserQuestion to clarify:

1. **"What problem does this solve?"** — Not what it does, but why it should exist
2. **"Who is this for?"** — Target audience (developers, consumers, teams, etc.)
3. **"What does success look like?"** — How do you know it's working?

Synthesize into a one-paragraph product vision. Present it back and wait for confirmation.

### Step 2: Principles

From the vision, propose 3-7 design principles — non-negotiable values that guide every future decision. Examples:

- "Security by default — every surface is authenticated unless explicitly public"
- "Zero setup — a new user goes from URL to working environment in under 60 seconds"
- "Offline-resilient — losing network mid-session never loses work"

Present to the user. Iterate until they confirm.

### Step 3: Constraints

Determine the architectural and technology guardrails:

1. **"Where does this run?"** — Cloudflare Workers, AWS, Vercel, self-hosted, etc.
2. **"What's the stack?"** — Based on deployment target, propose compatible technologies
3. **"What does this NOT do?"** — Explicit boundaries prevent scope creep

Write `spec/constraints.md` with technology stack table, non-functional requirements, and boundaries.

### Step 4: Domain Discovery

Identify the product's feature domains through conversation:

1. Ask: **"Walk me through what a user does, step by step, from first visit to daily use."**
2. Listen for nouns (users, sessions, files, payments) and verbs (create, upload, subscribe)
3. Group into 5-12 domains
4. Present the domain list with one-line descriptions
5. Iterate until the user confirms

### Step 5: Requirements Elicitation

For each domain, work through requirements one domain at a time:

1. Ask: **"For {domain}, what must be true for it to work?"**
2. Convert answers into numbered requirements (REQ-{DOMAIN}-{NNN}) with:
   - Intent (why)
   - Acceptance criteria (testable, binary pass/fail)
   - Constraints (guardrails specific to this requirement)
3. Mark all as `Status: Planned`
4. Present the domain file and iterate

Use the **spec** skill for formatting rules and quality checks. Every requirement must be testable, independent, and intentful.

### Step 6: Write the Spec

Create the `spec/` folder:

1. `spec/README.md` — vision, principles, domain index, out of scope
2. `spec/constraints.md` — technology stack, NFRs, boundaries
3. `spec/{domain}.md` — one file per domain with all requirements

Present the complete spec structure and wait for final approval.

### Step 7: Next Steps

After the spec is approved, tell the user:

```
Spec complete. Next steps:
1. /plan {domain} — plan implementation for a specific domain
2. Add new requirements to spec/ as the product evolves
3. After implementation, run doc-updater to keep docs in sync
```

## Arguments

$ARGUMENTS: Optional product name or description to start with (e.g., `/sdd a real-time collaboration tool for designers`)

## Tips

- Ask questions ONE AT A TIME. Never dump a wall of questions.
- Use AskUserQuestion with predefined options where possible — faster for the user.
- Start broad (vision, principles) and narrow down (domains, requirements).
- If the user already has code, suggest reverse-engineering the spec from code first, then using this workflow for new features.
- Keep requirements at the "what" level. If the user starts describing implementation ("use Redis for caching"), redirect to intent ("cache frequently accessed data to reduce latency").
- A good spec for a medium product has 50-100 requirements across 8-12 domains.
