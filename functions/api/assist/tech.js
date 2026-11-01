/* Technician (field) API — the app a driver actually uses on the road.
 *
 *   POST  /api/assist/tech   { action: 'login', code }   → shift session token
 *   POST  /api/assist/tech   { action: 'logout' }        → revoke the session
 *   GET   /api/assist/tech                                → my jobs
 *   PATCH /api/assist/tech   { id, status, note? }        → advance one of MY jobs
 *
 * Two ways to be a technician:
 *   1. A shift session: a per-tech access code (stored only as a SHA-256
 *      digest) is exchanged for a random token, itself stored only as a
 *      digest and expiring after TECH_SESSION_TTL. This works on deployments
 *      with no identity provider configured, and each code identifies one
 *      person — never the shared admin key.
 *   2. A *verified* JWT carrying `drev_technician`, mapped to a provisioned
 *      technician record by `sub`. Same role check as dispatch.js.
 *
 * Scope rules, enforced server-side — not hidden in the UI:
 *   • a tech only ever sees jobs where assigned_tech_id = their own id
 *   • a tech can only move those jobs to en_route / arrived / complete
 *   • customer email is never returned to a field device
 */
import {
  VALID_STATUSES, canTransition,
  json, err, handleOptions, parseJsonBody, cleanText, isUuid,
  rateLimit, sha256Hex, clientIp, authenticate, authConfigured, isTechnician,
} from './_shared.js';

/** Shift length. Long enough for a day's work, short enough to bound a leak. */
export const TECH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** States a technician may set. Dispatch keeps control of cancel/reopen. */
export const TECH_SETTABLE = new Set(['en_route', 'arrived', 'complete']);

const ACTIVE_JOB_STATUSES = ['dispatched', 'en_route', 'arrived'];

/** Columns a field device is allowed to receive. No email, no customer_id. */
const JOB_COLUMNS = `id, category, service_type, status, location_label, location_lat, location_lng,
  vehicle, intake_notes, customer_name, customer_phone, provider_label, requested_at, updated_at`;

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Resolve the caller to a technician record, or an error response. */
async function resolveTech(request, env, opts) {
  const db = env.ASSIST_DB;
  const raw = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return { error: err('Technician sign-in required.', 'UNAUTHENTICATED', 401, opts) };

  // 1. Shift session token (what the tech app uses).
  const session = await db.prepare(
    'SELECT tech_id, expires_at FROM assist_tech_sessions WHERE token_hash = ?',
  ).bind(await sha256Hex(raw)).first();
  if (session && Number(session.expires_at) > Date.now()) {
    const tech = await db.prepare(
      'SELECT * FROM assist_technicians WHERE id = ? AND active = 1',
    ).bind(session.tech_id).first();
    if (tech) return { tech };
  }

  // 2. Verified JWT with the technician group, mapped to a provisioned record.
  if (authConfigured(env)) {
    const claims = await authenticate(request, env);
    if (claims && isTechnician(claims)) {
      const tech = await db.prepare(
        'SELECT * FROM assist_technicians WHERE id = ? AND active = 1',
      ).bind(String(claims.sub || '')).first();
      if (tech) return { tech };
      return { error: err('This account has no technician record. Ask dispatch to provision one.', 'TECH_NOT_PROVISIONED', 403, opts) };
    }
  }

  return { error: err('Technician sign-in required.', 'UNAUTHENTICATED', 401, opts) };
}

function publicTech(tech) {
  return { id: tech.id, name: tech.name, unit: tech.unit || null, phone: tech.phone || null };
}

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);

  const db = env?.ASSIST_DB;
  if (!db) return err('Database not configured.', 'NOT_CONFIGURED', 503, opts);

  /* ── POST — login / logout (the only unauthenticated action) ─────────── */
  if (request.method === 'POST') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    const action = body?.action;

    if (action === 'login') {
      // Brute-force budget per IP: 10 attempts per 5 minutes.
      if (!(await rateLimit(db, request, 'tech-login', 10, 300))) {
        return err('Too many sign-in attempts. Wait a few minutes.', 'RATE_LIMITED', 429, opts);
      }
      const [code, codeErr] = cleanText(body?.code, { max: 200, required: true, field: 'Access code' });
      if (codeErr) return err('Access code required.', 'MISSING_CODE', 400, opts);

      const tech = await db.prepare(
        'SELECT * FROM assist_technicians WHERE access_code_hash = ? AND active = 1',
      ).bind(await sha256Hex(code)).first();
      // Same answer for "no such code" and "inactive tech".
      if (!tech) return err('That access code was not recognised.', 'INVALID_CODE', 401, opts);

      const token = newToken();
      const expiresAt = Date.now() + TECH_SESSION_TTL_MS;
      await db.prepare('DELETE FROM assist_tech_sessions WHERE expires_at < ?').bind(Date.now()).run();
      await db.prepare(
        'INSERT INTO assist_tech_sessions (token_hash, tech_id, expires_at) VALUES (?, ?, ?)',
      ).bind(await sha256Hex(token), tech.id, expiresAt).run();
      await db.prepare('UPDATE assist_technicians SET last_seen_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), tech.id).run();

      return json({ token, expiresAt, tech: publicTech(tech) }, 200, opts);
    }

    if (action === 'logout') {
      const raw = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
      if (raw) {
        await db.prepare('DELETE FROM assist_tech_sessions WHERE token_hash = ?')
          .bind(await sha256Hex(raw)).run();
      }
      return json({ signedOut: true }, 200, opts);
    }

    return err('Unknown action.', 'INVALID_ACTION', 400, opts);
  }

  /* ── Everything below needs a technician ─────────────────────────────── */
  const { tech, error } = await resolveTech(request, env, opts);
  if (error) return error;
  if (!(await rateLimit(db, request, 'tech', 240, 60))) {
    return err('Too many requests.', 'RATE_LIMITED', 429, opts);
  }

  /* ── GET — my jobs (active first, then recent history) ───────────────── */
  if (request.method === 'GET') {
    const active = await db.prepare(
      `SELECT ${JOB_COLUMNS} FROM assist_service_requests
       WHERE assigned_tech_id = ? AND status IN ('dispatched','en_route','arrived')
       ORDER BY requested_at ASC`,
    ).bind(tech.id).all();
    const recent = await db.prepare(
      `SELECT ${JOB_COLUMNS} FROM assist_service_requests
       WHERE assigned_tech_id = ? AND status IN ('complete','cancelled')
       ORDER BY updated_at DESC LIMIT 10`,
    ).bind(tech.id).all();

    return json({
      tech: publicTech(tech),
      jobs: active.results || [],
      recent: recent.results || [],
    }, 200, opts);
  }

  /* ── PATCH — advance one of my jobs ─────────────────────────────────── */
  if (request.method === 'PATCH') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    const { id, status } = body || {};
    if (!id || typeof id !== 'string' || !isUuid(id)) return err('A valid job id is required.', 'MISSING_ID', 400, opts);
    const [note, noteErr] = cleanText(body?.note, { max: 500, field: 'Note' });
    if (noteErr) return err(noteErr, 'INVALID_FIELD', 400, opts);
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      return err('Invalid status.', 'INVALID_STATUS', 400, opts);
    }
    if (status !== undefined && !TECH_SETTABLE.has(status)) {
      return err('Technicians can only mark a job en route, arrived, or complete.', 'FORBIDDEN_STATUS', 403, opts);
    }
    if (status === undefined && !note) return err('Nothing to update.', 'EMPTY_UPDATE', 400, opts);

    const row = await db.prepare('SELECT * FROM assist_service_requests WHERE id = ?').bind(id).first();
    if (!row) return err('Job not found.', 'NOT_FOUND', 404, opts);
    // Ownership is the important check: a tech never touches another's job.
    if (row.assigned_tech_id !== tech.id) {
      return err('That job is not assigned to you.', 'NOT_YOUR_JOB', 403, opts);
    }
    if (status !== undefined && status !== row.status && !canTransition(row.status, status)) {
      return err(`Cannot move a ${row.status} job to ${status}.`, 'INVALID_TRANSITION', 409, opts);
    }

    const now = new Date().toISOString();
    await db.prepare(
      'UPDATE assist_service_requests SET status = ?, updated_at = ? WHERE id = ?',
    ).bind(status ?? row.status, now, id).run();
    await db.prepare(
      'INSERT INTO assist_request_events (id, request_id, actor, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      crypto.randomUUID(), id, 'technician', row.status, status ?? row.status,
      note || `${tech.name}${tech.unit ? ` · ${tech.unit}` : ''}`.trim(), now,
    ).run();

    const updated = await db.prepare(
      `SELECT ${JOB_COLUMNS} FROM assist_service_requests WHERE id = ?`,
    ).bind(id).first();
    return json({ updated: true, job: updated, tech: publicTech(tech) }, 200, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}

/* Exported for tests: the exact columns a field device may receive. */
export const TECH_JOB_FIELDS = JOB_COLUMNS.split(',').map(s => s.trim());
export const TECH_ACTIVE_STATUSES = ACTIVE_JOB_STATUSES;
export { clientIp };
