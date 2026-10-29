import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDB, ctx } from './fake-db.mjs';
import { onRequest as requestsApi } from '../functions/api/assist/requests.js';
import { onRequest as adminApi } from '../functions/api/assist/admin.js';
import { onRequest as statusApi } from '../functions/api/assist/status/[id].js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const AUTH = { Authorization: 'Bearer test-admin-key-0123456789' };
const env = () => ({ ASSIST_DB: new FakeDB(), ADMIN_KEY: 'test-admin-key-0123456789' });

const intake = {
  category: 'roadside', serviceType: 'mobile-ev-charge', locationLabel: 'Uptown Charlotte, NC',
  locationLatitude: 35.227, locationLongitude: -80.843, powertrain: 'ev',
  vehicle: '2024 Tesla Model Y', customerName: 'Sam Driver', customerPhone: '704-555-0123',
};

test('end-to-end: customer submits → request persists in D1 → tech accepts → dispatched in D1 → customer sees provider feed', async () => {
  const e = env();

  // 1) Customer intake persists (not memory-only).
  const created = await requestsApi(ctx(e, { method: 'POST', body: intake }));
  assert.equal(created.status, 201);
  const { request } = await created.json();
  assert.equal(e.ASSIST_DB.requests.length, 1);
  assert.equal(e.ASSIST_DB.requests[0].status, 'submitted');

  // 2) Manager reads the same D1-backed queue.
  const queue = await (await adminApi(ctx(e, { headers: AUTH, url: 'https://assist.test/api/assist/admin' }))).json();
  assert.equal(queue.total, 1);
  assert.equal(queue.requests[0].id, request.id);

  // 3) The state machine refuses a direct submitted → dispatched jump…
  const skip = await adminApi(ctx(e, { method: 'PATCH', headers: AUTH, body: { id: request.id, status: 'dispatched' } }));
  assert.equal(skip.status, 409);

  // …so Accept does reviewed → dispatched with the tech's name, both persisted.
  const reviewed = await adminApi(ctx(e, { method: 'PATCH', headers: AUTH, body: { id: request.id, status: 'reviewed', note: 'Accepted by Maya (Unit 1)' } }));
  assert.equal(reviewed.status, 200);
  const dispatched = await adminApi(ctx(e, { method: 'PATCH', headers: AUTH, body: { id: request.id, status: 'dispatched', providerLabel: 'Maya · Unit 1' } }));
  assert.equal(dispatched.status, 200);

  const stored = e.ASSIST_DB.requests[0];
  assert.equal(stored.status, 'dispatched');
  assert.equal(stored.provider_label, 'Maya · Unit 1');
  assert.deepEqual(
    e.ASSIST_DB.events.map(ev => ev.to_status),
    ['submitted', 'reviewed', 'dispatched'],
    'every hop must be audit-logged',
  );

  // 4) Customer status (what the map polls) now carries the live provider feed.
  const status = await (await statusApi(ctx(e, { params: { id: request.id } }))).json();
  assert.equal(status.request.status, 'dispatched');
  assert.equal(status.request.providerLabel, 'Maya · Unit 1');
  assert.equal(status.request.providerFeed.simulated, true);
  assert.ok(Number.isFinite(status.request.providerFeed.position.lat));
});

test('manager UI has a real Accept & Dispatch action with a tech name', () => {
  const js = read('js/manager.js');
  const html = read('manager.html');
  assert.ok(js.includes('acceptRequest') && js.includes('data-accept'), 'accept action missing');
  assert.ok(js.includes("status: 'dispatched'") && js.includes('providerLabel'), 'accept must persist dispatched + tech');
  assert.ok(html.includes('id="tech-name"'), 'tech name input missing');
  assert.ok(!js.includes('DEMO_REQUESTS') && !js.includes('sampleRequests'), 'queue must come from the API, not demo memory');
});

test('customer app watches for dispatch after submit and lands it on the map', () => {
  const app = read('js/assist-app.js');
  assert.ok(app.includes('startStatusWatcher'), 'status watcher missing');
  assert.ok(app.includes('onCustomerStatusUpdate'), 'dispatch reaction missing');
  assert.ok(app.includes('startLiveTracking(r)'), 'dispatch must start the follow-cam');
  assert.ok(app.includes('12000'), 'watcher should poll on a battery-friendly interval');
});
