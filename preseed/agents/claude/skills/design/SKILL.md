---
name: design
description: "Master design router for frontend UI, UX systems, static artwork, critique, and polish. Use whenever a request asks to design, redesign, style, visualize, or substantially improve an interface or visual artifact."
---

# Design

Use this as the entry point for design work. It routes the brief to focused skills; it does not replace or repeat them.

## Route the request

| Need | Skill | Role |
|---|---|---|
| Product UI, patterns, palettes, typography, accessibility, stack guidance | `ui-ux-pro-max` | Searchable design intelligence and implementation constraints |
| Distinctive website, landing page, app shell, or component direction | `frontend-design` | Brief-specific art direction and frontend execution |
| Poster, artwork, cover, or other static PNG/PDF composition | `canvas-design` | Visual philosophy and canvas composition |
| UI critique, redesign, accessibility, responsive behavior, motion, or final polish | `impeccable` | Deep interface audit and refinement when installed |
| High-level landing-page or portfolio art direction | `design-taste-frontend` | Existing Codeflare taste and composition guidance |
| Repeated UI structure and behavioral component boundaries | `frontend-components` | Composable component and test discipline |
| React or Next.js state, performance, and architecture | `frontend-patterns` | Framework implementation patterns |
| Interaction detail and animation craft | `emil-design-eng` | Focused UI polish and motion guidance |

Read each selected skill's `SKILL.md` before applying it. Skills are installed beside this file in the runtime's skills directory. Optional specialists may not exist in every runtime; when one is absent, continue with the available selected skills.

## Composition rules

- **New frontend:** combine `frontend-design` + `ui-ux-pro-max`; add `impeccable` for critique and the final refinement pass when available.
- **Existing frontend redesign:** begin with `impeccable` when available, use `ui-ux-pro-max` for evidence and constraints, then use `frontend-design` to establish a coherent direction.
- **Static visual artifact:** use `canvas-design`; add `ui-ux-pro-max` only when the artifact also needs interface, accessibility, or product-system decisions.
- **Design-system request:** lead with `ui-ux-pro-max`; use `frontend-design` to keep the resulting implementation distinctive rather than database-driven or generic.
- Do not invoke every skill by default. Select the smallest set that covers the requested outcome.
- The user's explicit brief, brand, stack, output format, and accessibility requirements override specialist defaults.
- Resolve disagreements in this order: user constraints, observable accessibility/usability, project design system, coherent art direction, specialist preference.

## Invocation examples

Natural requests are enough:

- “Use the design skill to redesign this dashboard.”
- “Use design to create a distinctive landing page for this product.”
- “Design a static event poster and deliver PNG and PDF.”
- “Audit and polish this interface without changing its product structure.”

## Workflow

1. Identify the artifact, audience, primary job, required output, stack, and fixed brand constraints.
2. Choose the specialist set from the routing table and read those skills.
3. Establish one direction before implementation: content hierarchy, palette, type roles, layout logic, interaction or composition signature.
4. Build from shared tokens and reusable components where applicable.
5. Critique the result against the brief at mobile and desktop sizes or against the requested canvas boundaries.
6. Refine what exists before adding decoration. Deliver the requested files and briefly state the design decisions that materially shaped them.
