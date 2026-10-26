/* GET /api/assist/health — liveness/config probe. Reports only booleans,
   never secret values, so it is safe to poll from uptime monitoring. */
import { json, handleOptions, authConfigured, isAdminConfigured } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  const opts = { request, env };
  if (request.method === 'OPTIONS') return handleOptions(request, env);
  if (request.method !== 'GET') {
    return json({ error: { message: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' } }, 405, opts);
  }
  let dbOk = false;
  if (env?.ASSIST_DB) {
    try { await env.ASSIST_DB.prepare('SELECT 1').first(); dbOk = true; } catch { dbOk = false; }
  }
  return json({
    ok: true,
    service: 'drev-assist',
    time: new Date().toISOString(),
    database: dbOk,
    authConfigured: authConfigured(env),
    adminConfigured: isAdminConfigured(env),
    mapConfigured: Boolean(env?.MAPBOX_TOKEN),
  }, 200, opts);
}
