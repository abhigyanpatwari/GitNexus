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

describe('group contracts reports its completeness', () => {
  /**
   * `groupContracts` returns the structured triple alongside the contracts, so
   * an agent can tell a complete listing from a floor. The `--json` path used
   * to destructure `{ contracts, crossLinks }` and re-serialize just those two,
   * which silently dropped every other field the service returned — including
   * the ones that say the listing is incomplete. Printing the payload whole is
   * what keeps a new field from needing a matching CLI edit to become visible.
   */
  const seedRegistry = (group: string, registry: Record<string, unknown>): void => {
    const groupDir = path.join(tmpHome, 'groups', group);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'contracts.json'), JSON.stringify(registry, null, 2));
  };

  const baseRegistry = {
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    contracts: [],
    crossLinks: [],
    repoSnapshots: {},
    missingRepos: [],
  };

  it('carries the incompleteness fields through --json', () => {
    expect(runGroup(['create', 'jsonfloor']).status).toBe(0);
    seedRegistry('jsonfloor', { ...baseRegistry, unreadableRepos: ['app/backend'] });

    const r = runGroup(['contracts', 'jsonfloor', '--json']);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;

    expect(payload.unreadableRepos).toEqual(['app/backend']);
    expect(payload.truncated).toBe(true);
    expect(payload.truncationReason).toBe('incomplete-sync');
    expect(payload.riskEpistemic).toBe('lower-bound');
    // Still everything it always returned.
    expect(payload.contracts).toEqual([]);
    expect(payload.crossLinks).toEqual([]);
  });

  it('tells a human reader the listing is a floor, and which repos are missing from it', () => {
    expect(runGroup(['create', 'humanfloor']).status).toBe(0);
    seedRegistry('humanfloor', { ...baseRegistry, unreadableRepos: ['app/backend'] });

    const r = runGroup(['contracts', 'humanfloor']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('app/backend');
    expect(r.stdout.toLowerCase()).toContain('incomplete');
  });

  it('control: a complete registry says nothing about truncation on either surface', () => {
    expect(runGroup(['create', 'complete']).status).toBe(0);
    seedRegistry('complete', { ...baseRegistry, unreadableRepos: [] });

    const j = JSON.parse(runGroup(['contracts', 'complete', '--json']).stdout) as Record<
      string,
      unknown
    >;
    expect(j.truncated).toBe(false);
    expect(j.truncationReason).toBeUndefined();
    expect(j.riskEpistemic).toBeUndefined();

    const h = runGroup(['contracts', 'complete']);
    expect(h.stdout.toLowerCase()).not.toContain('incomplete');
  });
});
