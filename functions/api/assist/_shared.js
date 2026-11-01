/* Shared utilities for DREV Assist CF Pages Functions.
 *
 * Security rules enforced here:
 *  - No secret (Stripe key, webhook secret, admin key, DB credential) is ever
 *    returned to the browser.
 *  - JWTs are *verified* (RS256 against the configured JWKS), never merely
 *    decoded. If no auth provider is configured, authenticated endpoints fail
 *    closed with 503 instead of trusting unverified tokens.
 *  - CORS reflects only allow-listed / same-origin callers, never `*` on
 *    endpoints that accept an Authorization header.
 *  - All JSON responses are `Cache-Control: no-store`.
 */

/* ── Service catalogue (single source of truth) ─────────────────────────── */

export const SERVICE_CATALOG = Object.freeze({
  // roadside
  'mobile-ev-charge':     { category: 'roadside', label: 'Mobile EV Charge',   guidance: 'Stay with the vehicle if safe. Note your battery % and nearest cross-street.' },
  'jump-start':           { category: 'roadside', label: 'Jump Start',         guidance: 'Turn off lights and accessories. Note any clicking or dashboard warnings.' },
  'flat-tire':            { category: 'roadside', label: 'Flat Tire',          guidance: 'Pull fully off the roadway if possible. Tell us if you have a spare and which tire is flat.' },
  'tow-coordination':     { category: 'roadside', label: 'Tow Coordination',   guidance: 'Tell us where the vehicle needs to go and whether it can roll / be put in neutral.' },
  'lockout':              { category: 'roadside', label: 'Lockout',            guidance: 'Have photo ID ready — the provider must verify you own or rent the vehicle.' },
  'fuel-delivery':        { category: 'roadside', label: 'Fuel Delivery',      guidance: 'Confirm your fuel type (regular / premium / diesel) and stay in a safe spot.' },
  'collision-incident':   { category: 'roadside', label: 'Collision Incident', guidance: 'Not emergency services — call 911 for injuries. Move to safety and exchange info if safe to do so.' },
  'other-roadside':       { category: 'roadside', label: 'Other Roadside',     guidance: 'Describe the problem in the Situation box so a dispatcher can route it correctly.' },
  // home energy
  'home-charger-install': { category: 'home', label: 'Charger Install',        guidance: 'Photos of your panel and parking spot help. Note the distance from panel to vehicle.' },
  'home-charger-repair':  { category: 'home', label: 'Charger Repair',         guidance: 'Note the charger brand/model and any error lights or breaker trips.' },
  'v2h-planning':         { category: 'home', label: 'V2H Planning',           guidance: 'Tell us your vehicle model and what you want powered during an outage.' },
  'panel-battery-review': { category: 'home', label: 'Panel / Battery Review', guidance: 'A photo of your panel label (amperage, open slots) speeds up the review.' },
  'outage-readiness':     { category: 'home', label: 'Outage Readiness',       guidance: 'List the loads that matter most (medical, refrigeration, heating) and outage history.' },
  'other-home':           { category: 'home', label: 'Other Home Energy',      guidance: 'Describe your goal and current setup in the Situation box.' },
});

export const VALID_CATEGORIES = new Set(['roadside', 'home']);
export const VALID_POWERTRAINS = new Set(['ev', 'ice']);

/* ── Request status state machine (one vocabulary everywhere) ──────────── */

export const VALID_STATUSES = new Set(['submitted', 'reviewed', 'dispatched', 'en_route', 'arrived', 'complete', 'cancelled']);
export const STATUS_TRANSITIONS = Object.freeze({
  submitted:  ['reviewed', 'cancelled'],
  reviewed:   ['dispatched', 'cancelled'],
  /* A dispatched job is in the tech's hands: they set off, arrive, then close
     it out. Dispatch can still complete or cancel on the tech's behalf (phone
     call, dead battery), so those edges stay open from every active state. */
  dispatched: ['en_route', 'arrived', 'complete', 'cancelled'],
  en_route:   ['arrived', 'complete', 'cancelled'],
  arrived:    ['complete', 'cancelled'],
  complete:   [],
  cancelled:  [],
});
export function canTransition(from, to) {
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

/** States where a provider is committed to the job and the customer is watching. */
export const TRACKABLE_STATUSES = new Set(['dispatched', 'en_route', 'arrived']);

/** Human copy for a status, shared by the customer app and the tech app. */
export const STATUS_COPY = Object.freeze({
  submitted: 'Submitted — waiting for a dispatcher',
  reviewed:  'A dispatcher is reviewing your request',
  dispatched: 'Help is on the way',
  en_route:  'Your technician is en route',
  arrived:   'Your technician has arrived',
  complete:  'Service complete — thank you',
  cancelled: 'Request cancelled',
});

/* ── HTTP helpers ───────────────────────────────────────────────────────── */

function allowedOrigin(request, env) {
  const origin = request?.headers?.get('Origin');
  if (!origin) return null;
  try {
    if (new URL(origin).origin === new URL(request.url).origin) return origin;
  } catch { /* fall through */ }
  const extra = String(env?.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return extra.includes(origin) ? origin : null;
}

export function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,Idempotency-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function handleOptions(request, env) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export function json(data, status = 200, opts = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(opts.request ? corsHeaders(opts.request, opts.env) : {}),
      ...(opts.headers || {}),
    },
  });
}

export function err(message, code = 'SERVICE_UNAVAILABLE', status = 503, opts = {}) {
  return json({ error: { message, code } }, status, opts);
}

export function notConfigured(opts = {}) {
  return err(
    'DREV Assist backend is not yet configured for this operation.',
    'NOT_CONFIGURED',
    503,
    opts,
  );
}

/* ── Body parsing & field validation ────────────────────────────────────── */

export const MAX_BODY_BYTES = 16 * 1024;

/** Returns [body, errorResponse]. Enforces a hard size cap before parsing. */
export async function parseJsonBody(request, opts = {}) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) return [null, err('Request body too large.', 'BODY_TOO_LARGE', 413, opts)];
  let text;
  try { text = await request.text(); } catch { return [null, err('Could not read request body.', 'BAD_REQUEST', 400, opts)]; }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return [null, err('Request body too large.', 'BODY_TOO_LARGE', 413, opts)];
  }
  try { return [JSON.parse(text || '{}'), null]; }
  catch { return [null, err('Invalid JSON body.', 'BAD_REQUEST', 400, opts)]; }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Trim + strip control characters + enforce length. Returns [value, errorMessage]. */
export function cleanText(value, { max = 200, required = false, field = 'Field' } = {}) {
  if (value === undefined || value === null || value === '') {
    return required ? [null, `${field} is required.`] : ['', null];
  }
  if (typeof value !== 'string' && typeof value !== 'number') return [null, `${field} must be text.`];
  const v = String(value).replace(CONTROL_CHARS, ' ').trim().slice(0, max);
  if (required && !v) return [null, `${field} is required.`];
  return [v, null];
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export function isEmail(v) { return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v); }

/** Accept common phone formats; require 7–15 digits. */
export function isPhone(v) {
  if (typeof v !== 'string') return false;
  if (!/^[+()\-.\s\d]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

export function escapeLike(term) {
  return term.replace(/[%_\\]/g, '\\$&');
}

/* ── Timing-safe comparison (admin key, webhook signatures) ─────────────── */

export function timingSafeEqual(a, b) {
  const sa = String(a ?? ''), sb = String(b ?? '');
  let diff = sa.length ^ sb.length;
  const len = Math.max(sa.length, sb.length, 1);
  for (let i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i % sa.length) || 0) ^ (sb.charCodeAt(i % sb.length) || 0);
  }
  return diff === 0 && sa.length > 0;
}

/** Compare the shared admin secret by SHA-256 digest so length doesn't leak. */
export async function adminKeyMatches(provided, env) {
  const expected = env?.ADMIN_KEY;
  if (!expected || !provided) return false;
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(provided))),
    crypto.subtle.digest('SHA-256', enc.encode(String(expected))),
  ]);
  const ha = [...new Uint8Array(da)].map(x => x.toString(16).padStart(2, '0')).join('');
  const hb = [...new Uint8Array(db)].map(x => x.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(ha, hb);
}

export function isAdminConfigured(env) {
  return typeof env?.ADMIN_KEY === 'string' && env.ADMIN_KEY.length >= 16;
}

/* ── Rate limiting (D1 fixed-window, IP stored only as a hash) ──────────── */

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Fixed-window counter in D1. Fails open (allows) if the table/DB is absent
 * so a limiter outage never takes intake down — abuse is still bounded by
 * body-size + validation. Returns true when the request may proceed.
 */
export async function rateLimit(db, request, scope, limit, windowSec) {
  if (!db) return true;
  try {
    const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
    const bucket = `${scope}:${(await sha256Hex(clientIp(request))).slice(0, 32)}:${windowStart}`;
    const row = await db.prepare('SELECT count FROM assist_rate_limits WHERE bucket = ?').bind(bucket).first();
    if (row && row.count >= limit) return false;
    await db.prepare(
      `INSERT INTO assist_rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1`,
    ).bind(bucket, windowStart).run();
    // Opportunistic cleanup of expired buckets (cheap, keeps table small).
    if (Math.random() < 0.05) {
      await db.prepare('DELETE FROM assist_rate_limits WHERE window_start < ?')
        .bind(windowStart - windowSec * 10).run();
    }
    return true;
  } catch {
    return true;
  }
}

/* ── JWT verification (RS256 via JWKS) ──────────────────────────────────── */

export function authConfigured(env) {
  return Boolean(env?.AUTH_JWKS_URL || env?.AUTH_ISSUER);
}

function jwksUrl(env) {
  if (env.AUTH_JWKS_URL) return env.AUTH_JWKS_URL;
  return `${String(env.AUTH_ISSUER).replace(/\/$/, '')}/.well-known/jwks.json`;
}

let jwksCache = { url: '', keys: [], fetchedAt: 0 };
async function getJwks(env) {
  const url = jwksUrl(env);
  if (jwksCache.url === url && Date.now() - jwksCache.fetchedAt < 5 * 60 * 1000) return jwksCache.keys;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('JWKS fetch failed');
  const data = await res.json();
  jwksCache = { url, keys: data.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

function b64urlDecode(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - segment.length % 4) % 4);
  return atob(padded);
}

/**
 * Verify `Authorization: Bearer <jwt>` and return its claims, or null.
 * Checks signature (RS256), exp/nbf, and iss/aud when configured via
 * AUTH_ISSUER / AUTH_AUDIENCE. Never trust a token this returns null for.
 */
export async function authenticate(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !authConfigured(env)) return null;
  try {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const header = JSON.parse(b64urlDecode(h));
    if (header.alg !== 'RS256' || !header.kid) return null;
    const keys = await getJwks(env);
    const jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA');
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    const sig = Uint8Array.from(b64urlDecode(s), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(b64urlDecode(p));
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
    if (env.AUTH_ISSUER && claims.iss !== env.AUTH_ISSUER) return null;
    if (env.AUTH_AUDIENCE) {
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud, claims.client_id];
      if (!aud.includes(env.AUTH_AUDIENCE)) return null;
    }
    return claims.sub ? claims : null;
  } catch {
    return null;
  }
}

/** Returns { claims } or { error: Response } — 503 when auth isn't wired up. */
export async function requireAuth(request, env, opts = {}) {
  if (!authConfigured(env)) {
    return { error: err('Account sign-in is not configured on this deployment.', 'AUTH_NOT_CONFIGURED', 503, opts) };
  }
  const claims = await authenticate(request, env);
  if (!claims) return { error: err('Authentication required.', 'UNAUTHENTICATED', 401, opts) };
  return { claims };
}

export function isDispatcher(claims) {
  const groups = claims?.['cognito:groups'] || claims?.groups || [];
  return Array.isArray(groups) && groups.includes('drev_dispatcher');
}

/* Field technicians. Deliberately a separate group from drev_dispatcher:
   a tech gets their own assigned jobs, not the whole dispatch board. */
export const TECH_GROUP = 'drev_technician';
export function isTechnician(claims) {
  const groups = claims?.['cognito:groups'] || claims?.groups || [];
  return Array.isArray(groups) && groups.includes(TECH_GROUP);
}
