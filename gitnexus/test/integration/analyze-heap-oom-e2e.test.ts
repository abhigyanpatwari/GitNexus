import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const distCli = path.join(repoRoot, 'dist', 'cli', 'index.js');
const fixtureSource = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

const runAnalyzeWithForcedOom = (cwd: string, gitnexusHome: string) =>
  spawnSync(process.execPath, [distCli, 'analyze'], {
    cwd,
    encoding: 'utf8',
    timeout: process.env.CI ? 40_000 : 20_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GITNEXUS_HOME: gitnexusHome,
      NODE_OPTIONS: '',
      GITNEXUS_TEST_RESPAWN_HEAP_MB: '32',
      GITNEXUS_TEST_FORCE_HEAP_OOM: '1',
      CI: '1',
    },
  });

describe('analyze OOM guidance (real child-process OOM)', () => {
  it('prints OOM guidance with Unix and Windows commands when respawned child truly OOMs', () => {
    if (!fs.existsSync(distCli)) {
      throw new Error(
        'dist/cli/index.js missing — run `npm run build` first (or use `npm run test:integration`, which builds via pretest:integration).',
      );
    }

    const oomTestRepoParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-oom-e2e-repo-'));
    const oomTestGitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-oom-e2e-home-'));
    const repoPath = path.join(oomTestRepoParent, 'mini-repo');

    fs.cpSync(fixtureSource, repoPath, { recursive: true });
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

    try {
      const result = runAnalyzeWithForcedOom(repoPath, oomTestGitnexusHome);
      const combinedOutput = `${result.stderr}\n${result.stdout}`;

      expect(result.status).not.toBeNull();
      expect(result.status).not.toBe(0);
      expect(combinedOutput).toContain('Analysis likely ran out of memory.');
      expect(combinedOutput).toContain(
        'NODE_OPTIONS="--max-old-space-size=24576" gitnexus analyze [your-args]',
      );
      expect(combinedOutput).toContain(
        '(Windows: set NODE_OPTIONS=--max-old-space-size=24576 && gitnexus analyze [your-args])',
      );
    } finally {
      fs.rmSync(oomTestRepoParent, { recursive: true, force: true });
      fs.rmSync(oomTestGitnexusHome, { recursive: true, force: true });
    }
  }, 60_000);
});
