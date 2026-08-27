import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import nativeNotifications, {
  isPiRpcMode,
  PI_IDLE_NOTIFICATION_DELAY_MS,
} from '../../../preseed/agents/pi/extensions/native-notifications';

type Handler = (
  event?: Record<string, unknown>,
  context?: { signal?: AbortSignal },
) => Promise<void> | void;

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

function assistant(stopReason: 'stop' | 'error' | 'aborted') {
  return {
    role: 'assistant',
    content: [],
    stopReason,
    errorMessage: stopReason === 'error' ? 'provider failed' : undefined,
  };
}

async function settle(
  runtime: ReturnType<typeof notificationRuntime>,
  stopReason: 'stop' | 'error' | 'aborted' = 'stop',
) {
  await runtime.handlers.get('agent_end')?.({ messages: [assistant(stopReason)] });
  await runtime.handlers.get('agent_settled')?.();
}

describe('Pi native terminal notifications / REQ-TERM-024', () => {
  afterEach(() => {
    delete process.env.HERDR_ENV;
    vi.useRealTimers();
    vi.restoreAllMocks();
    spawnMock.mockClear();
  });

  it('REQ-TERM-024 AC3: registers nothing and writes no bytes in RPC mode', () => {
    expect(isPiRpcMode(['/usr/local/bin/pi', '--mode', 'rpc', '--no-session'])).toBe(true);
    expect(isPiRpcMode(['/usr/local/bin/pi'])).toBe(false);

    const runtime = notificationRuntime(['/usr/local/bin/pi', '--mode', 'rpc', '--no-session']);
    expect(runtime.handlers.size).toBe(0);
    expect(runtime.channels.size).toBe(0);
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it('uses the fixed loopback helper instead of OSC bytes inside Herdr', () => {
    process.env.HERDR_ENV = '1';
    const runtime = notificationRuntime();
    runtime.channels.get('rpiv:ask-user:prompt')?.({ question: 'untrusted' });

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/local/bin/codeflare-agent-event',
      ['input-required'],
      { stdio: 'ignore' },
    );
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it('REQ-TERM-024 AC1: emits one fixed input-required frame without question content', () => {
    const runtime = notificationRuntime();
    runtime.channels.get('rpiv:ask-user:prompt')?.({
      questions: [{ question: 'Include this secret?' }],
    });

    expect(runtime.write).toHaveBeenCalledOnce();
    expect(runtime.write).toHaveBeenCalledWith(
      '\u001b]777;notify;Pi;Agent needs your input\u0007',
    );
    expect(String(runtime.write.mock.calls[0]?.[0])).not.toContain('Include this secret?');
  });

  it('REQ-TERM-029 AC1: emits completion only after five idle minutes', async () => {
    vi.useFakeTimers();
    expect(PI_IDLE_NOTIFICATION_DELAY_MS).toBe(300_000);
    const runtime = notificationRuntime();
    await runtime.handlers.get('input')?.({ source: 'interactive' });
    await runtime.handlers.get('agent_start')?.({}, { signal: new AbortController().signal });
    await settle(runtime, 'stop');

    expect(runtime.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(runtime.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.write).toHaveBeenCalledOnce();
    expect(runtime.write).toHaveBeenCalledWith(
      '\u001b]777;notify;Pi;Ready for input\u0007',
    );
  });

  it('REQ-TERM-029 AC2: delays structured failure until five idle minutes', async () => {
    vi.useFakeTimers();
    const runtime = notificationRuntime();
    await runtime.handlers.get('input')?.({ source: 'interactive' });
    await runtime.handlers.get('agent_start')?.({}, { signal: new AbortController().signal });
    await settle(runtime, 'error');

    expect(runtime.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runtime.write).toHaveBeenCalledOnce();
  });

  it.each([
    ['stop' as const, '\u001b]777;notify;Pi;Ready for input\u0007'],
    ['error' as const, '\u001b]777;notify;Pi;Task failed\u0007'],
  ])('REQ-TERM-024 AC2: completion and failure frames are fixed and inert', async (
    stopReason,
    expected,
  ) => {
    vi.useFakeTimers();
    const runtime = notificationRuntime();
    await runtime.handlers.get('input')?.({ source: 'interactive' });
    await runtime.handlers.get('agent_start')?.({}, { signal: new AbortController().signal });
    await settle(runtime, stopReason);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(runtime.write).toHaveBeenCalledWith(expected);
    expect(String(runtime.write.mock.calls[0]?.[0])).not.toContain('provider failed');
  });

  it.each([
    ['no input provenance', undefined],
    ['RPC-origin input', { source: 'rpc' }],
    ['extension-origin input', { source: 'extension' }],
  ])('REQ-TERM-029 AC6: absent interactive lineage emits no terminal signal', async (_name, input) => {
    vi.useFakeTimers();
    const runtime = notificationRuntime();
    if (input) await runtime.handlers.get('input')?.(input);
    await runtime.handlers.get('agent_start')?.({}, { signal: new AbortController().signal });
    await settle(runtime, 'stop');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it('REQ-TERM-029 AC3: reactivation restarts five idle minutes after settlement', async () => {
    vi.useFakeTimers();
    const runtime = notificationRuntime();
    await runtime.handlers.get('input')?.({ source: 'interactive' });
    await runtime.handlers.get('agent_start')?.({}, { signal: new AbortController().signal });
    await settle(runtime, 'stop');
    await vi.advanceTimersByTimeAsync(299_999);

    await runtime.handlers.get('input')?.({ source: 'extension', streamingBehavior: 'followUp' });
    await runtime.handlers.get('agent_start')?.({}, { signal: new AbortController().signal });
    await settle(runtime, 'stop');

    await vi.advanceTimersByTimeAsync(299_999);
    expect(runtime.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.write).toHaveBeenCalledOnce();
    expect(runtime.write).toHaveBeenCalledWith(
      '\u001b]777;notify;Pi;Ready for input\u0007',
    );
  });

  it('REQ-TERM-029 AC4: cancelled input emits no terminal signal', async () => {
    vi.useFakeTimers();
    const runtime = notificationRuntime();
    await runtime.handlers.get('input')?.({ source: 'interactive' });
    await runtime.handlers.get('agent_start')?.({}, { signal: new AbortController().signal });
    await runtime.handlers.get('tool_result')?.({
      toolName: 'ask_user_question',
      details: { cancelled: true },
    });
    await settle(runtime, 'stop');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it('REQ-TERM-029 AC5: aborted run emits no terminal signal', async () => {
    vi.useFakeTimers();
    const runtime = notificationRuntime();
    const controller = new AbortController();
    await runtime.handlers.get('input')?.({ source: 'interactive' });
    await runtime.handlers.get('agent_start')?.({}, { signal: controller.signal });
    controller.abort();
    await settle(runtime, 'aborted');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runtime.write).not.toHaveBeenCalled();
  });

  it('does not settle twice when agent_settled repeats without a new run', async () => {
    vi.useFakeTimers();
    const runtime = notificationRuntime();
    await runtime.handlers.get('input')?.({ source: 'interactive' });
    await runtime.handlers.get('agent_start')?.({}, { signal: new AbortController().signal });
    await settle(runtime, 'stop');
    await runtime.handlers.get('agent_settled')?.();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runtime.write).toHaveBeenCalledOnce();
  });
});
