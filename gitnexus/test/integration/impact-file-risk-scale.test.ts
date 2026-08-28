import { beforeAll, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const fileImporters = Array.from(
  { length: 13 },
  (_, index) =>
    `CREATE (f:File {id: 'File:src/importer-${index}.ts', name: 'importer-${index}.ts', filePath: 'src/importer-${index}.ts', content: ''})`,
);
const fileImportEdges = Array.from(
  { length: 13 },
  (_, index) =>
    `MATCH (a:File {id:'File:src/importer-${index}.ts'}), (b:File {id:'File:src/crypto.ts'}) CREATE (a)-[:CodeRelation {type:'IMPORTS', confidence:1.0, reason:'import', step:0}]->(b)`,
);
const processNodes = Array.from(
  { length: 4 },
  (_, index) =>
    `CREATE (p:Process {id: 'proc-${index}', label: 'Flow ${index}', heuristicLabel: 'Flow ${index}', processType: 'cross_community', stepCount: 3, communities: [], entryPointId: 'Function:src/entry-${index}.ts:entry${index}', terminalId: 'Function:src/crypto.ts:getEncryptionKey'})`,
);
const processEntryPoints = Array.from(
  { length: 4 },
  (_, index) =>
    `CREATE (ep:Function {id: 'Function:src/entry-${index}.ts:entry${index}', name: 'entry${index}', filePath: 'src/entry-${index}.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
);
const processEdges = Array.from(
  { length: 4 },
  (_, index) =>
    `MATCH (a:Function {id:'Function:src/caller-${index % 2}.ts:caller${index % 2}'}), (p:Process {id:'proc-${index}'}) CREATE (a)-[:CodeRelation {type:'STEP_IN_PROCESS', confidence:1.0, reason:'trace-detection', step:1}]->(p)`,
);

const SEED = [
  `CREATE (f:File {id: 'File:src/crypto.ts', name: 'crypto.ts', filePath: 'src/crypto.ts', content: ''})`,
  ...fileImporters,
  ...fileImportEdges,
  `CREATE (fn:Function {id: 'Function:src/crypto.ts:getEncryptionKey', name: 'getEncryptionKey', filePath: 'src/crypto.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `CREATE (c0:Function {id: 'Function:src/caller-0.ts:caller0', name: 'caller0', filePath: 'src/caller-0.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `CREATE (c1:Function {id: 'Function:src/caller-1.ts:caller1', name: 'caller1', filePath: 'src/caller-1.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
  `MATCH (a:Function {id:'Function:src/caller-0.ts:caller0'}), (b:Function {id:'Function:src/crypto.ts:getEncryptionKey'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:1.0, reason:'direct', step:0}]->(b)`,
  `MATCH (a:Function {id:'Function:src/caller-1.ts:caller1'}), (b:Function {id:'Function:src/crypto.ts:getEncryptionKey'}) CREATE (a)-[:CodeRelation {type:'CALLS', confidence:1.0, reason:'direct', step:0}]->(b)`,
  ...processEntryPoints,
  ...processNodes,
  ...processEdges,
];

type BackendHandle = IndexedDBHandle & { _backend?: LocalBackend };

withTestLbugDB(
  'impact-file-risk-scale',
  (handle) => {
    let backend: LocalBackend;
    beforeAll(() => {
      const ext = handle as BackendHandle;
      if (!ext._backend) throw new Error('LocalBackend not initialized');
      backend = ext._backend;
    });

    it('marks the wider File score incomparable with the process-rich Function score', async () => {
      const file = await backend.callTool('impact', {
        target: 'crypto.ts',
        kind: 'File',
        direction: 'upstream',
      });
      const fn = await backend.callTool('impact', {
        target: 'getEncryptionKey',
        kind: 'Function',
        direction: 'upstream',
      });

      expect(file.impactedCount).toBe(13);
      expect(file.risk).toBe('MEDIUM');
      expect(file.riskSharedAxes).toBe('MEDIUM');
      expect(file.target.type).toBe('File');
      expect(file.riskScale).toEqual({
        comparableAcrossKinds: false,
        unusedAxes: [
          {
            axis: 'processes',
            reason: 'file-nodes-have-no-process-or-community-membership',
          },
          {
            axis: 'modules',
            reason: 'file-nodes-have-no-process-or-community-membership',
          },
        ],
      });
      expect(file.riskNote).toBeUndefined();

      expect(fn.impactedCount).toBe(2);
      expect(fn.risk).toBe('HIGH');
      expect(fn.riskSharedAxes).toBe('LOW');
      expect(fn.summary.processes_affected).toBe(4);
      expect(fn.riskScale).toEqual({
        comparableAcrossKinds: true,
        unusedAxes: [],
      });
      expect(fn.riskNote).toBeUndefined();
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
          stats: { files: 14, nodes: 21, communities: 0, processes: 4 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as BackendHandle)._backend = backend;
    },
  },
);
