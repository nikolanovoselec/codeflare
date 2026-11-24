import { afterEach, expect, it, vi } from 'vitest';
import { getPiWebStatus } from '../../api/pi-web';

afterEach(() => vi.unstubAllGlobals());

it('REQ-AGENT-272 AC3: accepts stopping as an in-progress switch status from Host', async () => {
  const status = {
    phase: 'stopping',
    surface: 'terminal',
    target: 'chat',
    requestId: 'c0c0834e-9063-411c-9c36-0372b36f25a4',
  };
  vi.stubGlobal('fetch', async () => Response.json(status));

  await expect(getPiWebStatus('abcdef1234567890', 7, new AbortController().signal)).resolves.toEqual(status);
});
