import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import nativeNotifications, {
  isPiRpcMode,
} from '../../../preseed/agents/pi/extensions/native-notifications';

type Handler = () => Promise<void> | void;

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
  afterEach(() => {
    delete process.env.HERDR_ENV;
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

  it('registers no completion lifecycle producer in terminal mode', () => {
    const runtime = notificationRuntime();
    expect([...runtime.handlers.keys()]).toEqual(['agent_start']);
    expect([...runtime.channels.keys()]).toEqual(['rpiv:ask-user:prompt']);
  });

  it('emits at most one needs-input event per foreground run', async () => {
    const runtime = notificationRuntime();
    runtime.channels.get('rpiv:ask-user:prompt')?.({});
    runtime.channels.get('rpiv:ask-user:prompt')?.({});
    expect(runtime.write).toHaveBeenCalledOnce();

    await runtime.handlers.get('agent_start')?.();
    runtime.channels.get('rpiv:ask-user:prompt')?.({});
    expect(runtime.write).toHaveBeenCalledTimes(2);
  });
});
