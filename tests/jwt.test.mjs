import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, authConfigured } from '../functions/api/assist/_shared.js';

/* Generate a real RSA keypair in-test, publish its public JWK through a
   stubbed JWKS endpoint, and prove that (a) properly signed tokens pass and
   (b) forged / expired tokens — the exact attack the old decode-only code
   allowed — are rejected. */

const b64url = buf => Buffer.from(buf).toString('base64url');

async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { ...pair, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

async function sign(privateKey, kid, claims) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const now = Math.floor(Date.now() / 1000);
const real = await makeKey('real-key');
const attacker = await makeKey('real-key'); // same kid, different key material

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ keys: [real.jwk] }), { headers: { 'Content-Type': 'application/json' } });

const env = { AUTH_JWKS_URL: 'https://issuer.test/jwks.json', AUTH_ISSUER: 'https://issuer.test' };
const req = token => new Request('https://assist.test/api/assist/requests', { headers: { Authorization: `Bearer ${token}` } });

test.after(() => { globalThis.fetch = realFetch; });

test('authConfigured reflects env', () => {
  assert.ok(authConfigured(env));
  assert.ok(!authConfigured({}));
});

test('valid RS256 token authenticates and returns sub', async () => {
  const token = await sign(real.privateKey, 'real-key', { sub: 'user-123', iss: 'https://issuer.test', exp: now + 600 });
  const claims = await authenticate(req(token), env);
  assert.equal(claims?.sub, 'user-123');
});

test('forged token (wrong signing key) is rejected — decode-only would have accepted it', async () => {
  const token = await sign(attacker.privateKey, 'real-key', { sub: 'admin-impersonator', iss: 'https://issuer.test', exp: now + 600 });
  assert.equal(await authenticate(req(token), env), null);
});

test('expired, wrong-issuer, and unsigned tokens are rejected', async () => {
  const expired = await sign(real.privateKey, 'real-key', { sub: 'u', iss: 'https://issuer.test', exp: now - 10 });
  assert.equal(await authenticate(req(expired), env), null);

  const wrongIss = await sign(real.privateKey, 'real-key', { sub: 'u', iss: 'https://evil.test', exp: now + 600 });
  assert.equal(await authenticate(req(wrongIss), env), null);

  const unsigned = `${b64url(JSON.stringify({ alg: 'none', kid: 'real-key' }))}.${b64url(JSON.stringify({ sub: 'u', iss: 'https://issuer.test', exp: now + 600 }))}.`;
  assert.equal(await authenticate(req(unsigned), env), null);
});
