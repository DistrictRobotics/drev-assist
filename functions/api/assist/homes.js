/* GET    /api/assist/homes      — list the signed-in customer's homes
   POST   /api/assist/homes      — save a home planning location
   DELETE /api/assist/homes?id=  — remove one of your own homes
*/
import { json, err, notConfigured, handleOptions, parseJsonBody, cleanText, requireAuth } from './_shared.js';

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
      'SELECT * FROM assist_homes WHERE customer_id = ? ORDER BY created_at DESC',
    ).bind(claims.sub).all();
    return json({ homes: rows.results || [] }, 200, opts);
  }

  if (request.method === 'POST') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    const [label, e0] = cleanText(body.label, { max: 60, field: 'Label' });
    const [addressLine1, e1] = cleanText(body.addressLine1, { max: 200, required: true, field: 'Address' });
    const [city, e2] = cleanText(body.city, { max: 100, field: 'City' });
    const [region, e3] = cleanText(body.region, { max: 100, required: true, field: 'State/region' });
    const [postalCode, e4] = cleanText(body.postalCode, { max: 20, field: 'Postal code' });
    for (const e of [e0, e1, e2, e3, e4]) if (e) return err(e, 'INVALID_FIELD', 400, opts);
    const home = {
      id: crypto.randomUUID(), customer_id: claims.sub,
      label: label || null, address_line1: addressLine1, city: city || null,
      region, postal_code: postalCode || null,
    };
    await db.prepare(
      'INSERT INTO assist_homes (id, customer_id, label, address_line1, city, region, postal_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(home.id, home.customer_id, home.label, home.address_line1, home.city, home.region, home.postal_code).run();
    return json({ ok: true, home }, 201, opts);
  }

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return err('id required.', 'MISSING_ID', 400, opts);
    const res = await db.prepare(
      'DELETE FROM assist_homes WHERE id = ? AND customer_id = ?',
    ).bind(id, claims.sub).run();
    if (!res.meta?.changes) return err('Home not found.', 'NOT_FOUND', 404, opts);
    return json({ ok: true, deleted: id }, 200, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}
