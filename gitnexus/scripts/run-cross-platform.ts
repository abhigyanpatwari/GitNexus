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

// Optional sharding (CI): `--shard=<i>/<n>` splits the fixed file list across
// parallel matrix shards so each runner processes ~1/n of it. Passed straight
// through to vitest, which partitions the *given* files deterministically. The
// Windows runner is ~5x slower than macOS/Linux on this spawn-heavy suite (~50
// CLI/worker process spawns), so a single shard was creeping past the watchdog
// below; sharding keeps each runner well under it (see ci-tests.yml matrix).
const shardArg = process.argv.slice(2).find((a) => /^--shard=\d+\/\d+$/.test(a));

// Per-shard watchdog. Kept at 15 min: with sharding each runner does a fraction
// of the suite, so this is generous headroom, not the tripwire it had become for
// the whole unsharded Windows run.
const TIMEOUT_MIN = 15;

console.log(
  `Running ${ALL_CROSS_PLATFORM.length} platform-sensitive tests` +
    `${shardArg ? ` (${shardArg.replace('--shard=', 'shard ')})` : ''}...\n`,
);

try {
  execFileSync('npx', ['vitest', 'run', ...ALL_CROSS_PLATFORM, ...(shardArg ? [shardArg] : [])], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: TIMEOUT_MIN * 60 * 1000,
    shell: true,
  });
} catch (err) {
  // execFileSync sets `killed`/`signal` when the watchdog above kills vitest.
  const e = err as { killed?: boolean; signal?: NodeJS.Signals | null };
  if (e.killed || e.signal) {
    console.error(`vitest timed out after ${TIMEOUT_MIN} minutes`);
  }
  process.exit(1);
}
