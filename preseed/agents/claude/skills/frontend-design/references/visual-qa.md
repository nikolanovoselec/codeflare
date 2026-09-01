# Visual QA

Read this before final review of work owned by `frontend-design`, or when `frontend-design` acts as the audit fallback.

## Match validation to available capabilities

- **Browser or preview available:** render the real interface, inspect it, and exercise important interactions.
- **Screenshot or rendering available:** capture representative mobile, tablet, desktop, and wide layouts relevant to the product. Include the user's reported viewport when known.
- **Visual inspection unavailable:** inspect structure, styles, tokens, and responsive rules; run available non-visual checks; state that composition and rendered fidelity were not visually validated.
- **Interaction automation unavailable:** inspect event and state logic, then name the interaction paths that still require manual verification.
- **Measurement unavailable:** do not invent performance, accessibility, or similarity scores.

Missing capability narrows evidence. It does not justify a false pass.

## Inspect the composition

At each relevant size, check:

- first-viewport thesis, primary action, and reading order;
- hierarchy, typography, line length, density, and spatial rhythm;
- alignment, grids, container behavior, and intentional asymmetry;
- responsive transformation rather than compressed desktop composition;
- content expansion, localization, overflow, clipping, and zoom;
- image crop, loading, fallback, and text contrast over media;
- consistency of tokens, components, icons, states, and material;
- whether the product-derived signature remains recognizable;
- whether unrelated sections were flattened into one card treatment.

Compare the result to the selected direction and actual product objective, not to generic taste.

## Exercise behavior

As applicable, verify:

- semantic landmarks, headings, labels, accessible names, and alternative text;
- logical keyboard order, visible focus, escape and dismissal behavior;
- contrast, touch targets, hover-independent access, and reduced motion;
- loading, empty, error, disabled, success, destructive, and offline or asset-failure states;
- real links, buttons, forms, validation, and no dead controls;
- mobile navigation, touch interaction, orientation, and onscreen-keyboard behavior;
- runtime and console errors, cleanup, hidden or offscreen animation, and cross-browser fallback.

Accessibility is part of composition and interaction design. Do not defer it to a cosmetic cleanup pass.

## Measure what has a budget

Use project requirements or agree on measurable budgets. Examples include LCP, CLS, interaction latency, JavaScript weight, media bytes, memory ceiling, frame rate, or contrast. Report measured values with method and viewport. If no budget or measurement capability exists, report qualitative risk without a fabricated number.

## Revise in bounded passes

1. Capture one representative evidence set.
2. Rank findings by product harm and thesis breakage.
3. Fix related problems as one coherent pass.
4. Confirm the changed areas.
5. Repeat only when confirmation exposes a remaining material defect, normally stopping within one to three passes.

Do not enter an endless polish loop. Clear critical findings before completion; if capability, scope, or budget prevents that, report the work as blocked or incomplete. If a foundational direction fails, return to direction rather than stacking effects on a broken composition.

## Report evidence honestly

Name inspected routes, viewport sizes, interactions, checks, screenshots, and known gaps. Distinguish source inspection, automated checks, rendered evidence, and manual evidence. Never call source code a visual validation result.
