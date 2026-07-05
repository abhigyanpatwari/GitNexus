/**
 * U6 — Cross-repo trace, evaluation-first end-to-end.
 *
 * Stands up TWO real LadybugDB indexes (a "frontend" consumer repo and a
 * "backend" provider repo), a real group bridge linking a consumer symbol to a
 * provider symbol, and a real LocalBackend with both repos registered. Then it
 * drives the public `callTool('trace', { repo: '@group', pdg: true })` and
 * asserts the stitched cross-repo path AND the real REACHING_DEF data-flow
 * enrichment — exercising every new query path against a real engine:
 * resolveSymbolCandidates, _traceImpl, the bridge `listCrossingsBetween` pair
 * query, and `_pdgFlowsForGroupImpl`.
 *
 * The two indexes are built sequentially with the writable core adapter (one
 * open writer at a time) and read back through the MCP pool adapter the backend
 * opens lazily. A real two-repo *analyze* pipeline is heavier than this gate
 * needs; hand-persisting the minimal real graph keeps it deterministic while
 * still hitting real LadybugDB Cypher.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../../src/storage/repo-manager.js';
import { writeBridge } from '../../../src/core/group/bridge-db.js';
import type { CrossLink } from '../../../src/core/group/types.js';
import { makeContract } from '../../unit/group/fixtures.js';

vi.mock('../../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    // No meta.json for the seeded DBs — pdgStampForMode degrades to the
    // row-existence probe (the seeded-DB reality, like pdg-query.test.ts).
    loadMeta: vi.fn().mockResolvedValue(null),
  };
});

// LadybugDB close-then-reopen is Windows-flaky (file lock held until process
// exit); the bridge write+read and the sequential two-DB build both hit it.
const describeReopen = process.platform === 'win32' ? describe.skip : describe;

/** Restore an env var to a prior value, or unset it if there was none. */
function restoreEnvVar(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

interface NodeSpec {
  label: 'Function' | 'BasicBlock';
  props: Record<string, unknown>;
}
interface RelSpec {
  type: 'CALLS' | 'REACHING_DEF';
  srcLabel: 'Function' | 'BasicBlock';
  dstLabel: 'Function' | 'BasicBlock';
  src: string;
  dst: string;
  reason?: string;
}

/** Build a real lbug DB at `lbugPath`, seeding nodes + rels via the writer. */
async function buildRepoDB(lbugPath: string, nodes: NodeSpec[], rels: RelSpec[]): Promise<void> {
  const core = await import('../../../src/core/lbug/lbug-adapter.js');
  await core.initLbug(lbugPath); // creates the full schema
  try {
    for (const n of nodes) {
      const assignments = Object.keys(n.props)
        .map((k) => `${k}: $${k}`)
        .join(', ');
      await core.executePrepared(`CREATE (x:${n.label} {${assignments}})`, n.props);
    }
    for (const r of rels) {
      await core.executePrepared(
        `MATCH (a:${r.srcLabel} {id: $src}), (b:${r.dstLabel} {id: $dst})
         CREATE (a)-[:CodeRelation {type: '${r.type}', confidence: 1.0, reason: $reason, step: 0}]->(b)`,
        { src: r.src, dst: r.dst, reason: r.reason ?? '' },
      );
    }
    await core.flushWAL();
  } finally {
    await core.closeLbug();
  }
}

describeReopen('cross-repo trace e2e (two real indexes + bridge)', () => {
  let tmpHome: string;
  let storageFE: string;
  let storageBE: string;
  let backend: LocalBackend;
  let prevHome: string | undefined;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cross-trace-e2e-'));
    storageFE = path.join(tmpHome, 'fe-storage');
    storageBE = path.join(tmpHome, 'be-storage');
    fs.mkdirSync(storageFE, { recursive: true });
    fs.mkdirSync(storageBE, { recursive: true });

    // ── Frontend (consumer) index: checkout -> callUsers, with a REACHING_DEF
    //    data-flow inside callUsers (def line 3 -> use line 4 of `userId`). ──
    await buildRepoDB(
      path.join(storageFE, 'lbug'),
      [
        {
          label: 'Function',
          props: {
            id: 'fn:checkout',
            name: 'checkout',
            filePath: 'src/checkout.ts',
            startLine: 10,
            endLine: 14,
          },
        },
        {
          label: 'Function',
          props: {
            id: 'fn:callUsers',
            name: 'callUsers',
            filePath: 'src/api.ts',
            startLine: 2,
            endLine: 6,
          },
        },
        {
          label: 'BasicBlock',
          props: {
            id: 'BasicBlock:src/api.ts:2:0:0',
            filePath: 'src/api.ts',
            startLine: 3,
            endLine: 3,
            text: 'const userId = req.params.id',
            callees: '',
            calleeIds: '',
          },
        },
        {
          label: 'BasicBlock',
          props: {
            id: 'BasicBlock:src/api.ts:2:0:1',
            filePath: 'src/api.ts',
            startLine: 4,
            endLine: 4,
            text: 'fetchUsers(userId)',
            callees: '',
            calleeIds: '',
          },
        },
      ],
      [
        {
          type: 'CALLS',
          srcLabel: 'Function',
          dstLabel: 'Function',
          src: 'fn:checkout',
          dst: 'fn:callUsers',
        },
        {
          type: 'REACHING_DEF',
          srcLabel: 'BasicBlock',
          dstLabel: 'BasicBlock',
          src: 'BasicBlock:src/api.ts:2:0:0',
          dst: 'BasicBlock:src/api.ts:2:0:1',
          reason: 'userId',
        },
      ],
    );

    // ── Backend (provider) index: handleUsers -> getUsers. No PDG layer. ──
    await buildRepoDB(
      path.join(storageBE, 'lbug'),
      [
        {
          label: 'Function',
          props: {
            id: 'fn:handleUsers',
            name: 'handleUsers',
            filePath: 'src/routes.ts',
            startLine: 5,
            endLine: 9,
          },
        },
        {
          label: 'Function',
          props: {
            id: 'fn:getUsers',
            name: 'getUsers',
            filePath: 'src/users.ts',
            startLine: 1,
            endLine: 4,
          },
        },
      ],
      [
        {
          type: 'CALLS',
          srcLabel: 'Function',
          dstLabel: 'Function',
          src: 'fn:handleUsers',
          dst: 'fn:getUsers',
        },
      ],
    );

    // ── Group config + bridge (consumer callUsers -> provider handleUsers). ──
    const groupDir = path.join(tmpHome, 'groups', 'grp');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: grp
description: ""
repos:
  app/frontend: reg-fe
  app/backend: reg-be
links: []
packages: {}
detect:
  http: true
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
    );
    const consumer = makeContract({
      repo: 'app/frontend',
      role: 'consumer',
      symbolUid: 'fn:callUsers',
      symbolRef: { filePath: 'src/api.ts', name: 'callUsers' },
      symbolName: 'callUsers',
      contractId: 'http::GET::/api/users',
    });
    const provider = makeContract({
      repo: 'app/backend',
      role: 'provider',
      symbolUid: 'fn:handleUsers',
      symbolRef: { filePath: 'src/routes.ts', name: 'handleUsers' },
      symbolName: 'handleUsers',
      contractId: 'http::GET::/api/users',
    });
    const link: CrossLink = {
      from: { repo: 'app/frontend', symbolUid: 'fn:callUsers', symbolRef: consumer.symbolRef },
      to: { repo: 'app/backend', symbolUid: 'fn:handleUsers', symbolRef: provider.symbolRef },
      type: 'http',
      contractId: 'http::GET::/api/users',
      matchType: 'exact',
      confidence: 0.9,
    };
    await writeBridge(groupDir, {
      contracts: [consumer, provider],
      crossLinks: [link],
      repoSnapshots: {},
      missingRepos: [],
    });

    // ── Register both repos + a real backend (lazy pool open). ──
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: 'reg-fe',
        path: path.join(tmpHome, 'fe-repo'),
        storagePath: storageFE,
        indexedAt: new Date(0).toISOString(),
        lastCommit: 'fe',
        stats: { files: 1, nodes: 2, communities: 0, processes: 0 },
      },
      {
        name: 'reg-be',
        path: path.join(tmpHome, 'be-repo'),
        storagePath: storageBE,
        indexedAt: new Date(0).toISOString(),
        lastCommit: 'be',
        stats: { files: 1, nodes: 2, communities: 0, processes: 0 },
      },
    ]);

    prevHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome;
    backend = new LocalBackend();
    await backend.init();
  }, 120_000);

  afterAll(async () => {
    await backend?.dispose();
    restoreEnvVar('GITNEXUS_HOME', prevHome);
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }, 120_000);

  it('stitches checkout -> getUsers across the bridge with real PDG enrichment', async () => {
    const result = await backend.callTool('trace', {
      repo: '@grp',
      from: 'checkout',
      to: 'getUsers',
      pdg: true,
    });

    expect(result).toMatchObject({
      status: 'ok',
      crossings: [
        {
          fromRepo: 'app/frontend',
          toRepo: 'app/backend',
          contractId: 'http::GET::/api/users',
          matchType: 'exact',
        },
      ],
    });

    // The stitched path spans both repos in order, tagged by member repo.
    const hops = (result.hops as Array<{ name: string; repo: string }>).map((h) => ({
      name: h.name,
      repo: h.repo,
    }));
    expect(hops).toEqual([
      { name: 'checkout', repo: 'app/frontend' },
      { name: 'callUsers', repo: 'app/frontend' },
      { name: 'handleUsers', repo: 'app/backend' },
      { name: 'getUsers', repo: 'app/backend' },
    ]);

    // The boundary hop carries the CONTRACT_LINK edge.
    const edgeTypes = (result.edges as Array<{ relType: string }>).map((e) => e.relType);
    expect(edgeTypes).toContain('CONTRACT_LINK');

    // Real REACHING_DEF enrichment of the consumer segment (intra-procedural).
    expect(result.dataFlow).toEqual([
      expect.objectContaining({
        repo: 'app/frontend',
        variable: 'userId',
        hops: expect.arrayContaining([expect.objectContaining({ line: 4, variable: 'userId' })]),
      }),
    ]);

    // The provider repo has no PDG layer → a degraded note, but the trace is ok.
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.stringContaining('No PDG layer in app/backend')]),
    );
  });

  // A SECOND @group call in the same process — exercises the bridge read-only
  // reopen that previously failed (closeBridgeDb used to CHECKPOINT read-only
  // handles, leaving a lock artifact). Now fixed, so repeated @group traces work.
  it('omitting pdg yields the same stitched path with no data-flow enrichment', async () => {
    const result = await backend.callTool('trace', {
      repo: '@grp',
      from: 'checkout',
      to: 'getUsers',
    });
    expect(result.status).toBe('ok');
    expect(result.dataFlow).toBeUndefined();
    expect((result.crossings as unknown[]).length).toBe(1);
    expect((result.hops as Array<{ name: string }>).map((h) => h.name)).toEqual([
      'checkout',
      'callUsers',
      'handleUsers',
      'getUsers',
    ]);
  });

  it('single-repo trace against one member is unchanged (no group routing)', async () => {
    const result = await backend.callTool('trace', {
      repo: 'reg-fe',
      from: 'checkout',
      to: 'callUsers',
    });
    expect(result.status).toBe('ok');
    // Plain single-repo result shape — no crossings field.
    expect(result.crossings).toBeUndefined();
    expect(result.hops.map((h: { name: string }) => h.name)).toEqual(['checkout', 'callUsers']);
  });
});
