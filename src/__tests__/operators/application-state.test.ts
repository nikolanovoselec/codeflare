/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it } from 'vitest';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { ApplicationStateStore, type ApplicationStateBinding } from '../../operators/application-state';
import { applicationRecoveryPrefix, recoveryDigest } from '../../operators/application-recovery';

const key = `renovate:head:44:17:${'b'.repeat(40)}`;
const aliasKey = `renovate-admission:44:17:${'b'.repeat(40)}`;
afterEach(async () => { await reset(); });

async function fixture(run: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_, state) => run(await seed(state.storage)));
}
async function seed(storage: DurableObjectStorage) {
  const a: ApplicationStateBinding = { sourceId: '23', installationId: 'install', ownerKey: 'a'.repeat(64),
    activityId: 'activity-a', generation: 1, deadline: Date.now() + 60_000 };
  const b = { ...a, ownerKey: 'b'.repeat(64), activityId: 'activity-b', generation: 2 };
  const legacy = { sourceId: a.sourceId, installationId: a.installationId, ownerKey: a.ownerKey,
    activityId: 'old', private: 'PRIVATE_ORIGINAL' };
  await storage.put(aliasKey, legacy);
  const storageKey = `${await applicationRecoveryPrefix(a.sourceId)}${await recoveryDigest(key)}`;
  const store = (binding: ApplicationStateBinding) => new ApplicationStateStore(storage, binding, {
    authorize: async () => true, validateSnapshot: () => true,
    resolveLegacy: requested => requested === key ? { storageKey: aliasKey, validate: record => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return 'unavailable';
      const value = record as Record<string, unknown>;
      if (typeof value.ownerKey !== 'string' || typeof value.sourceId !== 'string'
        || typeof value.installationId !== 'string') return 'unavailable';
      if (value.ownerKey !== binding.ownerKey || value.sourceId !== binding.sourceId
        || value.installationId !== binding.installationId) return 'conflict';
      return typeof value.activityId === 'string' ? 'owned' : 'unavailable';
    } } : null,
  });
  const owner = store(a), other = store(b);
  const exchange = (target: ApplicationStateStore, version: string | null, value: { [key: string]: string }) =>
    target.compareExchange({ expected: [{ key, version }], writes: [{ key, value }] });
  return { storage, storageKey, legacy, a, b, owner, other, exchange };
}

// REQ-OPERATOR-210 AC3/4 and REQ-DISPATCHER-003 AC2/7: only the real
// Registry recovery transaction (covered in registry-application-recovery.test)
// can authorize vacancy. Application JSON alone must never do so.
describe('application state refuses unverified release and foreign evidence', () => {
  it.each(['active', 'reset'] as const)('an owner-written %s value cannot release its head to another principal', state => fixture(async f => {
    const [legacy] = await f.owner.read([key]);
    expect(legacy).toEqual({ key, status: 'value', version: expect.stringMatching(/^[a-f0-9]{64}$/), value: f.legacy });
    if (legacy.status !== 'value') throw Error('Owner cannot read its legacy state');
    expect(await f.exchange(f.owner, legacy.version, { state, private: 'PRIVATE_PACKAGE_VALUE' })).toEqual({ status: 'committed' });
    const [owned] = await f.owner.read([key]);
    if (owned.status !== 'value') throw Error('Owner cannot read its state');
    const before = await f.storage.list();
    expect(await f.other.read([key])).toEqual([{ key, status: 'conflict' }]);
    expect(await f.exchange(f.other, owned.version, { state: 'active' })).toEqual({ status: 'conflict' });
    expect(await f.exchange(f.other, null, { state: 'active' })).toEqual({ status: 'conflict' });
    expect(await f.owner.read([key])).toEqual([owned]);
    expect(await f.storage.list()).toEqual(before);
  }));

  it.each(['malformed-envelope', 'malformed-alias'] as const)('%s is unavailable, not absence or vacancy, and cannot authorize any writes', kind => fixture(async f => {
    if (kind === 'malformed-envelope') await f.storage.put(f.storageKey, { value: { state: 'reset', private: 'PRIVATE_MALFORMED' } });
    else await f.storage.put(aliasKey, { state: 'reset', private: 'PRIVATE_MALFORMED' });
    const before = await f.storage.list();
    await expect(f.owner.read([key])).rejects.toMatchObject({ code: 'unavailable', message: 'Application state unavailable' });
    await expect(f.other.read([key])).rejects.toMatchObject({ code: 'unavailable', message: 'Application state unavailable' });
    await expect(f.owner.compareExchange({ expected: [{ key: 'unrelated', version: null }, { key, version: null }],
      writes: [{ key: 'unrelated', value: 'must-not-commit' }, { key, value: { state: 'active' } }] })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await f.storage.list()).toEqual(before);
    expect(await f.owner.read(['unrelated'])).toEqual([{ key: 'unrelated', status: 'absent', version: null }]);
  }));

  it('alias drift cannot convert an ordinary owner-written reset into vacancy or replace either historical copy', () => fixture(async f => {
    const [legacy] = await f.owner.read([key]);
    if (legacy.status !== 'value') throw Error('Expected owned legacy value');
    expect(await f.exchange(f.owner, legacy.version, { state: 'reset' })).toEqual({ status: 'committed' });
    const [reset] = await f.owner.read([key]);
    if (reset.status !== 'value') throw Error('Expected owned reset marker');
    await f.storage.put(aliasKey, { ...f.legacy, private: 'PRIVATE_CHANGED_HISTORY' });
    const before = await f.storage.list();
    expect(await f.owner.read([key])).toEqual([{ key, status: 'conflict' }]);
    expect(await f.other.read([key])).toEqual([{ key, status: 'conflict' }]);
    expect(await f.exchange(f.owner, reset.version, { state: 'active' })).toEqual({ status: 'conflict' });
    expect(await f.exchange(f.other, reset.version, { state: 'active' })).toEqual({ status: 'conflict' });
    expect(await f.storage.list()).toEqual(before);
  }));
});
