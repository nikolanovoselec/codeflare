import { describe, expect, it, vi } from 'vitest';
import {
  agentEventDisposition,
  agentNotificationsAvailable,
  agentNotificationsEnabled,
  setAgentNotificationsEnabled,
  showGrantedAgentEvent,
  type AgentNotificationBrowser,
  type AgentPresence,
} from '../../lib/agent-notifications';

const VAPID_PUBLIC_KEY = 'B'.repeat(87);

function decodePublicKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const decoded = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0)).buffer;
}

const PRESENCE: AgentPresence = Object.freeze({
  documentVisible: true,
  windowFocused: true,
  terminalView: true,
  activeSessionMatches: true,
  terminalOnePaneFocused: true,
});

function subscription(
  endpoint = 'https://fcm.googleapis.com/fcm/send/device-a',
  applicationServerKey?: ArrayBuffer,
) {
  return Object.freeze({
    endpoint,
    options: applicationServerKey === undefined ? undefined : { applicationServerKey },
    toJSON: () => ({
      endpoint,
      keys: { p256dh: 'p256dh', auth: 'auth' },
    }),
  });
}

function browser(overrides: Partial<AgentNotificationBrowser> = {}): AgentNotificationBrowser {
  const current = subscription();
  return {
    permission: () => 'granted',
    requestPermission: vi.fn(async () => 'granted' as const),
    currentSubscription: vi.fn(async () => current),
    getVapidPublicKey: vi.fn(async () => VAPID_PUBLIC_KEY),
    subscribe: vi.fn(async () => current),
    saveSubscription: vi.fn(async () => undefined),
    deleteSubscription: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => true),
    showNotification: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('REQ-TERM-023 AC2/AC3: away presence disposition', () => {
  it('suppresses only when every active-terminal predicate is true', () => {
    expect(agentEventDisposition(PRESENCE)).toBe('suppress');
  });

  it.each([
    ['hidden document', { documentVisible: false }],
    ['unfocused window', { windowFocused: false }],
    ['dashboard or other view', { terminalView: false }],
    ['other session', { activeSessionMatches: false }],
    ['other pane or terminal', { terminalOnePaneFocused: false }],
  ])('requests display for %s', (_name, change) => {
    expect(agentEventDisposition({ ...PRESENCE, ...change })).toBe('display-request');
  });
});

describe('REQ-TERM-023 AC3/AC5: granted local display', () => {
  it.each([
    ['input-required', 'Needs your input'],
    ['task-completed', 'Task completed'],
    ['task-failed', 'Task failed'],
  ] as const)('maps %s to fixed text plus trusted store identity', async (kind, body) => {
    const env = browser();
    await showGrantedAgentEvent({
      eventId: 'event-a',
      kind,
      agent: 'Pi',
      sessionName: 'Pi #1',
      sessionPath: '/app/session/abcdef0123456789',
    }, env);

    expect(env.showNotification).toHaveBeenCalledWith('Pi · Pi #1', {
      body,
      tag: 'codeflare-agent:/app/session/abcdef0123456789',
      renotify: true,
      data: {
        eventId: 'event-a',
        sessionUrl: `${window.location.origin}/app/session/abcdef0123456789`,
      },
    });
    expect(env.requestPermission).not.toHaveBeenCalled();
  });

  it('fails quietly when permission was revoked and never prompts from an event', async () => {
    const env = browser({
      permission: () => 'default',
      showNotification: vi.fn(async () => { throw new Error('must not display'); }),
    });
    await expect(showGrantedAgentEvent({
      eventId: 'event-a',
      kind: 'input-required',
      agent: 'Claude Code',
      sessionName: 'Claude #1',
      sessionPath: '/app/session/abcdef0123456789',
    }, env)).resolves.toBe(false);
    expect(env.requestPermission).not.toHaveBeenCalled();
    expect(env.showNotification).not.toHaveBeenCalled();
  });

  it('rejects malformed IDs, unknown kinds, untrusted names, and non-canonical paths', async () => {
    const env = browser();
    for (const event of [
      { eventId: '', kind: 'input-required', agent: 'Pi', sessionName: 'Pi #1', sessionPath: '/app/session/abcdef0123456789' },
      { eventId: 'event-a', kind: 'other', agent: 'Pi', sessionName: 'Pi #1', sessionPath: '/app/session/abcdef0123456789' },
      { eventId: 'event-a', kind: 'input-required', agent: 'Attacker', sessionName: 'Pi #1', sessionPath: '/app/session/abcdef0123456789' },
      { eventId: 'event-a', kind: 'input-required', agent: 'Pi', sessionName: 'bad\nname', sessionPath: '/app/session/abcdef0123456789' },
      { eventId: 'event-a', kind: 'input-required', agent: 'Pi', sessionName: 'Pi #1', sessionPath: 'https://attacker.example/app/session/abcdef0123456789' },
    ]) {
      await expect(showGrantedAgentEvent(event as never, env)).resolves.toBe(false);
    }
    expect(env.showNotification).not.toHaveBeenCalled();
  });
});

describe('REQ-TERM-025 AC1-AC6: one per-device enrollment switch', () => {
  it('reports availability only when sender configuration can return a public key', async () => {
    await expect(agentNotificationsAvailable(browser())).resolves.toBe(true);
    await expect(agentNotificationsAvailable(browser({
      getVapidPublicKey: vi.fn(async () => { throw new Error('unavailable'); }),
    }))).resolves.toBe(false);
  });

  it('reads on only when permission is granted and a valid subscription exists', async () => {
    await expect(agentNotificationsEnabled(browser())).resolves.toBe(true);
    await expect(agentNotificationsEnabled(browser({
      permission: () => 'default',
    }))).resolves.toBe(false);
    await expect(agentNotificationsEnabled(browser({
      currentSubscription: vi.fn(async () => undefined),
    }))).resolves.toBe(false);
  });

  it('enables in one gesture: permission, public config, subscribe, then authenticated save', async () => {
    const created = subscription('https://updates.push.services.mozilla.com/wpush/v2/device-a');
    const env = browser({
      permission: () => 'default',
      requestPermission: vi.fn(async () => 'granted' as const),
      currentSubscription: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => created),
    });

    await expect(setAgentNotificationsEnabled(true, env)).resolves.toBe('on');

    expect(env.requestPermission).toHaveBeenCalledOnce();
    expect(env.getVapidPublicKey).toHaveBeenCalledOnce();
    expect(env.subscribe).toHaveBeenCalledWith(VAPID_PUBLIC_KEY);
    expect(env.saveSubscription).toHaveBeenCalledWith(created.toJSON());
  });

  it('re-registers an existing matching subscription before reporting enrollment on', async () => {
    const current = subscription(
      'https://fcm.googleapis.com/fcm/send/existing-device',
      decodePublicKey(VAPID_PUBLIC_KEY),
    );
    const env = browser({ currentSubscription: vi.fn(async () => current) });

    await expect(setAgentNotificationsEnabled(true, env)).resolves.toBe('on');

    expect(env.getVapidPublicKey).toHaveBeenCalledOnce();
    expect(env.saveSubscription).toHaveBeenCalledWith(current.toJSON());
    expect(env.subscribe).not.toHaveBeenCalled();
    expect(env.unsubscribe).not.toHaveBeenCalled();
  });

  it('replaces an existing subscription whose application server key cannot match current config', async () => {
    const current = subscription(
      'https://fcm.googleapis.com/fcm/send/old-device',
      decodePublicKey('C'.repeat(87)),
    );
    const replacement = subscription(
      'https://fcm.googleapis.com/fcm/send/new-device',
      decodePublicKey(VAPID_PUBLIC_KEY),
    );
    const env = browser({
      currentSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async () => replacement),
    });

    await expect(setAgentNotificationsEnabled(true, env)).resolves.toBe('on');

    expect(env.deleteSubscription).toHaveBeenCalledWith(current.endpoint);
    expect(env.unsubscribe).toHaveBeenCalledWith(current);
    expect(env.subscribe).toHaveBeenCalledWith(VAPID_PUBLIC_KEY);
    expect(env.saveSubscription).toHaveBeenCalledWith(replacement.toJSON());
  });

  it('does not subscribe or save after permission denial', async () => {
    const env = browser({
      permission: () => 'default',
      requestPermission: vi.fn(async () => 'denied' as const),
    });
    await expect(setAgentNotificationsEnabled(true, env)).resolves.toBe('denied');
    expect(env.getVapidPublicKey).not.toHaveBeenCalled();
    expect(env.subscribe).not.toHaveBeenCalled();
    expect(env.saveSubscription).not.toHaveBeenCalled();
  });

  it('disables by deleting server capability then unsubscribing locally', async () => {
    const current = subscription('https://web.push.apple.com/device-a');
    const env = browser({ currentSubscription: vi.fn(async () => current) });

    await expect(setAgentNotificationsEnabled(false, env)).resolves.toBe('off');

    expect(env.deleteSubscription).toHaveBeenCalledWith(current.endpoint);
    expect(env.unsubscribe).toHaveBeenCalledWith(current);
    expect(env.requestPermission).not.toHaveBeenCalled();
  });

  it('treats subscription/config/worker failures as unavailable without capability leakage', async () => {
    const env = browser({
      currentSubscription: vi.fn(async () => undefined),
      getVapidPublicKey: vi.fn(async () => { throw new Error('endpoint=secret'); }),
    });
    await expect(setAgentNotificationsEnabled(true, env)).resolves.toBe('unavailable');
    expect(env.saveSubscription).not.toHaveBeenCalled();
  });
});
