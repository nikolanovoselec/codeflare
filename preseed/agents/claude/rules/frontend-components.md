# Frontend Components — Build It Composable, Test the Behavior

Mandatory standards for any UI with repeated structure. Exists because a landing
page once shipped as one ~770-line file of duplicated markup tested by copy-string
matching, so every fix was fifteen edits. Never build that again.

**Trigger:**
- Building or refactoring a page/section/widget where any pattern appears > twice.
- You catch yourself copy-pasting markup, tuning the same value in several places,
  or about to write `expect(html).toContain('<some copy>')` in a test.
- Any landing page, marketing site, dashboard, or component-library work.

**Route:** invoke the `frontend-components` skill for the full standard. The spine:

1. **Extract, don't duplicate.** A structure used > twice is one component. Pages
   are pure composition. To change X everywhere you edit exactly one place.
2. **Separate** structure (components) / content (a typed data module) / style
   (design tokens + one stylesheet convention). Components carry no copy, no magic
   numbers.
3. **Control centrally.** Every size/colour/space/motion is a token; retuning is a
   one-line edit that propagates.
4. **Refactor by extracting, not changing.** Preserve behavior (emit the same DOM /
   classes); a structural test is the migration oracle.
5. **Behavioral tests only.** No `toContain('<copy>')` theater. Assert structure,
   counts, slot routing, variant classes, DOM mutations under fake timers, and
   contract values (hrefs, parsed JSON, hidden defaults). Gut-check: if I gut the
   implementation, does the test fail?
6. **Done bar:** responsive at every breakpoint, reduced-motion alternative,
   content visible by default (never gated on a JS reveal class), a11y + contrast.

Skipping this when building multi-instance UI is how unmaintainable frontends get
built. See also [[karpathy]] (simplicity), [[tdd-discipline]] (test antipatterns).
