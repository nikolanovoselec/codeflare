---
name: desktop-native-design
description: "Own product-specific art direction and native behavior for macOS, Windows, Linux, and cross-platform desktop applications. Use for windows, menus, commands, keyboard and pointer workflows, documents, system integration, accessibility, and thesis-changing desktop redesign. Exclude responsive web, native mobile, static art, bounded finishing, and non-visual engineering."
---

# Desktop Native Design

Own one product-specific visual thesis while respecting genuine desktop behavior. Desktop-native is not responsive web at a wide viewport.

## Start with product and environment

Inspect product, audience, tasks, content, incumbent interface, brand, stack, target operating systems and versions, window model, input methods, accessibility, system integrations, and current changes. Treat Electron, Tauri, Flutter, Qt, .NET, Avalonia, MAUI, and Java as implementation contexts, not visual identities.

Proceed when requirements and direction are sufficient. Otherwise inspect first, then ask one focused batch about target systems, primary jobs, density, command model, document lifecycle, identity, integrations, and non-negotiable conventions. When examples exist, extract their system rather than cloning surfaces. When direction is delegated, state material assumptions and choose.

Read [references/platform-behavior.md](references/platform-behavior.md) when platform behavior, windows, commands, documents, system integration, adaptation, or accessibility affects the result. For operational information design, read [../frontend-design/references/operate-and-dashboards.md](../frontend-design/references/operate-and-dashboards.md).

## Commit to one desktop direction

Define product thesis, hierarchy and primary action, density, window and command model, typography, color, geometry, material, imagery, motion, signature, platform commitments, adaptation, lifecycle/recovery, and restraint before substantial implementation.

Platform guidance constrains behavior and accessibility without supplying product identity. Do not turn Fluent, Apple guidance, GNOME, KDE, or a framework theme into a universal aesthetic. Cross-platform identity should remain recognizable while behavior follows each target system where divergence helps users.

## Design for desktop work

Support keyboard-first and pointer-precise operation. Make commands discoverable through appropriate menus, toolbars, shortcuts, context actions, command surfaces, and status areas. Dense professional workflows may be correct; do not inflate them to mobile spacing.

Preserve incumbent architecture, behavior, data, labels, files, tokens, components, integrations, and dependencies unless change is authorized. Use platform-accessible primitives for complex behavior. Add motion only when it communicates state, relationship, or continuity and has an appropriate reduced form.

## Validate honestly

When capabilities exist, inspect representative window sizes, minimum size, resizing, maximized and full-screen states, high DPI, multiple displays, keyboard-only use, focus traversal, selection, menus, shortcuts, context actions, drag/drop alternatives, localization, screen readers, reduced motion, high contrast, restoration, and document recovery.

When target runtime or device access is unavailable, inspect source and declared contracts, state the limitation, and do not claim native-platform evidence.
