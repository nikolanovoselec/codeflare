---
name: frontend-patterns
description: Optimize React and Next.js data flow, bundles, rendering, and rerenders without speculative memoization.
license: MIT
---

# React and Next.js performance

Apply this skill when writing, reviewing, or refactoring React or Next.js code for runtime performance. For component API design and repeated UI structure, use `frontend-components`; this skill owns performance decisions.

Start with measured or structurally certain high-impact work. Eliminate request waterfalls and unnecessary client JavaScript before considering memoization or JavaScript micro-optimizations.

## 1. Eliminate waterfalls

- Start independent operations together and await them together.
- Move an `await` into the branch that actually consumes its result.
- When operations have partial dependencies, begin each operation as soon as its own inputs exist rather than serializing the whole chain.
- Place Suspense boundaries so independent page regions can stream without blocking the shell.
- In route handlers and server actions, start independent I/O early, perform synchronous validation while it is pending, then await only where required.

```ts
const userPromise = getUser(id)
const settingsPromise = getSettings(id)
const [user, settings] = await Promise.all([userPromise, settingsPromise])
```

Do not parallelize operations that depend on one another, mutate shared state, or require transactional ordering.

## 2. Reduce shipped JavaScript

- When the installed framework and incumbent architecture support Server Components, prefer server components and server data access until browser state, events, or APIs require a client boundary. Generic React or Vite applications may not have this lane.
- Import the narrow module actually used. Avoid broad barrel imports when they pull large dependency graphs or inhibit tree shaking.
- Keep import paths statically analyzable. Dynamic path construction can force bundlers and deployment tracers to include whole directories.
- Dynamically import heavy, optional UI that is not needed for the initial interaction.
- Load analytics, support widgets, and other non-critical third parties after hydration or user intent.
- Conditionally load feature code only after the feature is activated.
- Use preload or prefetch only when user intent or navigation probability justifies the network cost.

Do not add a dynamic boundary to tiny, always-needed modules; it adds another request and loading state without reducing useful work.

## 3. Keep server work request-safe

- Authenticate and authorize server actions as rigorously as API routes. Treat every argument as untrusted input.
- Deduplicate repeated work within one request with the framework's request-scoped cache.
- Use bounded cross-request caches only for data whose ownership, invalidation, tenant scope, and memory limit are explicit.
- Never keep request-specific mutable state in module scope.
- Pass the smallest serializable data shape from server to client. Avoid duplicate objects and values that can be derived on the client.
- Restructure nested components when sequential rendering creates sequential fetches; parallelize at the nearest common owner.
- Move static file or metadata reads out of per-request paths when the runtime lifecycle makes that safe.
- Schedule non-critical post-response work only with a runtime-owned mechanism that guarantees its lifecycle.

## 4. Deduplicate client work

- Use an established request cache such as the project's existing SWR or query library instead of building another ad hoc fetching hook.
- Share global event listeners among consumers and remove them when the last consumer unmounts.
- Mark touch and scroll listeners passive when they never call `preventDefault`.
- Version, validate, and minimize browser-storage data. Treat stored values as untrusted at the read boundary.
- Prefer URL or server state for shareable and durable state; do not mirror the same source into several client stores.

## 5. Prevent avoidable rerenders

- Derive values during render instead of synchronizing derived state in an effect.
- Subscribe to the smallest stable value needed, such as a boolean selector instead of a large object.
- Use functional state updates when the next value depends on the previous value.
- Lazily initialize expensive state by passing an initializer function to `useState`.
- Keep interaction logic in event handlers; effects synchronize with external systems, not user events or derived values.
- Define components at module scope rather than recreating component types during render.
- Use refs for transient values that do not affect rendered output.
- Use transitions or deferred values for non-urgent expensive rendering when responsiveness evidence warrants them.
- Hoist stable non-primitive default props instead of allocating a new object or array each render.

Inspect installed React, framework, router, cache model, and compiler configuration before version-sensitive advice. Account for React Compiler when present. Memoize only when calculation cost or child rerender evidence exceeds memoization complexity; do not wrap simple expressions, callbacks, or components mechanically.

## 6. Render efficiently

- Use `content-visibility` or virtualization for genuinely long off-screen content, based on layout and accessibility needs.
- Keep static JSX and static resources outside repeated render paths when ownership permits.
- Avoid ambiguous `condition && <Node />` expressions when the condition may render `0` or another non-boolean value; use an explicit ternary.
- Animate a wrapper rather than a complex SVG tree when it avoids repeated SVG layout and paint work.
- Preserve hydration correctness. Suppress hydration warnings only for an intentional, documented mismatch; never hide an unexplained mismatch.
- Add resource hints for critical, known resources only. Excessive preload competes with more important downloads.

## 7. Optimize JavaScript last

In measured hot paths:

- use `Set` or `Map` for repeated membership and key lookup;
- combine repeated full-array passes when it materially reduces work;
- use immutable `toSorted()` rather than mutating owned arrays with `sort()`;
- return early before expensive work;
- cache pure, expensive results only with bounded ownership and invalidation;
- avoid reading browser storage repeatedly inside loops or renders.

Do not trade readability for micro-optimizations outside a demonstrated hot path.

## Scope and verification

This skill covers React and Next.js performance where those technologies are present. It does not claim Vue, Svelte, Solid, Astro, native, or general application-architecture authority. Route those stacks to their own measured performance guidance.

Before changing code, state the suspected bottleneck and evidence. After the smallest change:

1. Verify observable behavior with behavioral tests.
2. Compare the relevant metric, request ordering, bundle composition, render count, or browser trace.
3. Confirm accessibility and loading/error behavior did not regress.
4. Respect repository verification policy. In Codeflare, CI owns builds and tests; the managed `safe-local-checks` wrapper is supplemental only.
5. For deployed browser performance, use `web-perf` and report the measured before/after evidence.

A performance change is incomplete when it merely looks idiomatic, shifts work elsewhere, or lacks evidence at the authoritative head.
