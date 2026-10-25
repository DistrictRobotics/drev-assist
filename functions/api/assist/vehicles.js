/* POST /api/assist/vehicles — save a vehicle to the authenticated profile */
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
    const { make, model, year, powertrain, plateLastFour } = body || {};
    if (!make) return err('Vehicle make is required.', 'MISSING_MAKE', 400);
    // Insert into assist_vehicles. Replace with actual insert.
    return json({ ok: true, vehicle: { id: crypto.randomUUID(), make, model, year, powertrain, plateLastFour } });
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);
}
