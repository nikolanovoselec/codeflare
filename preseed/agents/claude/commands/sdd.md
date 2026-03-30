# Spec-Driven Development

Create a product specification from scratch through structured discovery. The output is an `sdd/` folder that serves as the single source of truth for all future development.

Uses the **spec-driven-development** skill for formatting rules and quality checks.

## Sub-Commands

| Command | Purpose |
|---------|---------|
| `/sdd` or `/sdd init` | Full guided spec creation (Steps 1-9) |
| `/sdd elicit {domain}` | Deep-dive requirements for a single domain |
| `/sdd check` | Validate spec quality across all domain files |
| `/sdd add {domain}` | Add a new domain to an existing spec |

## Instructions

**HARD GATE: No implementation during spec creation. This is a requirements exercise.**

---

### `/sdd init` — Full Spec Creation

#### Step 1: Product Vision

Ask the user to describe their product idea in plain language. Clarify:

1. **"What problem does this solve?"** — Not what it does, but why it should exist
2. **"Who is this for?"** — Target audience
3. **"What does success look like?"** — How do you know it's working?

Synthesize into a one-paragraph product vision. Present back and wait for confirmation.

#### Step 2: Actors

Identify who interacts with the product:

1. Ask: **"Who are the different types of users or systems that interact with this?"**
2. For each actor, capture: name, description, what they need
3. Include non-human actors if relevant (external APIs, background systems)

Present the actors table. Iterate until confirmed.

#### Step 3: User Journey

Map the core workflows:

1. Ask: **"Walk me through what a user does, step by step, from first visit to daily use."**
2. Ask: **"What's the critical workflow — the one thing that must work perfectly?"**
3. Ask: **"What happens when something goes wrong?"**

Listen for nouns and verbs. This is the raw material for domain discovery.

#### Step 4: Domain Discovery

From the journey, extract feature domains:

1. Group related nouns+verbs into 5-12 domains
2. Name each domain with a clear, one-line description
3. Identify obvious dependencies between domains
4. Present the domain list as a table

Iterate until the user confirms the domain decomposition.

#### Step 5: Principles

Now that the product shape is clear, propose 3-7 design principles:

- Non-negotiable values that guide every future decision
- Derived from what you've learned about the product, not generic platitudes
- Each principle should be actionable (helps make a real decision)

Present and iterate until confirmed.

#### Step 6: Requirements Elicitation

For each domain, work through requirements one domain at a time:

1. Ask: **"For {domain}, what must be true for it to work?"**
2. Probe for edge cases: **"What happens when {failure case}?"**
3. Probe for actors: **"Does this work differently for admins vs regular users?"**
4. Convert answers into numbered requirements (REQ-{DOMAIN}-{NNN}) with:
   - Intent (why)
   - Applies To (which actor)
   - Acceptance criteria (testable, binary pass/fail)
   - Constraints (guardrails + references to global constraints)
   - Priority (P0-P3)
   - Dependencies (if any)
   - Verification method
5. Mark all as `Status: Planned`
6. Present the domain file and iterate

If the conversation is getting long, stop after 3-4 domains and suggest the user continue with `/sdd elicit {domain}` for remaining domains.

#### Step 7: Cross-Cutting Constraints

Now consolidate constraints across all domains:

1. **Technology stack** — based on deployment target and requirements discovered
2. **Security constraints** (CON-SEC-*) — auth, encryption, input validation
3. **Performance constraints** (CON-PERF-*) — latency budgets, throughput
4. **Reliability constraints** (CON-REL-*) — recovery, data durability
5. **Boundaries** — what the product does NOT do (explicit exclusions)

Give each constraint an ID (CON-{CATEGORY}-{NNN}) so domain requirements can reference them.

#### Step 8: Validation

Before writing files, run a quality check:

- [ ] Every requirement has a clear actor
- [ ] Every acceptance criterion is binary (pass/fail)
- [ ] Priorities are assigned
- [ ] Dependencies between requirements are explicit
- [ ] Cross-cutting constraints are referenced (not duplicated)
- [ ] Out-of-scope is documented per domain and globally
- [ ] Unclear terms are defined in the glossary
- [ ] No duplicate requirements across domains
- [ ] Edge cases and failure modes are covered for P0 requirements

Present any gaps found and iterate.

#### Step 9: Write the Spec

Create the `sdd/` folder:

1. `sdd/README.md` — vision, principles, actors, domain index, out of scope, agent rules
2. `sdd/glossary.md` — canonical terms from all domains
3. `sdd/constraints.md` — technology stack, security/performance/reliability constraints, boundaries
4. `sdd/changes.md` — initial entry with creation date
5. `sdd/{domain}.md` — one file per domain with all requirements

Present the complete spec structure and wait for final approval.

After approval:

```
Spec complete. Next steps:
1. /sdd elicit {domain} — deep-dive any domain that needs more requirements
2. /sdd check — validate spec quality
3. /plan {domain} — plan implementation for a specific domain
4. Add new requirements to sdd/ as the product evolves
```

---

### `/sdd elicit {domain}` — Single Domain Deep-Dive

Focused requirements elicitation for one domain. Use when:
- The initial `/sdd init` was too broad for some domains
- Adding depth to a domain after initial spec creation
- The context window is limited and full spec creation would degrade quality

1. Read `sdd/README.md` for vision, principles, and actors
2. Read `sdd/constraints.md` for applicable global constraints
3. Read `sdd/glossary.md` for existing terms
4. Read `sdd/{domain}.md` if it exists (build on existing requirements)
5. Elicit requirements through conversation (same process as Step 6 above)
6. Write/update `sdd/{domain}.md`
7. Update `sdd/glossary.md` with any new terms
8. Add entry to `sdd/changes.md`

---

### `/sdd check` — Validate Spec Quality

Read all files in `sdd/` and verify:

1. **Completeness** — every domain in README index has a corresponding file
2. **Quality** — every requirement has ID, intent, actor, acceptance criteria, priority
3. **Consistency** — terms match glossary, constraint IDs exist in constraints.md
4. **Dependencies** — referenced requirements (REQ-*-*) exist in their domain files
5. **Coverage** — P0 requirements have failure-mode criteria, not just happy path
6. **No duplication** — same requirement doesn't appear in multiple domains

Report findings as a checklist. Suggest fixes for any issues found.

---

### `/sdd add {domain}` — Add New Domain

1. Read existing `sdd/README.md` for context
2. Ask the user what this domain covers
3. Elicit requirements (same process as `/sdd elicit`)
4. Create `sdd/{domain}.md`
5. Update `sdd/README.md` domain index
6. Update `sdd/glossary.md` with new terms
7. Add entry to `sdd/changes.md`

---

## Arguments

$ARGUMENTS: Sub-command and optional context (e.g., `/sdd`, `/sdd init a real-time collaboration tool`, `/sdd elicit authentication`, `/sdd check`, `/sdd add billing`)

## Tips

- Ask questions ONE AT A TIME. Never dump a wall of questions.
- Use AskUserQuestion with predefined options where possible.
- Start broad (vision, actors, journey) and narrow down (domains, requirements).
- If the user already has code, suggest reverse-engineering the spec first, then using `/sdd` for new features.
- Keep requirements at the "what" level. If the user describes implementation, redirect to intent.
- A good spec for a medium product has 50-100 requirements across 8-12 domains.
- For large products, use `/sdd init` for the skeleton then `/sdd elicit {domain}` per domain to manage context.
- When in doubt about a requirement, mark it as `Proposed` with an open question — don't guess.
