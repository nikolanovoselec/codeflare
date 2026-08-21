'use strict';

const PUSH_FIELDS = Object.freeze([
  'v',
  'eventId',
  'kind',
  'sessionPath',
  'sessionName',
  'agent',
  'createdAt',
]);
const EVENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_PATH_PATTERN = /^\/app\/session\/[a-z0-9]{8,24}$/;
const MAX_SESSION_NAME_BYTES = 64;
const REASONS = Object.freeze({
  'input-required': 'Needs your input',
  'task-completed': 'Task completed',
  'task-failed': 'Task failed',
});
const AGENTS = new Set(['Pi', 'Claude Code']);

function utf8ByteLength(value) {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    length += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return length;
}

function containsControlCharacter(value) {
  return /\p{Cf}/u.test(value) || [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function parsePushPayload(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.length !== PUSH_FIELDS.length
    || !PUSH_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(value, field))
    || value.v !== 1
    || typeof value.eventId !== 'string'
    || !EVENT_ID_PATTERN.test(value.eventId)
    || typeof value.kind !== 'string'
    || !Object.prototype.hasOwnProperty.call(REASONS, value.kind)
    || typeof value.sessionPath !== 'string'
    || !SESSION_PATH_PATTERN.test(value.sessionPath)
    || typeof value.sessionName !== 'string'
    || value.sessionName.length === 0
    || containsControlCharacter(value.sessionName)
    || utf8ByteLength(value.sessionName) > MAX_SESSION_NAME_BYTES
    || typeof value.agent !== 'string'
    || !AGENTS.has(value.agent)
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
  ) {
    return undefined;
  }
  return value;
}

function canonicalNotificationTarget(candidate) {
  if (typeof candidate !== 'string') return undefined;
  try {
    const target = new URL(candidate);
    if (
      target.origin !== self.location.origin
      || !SESSION_PATH_PATTERN.test(target.pathname)
      || target.search !== ''
      || target.hash !== ''
      || target.username !== ''
      || target.password !== ''
      || candidate !== `${self.location.origin}${target.pathname}`
    ) {
      return undefined;
    }
    return target;
  } catch {
    return undefined;
  }
}

self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = parsePushPayload(event.data?.json());
  } catch {
    return;
  }
  if (!payload) return;

  event.waitUntil((async () => {
    let notifications = [];
    try {
      notifications = await self.registration.getNotifications();
    } catch {
      // A valid push must remain visible even when duplicate lookup is unavailable.
    }
    const duplicate = notifications.some((notification) => (
      notification?.data?.eventId === payload.eventId
    ));
    const sessionUrl = `${self.location.origin}${payload.sessionPath}`;
    await self.registration.showNotification(`${payload.agent} · ${payload.sessionName}`, {
      body: REASONS[payload.kind],
      tag: `codeflare-agent:${payload.sessionPath}`,
      renotify: !duplicate,
      data: {
        eventId: payload.eventId,
        sessionUrl,
      },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification;
  if (!notification || typeof notification.close !== 'function') return;
  notification.close();

  const target = canonicalNotificationTarget(notification.data?.sessionUrl);
  if (!target) return;
  const targetUrl = notification.data.sessionUrl;

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = clients.find((entry) => {
      try {
        const url = new URL(entry.url);
        return url.origin === target.origin && url.pathname === target.pathname;
      } catch {
        return false;
      }
    });
    if (client) {
      await client.focus();
      return;
    }
    await self.clients.openWindow?.(targetUrl);
  })());
});
