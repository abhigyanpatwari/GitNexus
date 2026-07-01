import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';

// Mock the pool adapter (and its re-export shim) so executeParameterized is fully
// controllable — the proven seam from impact-batching-grouping.test.ts. This is a
// UNIT test: the integration suite runs the real executeParameterized against a
// real DB, so it cannot make ONE enrichment query throw while the rest succeed.
const executeParameterizedMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/core/lbug-adapter.js')>();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend';

// A backend whose hybrid search yields exactly one matched symbol, so the
// enrichment chunk loop runs and can be made to fail. `ftsUsed` is parameterized
// so we can exercise the FTS-missing + enrichment-degraded composition.
function makeBackend(ftsUsed = true): LocalBackend {
  const backend = new LocalBackend();
  const repoHandle = {
    id: 'repo1',
    name: 'repo1',
    repoPath: '/tmp/repo',
    storagePath: '/tmp/repo/.gitnexus',
    lbugPath: '/tmp/repo/.gitnexus/lbug',
    indexedAt: 'now',
    lastCommit: 'c',
    stats: {},
  } as any;
  (backend as any).repos.set(repoHandle.id, repoHandle);
  (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  const sym = {
    nodeId: 'func:x',
    name: 'x',
    type: 'Function',
    filePath: 'f.ts',
    startLine: 1,
    endLine: 2,
  };
  (backend as any).bm25Search = vi.fn().mockResolvedValue({ results: [sym], ftsUsed });
  (backend as any).semanticSearch = vi.fn().mockResolvedValue([]);
  return { backend, repoHandle } as any;
}

const runQuery = (b: any, params: any = { query: 'x' }) =>
  (b.backend as any).query(b.repoHandle, params);

describe('query: degraded-enrichment signal', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('a REAL enrichment failure surfaces warning + partial, and still returns the symbol', async () => {
    const b = makeBackend(true);
    executeParameterizedMock.mockImplementation(async (_repo: string, query: string) => {
      if (query.includes('STEP_IN_PROCESS'))
        throw new Error('Query execution timed out after 30000ms');
      return []; // MEMBER_OF / content succeed (empty)
    });

    const result = await runQuery(b);

    expect(result).not.toHaveProperty('error');
    expect(result.partial).toBe(true);
    expect(typeof result.warning).toBe('string');
    expect(result.warning.toLowerCase()).toContain('enrichment');
    // The matched symbol still comes back (degraded to definitions, not dropped).
    expect(result.definitions.map((d: any) => d.id)).toContain('func:x');
  });

  it('a BENIGN missing-table error does NOT trip the signal', async () => {
    const b = makeBackend(true);
    executeParameterizedMock.mockImplementation(async (_repo: string, query: string) => {
      // A repo analyzed without processes/communities: prepare fails because the
      // table/label does not exist. This is normal, not degraded.
      if (query.includes('STEP_IN_PROCESS') || query.includes('MEMBER_OF'))
        throw new Error('Binder exception: Table Process does not exist.');
      return [];
    });

    const result = await runQuery(b);

    expect(result).not.toHaveProperty('error');
    expect(result.partial).toBeUndefined();
    expect(result.warning).toBeUndefined(); // ftsUsed=true and no real failure
    expect(result.definitions.map((d: any) => d.id)).toContain('func:x');
  });

  it('composes the FTS-missing warning with the enrichment-degraded message', async () => {
    const b = makeBackend(false); // FTS unavailable
    executeParameterizedMock.mockImplementation(async (_repo: string, query: string) => {
      if (query.includes('STEP_IN_PROCESS'))
        throw new Error('Query execution timed out after 30000ms');
      return [];
    });

    const result = await runQuery(b);

    expect(result.partial).toBe(true);
    expect(typeof result.warning).toBe('string');
    // Both messages present in the single composed warning — neither overwrites the other.
    expect(result.warning).toMatch(/FTS indexes missing|repair-fts/i);
    expect(result.warning.toLowerCase()).toContain('enrichment');
  });

  it('warns when a CJK query hits a server resolving segmentation to none (#2331)', async () => {
    const b = makeBackend(true);
    executeParameterizedMock.mockResolvedValue([]);

    const result = await runQuery(b, { query: '审批流程' });

    expect(typeof result.warning).toBe('string');
    expect(result.warning).toMatch(/GITNEXUS_FTS_CJK_SEGMENTATION=bigram/);
  });

  it('does not warn for a plain-ASCII query', async () => {
    const b = makeBackend(true);
    executeParameterizedMock.mockResolvedValue([]);

    const result = await runQuery(b, { query: 'approve request' });

    expect(result.warning).toBeUndefined();
  });

  it('a valid GITNEXUS_FTS_CJK_SEGMENTATION value does not log via logQueryError', async () => {
    const cap: LoggerCapture = _captureLogger();
    try {
      const b = makeBackend(true);
      executeParameterizedMock.mockResolvedValue([]);

      await runQuery(b, { query: '审批流程' });

      expect(cap.records().some((r) => r.context === 'query:cjk-warning')).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it('an invalid GITNEXUS_FTS_CJK_SEGMENTATION value is logged via logQueryError, not silently swallowed', async () => {
    // The MCP query path never calls initialiseSearchFTSCjkSegmentation(), so
    // getSearchFTSCjkSegmentation() re-resolves from env on every call here —
    // no module-cache priming needed for this to throw.
    vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'not-a-real-mode');
    const cap: LoggerCapture = _captureLogger();
    try {
      const b = makeBackend(true);
      executeParameterizedMock.mockResolvedValue([]);

      const result = await runQuery(b, { query: '审批流程' });

      // The throw is caught and logged — the query itself must still succeed.
      expect(result).not.toHaveProperty('error');
      const record = cap.records().find((r) => r.context === 'query:cjk-warning');
      expect(record).toBeDefined();
      expect(record!.msg).toBe('GitNexus query failed (degraded)');
    } finally {
      cap.restore();
    }
  });
});
