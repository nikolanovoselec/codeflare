# Redesign and polish

Read this after `frontend-design` is selected for incremental redesign or incumbent-system work. Use its bounded-polish path only after explicit `frontend-design` invocation or when acting as the audit fallback.

## Audit before replacing

Inspect the implementation and one representative source of visual truth: tokens, theme, shared styles, components, or assets. Record:

- framework, build, routing, styling, and deployment conventions;
- content, semantics, data flow, forms, analytics, and working behavior;
- palette, typography, spacing, shape, icon, imagery, and motion language;
- reusable components and the canonical token source;
- accessibility and responsive behavior worth preserving;
- the specific weakness the request asks to change.

A missing design document does not make an established interface greenfield.

## Set the change boundary

Classify the task:

- **Incremental redesign:** retain identity and architecture; improve composition or system decisions across a meaningful surface.
- **Polish:** refine a bounded area without opening a new visual direction.
- **Full redesign:** use [new-work.md](new-work.md), but preserve product truth and behavior.

Ask before changing routes, navigation labels, content claims, legal text, form contracts, analytics identifiers, identity assets, production dependencies, or established interaction models. Do not replace a stack or component library because another one is easier to style.

## Evolve the incumbent system

Prefer the smallest change that unlocks the intended result:

1. fix hierarchy and content structure;
2. correct typography and spatial rhythm;
3. clarify color and state roles;
4. improve imagery, material, and composition;
5. add purposeful interaction or motion;
6. replace shared architecture only when local changes cannot carry the direction.

Reuse tokens and components when they still serve the concept. Extend the canonical token source rather than creating a competing global CSS layer. Preserve the icon family unless migration is justified and authorized.

A local addition inherits its surrounding visual world. Do not turn one panel, form, or section into a separate brand exercise.

## Verify preservation

Compare before and after behavior, not only appearance. Check routes, keyboard flow, focus, content, data states, responsive transitions, localization, analytics-sensitive labels, and asset fallbacks.

Use [visual-qa.md](visual-qa.md) for critique.
