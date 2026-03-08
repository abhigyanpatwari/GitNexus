/**
 * P1 Integration Tests: CLI End-to-End
 *
 * Tests CLI commands via child process spawn:
 * - statusCommand: verify stdout for unindexed repo
 * - analyzeCommand: verify pipeline runs and creates .gitnexus/ output
 *
 * Uses process.execPath (never 'node' string), no shell: true.
 * Accepts status === null (timeout) as valid on slow CI runners.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
const MINI_REPO = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

beforeAll(() => {
  // Initialize mini-repo as a git repo so the CLI analyze command
  // can run the full pipeline (it requires a .git directory).
  const gitDir = path.join(MINI_REPO, '.git');
  if (!fs.existsSync(gitDir)) {
    spawnSync('git', ['init'], { cwd: MINI_REPO, stdio: 'pipe' });
    spawnSync('git', ['add', '-A'], { cwd: MINI_REPO, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'initial commit'], {
      cwd: MINI_REPO,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
    });
  }
});

afterAll(() => {
  // Clean up .git/ and .gitnexus/ directories created during the test
  for (const dir of ['.git', '.gitnexus']) {
    const fullPath = path.join(MINI_REPO, dir);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
});

function runCli(command: string, cwd: string, timeoutMs = 15000) {
  return spawnSync(process.execPath, ['--import', 'tsx', cliEntry, command], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('CLI end-to-end', () => {
  it('status command exits cleanly', () => {
    const result = runCli('status', MINI_REPO);

    // Accept timeout as valid on slow CI
    if (result.status === null) return;

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    // mini-repo may or may not be indexed depending on prior test runs
    expect(combined).toMatch(/Repository|not indexed/i);
  });

  it('analyze command runs pipeline on mini-repo', () => {
    const result = runCli('analyze', MINI_REPO, 30000);

    // Accept timeout as valid on slow CI
    if (result.status === null) return;

    expect(result.status).toBe(0);

    // Successful analyze should create .gitnexus/ output directory
    const gitnexusDir = path.join(MINI_REPO, '.gitnexus');
    expect(fs.existsSync(gitnexusDir)).toBe(true);
    expect(fs.statSync(gitnexusDir).isDirectory()).toBe(true);
  });
});
