/* Web Push from a Worker — no npm dependency.
 *
 * Implements the two specs a push service actually requires:
 *   • RFC 8292 VAPID  — an ES256 JWT identifying this deployment, so the
 *                       push service (FCM/Mozilla/Apple) accepts the message.
 *   • RFC 8291 / 8188 — aes128gcm payload encryption to the subscription's
 *                       own P-256 key + auth secret. The push service relays
 *                       ciphertext it cannot read; only the browser decrypts.
 *
 * Everything here is WebCrypto, so it runs unchanged in Workers, in Node 18+
 * (the tests round-trip the ciphertext), and in browsers.
 *
 * Configuration (all optional — push is off, and says so, until both are set):
 *   VAPID_PUBLIC_KEY   base64url raw P-256 point (65 bytes, starts 0x04)
 *   VAPID_PRIVATE_KEY  base64url raw scalar (32 bytes) — the `d` value
 *   VAPID_SUBJECT      contact for the push service, e.g. mailto:ops@drev.space
 *
 * Generate a pair with `node tools/gen-vapid.mjs`.
 */

const enc = new TextEncoder();

/* ── base64url ─────────────────────────────────────────────────────────── */

export function b64urlToBytes(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── HKDF (RFC 5869) on top of WebCrypto ───────────────────────────────── */

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/* ── VAPID ─────────────────────────────────────────────────────────────── */

export function pushConfigured(env) {
  return typeof env?.VAPID_PUBLIC_KEY === 'string' && env.VAPID_PUBLIC_KEY.length > 40
    && typeof env?.VAPID_PRIVATE_KEY === 'string' && env.VAPID_PRIVATE_KEY.length > 20;
}

/** The public key the browser subscribes with. Public by design. */
export function vapidPublicKey(env) {
  return pushConfigured(env) ? env.VAPID_PUBLIC_KEY : '';
}

async function importVapidPrivate(env) {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);   // 0x04 || X(32) || Y(32)
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte raw P-256 point');
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToB64url(b64urlToBytes(env.VAPID_PRIVATE_KEY)),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * Build the `Authorization: vapid t=…, k=…` header for one push endpoint.
 * `aud` must be the *origin* of the endpoint, per RFC 8292 §2.
 */
export async function vapidAuthHeader(env, endpoint, nowMs = Date.now()) {
  const audience = new URL(endpoint).origin;
  const subject = env.VAPID_SUBJECT || 'mailto:ops@drev.space';
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    exp: Math.floor(nowMs / 1000) + 12 * 60 * 60, // 12h; the spec caps at 24h
    sub: subject,
  };
  const signingInput = `${bytesToB64url(enc.encode(JSON.stringify(header)))}.${bytesToB64url(enc.encode(JSON.stringify(payload)))}`;
  const key = await importVapidPrivate(env);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput),
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/* ── Payload encryption (RFC 8291, aes128gcm) ──────────────────────────── */

/**
 * Encrypt a JSON payload for one subscription.
 * Returns the complete request body: salt || rs || idlen || as_public || ciphertext.
 */
export async function encryptPayload(payloadObj, { p256dh, auth }, recordSize = 4096) {
  const uaPublic = b64urlToBytes(p256dh);
  const authSecret = b64urlToBytes(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('Subscription p256dh must be a 65-byte P-256 point');
  if (authSecret.length < 16) throw new Error('Subscription auth secret must be at least 16 bytes');

  // 1. Ephemeral key pair for this message; the public half travels in the header.
  const asPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asPair.publicKey));

  // 2. ECDH with the subscription key → shared secret.
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPair.privateKey, 256));

  // 3. Combine with the auth secret to get the input keying material.
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);

  // 4. Per-message content key + nonce.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  void prk;

  // 5. Plaintext gets the RFC 8188 last-record delimiter.
  const body = concat(enc.encode(JSON.stringify(payloadObj)), new Uint8Array([0x02]));

  // 6. Header doubles as the AEAD associated data.
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, recordSize);
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);

  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: header, tagLength: 128 },
    await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']),
    body,
  ));

  return concat(header, ciphertext);
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* ── Sending ───────────────────────────────────────────────────────────── */

/** TTL for a job alert: an unread alert is useless after the shift. */
const TTL = 30 * 60;

/**
 * Deliver one notification to every subscription of one technician.
 *
 * Best-effort by design: a dead subscription must never fail the dispatch
 * action that triggered it. Returns a small report the caller can log or
 * surface, and prunes endpoints the push service says are gone (404/410).
 */
export async function notifyTechnician(env, db, techId, payload, { fetchImpl = fetch } = {}) {
  if (!pushConfigured(env)) return { sent: 0, pruned: 0, reason: 'push-not-configured' };
  if (!db || !techId) return { sent: 0, pruned: 0, reason: 'nothing-to-do' };

  const subs = await db.prepare(
    'SELECT endpoint, p256dh, auth FROM assist_push_subscriptions WHERE tech_id = ?',
  ).bind(techId).all();
  const rows = subs.results || [];
  if (!rows.length) return { sent: 0, pruned: 0, reason: 'no-subscriptions' };

  let sent = 0, pruned = 0, failed = 0;
  for (const row of rows) {
    try {
      const body = await encryptPayload(payload, row);
      const auth = await vapidAuthHeader(env, row.endpoint);
      const res = await fetchImpl(row.endpoint, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          TTL: String(TTL),
          Urgency: 'high',
        },
        body,
      });
      if (res.status === 404 || res.status === 410) {
        await db.prepare('DELETE FROM assist_push_subscriptions WHERE endpoint = ?').bind(row.endpoint).run();
        pruned++;
      } else if (res.ok) {
        sent++;
      } else {
        failed++;
      }
    } catch (_) {
      failed++;
    }
  }
  return { sent, pruned, failed, reason: sent ? 'ok' : (failed ? 'failed' : 'pruned') };
}
