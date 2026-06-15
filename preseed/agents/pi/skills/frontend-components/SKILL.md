---
name: frontend-components
description: Mandatory coding standards for building and refactoring any UI that has repeated structure — landing pages, marketing sites, dashboards, component libraries, any page where a pattern appears more than twice. Use BEFORE writing a new page/section/widget, and ALWAYS when you notice yourself copy-pasting markup, tuning the same thing in several places, or about to assert `toContain('some copy')` in a test. Enforces extract-don't-duplicate, central control (tokens + content data), behavior-preserving refactors, and behavioral-only tests (no string-matching theater). Framework-agnostic (Astro, React, Svelte, Vue, plain HTML).
---

# Frontend Components: Build It Composable, Control It Centrally, Test the Behavior

The standard that exists because a landing page got built as one ~770-line file of
hand-duplicated markup, tested by matching copy strings — so the same defect
appeared in fifteen places and every "fix" was fifteen edits. **Never again.**

## The Prime Directive

Every repeated piece of UI is a **component**. Every value you'd tune more than
once (size, colour, spacing, motion, copy) lives in **one central place**. Every
test asserts **behavior or structure**, never the presence of a copy string.

If you cannot say *"to change X everywhere, I edit exactly one place,"* you are not
done.

## 1. Extract, don't duplicate (the rule of N)

- A structure that appears **more than twice** is a component. No exceptions for
  "it's just markup." Copy-paste is a defect you are committing in advance.
- **One component owns each repeated structure.** Section wrapper, section head,
  card grid, terminal chrome, nav — each is exactly one file. Pages are *pure
  composition* of those.
- A one-off (used once) can stay inline, but extract it the moment a second use
  appears. Don't pre-abstract things used once (that's the opposite mistake).
- Specialised variants share a base: a chrome component + a body slot, not two
  near-identical copies. (Landing example: `Terminal` chrome + `Transcript` /
  `GateSteps` / `LedgerTable` bodies — every terminal's frame is tuned in one file.)

## 2. Separate structure, content, and style

Three different things, three different homes:

- **Structure** → components (props in, markup out; no embedded copy, no magic
  numbers).
- **Content** → a typed data module (`content/site.ts`-style). Components render
  data; they don't carry sentences. Deleting a card from the data file removes it
  from the page — that's the test, too (assert counts against the data).
- **Style** → design tokens + one stylesheet convention. Pick ONE: a central
  sheet *or* co-located scoped styles, and keep the whole surface consistent.
  Don't scatter the same rule across page `<style>` blocks.

## 3. Control centrally (tokens are the dials)

- Every scale, colour, space, radius, font, and motion curve is a **design token**.
  No bespoke `font-size: 0.92rem` one-offs; add a token or use the scale.
- Components consume tokens; they never hardcode brand values.
- The litmus test: changing the accent colour, a type step, or the section rhythm
  is a **one-line edit** that propagates everywhere.

## 4. Refactor by extracting, not by changing

When you componentize existing UI, **preserve behavior exactly** unless a change
was explicitly requested. Emit the same class names / DOM shape so existing styles
and scripts keep working; move logic into modules without rewriting it.

- Worked example: the landing had two animation "stylers" — a last-line blinking
  cursor and rolling rows. The refactor *extracted* them into `Transcript` and
  `GateSteps` with their timing/classes untouched. Structural, not behavioral.
- Prove the preservation: a structural test that the refactored output matches the
  contract (section order, element counts, hooks present) is your migration oracle
  when you can't diff pixels.

## 5. Behavioral tests only — no string-matching theater

The gut-check (from test discipline): **if I gut the implementation, does the test
fail?** If you can replace the component with a no-op and the test stays green,
it's theater.

- **Theater (BANNED):** `expect(html).toContain('Our pricing is simple')`,
  `expect(html).toContain('class="card"')`, asserting copy that lives in the data
  file you're importing anyway. These pass even when the component is broken.
- **Behavioral / structural (REQUIRED):** render the component, parse a real DOM,
  and assert *what it does*:
  - exactly one caret, on the last line (`animate='cursor'`);
  - `cols=3` → three columns rendered;
  - a `variant` toggles the right class / element (`<h2>` vs `<h3>`);
  - slot content lands in the right slot;
  - a script mutates the DOM as expected under `vi.useFakeTimers()`;
  - counts assert against the source data (`rows.length`, `lanes.length`).
- Load-bearing exact-value checks are fine when the value is a *contract*, not
  prose: an `href`, a parsed JSON attribute equalling the source array, a `hidden`
  default, a "never points at a real auth route" negative, the no-em-dash tripwire.
- Keep genuinely behavioral script tests; replace render "does the copy appear"
  suites with component-contract tests.

## 6. The done bar (not optional)

- Responsive at every breakpoint (test the real copy at mobile/tablet/desktop;
  the viewport is part of the design).
- `prefers-reduced-motion` alternative for every animation.
- Content visible by default — never gate visibility on a JS reveal class
  (transitions don't fire in headless renders or background tabs → ships blank).
- Accessibility: semantic elements, labels, contrast (body ≥ 4.5:1).

## Anti-patterns — match and refuse

- A page file over ~200 lines that is mostly inline markup → extract sections.
- The same markup block pasted with small tweaks → one component + props.
- The same CSS rule tuned in several files / `<style>` blocks → one token / one rule.
- `toContain('<copy>')` / `toContain('class="…"')` render assertions → behavioral test.
- A bespoke size/colour that matches no token → add it to the scale.
- Content strings hardcoded inside components → move to the data module.
- Visibility gated on a `.is-visible` class applied by JS → visible by default.

## Before you ship — checklist

1. Is every repeated structure a component? (grep for duplicated markup.)
2. Can I retune any size/colour/space/motion in ONE place?
3. Is all copy in the data module, not in components?
4. Do the tests fail if I break the implementation? (No `toContain` copy theater.)
5. Reduced-motion + responsive + a11y covered?
6. If refactoring: is behavior byte-identical except for explicitly-requested changes?

## See also

- [[frontend-patterns]] — React/Next component composition, state, data fetching.
- [[karpathy]] — simplicity first; don't over-abstract a single use.
- `tdd-enforce` / [[tdd-discipline]] — the antipattern catalogue behind §5.
- `impeccable` / `design-taste-frontend` / `emil-design-eng` — the *visual* design
  layer (this skill is about *architecture + tests*, not aesthetics).
