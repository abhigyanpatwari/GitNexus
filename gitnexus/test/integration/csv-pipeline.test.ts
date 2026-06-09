/**
 * P1 Integration Tests: CSV Pipeline
 *
 * Tests: streamAllCSVsToDisk with real graph data.
 * Covers hardening fixes: LRU cache (#24), BufferedCSVWriter flush
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { buildTestGraph, type TestNodeInput, type TestRelInput } from '../helpers/test-graph.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';

let tmpHandle: TestDBHandle;
let csvDir: string;
let repoDir: string;

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
        { sourceId: 'func:main', targetId: 'func:helper', type: 'CALLS' },
        { sourceId: 'file:src/index.ts', targetId: 'func:main', type: 'CONTAINS' },
        { sourceId: 'file:src/utils.ts', targetId: 'func:helper', type: 'CONTAINS' },
      ],
    );

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);

    // Check that CSV files were created
    expect(result.nodeFiles.size).toBeGreaterThan(0);
    expect(result.relRows).toBe(3);

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

    // Verify relations CSV exists
    const relContent = await fs.readFile(result.relCsvPath, 'utf-8');
    const relLines = relContent.trim().split('\n');
    expect(relLines.length).toBe(4); // header + 3 relationships
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
    expect(result.relRows).toBe(0);
  });

  it('handles node with empty string properties', async () => {
    const graph = buildTestGraph([{ id: 'file:empty', label: 'File', name: '', filePath: '' }]);

    const result = await streamAllCSVsToDisk(graph, repoDir, csvDir);
    const fileCsv = result.nodeFiles.get('File');
    expect(fileCsv).toBeDefined();
    expect(fileCsv!.rows).toBe(1);
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
  const NODES: TestNodeInput[] = [
    { id: 'folder:c', label: 'Folder', name: 'c', filePath: 'c' },
    { id: 'folder:a', label: 'Folder', name: 'a', filePath: 'a' },
    { id: 'folder:b', label: 'Folder', name: 'b', filePath: 'b' },
  ];
  const RELS: TestRelInput[] = [
    { sourceId: 'folder:c', targetId: 'folder:a', type: 'CONTAINS' },
    { sourceId: 'folder:a', targetId: 'folder:b', type: 'CONTAINS' },
    { sourceId: 'folder:b', targetId: 'folder:c', type: 'CONTAINS' },
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
      const relRows = dataRows(await fs.readFile(result.relCsvPath, 'utf-8'));
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
