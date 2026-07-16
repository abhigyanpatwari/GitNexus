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
import { parseShardArg } from './shard-arg.js';

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
// Fail loud on a malformed --shard arg (mirrors the missing-files check above):
// a silently-dropped shard flag would run the full unsharded suite and re-trip
// the watchdog. Kept outside the execFileSync try/catch below so the message
// isn't swallowed by that catch's watchdog-only branch.
let shardArg: string | undefined;
try {
  shardArg = parseShardArg(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Per-shard watchdog, default 15 min. Sharding splits the file list by COUNT, not
// runtime, so the heaviest spawn suites can cluster on one shard — what this
// bounds is the *busiest* shard, not an even 1/n of wall-clock. The busiest
// Windows shard has grown to the default (14m57s on the v1.6.10-rc.19 green
// run, one observed timeout since — #2449), so CI raises the budget to 20
// minutes via GITNEXUS_CROSS_PLATFORM_TIMEOUT_MINUTES; the default stays 15
// for local runs.
const DEFAULT_TIMEOUT_MIN = 15;
const timeoutMinutes = Number.parseInt(
  process.env.GITNEXUS_CROSS_PLATFORM_TIMEOUT_MINUTES ?? String(DEFAULT_TIMEOUT_MIN),
  10,
);
const timeoutMs =
  Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
    ? timeoutMinutes * 60 * 1000
    : DEFAULT_TIMEOUT_MIN * 60 * 1000;

console.log(
  `Running ${ALL_CROSS_PLATFORM.length} platform-sensitive tests` +
    `${shardArg ? ` (${shardArg.replace('--shard=', 'shard ')})` : ''}...\n`,
);

const startedAt = Date.now();
try {
  execFileSync('npx', ['vitest', 'run', ...ALL_CROSS_PLATFORM, ...(shardArg ? [shardArg] : [])], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: timeoutMs,
    shell: true,
  });
} catch (err) {
  // execFileSync sets `killed`/`signal` when the watchdog above kills vitest.
  const e = err as {
    killed?: boolean;
    signal?: NodeJS.Signals | null;
    status?: number | null;
    code?: string;
  };
  if (e.killed || e.signal) {
    console.error(`vitest timed out after ${Math.round(timeoutMs / 60_000)} minutes`);
  }
  // #2449: Windows shards have died with a bare `status: null`, empty stderr
  // and nothing to triage from. Always leave the child's exit facts behind.
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.error(
    `vitest exited abnormally: status=${e.status ?? 'null'} signal=${e.signal ?? 'none'} ` +
      `killed=${e.killed === true} spawnCode=${e.code ?? 'none'} elapsed=${elapsedSec}s ` +
      `budget=${Math.round(timeoutMs / 60_000)}min`,
  );
  process.exit(1);
}
