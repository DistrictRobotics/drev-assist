import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('no inline event handlers or inline scripts (CSP can drop unsafe-inline for scripts)', () => {
  for (const page of ['index.html', 'manager.html', 'tech.html']) {
    const html = read(page);
    assert.ok(!/\son\w+="/.test(html), `${page} still has an inline handler`);
    assert.ok(!/<script>(?!\s*src)/.test(html.replace(/<script src=[^>]*><\/script>/g, '')), `${page} still has an inline script`);
  }
  const headers = read('_headers');
  const csp = headers.split('\n').find(l => l.includes('Content-Security-Policy'));
  const scriptSrc = csp.match(/script-src ([^;]+)/)[1];
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src must not allow unsafe-inline');
});

test('shared helpers verify JWTs — the old decode-only bearerSub is gone', () => {
  const shared = read('functions/api/assist/_shared.js');
  assert.ok(!shared.includes('bearerSub'), 'decode-only helper must not return');
  assert.ok(shared.includes('crypto.subtle.verify'), 'JWT signature verification required');
  assert.ok(!shared.includes("'Access-Control-Allow-Origin': '*'"), 'wildcard CORS must not return');
});

test('manager escapes customer data before rendering', () => {
  const js = read('js/manager.js');
  assert.ok(js.includes('escapeHtml'), 'manager must escape interpolated values');
  assert.ok(!js.includes('${r.customer_name}') || js.includes('escapeHtml(r.customer_name)'));
  assert.ok(!js.includes('sessionStorage') && !js.includes('localStorage'), 'admin key must never be persisted');
});

test('customer app collects contact details and never fakes success', () => {
  const html = read('index.html');
  for (const id of ['inp-name', 'inp-phone', 'inp-email', 'chk-location', 'review-overlay']) {
    assert.ok(html.includes(`id="${id}"`), `index.html missing #${id}`);
  }
  const js = read('js/assist-app.js');
  assert.ok(js.includes('REQUEST NOT SENT'), 'not-sent state must be explicit');
  assert.ok(js.includes('Idempotency-Key'), 'submissions must be idempotent');
  assert.ok(!js.includes('if (res.status === 503) {\n      refId = localRef();'), '503 must not become fake success');
});

test('schema and migrations cover every table the code writes to', () => {
  const schema = read('schema.sql');
  const migration = read('migrations/0003_hardening.sql');
  for (const table of ['assist_service_requests', 'assist_request_events', 'assist_rate_limits', 'assist_customers', 'assist_vehicles', 'assist_homes', 'assist_members']) {
    assert.ok(schema.includes(table), `schema.sql missing ${table}`);
  }
  for (const table of ['assist_request_events', 'assist_rate_limits', 'assist_customers', 'assist_vehicles', 'assist_homes']) {
    assert.ok(migration.includes(table), `0003 migration missing ${table}`);
  }
  assert.ok(existsSync(new URL('../tools/assist-standalone-test.mjs', import.meta.url)));
  assert.ok(existsSync(new URL('../js/live-data.js', import.meta.url)));
  assert.ok(existsSync(new URL('../functions/api/assist/live.js', import.meta.url)));
  assert.ok(existsSync(new URL('../.dev.vars.example', import.meta.url)));
});

test('realtime layer is wired into both apps and labelled simulated', () => {
  const idx = read('index.html');
  const mgr = read('manager.html');
  const app = read('js/assist-app.js');
  const man = read('js/manager.js');
  assert.ok(idx.includes('id="tracking-hud"') && idx.includes('js/live-data.js'));
  assert.ok(mgr.includes('id="dispatch-map"') && mgr.includes('id="time-slider"') && mgr.includes('js/live-data.js'));
  assert.ok(app.includes('startLiveTracking') && app.includes('SIMULATED LIVE FEED'));
  assert.ok(man.includes('initDispatchMap') && man.includes('demandFrame'));
  assert.ok(!man.includes('setHTML'), 'map popups must use DOM, not HTML strings');
});
