---
name: frontend-components
description: Build repeated UI as composable components with centralized content and styles, explicit variants, and behavioral tests.
license: MIT
---

# Composable frontend components

Use this skill before adding repeated UI or while refactoring duplicated markup. It owns component structure, API composition, state ownership, centralized content and style, and behavioral tests. Visual direction belongs to the applicable design skill; React performance belongs to `frontend-patterns`.

## Extract only real repetition

- Extract a structure when it appears more than twice. Keep a true one-off inline instead of inventing speculative abstraction.
- One component owns each repeated structure. Specialized forms share a stable shell and compose their distinct body.
- Pages compose sections and features; they do not duplicate the implementation of cards, navigation, section headers, dialogs, tables, or repeated chrome.
- A change to repeated behavior must require one implementation edit.

Do not use file length alone as the reason to split a component. Split where ownership, reuse, state, loading boundaries, or testing contracts become clearer.

## Separate structure, content, and style

- **Structure** belongs in components: typed inputs, semantic markup, behavior, and slots.
- **Content** belongs in typed data or the owning domain module when several instances share the same shape. Components should not embed repeated product copy.
- **Style** belongs to the project's single established styling convention and shared design tokens.
- Components consume tokens rather than hardcoding repeated brand colors, spacing, type scales, radii, or motion curves.

The practical test is simple: changing a repeated value or behavior everywhere should require one edit.

## Prefer composition to configuration

A component API should expose meaningful structure rather than accumulating flags.

- Avoid boolean-prop combinations such as `compact`, `stacked`, `featured`, and `withFooter` when combinations create hidden states.
- Use explicit variant components when variants have different semantics or layout, while sharing internal primitives.
- Use children or named slots for caller-owned content. Use render callbacks only when the component must provide state or behavior to the callback.
- Use compound components when related pieces need shared context and callers need flexible arrangement.
- Keep low-level primitives small; compose them into domain components rather than adding every use case to one universal component.

Explicit variants should make invalid combinations impossible or obvious. Do not replace a small, stable prop with unnecessary hierarchy.

## Give state one owner

Lift state to the nearest common owner that must coordinate it. Avoid duplicated local state synchronized by effects.

For shared component state, expose a narrow interface:

- **state:** stable values consumers may render;
- **actions:** operations consumers may invoke;
- **metadata:** status such as loading, validity, or capabilities when it is part of the contract.

Keep provider consumers independent of the provider's internal reducer, store, or fetching library. This allows the implementation to change without rewriting every child. Split contexts or selectors when unrelated consumers otherwise rerender together.

Do not put all application state in one provider. Ownership follows the smallest domain boundary that needs coordination.

## Preserve behavior during extraction

A componentization refactor is structural unless the user requested behavior changes.

- Preserve semantic elements, accessibility relationships, public props, event ordering, class hooks, and state transitions.
- Keep immutable updates; do not mutate caller-owned arrays or objects.
- Separate refactoring from new behavior so regression evidence identifies the causal change.
- Add no fallback, variant, setting, or recovery state that the existing contract does not require.

## Test observable contracts

A test must fail when the component implementation is removed or broken.

Assert outcomes such as:

- a prop or explicit variant changes semantic output or interaction;
- children or named slots render in the correct owned region;
- user interaction changes state, focus, URL, or submitted data;
- repeated data produces the corresponding accessible items;
- disabled, loading, and error states enforce their interaction contracts;
- responsive or reduced-motion behavior is observable in the appropriate browser test.

Do not substitute source-text, prompt-text, class-string, or UI-copy matching for behavior. Exact values are valid when they are public contracts, such as an `href`, role, parsed attribute, default state, or serialized schema value.

## Completion bar

Before completion, verify:

1. Structures used more than twice have one owner.
2. Content and repeated style values have one source of truth.
3. APIs use explicit variants or composition instead of conflicting flags.
4. Shared state has one bounded owner and a narrow consumer interface.
5. Refactors preserve behavior not explicitly changed.
6. Behavioral tests fail when implementation behavior breaks.
7. Semantic HTML, labels, focus, contrast, responsive layout, and reduced motion remain correct.
8. Required CI is green at the authoritative head.
