/* POST /api/assist/checkout — create a Stripe Checkout Session for membership.
   No card PAN, CVC, or Stripe secret key is ever sent to the browser.
   Only a verified raw-body Stripe webhook may activate membership. */
import { CORS, json, err } from './_shared.js';

const PLANS = {
  essential: {
    name: 'DREV Assist Essential',
    description: '2 roadside events/yr · Priority dispatch',
    amount: 800,   // cents
  },
  flex: {
    name: 'DREV Assist Flex',
    description: 'Unlimited roadside · Home energy consult · V2H planning included',
    amount: 1800,  // cents
  },
};

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);

  const stripeSecret = env?.STRIPE_SECRET_KEY;
  if (!stripeSecret) {
    return err('Payment processing is not yet configured.', 'PAYMENT_NOT_CONFIGURED', 503);
  }

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON body.', 'BAD_REQUEST', 400); }

  const planKey = String(body?.plan || '').toLowerCase();
  const plan = PLANS[planKey];
  if (!plan) return err('Unknown plan. Use "essential" or "flex".', 'INVALID_PLAN', 400);

  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/?assist_checkout=success&plan=${encodeURIComponent(planKey)}`;
  const cancelUrl  = `${origin}/`;

  const params = new URLSearchParams({
    mode: 'subscription',
    success_url: successUrl,
    cancel_url:  cancelUrl,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(plan.amount),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': plan.name,
    'line_items[0][price_data][product_data][description]': plan.description,
    'line_items[0][quantity]': '1',
    'metadata[source]': 'drev-assist',
    'metadata[plan]': planKey,
  });

  if (body.email) params.set('customer_email', String(body.email).trim().slice(0, 254));

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const session = await res.json();
  if (!res.ok || !session.url) {
    return err(session.error?.message || 'Stripe did not return a checkout URL.', 'STRIPE_ERROR', 502);
  }

  return json({ checkoutUrl: session.url, sessionId: session.id });
}
