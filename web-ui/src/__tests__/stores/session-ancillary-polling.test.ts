import { describe, expect, it, vi } from 'vitest';
import { createSessionPollingOwners } from '../../stores/session-polling-owners';

describe('REQ-SESSION-010 AC7: ancillary polling separation', () => {
  it('frequent projection calls only batch status and never ancillary owners', async () => {
    const api = {
      getBatchStatus: vi.fn(async () => ({ sessions: [], generation: 1 })),
      getUsage: vi.fn(),
      getStorage: vi.fn(),
      getEntitlement: vi.fn(),
      getManagedRelease: vi.fn(),
      getPreseed: vi.fn(),
      advanceMigration: vi.fn(),
    };
    const owners = createSessionPollingOwners(api);
    await owners.refreshProjection();
    await owners.refreshProjection();
    expect(api.getBatchStatus).toHaveBeenCalledTimes(2);
    expect(api.getUsage).not.toHaveBeenCalled();
    expect(api.getStorage).not.toHaveBeenCalled();
    expect(api.getEntitlement).not.toHaveBeenCalled();
    expect(api.getManagedRelease).not.toHaveBeenCalled();
    expect(api.getPreseed).not.toHaveBeenCalled();
    expect(api.advanceMigration).not.toHaveBeenCalled();
  });

  it('has one explicit initial/slower ancillary owner and no duplicate in-flight refresh', async () => {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const api = {
      getBatchStatus: vi.fn(),
      getUsage: vi.fn(async () => pending),
      getStorage: vi.fn(async () => pending),
      getEntitlement: vi.fn(async () => pending),
      getManagedRelease: vi.fn(async () => pending),
      getPreseed: vi.fn(async () => pending),
      advanceMigration: vi.fn(async () => pending),
    };
    const owners = createSessionPollingOwners(api);
    const first = owners.refreshAncillary();
    const duplicate = owners.refreshAncillary();
    expect(duplicate).toBe(first);
    settle();
    await first;
    for (const call of [api.getUsage, api.getStorage, api.getEntitlement, api.getManagedRelease, api.getPreseed, api.advanceMigration]) {
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it('retains last good ancillary values when a later refresh fails', async () => {
    const api = {
      getBatchStatus: vi.fn(),
      getUsage: vi.fn().mockResolvedValueOnce({ seconds: 10 }).mockRejectedValueOnce(new Error('usage unavailable')),
      getStorage: vi.fn(async () => ({ bytes: 20 })),
      getEntitlement: vi.fn(async () => ({ tier: 'standard' })),
      getManagedRelease: vi.fn(async () => null),
      getPreseed: vi.fn(async () => ({ digest: 'abc' })),
      advanceMigration: vi.fn(async () => ({ pending: false })),
    };
    const owners = createSessionPollingOwners(api);
    await owners.refreshAncillary();
    const first = owners.getAncillarySnapshot();
    await owners.refreshAncillary();
    const failed = owners.getAncillarySnapshot();
    expect(failed.usage).toEqual(first.usage);
    expect(failed.error).toBeTruthy();
  });
});
