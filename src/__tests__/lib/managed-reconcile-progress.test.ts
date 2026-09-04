import { describe, expect, it, vi } from 'vitest';
import {
  clearMatchingManagedReconcileProgress,
  readManagedReconcileProgress,
  writeManagedReconcileProgress,
} from '../../lib/managed-reconcile-progress';

const targetDigest = 'd'.repeat(64);
const progress = {
  targetDigest,
  phase: 'writing' as const,
  completed: 25,
  total: 50,
};

describe('managed reconciliation progress / REQ-STOR-034', () => {
  it('REQ-STOR-034 AC1: progress write failure remains observational', async () => {
    const kv = {
      get: vi.fn(),
      put: vi.fn().mockRejectedValue(new Error('KV write failed')),
      delete: vi.fn(),
    } as unknown as KVNamespace;

    await expect(writeManagedReconcileProgress(kv, 'bucket', progress)).resolves.toBeUndefined();
  });

  it('REQ-STOR-036 AC3: progress read failure remains observational', async () => {
    const kv = {
      get: vi.fn().mockRejectedValue(new Error('KV read failed')),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KVNamespace;

    await expect(readManagedReconcileProgress(kv, 'bucket')).resolves.toBeUndefined();
  });

  it('REQ-STOR-034 AC7: progress cleanup failure cannot change applied reconciliation outcome', async () => {
    const kv = {
      get: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        ...progress,
        updatedAt: '2026-08-31T12:00:00.000Z',
      }),
      put: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error('KV delete failed')),
    } as unknown as KVNamespace;

    await expect(clearMatchingManagedReconcileProgress(kv, 'bucket', targetDigest)).resolves.toBeUndefined();
  });
});
