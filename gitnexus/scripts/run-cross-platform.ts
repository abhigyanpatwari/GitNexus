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

// Pass the complete subset and --shard to the configured timing sequencer.
// Every runner reads the same snapshot, selected once by CI's shard-plan job.
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

// Preserve the 15-minute local watchdog and the 20-minute CI override.
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
  `Running platform-sensitive test suite (${ALL_CROSS_PLATFORM.length} files total)` +
    `${shardArg ? ` (${shardArg}, balanced by timing history)` : ''}...\n`,
);

const startedAt = Date.now();
const reportName = process.env.GITNEXUS_TEST_REPORT;
if (reportName && !/^[a-zA-Z0-9_-]+\.json$/.test(reportName)) {
  throw new Error('GITNEXUS_TEST_REPORT must be a JSON basename');
}
const reportArgs = reportName
  ? [
      '--reporter=default',
      '--reporter=./scripts/execution-reporter.ts',
      '--reporter=blob',
      `--outputFile.json=${reportName}`,
      `--outputFile.blob=.vitest/blob/${reportName}`,
    ]
  : [];
try {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
      'run',
      ...ALL_CROSS_PLATFORM,
      ...(shardArg ? [shardArg] : []),
      ...reportArgs,
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: timeoutMs,
    },
  );
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
