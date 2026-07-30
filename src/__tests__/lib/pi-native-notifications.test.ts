import { afterEach, describe, expect, it, vi } from 'vitest';

import nativeNotifications from '../../../preseed/agents/pi/extensions/native-notifications';

describe('Pi native terminal notifications / REQ-TERM-023', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits one OSC 777 ready notification only when the agent is fully settled', async () => {
    const handlers = new Map<string, () => Promise<void>>();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    nativeNotifications({
      on: (event: string, handler: () => Promise<void>) => { handlers.set(event, handler); },
    } as never);

    expect(handlers.has('agent_end')).toBe(false);
    await handlers.get('agent_settled')?.();

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith('\u001b]777;notify;Pi;Ready for input\u0007');
  });
});
