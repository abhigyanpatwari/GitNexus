/**
 * WI-3 / WI-4 / WI-5 Unit Tests: Non-code File node filtering
 *
 * Tests that query(), detectChanges(), bm25Search(), and semanticSearch()
 * filter out File nodes where fileType !== 'code', while preserving
 * backward compatibility (null/undefined fileType → keep).
 *
 * Design: Mock executeParameterized and bm25/embedding layers to return
 * controlled data, then verify the output excludes non-code File nodes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must come before LocalBackend import) ──────────────────────

const mockExecuteParameterized = vi.fn().mockResolvedValue([]);
const mockExecuteQuery = vi.fn().mockResolvedValue([]);
const mockSearchFTS = vi.fn().mockResolvedValue([]);
const mockEmbedQuery = vi.fn().mockResolvedValue([]);
const mockGetEmbeddingDims = vi.fn().mockReturnValue(384);

vi.mock('../../src/mcp/core/lbug-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  executeQuery: (...args: any[]) => mockExecuteQuery(...args),
  executeParameterized: (...args: any[]) => mockExecuteParameterized(...args),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  isLbugReady: vi.fn().mockReturnValue(true),
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: (...args: any[]) => mockSearchFTS(...args),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: (...args: any[]) => mockEmbedQuery(...args),
  getEmbeddingDims: (...args: any[]) => mockGetEmbeddingDims(...args),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const MOCK_REPO = {
  id: 'test-project',
  name: 'test-project',
  repoPath: '/tmp/test-project',
  storagePath: '/tmp/.gitnexus/test-project',
  lbugPath: '/tmp/.gitnexus/test-project/kuzu.db',
  indexedAt: '2024-06-01T12:00:00Z',
  lastCommit: 'abc123',
  stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
};

async function createBackend(): Promise<LocalBackend> {
  const backend = new LocalBackend();
  const { listRegisteredRepos } = await import('../../src/storage/repo-manager.js');
  (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO]);
  await backend.init();
  return backend;
}

// ── WI-3: query() — non-code File filtering in definitions ──────────

describe('WI-3: query() non-code File filtering', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSearchFTS.mockResolvedValue([]);
    mockEmbedQuery.mockResolvedValue([]);
    mockExecuteQuery.mockResolvedValue([]);
    backend = await createBackend();
  });

  it('filters out File definitions with fileType=documentation', async () => {
    mockSearchFTS.mockResolvedValue([
      { filePath: 'src/utils.ts', score: 0.9 },
      { filePath: 'README.md', score: 0.8 },
    ]);
    mockExecuteQuery.mockResolvedValue([]);

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, params?: any) => {
        if (query.includes('n.filePath = $filePath') && params?.filePath === 'src/utils.ts') {
          return [{ id: 'Function:src/utils.ts:parse', name: 'parse', type: 'Function', filePath: 'src/utils.ts', startLine: 10, endLine: 20 }];
        }
        if (query.includes('n.filePath = $filePath') && params?.filePath === 'README.md') {
          return [{ id: 'File:README.md', name: 'README', type: 'File', filePath: 'README.md', startLine: null, endLine: null }];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        if (query.includes('MEMBER_OF')) return [];
        if (query.includes('n.fileType')) {
          return [{ filePath: 'README.md', fileType: 'documentation' }];
        }
        return [];
      });

    const result = await backend.callTool('query', { query: 'parse' });
    const fileDefs = (result as any).definitions?.filter((d: any) => d.type === 'File') ?? [];
    expect(fileDefs.every((d: any) => d.filePath !== 'README.md')).toBe(true);
  });

  it('keeps File definitions with fileType=code', async () => {
    mockSearchFTS.mockResolvedValue([{ filePath: 'main.ts', score: 0.9 }]);
    mockExecuteQuery.mockResolvedValue([]);

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, params?: any) => {
        if (query.includes('n.filePath = $filePath') && params?.filePath === 'main.ts') {
          return [{ id: 'File:main.ts', name: 'main', type: 'File', filePath: 'main.ts', startLine: null, endLine: null }];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        if (query.includes('MEMBER_OF')) return [];
        if (query.includes('n.fileType')) {
          return [{ filePath: 'main.ts', fileType: 'code' }];
        }
        return [];
      });

    const result = await backend.callTool('query', { query: 'main' });
    const fileDefs = (result as any).definitions?.filter((d: any) => d.type === 'File') ?? [];
    expect(fileDefs.some((d: any) => d.filePath === 'main.ts')).toBe(true);
  });

  it('keeps File definitions with null/undefined fileType (backward compat)', async () => {
    mockSearchFTS.mockResolvedValue([{ filePath: 'legacy.ts', score: 0.9 }]);
    mockExecuteQuery.mockResolvedValue([]);

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, params?: any) => {
        if (query.includes('n.filePath = $filePath') && params?.filePath === 'legacy.ts') {
          return [{ id: 'File:legacy.ts', name: 'legacy', type: 'File', filePath: 'legacy.ts', startLine: null, endLine: null }];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        if (query.includes('MEMBER_OF')) return [];
        if (query.includes('n.fileType')) {
          return [{ filePath: 'legacy.ts', fileType: null }];
        }
        return [];
      });

    const result = await backend.callTool('query', { query: 'legacy' });
    const fileDefs = (result as any).definitions?.filter((d: any) => d.type === 'File') ?? [];
    expect(fileDefs.some((d: any) => d.filePath === 'legacy.ts')).toBe(true);
  });
});

// ── WI-4: detectChanges() — non-code File filtering ──────────────────

describe('WI-4: detectChanges() non-code File filtering', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecuteQuery.mockResolvedValue([]);
    mockExecuteParameterized.mockResolvedValue([]);
    backend = await createBackend();
  });

  it('filters out File nodes with fileType=config', async () => {
    const { execFileSync } = await import('child_process');
    (execFileSync as any).mockReturnValue(
      'diff --git a/app.yml b/app.yml\nindex abc..def 100644\n--- a/app.yml\n+++ b/app.yml\n@@ -1 +1 @@\n-old\n+new\n'
    );

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, _params?: any) => {
        if (query.includes('n.filePath CONTAINS $filePath')) {
          return [
            { id: 'File:config/app.yml', name: 'app.yml', type: 'File', filePath: 'config/app.yml', fileType: 'config' },
            { id: 'Function:src/utils.ts:parse', name: 'parse', type: 'Function', filePath: 'src/utils.ts', fileType: null },
          ];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        return [];
      });

    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    const symbols = (result as any).changed_symbols ?? [];
    const fileSymbols = symbols.filter((s: any) => s.type === 'File');
    expect(fileSymbols.every((s: any) => s.filePath !== 'config/app.yml')).toBe(true);
    expect(symbols.some((s: any) => s.name === 'parse')).toBe(true);
  });

  it('keeps File nodes with fileType=code', async () => {
    const { execFileSync } = await import('child_process');
    (execFileSync as any).mockReturnValue(
      'diff --git a/main.ts b/main.ts\nindex abc..def 100644\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new\n'
    );

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, _params?: any) => {
        if (query.includes('n.filePath CONTAINS $filePath')) {
          return [{ id: 'File:main.ts', name: 'main.ts', type: 'File', filePath: 'main.ts', fileType: 'code' }];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        return [];
      });

    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    const symbols = (result as any).changed_symbols ?? [];
    expect(symbols.some((s: any) => s.type === 'File' && s.filePath === 'main.ts')).toBe(true);
  });

  it('keeps File nodes with null fileType (backward compat)', async () => {
    const { execFileSync } = await import('child_process');
    (execFileSync as any).mockReturnValue(
      'diff --git a/legacy.ts b/legacy.ts\nindex abc..def 100644\n--- a/legacy.ts\n+++ b/legacy.ts\n@@ -1 +1 @@\n-old\n+new\n'
    );

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, _params?: any) => {
        if (query.includes('n.filePath CONTAINS $filePath')) {
          return [{ id: 'File:legacy.ts', name: 'legacy.ts', type: 'File', filePath: 'legacy.ts', fileType: null }];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        return [];
      });

    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    const symbols = (result as any).changed_symbols ?? [];
    expect(symbols.some((s: any) => s.type === 'File' && s.filePath === 'legacy.ts')).toBe(true);
  });
});

// ── WI-5a: bm25Search() — non-code File filtering ────────────────────

describe('WI-5a: bm25Search() non-code File filtering', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecuteQuery.mockResolvedValue([]);
    mockEmbedQuery.mockResolvedValue([]);
    backend = await createBackend();
  });

  it('skips bm25Result when all symbols are non-code File nodes', async () => {
    mockSearchFTS.mockResolvedValue([
      { filePath: 'config/settings.yml', score: 0.9 },
      { filePath: 'src/app.ts', score: 0.8 },
    ]);

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, params?: any) => {
        if (query.includes('n.filePath = $filePath') && params?.filePath === 'config/settings.yml') {
          return [{ id: 'File:config/settings.yml', name: 'settings.yml', type: 'File', filePath: 'config/settings.yml', startLine: null, endLine: null, fileType: 'config' }];
        }
        if (query.includes('n.filePath = $filePath') && params?.filePath === 'src/app.ts') {
          return [{ id: 'Function:src/app.ts:main', name: 'main', type: 'Function', filePath: 'src/app.ts', startLine: 1, endLine: 10, fileType: null }];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        if (query.includes('MEMBER_OF')) return [];
        if (query.includes('n.fileType')) return [];
        return [];
      });

    const result = await backend.callTool('query', { query: 'settings' });
    const allSymbols = [
      ...(result as any).process_symbols ?? [],
      ...(result as any).definitions ?? [],
    ];
    expect(allSymbols.every((s: any) => s.filePath !== 'config/settings.yml')).toBe(true);
  });

  it('keeps code symbols from mixed results (code + non-code File)', async () => {
    mockSearchFTS.mockResolvedValue([{ filePath: 'src/app.ts', score: 0.9 }]);
    mockExecuteQuery.mockResolvedValue([]);

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, params?: any) => {
        if (query.includes('n.filePath = $filePath') && params?.filePath === 'src/app.ts') {
          return [
            { id: 'Function:src/app.ts:main', name: 'main', type: 'Function', filePath: 'src/app.ts', startLine: 1, endLine: 10, fileType: null },
            { id: 'File:src/app.ts', name: 'app.ts', type: 'File', filePath: 'src/app.ts', startLine: null, endLine: null, fileType: 'code' },
          ];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        if (query.includes('MEMBER_OF')) return [];
        return [];
      });

    const result = await backend.callTool('query', { query: 'main' });
    const allSymbols = [
      ...(result as any).process_symbols ?? [],
      ...(result as any).definitions ?? [],
    ];
    expect(allSymbols.some((s: any) => s.name === 'main' && s.type === 'Function')).toBe(true);
  });
});

// ── WI-5b: semanticSearch() — non-code File filtering ────────────────

describe('WI-5b: semanticSearch() non-code File filtering', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSearchFTS.mockResolvedValue([]);
    mockGetEmbeddingDims.mockReturnValue(384);
    mockEmbedQuery.mockResolvedValue(new Array(384).fill(0.1));
    mockExecuteQuery.mockResolvedValue([]);
    mockExecuteParameterized.mockResolvedValue([]);
    backend = await createBackend();
  });

  it('skips File nodes with fileType=documentation in semantic search', async () => {
    mockExecuteQuery.mockImplementation(async (_repoId: string, query: string) => {
      if (query.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (query.includes('QUERY_VECTOR_INDEX')) return [{ nodeId: 'File:README.md', distance: 0.3 }];
      return [];
    });

    mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string, params?: any) => {
      // Batch fileType lookup
      if (query.includes('n.id IN $nodeIds') && query.includes('n.fileType')) {
        return [{ nodeId: 'File:README.md', fileType: 'documentation' }];
      }
      // Node detail lookup
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'File:README.md') {
        return [{ name: 'README', filePath: 'README.md' }];
      }
      return [];
    });

    const results = await (backend as any).semanticSearch(MOCK_REPO, 'readme documentation', 5);
    expect(results.every((r: any) => r.nodeId !== 'File:README.md')).toBe(true);
  });

  it('keeps File nodes with fileType=code in semantic search', async () => {
    // Test via query() with BM25 to verify code files pass through the
    // same fileType filtering logic used by semanticSearch.
    // The condition `if (fileType && fileType !== 'code') continue`
    // evaluates to `if ('code' && false) continue` => false, so the node is kept.
    mockSearchFTS.mockResolvedValue([{ filePath: 'src/main.ts', score: 0.9 }]);
    mockExecuteQuery.mockResolvedValue([]);

    mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string, params?: any) => {
      if (query.includes('n.filePath = $filePath') && params?.filePath === 'src/main.ts') {
        return [{ id: 'File:src/main.ts', name: 'main.ts', type: 'File', filePath: 'src/main.ts', startLine: null, endLine: null, fileType: 'code' }];
      }
      if (query.includes('STEP_IN_PROCESS')) return [];
      if (query.includes('MEMBER_OF')) return [];
      if (query.includes('n.fileType') && query.includes('n.filePath')) {
        return [{ filePath: 'src/main.ts', fileType: 'code' }];
      }
      return [];
    });

    const result = await backend.callTool('query', { query: 'main' });
    const definitions = (result as any).definitions ?? [];
    expect(definitions.some((d: any) => d.filePath === 'src/main.ts' && d.type === 'File')).toBe(true);
  });

  it('keeps File nodes with null fileType in semantic search (backward compat)', async () => {
    // Test null fileType backward compat via query() with BM25.
    // The condition `if (fileType && fileType !== 'code') continue`
    // evaluates to `if (null && ...) continue` => false, so the node is kept.
    mockSearchFTS.mockResolvedValue([{ filePath: 'src/legacy.ts', score: 0.9 }]);
    mockExecuteQuery.mockResolvedValue([]);

    mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string, params?: any) => {
      if (query.includes('n.filePath = $filePath') && params?.filePath === 'src/legacy.ts') {
        return [{ id: 'File:src/legacy.ts', name: 'legacy.ts', type: 'File', filePath: 'src/legacy.ts', startLine: null, endLine: null, fileType: null }];
      }
      if (query.includes('STEP_IN_PROCESS')) return [];
      if (query.includes('MEMBER_OF')) return [];
      if (query.includes('n.fileType') && query.includes('n.filePath')) {
        return [{ filePath: 'src/legacy.ts', fileType: null }];
      }
      return [];
    });

    const result = await backend.callTool('query', { query: 'legacy' });
    const definitions = (result as any).definitions ?? [];
    expect(definitions.some((d: any) => d.filePath === 'src/legacy.ts' && d.type === 'File')).toBe(true);
  });
});

// ── Edge case: LadybugDB array-format results ─────────────────────────

describe('Non-code filtering with LadybugDB array-format results', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSearchFTS.mockResolvedValue([]);
    mockExecuteQuery.mockResolvedValue([]);
    backend = await createBackend();
  });

  it('WI-3: handles array-format fileType rows in query()', async () => {
    mockSearchFTS.mockResolvedValue([{ filePath: 'docs/guide.md', score: 0.9 }]);

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, params?: any) => {
        if (query.includes('n.filePath = $filePath') && params?.filePath === 'docs/guide.md') {
          return [['File:docs/guide.md', 'guide', 'File', 'docs/guide.md', null, null]];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        if (query.includes('MEMBER_OF')) return [];
        if (query.includes('n.fileType')) {
          return [['docs/guide.md', 'documentation']];
        }
        return [];
      });

    const result = await backend.callTool('query', { query: 'guide' });
    const fileDefs = (result as any).definitions?.filter((d: any) => d.type === 'File') ?? [];
    expect(fileDefs.every((d: any) => d.filePath !== 'docs/guide.md')).toBe(true);
  });

  it('WI-4: handles array-format fileType in detectChanges()', async () => {
    const { execFileSync } = await import('child_process');
    (execFileSync as any).mockReturnValue(
      'diff --git a/config.yml b/config.yml\nindex abc..def 100644\n--- a/config.yml\n+++ b/config.yml\n@@ -1 +1 @@\n-old\n+new\n'
    );

    mockExecuteParameterized
      .mockImplementation(async (_repoId: string, query: string, _params?: any) => {
        if (query.includes('n.filePath CONTAINS $filePath')) {
          return [['File:config.yml', 'config.yml', 'File', 'config.yml', 'config']];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        return [];
      });

    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    const symbols = (result as any).changed_symbols ?? [];
    expect(symbols.every((s: any) => s.filePath !== 'config.yml')).toBe(true);
  });
});

// ── semanticSearch filtering (direct, not via query()) ────────────────

describe('semanticSearch filtering', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSearchFTS.mockResolvedValue([]);
    mockGetEmbeddingDims.mockReturnValue(384);
    mockEmbedQuery.mockResolvedValue(new Array(384).fill(0.1));
    mockExecuteQuery.mockResolvedValue([]);
    mockExecuteParameterized.mockResolvedValue([]);
    backend = await createBackend();
  });

  it('filters out non-code File nodes via batch lookup', async () => {
    mockExecuteQuery.mockImplementation(async (_repoId: string, query: string) => {
      if (query.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (query.includes('QUERY_VECTOR_INDEX')) {
        return [
          { nodeId: 'File:README.md', distance: 0.3 },
          { nodeId: 'Function:src/app.ts:main', distance: 0.35 },
          { nodeId: 'File:config/settings.yml', distance: 0.4 },
        ];
      }
      return [];
    });

    mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string, params?: any) => {
      // Batch fileType lookup — mark README.md and settings.yml as non-code
      if (query.includes('n.id IN $nodeIds') && query.includes('n.fileType')) {
        return [
          { nodeId: 'File:README.md', fileType: 'documentation' },
          { nodeId: 'File:config/settings.yml', fileType: 'config' },
        ];
      }
      // Node detail lookups
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'File:README.md') {
        return [{ name: 'README', filePath: 'README.md' }];
      }
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'File:config/settings.yml') {
        return [{ name: 'settings', filePath: 'config/settings.yml' }];
      }
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'Function:src/app.ts:main') {
        return [{ name: 'main', filePath: 'src/app.ts', startLine: 1, endLine: 10 }];
      }
      return [];
    });

    const results = await (backend as any).semanticSearch(MOCK_REPO, 'readme config', 5);

    // Non-code File nodes should be filtered out
    expect(results.every((r: any) => r.nodeId !== 'File:README.md')).toBe(true);
    expect(results.every((r: any) => r.nodeId !== 'File:config/settings.yml')).toBe(true);
    // Code symbols should pass through
    expect(results.some((r: any) => r.nodeId === 'Function:src/app.ts:main')).toBe(true);
  });

  it('keeps File nodes with fileType=code', async () => {
    mockExecuteQuery.mockImplementation(async (_repoId: string, query: string) => {
      if (query.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (query.includes('QUERY_VECTOR_INDEX')) {
        return [{ nodeId: 'File:src/main.ts', distance: 0.25 }];
      }
      return [];
    });

    mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string, params?: any) => {
      if (query.includes('n.id IN $nodeIds') && query.includes('n.fileType')) {
        return [{ nodeId: 'File:src/main.ts', fileType: 'code' }];
      }
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'File:src/main.ts') {
        return [{ name: 'main.ts', filePath: 'src/main.ts' }];
      }
      return [];
    });

    const results = await (backend as any).semanticSearch(MOCK_REPO, 'main entry', 5);
    expect(results.some((r: any) => r.nodeId === 'File:src/main.ts')).toBe(true);
  });

  it('keeps File nodes with null fileType (backward compat)', async () => {
    mockExecuteQuery.mockImplementation(async (_repoId: string, query: string) => {
      if (query.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (query.includes('QUERY_VECTOR_INDEX')) {
        return [{ nodeId: 'File:src/legacy.ts', distance: 0.3 }];
      }
      return [];
    });

    mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string, params?: any) => {
      // Batch fileType lookup returns null fileType — should be kept
      if (query.includes('n.id IN $nodeIds') && query.includes('n.fileType')) {
        return [{ nodeId: 'File:src/legacy.ts', fileType: null }];
      }
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'File:src/legacy.ts') {
        return [{ name: 'legacy.ts', filePath: 'src/legacy.ts' }];
      }
      return [];
    });

    const results = await (backend as any).semanticSearch(MOCK_REPO, 'legacy', 5);
    expect(results.some((r: any) => r.nodeId === 'File:src/legacy.ts')).toBe(true);
  });

  it('handles LadybugDB array-format results from batch lookup', async () => {
    mockExecuteQuery.mockImplementation(async (_repoId: string, query: string) => {
      if (query.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (query.includes('QUERY_VECTOR_INDEX')) {
        return [
          { nodeId: 'File:docs/guide.md', distance: 0.3 },
          { nodeId: 'File:src/app.ts', distance: 0.35 },
        ];
      }
      return [];
    });

    mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string, params?: any) => {
      // Batch lookup returns array-format rows [nodeId, fileType]
      if (query.includes('n.id IN $nodeIds') && query.includes('n.fileType')) {
        return [
          ['File:docs/guide.md', 'documentation'],
          ['File:src/app.ts', 'code'],
        ];
      }
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'File:docs/guide.md') {
        return [['guide', 'docs/guide.md']];
      }
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'File:src/app.ts') {
        return [['app', 'src/app.ts']];
      }
      return [];
    });

    const results = await (backend as any).semanticSearch(MOCK_REPO, 'guide app', 5);
    // Non-code file should be filtered
    expect(results.every((r: any) => r.nodeId !== 'File:docs/guide.md')).toBe(true);
    // Code file should be kept
    expect(results.some((r: any) => r.nodeId === 'File:src/app.ts')).toBe(true);
  });

  it('skips batch filter when no File nodes in results', async () => {
    mockExecuteQuery.mockImplementation(async (_repoId: string, query: string) => {
      if (query.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (query.includes('QUERY_VECTOR_INDEX')) {
        return [{ nodeId: 'Function:src/app.ts:main', distance: 0.35 }];
      }
      return [];
    });

    mockExecuteParameterized.mockImplementation(async (_repoId: string, query: string, params?: any) => {
      // The batch fileType query should NOT be called since there are no File nodes
      if (query.includes('n.id IN $nodeIds') && query.includes('n.fileType')) {
        throw new Error('Batch fileType query should not be called when no File nodes exist');
      }
      if (query.includes('{id: $nodeId}') && params?.nodeId === 'Function:src/app.ts:main') {
        return [{ name: 'main', filePath: 'src/app.ts', startLine: 1, endLine: 10 }];
      }
      return [];
    });

    const results = await (backend as any).semanticSearch(MOCK_REPO, 'main function', 5);
    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe('Function:src/app.ts:main');
  });
});

// ── Issue #51: CLAUDE.md / AGENTS.md regression guard ─────────────────
//
// PR #103 (commit ef41fc0) added a filter in detectChanges() at
// local-backend.ts:1902-1903:
//   if (type === 'File' && fileType && fileType !== 'code') continue;
//
// This block asserts the canonical non-code files of interest (CLAUDE.md and
// AGENTS.md — both classified as `documentation` by getFileType()) are still
// filtered out of changed_symbols. A future refactor that drops the filter
// will break this test.

describe('Issue #51: CLAUDE.md / AGENTS.md filter in detectChanges()', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecuteQuery.mockResolvedValue([]);
    mockExecuteParameterized.mockResolvedValue([]);
    backend = await createBackend();
  });

  it('filters out CLAUDE.md and AGENTS.md File nodes (fileType=documentation)', async () => {
    const { execFileSync } = await import('child_process');
    // Simulate a dirty tree containing CLAUDE.md, AGENTS.md, and a real code file
    (execFileSync as any).mockReturnValue(
      [
        'CLAUDE.md',
        'AGENTS.md',
        'src/feature.ts',
      ].join('\n')
    );

    mockExecuteParameterized.mockImplementation(
      async (_repoId: string, query: string, _params?: any) => {
        if (query.includes('n.filePath CONTAINS $filePath')) {
          return [
            { id: 'File:CLAUDE.md', name: 'CLAUDE.md', type: 'File', filePath: 'CLAUDE.md', fileType: 'documentation' },
            { id: 'File:AGENTS.md', name: 'AGENTS.md', type: 'File', filePath: 'AGENTS.md', fileType: 'documentation' },
            { id: 'Function:src/feature.ts:doWork', name: 'doWork', type: 'Function', filePath: 'src/feature.ts', fileType: null },
          ];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        return [];
      }
    );

    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    const symbols = (result as any).changed_symbols ?? [];

    // The two canonical non-code files must be filtered out
    expect(symbols.some((s: any) => s.filePath === 'CLAUDE.md')).toBe(false);
    expect(symbols.some((s: any) => s.filePath === 'AGENTS.md')).toBe(false);
    // No File node for either may survive
    const fileSymbols = symbols.filter((s: any) => s.type === 'File');
    expect(fileSymbols.some((s: any) => s.filePath === 'CLAUDE.md')).toBe(false);
    expect(fileSymbols.some((s: any) => s.filePath === 'AGENTS.md')).toBe(false);
    // The legitimate code symbol passes through
    expect(symbols.some((s: any) => s.name === 'doWork' && s.type === 'Function')).toBe(true);
  });

  it('names CLAUDE.md and AGENTS.md explicitly in the exclusion contract', async () => {
    // Sentinel test: a future maintainer who removes the filter
    // (e.g. by changing the predicate to `fileType !== 'code' && fileType !== 'documentation'`)
    // will trip the per-file check at the bottom of this test. The test name and
    // the strings below are the contract.
    const canonicalNonCodeFiles = ['CLAUDE.md', 'AGENTS.md'];

    const { execFileSync } = await import('child_process');
    (execFileSync as any).mockReturnValue(
      [
        'CLAUDE.md',
        'AGENTS.md',
      ].join('\n')
    );

    mockExecuteParameterized.mockImplementation(
      async (_repoId: string, query: string, _params?: any) => {
        if (query.includes('n.filePath CONTAINS $filePath')) {
          return [
            { id: 'File:CLAUDE.md', name: 'CLAUDE.md', type: 'File', filePath: 'CLAUDE.md', fileType: 'documentation' },
            { id: 'File:AGENTS.md', name: 'AGENTS.md', type: 'File', filePath: 'AGENTS.md', fileType: 'documentation' },
          ];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        return [];
      }
    );

    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    const symbols = (result as any).changed_symbols ?? [];

    for (const filePath of canonicalNonCodeFiles) {
      expect(symbols.some((s: any) => s.filePath === filePath)).toBe(false);
    }
    expect(symbols.length).toBe(0);
  });
});