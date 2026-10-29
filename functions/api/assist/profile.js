/* GET   /api/assist/profile — customer + vehicles + homes for the signed-in user
   PATCH /api/assist/profile — update displayName / phone / email
   Identity comes only from a *verified* JWT `sub` (see _shared.authenticate).
*/
import { json, err, notConfigured, handleOptions, parseJsonBody, cleanText, isEmail, isPhone, requireAuth } from './_shared.js';

async function ensureCustomer(db, sub) {
  await db.prepare(
    'INSERT INTO assist_customers (id) VALUES (?) ON CONFLICT(id) DO NOTHING',
  ).bind(sub).run();
}

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);

  const { claims, error } = await requireAuth(request, env, opts);
  if (error) return error;
  const db = env?.ASSIST_DB;
  if (!db) return notConfigured(opts);
  await ensureCustomer(db, claims.sub);

  if (request.method === 'GET') {
    const [customer, vehicles, homes] = await Promise.all([
      db.prepare('SELECT id, display_name, phone, email, created_at FROM assist_customers WHERE id = ?').bind(claims.sub).first(),
      db.prepare('SELECT * FROM assist_vehicles WHERE customer_id = ? ORDER BY created_at DESC').bind(claims.sub).all(),
      db.prepare('SELECT * FROM assist_homes WHERE customer_id = ? ORDER BY created_at DESC').bind(claims.sub).all(),
    ]);
    return json({
      customer: customer
        ? { id: customer.id, displayName: customer.display_name, phone: customer.phone, email: customer.email, createdAt: customer.created_at }
        : { id: claims.sub, displayName: null, phone: null, email: claims.email || null },
      vehicles: vehicles.results || [],
      homes: homes.results || [],
      paymentMethods: [], // populated by the billing provider, never by this API
    }, 200, opts);
  }

  if (request.method === 'PATCH') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    const [displayName, e1] = cleanText(body.displayName, { max: 100, field: 'Name' });
    const [phone, e2] = cleanText(body.phone, { max: 32, field: 'Phone' });
    const [email, e3] = cleanText(body.email, { max: 254, field: 'Email' });
    for (const e of [e1, e2, e3]) if (e) return err(e, 'INVALID_FIELD', 400, opts);
    if (phone && !isPhone(phone)) return err('Phone number looks invalid.', 'INVALID_PHONE', 400, opts);
    if (email && !isEmail(email)) return err('Email address looks invalid.', 'INVALID_EMAIL', 400, opts);
    if (!displayName && !phone && !email) return err('Nothing to update.', 'EMPTY_UPDATE', 400, opts);

    const now = new Date().toISOString();
    await db.prepare(
      `UPDATE assist_customers SET
         display_name = COALESCE(NULLIF(?, ''), display_name),
         phone        = COALESCE(NULLIF(?, ''), phone),
         email        = COALESCE(NULLIF(?, ''), email),
         updated_at = ?
       WHERE id = ?`,
    ).bind(displayName, phone, email, now, claims.sub).run();
    return json({ ok: true }, 200, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}
