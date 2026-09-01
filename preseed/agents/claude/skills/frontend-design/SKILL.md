---
name: frontend-design
description: "Own web frontend art direction for responsive content and web products across marketing, operational, reading, and immersive interfaces. Use for greenfield work, redesign, and thesis-changing polish or critique. Exclude native mobile, desktop-native, static art, prose, bounded finishing, and non-visual engineering."
---

# Frontend Design

Own one coherent visual thesis from product discovery through implementation and critique. Make the result specific enough that another product could not wear it unchanged.

## Start with evidence

Before proposing direction, inspect available implementation, routes, content, assets, tokens, components, typography, configuration, screenshots, references, stack, deployment, and current changes. Establish product, audience, job, objective, action, hierarchy, brand, emotional target, constraints, and what must not change.

Do not ask the user for facts the project already answers. Do not invent metrics, customers, quotes, certifications, features, or legal claims.

## Choose the interview mode

After inspection, use one mode:

1. **Requirements sufficient:** state material assumptions and proceed.
2. **Material gaps:** ask one focused batch of high-impact questions. Explain what each answer changes. Do not impose a one-question limit.
3. **Creative direction unresolved:** present two or three materially different directions and ask the user to choose or react.
4. **Direction delegated:** make reasoned assumptions, state them, and continue autonomously.

Ask only about decisions that change the result: audience, job, content, identity, emotional target, references, priorities, creative risk, or non-negotiable constraints. Resolve low-impact details professionally. Do not begin major implementation while a foundational decision remains ambiguous unless the user delegated it.

## Select the workflow

Classify the work as greenfield, full redesign, incremental redesign, polish, or critique. Confirm the delivery platform is responsive web content or a web product; native iOS, Android, and cross-platform native work belongs to `native-mobile-design`. Classify the purpose as Persuade, Operate, Read, or Experience.

Read only the references the task needs:

- [references/new-work.md](references/new-work.md) for greenfield work or full redesign.
- [references/redesign.md](references/redesign.md) for incremental redesign or incumbent-system work; use its bounded-polish path only after explicit invocation or when acting as the audit fallback.
- [references/art-direction.md](references/art-direction.md) when establishing or materially changing frontend visual direction.
- [references/assets-and-motion.md](references/assets-and-motion.md) when imagery, illustration, video, animation, canvas, WebGL, generated assets, or external references materially support the concept.
- [references/visual-qa.md](references/visual-qa.md) before final review of work owned here, or when acting as the audit fallback.
- [references/operate-and-dashboards.md](references/operate-and-dashboards.md) for Operate surfaces; establish decisions and information architecture before selecting components.
- [references/component-systems.md](references/component-systems.md) when reusing, adapting, importing, generating, or creating component-system material.
- [references/complex-motion.md](references/complex-motion.md) only when the selected motion language may require coordinated or specialist choreography.
- [references/astro-cloudflare.md](references/astro-cloudflare.md) only when the repository already uses Astro or the task explicitly considers Astro for a new Cloudflare-targeted frontend.

## Commit to one direction

Before substantial implementation, define a compact contract: product, audience, and job; thesis and intended effect; primary hierarchy and action; product-derived signature; typography roles and palette logic; geometry, rhythm, density, and material; imagery and assets; interaction and motion character; responsive transformation; platform commitments; deliberate restraint; and evidence of success.

When examples exist, extract their composition, hierarchy, type, palette logic, material, imagery, rhythm, and interaction character. Preserve what the user points to without copying layouts, branding, or proprietary elements.

For greenfield work or substantial redesign, directions must differ materially in composition or hierarchy plus several supporting dimensions, not merely accent color or adjectives. Once the user selects or delegates a direction, stop mixing alternatives.

Apply the substitution test: if another company's name, logo, and copy could replace this product without the design feeling wrong, the direction is still generic.

## Implement inside the real system

Preserve the incumbent framework, build system, routes, semantics, content, data flow, behavior, tokens, component conventions, icon system, and dependencies unless change is authorized. Make the smallest architectural change that enables the design.

Use authentic content and working controls. Cover relevant initial, loading, empty, partial, stale, error, offline, permission, disabled, success, destructive, undo/recovery, long-content, localization, and asset-failure states without forcing irrelevant states into every surface. Accessibility belongs to composition and interaction, not cleanup.

For component work, inspect incumbent components, tokens, and registries first. Establish required behavior, accessibility, information architecture, and the visual thesis before choosing implementation material. Reuse or adapt compatible components; create new ones only when the incumbent system cannot cleanly express required behavior. A component source never chooses the thesis.

Keep simple transitions in CSS or the incumbent framework. Delegate only when the selected motion language requires complexity the existing system cannot express. An animation specialist implements that language and cannot invent it.

Choose techniques from the concept and repository, never habit. Do not mandate a framework, library, component registry, palette, icon set, font source, asset workflow, motion runtime, or rendering technique.

## Judge success by purpose

- **Persuade:** proposition comprehension, relevance, trust, authentic evidence, action hierarchy, and a coherent commitment path.
- **Operate:** situation awareness, prioritization, decision speed, safe action, recovery, auditability, and task-appropriate density.
- **Read:** navigation, scanning, sustained readability, comprehension, semantic structure, references, and print/share behavior where relevant.
- **Experience:** narrative progression, interaction legibility, sensory restraint, meaningful payoff, performance, and an accessible alternative path.

These are judgment criteria, not permission to invent analytics or claim outcomes that were not measured.

## Inspect, critique, revise

When browser, preview, screenshot, or rendering capability is available, render representative viewport sizes, inspect the actual interface, exercise important interaction and keyboard paths, and revise observed weaknesses. When visual inspection is unavailable, inspect structure and styles, run available non-visual checks, state the limitation, and do not claim visual validation.

Use one to three severity-driven passes: inspect, rank findings, fix a coherent set, and confirm. Stop when critical findings are cleared or report the unresolved blocker; a pass budget never converts a critical defect into success. Measure performance against stated budgets where measurement exists. Never translate “make it fast” into a fabricated score.

Finish only when the result preserves product truth, expresses the selected thesis, works at required sizes, handles relevant states, and reports validation evidence honestly.
