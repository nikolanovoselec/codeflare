import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getContainer, listRunningSessionIds } = vi.hoisted(() => ({
  getContainer: vi.fn(),
  listRunningSessionIds: vi.fn(),
}));
vi.mock('@cloudflare/containers', () => ({ getContainer }));
vi.mock('../../lib/session-helpers', () => ({ listRunningSessionIds }));

import { drainContainers } from '../../lib/migration-containers';

describe('REQ-ENTERPRISE-021 AC3: governed migration container drain', () => {
  beforeEach(() => vi.clearAllMocks());

  it('destroys every running session container and does nothing when none are running', async () => {
    const first = { destroy: vi.fn().mockResolvedValue(undefined) };
    const second = { destroy: vi.fn().mockResolvedValue(undefined) };
    listRunningSessionIds.mockResolvedValueOnce(['session-a', 'session-b']);
    getContainer.mockReturnValueOnce(first).mockReturnValueOnce(second);
    await drainContainers({ USAGE_DB: {} as D1Database, CONTAINER: {} as DurableObjectNamespace } as never, 'bucket-a');
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.destroy).toHaveBeenCalledOnce();

    listRunningSessionIds.mockResolvedValueOnce([]);
    await drainContainers({ USAGE_DB: {} as D1Database, CONTAINER: {} as DurableObjectNamespace } as never, 'bucket-a');
    expect(getContainer).toHaveBeenCalledTimes(2);
  });
});
