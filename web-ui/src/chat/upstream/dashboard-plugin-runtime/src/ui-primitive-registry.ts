/**
 * UI primitive registry — runtime data structure.
 *
 * The dashboard creates one of these at startup, registers an implementation
 * for every key in `UI_PRIMITIVE_KEYS`, and exposes it to descendants via
 * `<UiPrimitiveProvider>`. Plugin slot contributions look up impls via
 * `useUiPrimitive(key)` (see `ui-primitive-context.tsx`).
 *
 * The registry is a private wrapper around a `Map<string, unknown>`; consumers
 * never touch the underlying map directly. Public access is via:
 *
 *   - `createUiPrimitiveRegistry()` — make an empty registry
 *   - `registerUiPrimitive(reg, key, impl)` — type-safe registration
 *   - the lookup hooks in `ui-primitive-context.tsx`
 *
 * Double-registration throws (first-write-wins). Missing-key lookups throw
 * via the strict hook or return null via the soft hook.
 *
 * See change: add-plugin-ui-primitive-registry.
 */
import type {
  UiPrimitiveKey,
  UiPrimitiveMap,
} from "@blackbelt-technology/pi-dashboard-shared/dashboard-plugin/ui-primitives.js";

/**
 * Opaque handle to a registry. The internal shape is kept private so the
 * data structure can evolve (e.g. add metadata about who registered what,
 * detection of late registrations, listener support) without breaking
 * consumers.
 */
export interface UiPrimitiveRegistry {
  /** @internal — do not access from outside this module. */
  readonly _impls: Map<UiPrimitiveKey, unknown>;
}

/**
 * Create a fresh empty registry. Each dashboard instance creates exactly
 * one. The registry is not thread-safe, but React's single-threaded event
 * loop makes that a non-issue.
 */
export function createUiPrimitiveRegistry(): UiPrimitiveRegistry {
  return { _impls: new Map() };
}

/**
 * Register an implementation under a primitive key. Type-safe: the impl
 * must match the contract for that key in `UiPrimitiveMap`.
 *
 * Throws if the key is already registered. The first registration wins;
 * the throwing call's impl is discarded. This catches accidental
 * double-registration in main.tsx (e.g. someone copy-pasting a registration
 * line and not updating the key) and in tests.
 *
 * @example
 *   const reg = createUiPrimitiveRegistry();
 *   registerUiPrimitive(reg, UI_PRIMITIVE_KEYS.markdownContent, MarkdownContent);
 */
export function registerUiPrimitive<K extends UiPrimitiveKey>(
  registry: UiPrimitiveRegistry,
  key: K,
  impl: UiPrimitiveMap[K],
): void {
  if (registry._impls.has(key)) {
    throw new Error(
      `UI primitive "${key}" is already registered. Each primitive can only ` +
        `have one registration per registry. If you intend to override an ` +
        `existing primitive, do so before any other registration of the same key.`,
    );
  }
  registry._impls.set(key, impl);
}

/**
 * @internal — used by the lookup hooks. Returns the registered impl or
 * `undefined` if the key is not registered.
 */
export function getUiPrimitiveImpl<K extends UiPrimitiveKey>(
  registry: UiPrimitiveRegistry,
  key: K,
): UiPrimitiveMap[K] | undefined {
  return registry._impls.get(key) as UiPrimitiveMap[K] | undefined;
}
