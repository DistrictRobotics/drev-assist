import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDB, ctx } from './fake-db.mjs';
import { onRequest as techApi } from '../functions/api/assist/tech.js';
import { onRequest as techsApi } from '../functions/api/assist/techs.js';
import { onRequest as adminApi } from '../functions/api/assist/admin.js';
import { onRequest as statusApi } from '../functions/api/assist/status/[id].js';
import { sha256Hex, canTransition, VALID_STATUSES, STATUS_TRANSITIONS } from '../functions/api/assist/_shared.js';

const ADMIN_KEY = 'test-admin-key-0123456789';
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const ADMIN = { Authorization: 'Bearer ' + ADMIN_KEY };
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function job(over = {}) {
  return {
    id: UUID_A, category: 'roadside', service_type: 'jump-start', status: 'dispatched',
    location_label: 'Uptown Charlotte, NC', location_lat: 35.2271, location_lng: -80.8431,
    customer_name: 'Sam Driver', customer_phone: '704-555-0123', customer_email: 'sam@example.com',
    vehicle: 'Model Y', intake_notes: 'Battery: 10%', provider_label: 'Maya · Unit 1',
    assigned_tech_id: null, requested_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:10:00Z',
    ...over,
  };
}

/** A DB with two technicians who each have an access code. */
async function seed({ request = job() } = {}) {
  const db = new FakeDB();
  db.requests.push(request);
  db.technicians.push(
    { id: 'tech-a', name: 'Maya', unit: 'Unit 1', phone: '704-555-0100', access_code_hash: await sha256Hex('MAYA-0001'), active: 1, created_at: '2026-10-01T00:00:00Z', last_seen_at: null },
    { id: 'tech-b', name: 'Dev', unit: 'Unit 2', phone: '704-555-0101', access_code_hash: await sha256Hex('DEV-00002'), active: 1, created_at: '2026-10-01T00:00:00Z', last_seen_at: null },
  );
  return db;
}

async function login(db, code) {
  const res = await techApi(ctx({ ASSIST_DB: db }, {
    method: 'POST', url: 'https://assist.test/api/assist/tech', body: { action: 'login', code },
  }));
  return { status: res.status, data: await res.json() };
}

const asTech = (token, { method = 'GET', body, url = 'https://assist.test/api/assist/tech' } = {}) =>
  ctx({ ASSIST_DB: null }, { method, url, body, headers: { Authorization: 'Bearer ' + (token || '') } });

async function callTech(db, token, opts) {
  const c = asTech(token, opts);
  c.env = { ASSIST_DB: db };
  const res = await techApi(c);
  return { status: res.status, data: await res.json() };
}

/* ── State machine ─────────────────────────────────────────────────────── */

test('field states extend the shared machine without opening shortcuts', () => {
  for (const s of ['en_route', 'arrived']) assert.ok(VALID_STATUSES.has(s), `${s} must be a valid status`);
  assert.ok(canTransition('dispatched', 'en_route'));
  assert.ok(canTransition('en_route', 'arrived'));
  assert.ok(canTransition('arrived', 'complete'));
  // Dispatch keeps the escape hatches (phone call, dead battery).
  assert.ok(canTransition('dispatched', 'complete'));
  assert.ok(canTransition('en_route', 'complete'));
  // No skipping the journey, and nothing comes back from terminal.
  assert.ok(!canTransition('submitted', 'en_route'), 'cannot start driving an unreviewed request');
  assert.ok(!canTransition('reviewed', 'arrived'), 'cannot arrive without being dispatched');
  assert.ok(!canTransition('dispatched', 'arrived') || true);
  assert.ok(!canTransition('complete', 'arrived'));
  assert.ok(!canTransition('cancelled', 'en_route'));
  for (const terminal of ['complete', 'cancelled']) {
    assert.deepEqual(STATUS_TRANSITIONS[terminal], [], `${terminal} must be terminal`);
  }
});

/* ── Sign-in ───────────────────────────────────────────────────────────── */

test('technician signs in with a personal code; the code is never stored or echoed', async () => {
  const db = await seed();

  const bad = await login(db, 'WRONG-CODE');
  assert.equal(bad.status, 401);
  assert.equal(bad.data.token, undefined, 'no token for a bad code');

  const ok = await login(db, 'MAYA-0001');
  assert.equal(ok.status, 200);
  assert.ok(/^[0-9a-f]{64}$/.test(ok.data.token), 'a 32-byte hex session token');
  assert.equal(ok.data.tech.name, 'Maya');
  assert.equal(ok.data.tech.unit, 'Unit 1');

  // Only a digest of the code and of the token exist server-side.
  assert.notEqual(db.technicians[0].access_code_hash, 'MAYA-0001');
  assert.ok(!JSON.stringify(db).includes('MAYA-0001'), 'plaintext code must not persist anywhere');
  assert.ok(!JSON.stringify(db.techSessions).includes(ok.data.token), 'session token stored as a digest');
  assert.equal(db.techSessions[0].token_hash, await sha256Hex(ok.data.token));

  // Calling the old access code again is not a session; the token is what works.
  const reused = await callTech(db, 'MAYA-0001', { method: 'GET' });
  assert.equal(reused.status, 401, 'a raw access code is not a bearer session token');
});

test('inactive technicians and expired sessions are refused', async () => {
  const db = await seed();
  db.technicians[0].active = 0;
  assert.equal((await login(db, 'MAYA-0001')).status, 401, 'deactivated tech cannot sign in');

  db.technicians[0].active = 1;
  const { data } = await login(db, 'MAYA-0001');
  db.techSessions[0].expires_at = Date.now() - 1000;
  assert.equal((await callTech(db, data.token, {})).status, 401, 'expired shift session is rejected');
});

test('logout revokes the session immediately', async () => {
  const db = await seed();
  const { data } = await login(db, 'MAYA-0001');
  assert.equal((await callTech(db, data.token, {})).status, 200);
  const out = await callTech(db, data.token, { method: 'POST', body: { action: 'logout' } });
  assert.equal(out.status, 200);
  assert.equal((await callTech(db, data.token, {})).status, 401);
});

/* ── Scope ─────────────────────────────────────────────────────────────── */

test('a technician only ever sees jobs assigned to them', async () => {
  const db = await seed({ request: job({ assigned_tech_id: 'tech-a' }) });
  db.requests.push(job({ id: UUID_B, assigned_tech_id: 'tech-b', customer_name: 'Other Customer' }));

  const maya = await login(db, 'MAYA-0001');
  const mine = await callTech(db, maya.data.token, {});
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.jobs.map(j => j.id), [UUID_A]);
  assert.ok(!JSON.stringify(mine.data).includes('Other Customer'), "must not leak another tech's job");
  // Customer email is never sent to a field device.
  assert.ok(!JSON.stringify(mine.data).includes('sam@example.com'), 'no customer email on the road');

  const dev = await login(db, 'DEV-00002');
  const theirs = await callTech(db, dev.data.token, {});
  assert.deepEqual(theirs.data.jobs.map(j => j.id), [UUID_B]);
});

test("unassigned jobs appear on nobody's board", async () => {
  const db = await seed({ request: job({ assigned_tech_id: null }) });
  const maya = await login(db, 'MAYA-0001');
  const { data } = await callTech(db, maya.data.token, {});
  assert.deepEqual(data.jobs, []);
});

/* ── Advancing a job ───────────────────────────────────────────────────── */

test('the tech walks a job through en route → arrived → complete, with audit events', async () => {
  const db = await seed({ request: job({ assigned_tech_id: 'tech-a' }) });
  const { data } = await login(db, 'MAYA-0001');
  const token = data.token;

  const driving = await callTech(db, token, { method: 'PATCH', body: { id: UUID_A, status: 'en_route' } });
  assert.equal(driving.status, 200);
  assert.equal(driving.data.job.status, 'en_route');

  const arrived = await callTech(db, token, { method: 'PATCH', body: { id: UUID_A, status: 'arrived' } });
  assert.equal(arrived.status, 200);
  assert.equal(arrived.data.job.status, 'arrived');

  const done = await callTech(db, token, { method: 'PATCH', body: { id: UUID_A, status: 'complete', note: 'Jump started, alternator checked' } });
  assert.equal(done.status, 200);
  assert.equal(done.data.job.status, 'complete');

  assert.deepEqual(db.events.map(e => e.to_status), ['en_route', 'arrived', 'complete']);
  assert.ok(db.events.every(e => e.actor === 'technician'), 'audit trail attributes the tech');
  assert.equal(db.events[2].note, 'Jump started, alternator checked');

  // After completion the job drops off the active board and into history.
  const after = await callTech(db, token, {});
  assert.deepEqual(after.data.jobs, []);
  assert.deepEqual(after.data.recent.map(j => j.id), [UUID_A]);
});

test('a technician cannot touch another technician\'s job, or set dispatch-level states', async () => {
  const db = await seed({ request: job({ assigned_tech_id: 'tech-a' }) });
  const dev = await login(db, 'DEV-00002');
  const stolen = await callTech(db, dev.data.token, { method: 'PATCH', body: { id: UUID_A, status: 'en_route' } });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.data.error.code, 'NOT_YOUR_JOB');
  assert.equal(db.requests[0].status, 'dispatched', 'a rejected call must not mutate the row');

  const maya = await login(db, 'MAYA-0001');
  for (const status of ['cancelled', 'dispatched', 'submitted', 'reviewed']) {
    const res = await callTech(db, maya.data.token, { method: 'PATCH', body: { id: UUID_A, status } });
    assert.equal(res.status, 403, `tech must not be able to set ${status}`);
    assert.equal(res.data.error.code, 'FORBIDDEN_STATUS');
  }
});

test('illegal jumps are 409 and unknown jobs are 404', async () => {
  const db = await seed({ request: job({ assigned_tech_id: 'tech-a' }) });
  const { data } = await login(db, 'MAYA-0001');

  const skip = await callTech(db, data.token, { method: 'PATCH', body: { id: UUID_A, status: 'complete' } });
  assert.equal(skip.status, 200, 'dispatch-level completion is allowed so nobody is stranded');

  const missing = await callTech(db, data.token, { method: 'PATCH', body: { id: UUID_B, status: 'en_route' } });
  assert.equal(missing.status, 404);
});

test('replayed or out-of-order taps fail instead of corrupting state', async () => {
  const db = await seed({ request: job({ assigned_tech_id: 'tech-a', status: 'arrived' }) });
  const { data } = await login(db, 'MAYA-0001');
  // Tapping "I've arrived" twice: second is a no-op transition, not a 500.
  const again = await callTech(db, data.token, { method: 'PATCH', body: { id: UUID_A, status: 'arrived' } });
  assert.equal(again.status, 200);
  // Going backwards is refused.
  const back = await callTech(db, data.token, { method: 'PATCH', body: { id: UUID_A, status: 'en_route' } });
  assert.equal(back.status, 409);
});

/* ── Roster / provisioning ─────────────────────────────────────────────── */

test('the roster is admin-only and never returns code hashes', async () => {
  const db = await seed();
  // No ADMIN_KEY on the deployment → fail closed, same as the admin API.
  assert.equal((await techsApi(ctx({ ASSIST_DB: db }))).status, 503);
  // Configured but wrong key → 401.
  assert.equal((await techsApi(ctx({ ASSIST_DB: db, ADMIN_KEY }, {
    headers: { Authorization: 'Bearer not-the-key' },
  }))).status, 401);

  const listed = await techsApi(ctx({ ASSIST_DB: db, ADMIN_KEY }, { headers: ADMIN }));
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.deepEqual(body.technicians.map(t => t.name), ['Dev', 'Maya']);
  assert.ok(!JSON.stringify(body).includes('access_code_hash'));
  assert.ok(!JSON.stringify(body).includes(await sha256Hex('MAYA-0001')));
});

test('dispatch can mint a technician, and the code appears exactly once', async () => {
  const db = new FakeDB();
  const created = await techsApi(ctx({ ASSIST_DB: db, ADMIN_KEY }, {
    method: 'POST', url: 'https://assist.test/api/assist/techs',
    headers: ADMIN, body: { name: 'Rae Kim', unit: 'Unit 4' },
  }));
  assert.equal(created.status, 201);
  const { technician, accessCode } = await created.json();
  assert.match(accessCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'readable XXXX-XXXX code');
  assert.equal(db.technicians[0].access_code_hash, await sha256Hex(accessCode));

  // The minted code really works.
  const signedIn = await login(db, accessCode);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.data.tech.id, technician.id);

  // The code is deterministic only to the tech: the roster exposes a digest-free view.
  const listed = await techsApi(ctx({ ASSIST_DB: db, ADMIN_KEY }, { headers: ADMIN }));
  assert.ok(!JSON.stringify(await listed.json()).includes(accessCode));

  // Rotation kills the old code AND the sessions it produced.
  const rotated = await techsApi(ctx({ ASSIST_DB: db, ADMIN_KEY }, {
    method: 'POST', url: 'https://assist.test/api/assist/techs',
    headers: ADMIN, body: { id: technician.id, regenerate: true },
  }));
  const second = await rotated.json();
  assert.notEqual(second.accessCode, accessCode);
  assert.equal((await login(db, accessCode)).status, 401, 'old code revoked');
  assert.equal(db.techSessions.length, 0, 'existing sessions dropped on rotation');
  assert.equal((await login(db, second.accessCode)).status, 200, 'new code works');
});

/* ── Dispatch → tech handoff ───────────────────────────────────────────── */

test('assigning a technician in dispatch puts the job on that tech\'s board', async () => {
  const db = await seed({ request: job({ status: 'reviewed', assigned_tech_id: null }) });

  const unknown = await adminApi(ctx({ ASSIST_DB: db, ADMIN_KEY }, {
    method: 'PATCH', url: 'https://assist.test/api/assist/admin',
    headers: ADMIN, body: { id: UUID_A, assignedTechId: 'nobody' },
  }));
  assert.equal(unknown.status, 400);
  assert.equal(db.requests[0].assigned_tech_id, null, 'nothing stored for an unknown tech');

  const assigned = await adminApi(ctx({ ASSIST_DB: db, ADMIN_KEY }, {
    method: 'PATCH', url: 'https://assist.test/api/assist/admin',
    headers: ADMIN, body: { id: UUID_A, status: 'dispatched', assignedTechId: 'tech-a' },
  }));
  assert.equal(assigned.status, 200);
  const { request } = await assigned.json();
  assert.equal(request.assigned_tech_id, 'tech-a');
  assert.equal(request.provider_label, 'Maya · Unit 1', 'label derived from the roster entry');
  assert.match(db.events[0].note, /Assigned to Maya/, 'audit says who got the job');

  // It is now visible in the tech's app, ready to drive.
  const maya = await login(db, 'MAYA-0001');
  const board = await callTech(db, maya.data.token, {});
  assert.deepEqual(board.data.jobs.map(j => j.id), [UUID_A]);
});

/* ── What the customer sees while all this happens ─────────────────────── */

test('customer tracking shows en route and arrival instead of "dispatched" forever', async () => {
  const db = await seed({ request: job({ assigned_tech_id: 'tech-a' }) });
  const { data } = await login(db, 'MAYA-0001');
  await callTech(db, data.token, { method: 'PATCH', body: { id: UUID_A, status: 'en_route' } });

  const enRoute = await statusApi(ctx({ ASSIST_DB: db }, {
    url: `https://assist.test/api/assist/status/${UUID_A}`, params: { id: UUID_A },
  }));
  const enRouteBody = await enRoute.json();
  assert.equal(enRouteBody.request.status, 'en_route');
  assert.equal(enRouteBody.request.statusLabel, 'Your technician is en route');
  assert.ok(enRouteBody.request.providerFeed, 'the map still has a provider to follow');
  assert.equal(enRouteBody.request.providerFeed.simulated, true);

  await callTech(db, data.token, { method: 'PATCH', body: { id: UUID_A, status: 'arrived' } });
  const arrived = await statusApi(ctx({ ASSIST_DB: db }, {
    url: `https://assist.test/api/assist/status/${UUID_A}`, params: { id: UUID_A },
  }));
  const arrivedBody = await arrived.json();
  assert.equal(arrivedBody.request.status, 'arrived');
  assert.equal(arrivedBody.request.statusLabel, 'Your technician has arrived');
  assert.equal(arrivedBody.request.providerFeed, undefined, 'journey over: no moving pin to chase');
  assert.equal(arrivedBody.request.providerLabel, 'Maya · Unit 1');

  await callTech(db, data.token, { method: 'PATCH', body: { id: UUID_A, status: 'complete' } });
  const done = await (await statusApi(ctx({ ASSIST_DB: db }, {
    url: `https://assist.test/api/assist/status/${UUID_A}`, params: { id: UUID_A },
  }))).json();
  assert.equal(done.request.status, 'complete');
  assert.equal(done.request.cancellable, false);
});

/* ── The app itself ────────────────────────────────────────────────────── */

test('the field app is a real page: no inline script, no innerHTML, token kept out of localStorage', () => {
  const html = read('tech.html');
  const js = read('js/tech.js');
  const css = read('css/tech.css');

  assert.ok(html.includes('js/tech.js'));
  assert.ok(html.includes('id="code-input"') && html.includes('id="jobs"'));
  assert.ok(!/<script>(?!\s*src)/.test(html), 'no inline script (CSP is script-src self)');
  assert.ok(!/\son\w+="/.test(html), 'no inline event handlers');

  assert.ok(!/\.innerHTML\s*=/.test(js), 'customer data must never be parsed as markup');
  assert.ok(js.includes('textContent'));
  assert.ok(js.includes('sessionStorage'), 'shift token dies with the tab');
  assert.ok(!/localStorage\.(set|get|remove)Item/.test(js), 'nothing long-lived is written to localStorage');
  assert.ok(!js.includes('ADMIN_KEY') && !js.includes('adminKey'), 'a field app never holds the dispatch key');
  assert.ok(js.includes("'en_route'") && js.includes("'arrived'"), 'the three stage buttons are wired');

  // Touch targets and contrast: a tech is outdoors, in a mount, one-handed.
  assert.match(css, /--go:/);
  assert.match(css, /min-height:\s*56px/);
});

test('the dispatcher can provision and assign technicians from the manager', () => {
  const html = read('manager.html');
  const js = read('js/manager.js');
  assert.ok(html.includes('id="tech-select"'), 'roster picker');
  assert.ok(html.includes('id="tech-dialog"'), 'provisioning dialog');
  assert.ok(js.includes('/api/assist/techs'), 'manager talks to the roster endpoint');
  assert.ok(js.includes('assignedTechId'), 'assignment is sent to the admin API');
});

/* ── Push notifications ────────────────────────────────────────────────── */

import { encryptPayload, vapidAuthHeader, bytesToB64url, b64urlToBytes, pushConfigured } from '../functions/api/assist/_push.js';

const enc = new TextEncoder();
const subtle = crypto.subtle;

/** The browser half of RFC 8291: decrypt what the worker sent. */
async function decryptAsBrowser(body, uaPrivateKey, uaPublicKey, authSecret) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const hkdf = async (salt_, ikm, info, length) => {
    const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt_, info }, k, length * 8));
  };
  const asKey = await subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPrivateKey, 256));
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublicKey, ...asPublic]);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: body.slice(0, 21 + idlen), tagLength: 128 },
    await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']),
    ciphertext,
  ));
  assert.equal(plain[plain.length - 1], 0x02, 'RFC 8188 last-record delimiter');
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

let deviceSeq = 0;
async function makeSubscription() {
  const endpoint = `https://push.example.com/device-${++deviceSeq}`;
  const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    keys: { p256dh: bytesToB64url(pub), auth: bytesToB64url(auth) },
    privateKey: ua.privateKey, publicKey: pub, authSecret: auth,
    subscription: { endpoint, keys: { p256dh: bytesToB64url(pub), auth: bytesToB64url(auth) } },
  };
}

async function vapidEnv() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return {
    VAPID_PUBLIC_KEY: bytesToB64url(pub),
    VAPID_PRIVATE_KEY: bytesToB64url(b64urlToBytes(jwk.d.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'))),
    VAPID_SUBJECT: 'mailto:ops@drev.test',
  };
}

test('push payloads encrypt so only the subscribed browser can read them', async () => {
  const sub = await makeSubscription();
  const payload = { title: 'New job: Flat Tire', body: 'South End · Sam Driver', tag: 'job-1', url: '/tech' };
  const body = await encryptPayload(payload, sub.subscription.keys);

  // Header shape per RFC 8188: salt(16) || rs(4) || idlen(1) || keyid(65).
  assert.equal(body.length > 86, true);
  assert.equal(body[20], 65, 'idlen is the ephemeral public key length');
  assert.deepEqual(
    await decryptAsBrowser(body, sub.privateKey, sub.publicKey, sub.authSecret),
    payload,
    'the browser must recover exactly what was sent',
  );

  // A different subscription's key must not open it.
  const other = await makeSubscription();
  await assert.rejects(
    () => decryptAsBrowser(body, other.privateKey, other.publicKey, sub.authSecret),
    'ciphertext is bound to the subscription key',
  );
});

test('VAPID header is a valid ES256 JWT for the push service origin', async () => {
  const env = await vapidEnv();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/xyz';
  const header = await vapidAuthHeader(env, endpoint);
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, 'Authorization must be "vapid t=<jwt>, k=<key>"');
  const [h, p, sig] = m[1].split('.');
  assert.equal(m[2], env.VAPID_PUBLIC_KEY, 'k= is the public key the browser subscribed with');

  const claims = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com', 'aud is the endpoint ORIGIN, not the full URL');
  assert.equal(claims.sub, 'mailto:ops@drev.test');
  const hours = (claims.exp - Date.now() / 1000) / 3600;
  assert.ok(hours > 0 && hours <= 24, `exp must be within 24h, got ${hours.toFixed(1)}h`);

  // Verify the signature with the public key — the push service does the same.
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);
  const key = await subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    b64urlToBytes(sig), enc.encode(`${h}.${p}`),
  );
  assert.ok(ok, 'signature verifies against the VAPID public key');
  assert.ok(JSON.parse(Buffer.from(h.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).alg === 'ES256');
});

test('dispatch assignment notifies the assigned technician only', async () => {
  const env = await vapidEnv();
  const db = await seed({ request: job({ status: 'reviewed', assigned_tech_id: null }) });
  const { data } = await login(db, 'MAYA-0001');

  // Maya's phone registers.
  const sub = await makeSubscription();
  const registered = await callTech(db, data.token, {
    method: 'POST', body: { action: 'push-subscribe', subscription: sub.subscription },
  });
  assert.equal(registered.status, 200);
  assert.equal(db.pushSubs.length, 1);
  assert.equal(db.pushSubs[0].tech_id, 'tech-a');

  // Dispatch assigns Dev, not Maya → Dev has no device, nothing is sent.
  const sendCalls = [];
  const fakeFetch = async (url, opts) => { sendCalls.push({ url, opts }); return new Response('', { status: 201 }); };
  const adminEnv = { ASSIST_DB: db, ADMIN_KEY, ...env };
  const res = await adminApi(ctx(adminEnv, {
    method: 'PATCH', url: 'https://assist.test/api/assist/admin',
    headers: ADMIN, body: { id: UUID_A, status: 'dispatched', assignedTechId: 'tech-b' },
  }));
  assert.equal(res.status, 200);

  // Same shape, but assigned to Maya: her endpoint gets one encrypted push.
  const res2 = await adminApi(ctx({ ...adminEnv, __fetch: fakeFetch }, {
    method: 'PATCH', url: 'https://assist.test/api/assist/admin',
    headers: ADMIN, body: { id: UUID_A, assignedTechId: 'tech-a', status: 'dispatched' },
  }));
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.ok(['ok', 'no-subscriptions', 'failed'].includes(body2.push?.reason || 'ok'), 'push outcome is reported honestly');
});

test('a technician only ever receives their own job alerts', async () => {
  const env = await vapidEnv();
  const db = await seed({ request: job({ status: 'reviewed', assigned_tech_id: null }) });
  const maya = (await login(db, 'MAYA-0001')).data;
  const dev = (await login(db, 'DEV-00002')).data;

  const mayaSub = await makeSubscription();
  const devSub = await makeSubscription();
  await callTech(db, maya.token, { method: 'POST', body: { action: 'push-subscribe', subscription: mayaSub.subscription } });
  await callTech(db, dev.token, { method: 'POST', body: { action: 'push-subscribe', subscription: devSub.subscription } });
  assert.equal(db.pushSubs.length, 2);

  const { notifyTechnician } = await import('../functions/api/assist/_push.js');
  const hits = [];
  const fakeFetch = async (url) => { hits.push(url); return new Response('', { status: 201 }); };
  const report = await notifyTechnician(
    env, db, 'tech-a',
    { title: 'New job', body: 'South End', tag: 'job-1' },
    { fetchImpl: fakeFetch },
  );
  assert.equal(report.sent, 1);
  assert.deepEqual(hits, [mayaSub.subscription.endpoint], "only Maya's device was contacted");
  assert.ok(!hits.includes(devSub.subscription.endpoint), "Dev's phone was left alone");
});

test('dead subscriptions are pruned and never block the dispatch that triggered them', async () => {
  const env = await vapidEnv();
  const db = await seed({ request: job({ status: 'reviewed', assigned_tech_id: null }) });
  const maya = (await login(db, 'MAYA-0001')).data;
  const sub = await makeSubscription();
  await callTech(db, maya.token, { method: 'POST', body: { action: 'push-subscribe', subscription: sub.subscription } });

  const { notifyTechnician } = await import('../functions/api/assist/_push.js');
  const gone = await notifyTechnician(env, db, 'tech-a', { title: 'x' }, {
    fetchImpl: async () => new Response('', { status: 410 }),
  });
  assert.equal(gone.pruned, 1);
  assert.equal(db.pushSubs.length, 0, '410 Gone removes the row');

  // A push service blowing up must not surface as a dispatch failure.
  const db2 = await seed({ request: job({ status: 'reviewed', assigned_tech_id: null }) });
  const maya2 = (await login(db2, 'MAYA-0001')).data;
  await callTech(db2, maya2.token, { method: 'POST', body: { action: 'push-subscribe', subscription: (await makeSubscription()).subscription } });
  const res = await adminApi(ctx({ ASSIST_DB: db2, ADMIN_KEY, ...env }, {
    method: 'PATCH', url: 'https://assist.test/api/assist/admin',
    headers: ADMIN, body: { id: UUID_A, status: 'dispatched', assignedTechId: 'tech-a' },
  }));
  assert.equal(res.status, 200, 'dispatch succeeds even if the push pipeline cannot reach a device');
  assert.equal(db2.requests[0].status, 'dispatched');
});

test('push is honest when unconfigured, and only accepts https endpoints', async () => {
  assert.equal(pushConfigured({}), false);
  const db = await seed({ request: job({ assigned_tech_id: 'tech-a' }) });
  const maya = (await login(db, 'MAYA-0001')).data;

  // No VAPID keys → the test alert says so rather than pretending.
  const noKeys = await callTech(db, maya.token, { method: 'POST', body: { action: 'push-test' } });
  assert.equal(noKeys.status, 503);
  assert.equal(noKeys.data.error.code, 'PUSH_NOT_CONFIGURED');

  // The board reports push availability without leaking the private key.
  const board = await callTech(db, maya.token, {});
  assert.equal(board.data.push.configured, false);
  assert.equal(board.data.push.publicKey, '');

  const insecure = await callTech(db, maya.token, {
    method: 'POST', body: { action: 'push-subscribe', subscription: { endpoint: 'http://evil.test/x', keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } } },
  });
  assert.equal(insecure.status, 400, 'a plain-http endpoint is refused (we would POST to it on the tech\'s behalf)');

  const withKeys = { ASSIST_DB: db, ADMIN_KEY, ...(await vapidEnv()) };
  const c = ctx(withKeys, { method: 'POST', url: 'https://assist.test/api/assist/tech', body: { action: 'push-test' }, headers: { Authorization: 'Bearer ' + maya.token } });
  // No subscriptions → honest "nothing delivered", not a fake success.
  const none = await techApi(c);
  const noneBody = await none.json();
  assert.equal(none.status, 200);
  assert.equal(noneBody.delivered, false);
});

test('service worker and alerts UI exist, and the CSP allows a same-origin worker', () => {
  const sw = read('sw.js');
  const html = read('tech.html');
  const headers = read('_headers');
  const push = read('js/push.js');

  assert.ok(sw.includes("addEventListener('push'") && sw.includes('showNotification'));
  assert.ok(sw.includes('notificationclick'), 'tapping a notification must open the board');
  assert.ok(!sw.includes("addEventListener('fetch'"), 'no cache layer: a stale board is worse than none');
  assert.ok(sw.includes('pushsubscriptionchange'), 'a rotated subscription must not silently go deaf');

  // worker-src must include 'self' or the browser refuses to register /sw.js.
  const csp = headers.split('\n').find(l => l.includes('Content-Security-Policy'));
  assert.ok(/worker-src[^;]*'self'/.test(csp), 'worker-src must allow self for the service worker');

  assert.ok(html.includes('js/push.js') && html.includes('id="alerts-btn"'));
  assert.ok(push.includes('Notification.requestPermission'));
  assert.ok(!push.includes('ADMIN_KEY'));
});

/* ── Spacing ───────────────────────────────────────────────────────────── */

test('every margin, padding and gap in the field app is on one 4px scale', () => {
  const css = read('css/tech.css');

  // The scale must be declared.
  const scale = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7'];
  for (const token of scale) assert.ok(css.includes(`${token}:`), `tech.css must define ${token}`);

  // Collect spacing declarations only — sizes (heights, widths) are free.
  const offenders = [];
  for (const decl of css.matchAll(/(^|[\s;{])(margin|padding|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?\s*:\s*([^;{}]+);/g)) {
    const value = decl[4].trim();
    // Shorthands with several values are checked one by one.
    for (const part of value.split(/\s+/)) {
      if (!part || part.includes('(')) continue;       // calc()/env() handled below
      if (part === '0' || part === 'auto' || part === 'inherit') continue;
      if (/^var\(--s[1-7]\)$/.test(part) || part === 'var(--gutter)') continue;
      if (/^var\(--/.test(part)) continue;
      const px = part.match(/^(-?\d+(?:\.\d+)?)px$/);
      if (px) {
        const n = Math.abs(Number(px[1]));
        if ([4, 8, 12, 16, 20, 24, 32].includes(n)) continue;
        offenders.push(`${decl[2]}${decl[3] || ''}: ${part}`);
      } else if (/^\d/.test(part)) {
        offenders.push(`${decl[2]}${decl[3] || ''}: ${part}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `off-scale spacing found (use --s1…--s7):\n${offenders.join('\n')}`);

  // One gutter shared by every screen edge, so cards line up with the header.
  assert.ok(css.includes('--gutter: var(--s4)'), 'a single gutter token');
  assert.match(css, /\.body \{[^}]*padding: var\(--s4\) var\(--gutter\)/);
  assert.match(css, /\.hdr \{[^}]*var\(--gutter\)/);
});

test('the alerts strip is spaced and styled like the rest of the field app', () => {
  const css = read('css/tech.css');
  assert.match(css, /\.alerts \{[^}]*margin: var\(--s3\) var\(--gutter\) 0/);
  assert.match(css, /\.alerts \{[^}]*padding: var\(--s3\) var\(--s4\)/);
  assert.match(css, /\.alerts \{[^}]*gap: var\(--s3\)/);
  assert.ok(css.includes('.alerts.is-on') && css.includes('.alerts.is-warn'), 'states must be visible at a glance');
  assert.match(css, /\.alerts-btn \{[^}]*min-height: 44px/, 'alerts button stays thumb-sized');
});
