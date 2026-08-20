import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GroupConfig } from '../../../src/core/group/types.js';

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
 */

const LBUG_VERSION_ERROR =
  'LadybugDB unavailable for backend-repo. Another process may be rebuilding the index. ' +
  'Retry later. (Runtime exception: Trying to read a database file with a different version. ' +
  'Database file version: 43, Current build storage version: 40)';

const initLbugMock = vi.fn();

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: (...args: unknown[]) => initLbugMock(...args),
  executeParameterized: vi.fn(async () => []),
  pinRepo: vi.fn(() => () => {}),
  getMaxResidentRepos: vi.fn(() => 5),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  readRegistry: vi.fn(async () => [
    {
      name: 'backend-repo',
      path: '/repos/backend',
      storagePath: '/repos/backend/.gitnexus',
      indexedAt: '2026-01-01T00:00:00.000Z',
      lastCommit: 'abc123',
    },
  ]),
}));

const { syncGroup } = await import('../../../src/core/group/sync.js');

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
    workspace_deps: false,
  },
  matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
});

describe('syncGroup with an unreadable index', () => {
  let groupDir: string;

  beforeEach(() => {
    initLbugMock.mockReset();
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

  it('does not overwrite an existing contracts.json when no repo could be read', async () => {
    initLbugMock.mockRejectedValue(new Error(LBUG_VERSION_ERROR));

    const contractsPath = path.join(groupDir, 'contracts.json');
    const priorRegistry = JSON.stringify({
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      repoSnapshots: {},
      missingRepos: [],
      contracts: [{ contractId: 'http::GET::/api/users' }],
      crossLinks: [],
    });
    fs.writeFileSync(contractsPath, priorRegistry);

    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), { groupDir });

    expect(result.unreadableRepos).toEqual(['app/backend']);
    // The prior registry is intact — an extraction that read nothing is not
    // evidence that the group has no contracts.
    expect(fs.readFileSync(contractsPath, 'utf8')).toBe(priorRegistry);
  });

  it('writes normally when at least one repo was readable', async () => {
    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), {
      groupDir,
      extractorOverride: async () => [],
    });

    expect(result.unreadableRepos).toEqual([]);
    expect(fs.existsSync(path.join(groupDir, 'contracts.json'))).toBe(true);
  });
});
