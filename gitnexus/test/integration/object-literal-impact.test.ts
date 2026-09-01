import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importActual) => ({
  ...(await importActual<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

type BackendHandle = IndexedDBHandle & { backend?: LocalBackend };

const FIRST = 'Const:src/convex.ts:first';
const SECOND = 'Const:src/convex.ts:second';
const THIRD = 'Variable:src/convex.ts:third';
const FIRST_HANDLER = 'Function:src/convex.ts:first.handler';
const SECOND_HANDLER = 'Function:src/convex.ts:second.handler';
const THIRD_HANDLER = 'Function:src/convex.ts:third.handler';
const HELPER_A = 'Function:src/convex.ts:helperA';
const HELPER_B = 'Function:src/convex.ts:helperB';
const HELPER_C = 'Function:src/convex.ts:helperC';
const SERVICE = 'Const:src/convex.ts:service';
const SERVICE_RUN = 'Method:src/convex.ts:service.run#0';
const HELPER_D = 'Function:src/convex.ts:helperD';

withTestLbugDB(
  'object-literal-impact-3041',
  (handle) => {
    describe('downstream impact through object-owned callables (#3041)', () => {
      let backend: LocalBackend;

      beforeAll(() => {
        const attached = (handle as BackendHandle).backend;
        if (!attached) throw new Error('LocalBackend was not attached during setup');
        backend = attached;
      });

      it.each([
        ['first', HELPER_A, HELPER_B],
        ['second', HELPER_B, HELPER_A],
      ])('%s reaches only its own helper', async (target, expected, excluded) => {
        const result = await backend.callTool('impact', {
          target,
          direction: 'downstream',
        });
        expect(result).not.toHaveProperty('error');
        const ids = Object.values(result.byDepth ?? {})
          .flatMap((entries) => entries as Array<{ id: string }>)
          .map((entry) => entry.id);
        expect(ids).toContain(expected);
        expect(ids).not.toContain(excluded);
      });

      it('a let binding reaches its owned handler calls', async () => {
        const result = await backend.callTool('impact', {
          target: 'third',
          direction: 'downstream',
        });
        expect(result).not.toHaveProperty('error');
        const ids = Object.values(result.byDepth ?? {})
          .flatMap((entries) => entries as Array<{ id: string }>)
          .map((entry) => entry.id);
        expect(ids).toContain(HELPER_C);
        expect(ids).not.toContain(HELPER_A);
        expect(ids).not.toContain(HELPER_B);
      });

      it('counts the implicit member as depth 1 and its callee as depth 2', async () => {
        const firstHop = await backend.callTool('impact', {
          target: 'first',
          direction: 'downstream',
          maxDepth: 1,
        });
        expect(firstHop.byDepth?.['1']?.map((entry: { id: string }) => entry.id)).toEqual([
          FIRST_HANDLER,
        ]);
        expect(firstHop.byDepth?.['2']).toBeUndefined();

        const secondHop = await backend.callTool('impact', {
          target: 'first',
          direction: 'downstream',
          maxDepth: 2,
        });
        expect(secondHop.byDepth?.['1']?.map((entry: { id: string }) => entry.id)).toEqual([
          FIRST_HANDLER,
        ]);
        expect(secondHop.byDepth?.['2']?.map((entry: { id: string }) => entry.id)).toContain(
          HELPER_A,
        );
        expect(secondHop.summary?.direct).toBe(1);
      });

      it('does not widen an explicit CALLS-only traversal through HAS_METHOD', async () => {
        const result = await backend.callTool('impact', {
          target: 'first',
          direction: 'downstream',
          relationTypes: ['CALLS'],
          maxDepth: 3,
        });

        expect(result.impactedCount).toBe(0);
        expect(result.byDepth).toEqual({});
      });

      it('enters a Method-labelled shorthand member on the default traversal', async () => {
        const result = await backend.callTool('impact', {
          target: 'service',
          direction: 'downstream',
          maxDepth: 2,
        });

        expect(result.byDepth?.['1']?.map((entry: { id: string }) => entry.id)).toEqual([
          SERVICE_RUN,
        ]);
        expect(result.byDepth?.['2']?.map((entry: { id: string }) => entry.id)).toEqual([HELPER_D]);
      });

      it('preserves explicit HAS_METHOD traversal depth', async () => {
        const firstHop = await backend.callTool('impact', {
          target: 'first',
          direction: 'downstream',
          maxDepth: 1,
          relationTypes: ['HAS_METHOD', 'CALLS'],
        });
        expect(firstHop).not.toHaveProperty('error');
        expect(firstHop.byDepth?.['1']?.map((entry: { id: string }) => entry.id)).toEqual([
          FIRST_HANDLER,
        ]);

        const secondHop = await backend.callTool('impact', {
          target: 'first',
          direction: 'downstream',
          maxDepth: 2,
          relationTypes: ['HAS_METHOD', 'CALLS'],
        });
        expect(secondHop).not.toHaveProperty('error');
        expect(secondHop.byDepth?.['2']?.map((entry: { id: string }) => entry.id)).toContain(
          HELPER_A,
        );
      });
    });
  },
  {
    seed: [
      `CREATE (:Const {id: '${FIRST}', name: 'first', filePath: 'src/convex.ts', startLine: 1, endLine: 1})`,
      `CREATE (:Const {id: '${SECOND}', name: 'second', filePath: 'src/convex.ts', startLine: 2, endLine: 2})`,
      `CREATE (:Variable {id: '${THIRD}', name: 'third', filePath: 'src/convex.ts', startLine: 3, endLine: 3})`,
      `CREATE (:Function {id: '${FIRST_HANDLER}', name: 'handler', filePath: 'src/convex.ts', startLine: 3, endLine: 3})`,
      `CREATE (:Function {id: '${SECOND_HANDLER}', name: 'handler', filePath: 'src/convex.ts', startLine: 4, endLine: 4})`,
      `CREATE (:Function {id: '${THIRD_HANDLER}', name: 'handler', filePath: 'src/convex.ts', startLine: 5, endLine: 5})`,
      `CREATE (:Function {id: '${HELPER_A}', name: 'helperA', filePath: 'src/convex.ts', startLine: 5, endLine: 5})`,
      `CREATE (:Function {id: '${HELPER_B}', name: 'helperB', filePath: 'src/convex.ts', startLine: 6, endLine: 6})`,
      `CREATE (:Function {id: '${HELPER_C}', name: 'helperC', filePath: 'src/convex.ts', startLine: 7, endLine: 7})`,
      `CREATE (:Const {id: '${SERVICE}', name: 'service', filePath: 'src/convex.ts', startLine: 8, endLine: 8})`,
      `CREATE (:Method {id: '${SERVICE_RUN}', name: 'run', filePath: 'src/convex.ts', startLine: 8, endLine: 8})`,
      `CREATE (:Function {id: '${HELPER_D}', name: 'helperD', filePath: 'src/convex.ts', startLine: 9, endLine: 9})`,
      `MATCH (a:Const), (b:Function) WHERE a.id = '${FIRST}' AND b.id = '${FIRST_HANDLER}' CREATE (a)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'object literal member'}]->(b)`,
      `MATCH (a:Const), (b:Function) WHERE a.id = '${SECOND}' AND b.id = '${SECOND_HANDLER}' CREATE (a)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'object literal member'}]->(b)`,
      `MATCH (a:Variable), (b:Function) WHERE a.id = '${THIRD}' AND b.id = '${THIRD_HANDLER}' CREATE (a)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'object literal member'}]->(b)`,
      `MATCH (a:Function), (b:Function) WHERE a.id = '${FIRST_HANDLER}' AND b.id = '${HELPER_A}' CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.85, reason: 'direct'}]->(b)`,
      `MATCH (a:Function), (b:Function) WHERE a.id = '${SECOND_HANDLER}' AND b.id = '${HELPER_B}' CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.85, reason: 'direct'}]->(b)`,
      `MATCH (a:Function), (b:Function) WHERE a.id = '${THIRD_HANDLER}' AND b.id = '${HELPER_C}' CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.85, reason: 'direct'}]->(b)`,
      `MATCH (a:Const), (b:Method) WHERE a.id = '${SERVICE}' AND b.id = '${SERVICE_RUN}' CREATE (a)-[:CodeRelation {type: 'HAS_METHOD', confidence: 1.0, reason: 'object literal member'}]->(b)`,
      `MATCH (a:Method), (b:Function) WHERE a.id = '${SERVICE_RUN}' AND b.id = '${HELPER_D}' CREATE (a)-[:CodeRelation {type: 'CALLS', confidence: 0.85, reason: 'direct'}]->(b)`,
    ],
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'object-literal-impact-repo',
          path: '/object-literal-impact/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 1, nodes: 6, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as BackendHandle).backend = backend;
    },
  },
);
