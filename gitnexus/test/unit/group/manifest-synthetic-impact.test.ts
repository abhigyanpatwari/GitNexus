import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeHandle } from '../../../src/core/group/types.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';

const bridgeHandle = {
  _db: {},
  _conn: {},
  groupDir: '',
  _readOnly: true,
} as BridgeHandle;

vi.mock('../../../src/core/group/bridge-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/group/bridge-db.js')>();
  return {
    ...actual,
    readBridgeMeta: vi.fn(async () => ({ version: 1, generatedAt: '', missingRepos: [] })),
    getCachedBridgeReadOnly: vi.fn(async () => bridgeHandle),
    queryBridge: vi.fn(async () => [
      {
        neighborRepo: 'app',
        neighborUid: 'manifest::app::custom::executeAddDynamicLinkMS',
        neighborFilePath: '',
        matchType: 'manifest',
        confidence: 1,
        contractId: 'custom::executeAddDynamicLinkMS',
        contractType: 'custom',
      },
    ]),
    closeBridgeDb: vi.fn(async () => undefined),
  };
});

const { runGroupImpact } = await import('../../../src/core/group/cross-impact.js');

describe('group impact through manifest-only endpoints', () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-manifest-impact-'));
    const groupDir = path.join(home, 'groups', 'waveful');
    await fsp.mkdir(groupDir, { recursive: true });
    await fsp.writeFile(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: waveful
description: ""
repos:
  backend: backend-registry
  app: app-registry
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
`,
      'utf8',
    );
    await fsp.writeFile(path.join(groupDir, 'bridge.lbug'), '');
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reports a proven manifest crossing when the far endpoint has only a synthetic UID', async () => {
    const impactByUid = vi.fn(async () => null);
    const port: GroupToolPort = {
      resolveRepo: vi.fn(async (name) => ({
        id: name,
        name,
        repoPath: name,
        storagePath: path.join(home, name),
      })),
      impact: vi.fn(async () => ({
        target: {
          id: 'Function:src/functions.ts:executeAddDynamicLinkMS',
          filePath: 'src/functions.ts',
        },
        byDepth: {},
        summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
        risk: 'LOW',
      })),
      impactByUid,
      query: vi.fn(),
      context: vi.fn(),
    };

    const result = await runGroupImpact(
      { port, gitnexusDir: home },
      {
        name: 'waveful',
        repo: 'backend',
        target: 'executeAddDynamicLinkMS',
        direction: 'upstream',
      },
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.summary.cross_repo_hits).toBe(1);
    expect(result.cross).toEqual([
      expect.objectContaining({
        repo: 'app-registry',
        repo_path: 'app',
        contract: expect.objectContaining({
          id: 'custom::executeAddDynamicLinkMS',
          match_type: 'manifest',
          confidence: 1,
        }),
        by_depth: {},
        affected_processes: [],
      }),
    ]);
    expect(result.truncated).toBe(false);
    expect(impactByUid).not.toHaveBeenCalled();
  });
});
