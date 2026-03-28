/**
 * Shared mock KV factory for test files.
 *
 * Provides a Map-backed KVNamespace mock with optional JSON parsing support,
 * metadata support for kv.put({ metadata }) and kv.list() metadata return,
 * and convenience helpers (_store, _set, _clear).
 */
import { vi } from 'vitest';

interface StoreEntry {
  value: string;
  metadata?: unknown;
}

export interface MockKV {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  /** Direct access — accepts raw strings for backward compat with 110+ test callsites */
  _store: Map<string, string>;
  /** Convenience: JSON-stringify and store a value (optional metadata) */
  _set: (key: string, value: unknown, metadata?: unknown) => void;
  /** Clear the entire store */
  _clear: () => void;
}

/**
 * Create a mock KV namespace backed by an in-memory Map.
 *
 * Internally stores StoreEntry objects for metadata support, but _store
 * exposes a string-compatible interface for backward compatibility with
 * existing tests that use _store.set(key, JSON.stringify(value)).
 */
export function createMockKV(): MockKV {
  // Internal store with metadata support
  const entries = new Map<string, StoreEntry>();

  // Backward-compatible _store that accepts raw strings
  // When tests do _store.set(key, str), we wrap it as { value: str }
  const store = new Proxy(new Map<string, string>(), {
    get(target, prop) {
      if (prop === 'set') {
        return (key: string, value: string) => {
          entries.set(key, { value });
        };
      }
      if (prop === 'get') {
        return (key: string) => entries.get(key)?.value ?? undefined;
      }
      if (prop === 'has') {
        return (key: string) => entries.has(key);
      }
      if (prop === 'delete') {
        return (key: string) => entries.delete(key);
      }
      if (prop === 'clear') {
        return () => entries.clear();
      }
      if (prop === 'size') {
        return entries.size;
      }
      if (prop === 'keys') {
        return () => entries.keys();
      }
      if (prop === 'values') {
        return function* () {
          for (const entry of entries.values()) yield entry.value;
        };
      }
      if (prop === 'entries') {
        return function* () {
          for (const [k, v] of entries.entries()) yield [k, v.value] as const;
        };
      }
      if (prop === 'forEach') {
        return (cb: (value: string, key: string) => void) => {
          entries.forEach((v, k) => cb(v.value, k));
        };
      }
      if (prop === Symbol.iterator) {
        return function* () {
          for (const [k, v] of entries.entries()) yield [k, v.value] as [string, string];
        };
      }
      return Reflect.get(target, prop);
    },
  });

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const entry = entries.get(key);
      if (!entry) return null;
      if (type === 'json') {
        try { return JSON.parse(entry.value); } catch { return entry.value; }
      }
      return entry.value;
    }),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }) => {
      entries.set(key, { value, metadata: opts?.metadata });
    }),
    delete: vi.fn(async (key: string) => {
      entries.delete(key);
    }),
    list: vi.fn(async (opts?: { prefix?: string; cursor?: string }) => {
      const prefix = opts?.prefix ?? '';
      const keys = Array.from(entries.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([name, entry]) => ({ name, metadata: entry.metadata ?? null }));
      return { keys, list_complete: true };
    }),
    _store: store as unknown as Map<string, string>,
    _set: (key: string, value: unknown, metadata?: unknown) => {
      entries.set(key, { value: JSON.stringify(value), metadata: metadata ?? undefined });
    },
    _clear: () => entries.clear(),
  };
}
