/* GET  /api/assist/requests — list the signed-in customer's requests
   POST /api/assist/requests — create a service request (public intake)

   Intake is public (a stranded driver may have no account) but bounded:
   rate-limited per IP, size-capped, fully validated, and idempotent via
   the Idempotency-Key header so retries never create duplicates. A request
   is only acknowledged (201) after it is actually stored — if the database
   is not connected the API says so (503) instead of inventing a reference.
*/
import {
  SERVICE_CATALOG, VALID_POWERTRAINS,
  json, err, notConfigured, handleOptions, parseJsonBody, cleanText,
  isEmail, isPhone, rateLimit, requireAuth, authenticate, authConfigured,
} from './_shared.js';

function publicView(r) {
  return {
    id: r.id, category: r.category, serviceType: r.service_type, status: r.status,
    locationLabel: r.location_label, requestedAt: r.requested_at, updatedAt: r.updated_at,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);

  const db = env?.ASSIST_DB;

  /* ── GET — authenticated list (own requests only) ─────────────────────── */
  if (request.method === 'GET') {
    const { claims, error } = await requireAuth(request, env, opts);
    if (error) return error;
    if (!db) return notConfigured(opts);
    const rows = await db.prepare(
      'SELECT * FROM assist_service_requests WHERE customer_id = ? ORDER BY requested_at DESC LIMIT 50',
    ).bind(claims.sub).all();
    return json({ requests: (rows.results || []).map(publicView) }, 200, opts);
  }

  /* ── POST — public intake ─────────────────────────────────────────────── */
  if (request.method === 'POST') {
    if (!db) return notConfigured(opts);
    if (!(await rateLimit(db, request, 'intake', 10, 600))) {
      return err('Too many requests. Please wait a few minutes and try again.', 'RATE_LIMITED', 429, opts);
    }

    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;

    // Idempotent retry: a re-sent key returns the original request.
    const idemKey = (request.headers.get('Idempotency-Key') || body.idempotencyKey || '').trim().slice(0, 80);
    if (idemKey) {
      const existing = await db.prepare(
        'SELECT * FROM assist_service_requests WHERE idempotency_key = ?',
      ).bind(idemKey).first();
      if (existing) return json({ request: publicView(existing), deduplicated: true }, 200, opts);
    }

    const { category, serviceType } = body || {};
    const svc = SERVICE_CATALOG[serviceType];
    if (!svc) return err('Invalid service type.', 'INVALID_SERVICE_TYPE', 400, opts);
    if (svc.category !== category) {
      return err(`Service "${serviceType}" is not a ${category} service.`, 'CATEGORY_MISMATCH', 400, opts);
    }

    const lat = Number(body.locationLatitude);
    const lng = Number(body.locationLongitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return err('Valid location coordinates are required.', 'INVALID_LOCATION', 400, opts);
    }
    // Service area: continental US. Outside it we still accept home-energy
    // consults (they can be remote) but flag roadside for dispatcher review.
    const inServiceArea = lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66;

    let [locationLabel, e1] = cleanText(body.locationLabel, { max: 300, field: 'Location' });
    let [vehicle, e2] = cleanText(body.vehicle, { max: 120, field: 'Vehicle' });
    let [notes, e3] = cleanText(body.notes, { max: 2000, field: 'Notes' });
    let [customerName, e4] = cleanText(body.customerName, { max: 100, field: 'Name' });
    let [customerPhone, e5] = cleanText(body.customerPhone, { max: 32, field: 'Phone' });
    let [customerEmail, e6] = cleanText(body.customerEmail, { max: 254, field: 'Email' });
    for (const e of [e1, e2, e3, e4, e5, e6]) if (e) return err(e, 'INVALID_FIELD', 400, opts);

    if (category === 'roadside') {
      if (!customerName) return err('Your name is required so the dispatcher can reach you.', 'MISSING_NAME', 400, opts);
      if (!customerPhone || !isPhone(customerPhone)) {
        return err('A valid phone number is required for roadside requests.', 'INVALID_PHONE', 400, opts);
      }
      if (!vehicle) return err('Vehicle description is required for roadside requests.', 'MISSING_VEHICLE', 400, opts);
    } else {
      if (!customerPhone && !customerEmail) {
        return err('Provide a phone number or email so we can follow up.', 'MISSING_CONTACT', 400, opts);
      }
      if (customerPhone && !isPhone(customerPhone)) return err('Phone number looks invalid.', 'INVALID_PHONE', 400, opts);
    }
    if (customerEmail && !isEmail(customerEmail)) return err('Email address looks invalid.', 'INVALID_EMAIL', 400, opts);

    let powertrain = null;
    if (category === 'roadside') {
      powertrain = String(body.powertrain || '').toLowerCase();
      if (!VALID_POWERTRAINS.has(powertrain)) {
        return err('Powertrain must be "ev" or "ice".', 'INVALID_POWERTRAIN', 400, opts);
      }
    }
    if (body.memberPlanRequested !== undefined && typeof body.memberPlanRequested !== 'boolean') {
      return err('memberPlanRequested must be a boolean.', 'INVALID_FIELD', 400, opts);
    }

    // If the caller is signed in, attach the request to their account.
    // (Optional here — intake must also work for stranded non-members.)
    let customerId = null;
    if (authConfigured(env) && request.headers.get('Authorization')) {
      const claims = await authenticate(request, env);
      if (claims?.sub) customerId = claims.sub;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await db.prepare(`
        INSERT INTO assist_service_requests
          (id, category, service_type, status,
           location_label, location_lat, location_lng,
           powertrain, vehicle, intake_notes, member_plan_requested,
           customer_name, customer_phone, customer_email, customer_id,
           idempotency_key, requested_at, updated_at)
        VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id, category, serviceType,
        locationLabel || null, lat, lng,
        powertrain, vehicle || null, notes || null,
        body.memberPlanRequested ? 1 : 0,
        customerName || null, customerPhone || null, customerEmail || null,
        customerId, idemKey || null, now, now,
      ).run();
      await db.prepare(
        'INSERT INTO assist_request_events (id, request_id, actor, to_status, created_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), id, 'customer', 'submitted', now).run();
    } catch (dbErr) {
      // Never acknowledge a request we failed to store.
      console.error('D1 insert error:', dbErr?.message);
      return err('We could not save your request. Please try again.', 'STORAGE_FAILED', 500, opts);
    }

    return json({
      request: {
        id, category, serviceType, status: 'submitted',
        locationLabel: locationLabel || 'Map-selected location',
        memberPlanRequested: Boolean(body.memberPlanRequested),
        requestedAt: now,
        ...(inServiceArea ? {} : { serviceAreaWarning: 'Location appears outside the usual service area; a dispatcher will confirm coverage.' }),
      },
      notice: 'Your DREV Assist review request has been submitted. It is not an accepted job, ETA, or provider assignment.',
    }, 201, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}
