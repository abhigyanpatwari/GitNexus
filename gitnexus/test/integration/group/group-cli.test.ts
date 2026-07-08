/**
 * Smoke-test `gitnexus group` CLI (same spawn pattern as cli-e2e.test.ts, via
 * CLI_SPAWN_PREFIX: built dist in CI, tsx-on-source locally).
 * Does not exercise LadybugDB-backed commands end-to-end (needs indexed fixtures).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CLI_SPAWN_PREFIX } from '../../helpers/cli-entry.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');
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
  return spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'group', ...args], {
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
          ...CLI_SPAWN_PREFIX,
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
