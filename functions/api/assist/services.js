/* GET /api/assist/services — public service catalogue.
   Single source of truth shared by the customer app and the manager UI,
   so service names/guidance never drift between the three places they used
   to be copy-pasted. */
import { SERVICE_CATALOG, json, handleOptions } from './_shared.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return handleOptions(request, env);
  if (request.method !== 'GET') {
    return json({ error: { message: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' } }, 405, { request, env });
  }
  const services = Object.entries(SERVICE_CATALOG).map(([id, s]) => ({ id, ...s }));
  return json({ services }, 200, {
    request, env,
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
