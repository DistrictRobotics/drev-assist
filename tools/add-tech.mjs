#!/usr/bin/env node
/* Mint a technician access code without the browser.
 *
 * Use this when you would rather apply a migration by hand than click
 * "+ NEW TECH" in the manager (which does the same thing via
 * POST /api/assist/techs and shows the code once).
 *
 *   node tools/add-tech.mjs --name "Maya Ramirez" --unit "Unit 1"
 *   node tools/add-tech.mjs --name "Dev Shah" --local      # also apply to the local D1
 *
 * Only the SHA-256 digest of the code is written; the code itself is printed
 * once, here, and is not recoverable afterwards.
 */
import { createHash, randomUUID, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function mintCode() {
  const bytes = randomBytes(8);
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

const sha256 = s => createHash('sha256').update(s).digest('hex');
const sqlStr = v => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const name = arg('name');
const unit = arg('unit');
const phone = arg('phone');
const local = process.argv.includes('--local');

if (!name) {
  console.error('Usage: node tools/add-tech.mjs --name "Maya Ramirez" [--unit "Unit 1"] [--phone 704-555-0100] [--local]');
  process.exit(1);
}

const id = randomUUID();
const code = mintCode();
const hash = sha256(code);

const sql = `INSERT INTO assist_technicians (id, name, unit, phone, access_code_hash)
VALUES (${sqlStr(id)}, ${sqlStr(name)}, ${sqlStr(unit)}, ${sqlStr(phone)}, ${sqlStr(hash)});`;

console.log(`
  DREV Assist — technician created

  name : ${name}${unit ? `\n  unit : ${unit}` : ''}
  id   : ${id}

  ACCESS CODE: ${code}

  Show it once and hand it to the technician. Only its digest is stored, so it
  cannot be displayed again (rotate with POST /api/assist/techs {id, "regenerate":true}).
`);

if (local) {
  console.log(`  Apply to the LOCAL database with:

  npx wrangler d1 execute drev-assist-db --local --command "${sql.replace(/"/g, '\\"')}"
`);
} else {
  console.log(`  Then provision it (local or remote):

  npx wrangler d1 execute drev-assist-db --local --command "${sql.replace(/"/g, '\\"')}"
  npx wrangler d1 execute drev-assist-db --remote --command "${sql.replace(/"/g, '\\"')}"
`);
}
