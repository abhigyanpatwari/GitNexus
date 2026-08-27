/**
 * Smoke-test `gitnexus group` CLI (same spawn pattern as cli-e2e.test.ts, via
 * CLI_SPAWN_PREFIX: built dist in CI, tsx-on-source locally).
 * Does not exercise LadybugDB-backed QUERY commands end-to-end (needs indexed
 * fixtures). `group sync` IS driven end-to-end below, but only through the two
 * shapes that need no indexed repo: a group whose members are absent from the
 * registry, and a group whose members are registered at a storage path holding
 * no `lbug` file at all — which is what makes them unreadable.
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

  /**
   * `--skip-embeddings` and `--allow-stale` were both accepted by commander and
   * then read by nothing: the first named a BM25/embedding cascade that was
   * never built, the second a stale-index warning that no sync path ever
   * emitted. An operator who passed either got a silent no-op and a clean exit,
   * which is worse than the flag not existing — so they are gone, and the CLI
   * must now say so.
   *
   * `unknown option` is asserted rather than just a nonzero exit because
   * `group sync <missing-group>` ALSO exits nonzero (GroupNotFoundError), so
   * the exit code alone cannot tell "the flag is rejected" from "the group is
   * not there". The control below is what makes that distinction visible.
   */
  it('test_sync_rejects_removed_skip_embeddings_flag', () => {
    const r = runGroup(['sync', 'acme', '--skip-embeddings']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown option '--skip-embeddings'");
  });

  it('test_sync_rejects_removed_allow_stale_flag', () => {
    const r = runGroup(['sync', 'acme', '--allow-stale']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown option '--allow-stale'");
  });

  it('control: the surviving --exact-only flag is still parsed', () => {
    // Without this, the two cases above would also pass against a `group sync`
    // that rejected EVERY option. This one reaches the action handler and
    // fails on the group instead, which is the proof that commander accepted
    // the flag itself.
    const r = runGroup(['sync', 'no-such-group', '--exact-only']);
    expect(r.stderr).not.toContain('unknown option');
    expect(`${r.stderr}\n${r.stdout}`).toContain('no-such-group');
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

/**
 * A group.yaml with every detector off, so nothing in a sync opens a repo graph
 * and the only thing that can vary is what the registry says about its members.
 *
 * `links` is spliced in verbatim because the two shapes below need different
 * ones: a manifest link is the single input that makes a sync produce contracts
 * with no indexed repo (synthetic UIDs — see
 * `group-service-sync-lazy-import.test.ts`), which is what gives the wrote-line
 * counts to assert something other than zeroes.
 */
function writeGroupYaml(
  home: string,
  group: string,
  repos: Record<string, string>,
  links = '[]',
): string {
  const groupDir = path.join(home, 'groups', group);
  fs.mkdirSync(groupDir, { recursive: true });
  const repoLines = Object.entries(repos)
    .map(([groupPath, registryName]) => `  ${groupPath}: ${registryName}`)
    .join('\n');
  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: ${group}
description: ""
repos:
${repoLines}
links: ${links}
packages: {}
detect:
  http: false
  grpc: false
  thrift: false
  topics: false
  shared_libs: false
  embedding_fallback: false
  includes: false
  workspace_deps: false
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
    'utf8',
  );
  return groupDir;
}

/**
 * `group sync` has three mutually exclusive things it can say about
 * contracts.json, and the sentence is the ONLY channel that distinguishes them:
 * all three exit 0, and two of them leave the file's contract counts identical.
 *
 * The line used to be the unconditional `Wrote contracts.json (0 contracts, 0
 * cross-links)`, printed even on a run that deliberately kept the previous
 * registry — a confident false statement about persisted state on the exact
 * path this command exists to make legible. These go through the real CLI
 * because the sentence IS the deliverable: the service payload can carry
 * `registryOutcome` perfectly while the console still says one thing for all
 * three.
 */
describe('group sync says what it did to contracts.json', () => {
  let home: string;

  /** Contracts a preserve run must carry forward untouched. */
  const PRIOR_REGISTRY = {
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    repoSnapshots: {},
    missingRepos: [],
    unreadableRepos: [],
    contracts: [],
    crossLinks: [],
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-group-sync-outcome-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /**
   * Registry rows whose storage directory exists but holds no `lbug` file, so
   * `initLbug` throws `LadybugDB not found at …` for every one of them. That is
   * a load ERROR, not an absence: the repos resolve, and every one of them
   * lands on `unreadableRepos` — the only state that reaches the two
   * total-failure branches. A row missing from registry.json instead reports as
   * MISSING and syncs to a written registry, which is the other case below.
   */
  const registerReposWithNoIndex = (registryNames: Record<string, string>): void => {
    const rows = Object.entries(registryNames).map(([registryName, dirName]) => {
      const repoPath = path.join(home, dirName);
      const storagePath = path.join(repoPath, '.gitnexus');
      fs.mkdirSync(storagePath, { recursive: true });
      return {
        name: registryName,
        path: repoPath,
        storagePath,
        indexedAt: '2026-01-01T00:00:00.000Z',
        lastCommit: 'abc123',
      };
    });
    fs.writeFileSync(path.join(home, 'registry.json'), JSON.stringify(rows), 'utf8');
  };

  it('prints what it wrote, and the counts, on a sync that produced a registry', () => {
    // Every member is genuinely absent from the registry, which is a clean
    // (if empty-handed) sync: the total-failure guard is gated on a load error,
    // never on an empty result. The declared manifest link still yields two
    // synthetic contracts and one cross-link, so the counts in the line are
    // non-zero and therefore say something.
    const groupDir = writeGroupYaml(
      home,
      'wrote',
      { 'app/backend': 'wrote-backend', 'app/frontend': 'wrote-frontend' },
      `
  - from: app/frontend
    to: app/backend
    type: custom
    contract: rotateSigningKey
    role: consumer`,
    );
    fs.writeFileSync(path.join(home, 'registry.json'), '[]', 'utf8');

    const r = runGroupIn(home, ['sync', 'wrote']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Wrote contracts.json (2 contracts, 1 cross-links)');
    // The other two sentences are about the same file and contradict this one.
    expect(r.stdout).not.toContain('Kept the previous contracts.json');
    expect(r.stdout).not.toContain('Did NOT write contracts.json');
    expect(fs.existsSync(path.join(groupDir, 'contracts.json'))).toBe(true);
  });

  /**
   * The per-stage `Matching:` block. It used to print `Matching cascade:` and
   * count `exact` alone, while the `Wrote contracts.json (…)` line beneath it
   * reported every cross-link — so for any group with manifest or wildcard
   * links the two numbers disagreed with nothing on screen explaining why.
   *
   * A manifest fixture is enough to pin both halves. The stage counts have to
   * sum to the printed total, and the skipped rendering does not depend on a
   * stage having matched anything: `--exact-only` records the suppression
   * whatever the fixture contains.
   */
  const writeManifestGroup = (name: string): void => {
    writeGroupYaml(
      home,
      name,
      { 'app/backend': `${name}-backend`, 'app/frontend': `${name}-frontend` },
      `
  - from: app/frontend
    to: app/backend
    type: custom
    contract: rotateSigningKey
    role: consumer`,
    );
    fs.writeFileSync(path.join(home, 'registry.json'), '[]', 'utf8');
  };

  it('prints a count for every matching stage, and they sum to the written total', () => {
    writeManifestGroup('stages');

    const r = runGroupIn(home, ['sync', 'stages']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('exact:     0 cross-links (confidence 1.0)');
    expect(r.stdout).toContain('manifest:  1 cross-links');
    expect(r.stdout).toContain('wildcard:  0 cross-links');
    // The reconciliation this block exists for: 0 + 1 + 0 is the total below.
    expect(r.stdout).toContain('Wrote contracts.json (2 contracts, 1 cross-links)');
  });

  it('names a stage it was told to skip as skipped, not as zero', () => {
    writeManifestGroup('skipped');

    const r = runGroupIn(home, ['sync', 'skipped', '--exact-only']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('wildcard:  skipped (--exact-only)');
    // "ran and matched nothing" must not be printable for a stage that never ran.
    expect(r.stdout).not.toContain('wildcard:  0 cross-links');
    // Manifest links are unaffected by the flag, so the total still says so.
    expect(r.stdout).toContain('manifest:  1 cross-links');
  });

  // control: the skipped rendering tracks the flag, not the fixture. Without
  // this, printing `skipped` unconditionally would pass the case above.
  it('control: the same group without the flag reports the stage as zero', () => {
    writeManifestGroup('unskipped');

    const r = runGroupIn(home, ['sync', 'unskipped']);

    expect(r.stdout).toContain('wildcard:  0 cross-links');
    expect(r.stdout).not.toContain('skipped (--exact-only)');
  });

  it('says the previous contracts.json was KEPT when no repo could be read', () => {
    // "Did NOT write contracts.json" was false here: this path REWRITES the
    // file, keeping the previous sync's contracts and replacing only the two
    // diagnostic lists. Saying otherwise sent an operator looking at an
    // unchanged mtime to conclude the sync had not run.
    const groupDir = writeGroupYaml(home, 'kept', {
      'app/backend': 'kept-backend',
      'app/frontend': 'kept-frontend',
    });
    registerReposWithNoIndex({ 'kept-backend': 'backend', 'kept-frontend': 'frontend' });
    const contractsPath = path.join(groupDir, 'contracts.json');
    fs.writeFileSync(contractsPath, JSON.stringify(PRIOR_REGISTRY), 'utf8');

    const r = runGroupIn(home, ['sync', 'kept']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'Kept the previous contracts.json — no repo in this group could be read.',
    );
    expect(r.stdout).toContain('Its contracts and cross-links are unchanged');
    expect(r.stdout).not.toContain('Wrote contracts.json');
    expect(r.stdout).not.toContain('Did NOT write contracts.json');

    // What makes the sentence true rather than merely present: the file is
    // still there, its contracts are the previous run's, and only the
    // diagnostic list describes THIS run.
    const onDisk = JSON.parse(fs.readFileSync(contractsPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.contracts).toEqual(PRIOR_REGISTRY.contracts);
    expect(onDisk.generatedAt).toBe(PRIOR_REGISTRY.generatedAt);
    expect(onDisk.unreadableRepos).toEqual(['app/backend', 'app/frontend']);
  });

  it('says nothing was written when no repo could be read and there is no prior registry', () => {
    // Distinct from the branch above on purpose: there is nothing on disk to
    // keep, so promising the previous sync's contracts are safe would send an
    // operator whose group has never synced looking for a file that has never
    // existed.
    const groupDir = writeGroupYaml(home, 'nothing', {
      'app/backend': 'nothing-backend',
      'app/frontend': 'nothing-frontend',
    });
    registerReposWithNoIndex({ 'nothing-backend': 'backend', 'nothing-frontend': 'frontend' });

    const r = runGroupIn(home, ['sync', 'nothing']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'Did NOT write contracts.json — no repo in this group could be read,',
    );
    expect(r.stdout).toContain('there is no previous contracts.json to fall back on');
    expect(r.stdout).not.toContain('Wrote contracts.json');
    expect(r.stdout).not.toContain('Kept the previous contracts.json');
    // And the claim is true of disk: no file was invented to go with it.
    expect(fs.existsSync(path.join(groupDir, 'contracts.json'))).toBe(false);
  });
});

/**
 * `undefined` and `[]` are different answers about the last sync's unreadable
 * repos — "never recorded" versus the measurement "none" — and `group status`
 * is where an operator reads them. Printing nothing for both would let an
 * unmeasured sync read as evidence that every index opened cleanly, which is
 * the fail-open the tri-state exists to close.
 */
describe('group status reports what the last sync recorded as unreadable', () => {
  let home: string;

  const BASE_REGISTRY = {
    version: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    repoSnapshots: {},
    missingRepos: [],
    contracts: [],
    crossLinks: [],
  };

  const NOT_RECORDED_LINE = 'Last sync unreadable repos: not recorded';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-group-status-unreadable-'));
    // An empty registry, so every member reports MISSING and nothing in the
    // per-repo table can vary between these three cases.
    fs.writeFileSync(path.join(home, 'registry.json'), '[]', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const seed = (group: string, registry: Record<string, unknown>): void => {
    const groupDir = writeGroupYaml(home, group, {
      'app/backend': `${group}-backend`,
      'app/frontend': `${group}-frontend`,
    });
    fs.writeFileSync(path.join(groupDir, 'contracts.json'), JSON.stringify(registry), 'utf8');
  };

  it('says the field was not recorded when the registry never carried it', () => {
    // A contracts.json written before the field existed has no opinion about
    // which indexes were readable, and the remedy is to re-run the sync — not
    // to conclude that none of them failed.
    seed('unrecorded', BASE_REGISTRY);

    const r = runGroupIn(home, ['status', 'unrecorded']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(NOT_RECORDED_LINE);
    expect(r.stdout).toContain('the registry predates this field, or its value could not be read');
    expect(r.stdout).toContain('Re-run `gitnexus group sync` to record it.');
  });

  it('says nothing at all when the registry recorded an empty list', () => {
    // `[]` is a measurement — this sync accounted for every repo — so there is
    // no caveat to print and no repo to name. Reporting the "not recorded"
    // caveat here would tell an operator to re-run the sync that just
    // succeeded.
    seed('measured', { ...BASE_REGISTRY, unreadableRepos: [] });

    const r = runGroupIn(home, ['status', 'measured']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('Last sync unreadable repos');
  });

  it('names the repos when the registry recorded some', () => {
    // Without this, "says nothing at all" above would also be satisfied by a
    // command that never printed this line on any registry.
    seed('named', { ...BASE_REGISTRY, unreadableRepos: ['app/backend'] });

    const r = runGroupIn(home, ['status', 'named']);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Last sync unreadable repos: app/backend');
    expect(r.stdout).not.toContain(NOT_RECORDED_LINE);
  });
});
