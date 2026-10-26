/* GET  /api/assist/requests — list requests (requires auth)
   POST /api/assist/requests — create a service request (public intake, no auth needed) */
import { CORS, json, err, notConfigured, bearerSub } from './_shared.js';

const VALID_CATEGORIES = new Set(['roadside', 'home']);
const VALID_SERVICE_TYPES = new Set([
  'mobile-ev-charge', 'fuel-delivery', 'jump-start', 'flat-tire',
  'lockout', 'tow-coordination', 'collision-incident', 'other-roadside',
  'v2h-planning', 'home-charger-install', 'home-charger-repair',
  'panel-battery-review', 'outage-readiness', 'other-home',
]);

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const db = context.env?.ASSIST_DB;

  /* ── GET — authenticated list ─────────────────────────── */
  if (context.request.method === 'GET') {
    const sub = bearerSub(context.request);
    if (!sub) return err('Authentication required.', 'UNAUTHENTICATED', 401);
    if (!db) return notConfigured();
    const rows = await db.prepare(
      'SELECT * FROM assist_service_requests WHERE customer_id = ? ORDER BY requested_at DESC LIMIT 50'
    ).bind(sub).all();
    return json({ requests: rows.results || [] });
  }

  /* ── POST — public intake, no auth required ────────────── */
  if (context.request.method === 'POST') {
    let body;
    try { body = await context.request.json(); } catch { return err('Invalid JSON body.', 'BAD_REQUEST', 400); }

    const {
      category, serviceType,
      locationLabel, locationLatitude, locationLongitude,
      powertrain, vehicle, notes, memberPlanRequested,
      customerName, customerPhone, customerEmail,
    } = body || {};

    if (!VALID_CATEGORIES.has(category))    return err('Invalid service category.', 'INVALID_CATEGORY', 400);
    if (!VALID_SERVICE_TYPES.has(serviceType)) return err('Invalid service type.', 'INVALID_SERVICE_TYPE', 400);
    const lat = parseFloat(locationLatitude);
    const lng = parseFloat(locationLongitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return err('Valid location coordinates are required.', 'INVALID_LOCATION', 400);

    const id  = crypto.randomUUID();
    const now = new Date().toISOString();

    if (db) {
      try {
        await db.prepare(`
          INSERT INTO assist_service_requests
            (id, category, service_type, status,
             location_label, location_lat, location_lng,
             powertrain, vehicle, intake_notes, member_plan_requested,
             customer_name, customer_phone, customer_email, requested_at)
          VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id, category, serviceType,
          locationLabel || null, lat, lng,
          powertrain || null, vehicle || null, notes || null,
          memberPlanRequested ? 1 : 0,
          customerName || null, customerPhone || null, customerEmail || null,
          now,
        ).run();
      } catch (dbErr) {
        console.error('D1 insert error:', dbErr?.message);
      }
    }

    return json({
      request: {
        id, category, serviceType,
        status: 'submitted',
        locationLabel: locationLabel || 'Map-selected location',
        locationLatitude: String(lat), locationLongitude: String(lng),
        memberPlanRequested: Boolean(memberPlanRequested),
        intakeNotes: notes || '',
        requestedAt: now,
      },
      notice: 'Your DREV Assist review request has been submitted. It is not an accepted job, ETA, or provider assignment.',
    }, 201);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);
}
