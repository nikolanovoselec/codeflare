---
name: spec-driven-development
description: Specification-driven development. Use when the user wants to create a product specification for a new project, define requirements, or establish a single source of truth for product development. Triggers on "spec", "specification", "requirements", "define the product", "what should it do", "write a spec", "SDD", "spec-driven".
version: 1.0.0
---

# Specification-Driven Development

Create and maintain a product specification that serves as the single source of truth for development. The spec captures **what** and **why** — not **how**. Implementation details emerge during planning from the spec combined with skills, rules, and architecture decisions.

## What a Spec Is

A spec is the contract between the product owner and the development process. It defines:

- **What** the product does (requirements with acceptance criteria)
- **Why** it exists (intent, problems solved)
- **Boundaries** (what it does NOT do)
- **Guardrails** (architectural and technology constraints)

A spec is NOT:

- Implementation documentation (file paths, function names, API shapes)
- A technical reference (that's `documentation/`)
- A tutorial or user guide
- A project plan or timeline

## Spec Structure

Every spec lives in a `spec/` folder at the project root:

```
spec/
├── README.md              # Product vision, principles, how to use this spec
├── {domain-1}.md          # Requirements for a feature domain
├── {domain-2}.md          # Requirements for another domain
├── ...
└── constraints.md         # Cross-cutting architectural and technology guardrails
```

### README.md — Product Vision

```markdown
# {Product Name} Specification

{One paragraph: what is this product, who is it for, what problem does it solve.}

## Principles

{3-7 non-negotiable design principles that guide every decision.}

## Domains

| Domain | Description | Status |
|--------|-------------|--------|
| [{name}]({name}.md) | {one-line description} | Active |

## How This Spec Works

1. New requirements are added to the relevant domain file
2. Each requirement has an ID, intent, acceptance criteria, and constraints
3. Implementation is planned from the spec (not the other way around)
4. After implementation, documentation is updated to reflect what was built
5. Tests verify the implementation satisfies the spec

## Out of Scope

{What this product deliberately does NOT do.}
```

### Domain Files — Requirements

Each domain file follows this structure:

```markdown
# {Domain Name}

{One paragraph: what this domain covers and why it exists.}

## {Feature Group}

### REQ-{DOMAIN}-{NNN}: {Short title}

**Intent:** {Why this requirement exists — the problem it solves, not the solution.}

**Acceptance Criteria:**
- [ ] {Testable criterion — specific, observable, binary pass/fail}
- [ ] {Another criterion}
- [ ] {Another criterion}

**Constraints:**
- {Architectural or technology guardrail specific to this requirement}

**Status:** Implemented | Planned | Proposed

---
```

### constraints.md — Cross-Cutting Guardrails

```markdown
# Constraints

Architectural and technology decisions that apply across all domains.

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| {layer} | {technology} | {why} |

## Non-Functional Requirements

### Performance
- {requirement}

### Security
- {requirement}

### Reliability
- {requirement}

## Boundaries

- {What the product does NOT do and why}
```

## Requirement Quality Rules

Every requirement MUST be:

1. **Testable** — an agent can write a test that verifies it
2. **Independent** — can be implemented without requiring other unfinished requirements
3. **Intentful** — states WHY, not just WHAT (intent survives implementation changes)
4. **Constrained** — includes guardrails that prevent wrong implementations
5. **Statused** — marked as Implemented, Planned, or Proposed

Bad: "Support multiple agents"
Good: "REQ-AGENT-001: A user can select from any supported agent at session creation, and the container starts with that agent's CLI pre-configured and ready to use."

Bad: "Be secure"
Good: "REQ-SEC-001: All authenticated API endpoints reject requests without a valid session credential. Unauthenticated requests receive 401 or 302, never a data response."

## Domain Discovery

When creating a spec for a new project, identify domains by asking:

1. What are the nouns in the product? (users, sessions, files, payments)
2. What are the verbs? (create, upload, subscribe, deploy)
3. Group related nouns+verbs into domains
4. Each domain should have 5-20 requirements (split if larger, merge if smaller)

## Workflow Integration

```
Spec (what + why + guardrails)
  ↓ /plan + skills + rules
Implementation (code)
  ↓ doc-updater agent
Documentation (how it works)
  ↓ tests
Verification (does it match the spec?)
```

The spec is the starting point. Changes flow downstream:
1. Add/modify requirement in spec
2. Plan implementation (`/plan`)
3. Implement with TDD
4. Update documentation
5. Tests verify acceptance criteria

Changes never flow upstream silently — if implementation reveals the spec needs updating, update the spec explicitly.
