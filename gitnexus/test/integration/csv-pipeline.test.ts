/**
 * P1 Integration Tests: CSV Pipeline
 *
 * Tests: streamAllCSVsToDisk with real graph data.
 * Covers hardening fixes: LRU cache (#24), BufferedCSVWriter flush
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { readdirSync } from 'node:fs';
import { finished } from 'stream/promises';
import path from 'path';
import { constants as bufferConstants } from 'node:buffer';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { buildTestGraph, type TestNodeInput, type TestRelInput } from '../helpers/test-graph.js';
import {
  streamAllCSVsToDisk,
  buildRelRow,
  REL_CSV_HEADER,
  shouldFlushCSVBuffer,
  FLUSH_BYTES,
} from '../../src/core/lbug/csv-generator.js';
import { splitRelCsvByLabelPair } from '../../src/core/lbug/lbug-adapter.js';
import { getNodeLabel } from '../../src/core/lbug/rel-pair-routing.js';
import { NODE_TABLES } from '../../src/core/lbug/schema.js';
import { TREE_SITTER_MAX_BUFFER } from '../../src/core/ingestion/constants.js';
import { CJK_BIGRAM_WORST_CASE_GROWTH_FACTOR } from '../../src/core/search/cjk-segmentation.js';

let tmpHandle: TestDBHandle;
let csvDir: string;
let repoDir: string;

/** Data rows (header dropped) of one CSV file's text. */
const dataRowsOf = (csv: string): string[] =>
  csv
    .trim()
    .split('\n')
    .slice(1)
    .filter((l) => l.length > 0);

/** Concatenate data rows from every per-pair rel file (#2203 U2), pair keys
 * sorted so the concatenation order is deterministic regardless of map order. */
const readAllRelRows = async (
  relsByPair: Map<string, { csvPath: string; rows: number }>,
): Promise<string[]> => {
  const rows: string[] = [];
  for (const key of [...relsByPair.keys()].sort()) {
    rows.push(...dataRowsOf(await fs.readFile(relsByPair.get(key)!.csvPath, 'utf-8')));
  }
  return rows;
};

beforeAll(async () => {
  tmpHandle = await createTempDir('csv-pipeline-test-');
  csvDir = path.join(tmpHandle.dbPath, 'csv');
  repoDir = path.join(tmpHandle.dbPath, 'repo');

  // Create a fake repo directory with source files
  await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(repoDir, 'src', 'index.ts'),
    'export function main() {\n  console.log("hello");\n  helper();\n}\n\nexport class App {\n  run() {}\n}\n',
  );
  await fs.writeFile(
    path.join(repoDir, 'src', 'utils.ts'),
    'export function helper() {\n  return 42;\n}\n',
  );
});

afterAll(async () => {
  try {
    await tmpHandle.cleanup();
  } catch {
    /* best-effort */
  }
});

describe('streamAllCSVsToDisk', () => {
  it('generates CSV files for all node types in the graph', async () => {
    const graph = buildTestGraph(
      [
        { id: 'file:src/index.ts', label: 'File', name: 'index.ts', filePath: 'src/index.ts' },
        { id: 'file:src/utils.ts', label: 'File', name: 'utils.ts', filePath: 'src/utils.ts' },
        {
          id: 'func:main',
          label: 'Function',
          name: 'main',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 4,
          isExported: true,
        },
        {
          id: 'func:helper',
          label: 'Function',
          name: 'helper',
          filePath: 'src/utils.ts',
          startLine: 1,
          endLine: 3,
          isExported: true,
        },
        {
          id: 'class:App',
          label: 'Class',
          name: 'App',
          filePath: 'src/index.ts',
          startLine: 6,
          endLine: 8,
          isExported: true,
        },
        { id: 'folder:src', label: 'Folder', name: 'src', filePath: 'src' },
      ],
      [
        { sourceId: 'Function:main', targetId: 'Function:helper', type: 'CALLS' },
        { sourceId: 'File:src/index.ts', targetId: 'Function:main', type: 'CONTAINS' },
        { sourceId: 'File:src/utils.ts', targetId: 'Function:helper', type: 'CONTAINS' },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);

    // Check that CSV files were created
    expect(result.nodeFiles.size).toBeGreaterThan(0);
    expect(result.totalValidRels).toBe(3);
    expect(result.skippedRels).toBe(0);

    // Verify File CSV
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();
    expect(fileCsv!.rows).toBe(2);

    // Verify Function CSV
    const funcCsv = result.nodeFiles.get('Function');
    expect(funcCsv).toBeDefined();
    expect(funcCsv!.rows).toBe(2);

    // Verify Class CSV
    const classCsv = result.nodeFiles.get('Class');
    expect(classCsv).toBeDefined();
    expect(classCsv!.rows).toBe(1);

    // Verify Folder CSV
    const folderCsv = result.nodeFiles.get('Folder');
    expect(folderCsv).toBeDefined();
    expect(folderCsv!.rows).toBe(1);

    // Relationships are routed to per-FROM→TO-label-pair files (#2203 U2):
    // Function→Function (CALLS) + File→Function (2× CONTAINS).
    expect(result.relsByPair.has('Function|Function')).toBe(true);
    expect(result.relsByPair.has('File|Function')).toBe(true);
    expect(result.relsByPair.get('File|Function')!.rows).toBe(2);
    expect(await readAllRelRows(result.relsByPair)).toHaveLength(3);
  });

  it('CSV content is properly escaped', async () => {
    const graph = buildTestGraph([
      {
        id: 'file:src/index.ts',
        label: 'File',
        name: 'index.ts',
        filePath: 'src/index.ts',
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();

    const content = await fs.readFile(fileCsv!.csvPath, 'utf-8');
    // Content should be properly quoted
    expect(content).toContain('"file:src/index.ts"');
    expect(content).toContain('"index.ts"');
  });

  it('stores exact symbol content, pinned against a ±1 boundary shift', async () => {
    // Neighbors sit DIRECTLY adjacent to the [2,4] span (no blank buffer), so a
    // one-line slice shift at either edge — the #2379 COBOL/JCL failure mode —
    // pulls a guard line into the snippet and fails an assertion.
    await fs.writeFile(
      path.join(repoDir, 'src', 'symbol-window.ts'),
      [
        'const guardTop = 0;',
        'const before = 1;',
        'export function target() {',
        '  return before;',
        '}',
        'const after = 2;',
        'const guardBottom = 3;',
      ].join('\n'),
    );
    const graph = buildTestGraph([
      {
        id: 'func:target',
        label: 'Function',
        name: 'target',
        filePath: 'src/symbol-window.ts',
        startLine: 2,
        endLine: 4,
        isExported: true,
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const functionCsv = result.nodeFiles.get('Function');
    expect(functionCsv).toBeDefined();
    const content = await fs.readFile(functionCsv!.csvPath, 'utf-8');
    expect(content).toContain('export function target()');
    expect(content).toContain('return before;');
    // Directly-adjacent neighbors must NOT leak — catches an off-by-one either way.
    expect(content).not.toContain('const before = 1;');
    expect(content).not.toContain('const after = 2;');
  });

  it('stores exact content for a one-line symbol (startLine === endLine)', async () => {
    await fs.writeFile(
      path.join(repoDir, 'src', 'one-line.ts'),
      ['AAA_TOP', 'BBB_BEFORE', 'const only = 1;', 'CCC_AFTER', 'DDD_BOTTOM'].join('\n'),
    );
    const graph = buildTestGraph([
      {
        id: 'func:only',
        label: 'Function',
        name: 'only',
        filePath: 'src/one-line.ts',
        startLine: 2,
        endLine: 2,
        isExported: true,
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const functionCsv = result.nodeFiles.get('Function');
    expect(functionCsv).toBeDefined();
    const content = await fs.readFile(functionCsv!.csvPath, 'utf-8');
    expect(content).toContain('const only = 1;');
    expect(content).not.toContain('BBB_BEFORE');
    expect(content).not.toContain('CCC_AFTER');
  });

  it('keeps ±2 neighbor context for non-exact labels (Section)', async () => {
    // `Section` is NOT in EXACT_SYMBOL_CONTENT_LABELS, so it retains the ±2
    // context window — the fallback branch the exact-content change left in place.
    await fs.writeFile(
      path.join(repoDir, 'src', 'section-window.ts'),
      [
        's0_alpha',
        's1_bravo',
        's2_charlie',
        's3_delta',
        's4_echo',
        's5_foxtrot',
        's6_golf',
        's7_hotel',
      ].join('\n'),
    );
    const graph = buildTestGraph([
      {
        id: 'sec:s',
        label: 'Section',
        name: 's',
        filePath: 'src/section-window.ts',
        startLine: 4,
        endLine: 4,
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const sectionCsv = result.nodeFiles.get('Section');
    expect(sectionCsv).toBeDefined();
    const content = await fs.readFile(sectionCsv!.csvPath, 'utf-8');
    expect(content).toContain('s4_echo'); // the section's own line
    expect(content).toContain('s2_charlie'); // startLine - 2
    expect(content).toContain('s6_golf'); // endLine + 2
    expect(content).not.toContain('s1_bravo'); // outside the ±2 window
    expect(content).not.toContain('s7_hotel');
  });

  it('keeps full text file content searchable past 10KB', async () => {
    const lateNeedle = 'late_text_file_needle_after_10kb';
    await fs.writeFile(
      path.join(repoDir, 'src', 'large.txt'),
      `${'filler line for large text indexing\n'.repeat(400)}${lateNeedle}\n`,
    );
    const graph = buildTestGraph([
      {
        id: 'file:src/large.txt',
        label: 'File',
        name: 'large.txt',
        filePath: 'src/large.txt',
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();

    const content = await fs.readFile(fileCsv!.csvPath, 'utf-8');
    expect(content).toContain(lateNeedle);
    expect(content).not.toContain('[truncated]');
  });

  describe('GITNEXUS_FTS_CJK_SEGMENTATION (#2331)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // The description phrase is deliberately different from anything in the
    // file's own source text (and the function's startLine/endLine keep the
    // extracted content snippet away from the file-level comment). If
    // description and content were segmented via the same accidental code
    // path, or formatFtsDescription silently used the wrong property, a
    // description-only phrase could not appear in either CSV row.
    const FILE_CJK_PHRASE = '采购订单自动审批流程';
    const DESCRIPTION_CJK_PHRASE = '库存管理系统更新';

    it('leaves File content and Function description byte-identical by default (mode: none)', async () => {
      const cjkContent = `// ${FILE_CJK_PHRASE}\nexport function approve() {\n  return true;\n}\n`;
      await fs.writeFile(path.join(repoDir, 'src', 'cjk.ts'), cjkContent);
      const graph = buildTestGraph([
        { id: 'file:src/cjk.ts', label: 'File', name: 'cjk.ts', filePath: 'src/cjk.ts' },
        {
          id: 'func:approve',
          label: 'Function',
          name: 'approve',
          filePath: 'src/cjk.ts',
          extra: { description: DESCRIPTION_CJK_PHRASE, startLine: 3, endLine: 3 },
        },
      ]);

      const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
      const fileContent = await fs.readFile(result.nodeFiles.get('File')!.csvPath, 'utf-8');
      const funcContent = await fs.readFile(result.nodeFiles.get('Function')!.csvPath, 'utf-8');
      expect(fileContent).toContain(FILE_CJK_PHRASE);
      expect(funcContent).toContain(DESCRIPTION_CJK_PHRASE);
      expect(funcContent).not.toContain(FILE_CJK_PHRASE);
      // No bigram-separator spaces inserted into the CJK run.
      expect(fileContent).not.toContain('采购 购订');
      expect(funcContent).not.toContain('库存 存管');
    });

    it('bigram-segments both File content and Function description when enabled', async () => {
      vi.stubEnv('GITNEXUS_FTS_CJK_SEGMENTATION', 'bigram');
      const cjkContent = `// ${FILE_CJK_PHRASE}\nexport function approve() {\n  return true;\n}\n`;
      await fs.writeFile(path.join(repoDir, 'src', 'cjk-bigram.ts'), cjkContent);
      const graph = buildTestGraph([
        {
          id: 'file:src/cjk-bigram.ts',
          label: 'File',
          name: 'cjk-bigram.ts',
          filePath: 'src/cjk-bigram.ts',
        },
        {
          id: 'func:approve-bigram',
          label: 'Function',
          name: 'approveBigram',
          filePath: 'src/cjk-bigram.ts',
          extra: { description: DESCRIPTION_CJK_PHRASE, startLine: 3, endLine: 3 },
        },
      ]);

      const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
      const fileContent = await fs.readFile(result.nodeFiles.get('File')!.csvPath, 'utf-8');
      const funcContent = await fs.readFile(result.nodeFiles.get('Function')!.csvPath, 'utf-8');
      // Every expected overlapping bigram from the issue's own example must
      // be present as a real, space-delimited FTS token in the File row.
      const expectedFileBigrams = [
        '采购',
        '购订',
        '订单',
        '单自',
        '自动',
        '动审',
        '审批',
        '批流',
        '流程',
      ];
      for (const bigram of expectedFileBigrams) {
        expect(fileContent).toContain(bigram);
      }
      // The Function row's description column is segmented independently —
      // proven against its own (distinct) phrase, not the file's.
      const expectedDescriptionBigrams = ['库存', '存管', '管理', '理系', '系统', '统更', '更新'];
      for (const bigram of expectedDescriptionBigrams) {
        expect(funcContent).toContain(bigram);
      }
      // #2339: every one of the bigram substrings above is ALSO a literal
      // substring of the original unsegmented phrase (bigrams are
      // overlapping substrings by construction), so the positive assertions
      // alone would pass even if applyCjkSegmentationIfEnabled silently
      // became a no-op. Mirror the `mode: none` test's negative-assertion
      // pattern above: the original contiguous run must NOT survive intact.
      expect(fileContent).not.toContain(FILE_CJK_PHRASE);
      expect(funcContent).not.toContain(DESCRIPTION_CJK_PHRASE);
    });
  });

  it('handles community nodes with keywords', async () => {
    const graph = buildTestGraph([
      {
        id: 'comm:auth',
        label: 'Community' as any,
        name: 'Auth',
        filePath: '',
        extra: {
          heuristicLabel: 'Authentication',
          keywords: ['auth', 'login', 'pass,word'],
          description: 'Auth module',
          enrichedBy: 'heuristic',
          cohesion: 0.85,
          symbolCount: 5,
        },
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const commCsv = result.nodeFiles.get('Community');
    expect(commCsv).toBeDefined();
    expect(commCsv!.rows).toBe(1);

    const content = await fs.readFile(commCsv!.csvPath, 'utf-8');
    // Keywords with commas should be escaped with \,
    expect(content).toContain('pass\\,word');
  });

  it('handles process nodes', async () => {
    const graph = buildTestGraph([
      {
        id: 'proc:flow',
        label: 'Process' as any,
        name: 'LoginFlow',
        filePath: '',
        extra: {
          heuristicLabel: 'User Login',
          processType: 'intra_community',
          stepCount: 3,
          communities: ['auth'],
          entryPointId: 'func:login',
          terminalId: 'func:validate',
        },
      },
    ]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const procCsv = result.nodeFiles.get('Process');
    expect(procCsv).toBeDefined();
    expect(procCsv!.rows).toBe(1);
  });

  it('deduplicates File nodes', async () => {
    const graph = buildTestGraph([
      { id: 'file:src/index.ts', label: 'File', name: 'index.ts', filePath: 'src/index.ts' },
      // Duplicate (same id) — should not appear twice
    ]);
    // Add the same node again manually
    graph.addNode({
      id: 'file:src/index.ts',
      label: 'File',
      properties: { name: 'index.ts', filePath: 'src/index.ts' },
    });

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();
    expect(fileCsv!.rows).toBe(1);
  });

  // ─── Unhappy paths ──────────────────────────────────────────────────

  it('handles empty graph (zero nodes)', async () => {
    const graph = buildTestGraph([], []);
    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    expect(result.nodeFiles.size).toBe(0);
    expect(result.totalValidRels).toBe(0);
    expect(result.relsByPair.size).toBe(0);
  });

  it('handles node with empty string properties', async () => {
    const graph = buildTestGraph([{ id: 'file:empty', label: 'File', name: '', filePath: '' }]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();
    expect(fileCsv!.rows).toBe(1);
  });

  it('crosses the BufferedCSVWriter FLUSH_BYTES boundary without losing rows', async () => {
    // FLUSH_BYTES=8MB; real File content totalling >8MB forces ≥1 mid-stream
    // flush, exercising addRow's flush-promise return + the loop's
    // `if (pending) await pending` path that the small fixtures above never
    // reach (only the bench did).
    const N = 10;
    const CONTENT_SIZE = 1024 * 1024; // 1MB/file, 10MB total > FLUSH_BYTES
    const bigContent = 'x'.repeat(CONTENT_SIZE);
    await fs.mkdir(path.join(repoDir, 'src', 'big'), { recursive: true });
    const nodes: TestNodeInput[] = [];
    for (let i = 0; i < N; i++) {
      const filePath = `src/big/f${i}.ts`;
      await fs.writeFile(path.join(repoDir, filePath), bigContent);
      nodes.push({ id: `File:${filePath}`, label: 'File', name: `f${i}.ts`, filePath });
    }
    const result = await streamAllCSVsToDisk(buildTestGraph(nodes), repoDir, csvDir);

    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();
    expect(fileCsv!.rows).toBe(N); // no rows dropped/duplicated at the flush boundary
    const dataRows = dataRowsOf(await fs.readFile(fileCsv!.csvPath, 'utf-8'));
    expect(dataRows).toHaveLength(N);
    expect(new Set(dataRows).size).toBe(N); // all distinct — no flush-boundary corruption
  });

  it('flushes the buffered CSV chunk once the byte threshold is reached', () => {
    expect(shouldFlushCSVBuffer(FLUSH_BYTES - 1)).toBe(false);
    expect(shouldFlushCSVBuffer(FLUSH_BYTES)).toBe(true);
  });

  it('shouldFlushCSVBuffer stays within the V8 string-length ceiling', () => {
    // One more max-size row (TREE_SITTER_MAX_BUFFER, hard-clamped — see
    // max-file-size.ts) can land right after the buffer was just under
    // FLUSH_BYTES. Two transforms can each grow that row before it's joined:
    // applyCjkSegmentationIfEnabled (#2331, ~7/3x worst case on an all-CJK
    // row with GITNEXUS_FTS_CJK_SEGMENTATION=bigram) and escapeCSVField's
    // quote-doubling (2x). The resulting join() must stay well under Node's
    // MAX_STRING_LENGTH, or BufferedCSVWriter.flush() throws
    // `RangeError: Invalid string length`.
    const worstCaseJoinSize =
      FLUSH_BYTES + 2 * CJK_BIGRAM_WORST_CASE_GROWTH_FACTOR * TREE_SITTER_MAX_BUFFER;
    expect(worstCaseJoinSize).toBeLessThan(bufferConstants.MAX_STRING_LENGTH / 2);
  });
});

/**
 * Deterministic output — `GITNEXUS_SORT_GRAPH_OUTPUT` makes the CSV a pure function of the
 * graph's node/edge SET (id-sorted) instead of of insertion order. This is the
 * structural enabler for the out-of-core / windowed resolve: with it on,
 * a windowed emit that produces the same edge set in a different order yields
 * byte-identical CSV. Default off = today's insertion-order bytes exactly.
 */
describe('streamAllCSVsToDisk — deterministic output ordering', () => {
  // Folder nodes: single-line CSV rows (no multi-line `content` column), so the
  // id is the first comma-separated field and split('\n') is safe. ids are
  // deliberately NOT in insertion order (c, a, b).
  // ids use the `Folder:` prefix so getNodeLabel derives the valid `Folder`
  // table — edges route to rel_Folder_Folder.csv (#2203 U2). Deliberately NOT
  // in insertion order (c, a, b).
  const NODES: TestNodeInput[] = [
    { id: 'Folder:c', label: 'Folder', name: 'c', filePath: 'c' },
    { id: 'Folder:a', label: 'Folder', name: 'a', filePath: 'a' },
    { id: 'Folder:b', label: 'Folder', name: 'b', filePath: 'b' },
  ];
  const RELS: TestRelInput[] = [
    { sourceId: 'Folder:c', targetId: 'Folder:a', type: 'CONTAINS' },
    { sourceId: 'Folder:a', targetId: 'Folder:b', type: 'CONTAINS' },
    { sourceId: 'Folder:b', targetId: 'Folder:c', type: 'CONTAINS' },
  ];
  const dataRows = (csv: string): string[] =>
    csv
      .trim()
      .split('\n')
      .slice(1)
      .filter((l) => l.length > 0);
  const firstCol = (row: string): string => row.split(',')[0];

  const run = async (
    nodes: TestNodeInput[],
    rels: TestRelInput[],
    sorted: boolean,
    sub: string,
  ): Promise<{ folderIds: string[]; relRows: string[] }> => {
    if (sorted) process.env.GITNEXUS_SORT_GRAPH_OUTPUT = '1';
    else delete process.env.GITNEXUS_SORT_GRAPH_OUTPUT;
    try {
      const result = await streamAllCSVsToDisk(
        buildTestGraph(nodes, rels),
        repoDir,
        path.join(csvDir, sub),
      );
      const folderCsv = result.nodeFiles.get('Folder');
      const folderIds = folderCsv
        ? dataRows(await fs.readFile(folderCsv.csvPath, 'utf-8')).map(firstCol)
        : [];
      const relRows = await readAllRelRows(result.relsByPair);
      return { folderIds, relRows };
    } finally {
      delete process.env.GITNEXUS_SORT_GRAPH_OUTPUT;
    }
  };

  it('default off: node rows follow graph insertion order (not id-sorted)', async () => {
    const { folderIds } = await run(NODES, RELS, false, 'u6a-off');
    expect(folderIds).not.toEqual([...folderIds].sort()); // insertion order c, a, b
  });

  it('flag on: node rows are sorted by id', async () => {
    const { folderIds } = await run(NODES, RELS, true, 'u6a-on');
    expect(folderIds).toEqual([...folderIds].sort());
  });

  it('flag on makes output independent of graph insertion order; off does not', async () => {
    const nodesRev = [...NODES].reverse();
    const relsRev = [...RELS].reverse();

    const onFwd = await run(NODES, RELS, true, 'u6a-on-fwd');
    const onRev = await run(nodesRev, relsRev, true, 'u6a-on-rev');
    // SORTED: byte-for-byte identical regardless of insertion order — the deterministic-output property.
    expect(onRev.folderIds).toEqual(onFwd.folderIds);
    expect(onRev.relRows).toEqual(onFwd.relRows);

    const offFwd = await run(NODES, RELS, false, 'u6a-off-fwd');
    const offRev = await run(nodesRev, relsRev, false, 'u6a-off-rev');
    // UNSORTED: insertion order leaks into the bytes (today's behavior).
    expect(offRev.folderIds).not.toEqual(offFwd.folderIds);

    // SAME node/edge SET in both modes — sorting reorders rows, never adds/drops.
    expect([...onFwd.folderIds].sort()).toEqual([...offFwd.folderIds].sort());
    expect([...onFwd.relRows].sort()).toEqual([...offFwd.relRows].sort());
  });
});

/**
 * #2203 U2 byte-identity: for all quote-free ids the direct per-pair emit must
 * produce per-pair files byte-for-byte identical to the legacy
 * splitRelCsvByLabelPair oracle run over an equivalent monolithic relations.csv
 * from the same graph. This is the load-bearing guard for "byte-identical graph
 * content" (issue acceptance). The ONE intentional divergence — ids containing a
 * double-quote, where the router (raw-id label) is more correct than the oracle
 * (regex over the escaped row) — is asserted explicitly in its own test below.
 */
describe('streamAllCSVsToDisk — direct per-pair emit matches the split oracle', () => {
  // The oracle always emits in graph.iterRelationships() (unsorted) order; the
  // production path honours GITNEXUS_SORT_GRAPH_OUTPUT. Clear it so a value
  // leaked from a prior test can't desync the two and produce a spurious diff.
  beforeEach(() => {
    delete process.env.GITNEXUS_SORT_GRAPH_OUTPUT;
  });

  it('produces byte-identical per-pair files + identical skip/total accounting', async () => {
    // Multiple valid pairs, getNodeLabel special prefixes (comm_ AND proc_), and
    // one invalid-label edge that BOTH paths must skip identically.
    const graph = buildTestGraph(
      [
        { id: 'File:a.ts', label: 'File', name: 'a.ts', filePath: 'a.ts' },
        { id: 'Function:a.ts:f:1', label: 'Function', name: 'f', filePath: 'a.ts' },
        { id: 'Function:a.ts:g:5', label: 'Function', name: 'g', filePath: 'a.ts' },
        { id: 'comm_1', label: 'Community' as never, name: 'c1', filePath: '' },
        { id: 'comm_2', label: 'Community' as never, name: 'c2', filePath: '' },
        { id: 'proc_1', label: 'Process' as never, name: 'p1', filePath: '' },
        { id: 'proc_2', label: 'Process' as never, name: 'p2', filePath: '' },
      ],
      [
        { sourceId: 'File:a.ts', targetId: 'Function:a.ts:f:1', type: 'CONTAINS' },
        { sourceId: 'File:a.ts', targetId: 'Function:a.ts:g:5', type: 'CONTAINS' },
        { sourceId: 'Function:a.ts:f:1', targetId: 'Function:a.ts:g:5', type: 'CALLS' },
        { sourceId: 'comm_1', targetId: 'comm_2', type: 'CONTAINS' },
        // proc_ prefix → Process label (getNodeLabel special case).
        { sourceId: 'proc_1', targetId: 'proc_2', type: 'CONTAINS' },
        // Invalid FROM label ('Bogus' ∉ NODE_TABLES) — skipped by both paths.
        { sourceId: 'Bogus:x', targetId: 'File:a.ts', type: 'CONTAINS' },
        // Invalid TO label — exercises the OTHER branch of the skip condition.
        { sourceId: 'File:a.ts', targetId: 'Bogus:y', type: 'CONTAINS' },
      ],
    );

    const directDir = path.join(csvDir, 'diff-direct');
    const oracleDir = path.join(csvDir, 'diff-oracle');
    await fs.mkdir(oracleDir, { recursive: true });

    // Direct emit (production path).
    const direct = await streamAllCSVsToDisk(graph, repoDir, directDir);

    // Oracle: build the monolithic relations.csv this graph would have produced
    // (same insertion order, same row bytes via buildRelRow), then split it.
    const relCsv = path.join(oracleDir, 'relations.csv');
    const lines = [REL_CSV_HEADER];
    for (const rel of graph.iterRelationships()) lines.push(buildRelRow(rel));
    await fs.writeFile(relCsv, lines.join('\n') + '\n', 'utf-8');

    const split = await splitRelCsvByLabelPair(
      relCsv,
      oracleDir,
      new Set<string>(NODE_TABLES),
      getNodeLabel,
    );
    await Promise.all(
      Array.from(split.pairWriteStreams.values()).map(async (ws) => {
        ws.end();
        await finished(ws);
      }),
    );

    // Identical accounting.
    expect(direct.totalValidRels).toBe(split.totalValidRels);
    expect(direct.totalValidRels).toBe(5);
    expect(direct.skippedRels).toBe(split.skippedRels);
    expect(direct.skippedRels).toBe(2); // invalid-FROM + invalid-TO, both skipped
    expect(direct.relHeader).toBe(split.relHeader);

    // Identical pair set.
    expect([...direct.relsByPair.keys()].sort()).toEqual([...split.relsByPairMeta.keys()].sort());

    // Byte-identical per-pair file contents.
    for (const key of direct.relsByPair.keys()) {
      const directContent = await fs.readFile(direct.relsByPair.get(key)!.csvPath, 'utf-8');
      const oracleContent = await fs.readFile(split.relsByPairMeta.get(key)!.csvPath, 'utf-8');
      expect(directContent, `pair ${key}`).toBe(oracleContent);
    }
  });

  it('quote-in-id edge: router routes it (raw-id label) while the oracle drops it — intended divergence', async () => {
    // A node id with an embedded double-quote (legal in a POSIX filePath). The
    // router derives the label from the RAW id (`File`), so it routes the edge;
    // the oracle re-derives the label via /"([^"]*)","([^"]*)"/ over the ESCAPED
    // row (`"File:a""b.ts",...`), mis-reads the field, and drops it. This locks
    // the intended divergence so a future change can't silently revert the
    // router to the buggy regex semantics.
    const graph = buildTestGraph(
      [
        { id: 'File:clean.ts', label: 'File', name: 'clean.ts', filePath: 'clean.ts' },
        { id: 'File:a"b.ts', label: 'File', name: 'a"b.ts', filePath: 'a"b.ts' },
        { id: 'Function:a.ts:f:1', label: 'Function', name: 'f', filePath: 'a.ts' },
      ],
      [
        { sourceId: 'File:clean.ts', targetId: 'Function:a.ts:f:1', type: 'CONTAINS' },
        { sourceId: 'File:a"b.ts', targetId: 'Function:a.ts:f:1', type: 'CONTAINS' },
      ],
    );

    const directDir = path.join(csvDir, 'qd-direct');
    const oracleDir = path.join(csvDir, 'qd-oracle');
    await fs.mkdir(oracleDir, { recursive: true });

    const direct = await streamAllCSVsToDisk(graph, repoDir, directDir);

    const relCsv = path.join(oracleDir, 'relations.csv');
    const lines = [REL_CSV_HEADER];
    for (const rel of graph.iterRelationships()) lines.push(buildRelRow(rel));
    await fs.writeFile(relCsv, lines.join('\n') + '\n', 'utf-8');
    const split = await splitRelCsvByLabelPair(
      relCsv,
      oracleDir,
      new Set<string>(NODE_TABLES),
      getNodeLabel,
    );
    await Promise.all(
      Array.from(split.pairWriteStreams.values()).map(async (ws) => {
        ws.end();
        await finished(ws);
      }),
    );

    // Router routes BOTH edges — the raw-id label `File` is valid for both.
    expect(direct.totalValidRels).toBe(2);
    expect(direct.skippedRels).toBe(0);
    expect(direct.relsByPair.get('File|Function')!.rows).toBe(2);

    // Oracle DIVERGES: its regex mis-reads the quote-in-id row and drops that
    // edge, so it routes strictly fewer edges. Asserted robustly — we do NOT
    // pin the oracle's exact mis-derived label.
    expect(split.totalValidRels).toBeLessThan(direct.totalValidRels);
    expect(split.skippedRels).toBeGreaterThan(direct.skippedRels);
  });

  it('sorted path (GITNEXUS_SORT_GRAPH_OUTPUT=1): per-pair files byte-identical to the oracle', async () => {
    // The earlier differential test covers the default (insertion-order) path.
    // Here the sorted emit path must also match the oracle — fed the SAME
    // id-sorted order orderedRelationships() uses (sort by rel.id).
    process.env.GITNEXUS_SORT_GRAPH_OUTPUT = '1';
    try {
      const graph = buildTestGraph(
        [
          { id: 'File:a.ts', label: 'File', name: 'a.ts', filePath: 'a.ts' },
          { id: 'Function:a.ts:f:1', label: 'Function', name: 'f', filePath: 'a.ts' },
          { id: 'Function:a.ts:g:5', label: 'Function', name: 'g', filePath: 'a.ts' },
        ],
        // Deliberately NOT in id-sorted order so the sort actually reorders rows.
        [
          { sourceId: 'Function:a.ts:f:1', targetId: 'Function:a.ts:g:5', type: 'CALLS' },
          { sourceId: 'File:a.ts', targetId: 'Function:a.ts:g:5', type: 'CONTAINS' },
          { sourceId: 'File:a.ts', targetId: 'Function:a.ts:f:1', type: 'CONTAINS' },
        ],
      );

      const directDir = path.join(csvDir, 'sorted-direct');
      const oracleDir = path.join(csvDir, 'sorted-oracle');
      await fs.mkdir(oracleDir, { recursive: true });

      const direct = await streamAllCSVsToDisk(graph, repoDir, directDir);

      // Oracle fed the same id-sorted order the sorted emit produces.
      const sortedRels = [...graph.iterRelationships()].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      const relCsv = path.join(oracleDir, 'relations.csv');
      const lines = [REL_CSV_HEADER];
      for (const rel of sortedRels) lines.push(buildRelRow(rel));
      await fs.writeFile(relCsv, lines.join('\n') + '\n', 'utf-8');
      const split = await splitRelCsvByLabelPair(
        relCsv,
        oracleDir,
        new Set<string>(NODE_TABLES),
        getNodeLabel,
      );
      await Promise.all(
        Array.from(split.pairWriteStreams.values()).map(async (ws) => {
          ws.end();
          await finished(ws);
        }),
      );

      expect([...direct.relsByPair.keys()].sort()).toEqual([...split.relsByPairMeta.keys()].sort());
      for (const key of direct.relsByPair.keys()) {
        const directContent = await fs.readFile(direct.relsByPair.get(key)!.csvPath, 'utf-8');
        const oracleContent = await fs.readFile(split.relsByPairMeta.get(key)!.csvPath, 'utf-8');
        expect(directContent, `pair ${key} (sorted)`).toBe(oracleContent);
      }
    } finally {
      delete process.env.GITNEXUS_SORT_GRAPH_OUTPUT;
    }
  });
});

// The overlap leg (#2203) needs to start COPY-ing nodes while relationship CSVs
// are still being written. streamAllCSVsToDisk exposes that boundary via an
// onNodePhaseComplete callback. These tests pin the contract: it fires once,
// after node CSVs exist and before any rel CSV does, and supplying it does not
// change the emitted output.
describe('onNodePhaseComplete hook (#2203 overlap boundary)', () => {
  const hookGraph = () =>
    buildTestGraph(
      [
        { id: 'File:src/index.ts', label: 'File', name: 'index.ts', filePath: 'src/index.ts' },
        {
          id: 'Function:src/index.ts:main:1',
          label: 'Function',
          name: 'main',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 3,
        },
      ],
      [
        {
          sourceId: 'File:src/index.ts',
          targetId: 'Function:src/index.ts:main:1',
          type: 'DEFINES',
        },
      ],
    );

  it('fires exactly once, after node CSVs are flushed and before any rel CSV exists', async () => {
    const hookCsvDir = path.join(tmpHandle.dbPath, 'csv-hook-timing');
    let calls = 0;
    let nodeCsvsPresent = false;
    let relCsvsPresent = true;
    let handedKeys: string[] = [];

    const result = await streamAllCSVsToDisk(hookGraph(), repoDir, hookCsvDir, (nodeFiles) => {
      calls++;
      handedKeys = [...nodeFiles.keys()].sort();
      const entries = readdirSync(hookCsvDir);
      nodeCsvsPresent = entries.includes('file.csv') && entries.includes('function.csv');
      relCsvsPresent = entries.some((f) => f.startsWith('rel_'));
    });

    expect(calls).toBe(1);
    expect(nodeCsvsPresent).toBe(true);
    // No relationship CSV may exist yet — the rel pass starts after the hook.
    expect(relCsvsPresent).toBe(false);
    // The manifest handed to the callback is the one returned to the caller.
    expect(handedKeys).toEqual([...result.nodeFiles.keys()].sort());
    expect(result.totalValidRels).toBe(1);
  });

  it('supplying the callback does not change the node manifest (no behavior change)', async () => {
    const withDir = path.join(tmpHandle.dbPath, 'csv-hook-with');
    const withoutDir = path.join(tmpHandle.dbPath, 'csv-hook-without');
    const withCb = await streamAllCSVsToDisk(hookGraph(), repoDir, withDir, () => {});
    const without = await streamAllCSVsToDisk(hookGraph(), repoDir, withoutDir);

    const manifest = (r: typeof withCb) =>
      [...r.nodeFiles.entries()].map(([k, v]) => `${k}:${v.rows}`).sort();
    expect(manifest(withCb)).toEqual(manifest(without));
    expect(withCb.totalValidRels).toBe(without.totalValidRels);
    expect(withCb.skippedRels).toBe(without.skippedRels);
  });
});
