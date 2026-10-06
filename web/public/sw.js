/*
 * Switchboard's service worker. It shows the notifications the daemon pushes, puts the count of
 * sessions waiting on you on the app's icon, and opens the session a notification points at when it
 * is tapped. No fetch handler, deliberately: the app
 * is always loaded fresh from the desk, so nothing here can serve a stale build.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Switchboard';
  // The app may be closed: the icon's number is set from here then. Nothing to set it on, nothing set.
  const badge =
    typeof data.badge === 'number' && self.navigator.setAppBadge
      ? (data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => undefined)
      : Promise.resolve();
  event.waitUntil(
    Promise.all([badge, self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      // A session asking again after being answered is news, even under the same tag.
      renotify: !!data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    })]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // An open Switchboard is taken to the session rather than a second one opened beside it.
      for (const client of open) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) await client.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
