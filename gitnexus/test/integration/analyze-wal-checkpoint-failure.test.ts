/**
 * Integration test: WAL auto-checkpoint rename failure (#1741 / #1772).
 *
 * Drives the real `analyzeCommand` against a real LadybugDB instance and
 * provokes a genuine Ladybug-engine `IO exception: Error renaming file
 * <db>.wal to <db>.wal.checkpoint` by pre-planting a *directory* at the
 * `<db>.wal.checkpoint` rename target. `fs.rename` (which Ladybug's native
 * `LocalFileSystem` ultimately invokes) cannot overwrite a non-empty
 * directory with a file on either POSIX or Windows, and Ladybug's
 * `doInitLbug` orphan-cleanup uses `fs.unlink` which fails on a directory
 * — so the blocker survives initialization and the next auto-checkpoint
 * fires the natural rename failure that motivated PR #1772.
 *
 * No test-only hooks, no env-var fault toggles in production code: we use
 * the same `GITNEXUS_WAL_CHECKPOINT_THRESHOLD=1` knob that real users have
 * available to force checkpointing on every write, then arrange a real
 * filesystem state that makes the rename impossible.
 *
 * Verifies that:
 *   1. The CLI exits non-zero.
 *   2. stderr contains the actionable recovery hint pointing at
 *      `--wal-checkpoint-threshold 67108864` (the
 *      `RECOMMENDED_WAL_CHECKPOINT_THRESHOLD` constant in `analyze.ts`).
 *   3. The recovery message references the
 *      `GITNEXUS_WAL_CHECKPOINT_THRESHOLD` env var as a parallel route.
 *
 * Empirically confirmed portable on Windows; the same mechanism is
 * expected to work on POSIX (`rename(2)` fails with `EISDIR`/`ENOTEMPTY`
 * when the target is a non-empty directory). If a future Ladybug release
 * changes the rename ordering, the loose match on the recovery hint
 * (rather than the exact engine error wording) keeps this test stable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { cleanupTempDirSync } from '../helpers/test-db.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
const FIXTURE_SRC = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

let tmpParent: string;
let suiteGitnexusHome: string;
let repoPath: string;

beforeAll(() => {
  tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-wal-checkpoint-e2e-'));
  suiteGitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-wal-checkpoint-home-'));
  repoPath = path.join(tmpParent, 'mini-repo');
  fs.cpSync(FIXTURE_SRC, repoPath, { recursive: true });

  spawnSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  spawnSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'initial commit'], {
    cwd: repoPath,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
});

afterAll(() => {
  if (tmpParent) cleanupTempDirSync(tmpParent);
  if (suiteGitnexusHome) cleanupTempDirSync(suiteGitnexusHome);
});

describe('analyze WAL auto-checkpoint rename failure (real lbug, no mocks)', () => {
  it('surfaces the --wal-checkpoint-threshold recovery hint when the rename target is blocked', () => {
    // Plant a non-empty directory at the path Ladybug's auto-checkpoint
    // will try to rename `<db>.wal` over. `fs.rename` cannot overwrite a
    // non-empty directory, and the adapter's orphan-sidecar cleanup uses
    // `fs.unlink` (which fails on directories) — so the blocker persists
    // through `doInitLbug` and trips the very first auto-checkpoint that
    // a `GITNEXUS_WAL_CHECKPOINT_THRESHOLD=1` setting forces.
    const storageDir = path.join(repoPath, '.gitnexus');
    fs.mkdirSync(storageDir, { recursive: true });
    const blockerDir = path.join(storageDir, 'lbug.wal.checkpoint');
    fs.mkdirSync(blockerDir, { recursive: true });
    fs.writeFileSync(path.join(blockerDir, 'blocker'), 'cannot-be-renamed-over');

    const result = spawnSync(
      process.execPath,
      ['--import', tsxImportUrl, cliEntry, 'analyze', '--skip-skills'],
      {
        cwd: repoPath,
        encoding: 'utf8',
        // Generous timeout: the test does real CSV/COPY work before the
        // first failing checkpoint, and CI runners are slow.
        timeout: process.env.CI ? 120_000 : 60_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GITNEXUS_HOME: suiteGitnexusHome,
          // Skip ensureHeap re-exec (which drops the tsx loader).
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
          // Tiny threshold forces auto-checkpoint on every write so the
          // first write into the WAL trips the planted rename blocker.
          GITNEXUS_WAL_CHECKPOINT_THRESHOLD: '1',
          CI: '1',
        },
      },
    );

    const combined = `${result.stderr}\n${result.stdout}`;

    // The CLI must exit non-zero. status === null means the timeout fired
    // without a clean exit — also a failure for this assertion.
    expect(result.status === null ? 'timeout' : result.status).not.toBe(0);

    // Recovery hint must reference the CLI flag and the recommended
    // 64 MiB threshold (67_108_864 bytes). Both come from the
    // RECOMMENDED_WAL_CHECKPOINT_THRESHOLD constant in analyze.ts; keep
    // those values in sync with this assertion if the constant changes.
    expect(combined).toContain('gitnexus analyze --wal-checkpoint-threshold');
    expect(combined).toContain('67108864');
    // The env-var route should be advertised alongside the flag.
    expect(combined).toContain('GITNEXUS_WAL_CHECKPOINT_THRESHOLD');
  }, 180_000);
});
