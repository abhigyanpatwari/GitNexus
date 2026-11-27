import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliAnalysisEnv, CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';

let root: string;
let registryPath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-batch-'));
  registryPath = path.join(root, 'registry.json');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function analyzeAll(...args: string[]) {
  return spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'analyze', '--all', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
    env: cliAnalysisEnv({
      GITNEXUS_HOME: root,
      GITNEXUS_STORAGE_PATH: undefined,
      GITNEXUS_STORAGE_ROOT: undefined,
    }),
  });
}

describe('analyze --all', () => {
  it('reports an empty registry', () => {
    const result = analyzeAll();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 succeeded, 0 skipped, 0 failed');
  });

  it('rejects a corrupt registry', () => {
    writeFileSync(registryPath, '{');
    const result = analyzeAll();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('registry is corrupt');
  });

  it.each([['--watch'], ['--branch', 'main'], ['--name', 'alias'], ['.']])(
    'rejects a conflicting selector %s',
    (...args) => {
      const result = analyzeAll(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--all');
    },
  );

  it('counts missing and failed checkouts and continues to the next repo', () => {
    const missing = path.join(root, 'missing');
    const invalid = path.join(root, 'not a repo');
    const valid = path.join(root, 'repo with spaces');
    const nonGit = path.join(valid, 'non-git index');
    mkdirSync(invalid);
    mkdirSync(valid);
    mkdirSync(nonGit);
    execFileSync('git', ['init', '--quiet'], { cwd: valid });
    writeFileSync(path.join(valid, 'main.ts'), 'export function answer() { return 42; }');
    writeFileSync(path.join(nonGit, 'main.ts'), 'export function answer() { return 43; }');
    writeFileSync(
      registryPath,
      JSON.stringify(
        [missing, invalid, valid, nonGit].map((repoPath) => ({
          name: path.basename(repoPath),
          path: repoPath,
          storagePath: path.join(repoPath, '.gitnexus'),
          indexedAt: new Date(0).toISOString(),
          ...(repoPath === nonGit ? {} : { lastCommit: 'previous' }),
        })),
      ),
    );

    const result = analyzeAll('--force', '--index-only', '--skip-fts');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Skipping');
    expect(result.stderr).toContain('Analysis failed');
    expect(result.stdout, result.stderr).toContain('2 succeeded, 1 skipped, 1 failed');
    expect(
      JSON.parse(readFileSync(registryPath, 'utf8')).map((repo: { path: string }) => repo.path),
    ).toEqual([missing, invalid, valid, nonGit]);
    expect(
      JSON.parse(readFileSync(path.join(valid, '.gitnexus', 'meta.json'), 'utf8')).stats.nodes,
    ).toBeGreaterThan(0);
    expect(
      JSON.parse(readFileSync(path.join(nonGit, '.gitnexus', 'meta.json'), 'utf8')),
    ).toMatchObject({
      repoPath: nonGit,
      lastCommit: '',
    });
  }, 100_000);
});
