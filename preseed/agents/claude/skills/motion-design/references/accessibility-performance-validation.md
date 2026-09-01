# Accessibility, performance, and validation

Read this when motion may affect access, comfort, responsiveness, or delivery confidence.

## Design the reduced form

Classify motion as essential to understanding, helpful, decorative, or potentially vestibular. Reduced motion may remove, shorten, simplify, replace, or preserve motion depending on its job. Do not impose either “always zero” or “never zero.” Keep state, focus, feedback, and task completion clear in every form.

Avoid seizure-risk flashing and large unnecessary field-of-view movement. Keep screen-reader semantics stable; visual transitions must not duplicate controls or delay announcements. Keyboard-triggered motion is valid when meaningful and reduced appropriately.

## Reason about performance accurately

Transform and opacity are often safer starting points, not guarantees. Layout, paint, compositing, layer creation, raster cost, image size, blur, filters, DOM complexity, JavaScript work, and device/browser behavior all matter. CSS, Web Animations, and JavaScript each can perform well or poorly.

Measure the relevant frame stability, input latency, long tasks, layout/paint cost, memory, or asset/runtime weight before claiming improvement. If measurement is unavailable, identify likely risk and say it remains unverified.

## Validate the real behavior

When available, inspect at normal speed and slow motion. Exercise rapid repetition, interruption, reversal, cancellation, reduced motion, long/localized content, focus, screen readers, hidden/offscreen behavior, background/foreground changes, low-end hardware, and representative browsers or devices.

Record what was observed and what was source-inspected only. Fix related defects in one pass and confirm. Unavailable tools narrow evidence; they never justify a false pass.
