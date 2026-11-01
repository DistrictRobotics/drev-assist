/* DREV Assist — job alerts (Web Push client).
 *
 * The browser half of push. Never fabricates a working state: if the API has
 * no VAPID keys, if the permission is blocked, or if the browser cannot do
 * service workers at all, it says so instead of showing "alerts on".
 *
 *   DrevPush.status()            → one of the states below
 *   DrevPush.enable(token)       → subscribe this device
 *   DrevPush.disable(token)      → unsubscribe this device
 *   DrevPush.test(token)         → ask the server to send one notification
 *
 * States: unsupported | not-configured | default | blocked | subscribed | off
 */
'use strict';

window.DrevPush = (function () {
  const SW_URL = '/sw.js';

  let vapidKey = '';          // from GET /api/assist/tech (or /config)
  let devices = 0;            // how many devices this tech has enabled
  let configured = false;

  const supported = () =>
    typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;

  /* base64url → Uint8Array, for applicationServerKey. */
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function bytesToB64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function registration() {
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing && existing.active) return existing;
    return navigator.serviceWorker.register(SW_URL, { scope: '/' });
  }

  async function currentSubscription() {
    if (!supported()) return null;
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) return null;
    try { return await reg.pushManager.getSubscription(); } catch (_) { return null; }
  }

  /** Read the server's view: is push configured, and how many devices are on? */
  function applyServerInfo(info) {
    if (!info) return;
    configured = Boolean(info.configured);
    devices = Number(info.devices || 0);
    if (info.publicKey) vapidKey = info.publicKey;
  }

  async function status() {
    if (!supported()) return 'unsupported';
    if (!configured) return 'not-configured';
    if (Notification.permission === 'denied') return 'blocked';
    const sub = await currentSubscription();
    // Only "on" when both halves agree: a subscription here AND a row on the
    // server. A local-only subscription sends nothing, so offering to fix it
    // is more honest than showing a green state.
    if (sub && devices > 0) return 'subscribed';
    return 'off';
  }

  async function enable(token) {
    if (!supported()) throw new Error('This browser cannot show job alerts.');
    if (!configured || !vapidKey) throw new Error('Job alerts are not configured on this deployment.');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      throw new Error(permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.'
        : 'Notifications were not allowed.');
    }

    const reg = await registration();
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    // A subscription created with an older VAPID key cannot be reused.
    if (sub && vapidKey) {
      const current = sub.options?.applicationServerKey
        ? bytesToB64url(new Uint8Array(sub.options.applicationServerKey))
        : null;
      if (current && current !== vapidKey) { try { await sub.unsubscribe(); } catch (_) {} sub = null; }
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,               // the browser requires this
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }

    const res = await fetch('/api/assist/tech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push-subscribe', subscription: sub.toJSON() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || 'Could not register this device.');
    devices = Math.max(1, devices);
    return true;
  }

  async function disable(token) {
    const sub = await currentSubscription();
    const endpoint = sub?.endpoint || '';
    if (sub) { try { await sub.unsubscribe(); } catch (_) {} }
    if (token) {
      try {
        await fetch('/api/assist/tech', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'push-unsubscribe', endpoint }),
        });
      } catch (_) { /* local unsubscribe already did the important part */ }
    }
    devices = 0;
    return true;
  }

  async function test(token) {
    const res = await fetch('/api/assist/tech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push-test' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || 'Could not send a test alert.');
    if (!data.delivered) {
      throw new Error('The push service accepted nothing — alerts may not be reaching this device yet.');
    }
    return data;
  }

  /* Ask the browser to re-register when the push service rotates a
     subscription (see pushsubscriptionchange in sw.js). */
  if (supported() && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data && event.data.type === 'push-subscription-change') {
        window.dispatchEvent(new CustomEvent('drevpush:resubscribe'));
      }
    });
  }

  return {
    supported,
    status,
    enable,
    disable,
    test,
    currentSubscription,
    applyServerInfo,
    get devices() { return devices; },
    get configured() { return configured; },
  };
})();
