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

const bridgeRows = vi.hoisted(() => ({
  value: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/core/group/bridge-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/group/bridge-db.js')>();
  return {
    ...actual,
    readBridgeMeta: vi.fn(async () => ({ version: 1, generatedAt: '', missingRepos: [] })),
    getCachedBridgeReadOnly: vi.fn(async () => bridgeHandle),
    queryBridge: vi.fn(async () => bridgeRows.value),
    closeBridgeDb: vi.fn(async () => undefined),
  };
});

const { runGroupImpact } = await import('../../../src/core/group/cross-impact.js');

describe('group impact through manifest-only endpoints', () => {
  let home: string;

  beforeEach(async () => {
    bridgeRows.value = [
      {
        neighborRepo: 'app',
        neighborUid: 'manifest::app::custom::executeAddDynamicLinkMS',
        neighborFilePath: '',
        matchType: 'manifest',
        confidence: 1,
        contractId: 'custom::executeAddDynamicLinkMS',
        contractType: 'custom',
      },
    ];
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

  function makePort(impactByUid: GroupToolPort['impactByUid']): GroupToolPort {
    return {
      resolveRepo: vi.fn(async (name: string) => ({
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
  }

  it('reports a proven manifest crossing when the far endpoint has only a synthetic UID', async () => {
    const impactByUid = vi.fn(async () => null);
    const resolveRepo = vi.fn(async (name: string) => ({
      id: name,
      name,
      repoPath: name,
      storagePath: path.join(home, name),
    }));
    const port: GroupToolPort = {
      resolveRepo,
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
        fanout_status: 'not_attempted',
      }),
    ]);
    expect(result.truncated).toBe(false);
    expect(result.risk).toBe('LOW');
    expect(resolveRepo).toHaveBeenCalledWith('app-registry');
    expect(impactByUid).not.toHaveBeenCalled();
  });

  it('keeps a boundary-only crossing visible when its service scope is unknown', async () => {
    const impactByUid = vi.fn(async () => null);
    const result = await runGroupImpact(
      { port: makePort(impactByUid), gitnexusDir: home },
      {
        name: 'waveful',
        repo: 'backend',
        target: 'executeAddDynamicLinkMS',
        direction: 'upstream',
        service: 'src',
      },
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.summary.cross_repo_hits).toBe(1);
    expect(result.cross[0]).toMatchObject({
      repo_path: 'app',
      fanout_status: 'not_attempted',
    });
    expect(result.risk).toBe('LOW');
    expect(impactByUid).not.toHaveBeenCalled();
  });

  it('labels a synthetic endpoint as manifest even when exact matching emitted the link', async () => {
    bridgeRows.value[0].matchType = 'exact';
    const result = await runGroupImpact(
      { port: makePort(vi.fn(async () => null)), gitnexusDir: home },
      {
        name: 'waveful',
        repo: 'backend',
        target: 'executeAddDynamicLinkMS',
        direction: 'upstream',
      },
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.cross[0].contract.match_type).toBe('manifest');
    expect(result.cross[0].fanout_status).toBe('not_attempted');
  });

  it('prefers completed fan-out over a duplicate manifest-only boundary', async () => {
    bridgeRows.value.push({
      neighborRepo: 'app',
      neighborUid: 'Function:src/handler.ts:executeAddDynamicLinkMS',
      neighborFilePath: 'src/handler.ts',
      matchType: 'exact',
      confidence: 1,
      contractId: 'custom::executeAddDynamicLinkMS',
      contractType: 'custom',
    });
    const impactByUid = vi.fn(async () => ({
      byDepth: {
        1: [{ id: 'Function:src/caller.ts:callDynamicLink' }],
      },
      affected_processes: [{ name: 'dynamic-link-flow' }],
    }));
    const result = await runGroupImpact(
      { port: makePort(impactByUid), gitnexusDir: home },
      {
        name: 'waveful',
        repo: 'backend',
        target: 'executeAddDynamicLinkMS',
        direction: 'upstream',
      },
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(impactByUid).toHaveBeenCalledTimes(1);
    expect(result.cross).toHaveLength(1);
    expect(result.cross[0]).toMatchObject({
      repo_path: 'app',
      contract: { id: 'custom::executeAddDynamicLinkMS', match_type: 'exact' },
      by_depth: {
        1: [{ id: 'Function:src/caller.ts:callDynamicLink' }],
      },
      affected_processes: ['dynamic-link-flow'],
    });
    expect(result.cross[0].fanout_status).toBeUndefined();
    expect(result.risk).toBe('HIGH');
  });

  it('does not escalate risk from multiple boundary-only crossings', async () => {
    bridgeRows.value = [1, 2, 3].map((suffix) => ({
      neighborRepo: 'app',
      neighborUid: `manifest::app::custom::dynamic-${suffix}`,
      neighborFilePath: '',
      matchType: 'manifest',
      confidence: 1,
      contractId: `custom::dynamic-${suffix}`,
      contractType: 'custom',
    }));
    const result = await runGroupImpact(
      { port: makePort(vi.fn(async () => null)), gitnexusDir: home },
      {
        name: 'waveful',
        repo: 'backend',
        target: 'executeAddDynamicLinkMS',
        direction: 'upstream',
      },
    );

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.cross).toHaveLength(3);
    expect(result.cross.every((entry) => entry.fanout_status === 'not_attempted')).toBe(true);
    expect(result.risk).toBe('LOW');
  });

  it('keeps an unavailable synthetic neighbor truncated instead of reporting a hit', async () => {
    const impactByUid = vi.fn(async () => null);
    const port: GroupToolPort = {
      resolveRepo: vi.fn(async (name) => {
        if (name === 'app-registry') throw new Error('repository unavailable');
        return {
          id: name,
          name,
          repoPath: name,
          storagePath: path.join(home, name),
        };
      }),
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

    expect(result.cross).toEqual([]);
    expect(result.summary.cross_repo_hits).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.truncatedRepos).toEqual(['app']);
    expect(impactByUid).not.toHaveBeenCalled();
  });
});
