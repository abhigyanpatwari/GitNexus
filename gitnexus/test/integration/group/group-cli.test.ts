/**
 * Smoke-test `gitnexus group` CLI via tsx (same pattern as cli-e2e.test.ts).
 * Does not exercise LadybugDB-backed commands end-to-end (needs indexed fixtures).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

let tmpHome: string;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-group-cli-'));
});

afterAll(() => {
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

function runGroup(args: string[]) {
  return spawnSync(process.execPath, ['--import', tsxImportUrl, cliEntry, 'group', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GITNEXUS_HOME: tmpHome },
  });
}

describe('group CLI', () => {
  it('create + list', () => {
    const c = runGroup(['create', 'acme']);
    expect(c.status).toBe(0);
    expect(c.stdout).toContain('Created group "acme"');

    const l = runGroup(['list']);
    expect(l.status).toBe(0);
    expect(l.stdout).toContain('acme');
  });

  it('test_create_with_invalid_name_fails', () => {
    const result = runGroup(['create', '../../evil']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid group name');
  });

  it('test_sync_command_source_does_not_call_blanket_closeLbug', () => {
    const cliGroupPath = path.join(repoRoot, 'src', 'cli', 'group.ts');
    const source = fs.readFileSync(cliGroupPath, 'utf-8');

    // closeLbug() without arguments (blanket close) must not appear.
    // Match closeLbug() but not closeLbug(someArg)
    const blanketClosePattern = /closeLbug\s*\(\s*\)/;
    expect(source).not.toMatch(blanketClosePattern);
  });

  it('group impact requires --target and --repo', () => {
    const c = runGroup(['create', 'impcli']);
    expect(c.status).toBe(0);
    const r = runGroup(['impact', 'impcli']);
    expect(r.status).not.toBe(0);
  });

  it('group impact runs with Issue #794 style flags (fixture-backed home)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cli-impact-'));
    try {
      const gd = path.join(home, 'groups', 'test-group');
      fs.mkdirSync(gd, { recursive: true });
      fs.copyFileSync(
        path.join(repoRoot, 'test', 'fixtures', 'group', 'group.yaml'),
        path.join(gd, 'group.yaml'),
      );
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          tsxImportUrl,
          cliEntry,
          'group',
          'impact',
          'test-group',
          '--target',
          'health',
          '--repo',
          'app/backend',
          '--json',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 20000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, GITNEXUS_HOME: home },
        },
      );
      expect(r.status).not.toBe(0);
      const msg = `${r.stderr}\n${r.stdout}`;
      expect(msg).toMatch(/error|indexed|not found|repository/i);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
