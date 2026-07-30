import { describe, expect, it, vi } from 'vitest';

import {
  enableAgentNotifications,
  parseAgentNotification,
  showAgentNotification,
  type AgentNotificationBrowser,
} from '../../lib/agent-notifications';

const context = Object.freeze({
  agentType: 'pi' as const,
  terminalId: '1',
  sessionName: 'Matrix',
});

function browser(overrides: Partial<AgentNotificationBrowser> = {}): AgentNotificationBrowser {
  return {
    permission: () => 'granted',
    requestPermission: vi.fn(async () => 'granted'),
    registerWorker: vi.fn(async () => ({ showNotification: vi.fn(async () => undefined) })),
    getWorker: vi.fn(async () => ({ showNotification: vi.fn(async () => undefined) })),
    ...overrides,
  };
}

describe('native agent browser notifications / REQ-TERM-023', () => {
  it('converts one native OSC 777 notification into bounded inert text for terminal 1', () => {
    expect(parseAgentNotification('notify;Pi;Ready for input', context)).toEqual({
      title: 'Pi · Matrix',
      body: 'Ready for input',
      sessionUrl: window.location.href,
    });
  });

  it.each([
    ['unsupported agent', { ...context, agentType: 'bash' as const }, 'notify;Pi;Ready'],
    ['other terminal', { ...context, terminalId: '2' }, 'notify;Pi;Ready'],
    ['missing title', context, 'notify;;Ready'],
    ['missing body', context, 'notify;Pi;'],
    ['unexpected operation', context, 'open;Pi;Ready'],
    ['control-bearing title', context, 'notify;Pi\nspoof;Ready'],
    ['control-bearing body', context, 'notify;Pi;Ready\u001b[31m'],
    ['oversized title', context, `notify;${'p'.repeat(65)};Ready`],
    ['oversized composed title', { ...context, sessionName: 's'.repeat(60) }, 'notify;Pi;Ready'],
    ['oversized body', context, `notify;Pi;${'é'.repeat(129)}`],
  ])('rejects %s', (_name, notificationContext, payload) => {
    expect(parseAgentNotification(payload, notificationContext)).toBeUndefined();
  });

  it('shows one validated event through an existing service-worker registration', async () => {
    const showNotification = vi.fn(async () => undefined);
    const env = browser({
      getWorker: vi.fn(async () => ({ showNotification })),
    });

    await showAgentNotification('notify;Claude Code;Task complete', {
      agentType: 'claude-code',
      terminalId: '1',
      sessionName: 'Nebuchadnezzar',
    }, env);

    expect(showNotification).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith('Claude Code · Nebuchadnezzar', {
      body: 'Task complete',
      data: { sessionUrl: window.location.href },
    });
    expect(env.requestPermission).not.toHaveBeenCalled();
    expect(env.registerWorker).not.toHaveBeenCalled();
  });

  it.each(['default', 'denied'] as const)('does not prompt or display when permission is %s', async (permission) => {
    const env = browser({
      permission: () => permission,
      getWorker: vi.fn(async () => { throw new Error('must not resolve worker'); }),
    });

    await showAgentNotification('notify;Pi;Ready for input', context, env);

    expect(env.requestPermission).not.toHaveBeenCalled();
    expect(env.getWorker).not.toHaveBeenCalled();
  });

  it('requests permission and registers the inert worker only from the explicit enable action', async () => {
    const env = browser();

    await expect(enableAgentNotifications(env)).resolves.toBe('granted');

    expect(env.requestPermission).toHaveBeenCalledOnce();
    expect(env.registerWorker).toHaveBeenCalledOnce();
  });

  it('does not register a worker after permission denial', async () => {
    const env = browser({ requestPermission: vi.fn(async () => 'denied') });

    await expect(enableAgentNotifications(env)).resolves.toBe('denied');

    expect(env.registerWorker).not.toHaveBeenCalled();
  });

  it.each([
    ['permission request rejection', browser({ requestPermission: vi.fn(async () => { throw new Error('blocked'); }) })],
    ['missing service-worker registration', browser({ registerWorker: vi.fn(async () => undefined) })],
    ['service-worker registration rejection', browser({ registerWorker: vi.fn(async () => { throw new Error('blocked'); }) })],
  ])('reports notification enablement as unavailable after %s', async (_name, env) => {
    await expect(enableAgentNotifications(env)).resolves.toBe('unavailable');
  });
});
