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
    // Match on origin + pathname: SPA navigation and warm-start query params
    // change the full href without changing which tab owns the session.
    const client = clients.find((entry) => {
      const url = new URL(entry.url);
      return url.origin === target.origin && url.pathname === target.pathname;
    });
    if (client) {
      await client.focus();
      return;
    }
    await self.clients.openWindow?.(target.href);
  })());
});
