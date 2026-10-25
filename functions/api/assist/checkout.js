/* POST /api/assist/checkout — create a Stripe Checkout Session for membership or a quote.
   No card PAN, CVC, or Stripe secret key is ever sent to the browser.
   Only a verified raw-body Stripe webhook may activate membership or mark a quote paid. */
import { CORS, json, err, notConfigured, bearerSub } from './_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const sub = bearerSub(context.request);
  if (!sub) return err('Authentication required.', 'UNAUTHENTICATED', 401);

  const stripeSecret = context.env?.STRIPE_SECRET_KEY;
  const db = context.env?.ASSIST_DB;
  if (!db) return notConfigured();
  if (!stripeSecret) return err('Payment processing is not yet configured for DREV Assist.', 'PAYMENT_NOT_CONFIGURED', 503);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON body.', 'BAD_REQUEST', 400); }
  const { kind, requestId, quoteId } = body || {};

  if (kind === 'membership') {
    // Create a Stripe Checkout Session for the DREV Assist membership plan.
    // Replace STRIPE_MEMBERSHIP_PRICE_ID env var with the real price_xxx from your Stripe dashboard.
    const priceId = context.env?.STRIPE_MEMBERSHIP_PRICE_ID;
    if (!priceId) return err('Membership price is not configured.', 'PRICE_NOT_CONFIGURED', 503);

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        mode: 'subscription',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        success_url: `${new URL(context.request.url).origin}/?assist_checkout=success`,
        cancel_url: `${new URL(context.request.url).origin}/?assist_checkout=cancelled`,
        'metadata[sub]': sub,
        'metadata[kind]': 'membership',
      }),
    });
    const session = await response.json();
    if (!response.ok || !session.url) return err(session.error?.message || 'Stripe did not return a checkout URL.', 'STRIPE_ERROR', 502);
    return json({ checkoutUrl: session.url });
  }

  if (kind === 'quote') {
    if (!requestId || !quoteId) return err('requestId and quoteId are required for a quote checkout.', 'MISSING_IDS', 400);
    // Fetch quote from DB to verify it belongs to this sub and get priceId / amountCents.
    // Replace with actual DB lookup.
    return err('Quote checkout requires a connected database.', 'DATABASE_NOT_CONNECTED', 503);
  }

  return err('Unsupported checkout kind.', 'INVALID_KIND', 400);
}
