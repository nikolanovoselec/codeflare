import { vi } from 'vitest';
import { Timekeeper } from '../../timekeeper/index';
import type { Env } from '../../types';
import { createMockKV } from './mock-kv';

export function createMockBillingCoordinator(kv: ReturnType<typeof createMockKV>): DurableObjectNamespace {
  const coordinators = new Map<string, Timekeeper>();
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((id: string) => {
      const existing = coordinators.get(id);
      if (existing) return existing;
      const values = new Map<string, unknown>();
      let lock = Promise.resolve();
      const ctx = {
        storage: {
          get: async (key: string) => values.get(key),
          put: async (key: string, value: unknown) => { values.set(key, value); },
          delete: async (keys: string[]) => { for (const key of keys) values.delete(key); },
        },
        blockConcurrencyWhile: (callback: () => Promise<void>) => {
          const run = lock.then(callback);
          lock = run.then(() => undefined, () => undefined);
          return run;
        },
      } as unknown as DurableObjectState;
      const coordinator = new Timekeeper(ctx, { KV: kv } as unknown as Env);
      coordinators.set(id, coordinator);
      return coordinator;
    }),
  } as unknown as DurableObjectNamespace;
}
