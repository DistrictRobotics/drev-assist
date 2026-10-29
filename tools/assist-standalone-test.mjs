#!/usr/bin/env node
/* Standalone smoke checks (no wrangler / network needed):
     node tools/assist-standalone-test.mjs
   The full suite lives in tests/ and runs with `npm test`. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
