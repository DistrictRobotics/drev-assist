/* Admin API — requires ADMIN_KEY env var on CF Pages
   GET  /api/assist/admin         — list all requests
   PATCH /api/assist/admin        — update status { id, status }
*/
import { CORS, json, err } from './_shared.js';

const VALID_STATUSES = new Set(['submitted', 'reviewed', 'dispatched', 'complete', 'cancelled']);

function isAdmin(request, env) {
  const key = env.ADMIN_KEY;
  if (!key) return false;
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  return auth === key;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (!isAdmin(request, env)) return err('Unauthorized.', 'UNAUTHORIZED', 401);

  const db = env.ASSIST_DB;
  if (!db) return err('Database not configured.', 'NOT_CONFIGURED', 503);

  /* ── GET — list all requests ─────────────────────────── */
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 500);
    const status = url.searchParams.get('status');
    let query = 'SELECT * FROM assist_service_requests';
    const params = [];
    if (status && VALID_STATUSES.has(status)) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    query += ' ORDER BY requested_at DESC LIMIT ?';
    params.push(limit);
    const rows = await db.prepare(query).bind(...params).all();
    return json({ requests: rows.results || [] });
  }

  /* ── PATCH — update status ───────────────────────────── */
  if (request.method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return err('Invalid JSON.', 'BAD_REQUEST', 400); }
    const { id, status } = body || {};
    if (!id) return err('id required.', 'MISSING_ID', 400);
    if (!VALID_STATUSES.has(status)) return err('Invalid status.', 'INVALID_STATUS', 400);
    await db.prepare(
      'UPDATE assist_service_requests SET status = ?, updated_at = ? WHERE id = ?'
    ).bind(status, new Date().toISOString(), id).run();
    return json({ updated: true, id, status });
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);
}
