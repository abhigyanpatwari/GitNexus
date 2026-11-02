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
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

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
  initGitRepo(repoDir);
  commitAll(repoDir, 'init');
  // Source line 2 of lib/a.py only — inside `a` (0-based [0,1]), nowhere near
  // `far` (0-based [40,45]).
  writeFileSync(path.join(repoDir, 'lib/a.py'), 'def x():\n    return 99\n');
  return repoDir;
}

/** The fields these tests read off one `detect_changes` run. */
type DetectChangesResult = {
  error?: unknown;
  summary: { changed_count: number; risk_level: string };
  changed_symbols: { name: string; filePath: string }[];
  partial?: boolean;
  unmapped_files?: string[];
};

withTestLbugDB(
  'detect-changes-path-anchoring',
  (handle) => {
    // One `detect_changes` run for the whole suite: each test below asserts on a
    // different property of the SAME result, so re-running it per test would pay
    // for three git-diff + Cypher round trips to observe one outcome.
    let result: DetectChangesResult;

    beforeAll(async () => {
      const ext = handle as typeof handle & { _backend?: LocalBackend };
      if (!ext._backend) throw new Error('LocalBackend not initialized by afterSetup');
      result = (await ext._backend.callTool('detect_changes', {
        scope: 'unstaged',
      })) as DetectChangesResult;
    });

    it('reports only the edited file, not a sibling whose path shares the suffix', () => {
      expect(result.error).toBeUndefined();
      // `b` lives in src/mylib/a.py: a bare `ENDS WITH 'lib/a.py'` matches it.
      expect(result.changed_symbols.map((s) => s.name)).toEqual(['a']);
    });

    it('drops a symbol outside the edited line span via the engine-side bound', () => {
      // `far` is in the edited file but 40 lines below the hunk.
      expect(result.changed_symbols.map((s) => s.name)).not.toContain('far');
      expect(result.summary.changed_count).toBe(1);
    });

    it("reports the edit even though it lands on the symbol's last line (#2377)", () => {
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

withTestLbugDB(
  'detect-changes-unindexed-sibling',
  (handle) => {
    it('does not certify a new root index.ts from an indexed pkg/index.ts suffix match', async () => {
      const backend = (handle as typeof handle & { _backend: LocalBackend })._backend;
      const result = (await backend.callTool('detect_changes', {
        scope: 'staged',
      })) as DetectChangesResult;
      expect(result.error).toBeUndefined();
      // The fallback remains visible, but cannot certify the identity of the new file.
      expect(result.changed_symbols).toEqual([
        expect.objectContaining({ name: 'helper', filePath: 'pkg/index.ts' }),
      ]);
      expect(result.summary.risk_level).toBe('unknown');
      expect(result.partial).toBe(true);
      expect(result.unmapped_files).toEqual(['index.ts']);
    });
  },
  {
    seed: [
      "CREATE (fn:Function {id: 'Function:pkg/index.ts:helper', name: 'helper', filePath: 'pkg/index.ts', startLine: 0, endLine: 1, isExported: true})",
    ],
    poolAdapter: true,
    afterSetup: async (handle) => {
      const repoDir = tempDirs.dir();
      mkdirSync(path.join(repoDir, 'pkg'), { recursive: true });
      writeFileSync(path.join(repoDir, 'pkg/index.ts'), 'export function helper() {\n}\n');
      initGitRepo(repoDir);
      commitAll(repoDir, 'indexed sibling');
      writeFileSync(path.join(repoDir, 'index.ts'), 'export function added() {\n}\n');
      execFileSync('git', ['add', 'index.ts'], { cwd: repoDir });
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'sibling-repo',
          path: repoDir,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc1234',
          stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as typeof handle & { _backend: LocalBackend })._backend = backend;
    },
  },
);
