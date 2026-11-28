import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _captureLogger } from '../../src/core/logger.js';

const executeQueryMock = vi.fn();
const ensureVectorExtensionMock = vi.fn();
const embedQueryMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  ensureVectorExtension: (...args: unknown[]) => ensureVectorExtensionMock(...args),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: (...args: unknown[]) => embedQueryMock(...args),
  getEmbeddingDims: () => 3,
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

interface SemanticSearchable {
  semanticSearch(repo: { lbugPath: string }, query: string, limit: number): Promise<unknown[]>;
}

const runSemanticSearch = (backend: LocalBackend): Promise<unknown[]> =>
  (backend as unknown as SemanticSearchable).semanticSearch({ lbugPath: '/tmp/index' }, 'q', 5);

describe('LocalBackend semantic search lazy VECTOR loading (#3021)', () => {
  beforeEach(() => {
    executeQueryMock.mockReset();
    ensureVectorExtensionMock.mockReset();
    embedQueryMock.mockReset();
    embedQueryMock.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('does not probe VECTOR when the exact embedding count is zero', async () => {
    executeQueryMock.mockResolvedValueOnce([{ cnt: 0 }]);

    await expect(runSemanticSearch(new LocalBackend())).resolves.toEqual([]);

    expect(ensureVectorExtensionMock).not.toHaveBeenCalled();
    expect(embedQueryMock).not.toHaveBeenCalled();
  });

  it('probes VECTOR only after embeddings are found and keeps exact-scan fallback', async () => {
    executeQueryMock.mockResolvedValueOnce([{ cnt: 2 }]).mockResolvedValueOnce([]);
    ensureVectorExtensionMock.mockResolvedValue(false);

    await expect(runSemanticSearch(new LocalBackend())).resolves.toEqual([]);

    expect(ensureVectorExtensionMock).toHaveBeenCalledOnce();
    expect(ensureVectorExtensionMock).toHaveBeenCalledWith('/tmp/index');
    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(
      executeQueryMock.mock.calls.some(([, cypher]) =>
        String(cypher).includes('QUERY_VECTOR_INDEX'),
      ),
    ).toBe(false);
  });

  it('uses QUERY_VECTOR_INDEX only after the lazy VECTOR load succeeds', async () => {
    executeQueryMock
      .mockResolvedValueOnce([{ cnt: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    ensureVectorExtensionMock.mockResolvedValue(true);

    await expect(runSemanticSearch(new LocalBackend())).resolves.toEqual([]);

    expect(ensureVectorExtensionMock).toHaveBeenCalledOnce();
    expect(
      executeQueryMock.mock.calls.some(([, cypher]) =>
        String(cypher).includes('QUERY_VECTOR_INDEX'),
      ),
    ).toBe(true);
  });

  it('falls back to the exact scan when the lazy VECTOR load rejects', async () => {
    executeQueryMock.mockResolvedValueOnce([{ cnt: 2 }]).mockResolvedValueOnce([]);
    ensureVectorExtensionMock.mockRejectedValue(new Error('transient load failure'));

    await expect(runSemanticSearch(new LocalBackend())).resolves.toEqual([]);

    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(
      executeQueryMock.mock.calls.some(([, cypher]) =>
        String(cypher).includes('QUERY_VECTOR_INDEX'),
      ),
    ).toBe(false);
  });

  it('reports load and index-query failures independently', async () => {
    executeQueryMock.mockImplementation(async (_repoId: string, cypher: string) => {
      if (cypher.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (cypher.includes('QUERY_VECTOR_INDEX')) throw new Error('stale vector index');
      return [];
    });
    ensureVectorExtensionMock
      .mockRejectedValueOnce(new Error('transient load failure'))
      .mockResolvedValueOnce(true);
    const backend = new LocalBackend();
    const cap = _captureLogger();

    try {
      await expect(runSemanticSearch(backend)).resolves.toEqual([]);
      await expect(runSemanticSearch(backend)).resolves.toEqual([]);

      const messages = cap.records().map((record) => String(record.msg ?? ''));
      expect(
        messages.filter((message) => message.includes('vector extension load failed')),
      ).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes('vector index query failed')),
      ).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });
});

describe('LocalBackend semantic search past the exact-scan limit (#3014)', () => {
  type Degraded = { reason?: string; embeddingDims?: number };
  interface DegradableSearch {
    semanticSearch(
      repo: { lbugPath: string },
      query: string,
      limit: number,
      degraded: Degraded,
    ): Promise<unknown[]>;
  }
  const search = async (): Promise<{ results: unknown[]; degraded: Degraded }> => {
    const degraded: Degraded = {};
    const results = await (new LocalBackend() as unknown as DegradableSearch).semanticSearch(
      { lbugPath: '/tmp/index' },
      'q',
      5,
      degraded,
    );
    return { results, degraded };
  };
  const exactScanRan = (): boolean =>
    executeQueryMock.mock.calls.some(([, cypher]) => String(cypher).includes('e.embedding AS'));
  const expectSkippedLaneReason = (reason: string | undefined): void => {
    expect(reason).toMatch(/^Semantic search is unavailable/);
    expect(reason).toContain('GITNEXUS_SEMANTIC_EXACT_SCAN_LIMIT');
  };

  beforeEach(() => {
    executeQueryMock.mockReset();
    ensureVectorExtensionMock.mockReset();
    embedQueryMock.mockReset();
    embedQueryMock.mockResolvedValue([0.1, 0.2, 0.3]);
    // Three stored embeddings, two allowed in the exact scan.
    vi.stubEnv('GITNEXUS_SEMANTIC_EXACT_SCAN_LIMIT', '2');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { lane: 'is unavailable', arrange: () => ensureVectorExtensionMock.mockResolvedValue(false) },
    {
      lane: 'fails to load',
      arrange: () => ensureVectorExtensionMock.mockRejectedValue(new Error('load failure')),
    },
  ])('names the skipped semantic lane when VECTOR $lane', async ({ arrange }) => {
    executeQueryMock.mockResolvedValueOnce([{ cnt: 3 }]);
    arrange();

    const { results, degraded } = await search();

    expect(results).toEqual([]);
    expect(exactScanRan()).toBe(false);
    expectSkippedLaneReason(degraded.reason);
  });

  it('names the skipped semantic lane when the vector index query fails', async () => {
    executeQueryMock.mockImplementation(async (_repoId: string, cypher: string) => {
      if (cypher.includes('COUNT(*) AS cnt')) return [{ cnt: 3 }];
      if (cypher.includes('QUERY_VECTOR_INDEX')) throw new Error('stale vector index');
      return [];
    });
    ensureVectorExtensionMock.mockResolvedValue(true);

    const { results, degraded } = await search();

    expect(results).toEqual([]);
    expect(exactScanRan()).toBe(false);
    expectSkippedLaneReason(degraded.reason);
  });

  it('leaves a genuinely empty vector result unflagged', async () => {
    executeQueryMock.mockImplementation(async (_repoId: string, cypher: string) => {
      if (cypher.includes('COUNT(*) AS cnt')) return [{ cnt: 3 }];
      return [];
    });
    ensureVectorExtensionMock.mockResolvedValue(true);

    const { results, degraded } = await search();

    expect(results).toEqual([]);
    expect(degraded.reason).toBeUndefined();
  });
});
