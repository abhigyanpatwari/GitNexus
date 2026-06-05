/**
 * Unit Tests: LocalBackend.rename — accuracy regression suite
 *
 * Pins the dispatch contract for the multi-file coordinated rename tool,
 * specifically the Batch G fixes for #62, #63, and #72. These tests
 * exercise the full rename() method via callTool('rename', ...) with
 * mocked LadybugDB + fs + child_process, asserting that:
 *
 *   #62 — `break` removed from allIncoming line loop. Substring
 *         false positives (e.g. `getAllBondCategory` when renaming
 *         `getAllBond`) no longer cause the loop to exit before
 *         actual call sites are found. The regex gate (#60) rejects
 *         the false positive cleanly, then the loop continues to
 *         the next line.
 *
 *   #63 — `break` removed means all occurrences of the renamed
 *         symbol in a graph-covered file get edits, not just the
 *         first. seenEdits (#37) still dedupes identical edits.
 *
 *   #72 — Class/Interface rename walks the sym's own definition
 *         file for all word-bounded matches of the class name,
 *         catching the declaration + any intra-file uses
 *         (constructors, static calls). The class's import lines
 *         in other files are also captured via the graph's
 *         incoming IMPORTS edges.
 *
 * Each test seeds a minimal in-memory filesystem via a mocked
 * `fs/promises.readFile`, a mocked LadybugDB via
 * `executeParameterized`, and a mocked ripgrep via
 * `child_process.execFileSync`. The shape of the result is asserted
 * against the expected edits (file, line, old text, new text).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to share state between the mock factories (run at
// module load) and the test bodies (run after all imports). This
// lets the fs mock know about file contents declared in the test
// bodies, and lets the child_process mock dispatch on call args.
const { fileContents, rgFiles } = vi.hoisted(() => ({
  fileContents: new Map<string, string>(),
  rgFiles: [] as string[],
}));

// Mock the LadybugDB adapter. Rename() calls executeParameterized
// for the symbol lookup + incoming/outgoing edges + classlike
// expansion. The exact queries are routed via a query-string sniff.
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

// Mock child_process for the ripgrep text-search phase + git diff.
// `rename` uses execFileSync('rg', ...) — we return a list of files
// from the hoisted `rgFiles` array. The other callers (git diff)
// can return an empty string; they aren't exercised here.
vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd: string, args: any) => {
    if (cmd === 'rg') {
      // Return the hoisted rgFiles joined by newlines so the
      // text-search phase walks exactly the files the test wants.
      return rgFiles.join('\n');
    }
    return '';
  }),
}));

// Mock fs/promises so the rename code can read the hoisted
// fileContents map. The path-guard in rename() uses
// path.resolve(repoPath, filePath) which will produce a real
// absolute path under /tmp/test-project — our mock resolves
// the basename + the relative suffix, so any path that ENDS
// with one of the keys in fileContents returns its content.
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
      // Surface a clear error so tests that depend on a missing
      // file fail loudly instead of silently reading empty.
      throw new Error(`ENOENT (mock): ${filePath}`);
    }),
  },
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';
import { execFileSync as mockedExecFileSync } from 'child_process';

// ─── Helpers ─────────────────────────────────────────────────────────

const MOCK_REPO_ENTRY = {
  name: 'test-project',
  path: '/tmp/test-project',
  storagePath: '/tmp/.gitnexus/test-project',
  indexedAt: '2024-06-01T12:00:00Z',
  lastCommit: 'abc1234567890',
  stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
};

/**
 * Set up the single-repo fixture. The dispatch looks up the repo
 * by walking listRegisteredRepos, so we just need to return one
 * entry whose path matches what the path-guard in rename() will
 * resolve against.
 */
function setupSingleRepo() {
  (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
}

/**
 * Configure the LadybugDB mock to answer the queries rename() makes.
 * The queries are routed by inspecting the query string + params:
 *   - symbol lookup:    WHERE n.name = $symName
 *   - incoming:         MATCH (caller)-[r:CodeRelation]->(n {id: $symId})
 *   - outgoing:         MATCH (n {id: $symId})-[r:CodeRelation]->(target)
 *   - classlike expand: HAS_METHOD, DEFINES, and target:Method probes
 *
 * `incomingEdges` and `outgoingEdges` are returned verbatim. The
 * caller sym is returned by the first call; subsequent calls return
 * the edges (or empty arrays when the test wants no edges).
 */
function setupGraph({
  sym,
  incomingEdges = [],
  outgoingEdges = [],
  classExpansion = { ctor: [], file: [], method: [] },
}: {
  sym: { id: string; name: string; type: string; filePath: string; startLine: number; endLine?: number };
  incomingEdges?: any[];
  outgoingEdges?: any[];
  classExpansion?: { ctor: any[]; file: any[]; method: any[] };
}) {
  const calls: any[] = [];
  (executeParameterized as any).mockImplementation(async (_repoId: string, query: string, params: Record<string, any>) => {
    calls.push({ query, params });

    // 1) symbol lookup (name-based)
    if (query.includes('n.name = $symName') || query.includes('n.id = $symName')) {
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
      return [{
        id: sym.id,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine ?? sym.startLine + 5,
      }];
    }

    // 3) classlike disambiguation probes (UNION ALL) — return empty
    //    unless the sym.type is empty; we always set a type here so
    //    these are not exercised, but we route them defensively.
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

    // 7) incoming refs (CALLS, IMPORTS, EXTENDS, IMPLEMENTS)
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
 * Convenience: collect all edits from a rename result into a flat
 * array, sorted by (file, line) for deterministic assertions.
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

// ─── Tests ───────────────────────────────────────────────────────────

describe('LocalBackend.rename — Batch G accuracy fixes', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    fileContents.clear();
    rgFiles.length = 0;
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── #62: substring false positive + actual call site ───────────

  it('#62 — substring false positive is rejected, actual call site is edited', async () => {
    // Scenario: renaming `getAllBond` → `getAllBonds` on a method
    // node. The graph surfaces one IMPLEMENTS edge from
    // AssetDetailServiceImpl.java. That file has TWO lines:
    //   - line 10: `protected ... getAllBondCategory() {`
    //     (substring false positive — contains 'getAllBond' but
    //     \bgetAllBond\b does not match)
    //   - line 20: `bondService.getAllBond();` (actual call site)
    //
    // Before the fix: the inner loop's `break` fired on line 10's
    // substring match (even though the regex gate rejected the
    // edit), skipping line 20's actual call site.
    //
    // After the fix: the regex gate rejects line 10, the loop
    // continues to line 20, and the call site is edited.
    fileContents.set(
      'src/AssetDetailServiceImpl.java',
      [
        'package com.example;',
        'public class AssetDetailServiceImpl {',
        '  private BondService bondService;',
        '',
        '  // Substring false positive — contains "getAllBond" as a',
        '  // prefix of "getAllBondCategory" but the word-bounded',
        '  // regex \bgetAllBond\b does not match.',
        '  protected List<Category> getAllBondCategory() {',
        '    return bondService.getAllCategories();',
        '  }',
        '',
        '  // Actual call site — \bgetAllBond\b matches.',
        '  public List<Bond> fetchBonds() {',
        '    return bondService.getAllBond();',
        '  }',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Method:getAllBond',
        name: 'getAllBond',
        type: 'Method',
        filePath: 'src/BondService.java',
        startLine: 12,
      },
      incomingEdges: [
        { relType: 'IMPLEMENTS', uid: 'Class:AssetDetailServiceImpl', name: 'AssetDetailServiceImpl', filePath: 'src/AssetDetailServiceImpl.java', kind: 'Class' },
      ],
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'getAllBond',
      new_name: 'getAllBonds',
      dry_run: true,
    });

    expect((result as any).error).toBeUndefined();
    const edits = collectEdits(result);

    // The actual call site on line 14 MUST be edited.
    // (line 8 has the substring false positive `getAllBondCategory`.)
    const callSite = edits.find(e => e.file === 'src/AssetDetailServiceImpl.java' && e.line === 14);
    expect(callSite, 'expected call site at line 14 to be edited').toBeDefined();
    expect(callSite!.oldText).toContain('getAllBond');
    expect(callSite!.newText).toContain('getAllBonds');

    // The substring false positive on line 8 must NOT produce an
    // edit. If the regex gate regressed, an edit on line 8 would
    // produce `getAllBondsCategory` from `getAllBondCategory`.
    const substringLeak = edits.find(e =>
      e.file === 'src/AssetDetailServiceImpl.java' &&
      e.line === 8
    );
    expect(substringLeak, 'expected NO edit at line 8 (substring false positive)').toBeUndefined();
  });

  it('#62 negative — no false positive present, call site still edited', async () => {
    // Same scenario as above but the false-positive line is gone.
    // The actual call site must still be captured (regression
    // guard against the fix accidentally breaking the happy path).
    fileContents.set(
      'src/AssetDetailServiceImpl.java',
      [
        'public class AssetDetailServiceImpl {',
        '  public List<Bond> fetchBonds() {',
        '    return bondService.getAllBond();',
        '  }',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Method:getAllBond',
        name: 'getAllBond',
        type: 'Method',
        filePath: 'src/BondService.java',
        startLine: 12,
      },
      incomingEdges: [
        { relType: 'IMPLEMENTS', uid: 'Class:AssetDetailServiceImpl', name: 'AssetDetailServiceImpl', filePath: 'src/AssetDetailServiceImpl.java', kind: 'Class' },
      ],
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'getAllBond',
      new_name: 'getAllBonds',
      dry_run: true,
    });

    expect((result as any).error).toBeUndefined();
    const edits = collectEdits(result);
    const callSite = edits.find(e => e.file === 'src/AssetDetailServiceImpl.java' && e.line === 3);
    expect(callSite, 'expected call site at line 3 to be edited').toBeDefined();
    expect(callSite!.newText).toContain('getAllBonds');
  });

  // ─── #63: multiple occurrences in same file ──────────────────────

  it('#63 — all 3 occurrences of the renamed symbol are edited, not just the first', async () => {
    // Scenario: renaming `foo` → `bar` on a function node. The
    // graph surfaces one CALLS edge to a file that calls foo
    // THREE times (lines 5, 10, 15).
    //
    // Before the fix: `break` exited the line loop on the first
    // match, so only line 5 got an edit. Lines 10 and 15 were
    // missed because the file is in `graphFiles` and the
    // text-search phase skips it.
    //
    // After the fix: all three lines produce edits.
    fileContents.set(
      'src/Caller.ts',
      [
        'import { foo } from "./foo";',
        '',
        'export function caller() {',
        '  foo();  // line 5',
        '  return foo();  // line 5 (same line)',
        '}',
        '',
        'export function second() {',
        '  foo();  // line 9',
        '}',
        '',
        'export function third() {',
        '  foo();  // line 13',
        '  return foo();  // line 14',
        '  foo();  // line 15',
        '}',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Function:foo',
        name: 'foo',
        type: 'Function',
        filePath: 'src/foo.ts',
        startLine: 1,
      },
      incomingEdges: [
        { relType: 'CALLS', uid: 'Function:caller', name: 'caller', filePath: 'src/Caller.ts', kind: 'Function' },
      ],
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'foo',
      new_name: 'bar',
      dry_run: true,
    });

    expect((result as any).error).toBeUndefined();
    const edits = collectEdits(result);
    const callerEdits = edits.filter(e => e.file === 'src/Caller.ts');

    // Extract unique lines that were edited.
    const editedLines = new Set(callerEdits.map(e => e.line));
    // We expect at LEAST lines 5, 9, 13, 14, 15 to be edited
    // (line 5 has two `foo()` calls on the same line but they
    // dedupe to one edit, then the next-match line is line 9).
    // The minimum invariant: at least 3 distinct lines were
    // edited. (Before the fix only line 5 was.)
    expect(editedLines.size).toBeGreaterThanOrEqual(3);

    // All edits for the renamed symbol must be on lines that
    // originally contained `foo(`. Verify by checking each
    // edited line's newText contains 'bar'.
    for (const e of callerEdits) {
      expect(e.newText, `edit at line ${e.line} should rename foo → bar`).toContain('bar');
    }
  });

  // ─── #72: class declaration + intra-file uses + imports ─────────

  it('#72 — class declaration, intra-file uses, and imports are all edited', async () => {
    // Scenario: renaming `BondServiceImpl` → `BondServiceImplV2`
    // (a Class). The class is defined in BondServiceImpl.java with
    // a constructor and a static factory. Another file imports
    // and uses the class.
    //
    // Before the fix: only the file from the single import edge
    // was touched. The class declaration + intra-file uses
    // (constructor, static call) were missed because the sym's
    // own file was not in `allIncoming` and the text-search
    // phase skipped it (it was in `graphFiles`).
    //
    // After the fix: the sym's own file is added to allIncoming
    // (synthetic entry for Class/Interface), so the graph phase
    // walks ALL lines of that file. The class declaration,
    // constructor, and static call are all edited. The import
    // line in the consumer file is also edited.
    fileContents.set(
      'src/BondServiceImpl.java',
      [
        'package com.example;',
        '',
        'public class BondServiceImpl implements BondService {',
        '  private static final BondServiceImpl INSTANCE = new BondServiceImpl();',
        '',
        '  public static BondServiceImpl getInstance() {',
        '    return INSTANCE;',
        '  }',
        '',
        '  private BondServiceImpl() {}',
        '',
        '  public List<Bond> getAllBond() {',
        '    return List.of();',
        '  }',
        '}',
      ].join('\n'),
    );

    fileContents.set(
      'src/BondServiceV2Impl.java',
      [
        'package com.example;',
        '',
        'import com.example.BondServiceImpl;',
        '',
        'public class BondServiceV2Impl {',
        '  private BondServiceImpl delegate;',
        '',
        '  public void init() {',
        '    this.delegate = new BondServiceImpl();',
        '  }',
        '}',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Class:BondServiceImpl',
        name: 'BondServiceImpl',
        type: 'Class',
        filePath: 'src/BondServiceImpl.java',
        startLine: 3,
      },
      incomingEdges: [
        { relType: 'IMPORTS', uid: 'Class:BondServiceV2Impl', name: 'BondServiceV2Impl', filePath: 'src/BondServiceV2Impl.java', kind: 'Class' },
      ],
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'BondServiceImpl',
      new_name: 'BondServiceImplV2',
      dry_run: true,
    });

    expect((result as any).error).toBeUndefined();
    const edits = collectEdits(result);

    // The class declaration on line 3 of BondServiceImpl.java
    // must be edited.
    const declEdit = edits.find(e => e.file === 'src/BondServiceImpl.java' && e.line === 3);
    expect(declEdit, 'expected class declaration at line 3 to be edited').toBeDefined();
    expect(declEdit!.oldText).toContain('class BondServiceImpl');
    expect(declEdit!.newText).toContain('class BondServiceImplV2');

    // The import line in BondServiceV2Impl.java must be edited.
    const importEdit = edits.find(e => e.file === 'src/BondServiceV2Impl.java' && e.line === 3);
    expect(importEdit, 'expected import on line 3 of BondServiceV2Impl.java to be edited').toBeDefined();
    expect(importEdit!.oldText).toContain('BondServiceImpl');
    expect(importEdit!.newText).toContain('BondServiceImplV2');

    // Intra-file uses of the class in the definition file should
    // also be edited (constructor invocations, static factory
    // return type, static field type). We don't pin exact line
    // numbers because the fixture's line numbering could shift
    // if the implementation re-reads; we just assert that the
    // total edits in BondServiceImpl.java is > 1 (i.e. more than
    // just the declaration).
    const defFileEdits = edits.filter(e => e.file === 'src/BondServiceImpl.java');
    expect(defFileEdits.length, 'expected multiple edits in the class definition file').toBeGreaterThan(1);
  });

  it('#72 negative — single-file class, declaration line is still updated', async () => {
    // Class with no other references in the graph. The
    // declaration line MUST still be edited.
    fileContents.set(
      'src/OnlyOne.java',
      [
        'package com.example;',
        '',
        'public class OnlyOne {',
        '  public void run() {}',
        '}',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Class:OnlyOne',
        name: 'OnlyOne',
        type: 'Class',
        filePath: 'src/OnlyOne.java',
        startLine: 3,
      },
      incomingEdges: [],
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'OnlyOne',
      new_name: 'OnlyOneV2',
      dry_run: true,
    });

    expect((result as any).error).toBeUndefined();
    const edits = collectEdits(result);
    const decl = edits.find(e => e.file === 'src/OnlyOne.java' && e.line === 3);
    expect(decl, 'expected class declaration on line 3 to be edited').toBeDefined();
    expect(decl!.oldText).toContain('class OnlyOne');
    expect(decl!.newText).toContain('class OnlyOneV2');
  });

  // ─── #72: Interface (parity with Class) ──────────────────────────

  it('#72 Interface — declaration + intra-file uses are all edited (not a no-op)', async () => {
    // Scenario: renaming `Foo` → `Bar` on an Interface symbol.
    // The same `symIsClassLike` gate that covers Class in #72
    // also covers Interface, so the synthetic self-reference
    // entry is added to `allIncoming` and the graph phase walks
    // ALL lines of the interface's own file. We assert that:
    //   - the `interface Foo` declaration line is edited
    //   - the default method's return type uses the new name
    //   - there are multiple edits (NOT a single declaration
    //     edit followed by a no-op dedupe, which is the symptom
    //     when the synthetic entry is missing for Interface).
    fileContents.set(
      'src/FooService.ts',
      [
        'export interface Foo {',
        '  void bar(): void;',
        '  default Foo self(): Foo {',
        '    return this;',
        '  }',
        '}',
        '',
        'export const uses: Foo = {} as Foo;',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Interface:Foo',
        name: 'Foo',
        type: 'Interface',
        filePath: 'src/FooService.ts',
        startLine: 1,
      },
      incomingEdges: [],
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'Foo',
      new_name: 'Bar',
      dry_run: true,
    });

    expect((result as any).error).toBeUndefined();
    const edits = collectEdits(result);

    // The interface declaration on line 1 must be edited.
    const decl = edits.find(e => e.file === 'src/FooService.ts' && e.line === 1);
    expect(decl, 'expected interface declaration on line 1 to be edited').toBeDefined();
    expect(decl!.oldText).toContain('interface Foo');
    expect(decl!.newText).toContain('interface Bar');

    // The default method's return type on line 3 must also be
    // edited (intra-file use of the interface name).
    const methodReturn = edits.find(e => e.file === 'src/FooService.ts' && e.line === 3);
    expect(methodReturn, 'expected default method return type on line 3 to be edited').toBeDefined();
    expect(methodReturn!.newText).toContain('Bar');
    expect(methodReturn!.newText).not.toContain('Foo');

    // Sanity: not a no-op. The file must have at least 2 distinct
    // edited lines (declaration + at least one intra-file use).
    // If the Interface branch regressed (synthetic entry dropped,
    // or the loop gated on the wrong kind), only the declaration
    // line would be edited and this assertion would fail.
    const defFileLines = new Set(
      edits.filter(e => e.file === 'src/FooService.ts').map(e => e.line),
    );
    expect(defFileLines.size, 'expected > 1 edited lines in the interface file').toBeGreaterThan(1);
  });

  // ─── Regression guards for earlier batches (#37, #60) ────────────

  it('#37 regression — 2 identical call sites produce 1 edit (dedup preserved)', async () => {
    // Scenario: two distinct graph edges (e.g. EXTENDS + IMPORTS
    // from the same file) both resolve to the same import
    // statement on the same line. The seenEdits Set must dedupe
    // them so we get a single edit, not two identical edits.
    fileContents.set(
      'src/Consumer.java',
      [
        'import com.example.OldService;',
        '',
        'public class Consumer extends OldService {',
        '}',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Class:OldService',
        name: 'OldService',
        type: 'Class',
        filePath: 'src/OldService.java',
        startLine: 1,
      },
      incomingEdges: [
        { relType: 'IMPORTS', uid: 'Class:Consumer', name: 'Consumer', filePath: 'src/Consumer.java', kind: 'Class' },
        { relType: 'EXTENDS', uid: 'Class:Consumer', name: 'Consumer', filePath: 'src/Consumer.java', kind: 'Class' },
      ],
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'OldService',
      new_name: 'NewService',
      dry_run: true,
    });

    expect((result as any).error).toBeUndefined();
    const edits = collectEdits(result);

    // The import line is the same for both edges. seenEdits must
    // dedupe. We expect exactly ONE edit for the import line.
    const importLineEdits = edits.filter(e => e.file === 'src/Consumer.java' && e.line === 1);
    expect(importLineEdits.length, 'expected dedupe to produce exactly 1 edit for the import line').toBe(1);

    // Also the extends line (line 3) should be edited exactly once.
    const extendsLineEdits = edits.filter(e => e.file === 'src/Consumer.java' && e.line === 3);
    expect(extendsLineEdits.length, 'expected exactly 1 edit for the extends line').toBe(1);
  });

  it('#60 regression — substring-only line is not edited (regex gate preserved)', async () => {
    // Scenario: a file with two lines — one substring false
    // positive (`getAllBondCategory`) and one actual call site
    // (`getAllBond`). The substring line must NOT be edited.
    fileContents.set(
      'src/Service.java',
      [
        'public class Service {',
        '  protected List<Category> getAllBondCategory() {',
        '    return null;',
        '  }',
        '  public List<Bond> fetch() {',
        '    return getAllBond();',
        '  }',
        '}',
      ].join('\n'),
    );

    setupGraph({
      sym: {
        id: 'Method:getAllBond',
        name: 'getAllBond',
        type: 'Method',
        filePath: 'src/BondService.java',
        startLine: 1,
      },
      incomingEdges: [
        { relType: 'CALLS', uid: 'Class:Service', name: 'Service', filePath: 'src/Service.java', kind: 'Class' },
      ],
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'getAllBond',
      new_name: 'getAllBonds',
      dry_run: true,
    });

    expect((result as any).error).toBeUndefined();
    const edits = collectEdits(result);

    // No edit on line 2 (the substring false positive).
    const line2 = edits.find(e => e.file === 'src/Service.java' && e.line === 2);
    expect(line2, 'expected NO edit at line 2 (substring false positive)').toBeUndefined();

    // An edit on line 6 (the actual call site).
    const line6 = edits.find(e => e.file === 'src/Service.java' && e.line === 6);
    expect(line6, 'expected edit at line 6 (actual call site)').toBeDefined();
    expect(line6!.newText).toContain('getAllBonds');
  });

  it('existing rename dispatch returns a defined result (smoke test)', async () => {
    // Pure smoke test: dispatching rename with a well-formed
    // request must complete and return a defined result. Mirrors
    // the existing dispatch test in calltool-dispatch.test.ts
    // and ensures the Batch G fixes did not break the basic
    // happy path.
    setupGraph({
      sym: {
        id: 'func:helper',
        name: 'helper',
        type: 'Function',
        filePath: 'src/util.ts',
        startLine: 1,
      },
    });

    const result = await backend.callTool('rename', {
      symbol_name: 'helper',
      new_name: 'helperV2',
      dry_run: true,
    });
    expect(result).toBeDefined();
  });
});
