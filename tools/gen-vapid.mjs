#!/usr/bin/env node
/* Generate a VAPID key pair for Web Push.
 *
 *   node tools/gen-vapid.mjs                 # print the env vars
 *   node tools/gen-vapid.mjs --format json   # {"publicKey":…,"privateKey":…}
 *
 * Add the output to .dev.vars locally and to the Pages project's environment
 * (Settings → Environment variables) in production. The public key is public
 * by design — the browser subscribes with it. The private key never leaves
 * the server; if it does, rotate both and every subscription must re-subscribe.
 */
import { webcrypto as crypto } from 'node:crypto';

const ALPHABET_B64URL = /[+/=]/g;
const b64url = bytes => Buffer.from(bytes).toString('base64').replace(ALPHABET_B64URL, c => ({ '+': '-', '/': '_', '=': '' }[c]));

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)); // 0x04 || X || Y
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const d = Buffer.from(jwk.d, 'base64url');

const publicKey = b64url(raw);
const privateKey = b64url(new Uint8Array(d));

if (process.argv.includes('--format')) {
  const i = process.argv.indexOf('--format');
  if (process.argv[i + 1] === 'json') {
    console.log(JSON.stringify({ publicKey, privateKey }, null, 2));
    process.exit(0);
  }
}

console.log(`
  DREV Assist — VAPID keys for Web Push

  Add these to .dev.vars (local) and to the Pages project environment (prod):

  VAPID_PUBLIC_KEY=${publicKey}
  VAPID_PRIVATE_KEY=${privateKey}
  VAPID_SUBJECT=mailto:ops@drev.space

  Then run the migration:

  npx wrangler d1 execute drev-assist-db --local --file migrations/0005_push.sql
`);
