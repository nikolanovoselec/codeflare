---
name: design
description: "Route visual work by work mode, purpose, platform, and available direction to exactly one art-direction owner. Use for web, native mobile, desktop-native, static, operational, and ambiguous visual requests. Exclude backend, API, data, prose-only, and non-visual engineering work."
---

# Design router

Classify, dispatch, and stop. Do not perform owner methodology here.

## Classify the request

Choose one **work mode**: greenfield, full redesign, incremental redesign, polish, or audit.

Choose one primary **purpose**:

- **Persuade:** help an audience understand, trust, decide, or act.
- **Operate:** help a person monitor, decide, control, or recover.
- **Read:** help a person navigate and understand sustained content.
- **Experience:** make interaction, narrative, or expression the product.

Choose one **platform**: responsive web content, web product, native iOS, native Android, cross-platform native mobile, desktop-native, or static/fixed artifact.

Choose one **input state**:

- Requirements are complete: preserve them and proceed.
- Examples or direction exist: infer the system behind them; do not copy surfaces.
- Material decisions are missing: inspect first, then ask one focused batch whose answers change the result.
- Direction is delegated: choose from product evidence and state only consequential assumptions.

Purpose controls hierarchy, density, emotional intent, and success. Platform controls behavior, input, navigation, accessibility, lifecycle, and implementation. Work mode controls how much incumbent direction may change.

## Dispatch exactly one owner

| Request | Art-direction owner | Boundary |
|---|---|---|
| Responsive web or web product creation, redesign, or thesis-changing refinement | `frontend-design` | Includes Persuade, Operate, Read, and Experience |
| Native iOS, Android, or cross-platform mobile | `native-mobile-design` | Shared identity; platform-correct behavior |
| macOS, Windows, Linux, or cross-platform desktop-native product | `desktop-native-design` | Desktop behavior, not wide responsive web |
| Standalone poster, cover, graphic, artwork, or fixed production artifact | `canvas-design` | Select communication or expressive lane |
| Bounded polish or audit of an established interface | Incumbent product direction | Impeccable may critique or finish without replacing thesis |
| Backend, API, infrastructure, data, prose-only, or non-visual refactor | No design owner | Use the relevant engineering or writing owner |

For “make this better,” inspect first. Route thesis, hierarchy, composition, or visual-language changes to the platform owner. Preserve incumbent direction for bounded correction.

An explicit specialist command is a user override for that bounded command. It does not grant authority over unrelated art direction. `design-taste-frontend` is a compatibility redirect to `frontend-design`; never load both as owners.

## Handle mixed artifacts

Classify each deliverable separately. A web product and its downloadable poster have different owners. A static screenshot of UI remains an interface task. Interactive canvas or WebGL remains web. An illustration, texture, or hero asset created for an existing interface is delegated work: `canvas-design` inherits the platform owner’s thesis and cannot invent another one.

Non-visual specialists may work without any art-direction owner. A React performance request with no visual change may use `frontend-patterns` directly.

## Add only orthogonal specialists

Select the smallest useful set after the owner establishes direction:

- `frontend-components` for repeated component structure and bounded state ownership;
- `frontend-patterns` for measured React or Next.js performance work;
- `motion-design` for motion, continuity, gesture, or direct-manipulation engineering;
- `impeccable` for explicit commands, audit, hardening, critique, or bounded finishing.

A specialist cannot choose a competing palette, typography, geometry, imagery system, or motion character. Component libraries, registries, presets, datasets, and generated recommendations provide material or evidence, never art direction.

## Resolve truth and conflicts

Use this order:

1. current user brief and non-negotiable constraints;
2. product truth, required behavior, accessibility, and platform commitments;
3. incumbent implementation and confirmed project design contract;
4. selected owner’s direction for this work mode;
5. research evidence;
6. specialist preference.

An established product remains established without a formal design file. `DESIGN.md`, sidecars, and surface briefs may record decisions; generated research cannot silently replace them.

## Execute honestly

1. Inspect enough project evidence to classify request and avoid repeated questions.
2. Select one owner and only necessary specialists.
3. Load detailed references progressively.
4. State material assumptions or ask one focused batch when foundational choices remain unresolved.
5. Verify with available capabilities and report unavailable rendering, browsing, simulation, measurement, or review plainly.

For external skills, registries, packages, assets, fonts, MCP servers, or executable commands, read [references/external-dependencies.md](references/external-dependencies.md) first. Missing optional capabilities never block the owning design workflow.
