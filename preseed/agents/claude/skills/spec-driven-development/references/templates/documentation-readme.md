# {PROJECT_NAME} Documentation

This index routes readers to the canonical owner for each operational concern. Lane files are emitted only when source evidence justifies them.

## Jump-TOC

- [Lane ownership](#lane-ownership)
- [REQ backlinks](#req-backlinks)
- [Synonym glossary](#synonym-glossary)
- [Reading order for a new contributor](#reading-order-for-a-new-contributor)
- [Related](#related)

## Lane ownership

| Lane | Owns |
|---|---|
{LANE_INDEX_ROWS}
| [Decisions](decisions/README.md) | Trade-offs, alternatives, consequences, and supersession history |

A lane may summarize an adjacent boundary, but it links to the canonical owner instead of repeating the behavioral narrative. First-level project lanes are allowed when indexed above and backed by a concern that no canonical lane owns.

## REQ backlinks

Every load-bearing behavior links to its governing requirement. Grouped registers use an `Implements` or `Requirements` column; prose sections place the link beside the claim.

## Synonym glossary

| Canonical term | Synonyms | Definition owner |
|---|---|---|
| {TERM} | {ALIASES} | [Specification glossary](../sdd/spec/glossary.md) |

## Reading order for a new contributor

1. Read Architecture for topology, ownership, authority, and recovery boundaries.
2. Read the lane that owns the surface being changed.
3. Follow requirement and decision links before changing behavior.
4. Use Deployment and Troubleshooting for procedures rather than reconstructing commands from source.

## Related

- [Specification](../sdd/README.md)
- [Architecture decisions](decisions/README.md)
- [Project README](../README.md)
