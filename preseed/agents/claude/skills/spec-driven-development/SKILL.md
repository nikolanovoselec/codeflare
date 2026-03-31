---
name: spec-driven-development
description: Specification-driven development reference. This skill defines the structure and rules for product specifications. It is NOT auto-triggered — it is only used when explicitly invoked via the /sdd command.
version: 3.0.0
---

# Specification-Driven Development

A product specification is the single source of truth for development. It captures **what** the product does and **why** — not how. The agent's job is to take a rough idea from the user and turn it into a structured, complete specification through conversation.

## How It Works

The user describes what they want in plain language — a sentence, a paragraph, a vague idea. The agent:

1. Proposes a product vision and asks if it captures the intent
2. Identifies actors, domains, and requirements from the description
3. Drafts everything and presents it for confirmation
4. Asks targeted questions to fill gaps — always proposing answers, never asking open-ended questions without suggestions
5. Writes the `sdd/` folder when the user is satisfied

The user's job is to say yes, no, or "more like this." The agent does the work.

## Spec Structure

```
sdd/
├── README.md              # Vision, principles, actors, domain index, out of scope
├── glossary.md            # Canonical terms
├── constraints.md         # Technology stack, cross-cutting guardrails (CON-* IDs)
├── changes.md             # Semantic changelog
└── {domain}.md            # Requirements per feature area
```

## Requirement Format

```markdown
### REQ-{DOMAIN}-{NNN}: {Title}

**Intent:** {Why this exists — the problem, not the solution.}

**Applies To:** {Actor — User, Admin, System, etc.}

**Acceptance Criteria:**
- [ ] {Testable, binary pass/fail}

**Constraints:**
- {Guardrails, including CON-* references where applicable}

**Priority:** P0 | P1 | P2 | P3
**Dependencies:** REQ-*-* | None
**Verification:** Automated test | Integration test | Manual check
**Status:** Planned | Implemented | Proposed
```

## Domain File Structure

```markdown
# {Domain Name}

{What this domain covers and why.}

## Key Concepts
{Domain-specific terms or glossary references.}

## Out of Scope
{What this domain does NOT cover.}

## Domain Dependencies
{Other domains this depends on.}

## Requirements
{REQ-{DOMAIN}-NNN entries}
```

## Constraint Format

Constraints have IDs so requirements can reference them:

```markdown
### CON-SEC-001: {Title}
{Description.}
**Applies To:** {All endpoints | User-facing | etc.}
```

## Quality Rules

- Every requirement must be testable (an agent can write a test for it)
- Every acceptance criterion must be binary (pass or fail, no "should be good")
- Intent explains WHY, not WHAT — the intent survives even if the implementation changes completely
- Priorities: P0 (must have), P1 (important), P2 (valuable), P3 (nice to have)
- A requirement is Implemented only when acceptance criteria are verified and constraints satisfied

## The Spec Lives Forever

The spec is the single source of truth for the entire product. It is never thrown away, never "completed." Every new idea gets added to the existing spec — new requirements in existing domains or new domains entirely. The spec grows with the product.

## Workflow

```
User idea (prose)
  ↓ /sdd or /sdd edit {domain} — add to spec
Spec updated (new/modified requirements marked Planned)
  ↓ /plan — plan ONLY the new/changed requirements
Implementation plan (targets only what's new)
  ↓ TDD: write tests first, then implement
Code + Tests
  ↓ doc-updater — update documentation
Documentation updated
  ↓ mark requirements as Implemented in spec
Spec updated (Status: Implemented)
```

### Critical Rules

1. **New ideas always go into the spec first.** Never implement without a spec entry.
2. **Planning targets only new/changed requirements.** When transitioning from spec to `/plan`, the plan covers ONLY requirements with `Status: Planned` or `Status: Proposed` — not the entire spec. The existing Implemented requirements are the foundation the new work builds on.
3. **Test-driven development is mandatory.** Every plan must include tests written BEFORE implementation. Tests are derived from acceptance criteria in the spec.
4. **Documentation updates are mandatory.** Every implementation must update the relevant documentation in `documentation/`. The doc-updater agent enforces this.
5. **Status flows one way:** Proposed → Planned → Implemented. Moving backward requires an explicit spec change with a changelog entry.
6. **The spec is never deleted.** When a feature is removed, the requirement is marked `Deprecated` with a reason — not deleted. History matters.
