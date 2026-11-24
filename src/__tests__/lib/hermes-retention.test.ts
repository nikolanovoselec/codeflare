import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { HermesRetention, type HermesFileObservation } from '../../lib/hermes-retention';

// The bucket-owner policy uses real DO storage. Only the remote bucket and
// generation-bound writer settlement evidence are represented by fixtures.
const oldIds = Array.from({ length: 10 }, (_, i) => `previous${i}`);
const newIds = ['incoming0', 'incoming1'];
const writer = (sessionId: string, generation = 1) => ({ sessionId, generation });
const prefix = (sessionId: string) => `Vault/Memory/Sessions/${sessionId}/`;
const digest = async (content: string) => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))),
  byte => byte.toString(16).padStart(2, '0'),
).join('');

async function withBucket(run: (bucket: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(namespace.getByName(`hermes-retention:${crypto.randomUUID()}`),
    async (_instance, state) => run(await fixture(state.storage)));
}

async function fixture(storage: DurableObjectStorage) {
  const stores = new Map<string, HermesFileObservation[]>();
  const incomplete = new Set<string>();
  const exited = new Map<string, number>();
  const objects = new Map<string, string>();
  const settled = new Map<string, number>();
  let inventoryComplete = true;
  let deletion: 'confirmed' | 'failed' | 'partial' | 'lost-reply' | 'rejected' = 'confirmed';
  let beforeDelete: (() => Promise<void>) | undefined;
  let now = 10_000;
  const ports = {
    canAdmit: async () => true,
    inventory: async () => inventoryComplete ? new Map([...stores]
      .map(([id, files]) => [id, incomplete.has(id) ? null : files] as const)) : null,
    observe: async (sessionId: string) => stores.get(sessionId)
      ?? ([...objects.keys()].some(key => key.startsWith(prefix(sessionId))) ? null : 'absent' as const),
    writerExited: async (identity: ReturnType<typeof writer>) => (exited.get(identity.sessionId) ?? settled.get(identity.sessionId)) === identity.generation,
    writerSettled: async (identity: ReturnType<typeof writer>) => settled.get(identity.sessionId) === identity.generation,
    evict: async (objectPrefix: string) => {
      const pause = beforeDelete;
      beforeDelete = undefined;
      await pause?.();
      if (deletion === 'failed') return false;
      const keys = [...objects.keys()].filter(key => key.startsWith(objectPrefix));
      for (const key of deletion === 'partial' ? keys.slice(0, 1) : keys) objects.delete(key);
      for (const sessionId of stores.keys()) {
        if (!objects.has(`${prefix(sessionId)}global/MEMORY.md`)) stores.delete(sessionId);
      }
      if (deletion === 'rejected') throw new Error('Lost delete response');
      return deletion === 'confirmed';
    },
    prefixEmpty: async (objectPrefix: string) => ![...objects.keys()].some(key => key.startsWith(objectPrefix)),
  };
  let retention = new HermesRetention(storage);
  const admit = (sessionId: string, generation = 1) => retention.admit(writer(sessionId, generation), ports);
  const sync = async (sessionId: string, content: string) => {
    const key = `${prefix(sessionId)}global/MEMORY.md`;
    if (objects.get(key) === content) return;
    objects.set(key, content);
    stores.set(sessionId, [{ digest: await digest(content), updatedAt: now }]);
  };
  return {
    stores, objects, admit, sync, settled, exited, incomplete,
    advance: () => { now++; },
    loseInventory: () => { inventoryComplete = false; },
    loseDeleteConfirmation: (effect: 'failed' | 'partial' | 'lost-reply' | 'rejected' = 'failed') => { deletion = effect; },
    holdNextDeletion(afterEffect = false) {
      let started!: () => void;
      let release!: () => void;
      const deleting = new Promise<void>(resolve => { started = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      beforeDelete = async () => {
        if (afterEffect) {
          const victim = oldIds[0];
          for (const key of objects.keys()) if (key.startsWith(prefix(victim))) objects.delete(key);
          stores.delete(victim);
        }
        started();
        await held;
      };
      return { deleting, release };
    },
    reopenOwner: () => { retention = new HermesRetention(storage); },
    async fill() {
      for (const id of oldIds) {
        expect(await admit(id)).toBe('new');
        await sync(id, 'Shared seeds');
        now++;
        await sync(id, `Edited Markdown for ${id}`);
        settled.set(id, 1);
      }
    },
  };
}

it('REQ-MEM-042 AC1: overlapping admissions evict distinct least recently updated stores', async () => {
  await withBucket(async f => {
    await f.fill();
    f.reopenOwner();
    // Both starts reserve before the entrypoints can publish Markdown.
    const decisions = await Promise.all(newIds.map(id => f.admit(id)));
    expect(decisions).toEqual(newIds.map(() => 'new'));
    for (const id of newIds) await f.sync(id, 'Shared seeds');
    expect([...f.stores.keys()].sort()).toEqual([...oldIds.slice(2), ...newIds].sort());
  });
});

it('REQ-MEM-042 AC1: an upload racing the next admission does not reuse a slot', async () => {
  await withBucket(async f => {
    await f.fill();
    const decisions = await Promise.all(newIds.map(async id => {
      const decision = await f.admit(id);
      if (decision === 'new') await f.sync(id, 'Shared seeds');
      return decision;
    }));
    expect(decisions).toEqual(newIds.map(() => 'new'));
    expect([...f.stores.keys()].sort()).toEqual([...oldIds.slice(2), ...newIds].sort());
  });
});

it('REQ-MEM-042 AC2: an unchanged later sync does not touch rank, but an actual Markdown edit does', async () => {
  await withBucket(async f => {
    await f.fill();
    const [edited, unchanged] = oldIds;
    f.advance();
    expect(await f.admit(edited, 2)).toBe('existing');
    await f.sync(edited, 'New Markdown edit');
    f.settled.set(edited, 2);
    f.advance();
    expect(await f.admit(unchanged, 2)).toBe('existing');
    await f.sync(unchanged, `Edited Markdown for ${unchanged}`);
    f.settled.set(unchanged, 2);
    expect(await f.admit(newIds[0])).toBe('new');
    expect(f.stores.has(edited)).toBe(true);
    expect(f.stores.has(unchanged)).toBe(false);
  });
});

it('REQ-MEM-042 AC2: a change back to previously observed bytes still counts as an update', async () => {
  await withBucket(async f => {
    await f.fill();
    const [edited, nextOldest] = oldIds;
    f.advance();
    expect(await f.admit(edited, 2)).toBe('existing');
    await f.sync(edited, 'A different intermediate fact');
    f.advance();
    await f.sync(edited, `Edited Markdown for ${edited}`);
    f.settled.set(edited, 2);
    expect(await f.admit(newIds[0])).toBe('new');
    expect(f.stores.has(edited)).toBe(true);
    expect(f.stores.has(nextOldest)).toBe(false);
  });
});

it('REQ-MEM-042 AC2: sessions with equal content-update times evict by ascending session ID', async () => {
  await withBucket(async f => {
    for (const id of [...oldIds].reverse()) {
      expect(await f.admit(id)).toBe('new');
      await f.sync(id, `Different edited Markdown for ${id}`);
      f.settled.set(id, 1);
    }
    expect(await f.admit(newIds[0])).toBe('new');
    expect([...f.stores.keys()].sort()).toEqual(oldIds.slice(1));
  });
});

it('REQ-MEM-042 AC4: eviction removes the entire exact memory folder without touching siblings', async () => {
  await withBucket(async f => {
    await f.fill();
    const victim = prefix(oldIds[0]);
    f.objects.set(`${victim}Projects/workspace/MEMORY.md`, 'Project fact');
    f.objects.set(`${victim}checkpoint.json`, 'Earlier checkpoint');
    const survivor = new Map([
      [`${prefix(`${oldIds[0]}extra`)}checkpoint.json`, 'A checkpoint-only sibling'],
      ['Vault/Memory/MEMORY.md', 'Shared master'],
      ['Vault/Notes/side.md', 'Unrelated Vault note'],
    ]);
    for (const [key, bytes] of survivor) f.objects.set(key, bytes);
    expect(await f.admit(newIds[0])).toBe('new');
    expect([...f.objects.keys()].filter(key => key.startsWith(victim))).toEqual([]);
    for (const [key, bytes] of survivor) expect(f.objects.get(key)).toBe(bytes);
  });
});

it.each([false, true])('REQ-MEM-042 AC4: a held deletion cannot free a slot after owner reconstruction (empty prefix=%s)', async empty => {
  await withBucket(async f => {
    await f.fill();
    const held = f.holdNextDeletion(empty);
    const first = f.admit(newIds[0]);
    try {
      // If admission never attempts eviction, surface the returned decision
      // as a test failure rather than waiting indefinitely on the fixture.
      expect(await Promise.race([held.deleting.then(() => 'deleting'), first])).toBe('deleting');
      f.reopenOwner();
      expect(await f.admit(newIds[1])).toBe('deferred');
      expect([...f.stores.keys()].sort()).toEqual(empty ? oldIds.slice(1) : oldIds);
    } finally {
      held.release();
      await first;
    }
    expect(await first).toBe('new');
    await f.sync(newIds[0], 'Shared seeds');
    expect([...f.stores.keys()].sort()).toEqual([...oldIds.slice(1), newIds[0]].sort());
  });
});

it.each(['partial', 'lost-reply', 'rejected'] as const)('REQ-MEM-042 AC4: an unconfirmed %s deletion requires empty-prefix readback', async mode => {
  await withBucket(async f => {
    await f.fill();
    f.objects.set(`${prefix(oldIds[0])}Projects/workspace/MEMORY.md`, 'Project fact');
    f.loseDeleteConfirmation(mode);
    expect(await f.admit(newIds[0])).toBe('deferred');
    expect([...f.stores.keys()].sort()).toEqual(oldIds.slice(1));
    const remaining = [...f.objects.keys()].filter(key => key.startsWith(prefix(oldIds[0])));
    expect(remaining).toEqual(mode === 'partial' ? [`${prefix(oldIds[0])}Projects/workspace/MEMORY.md`] : []);
    f.reopenOwner();
    expect(await f.admit(newIds[1])).toBe(mode === 'partial' ? 'deferred' : 'new');
    expect([...f.stores.keys()].sort()).toEqual(oldIds.slice(1));
  });
});

it('REQ-MEM-041 AC7: a confirmed evicted store can be admitted as new', async () => {
  await withBucket(async f => {
    await f.fill();
    expect(await f.admit(newIds[0])).toBe('new');
    await f.sync(newIds[0], 'Initial store');
    expect(f.stores.has(oldIds[0])).toBe(false);
    expect(await f.admit(oldIds[0], 2)).toBe('new');
    await f.sync(oldIds[0], 'Current shared masters');
    expect(f.objects.get(`${prefix(oldIds[0])}global/MEMORY.md`)).toBe('Current shared masters');
    expect(f.stores.size).toBe(10);
  });
});

it('REQ-MEM-042 AC4: a superseded writer cannot reopen an admitted store', async () => {
  await withBucket(async f => {
    await f.fill();
    const id = oldIds[0];
    expect(await f.admit(id, 2)).toBe('existing');
    const before = new Map(f.stores);
    expect(await f.admit(id, 1)).toBe('deferred');
    expect(f.stores).toEqual(before);
  });
});

it.each([undefined, 2])('REQ-MEM-042 AC3: rotates the oldest prefix without a matching final-save receipt (%s)', async receipt => {
  await withBucket(async f => {
    await f.fill();
    const oldest = oldIds[0];
    f.settled.delete(oldest);
    if (receipt !== undefined) f.settled.set(oldest, receipt);
    expect(await f.admit(newIds[0])).toBe('new');
    await f.sync(newIds[0], 'New session memory');
    expect([...f.stores.keys()].sort()).toEqual([...oldIds.slice(1), newIds[0]].sort());
  });
});

it.each(['incomplete-inventory', 'unconfirmed-deletion'] as const)(
  'REQ-MEM-042 AC4: does not reuse a slot on %s', async refusal => {
    await withBucket(async f => {
      await f.fill();
      if (refusal === 'incomplete-inventory') f.loseInventory();
      if (refusal === 'unconfirmed-deletion') f.loseDeleteConfirmation();
      expect(await f.admit(newIds[0])).toBe('deferred');
      f.reopenOwner();
      expect(await f.admit(newIds[1])).toBe('deferred');
      expect([...f.stores.keys()].sort()).toEqual(oldIds);
    });
  },
);

it('REQ-MEM-042 AC4: an incomplete non-victim observation blocks eviction', async () => {
  await withBucket(async f => {
    await f.fill();
    f.incomplete.add(oldIds[9]);
    expect(await f.admit(newIds[0])).toBe('deferred');
    expect([...f.stores.keys()].sort()).toEqual(oldIds);
  });
});

it('REQ-MEM-041 AC6: confirmed exit after failed final sync allows reopening', async () => {
  await withBucket(async f => {
    await f.fill();
    const oldest = oldIds[0];
    const previous = f.objects.get(`${prefix(oldest)}global/MEMORY.md`);
    f.settled.delete(oldest);
    expect(await f.admit(oldest, 2)).toBe('deferred');
    f.exited.set(oldest, 1);
    expect(await f.admit(oldest, 2)).toBe('existing');
    expect(f.objects.get(`${prefix(oldest)}global/MEMORY.md`)).toBe(previous);
  });
});
