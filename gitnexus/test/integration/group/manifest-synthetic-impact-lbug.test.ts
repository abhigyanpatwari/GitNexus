import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGroupImpact } from '../../../src/core/group/cross-impact.js';
import { closeAllCachedBridges, writeBridge } from '../../../src/core/group/bridge-db.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';
import type { CrossLink, StoredContract } from '../../../src/core/group/types.js';

// LadybugDB does not reliably release the writer handle before an immediate
// read-only reopen on Windows; the existing real-bridge tests use the same
// platform guard. Linux CI executes this regression against the real DB.
const itRealBridge = process.platform === 'win32' ? it.skip : it;

describe('manifest-only group impact through a real bridge', () => {
  let home: string;
  let groupDir: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-manifest-impact-lbug-'));
    groupDir = path.join(home, 'groups', 'waveful');
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
  });

  afterEach(async () => {
    await closeAllCachedBridges();
    await fsp.rm(home, { recursive: true, force: true });
  });

  itRealBridge(
    'round-trips a synthetic uid and reports the boundary without attempting fan-out',
    async () => {
      const contractId = 'custom::executeAddDynamicLinkMS';
      const providerUid = 'Function:src/functions.ts:executeAddDynamicLinkMS';
      const syntheticUid = `manifest::app::${contractId}`;
      const provider: StoredContract = {
        repo: 'backend',
        role: 'provider',
        contractId,
        type: 'custom',
        symbolUid: providerUid,
        symbolRef: { filePath: 'src/functions.ts', name: 'executeAddDynamicLinkMS' },
        symbolName: 'executeAddDynamicLinkMS',
        confidence: 1,
        meta: {},
      };
      const consumer: StoredContract = {
        repo: 'app',
        role: 'consumer',
        contractId,
        type: 'custom',
        symbolUid: syntheticUid,
        symbolRef: { filePath: '', name: contractId },
        symbolName: contractId,
        confidence: 1,
        meta: { source: 'manifest' },
      };
      const link: CrossLink = {
        from: { repo: 'app', symbolUid: syntheticUid, symbolRef: consumer.symbolRef },
        to: { repo: 'backend', symbolUid: providerUid, symbolRef: provider.symbolRef },
        type: 'custom',
        contractId,
        matchType: 'manifest',
        confidence: 1,
      };
      const report = await writeBridge(groupDir, {
        contracts: [provider, consumer],
        crossLinks: [link],
        repoSnapshots: {},
        missingRepos: [],
      });
      expect(report.linksInserted).toBe(1);

      const impactByUid = vi.fn(async () => null);
      const port: GroupToolPort = {
        resolveRepo: vi.fn(async (name: string) => ({
          id: name,
          name,
          repoPath: name,
          storagePath: path.join(home, name),
        })),
        impact: vi.fn(async () => ({
          target: { id: providerUid, filePath: 'src/functions.ts' },
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

      if ('error' in result) throw new Error(result.error);

      expect(result.cross).toEqual([
        expect.objectContaining({
          repo_path: 'app',
          contract: expect.objectContaining({ id: contractId, match_type: 'manifest' }),
          fanout_status: 'not_attempted',
        }),
      ]);
      expect(result.summary.cross_repo_hits).toBe(1);
      expect(result.risk).toBe('LOW');
      expect(result.truncated).toBe(false);
      expect(impactByUid).not.toHaveBeenCalled();
    },
  );
});
