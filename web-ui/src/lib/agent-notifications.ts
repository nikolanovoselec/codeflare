import type { AgentType } from '../types';

const SUPPORTED_AGENTS = new Set<AgentType>(['pi', 'claude-code']);
const MAX_TITLE_BYTES = 64;
const MAX_BODY_BYTES = 256;
const MAX_SESSION_BYTES = 64;
function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
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
  showNotification(title: string, options: NotificationOptions): Promise<void>;
}

export interface AgentNotificationBrowser {
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  registerWorker(): Promise<AgentNotificationWorker | undefined>;
  getWorker(): Promise<AgentNotificationWorker | undefined>;
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
  if (
    context.terminalId !== '1'
    || !context.agentType
    || !SUPPORTED_AGENTS.has(context.agentType)
    || !boundedPlainText(context.sessionName, MAX_SESSION_BYTES)
    || !data.startsWith('notify;')
  ) {
    return undefined;
  }
  const separator = data.indexOf(';', 'notify;'.length);
  if (separator < 0) return undefined;
  const title = data.slice('notify;'.length, separator);
  const body = data.slice(separator + 1);
  const composedTitle = `${title} · ${context.sessionName}`;
  if (!boundedPlainText(composedTitle, MAX_TITLE_BYTES) || !boundedPlainText(body, MAX_BODY_BYTES)) {
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
): NotificationPermission {
  return browser.permission();
}

export async function enableAgentNotifications(
  browser: AgentNotificationBrowser = defaultBrowser,
): Promise<AgentNotificationEnablement> {
  try {
    const permission = await browser.requestPermission();
    if (permission !== 'granted') return permission;
    return await browser.registerWorker() ? 'granted' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export async function showAgentNotification(
  data: string,
  context: AgentNotificationContext,
  browser: AgentNotificationBrowser = defaultBrowser,
): Promise<void> {
  const payload = parseAgentNotification(data, context);
  if (!payload || browser.permission() !== 'granted') return;
  try {
    const worker = await browser.getWorker();
    await worker?.showNotification(payload.title, {
      body: payload.body,
      data: { sessionUrl: payload.sessionUrl },
    });
  } catch {
    // Notification delivery must never affect terminal or agent execution.
  }
}

const defaultBrowser: AgentNotificationBrowser = {
  permission: () => typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  requestPermission: async () => {
    if (typeof Notification === 'undefined') return 'denied';
    return Notification.requestPermission();
  },
  registerWorker: async () => {
    if (!('serviceWorker' in navigator)) return undefined;
    return navigator.serviceWorker.register(WORKER_PATH, { scope: WORKER_SCOPE });
  },
  getWorker: async () => {
    if (!('serviceWorker' in navigator)) return undefined;
    return navigator.serviceWorker.getRegistration(WORKER_SCOPE);
  },
};
