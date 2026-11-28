import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliAnalysisEnv, CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';

let root: string;
let registryPath: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-batch-'));
  registryPath = path.join(root, 'registry.json');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function runAnalyze(...args: string[]) {
  return spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'analyze', ...args], {
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

function analyzeAll(...args: string[]) {
  return runAnalyze('--all', ...args);
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
  it('refreshes registered checkouts with an existing duplicate alias', () => {
    const flags = ['--index-only', '--skip-fts'];
    const repos = ['first', 'second'].map((name) => path.join(root, name));
    for (const repo of repos) {
      mkdirSync(repo);
      execFileSync('git', ['init', '--quiet'], { cwd: repo });
      writeFileSync(path.join(repo, 'main.ts'), 'export function answer() { return 42; }');
      const registered = runAnalyze(
        ...flags,
        '--name',
        'shared-alias',
        '--allow-duplicate-name',
        repo,
      );
      expect(registered.status, registered.stderr).toBe(0);
    }

    const result = analyzeAll(...flags, '--force');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('2 succeeded, 0 skipped, 0 failed');
    expect(
      JSON.parse(readFileSync(registryPath, 'utf8')).map(({ name }: { name: string }) => name),
    ).toEqual(['shared-alias', 'shared-alias']);
  }, 100_000);

  it.skipIf(process.platform === 'win32')(
    'waits for the active analyzer after SIGTERM to the batch PID',
    async () => {
      const repos = ['first', 'second'].map((name) => path.join(root, name));
      for (const repo of repos) mkdirSync(repo);
      writeFileSync(
        registryPath,
        JSON.stringify(
          repos.map((repo) => ({
            name: path.basename(repo),
            path: repo,
            storagePath: path.join(repo, '.gitnexus'),
          })),
        ),
      );

      // A preload stands in for the child analyzer so its shutdown window
      // is deterministic and the test never races a real metadata write.
      const probe = path.join(root, 'analyzer-probe.mjs');
      writeFileSync(
        probe,
        `
      import { writeFileSync } from 'node:fs';
      if (!process.argv.includes('--all')) {
        const timer = setTimeout(() => process.exit(1), 4000);
        process.on('SIGTERM', () => {
          clearTimeout(timer);
          setTimeout(() => {
            writeFileSync('child-shutdown', 'complete');
            process.exit(143);
          }, 100);
        });
        console.log('child ready');
        await new Promise(() => {});
      }
    `,
      );
      const batch = spawn(
        process.execPath,
        ['--import', pathToFileURL(probe).href, ...CLI_SPAWN_PREFIX, 'analyze', '--all'],
        {
          cwd: root,
          env: cliAnalysisEnv({
            GITNEXUS_HOME: root,
            GITNEXUS_STORAGE_PATH: undefined,
            GITNEXUS_STORAGE_ROOT: undefined,
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let signalled = false;
      batch.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
        if (!signalled && output.includes('child ready')) {
          signalled = true;
          batch.kill('SIGTERM');
        }
      });
      const [status, signal] = await once(batch, 'exit');
      expect({ status, signal }).toEqual({ status: 143, signal: null });
      expect(signalled).toBe(true);
      expect(readFileSync(path.join(root, 'child-shutdown'), 'utf8')).toBe('complete');
      expect(output).not.toContain('Analyzing second');
    },
    30_000,
  );
});
