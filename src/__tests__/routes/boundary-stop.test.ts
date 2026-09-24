import { describe, expect, it } from 'vitest';
import { fencePendingBoundaryStart } from '../../routes/session/boundary-stop';
import type { Env } from '../../types';
import type { D1Session, D1SessionRepository } from '../../lib/session-repository';

const session = { ownerKey: 'owner', sessionId: 'session123', lifecycleGeneration: 3,
  lifecycleState: 'stopping', boundaryActivityId: 'activity123' } as D1Session;
const binding = { repositoryId: 1, pullRequest: 2, contextDigest: 'a'.repeat(64),
  session: { bucket: 'owner', sessionId: 'session123', generation: 3 } };

function fixture(resolved: typeof binding | null = binding, cancelled = true) {
  let acknowledged = false;
  let fenced = false;
  const activity = {
    getBoundaryStartBinding: async () => resolved,
    cancelBoundaryStart: async () => { fenced = cancelled; return { ok: cancelled }; },
  };
  const env = { OPERATOR_ACTIVITY: { getByName: () => activity } } as unknown as Env;
  const repository = { acknowledgeBoundaryCancellation: async () => {
    if (!fenced) throw new Error('Acknowledgement preceded durable cancellation');
    acknowledged = true;
    return true;
  } } as unknown as D1SessionRepository;
  return { env, repository, wasAcknowledged: () => acknowledged, wasFenced: () => fenced };
}

describe('Stop boundary admission fence', () => {
  it('fences the exact pending activity before clearing D1 pending identity', async () => {
    const f = fixture();
    await fencePendingBoundaryStart(f.env, f.repository, session);
    expect(f.wasFenced()).toBe(true);
    expect(f.wasAcknowledged()).toBe(true);
  });

  it('preserves pending identity when binding is absent or belongs to another generation', async () => {
    for (const candidate of [null, { ...binding, session: { ...binding.session, generation: 4 } }]) {
      const f = fixture(candidate);
      await expect(fencePendingBoundaryStart(f.env, f.repository, session)).rejects.toThrow();
      expect(f.wasAcknowledged()).toBe(false);
      expect(f.wasFenced()).toBe(false);
    }
  });

  it('does not clear D1 pending identity when Activity cancellation is unconfirmed', async () => {
    const f = fixture(binding, false);
    await expect(fencePendingBoundaryStart(f.env, f.repository, session)).rejects.toThrow();
    expect(f.wasAcknowledged()).toBe(false);
  });
});
