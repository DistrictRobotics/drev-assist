/* GET  /api/assist/status/:id — public status lookup by unguessable UUID.
   POST /api/assist/status/:id — customer cancels their own request
        (only while it is still `submitted` or `reviewed`).

   Returns the minimum a customer needs — never PII beyond what tracking
   requires (provider label / scheduled window once dispatched).
*/
import { json, err, handleOptions, parseJsonBody, isUuid, rateLimit, canTransition } from '../_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);
  if (!['GET', 'POST'].includes(request.method)) {
    return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
  }

  const db = env?.ASSIST_DB;
  if (!db) return err('Not configured.', 'NOT_CONFIGURED', 503, opts);
  if (!(await rateLimit(db, request, 'status', 60, 60))) {
    return err('Too many lookups. Please wait a minute.', 'RATE_LIMITED', 429, opts);
  }

  const id = context.params?.id?.trim();
  if (!id || !isUuid(id)) return err('Invalid request ID.', 'INVALID_ID', 400, opts);

  const row = await db.prepare(
    `SELECT id, category, service_type, status, requested_at, updated_at, provider_label, scheduled_window
     FROM assist_service_requests WHERE id = ?`,
  ).bind(id).first();
  if (!row) return err('Request not found.', 'NOT_FOUND', 404, opts);

  if (request.method === 'POST') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    if (body?.action !== 'cancel') return err('Unknown action.', 'INVALID_ACTION', 400, opts);
    if (!canTransition(row.status, 'cancelled')) {
      return err(`A ${row.status} request can no longer be cancelled online — contact dispatch.`, 'CANNOT_CANCEL', 409, opts);
    }
    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE assist_service_requests SET status = ?, updated_at = ? WHERE id = ?',
    ).bind('cancelled', now, id).run();
    await db.prepare(
      'INSERT INTO assist_request_events (id, request_id, actor, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), id, 'customer', row.status, 'cancelled', now).run();
    row.status = 'cancelled';
    row.updated_at = now;
  }

  return json({
    request: {
      id: row.id,
      category: row.category,
      serviceType: row.service_type,
      status: row.status,
      requestedAt: row.requested_at,
      updatedAt: row.updated_at,
      ...(row.status === 'dispatched' || row.status === 'complete'
        ? { providerLabel: row.provider_label || null, scheduledWindow: row.scheduled_window || null }
        : {}),
      cancellable: canTransition(row.status, 'cancelled'),
    },
  }, 200, opts);
}
