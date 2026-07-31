import { afterEach, describe, expect, it, vi } from 'vitest';

import nativeNotifications, { isPiRpcMode } from '../../../preseed/agents/pi/extensions/native-notifications';

type Handler = (event?: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<void> | void;

function notificationRuntime(argv: readonly string[] = ['/usr/local/bin/pi']) {
  const handlers = new Map<string, Handler>();
  const channels = new Map<string, (data: unknown) => void>();
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  nativeNotifications({
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    events: {
      on: (channel: string, handler: (data: unknown) => void) => {
        channels.set(channel, handler);
        return () => {};
      },
    },
  } as never, argv);
  return { handlers, channels, write };
}

describe('Pi native terminal notifications / REQ-TERM-024', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers no notification behavior and writes no terminal bytes in RPC mode', () => {
    expect(isPiRpcMode(['/usr/local/bin/pi', '--mode', 'rpc', '--no-session'])).toBe(true);
    expect(isPiRpcMode(['/usr/local/bin/pi'])).toBe(false);

    const { handlers, channels, write } = notificationRuntime([
      '/usr/local/bin/pi',
      '--mode',
      'rpc',
      '--no-session',
    ]);

    expect(handlers.size).toBe(0);
    expect(channels.size).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('emits fixed OSC 777 attention and settled notifications without prompt content', async () => {
    const { handlers, channels, write } = notificationRuntime();

    channels.get('rpiv:ask-user:prompt')?.({
      questions: [{ question: 'Include this secret?' }],
    });
    expect(write).toHaveBeenLastCalledWith(
      '\u001b]777;notify;Pi;Agent needs your input\u0007',
    );
    expect(String(write.mock.calls[0]?.[0])).not.toContain('Include this secret?');
    expect(handlers.has('agent_end')).toBe(false);
    expect(handlers.has('tool_call')).toBe(false);

    await handlers.get('agent_settled')?.();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('\u001b]777;notify;Pi;Ready for input\u0007');
  });

  it('suppresses stale completion after a cancelled question or aborted run', async () => {
    const cancelled = notificationRuntime();

    cancelled.channels.get('rpiv:ask-user:prompt')?.({ questions: [] });
    await cancelled.handlers.get('tool_result')?.({
      toolName: 'ask_user_question',
      details: { cancelled: true },
    });
    await cancelled.handlers.get('agent_settled')?.();

    expect(cancelled.write).toHaveBeenCalledOnce();
    expect(cancelled.write).toHaveBeenCalledWith(
      '\u001b]777;notify;Pi;Agent needs your input\u0007',
    );

    vi.restoreAllMocks();
    const aborted = notificationRuntime();
    const controller = new AbortController();
    await aborted.handlers.get('agent_start')?.({}, { signal: controller.signal });
    controller.abort();
    await aborted.handlers.get('agent_settled')?.();

    expect(aborted.write).not.toHaveBeenCalled();
  });
});
