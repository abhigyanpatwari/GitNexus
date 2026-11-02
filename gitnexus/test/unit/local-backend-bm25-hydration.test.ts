import { beforeEach, describe, expect, it, vi } from 'vitest';

const { searchFTS, executeParameterized } = vi.hoisted(() => ({
  searchFTS: vi.fn(),
  executeParameterized: vi.fn(),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({ searchFTSFromLbug: searchFTS }));
vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeParameterized,
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

const repo = { lbugPath: '/tmp/bm25-hydration/lbug' };
type TestRepo = typeof repo;
const row = (index: number) => ({
  id: `Function:src/file-${index}.ts:handler`,
  name: 'handler',
  type: 'Function',
  filePath: `src/file-${index}.ts`,
  startLine: index,
  endLine: index + 1,
});

const search = () =>
  (
    new LocalBackend() as unknown as {
      bm25Search: (
        repo: TestRepo,
        query: string,
        limit: number,
      ) => Promise<{ results: unknown[]; ftsUsed: boolean }>;
    }
  ).bm25Search(repo, 'handler', 100);

describe('LocalBackend BM25 symbol hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hydrates 100 matching files with one graph read and preserves their ranking', async () => {
    const symbols = Array.from({ length: 100 }, (_, index) => row(index));
    searchFTS.mockResolvedValue({
      ftsAvailable: true,
      results: symbols.map((symbol, index) => ({
        filePath: symbol.filePath,
        score: 100 - index,
        nodeIds: [symbol.id],
      })),
    });
    executeParameterized.mockImplementation(async (_repo, _cypher, params) =>
      symbols.filter((symbol) => params.nodeIds.includes(symbol.id)),
    );

    const result = await search();

    expect(result.ftsUsed).toBe(true);
    expect(result.results).toEqual(
      symbols.map(({ id, ...symbol }, index) => ({
        nodeId: id,
        ...symbol,
        bm25Score: 100 - index,
      })),
    );
    expect(executeParameterized).toHaveBeenCalledTimes(1);
  });

  it('bounds batches without changing the FTS file ranking', async () => {
    const symbols = Array.from({ length: 201 }, (_, index) => row(index));
    searchFTS.mockResolvedValue({
      ftsAvailable: true,
      results: symbols.map((symbol) => ({
        filePath: symbol.filePath,
        score: 1,
        nodeIds: [symbol.id],
      })),
    });
    executeParameterized.mockImplementation(async (_repo, _cypher, params) =>
      symbols.filter((symbol) => params.nodeIds.includes(symbol.id)).reverse(),
    );
    const result = await search();
    expect(result.results.map((hit: { nodeId: string }) => hit.nodeId)).toEqual(
      symbols.map((symbol) => symbol.id),
    );
    expect(executeParameterized).toHaveBeenCalledTimes(3);
    for (const [, cypher, params] of executeParameterized.mock.calls) {
      expect(params.nodeIds.length).toBeLessThanOrEqual(100);
      expect(cypher).toContain('WHERE n.id IN $nodeIds');
      expect(cypher).toContain('ORDER BY startLine, id');
    }
  });

  it('keeps database ordering, scores, positional rows, and duplicate-ID semantics', async () => {
    const first = row(0);
    const second = { ...row(1), filePath: first.filePath };
    searchFTS.mockResolvedValue({
      ftsAvailable: true,
      results: [{ filePath: second.filePath, score: 8, nodeIds: [second.id, first.id, second.id] }],
    });
    executeParameterized.mockResolvedValue([Object.values(first), Object.values(second)]);
    expect((await search()).results).toEqual(
      [first, second].map(({ id, ...symbol }) => ({ nodeId: id, ...symbol, bm25Score: 8 })),
    );
    expect(executeParameterized.mock.calls[0][2].nodeIds).toEqual([second.id, first.id]);
  });

  it('retains file-only and legacy path fallbacks without adding an empty batch', async () => {
    searchFTS.mockResolvedValue({
      ftsAvailable: false,
      missingIndexes: ['Function.symbol_fts'],
      nonBenignErrors: ['diagnostic'],
      results: [
        { filePath: 'src/missing.ts', score: 2, nodeIds: ['Function:missing'] },
        { filePath: 'src/legacy.ts', score: 1 },
      ],
    });
    executeParameterized.mockResolvedValue([]);
    expect(await search()).toEqual({
      ftsUsed: false,
      missingIndexes: ['Function.symbol_fts'],
      nonBenignErrors: ['diagnostic'],
      results: [
        { name: 'missing.ts', type: 'File', filePath: 'src/missing.ts', bm25Score: 2 },
        { name: 'legacy.ts', type: 'File', filePath: 'src/legacy.ts', bm25Score: 1 },
      ],
    });
    expect(executeParameterized).toHaveBeenCalledTimes(2);
    expect(executeParameterized.mock.calls[1][1]).toContain("NOT n.id STARTS WITH 'BasicBlock:'");
    expect(executeParameterized.mock.calls[1][1]).toContain('LIMIT 3');

    executeParameterized.mockClear();
    searchFTS.mockResolvedValue({ ftsAvailable: true, results: [] });
    expect(await search()).toEqual({ ftsUsed: true, results: [] });
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it('retries failed batches per file so one failure does not hide another file', async () => {
    const symbols = [row(0), row(1)];
    searchFTS.mockResolvedValue({
      ftsAvailable: true,
      results: symbols.map((symbol) => ({
        filePath: symbol.filePath,
        score: 1,
        nodeIds: [symbol.id],
      })),
    });
    executeParameterized.mockImplementation(async (_repo, _cypher, params) => {
      if (params.nodeIds.includes(symbols[0].id)) throw new Error('query failed');
      return [symbols[1]];
    });
    const { id, ...symbol } = symbols[1];
    expect((await search()).results).toEqual([
      { name: 'file-0.ts', type: 'File', filePath: 'src/file-0.ts', bm25Score: 1 },
      { nodeId: id, ...symbol, bm25Score: 1 },
    ]);
    expect(executeParameterized).toHaveBeenCalledTimes(3);
  });

  it('rejects corrupt input and hydrated identities rather than returning file fallbacks', async () => {
    searchFTS.mockResolvedValue({
      ftsAvailable: true,
      results: [{ filePath: 'src/file-0.ts', score: 1, nodeIds: [''] }],
    });
    await expect(search()).rejects.toThrow('invalid symbol identity');
    expect(executeParameterized).not.toHaveBeenCalled();

    searchFTS.mockResolvedValue({
      ftsAvailable: true,
      results: [{ filePath: 'src/file-0.ts', score: 1, nodeIds: [row(0).id] }],
    });
    executeParameterized.mockResolvedValue([{ ...row(0), id: '' }]);
    await expect(search()).rejects.toThrow('invalid symbol identity');
    expect(executeParameterized).toHaveBeenCalledTimes(1);
  });
});
