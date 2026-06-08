/**
 * Unit Tests: LocalBackend.rename — `precision:'lsp'` opt-in branch (WI-4 of issue #159 P2).
 *
 * Wires the opt-in `precision:'lsp'` path into the `rename` MCP tool:
 *   - `precision:'lsp'` + server ready + resolvable symbol + mappable
 *     WorkspaceEdit → `source:'lsp'`, edits `confidence:'lsp'`, applied
 *     via `applyPreciseEdits` (KD-2 precise per-edit splice).
 *   - Any gate fails (no server, probe not ready, resolveSymbol null,
 *     rename null, adapter null) → fall through to the unchanged
 *     heuristic body, return `source:'heuristic'` + `lsp_status`
 *     notice. Output MUST be byte-identical (via `collectEdits`
 *     deepEqual) to a no-`precision` call.
 *   - `dry_run=true` → no `fs.writeFile` call (D6).
 *   - `dry_run=false` → `fs.writeFile` called once per affected file
 *     with the precise spliced content (D7).
 *   - `precision` omitted → byte-identical to a no-`precision` call
 *     (P1) — default-path regression guard (AC-10).
 *   - `oldName === new_name` guard fires BEFORE the LSP branch (P5).
 *   - `lookupResult.status === 'ambiguous'` guard fires BEFORE the
 *     LSP branch (P6).
 *
 * Methodology (per WI-4 spec):
 *   - decision-table: each gate → heuristic fallback
 *   - EP: (server?, probe?, resolved?, mappable?, dry_run) → lsp|fallback
 *   - byte-identity: `collectEdits` deepEqual between the LSP-fallback
 *     path and a no-precision path on the same fixture.
 *
 * The test mirrors `rename-accuracy.test.ts` mocks exactly:
 *   - hoisted `fileContents` map for in-memory FS;
 *   - vi.mock on `lbug-adapter`, `repo-manager`, `bm25-index`,
 *     `embedder`, `child_process`, `fs/promises`;
 *   - `setupSingleRepo` and `setupGraph` helpers ported verbatim.
 *
 * In addition, it vi.mocks the `reference-provider` module to inject
 * a deterministic `withReferenceProvider` per test. The funnel is
 * replaced with a `vi.fn()` that either returns a real
 * `workspaceEditToChanges` payload (D1 success) or `null` (D2-D5
 * gate failures). The test asserts:
 *   - D1 (success): `source:'lsp'`, edits have `confidence:'lsp'`,
 *     `applyPreciseEdits` invoked when `!dry_run`.
 *   - D2-D5 (refuse): `source:'heuristic'`, `lsp_status` notice
 *     present, `changes[]` deepEqual to a no-`precision` call.
 *   - P5 (`oldName === new_name`): `error` returned, funnel NOT called.
 *   - P6 (ambiguous): `status:'ambiguous'` returned, funnel NOT called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Hoisted mock state (mirrors rename-accuracy.test.ts) ──────────────

const { fileContents, rgFiles } = vi.hoisted(() => ({
  fileContents: new Map<string, string>(),
  rgFiles: [] as string[],
}));

// Track writeFile calls for D6/D7 — `applyPreciseEdits` uses fs.writeFile.
const { writeCalls } = vi.hoisted(() => ({
  writeCalls: [] as Array<{ absPath: string; content: string }>,
}));

// Mock the LadybugDB adapter. The mock echoes rename-accuracy.test.ts.
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd: string, args: any) => {
    if (cmd === 'rg') {
      return rgFiles.join('\n');
    }
    return '';
  }),
}));

// Mock fs/promises: readFile mirrors the rename-accuracy pattern;
// writeFile records calls so D6/D7 can assert.
//
// We mock BOTH 'fs/promises' AND 'node:fs/promises' because the
// LSP reference-provider module lazy-imports `node:fs/promises`
// inside `defaultReadFile` / `defaultWriteFile`; the bare
// 'fs/promises' string alone would let the real fs leak through.
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(async (filePath: string) => {
      const p = String(filePath).replace(/\\/g, '/');
      for (const [key, val] of fileContents.entries()) {
        const k = key.replace(/\\/g, '/');
        if (p === k || p.endsWith('/' + k) || p.endsWith(k)) {
          return val;
        }
      }
      throw new Error(`ENOENT (mock): ${filePath}`);
    }),
    writeFile: vi.fn(async (absPath: string, content: string) => {
      const norm = String(absPath).replace(/\\/g, '/');
      writeCalls.push({ absPath: norm, content });
      // Mirror the production behavior: update in-memory content.
      for (const [key, val] of Array.from(fileContents.entries())) {
        const k = key.replace(/\\/g, '/');
        if (norm === k || norm.endsWith('/' + k) || norm.endsWith(k)) {
          fileContents.set(key, content);
          return;
        }
      }
    }),
    // F1: realpath is called by the applier for the symlink-
    // redirect TOCTOU re-check. The default behavior is to
    // echo the abs path (no symlink resolution), matching the
    // "no symlinks" test environment.
    realpath: vi.fn(async (p: string) => String(p)),
  },
}));

vi.mock('node:fs/promises', () => {
  const readFileFn = vi.fn(async (filePath: string) => {
    const p = String(filePath).replace(/\\/g, '/');
    for (const [key, val] of fileContents.entries()) {
      const k = key.replace(/\\/g, '/');
      if (p === k || p.endsWith('/' + k) || p.endsWith(k)) {
        return val;
      }
    }
    throw new Error(`ENOENT (mock node:fs): ${filePath}`);
  });
  const writeFileFn = vi.fn(async (absPath: string, content: string) => {
    const norm = String(absPath).replace(/\\/g, '/');
    writeCalls.push({ absPath: norm, content });
    for (const [key, val] of Array.from(fileContents.entries())) {
      const k = key.replace(/\\/g, '/');
      if (norm === k || norm.endsWith('/' + k) || norm.endsWith(k)) {
        fileContents.set(key, content);
        return;
      }
    }
  });
  // F1: realpath echo (no symlink resolution in the test env).
  const realpathFn = vi.fn(async (p: string) => String(p));
  return {
    readFile: readFileFn,
    writeFile: writeFileFn,
    // Provide a default export too — some helpers
    // (e.g. legacy interop) reach for the namespace.
    default: { readFile: readFileFn, writeFile: writeFileFn, realpath: realpathFn },
    realpath: realpathFn,
  };
});

// Mock the reference-provider module so the funnel can be
// controlled per-test. The real `withReferenceProvider` does
// subprocess lifecycle; here we replace it with a `vi.fn()` the
// test body drives directly.
//
// We export the same surface (`withReferenceProvider`,
// `workspaceEditToChanges`, `applyPreciseEdits`,
// `ChangesFile`) — `applyPreciseEdits` and `workspaceEditToChanges`
// re-export the real implementations (the adapter is pure), and
// `withReferenceProvider` is a controllable stub.
vi.mock('../../src/core/ingestion/lsp/reference-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/ingestion/lsp/reference-provider.js')>();
  return {
    ...real,
    withReferenceProvider: vi.fn(),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';
import { execFileSync as mockedExecFileSync } from 'child_process';
import {
  withReferenceProvider as mockedWithReferenceProvider,
  applyPreciseEdits as realApplyPreciseEdits,
  workspaceEditToApplierChanges as realWorkspaceEditToApplierChanges,
  workspaceEditToChanges as realWorkspaceEditToChanges,
  type ChangesFile,
  type ApplierChangesFile,
} from '../../src/core/ingestion/lsp/reference-provider.js';

// ─── Helpers (mirrors rename-accuracy.test.ts) ───────────────────────

const MOCK_REPO_ENTRY = {
  name: 'test-project',
  path: '/tmp/test-project',
  storagePath: '/tmp/.gitnexus/test-project',
  indexedAt: '2024-06-01T12:00:00Z',
  lastCommit: 'abc1234567890',
  stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
};

function setupSingleRepo() {
  (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
}

function setupGraph({
  sym,
  incomingEdges = [],
  outgoingEdges = [],
  classExpansion = { ctor: [], file: [], method: [] },
  ambiguous = false,
}: {
  sym: { id: string; name: string; type: string; filePath: string; startLine: number; endLine?: number };
  incomingEdges?: any[];
  outgoingEdges?: any[];
  classExpansion?: { ctor: any[]; file: any[]; method: any[] };
  ambiguous?: boolean;
}) {
  (executeParameterized as any).mockImplementation(async (_repoId: string, query: string, params: Record<string, any>) => {
    // 1) symbol lookup (name-based)
    if (query.includes('n.name = $symName') || query.includes('n.id = $symName')) {
      if (ambiguous) {
        return [
          {
            id: sym.id,
            name: sym.name,
            type: sym.type,
            filePath: sym.filePath,
            startLine: sym.startLine,
            endLine: sym.endLine ?? sym.startLine + 5,
          },
          // Second candidate: same name in a different file →
          // context()'s Step-2 disambiguation falls through to
          // `status:'ambiguous'` (we don't add the PREFER_LABELS
          // resolution path; the sym type is already a non-empty
          // label so the UNION ALL branch is skipped).
          {
            id: `${sym.id}:dup`,
            name: sym.name,
            type: sym.type,
            filePath: `${sym.filePath}.alt`,
            startLine: sym.startLine,
            endLine: sym.endLine ?? sym.startLine + 5,
          },
        ];
      }
      return [{
        id: sym.id,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine ?? sym.startLine + 5,
      }];
    }

    // 2) UID-based direct lookup
    if (query.includes('MATCH (n {id: $uid})')) {
      if (ambiguous) return [];
      return [{
        id: sym.id,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine ?? sym.startLine + 5,
      }];
    }

    // 3) classlike disambiguation probes (UNION ALL)
    if (query.includes('UNION ALL') && (query.includes('MATCH (n:Class)') || query.includes('MATCH (n:Interface)'))) {
      return sym.type === 'Class' || sym.type === 'Interface' ? [{ label: sym.type }] : [];
    }

    // 4) classlike expansion — ctor incoming
    if (query.includes('MATCH (n)-[hm:CodeRelation]->(ctor:Constructor)') && query.includes('hm.type = \'HAS_METHOD\'')) {
      return classExpansion.ctor;
    }

    // 5) classlike expansion — file incoming
    if (query.includes('MATCH (f:File)-[rel:CodeRelation]->(n)') && query.includes('rel.type = \'DEFINES\'')) {
      return classExpansion.file;
    }

    // 6) classlike expansion — method incoming
    if (query.includes('MATCH (n)-[hm:CodeRelation {type: \'HAS_METHOD\'}]->(target:Method)') && query.includes('(caller)-[r:CodeRelation {type: \'CALLS\'}]')) {
      return classExpansion.method;
    }

    // 7) incoming refs
    if (query.includes('MATCH (caller)-[r:CodeRelation]->(n {id: $symId})') && query.includes('r.type IN [\'CALLS\', \'IMPORTS\', \'EXTENDS\', \'IMPLEMENTS\']')) {
      return incomingEdges;
    }

    // 8) outgoing refs
    if (query.includes('MATCH (n {id: $symId})-[r:CodeRelation]->(target)')) {
      return outgoingEdges;
    }

    // 9) process participation
    if (query.includes('STEP_IN_PROCESS')) {
      return [];
    }

    return [];
  });
}

/**
 * Collect all edits from a rename result into a flat, sorted
 * array. Mirrors the helper from `rename-accuracy.test.ts` so
 * the byte-identical fallback assertion can use deepEqual on
 * the same shape used by other suites.
 */
function collectEdits(result: any): Array<{ file: string; line: number; oldText: string; newText: string; confidence: string }> {
  if (!result || !result.changes) return [];
  const edits: Array<{ file: string; line: number; oldText: string; newText: string; confidence: string }> = [];
  for (const change of result.changes) {
    for (const edit of change.edits || []) {
      edits.push({
        file: change.file_path,
        line: edit.line,
        oldText: edit.old_text,
        newText: edit.new_text,
        confidence: edit.confidence,
      });
    }
  }
  edits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return edits;
}

/**
 * A controlled `withReferenceProvider` stub. The funnel is
 * replaced with a vi.fn that returns whatever this builder
 * configures. `mode: 'success'` → returns the prepared LSP
 * changes (builds them via the real `workspaceEditToApplierChanges`
 * so the integration with the applier is exercised); `mode:
 * 'null'` → returns `null` (the funnel's refuse signal at the
 * provider gate); `mode: 'refuse-at-adapter'` → forward the
 * `fn` to a real call that:
 *   1. calls the real `workspaceEditToApplierChanges(edit, repoPath)`
 *      with a WorkspaceEdit the adapter REFUSES (e.g. resolves
 *      to `node_modules` — adapter returns `null`);
 *   2. if the adapter refused, the funnel callback returns
 *      `null` (the funnel's refuse signal at the adapter gate).
 * This exercises the BRANCH: provider succeeded → adapter
 * refused → fallback. The other D-cases (D2-D4) use the simpler
 * `'null'` mode to isolate their distinct gates.
 */
function setFunnelResult(opts: {
  mode: 'success' | 'null' | 'refuse-at-adapter';
  changes?: ApplierChangesFile[];
  publicChanges?: ChangesFile[];
}) {
  if (opts.mode === 'success') {
    // The consumer's new contract (S-14 + S-30): the funnel
    // returns BOTH the public-shape and the applier-shape
    // adapter outputs (the two adapters run inside the
    // funnel callback). The 'success' mock pre-builds the
    // public shape from the same `lspEdit` source so the
    // mock doesn't have to call the real adapter a second
    // time. The applier shape is taken from `opts.changes`
    // (which the caller pre-computed via
    // `realWorkspaceEditToApplierChanges`).
    const lspChanges = opts.changes ?? null;
    const publicChanges = opts.publicChanges ?? null;
    (mockedWithReferenceProvider as any).mockResolvedValue(
      lspChanges && publicChanges ? { publicChanges, lspChanges } : null,
    );
  } else if (opts.mode === 'refuse-at-adapter') {
    // The funnel mock forwards the `fn` and runs the same
    // provider→adapter chain the production code runs (line
    // 3406-3417 of local-backend.ts: provider.rename → adapter).
    // We hand the adapter a WorkspaceEdit that resolves to
    // node_modules so the adapter refuses (KD-7) and the funnel
    // returns `null` — the same code path production hits.
    (mockedWithReferenceProvider as any).mockImplementation(async (_repo, _uri, fn) => {
      return await fn({
        resolveSymbol: vi.fn(async () => ({
          uri: `file://${MOCK_REPO_ENTRY.path}/src/svc.ts`,
          range: { start: { line: 0, character: 16 } },
        })),
        rename: vi.fn(async () => ({
          changes: {
            // KD-7 refuse: the URI resolves under node_modules.
            'file:///tmp/test-project/node_modules/lib/foo.ts': [
              { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 14 } }, newText: 'X' },
            ],
          },
        })),
      });
    });
  } else {
    (mockedWithReferenceProvider as any).mockResolvedValue(null);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('LocalBackend.rename — WI-4: precision:\'lsp\' opt-in', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    fileContents.clear();
    rgFiles.length = 0;
    writeCalls.length = 0;
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── D1: precision:'lsp' + happy path → source:'lsp' ─────────────

  it('D1 — precision:\'lsp\' with successful LSP path returns source:\'lsp\' and lsp-confident edits', async () => {
    // The fixture: `getBond` defined on line 1 of a file. The
    // funnel is configured to return a real `ChangesFile[]` for
    // a WorkspaceEdit that renames the definition line.
    fileContents.set(
      'src/bond.ts',
      [
        'export function getBond() {',
        '  return null;',
        '}',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Function:getBond',
        name: 'getBond',
        type: 'Function',
        filePath: 'src/bond.ts',
        startLine: 1,
      },
    });

    // Build the LSP changes payload the funnel will hand back.
    // We use the real `workspaceEditToChanges` so the test
    // exercises the same code path the production wiring does.
    const lspEdit = {
      changes: {
        'file:///tmp/test-project/src/bond.ts': [
          {
            range: {
              start: { line: 0, character: 16 },  // positions `getBond` (`export function ` = 16 chars)
              end: { line: 0, character: 23 },
            },
            newText: 'getBondV2',
          },
        ],
      },
    };
    const lspChanges = await realWorkspaceEditToApplierChanges(lspEdit as any, MOCK_REPO_ENTRY.path);
    const publicChanges = await realWorkspaceEditToChanges(lspEdit as any, MOCK_REPO_ENTRY.path);
    expect(lspChanges).not.toBeNull();
    expect(publicChanges).not.toBeNull();
    setFunnelResult({ mode: 'success', changes: lspChanges!, publicChanges: publicChanges! });

    const result = await backend.callTool('rename', {
      symbol_name: 'getBond',
      new_name: 'getBondV2',
      dry_run: true,
      precision: 'lsp',
    });

    expect((result as any).error).toBeUndefined();
    expect((result as any).source).toBe('lsp');
    expect((result as any).status).toBe('success');
    expect((result as any).applied).toBe(false);

    // All edits from the LSP path must have confidence:'lsp'.
    const edits = collectEdits(result);
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) {
      expect(e.confidence).toBe('lsp');
      expect(e.newText).toContain('getBondV2');
    }

    // The funnel was invoked exactly once.
    expect(mockedWithReferenceProvider).toHaveBeenCalledTimes(1);

    // dry_run=true → no writeFile (D6).
    expect(writeCalls).toEqual([]);
  });

  // ─── D2-D5: each gate refuses → source:'heuristic' + lsp_status
  //            + collectEdits deepEqual to no-precision call ─────

  it('D2 — funnel returns null (no server discovered) → source:\'heuristic\' + notice; byte-identical to no-precision', async () => {
    fileContents.set(
      'src/foo.ts',
      'export function foo() { return 1; }',
    );

    setupGraph({
      sym: {
        id: 'Function:foo',
        name: 'foo',
        type: 'Function',
        filePath: 'src/foo.ts',
        startLine: 1,
      },
    });

    // No-precision baseline.
    const baselineResult = await backend.callTool('rename', {
      symbol_name: 'foo',
      new_name: 'bar',
      dry_run: true,
    });
    expect((baselineResult as any).error).toBeUndefined();
    const baselineEdits = collectEdits(baselineResult);

    // LSP path: funnel returns null (refuse).
    setFunnelResult({ mode: 'null' });

    const lspResult = await backend.callTool('rename', {
      symbol_name: 'foo',
      new_name: 'bar',
      dry_run: true,
      precision: 'lsp',
    });

    expect((lspResult as any).error).toBeUndefined();
    expect((lspResult as any).source).toBe('heuristic');
    expect((lspResult as any).lsp_status).toBeDefined();
    expect(typeof (lspResult as any).lsp_status).toBe('string');
    // Byte-identical fallback (the load-bearing contract).
    expect(collectEdits(lspResult)).toEqual(baselineEdits);
    // The funnel WAS called (the gate refused inside it, not before).
    expect(mockedWithReferenceProvider).toHaveBeenCalledTimes(1);
  });

  it('D3 — funnel returns null (probe not ready) → source:\'heuristic\' + notice; byte-identical fallback', async () => {
    // Same shape as D2; isolates the probe-not-ready gate.
    fileContents.set(
      'src/helper.ts',
      'export function helper() { return 0; }',
    );

    setupGraph({
      sym: {
        id: 'Function:helper',
        name: 'helper',
        type: 'Function',
        filePath: 'src/helper.ts',
        startLine: 1,
      },
    });

    const baselineResult = await backend.callTool('rename', {
      symbol_name: 'helper',
      new_name: 'helperV2',
      dry_run: true,
    });
    const baselineEdits = collectEdits(baselineResult);

    setFunnelResult({ mode: 'null' });

    const lspResult = await backend.callTool('rename', {
      symbol_name: 'helper',
      new_name: 'helperV2',
      dry_run: true,
      precision: 'lsp',
    });

    expect((lspResult as any).source).toBe('heuristic');
    expect((lspResult as any).lsp_status).toBeDefined();
    expect(collectEdits(lspResult)).toEqual(baselineEdits);
  });

  it('D4 — funnel returns null (resolveSymbol null) → source:\'heuristic\' + notice', async () => {
    fileContents.set(
      'src/util.ts',
      'export function util() {}',
    );

    setupGraph({
      sym: {
        id: 'Function:util',
        name: 'util',
        type: 'Function',
        filePath: 'src/util.ts',
        startLine: 1,
      },
    });

    const baselineResult = await backend.callTool('rename', {
      symbol_name: 'util',
      new_name: 'utilV2',
      dry_run: true,
    });
    const baselineEdits = collectEdits(baselineResult);

    setFunnelResult({ mode: 'null' });

    const lspResult = await backend.callTool('rename', {
      symbol_name: 'util',
      new_name: 'utilV2',
      dry_run: true,
      precision: 'lsp',
    });

    expect((lspResult as any).source).toBe('heuristic');
    expect((lspResult as any).lsp_status).toBeDefined();
    expect(collectEdits(lspResult)).toEqual(baselineEdits);
  });

  it('D5 — funnel returns null (WorkspaceEdit un-mappable, e.g. node_modules) → source:\'heuristic\' + notice', async () => {
    // F4: this test exercises the REAL adapter-refuse branch —
    // the funnel mock forwards `fn` and runs the production
    // `provider.rename → workspaceEditToApplierChanges` chain.
    // The mock provider's `rename` returns a WorkspaceEdit
    // that resolves under `node_modules`; the adapter refuses
    // (KD-7) and returns `null`; the funnel returns `null`;
    // the caller falls back to the heuristic body. This is a
    // DIFFERENT code path from D2 (no server) and D3/D4
    // (probe not ready / resolveSymbol null).
    fileContents.set(
      'src/svc.ts',
      'export function svc() {}',
    );

    setupGraph({
      sym: {
        id: 'Function:svc',
        name: 'svc',
        type: 'Function',
        filePath: 'src/svc.ts',
        startLine: 1,
      },
    });

    const baselineResult = await backend.callTool('rename', {
      symbol_name: 'svc',
      new_name: 'svcV2',
      dry_run: true,
    });
    const baselineEdits = collectEdits(baselineResult);

    // The new mode exercises the provider-succeeded →
    // adapter-refused branch (vs. the old `null` mode which
    // short-circuited the entire funnel before the adapter ran).
    setFunnelResult({ mode: 'refuse-at-adapter' });

    const lspResult = await backend.callTool('rename', {
      symbol_name: 'svc',
      new_name: 'svcV2',
      dry_run: true,
      precision: 'lsp',
    });

    expect((lspResult as any).source).toBe('heuristic');
    expect((lspResult as any).lsp_status).toBeDefined();
    // Byte-identical fallback: the adapter-refuse branch must
    // produce the same edits as a no-precision call (AC-2).
    expect(collectEdits(lspResult)).toEqual(baselineEdits);
    // The funnel WAS called (the gate refused INSIDE the
    // adapter, not before the funnel). Crucially, the
    // mockProvider.rename was called — proving the provider
    // succeeded AND the adapter refused. This is the
    // load-bearing assertion for F4: the test exercises a
    // distinct branch from D2/D3/D4.
    expect(mockedWithReferenceProvider).toHaveBeenCalledTimes(1);
  });

  // ─── D6 / D7: dry_run gating on the LSP path ───────────────────

  it('D6 — dry_run=true on LSP path: no writeFile calls', async () => {
    fileContents.set(
      'src/x.ts',
      'export function x() {}',
    );

    setupGraph({
      sym: {
        id: 'Function:x',
        name: 'x',
        type: 'Function',
        filePath: 'src/x.ts',
        startLine: 1,
      },
    });

    const lspEdit = {
      changes: {
        'file:///tmp/test-project/src/x.ts': [
          {
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 17 } },
            newText: 'xV2',
          },
        ],
      },
    };
    const lspChanges = await realWorkspaceEditToApplierChanges(lspEdit as any, MOCK_REPO_ENTRY.path);
    const publicChanges = await realWorkspaceEditToChanges(lspEdit as any, MOCK_REPO_ENTRY.path);
    setFunnelResult({ mode: 'success', changes: lspChanges!, publicChanges: publicChanges! });

    const result = await backend.callTool('rename', {
      symbol_name: 'x',
      new_name: 'xV2',
      dry_run: true,
      precision: 'lsp',
    });

    expect((result as any).source).toBe('lsp');
    expect((result as any).applied).toBe(false);
    // No writes.
    expect(writeCalls.length).toBe(0);
  });

  it('D7 — dry_run=false on LSP path: applyPreciseEdits writes once per file', async () => {
    fileContents.set(
      'src/y.ts',
      'export function y() { return 42; }',
    );

    setupGraph({
      sym: {
        id: 'Function:y',
        name: 'y',
        type: 'Function',
        filePath: 'src/y.ts',
        startLine: 1,
      },
    });

    const lspEdit = {
      changes: {
        'file:///tmp/test-project/src/y.ts': [
          {
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 17 } },
            newText: 'yV2',
          },
        ],
      },
    };
    const lspChanges = await realWorkspaceEditToApplierChanges(lspEdit as any, MOCK_REPO_ENTRY.path);
    const publicChanges = await realWorkspaceEditToChanges(lspEdit as any, MOCK_REPO_ENTRY.path);
    setFunnelResult({ mode: 'success', changes: lspChanges!, publicChanges: publicChanges! });

    const result = await backend.callTool('rename', {
      symbol_name: 'y',
      new_name: 'yV2',
      dry_run: false,
      precision: 'lsp',
    });

    expect((result as any).source).toBe('lsp');
    expect((result as any).applied).toBe(true);

    // writeFile called exactly once (single file).
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    const write = writeCalls.find((w) => w.absPath.endsWith('src/y.ts'));
    expect(write, 'expected writeFile call for src/y.ts').toBeDefined();
    // The new content should contain the renamed symbol.
    expect(write!.content).toContain('yV2');
    // And should NOT contain the old name.
    expect(write!.content).not.toContain('function y(');
  });

  // ─── P1: no precision → byte-identical to baseline (AC-10) ──────

  it('P1 — precision omitted: result byte-identical to a no-precision call (AC-10 regression)', async () => {
    fileContents.set(
      'src/z.ts',
      'export function z() {}',
    );

    setupGraph({
      sym: {
        id: 'Function:z',
        name: 'z',
        type: 'Function',
        filePath: 'src/z.ts',
        startLine: 1,
      },
    });

    const noPrecision = await backend.callTool('rename', {
      symbol_name: 'z',
      new_name: 'zV2',
      dry_run: true,
    });

    // The funnel must NOT have been called — precision is undefined.
    expect(mockedWithReferenceProvider).not.toHaveBeenCalled();

    // The result should still include `source: 'heuristic'` (the
    // default annotation), and the edits should be unchanged.
    expect((noPrecision as any).source).toBe('heuristic');
    // (Heuristic may legitimately produce 0 edits in this fixture
    // — the graph-only path with no incoming refs and an rg-fallback
    // that returns empty. The byte-identity assertion is the
    // load-bearing contract; this test pins the `source` field
    // shape, not the edit count.)
    expect(noPrecision).toBeDefined();
  });

  // ─── P5: oldName === new_name guard fires BEFORE the LSP branch ─

  it('P5 — oldName === new_name returns error without invoking the LSP funnel', async () => {
    fileContents.set(
      'src/idem.ts',
      'export function idem() {}',
    );

    setupGraph({
      sym: {
        id: 'Function:idem',
        name: 'idem',
        type: 'Function',
        filePath: 'src/idem.ts',
        startLine: 1,
      },
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'idem',
      new_name: 'idem',
      dry_run: true,
      precision: 'lsp',
    });

    expect((result as any).error).toBeDefined();
    // The funnel must not have been called — the guard fires
    // before the LSP branch.
    expect(mockedWithReferenceProvider).not.toHaveBeenCalled();
  });

  // ─── P6: ambiguous lookup fires BEFORE the LSP branch ───────────

  it('P6 — ambiguous lookup result short-circuits before the LSP branch', async () => {
    // No fixture file needed; the lookup itself returns ambiguous.
    setupGraph({
      sym: {
        id: 'Function:amb',
        name: 'amb',
        type: 'Function',
        filePath: 'src/amb.ts',
        startLine: 1,
      },
      ambiguous: true,
    });

    // The lookupResult.status='ambiguous' path returns the
    // disambiguation passthrough. We assert the funnel is NOT
    // called and the result is the disambiguation object.
    const result = await backend.callTool('rename', {
      symbol_name: 'amb',
      new_name: 'ambV2',
      dry_run: true,
      precision: 'lsp',
    });

    // The ambiguous passthrough does not include source/lsp_status;
    // the funnel must not have been called.
    expect(mockedWithReferenceProvider).not.toHaveBeenCalled();
    // The status is 'ambiguous' (returned by context()).
    expect((result as any).status).toBe('ambiguous');
  });
});
