<!-- doc-discipline: never delete entries (replace with Status: Reclassified or Status: Merged into AD-X stubs); one ADR per architectural decision; each ADR Context block carries an inline @impl source-anchor -->

# Architecture Decision Records

Decisions made during implementation, with rationale.

**Audience:** Developers

Each ADR documents a non-obvious design choice and the trade-offs considered. The decision log is load-bearing: a future contributor about to revert a change should find the prior reasoning here.

## What is NOT an ADR

ADRs document choices between **real alternatives** where the chosen path has consequences a future reader needs to understand to avoid undoing it. Four shapes regularly drift INTO the ADR set but belong elsewhere:

| Shape | Belongs in |
|---|---|
| Static-analyzer false positive accepted with context | Inline source-code comment (`// SAST-false-positive: ...`) + one-line note in `documentation/[lanes/]troubleshooting.md` if the pattern recurs |
| Naming/spelling preserved for backward compatibility | One-line note in `documentation/[lanes/]configuration.md` next to the variable |
| Risk acceptance with no alternative considered | Inline source-code comment OR `documentation/[lanes/]security.md` "trust model" section |
| Implementation note framed as a decision | Delete or move to `pending.md` |

The single test: **did we choose between real alternatives, AND would a future reader need to understand the choice to avoid undoing it?** If either half is no, it is not an ADR. The full rule and detection signals live in `~/.claude/rules/documentation-discipline.md` ("What is NOT an ADR") and run as `doc-updater` Pass 5 on every push.

When an existing ADR is reclassified to a canonical home, preserve its `### AD-N:` heading as a `Status: Reclassified on YYYY-MM-DD` stub so inbound `AD-N` references in the codebase keep resolving. Same shape applies to merged ADRs (`Status: Merged into AD-X`). Never delete entries outright — content is moved, anchors stay.

---

## Decision Index

| ID | Decision | Category | Date |
|----|----------|----------|------|
| AD1 | {First decision title} | Architecture / Security / Storage / Billing / UI | YYYY-MM-DD |

---

### AD1: {First decision title}

**Status:** Accepted (YYYY-MM-DD)

**Decision:** {What was decided in one sentence.}

**Context:** {What prompted the decision. What problem or constraint was being addressed?} <!-- @impl: <path>::<symbol> -->

**Alternatives considered:** {Brief list of other options that were rejected. ADRs require real alternatives — if none, this is not an ADR (see "What is NOT an ADR" above).}

**Rationale:** {Why this choice over the alternatives. Trade-offs accepted.}

**Consequences:** {What downstream code/docs must keep in lockstep.}

**Related requirements:** [REQ-X-N](../../sdd/spec/{domain}.md#req-x-n)

---
