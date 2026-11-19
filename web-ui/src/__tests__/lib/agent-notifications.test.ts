import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('REQ-TERM-039 AC2: labels local Pi completion as ready for input', async () => {
    const env = browser();
    await showGrantedAgentEvent({
      eventId: 'event-a',
      kind: 'task-completed',
      agent: 'Pi',
      sessionName: 'Pi #1',
      sessionPath: '/app/session/abcdef0123456789',
    }, env);

    expect(env.showNotification).toHaveBeenCalledWith(
      'Pi · Pi #1',
      expect.objectContaining({ body: 'Ready for input' }),
    );
  });

  it('REQ-TERM-039 AC4: keeps local Claude completion copy task-oriented', async () => {
    const env = browser();
    await showGrantedAgentEvent({
      eventId: 'event-a',
      kind: 'task-completed',
      agent: 'Claude Code',
      sessionName: 'Claude #1',
      sessionPath: '/app/session/abcdef0123456789',
    }, env);

    expect(env.showNotification).toHaveBeenCalledWith(
      'Claude Code · Claude #1',
      expect.objectContaining({ body: 'Task completed' }),
    );
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

  it('REQ-TERM-025 AC2: enrollment stays pending until existing capability registration succeeds', async () => {
    let finish!: () => void;
    const registration = new Promise<void>(resolve => { finish = resolve; });
    const current = subscription('https://fcm.googleapis.com/fcm/send/existing-device', decodePublicKey(VAPID_PUBLIC_KEY));
    let stored: unknown;
    let registering = false;
    const env = browser({ currentSubscription: async () => current,
      saveSubscription: async value => { registering = true; await registration; stored = value; } });
    let state = 'pending';
    const work = setAgentNotificationsEnabled(true, env).then(value => { state = value; });
    await vi.waitFor(() => expect(registering).toBe(true));
    expect(state).toBe('pending');
    expect(stored).toBeUndefined();
    finish();
    await work;
    expect(stored).toEqual(current.toJSON());
    expect(state).toBe('on');

    const failed = browser({ currentSubscription: async () => current,
      saveSubscription: async () => { throw new Error('registration denied'); } });
    await expect(setAgentNotificationsEnabled(true, failed)).resolves.toBe('unavailable');
  });

  it('REQ-TERM-025 AC3: worker readiness precedes subscription and registration precedes on', async () => {
    let ready!: (worker: { showNotification: () => Promise<void> }) => void;
    const worker = new Promise<{ showNotification: () => Promise<void> }>(resolve => { ready = resolve; });
    let save!: () => void;
    const registration = new Promise<void>(resolve => { save = resolve; });
    let local: ReturnType<typeof subscription> | undefined;
    let stored: unknown;
    const created = subscription();
    let preparingWorker = false;
    const env = browser({ currentSubscription: async () => undefined, registerWorker: () => { preparingWorker = true; return worker; },
      subscribe: async () => { local = created; return created; },
      saveSubscription: async value => { await registration; stored = value; } });
    let state = 'pending';
    const work = setAgentNotificationsEnabled(true, env).then(value => { state = value; });
    await vi.waitFor(() => expect(preparingWorker).toBe(true));
    expect(local).toBeUndefined();
    expect(state).toBe('pending');
    ready({ showNotification: async () => {} });
    await vi.waitFor(() => expect(local).toBe(created));
    expect(stored).toBeUndefined();
    expect(state).toBe('pending');
    save();
    await work;
    expect(stored).toEqual(created.toJSON());
    expect(state).toBe('on');
  });

  it('REQ-TERM-025 AC4: pending or failed server deletion retains the local subscription', async () => {
    let finish!: () => void;
    const deletion = new Promise<void>(resolve => { finish = resolve; });
    const current = subscription();
    let local: ReturnType<typeof subscription> | undefined = current;
    let serverPresent = true;
    const env = browser({ currentSubscription: async () => local,
      deleteSubscription: async () => { await deletion; serverPresent = false; },
      unsubscribe: async () => { local = undefined; return true; } });
    let state = 'pending';
    const work = setAgentNotificationsEnabled(false, env).then(value => { state = value; });
    await Promise.resolve();
    expect(local).toBe(current);
    expect(serverPresent).toBe(true);
    expect(state).toBe('pending');
    finish();
    await work;
    expect(serverPresent).toBe(false);
    expect(local).toBeUndefined();
    expect(state).toBe('off');

    local = current;
    env.deleteSubscription = async () => { throw new Error('denied'); };
    await expect(setAgentNotificationsEnabled(false, env)).resolves.toBe('unavailable');
    expect(local).toBe(current);
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

// Exercise the default adapter, not the injected AgentNotificationBrowser seam.
class NativeWorker extends EventTarget {
  constructor(public state: ServiceWorkerState) { super(); }
  transition(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

function nativeEnrollment() {
  const registration = Object.assign(new EventTarget(), {
    active: null as NativeWorker | null,
    installing: null as NativeWorker | null,
    waiting: null as NativeWorker | null,
    pushManager: {
      getSubscription: async () => local,
      subscribe: async () => {
        await subscribeGate;
        local = current;
        return current;
      },
    },
  });
  let local: (ReturnType<typeof subscription> & { unsubscribe(): Promise<boolean> }) | null = null;
  const current = {
    ...subscription('https://fcm.googleapis.com/fcm/send/native', decodePublicKey(VAPID_PUBLIC_KEY)),
    unsubscribe: async () => { local = null; return true; },
  };
  let registered = false;
  let repairedWorker: NativeWorker | undefined;
  let existing: typeof registration | undefined;
  let subscribeGate: Promise<void> = Promise.resolve();
  let saveStatus = 200;
  let saveGate: Promise<void> = Promise.resolve();
  const saved: unknown[] = [];
  const requests: { method: string; credentials?: RequestCredentials }[] = [];
  const serviceWorker = {
    // Intentionally never settles, even when register returns an active worker.
    ready: new Promise<never>(() => {}),
    getRegistration: async () => existing,
    register: async () => {
      registered = true;
      if (repairedWorker) registration.active = repairedWorker;
      return registration;
    },
  };
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === '/api/notifications/config') {
      return new Response(JSON.stringify({ vapidPublicKey: VAPID_PUBLIC_KEY }));
    }
    if (url === '/api/notifications/subscription') {
      requests.push({ method: init.method!, credentials: init.credentials });
      if (init.method === 'POST') {
        await saveGate;
        if (saveStatus === 200) saved.push(JSON.parse(init.body as string));
      }
      return new Response('{}', { status: saveStatus });
    }
    throw new Error('Unexpected request');
  });
  return {
    registration, saved, requests,
    get local() { return local; },
    get registered() { return registered; },
    setExisting: () => { existing = registration; },
    repairWith: (worker: NativeWorker) => { repairedWorker = worker; },
    holdSubscribe: (gate: Promise<void>) => { subscribeGate = gate; },
    holdSave: (gate: Promise<void>) => { saveGate = gate; },
    failSave: () => { saveStatus = 500; },
    restore: () => {
      if (descriptor) Object.defineProperty(navigator, 'serviceWorker', descriptor);
      else Reflect.deleteProperty(navigator, 'serviceWorker');
    },
  };
}

describe('REQ-TERM-025 AC3: native registration repair and activation', () => {
  let native: ReturnType<typeof nativeEnrollment> | undefined;
  afterEach(() => {
    native?.restore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads an inactive registration as off so an explicit gesture can repair it', async () => {
    native = nativeEnrollment();
    native.setExisting();
    await expect(agentNotificationsEnabled()).resolves.toBe(false);
    expect(native.registered).toBe(false);
    expect(native.local).toBeNull();
    native.repairWith(new NativeWorker('activated'));
    await expect(setAgentNotificationsEnabled(true)).resolves.toBe('on');
    expect(native.saved).toEqual([native.local!.toJSON()]);
  });

  it('uses the returned active registration despite globally pending ready, saving before on', async () => {
    native = nativeEnrollment();
    native.registration.active = new NativeWorker('activated');
    let finish!: () => void;
    native.holdSave(new Promise<void>(resolve => { finish = resolve; }));
    let state = 'pending';
    const work = setAgentNotificationsEnabled(true).then(value => { state = value; });
    await vi.waitFor(() => expect(native!.local).not.toBeNull());
    expect(state).toBe('pending');
    expect(native.saved).toEqual([]);
    finish();
    await work;
    expect(state).toBe('on');
    expect(native.saved).toEqual([native.local!.toJSON()]);
    expect(native.requests).toEqual([{ method: 'POST', credentials: 'same-origin' }]);
  });

  it('waits for installing then activating then active before subscribing', async () => {
    native = nativeEnrollment();
    const worker = new NativeWorker('installing');
    native.registration.installing = worker;
    const work = setAgentNotificationsEnabled(true);
    await vi.waitFor(() => expect(native!.registered).toBe(true));
    expect(native.local).toBeNull();
    worker.transition('installed');
    native.registration.installing = null;
    native.registration.active = worker;
    worker.transition('activating');
    expect(native.local).toBeNull();
    expect(native.saved).toEqual([]);
    worker.transition('activated');
    await expect(work).resolves.toBe('on');
    expect(native.saved).toEqual([native.local!.toJSON()]);
  });

  it('keeps an active worker usable while an update waits', async () => {
    native = nativeEnrollment();
    native.registration.active = new NativeWorker('activated');
    const update = new NativeWorker('installed');
    native.registration.waiting = update;
    await expect(setAgentNotificationsEnabled(true)).resolves.toBe('on');
    expect(update.state).toBe('installed');
    expect(native.saved).toEqual([native.local!.toJSON()]);
  });

  it('follows a worker discovered by the registration updatefound lifecycle', async () => {
    native = nativeEnrollment();
    const work = setAgentNotificationsEnabled(true);
    await vi.waitFor(() => expect(native!.registered).toBe(true));
    const worker = new NativeWorker('installing');
    native.registration.installing = worker;
    native.registration.dispatchEvent(new Event('updatefound'));
    native.registration.active = worker;
    native.registration.installing = null;
    worker.transition('activated');
    await expect(work).resolves.toBe('on');
    expect(native.saved).toEqual([native.local!.toJSON()]);
  });

  it.each(['already redundant', 'becomes redundant', 'stalled'] as const)(
    'fails closed for %s activation; late activation cannot subscribe or save', async failure => {
      vi.useFakeTimers();
      native = nativeEnrollment();
      const worker = new NativeWorker(failure === 'already redundant' ? 'redundant' : 'installing');
      native.registration.installing = worker;
      let result = 'pending';
      const work = setAgentNotificationsEnabled(true).then(value => { result = value; });
      await vi.advanceTimersByTimeAsync(0);
      expect(native.registered).toBe(true);
      if (failure === 'becomes redundant') worker.transition('redundant');
      if (failure === 'stalled') await vi.advanceTimersByTimeAsync(10_000);
      // Check bounded settlement without awaiting an implementation that may hang.
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toBe('unavailable');
      await work;
      expect(native.local).toBeNull();
      expect(native.requests).toEqual([]);
      native.registration.active = worker;
      worker.transition('activated');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(native.local).toBeNull();
      expect(native.saved).toEqual([]);
    },
  );

  it('does not race a slow PushManager subscription with an activation deadline', async () => {
    vi.useFakeTimers();
    native = nativeEnrollment();
    native.registration.active = new NativeWorker('activated');
    let finish!: () => void;
    native.holdSubscribe(new Promise<void>(resolve => { finish = resolve; }));
    let state = 'pending';
    const work = setAgentNotificationsEnabled(true).then(value => { state = value; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state).toBe('pending');
    expect(native.local).toBeNull();
    expect(native.saved).toEqual([]);
    finish();
    await work;
    expect(state).toBe('on');
    expect(native.saved).toEqual([native.local!.toJSON()]);
  });

  it('does not time out a server save after worker activation', async () => {
    vi.useFakeTimers();
    native = nativeEnrollment();
    native.registration.active = new NativeWorker('activated');
    let finish!: () => void;
    native.holdSave(new Promise<void>(resolve => { finish = resolve; }));
    let state = 'pending';
    const work = setAgentNotificationsEnabled(true).then(value => { state = value; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.local).not.toBeNull();
    expect(state).toBe('pending');
    finish();
    await work;
    expect(state).toBe('on');
    expect(native.saved).toEqual([native.local!.toJSON()]);
  });

  it('rolls back a native subscription if the authenticated save fails', async () => {
    native = nativeEnrollment();
    native.registration.active = new NativeWorker('activated');
    native.failSave();
    await expect(setAgentNotificationsEnabled(true)).resolves.toBe('unavailable');
    expect(native.local).toBeNull();
    expect(native.saved).toEqual([]);
    expect(native.requests.map(request => request.method)).toEqual(['POST', 'DELETE']);
  });
});
