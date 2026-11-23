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
 *
 * And they pin what the rewrite made newly falsifiable at this layer: the flag
 * a batch failure raises (failure granularity is now up to 100 files, and this
 * IS the pre-commit gate), the risk level a degraded run may claim, the order
 * the symbols come out in, and the label they carry.
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
  const actual = await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>();
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
import {
  coalesceHunks,
  coalesceHunksByPath,
  hunksOverlapRange,
  parseDiffHunks,
} from '../../src/storage/git.js';
import { diffArgsFor } from '../helpers/detect-changes-diff-args.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

const tempDirs = createTempDirPool('gnx-hunk-scale-');

/** A git repo with `files` tracked files of `lines` numbered lines each. */
function makeRepo(files: string[], lines: number): string {
  const repoDir = tempDirs.dir();
  mkdirSync(path.join(repoDir, '.gitnexus', 'lbug'), { recursive: true });
  writeFileSync(path.join(repoDir, '.gitnexus', 'meta.json'), '{}');
  initGitRepo(repoDir);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repoDir, file)), { recursive: true });
    writeFileSync(
      path.join(repoDir, file),
      Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    );
  }
  commitAll(repoDir, 'init');
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

/** One bounded file in the hunk→symbol query's `$bounds` parameter. */
interface QueryBound {
  path: string;
  suffix: string;
  lo: number;
  hi: number;
}

/** The parameters the engine receives for the hunk→symbol query. */
interface SymbolQueryParams {
  bounds: QueryBound[];
  paths: string[];
  suffixes: string[];
}

/** The hunk→symbol query is the only one selecting `diffPath`. */
function symbolQueryCalls(): { query: string; params: SymbolQueryParams }[] {
  return lbugMocks.executeParameterized.mock.calls
    .map((call) => ({
      query: String(call[1]),
      params: (call[2] ?? {}) as SymbolQueryParams,
    }))
    .filter((call) => call.query.includes('diffPath'));
}

interface DetectChangesResult {
  summary: { changed_count: number; changed_files: number; risk_level: string };
  changed_symbols: { name?: string; type?: string }[];
  affected_processes?: unknown[];
  unmapped_files?: string[];
  truncated?: boolean;
  partial?: boolean;
}

async function runDetectChanges(scope = 'unstaged'): Promise<DetectChangesResult> {
  const backend = new LocalBackend();
  await backend.init();
  return (await backend.callTool('detect_changes', {
    scope,
    repo: 'hunk-scale-repo',
  })) as DetectChangesResult;
}

/** The label the mocked engine reports for every node it returns. */
const NODE_LABEL = 'Function';

/**
 * What LadybugDB answers for the column aliased `type`, read off the query text.
 *
 * `labels(n)` comes back as a scalar STRING, not a list, so a subscript indexes
 * its CHARACTERS and is 1-based: probed on @ladybugdb/core, `labels(n)` is
 * 'Function', `labels(n)[0]` is '' and `labels(n)[1]` is 'F'. The projection is
 * simulated rather than hardcoded so the mock cannot keep answering 'Function'
 * for the `labels(n)[0]` form that shipped an always-empty `type` (#2915).
 */
function projectTypeColumn(query: string): string {
  const projection = /labels\(n\)(?:\[(\d+)\])?\s+AS type/.exec(query);
  if (!projection) throw new Error('the hunk→symbol query no longer projects a `type` column');
  const [, subscript] = projection;
  return subscript === undefined ? NODE_LABEL : (NODE_LABEL[Number(subscript) - 1] ?? '');
}

/** A 0-based symbol row the mocked engine returns for the hunk→symbol query. */
interface SymbolRow {
  /** Defaults to the normal Function identity; an empty value models #3931. */
  id?: string;
  name: string;
  startLine: number;
  endLine: number;
  /** Defaults to `code.py`, the file every single-file case below edits. */
  filePath?: string;
}

/** Make the hunk→symbol query return `rows`, in the order given. */
function mockSymbolRows(rows: SymbolRow[]): void {
  lbugMocks.executeParameterized.mockImplementation(async (_db: string, query: string) =>
    String(query).includes('diffPath')
      ? rows.map((row) => {
          const filePath = row.filePath ?? 'code.py';
          return {
            diffPath: filePath,
            id: row.id ?? `Function:${filePath}:${row.name}`,
            name: row.name,
            type: projectTypeColumn(String(query)),
            filePath,
            startLine: row.startLine,
            endLine: row.endLine,
          };
        })
      : [],
  );
}

/**
 * Answer each batch of the hunk→symbol query with one symbol per bounded file,
 * spanning exactly that file's touched region — except the batch carrying
 * `failingPath`, which rejects the way a query timeout or a native fault does.
 */
function mockBatchFailure(failingPath: string): void {
  lbugMocks.executeParameterized.mockImplementation(
    async (_db: string, query: string, params: SymbolQueryParams) => {
      const bounds = String(query).includes('diffPath') ? (params?.bounds ?? []) : [];
      return bounds.some((bound) => bound.path === failingPath)
        ? Promise.reject(new Error(`injected failure for the batch containing ${failingPath}`))
        : bounds.map((bound) => ({
            diffPath: bound.path,
            id: `Function:${bound.path}:sym`,
            name: `sym@${bound.path}`,
            type: projectTypeColumn(String(query)),
            filePath: bound.path,
            startLine: bound.lo,
            endLine: bound.hi,
          }));
    },
  );
}

/**
 * Commit `code.py` with `originalLines` numbered lines, replace it with
 * `edited`, and answer the symbol query with `rows` — the setup every behaviour
 * case below shares. `originalLines` defaults to the edited line count (an
 * in-place edit) and is passed explicitly by the deletion cases.
 */
async function detectChangesForCodePy(
  edited: string,
  rows: SymbolRow[] = [],
  originalLines = edited.trimEnd().split('\n').length,
): Promise<DetectChangesResult> {
  const repoDir = makeRepo(['code.py'], originalLines);
  writeFileSync(path.join(repoDir, 'code.py'), edited);
  registerRepo(repoDir);
  mockSymbolRows(rows);
  return runDetectChanges();
}

// Use real git snapshots and Python extraction through the public tool entry.
// Only the DB relation rows are supplied by the fixture.
function makeKeywordChange(addSeparator = false) {
  const dir = makeRepo(['model.py', 'use.py'], 1);
  const original = 'def charge(\n    amount,\n    legacy=None,\n):\n    pass\n';
  writeFileSync(path.join(dir, 'model.py'), original);
  writeFileSync(path.join(dir, 'use.py'), 'from model import charge\ncharge(1, legacy=True)\n');
  commitAll(dir, 'add keyword caller');
  writeFileSync(
    path.join(dir, 'model.py'),
    addSeparator
      ? original.replace('):', '    /,\n):')
      : original.replace('    legacy=None,\n', ''),
  );
  registerRepo(dir);
  const id = 'Function:model.py:charge';
  lbugMocks.executeParameterized.mockImplementation(async (_db, query, params) => {
    if (String(query).includes('diffPath'))
      return [
        {
          diffPath: 'model.py',
          startLine: 0,
          endLine: 4,
          type: 'Function',
          name: 'charge',
          filePath: 'model.py',
          id,
        },
      ];
    if (
      String(query).includes('r.type AS relationType') &&
      params.ids.includes(id) &&
      params.relationTypes.includes('CALLS')
    )
      return [{ target: id, filePath: 'use.py', relationType: 'CALLS' }];
    return [];
  });
  return dir;
}

describe('provider call compatibility in detect_changes', () => {
  it('runs each registered checker and keeps findings when a different checker fails', async () => {
    const dir = makeRepo(['a.ts', 'b.rb', 'c.go'], 2);
    for (const file of ['a.ts', 'b.rb', 'c.go']) editEveryNthLine(dir, file, 2, 1);
    registerRepo(dir);
    mockSymbolRows(
      ['a.ts', 'b.rb', 'c.go'].map((filePath) => ({
        filePath,
        name: 'run',
        startLine: 0,
        endLine: 1,
      })),
    );
    const registry = await import('../../src/core/ingestion/languages/query-providers.js');
    const base = registry.getQueryProviderForFile('a.ts')!;
    const found = {
      target: 'Function:a.ts:run',
      name: 'run',
      keyword: 'arg',
      filePath: 'caller.ts',
      line: 2,
    };
    const check = vi.fn().mockResolvedValue({ findings: [found], complete: true, skipped: [] });
    const failing = vi.fn().mockRejectedValue(new Error('provider check failed'));
    const capability = { acceptsTarget: () => true, relationTypes: [] as const, check };
    const resolver = vi
      .spyOn(registry, 'getQueryProviderForFile')
      .mockImplementation((file) =>
        file === 'a.ts'
          ? { ...base, callCompatibility: capability }
          : file === 'b.rb'
            ? { ...base, callCompatibility: { ...capability, check: failing } }
            : base,
      );
    try {
      expect(await runDetectChanges()).toMatchObject({
        partial: true,
        summary: {
          risk_level: 'high',
          incompatible_call_count: 1,
          incompatible_calls_checked: false,
        },
        incompatible_calls: [found],
        incompatible_call_skips: [{ reason: 'signature-check-failed' }],
      });
      expect(
        check.mock.calls.map((args) =>
          args[3].map((target: { filePath: string }) => target.filePath),
        ),
      ).toEqual([['a.ts']]);
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      resolver.mockRestore();
    }
  });

  it('leaves providers without call compatibility out of the subcheck', async () => {
    const dir = makeRepo(['a.ts'], 2);
    editEveryNthLine(dir, 'a.ts', 2, 1);
    registerRepo(dir);
    mockSymbolRows([{ filePath: 'a.ts', name: 'run', startLine: 0, endLine: 1 }]);
    const result = await runDetectChanges();
    expect(result.summary).not.toHaveProperty('incompatible_calls_checked');
    expect(result.partial).toBeUndefined();
  });

  it('maps an edited source rename to the indexed symbol when both paths share a provider', async () => {
    const dir = makeRepo(['before.ts'], 12);
    execFileSync('git', ['mv', 'before.ts', 'after.ts'], { cwd: dir });
    editEveryNthLine(dir, 'after.ts', 12, 12);
    execFileSync('git', ['add', 'after.ts'], { cwd: dir });
    registerRepo(dir);
    mockSymbolRows([{ filePath: 'before.ts', name: 'run', startLine: 0, endLine: 11 }]);
    const result = await runDetectChanges('staged');
    expect(result.changed_symbols).toMatchObject([{ name: 'run' }]);
    expect(result.unmapped_files).toBeUndefined();
    expect(result.partial).toBeUndefined();
  });

  it.each([false, true])(
    'promotes an incompatible call to high risk (addition-only: %s)',
    async (addSeparator) => {
      makeKeywordChange(addSeparator);
      const result = await runDetectChanges();
      expect(result).toMatchObject({
        summary: {
          risk_level: 'high',
          affected_count: 0,
          incompatible_call_count: 1,
          incompatible_calls_checked: true,
        },
        incompatible_calls: [{ name: 'charge', keyword: 'legacy', filePath: 'use.py', line: 2 }],
      });
      expect(result.partial).toBeUndefined();
    },
  );

  it('reports unavailable retained source', async () => {
    const dir = makeKeywordChange();
    writeFileSync(
      path.join(dir, '.gitnexus', 'meta.json'),
      JSON.stringify({ contentRetention: 'none' }),
    );
    expect(await runDetectChanges()).toMatchObject({
      partial: true,
      summary: { risk_level: 'unknown', incompatible_calls_checked: false },
      incompatible_call_skips: [{ reason: 'content-retention' }],
    });
  });

  it('does not read unchanged re-export endpoints at reduced retention', async () => {
    const dir = makeRepo(['api.py', 'previous.py', 'current.py'], 1);
    writeFileSync(path.join(dir, 'api.py'), 'from previous import charge\n');
    writeFileSync(path.join(dir, 'previous.py'), 'def charge(legacy=False): pass\n');
    writeFileSync(path.join(dir, 'current.py'), 'def charge(): pass\n');
    commitAll(dir, 'publish charge');
    writeFileSync(path.join(dir, 'api.py'), 'from current import charge\n');
    registerRepo(dir);
    writeFileSync(
      path.join(dir, '.gitnexus', 'meta.json'),
      JSON.stringify({ contentRetention: 'none' }),
    );
    const images = await import('../../src/core/ingestion/languages/python/signature-images.js');
    const read = vi.spyOn(images, 'readImage');
    try {
      const result = await runDetectChanges();
      expect(result).toMatchObject({
        partial: true,
        summary: { incompatible_calls_checked: false },
      });
      const paths = read.mock.calls.map((args) => args[2]);
      expect(paths).not.toContain('previous.py');
      expect(paths).not.toContain('current.py');
    } finally {
      read.mockRestore();
    }
  });

  it.each(['symbol', 'none'])(
    'checks a body-only edit without reading callers at %s retention',
    async (contentRetention) => {
      const dir = makeKeywordChange();
      const original = execFileSync('git', ['show', 'HEAD:model.py'], {
        cwd: dir,
        encoding: 'utf8',
      });
      writeFileSync(path.join(dir, 'model.py'), original.replace('pass', 'return amount'));
      writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), JSON.stringify({ contentRetention }));
      const result = await runDetectChanges();
      expect(result.partial).toBeUndefined();
      expect(result.summary).toMatchObject({ risk_level: 'low', incompatible_calls_checked: true });
    },
  );

  it('checks a removed keyword when its declaration moved outside the indexed hunk span', async () => {
    const dir = makeKeywordChange();
    const preamble = '# setup\n'.repeat(8);
    const before = 'def charge(amount, legacy=None):\n    return amount\n';
    writeFileSync(path.join(dir, 'model.py'), preamble + before);
    commitAll(dir, 'move definition below preamble');
    writeFileSync(path.join(dir, 'model.py'), before.replace(', legacy=None', ''));
    execFileSync('git', ['add', 'model.py'], { cwd: dir });
    const id = 'Function:model.py:charge';
    lbugMocks.executeParameterized.mockImplementation(async (_db, query, params) => {
      if (query.includes('r.type AS relationType'))
        return [{ target: id, filePath: 'use.py', relationType: 'CALLS' }];
      if (!query.includes('diffPath')) return [];
      const rows = [
        {
          diffPath: 'model.py',
          filePath: 'model.py',
          type: 'Function',
          id,
          name: 'charge',
          startLine: 8,
          endLine: 9,
        },
      ];
      return params.declarationPaths?.includes('model.py') ? rows : [];
    });
    expect(await runDetectChanges('staged')).toMatchObject({
      summary: { risk_level: 'high', incompatible_call_count: 1, changed_count: 1 },
      changed_symbols: [{ id, name: 'charge' }],
      incompatible_calls: [{ name: 'charge', filePath: 'use.py', keyword: 'legacy' }],
    });
  });

  it('reports a new staged caller even before it has a graph edge', async () => {
    const dir = makeKeywordChange();
    writeFileSync(
      path.join(dir, 'new_use.py'),
      'from model import charge\ncharge(2, legacy=False)\n',
    );
    execFileSync('git', ['add', 'model.py', 'new_use.py'], { cwd: dir });
    expect(await runDetectChanges('staged')).toMatchObject({
      summary: { risk_level: 'high', incompatible_call_count: 2 },
      partial: true,
      unmapped_files: ['new_use.py'],
      incompatible_calls: [
        { filePath: 'new_use.py', line: 2 },
        { filePath: 'use.py', line: 2 },
      ],
    });
  });

  it('reports a failed check without claiming the indexed caller is safe', async () => {
    makeKeywordChange();
    const helper = await import('../../src/core/ingestion/languages/python/signature-changes.js');
    const spy = vi.spyOn(helper, 'findBrokenKeywordCalls').mockRejectedValue(new Error('fixture'));
    try {
      expect(await runDetectChanges()).toMatchObject({
        partial: true,
        summary: { risk_level: 'unknown', incompatible_calls_checked: false },
        incompatible_call_skips: [{ reason: 'signature-check-failed' }],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('caps the listing while counting every observed incompatible call site', async () => {
    makeKeywordChange();
    const helper = await import('../../src/core/ingestion/languages/python/signature-changes.js');
    const findings = Array.from({ length: 1001 }, (_, i) => ({
      target: 'Function:model.py:charge',
      name: 'charge',
      keyword: 'legacy',
      filePath: 'use.py',
      line: i + 1,
    }));
    const spy = vi.spyOn(helper, 'findBrokenKeywordCalls').mockResolvedValue({
      findings,
      complete: false,
      skipped: [{ filePath: 'other.py', reason: 'file-too-large' }],
    });
    try {
      const result = await runDetectChanges();
      expect(result).toMatchObject({
        partial: true,
        truncated: true,
        summary: {
          risk_level: 'high',
          incompatible_call_count: 1001,
          incompatible_calls_checked: false,
        },
      });
      expect(result).toHaveProperty('incompatible_calls.length', 1000);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    { processes: 5, broken: false, risk: 'unknown' },
    { processes: 6, broken: false, risk: 'high' },
    { processes: 16, broken: true, risk: 'critical' },
  ])(
    'preserves $risk risk for $processes affected processes under incomplete caller coverage',
    async ({ processes, broken, risk }) => {
      makeKeywordChange();
      const answer = lbugMocks.executeParameterized.getMockImplementation()!;
      lbugMocks.executeParameterized.mockImplementation((db, query, params) =>
        query.includes('p.id AS pid')
          ? Promise.resolve(
              Array.from({ length: processes }, (_, i) => ({
                nodeId: 'Function:model.py:charge',
                pid: 'Process:' + i,
                label: 'process ' + i,
                processType: 'cross_community',
                stepCount: 2,
                step: 1,
              })),
            )
          : answer(db, query, params),
      );
      const helper = await import('../../src/core/ingestion/languages/python/signature-changes.js');
      const spy = vi.spyOn(helper, 'findBrokenKeywordCalls').mockResolvedValue({
        findings: broken
          ? [
              {
                target: 'Function:model.py:charge',
                name: 'charge',
                keyword: 'legacy',
                filePath: 'use.py',
                line: 2,
              },
            ]
          : [],
        complete: false,
        skipped: Array.from({ length: 1001 }, (_, i) => ({
          filePath: 'caller' + i,
          reason: 'unavailable',
        })),
      });
      try {
        const result = await runDetectChanges();
        expect(result).toMatchObject({
          summary: { affected_count: processes, risk_level: risk },
          partial: true,
          truncated: true,
        });
        expect(result).toHaveProperty('incompatible_call_skips.length', 1000);
      } finally {
        spy.mockRestore();
      }
    },
  );
});

beforeEach(() => {
  lbugMocks.executeParameterized.mockReset();
  lbugMocks.executeParameterized.mockResolvedValue([]);
});

describe('#2915 detect_changes hunk scaling', () => {
  it('withholds a low-risk verdict when a changed source file maps to no symbols', async () => {
    const result = await detectChangesForCodePy('def vanished():\n    return 2\n');
    expect(result.summary.changed_files).toBe(1);
    expect(result.summary.changed_count).toBe(0);
    expect(result.summary.risk_level).toBe('unknown');
    expect(result.partial).toBe(true);
    expect(result).toHaveProperty('unmapped_files', ['code.py']);
  });

  it('keeps Markdown sections in docs-only reviews and counts them separately beside code', async () => {
    const dir = makeRepo(['README.MD', 'guide.Mdx', 'code.ts'], 1);
    registerRepo(dir);
    lbugMocks.executeParameterized.mockImplementation(async (_db, query, { bounds }) =>
      String(query).includes('diffPath')
        ? bounds.map((bound: QueryBound) => ({
            diffPath: bound.path,
            filePath: bound.path,
            startLine: 0,
            endLine: 0,
            id: bound.path,
            name: bound.path,
            type: bound.path === 'code.ts' ? 'Function' : 'Section',
          }))
        : [],
    );
    writeFileSync(path.join(dir, 'README.MD'), '# Edited section\n');
    writeFileSync(path.join(dir, 'guide.Mdx'), '# Edited MDX section\n');
    const docs = await runDetectChanges();
    expect(docs.changed_symbols).toMatchObject([{ type: 'Section' }, { type: 'Section' }]);
    expect(docs.summary).toMatchObject({
      changed_count: 2,
      documentation_basis: 'indexed_headings',
    });
    writeFileSync(path.join(dir, 'code.ts'), 'function run() {}\n');
    const mixed = await runDetectChanges();
    expect(mixed.summary).toMatchObject({
      documentation_sections: 2,
      changed_count: 1,
      changed_files: 3,
    });
    expect(mixed.changed_symbols).toMatchObject([{ type: 'Function' }]);
  });

  it('separates Markdown sections even when the changed code has no mapped symbol', async () => {
    const dir = makeRepo(['guide.md', 'unindexed.ts'], 1);
    registerRepo(dir);
    writeFileSync(path.join(dir, 'guide.md'), '# Changed\n');
    writeFileSync(path.join(dir, 'unindexed.ts'), 'export const value = 1;\n');
    lbugMocks.executeParameterized.mockResolvedValue([
      {
        diffPath: 'guide.md',
        filePath: 'guide.md',
        id: 'Section:guide.md:Changed',
        name: 'Changed',
        type: 'Section',
        startLine: 0,
        endLine: 0,
      },
    ]);
    expect(await runDetectChanges()).toMatchObject({
      summary: { documentation_sections: 1, changed_count: 0, risk_level: 'unknown' },
      changed_symbols: [],
      unmapped_files: ['unindexed.ts'],
      partial: true,
    });
  });

  it('omits the reindex hint for an unindexed documentation extension', async () => {
    const file = 'README.markdown';
    const dir = makeRepo([file], 1);
    registerRepo(dir);
    writeFileSync(path.join(dir, file), '# Changed\n');
    expect((await runDetectChanges()).summary).not.toHaveProperty('documentation_basis');
  });

  it.each(['notes.txt', 'README.md', 'config.json', 'config.yaml'])(
    'keeps ordinary non-source changes in %s measurable with zero symbols',
    async (filePath) => {
      const repoDir = makeRepo([filePath], 2);
      writeFileSync(path.join(repoDir, filePath), 'changed\nline 2\n');
      registerRepo(repoDir);
      const result = await runDetectChanges();
      expect(result.summary.risk_level).toBe('low');
      expect(result.partial).toBeUndefined();
    },
  );

  it.each(['.html', '.htm', '.ejs', '.hbs', '.blade.php'])(
    'withholds ranked risk when a changed %s template maps to no symbols',
    async (extension) => {
      const filePath = `views/orders${extension}`;
      const repoDir = makeRepo([filePath], 2);
      writeFileSync(path.join(repoDir, filePath), '<form action="/orders/new"></form>\n');
      registerRepo(repoDir);
      const result = await runDetectChanges();
      expect(result.summary).toMatchObject({
        changed_files: 1,
        changed_count: 0,
        risk_level: 'unknown',
      });
      expect(result.partial).toBe(true);
      expect(result).toHaveProperty('unmapped_files', [filePath]);
    },
  );

  it.each(['.html', '.htm', '.ejs', '.hbs', '.blade.php'])(
    'recognizes the template side of a pure %s-to-text rename',
    async (extension) => {
      const filePath = `orders${extension}`;
      const repoDir = makeRepo([filePath], 2);
      execFileSync('git', ['mv', filePath, 'orders.txt'], { cwd: repoDir });
      registerRepo(repoDir);
      const result = await runDetectChanges('staged');
      expect(result.summary).toMatchObject({
        changed_files: 1,
        changed_count: 0,
        risk_level: 'unknown',
      });
      expect(result.partial).toBe(true);
      expect(result).toHaveProperty('unmapped_files', ['orders.txt']);
    },
  );

  it('keeps mapped template changes measurable', async () => {
    const filePath = 'views/orders.blade.php';
    const repoDir = makeRepo([filePath], 2);
    writeFileSync(path.join(repoDir, filePath), '<form action="/orders/new"></form>\nline 2\n');
    registerRepo(repoDir);
    mockSymbolRows([{ name: 'orders', filePath, startLine: 0, endLine: 1 }]);
    const result = await runDetectChanges();
    expect(result.summary).toMatchObject({
      changed_files: 1,
      changed_count: 1,
      risk_level: 'low',
    });
    expect(result.changed_symbols.map((symbol) => symbol.name)).toEqual(['orders']);
    expect(result.partial).toBeUndefined();
    expect(result).not.toHaveProperty('unmapped_files');
  });

  it('withholds a low-risk verdict for an unmapped source rename without hunks', async () => {
    const repoDir = makeRepo(['code.py'], 2);
    execFileSync('git', ['mv', 'code.py', 'renamed.py'], { cwd: repoDir });
    registerRepo(repoDir);
    const result = await runDetectChanges('staged');
    expect(result.summary.changed_files).toBe(1);
    expect(result.summary.risk_level).toBe('unknown');
    expect(result.partial).toBe(true);
    expect(result).toHaveProperty('unmapped_files', ['renamed.py']);
  });

  it('recognizes the source side of a pure source-to-text rename', async () => {
    const repoDir = makeRepo(['code.py'], 2);
    execFileSync('git', ['mv', 'code.py', 'code.txt'], { cwd: repoDir });
    registerRepo(repoDir);
    const result = await runDetectChanges('staged');
    expect(result.summary).toMatchObject({
      changed_files: 1,
      changed_count: 0,
      risk_level: 'unknown',
    });
    expect(result.partial).toBe(true);
    expect(result).toHaveProperty('unmapped_files', ['code.txt']);
  });

  it.each(['.jcl', '.job', '.proc', '.copybook', '.JCL', '.COPYBOOK'])(
    'withholds ranked risk for an unmapped ingestion-supported %s rename',
    async (extension) => {
      const repoDir = makeRepo([`source${extension}`], 2);
      execFileSync('git', ['mv', `source${extension}`, `renamed${extension}`], { cwd: repoDir });
      registerRepo(repoDir);
      const result = await runDetectChanges('staged');
      expect(result.summary.risk_level).toBe('unknown');
      expect(result.partial).toBe(true);
      expect(result).toHaveProperty('unmapped_files', [`renamed${extension}`]);
    },
  );

  it('retains mapped symbols while withholding ranked risk for an unmapped source', async () => {
    const repoDir = makeRepo(['code.py', 'other.ts'], 2);
    writeFileSync(path.join(repoDir, 'code.py'), 'changed\nline 2\n');
    writeFileSync(path.join(repoDir, 'other.ts'), 'changed\nline 2\n');
    registerRepo(repoDir);
    mockSymbolRows([{ name: 'known', startLine: 0, endLine: 1 }]);
    const result = await runDetectChanges();
    expect(result.summary).toMatchObject({
      changed_files: 2,
      changed_count: 1,
      risk_level: 'unknown',
    });
    expect(result.changed_symbols.map((symbol) => symbol.name)).toEqual(['known']);
    expect(result.partial).toBe(true);
    expect(result).toHaveProperty('unmapped_files', ['other.ts']);
  });

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
    expect(Object.keys(calls[0].params)).toEqual(['bounds', 'paths', 'suffixes']);
    expect(calls[0].query).not.toContain('$hunk');
  });

  it.each(['local.ts', 'local.py'])(
    '#2699 maps %s by position and only reports its id',
    async (file) => {
      const repoDir = makeRepo([file], 1);
      writeFileSync(path.join(repoDir, file), 'value = 1\n');
      registerRepo(repoDir);
      await runDetectChanges();

      const calls = symbolQueryCalls();
      expect(calls).toHaveLength(1);
      const { query } = calls[0];
      const [predicates, projection] = query.split('RETURN');
      expect(predicates).toContain('n.startLine IS NOT NULL AND n.endLine IS NOT NULL');
      expect(predicates).toContain('n.startLine <= b.hi AND n.endLine >= b.lo');
      expect(predicates).toContain("NOT n.id STARTS WITH 'BasicBlock:'");
      expect(predicates).not.toMatch(/n\.id\s*(?:=|IN\b)/i);
      expect(projection).toContain('n.id AS id');
      if (file === 'local.py') {
        expect(projection).toMatch(
          /ORDER BY b\.path, \(n\.filePath = b\.path\) DESC, n\.id LIMIT \d+/,
        );
      } else {
        expect(projection).not.toMatch(/ORDER BY|LIMIT/);
      }
    },
  );

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
    // The batch-wide prefilter is derived from the batch in hand. Fed the whole
    // diff's paths it would over-scan; fed another batch's it would drop rows
    // the correlated `b` match is entitled to keep.
    expect(calls.map((c) => c.params.paths)).toEqual(
      calls.map((c) => c.params.bounds.map((bound) => bound.path)),
    );
    expect(calls.map((c) => c.params.suffixes)).toEqual(
      calls.map((c) => c.params.bounds.map((bound) => bound.suffix)),
    );
  });

  it('reports a symbol edited on its last line (0-based rows vs 1-based hunks, #2377)', async () => {
    // Touch source line 2 only. `hello` spans source lines 1–2, stored 0-based
    // as [0, 1] — the old raw comparison saw hunk [2,2] vs [0,1] and missed it.
    const result = await detectChangesForCodePy('line 1\nline 2 changed\n', [
      { name: 'hello', startLine: 0, endLine: 1 },
    ]);

    expect(result.changed_symbols.map((s) => s.name)).toEqual(['hello']);
    expect(result.summary.changed_count).toBe(1);
  });

  it('does not report a symbol that ends one line above the hunk', async () => {
    // 0-based [0,2] = source lines 1–3; the hunk is source line 4.
    const result = await detectChangesForCodePy('line 1\nline 2\nline 3\nline 4 changed\n', [
      { name: 'above', startLine: 0, endLine: 2 },
    ]);

    expect(result.changed_symbols).toEqual([]);
  });

  it('caps the listed symbols without capping the counts', async () => {
    const result = await detectChangesForCodePy(
      'line 1 changed\nline 2\n',
      Array.from({ length: 1200 }, (_, i) => ({ name: `fn${i}`, startLine: 0, endLine: 1 })),
    );

    expect(result.changed_symbols).toHaveLength(1000);
    // The gate's own number stays true, so the CLI's "... and N more" and any
    // client comparing list length against the count still see 1,200.
    expect(result.summary.changed_count).toBe(1200);
    expect(result.truncated).toBe(true);
  });

  it('counts a path the diff reports twice as one changed file', async () => {
    // A file header is a line starting `+++ b/`, and under `-U0` an ADDED line
    // whose own text starts `++ b/` renders as exactly that — which is how a
    // repo that tracks patch/diff fixtures gets one path reported twice. The
    // count is over DISTINCT paths, so the second entry must not inflate it.
    const repoDir = makeRepo(['code.py'], 4);
    writeFileSync(
      path.join(repoDir, 'code.py'),
      'line 1 changed\nline 2\nline 3\nline 4\n++ b/code.py\n',
    );
    registerRepo(repoDir);

    // A content line that is itself `+++ b/code.py` must not open a second
    // FileDiff — the same-path skip is the intended shape (#3251).
    const parsed = parseDiffHunks(
      execFileSync('git', diffArgsFor('unstaged'), { cwd: repoDir, encoding: 'utf-8' }),
    );
    expect(parsed.map((fileDiff) => fileDiff.filePath)).toEqual(['code.py']);

    const result = await runDetectChanges();

    expect(result.summary.changed_files).toBe(1);
  });

  it('reports a node matched by two changed paths once', async () => {
    // One node can come back once per changed path whose suffix it matches.
    const result = await detectChangesForCodePy('line 1 changed\nline 2\n', [
      { name: 'hello', startLine: 0, endLine: 1 },
      { name: 'hello', startLine: 0, endLine: 1 },
    ]);

    expect(result.changed_symbols.map((s) => s.name)).toEqual(['hello']);
  });

  it("carries the node's label in `type`", async () => {
    // `labels(n)[0]` is '' (see projectTypeColumn), so every reported symbol
    // used to arrive untyped and the CLI printed the `Symbol` placeholder.
    const result = await detectChangesForCodePy('line 1 changed\nline 2\n', [
      { name: 'hello', startLine: 0, endLine: 1 },
    ]);

    expect(result.changed_symbols).toEqual([
      {
        id: 'Function:code.py:hello',
        name: 'hello',
        type: 'Function',
        filePath: 'code.py',
        change_type: 'touched',
      },
    ]);
  });

  it('does not fan an empty-id symbol out through empty-id process steps (#3931)', async () => {
    const processQueries: string[][] = [];
    lbugMocks.executeParameterized.mockImplementation(
      async (_db: string, query: string, params: SymbolQueryParams | { ids?: string[] }) => {
        if (String(query).includes('diffPath')) {
          return [
            {
              diffPath: 'code.py',
              id: '',
              name: '',
              type: '',
              filePath: 'code.py',
              startLine: 0,
              endLine: 1,
            },
          ];
        }
        if (String(query).includes('STEP_IN_PROCESS')) {
          const ids = 'ids' in params ? (params.ids ?? []) : [];
          processQueries.push(ids);
          return [
            {
              nodeId: '',
              pid: 'Process:unrelated',
              label: 'unrelated flow',
              processType: 'cross_community',
              stepCount: 3,
              step: 2,
            },
          ];
        }
        return [];
      },
    );

    const repoDir = makeRepo(['code.py'], 2);
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1 changed\nline 2\n');
    registerRepo(repoDir);

    const result = await runDetectChanges();

    expect(processQueries).toEqual([]);
    expect(result.changed_symbols).toEqual([]);
    expect(result.affected_processes).toEqual([]);
    expect(result.unmapped_files).toEqual(['code.py']);
    expect(result.partial).toBe(true);
    expect(result.summary.risk_level).toBe('unknown');
  });

  it.each([
    { kind: 'an empty', id: '' },
    { kind: 'a whitespace-only', id: '  ' },
    { kind: 'a NUL-containing', id: 'Function:code.py:\0' },
  ])(
    'withholds a ranked verdict when $kind id sits beside a valid symbol (#3931)',
    async ({ id }) => {
      mockSymbolRows([
        { name: 'ok', startLine: 0, endLine: 1 },
        { id, name: 'corrupt', startLine: 0, endLine: 1 },
      ]);
      const repoDir = makeRepo(['code.py'], 2);
      writeFileSync(path.join(repoDir, 'code.py'), 'line 1 changed\nline 2\n');
      registerRepo(repoDir);

      const result = await runDetectChanges();

      // The valid row maps the file, so `partial` here can only come from the
      // identity check — not from the unmapped-file rule the case above trips.
      expect(result.changed_symbols.map((symbol) => symbol.name)).toEqual(['ok']);
      expect(result.unmapped_files).toBeUndefined();
      expect(result.partial).toBe(true);
      expect(result.summary.risk_level).toBe('unknown');
    },
  );

  it('emits the same order however the engine happens to order its rows', async () => {
    // The query has no ORDER BY, so row order was the engine's — measured at 5
    // distinct orders across 8 runs — and both the 1000-symbol cut and the
    // process lookup read it. Rows arrive here in the exact reverse of the
    // (filePath, startLine, id) order they must come out in.
    const repoDir = makeRepo(['a.txt', 'b.txt'], 10);
    const edited =
      Array.from({ length: 10 }, (_, i) =>
        i === 0 || i === 6 ? `line ${i + 1} changed` : `line ${i + 1}`,
      ).join('\n') + '\n';
    writeFileSync(path.join(repoDir, 'a.txt'), edited);
    writeFileSync(path.join(repoDir, 'b.txt'), edited);
    registerRepo(repoDir);
    mockSymbolRows([
      { name: 'beta', filePath: 'b.txt', startLine: 0, endLine: 1 },
      { name: 'zeta', filePath: 'a.txt', startLine: 5, endLine: 6 },
      { name: 'mid', filePath: 'a.txt', startLine: 0, endLine: 1 },
      { name: 'alpha', filePath: 'a.txt', startLine: 0, endLine: 1 },
    ]);

    const result = await runDetectChanges();

    expect(result.changed_symbols.map((s) => s.name)).toEqual(['alpha', 'mid', 'zeta', 'beta']);
  });

  it('keeps the surviving batches and flags the run partial when one fails', async () => {
    // Failure granularity is a BATCH of up to 100 files, not one file: a
    // swallowed error drops 100 files' symbols and the result would otherwise
    // read as a clean, lower-risk run.
    const files = Array.from({ length: 120 }, (_, i) => `f${String(i).padStart(3, '0')}.txt`);
    const repoDir = makeRepo(files, 10);
    for (const file of files) editEveryNthLine(repoDir, file, 10, 5);
    registerRepo(repoDir);
    // git emits the diff in path order, so this is the first batch of 100.
    mockBatchFailure('f000.txt');

    const result = await runDetectChanges();

    expect(result.changed_symbols.map((s) => s.name)).toEqual(
      Array.from({ length: 20 }, (_, i) => `sym@f${100 + i}.txt`),
    );
    expect(result.summary.changed_count).toBe(20);
    expect(result.partial).toBe(true);
    expect(result.summary.risk_level).toBe('unknown');
  });

  it('keeps the mapped symbol count when only process lookup fails', async () => {
    const file = 'main.ts';
    const repoDir = makeRepo([file], 1);
    editEveryNthLine(repoDir, file, 1, 1);
    registerRepo(repoDir);
    lbugMocks.executeParameterized.mockImplementation(async (_db: string, query: string) => {
      if (query.includes('STEP_IN_PROCESS')) throw new Error('injected process lookup failure');
      if (!query.includes('diffPath')) return [];
      return [
        {
          id: 'Function:main.ts:main',
          name: 'main',
          type: 'Function',
          diffPath: file,
          filePath: file,
          startLine: 0,
          endLine: 0,
        },
      ];
    });

    expect(await runDetectChanges()).toMatchObject({
      partial: true,
      summary: { changed_count: 1, affected_count: 0, risk_level: 'unknown' },
      changed_symbols: [{ name: 'main' }],
      affected_processes: [],
    });
  });

  it('reports a run whose every batch failed as unknown risk, not a clean zero', async () => {
    const repoDir = makeRepo(['code.py'], 4);
    writeFileSync(path.join(repoDir, 'code.py'), 'line 1 changed\nline 2\nline 3\nline 4\n');
    registerRepo(repoDir);
    mockBatchFailure('code.py');

    const result = await runDetectChanges();

    // The #2915 field report: a swallowed query failure printed "No changes
    // detected." and exited 0 over a diff that really did change code.
    expect(result.changed_symbols).toEqual([]);
    expect(result.summary.changed_count).toBe(0);
    expect(result.partial).toBe(true);
    expect(result.summary.risk_level).toBe('unknown');
  });

  it('reports the enclosing symbol for a diff that only deletes lines', async () => {
    // `git diff -U0` reports the deletion of source lines 2–3 as `@@ -2,2 +1,0
    // @@` — new-side count 0. Dropped as "no hunks", the file mapped to nothing
    // and a deleted function body came back `changed_files: 1, changed_count: 0`.
    const result = await detectChangesForCodePy(
      'line 1\nline 4\n',
      [{ name: 'hello', startLine: 0, endLine: 3 }],
      4,
    );

    expect(result.changed_symbols.map((s) => s.name)).toEqual(['hello']);
    expect(result.summary.changed_files).toBe(1);
    expect(result.summary.changed_count).toBe(1);
  });

  it('anchors a deletion at the head of the file, where git reports `+0,0`', async () => {
    // Deleting source line 1 gives `@@ -1 +0,0 @@` — the one header shape whose
    // OLD side carries no count and whose new-side anchor is line 0, before the
    // first line of the file. Both halves have to survive: a header pattern
    // requiring `-N,M` skips this hunk entirely and the deletion goes
    // unreported. (The anchor's own clamp to 1 is belt-and-braces here —
    // `toZeroBasedLine` clamps at 0 as well — so it is pinned at the parser
    // level, in test/unit/parse-diff-hunks.test.ts.)
    const result = await detectChangesForCodePy(
      'line 2\nline 3\nline 4\n',
      [{ name: 'hello', startLine: 0, endLine: 1 }],
      4,
    );

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
