/* GET /api/assist/dispatch — dispatcher workspace: open requests
   PUT /api/assist/dispatch — record a dispatcher update

   Requires a *verified* JWT carrying the `drev_dispatcher` group. Uses the
   same status vocabulary / state machine as the admin API — dispatcher
   updates are real D1 writes with an audit event, not placeholders.
*/
import {
  VALID_STATUSES, canTransition,
  json, err, notConfigured, handleOptions, parseJsonBody, cleanText, requireAuth, isDispatcher,
} from './_shared.js';

/* Legacy dispatcher vocabulary → shared vocabulary. */
const STATUS_ALIASES = { reviewing: 'reviewed', assigned: 'dispatched', en_route: 'dispatched', arrived: 'dispatched', in_service: 'dispatched', completed: 'complete', scheduled: 'dispatched', quoted: 'reviewed', payment_pending: 'reviewed', closed: 'complete' };

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);

  const { claims, error } = await requireAuth(request, env, opts);
  if (error) return error;
  if (!isDispatcher(claims)) {
    return err('Dispatcher role required. This endpoint does not elevate a customer account.', 'FORBIDDEN', 403, opts);
  }
  const db = env?.ASSIST_DB;
  if (!db) return notConfigured(opts);

  if (request.method === 'GET') {
    const rows = await db.prepare(
      `SELECT * FROM assist_service_requests
       WHERE status NOT IN ('complete', 'cancelled')
       ORDER BY requested_at ASC LIMIT 200`,
    ).all();
    return json({ requests: rows.results || [] }, 200, opts);
  }

  if (request.method === 'PUT') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    const { requestId } = body || {};
    if (!requestId) return err('requestId is required.', 'MISSING_REQUEST_ID', 400, opts);

    let status = body.status ? STATUS_ALIASES[body.status] || body.status : undefined;
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return err('Invalid status value.', 'INVALID_STATUS', 400, opts);
    }
    const [providerLabel, e1] = cleanText(body.providerLabel, { max: 120, field: 'Provider' });
    const [scheduledWindow, e2] = cleanText(body.scheduledWindow, { max: 120, field: 'Scheduled window' });
    const [note, e3] = cleanText(body.note, { max: 500, field: 'Note' });
    for (const e of [e1, e2, e3]) if (e) return err(e, 'INVALID_FIELD', 400, opts);

    const row = await db.prepare('SELECT * FROM assist_service_requests WHERE id = ?').bind(requestId).first();
    if (!row) return err('Request not found.', 'NOT_FOUND', 404, opts);
    if (status !== undefined && status !== row.status && !canTransition(row.status, status)) {
      return err(`Cannot move a ${row.status} request to ${status}.`, 'INVALID_TRANSITION', 409, opts);
    }

    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE assist_service_requests SET status = ?, provider_label = ?, scheduled_window = ?, assigned_dispatcher_id = ?, updated_at = ? WHERE id = ?',
    ).bind(
      status ?? row.status,
      providerLabel || row.provider_label,
      scheduledWindow || row.scheduled_window,
      claims.sub, now, requestId,
    ).run();
    await db.prepare(
      'INSERT INTO assist_request_events (id, request_id, actor, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), requestId, 'dispatcher', row.status, status ?? row.status, note || null, now).run();
    return json({ ok: true, id: requestId, status: status ?? row.status }, 200, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}
