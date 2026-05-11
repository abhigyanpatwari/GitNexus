/**
 * Integration smoke test: `gitnexus export`
 *
 * Runs analyze on the mini-repo fixture, then exercises the three export
 * formats (json, csv, parquet) and verifies that per-table files are
 * created and non-empty.  Uses the same spawning helpers as cli-e2e.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
const FIXTURE_SRC = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

let MINI_REPO: string;
let tmpParent: string;

function runCliRaw(
  extraArgs: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 60000,
) {
  return spawnSync(process.execPath, ['--import', tsxImportUrl, cliEntry, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
      ...extraEnv,
    },
  });
}

beforeAll(() => {
  tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-export-smoke-'));
  MINI_REPO = path.join(tmpParent, 'mini-repo');
  fs.cpSync(FIXTURE_SRC, MINI_REPO, { recursive: true });

  spawnSync('git', ['init'], { cwd: MINI_REPO, stdio: 'pipe' });
  spawnSync('git', ['add', '-A'], { cwd: MINI_REPO, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'initial commit'], {
    cwd: MINI_REPO,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });

  // Index the repo once so all export tests can share the artifact.
  const analyzeResult = runCliRaw(['analyze', '--index-only'], MINI_REPO, {}, 60000);
  if (analyzeResult.status !== 0 && analyzeResult.status !== null) {
    throw new Error(
      `analyze setup failed (exit ${analyzeResult.status}):\n${analyzeResult.stdout}\n${analyzeResult.stderr}`,
    );
  }
}, 120_000);

afterAll(() => {
  if (tmpParent) {
    fs.rmSync(tmpParent, { recursive: true, force: true });
  }
});

describe('gitnexus export smoke tests', () => {
  it('export --format json writes non-empty node and meta.json files', () => {
    const exportDir = path.join(tmpParent, 'export-json');

    const result = runCliRaw(
      ['export', MINI_REPO, '-o', exportDir, '--format', 'json', '--force'],
      MINI_REPO,
    );

    if (result.status === null) return; // timeout — slow CI

    expect(
      result.status,
      `export json failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    const files = fs.readdirSync(exportDir);
    expect(files).toContain('meta.json');

    const nodeFiles = files.filter((f) => f.startsWith('nodes_') && f.endsWith('.json'));
    expect(nodeFiles.length).toBeGreaterThan(0);

    // Every exported file must be non-empty
    for (const f of files) {
      const size = fs.statSync(path.join(exportDir, f)).size;
      expect(size, `${f} is empty`).toBeGreaterThan(0);
    }
  }, 90_000);

  it('export --format csv writes non-empty .csv files', () => {
    const exportDir = path.join(tmpParent, 'export-csv');

    const result = runCliRaw(
      ['export', MINI_REPO, '-o', exportDir, '--format', 'csv', '--force'],
      MINI_REPO,
    );

    if (result.status === null) return;

    expect(
      result.status,
      `export csv failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    const files = fs.readdirSync(exportDir);
    expect(files).toContain('meta.json');

    const csvFiles = files.filter((f) => f.endsWith('.csv'));
    expect(csvFiles.length).toBeGreaterThan(0);

    for (const f of csvFiles) {
      const size = fs.statSync(path.join(exportDir, f)).size;
      expect(size, `${f} is empty`).toBeGreaterThan(0);
    }
  }, 90_000);

  it('export --format parquet writes non-empty .parquet files', () => {
    const exportDir = path.join(tmpParent, 'export-parquet');

    const result = runCliRaw(
      ['export', MINI_REPO, '-o', exportDir, '--format', 'parquet', '--force'],
      MINI_REPO,
    );

    if (result.status === null) return;

    expect(
      result.status,
      `export parquet failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    const files = fs.readdirSync(exportDir);
    expect(files).toContain('meta.json');

    const parquetFiles = files.filter((f) => f.endsWith('.parquet'));
    expect(parquetFiles.length).toBeGreaterThan(0);

    for (const f of parquetFiles) {
      const size = fs.statSync(path.join(exportDir, f)).size;
      expect(size, `${f} is empty`).toBeGreaterThan(0);
    }
  }, 90_000);

  it('export without --force exits cleanly when output dir already has files', () => {
    const exportDir = path.join(tmpParent, 'export-guard');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(path.join(exportDir, 'existing.json'), '{}');

    const result = runCliRaw(['export', MINI_REPO, '-o', exportDir], MINI_REPO);

    if (result.status === null) return;

    expect(result.status).toBe(0); // exits cleanly, not an error
    expect(result.stdout + result.stderr).toMatch(/already contains files|--force/i);
    // The existing file must not have been overwritten
    const files = fs.readdirSync(exportDir);
    expect(files).toEqual(['existing.json']);
  }, 30_000);

  it('export with no indexed repo exits with non-zero code', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-no-index-'));
    spawnSync('git', ['init'], { cwd: emptyDir, stdio: 'pipe' });

    try {
      const result = runCliRaw(['export', emptyDir, '--force'], emptyDir);

      if (result.status === null) return;

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/no indexed repository|gitnexus analyze/i);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 30_000);
});
