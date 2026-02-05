/**
 * Shared mock KV factory for test files.
 *
 * Provides a Map-backed KVNamespace mock with optional JSON parsing support
 * and convenience helpers (_store, _set, _clear).
 */
import { vi } from 'vitest';

export interface MockKV {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  /** Direct access to the underlying store */
  _store: Map<string, string>;
  /** Convenience: JSON-stringify and store a value */
  _set: (key: string, value: unknown) => void;
  /** Clear the entire store */
  _clear: () => void;
}

/**
 * Create a mock KV namespace backed by an in-memory Map.
 *
 * - `get` supports an optional `type`/`format` second argument; when `'json'`
 *   is passed, the stored string is JSON-parsed before returning.
 * - `list` supports an optional `{ prefix }` filter.
 */
export function createMockKV(): MockKV {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) return null;
      if (type === 'json') {
        try { return JSON.parse(value); } catch { return value; }
      }
      return value;
    }),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (opts?: { prefix?: string; cursor?: string }) => {
      const prefix = opts?.prefix ?? '';
      const keys = Array.from(store.keys())
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    }),
    _store: store,
    _set: (key: string, value: unknown) => store.set(key, JSON.stringify(value)),
    _clear: () => store.clear(),
  };
}
