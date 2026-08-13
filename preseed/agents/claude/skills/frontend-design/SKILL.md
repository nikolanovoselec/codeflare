---
name: frontend-design
description: "Create distinctive, brief-specific frontend visual direction and carry it through accessible, responsive implementation. Use for new pages, landing pages, app shells, and substantial interface redesigns."
---

# Frontend Design

This is a Codeflare-owned, independently authored skill. It turns a product brief into a recognizable visual system and working frontend without relying on generic design defaults.

## Start with the product truth

Before styling, identify:

- the specific product or subject;
- the people using it and their situation;
- the page's one primary job;
- the real content and actions that prove that job;
- fixed brand, stack, accessibility, and performance constraints.

If essential facts are missing and materially change the result, ask. Otherwise make a concrete, stated assumption. Draw the visual language from the subject's own materials, tools, vocabulary, environment, and history rather than from a fashionable page template.

## Define one direction

Create a compact direction before implementation:

1. **Concept:** one sentence connecting the subject to the visual treatment.
2. **Hierarchy:** what dominates, what supports it, and what remains quiet.
3. **Palette:** a small set of named color roles with accessible text/background pairs.
4. **Typography:** distinct display, reading, and utility roles; choose every role for a reason.
5. **Layout:** explain the organizing geometry and sketch difficult structure with a small ASCII wireframe when useful.
6. **Signature:** one memorable element or interaction tied directly to the subject.
7. **Restraint:** name what the design deliberately avoids.

Test the direction with one question: could the same plan be pasted onto an unrelated product with only the nouns changed? If yes, replace the generic choices before coding.

## Build the direction, not a collage

- Encode palette, type, spacing, radius, elevation, and motion as shared tokens.
- Make components reusable without erasing the page's identity.
- Let structure carry meaning. Labels, rules, numbers, cards, and grids should clarify real relationships rather than decorate empty space.
- Use authentic content. Placeholder slogans and vague benefit cards make even polished layouts feel synthetic.
- Spend visual intensity on the signature. Keep surrounding elements disciplined.
- Match implementation complexity to the idea. A quiet design needs exact spacing and typography; an expressive design needs enough technical depth to make its central gesture convincing.
- Preserve the project's framework and conventions unless the user asks for a change.

## Interaction and copy

Motion should explain state, continuity, hierarchy, or cause and effect. Prefer one coordinated moment over unrelated animation on every element. Respect reduced-motion preferences and never make motion necessary to understand or operate the interface.

Write interface text from the user's side of the screen. Use concrete nouns and verbs, consistent action names, visible labels, actionable errors, and empty states that explain the next step. Avoid internal architecture vocabulary and promotional filler inside product controls.

## Quality floor

Every delivered frontend must:

- work from narrow mobile viewports through wide desktop layouts;
- preserve visible keyboard focus and logical tab order;
- use semantic structure and labels;
- meet appropriate contrast and target-size expectations;
- avoid horizontal overflow and accidental layout shift;
- handle loading, empty, error, long-content, and disabled states relevant to the brief;
- avoid selector collisions and one-off overrides that undermine the token system.

## Critique twice

Critique once before implementation and once after. In the final pass:

1. compare the result to the original brief rather than to generic taste;
2. inspect hierarchy, alignment, spacing rhythm, type, contrast, and content density;
3. inspect mobile behavior, focus, reduced motion, and important edge states;
4. remove an unnecessary effect or ornamental element before adding anything new;
5. refine the weakest existing decision until the page reads as one authored system.

When browser or screenshot tools are available, use visual evidence for the final critique. Otherwise inspect the rendered structure and styles directly and clearly state the verification limit.
