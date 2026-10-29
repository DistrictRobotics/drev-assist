import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('Warm Trust customer design tokens are in place', () => {
  const css = read('css/assist.css');
  for (const token of ['#cc785c', '#faf9f5', '#141413', 'Fraunces', '--brand']) {
    assert.ok(css.includes(token), `assist.css missing ${token}`);
  }
  assert.ok(read('index.html').includes('Fraunces'), 'customer app must load the serif display font');
  assert.ok(css.includes('.sheet-cta') && css.includes('var(--brand)'), 'primary CTA must be coral');
});

test('EV-native battery tile exists and feeds the request snapshot', () => {
  const html = read('index.html');
  for (const id of ['ev-tile', 'inp-battery', 'ev-pct']) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  const app = read('js/assist-app.js');
  assert.ok(app.includes('syncBatteryTile') && app.includes('Battery: '), 'battery level must reach the payload notes');
});

test('Live Motion tracking pill styling is applied', () => {
  const css = read('css/assist.css');
  assert.ok(css.includes('.tracking-hud') && css.includes('translateX(-50%)'), 'tracking must be a centered floating pill');
  assert.ok(css.includes('border-radius: 28px'), 'pill radius expected');
});

test('Linear treatment is applied to the manager', () => {
  const css = read('css/manager.css');
  for (const token of ['#08090a', '#5e6ad2', '#23252a', 'Inter']) {
    assert.ok(css.includes(token), `manager.css missing ${token}`);
  }
  assert.ok(read('manager.html').includes('Inter'), 'manager must load Inter');
});
