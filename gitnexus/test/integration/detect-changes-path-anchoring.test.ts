/**
 * `detect_changes` against a REAL engine: path matching and the hunk→symbol
 * range bound, executed as Cypher rather than asserted as query text.
 *
 * The unit suite (`test/unit/detect-changes-hunk-scale.test.ts`) mocks the query
 * layer, so it can pin the shape of the query but not what LadybugDB does with
 * it. Two properties only show up against a real index:
 *
 *  - `ENDS WITH` is a plain string suffix. A diff touching `lib/a.py` matched an
 *    indexed `src/mylib/a.py` — a symbol in a file the diff never touched,
 *    reported as changed by the pre-commit gate. The match is anchored on the
 *    separator (with an equality arm for a path that IS the indexed value).
 *  - The per-file `[lo, hi]` bound is evaluated by the engine, in the graph's
 *    0-based line space (#2377, #2915).
 */
import { it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

const tempDirs = createTempDirPool('gnx-anchor-');

/**
 * Two files whose paths share a trailing segment, plus one symbol each.
 * Lines are 0-based, as the pipeline stores them: `a` covers source lines 1-2.
 */
const SEED = [
  `CREATE (fn:Function {id: 'Function:lib/a.py:a', name: 'a', filePath: 'lib/a.py', startLine: 0, endLine: 1, isExported: true})`,
  `CREATE (fn:Function {id: 'Function:src/mylib/a.py:b', name: 'b', filePath: 'src/mylib/a.py', startLine: 0, endLine: 1, isExported: true})`,
  `CREATE (fn:Function {id: 'Function:lib/a.py:far', name: 'far', filePath: 'lib/a.py', startLine: 40, endLine: 45, isExported: true})`,
];

/** A git repo mirroring the seeded files, with `lib/a.py` line 2 edited. */
function makeWorkingCopy(): string {
  const repoDir = tempDirs.dir();
  for (const file of ['lib/a.py', 'src/mylib/a.py']) {
    mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
    writeFileSync(path.join(repoDir, file), 'def x():\n    return 1\n');
  }
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
  // Source line 2 of lib/a.py only — inside `a` (0-based [0,1]), nowhere near
  // `far` (0-based [40,45]).
  writeFileSync(path.join(repoDir, 'lib/a.py'), 'def x():\n    return 99\n');
  return repoDir;
}

withTestLbugDB(
  'detect-changes-path-anchoring',
  (handle) => {
    let backend: LocalBackend;

    beforeAll(() => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) throw new Error('LocalBackend not initialized by afterSetup');
      backend = ext._backend;
    });

    it('reports only the edited file, not a sibling whose path shares the suffix', async () => {
      const result = await backend.callTool('detect_changes', { scope: 'unstaged' });

      expect(result.error).toBeUndefined();
      // `b` lives in src/mylib/a.py: a bare `ENDS WITH 'lib/a.py'` matches it.
      expect(result.changed_symbols.map((s: { name: string }) => s.name)).toEqual(['a']);
    });

    it('drops a symbol outside the edited line span via the engine-side bound', async () => {
      const result = await backend.callTool('detect_changes', { scope: 'unstaged' });

      // `far` is in the edited file but 40 lines below the hunk.
      expect(result.changed_symbols.map((s: { name: string }) => s.name)).not.toContain('far');
      expect(result.summary.changed_count).toBe(1);
    });

    it("reports the edit even though it lands on the symbol's last line (#2377)", async () => {
      const result = await backend.callTool('detect_changes', { scope: 'unstaged' });

      // Hunk is source line 2 = 0-based line 1 = `a`'s endLine.
      expect(result.changed_symbols).toHaveLength(1);
      expect(result.changed_symbols[0].filePath).toBe('lib/a.py');
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    afterSetup: async (handle) => {
      const repoDir = makeWorkingCopy();
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'anchor-repo',
          path: repoDir,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc1234',
          stats: { files: 2, nodes: 3, communities: 0, processes: 0 },
        },
      ]);

      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
