/* Technician roster — admin-only (shared ADMIN_KEY, same as the admin API).
 *
 *   GET  /api/assist/techs            → roster for the manager's assign picker
 *   POST /api/assist/techs  {name, unit?, phone?} → create a tech
 *
 * POST returns the freshly minted access code **once**. Only its SHA-256
 * digest is stored, so it cannot be shown again — losing it means minting a
 * new one (`POST {id, regenerate:true}`).
 *
 * Hash digests are never returned by either method.
 */
import {
  json, err, handleOptions, parseJsonBody, cleanText, isUuid,
  adminKeyMatches, isAdminConfigured, rateLimit, sha256Hex,
} from './_shared.js';

/* No 0/O/1/I/L: technicians read these codes off a phone screen or a card. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function mintCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);

  if (!isAdminConfigured(env)) {
    return err('Admin access is not configured (set ADMIN_KEY, 16+ characters).', 'NOT_CONFIGURED', 503, opts);
  }
  const db = env?.ASSIST_DB;
  if (!db) return err('Database not configured.', 'NOT_CONFIGURED', 503, opts);
  if (!(await rateLimit(db, request, 'techs-admin', 120, 60))) {
    return err('Too many requests.', 'RATE_LIMITED', 429, opts);
  }
  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await adminKeyMatches(provided, env))) {
    return err('Unauthorized.', 'UNAUTHORIZED', 401, opts);
  }

  if (request.method === 'GET') {
    const rows = await db.prepare(
      'SELECT id, name, unit, phone, active, created_at, last_seen_at FROM assist_technicians ORDER BY active DESC, name ASC',
    ).all();
    return json({ technicians: rows.results || [] }, 200, opts);
  }

  if (request.method === 'POST') {
    const [body, bodyErr] = await parseJsonBody(request, opts);
    if (bodyErr) return bodyErr;
    const { id, regenerate } = body || {};

    /* Rotate an existing tech's code (lost card, phone replaced). */
    if (id !== undefined) {
      if (!isUuid(id)) return err('A valid technician id is required.', 'INVALID_ID', 400, opts);
      const existing = await db.prepare('SELECT * FROM assist_technicians WHERE id = ?').bind(id).first();
      if (!existing) return err('Technician not found.', 'NOT_FOUND', 404, opts);
      if (!regenerate) return err('Nothing to update.', 'EMPTY_UPDATE', 400, opts);

      const code = mintCode();
      await db.prepare('UPDATE assist_technicians SET access_code_hash = ? WHERE id = ?')
        .bind(await sha256Hex(code), id).run();
      // Old shift sessions must die with the old code.
      await db.prepare('DELETE FROM assist_tech_sessions WHERE tech_id = ?').bind(id).run();
      return json({
        technician: { id: existing.id, name: existing.name, unit: existing.unit, phone: existing.phone },
        accessCode: code,
        note: 'Shown once — store it now. Previous sessions and code are revoked.',
      }, 200, opts);
    }

    const [name, nameErr] = cleanText(body?.name, { max: 80, required: true, field: 'Name' });
    const [unit, unitErr] = cleanText(body?.unit, { max: 40, field: 'Unit' });
    const [phone, phoneErr] = cleanText(body?.phone, { max: 40, field: 'Phone' });
    for (const e of [nameErr, unitErr, phoneErr]) if (e) return err(e, 'INVALID_FIELD', 400, opts);

    const code = mintCode();
    const techId = crypto.randomUUID();
    await db.prepare(
      'INSERT INTO assist_technicians (id, name, unit, phone, access_code_hash) VALUES (?, ?, ?, ?, ?)',
    ).bind(techId, name, unit || null, phone || null, await sha256Hex(code)).run();

    return json({
      technician: { id: techId, name, unit: unit || null, phone: phone || null },
      accessCode: code,
      note: 'Shown once — store it now, then hand it to the technician.',
    }, 201, opts);
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405, opts);
}
