/**
 * Integration test: epistemic lower-bound flag (#1858)
 *
 * When a symbol sits behind an interface / indirection boundary, callers that
 * bind via a DI container or dynamic dispatch are not traced to the concrete
 * symbol — so impact()/context() report a *lower bound*, not an exact figure.
 * Instead of a silent confident zero, the result is annotated
 * `epistemic: 'lower-bound'` with a human-readable boundary note. A fully
 * resolved leaf with no indirection stays `epistemic: 'exact'`.
 *
 * Graph shape (the canonical Symfony/DI case from #1858 / the #1589 comment):
 *   SignupController --CALLS--> Logger (interface)
 *   EmailLogger --IMPLEMENTS--> Logger
 *   FileLogger  --IMPLEMENTS--> Logger
 * The controller binds to the *interface*; the concrete impl is wired by the
 * container, so impact("EmailLogger", upstream) finds no direct caller — but
 * must flag that the true blast radius is higher.
 */
import { it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const SEED = [
  // Interface + two implementations + an interface-level consumer.
  `CREATE (iface:Interface {id: 'Interface:src/Logger.ts:Logger', name: 'Logger', filePath: 'src/Logger.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `CREATE (email:Class {id: 'Class:src/EmailLogger.ts:EmailLogger', name: 'EmailLogger', filePath: 'src/EmailLogger.ts', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (file:Class {id: 'Class:src/FileLogger.ts:FileLogger', name: 'FileLogger', filePath: 'src/FileLogger.ts', startLine: 1, endLine: 20, isExported: true, content: '', description: ''})`,
  `CREATE (ctrl:Class {id: 'Class:src/SignupController.ts:SignupController', name: 'SignupController', filePath: 'src/SignupController.ts', startLine: 1, endLine: 30, isExported: true, content: '', description: ''})`,

  `MATCH (a:Class {id:'Class:src/EmailLogger.ts:EmailLogger'}), (b:Interface {id:'Interface:src/Logger.ts:Logger'}) CREATE (a)-[:CodeRelation {type:'IMPLEMENTS', confidence:0.85, reason:'implements', step:0}]->(b)`,
  `MATCH (a:Class {id:'Class:src/FileLogger.ts:FileLogger'}), (b:Interface {id:'Interface:src/Logger.ts:Logger'}) CREATE (a)-[:CodeRelation {type:'IMPLEMENTS', confidence:0.85, reason:'implements', step:0}]->(b)`,
  `MATCH (a:Class {id:'Class:src/SignupController.ts:SignupController'}), (b:Interface {id:'Interface:src/Logger.ts:Logger'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.85, reason:'interface-call', step:0}]->(b)`,

  // A fully-resolved leaf with no indirection — must stay `exact`.
  `CREATE (leaf:Function {id: 'Function:src/util.ts:formatDate', name: 'formatDate', filePath: 'src/util.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `CREATE (caller:Function {id: 'Function:src/page.ts:renderHeader', name: 'renderHeader', filePath: 'src/page.ts', startLine: 1, endLine: 10, isExported: true, content: '', description: ''})`,
  `MATCH (a:Function {id:'Function:src/page.ts:renderHeader'}), (b:Function {id:'Function:src/util.ts:formatDate'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:0.9, reason:'direct', step:0}]->(b)`,
];

withTestLbugDB(
  'impact-epistemic-lower-bound',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      backend = (handle as any)._backend;
    });

    it('flags impact() on a concrete impl behind an interface as lower-bound', async () => {
      const result = await backend.callTool('impact', {
        target: 'EmailLogger',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      expect(result.epistemic).toBe('lower-bound');
      expect(Array.isArray(result.boundaries)).toBe(true);
      expect(result.boundaries.join(' ')).toContain('Logger');
    });

    it('flags impact() on the interface itself as lower-bound', async () => {
      const result = await backend.callTool('impact', {
        target: 'Logger',
        direction: 'upstream',
      });
      expect(result.epistemic).toBe('lower-bound');
    });

    it('keeps a fully-resolved leaf exact (no false boundary)', async () => {
      const result = await backend.callTool('impact', {
        target: 'formatDate',
        direction: 'upstream',
      });
      expect(result.epistemic).toBe('exact');
      expect(result.boundaries).toBeUndefined();
      // The real caller is still reported — the flag is additive, not lossy.
      expect(result.impactedCount).toBeGreaterThanOrEqual(1);
    });

    it('context() carries the same epistemic signal', async () => {
      const result = await backend.callTool('context', {
        name: 'EmailLogger',
        file_path: 'src/EmailLogger.ts',
      });
      expect(result.status).toBe('found');
      expect(result.epistemic).toBe('lower-bound');
    });

    it('context() on a leaf interface itself is lower-bound (#1858 review F3)', async () => {
      // Logger is a leaf interface — it implements/extends nothing, so the only
      // boundary signal is computeEpistemicBoundary's symType==='Interface'
      // self-branch. Before the F3 fix, context() collapsed symKind to 'Class'
      // and this returned 'exact'.
      const result = await backend.callTool('context', { name: 'Logger' });
      expect(result.status).toBe('found');
      expect(result.epistemic).toBe('lower-bound');
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
          stats: { files: 6, nodes: 6, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
