import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDB, ctx } from './fake-db.mjs';
import { onRequest as requestsApi } from '../functions/api/assist/requests.js';
import { onRequest as statusApi } from '../functions/api/assist/status/[id].js';
import { onRequest as adminApi } from '../functions/api/assist/admin.js';
import { onRequest as healthApi } from '../functions/api/assist/health.js';
import { onRequest as profileApi } from '../functions/api/assist/profile.js';

const validRoadside = {
  category: 'roadside', serviceType: 'jump-start',
  locationLabel: 'Charlotte, NC', locationLatitude: 35.227, locationLongitude: -80.843,
  powertrain: 'ev', vehicle: '2024 Tesla Model Y', notes: 'Battery dead',
  customerName: 'Sam Driver', customerPhone: '704-555-0123', customerEmail: '',
  memberPlanRequested: false,
};

const ADMIN_ENV = extra => ({ ASSIST_DB: new FakeDB(), ADMIN_KEY: 'test-admin-key-0123456789', ...extra });

test('POST /requests stores a valid roadside request and returns 201 + audit event', async () => {
  const env = ADMIN_ENV();
  const res = await requestsApi(ctx(env, { method: 'POST', body: validRoadside, headers: { 'Idempotency-Key': 'key-1' } }));
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.request.id);
  assert.equal(env.ASSIST_DB.requests.length, 1);
  assert.equal(env.ASSIST_DB.requests[0].customer_phone, '704-555-0123');
  assert.equal(env.ASSIST_DB.events.length, 1);
});

test('POST /requests is idempotent — a retry with the same key does not duplicate', async () => {
  const env = ADMIN_ENV();
  const mk = () => requestsApi(ctx(env, { method: 'POST', body: validRoadside, headers: { 'Idempotency-Key': 'dup-key' } }));
  const first = await mk();
  const second = await mk();
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).deduplicated, true);
  assert.equal(env.ASSIST_DB.requests.length, 1);
});

test('POST /requests rejects category/service mismatch, missing contact, bad coordinates', async () => {
  const env = ADMIN_ENV();
  const mismatch = await requestsApi(ctx(env, { method: 'POST', body: { ...validRoadside, serviceType: 'home-charger-install' } }));
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error.code, 'CATEGORY_MISMATCH');

  const noPhone = await requestsApi(ctx(env, { method: 'POST', body: { ...validRoadside, customerPhone: '' } }));
  assert.equal(noPhone.status, 400);

  const badLat = await requestsApi(ctx(env, { method: 'POST', body: { ...validRoadside, locationLatitude: 999 } }));
  assert.equal(badLat.status, 400);

  const badBody = await requestsApi(ctx(env, { method: 'POST', body: '{"not json' }));
  assert.equal(badBody.status, 400);
  assert.equal(env.ASSIST_DB.requests.length, 0);
});

test('POST /requests without a database is 503 — it never invents a confirmation', async () => {
  const res = await requestsApi(ctx({}, { method: 'POST', body: validRoadside }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'NOT_CONFIGURED');
});

test('status lookup + customer cancel respects the state machine', async () => {
  const env = ADMIN_ENV();
  const created = await (await requestsApi(ctx(env, { method: 'POST', body: validRoadside }))).json();
  const id = created.request.id;

  const got = await statusApi(ctx(env, { params: { id } }));
  assert.equal(got.status, 200);
  assert.equal((await got.json()).request.cancellable, true);

  const badId = await statusApi(ctx(env, { params: { id: 'not-a-uuid' } }));
  assert.equal(badId.status, 400);

  const cancelled = await statusApi(ctx(env, { method: 'POST', params: { id }, body: { action: 'cancel' } }));
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).request.status, 'cancelled');

  const again = await statusApi(ctx(env, { method: 'POST', params: { id }, body: { action: 'cancel' } }));
  assert.equal(again.status, 409);
});

test('admin requires the key, enforces transitions, 404s on unknown ids', async () => {
  const env = ADMIN_ENV();
  const noKey = await adminApi(ctx(env, {}));
  assert.equal(noKey.status, 401);

  const created = await (await requestsApi(ctx(env, { method: 'POST', body: validRoadside }))).json();
  const id = created.request.id;
  const auth = { Authorization: 'Bearer test-admin-key-0123456789' };

  const list = await adminApi(ctx(env, { headers: auth, url: 'https://assist.test/api/assist/admin?limit=10' }));
  assert.equal(list.status, 200);
  assert.equal((await list.json()).total, 1);

  // submitted -> complete skips review/dispatch: must be refused.
  const skip = await adminApi(ctx(env, { method: 'PATCH', headers: auth, body: { id, status: 'complete' } }));
  assert.equal(skip.status, 409);

  const okPatch = await adminApi(ctx(env, { method: 'PATCH', headers: auth, body: { id, status: 'reviewed', providerLabel: 'Queen City EV' } }));
  assert.equal(okPatch.status, 200);
  assert.equal(env.ASSIST_DB.requests[0].provider_label, 'Queen City EV');

  const missing = await adminApi(ctx(env, { method: 'PATCH', headers: auth, body: { id: '123e4567-e89b-12d3-a456-426614174000', status: 'reviewed' } }));
  assert.equal(missing.status, 404);
});

test('authenticated endpoints fail closed (503) when no IdP is configured — forged JWTs gain nothing', async () => {
  const forged = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhdHRhY2tlciJ9.';
  const res = await profileApi(ctx({ ASSIST_DB: new FakeDB() }, { headers: { Authorization: `Bearer ${forged}` } }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'AUTH_NOT_CONFIGURED');
});

test('health reports configuration booleans without leaking values', async () => {
  const env = { ASSIST_DB: new FakeDB(), ADMIN_KEY: 'test-admin-key-0123456789', MAPBOX_TOKEN: 'pk.secret-ish' };
  const res = await healthApi(ctx(env, { url: 'https://assist.test/api/assist/health' }));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.database, true);
  assert.equal(data.adminConfigured, true);
  assert.ok(!JSON.stringify(data).includes('pk.secret-ish'));
  assert.ok(!JSON.stringify(data).includes('test-admin-key'));
});
