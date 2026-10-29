/* GET    /api/assist/vehicles      — list the signed-in customer's vehicles
   POST   /api/assist/vehicles      — add a vehicle
   DELETE /api/assist/vehicles?id=  — remove one of your own vehicles
*/
import { json, err, notConfigured, handleOptions, parseJsonBody, cleanText, requireAuth, VALID_POWERTRAINS } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);

  const { claims, error } = await requireAuth(request, env, opts);
  if (error) return error;
  const db = env?.ASSIST_DB;
  if (!db) return notConfigured(opts);
  await db.prepare('INSERT INTO assist_customers (id) VALUES (?) ON CONFLICT(id) DO NOTHING').bind(claims.sub).run();

  if (request.method === 'GET') {
    const rows = await db.prepare(
      'SELECT * FROM assist_vehicles WHERE customer_id = ? ORDER BY created_at DESC',
    ).bind(claims.sub).all();
    return json({ vehicles: rows.results || [] }, 200, opts);
  }

  if (request.method === 'POST') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    const [make, e1] = cleanText(body.make, { max: 60, required: true, field: 'Vehicle make' });
    const [model, e2] = cleanText(body.model, { max: 60, field: 'Vehicle model' });
    const [plate, e3] = cleanText(body.plateLastFour, { max: 4, field: 'Plate' });
    for (const e of [e1, e2, e3]) if (e) return err(e, 'INVALID_FIELD', 400, opts);
    if (plate && !/^[A-Za-z0-9]{4}$/.test(plate)) return err('Plate must be the last 4 letters/digits.', 'INVALID_PLATE', 400, opts);
    const year = body.year === undefined || body.year === '' ? null : Number(body.year);
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear() + 2)) {
      return err('Vehicle year looks invalid.', 'INVALID_YEAR', 400, opts);
    }
    const powertrain = body.powertrain ? String(body.powertrain).toLowerCase() : null;
    if (powertrain && !VALID_POWERTRAINS.has(powertrain)) {
      return err('Powertrain must be "ev" or "ice".', 'INVALID_POWERTRAIN', 400, opts);
    }
    const vehicle = {
      id: crypto.randomUUID(), customer_id: claims.sub,
      make, model: model || null, year, powertrain, plate_last_four: plate ? plate.toUpperCase() : null,
    };
    await db.prepare(
      'INSERT INTO assist_vehicles (id, customer_id, make, model, year, powertrain, plate_last_four) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(vehicle.id, vehicle.customer_id, vehicle.make, vehicle.model, vehicle.year, vehicle.powertrain, vehicle.plate_last_four).run();
    return json({ ok: true, vehicle }, 201, opts);
  }

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return err('id required.', 'MISSING_ID', 400, opts);
    const res = await db.prepare(
      'DELETE FROM assist_vehicles WHERE id = ? AND customer_id = ?',
    ).bind(id, claims.sub).run();
    if (!res.meta?.changes) return err('Vehicle not found.', 'NOT_FOUND', 404, opts);
    return json({ ok: true, deleted: id }, 200, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}
