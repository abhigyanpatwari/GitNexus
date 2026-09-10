import { beforeEach, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, saveMeta } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return { ...actual, listRegisteredRepos: vi.fn() };
});

const SEED = [
  `CREATE (:Function {id: 'Function:src/util.ts:formatDate', name: 'formatDate', filePath: 'src/util.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
];

withTestLbugDB(
  'impact-scope-omission-persistence',
  (handle) => {
    beforeEach(() => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date(0).toISOString(),
          lastCommit: 'abc123',
          stats: { files: 1, nodes: 1, communities: 0, processes: 0 },
        },
      ]);
    });

    it('persists omissions for reopened readers and clears them after a clean run', async () => {
      const baseMeta = {
        repoPath: '/test/repo',
        lastCommit: 'abc123',
        indexedAt: new Date(0).toISOString(),
        scopeExtractionReceipt: 1 as const,
      };
      await saveMeta(handle.tmpHandle.dbPath, {
        ...baseMeta,
        scopeExtractionFailures: { total: 1, paths: ['src/broken.ts'] },
      });

      const incompleteBackend = new LocalBackend();
      await incompleteBackend.init();
      const impact = await incompleteBackend.callTool('impact', {
        target: 'formatDate',
        direction: 'upstream',
      });
      const context = await incompleteBackend.callTool('context', {
        name: 'formatDate',
        file_path: 'src/util.ts',
      });
      expect(impact).toMatchObject({
        epistemic: 'lower-bound',
        causes: { scopeExtractionFiles: 1 },
      });
      expect(context).toMatchObject({
        status: 'found',
        epistemic: 'lower-bound',
        causes: { scopeExtractionFiles: 1 },
      });

      await saveMeta(handle.tmpHandle.dbPath, baseMeta);
      const cleanBackend = new LocalBackend();
      await cleanBackend.init();
      const cleanImpact = await cleanBackend.callTool('impact', {
        target: 'formatDate',
        direction: 'upstream',
      });
      expect(cleanImpact).toMatchObject({ epistemic: 'exact' });
      expect(cleanImpact).not.toHaveProperty('boundaries');
    });
  },
  { seed: SEED, poolAdapter: true },
);
