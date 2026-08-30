# Native platform behavior

Read this when native navigation, system integration, accessibility, lifecycle, device adaptation, or cross-platform compromise affects the result.

## Separate shared identity from platform behavior

Keep product voice, content strategy, brand typography where feasible, color logic, imagery, material intent, and signature interactions recognizable across platforms. Let navigation, back behavior, system controls, gestures, permissions, text scaling, transitions, and lifecycle follow each platform where divergence improves comprehension or access.

Use current official Apple and Android guidance when exact conventions or APIs matter. State when current documentation is unavailable. Material guidance is conditional to Android or a selected Material system. Apple guidance is conditional to Apple platforms. Neither supplies the product thesis.

## Design the complete mobile environment

Account for:

- platform navigation, system back behavior, modal dismissal, deep links, and gesture conflicts;
- safe areas, status and navigation system UI, cutouts, home indicators, and edge-to-edge content;
- thumb reach, touch targets, touch feedback, haptics, and gesture discoverability;
- software keyboard appearance, input avoidance, validation, autofill, and focus restoration;
- dynamic type or font scaling, screen readers, contrast, reduced motion, and switch or keyboard access where applicable;
- orientation, window-size changes, tablets, split view, foldables, and resizable app windows;
- permission requests with clear timing, rationale, denial, limited access, and settings recovery;
- offline, high-latency, stale, partial, and conflicting data;
- background, interruption, termination, restoration, task resumption, and platform lifecycle;
- native transitions that preserve spatial and navigation understanding.

Do not hide essential behavior behind an undiscoverable gesture. Do not assume a phone is always portrait, online, one-handed, or uninterrupted.

## Choose cross-platform compromises deliberately

For shared implementations, identify what can remain identical and what must diverge. Preserve one product identity while allowing platform navigation, back handling, controls, permissions, typography metrics, haptics, and transitions to differ.

A shared codebase is not evidence that every screen should be pixel-identical. Nor is platform fidelity permission to produce two visually unrelated products. Record each meaningful compromise and the user benefit it protects.

## Preserve the primary job on larger and smaller devices

Adapt information hierarchy and interaction to available window size. Tablets and foldables may expose parallel panes, persistent context, or richer comparison. Phones may need focused flows and progressive disclosure. Avoid stretched phone layouts on tablets and compressed desktop layouts on phones.

## Validate interruption and recovery

Exercise cold start, warm resume, deep-link entry, permission denial, offline start, network loss during action, keyboard-open navigation, orientation change, background during pending work, destructive confirmation, failed optimistic action, and restored state. Verify platform back behavior and assistive technology independently on iOS and Android.
