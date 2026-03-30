# Spec-Driven Development

Turn a rough product idea into a structured specification. The user describes what they want — you do the heavy lifting.

## Sub-Commands

| Command | Purpose |
|---------|---------|
| `/sdd` or `/sdd init` | Create a new spec from a product idea |
| `/sdd edit {domain}` | Add or modify requirements in a domain |
| `/sdd check` | Validate spec quality |
| `/sdd add {domain}` | Add a new domain to an existing spec |

## Core Principle

**You propose, the user confirms.** Never ask an open-ended question without suggesting an answer. Draft everything — vision, domains, requirements, constraints — and present it for the user to accept, reject, or tweak.

**HARD GATE: No implementation during spec creation.**

---

## `/sdd init` — Create a New Spec

### What the user gives you

A rough idea. Could be one sentence ("I want a task manager for teams") or a paragraph. Could be vague ("something like Notion but simpler") or specific. Take whatever you get.

### What you do

**1. Draft the vision.** From the user's description, write a one-paragraph product vision. Include who it's for and what problem it solves. Present it:

> "Here's what I think you're describing: [vision]. Is that right, or should I adjust?"

**2. Propose actors.** From the vision, identify who interacts with the product (users, admins, external systems). Present a table:

> "I see these actors: [table]. Anyone missing?"

**3. Map the user journey.** Ask ONE question:

> "Walk me through what happens from the moment someone first opens this until they're using it daily."

From the answer, extract nouns and verbs. If the user is brief, propose a journey yourself and ask if it's right.

**4. Propose domains.** Group the journey into 5-12 feature domains. Present as a table with descriptions and priorities:

> "I'd break this into these domains: [table]. Want to add, remove, or rename any?"

**5. Propose principles.** Based on everything so far, draft 3-7 design principles. These should be specific to this product, not generic. Present them:

> "These principles would guide every decision: [list]. Anything to change?"

**6. Draft requirements.** For each domain, draft 5-15 requirements with full format (Intent, Applies To, Acceptance Criteria, Constraints, Priority, Dependencies, Verification, Status: Planned). Present one domain at a time:

> "Here's what I think {domain} needs: [requirements]. What's missing? What's wrong?"

For each requirement, actively propose edge cases and failure modes:

> "What should happen if [failure case]? I'd suggest [proposed behavior]."

**7. Draft constraints.** Propose the technology stack (based on what you know about the user's deployment target), security/performance/reliability guardrails, and boundaries. Give each constraint a CON-* ID:

> "Here are the guardrails I'd set: [constraints]. Anything too strict or too loose?"

**8. Write the spec.** Create `sdd/` with all files. Add glossary terms, changelog entry, and out-of-scope sections.

Present the final structure and wait for approval.

### Tips for the agent

- **Infer aggressively.** If the user says "a blog," you know it needs posts, authors, comments, tags, admin panel, RSS feed. Propose all of it — let them cut what they don't want.
- **Propose, don't interrogate.** Bad: "What authentication do you need?" Good: "I'd use email/password with optional OAuth. Sound right?"
- **Name the actors early.** Every requirement should say who it applies to.
- **P0 first.** Draft the core workflow as P0, admin/config as P1, polish as P2, stretch as P3.
- **Failure modes matter.** For every P0 requirement, ask yourself "what happens when this fails?" and include a criterion for it.
- **One question at a time.** Never dump multiple questions. Present a proposal and ask one thing.

---

## `/sdd edit {domain}` — Edit a Domain

Add or modify requirements in an existing domain:

1. Read `sdd/README.md`, `sdd/constraints.md`, `sdd/glossary.md` for context
2. Read `sdd/{domain}.md` for existing requirements
3. Ask the user what they want to add or change
4. Draft new/modified requirements and present for confirmation
5. Write the updated domain file
6. Update glossary and changelog

---

## `/sdd check` — Validate Spec

Read all `sdd/` files and verify:

1. Every domain in README index has a file
2. Every requirement has all fields (ID, Intent, Applies To, AC, Constraints, Priority, Dependencies, Verification, Status)
3. All acceptance criteria are binary pass/fail
4. Constraint IDs (CON-*) exist in constraints.md
5. Cross-requirement references (REQ-*-*) resolve
6. P0 requirements cover failure modes
7. Each domain has Key Concepts, Out of Scope, Domain Dependencies
8. README has Actors table
9. Glossary covers key terms used across domains
10. No duplicate requirements across domains

Report pass/fail per check with specific issues.

---

## `/sdd add {domain}` — Add New Domain

1. Read existing spec for context
2. Ask the user what this domain covers
3. Draft requirements (same process as init step 6)
4. Create `sdd/{domain}.md`
5. Update README index, glossary, changelog

---

## Transitioning to Implementation

When the user is ready to implement, they use `/plan`. The agent MUST:

1. **Read the spec first.** Load `sdd/README.md` and the relevant domain file(s).
2. **Plan ONLY new work.** Filter for `Status: Planned` or `Status: Proposed` requirements. Never re-plan Implemented requirements — they're the existing foundation.
3. **Enforce TDD.** The plan must include writing tests BEFORE implementation. Tests are derived directly from acceptance criteria in the spec.
4. **Require documentation updates.** Every plan must include a step to update `documentation/` for any user-visible changes.
5. **After implementation:** mark requirements as `Status: Implemented` in the spec, add a changelog entry to `sdd/changes.md`.

The spec is never "done." It grows with the product. Every new idea starts here.

---

## Arguments

$ARGUMENTS: Sub-command and context. Examples:
- `/sdd` — start from scratch
- `/sdd init a marketplace for handmade crafts`
- `/sdd edit authentication` — add/modify requirements in existing domain
- `/sdd check` — validate spec quality
- `/sdd add notifications` — add a new domain
