/**
 * Smoke-test `gitnexus group` CLI (same spawn pattern as cli-e2e.test.ts, via
 * CLI_SPAWN_PREFIX: built dist in CI, tsx-on-source locally).
 * Does not exercise LadybugDB-backed commands end-to-end (needs indexed fixtures).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { CLI_SPAWN_PREFIX } from '../../helpers/cli-entry.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { INDEX_METADATA_FILE } from '../../../src/storage/repo-meta.js';

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

function runGroupIn(home: string, args: string[]) {
  return spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'group', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GITNEXUS_HOME: home },
  });
}

function runGroup(args: string[]) {
  return runGroupIn(tmpHome, args);
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

/**
 * The per-repo status table had ONE failure label — `MISSING (no entry in the
 * registry)` — and every reason a repo failed to resolve was printed with it,
 * including a global registry that could not be read at all. For that case the
 * line states something nobody measured (the command never got to read any
 * entry) and points at the wrong repair: index the repo, when the fix is to
 * repair the registry.
 *
 * These cases go through the real CLI because the label is the deliverable —
 * the service payload can carry the distinction perfectly while the table
 * still prints one word for both.
 */
describe('group status names which failure a repo hit', () => {
  let home: string;

  /** Two members: one the registry will know about, one it never will. */
  const GROUP_YAML = `version: 1
name: labels
description: ""
repos:
  backend: backend-registry
  svc/users: svc-users-registry
links: []
packages: {}
detect:
  http: false
  grpc: false
  thrift: false
  topics: false
  shared_libs: false
  embedding_fallback: false
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-group-status-labels-'));
    const groupDir = path.join(home, 'groups', 'labels');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'group.yaml'), GROUP_YAML, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /**
   * A registry row that survives `LocalBackend.init()`'s validation pass —
   * which prunes (and rewrites) any entry whose storage path has no metadata
   * file, so a row backed by nothing would silently become a genuine absence
   * before `group status` ever read the registry.
   */
  const registeredRow = (name: string, dirName: string): Record<string, string> => {
    const repoPath = path.join(home, dirName);
    const storagePath = path.join(repoPath, '.gitnexus');
    fs.mkdirSync(storagePath, { recursive: true });
    fs.writeFileSync(path.join(storagePath, INDEX_METADATA_FILE), '{}', 'utf8');
    return {
      name,
      path: repoPath,
      storagePath,
      indexedAt: '2026-01-01T00:00:00.000Z',
      lastCommit: 'abc123',
    };
  };

  const writeRegistry = (body: string): void =>
    fs.writeFileSync(path.join(home, 'registry.json'), body, 'utf8');

  it('says MISSING for a repo a readable registry simply does not hold', () => {
    // The label this command has always printed, kept honest: the registry
    // reads fine and genuinely has no row for either member.
    writeRegistry('[]');

    const r = runGroupIn(home, ['status', 'labels']);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ +backend +MISSING {3}\(no entry in the registry\)$/m);
    expect(r.stdout).toMatch(/^ +svc\/users +MISSING {3}\(no entry in the registry\)$/m);
    expect(r.stdout).not.toContain('UNRESOLVABLE');
  });

  it('says UNRESOLVABLE for a repo the registry holds but cannot resolve', () => {
    // Two registered clones under one name: the row is right there, and
    // resolution still cannot pick one. Printing "no entry in the registry"
    // here would be a false statement about the file just read — and the two
    // members must come out with DIFFERENT labels in the same table.
    writeRegistry(
      JSON.stringify([
        registeredRow('backend-registry', 'clone-a'),
        registeredRow('backend-registry', 'clone-b'),
      ]),
    );

    const r = runGroupIn(home, ['status', 'labels']);

    expect(r.status).toBe(0);
    // One line, not four: the ambiguity error is multi-line and gets folded.
    expect(r.stdout).toMatch(/^ +backend +UNRESOLVABLE \(.*backend-registry.*\)$/m);
    expect(r.stdout).toMatch(/^ +svc\/users +MISSING {3}\(no entry in the registry\)$/m);
  });

  it('says UNRESOLVABLE for every member when the registry itself cannot be read', () => {
    // Nothing was measured about any repo, so "no entry in the registry" is a
    // claim about a file that could not be parsed. Every configured member is
    // unresolved — including one whose row might have been perfectly fine.
    writeRegistry('{"repos": []}');

    const r = runGroupIn(home, ['status', 'labels']);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^ +backend +UNRESOLVABLE \(.*registry\.json.*\)$/m);
    expect(r.stdout).toMatch(/^ +svc\/users +UNRESOLVABLE \(.*registry\.json.*\)$/m);
    expect(r.stdout).not.toContain('MISSING');
  });
});
