import { SESSION_ID_PATTERN } from './constants';

export const HERMES_SESSION_ROOT = 'Vault/Memory/Sessions/';
export const HERMES_MARKDOWN = ['global/USER.md', 'global/MEMORY.md', 'global/failures.md', 'Projects/workspace/MEMORY.md'] as const;
export const HERMES_STORE_MARKER = 'session-id';
const STATE_KEY = 'hermes:retention';
const LIMIT = 10;

export interface HermesWriter { sessionId: string; generation: number }
export interface HermesFileObservation { digest: string; updatedAt: number }
export type HermesAdmission = 'new' | 'existing' | 'deferred';
interface Store {
  generation: number;
  updatedAt?: number;
}
interface State { stores: Record<string, Store>; eviction?: { victim: string; settled: boolean } }
interface Ports {
  canAdmit(): Promise<boolean>;
  inventory(): Promise<Map<string, HermesFileObservation[] | null> | null>;
  writerExited(writer: HermesWriter): Promise<boolean>;
  writerSettled(writer: HermesWriter): Promise<boolean>;
  observe(sessionId: string): Promise<HermesFileObservation[] | 'absent' | null>;
  evict(prefix: string): Promise<boolean | 'not-started'>;
  prefixEmpty(prefix: string): Promise<boolean>;
}

function validWriter({ sessionId, generation }: HermesWriter): boolean {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId) && Number.isSafeInteger(generation) && generation > 0;
}

/** One instance on the bucket owner. Its persisted eviction keeps a slot
 * occupied across reconstruction; external I/O never runs in a transaction. */
export class HermesRetention {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: DurableObjectStorage) {}

  async hasStore(sessionId: string): Promise<boolean> {
    const state = await this.storage.get<State>(STATE_KEY);
    return !!state && Object.hasOwn(state.stores, sessionId);
  }

  admit(writer: HermesWriter, ports: Ports, signal?: AbortSignal): Promise<HermesAdmission> {
    const next = this.tail.then(() => this.admitOne(writer, ports, signal));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async admitOne(writer: HermesWriter, ports: Ports, signal?: AbortSignal): Promise<HermesAdmission> {
    if (!validWriter(writer) || signal?.aborted) return 'deferred';
    const inventory = await ports.inventory();
    if (!inventory || signal?.aborted || !await ports.canAdmit() || signal?.aborted) return 'deferred';
    const state = await this.storage.get<State>(STATE_KEY) ?? { stores: {} };
    // A partial deletion still occupies the slot. An ambiguous reply can be
    // reconciled without repeating a delete, using a complete prefix readback.
    if (state.eviction) {
      const { victim, settled } = state.eviction;
      if (!settled || !SESSION_ID_PATTERN.test(victim) || inventory.has(victim)
        || !await ports.prefixEmpty(`${HERMES_SESSION_ROOT}${victim}/`) || signal?.aborted) return 'deferred';
      delete state.stores[victim];
      delete state.eviction;
      await this.storage.put(STATE_KEY, state);
    }
    if ([...inventory.keys()].some(id => !Object.hasOwn(state.stores, id))) return 'deferred';
    const { sessionId, generation } = writer;
    const previous = Object.hasOwn(state.stores, sessionId) ? state.stores[sessionId] : undefined;
    for (const [id, item] of Object.entries(state.stores)) {
      const observed = inventory.get(id);
      if (!observed) continue;
      for (const file of observed) item.updatedAt = Math.max(item.updatedAt ?? 0, file.updatedAt);
    }
    if (previous) {
      if (generation < previous.generation || (inventory.has(sessionId) && !inventory.get(sessionId))
        || (previous.updatedAt !== undefined && !inventory.has(sessionId))) return 'deferred';
      if (generation > previous.generation) {
        const previousWriter = { sessionId, generation: previous.generation };
        const safeToReopen = previous.updatedAt === undefined
          ? await ports.writerSettled(previousWriter)
          : await ports.writerExited(previousWriter);
        if (!safeToReopen) return 'deferred';
      }
      if (signal?.aborted) return 'deferred';
      previous.generation = generation;
      await this.storage.put(STATE_KEY, state);
      return previous.updatedAt === undefined ? 'new' : 'existing';
    }
    if (Object.keys(state.stores).length >= LIMIT) {
      const stores = Object.entries(state.stores);
      if (stores.some(([id, item]) => inventory.get(id) === null
        || (item.updatedAt !== undefined && !inventory.has(id)))) return 'deferred';
      // Reservations count toward capacity but cannot be ranked as a saved store.
      const oldestSaved = stores.filter(([, item]) => item.updatedAt !== undefined).sort(([a, left], [b, right]) =>
        left.updatedAt! - right.updatedAt! || (a < b ? -1 : 1))[0];
      if (!oldestSaved) return 'deferred';
      const [oldestId] = oldestSaved;
      if (!SESSION_ID_PATTERN.test(oldestId) || signal?.aborted) return 'deferred';
      // A concurrent upload can change which prefix is oldest.
      const latest = await ports.observe(oldestId);
      if (signal?.aborted || latest === null
        || JSON.stringify(latest) !== JSON.stringify(inventory.get(oldestId) ?? 'absent')) return 'deferred';
      const prefix = `${HERMES_SESSION_ROOT}${oldestId}/`;
      state.eviction = { victim: oldestId, settled: false };
      await this.storage.put(STATE_KEY, state);
      let deleted: Awaited<ReturnType<Ports['evict']>>;
      try {
        deleted = await ports.evict(prefix);
      } catch {
        // The request has returned, not necessarily with a trustworthy result.
        // Reuse still requires an independent complete empty-prefix readback.
        deleted = false;
      }
      if (deleted === 'not-started') {
        delete state.eviction;
        await this.storage.put(STATE_KEY, state);
        return 'deferred';
      }
      state.eviction.settled = true;
      await this.storage.put(STATE_KEY, state);
      if (!deleted || !await ports.prefixEmpty(prefix)) return 'deferred';
      delete state.stores[oldestId];
      delete state.eviction;
    }
    state.stores[sessionId] = { generation };
    await this.storage.put(STATE_KEY, state);
    return signal?.aborted ? 'deferred' : 'new';
  }
}
