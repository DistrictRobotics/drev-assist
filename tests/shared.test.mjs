import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_CATALOG, canTransition, cleanText, isEmail, isPhone, isUuid,
  timingSafeEqual, escapeLike,
} from '../functions/api/assist/_shared.js';

test('catalogue: every service maps to exactly one valid category', () => {
  assert.equal(Object.keys(SERVICE_CATALOG).length, 14);
  for (const [id, s] of Object.entries(SERVICE_CATALOG)) {
    assert.ok(['roadside', 'home'].includes(s.category), id);
    assert.ok(s.label && s.guidance, id);
  }
});

test('status state machine allows forward flow and cancellation, blocks terminal exits', () => {
  assert.ok(canTransition('submitted', 'reviewed'));
  assert.ok(canTransition('reviewed', 'dispatched'));
  assert.ok(canTransition('dispatched', 'complete'));
  assert.ok(canTransition('submitted', 'cancelled'));
  assert.ok(!canTransition('complete', 'submitted'));
  assert.ok(!canTransition('cancelled', 'reviewed'));
  assert.ok(!canTransition('submitted', 'complete')); // must be reviewed/dispatched first
});

test('cleanText trims, strips control chars, enforces max + required', () => {
  assert.deepEqual(cleanText('  hello\x00 world  ', { max: 50 }), ['hello  world', null]);
  assert.equal(cleanText('x'.repeat(300), { max: 10 })[0].length, 10);
  assert.match(cleanText('', { required: true, field: 'Name' })[1], /Name is required/);
  assert.deepEqual(cleanText(undefined), ['', null]);
  assert.match(cleanText({ evil: true }, { field: 'Notes' })[1], /must be text/);
});

test('email / phone / uuid validators', () => {
  assert.ok(isEmail('driver@example.com'));
  assert.ok(!isEmail('not-an-email'));
  assert.ok(!isEmail('a@b'));
  assert.ok(isPhone('704-555-0123'));
  assert.ok(isPhone('+1 (704) 555-0123'));
  assert.ok(!isPhone('123'));
  assert.ok(!isPhone('call-me-maybe'));
  assert.ok(isUuid('123e4567-e89b-12d3-a456-426614174000'));
  assert.ok(!isUuid('REQ-ABC123'));
  assert.ok(!isUuid('123e4567-e89b-12d3-a456'));
});

test('timingSafeEqual and escapeLike', () => {
  assert.ok(timingSafeEqual('s3cret-value', 's3cret-value'));
  assert.ok(!timingSafeEqual('s3cret-value', 's3cret-valuf'));
  assert.ok(!timingSafeEqual('short', 'much-longer-value'));
  assert.ok(!timingSafeEqual('', ''));
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
});
