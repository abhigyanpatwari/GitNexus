/**
 * #2915 — `detect_changes` must not scale its query with the diff's hunk count.
 * See `coalesceHunks` in src/storage/git.ts for the crash mechanism.
 *
 * These tests drive the real `detect_changes` path against a real git repo with
 * the query layer mocked, so they observe the query the engine would receive:
 * its text and parameters must not grow with the hunk count. What the ENGINE
 * then does with that query — path anchoring and the line bound — is pinned
 * against a real index in test/integration/detect-changes-path-anchoring.
 *
 * They also pin the line-base fix that came with the rewrite: graph rows are
 * 0-based (#2377) and git hunks are 1-based, so comparing them raw shifted
 * every symbol one line up and hid edits to a symbol's last line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, type RegistryEntry } from '../../src/storage/repo-manager.js';
import { coalesceHunks, coalesceHunksByPath, hunksOverlapRange } from '../../src/storage/git.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';

const tempDirs = createTempDirPool('gnx-hunk-scale-');

/** A git repo with `files` tracked files of `lines` numbered lines each. */
function makeRepo(files: string[], lines: number): string {
  const repoDir = tempDirs.dir();
  mkdirSync(path.join(repoDir, '.gitnexus', 'lbug'), { recursive: true });
  writeFileSync(path.join(repoDir, '.gitnexus', 'meta.json'), '{}');
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
    writeFileSync(
      path.join(repoDir, file),
      Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    );
  }
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir });
  return repoDir;
}

/** Rewrite `file` so every `every`-th line differs — one -U0 hunk per change. */
function editEveryNthLine(repoDir: string, file: string, lines: number, every: number): number {
  writeFileSync(
    path.join(repoDir, file),
    Array.from({ length: lines }, (_, i) =>
      (i + 1) % every === 0 ? `line ${i + 1} changed` : `line ${i + 1}`,
    ).join('\n') + '\n',
  );
  return Math.floor(lines / every);
}

function registerRepo(repoDir: string): void {
  const entry: RegistryEntry = {
    name: 'hunk-scale-repo',
    path: repoDir,
    storagePath: path.join(repoDir, '.gitnexus'),
    indexedAt: '2026-08-11T00:00:00Z',
    lastCommit: 'abc1234',
    stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
  };
  vi.mocked(listRegisteredRepos).mockResolvedValue([entry]);
}

/** The hunk→symbol query is the only one selecting `diffPath`. */
function symbolQueryCalls(): { query: string; params: Record<string, unknown> }[] {
  return lbugMocks.executeParameterized.mock.calls
    .map((call) => ({
      query: String(call[1]),
      params: (call[2] ?? {}) as Record<string, unknown>,
    }))
    .filter((call) => call.query.includes('diffPath'));
}

interface DetectChangesResult {
  summary: { changed_count: number; changed_files: number };
  changed_symbols: { name?: string }[];
  symbols_truncated?: { listed: number; total: number };
}

async function runDetectChanges(): Promise<DetectChangesResult> {
  const backend = new LocalBackend();
  await backend.init();
  return (await backend.callTool('detect_changes', {
    scope: 'unstaged',
    repo: 'hunk-scale-repo',
  })) as DetectChangesResult;
}

/** Make the hunk→symbol query return 0-based symbol rows for `code.py`. */
function mockSymbolRows(rows: { name: string; startLine: number; endLine: number }[]): void {
  lbugMocks.executeParameterized.mockImplementation(async (_db: string, query: string) =>
    String(query).includes('diffPath')
      ? rows.map((row) => ({
          diffPath: 'code.py',
          id: `Function:code.py:${row.name}`,
          name: row.name,
          type: 'Function',
          filePath: 'code.py',
          startLine: row.startLine,
          endLine: row.endLine,
        }))
      : [],
  );
}

beforeEach(() => {
  lbugMocks.executeParameterized.mockReset();
  lbugMocks.executeParameterized.mockResolvedValue([]);
});

describe('#2915 detect_changes hunk scaling', () => {
  it('sends the same query for a 3,000-hunk diff as for a 1-hunk diff', async () => {
    const oneHunkRepo = makeRepo(['big.txt'], 12000);
    editEveryNthLine(oneHunkRepo, 'big.txt', 12000, 12000);
    registerRepo(oneHunkRepo);
    await runDetectChanges();
    const oneHunkCall = symbolQueryCalls()[0];

    lbugMocks.executeParameterized.mockClear();
    const manyHunksRepo = makeRepo(['big.txt'], 12000);
    expect(editEveryNthLine(manyHunksRepo, 'big.txt', 12000, 4)).toBe(3000);
    registerRepo(manyHunksRepo);
    await runDetectChanges();
    const calls = symbolQueryCalls();

    expect(calls).toHaveLength(1);
    // 3,000 hunks used to produce 3,000 OR'd condition pairs and 6,000 params.
    expect(calls[0].query).toBe(oneHunkCall.query);
    expect(Object.keys(calls[0].params)).toEqual(['bounds']);
    expect(calls[0].query).not.toContain('$hunk');
  });

  it('bounds each file by its touched span, in the graph 0-based line space', async () => {
    const repoDir = makeRepo(['big.txt'], 100);
    // Source lines 20 and 60 (1-based) — the span the engine may prefilter on.
    writeFileSync(
      path.join(repoDir, 'big.txt'),
      Array.from({ length: 100 }, (_, i) =>
        i + 1 === 20 || i + 1 === 60 ? `line ${i + 1} changed` : `line ${i + 1}`,
      ).join('\n') + '\n',
    );
    registerRepo(repoDir);

    await runDetectChanges();

    const calls = symbolQueryCalls();
    expect(calls[0].params.bounds).toEqual([
      { path: 'big.txt', suffix: '/big.txt', lo: 19, hi: 59 },
    ]);
    expect(calls[0].query).toContain('n.startLine <= b.hi AND n.endLine >= b.lo');
  });

  it('anchors the path match on a separator so a sibling suffix cannot match', async () => {
    const repoDir = makeRepo(['lib/a.ts'], 4);
    writeFileSync(path.join(repoDir, 'lib/a.ts'), 'line 1 changed\nline 2\nline 3\nline 4\n');
    registerRepo(repoDir);

    await runDetectChanges();

    const calls = symbolQueryCalls();
    // A bare `ENDS WITH lib/a.ts` also matches an indexed `src/mylib/a.ts`.
    expect(calls[0].query).toContain('n.filePath = b.path OR n.filePath ENDS WITH b.suffix');
    expect(calls[0].params.bounds).toEqual([
      { path: 'lib/a.ts', suffix: '/lib/a.ts', lo: 0, hi: 0 },
    ]);
  });

  it('batches changed files instead of running one full scan each', async () => {
    const files = Array.from({ length: 250 }, (_, i) => `f${i}.txt`);
    const repoDir = makeRepo(files, 10);
    for (const file of files) editEveryNthLine(repoDir, file, 10, 5);
    registerRepo(repoDir);

    await runDetectChanges();

    const calls = symbolQueryCalls();
    expect(calls).toHaveLength(3); // ceil(250 / 100)
    expect(calls.flatMap((c) => c.params.bounds)).toHaveLength(250);
  });

  it('reports a symbol edited on its last line (0-based rows vs 1-based hunks, #2377)', async () => {
    const repoDir = makeRepo(['code.py'], 2);
    // Touch source line 2 only. `hello` spans source lines 1–2, stored 0-based
    // as [0, 1] — the old raw comparison saw hunk [2,2] vs [0,1] and missed it.
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1\nline 2 changed\n');
    registerRepo(repoDir);
    mockSymbolRows([{ name: 'hello', startLine: 0, endLine: 1 }]);

    const result = await runDetectChanges();

    expect(result.changed_symbols.map((s) => s.name)).toEqual(['hello']);
    expect(result.summary.changed_count).toBe(1);
  });

  it('does not report a symbol that ends one line above the hunk', async () => {
    const repoDir = makeRepo(['code.py'], 4);
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1\nline 2\nline 3\nline 4 changed\n');
    registerRepo(repoDir);
    // 0-based [0,2] = source lines 1–3; the hunk is source line 4.
    mockSymbolRows([{ name: 'above', startLine: 0, endLine: 2 }]);

    const result = await runDetectChanges();

    expect(result.changed_symbols).toEqual([]);
  });

  it('caps the listed symbols without capping the counts', async () => {
    const repoDir = makeRepo(['code.py'], 2);
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1 changed\nline 2\n');
    registerRepo(repoDir);
    mockSymbolRows(
      Array.from({ length: 1200 }, (_, i) => ({ name: `fn${i}`, startLine: 0, endLine: 1 })),
    );

    const result = await runDetectChanges();

    expect(result.changed_symbols).toHaveLength(1000);
    // The gate's own number stays true, so the CLI's "... and N more" and any
    // client comparing list length against the count still see 1,200.
    expect(result.summary.changed_count).toBe(1200);
    expect(result.symbols_truncated).toEqual({ listed: 1000, total: 1200 });
  });

  it('counts a path reported twice in one diff as one changed file', async () => {
    const repoDir = makeRepo(['code.py'], 4);
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1 changed\nline 2\nline 3\nline 4\n');
    registerRepo(repoDir);

    const result = await runDetectChanges();

    expect(result.summary.changed_files).toBe(1);
  });

  it('reports a node matched by two changed paths once', async () => {
    const repoDir = makeRepo(['code.py'], 2);
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1 changed\nline 2\n');
    registerRepo(repoDir);
    // `ENDS WITH` is a plain suffix match, so one node can come back per path.
    mockSymbolRows([
      { name: 'hello', startLine: 0, endLine: 1 },
      { name: 'hello', startLine: 0, endLine: 1 },
    ]);

    const result = await runDetectChanges();

    expect(result.changed_symbols.map((s) => s.name)).toEqual(['hello']);
  });
});

describe('coalesceHunks', () => {
  it('merges overlapping and abutting ranges, keeping real gaps apart', () => {
    expect(
      coalesceHunks([
        { startLine: 10, endLine: 12 },
        { startLine: 13, endLine: 14 }, // abuts 10–12
        { startLine: 11, endLine: 20 }, // overlaps
        { startLine: 30, endLine: 30 }, // separate
      ]),
    ).toEqual([
      { startLine: 10, endLine: 20 },
      { startLine: 30, endLine: 30 },
    ]);
  });

  // The one property the cases around this do not pin: output ORDER, which
  // `hunksOverlapRange`'s binary search depends on.
  it('returns ranges in ascending order for unordered input', () => {
    expect(
      coalesceHunks([
        { startLine: 8, endLine: 8 },
        { startLine: 1, endLine: 1 },
        { startLine: 5, endLine: 5 },
      ]),
    ).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 5, endLine: 5 },
      { startLine: 8, endLine: 8 },
    ]);
  });

  it('covers exactly the lines the raw hunks covered', () => {
    const raw = [
      { startLine: 4, endLine: 4 },
      { startLine: 8, endLine: 9 },
      { startLine: 10, endLine: 10 },
      { startLine: 20, endLine: 21 },
    ];
    const merged = coalesceHunks(raw);
    const covered = (hunks: { startLine: number; endLine: number }[], line: number) =>
      hunks.some((h) => h.startLine <= line && h.endLine >= line);
    for (let line = 1; line <= 25; line++) {
      expect(covered(merged, line), `line ${line}`).toBe(covered(raw, line));
    }
  });

  it('does not mutate its input', () => {
    const raw = [
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 5 },
    ];
    coalesceHunks(raw);
    expect(raw).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 5 },
    ]);
  });
});

describe('coalesceHunksByPath', () => {
  it('converts git 1-based hunks into the graph 0-based space', () => {
    const byPath = coalesceHunksByPath([
      { filePath: 'a.ts', hunks: [{ startLine: 10, endLine: 12 }] },
    ]);

    expect(byPath.get('a.ts')).toEqual([{ startLine: 9, endLine: 11 }]);
  });

  it('accumulates a path reported twice in one diff', () => {
    const byPath = coalesceHunksByPath([
      { filePath: 'a.ts', hunks: [{ startLine: 20, endLine: 20 }] },
      { filePath: 'a.ts', hunks: [{ startLine: 5, endLine: 6 }] },
    ]);

    expect(byPath.size).toBe(1);
    expect(byPath.get('a.ts')).toEqual([
      { startLine: 4, endLine: 5 },
      { startLine: 19, endLine: 19 },
    ]);
  });

  it('skips files whose diff carried no hunks', () => {
    expect(coalesceHunksByPath([{ filePath: 'renamed.ts', hunks: [] }]).size).toBe(0);
  });
});

describe('hunksOverlapRange', () => {
  const hunks = coalesceHunks([
    { startLine: 10, endLine: 12 },
    { startLine: 20, endLine: 20 },
    { startLine: 40, endLine: 45 },
  ]);

  it.each([
    ['symbol containing a hunk', 5, 15, true],
    ['symbol ending on the hunk start', 1, 10, true],
    ['symbol starting on the hunk end', 12, 30, true],
    ['symbol inside a hunk', 11, 11, true],
    ['symbol ending one line before a hunk', 1, 9, false],
    ['symbol starting one line after a hunk', 13, 19, false],
    ['symbol spanning every hunk', 1, 100, true],
    ['symbol past the last hunk', 46, 60, false],
  ])('%s', (_label, startLine, endLine, expected) => {
    expect(hunksOverlapRange(hunks, startLine, endLine)).toBe(expected);
  });

  it('never matches when the file has no hunks', () => {
    expect(hunksOverlapRange([], 1, 1000)).toBe(false);
  });
});
