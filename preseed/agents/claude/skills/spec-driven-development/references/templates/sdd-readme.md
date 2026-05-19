# {PROJECT_NAME} — Product Specification

## Vision

{ONE_PARAGRAPH_VISION_OF_WHAT_THE_PRODUCT_IS_AND_WHO_ITS_FOR}

## Actors

| Actor | Description |
|-------|-------------|
| **{ACTOR_1}** | {Description of who they are and what they want} |
| **{ACTOR_2}** | {Description} |

## Design Principles

1. **{PRINCIPLE_1}** — {explanation specific to this product, not generic}
2. **{PRINCIPLE_2}** — {explanation}
3. **{PRINCIPLE_3}** — {explanation}

## Domains

| # | Domain | File | Priority | Description |
|---|--------|------|----------|-------------|
| 1 | {Domain Name} | [{file}.md]({file}.md) | P0 | {What this domain covers} |
| 2 | {Domain Name} | [{file}.md]({file}.md) | P0 | {Description} |

## Out of Scope

The following were considered and intentionally excluded from the product:

- **{Idea Title}** — {One-sentence reason it was excluded}

## Constraints

See [constraints.md](constraints.md) for cross-cutting guardrails.

## Glossary

See [glossary.md](glossary.md) for canonical term definitions.

## Documentation

Implementation documentation lives in `documentation/`:
- `architecture.md` — System overview, components, data flow
- `api-reference.md` — All API endpoints
- `configuration.md` — Env vars, secrets, deployment config
- `deployment.md` — Dev setup and deployment steps
- `decisions/README.md` — Architecture Decision Records

## Changelog

See [changes.md](changes.md) for specification history.
