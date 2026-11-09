/**
 * Real filesystem obstruction at the previous graph's checkpoint path.
 * Fresh staged writes must not conceal damaged recovery files by publishing
 * beside them (#3852). The prior row-update path reached a native checkpoint
 * rename failure here; staged publication now refuses during consolidation.
 * The in-place fallback must also fail, preserving bytes before mutation or
 * retaining a recovery marker after mutation begins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cliAnalysisEnv, CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { cleanupTempDirSync } from '../helpers/test-db.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

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

const runAnalyze = (walCheckpointThreshold: string) =>
  spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'analyze', '--skip-skills'], {
    cwd: repoPath,
    encoding: 'utf8',
    // Generous timeout: the test does real CSV/COPY work before the
    // first failing checkpoint, and CI runners are slow.
    timeout: process.env.CI ? 120_000 : 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cliAnalysisEnv({
      GITNEXUS_HOME: suiteGitnexusHome,
      GITNEXUS_WAL_CHECKPOINT_THRESHOLD: walCheckpointThreshold,
      CI: '1',
    }),
  });

describe('analyze blocked checkpoint family (real lbug, no mocks)', () => {
  it('refuses damaged prior recovery files and succeeds after the obstruction is removed', () => {
    const storageDir = path.join(repoPath, '.gitnexus');

    // 1) Clean full analyze (no blocker) — builds the index into staging and
    // swaps it in. Must succeed; the staging checkpoint name is unblocked.
    // Use the normal 64 MiB threshold while seeding the index. Checkpointing
    // every setup write needlessly stalls schema and FTS creation on Windows.
    const first = runAnalyze('67108864');
    expect(first.status === null ? 'timeout' : first.status, first.stderr).toBe(0);
    const { lbugPath, metaPath } = getStoragePaths(repoPath);
    const graphBefore = fs.readFileSync(lbugPath);
    const metadataBefore = fs.readFileSync(metaPath);

    // 2) Change a tracked source file so the next analyze must write a graph.
    const churnFile = path.join(repoPath, 'src', 'logger.ts');
    fs.appendFileSync(churnFile, `\nexport const walChurnMarker = ${Date.now()};\n`);
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    };
    spawnSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'churn for incremental'], {
      cwd: repoPath,
      stdio: 'pipe',
      env: gitEnv,
    });

    // 3) A non-empty directory cannot be replayed, renamed over or unlinked
    // as a checkpoint file. Rebuilding beside it must not hide that damage.
    const blockerDir = path.join(storageDir, 'lbug.wal.checkpoint');
    fs.rmSync(blockerDir, { recursive: true, force: true });
    fs.mkdirSync(blockerDir, { recursive: true });
    fs.writeFileSync(path.join(blockerDir, 'blocker'), 'cannot-be-renamed-over');

    // 4) Refuse the damaged family before certifying the replacement.
    const result = runAnalyze('1');
    const combined = `${result.stderr}\n${result.stdout}`;

    // The blocked checkpoint must produce an error, rather than a timeout.
    expect(result.status, combined).not.toBeNull();
    expect(result.status).not.toBe(0);

    expect(combined).toContain('lbug.wal.checkpoint');
    expect(fs.readFileSync(path.join(blockerDir, 'blocker'), 'utf8')).toBe(
      'cannot-be-renamed-over',
    );
    const staged = process.platform !== 'win32' || process.env.GITNEXUS_ATOMIC_WINDOWS_SWAP === '1';
    if (staged) {
      expect(combined).toContain('publication was stopped to preserve its recovery files');
      expect(combined).toContain('gitnexus clean --lbug-sidecars');
      expect(fs.readFileSync(lbugPath)).toEqual(graphBefore);
      expect(fs.readFileSync(metaPath)).toEqual(metadataBefore);
    } else {
      const failedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!failedMeta.incrementalInProgress) {
        // A read-only cache/accounting open can refuse before the first
        // destructive write. Without a recovery marker, both must be intact.
        expect(fs.readFileSync(lbugPath)).toEqual(graphBefore);
        expect(fs.readFileSync(metaPath)).toEqual(metadataBefore);
      }
    }

    fs.rmSync(blockerDir, { recursive: true });
    const recovered = runAnalyze('67108864');
    expect(recovered.status === null ? 'timeout' : recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).incrementalInProgress).toBeUndefined();
  }, 180_000);
});
