/* GET /api/assist/profile  — returns customer + profile + vehicles + homes + paymentMethods
   PATCH /api/assist/profile — update displayName and profile sub-fields */
import { CORS, json, err, notConfigured, bearerSub } from './_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const sub = bearerSub(context.request);
  if (!sub) return err('Authentication required.', 'UNAUTHENTICATED', 401);

  // DB adapter wiring point — replace with real D1 / Hyperdrive query when connected.
  const db = context.env?.ASSIST_DB;
  if (!db) return notConfigured();

  if (context.request.method === 'GET') {
    // Query assist_customers + profiles + vehicles + homes by sub.
    // Placeholder — replace with actual DB query.
    return json({ customer: null, profile: {}, vehicles: [], homes: [], paymentMethods: [] });
  }

  if (context.request.method === 'PATCH') {
    let body;
    try { body = await context.request.json(); } catch { return err('Invalid JSON body.', 'BAD_REQUEST', 400); }
    // Persist displayName and profile fields. Replace with actual upsert.
    return json({ ok: true, notice: 'Profile update pending backend connection.' });
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);
}
