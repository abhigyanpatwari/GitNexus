/**
 * E2E: the analyze `--embedding-dims` validation on the REAL CLI parse path.
 *
 * The fix for the dims crash lives in the commander `preAction` hook in
 * src/cli/index.ts, which must validate the value BEFORE the lazy
 * import('./analyze.js') triggers schema.ts's module-load read of
 * GITNEXUS_EMBEDDING_DIMS (which throws on a bad value). Direct
 * analyzeCommand() unit tests bypass the hook entirely, so this interaction —
 * commander hook timing + synchronous program.parse + lazy import + the
 * module-load throw — can only be exercised by running the actual binary.
 *
 * Reliability: every case here is INVALID dims, so the hook prints a friendly
 * error and process.exit(1)s *before* the action runs. No repo, no lazy
 * import, no pipeline, no DB, no network — just tsx startup + commander parse.
 * That makes these deterministic and fast, unlike the full-analyze e2e cases.
 *
 * Spawns the CLI via CLI_SPAWN_PREFIX (built dist in CI, tsx-on-source locally),
 * mirroring test/integration/cli-e2e.test.ts.
 */
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';

let cwd: string;

beforeAll(() => {
  // The hook exits before any repo logic, so this dir need not be a git repo.
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-embed-dims-e2e-'));
});

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function runAnalyze(args: string[]) {
  // Strip any ambient GITNEXUS_EMBEDDING_* so the flag is the sole input.
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const k of Object.keys(env)) {
    if (k.startsWith('GITNEXUS_EMBEDDING_')) delete env[k];
  }
  // Pre-set the heap cap so analyzeCommand's ensureHeap() wouldn't re-exec
  // (would drop the tsx loader). Irrelevant on the invalid-dims path since the
  // hook exits first, but harmless and matches the cli-e2e harness.
  env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim();
  return spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'analyze', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
}

describe('analyze --embedding-dims validation (real CLI parse path)', () => {
  it.each(['abc', '0', '-5', '1e3', '3.5'])(
    'rejects %j with a friendly error, not a raw module-load crash',
    (bad) => {
      const result = runAnalyze([cwd, '--embedding-dims', bad]);
      const stderr = result.stderr ?? '';

      // Non-zero exit (the hook called process.exit(1)).
      expect(result.status).toBe(1);

      // The friendly, flag-named message surfaced...
      expect(stderr).toContain('--embedding-dims must be a positive integer');

      // ...and NOT the raw schema.ts throw (env-var-named) that would appear if
      // the hook validation were removed and schema.ts crashed during the lazy
      // import. This is the regression guard for finding #1.
      expect(stderr).not.toContain('GITNEXUS_EMBEDDING_DIMS must be a positive integer');
      // No unhandled-rejection / stack-trace leakage either.
      expect(stderr).not.toContain('UnhandledPromiseRejection');
      expect(stderr).not.toMatch(/^\s+at .+:\d+:\d+/m);
    },
    30_000,
  );
});
