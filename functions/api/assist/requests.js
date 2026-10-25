/* GET  /api/assist/requests — list customer's requests + quotes
   POST /api/assist/requests — create a new service request */
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
  const sub = bearerSub(context.request);
  if (!sub) return err('Authentication required.', 'UNAUTHENTICATED', 401);

  const db = context.env?.ASSIST_DB;
  if (!db) return notConfigured();

  if (context.request.method === 'GET') {
    // Return { requests: [...], quotes: [...] }. Replace with real DB query.
    return json({ requests: [], quotes: [] });
  }

  if (context.request.method === 'POST') {
    let body;
    try { body = await context.request.json(); } catch { return err('Invalid JSON body.', 'BAD_REQUEST', 400); }

    const { category, serviceType, locationLabel, locationLatitude, locationLongitude, powertrain, notes, memberPlanRequested } = body || {};

    if (!VALID_CATEGORIES.has(category)) return err('Invalid service category.', 'INVALID_CATEGORY', 400);
    if (!VALID_SERVICE_TYPES.has(serviceType)) return err('Invalid service type.', 'INVALID_SERVICE_TYPE', 400);
    const lat = parseFloat(locationLatitude);
    const lng = parseFloat(locationLongitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return err('Valid location coordinates are required.', 'INVALID_LOCATION', 400);

    // Insert into assist_service_requests. Replace with actual insert.
    return json({
      request: {
        id: crypto.randomUUID(),
        category, serviceType,
        status: 'submitted',
        locationLabel: locationLabel || 'Map-selected location',
        locationLatitude: String(lat), locationLongitude: String(lng),
        memberPlanRequested: Boolean(memberPlanRequested),
        intakeNotes: notes || '',
        assignedDispatcherId: null, providerLabel: null, scheduledWindow: null,
        requestedAt: new Date().toISOString(),
      },
      notice: 'Your DREV Assist review request has been submitted. It is not an accepted job, ETA, or provider assignment.',
    });
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);
}
