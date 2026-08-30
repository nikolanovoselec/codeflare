# Complex motion delegation

Read this only when motion materially supports the selected visual thesis and may exceed simple CSS or incumbent-framework transitions.

## Start with the smallest motion system

Keep simple hover, focus, disclosure, enter, exit, and state transitions in CSS or the incumbent framework when sufficient. Do not activate specialist tooling for a generic fade, slide, scale, or reveal.

Prefer the project's existing animation system unless a demonstrated technical gap prevents the selected motion language. A new library adds lifecycle, bundle, maintenance, accessibility, and debugging cost.

## Delegate only for real complexity

Use a dedicated animation specialist or library when the chosen direction requires one or more of:

- coordinated timelines;
- interruptible sequences;
- complex scroll-linked storytelling;
- SVG morphing;
- physics-based interaction;
- drag behavior;
- synchronized multi-element choreography.

The art-direction authority defines motion purpose, rhythm, restraint, and reduced-motion intent first. The animation specialist implements that contract. It cannot invent a competing motion language.

If GSAP is selected, use current official guidance when exact lifecycle or API behavior matters. Scope instances correctly, clean up on teardown, prefer transforms, handle responsive matching, and provide reduced-motion behavior. Do not introduce GSAP for generic fade-up scroll reveals.

## Validate motion as behavior

Exercise interruption, rapid reversal, resize, route change, background return, cleanup, reduced motion, keyboard and touch paths, lower-power devices, and content that arrives late. Confirm that motion preserves focus, reading order, controls, and the primary action.

When advanced tooling is unavailable, preserve the experience with a simple transition or static state. Missing animation capability must not block core content or interaction.
