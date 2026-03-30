---
name: spec-driven-development
description: Specification-driven development. Use when the user wants to create a product specification for a new project, define requirements, or establish a single source of truth for product development. Triggers on "spec", "specification", "requirements", "define the product", "what should it do", "write a spec", "SDD", "spec-driven".
version: 2.0.0
---

# Specification-Driven Development

Create and maintain a product specification that serves as the single source of truth for development. The spec captures **what** and **why** — not **how**. Implementation details emerge during planning from the spec combined with skills, rules, and architecture decisions.

## What a Spec Is

A spec is the contract between the product owner and the development process:

- **What** the product does (requirements with acceptance criteria)
- **Why** it exists (intent, problems solved)
- **Who** it serves (actors with distinct needs)
- **Boundaries** (what it does NOT do)
- **Guardrails** (architectural and technology constraints)

A spec is NOT:

- Implementation documentation (file paths, function names, API shapes)
- A technical reference (that's `documentation/`)
- A tutorial or user guide
- A project plan or timeline
- An architecture decision record (those are separate, cross-linked)

## Spec Structure

Every spec lives in an `sdd/` folder at the project root:

```
sdd/
├── README.md              # Product vision, principles, actors, domain index
├── glossary.md            # Canonical terms and domain concepts
├── constraints.md         # Cross-cutting guardrails with IDs (CON-*)
├── changes.md             # Semantic spec changelog
├── {domain-1}.md          # Requirements for a feature domain
├── {domain-2}.md          # Requirements for another domain
└── ...
```

### README.md — Product Vision

```markdown
# {Product Name} Specification

{One paragraph: what is this product, who is it for, what problem does it solve.}

## Principles

{3-7 non-negotiable design principles that guide every decision.}

## Actors

| Actor | Description |
|-------|-------------|
| {name} | {who they are, what they need} |

## Domains

| Domain | Description | Priority | Status |
|--------|-------------|----------|--------|
| [{name}]({name}.md) | {one-line description} | P0 | Active |

## Out of Scope

{What this product deliberately does NOT do.}

## How This Spec Works

1. New requirements are added to the relevant domain file
2. Each requirement has an ID, intent, acceptance criteria, and constraints
3. Implementation is planned from the spec (`/plan`) — never the other way around
4. After implementation, documentation is updated to reflect what was built
5. Tests verify the implementation satisfies the spec
6. If implementation reveals the spec needs updating, update the spec explicitly

## Agent Operating Rules

- Never implement a requirement not present in `sdd/` unless explicitly instructed
- If code and spec conflict, raise issue and propose spec update
- Do not mark a requirement Implemented without verification evidence
- Constraints override local convenience
- Always read `sdd/constraints.md` alongside the target domain when planning
```

### Domain Files — Requirements

Each domain file follows this structure:

```markdown
# {Domain Name}

{One paragraph: what this domain covers and why it exists.}

## Key Concepts

{Define domain-specific terms — or reference glossary.md entries.}

## Out of Scope

{What this domain deliberately does NOT cover.}

## Domain Dependencies

{Which other domains this depends on, if any.}

## {Feature Group}

### REQ-{DOMAIN}-{NNN}: {Short title}

**Intent:** {Why this requirement exists — the problem it solves, not the solution.}

**Applies To:** {Actor from README — e.g., User, Admin, System}

**Acceptance Criteria:**
- [ ] {Testable criterion — specific, observable, binary pass/fail}
- [ ] {Another criterion}

**Constraints:**
- {Architectural or technology guardrail specific to this requirement}
- Must comply with CON-SEC-001
- {Reference applicable global constraints by ID}

**Priority:** P0 | P1 | P2 | P3
**Dependencies:** REQ-OTHER-NNN (if any) | None
**Verification:** Automated test | Integration test | Manual check
**Status:** Implemented | Planned | Proposed

---
```

### constraints.md — Cross-Cutting Guardrails

```markdown
# Constraints

Architectural and technology decisions that apply across all domains. Each constraint has an ID for reference from domain requirements.

## Technology Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| {layer} | {technology} | {why} |

## Security Constraints

### CON-SEC-001: {Title}
{Description of the constraint.}
**Applies To:** {All API endpoints | User-facing surfaces | etc.}

## Performance Constraints

### CON-PERF-001: {Title}
{Description.}

## Reliability Constraints

### CON-REL-001: {Title}
{Description.}

## Boundaries

- {What the product does NOT do and why}
```

### glossary.md — Canonical Terms

```markdown
# Glossary

Canonical definitions for domain concepts. Use these terms consistently across all spec files, implementation, and documentation.

| Term | Definition |
|------|-----------|
| {term} | {precise definition} |
```

### changes.md — Spec Changelog

```markdown
# Spec Changes

Semantic changes to the specification. Git history captures diffs; this file captures intent.

## {Date}
- Added REQ-AUTH-004: Session expiration handling
- Updated REQ-API-002 acceptance criteria (added 429 on rate limit)
- Deferred billing domain from P1 to P2 — Stripe integration postponed
```

## Requirement Quality Rules

Every requirement MUST be:

1. **Testable** — an agent can write a test that verifies it
2. **Independent** — as independent as practical; when dependencies exist, they must be explicit
3. **Intentful** — states WHY, not just WHAT (intent survives implementation changes)
4. **Constrained** — references applicable global constraints by ID
5. **Prioritized** — P0 (critical), P1 (important), P2 (valuable), P3 (stretch)
6. **Actor-scoped** — names who it applies to

**Bad:** "Support multiple agents"
**Good:** "REQ-AGENT-001: A user can select from any supported agent at session creation, and the container starts with that agent's CLI pre-configured and ready to use."

**Bad:** "Be secure"
**Good:** "REQ-SEC-001: All authenticated API endpoints reject requests without a valid session credential. Unauthenticated requests receive 401 or 302, never a data response."

## Definition of Done

A requirement can be marked `Implemented` only when:
- All acceptance criteria are covered by tests or explicit verification evidence
- All referenced constraints (CON-*) are satisfied
- Documentation is updated if user-visible behavior changed
- No known critical gaps remain

## Priority Model

| Level | Meaning | When to implement |
|-------|---------|-------------------|
| P0 | Critical — product doesn't work without it | MVP / first |
| P1 | Important — core experience depends on it | Near-term |
| P2 | Valuable — improves product meaningfully | After core is solid |
| P3 | Stretch — nice to have | When time allows |

## Domain Discovery

When creating a spec for a new project:

1. Define actors first — who uses this?
2. Walk through the user journey — first visit to daily use
3. Identify nouns (users, sessions, files) and verbs (create, upload, subscribe)
4. Group related nouns+verbs into domains
5. Each domain should have 5-20 requirements (split if larger, merge if smaller)

## Relationship to Architecture Decisions

The spec defines the **problem space** (what/why). Architecture decisions define the **solution space** (how/trade-offs).

- Spec lives in `sdd/`
- ADRs live separately (e.g., `documentation/decisions/`)
- `sdd/constraints.md` bridges the two — it contains stable product guardrails
- ADRs reference requirement IDs they satisfy
- Plans reference both spec requirements and applicable ADRs

Rule of thumb: put it in `constraints.md` only if violating it would mean building the wrong product. If it's a current technical choice that could change, it belongs in an ADR.

## Traceability

Connect spec → plan → code → tests → docs:

- Implementation plans reference requirement IDs: `Implements: REQ-AUTH-001, REQ-AUTH-003`
- Tests reference requirements in names/comments
- Documentation updates link to implemented requirements
- Commit messages reference requirement IDs when implementing spec items

## Workflow Integration

```
Spec (what + why + guardrails)
  ↓ /plan + skills + rules + ADRs
Implementation (code + tests)
  ↓ doc-updater agent
Documentation (how it works)
  ↓ verification
Does it match the spec?
```
