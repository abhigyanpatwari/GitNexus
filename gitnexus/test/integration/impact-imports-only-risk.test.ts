/**
 * Integration test: IMPORTS-only BFS nodes must not inflate risk tier.
 *
 * #3602 Repro 1: an exported Interface declared in a heavily-imported module
 * has 1 real caller (USES edge) but 120 file importers (IMPORTS edges via the
 * #480 file seed). Before the fix, `scoreImpactRisk` received all 121 nodes
 * undifferentiated, hitting the `impactedCount >= 100` → HIGH threshold.
 * Only the USES edge represents genuine symbol usage; the 120 IMPORTS edges
 * are file-level module imports that do not directly reference the target.
 *
 * The fix excludes nodes reached exclusively via IMPORTS from the counts fed
 * to `scoreImpactRisk`, while keeping `impactedCount` at its total-walk
 * value for backward compatibility.
 *
 * File targets are exempt: for a File node the question IS "who imports this
 * file?", so IMPORTS edges are the correct evidence for risk scoring.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const ROUTE_COUNT = 120;

const routeFiles = Array.from(
  { length: ROUTE_COUNT },
  (_, i) =>
    `CREATE (f:File {id: 'File:src/routes/route-${i}.ts', name: 'route-${i}.ts', filePath: 'src/routes/route-${i}.ts', content: ''})`,
);
const routeImports = Array.from(
  { length: ROUTE_COUNT },
  (_, i) =>
    `MATCH (a:File {id:'File:src/routes/route-${i}.ts'}), (b:File {id:'File:src/lib/adapter.ts'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:1.0, reason:'import', step:0}]->(b)`,
);

const SEED = [
  // Declaring file
  `CREATE (f:File {id: 'File:src/lib/adapter.ts', name: 'adapter.ts', filePath: 'src/lib/adapter.ts', content: 'export interface AdapterConfig {}'})`,
  // Exported Interface — the target symbol. The #480 file seed adds the declaring
  // File to the BFS frontier for Class/Interface targets, so IMPORTS edges from
  // route files fan out into the walk.
  `CREATE (iface:Interface {id: 'Interface:src/lib/adapter.ts:AdapterConfig', name: 'AdapterConfig', filePath: 'src/lib/adapter.ts', startLine: 1, endLine: 5, isExported: true, content: '', description: ''})`,
  `MATCH (f:File {id:'File:src/lib/adapter.ts'}), (iface:Interface {id:'Interface:src/lib/adapter.ts:AdapterConfig'}) CREATE (f)-[:CodeRelation {type:'DEFINES', confidence:1.0, reason:'', step:0}]->(iface)`,
  // Single real consumer — the only USES edge
  `CREATE (fn:Function {id: 'Function:src/auth.ts:initAuth', name: 'initAuth', filePath: 'src/auth.ts', startLine: 1, endLine: 10, isExported: true, content: '', description: ''})`,
  `MATCH (a:Function {id:'Function:src/auth.ts:initAuth'}), (b:Interface {id:'Interface:src/lib/adapter.ts:AdapterConfig'}) CREATE (a)-[:CodeRelation {type:'USES', confidence:0.85, reason:'type-reference', step:0}]->(b)`,
  // 120 route files that import the declaring module (IMPORTS-only edges).
  // These reach the BFS via the #480 file seed, inflating impactedCount.
  ...routeFiles,
  ...routeImports,
  // A Function with zero callers — control case for no-IMPORTS behavior.
  `CREATE (orphan:Function {id: 'Function:src/orphan.ts:orphanFn', name: 'orphanFn', filePath: 'src/orphan.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
];

type BackendHandle = IndexedDBHandle & { _backend?: LocalBackend };

withTestLbugDB(
  'impact-imports-only-risk',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      const ext = handle as BackendHandle;
      if (!ext._backend) throw new Error('LocalBackend not initialized');
      backend = ext._backend;
    });

    it('does not inflate risk tier with IMPORTS-only nodes (#3602)', async () => {
      const result = await backend.callTool('impact', {
        target: 'AdapterConfig',
        kind: 'Interface',
        direction: 'upstream',
      });
      expect(result).not.toHaveProperty('error');
      // Total walk still includes all nodes (backward compat)
      expect(result.impactedCount).toBeGreaterThanOrEqual(ROUTE_COUNT + 1);
      // Risk must be LOW — only 1 real consumer (initAuth via USES),
      // not HIGH from 121+ total impacted.
      expect(result.risk).toBe('LOW');
    });

    it('reports imports_only count in summary', async () => {
      const result = await backend.callTool('impact', {
        target: 'AdapterConfig',
        kind: 'Interface',
        direction: 'upstream',
      });
      expect(result.summary.imports_only).toBe(ROUTE_COUNT);
      expect(result.summary.direct).toBeGreaterThanOrEqual(1);
    });

    it('explains the IMPORTS-only exclusion in riskNote', async () => {
      const result = await backend.callTool('impact', {
        target: 'AdapterConfig',
        kind: 'Interface',
        direction: 'upstream',
      });
      expect(typeof result.riskNote).toBe('string');
      expect(result.riskNote).toMatch(/IMPORTS/);
      expect(result.riskNote).toMatch(/file-level imports/);
    });

    it('omits imports_only and riskNote when no IMPORTS-only nodes exist', async () => {
      // initAuth is a Function — no file seed, so no IMPORTS fan-out
      const result = await backend.callTool('impact', {
        target: 'orphanFn',
        direction: 'upstream',
      });
      expect(result.summary.imports_only).toBeUndefined();
    });

    it('downstream direction is not broken by the fix', async () => {
      const result = await backend.callTool('impact', {
        target: 'AdapterConfig',
        kind: 'Interface',
        direction: 'downstream',
      });
      expect(result).not.toHaveProperty('error');
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
          stats: { files: 123, nodes: 125, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
