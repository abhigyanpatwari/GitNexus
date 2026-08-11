/**
 * #2915 — `detect_changes` must not scale its query with the diff's hunk count.
 *
 * The old mapping folded one `(n.startLine <= $hunkEndI AND n.endLine >=
 * $hunkStartI)` pair per hunk into a single WHERE clause. A generated file
 * diffs at thousands of hunks with `-U0`, and the expression tree that produced
 * overflowed LadybugDB's recursive evaluator copy — SIGBUS with no output where
 * secondary threads get 512 KB of stack, a swallowed 30s timeout elsewhere.
 *
 * Hunk ranges are now coalesced and matched in JS, so the Cypher text and the
 * parameter set are the same whether the file changed in 1 place or 5,000.
 * These tests drive the real `detect_changes` path against a real git repo with
 * a mocked query layer, so they observe the query the engine would receive.
 *
 * They also pin the line-base fix that came with the rewrite: graph rows are
 * 0-based (#2377) and git hunks are 1-based, so comparing them raw shifted
 * every symbol one line up and hid edits to a symbol's last line.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
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

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
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

vi.mock('../../src/core/git-staleness.js', () => ({
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, type RegistryEntry } from '../../src/storage/repo-manager.js';
import { coalesceHunks, hunksOverlapRange } from '../../src/storage/git.js';

const fixtureDirs: string[] = [];

/** A git repo with `files` tracked files of `lines` numbered lines each. */
function makeRepo(files: string[], lines: number): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gnx-hunk-scale-'));
  fixtureDirs.push(repoDir);
  mkdirSync(path.join(repoDir, '.gitnexus', 'lbug'), { recursive: true });
  writeFileSync(path.join(repoDir, '.gitnexus', 'meta.json'), '{}');
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  for (const file of files) {
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
  summary: { changed_count: number };
  changed_symbols: { name?: string }[];
}

async function runDetectChanges(): Promise<DetectChangesResult> {
  const backend = new LocalBackend();
  await backend.init();
  return (await backend.callTool('detect_changes', {
    scope: 'unstaged',
    repo: 'hunk-scale-repo',
  })) as DetectChangesResult;
}

beforeEach(() => {
  lbugMocks.executeParameterized.mockReset();
  lbugMocks.executeParameterized.mockResolvedValue([]);
});

afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

describe('#2915 detect_changes hunk scaling', () => {
  it('sends one bounded query per file batch regardless of hunk count', async () => {
    const repoDir = makeRepo(['big.txt'], 12000);
    const hunks = editEveryNthLine(repoDir, 'big.txt', 12000, 4);
    expect(hunks).toBe(3000);
    registerRepo(repoDir);

    await runDetectChanges();

    const calls = symbolQueryCalls();
    expect(calls).toHaveLength(1);
    // The crash shape: one OR'd condition pair per hunk, two params each.
    expect(calls[0].query).not.toContain('$hunk');
    expect(Object.keys(calls[0].params)).toEqual(['paths']);
    expect(calls[0].params.paths).toEqual(['big.txt']);
    // 3,000 hunks used to produce a ~200 KB WHERE clause.
    expect(calls[0].query.length).toBeLessThan(1000);
  });

  it('batches changed files instead of running one full scan each', async () => {
    const files = Array.from({ length: 250 }, (_, i) => `f${i}.txt`);
    const repoDir = makeRepo(files, 10);
    for (const file of files) editEveryNthLine(repoDir, file, 10, 5);
    registerRepo(repoDir);

    await runDetectChanges();

    const calls = symbolQueryCalls();
    expect(calls).toHaveLength(3); // ceil(250 / 100)
    expect(calls.flatMap((c) => c.params.paths)).toHaveLength(250);
  });

  it('reports a symbol edited on its last line (0-based rows vs 1-based hunks, #2377)', async () => {
    const repoDir = makeRepo(['code.py'], 2);
    // Touch source line 2 only. `hello` spans source lines 1–2, stored 0-based
    // as [0, 1] — the old raw comparison saw hunk [2,2] vs [0,1] and missed it.
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1\nline 2 changed\n');
    registerRepo(repoDir);

    lbugMocks.executeParameterized.mockImplementation(async (_db: string, query: string) =>
      String(query).includes('diffPath')
        ? [
            {
              diffPath: 'code.py',
              id: 'Function:code.py:hello',
              name: 'hello',
              type: 'Function',
              filePath: 'code.py',
              startLine: 0,
              endLine: 1,
            },
          ]
        : [],
    );

    const result = await runDetectChanges();

    expect(result.changed_symbols.map((s) => s.name)).toEqual(['hello']);
    expect(result.summary.changed_count).toBe(1);
  });

  it('does not report a symbol that ends one line above the hunk', async () => {
    const repoDir = makeRepo(['code.py'], 4);
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1\nline 2\nline 3\nline 4 changed\n');
    registerRepo(repoDir);

    lbugMocks.executeParameterized.mockImplementation(async (_db: string, query: string) =>
      String(query).includes('diffPath')
        ? [
            {
              diffPath: 'code.py',
              id: 'Function:code.py:above',
              name: 'above',
              type: 'Function',
              // 0-based [0,2] = source lines 1–3; the hunk is source line 4.
              startLine: 0,
              endLine: 2,
              filePath: 'code.py',
            },
          ]
        : [],
    );

    const result = await runDetectChanges();

    expect(result.changed_symbols).toEqual([]);
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

  it('sorts unordered input and leaves a two-line gap unmerged', () => {
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
