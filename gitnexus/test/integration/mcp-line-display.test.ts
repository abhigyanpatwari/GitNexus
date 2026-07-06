/**
 * Integration test: MCP tools present 1-based line numbers (#2377), while raw
 * `cypher` returns the stored 0-based value unchanged.
 *
 * GraphNode startLine/endLine are stored 0-based (the tree-sitter convention;
 * see ingestion/utils/line-base.ts). Human/LLM-facing tools (context, query,
 * impact) add 1 at the response boundary so the numbers line up with editors /
 * `sed`; the raw `cypher` passthrough stays 0-based and is documented.
 *
 * One shared LadybugDB (with FTS) backs every case so query()'s BM25 path is
 * exercised without a second full DB+FTS setup.
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
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

// Stored 0-based: App occupies 0-based lines 41..58 (editor lines 42..59).
// TopFn sits on the file's first line (stored 0-based 0) — the #2380 falsy-`||`
// case where `sym.startLine || sym[4]` would drop the line entirely.
// Two DupFn symbols force impact()'s ambiguous branch, the only impact response
// that surfaces a per-candidate line. Zqxwvbm carries a distinctive content
// token so query()'s BM25/FTS retriever surfaces it (the #2380 P1 path).
const SEED = [
  `CREATE (c:Class {id:'Class:src/app.ts:App', name:'App', filePath:'src/app.ts', startLine:41, endLine:58, content:'class App {}', description:''})`,
  `CREATE (c:Class {id:'Class:src/top.ts:TopFn', name:'TopFn', filePath:'src/top.ts', startLine:0, endLine:0, content:'class TopFn {}', description:''})`,
  `CREATE (f:Function {id:'Function:src/a.ts:DupFn', name:'DupFn', filePath:'src/a.ts', startLine:41, endLine:50, content:'function DupFn() {}', description:''})`,
  `CREATE (f:Function {id:'Function:src/b.ts:DupFn', name:'DupFn', filePath:'src/b.ts', startLine:7, endLine:12, content:'function DupFn() {}', description:''})`,
  `CREATE (c:Class {id:'Class:src/svc.ts:Zqxwvbm', name:'Zqxwvbm', filePath:'src/svc.ts', startLine:41, endLine:58, content:'class Zqxwvbm zqxwvbmtoken', description:'zqxwvbmtoken service'})`,
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

      it('context() keeps a 0-based first-line symbol (startLine:0 -> 1, not dropped)', async () => {
        // Before #2380 the falsy `sym.startLine || sym[4]` collapsed a valid 0 to
        // undefined, so context() omitted startLine/endLine for first-line symbols
        // (every COBOL Module, markdown h1). `??` preserves the 0.
        const result = await backend.callTool('context', { uid: 'Class:src/top.ts:TopFn' });
        expect(result.status).toBe('found');
        expect(result.symbol.startLine).toBe(1); // stored 0-based 0 -> display 1
        expect(result.symbol.endLine).toBe(1);
      });

      it('impact() ambiguous candidates report 1-based line (stored 41 -> 42)', async () => {
        const result = await backend.callTool('impact', { target: 'DupFn' });
        expect(result.status).toBe('ambiguous');
        const cand = (result.candidates as Array<{ filePath: string; line: number }>).find(
          (c) => c.filePath === 'src/a.ts',
        );
        expect(cand).toBeDefined();
        expect(cand!.line).toBe(42); // stored 0-based 41 -> display 42
      });

      it('query() BM25 path converts the line exactly once (stored 41 -> 42, not 43)', async () => {
        // bm25Search returns raw 0-based rows; query()'s aggregation applies
        // toDisplayLine once. Before #2380 both converted -> 43 (#2380 P1).
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
          stats: { files: 1, nodes: 5, communities: 0, processes: 0 },
        },
      ]);
      backend = new LocalBackend();
      await backend.init();
    },
  },
);
