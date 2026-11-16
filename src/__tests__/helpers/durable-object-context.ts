import { runInDurableObject } from 'cloudflare:test';

/** Test RPC facade: invoke real methods in their storage owner's context. */
export function bindDurableObjectContext<T extends object>(stub: DurableObjectStub, current: () => T): T {
  return new Proxy({} as T, {
    get(_target, key) {
      const value = Reflect.get(current(), key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => runInDurableObject(stub, async () => Reflect.apply(value, current(), args));
    },
  });
}
