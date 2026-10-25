/* Shared utilities for DREV Assist CF Pages Functions.
   No card PAN, CVC, Stripe secret, webhook secret, or database credential
   may ever be returned to the browser. */

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export function err(message, code = 'SERVICE_UNAVAILABLE', status = 503) {
  return json({ error: { message, code } }, status);
}

export function notConfigured() {
  return err(
    'DREV Assist backend is not yet configured. The API Gateway, database adapter, and Cognito pool must be connected before account operations are available.',
    'DATABASE_NOT_CONNECTED',
    503,
  );
}

/** Verify the Authorization: Bearer <token> header and return the subject claim.
 *  Returns null if no valid JWT is present (caller must reject with 401). */
export function bearerSub(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payload.length % 4) % 4);
    const claims = JSON.parse(atob(padded));
    return claims.sub || null;
  } catch { return null; }
}
