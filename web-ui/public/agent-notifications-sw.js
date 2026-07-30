'use strict';

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const candidate = event.notification?.data?.sessionUrl;
  let target;
  try {
    target = new URL(candidate);
  } catch {
    return;
  }
  if (target.origin !== self.location.origin) return;

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = clients.find((entry) => new URL(entry.url).href === target.href);
    await client?.focus();
  })());
});
