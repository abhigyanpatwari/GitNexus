/**
 * Cross-platform test runner.
 *
 * Runs the platform-sensitive test subset defined in cross-platform-tests.ts
 * via vitest. Used by `npm run test:cross-platform` and by the CI cross-
 * platform matrix (ci-tests.yml).
 *
 * The main vitest.config.ts is used, so lbug-db project files get
 * sequential execution and other safety constraints are preserved.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALL_CROSS_PLATFORM } from './cross-platform-tests.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Verify all files exist
const missing = ALL_CROSS_PLATFORM.filter((f) => !fs.existsSync(path.resolve(ROOT, f)));
if (missing.length > 0) {
  console.error(`Cross-platform test files not found (${missing.length}):`);
  for (const f of missing) console.error(`  ${f}`);
  console.error('\nUpdate scripts/cross-platform-tests.ts if files were moved or removed.');
  process.exit(1);
}

console.log(`Running ${ALL_CROSS_PLATFORM.length} platform-sensitive tests...\n`);

try {
  execFileSync('npx', ['vitest', 'run', ...ALL_CROSS_PLATFORM], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 15 * 60 * 1000,
    shell: true,
  });
} catch (err: any) {
  if (err.killed || err.signal) {
    console.error('vitest timed out after 15 minutes');
  }
  process.exit(1);
}
