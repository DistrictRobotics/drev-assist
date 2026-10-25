/* GET /api/assist/dispatch — dispatcher workspace: list all open requests (drev_dispatcher role required)
   PUT /api/assist/dispatch — record a dispatcher update (status, providerLabel, scheduledWindow, note, optional quote) */
import { CORS, json, err, notConfigured, bearerSub } from './_shared.js';

const VALID_STATUSES = new Set([
  'submitted', 'reviewing', 'quoted', 'payment_pending', 'scheduled',
  'assigned', 'en_route', 'arrived', 'in_service', 'completed', 'cancelled', 'closed',
]);

function isDispatcher(claims) {
  const groups = claims?.['cognito:groups'] || claims?.groups || [];
  return Array.isArray(groups) && groups.includes('drev_dispatcher');
}

function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch { return {}; }
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const sub = bearerSub(context.request);
  if (!sub) return err('Authentication required.', 'UNAUTHENTICATED', 401);

  const rawToken = (context.request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = decodeJwt(rawToken);
  if (!isDispatcher(claims)) return err('Dispatcher role required. This endpoint does not elevate a customer account.', 'FORBIDDEN', 403);

  const db = context.env?.ASSIST_DB;
  if (!db) return notConfigured();

  if (context.request.method === 'GET') {
    // Query open requests for dispatcher view. Replace with actual DB query.
    return json({ requests: [] });
  }

  if (context.request.method === 'PUT') {
    let body;
    try { body = await context.request.json(); } catch { return err('Invalid JSON body.', 'BAD_REQUEST', 400); }
    const { requestId, status, providerLabel, scheduledWindow, note, quote } = body || {};
    if (!requestId) return err('requestId is required.', 'MISSING_REQUEST_ID', 400);
    if (status && !VALID_STATUSES.has(status)) return err('Invalid status value.', 'INVALID_STATUS', 400);
    if (quote) {
      if (!Number.isInteger(quote.amountCents) || quote.amountCents <= 0) return err('Quote requires a positive integer amountCents.', 'INVALID_QUOTE', 400);
      if (!quote.description) return err('Quote requires a description.', 'INVALID_QUOTE', 400);
    }
    // Update request and optionally insert quote. Replace with actual DB logic.
    return json({ ok: true, notice: 'Dispatcher update recorded.' });
  }

  return err('Method not allowed.', 'METHOD_NOT_ALLOWED', 405);
}
