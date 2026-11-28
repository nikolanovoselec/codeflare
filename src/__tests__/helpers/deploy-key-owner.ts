import type { Env } from '../../types';
import { DeployKeyState } from '../../lib/deploy-key-state';

// Small unit-fixture transport for suites that already mock their bindings. The
// ownership race suite uses the real owner RPCs with native transactions instead.
const namespaces = new WeakMap<KVNamespace, Map<string, { storage: DurableObjectStorage; records: Map<string, unknown> }>>();

function makeStorage() {
  const records = new Map<string, unknown>();
  let tail = Promise.resolve();
  const storage = {
    get: async (key: string) => structuredClone(records.get(key)),
    put: async (key: string, value: unknown) => { records.set(key, structuredClone(value)); },
    transaction<T>(work: (txn: DurableObjectTransaction) => Promise<T>) {
      const ready = tail.then(() => work(storage as unknown as DurableObjectTransaction));
      tail = ready.then(() => {}, () => {});
      return ready;
    },
  } as unknown as DurableObjectStorage;
  return { storage, records };
}

function makeOwner(env: Env, bucket: string) {
  let namespace = namespaces.get(env.KV);
  if (!namespace) namespaces.set(env.KV, namespace = new Map());
  let state = namespace.get(bucket);
  if (!state) namespace.set(bucket, state = makeStorage());
  const owner = new DeployKeyState(env, state.storage, bucket);
  return {
    readOwnedDeployKeys: (_bucket: string) => owner.read(),
    compareOwnedDeployKeys: (_bucket: string, ...args: Parameters<DeployKeyState['compare']>) => owner.compare(...args),
    resetOwnedDeployKeys: (_bucket: string) => owner.reset(),
  };
}

export function withDeployKeyOwner(env: Env): Env {
  const original = env.CONTAINER;
  const namespace = Object.create(original ?? null) as Env['CONTAINER'];
  const ids = new Map<DurableObjectId, string>();
  namespace.idFromName = name => {
    if (!name.startsWith('bucket-owner:')) return original.idFromName(name);
    const id = {} as DurableObjectId;
    ids.set(id, name.slice('bucket-owner:'.length));
    return id;
  };
  namespace.get = (id, options) => {
    const bucket = ids.get(id);
    return bucket ? makeOwner(env, bucket) as unknown as ReturnType<Env['CONTAINER']['get']> : original.get(id, options);
  };
  return { ...env, CONTAINER: namespace };
}

/** Inspect the at-rest format only in encryption assertions. */
export function deployKeyCiphertext(kv: unknown, bucket: string): string | undefined {
  const record = namespaces.get(kv as KVNamespace)?.get(bucket)?.records.get('deploy-keys') as { sealed: string | null } | undefined;
  return record?.sealed ?? undefined;
}
