import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../js/live-data.js';
import { FakeDB, ctx } from './fake-db.mjs';
import { providerPositionFor, providersSnapshot } from '../functions/api/assist/_live-sim.js';
import { onRequest as liveApi } from '../functions/api/assist/live.js';
import { onRequest as requestsApi } from '../functions/api/assist/requests.js';
import { onRequest as adminApi } from '../functions/api/assist/admin.js';
import { onRequest as statusApi } from '../functions/api/assist/status/[id].js';

const DrevLive = globalThis.DrevLive;
const CHARLOTTE = { lng: -80.843, lat: 35.227 };

test('live-data: simulation is deterministic for a given seed', () => {
  const a = DrevLive.createSimulation(42);
  const b = DrevLive.createSimulation(42);
  a.tick(5); b.tick(5);
  assert.deepEqual(DrevLive.providersGeoJSON(a), DrevLive.providersGeoJSON(b));
});

test('live-data: providers actually move and cycle statuses', () => {
  const sim = DrevLive.createSimulation(3);
  const before = DrevLive.providersGeoJSON(sim).features.map(f => f.geometry.coordinates.join(','));
  for (let i = 0; i < 120; i++) sim.tick(1);
  const after = DrevLive.providersGeoJSON(sim).features.map(f => f.geometry.coordinates.join(','));
  assert.notDeepEqual(before, after);
  for (const pv of sim.providers) assert.ok(['available', 'en_route', 'in_service'].includes(pv.status));
  const fc = DrevLive.providersGeoJSON(sim);
  assert.equal(fc.features.length, 6);
  assert.ok(fc.features.every(f => f.geometry.coordinates.every(Number.isFinite)));
});

test('live-data: route interpolation starts at A and ends at B', () => {
  const route = DrevLive.routeBetween(CHARLOTTE, { lng: -80.75, lat: 35.31 }, 5);
  assert.ok(route.totalKm > 5);
  const start = DrevLive.pointAlongRoute(route, 0);
  const mid = DrevLive.pointAlongRoute(route, 0.5);
  const end = DrevLive.pointAlongRoute(route, 1);
  assert.ok(Math.abs(start.lng - CHARLOTTE.lng) < 0.01);
  assert.ok(Math.abs(end.lng - -80.75) < 0.01 && Math.abs(end.lat - 35.31) < 0.01);
  assert.ok(DrevLive.haversineKm(mid, CHARLOTTE) > 1);
});

test('live-data: demand replay stays inside 24h and frames filter by time', () => {
  const events = DrevLive.generateDemand(7, 220);
  assert.equal(events.length, 220);
  assert.ok(events.every(e => e.minute >= 0 && e.minute <= 1439));
  assert.ok(events.every(e => e.lat > 34.9 && e.lat < 35.5 && e.lng > -81.1 && e.lng < -80.6));
  const frame = DrevLive.demandFrame(events, 12 * 60, 90);
  assert.ok(frame.every(e => e.minute <= 720 && e.minute > 630));
  assert.equal(DrevLive.fmtClock(0), '00:00');
  assert.equal(DrevLive.fmtClock(1439), '23:59');
});

test('live-data: outage zones are labelled demo and have heights', () => {
  const fc = DrevLive.outagesGeoJSON();
  assert.equal(fc.features.length, 3);
  assert.ok(fc.features.every(f => f.properties.demo === true && f.properties.height > 0));
  assert.ok(fc.features.every(f => f.geometry.type === 'Polygon'));
});

test('server sim: provider starts away from the job and arrives after the trip window', () => {
  const dispatchedAt = new Date('2026-01-01T12:00:00Z').toISOString();
  const req = { id: '123e4567-e89b-12d3-a456-426614174000', location_lng: CHARLOTTE.lng, location_lat: CHARLOTTE.lat, updated_at: dispatchedAt, provider_label: 'Unit 1' };
  const t0 = Date.parse(dispatchedAt);
  const start = providerPositionFor(req, t0);
  assert.equal(start.simulated, true);
  assert.equal(start.progress, 0);
  assert.ok(start.position.lng !== CHARLOTTE.lng || start.position.lat !== CHARLOTTE.lat);
  const end = providerPositionFor(req, t0 + 20 * 60 * 1000);
  assert.equal(end.progress, 1);
  assert.equal(end.arrived, true);
  assert.ok(Math.abs(end.position.lng - CHARLOTTE.lng) < 0.001);
  const fleet = providersSnapshot(t0);
  assert.equal(fleet.length, 6);
  assert.ok(fleet.every(u => u.simulated && Number.isFinite(u.position.lng)));
});

test('GET /live: public callers get aggregates only — no ids, no fleet, coarse coords', async () => {
  const db = new FakeDB();
  db.requests.push({ id: 'abc-123', category: 'roadside', service_type: 'jump-start', status: 'submitted', location_label: 'Secret St', location_lat: 35.227123, location_lng: -80.843987, requested_at: new Date().toISOString() });
  const res = await liveApi(ctx({ ASSIST_DB: db }, { url: 'https://assist.test/api/assist/live' }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.openTotal, 1);
  assert.equal(data.providers, undefined);
  assert.equal(data.requests, undefined);
  assert.equal(data.demand[0].lng, -80.844); // rounded to ~100m
  assert.ok(!JSON.stringify(data).includes('abc-123'));
  assert.ok(!JSON.stringify(data).includes('Secret St'));
});

test('GET /live: admin key unlocks the fleet + open requests', async () => {
  const db = new FakeDB();
  const env = { ASSIST_DB: db, ADMIN_KEY: 'test-admin-key-0123456789' };
  const res = await liveApi(ctx(env, { url: 'https://assist.test/api/assist/live', headers: { Authorization: 'Bearer test-admin-key-0123456789' } }));
  const data = await res.json();
  assert.equal(data.simulatedProviders, true);
  assert.equal(data.providers.length, 6);
  assert.ok(Array.isArray(data.outages) && data.outages.every(o => o.demo));
});

test('dispatched requests carry a simulated providerFeed on the status endpoint', async () => {
  const env = { ASSIST_DB: new FakeDB(), ADMIN_KEY: 'test-admin-key-0123456789' };
  const body = {
    category: 'roadside', serviceType: 'jump-start', locationLabel: 'Charlotte, NC',
    locationLatitude: 35.227, locationLongitude: -80.843, powertrain: 'ev',
    vehicle: '2024 Tesla Model Y', customerName: 'Sam Driver', customerPhone: '704-555-0123',
  };
  const created = await (await requestsApi(ctx(env, { method: 'POST', body }))).json();
  const id = created.request.id;
  const auth = { Authorization: 'Bearer test-admin-key-0123456789' };
  await adminApi(ctx(env, { method: 'PATCH', headers: auth, body: { id, status: 'reviewed' } }));
  await adminApi(ctx(env, { method: 'PATCH', headers: auth, body: { id, status: 'dispatched', providerLabel: 'Unit 1' } }));
  const status = await (await statusApi(ctx(env, { params: { id } }))).json();
  assert.equal(status.request.status, 'dispatched');
  assert.equal(status.request.providerFeed.simulated, true);
  assert.ok(Number.isFinite(status.request.providerFeed.position.lng));
});
