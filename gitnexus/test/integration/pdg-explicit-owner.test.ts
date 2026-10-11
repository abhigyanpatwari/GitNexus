import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTestGraph } from '../helpers/test-graph.js';
import { runImpactPDG } from '../../src/mcp/local/pdg-impact.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, type RepoMeta } from '../../src/storage/repo-manager.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
  loadMeta: vi.fn().mockResolvedValue({
    pdg: {
      maxCdgEdgesPerFunction: 100,
      maxReachingDefEdgesPerFunction: 100,
      taintModelVersion: '1',
    },
  } as unknown as RepoMeta),
}));

let backend: LocalBackend;
const repoId = 'pdg-owner';

let root: string;
let db: string;
const filePath = 'program.cbl';
const outer = 'Module:program.cbl:Outer';
const inner = 'Module:program.cbl:Inner';
const outerBlock = 'BasicBlock:program.cbl:5:0:0';
const innerBlock = 'BasicBlock:program.cbl:12:0:0';
const outerDependent = 'BasicBlock:program.cbl:5:0:1';
const innerDependent = 'BasicBlock:program.cbl:12:0:1';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdg-owner-'));
  const storage = path.join(root, '.gitnexus');
  db = path.join(storage, 'lbug');
  await adapter.initLbug(db);
  await adapter.loadGraphToLbug(
    buildTestGraph(
      [
        { id: outer, label: 'Module', name: 'Outer', filePath, startLine: 0, endLine: 20 },
        { id: inner, label: 'Module', name: 'Inner', filePath, startLine: 9, endLine: 18 },
        {
          id: 'Function:program.cbl:Outer:main',
          label: 'Function',
          name: 'main',
          filePath,
          startLine: 4,
          endLine: 6,
        },
        {
          id: outerBlock,
          label: 'BasicBlock',
          name: '',
          filePath,
          startLine: 5,
          endLine: 5,
          extra: { text: 'display outer', ownerId: outer },
        },
        {
          id: innerBlock,
          label: 'BasicBlock',
          name: '',
          filePath,
          startLine: 12,
          endLine: 12,
          extra: { text: 'display inner', ownerId: inner },
        },
        {
          id: outerDependent,
          label: 'BasicBlock',
          name: '',
          filePath,
          startLine: 6,
          endLine: 6,
          extra: { text: 'display outer dependent', ownerId: outer },
        },
        {
          id: innerDependent,
          label: 'BasicBlock',
          name: '',
          filePath,
          startLine: 13,
          endLine: 13,
          extra: { text: 'display inner dependent', ownerId: inner },
        },
      ],
      [outerBlock, innerBlock].flatMap((sourceId, i) =>
        (['CDG', 'REACHING_DEF', 'TAINTED'] as const).map((type) => ({
          sourceId,
          targetId: i === 0 ? outerDependent : innerDependent,
          type,
          reason: type === 'CDG' ? 'T' : 'TOTAL',
        })),
      ),
    ),
    root,
    storage,
  );
  await adapter.flushWAL();
  await pool.initLbugWithDb(repoId, adapter.getDatabase()!, db);
  vi.mocked(listRegisteredRepos).mockResolvedValue([
    {
      name: repoId,
      path: root,
      storagePath: storage,
      indexedAt: new Date().toISOString(),
      lastCommit: 'test',
      stats: { files: 1, nodes: 7, communities: 0, processes: 0 },
    },
  ]);
  backend = new LocalBackend();
  await backend.init();
});

afterAll(async () => {
  await backend?.dispose();
  await pool.closeLbug(repoId);
  await adapter.closeLbug();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe('explicit executable ownership in PDG seeds', () => {
  const impact = (id: string, startLine: number, endLine: number, line?: number) =>
    runImpactPDG({
      repo: { lbugPath: db },
      sym: { id, name: id.split(':').at(-1)!, filePath, startLine, endLine },
      symType: id.split(':')[0]!,
      direction: 'downstream',
      maxDepth: 1,
      limit: 50,
      line,
      executeParameterized: (_db, query, params) => adapter.executePrepared(query, params),
    });

  it('excludes a nested executable owner from its enclosing source span', async () => {
    expect(await impact(outer, 0, 20)).toMatchObject({ seedBlocks: [outerBlock, outerDependent] });
  });

  it('does not seed a nested program statement for its enclosing program', async () => {
    expect(await impact(outer, 0, 20, 12)).toMatchObject({
      seedBlocks: [],
      epistemic: 'pdg-no-block-at-line',
    });
  });

  it('retains span-based selection for a paragraph inside an owned program', async () => {
    expect(await impact('Function:program.cbl:Outer:main', 4, 6, 5)).toMatchObject({
      seedBlocks: [outerBlock],
    });
  });
  it('labels paragraph effects by the execution owner of the seed', async () => {
    const result = await impact('Function:program.cbl:Outer:main', 4, 6, 5);
    expect(result).toMatchObject({
      intraReachableBlocks: [outerDependent],
      affectedStatements: [{ line: 6, text: 'display outer dependent', scope: 'intra' }],
    });
  });

  it('keeps statements reached in another execution owner inter-procedural', async () => {
    await adapter.executePrepared(
      `MATCH (a:BasicBlock {id: $source}), (b:BasicBlock {id: $target})
       CREATE (a)-[:CodeRelation {type: 'REACHING_DEF', reason: 'cross-owner', confidence: 1.0, step: 0}]->(b)`,
      { source: outerBlock, target: innerDependent },
    );
    try {
      const result = await impact('Function:program.cbl:Outer:main', 4, 6, 5);
      expect(result).toMatchObject({
        affectedStatements: [
          { line: 6, scope: 'intra' },
          { line: 13, scope: 'inter' },
        ],
      });
    } finally {
      await adapter.executeQuery(
        "MATCH (:BasicBlock)-[r:CodeRelation]->(:BasicBlock) WHERE r.reason = 'cross-owner' DELETE r",
      );
    }
  });

  it.each(['controls', 'flows'])(
    'public %s queries exclude nested program dependencies',
    async (mode) => {
      const result = await backend.callTool('pdg_query', { mode, target: 'Outer' });
      expect(result.error).toBeUndefined();
      expect(result.total).toBe(1);
      expect(JSON.stringify(result.results)).not.toContain('inner');
      const fileResult = await backend.callTool('pdg_query', { mode, target: filePath });
      expect(fileResult.total).toBe(2);
      const paragraph = await backend.callTool('pdg_query', { mode, target: 'main' });
      expect(paragraph.total).toBe(1);
    },
  );

  it('public explain excludes nested program findings', async () => {
    const result = await backend.callTool('explain', { target: 'Outer' });
    expect(result.error).toBeUndefined();
    expect(result.totalFindings).toBe(1);
  });

  it('rejects a ready legacy PDG index with explicit schema recovery guidance', async () => {
    await adapter.executeQuery('ALTER TABLE BasicBlock DROP ownerId');
    try {
      for (const line of [undefined, 5]) {
        const result = await impact('Function:program.cbl:Outer:main', 4, 6, line);
        expect(result).toMatchObject({
          risk: 'UNKNOWN',
          impactedCount: null,
          recoverySuggestion: expect.stringContaining('gitnexus analyze --pdg'),
        });
      }
      for (const line of [undefined, 5]) {
        const result = await backend.callTool('impact', {
          target: 'main',
          mode: 'pdg',
          direction: 'downstream',
          line,
        });
        expect(result).toMatchObject({
          impactedCount: null,
          recoverySuggestion: expect.stringContaining('gitnexus analyze --pdg'),
        });
      }
      for (const tool of ['pdg_query', 'explain']) {
        const result = await backend.callTool(tool, { mode: 'flows', target: 'Outer' });
        expect(result.recoverySuggestion).toContain('gitnexus analyze --pdg');
      }
      const columns = await adapter.executeQuery("CALL table_info('BasicBlock') RETURN name");
      expect(columns.some((row) => row.name === 'ownerId')).toBe(false);
    } finally {
      await adapter.executeQuery('ALTER TABLE BasicBlock ADD ownerId STRING');
    }
  });
});
