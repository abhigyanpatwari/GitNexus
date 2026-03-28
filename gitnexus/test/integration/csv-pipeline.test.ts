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
import { buildTestGraph } from '../helpers/test-graph.js';
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
