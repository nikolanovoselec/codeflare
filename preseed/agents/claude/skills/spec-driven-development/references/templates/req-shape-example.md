<!-- doc-discipline: copy-fixture, not a real domain file. Agent copies the
     SHAPE of a single REQ block from here. The full skill manifest lives in
     spec-driven-development § "REQ format" and spec-enforce § "REQ rendering
     template"; this file is the literal exemplar so the agent does not
     re-derive the shape from prose. -->

# Example Domain

One-paragraph domain summary — what this slice of behaviour covers and why it exists. No edit history, no dates, no "this file was extracted from..." lines (those go in `sdd/spec/changes.md`).

## REQ-EXAMPLE-001: One-line title in sentence case

**Intent:** One paragraph, 1-4 sentences, plain prose. No bullets, no headings, no code blocks. Describes WHAT the system does and WHY a user cares. Stays focused on observable behaviour; mechanism detail moves to `documentation/`.

**Applies To:** User

**Acceptance Criteria:**

1. First observable behaviour, single sentence, <=150 words. Describes what is true after the system runs. <!-- @impl: lib/services/example_service.dart::doThing -->
2. Second behaviour asserting a concrete value. Use the `= <value-pattern>` form on the anchor so the value-drift check can resolve. <!-- @impl: lib/services/example_service.dart::doThing = 3 -->
3. Up to 7 ACs maximum, numbered (`1.`, `2.`, ...), never bulleted (`-`). <!-- @impl: lib/services/example_service.dart::doThing -->

**Constraints:** [CON-EXAMPLE-001](constraints.md#con-example-001-title-slug), [CON-SEC-001](constraints.md#con-sec-001-title-slug)

**Priority:** P1

**Dependencies:** [REQ-OTHER-001](other-domain.md#req-other-001-title-slug)

**Verification:** Automated test

**Status:** Implemented

---

## REQ-EXAMPLE-002: Second REQ shows the empty-field rendering

**Intent:** A REQ with no constraints and no dependencies still has both fields present. The literal token `None.` renders for each empty field. Omitting either field entirely is a MEDIUM `req-missing-required-field` finding.

**Applies To:** User

**Acceptance Criteria:**

1. The single AC describes one behaviour. <!-- @impl: lib/services/example_service.dart::otherThing -->

**Constraints:** None.

**Priority:** P2

**Dependencies:** None.

**Verification:** Manual check

**Status:** Partial

**Notes:** Status is `Partial` because the UI affordance exists but the server endpoint is not yet wired. See [pending.md](../../../pending.md).

---

<!--
  Shape rules pinned by this fixture (deviation is a MEDIUM auto-fix in
  spec-enforce row 3):

  1. REQ heading is H3 (`### REQ-{DOMAIN}-{NNN}: {Title}`), never H2.
  2. Field order is LOCKED: Intent -> Applies To -> Acceptance Criteria
     -> Notes (optional) -> Constraints -> Priority -> Dependencies
     -> Verification -> Status. Status is ALWAYS the last field.
  3. One blank line between every `**Field:**` line. Two label lines on
     consecutive lines collapse on GitHub render.
  4. ACs are numbered (`1.`, `2.`, `3.`), never bulleted (`-`).
  5. Constraints and Dependencies ALWAYS present; render `None.` (literal,
     with trailing period) when empty.
  6. CON-* and REQ-* references inside Constraints/Dependencies render as
     markdown anchor links, never plain text.
  7. Every AC describing observable behaviour ends with
     `<!-- @impl: <path>::<symbol> -->`. ACs asserting a concrete value
     use `<!-- @impl: <path>::<symbol> = <value-pattern> -->`.
  8. Applies To, Priority, and Verification are REQUIRED on every REQ.
  9. Each REQ ends with `---` on its own line, blank lines either side.
 10. Notes is OPTIONAL and uses one of two shapes only:
     (a) Partial-explanation: Status=Partial only, <=3 sentences,
         explains what is unmet. No mechanism tokens (file paths,
         function names, env vars, commit SHAs) - those go in
         pending.md or documentation/.
     (b) Doc-pointer: any status, <=2 sentences, MUST contain a
         markdown link to documentation/** or sdd/**. Prose pattern
         "X is documented at [link]".
     Sibling-REQ cross-references go in Dependencies, not Notes.
 11. Maximum 7 ACs per REQ. A REQ that grows past 7 splits along a
     concern boundary into a sibling REQ (mechanics in spec-enforce-ac).
 12. Banned inside a REQ body (Intent or any AC): sub-headings
     (####/#####), nested lists, code blocks (```), tables,
     strikethrough, block quotes, and "Current behaviour:" /
     "Previously:" branches. These belong in documentation/, not in
     the spec. Their presence is MEDIUM `req-body-forbidden-content`.
-->
