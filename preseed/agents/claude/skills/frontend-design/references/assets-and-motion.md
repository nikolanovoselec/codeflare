# Assets and motion

Read this only when imagery, illustration, video, animation, canvas, WebGL, generated assets, or external references materially support the concept.

## Use assets deliberately

Inspect existing assets before sourcing or creating replacements. Choose imagery by its job in the visual thesis, required crop, responsive behavior, loading priority, provenance, and failure state.

If image generation is available and original imagery strengthens the concept, use it. If image search is available, verify source, license, resolution, and relevance. If neither exists, work with repository assets or describe exact asset requirements. Do not claim an asset was generated, searched, licensed, or visually checked when it was not.

Generated imagery must not impersonate customers, employees, endorsements, evidence, or documentary photography. Do not fabricate testimonial portraits or proof. Preserve provenance and licensing information where relevant.

Study references for composition, rhythm, density, contrast, typography, material, image treatment, and interaction tempo. Never clone branding, proprietary components, illustrations, or layouts.

## Treat blend modes as rendering, not extraction

`mix-blend-mode: exclusion` does not remove an image background. It combines source and backdrop colors; the result depends on both. Use blend modes only after testing the exact asset across supported backgrounds.

Prefer transparent assets, alpha channels, masks, SVG, deliberately graded media, or shaders when those solve the actual problem.

## Build loops as assets first

Do not reverse ordinary video by continuously seeking `currentTime`. Repeated seeking can cause seek/decode churn, stalls, frame drops, and unnecessary CPU or memory cost.

Preferred order:

1. produce a true cyclic or ping-pong asset during preparation;
2. create a natural forward loop;
3. use a suitable animation or image sequence when justified;
4. reserve runtime frame control for exceptional experiences whose benefit warrants the complexity.

Exceptional runtime control must define browser support, memory and resolution bounds, scheduling, decode behavior, mobile and reduced-motion fallbacks, offscreen pausing, teardown, poster behavior, and failure behavior.

## Give motion a job

Motion should explain, orient, respond, reveal, or establish atmosphere. Remove motion that exists only to advertise animation capability. Prefer native platform behavior for simple transitions; add a heavier runtime only when the concept and maintenance budget justify it.

For persistent animation, media, canvas, or GPU work:

- respect reduced-motion preferences and provide a static or simplified form;
- initialize only when needed and pause when hidden or offscreen where appropriate;
- bound CPU, GPU, memory, network, resolution, and frame rate;
- keep content available without hover or animation completion;
- reserve layout space and prevent avoidable shifts;
- cancel callbacks and timers, disconnect observers, remove listeners, stop media, and release graphics resources;
- test touch, keyboard, assistive technology, mobile fallback, poster, and failure behavior.

## Validate the actual asset

Inspect important crops at representative widths. Check focal point, contrast behind text, intrinsic dimensions, format support, loading priority, failure behavior, and reduced-data implications. A file existing in the repository does not prove it works in the composition.
