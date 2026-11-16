import { runInDurableObject } from 'cloudflare:test';

/** Test RPC facade: acquire outgoing stubs in the caller, then enter the storage owner. */
export function bindDurableObjectContext<T extends object>(stub: () => DurableObjectStub, current: () => T): T {
  return new Proxy({} as T, {
    get(_target, key) {
      const value = Reflect.get(current(), key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => runInDurableObject(stub(), async () => Reflect.apply(value, current(), args));
    },
  });
}
