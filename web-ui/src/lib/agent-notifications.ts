import type { AgentType } from '../types';
import {
  deleteAgentNotificationSubscription,
  getAgentNotificationVapidPublicKey,
  saveAgentNotificationSubscription,
} from '../api/client';

const AGENT_TITLES = new Map<AgentType, string>([
  ['pi', 'Pi'],
  ['claude-code', 'Claude Code'],
]);
const MAX_TITLE_BYTES = 64;
const MAX_BODY_BYTES = 256;
const MAX_SESSION_BYTES = 64;
function containsControlCharacter(value: string): boolean {
  return /\p{Cf}/u.test(value) || [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}
const WORKER_PATH = '/agent-notifications-sw.js';
const WORKER_SCOPE = '/';

export interface AgentNotificationContext {
  readonly agentType: AgentType | undefined;
  readonly terminalId: string;
  readonly sessionName: string;
}

export interface AgentNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly sessionUrl: string;
}

export type AgentNotificationEnablement = NotificationPermission | 'unavailable';

export interface AgentNotificationWorker {
  // renotify is real Notification API surface the pinned lib.dom typing omits.
  showNotification(title: string, options: NotificationOptions & { renotify?: boolean }): Promise<void>;
}

export interface AgentNotificationSubscription {
  readonly endpoint: string;
  toJSON(): {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
}

export interface AgentNotificationBrowser {
  permission(): AgentNotificationEnablement;
  requestPermission(): Promise<AgentNotificationEnablement>;
  registerWorker?(): Promise<AgentNotificationWorker | undefined>;
  getWorker?(): Promise<AgentNotificationWorker | undefined>;
  currentSubscription?(): Promise<AgentNotificationSubscription | undefined>;
  getVapidPublicKey?(): Promise<string>;
  subscribe?(publicKey: string): Promise<AgentNotificationSubscription>;
  saveSubscription?(subscription: ReturnType<AgentNotificationSubscription['toJSON']>): Promise<void>;
  deleteSubscription?(endpoint: string): Promise<void>;
  unsubscribe?(subscription: AgentNotificationSubscription): Promise<boolean>;
  showNotification?(title: string, options: NotificationOptions & { renotify?: boolean }): Promise<void>;
}

function boundedPlainText(value: string, maxBytes: number): boolean {
  return value.length > 0
    && !containsControlCharacter(value)
    && new TextEncoder().encode(value).byteLength <= maxBytes;
}

export function parseAgentNotification(
  data: string,
  context: AgentNotificationContext,
): AgentNotificationPayload | undefined {
  const agentTitle = context.agentType ? AGENT_TITLES.get(context.agentType) : undefined;
  if (
    context.terminalId !== '1'
    || !agentTitle
    || !boundedPlainText(context.sessionName, MAX_SESSION_BYTES)
    || !data.startsWith('notify;')
  ) {
    return undefined;
  }
  const separator = data.indexOf(';', 'notify;'.length);
  if (separator < 0) return undefined;
  const payloadTitle = data.slice('notify;'.length, separator);
  const body = data.slice(separator + 1);
  const composedTitle = `${agentTitle} · ${context.sessionName}`;
  if (
    !boundedPlainText(payloadTitle, MAX_TITLE_BYTES)
    || !boundedPlainText(composedTitle, MAX_TITLE_BYTES)
    || !boundedPlainText(body, MAX_BODY_BYTES)
  ) {
    return undefined;
  }
  return Object.freeze({
    title: composedTitle,
    body,
    sessionUrl: window.location.href,
  });
}

export function agentNotificationPermission(
  browser: AgentNotificationBrowser = defaultBrowser,
): AgentNotificationEnablement {
  return browser.permission();
}

export async function showAgentNotification(
  data: string,
  context: AgentNotificationContext,
  browser: AgentNotificationBrowser = defaultBrowser,
): Promise<void> {
  const payload = parseAgentNotification(data, context);
  if (!payload || browser.permission() !== 'granted') return;
  try {
    const worker = await browser.getWorker?.();
    // Tag on origin+pathname — the same stable identity the service worker
    // matches clients by — so history.replaceState query cleanups cannot split
    // one session's notifications into separate stacks.
    const scope = new URL(payload.sessionUrl);
    await worker?.showNotification(payload.title, {
      body: payload.body,
      // Per-session tag: a new notification replaces the previous one for the
      // same session instead of stacking, without collapsing other sessions'.
      tag: `codeflare-agent:${scope.origin}${scope.pathname}`,
      renotify: true,
      data: { sessionUrl: payload.sessionUrl },
    });
  } catch {
    // Notification delivery must never affect terminal or agent execution.
  }
}

export interface AgentPresence {
  readonly documentVisible: boolean;
  readonly windowFocused: boolean;
  readonly terminalView: boolean;
  readonly activeSessionMatches: boolean;
  readonly terminalOnePaneFocused: boolean;
}

export type AgentEventDisposition = 'suppress' | 'display-request';
export type AgentNotificationSwitchState = 'on' | 'off' | 'denied' | 'unavailable';

export interface GrantedAgentEvent {
  readonly eventId: string;
  readonly kind: 'input-required' | 'task-completed' | 'task-failed';
  readonly agent: 'Pi' | 'Claude Code';
  readonly sessionName: string;
  readonly sessionPath: string;
}

export function agentEventDisposition(presence: AgentPresence): AgentEventDisposition {
  return presence.documentVisible
    && presence.windowFocused
    && presence.terminalView
    && presence.activeSessionMatches
    && presence.terminalOnePaneFocused
    ? 'suppress'
    : 'display-request';
}

function validSubscription(subscription: AgentNotificationSubscription | undefined): subscription is AgentNotificationSubscription {
  if (!subscription?.endpoint) return false;
  try {
    const serialized = subscription.toJSON();
    return serialized.endpoint === subscription.endpoint
      && typeof serialized.keys?.p256dh === 'string'
      && serialized.keys.p256dh.length > 0
      && typeof serialized.keys.auth === 'string'
      && serialized.keys.auth.length > 0;
  } catch {
    return false;
  }
}

export async function agentNotificationsEnabled(browser: AgentNotificationBrowser = defaultBrowser): Promise<boolean> {
  try {
    if (browser.permission() !== 'granted' || !browser.currentSubscription) return false;
    return validSubscription(await browser.currentSubscription());
  } catch {
    return false;
  }
}

export async function setAgentNotificationsEnabled(
  enabled: boolean,
  browser: AgentNotificationBrowser = defaultBrowser,
): Promise<AgentNotificationSwitchState> {
  if (!enabled) {
    try {
      const subscription = await browser.currentSubscription?.();
      if (!subscription) return 'off';
      if (!validSubscription(subscription) || !browser.deleteSubscription || !browser.unsubscribe) {
        return 'unavailable';
      }
      await browser.deleteSubscription(subscription.endpoint);
      return await browser.unsubscribe(subscription) ? 'off' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  let createdSubscription: AgentNotificationSubscription | undefined;
  try {
    let permission = browser.permission();
    if (permission === 'denied') return 'denied';
    if (permission === 'unavailable') return 'unavailable';
    if (permission !== 'granted') {
      permission = await browser.requestPermission();
      if (permission === 'denied') return 'denied';
      if (permission !== 'granted') return 'unavailable';
    }

    const existingSubscription = await browser.currentSubscription?.();
    if (validSubscription(existingSubscription)) return 'on';
    if (!browser.getVapidPublicKey || !browser.subscribe || !browser.saveSubscription) {
      return 'unavailable';
    }

    if (browser.registerWorker && !(await browser.registerWorker())) return 'unavailable';
    const publicKey = await browser.getVapidPublicKey();
    createdSubscription = await browser.subscribe(publicKey);
    if (!validSubscription(createdSubscription)) throw new Error('Invalid Push subscription');
    await browser.saveSubscription(createdSubscription.toJSON());
    return 'on';
  } catch {
    if (createdSubscription) {
      try {
        await browser.deleteSubscription?.(createdSubscription.endpoint);
      } catch {
        // A failed registration may not have created a server record.
      }
      try {
        await browser.unsubscribe?.(createdSubscription);
      } catch {
        // Preserve the original unavailable result after best-effort rollback.
      }
    }
    return 'unavailable';
  }
}

export async function showGrantedAgentEvent(
  event: GrantedAgentEvent,
  browser: AgentNotificationBrowser = defaultBrowser,
): Promise<boolean> {
  const bodies: Readonly<Record<GrantedAgentEvent['kind'], string>> = Object.freeze({
    'input-required': 'Needs your input',
    'task-completed': 'Task completed',
    'task-failed': 'Task failed',
  });
  const body = bodies[event.kind];
  const title = `${event.agent} · ${event.sessionName}`;
  if (
    browser.permission() !== 'granted'
    || !/^[A-Za-z0-9_-]{1,128}$/.test(event.eventId)
    || !body
    || (event.agent !== 'Pi' && event.agent !== 'Claude Code')
    || !boundedPlainText(event.sessionName, MAX_SESSION_BYTES)
    || !boundedPlainText(title, MAX_TITLE_BYTES)
    || !/^\/app\/session\/[a-z0-9]{8,24}$/.test(event.sessionPath)
  ) {
    return false;
  }

  const options: NotificationOptions & { renotify?: boolean } = {
    body,
    tag: `codeflare-agent:${event.sessionPath}`,
    renotify: true,
    data: {
      eventId: event.eventId,
      sessionUrl: `${window.location.origin}${event.sessionPath}`,
    },
  };

  try {
    if (browser.showNotification) {
      await browser.showNotification(title, options);
    } else {
      const worker = await browser.getWorker?.();
      if (!worker) return false;
      await worker.showNotification(title, options);
    }
    return true;
  } catch {
    return false;
  }
}

function decodeVapidPublicKey(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]{87}$/.test(value)) throw new Error('Invalid VAPID public key');
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const decoded = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error('Invalid VAPID public key');
  const output = new ArrayBuffer(bytes.length);
  new Uint8Array(output).set(bytes);
  return output;
}

function serializedSubscription(
  subscription: ReturnType<AgentNotificationSubscription['toJSON']>,
) {
  if (
    typeof subscription.endpoint !== 'string'
    || typeof subscription.keys?.p256dh !== 'string'
    || typeof subscription.keys.auth !== 'string'
  ) {
    throw new Error('Invalid Push subscription');
  }
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
  };
}

async function readyNotificationWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  await navigator.serviceWorker.register(WORKER_PATH, { scope: WORKER_SCOPE });
  return navigator.serviceWorker.ready;
}

const defaultBrowser: AgentNotificationBrowser = {
  permission: () => typeof Notification === 'undefined' ? 'unavailable' : Notification.permission,
  requestPermission: async () => {
    if (typeof Notification === 'undefined') return 'unavailable';
    return Notification.requestPermission();
  },
  registerWorker: readyNotificationWorker,
  getWorker: async () => {
    if (!('serviceWorker' in navigator)) return undefined;
    const registration = await navigator.serviceWorker.getRegistration(WORKER_SCOPE);
    if (!registration) return undefined;
    return registration.active ? registration : navigator.serviceWorker.ready;
  },
  currentSubscription: async () => {
    if (!('serviceWorker' in navigator)) return undefined;
    const registration = await navigator.serviceWorker.getRegistration(WORKER_SCOPE);
    if (!registration) return undefined;
    const readyRegistration = registration.active ? registration : await navigator.serviceWorker.ready;
    return (await readyRegistration.pushManager.getSubscription()) ?? undefined;
  },
  getVapidPublicKey: getAgentNotificationVapidPublicKey,
  subscribe: async (publicKey) => {
    const registration = await readyNotificationWorker();
    if (!registration) throw new Error('Push notifications unavailable');
    return registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeVapidPublicKey(publicKey),
    });
  },
  saveSubscription: async (subscription) => {
    await saveAgentNotificationSubscription(serializedSubscription(subscription));
  },
  deleteSubscription: deleteAgentNotificationSubscription,
  unsubscribe: async (subscription) => {
    const nativeSubscription = subscription as PushSubscription;
    if (typeof nativeSubscription.unsubscribe !== 'function') return false;
    return nativeSubscription.unsubscribe();
  },
};
