/* DREV Assist — service worker.
 *
 * Exists for one job: turn a Web Push message into a notification on the
 * technician's lock screen, and open their board when they tap it.
 *
 * It deliberately does NOT cache pages or intercept fetches. A field app that
 * serves a stale "no jobs assigned" from cache is worse than no app at all,
 * so there is no fetch handler here.
 */
'use strict';

const CLIENT_URL = '/tech';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

/* ── Incoming push ─────────────────────────────────────────────────────── */
self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title: 'DREV Assist', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'DREV Assist';
  const options = {
    body: payload.body || '',
    // One notification per job: a re-push replaces rather than stacks.
    tag: payload.tag || 'drev-job',
    renotify: Boolean(payload.tag),
    requireInteraction: true, // stays on screen until acknowledged: it is a job
    silent: false,
    data: { url: payload.url || CLIENT_URL, jobId: payload.jobId || null },
    icon: '/assets/assist-mark.png',
    badge: '/assets/assist-mark.png',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* ── Tap ───────────────────────────────────────────────────────────────── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || CLIENT_URL;

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an already-open board instead of piling up new tabs.
    for (const client of all) {
      if (client.url.includes('/tech')) {
        await client.focus();
        if (client.url !== new URL(target, self.location.origin).href) client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

/* ── Subscription rotated by the browser ───────────────────────────────────
   The push service can invalidate a subscription without asking. The page
   holds the shift token, so it is the only thing that can re-register; ask it
   to rather than silently going deaf. */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) client.postMessage({ type: 'push-subscription-change' });
  })());
});
