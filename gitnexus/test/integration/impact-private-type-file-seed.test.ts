import { beforeAll, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

// #3602 repro 2: `src/lib/svc.ts` declares a module-private interface `Entry`,
// used by `parse`, which `verify` (the file's only export) calls. Eight route
// files import `verify`. The owning-file seed (#480) turned those eight
// importers into direct dependants of `Entry`, a name none of them can reach.
const ROUTE_COUNT = 8;
const routeFiles = Array.from(
  { length: ROUTE_COUNT },
  (_, index) =>
    `CREATE (f:File {id: 'File:src/app/v${index}/route.ts', name: 'route.ts', filePath: 'src/app/v${index}/route.ts', content: ''})`,
);
const routeImports = Array.from(
  { length: ROUTE_COUNT },
  (_, index) =>
    `MATCH (a:File {id:'File:src/app/v${index}/route.ts'}), (b:File {id:'File:src/lib/svc.ts'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:1.0, reason:'import', step:0}]->(b)`,
);

const SEED = [
  `CREATE (f:File {id: 'File:src/lib/svc.ts', name: 'svc.ts', filePath: 'src/lib/svc.ts', content: ''})`,
  ...routeFiles,
  ...routeImports,
  // Module-private: a recorded `false` verdict.
  `CREATE (i:Interface {id: 'Interface:src/lib/svc.ts:Entry', name: 'Entry', filePath: 'src/lib/svc.ts', startLine: 1, endLine: 3, isExported: false, content: '', description: ''})`,
  // Exported sibling in the same file: the file seed must stay for it.
  `CREATE (i:Interface {id: 'Interface:src/lib/svc.ts:Options', name: 'Options', filePath: 'src/lib/svc.ts', startLine: 4, endLine: 6, isExported: true, content: '', description: ''})`,
  // No verdict at all (NULL): the seed stays, as before.
  `CREATE (i:Interface {id: 'Interface:src/lib/svc.ts:Legacy', name: 'Legacy', filePath: 'src/lib/svc.ts', startLine: 7, endLine: 9, content: '', description: ''})`,
  `CREATE (fn:Function {id: 'Function:src/lib/svc.ts:parse', name: 'parse', filePath: 'src/lib/svc.ts', startLine: 10, endLine: 12, isExported: false, content: '', description: ''})`,
  `CREATE (fn:Function {id: 'Function:src/lib/svc.ts:verify', name: 'verify', filePath: 'src/lib/svc.ts', startLine: 13, endLine: 15, isExported: true, content: '', description: ''})`,
  ...['Entry', 'Options', 'Legacy'].map(
    (name) =>
      `MATCH (f:File {id:'File:src/lib/svc.ts'}), (i:Interface {id:'Interface:src/lib/svc.ts:${name}'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(i)`,
  ),
  `MATCH (a:Function {id:'Function:src/lib/svc.ts:parse'}), (b:Interface {id:'Interface:src/lib/svc.ts:Entry'}) CREATE (a)-[:CodeRelation {type:'USES', confidence:1.0, reason:'type-reference', step:0}]->(b)`,
  `MATCH (a:Function {id:'Function:src/lib/svc.ts:verify'}), (b:Function {id:'Function:src/lib/svc.ts:parse'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:1.0, reason:'direct', step:0}]->(b)`,
];

type BackendHandle = IndexedDBHandle & { _backend?: LocalBackend };

type ImpactByDepth = { byDepth?: Record<number, Array<{ id?: unknown }>> };

const ids = (result: ImpactByDepth, depth: number): string[] =>
  (result.byDepth?.[depth] ?? []).map((item) => String(item.id)).sort();

withTestLbugDB(
  'impact-private-type-file-seed',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      const ext = handle as BackendHandle;
      if (!ext._backend) throw new Error('LocalBackend not initialized');
      backend = ext._backend;
    });

    it('does not report the importers of the file as direct dependants of a module-private interface', async () => {
      const result = await backend.callTool('impact', {
        target: 'Entry',
        kind: 'Interface',
        direction: 'upstream',
      });

      expect(result.target.id).toBe('Interface:src/lib/svc.ts:Entry');
      expect(ids(result, 1)).toEqual(['Function:src/lib/svc.ts:parse']);
      expect(ids(result, 2)).toEqual(['Function:src/lib/svc.ts:verify']);
      expect(result.impactedCount).toBe(2);
      expect(result.summary.direct).toBe(1);
      expect(result.risk).toBe('LOW');
    });

    it('keeps the file seed for an exported interface of the same file', async () => {
      const result = await backend.callTool('impact', {
        target: 'Options',
        kind: 'Interface',
        direction: 'upstream',
      });

      expect(ids(result, 1)).toEqual(
        Array.from({ length: ROUTE_COUNT }, (_, index) => `File:src/app/v${index}/route.ts`).sort(),
      );
      expect(result.impactedCount).toBe(ROUTE_COUNT);
    });

    it('keeps the file seed when the index recorded no export verdict', async () => {
      const result = await backend.callTool('impact', {
        target: 'Legacy',
        kind: 'Interface',
        direction: 'upstream',
      });

      expect(result.impactedCount).toBe(ROUTE_COUNT);
      expect(ids(result, 1).every((id) => id.startsWith('File:src/app/'))).toBe(true);
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
          stats: { files: ROUTE_COUNT + 1, nodes: ROUTE_COUNT + 6, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as BackendHandle)._backend = backend;
    },
  },
);
