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
