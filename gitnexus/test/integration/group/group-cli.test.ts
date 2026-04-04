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
});
