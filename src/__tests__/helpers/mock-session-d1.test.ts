import { describe, expect, it } from 'vitest';
import { D1SessionRepository } from '../../lib/session-repository';
import { createMockKV } from './mock-kv';
import { createMockSessionD1 } from './mock-session-d1';

describe('shared D1 fake boundary release', () => {
  it('releases completed running actions and acknowledges stopping cancellation under their distinct guards', async () => {
    const kv = createMockKV();
    const key = 'session:owner:session01';
    const base = { id: 'session01', userId: 'owner', lifecycleGeneration: 2,
      boundaryActivityId: 'activity-1', createdAt: '2026-01-01T00:00:00Z', lastAccessedAt: '2026-01-01T00:00:00Z' };
    const repository = new D1SessionRepository(createMockSessionD1(kv));

    kv._set(key, { ...base, status: 'running' });
    expect(await repository.acknowledgeBoundaryCancellation('owner', 'session01', 2, 'activity-1')).toBe(false);
    expect(await repository.releaseCompletedBoundaryAction('owner', 'session01', 2, 'activity-1')).toBe(true);
    expect((await repository.getSession('owner', 'session01'))?.boundaryActivityId).toBeUndefined();

    kv._set(key, { ...base, status: 'stopping', terminationIntentId: 'intent-1' });
    expect(await repository.releaseCompletedBoundaryAction('owner', 'session01', 2, 'activity-1')).toBe(false);
    expect(await repository.acknowledgeBoundaryCancellation('owner', 'session01', 2, 'activity-1')).toBe(true);
    expect((await repository.getSession('owner', 'session01'))?.boundaryActivityId).toBeUndefined();
  });
});
