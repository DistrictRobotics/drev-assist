/* Admin API — requires ADMIN_KEY env var (min 16 chars) on CF Pages.
   GET   /api/assist/admin?status=&q=&limit=&offset= — list requests
   PATCH /api/assist/admin — { id, status?, providerLabel?, scheduledWindow?, assignedTechId?, note? }

   assignedTechId is how a dispatcher puts a *real* technician record on a job:
   the id is checked against the roster before it is stored, and the job then
   appears in that technician's own app. Passing an empty string unassigns.

   The key is compared by SHA-256 digest (timing-safe), status changes must
   follow the shared state machine, every change writes an audit event, and
   PATCH on a missing / terminal request fails instead of pretending success.
*/
import {
  VALID_STATUSES, canTransition,
  json, err, handleOptions, parseJsonBody, cleanText, escapeLike,
  adminKeyMatches, isAdminConfigured, rateLimit,
} from './_shared.js';
import { notifyTechnician } from './_push.js';

const SERVICE_NAMES = {
  'mobile-ev-charge': 'Mobile EV Charge', 'fuel-delivery': 'Fuel Delivery',
  'jump-start': 'Jump Start', 'flat-tire': 'Flat Tire', 'lockout': 'Lockout',
  'tow-coordination': 'Tow Coordination', 'collision-incident': 'Collision Incident',
  'other-roadside': 'Other Roadside', 'v2h-planning': 'V2H Planning',
  'home-charger-install': 'Charger Install', 'home-charger-repair': 'Charger Repair',
  'panel-battery-review': 'Panel Review', 'outage-readiness': 'Outage Readiness',
  'other-home': 'Other Home',
};

/** The alert a technician sees on their lock screen. Short, no PII spill. */
function jobAlert(updated, { assigned, fromStatus }) {
  const svc = SERVICE_NAMES[updated.service_type] || updated.service_type;
  const where = updated.location_label || 'your area';
  if (updated.status === 'cancelled') {
    return { title: `Job cancelled: ${svc}`, body: `${where} — dispatch cancelled this one.`, tag: `job-${updated.id}`, url: '/tech' };
  }
  if (updated.status === 'complete' && !assigned) {
    return null; // closing a job is not news to the tech who closed it
  }
  if (assigned || fromStatus === 'reviewed') {
    return {
      title: `New job: ${svc}`,
      body: `${where}${updated.vehicle ? ` · ${updated.vehicle}` : ''}`,
      tag: `job-${updated.id}`,
      url: '/tech',
      jobId: updated.id,
    };
  }
  return null;
}

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
    const [assignedTechId, e4] = cleanText(body.assignedTechId, { max: 64, field: 'Technician' });
    for (const e of [e1, e2, e3, e4]) if (e) return err(e, 'INVALID_FIELD', 400, opts);
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return err('Invalid status.', 'INVALID_STATUS', 400, opts);
    }
    if (status === undefined && !providerLabel && !scheduledWindow && !note
        && body.assignedTechId === undefined) {
      return err('Nothing to update.', 'EMPTY_UPDATE', 400, opts);
    }

    const row = await db.prepare('SELECT * FROM assist_service_requests WHERE id = ?').bind(id).first();
    if (!row) return err('Request not found.', 'NOT_FOUND', 404, opts);
    if (status !== undefined && status !== row.status && !canTransition(row.status, status)) {
      return err(`Cannot move a ${row.status} request to ${status}.`, 'INVALID_TRANSITION', 409, opts);
    }

    /* Validate the technician against the roster before storing anything.
       An empty string is an explicit unassign, not a missing value. */
    let tech = null;
    if (assignedTechId) {
      tech = await db.prepare('SELECT * FROM assist_technicians WHERE id = ? AND active = 1')
        .bind(assignedTechId).first();
      if (!tech) return err('Unknown or inactive technician.', 'UNKNOWN_TECHNICIAN', 400, opts);
    }
    const techId = body.assignedTechId === undefined
      ? (row.assigned_tech_id ?? null)
      : (assignedTechId || null);

    /* Dispatching to a tech names the provider on the job by default, so the
       customer's tracking view and the tech's app agree on who is coming. */
    const techLabel = tech ? [tech.name, tech.unit].filter(Boolean).join(' · ') : '';
    const finalProviderLabel = providerLabel || techLabel || row.provider_label;

    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE assist_service_requests SET status = ?, provider_label = ?, scheduled_window = ?, assigned_tech_id = ?, updated_at = ? WHERE id = ?',
    ).bind(
      status ?? row.status,
      finalProviderLabel,
      scheduledWindow || row.scheduled_window,
      techId,
      now, id,
    ).run();
    await db.prepare(
      'INSERT INTO assist_request_events (id, request_id, actor, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      crypto.randomUUID(), id, 'admin', row.status, status ?? row.status,
      note || (tech ? `Assigned to ${techLabel}` : null), now,
    ).run();

    const updated = await db.prepare('SELECT * FROM assist_service_requests WHERE id = ?').bind(id).first();

    /* Tell the technician's phone, if this change is theirs to act on.
       Best-effort: a push failure must never fail (or roll back) a dispatch
       action that already committed to D1. */
    let push = { send: 'not-applicable' };
    const techForPush = techId || null;
    if (techForPush && techForPush !== row.assigned_tech_id && status === 'dispatched') {
      // Assignment is the loud one.
      try {
        push = await notifyTechnician(env, db, techForPush, jobAlert(updated, { assigned: true, fromStatus: row.status }));
      } catch (e) { push = { send: 'failed', error: String(e?.message || e) }; }
    } else if (techForPush && status === 'cancelled') {
      try {
        push = await notifyTechnician(env, db, techForPush, jobAlert(updated, { assigned: false, fromStatus: row.status }));
      } catch (e) { push = { send: 'failed', error: String(e?.message || e) }; }
    }

    return json({ updated: true, request: updated, push }, 200, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}
