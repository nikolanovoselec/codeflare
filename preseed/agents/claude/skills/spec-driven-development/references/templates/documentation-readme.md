# {PROJECT_NAME} Documentation

This index routes readers to the canonical owner for each operational concern. Lane files are emitted only when source evidence justifies them.

## Jump-TOC

- [Lane ownership](#lane-ownership)
- [Specification coverage](#specification-coverage)
- [REQ backlinks](#req-backlinks)
- [Synonym glossary](#synonym-glossary)
- [Reading order for a new contributor](#reading-order-for-a-new-contributor)
- [Related](#related)

## Lane ownership

| Lane | Owns |
|---|---|
{LANE_INDEX_ROWS}

Render lane rows alphabetically by visible title (case-insensitive; path breaks ties). The [decision ledger](decisions/README.md) owns trade-offs, alternatives, consequences and supersession—not execution reports.

A lane may summarize an adjacent boundary, but links to its canonical owner instead of duplicating it. Indexed project lanes are allowed for a concern no existing owner covers.

## Specification coverage

| Specification domain | Documentation owner(s) |
|---|---|
{SPEC_DOMAIN_COVERAGE_ROWS}

Include every concrete REQ-bearing domain, alphabetically by visible title. Link real indexed owners with usable guidance and REQ backlinks; shared owners are allowed. A spec link alone is not documentation. If behavior is genuinely unimplemented, record the exact coverage gap rather than inventing current behavior or deleting the requirement to clear the check.

## REQ backlinks

Every load-bearing behavior links to its governing requirement. Grouped registers use an `Implements` or `Requirements` column; prose places the link beside the claim. Named manual checks contain concrete actions and observable pass/fail outcomes. Documentation describes current operation and durable limitations, not session, commit, CI-run, experiment or deployment-campaign history; retain such receipts in their existing Git/PR/CI/Vault records without dropping current safety or acceptance conditions.

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
