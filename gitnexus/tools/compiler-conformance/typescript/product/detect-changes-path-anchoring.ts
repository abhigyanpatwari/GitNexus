import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { expect } from 'expect';
import { LocalBackend } from '../../../../src/mcp/local/local-backend.js';
import { registerRepo, saveMeta } from '../../../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../../../../test/helpers/temp-git-repo.js';
import { isolateAnalysisHome } from '../support/analysis-home.js';
import { withTestLbugDB } from '../support/indexed-db.js';

await isolateAnalysisHome();
const fixture = 'test/fixtures/compiler-conformance/typescript-detect-changes-siblings';

withTestLbugDB(
  'detect-changes-unindexed-sibling',
  (handle) => {
    it('does not certify a new root index.ts from an indexed pkg/index.ts suffix match', async () => {
      const storagePath = handle.tmpHandle.dbPath;
      const repoPath = path.join(storagePath, 'repo');
      mkdirSync(path.join(repoPath, 'pkg'), { recursive: true });
      copyFileSync(path.join(fixture, 'pkg/index.ts'), path.join(repoPath, 'pkg/index.ts'));
      initGitRepo(repoPath);
      commitAll(repoPath, 'indexed sibling');
      const lastCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim();
      const meta = { repoPath, storagePath, lastCommit, indexedAt: new Date().toISOString() };
      await saveMeta(storagePath, meta);
      await registerRepo(repoPath, meta, { name: 'sibling-repo', storagePath });

      copyFileSync(path.join(fixture, 'index.ts'), path.join(repoPath, 'index.ts'));
      execFileSync('git', ['add', 'index.ts'], { cwd: repoPath });
      const backend = new LocalBackend();
      try {
        await backend.init();
        const result = await backend.callTool('detect_changes', { scope: 'staged' });
        expect(result.error).toBeUndefined();
        expect(result.changed_symbols).toEqual([
          expect.objectContaining({ name: 'helper', filePath: 'pkg/index.ts' }),
        ]);
        expect(result.summary.risk_level).toBe('unknown');
        expect(result.partial).toBe(true);
        expect(result.unmapped_files).toEqual(['index.ts']);
      } finally {
        await backend.dispose();
      }
    });
  },
  {
    seed: [
      "CREATE (fn:Function {id: 'Function:pkg/index.ts:helper', name: 'helper', filePath: 'pkg/index.ts', startLine: 0, endLine: 1, isExported: true})",
    ],
    poolAdapter: true,
  },
);
