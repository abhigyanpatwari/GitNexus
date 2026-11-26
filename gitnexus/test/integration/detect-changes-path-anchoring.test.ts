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
 *  - A node whose id is empty is a row the engine really returns (#3931). The
 *    unit suite hands such a row to the JS check directly; only here does the
 *    query text decide whether the check ever sees it.
 */
import { it, expect, beforeAll, vi } from 'vitest';
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
  affected_processes?: unknown[];
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

/** Registers `repoDir` as the one indexed repo and hands back a ready backend. */
async function backendFor(
  repoDir: string,
  storagePath: string,
  nodes: number,
): Promise<LocalBackend> {
  vi.mocked(listRegisteredRepos).mockResolvedValue([
    {
      name: 'identity-repo',
      path: repoDir,
      storagePath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc1234',
      stats: { files: 2, nodes, edges: 0, communities: 0, processes: 0 },
    },
  ]);
  const backend = new LocalBackend();
  await backend.init();
  return backend;
}

withTestLbugDB(
  'detect-changes-corrupt-identity',
  (handle) => {
    it('omits an empty-id node beside a valid symbol and withholds the verdict (#3931)', async () => {
      const backend = (handle as typeof handle & { _backend: LocalBackend })._backend;
      const result = (await backend.callTool('detect_changes', {
        scope: 'unstaged',
      })) as DetectChangesResult;
      expect(result.error).toBeUndefined();
      // `ghost` (id '') overlaps the same hunk as `a`. It is not listed, it
      // does not pull in the process an unrelated empty-id node belongs to,
      // and the file being mapped by `a` does not make the result complete.
      expect(result.changed_symbols.map((s) => s.name)).toEqual(['a']);
      expect(result.affected_processes).toEqual([]);
      expect(result.unmapped_files).toBeUndefined();
      expect(result.partial).toBe(true);
      expect(result.summary.risk_level).toBe('unknown');
    });
  },
  {
    seed: [
      `CREATE (fn:Function {id: 'Function:lib/a.py:a', name: 'a', filePath: 'lib/a.py', startLine: 0, endLine: 1, isExported: true})`,
      `CREATE (m:Method {id: '', name: 'ghost', filePath: 'lib/a.py', startLine: 0, endLine: 1, isExported: true})`,
      // One empty id per table is all a primary key allows; a second table
      // supplies the unrelated endpoint the bare '' used to join to.
      `CREATE (c:Class {id: '', name: 'Elsewhere', filePath: 'other/b.py', startLine: 0, endLine: 9, isExported: true})`,
      `CREATE (p:Process {id: 'proc-unrelated', label: 'Unrelated', heuristicLabel: 'Unrelated', processType: 'cross_community', stepCount: 3, communities: []})`,
      `MATCH (c:Class {id: ''}), (p:Process {id: 'proc-unrelated'}) CREATE (c)-[:CodeRelation {type: 'STEP_IN_PROCESS', confidence: 1.0, reason: 'trace-detection', step: 2}]->(p)`,
    ],
    poolAdapter: true,
    afterSetup: async (handle) => {
      (handle as typeof handle & { _backend: LocalBackend })._backend = await backendFor(
        makeWorkingCopy(),
        handle.tmpHandle.dbPath,
        4,
      );
    },
  },
);

withTestLbugDB(
  'detect-changes-corrupt-exact-row',
  (handle) => {
    it('keeps the suffix fallback closed when the only exact-path row has an empty id', async () => {
      const backend = (handle as typeof handle & { _backend: LocalBackend })._backend;
      const result = (await backend.callTool('detect_changes', {
        scope: 'unstaged',
      })) as DetectChangesResult;
      expect(result.error).toBeUndefined();
      // The corrupt row proves the index knows `lib/a.py`, so `pkg/lib/a.py`
      // must not answer for it; nothing usable is left to report.
      expect(result.changed_symbols).toEqual([]);
      expect(result.unmapped_files).toEqual(['lib/a.py']);
      expect(result.partial).toBe(true);
      expect(result.summary.risk_level).toBe('unknown');
    });
  },
  {
    seed: [
      `CREATE (m:Method {id: '', name: 'ghost', filePath: 'lib/a.py', startLine: 0, endLine: 1, isExported: true})`,
      `CREATE (fn:Function {id: 'Function:pkg/lib/a.py:sibling', name: 'sibling', filePath: 'pkg/lib/a.py', startLine: 0, endLine: 1, isExported: true})`,
    ],
    poolAdapter: true,
    afterSetup: async (handle) => {
      (handle as typeof handle & { _backend: LocalBackend })._backend = await backendFor(
        makeWorkingCopy(),
        handle.tmpHandle.dbPath,
        2,
      );
    },
  },
);
