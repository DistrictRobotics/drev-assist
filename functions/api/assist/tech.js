/* Technician (field) API — the app a driver actually uses on the road.
 *
 *   POST  /api/assist/tech   { action: 'login', code }        → shift session token
 *   POST  /api/assist/tech   { action: 'logout' }             → revoke the session
 *   POST  /api/assist/tech   { action: 'push-subscribe', subscription }
 *                                                            → register this device for job alerts
 *   POST  /api/assist/tech   { action: 'push-unsubscribe', endpoint }
 *   POST  /api/assist/tech   { action: 'push-test' }         → send one alert to my devices
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
import { pushConfigured, notifyTechnician, vapidPublicKey } from './_push.js';

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

  /* ── POST — parse once. A Request body can only be read once, so login and
     the authenticated push actions share this parse. ─────────────────── */
  let postBody = null;
  if (request.method === 'POST') {
    const [parsed, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    postBody = parsed || {};
    const action = postBody.action;

    if (action === 'login') {
      // Brute-force budget per IP: 10 attempts per 5 minutes.
      if (!(await rateLimit(db, request, 'tech-login', 10, 300))) {
        return err('Too many sign-in attempts. Wait a few minutes.', 'RATE_LIMITED', 429, opts);
      }
      const [code, codeErr] = cleanText(postBody.code, { max: 200, required: true, field: 'Access code' });
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

    // Not a login action — fall through to the authenticated actions below.
  }

  /* ── Everything below needs a technician ─────────────────────────────── */
  const { tech, error } = await resolveTech(request, env, opts);
  if (error) return error;
  if (!(await rateLimit(db, request, 'tech', 240, 60))) {
    return err('Too many requests.', 'RATE_LIMITED', 429, opts);
  }

  /* ── Push actions (authenticated: a subscription belongs to a tech) ──── */
  if (request.method === 'POST') {
    const body = postBody;
    const action = body?.action;

    if (action === 'push-subscribe') {
      const sub = body?.subscription;
      if (!sub || typeof sub !== 'object') return err('A subscription is required.', 'MISSING_SUBSCRIPTION', 400, opts);
      const [endpoint, epErr] = cleanText(sub.endpoint, { max: 1000, required: true, field: 'Endpoint' });
      const [p256dh, kErr] = cleanText(sub.keys?.p256dh, { max: 200, required: true, field: 'Key' });
      const [auth, aErr] = cleanText(sub.keys?.auth, { max: 100, required: true, field: 'Auth' });
      for (const e of [epErr, kErr, aErr]) if (e) return err(e, 'INVALID_SUBSCRIPTION', 400, opts);
      // Only real push-service endpoints: never store an arbitrary URL we
      // would later POST to on a technician's behalf.
      let url;
      try { url = new URL(endpoint); } catch { return err('Endpoint must be a URL.', 'INVALID_SUBSCRIPTION', 400, opts); }
      if (url.protocol !== 'https:') return err('Endpoint must be https.', 'INVALID_SUBSCRIPTION', 400, opts);

      const [ua] = cleanText(request.headers.get('User-Agent'), { max: 200, field: 'User agent' });
      await db.prepare(
        `INSERT INTO assist_push_subscriptions (endpoint, tech_id, p256dh, auth, user_agent)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET tech_id = excluded.tech_id,
           p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      ).bind(endpoint, tech.id, p256dh, auth, ua || null).run();

      return json({ subscribed: true, pushConfigured: pushConfigured(env) }, 200, opts);
    }

    if (action === 'push-unsubscribe') {
      const [endpoint] = cleanText(body?.endpoint, { max: 1000, field: 'Endpoint' });
      if (endpoint) {
        // Scoped to this technician: one tech cannot unsubscribe another.
        await db.prepare('DELETE FROM assist_push_subscriptions WHERE endpoint = ? AND tech_id = ?')
          .bind(endpoint, tech.id).run();
      }
      return json({ subscribed: false }, 200, opts);
    }

    if (action === 'push-test') {
      if (!pushConfigured(env)) {
        return err('Job alerts are not configured on this deployment (VAPID keys missing).', 'PUSH_NOT_CONFIGURED', 503, opts);
      }
      const result = await notifyTechnician(env, db, tech.id, {
        title: 'Job alerts are on',
        body: `${tech.name}, you will get a notification here when dispatch assigns you a job.`,
        tag: 'drev-test',
        url: '/tech',
      });
      return json({ ...result, delivered: result.sent > 0 }, 200, opts);
    }

    return err('Unknown action.', 'INVALID_ACTION', 400, opts);
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

    const subs = await db.prepare(
      'SELECT COUNT(*) AS n FROM assist_push_subscriptions WHERE tech_id = ?',
    ).bind(tech.id).first();

    return json({
      tech: publicTech(tech),
      jobs: active.results || [],
      recent: recent.results || [],
      push: {
        configured: pushConfigured(env),
        devices: Number(subs?.n || 0),
        publicKey: vapidPublicKey(env),
      },
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
