---
name: native-mobile-design
description: "Own product-specific art direction and platform behavior for native iOS, native Android, and cross-platform native mobile applications. Use for mobile flows, screens, navigation, gestures, lifecycle, accessibility, and thesis-changing native redesign. Exclude responsive web, static art, bounded finishing, and non-visual engineering."
---

# Native Mobile Design

Own one product-specific visual thesis while respecting genuine platform behavior. Native mobile is not responsive web at a smaller width.

## Start with product and platform evidence

Inspect product goals, audience, tasks, content, brand, incumbent screens, navigation, components, tokens, assets, accessibility, repository stack, platform versions, and current changes. Establish a support matrix covering target OS versions, phones/tablets/foldables, orientations or window sizes, input methods, accessibility commitments, offline/high-latency behavior, and permitted cross-platform divergence. Identify whether delivery is native iOS, native Android, or cross-platform native mobile.

Treat SwiftUI, UIKit, Jetpack Compose, Android Views, React Native, Expo, and Flutter as implementation contexts, not design styles. Do not infer a visual identity from the framework.

## Choose the interview mode

Proceed when product, platform, and direction are clear. Otherwise ask one focused batch about target platforms, audience, primary job, identity, navigation, offline needs, device range, and non-negotiable conventions. Offer materially different directions only when creative direction remains unresolved. If direction is delegated, state assumptions and choose.

## Load detailed platform guidance progressively

Read [references/platform-behavior.md](references/platform-behavior.md) when establishing navigation, system integration, gestures, lifecycle, accessibility, responsive native layouts, or cross-platform compromises.

For an Operate surface, read [../frontend-design/references/operate-and-dashboards.md](../frontend-design/references/operate-and-dashboards.md) before mapping information architecture to native components. When component-system or registry material may be used, read [../frontend-design/references/component-systems.md](../frontend-design/references/component-systems.md). When external skills, MCP servers, presets, or executable packages may be adopted, also read [../design/references/external-dependencies.md](../design/references/external-dependencies.md). Missing optional tools or registries do not block native design.

## Commit to one native direction

Define one contract before substantial implementation: product thesis, hierarchy and action, platform commitments, navigation, typography, color, geometry, material, imagery, motion, product signature, adaptive transformation, lifecycle/recovery, and restraint.

Platform conventions constrain behavior and accessibility. They do not erase product identity. Apple Human Interface Guidelines are conditional Apple guidance, not a reason to imitate Apple's visual identity. Material Design is conditional Android or Material guidance, not a universal aesthetic.

Do not apply arbitrary universal rules such as an F-pattern, bottom-third primary actions, a 60/30/10 palette, four type sizes, one universal spacing grid, soft shadows, or imitation of popular consumer apps. Product identity, accessibility, content, platform behavior, and the user's task decide.

## Implement inside the native system

Preserve incumbent navigation, lifecycle, data flow, architecture, design tokens, components, analytics-sensitive labels, permissions, deep links, and dependencies unless change is authorized.

Inspect incumbent components before selecting new material. Prefer platform-appropriate accessible primitives for complex interaction. Establish behavior, information architecture, and visual thesis before choosing components. Create new components only when the incumbent system cannot cleanly express the required behavior.

Keep simple transitions native. Add animation tooling only when the selected motion language requires real choreography or physics and the incumbent system has a demonstrated gap.

## Validate native behavior

Inspect representative phones plus relevant tablets, foldables, orientations, and window sizes when capabilities exist. Exercise navigation and back behavior, gestures, safe areas, system UI, keyboard avoidance, Dynamic Type or font scaling, localization and bidirectional text, screen readers, touch targets, permissions and denial recovery, deep links, offline and high-latency states, process recreation or termination, interruption, background and foreground transitions, state restoration, reduced motion, and destructive recovery.

For cross-platform work, verify each platform separately. Preserve shared product identity while allowing genuine behavioral differences. When rendering or device access is unavailable, inspect source and platform contracts, state the limitation, and do not claim device evidence.
