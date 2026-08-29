import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';

const resolveManagedEnvironment = vi.hoisted(() => vi.fn());

vi.mock('../../lib/remote-curation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/remote-curation')>()),
  resolveManagedEnvironment,
}));

import { getActiveManagedRelease } from '../../lib/managed-release-active';

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
