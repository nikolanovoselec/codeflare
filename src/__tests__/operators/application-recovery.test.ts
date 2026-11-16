/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { ApplicationStateStore, type StateRecord } from '../../operators/application-state';
import { applicationRecoveryPrefix, inspectRecoveryRecord, recoveryDigest, recoveryInventoryPage } from '../../operators/application-recovery';

const sourceId = '23', ownerKey = 'a'.repeat(64);
const key = `renovate:head:44:1:${'b'.repeat(40)}`;
const alias = `renovate-admission:44:1:${'b'.repeat(40)}`;
const origin = { sourceId, ownerKey, installationId: 'installed', activityId: 'original', generation: 1, deadline: 1 };
const withStorage = async (run: (storage: DurableObjectStorage) => Promise<void>) => {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_, state) => run(state.storage));
};
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe('recovery inventory preserves ownership and state-version contracts', () => {
  it.each(['owned', 'owner', 'source', 'legacy-drift', 'malformed'] as const)('%s overlay is classified without foreign bytes', name => withStorage(async storage => {
    const prefix = await applicationRecoveryPrefix(sourceId);
    const record: StateRecord = { ...origin, schemaVersion: 1, key,
      ...(name === 'owner' ? { ownerKey: 'c'.repeat(64) } : {}),
      ...(name === 'source' ? { sourceId: '98' } : {}),
      legacy: { storageKey: alias, version: null }, value: { secret: 'ORIGINAL_PRIVATE' } };
    if (name === 'legacy-drift') record.legacy!.version = 'd'.repeat(64);
    await storage.put(`${prefix}${await recoveryDigest(key)}`, name === 'malformed' ? { value: 'FOREIGN_PRIVATE' } : record);
    const result = await inspectRecoveryRecord(storage, key, sourceId, ownerKey, async () => null);
    expect(result.record.reason).toBe({ owned: 'proof-required', owner: 'owner-mismatch', source: 'source-mismatch',
      'legacy-drift': 'legacy-version-drift', malformed: 'malformed' }[name]);
    if (name !== 'owned') {
      expect(result.record.value).toBeUndefined();
      expect(result.original).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    } else {
      const live = { ...origin, activityId: 'live', deadline: Date.now() + 60_000 };
      const store = new ApplicationStateStore(storage, live, { authorize: async () => true,
        validateSnapshot: () => true, resolveLegacy: () => ({ storageKey: alias, validate: () => 'owned' }) });
      expect(await store.read([key])).toEqual([{ key, status: 'value', value: record.value, version: result.record.version }]);
    }
  }));

  it('paginates more than 64 modern and legacy records without duplicates or silent truncation', () => withStorage(async storage => {
    const prefix = await applicationRecoveryPrefix(sourceId);
    for (let index = 1; index <= 70; index++) {
      const itemKey = `renovate:head:44:${index}:${'b'.repeat(40)}`;
      await storage.put(`renovate-admission:44:${index}:${'b'.repeat(40)}`, { ownerKey, activityId: `old-${index}` });
      if (index <= 65) await storage.put(`${prefix}${await recoveryDigest(itemKey)}`, {
        ...origin, schemaVersion: 1, key: itemKey, legacy: null, value: { index },
      });
    }
    await storage.put(`${prefix}audit:test`, { requestId: 'audit' });
    const found: string[] = [];
    let after: string | undefined;
    do {
      const page = await recoveryInventoryPage(storage, sourceId, after);
      expect(page.keys.length).toBeLessThanOrEqual(64);
      found.push(...page.keys);
      after = page.nextCursor ?? undefined;
    } while (after);
    expect(found).toHaveLength(70);
    expect(new Set(found).size).toBe(70);
  }));

  it('refuses oversized stored payloads instead of manufacturing a version', () => withStorage(async storage => {
    const prefix = await applicationRecoveryPrefix(sourceId);
    await storage.put(`${prefix}${await recoveryDigest(key)}`, { ...origin, schemaVersion: 1, key, legacy: null, value: 'x'.repeat(65536) });
    await expect(inspectRecoveryRecord(storage, key, sourceId, ownerKey, async () => null)).rejects.toThrow('exceeds limit');
  }));

  it.each(['owner-mismatch', 'source-mismatch', 'malformed'])('returns opaque %s for legacy records', reason => withStorage(async storage => {
    await storage.put(alias, { ownerKey, activityId: 'old', installationId: 'installed', repositoryId: 44,
      pullRequest: 1, head: 'b'.repeat(40), private: 'PRIVATE_FOREIGN' });
    const item = await inspectRecoveryRecord(storage, key, sourceId, ownerKey, async () => reason);
    expect(item.record.reason).toBe(reason);
    expect(item.record.value).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('PRIVATE_FOREIGN');
  }));
});
