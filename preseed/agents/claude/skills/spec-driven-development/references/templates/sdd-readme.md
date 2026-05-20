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
| 1 | {Domain Name} | [spec/{file}.md](spec/{file}.md) | P0 | {What this domain covers} |
| 2 | {Domain Name} | [spec/{file}.md](spec/{file}.md) | P0 | {Description} |

## Out of Scope

The following were considered and intentionally excluded from the product:

- **{Idea Title}** — {One-sentence reason it was excluded}

## Constraints

See [spec/constraints.md](spec/constraints.md) for cross-cutting guardrails.

## Glossary

See [spec/glossary.md](spec/glossary.md) for canonical term definitions.

## Documentation

Implementation documentation lives in [`documentation/`](../documentation/README.md). Lane files emit only when source evidence justifies them; `documentation/lanes/architecture.md` is always present.

## Changelog

See [spec/changes.md](spec/changes.md) for specification history.
