/* POST /api/assist/webhook — Stripe webhook handler.
   Raw-body HMAC verification with a 5-minute replay window and a
   timing-safe signature comparison. Only checkout.session.completed
   activates membership in D1. Supports key rotation (multiple v1 sigs). */
import { timingSafeEqual } from './_shared.js';

const TOLERANCE_SEC = 300;

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  let ts = null;
  const v1s = [];
  for (const part of sigHeader.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') ts = v;
    if (k === 'v1') v1s.push(v);
  }
  if (!ts || !v1s.length) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > TOLERANCE_SEC) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${rawBody}`));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return v1s.some(v1 => timingSafeEqual(hex, v1));
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const webhookSecret = env?.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return new Response('Webhook not configured.', { status: 503 });

  const rawBody = await request.text();
  const valid = await verifyStripeSignature(rawBody, request.headers.get('stripe-signature') || '', webhookSecret);
  if (!valid) return new Response('Invalid signature.', { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Bad JSON.', { status: 400 }); }

  const db = env?.ASSIST_DB;
  const now = new Date().toISOString();

  if (db && event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    const plan = session?.metadata?.plan;
    if (plan === 'essential' || plan === 'flex') {
      await db.prepare(
        `INSERT INTO assist_members (stripe_customer_id, stripe_subscription_id, email, plan, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)
         ON CONFLICT(stripe_customer_id) DO UPDATE SET
           stripe_subscription_id = excluded.stripe_subscription_id,
           plan = excluded.plan, status = 'active', updated_at = excluded.created_at`,
      ).bind(session.customer || '', session.subscription || '', session.customer_email || session.customer_details?.email || '', plan, now).run();
    }
  }

  if (db && event.type === 'customer.subscription.updated') {
    const sub = event.data?.object;
    const status = sub?.status === 'active' || sub?.status === 'trialing' ? 'active'
      : sub?.status === 'paused' ? 'paused' : null;
    if (status && sub?.customer) {
      await db.prepare('UPDATE assist_members SET status = ?, updated_at = ? WHERE stripe_customer_id = ?')
        .bind(status, now, sub.customer).run();
    }
  }

  if (db && event.type === 'customer.subscription.deleted') {
    const customerId = event.data?.object?.customer || '';
    if (customerId) {
      await db.prepare("UPDATE assist_members SET status = 'cancelled', updated_at = ? WHERE stripe_customer_id = ?")
        .bind(now, customerId).run();
    }
  }

  return new Response('ok', { status: 200 });
}
