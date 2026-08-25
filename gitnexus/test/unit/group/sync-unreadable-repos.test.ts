import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { _captureLogger } from '../../../src/core/logger.js';
import type { GroupConfig, RepoHandle } from '../../../src/core/group/types.js';

/**
 * A repo that is registered but whose index cannot be opened must not be
 * reported as a MISSING repo, and must not silently replace a good
 * contracts.json with an empty one.
 *
 * The failure this pins: `syncGroup` wrapped `initLbug` + extraction in a bare
 * `catch {}` that pushed the repo onto `missingRepos` and discarded the error.
 * A LadybugDB storage-version mismatch therefore surfaced as "repo not found",
 * `group sync` printed `0 contracts, 0 cross-links` and exited 0, and the
 * existing registry was overwritten with an empty one.
 *
 * Three of these cases exist because mutation testing showed the original four
 * could not see the change they were named after:
 *  - a two-repo case, because with exactly one configured repo
 *    `unreadableRepos.length === configuredRepoCount` holds whenever anything
 *    fails, so deleting the `=== configuredRepoCount` conjunct — turning "every
 *    repo failed" into "any repo failed" — passed everything;
 *  - an all-missing case, because deleting the `unreadableRepos.length > 0`
 *    conjunct was caught only by a 9.7 s integration test in another directory;
 *  - a log assertion, because deleting both `logger.warn` calls — the entire
 *    stated purpose of the change — passed everything too.
 */

const LBUG_VERSION_ERROR =
  'LadybugDB unavailable for backend-repo. Another process may be rebuilding the index. ' +
  'Retry later. (Runtime exception: Trying to read a database file with a different version. ' +
  'Database file version: 43, Current build storage version: 40)';

const initLbugMock = vi.fn();
const readRegistryMock = vi.fn();

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: (...args: unknown[]) => initLbugMock(...args),
  executeParameterized: vi.fn(async () => []),
  pinRepo: vi.fn(() => () => {}),
  getMaxResidentRepos: vi.fn(() => 5),
}));

// Both bind to the same mock: `syncGroup` reads through the strict export, and
// the refuses-to-sync case below drives it by rejecting.
vi.mock('../../../src/storage/repo-manager.js', () => ({
  readRegistry: (...args: unknown[]) => readRegistryMock(...args),
  readRegistryStrict: (...args: unknown[]) => readRegistryMock(...args),
}));

const { syncGroup } = await import('../../../src/core/group/sync.js');

const registryEntry = (name: string, dir: string) => ({
  name,
  path: `/repos/${dir}`,
  storagePath: `/repos/${dir}/.gitnexus`,
  indexedAt: '2026-01-01T00:00:00.000Z',
  lastCommit: 'abc123',
});

const REGISTRY = [registryEntry('backend-repo', 'backend'), registryEntry('web-repo', 'web')];

const makeConfig = (repos: Record<string, string>): GroupConfig => ({
  version: 1,
  name: 'test',
  description: '',
  repos,
  links: [],
  packages: {},
  detect: {
    http: true,
    grpc: false,
    thrift: false,
    topics: false,
    shared_libs: false,
    embedding_fallback: false,
    includes: false,
    workspace_deps: false,
  },
  matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
});

/**
 * Resolve handles from a table keyed on the registry name, so a multi-repo case
 * needs no branching inside the test body. An unknown name resolves to `null`,
 * which is the production "not in the registry" answer.
 */
const handleTable = (names: readonly string[]) => {
  const byName = new Map<string, RepoHandle>(
    names.map((name) => [
      name,
      {
        id: `pool-${name}`,
        path: `/repos/${name}`,
        repoPath: `/repos/${name}`,
        storagePath: `/repos/${name}/.gitnexus`,
      },
    ]),
  );
  return async (registryName: string): Promise<RepoHandle | null> =>
    byName.get(registryName) ?? null;
};

/** `initLbug` is called with the pool id, so failures can be keyed on the repo. */
const failInitFor = (failingPoolIds: ReadonlySet<string>) => async (poolId: unknown) => {
  if (failingPoolIds.has(String(poolId))) throw new Error(LBUG_VERSION_ERROR);
};

const PRIOR_REGISTRY = {
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  repoSnapshots: {},
  missingRepos: [],
  contracts: [{ contractId: 'http::GET::/api/users' }],
  crossLinks: [{ contractId: 'http::GET::/api/users' }],
};

describe('syncGroup with an unreadable index', () => {
  let groupDir: string;

  beforeEach(() => {
    initLbugMock.mockReset();
    readRegistryMock.mockReset();
    readRegistryMock.mockResolvedValue(REGISTRY);
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-unreadable-'));
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('reports an unopenable index as unreadable, not missing', async () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));

    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), {
      skipWrite: true,
    });

    expect(result.unreadableRepos).toEqual(['app/backend']);
    // The repo IS registered — calling it "missing" sends the operator to
    // `gitnexus analyze` for a problem that indexing will not fix.
    expect(result.missingRepos).toEqual([]);
  });

  it('still reports a genuinely unregistered repo as missing', async () => {
    const result = await syncGroup(makeConfig({ 'app/ghost': 'not-in-registry' }), {
      skipWrite: true,
    });

    expect(result.missingRepos).toEqual(['app/ghost']);
    expect(result.unreadableRepos).toEqual([]);
  });

  it('logs the underlying load error, with the repo it belongs to', async () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));
    const cap = _captureLogger();

    try {
      await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { skipWrite: true });
    } finally {
      cap.restore();
    }

    // The whole point of the change is that this error reaches the operator.
    // Asserting only on `unreadableRepos` left both `logger.warn` calls
    // deletable with every test still green.
    const warnings = cap.records().filter((r) => r.level === 40);
    const loadFailure = warnings.find((r) => String(r.repo ?? '') === 'backend-repo');

    expect(loadFailure).toBeDefined();
    expect(String(loadFailure?.groupPath)).toBe('app/backend');
    expect(JSON.stringify(loadFailure?.err)).toContain('Current build storage version');
  });

  it('preserves the previous contracts and refreshes the diagnostics when nothing could be read', async () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));

    const contractsPath = path.join(groupDir, 'contracts.json');
    fs.writeFileSync(contractsPath, JSON.stringify(PRIOR_REGISTRY));

    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });

    expect(result.unreadableRepos).toEqual(['app/backend']);
    expect(result.registryOutcome).toBe('preserved');

    const onDisk = JSON.parse(fs.readFileSync(contractsPath, 'utf8')) as Record<string, unknown>;
    // The contracts are the previous run's and are kept verbatim — an
    // extraction that read nothing is not evidence that the group has none.
    expect(onDisk.contracts).toEqual(PRIOR_REGISTRY.contracts);
    expect(onDisk.crossLinks).toEqual(PRIOR_REGISTRY.crossLinks);
    // `generatedAt` dates the contracts, which did not change, so it does not
    // move either — otherwise `group status` would claim this run produced them.
    expect(onDisk.generatedAt).toBe(PRIOR_REGISTRY.generatedAt);
    // ...but the diagnostic describing THIS run is refreshed, which is what
    // makes `gitnexus group status` able to explain the failure afterwards.
    expect(onDisk.unreadableRepos).toEqual(['app/backend']);
  });

  it('writes nothing at all when there is no previous registry to preserve', async () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));

    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });

    // NOT `preserved`. Nothing exists to preserve, and the CLI turns that word
    // into "the contracts from the previous sync are preserved" — which sends
    // an operator whose group has never synced looking for a file that has
    // never existed. Same class of confident-wrong-answer as the rest of this.
    expect(result.registryOutcome).toBe('no-prior-registry');
    expect(fs.existsSync(path.join(groupDir, 'contracts.json'))).toBe(false);
  });

  it('reports `preserved` only when a prior registry was actually refreshed', async () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));
    fs.writeFileSync(path.join(groupDir, 'contracts.json'), JSON.stringify(PRIOR_REGISTRY));

    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });

    expect(result.registryOutcome).toBe('preserved');
  });

  it('does not report `preserved` when the prior registry will not parse', async () => {
    // An unparseable prior is not a thing that got carried forward either.
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));
    fs.writeFileSync(path.join(groupDir, 'contracts.json'), '{"truncated": ');

    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });

    expect(result.registryOutcome).toBe('no-prior-registry');
    // ...and the unparseable file is left exactly as it was, not replaced.
    expect(fs.readFileSync(path.join(groupDir, 'contracts.json'), 'utf8')).toBe('{"truncated": ');
  });

  it('still writes when only SOME configured repos are unreadable', async () => {
    // The case that pins the word "every" in `everyRepoFailed`. With a single
    // configured repo, "every repo failed" and "any repo failed" are the same
    // predicate, so the guard could be widened to abort on a single skewed repo
    // in a five-repo group — silently freezing contracts.json forever — with
    // nothing going red.
    initLbugMock.mockImplementation(failInitFor(new Set(['pool-backend-repo'])));

    const result = await syncGroup(
      makeConfig({ 'app/backend': 'backend-repo', 'app/web': 'web-repo' }),
      { groupDir, resolveRepoHandle: handleTable(['backend-repo', 'web-repo']) },
    );

    expect(result.unreadableRepos).toEqual(['app/backend']);
    expect(result.missingRepos).toEqual([]);
    expect(result.registryOutcome).toBe('written');

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(groupDir, 'contracts.json'), 'utf8'),
    ) as Record<string, unknown>;
    // The partial result records which repo is unaccounted for, so a reader of
    // contracts.json can tell a small registry from a complete one.
    expect(onDisk.unreadableRepos).toEqual(['app/backend']);
  });

  it('still writes when every repo is merely MISSING and none failed to load', async () => {
    // A group whose repos were all deregistered legitimately syncs to empty.
    // The guard must stay off here: it is gated on a load ERROR, not on an
    // empty result. Dropping the `unreadableRepos.length > 0` conjunct would
    // turn a deliberate deregistration into a registry frozen forever.
    const result = await syncGroup(
      makeConfig({ 'app/ghost': 'not-in-registry', 'app/phantom': 'also-absent' }),
      { groupDir },
    );

    expect(result.unreadableRepos).toEqual([]);
    expect(result.missingRepos).toEqual(['app/ghost', 'app/phantom']);
    expect(result.registryOutcome).toBe('written');
    expect(fs.existsSync(path.join(groupDir, 'contracts.json'))).toBe(true);
  });

  it('does not claim to preserve a file on a dry run', async () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));
    const cap = _captureLogger();

    let result;
    try {
      result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { skipWrite: true });
    } finally {
      cap.restore();
    }

    expect(result.registryOutcome).toBe('not-attempted');
    // The total-failure warning talks about an existing contracts.json. A
    // caller that asked not to write may not even have a group directory, so
    // telling it the file was left untouched describes a file that need not
    // exist.
    const preserveWarnings = cap
      .records()
      .filter((r) => String(r.msg ?? '').includes('previous sync'));
    expect(preserveWarnings).toEqual([]);
  });

  it('refuses to sync when the global registry cannot be read', async () => {
    // `readRegistry` swallows every failure and returns `[]`, so an EACCES or a
    // truncated registry.json presented as "no repo is registered": every
    // configured repo resolved to MISSING, the total-failure guard stayed off
    // (it needs a load error), and a good contracts.json was replaced by an
    // empty one at exit 0. That is an unreadable condition reported as missing,
    // one frame above the code this change fixes.
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    readRegistryMock.mockRejectedValue(eacces);

    const contractsPath = path.join(groupDir, 'contracts.json');
    fs.writeFileSync(contractsPath, JSON.stringify(PRIOR_REGISTRY));

    await expect(
      syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir }),
    ).rejects.toThrow('EACCES');

    expect(JSON.parse(fs.readFileSync(contractsPath, 'utf8'))).toEqual(PRIOR_REGISTRY);
  });
});
