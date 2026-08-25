import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ExtractedContract, GroupConfig, RepoHandle } from '../../../src/core/group/types.js';

/**
 * Per-repo extraction is all-or-nothing.
 *
 * `syncGroup` runs each enabled extractor for a repo in sequence and any one of
 * them can throw. Appending results to the shared `autoContracts` as they were
 * produced meant a repo whose HTTP extractor succeeded and whose gRPC extractor
 * then failed contributed a partial set to contracts.json — while the catch that
 * caught the failure told the operator that repo's "contracts are omitted from
 * this sync", and `group sync` printed the same. The persisted registry held an
 * undocumented partial view of a repo that the diagnostics described as absent.
 *
 * Nothing about the earlier extractor's output is wrong in isolation. What makes
 * it unusable is that no reader can tell which repos are complete: a contract
 * that is silently absent reads exactly like a contract that does not exist.
 */

const PARTIAL_CONTRACT: ExtractedContract = {
  contractId: 'http::GET::/api/users',
  type: 'http',
  role: 'provider',
  symbolUid: 'Function:src/users.ts:listUsers',
  symbolRef: { filePath: 'src/users.ts', name: 'listUsers' },
  symbolName: 'listUsers',
  confidence: 1,
  meta: {},
};

const httpExtract = vi.fn();
const grpcExtract = vi.fn();

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(async () => {}),
  executeParameterized: vi.fn(async () => []),
  pinRepo: vi.fn(() => () => {}),
  getMaxResidentRepos: vi.fn(() => 5),
}));

vi.mock('../../../src/storage/repo-manager.js', () => ({
  readRegistry: vi.fn(async () => []),
}));

vi.mock('../../../src/core/group/extractors/http-route-extractor.js', () => ({
  HttpRouteExtractor: class {
    extract = (...args: unknown[]) => httpExtract(...args);
  },
}));

vi.mock('../../../src/core/group/extractors/grpc-extractor.js', () => ({
  GrpcExtractor: class {
    extract = (...args: unknown[]) => grpcExtract(...args);
  },
}));

const { syncGroup } = await import('../../../src/core/group/sync.js');

const handle: RepoHandle = {
  id: 'pool-backend',
  path: '/repos/backend',
  repoPath: '/repos/backend',
  storagePath: '/repos/backend/.gitnexus',
};

const config = (): GroupConfig => ({
  version: 1,
  name: 'test',
  description: '',
  repos: { 'app/backend': 'backend-repo' },
  links: [],
  packages: {},
  detect: {
    http: true,
    grpc: true,
    thrift: false,
    topics: false,
    shared_libs: false,
    embedding_fallback: false,
    includes: false,
    workspace_deps: false,
  },
  matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
});

describe('syncGroup when one extractor fails partway through a repo', () => {
  let groupDir: string;

  beforeEach(() => {
    httpExtract.mockReset();
    grpcExtract.mockReset();
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-partial-'));
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('keeps none of that repo’s contracts, matching what the diagnostics say', async () => {
    httpExtract.mockResolvedValue([PARTIAL_CONTRACT]);
    grpcExtract.mockRejectedValue(new Error('gRPC extraction failed'));

    const result = await syncGroup(config(), {
      groupDir,
      resolveRepoHandle: async () => handle,
    });

    expect(httpExtract).toHaveBeenCalledTimes(1);
    expect(result.unreadableRepos).toEqual(['app/backend']);
    // The contract the HTTP extractor produced is discarded with the rest of
    // the repo. Anything else contradicts the warning the same run emits.
    expect(result.contracts).toEqual([]);
  });

  it('keeps every contract when all enabled extractors succeed', async () => {
    // The control: the all-or-nothing rule must not cost the happy path its
    // output, which a guard that simply dropped `repoContracts` would.
    httpExtract.mockResolvedValue([PARTIAL_CONTRACT]);
    grpcExtract.mockResolvedValue([]);

    const result = await syncGroup(config(), {
      groupDir,
      resolveRepoHandle: async () => handle,
    });

    expect(result.unreadableRepos).toEqual([]);
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0].contractId).toBe('http::GET::/api/users');
    expect(result.contracts[0].repo).toBe('app/backend');
  });
});
