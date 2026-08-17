<!-- doc-discipline: never delete entries; superseded index entries are struck through; reclassified/merged entries become explicit Redirect anchor stubs; one ADR per architectural decision; each ADR Context block carries an inline @impl source-anchor -->

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

The single test: **did we choose between real alternatives, AND would a future reader need to understand the choice to avoid undoing it?** If either half is no, it is not an ADR. Runtime-neutral classification and reclassification rules live in `doc-enforce-lanes` under `Dual-narrative ADRs` and run during documentation lane enforcement.

When an existing ADR is reclassified to a canonical home, preserve its numbered heading as a `Status: Reclassified on YYYY-MM-DD` stub so inbound references keep resolving. The same rule applies to merged ADRs. Label both as `Redirect anchor` and link the destination; never use unexplained `(redirect)` or `(redirected)` shorthand.

State rendering is explicit:

- **Active:** normal index row.
- **Superseded:** strike through both the linked ID and decision cells, set State to `Superseded`, link the successor, and retain the complete historical section.
- **Partially superseded:** keep the row unstruck, set State to `Partially superseded`, and name only the replaced clause plus successor.
- **Redirect anchor:** keep the row unstruck, set State to `Redirect anchor`, and link the merged or reclassified destination.

Index rows are self-contained: `Decision` is a label of at most 90 rendered characters; `Summary` is one sentence of 40–180 rendered characters. Active summaries name the concrete subject and choice plus a specific driver or consequence supported by the ADR body. Superseded, partial, and redirect summaries name and link their successor, retained scope, or destination. Summaries never merely repeat the label or begin with an unexplained pronoun.

---

## Decision Index

| ID | Decision | Summary | Category | State |
|----|----------|---------|----------|-------|
| [{DECISION_ID}](#{DECISION_SLUG}) | {DECISION_LABEL} | {DECISION_SUMMARY} | {DECISION_CATEGORY} | Active |

---

### {DECISION_ID}: {DECISION_TITLE}

**Status:** Accepted (YYYY-MM-DD)

**Decision:** {DECISION}

**Context:** {CONTEXT} <!-- @impl: <path>::<symbol> -->

**Alternatives considered:** {ALTERNATIVES}

**Rationale:** {RATIONALE}

**Consequences:** {CONSEQUENCES}

**Related requirements:** {REQUIREMENT_LINK}

---
