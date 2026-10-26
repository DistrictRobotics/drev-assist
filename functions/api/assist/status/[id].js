/* Public status lookup — GET /api/assist/status/:id
   Returns minimal info: id, category, service_type, status, requested_at
   No auth needed — customers use their ref UUID to check status.
*/
import { CORS, json, err } from '../_shared.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const db = context.env?.ASSIST_DB;
  if (!db) return err('Not configured.', 'NOT_CONFIGURED', 503);

  const id = context.params?.id?.trim();
  if (!id) return err('ID required.', 'MISSING_ID', 400);

  const row = await db.prepare(
    'SELECT id, category, service_type, status, requested_at FROM assist_service_requests WHERE id = ?'
  ).bind(id).first();

  if (!row) return err('Request not found.', 'NOT_FOUND', 404);

  return json({ request: {
    id:          row.id,
    category:    row.category,
    serviceType: row.service_type,
    status:      row.status,
    requestedAt: row.requested_at,
  }});
}
