/* POST /api/assist/webhook — Stripe webhook handler.
   Raw body verification via STRIPE_WEBHOOK_SECRET.
   Only checkout.session.completed activates membership in D1. */
import { json, err } from './_shared.js';

const CORS_NONE = {}; // Stripe webhooks don't need CORS headers

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const payload = `${ts}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex === v1;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const webhookSecret = env?.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response('Webhook not configured.', { status: 503 });
  }

  const sigHeader = request.headers.get('stripe-signature') || '';
  const rawBody = await request.text();

  const valid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!valid) return new Response('Invalid signature.', { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Bad JSON.', { status: 400 }); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object;
    const plan = session?.metadata?.plan;
    const email = session?.customer_email || session?.customer_details?.email || '';
    const customerId = session?.customer || '';
    const subscriptionId = session?.subscription || '';

    const db = env?.ASSIST_DB;
    if (db && plan) {
      await db.prepare(
        `INSERT INTO assist_members (stripe_customer_id, stripe_subscription_id, email, plan, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)
         ON CONFLICT(stripe_customer_id) DO UPDATE SET
           stripe_subscription_id = excluded.stripe_subscription_id,
           plan = excluded.plan,
           status = 'active',
           updated_at = excluded.created_at`
      ).bind(customerId, subscriptionId, email, plan, new Date().toISOString()).run();
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data?.object;
    const customerId = sub?.customer || '';
    const db = env?.ASSIST_DB;
    if (db && customerId) {
      await db.prepare(
        `UPDATE assist_members SET status = 'cancelled', updated_at = ? WHERE stripe_customer_id = ?`
      ).bind(new Date().toISOString(), customerId).run();
    }
  }

  return new Response('ok', { status: 200 });
}
