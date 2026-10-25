/* POST /api/assist/homes — save a home planning location to the authenticated profile */
import { CORS, json, err, notConfigured, bearerSub } from './_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const sub = bearerSub(context.request);
  if (!sub) return err('Authentication required.', 'UNAUTHENTICATED', 401);

  const db = context.env?.ASSIST_DB;
  if (!db) return notConfigured();

  if (context.request.method === 'POST') {
    let body;
    try { body = await context.request.json(); } catch { return err('Invalid JSON body.', 'BAD_REQUEST', 400); }
    const { label, addressLine1, city, region, postalCode } = body || {};
    if (!addressLine1 || !region) return err('Address and region are required.', 'MISSING_FIELDS', 400);
    // Insert into assist_homes. Replace with actual insert.
    return json({ ok: true, home: { id: crypto.randomUUID(), label, addressLine1, city, region, postalCode } });
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);
}
