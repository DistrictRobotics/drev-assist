import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('no render-blocking Mapbox assets in <head> — map loads dynamically with a timeout', () => {
  for (const page of ['index.html', 'manager.html']) {
    const html = read(page);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(!head.includes('api.mapbox.com'), `${page} must not block first paint on Mapbox`);
    assert.ok(!/<script src=/.test(head.replace(/<script src="js\//g, '')), `${page} head must not carry external scripts`);
  }
  const app = read('js/assist-app.js');
  assert.ok(app.includes('loadMapboxGL') && app.includes('timeout'), 'customer app needs a timed dynamic loader');
  assert.ok(app.includes('9000') || app.includes('9_000'), 'loader must have a hard timeout');
});

test('boot is not gated on window load (the old freeze)', () => {
  const app = read('js/assist-app.js');
  assert.ok(!app.includes("addEventListener('load'"), 'window load gate must not return');
  assert.ok(app.includes('DOMContentLoaded') && app.includes('boot()'), 'boot must run at DOM ready');
});

test('intro splash exists, is dismissible, and has a hard auto-dismiss cap', () => {
  const html = read('index.html');
  for (const id of ['intro', 'intro-help', 'intro-track']) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  assert.ok(html.includes('tel:911'), 'intro must surface 911');
  const app = read('js/assist-app.js');
  assert.ok(app.includes('dismissIntro') && app.includes('2600'), 'intro needs a hard-cap dismissal');
  const css = read('css/assist.css');
  assert.ok(css.includes('.intro.done'), 'intro needs a fade-out state');
  assert.ok(css.includes('prefers-reduced-motion'), 'intro animations must respect reduced motion');
});

test('low-end devices get a scaled-down map profile', () => {
  const app = read('js/assist-app.js');
  assert.ok(app.includes('LOW_POWER') && app.includes('deviceMemory'), 'capability detection required');
  assert.ok(app.includes('antialias: !LOW_POWER'), 'antialias must be off on low-power devices');
  assert.ok(app.includes('webglAvailable'), 'WebGL support must be probed');
  assert.ok(!app.includes('pitch: 58,'), 'no hardcoded full pitch (use the tier PITCH)');
  const css = read('css/assist.css');
  assert.ok(css.includes('body.low-power'), 'low-power CSS tier required');
});

test('no-map fallback keeps the request flow alive', () => {
  const html = read('index.html');
  for (const id of ['map-fallback', 'fallback-addr', 'fallback-locate']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  const app = read('js/assist-app.js');
  assert.ok(app.includes('enterNoMapMode'), 'fallback mode required');
  assert.ok(app.includes('body.no-map') || app.includes("'no-map'"), 'no-map body state required');
});

test('manager map also lazy-loads and scales down on phones', () => {
  const mgr = read('js/manager.js');
  assert.ok(mgr.includes('loadScriptMgr') && mgr.includes('MGR_LOW_POWER'));
  assert.ok(mgr.includes('antialias: !MGR_LOW_POWER'));
});
