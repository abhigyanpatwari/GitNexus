/**
 * Integration test: MCP tools present 1-based line numbers (#2377), while raw
 * `cypher` returns the stored 0-based value unchanged.
 *
 * GraphNode startLine/endLine are stored 0-based (the tree-sitter convention;
 * see ingestion/utils/line-base.ts). Human/LLM-facing tools (context, query,
 * impact) add 1 at the response boundary so the numbers line up with editors /
 * `sed`; the raw `cypher` passthrough stays 0-based and is documented.
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';

const PRODUCTION_FTS_INDEXES = FTS_INDEXES.map((i) => ({
  table: i.table,
  indexName: i.indexName,
  columns: [...i.properties],
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
  };
});

// Stored 0-based: this Class occupies 0-based lines 41..58 (editor lines 42..59).
const SEED = [
  `CREATE (c:Class {id:'Class:src/app.ts:App', name:'App', filePath:'src/app.ts', startLine:41, endLine:58, content:'class App {}', description:''})`,
];

let backend: LocalBackend;

withTestLbugDB(
  'mcp-line-display',
  () => {
    describe('MCP line-number display (#2377): tools 1-based, raw cypher 0-based', () => {
      it('context() reports 1-based startLine/endLine (editor / sed aligned)', async () => {
        const result = await backend.callTool('context', { uid: 'Class:src/app.ts:App' });
        expect(result.status).toBe('found');
        expect(result.symbol.startLine).toBe(42); // stored 0-based 41 -> display 42
        expect(result.symbol.endLine).toBe(59); // stored 0-based 58 -> display 59
      });

      it('raw cypher returns the stored 0-based value unchanged', async () => {
        const result = await backend.callTool('cypher', {
          statement: "MATCH (n:Class {name:'App'}) RETURN n.startLine AS startLine",
        });
        expect(result).toHaveProperty('markdown');
        // If display-conversion leaked into raw cypher this would read 42.
        expect(result.markdown).toContain('41');
        expect(result.markdown).not.toContain('42');
      });
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 1, nodes: 1, communities: 0, processes: 0 },
        },
      ]);
      backend = new LocalBackend();
      await backend.init();
    },
  },
);

// #2380 P1: `query()` must convert the line EXACTLY once. `bm25Search` returns
// raw 0-based rows and `query()`'s aggregation applies `toDisplayLine` once — a
// BM25-matched symbol stored 0-based 41 must read 42, not 43 (double-convert).
// A distinctive content token guarantees the BM25/FTS retriever surfaces it.
const SEED_BM25 = [
  `CREATE (c:Class {id:'Class:src/svc.ts:Zqxwvbm', name:'Zqxwvbm', filePath:'src/svc.ts', startLine:41, endLine:58, content:'class Zqxwvbm zqxwvbmtoken', description:'zqxwvbmtoken service'})`,
];

withTestLbugDB(
  'mcp-line-display-query-bm25',
  (handle) => {
    describe('query() BM25 path converts line numbers once (#2380 P1)', () => {
      it('reports stored 0-based 41 as 42 (single conversion, not 43)', async () => {
        const ext = handle as IndexedDBHandle & { _backend?: LocalBackend };
        const backend = ext._backend!;
        type QuerySymbol = { id: string; startLine?: number; endLine?: number };
        type QueryResult = { definitions?: QuerySymbol[]; process_symbols?: QuerySymbol[] };
        const result: QueryResult = await backend.callTool('query', { query: 'zqxwvbmtoken' });
        const sym = [...(result.process_symbols ?? []), ...(result.definitions ?? [])].find(
          (s) => s.id === 'Class:src/svc.ts:Zqxwvbm',
        );
        expect(sym).toBeDefined();
        expect(sym!.startLine).toBe(42); // 41 + 1, converted exactly once
        expect(sym!.endLine).toBe(59); // 58 + 1
      });
    });
  },
  {
    seed: SEED_BM25,
    ftsIndexes: PRODUCTION_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 1, nodes: 1, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as IndexedDBHandle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
