import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { _captureLogger } from '../../../src/core/logger.js';
import type { BridgeHandle, GroupConfig, RepoHandle } from '../../../src/core/group/types.js';
import { BRIDGE_SCHEMA_VERSION } from '../../../src/core/group/bridge-schema.js';
import { makeGroupToolPort, writeGroupYaml } from './fixtures.js';

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
const readRegistryStrictMock = vi.fn();

/**
 * A SEPARATE mock from the strict one, and that separation is the whole point.
 *
 * Both exports used to resolve to one mock, so the refuses-to-sync case below —
 * which drives the read by rejecting — got the same rejection whichever export
 * `syncGroup` called. It would have passed identically against the lenient read
 * it exists to rule out, which is to say it measured nothing about which read is
 * used.
 *
 * The implementation here is the lenient export's real contract: `readRegistry`
 * swallows EACCES and a corrupt file alike and answers `[]`. Pointing
 * `syncGroup` at it therefore turns an unreadable registry back into "no repo is
 * registered" — every configured repo MISSING, the total-failure guard off, a
 * good contracts.json replaced by an empty one at exit 0 — and the case goes
 * red. On this path production reaches the lenient export only under
 * `detect.workspace_deps`, which `makeConfig` leaves off, so no other case in
 * this file can see the split.
 */
const readRegistryLenientMock = vi.fn(async (..._args: unknown[]): Promise<never[]> => []);

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: (...args: unknown[]) => initLbugMock(...args),
  executeParameterized: vi.fn(async () => []),
  pinRepo: vi.fn(() => () => {}),
  getMaxResidentRepos: vi.fn(() => 5),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  readRegistry: (...args: unknown[]) => readRegistryLenientMock(...args),
  readRegistryStrict: (...args: unknown[]) => readRegistryStrictMock(...args),
}));

/**
 * Armed by the bridge-write-failure suite at the bottom of this file, `null`
 * everywhere else. There is no filesystem shape that makes the real writer fail
 * while `writeContractRegistry` — same directory, one line earlier in
 * `syncGroup` — still succeeds, and that ordering is the whole subject of the
 * warning under test.
 */
let writeBridgeFailure: Error | null = null;

/**
 * Only the read-only OPEN legs are stubbed, so `runGroupImpact` can read the
 * metadata a preserve sync just wrote without a native LadybugDB open of a
 * placeholder file. The bridge write, `writeBridgeMeta`, `readBridgeMeta` and
 * `bridgeMetaMatchesFile` all travel their real implementations — they are the
 * code under test here, and `syncGroup` reaches the bridge write through this
 * module too. The wrapper below is a pass-through in every test that does not
 * arm `writeBridgeFailure`.
 *
 * It intercepts `writeBridgeUnlocked`, NOT the exported `writeBridge`: the swap
 * comes in two halves, and `syncGroup` calls the lock-free one because it is
 * already inside `withGroupSyncLock` (a second acquisition of a non-reentrant
 * lock would hang every sync). Arming the acquiring wrapper instead would inject
 * a fault into a function this path never calls, and the failure branch below
 * would go quietly untested.
 */
vi.mock('../../../src/core/group/bridge-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/group/bridge-db.js')>();
  return {
    ...actual,
    writeBridgeUnlocked: vi.fn(async (...args: Parameters<typeof actual.writeBridgeUnlocked>) => {
      if (writeBridgeFailure) throw writeBridgeFailure;
      return actual.writeBridgeUnlocked(...args);
    }),
    getCachedBridgeReadOnly: vi.fn(
      async (groupDir: string) =>
        ({ _db: {}, _conn: {}, groupDir, _readOnly: true }) as BridgeHandle,
    ),
    queryBridge: vi.fn(async () => [] as Array<Record<string, unknown>>),
    closeBridgeDb: vi.fn(async () => undefined),
  };
});

/**
 * Armed by the concurrent-sync suite at the bottom of this file, `null`
 * everywhere else. It runs INSIDE the real group sync lock — after this sync
 * acquired it, before its persist section starts — which is the one window in
 * which another sync's write can land: extraction runs OUTSIDE the lock, so a
 * sync that queued behind a winner is holding stats it took before the winner
 * ever wrote. Nothing in-process can reach that window otherwise, and a rare
 * interleave is not a test.
 */
let whileWaitingForTheGroupLock: (() => Promise<void>) | null = null;

/**
 * A pass-through in every test that does not arm the hook: the REAL lock is
 * acquired, on the real `<groupDir>/sync-lock`, exactly as production does.
 */
vi.mock('../../../src/core/group/group-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/group/group-lock.js')>();
  return {
    ...actual,
    withGroupSyncLock: <T>(groupDir: string, operation: () => Promise<T>): Promise<T> =>
      actual.withGroupSyncLock(groupDir, async () => {
        const hook = whileWaitingForTheGroupLock;
        whileWaitingForTheGroupLock = null;
        if (hook) await hook();
        return operation();
      }),
  };
});

const { syncGroup } = await import('../../../src/core/group/sync.js');
const { runGroupImpact } = await import('../../../src/core/group/cross-impact.js');
const { bridgeMetaMatchesFile, closeAllCachedBridges, readBridgeMeta, writeBridgeMeta } =
  await import('../../../src/core/group/bridge-db.js');

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

/**
 * The one warning that describes the RUN rather than a single repo: it is the
 * only record carrying the whole-run repo lists. The per-repo load failures
 * logged beside it carry `repo` / `groupPath` instead, so selecting on the list
 * field cannot pick one of those up by accident.
 */
const totalFailureWarning = (cap: ReturnType<typeof _captureLogger>) =>
  cap.records().find((r) => r.level === 40 && Array.isArray(r.unreadableRepos));

describe('syncGroup with an unreadable index', () => {
  let groupDir: string;

  beforeEach(() => {
    initLbugMock.mockReset();
    readRegistryStrictMock.mockReset();
    readRegistryStrictMock.mockResolvedValue(REGISTRY);
    // `mockClear`, not `mockReset`: the lenient answer IS its implementation
    // (see its declaration), so resetting would erase the very behaviour that
    // makes calling it distinguishable from calling the strict one.
    readRegistryLenientMock.mockClear();
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

  it('names the previous sync in the total-failure warning when a prior registry was kept', async () => {
    // This warning used to be emitted BEFORE the prior registry was resolved,
    // so it promised "the contracts from the previous sync" without knowing
    // whether there were any. This is the branch on which that promise is true.
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));
    fs.writeFileSync(path.join(groupDir, 'contracts.json'), JSON.stringify(PRIOR_REGISTRY));
    const cap = _captureLogger();

    let result;
    try {
      result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });
    } finally {
      cap.restore();
    }

    const warning = totalFailureWarning(cap);
    expect(warning).toBeDefined();
    // The log and the console say the same thing about which of the two
    // happened: the CLI picks its sentence from `registryOutcome`, and this is
    // the outcome whose sentence keeps the previous contracts.
    expect(result.registryOutcome).toBe('preserved');
    expect(String(warning?.msg)).toContain('previous sync');
    // Still a warning, still carrying the lists that name the cause.
    expect(warning?.level).toBe(40);
    expect(warning?.unreadableRepos).toEqual(['app/backend']);
    expect(warning?.missingRepos).toEqual([]);
  });

  it('does not claim anything was preserved when there is no prior registry', async () => {
    // The same total failure with nothing on disk to preserve. The warning said
    // the contracts from the previous sync were being kept — to an operator
    // whose group has never synced, about a file that has never existed, while
    // the console line for this same run says the opposite. What the message
    // says about disk has to be what happened on it.
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));
    const cap = _captureLogger();

    let result;
    try {
      result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });
    } finally {
      cap.restore();
    }

    const warning = totalFailureWarning(cap);
    expect(warning).toBeDefined();
    expect(result.registryOutcome).toBe('no-prior-registry');
    expect(String(warning?.msg)).not.toMatch(/previous sync|preserv|keeping|kept/i);
    expect(String(warning?.msg)).toContain('no previous contracts.json');
    // ...and it is still a warning carrying the same lists as the branch above.
    expect(warning?.level).toBe(40);
    expect(warning?.unreadableRepos).toEqual(['app/backend']);
    expect(warning?.missingRepos).toEqual([]);
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

  it('records an empty unreadable list on a clean sync, not an absent one', async () => {
    // `[]` is a measurement — "this sync accounted for every repo" — and it is
    // a different claim from a registry that never recorded the field. Omitting
    // the empty case made that state unreachable: every clean sync wrote a
    // registry whose `unreadableRepos` was absent, so `gitnexus group status`
    // reported it as not recorded and told the operator to re-run the sync that
    // had just succeeded.
    const result = await syncGroup(
      makeConfig({ 'app/backend': 'backend-repo', 'app/web': 'web-repo' }),
      { groupDir, resolveRepoHandle: handleTable(['backend-repo', 'web-repo']) },
    );

    expect(result.unreadableRepos).toEqual([]);
    expect(result.registryOutcome).toBe('written');

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(groupDir, 'contracts.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk).toHaveProperty('unreadableRepos');
    expect(onDisk.unreadableRepos).toEqual([]);
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
    // Selected on the sentence both total-failure messages share, so this stays
    // decisive whichever of the two the persisting path would have emitted.
    const totalFailureWarnings = cap
      .records()
      .filter((r) => String(r.msg ?? '').includes('No repo in this group could be read'));
    expect(totalFailureWarnings).toEqual([]);
  });

  it('refuses to sync when the global registry cannot be read', async () => {
    // `readRegistry` swallows every failure and returns `[]`, so an EACCES or a
    // truncated registry.json presented as "no repo is registered": every
    // configured repo resolved to MISSING, the total-failure guard stayed off
    // (it needs a load error), and a good contracts.json was replaced by an
    // empty one at exit 0. That is an unreadable condition reported as missing,
    // one frame above the code this change fixes.
    //
    // Only the STRICT export is armed to reject. The lenient one is a separate
    // mock answering `[]` — production's own lenient behaviour — so a `syncGroup`
    // reading through it never sees this failure at all: it would sync a group
    // whose every repo is "unregistered" and overwrite the prior registry, which
    // is what makes each of the three assertions below a statement about which
    // read was used rather than about EACCES.
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    readRegistryStrictMock.mockRejectedValue(eacces);

    const contractsPath = path.join(groupDir, 'contracts.json');
    fs.writeFileSync(contractsPath, JSON.stringify(PRIOR_REGISTRY));

    await expect(
      syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir }),
    ).rejects.toThrow('EACCES');

    expect(JSON.parse(fs.readFileSync(contractsPath, 'utf8'))).toEqual(PRIOR_REGISTRY);
    // The direct form of the same claim, so a regression names itself instead of
    // arriving as "expected a rejection, got a resolved sync".
    expect(readRegistryLenientMock).not.toHaveBeenCalled();
    expect(readRegistryStrictMock).toHaveBeenCalled();
  });
});

/**
 * The preserve path rewrites `contracts.json` and deliberately does NOT rebuild
 * `bridge.lbug` — the contracts that bridge holds are the ones being preserved,
 * so rebuilding it from an extraction that read nothing is the one write that
 * could lose them.
 *
 * But `meta.json`, not `contracts.json`, is where `runGroupImpact` reads
 * completeness from. Leaving it alone therefore left the two files telling
 * different stories: `contracts.json` said "this sync could not read app/backend"
 * while a cross-repo query, reading the previous sync's metadata, answered
 * `{ cross: [], truncated: false }` — fully accounted for. That is a confident
 * wrong answer about the exact thing the completeness channel exists to make
 * legible, and it is what R6 forbids.
 *
 * Refreshing the metadata is not free, though, and the naive version of it is
 * worse than the bug. This file rewrites `meta.json` ATOMICALLY, so its mtime
 * becomes now while `bridge.lbug`'s stays old — which is precisely the shape
 * the unstamped write-order rule ACCEPTS. A refresh that just carried the old
 * fields forward would therefore LAUNDER a pair that was already broken into
 * one that passes `bridgeMetaMatchesFile`. Hence the explicit marker, and hence
 * the cases below that pin a broken pair as still broken afterwards.
 */
describe('the preserve path and the bridge metadata beside it', () => {
  let home: string;
  let groupDir: string;
  let dbPath: string;
  let metaPath: string;

  /** Fixed, whole-second instants — exactly representable on any filesystem. */
  const WRITTEN_AT = new Date('2026-01-01T00:00:00.000Z');
  const TEN_SECONDS_LATER = new Date('2026-01-01T00:00:10.000Z');
  const PRIOR_META_GENERATED_AT = '2026-01-01T00:00:00.000Z';

  beforeEach(async () => {
    initLbugMock.mockReset();
    readRegistryStrictMock.mockReset();
    readRegistryStrictMock.mockResolvedValue(REGISTRY);
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-preserve-bridge-'));
    groupDir = path.join(home, 'groups', 'waveful');
    dbPath = path.join(groupDir, 'bridge.lbug');
    metaPath = path.join(groupDir, 'meta.json');
    await writeGroupYaml(groupDir, ['app/backend']);
  });

  afterEach(async () => {
    await closeAllCachedBridges();
    await fsp.rm(home, { recursive: true, force: true });
  });

  const seedPriorRegistry = (): Promise<void> =>
    fsp.writeFile(path.join(groupDir, 'contracts.json'), JSON.stringify(PRIOR_REGISTRY));

  /** A stamped pair that matches: what a successful `writeBridge` leaves behind. */
  const seedMatchingPair = async (): Promise<void> => {
    await fsp.writeFile(dbPath, 'the previous sync database');
    const stat = await fsp.stat(dbPath);
    await writeBridgeMeta(groupDir, {
      version: BRIDGE_SCHEMA_VERSION,
      generatedAt: PRIOR_META_GENERATED_AT,
      bridgeSize: stat.size,
      bridgeMtimeMs: stat.mtimeMs,
      missingRepos: [],
      unreadableRepos: [],
    });
  };

  /**
   * The legacy shape, broken: metadata with no stamp sitting beside a database
   * that was replaced after it. `unstampedMetaPairsByWriteOrder` is the ONLY
   * thing that can see this, and it sees it purely through the two file times —
   * which is why an atomic rewrite of `meta.json` erases the evidence.
   */
  const seedUnstampedPairWithNewerDatabase = async (): Promise<void> => {
    await fsp.writeFile(dbPath, 'a database swapped in after the metadata');
    await writeBridgeMeta(groupDir, {
      version: BRIDGE_SCHEMA_VERSION,
      generatedAt: PRIOR_META_GENERATED_AT,
      missingRepos: [],
      unreadableRepos: [],
    });
    await fsp.utimes(metaPath, WRITTEN_AT, WRITTEN_AT);
    await fsp.utimes(dbPath, TEN_SECONDS_LATER, TEN_SECONDS_LATER);
  };

  const runTotalFailureSync = () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));
    return syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });
  };

  const runSuccessfulSync = () => {
    initLbugMock.mockReset();
    return syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), {
      groupDir,
      resolveRepoHandle: handleTable(['backend-repo']),
    });
  };

  const runImpact = () =>
    runGroupImpact(
      { port: makeGroupToolPort(home), gitnexusDir: home },
      { name: 'waveful', repo: 'app/backend', target: 'publish', direction: 'upstream' },
    );

  const pairsAfterwards = async (): Promise<boolean> =>
    bridgeMetaMatchesFile(groupDir, await readBridgeMeta(groupDir));

  it('reports the repos this sync could not read as a lower bound on the next cross-repo query', async () => {
    // The headline case, and the one that makes `contracts.json` and `group
    // impact` describe the same set of unaccounted repos. Every other signal
    // says "complete": the local walk finished, the bridge returned no
    // crossings, no cap and no clock fired.
    await seedPriorRegistry();
    await seedMatchingPair();

    const result = await runTotalFailureSync();
    expect(result.registryOutcome).toBe('preserved');

    const impact = await runImpact();

    expect(impact).toMatchObject({
      cross: [],
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
      truncatedRepos: ['app/backend'],
    });
  });

  it('leaves the bridge database itself byte-for-byte untouched', async () => {
    // The contracts this bridge holds are the ones being preserved. A refresh
    // that rebuilt it would be the single write capable of losing them.
    await seedPriorRegistry();
    await seedMatchingPair();
    const before = await fsp.readFile(dbPath);
    const beforeStat = await fsp.stat(dbPath);

    await runTotalFailureSync();

    expect(await fsp.readFile(dbPath)).toEqual(before);
    const afterStat = await fsp.stat(dbPath);
    expect(afterStat.size).toBe(beforeStat.size);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('keeps a stamped pair that already failed the check failing, with its stamp untouched', async () => {
    // Re-stamping here would MANUFACTURE provenance: it would declare that this
    // metadata describes the database beside it, which is the one thing the
    // failed check just said is not known. The stamp fields are carried through
    // verbatim instead — dropping them would leave an unstamped file whose
    // freshly-moved mtime the write-order rule then accepts.
    await seedPriorRegistry();
    await fsp.writeFile(dbPath, 'a database this metadata was never written for');
    await writeBridgeMeta(groupDir, {
      version: BRIDGE_SCHEMA_VERSION,
      generatedAt: PRIOR_META_GENERATED_AT,
      bridgeSize: 999_999,
      bridgeMtimeMs: 1_700_000_000_000,
      missingRepos: [],
      unreadableRepos: [],
    });
    expect(await pairsAfterwards()).toBe(false);

    await runTotalFailureSync();

    const after = await readBridgeMeta(groupDir);
    expect(after.bridgeSize).toBe(999_999);
    expect(after.bridgeMtimeMs).toBe(1_700_000_000_000);
    expect(after.provenanceUnknown).toBe(true);
    expect(after.unreadableRepos).toEqual(['app/backend']);
    expect(await pairsAfterwards()).toBe(false);
  });

  it('keeps an unstamped pair that already failed the check failing, though the rewrite moves meta.json to now', async () => {
    // The laundering case, and the only shape that exercises the write-order
    // rule. Before the sync the database is NEWER than the metadata beside it,
    // which is the inverted write order that rule rejects. The atomic rewrite
    // then makes `meta.json` the newer file — the exact shape it ACCEPTS — so
    // without an explicit marker a preserve sync would hand back "verified" for
    // a pair it just found broken.
    await seedPriorRegistry();
    await seedUnstampedPairWithNewerDatabase();
    expect(await pairsAfterwards()).toBe(false);

    await runTotalFailureSync();

    const dbStat = await fsp.stat(dbPath);
    const metaStat = await fsp.stat(metaPath);
    // The evidence the write-order rule reads has genuinely been inverted...
    expect(metaStat.mtimeMs).toBeGreaterThanOrEqual(dbStat.mtimeMs);
    const after = await readBridgeMeta(groupDir);
    // ...no stamp was invented to replace it...
    expect(after.bridgeSize).toBeUndefined();
    expect(after.bridgeMtimeMs).toBeUndefined();
    // ...and the verdict survives in the metadata, which is the only place it
    // can, because the refresh cannot avoid moving the mtime.
    expect(after.provenanceUnknown).toBe(true);
    expect(await pairsAfterwards()).toBe(false);

    const impact = await runImpact();
    expect(impact).toMatchObject({
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
  });

  it('never writes either reader-side field back into meta.json', async () => {
    // `repoListsUnreadable` and `pairedWithDatabase` are things a READER
    // computes ABOUT a file; both are documented NEVER PERSISTED. This path is
    // the first code to read metadata and write it back, so a naive
    // `writeBridgeMeta(await readBridgeMeta(dir))` persists whichever of them
    // the read produced. A stale `pairedWithDatabase: true` on disk is actively
    // poisonous: it tells every future reader the pair was verified.
    await seedPriorRegistry();
    await fsp.writeFile(dbPath, 'db');
    await fsp.writeFile(
      metaPath,
      JSON.stringify({
        version: BRIDGE_SCHEMA_VERSION,
        generatedAt: PRIOR_META_GENERATED_AT,
        // Not a list of repo paths, so `readBridgeMeta` answers with
        // `repoListsUnreadable: true` on the object this path then rewrites.
        missingRepos: { 'app/backend': true },
        // A foreign writer, a hand-edit, or an earlier naive round-trip.
        pairedWithDatabase: true,
      }),
    );

    await runTotalFailureSync();

    const raw = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('pairedWithDatabase');
    expect(raw).not.toHaveProperty('repoListsUnreadable');
    // ...and the unusable list was replaced by this run's real measurement,
    // rather than being carried forward as garbage.
    expect(raw.missingRepos).toEqual([]);
    expect(raw.unreadableRepos).toEqual(['app/backend']);
  });

  it('completes when there is no bridge.lbug for the metadata to describe', async () => {
    // `writeBridge` can leave this behind: the old database is renamed aside
    // and the new one never arrives. The refresh must not stat a file that is
    // not there, and must not vouch for one either.
    await seedPriorRegistry();
    await writeBridgeMeta(groupDir, {
      version: BRIDGE_SCHEMA_VERSION,
      generatedAt: PRIOR_META_GENERATED_AT,
      bridgeSize: 4096,
      bridgeMtimeMs: 1_700_000_000_000,
      missingRepos: [],
      unreadableRepos: [],
    });

    const result = await runTotalFailureSync();

    expect(result.registryOutcome).toBe('preserved');
    expect(fs.existsSync(dbPath)).toBe(false);
    const after = await readBridgeMeta(groupDir);
    expect(after.provenanceUnknown).toBe(true);
    // Carried through verbatim: the stamp still records which database this
    // metadata was written for, which is information, not a claim about what
    // is on disk now.
    expect(after.bridgeSize).toBe(4096);
    expect(after.bridgeMtimeMs).toBe(1_700_000_000_000);
    expect(after.unreadableRepos).toEqual(['app/backend']);

    // The query that follows answers rather than throwing. With no database
    // there is nothing to answer FROM, so it names the missing file and sends
    // the operator to `group sync` — never a confident "nothing depends on
    // this". (The lower-bound answer is the shape above, where a database IS
    // present and the marker is what stops it being trusted.)
    const impact = await runImpact();
    expect(impact).toMatchObject({ error: expect.stringContaining('No bridge.lbug') });
  });

  it('does not manufacture metadata for a bridge that has never existed', async () => {
    // Neither file is on disk, so there is no pair that could disagree with
    // anything and nothing to keep honest. `readBridgeMeta` already answers
    // `version: 0` — provenance unknown — for an absent file, and writing a
    // `version: 0` file that says the same thing only invents state.
    await seedPriorRegistry();

    await runTotalFailureSync();

    expect(fs.existsSync(metaPath)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('records this run against a database whose metadata is missing entirely', async () => {
    // The other half of the pair being absent. The database is real and the
    // metadata is gone — provenance is already unknown, and staying silent
    // costs the operator the NAMES of the repos this run could not read.
    await seedPriorRegistry();
    await fsp.writeFile(dbPath, 'a database with no metadata beside it');

    await runTotalFailureSync();

    const after = await readBridgeMeta(groupDir);
    expect(after.provenanceUnknown).toBe(true);
    expect(after.unreadableRepos).toEqual(['app/backend']);
    expect(await pairsAfterwards()).toBe(false);
  });

  it('does not launder the pair it already marked on a second preserve run', async () => {
    // The invariant in its strongest form: no preserve run ever increases the
    // number of pairs that pass the check. The second run reads metadata that
    // now carries the marker, and the marker has to survive its own rewrite.
    await seedPriorRegistry();
    await seedUnstampedPairWithNewerDatabase();

    await runTotalFailureSync();
    expect(await pairsAfterwards()).toBe(false);

    await runTotalFailureSync();

    const after = await readBridgeMeta(groupDir);
    expect(after.provenanceUnknown).toBe(true);
    expect(await pairsAfterwards()).toBe(false);
  });

  it('clears the marker on the next successful sync', async () => {
    // Nothing clears the marker deliberately: a successful `writeBridge`
    // builds fresh metadata from a literal and simply never sets the field.
    // That is what keeps a marked bridge from being marked forever.
    await seedPriorRegistry();
    await seedUnstampedPairWithNewerDatabase();
    await runTotalFailureSync();
    expect((await readBridgeMeta(groupDir)).provenanceUnknown).toBe(true);

    const ok = await runSuccessfulSync();

    expect(ok.registryOutcome).toBe('written');
    const after = await readBridgeMeta(groupDir);
    expect(after.provenanceUnknown).toBeUndefined();
    expect(await pairsAfterwards()).toBe(true);
  });

  it('control: a successful sync writes a pair that passes the check, unmarked', async () => {
    // Without this, "the marker is absent after a good sync" could be true
    // because the marker is absent from everything.
    const ok = await runSuccessfulSync();

    expect(ok.registryOutcome).toBe('written');
    const after = await readBridgeMeta(groupDir);
    expect(after.provenanceUnknown).toBeUndefined();
    expect(after.unreadableRepos).toEqual([]);
    expect(await pairsAfterwards()).toBe(true);
  });
});

/**
 * The branch taken when `writeBridge` throws. `contracts.json` has already been
 * written and is canonical by then, so the failure is a recoverable degradation
 * — and the warning is the ONLY thing this branch produces. The return value,
 * `registryOutcome` and every file on disk are identical whether the sentence
 * is true or not, which is why the text needs an assertion of its own instead of
 * borrowing a state assertion from elsewhere in this file.
 */
describe('the warning after a failed bridge write', () => {
  let groupDir: string;

  beforeEach(() => {
    initLbugMock.mockReset();
    readRegistryStrictMock.mockReset();
    readRegistryStrictMock.mockResolvedValue(REGISTRY);
    writeBridgeFailure = null;
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-bridge-write-'));
  });

  afterEach(async () => {
    writeBridgeFailure = null;
    await closeAllCachedBridges();
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  const runSync = () =>
    syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), {
      groupDir,
      resolveRepoHandle: handleTable(['backend-repo']),
    });

  /** The bridge-failure warning is the only record carrying `groupDir`. */
  const bridgeWarning = (cap: ReturnType<typeof _captureLogger>) =>
    cap.records().find((r) => r.level === 40 && typeof r.groupDir === 'string');

  it('names the registry as intact and does not promise a truncation this branch never reports', async () => {
    writeBridgeFailure = new Error('ENOSPC: no space left on device');
    const cap = _captureLogger();

    let result;
    try {
      result = await runSync();
    } finally {
      cap.restore();
    }

    // The registry write happens before the bridge write and is not rolled back
    // — the reason this failure is survivable at all.
    expect(result.registryOutcome).toBe('written');

    const warning = bridgeWarning(cap);
    expect(warning).toBeDefined();
    expect(String(warning?.msg)).toContain('contracts.json is intact');
    // The claim the code does not keep. A failed `writeBridge` leaves the
    // PREVIOUS sync's database and the metadata stamped for it untouched, so the
    // next cross-repo query reads a pair that checks out, finds no unreadable
    // repos recorded in it, and answers `truncated: false` — from contracts this
    // sync has already superseded. Nothing on this branch marks the bridge at
    // all, so telling the operator to wait for `truncated` is telling them to
    // wait for a signal that is never coming.
    expect(String(warning?.msg)).not.toMatch(/truncat/i);
    // What the code does guarantee instead: the registry is the good copy, the
    // bridge may still answer from the previous sync, and only another sync
    // replaces it.
    expect(String(warning?.msg)).toMatch(/previous sync/i);
    expect(String(warning?.msg)).toContain('group sync');
    // ...and the underlying failure still reaches the operator.
    expect(String(warning?.err)).toContain('ENOSPC');
  });

  it('control: a sync whose bridge write succeeds emits no such warning', async () => {
    // Without this, "the warning does not promise a truncation" could be true
    // because no warning is emitted on any run at all.
    const cap = _captureLogger();

    let result;
    try {
      result = await runSync();
    } finally {
      cap.restore();
    }

    expect(result.registryOutcome).toBe('written');
    expect(bridgeWarning(cap)).toBeUndefined();
  });
});

/**
 * R9, the half a lock does not fix: serializing is not ordering.
 *
 * Both syncs run EXTRACTION outside the lock and only the persist section
 * inside it, so a total-failure sync that queues behind a healthy one arrives at
 * the critical section holding a snapshot of a group it read minutes ago. The
 * preserve path then re-reads `contracts.json` as `prior` — and the file it
 * finds is the winner's, written while this run waited — and stamps its own
 * all-unreadable lists over it. That is not a rare interleave: it is what
 * happens every time the total-failure sync loses the race, and it downgrades a
 * registry that describes repos that were readable seconds earlier.
 *
 * The guard is a compare-and-swap on the prior file's own identity: stat it
 * BEFORE acquiring, re-stat AFTER, and skip the diagnostic refresh when the two
 * differ. Keyed on the file, not on `generatedAt`: that field is stamped when
 * the registry object is built (before the lock), so a winner that waited writes
 * one OLDER than the loser's start, and the preserve path carries it forward
 * verbatim by design — after any preserve sync it does not date the write at
 * all. File identity also needs no cross-process clock agreement and has no
 * undefined case for an absent or unparseable timestamp.
 */
describe('a total-failure sync that reaches the group lock second', () => {
  let groupDir: string;
  let contractsPath: string;
  let dbPath: string;
  let metaPath: string;

  /** What the sync that won the lock wrote while this one was still waiting. */
  const WINNER_REGISTRY = {
    version: 1,
    generatedAt: '2026-02-02T00:00:00.000Z',
    repoSnapshots: {},
    missingRepos: [],
    unreadableRepos: [],
    contracts: [{ contractId: 'http::GET::/api/users' }, { contractId: 'http::POST::/api/users' }],
    crossLinks: [{ contractId: 'http::GET::/api/users' }],
  };

  beforeEach(() => {
    initLbugMock.mockReset();
    readRegistryStrictMock.mockReset();
    readRegistryStrictMock.mockResolvedValue(REGISTRY);
    whileWaitingForTheGroupLock = null;
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-second-'));
    contractsPath = path.join(groupDir, 'contracts.json');
    dbPath = path.join(groupDir, 'bridge.lbug');
    metaPath = path.join(groupDir, 'meta.json');
  });

  afterEach(async () => {
    whileWaitingForTheGroupLock = null;
    await closeAllCachedBridges();
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  const runTotalFailureSync = () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));
    return syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });
  };

  const seedPriorRegistry = (): void =>
    fs.writeFileSync(contractsPath, JSON.stringify(PRIOR_REGISTRY));

  /** The winner's write, landing while this sync waits on the lock. */
  const winnerWritesTheRegistry = async (): Promise<void> => {
    fs.writeFileSync(contractsPath, JSON.stringify(WINNER_REGISTRY));
  };

  const readOnDisk = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(contractsPath, 'utf8')) as Record<string, unknown>;

  it('leaves the registry the winning sync wrote exactly as it found it, and reports preserved', async () => {
    seedPriorRegistry();
    whileWaitingForTheGroupLock = winnerWritesTheRegistry;

    const result = await runTotalFailureSync();

    // Byte-identical to what the winner wrote. NOT the winner's contracts with
    // this run's all-unreadable list stamped over them, which is what re-reading
    // `prior` inside the lock produces — a registry that says every repo in the
    // group is unreadable, written on top of a sync that had just read them.
    expect(fs.readFileSync(contractsPath, 'utf8')).toBe(JSON.stringify(WINNER_REGISTRY));
    expect(readOnDisk().unreadableRepos).toEqual([]);
    // The existing outcome, not a new one: nothing was written and a prior
    // registry was kept, which is exactly what `preserved` already means. A new
    // value would fall through `cli/group.ts`'s outcome chain, which has no
    // fallback branch, and falsify the guard asserting the sync tool's
    // description names every reachable outcome.
    expect(result.registryOutcome).toBe('preserved');
    // ...and the caller still learns what THIS run could not read.
    expect(result.unreadableRepos).toEqual(['app/backend']);
  });

  it('treats a registry that was absent before the lock and present after as changed', async () => {
    // No prior file at all when this sync stat'd: on its own reading it was
    // heading for `no-prior-registry` (write nothing), and then found a registry
    // to "refresh" — one belonging to a sync it never overlapped in extraction.
    whileWaitingForTheGroupLock = winnerWritesTheRegistry;

    const result = await runTotalFailureSync();

    expect(fs.readFileSync(contractsPath, 'utf8')).toBe(JSON.stringify(WINNER_REGISTRY));
    expect(readOnDisk().unreadableRepos).toEqual([]);
    expect(result.registryOutcome).toBe('preserved');
  });

  it('does not stamp this run into the bridge metadata beside the registry it skipped', async () => {
    // `meta.json` is where `runGroupImpact` reads completeness from, so writing
    // this run's lists there is the same downgrade one file over: it would
    // report repos as unaccounted for that the winning sync had just accounted
    // for. The refresh describes THIS run, and on this path this run is the
    // stale one — and `refreshPreservedBridgeMeta` moves meta.json's mtime and
    // can mark a pair `provenanceUnknown`, so it can only degrade a pair the
    // winner left consistent. Nothing is written, which is what makes
    // `preserved` an honest answer here.
    fs.writeFileSync(dbPath, 'the winning sync database');
    const dbStat = fs.statSync(dbPath);
    await writeBridgeMeta(groupDir, {
      version: BRIDGE_SCHEMA_VERSION,
      generatedAt: '2026-02-02T00:00:00.000Z',
      bridgeSize: dbStat.size,
      bridgeMtimeMs: dbStat.mtimeMs,
      missingRepos: [],
      unreadableRepos: [],
    });
    const metaBefore = fs.readFileSync(metaPath, 'utf8');
    const metaStatBefore = fs.statSync(metaPath);
    seedPriorRegistry();
    whileWaitingForTheGroupLock = winnerWritesTheRegistry;

    await runTotalFailureSync();

    expect(fs.readFileSync(metaPath, 'utf8')).toBe(metaBefore);
    expect(fs.statSync(metaPath).mtimeMs).toBe(metaStatBefore.mtimeMs);
    const meta = await readBridgeMeta(groupDir);
    expect(meta.unreadableRepos).toEqual([]);
    expect(meta.provenanceUnknown).toBeUndefined();
  });

  it('refreshes as usual when it is the sync that got to the lock first', async () => {
    // The same interleaving in the other order: the other sync is still
    // extracting and has written nothing, so this run's stats match across the
    // acquisition and the diagnostic refresh — the entire point of the preserve
    // path — must still happen. A guard that fired on "a second sync exists"
    // rather than on "the file changed" would freeze the diagnostics of every
    // contended group.
    seedPriorRegistry();
    let otherSyncStillExtracting = false;
    whileWaitingForTheGroupLock = async () => {
      otherSyncStillExtracting = true;
    };

    const result = await runTotalFailureSync();

    expect(otherSyncStillExtracting).toBe(true);
    expect(result.registryOutcome).toBe('preserved');
    const onDisk = readOnDisk();
    expect(onDisk.contracts).toEqual(PRIOR_REGISTRY.contracts);
    expect(onDisk.unreadableRepos).toEqual(['app/backend']);
  });

  it('control: an uncontended sync sees identical stats and refreshes as usual', async () => {
    // Nothing armed at all, so the compare-and-swap runs over a file no one
    // else touched. Without this, every assertion above could be satisfied by a
    // guard that skipped the refresh on every run.
    seedPriorRegistry();

    const result = await runTotalFailureSync();

    expect(result.registryOutcome).toBe('preserved');
    const onDisk = readOnDisk();
    expect(onDisk.contracts).toEqual(PRIOR_REGISTRY.contracts);
    expect(onDisk.unreadableRepos).toEqual(['app/backend']);
  });
});
