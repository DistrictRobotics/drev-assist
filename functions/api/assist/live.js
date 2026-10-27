/* GET /api/assist/live — realtime picture for the maps.
 *
 * Public callers get aggregates only (counts + coarse, rounded demand
 * points). The full picture — individual open requests and the provider
 * fleet — requires the admin key or a verified dispatcher JWT, because
 * precise stranded-driver locations are sensitive.
 *
 * Provider positions are a deterministic simulation until a real GPS feed
 * is connected, and are always labelled `simulated: true`.
 */
import { json, err, handleOptions, adminKeyMatches, requireAuth, isDispatcher, rateLimit } from './_shared.js';
import { providersSnapshot, OUTAGE_ZONES } from './_live-sim.js';

const round3 = n => Math.round(Number(n) * 1000) / 1000;

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);
  if (request.method !== 'GET') return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);

  const db = env?.ASSIST_DB;
  if (db && !(await rateLimit(db, request, 'live', 120, 60))) {
    return err('Too many live-feed requests.', 'RATE_LIMITED', 429, opts);
  }

  // Who is asking?
  let privileged = false;
  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (provided && await adminKeyMatches(provided, env)) privileged = true;
  if (!privileged && provided) {
    const { claims } = await requireAuth(request, env, opts).catch(() => ({}));
    // requireAuth returns an error Response for bad tokens; only a verified
    // dispatcher claim elevates. A plain customer token stays public-level.
    if (claims && isDispatcher(claims)) privileged = true;
  }

  let open = [];
  if (db) {
    try {
      const rows = await db.prepare(
        `SELECT id, category, service_type, status, location_label, location_lat, location_lng, requested_at, updated_at, provider_label
         FROM assist_service_requests
         WHERE status NOT IN ('complete', 'cancelled')
         ORDER BY requested_at DESC LIMIT 500`,
      ).all();
      open = rows.results || [];
    } catch { open = []; }
  }

  const byStatus = {};
  for (const r of open) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

  const base = {
    generatedAt: new Date().toISOString(),
    simulatedProviders: true,
    openByStatus: byStatus,
    openTotal: open.length,
  };

  if (!privileged) {
    // Coarse demand only: coordinates rounded to ~100 m, no ids or labels.
    return json({
      ...base,
      demand: open
        .filter(r => Number.isFinite(r.location_lat) && Number.isFinite(r.location_lng))
        .map(r => ({ lng: round3(r.location_lng), lat: round3(r.location_lat), status: r.status })),
    }, 200, opts);
  }

  return json({
    ...base,
    requests: open.map(r => ({
      id: r.id, category: r.category, serviceType: r.service_type, status: r.status,
      locationLabel: r.location_label,
      location_lat: r.location_lat, location_lng: r.location_lng,
      requestedAt: r.requested_at, providerLabel: r.provider_label,
    })),
    providers: providersSnapshot(),
    outages: OUTAGE_ZONES,
  }, 200, opts);
}
