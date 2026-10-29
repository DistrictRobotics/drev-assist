/* Admin API — requires ADMIN_KEY env var (min 16 chars) on CF Pages.
   GET   /api/assist/admin?status=&q=&limit=&offset= — list requests
   PATCH /api/assist/admin — { id, status?, providerLabel?, scheduledWindow?, note? }

   The key is compared by SHA-256 digest (timing-safe), status changes must
   follow the shared state machine, every change writes an audit event, and
   PATCH on a missing / terminal request fails instead of pretending success.
*/
import {
  VALID_STATUSES, canTransition,
  json, err, handleOptions, parseJsonBody, cleanText, escapeLike,
  adminKeyMatches, isAdminConfigured, rateLimit,
} from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);

  if (!isAdminConfigured(env)) {
    return err('Admin access is not configured (set ADMIN_KEY, 16+ characters).', 'NOT_CONFIGURED', 503, opts);
  }
  const db = env.ASSIST_DB;
  if (db && !(await rateLimit(db, request, 'admin', 120, 60))) {
    return err('Too many admin requests.', 'RATE_LIMITED', 429, opts);
  }
  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await adminKeyMatches(provided, env))) {
    return err('Unauthorized.', 'UNAUTHORIZED', 401, opts);
  }
  if (!db) return err('Database not configured.', 'NOT_CONFIGURED', 503, opts);

  /* ── GET — list requests (paginated, filterable, searchable) ─────────── */
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 100, 1), 500);
    const offset = Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0);
    const status = url.searchParams.get('status');
    const q = (url.searchParams.get('q') || '').trim().slice(0, 100);

    const where = [];
    const params = [];
    if (status) {
      if (!VALID_STATUSES.has(status)) return err('Invalid status filter.', 'INVALID_STATUS', 400, opts);
      where.push('status = ?');
      params.push(status);
    }
    if (q) {
      where.push("(id LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' OR customer_phone LIKE ? ESCAPE '\\' OR location_label LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(q)}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const totalRow = await db.prepare(
      `SELECT COUNT(*) AS n FROM assist_service_requests${whereSql}`,
    ).bind(...params).first();
    const rows = await db.prepare(
      `SELECT * FROM assist_service_requests${whereSql} ORDER BY requested_at DESC LIMIT ? OFFSET ?`,
    ).bind(...params, limit, offset).all();
    return json({ requests: rows.results || [], total: totalRow?.n ?? 0, limit, offset }, 200, opts);
  }

  /* ── PATCH — status transition and/or dispatch details ────────────────── */
  if (request.method === 'PATCH') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    const { id, status } = body || {};
    if (!id || typeof id !== 'string') return err('id required.', 'MISSING_ID', 400, opts);

    const [providerLabel, e1] = cleanText(body.providerLabel, { max: 120, field: 'Provider' });
    const [scheduledWindow, e2] = cleanText(body.scheduledWindow, { max: 120, field: 'Scheduled window' });
    const [note, e3] = cleanText(body.note, { max: 500, field: 'Note' });
    for (const e of [e1, e2, e3]) if (e) return err(e, 'INVALID_FIELD', 400, opts);
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return err('Invalid status.', 'INVALID_STATUS', 400, opts);
    }
    if (status === undefined && !providerLabel && !scheduledWindow && !note) {
      return err('Nothing to update.', 'EMPTY_UPDATE', 400, opts);
    }

    const row = await db.prepare('SELECT * FROM assist_service_requests WHERE id = ?').bind(id).first();
    if (!row) return err('Request not found.', 'NOT_FOUND', 404, opts);
    if (status !== undefined && status !== row.status && !canTransition(row.status, status)) {
      return err(`Cannot move a ${row.status} request to ${status}.`, 'INVALID_TRANSITION', 409, opts);
    }

    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE assist_service_requests SET status = ?, provider_label = ?, scheduled_window = ?, updated_at = ? WHERE id = ?',
    ).bind(
      status ?? row.status,
      providerLabel || row.provider_label,
      scheduledWindow || row.scheduled_window,
      now, id,
    ).run();
    await db.prepare(
      'INSERT INTO assist_request_events (id, request_id, actor, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), id, 'admin', row.status, status ?? row.status, note || null, now).run();

    const updated = await db.prepare('SELECT * FROM assist_service_requests WHERE id = ?').bind(id).first();
    return json({ updated: true, request: updated }, 200, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}
