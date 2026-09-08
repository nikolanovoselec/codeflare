import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';

const resolveManagedEnvironment = vi.hoisted(() => vi.fn());

vi.mock('../../lib/remote-curation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/remote-curation')>()),
  resolveManagedEnvironment,
}));

import {
  appendManagedReconciliationTarget,
  getActiveManagedRelease,
  hasPendingManagedReconciliation,
  readManagedReconciliationTargets,
} from '../../lib/managed-release-active';

describe('getActiveManagedRelease', () => {
  beforeEach(() => {
    resolveManagedEnvironment.mockReset();
  });

  it('REQ-STOR-023 AC1: returns configured managed resource policy with the active descriptor', async () => {
    const pointer = { digest: 'd'.repeat(64), sequence: 4 };
    resolveManagedEnvironment.mockResolvedValue({
      config: { enabled: true, resourcePolicy: 'exclusive' },
      active: pointer,
    });

    const result = await getActiveManagedRelease({} as Env);

    expect(resolveManagedEnvironment).toHaveBeenCalledWith({ env: {}, requireFresh: false });
    expect(result).toEqual({ digest: 'd'.repeat(64), pointer, resourcePolicy: 'exclusive' });
  });
});

describe('managed reconciliation projection identity', () => {
  const target = {
    digest: 'd'.repeat(64),
    sequence: 9,
    mode: 'advanced' as const,
    projectionIdentity: 'v1:claude-code,pi',
  };

  it('REQ-STOR-023 AC1: accepts schema v1 with canonical agent order and rejects malformed projection identities', () => {
    expect(readManagedReconciliationTargets({ targets: [target] })).toEqual([target]);

    for (const projectionIdentity of [
      'v2:claude-code,pi',
      'v1:pi,claude-code',
      'v1:claude-code,unknown',
      'claude-code,pi',
    ]) {
      expect(() => readManagedReconciliationTargets({
        targets: [{ ...target, projectionIdentity }],
      })).toThrow('Managed reconciliation target state is invalid');
    }
  });

  it('REQ-STOR-035 AC2: accepts a legacy target without projection identity and keeps it pending for retry', () => {
    const legacy = {
      digest: 'c'.repeat(64),
      sequence: 8,
      mode: 'default' as const,
    };

    expect(readManagedReconciliationTargets({ targets: [legacy] })).toEqual([legacy]);
    expect(hasPendingManagedReconciliation({ targets: [legacy] })).toBe(true);
  });

  it('REQ-STOR-035 AC1: deduplicates only an exact release, mode, and projection identity', () => {
    const legacy = { digest: target.digest, sequence: 7, mode: target.mode };
    const previousProjection = { ...target, sequence: 8, projectionIdentity: 'v1:pi' };
    const replacement = { ...target, sequence: 10 };

    expect(appendManagedReconciliationTarget(
      [legacy, previousProjection, target] as any,
      replacement as any,
    )).toEqual([legacy, previousProjection, replacement]);
  });
});
